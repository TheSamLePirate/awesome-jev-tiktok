import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Director } from "../Director";
import { api } from "../lib/api";
import { dispatch, getState, type SocialEvent } from "../lib/store";
import { resetAudioForTests } from "../lib/audio";
import { DEFAULT_PREFS, LAYOUTS, TIMING, audience, avatarIndex, cardBody, cardTitle, flagText, fmtCountdown, fmtElapsed, meterText, meterValue, parseCountdown, parseNotes, ruleRows, selectCards, urlOverrides, viewerStats, waitingCount, type RuleRow } from "../director/model";
import { Bursts, Card, Count, Countdown, Meter, NotesRail, RuleCard, StatTile, usePresence } from "../director/widgets";
import { DashboardView, FocusView, OverlayView, RecapView, StageView, type ViewData } from "../director/views";
import { chat, decision, health, hello, highlight, localQ, messageDecision, messageQ, push, question, replayInfo, roomHl, rule, sceneHl, snapshot, status, summary, transcriptHl, watchState, T0 } from "./fixtures";
import { FakeAudioContext } from "./setup";

TIMING.burstMs = 40; TIMING.timerLingerMs = 40; TIMING.leaveMs = 30;
const key = (k: string, init: KeyboardEventInit = {}) => act(() => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })); });
const now = () => Date.now();

describe("director model", () => {
  test("urlOverrides reads only the known options", () => {
    expect(urlOverrides("")).toEqual({});
    expect(urlOverrides("?transparent=1&scale=1.25&warnings=0&ticker=0&meters=0&layout=overlay")).toEqual({ transparent: true, scale: 1.25, showWarnings: false, showChat: false, showMeters: false, layout: "overlay" });
    expect(urlOverrides("?layout=nope&scale=-1&transparent=0")).toEqual({});
  });
  test("selectCards: hidden, warnings, lifetime, snooze, featured and warnings first, order, cap", () => {
    const t = now();
    const hs = [highlight({ id: "old", ts: t - 60_000 }), highlight({ id: "a", ts: t - 5000 }), highlight({ id: "b", ts: t - 1000 }), sceneHl({ id: "w", ts: t - 3000 }), roomHl({ id: "p", ts: t - 30_000, pinned: true }), highlight({ id: "r", ts: t, resolved: true }), transcriptHl({ id: "h", ts: t })];
    const base = { hidden: new Set<string>(), showWarnings: true, ttlSec: 45, maxCards: 8, order: "newest" as const, snoozed: new Map<string, number>(), now: t };
    expect(selectCards(hs, base).map((h) => h.id)).toEqual(["p", "w", "h", "b", "a"]);
    expect(selectCards(hs, { ...base, order: "oldest" }).map((h) => h.id)).toEqual(["p", "w", "a", "b", "h"]);
    expect(selectCards(hs, { ...base, showWarnings: false }).map((h) => h.id)).toEqual(["p", "h", "b", "a"]);
    expect(selectCards(hs, { ...base, hidden: new Set(["m1"]) }).map((h) => h.id)).toEqual(["p", "w", "h"]);
    expect(selectCards(hs, { ...base, snoozed: new Map([["b", t + 60_000], ["a", t - 1]]) }).map((h) => h.id)).toEqual(["p", "w", "h", "a"]);
    expect(selectCards(hs, { ...base, maxCards: 2 }).map((h) => h.id)).toEqual(["p", "w"]);
    expect(selectCards(hs, { ...base, ttlSec: 2 }).map((h) => h.id)).toEqual(["p", "h", "b"]);
  });
  test("waitingCount, audience, viewerStats", () => {
    const t = now();
    expect(waitingCount([highlight({ ts: t }), sceneHl({ ts: t }), highlight({ id: "x", ts: t - 11 * 60_000 }), highlight({ id: "y", ts: t, resolved: true })], new Set(), t)).toBe(1);
    expect(waitingCount([highlight({ ts: t })], new Set(["m1"]), t)).toBe(0);
    const social: SocialEvent[] = [{ kind: "gift", id: "g1", ts: t, handle: "amy", giftName: "Rose", count: 2, diamonds: 5 }, { kind: "gift", id: "g2", ts: t, handle: "bob", giftName: "Lion", count: 1, diamonds: 100 }, { kind: "gift", id: "g3", ts: t, handle: "amy", giftName: "Rose", count: 1, diamonds: 5 }, { kind: "social", ts: t, handle: "c", action: "follow" }, { kind: "social", ts: t, handle: "d", action: "share" }, { kind: "social", ts: t, handle: "e", action: "other" }, { kind: "member", ts: t, handle: "f", nickname: "F" }];
    expect(audience(social)).toEqual({ diamonds: 115, gifts: 4, follows: 1, shares: 1, joins: 1, leaders: [{ handle: "bob", diamonds: 100 }, { handle: "amy", diamonds: 15 }] });
    expect(audience([])).toEqual({ diamonds: 0, gifts: 0, follows: 0, shares: 0, joins: 0, leaders: [] });
    expect(viewerStats([], t)).toEqual({ current: null, peak: 0, delta: null, trend: "flat" });
    expect(viewerStats([{ ts: t, count: 10 }], t)).toEqual({ current: 10, peak: 10, delta: null, trend: "flat" });
    expect(viewerStats([{ ts: t - 6 * 60_000, count: 100 }, { ts: t - 60_000, count: 150 }, { ts: t, count: 120 }], t)).toEqual({ current: 120, peak: 150, delta: 20, trend: "up" });
    expect(viewerStats([{ ts: t - 10_000, count: 100 }, { ts: t, count: 80 }], t)).toEqual({ current: 80, peak: 100, delta: -20, trend: "down" });
    expect(viewerStats([{ ts: t - 10_000, count: 100 }, { ts: t, count: 101 }], t).trend).toBe("flat");
  });
  test("countdown and clock formats, notes, meters, card texts", () => {
    expect(parseCountdown("5")).toBe(300); expect(parseCountdown(" 2:30 ")).toBe(150); expect(parseCountdown("45s")).toBe(45); expect(parseCountdown("1.5 min")).toBe(90); expect(parseCountdown("10 sec")).toBe(10);
    expect(parseCountdown("")).toBeNull(); expect(parseCountdown("abc")).toBeNull(); expect(parseCountdown("1:99")).toBeNull();
    expect(fmtCountdown(0)).toBe("0:00"); expect(fmtCountdown(-3)).toBe("0:00"); expect(fmtCountdown(65.2)).toBe("1:06");
    expect(fmtElapsed(65_000)).toBe("1:05"); expect(fmtElapsed(3_661_000)).toBe("1:01:01"); expect(fmtElapsed(-1)).toBe("0:00");
    expect(parseNotes("Intro\n- hello\n* topic\n[ ] ask\n[x] done\n\n  ")).toEqual([{ key: "0:Intro", text: "Intro", checkable: false }, { key: "1:- hello", text: "hello", checkable: true }, { key: "2:* topic", text: "topic", checkable: true }, { key: "3:[ ] ask", text: "ask", checkable: true }, { key: "4:[x] done", text: "done", checkable: true }]);
    expect(meterValue(undefined)).toBe(0); expect(meterValue({ type: "noul", noul: 0.4 })).toBe(0.4); expect(meterValue({ type: "score", score: 1, legend: { "0": "a", "1": "b", "2": "c" }, probabilities: {}, confidence: 1 })).toBe(0.5); expect(meterValue({ type: "choice", choice: "x", probabilities: {}, confidence: 0.7 })).toBe(0.7);
    expect(meterText(undefined)).toBe("—"); expect(meterText(undefined, true)).toBe("n/a"); expect(meterText({ type: "noul", noul: 0.4 })).toBe("40%");
    expect(cardTitle(highlight())).toBe("💬 Reply to Alice"); expect(cardTitle(highlight({ severity: "warn" }))).toBe("⚠ Watch Alice"); expect(cardTitle(transcriptHl())).toBe("🎙 You said"); expect(cardTitle(sceneHl())).toBe("🎥 Check the camera"); expect(cardTitle(roomHl())).toBe("✦ Room");
    expect(cardBody(highlight())).toContain("Hello host"); expect(cardBody(transcriptHl())).toContain("“Let us talk"); expect(cardBody(sceneHl())).toBe("An empty chair."); expect(cardBody(roomHl())).toBe("bob: wow"); expect(cardBody(roomHl({ chat: undefined }))).toBe("");
    expect(flagText(highlight())).toBe("Question to host 90%");
    expect(DEFAULT_PREFS.layout).toBe("stage"); expect(LAYOUTS.length).toBe(4);
  });
});

describe("director model: rule rows", () => {
  test("ruleRows: one row per question, session flags only, chat rules count judged messages, paused / local / muted", () => {
    const qs = [question(), messageQ(), localQ({ id: "k1" })];
    const hl = [highlight({ ts: T0 + 1000 }), highlight({ id: "h9", ts: T0 + 5000, message: chat({ id: "c9", text: "later" }) }), highlight({ id: "other", sessionId: "s0" }), transcriptHl({ ts: T0 + 3000 })];
    const md = { c1: messageDecision(), c2: messageDecision({ messageId: "c2", fired: [], answers: { m1: { type: "noul", noul: 0.1 } } }), c3: messageDecision({ messageId: "c3", answers: {}, fired: [], skipped: ["k1"] }) };
    const rows = ruleRows(qs, { rules: [rule(), rule({ id: "r3", kind: "keyword", paused: true })], decisions: [decision({ ts: T0 }), decision({ ts: T0 + 1000, answers: { q1: { type: "noul", noul: 0.2 } }, fired: [], skipped: ["q1"] })], messageDecisions: md, highlights: hl, sessionId: "s1", hidden: new Set(["m1"]) });
    expect(rows.map((r) => r.id)).toEqual(["q1", "m1", "k1"]);
    expect(rows[0]).toMatchObject({ scope: "window", local: false, paused: false, muted: false, fired: false, skipped: true, history: [0.82, 0.2], fires: 1, lastFire: T0 + 3000, judged: 0, matched: 0 });
    expect(rows[0].answer).toEqual({ type: "noul", noul: 0.2 }); expect(rows[0].last?.kind).toBe("transcript");
    expect(rows[1]).toMatchObject({ scope: "message", muted: true, history: [], fires: 2, lastFire: T0 + 5000, judged: 2, matched: 1 }); expect(rows[1].last?.message?.text).toBe("later");
    expect(rows[2]).toMatchObject({ local: true, paused: true, fires: 0, lastFire: null, judged: 1, matched: 0 }); expect(rows[2].last).toBeUndefined();
    // Without a session id every flag counts.
    expect(ruleRows([messageQ()], { rules: [], decisions: [], messageDecisions: {}, highlights: hl, sessionId: null, hidden: new Set() })[0]).toMatchObject({ fires: 3, answer: undefined, fired: false, skipped: false });
  });
  test("avatarIndex keeps the latest avatar per handle and skips messages without one", () => {
    const m = avatarIndex([chat({ handle: "a", avatar: "1.png" }), chat({ handle: "a", avatar: "2.png" }), chat({ handle: "b", avatar: undefined })]);
    expect([...m.entries()]).toEqual([["a", "2.png"]]);
  });
});

const ruleRow = (o: Partial<RuleRow> = {}): RuleRow => ({ id: "q1", label: "Host topic", scope: "window", sources: ["transcript"], local: false, paused: false, muted: false, answer: { type: "noul", noul: 0.8 }, fired: true, skipped: false, history: [0.2, 0.8], fires: 3, lastFire: T0, judged: 0, matched: 0, ...o });

describe("director widgets", () => {
  test("usePresence keeps a removed item as leaving for a moment", async () => {
    const Probe = ({ items }: { items: string[] }) => { const p = usePresence(items, (s) => s); return <ul>{p.map((x) => <li key={x.item} className={x.leaving ? "leaving" : ""}>{x.item}</li>)}</ul>; };
    const { container, rerender } = render(<Probe items={["a", "b"]} />);
    rerender(<Probe items={["b", "c"]} />);
    expect([...container.querySelectorAll("li")].map((l) => `${l.textContent}${l.className ? "*" : ""}`)).toEqual(["b", "c", "a*"]);
    rerender(<Probe items={["a", "c"]} />);
    expect([...container.querySelectorAll("li")].map((l) => `${l.textContent}${l.className ? "*" : ""}`)).toEqual(["a", "c", "b*"]);
    await waitFor(() => expect(container.querySelectorAll("li.leaving").length).toBe(0));
  });
  test("Card: actions stop the click from selecting, sizes, featured has no lifetime bar", () => {
    const actions = { onDone: mock(() => {}), onPin: mock(() => {}), onSnooze: mock(() => {}), onSelect: mock(() => {}) };
    const t = now();
    const { container, rerender } = render(<Card h={highlight({ ts: t - 10_000 })} now={t} ttlSec={20} selected actions={actions} />);
    expect(container.querySelector(".dc.selected")?.getAttribute("aria-current")).toBe("true"); expect((container.querySelector(".dc-ttl") as HTMLElement).style.width).toBe("50%");
    fireEvent.click(screen.getByLabelText("done")); fireEvent.click(screen.getByLabelText("feature")); fireEvent.click(screen.getByLabelText("snooze"));
    expect(actions.onDone).toHaveBeenCalledTimes(1); expect(actions.onPin).toHaveBeenCalledTimes(1); expect(actions.onSnooze).toHaveBeenCalledTimes(1); expect(actions.onSelect).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector(".dc")!); expect(actions.onSelect).toHaveBeenCalledTimes(1);
    rerender(<Card h={roomHl({ pinned: true })} now={t} ttlSec={20} size="small" leaving actions={actions} />);
    expect(container.querySelector(".dc.small.leaving.pinned")).not.toBeNull(); expect(container.querySelector(".dc-ttl") === null).toBe(true); expect(container.querySelector(".dc-actions") === null).toBe(true); expect(container.querySelector(".dc-scene")?.textContent).toBe("bob: wow");
    rerender(<Card h={transcriptHl()} now={t} ttlSec={20} size="big" actions={actions} />);
    expect(container.querySelector(".dc.big .dc-quote")).not.toBeNull(); expect(screen.getByLabelText("feature")).toBeTruthy();
    rerender(<Card h={roomHl({ pinned: true })} now={t} ttlSec={20} actions={actions} />);
    expect(screen.getByLabelText("unfeature")).toBeTruthy();
  });
  test("Meter, StatTile, Count, Countdown, Bursts, NotesRail", () => {
    const { container, rerender } = render(<Meter label="Hype" answer={{ type: "noul", noul: 0.6 }} fired skipped={false} history={[0.1, 0.6]} />);
    expect(container.querySelector(".dm.fired .dm-spark")).not.toBeNull(); expect(container.querySelector(".dm-head b")?.textContent).toBe("60%");
    rerender(<Meter label="Hype" fired={false} skipped history={[0.1]} />);
    expect(container.querySelector(".dm.skipped")).not.toBeNull(); expect(container.querySelector(".dm-spark") === null).toBe(true); expect(container.querySelector(".dm-head b")?.textContent).toBe("n/a");
    rerender(<StatTile icon="👁" label="viewers" value={<Count value={42} />} sub="peak 50" tone="up" spark={[1, 5, 3]} big />);
    expect(container.querySelector(".d-tile.up.big .d-tile-spark")).not.toBeNull(); expect(container.textContent).toContain("peak 50");
    rerender(<StatTile label="plain" value="x" spark={[1]} />);
    expect(container.querySelector(".d-tile-spark") === null).toBe(true); expect(container.querySelector(".d-tile-sub") === null).toBe(true);
    const onClear = mock(() => {});
    rerender(<Countdown endAt={T0 + 65_000} now={T0} onClear={onClear} />);
    expect(container.querySelector(".d-timer-value")?.textContent).toBe("1:05"); expect(container.querySelector(".d-timer.urgent") === null).toBe(true);
    rerender(<Countdown endAt={T0 + 5000} now={T0} onClear={onClear} />);
    expect(container.querySelector(".d-timer.urgent")).not.toBeNull();
    rerender(<Countdown endAt={T0} now={T0 + 1} onClear={onClear} />);
    expect(container.querySelector(".d-timer.done .d-timer-value")?.textContent).toBe("TIME");
    fireEvent.click(screen.getByLabelText("clear timer")); expect(onClear).toHaveBeenCalled();
    rerender(<Bursts items={[]} />);
    expect(container.innerHTML).toBe("");
    rerender(<Bursts items={[{ id: "1", emoji: "🎁", text: "amy sent Rose" }, { id: "2", emoji: "➕", text: "bo followed", handle: "bo", avatar: "https://example.test/bo.png" }]} />);
    expect(container.querySelectorAll(".d-burst .p").length).toBe(8); expect(container.textContent).toContain("amy sent Rose"); expect(container.querySelectorAll(".d-burst-avatar").length).toBe(1);
    // RuleCard: a firing room rule with its sparkline and latest flag; a chat rule with the matched ratio, tags and the last message's avatar.
    rerender(<RuleCard r={ruleRow({ last: transcriptHl() })} now={T0 + 5000} />);
    expect(container.querySelector(".d-rule.window.fired .dm-spark")).not.toBeNull(); expect(container.querySelector(".d-rule-now")?.textContent).toBe("80%"); expect(container.querySelector(".d-rule-foot")?.textContent).toBe("fired ×3· 5s"); expect(container.querySelector(".d-rule-last")?.textContent).toContain("Politics again"); expect(container.querySelector(".d-rule-avatar") === null).toBe(true);
    rerender(<RuleCard r={ruleRow({ id: "k1", label: "links", scope: "message", local: true, paused: true, muted: true, answer: undefined, fired: false, skipped: true, history: [], fires: 0, lastFire: null, judged: 12, matched: 3, last: highlight() })} now={T0} />);
    expect(container.querySelector(".d-rule.message.paused.skipped.muted")).not.toBeNull(); expect(container.querySelector(".d-rule-now")?.textContent).toBe("3 / 12"); expect([...container.querySelectorAll(".d-rule-tag")].map((t) => t.textContent)).toEqual(["⌘", "paused", "muted"]);
    expect(container.querySelector(".d-rule-foot")?.textContent).toBe("not fired yet· 12 judged"); expect(container.querySelector(".d-rule-avatar")).not.toBeNull(); expect(container.querySelector(".d-rule-last b")?.textContent).toBe("Alice"); expect(container.querySelector(".dm-spark") === null).toBe(true);
    rerender(<RuleCard r={ruleRow({ scope: "message", answer: undefined, judged: 0, matched: 0, fires: 0, lastFire: null, fired: false })} now={T0} />);
    expect(container.querySelector(".d-rule-now")?.textContent).toBe("—"); expect(container.querySelector(".d-rule-last") === null).toBe(true);
    const onToggle = mock(() => {}), onClose = mock(() => {});
    rerender(<NotesRail items={[]} done={new Set()} onToggle={onToggle} onClose={onClose} />);
    expect(container.textContent).toContain("Write your plan");
    rerender(<NotesRail items={parseNotes("Part 1\n- hello\n- topic")} done={new Set(["1:- hello"])} onToggle={onToggle} onClose={onClose} />);
    expect(container.querySelector(".d-notes-count")?.textContent).toBe("1/2"); expect(container.querySelectorAll("li.done").length).toBe(1); expect(container.querySelector("li.plain")?.textContent).toBe("Part 1");
    fireEvent.click(container.querySelectorAll('input[type="checkbox"]')[1]); expect(onToggle).toHaveBeenCalledWith("2:- topic");
    fireEvent.click(screen.getByLabelText("hide notes")); expect(onClose).toHaveBeenCalled();
  });
});

const viewData = (o: Partial<ViewData> = {}): ViewData => {
  const t = now();
  return { cards: [{ item: highlight({ ts: t - 1000 }), leaving: false }, { item: transcriptHl({ ts: t - 2000 }), leaving: false }], queueLength: 2, meters: [{ id: "q1", label: "Host topic", answer: { type: "noul", noul: 0.8 }, fired: true, skipped: false, history: [0.2, 0.8] }], rules: [], avatars: new Map([["ed", "https://example.test/ed.png"]]), stats: { elapsedMs: 65_000, viewers: { current: 67, peak: 80, delta: 5, trend: "up" }, viewerSeries: [60, 67], velocity: "steady", likes: "few", audience: { diamonds: 12, gifts: 2, follows: 3, shares: 1, joins: 4, leaders: [{ handle: "amy", diamonds: 12 }] }, decisionAgeSec: 2, latencyMs: 300 }, chat: [], events: [{ kind: "gift", id: "g", ts: t, handle: "amy", giftName: "Rose", count: 2, diamonds: 6 }, { kind: "social", ts: t, handle: "bo", nickname: "Bo", avatar: "https://example.test/bo.png", action: "follow" }, { kind: "social", ts: t, handle: "cy", action: "share" }, { kind: "social", ts: t, handle: "dee", action: "other" }, { kind: "member", ts: t, handle: "ed", nickname: "" }], now: t, prefs: { ...DEFAULT_PREFS }, selectedId: "h1", live: true, idle: { title: "nothing to act on", detail: "last decision 2 s ago" }, ...o };
};
const noActions = { onDone: () => {}, onPin: () => {}, onSnooze: () => {}, onSelect: () => {} };

describe("director views", () => {
  test("Stage, Focus, Dashboard, Overlay, Recap", () => {
    const { container, rerender } = render(<StageView data={viewData()} actions={noActions} />);
    expect(container.querySelectorAll(".d-meters .dm").length).toBe(1); expect(container.querySelectorAll(".dc").length).toBe(2); expect(container.querySelector(".dc.selected")).not.toBeNull();
    rerender(<StageView data={viewData({ cards: [], prefs: { ...DEFAULT_PREFS, showMeters: false } })} actions={noActions} />);
    expect(container.querySelector(".d-meters") === null).toBe(true); expect(container.querySelector(".d-idle")?.textContent).toContain("nothing to act on");
    rerender(<FocusView data={viewData()} actions={noActions} />);
    expect(container.querySelector(".dc.big .dc-msg p")?.textContent).toContain("Hello host"); expect(container.querySelector(".d-focus-pos")?.textContent).toBe("1 / 2"); expect(container.querySelectorAll(".d-next .dc.small").length).toBe(1);
    rerender(<FocusView data={viewData({ selectedId: "missing", cards: [{ item: highlight({ ts: now() }), leaving: true }, { item: transcriptHl(), leaving: false }] })} actions={noActions} />);
    expect(container.querySelector(".dc.big .dc-quote")).not.toBeNull(); expect(container.querySelector(".d-next") === null).toBe(true);
    rerender(<FocusView data={viewData({ cards: [] })} actions={noActions} />);
    expect(container.querySelector(".d-idle")).not.toBeNull(); expect(container.querySelector(".d-focus-hint") === null).toBe(true);
    rerender(<DashboardView data={viewData()} actions={noActions} />);
    expect(container.querySelectorAll(".d-tile").length).toBe(6); expect(container.querySelector(".d-rules")?.textContent).toContain("No rules yet"); expect(container.querySelectorAll(".d-ev img.d-ev-avatar").length).toBe(2); expect(container.querySelectorAll(".d-ev span.d-ev-avatar").length).toBe(3); expect(container.textContent).toContain("+5 in 5 min · peak 80"); expect(container.textContent).toContain("amy 12"); expect(container.textContent).toContain("1 shares · 4 joins"); expect(container.textContent).toContain("last decision 2 s ago · 300 ms");
    expect([...container.querySelectorAll(".d-ev")].map((e) => e.className)).toEqual(["d-ev member", "d-ev social", "d-ev social", "d-ev social", "d-ev gift"]); expect(container.textContent).toContain("🎁 amy · Rose ×2 · 💎 12"); expect(container.textContent).toContain("👋 ed joined");
    rerender(<DashboardView data={viewData({ cards: [], events: [], stats: { elapsedMs: null, viewers: { current: null, peak: 0, delta: null, trend: "flat" }, viewerSeries: [], velocity: "flood", likes: "burst", audience: { diamonds: 0, gifts: 0, follows: 0, shares: 0, joins: 0, leaders: [] }, decisionAgeSec: 30, latencyMs: null } })} actions={noActions} />);
    expect(container.textContent).toContain("no history yet"); expect(container.textContent).toContain("0 gifts"); expect(container.textContent).toContain("last decision 30 s ago"); expect(container.querySelectorAll(".d-tile.hot").length).toBe(2); expect(container.querySelector(".d-tile.warn")).not.toBeNull(); expect(container.textContent).toContain("Gifts, follows and joins land here"); expect(container.querySelector(".d-idle")).not.toBeNull();
    rerender(<DashboardView data={viewData({ stats: { ...viewData().stats, viewers: { current: 10, peak: 20, delta: -8, trend: "down" }, decisionAgeSec: null }, rules: [ruleRow(), ruleRow({ id: "m1", scope: "message", fired: false })] })} actions={noActions} />);
    expect(container.textContent).toContain("↘ -8 in 5 min"); expect(container.textContent).toContain("no decision yet"); expect(container.querySelectorAll(".d-rules .d-rule").length).toBe(2); expect(container.querySelector(".d-rules h4")?.textContent).toBe("Rules 21 firing");
    rerender(<DashboardView data={viewData({ rules: [ruleRow({ fired: false })] })} actions={noActions} />);
    expect(container.querySelector(".d-rules-live") === null).toBe(true);
    const onExit = mock(() => {});
    rerender(<OverlayView data={viewData()} onExit={onExit} />);
    expect(container.querySelector(".d-lt") === null).toBe(true); expect(container.textContent).toContain("Feature a prompt");
    fireEvent.click(screen.getByLabelText("exit overlay")); expect(onExit).toHaveBeenCalled();
    rerender(<OverlayView data={viewData()} />);
    expect(container.querySelector(".d-exit") === null).toBe(true);
    rerender(<OverlayView data={viewData({ cards: [{ item: highlight({ pinned: true }), leaving: false }] })} />);
    expect(container.querySelector(".d-lt-name")?.textContent).toBe("Alice"); expect(container.querySelector(".d-lt-avatar")).not.toBeNull();
    rerender(<OverlayView data={viewData({ cards: [{ item: transcriptHl({ pinned: true }), leaving: false }] })} />);
    expect(container.querySelector(".d-lt-name")?.textContent).toBe("You said"); expect(container.querySelector(".d-lt-text")?.textContent).toContain("Politics again");
    rerender(<OverlayView data={viewData({ cards: [{ item: sceneHl({ pinned: true, severity: "info" }), leaving: false }] })} />);
    expect(container.querySelector(".d-lt-name")?.textContent).toBe("On stage"); expect(container.querySelector(".d-lt-text")?.textContent).toBe("An empty chair.");
    rerender(<OverlayView data={viewData({ cards: [{ item: roomHl({ pinned: true, scene: undefined }), leaving: false }], live: false })} />);
    expect(container.querySelector(".d-lt-text")?.textContent).toBe("bob: wow");
    rerender(<OverlayView data={viewData({ cards: [{ item: sceneHl({ pinned: true }), leaving: false }], live: false })} />);
    expect(container.querySelector(".d-lt") === null).toBe(true); expect(container.textContent).not.toContain("Feature a prompt");
    rerender(<RecapView summary={summary()} status={status({ state: "offline", detail: "stream ended" })} chart={[1, 5, 3]} />);
    expect(container.textContent).toContain("@koursk1"); expect(container.textContent).toContain("Débat"); expect(container.textContent).toContain("Host topic ×3"); expect(container.textContent).toContain("1 warnings"); expect(container.textContent).toContain("stream ended"); expect(container.querySelector(".d-recap-spark")).not.toBeNull();
    rerender(<RecapView summary={summary({ title: undefined, warnings: 0, topFired: [] })} status={null} chart={[]} />);
    expect(container.textContent).toContain("no warnings"); expect(container.textContent).toContain("nothing fired"); expect(container.textContent).toContain("Waiting for the next stream"); expect(container.querySelector(".d-recap-spark") === null).toBe(true);
  });
});

describe("Director", () => {
  const spies: { mockRestore: () => void }[] = [];
  let patch: ReturnType<typeof spyOn>;
  beforeEach(() => {
    patch = spyOn(api, "patchHighlight").mockResolvedValue({ ok: true } as any); spies.push(patch);
    window.happyDOM.setURL("http://localhost:5173/?view=director");
    const t = now();
    act(() => dispatch({ type: "ws", msg: hello({ status: status({ ts: t - 65_000 }), decisions: [decision({ ts: t, skipped: ["q3"] })], highlights: [highlight({ ts: t - 1000 }), transcriptHl({ ts: t - 2000 }), sceneHl({ ts: t - 3000 }), roomHl({ ts: t - 4000, pinned: true }), highlight({ id: "old", ts: t - 600_000 }), highlight({ id: "res", resolved: true, ts: t })], messageDecisions: [messageDecision()] }) }));
    push({ type: "snapshot", snapshot: snapshot({ sources: { transcript: { state: "error", ageMs: 1 }, video: { state: "missing", ageMs: -1 }, chat: { state: "available", ageMs: 1 } } }) });
    push({ type: "event", event: { kind: "viewers", ts: t - 6 * 60_000, count: 50 } });
    push({ type: "event", event: { kind: "viewers", ts: t, count: 67 } });
  });
  afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); window.happyDOM.setURL("http://localhost:5173/"); });

  test("stage: top bar, meters, queue with keyboard selection, done / feature / snooze, ticker", async () => {
    const { container } = render(<Director />);
    expect(container.querySelector(".d-live.on")?.textContent).toBe("LIVE"); expect(container.querySelector(".d-clock")?.textContent).toMatch(/^1:0\d$/);
    expect(container.querySelector(".d-stat.up")?.textContent).toContain("👁 67"); expect(container.textContent).toContain("1 waiting"); expect(container.textContent).toContain("🎙 🎥 unavailable"); expect(container.textContent).toContain("💬 steady");
    expect(container.querySelectorAll(".dm").length).toBe(3); expect(container.querySelectorAll(".dm.fired").length).toBe(1); expect(container.querySelectorAll(".dm.skipped").length).toBe(1);
    expect([...container.querySelectorAll(".dc")].map((c) => c.getAttribute("aria-label"))).toEqual(["✦ Room", "🎥 Check the camera", "💬 Reply to Alice", "🎙 You said"]);
    expect(container.querySelector(".dc.selected")?.getAttribute("aria-label")).toBe("✦ Room");
    expect(container.querySelectorAll(".d-chat span").length).toBe(2); expect(container.querySelector(".d-chat .hot")).not.toBeNull();
    // Keyboard: j / ↓ / k / ↑ move the selection and wrap; a click selects too.
    key("j"); expect(container.querySelector(".dc.selected")?.getAttribute("aria-label")).toBe("🎥 Check the camera");
    key("ArrowDown"); key("ArrowDown"); key("ArrowDown"); expect(container.querySelector(".dc.selected")?.getAttribute("aria-label")).toBe("✦ Room");
    key("k"); expect(container.querySelector(".dc.selected")?.getAttribute("aria-label")).toBe("🎙 You said");
    key("ArrowUp"); expect(container.querySelector(".dc.selected")?.getAttribute("aria-label")).toBe("💬 Reply to Alice");
    fireEvent.click(container.querySelector(".dc.transcript")!); expect(container.querySelector(".dc.selected")?.getAttribute("aria-label")).toBe("🎙 You said");
    key("f"); expect(patch).toHaveBeenLastCalledWith("h2", { pinned: true });
    key("Enter"); expect(patch).toHaveBeenLastCalledWith("h2", { resolved: true });
    key("x"); expect(patch).toHaveBeenCalledTimes(3);
    fireEvent.click(container.querySelector(".dc.pinned [aria-label='unfeature']")!); expect(patch).toHaveBeenLastCalledWith("h4", { pinned: false });
    fireEvent.click(container.querySelector(".dc.message [aria-label='done']")!); expect(patch).toHaveBeenLastCalledWith("h1", { resolved: true });
    // Snooze hides the selected prompt on this screen only; the server never hears about it.
    key("z");
    await waitFor(() => expect(container.querySelectorAll(".dc:not(.leaving)").length).toBe(3));
    expect(container.querySelector(".dc.transcript:not(.leaving)")).toBeNull();
    await waitFor(() => expect(container.querySelectorAll(".dc").length).toBe(3));
    fireEvent.click(container.querySelector(".dc.message [aria-label='snooze']")!);
    await waitFor(() => expect(container.querySelectorAll(".dc:not(.leaving)").length).toBe(2));
    expect(patch).toHaveBeenCalledTimes(5);
    // The server resolves one: it leaves; a new one arrives with sound on: a chime.
    resetAudioForTests(); key("s");
    push({ type: "highlight", highlight: sceneHl({ resolved: true }), fresh: false });
    await waitFor(() => expect(container.querySelectorAll(".dc:not(.leaving)").length).toBe(1));
    push({ type: "highlight", highlight: highlight({ id: "new", ts: now(), message: { ...highlight().message!, id: "cn", text: "new question" } }), fresh: true });
    expect(container.querySelector(".dc.message .dc-msg p")?.textContent).toBe("new question");
    expect(FakeAudioContext.instances.at(-1)?.started.length).toBe(2);
    patch.mockRejectedValue(new Error("x")); key("x"); key("f");
    await new Promise((r) => setTimeout(r, 10));
  });

  test("layouts by key and switch: focus, dashboard, overlay (featured lower third), meters / ticker toggles, help", () => {
    const { container } = render(<Director />);
    key("2"); expect(container.querySelector(".director.layout-focus .dc.big")).not.toBeNull(); expect(container.querySelector(".d-focus-pos")?.textContent).toBe("1 / 4"); expect(container.querySelectorAll(".d-next .dc").length).toBe(3);
    key("3"); expect(container.querySelectorAll(".layout-dashboard .d-tile").length).toBe(6); expect(container.querySelector(".d-chat") === null).toBe(true); expect(container.querySelectorAll(".d-events .d-ev").length).toBe(1);
    // Every rule of the set is on the dashboard, room and chat alike, with what it did this session.
    expect([...container.querySelectorAll(".d-rules .d-rule")].map((r) => r.getAttribute("aria-label"))).toEqual(["Host topic", "Mood", "Hype", "Question to host", "links"]);
    expect(container.querySelector(".d-rule.window.fired .d-rule-foot")?.textContent).toMatch(/^fired ×1· (now|\ds)$/); expect(container.querySelector('.d-rule[aria-label="Question to host"] .d-rule-now')?.textContent).toBe("1 / 1"); expect(container.querySelector('.d-rule[aria-label="Question to host"] .d-rule-avatar')).not.toBeNull(); expect(container.querySelector('.d-rule[aria-label="links"] .d-rule-tag')?.textContent).toBe("⌘");
    key("4"); expect(container.querySelector(".layout-overlay .d-top") === null).toBe(true); expect(container.querySelector(".d-lt-name")?.textContent).toBe("On stage"); expect(container.querySelector(".d-lt-text")?.textContent).toBe("bob: wow"); expect(container.querySelector(".d-chat")).not.toBeNull(); expect(container.querySelectorAll(".d-chat .d-chat-avatar").length).toBe(2);
    // Leaving the overlay: the button, or esc when nothing else is open.
    fireEvent.click(screen.getByLabelText("exit overlay")); expect(container.querySelector(".layout-stage")).not.toBeNull();
    key("4"); key("?"); key("Escape"); expect(container.querySelector(".layout-overlay")).not.toBeNull(); key("Escape"); expect(container.querySelector(".layout-stage")).not.toBeNull();
    key("1"); expect(container.querySelector(".layout-stage .d-meters")).not.toBeNull();
    fireEvent.click(container.querySelector('.d-switch button[title^="Focus"]')!); expect(container.querySelector(".layout-focus")).not.toBeNull();
    fireEvent.click(container.querySelector('.d-switch button[title^="Stage"]')!);
    key("m"); expect(container.querySelector(".d-meters") === null).toBe(true); key("m"); expect(container.querySelector(".d-meters")).not.toBeNull();
    key("c"); expect(container.querySelector(".d-chat") === null).toBe(true); key("c"); expect(container.querySelector(".d-chat")).not.toBeNull();
    key("?"); expect(screen.getByText("Keyboard")).toBeTruthy(); expect(container.querySelector(".d-help-sheet")?.textContent).toContain("prompt done");
    fireEvent.click(container.querySelector(".d-help-sheet")!); expect(screen.getByText("Keyboard")).toBeTruthy();
    fireEvent.click(container.querySelector(".overlay")!); expect(screen.queryByText("Keyboard") === null).toBe(true);
    fireEvent.click(screen.getByLabelText("keyboard shortcuts")); key("Escape"); expect(screen.queryByText("Keyboard") === null).toBe(true);
  });

  test("run of show, countdown, celebrations, wake lock, full screen", async () => {
    localStorage.setItem("jev.director", JSON.stringify({ notes: "Part 1\n- hello\n- topic" }));
    const { container } = render(<Director />);
    key("n"); expect(container.querySelector(".d-stage.with-notes .d-notes")).not.toBeNull(); expect(container.querySelector(".d-notes-count")?.textContent).toBe("0/2");
    fireEvent.click(container.querySelectorAll('.d-notes input[type="checkbox"]')[0]); expect(container.querySelector(".d-notes-count")?.textContent).toBe("1/2");
    fireEvent.click(container.querySelectorAll('.d-notes input[type="checkbox"]')[0]); expect(container.querySelector(".d-notes-count")?.textContent).toBe("0/2");
    fireEvent.click(screen.getByLabelText("hide notes")); expect(container.querySelector(".d-notes") === null).toBe(true);
    fireEvent.click(screen.getByLabelText("run of show")); expect(container.querySelector(".d-notes")).not.toBeNull();
    // Countdown: cancel, invalid, then one second that rings and clears itself; t while running clears.
    const dlg = container.querySelector("dialog")!;
    key("t"); await waitFor(() => expect(dlg.open).toBe(true)); fireEvent.click(screen.getByText("Cancel")); await waitFor(() => expect(dlg.open).toBe(false));
    expect(container.querySelector(".d-timer") === null).toBe(true);
    key("t"); await waitFor(() => expect(dlg.open).toBe(true)); fireEvent.change(dlg.querySelector("input")!, { target: { value: "nope" } }); fireEvent.click(screen.getByText("Start"));
    await waitFor(() => expect(dlg.open).toBe(false)); expect(container.querySelector(".d-timer") === null).toBe(true);
    resetAudioForTests();
    fireEvent.click(screen.getByLabelText("countdown")); await waitFor(() => expect(dlg.open).toBe(true)); fireEvent.change(dlg.querySelector("input")!, { target: { value: "1s" } }); fireEvent.click(screen.getByText("Start"));
    await waitFor(() => expect(container.querySelector(".d-timer-value")?.textContent).toMatch(/^0:0[01]$/));
    await waitFor(() => expect(container.querySelector(".d-timer.done")).not.toBeNull(), { timeout: 3000 });
    expect(FakeAudioContext.instances.at(-1)?.started.length).toBe(2);
    await waitFor(() => expect(container.querySelector(".d-timer") === null).toBe(true));
    key("t"); await waitFor(() => expect(dlg.open).toBe(true)); fireEvent.change(dlg.querySelector("input")!, { target: { value: "5:00" } }); fireEvent.click(screen.getByText("Start"));
    await waitFor(() => expect(container.querySelector(".d-timer-value")?.textContent).toMatch(/^[45]:\d\d$/));
    key("t"); expect(container.querySelector(".d-timer") === null).toBe(true);
    key("t"); await waitFor(() => expect(dlg.open).toBe(true)); fireEvent.change(dlg.querySelector("input")!, { target: { value: "2" } }); fireEvent.click(screen.getByText("Start"));
    await waitFor(() => expect(container.querySelector(".d-timer")).not.toBeNull());
    fireEvent.click(screen.getByLabelText("clear timer")); expect(container.querySelector(".d-timer") === null).toBe(true);
    // Celebrations: a gift and a follow burst, a share does not; they fade after TIMING.burstMs; off = nothing.
    push({ type: "event", event: { kind: "gift", id: "g9", ts: now(), handle: "amy", giftName: "Rose", count: 2, diamonds: 5 } });
    push({ type: "event", event: { kind: "social", ts: now(), handle: "alice", nickname: "Alice", action: "follow" } });
    push({ type: "event", event: { kind: "social", ts: now(), handle: "cy", action: "share" } });
    expect([...container.querySelectorAll(".d-burst-text")].map((b) => b.textContent)).toEqual(["amy sent Rose ×2 · 💎 10", "Alice followed"]);
    // amy never chatted: a lettered fallback; alice did: her chat avatar.
    expect([...container.querySelectorAll(".d-burst-avatar")].map((a) => a.tagName)).toEqual(["SPAN", "IMG"]);
    expect(container.querySelector(".d-top")?.textContent).toContain("➕ 1"); expect(container.querySelector(".d-top")?.textContent).toContain("💎 10");
    await waitFor(() => expect(container.querySelector(".d-burst") === null).toBe(true));
    key("g"); fireEvent.click(screen.getByLabelText("gift & follow celebrations")); key("Escape");
    push({ type: "event", event: { kind: "gift", id: "g10", ts: now(), handle: "amy", giftName: "Rose", count: 1, diamonds: 5 } });
    expect(container.querySelector(".d-burst") === null).toBe(true);
    // Wake lock: no API → nothing; API → on, the system releases it → off; request failing → off.
    key("w"); await new Promise((r) => setTimeout(r, 5)); expect(screen.getByLabelText("keep awake").getAttribute("aria-pressed")).toBe("false");
    let onRelease: (() => void) | null = null;
    const lock = { release: mock(async () => {}), addEventListener: mock((_t: string, f: () => void) => { onRelease = f; }) };
    Object.defineProperty(navigator, "wakeLock", { value: { request: mock(async () => lock) }, configurable: true });
    fireEvent.click(screen.getByLabelText("keep awake")); await waitFor(() => expect(screen.getByLabelText("keep awake").getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(screen.getByLabelText("keep awake")); await waitFor(() => expect(screen.getByLabelText("keep awake").getAttribute("aria-pressed")).toBe("false")); expect(lock.release).toHaveBeenCalled();
    key("w"); await waitFor(() => expect(screen.getByLabelText("keep awake").getAttribute("aria-pressed")).toBe("true"));
    act(() => onRelease?.()); expect(screen.getByLabelText("keep awake").getAttribute("aria-pressed")).toBe("false");
    // A lock whose release fails still counts as off.
    const stubborn = { release: mock(async () => { throw new Error("stuck"); }) };
    Object.defineProperty(navigator, "wakeLock", { value: { request: mock(async () => stubborn) }, configurable: true });
    key("w"); await waitFor(() => expect(screen.getByLabelText("keep awake").getAttribute("aria-pressed")).toBe("true"));
    key("w"); await waitFor(() => expect(screen.getByLabelText("keep awake").getAttribute("aria-pressed")).toBe("false"));
    Object.defineProperty(navigator, "wakeLock", { value: { request: mock(async () => { throw new Error("denied"); }) }, configurable: true });
    key("w"); await new Promise((r) => setTimeout(r, 5)); expect(screen.getByLabelText("keep awake").getAttribute("aria-pressed")).toBe("false");
    delete (navigator as any).wakeLock;
    // Full screen through the Fullscreen API.
    const el = document.documentElement as HTMLElement & { requestFullscreen: () => Promise<void> };
    el.requestFullscreen = mock(async () => { Object.defineProperty(document, "fullscreenElement", { value: el, configurable: true }); document.dispatchEvent(new Event("fullscreenchange")); });
    (document as any).exitFullscreen = mock(async () => { Object.defineProperty(document, "fullscreenElement", { value: null, configurable: true }); document.dispatchEvent(new Event("fullscreenchange")); });
    key("F"); await waitFor(() => expect(screen.getByLabelText("full screen").getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(screen.getByLabelText("full screen")); await waitFor(() => expect(screen.getByLabelText("full screen").getAttribute("aria-pressed")).toBe("false"));
    el.requestFullscreen = mock(async () => { throw new Error("no"); }); key("F"); await new Promise((r) => setTimeout(r, 5));
    delete (document as any).fullscreenElement;
  });

  test("an overlay set by the URL (OBS source) has no exit button and ignores esc", () => {
    window.happyDOM.setURL("http://localhost:5173/?view=director&layout=overlay");
    const { container } = render(<Director />);
    expect(container.querySelector(".layout-overlay")).not.toBeNull(); expect(container.querySelector(".d-exit") === null).toBe(true);
    key("Escape"); expect(container.querySelector(".layout-overlay")).not.toBeNull();
  });

  test("settings panel: every control, hidden questions, URL overrides, sound button", () => {
    window.happyDOM.setURL("http://localhost:5173/?view=director&transparent=1&scale=1.25&warnings=0&ticker=0&meters=0");
    const { container } = render(<Director />);
    expect(container.querySelector(".director.transparent")).not.toBeNull(); expect((container.querySelector(".director") as HTMLElement).style.fontSize).toBe("20px"); expect(container.querySelector(".dc.warn") === null).toBe(true); expect(container.querySelector(".d-chat") === null).toBe(true); expect(container.querySelector(".d-meters") === null).toBe(true);
    expect(document.body.classList.contains("transparent")).toBe(true);
    fireEvent.click(screen.getByLabelText("director settings"));
    expect(screen.getByText("Director view")).toBeTruthy();
    const panel = container.querySelector(".d-panel")!;
    fireEvent.click(panel.querySelectorAll(".d-switch")[0].querySelectorAll("button")[1]); expect(container.querySelector(".layout-focus")).not.toBeNull();
    fireEvent.click(panel.querySelectorAll(".d-switch")[1].querySelectorAll("button")[1]); expect(JSON.parse(localStorage.getItem("jev.director")!).order).toBe("oldest");
    fireEvent.click(panel.querySelectorAll(".d-switch")[1].querySelectorAll("button")[0]); expect(JSON.parse(localStorage.getItem("jev.director")!).order).toBe("newest");
    const ranges = panel.querySelectorAll('input[type="range"]');
    fireEvent.change(ranges[0], { target: { value: "10" } }); fireEvent.change(ranges[1], { target: { value: "2" } }); fireEvent.change(ranges[2], { target: { value: "7" } }); fireEvent.change(ranges[3], { target: { value: "1.5" } });
    expect(JSON.parse(localStorage.getItem("jev.director")!)).toMatchObject({ ttlSec: 10, maxCards: 2, snoozeMin: 7, scale: 1.5 });
    expect((container.querySelector(".director") as HTMLElement).style.fontSize).toBe("20px");
    for (const label of [/^room meters/, /^chat ticker/, /^on-air clock/, /^sound on new prompts/, /^gift & follow celebrations/, /^moderation warnings/, /^transparent background/]) fireEvent.click(screen.getByLabelText(label));
    // The URL overrides pre-check meters / ticker / warnings / transparent, so the first click flips each one the other way.
    expect(JSON.parse(localStorage.getItem("jev.director")!)).toMatchObject({ showMeters: true, showChat: true, showClock: false, sound: true, celebrations: false, showWarnings: true, transparent: false });
    // While the URL forces transparency the box always shows checked, so a click can only save "off"; the override still wins.
    fireEvent.click(screen.getByLabelText(/^transparent background/)); expect(JSON.parse(localStorage.getItem("jev.director")!).transparent).toBe(false); expect(document.body.classList.contains("transparent")).toBe(true);
    expect(container.querySelector(".d-clock") === null).toBe(true);
    fireEvent.change(panel.querySelector("textarea")!, { target: { value: "- a\n- b" } }); expect(JSON.parse(localStorage.getItem("jev.director")!).notes).toBe("- a\n- b");
    const qBoxes = panel.querySelectorAll('.d-qs input[type="checkbox"]');
    fireEvent.click(qBoxes[0]); expect(JSON.parse(localStorage.getItem("jev.director")!).hidden).toEqual(["q1"]); expect(container.querySelectorAll(".dm").length).toBe(0);
    fireEvent.click(qBoxes[0]); expect(JSON.parse(localStorage.getItem("jev.director")!).hidden).toEqual([]);
    fireEvent.click(qBoxes[3]); expect(container.textContent).not.toContain("waiting");
    fireEvent.click(screen.getByLabelText("close settings")); expect(screen.queryByText("Director view") === null).toBe(true);
    fireEvent.click(screen.getByLabelText("sound")); expect(JSON.parse(localStorage.getItem("jev.director")!).sound).toBe(false);
  });

  test("state labels, replay tag, idle texts, recap after the stream, overlay without stream", () => {
    act(() => dispatch({ type: "ws", msg: hello({ seq: 2, decisions: [], highlights: [], questions: { version: 1, createdAt: T0, reason: "x", questions: [question(), question({ id: "a" }), question({ id: "b" }), question({ id: "c" }), question({ id: "d" }), question({ id: "e" })] }, replay: replayInfo() }) }));
    const { container } = render(<Director />);
    expect(container.querySelectorAll(".dm").length).toBe(5); expect(container.querySelector(".d-replay")).not.toBeNull();
    expect(container.querySelector(".d-idle")?.textContent).toContain("waiting for decisions"); expect(container.querySelector(".d-live.warn")?.textContent).toBe("no decision");
    push({ type: "decision", decision: decision({ ts: now(), cached: true }) });
    expect(container.querySelector(".d-idle")?.textContent).toContain("nothing to act on"); expect(container.textContent).toContain("last decision 0 s ago");
    push({ type: "snapshot", snapshot: snapshot({ sources: { transcript: { state: "error", ageMs: 1 }, video: { state: "available", ageMs: 1 }, chat: { state: "available", ageMs: 1 } } }) });
    expect(container.textContent).toContain("transcript unavailable");
    push({ type: "health", health: health({ budget: { spent: 2, cap: 2, stopped: true } }) });
    expect(container.querySelector(".d-live.warn")?.textContent).toBe("paid calls paused"); expect(container.textContent).toContain("decisions paused");
    push({ type: "health", health: health({ breaker: { until: now() + 10_000, reason: "402" } }) });
    expect(container.querySelector(".d-live.warn")?.textContent).toBe("paid calls paused");
    push({ type: "health", health: health() });
    push({ type: "event", event: status({ state: "offline", detail: "stream ended" }) });
    expect(container.querySelector(".d-live")?.textContent).toBe("offline"); expect(container.textContent).toContain("stream ended");
    push({ type: "reset", reason: "ended", summary: summary() });
    expect(container.querySelector(".d-recap")).not.toBeNull(); expect(container.textContent).toContain("Stream ended");
    key("4"); expect(container.querySelector(".d-recap") === null).toBe(true); expect(container.querySelector(".d-overlay")).not.toBeNull(); expect(container.textContent).not.toContain("Feature a prompt");
    key("1");
    act(() => dispatch({ type: "connected", value: false }));
    expect(container.querySelector(".d-live")?.textContent).toBe("console offline");
    act(() => dispatch({ type: "ws", msg: hello({ seq: 9, status: null as any, decisions: [], summary: null, highlights: [] }) }));
    expect(container.querySelector(".d-live")?.textContent).toBe("offline"); expect(container.querySelector(".d-idle")?.textContent).toContain("offline");
    // While the watcher waits for the account, the stage says so instead of "offline".
    push({ type: "watch", watch: watchState({ armed: true, username: "amy" }) });
    expect(container.querySelector(".d-idle span")?.textContent).toBe("waiting for @amy"); expect(container.querySelector(".d-idle small")?.textContent).toContain("connects on its own");
    push({ type: "watch", watch: watchState({ armed: true, username: "amy", detail: "stream dropped; reconnecting" }) });
    expect(container.querySelector(".d-idle small")?.textContent).toBe("stream dropped; reconnecting");
  });
});

describe("main entry", () => {
  test("mounts the console into #root", async () => {
    const saved = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = class { onopen = null; onmessage = null; onclose = null; onerror = null; close() {} constructor(public url: string) {} };
    spyOn(api, "recordings").mockResolvedValue([]); spyOn(api, "timeline").mockResolvedValue(null);
    const host = document.createElement("div"); host.id = "root"; document.body.appendChild(host);
    const { root } = await import("../main");
    await waitFor(() => expect(document.querySelector("#root .app")).not.toBeNull());
    act(() => root.unmount());
    host.remove();
    (globalThis as any).WebSocket = saved;
    void getState;
  });
});
