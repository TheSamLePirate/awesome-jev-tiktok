import { describe, expect, spyOn, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HealthBar } from "../components/HealthBar";
import { EventsFeed } from "../components/EventsFeed";
import { SessionSummary } from "../components/SessionSummary";
import { GlmLog } from "../components/GlmLog";
import { Versions } from "../components/Versions";
import { ActivityLog } from "../components/ActivityLog";
import { Toasts } from "../components/Toasts";
import { DialogHost } from "../components/Dialog";
import { api } from "../lib/api";
import { dispatch, getState, toast } from "../lib/store";
import { choiceQ, glm, health, hello, highlight, logEntry, push, qset, question, roomHl, sceneHl, scoreQ, summary, totals, transcriptHl, T0 } from "./fixtures";

const downloads = () => { const names: string[] = []; const s = spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download); }); return { names, restore: () => s.mockRestore() }; };

describe("HealthBar", () => {
  test("renders nothing when healthy, one pill per problem", () => {
    const now = T0 + 20_000;
    const { container, rerender } = render(<HealthBar health={null} live now={now} />);
    expect(container.innerHTML).toBe("");
    rerender(<HealthBar health={health()} live={false} now={now} />);
    expect(container.innerHTML).toBe("");
    rerender(<HealthBar health={health({ breaker: { until: now + 1000, reason: "401" }, budget: { spent: 2, cap: 2, stopped: true }, rateLimitedUntil: now + 3000, ffmpeg: "exited", deepgram: "backoff", deepgramDetail: "429", lastTickAt: now - 30_000, chatBacklog: 50, recorder: "finalizing", diskFreeBytes: 1e9 })} live now={now} />);
    const items = [...container.querySelectorAll(".health-item")].map((e) => e.textContent);
    expect(items).toEqual(["paid calls paused: 401", "budget reached ($2.00) · paid calls stopped", "rate limited · retry in 3 s", "ffmpeg exited", "speech reconnecting · 429", "no decision for 30 s", "chat backlog 50", "finalizing recording…", "disk: 1.00 GB free"]);
    rerender(<HealthBar health={health({ deepgram: "gave-up", deepgramDetail: "key", diskFreeBytes: null, lastTickAt: 0 })} live now={now} />);
    expect(container.textContent).toContain("speech off: Deepgram gave up");
    rerender(<HealthBar health={health({ deepgram: "backoff", lastTickAt: now })} live now={now} />);
    expect(container.textContent).toBe("speech reconnecting");
  });
});

describe("EventsFeed", () => {
  test("empty, gifts with top gifters, social and joins", () => {
    const { container, rerender } = render(<EventsFeed events={[]} />);
    expect(container.innerHTML).toBe("");
    rerender(<EventsFeed events={[
      { kind: "gift", id: "g1", ts: T0, handle: "bob", giftName: "Rose", count: 2, diamonds: 5 }, { kind: "gift", id: "g2", ts: T0, handle: "amy", giftName: "Lion", count: 1, diamonds: 100 },
      { kind: "social", ts: T0, handle: "cy", action: "follow" }, { kind: "social", ts: T0, handle: "dee", action: "share" }, { kind: "social", ts: T0, handle: "ed", action: "other" },
      { kind: "member", ts: T0, handle: "fay", nickname: "" }, { kind: "member", ts: T0, handle: "gus", nickname: "Gus" },
    ]} />);
    const chips = [...container.querySelectorAll(".events-top .chip")].map((c) => c.textContent);
    expect(chips[0]).toContain("amy · 100"); expect(chips[1]).toContain("bob · 10");
    const evs = [...container.querySelectorAll(".ev")].map((e) => e.textContent?.replace(/now$/, ""));
    expect(evs).toEqual(["👋 Gus joined", "👋 fay joined", "✦ ed ", "🔁 dee shared", "➕ cy followed", "🎁 amy · Lion", "🎁 bob · Rose ×2"]);
  });
});

describe("SessionSummary", () => {
  test("shows the numbers, exports and replays", () => {
    const d = downloads();
    const onReplay = spyOn({ f: (_: string) => {} }, "f");
    const { container, rerender } = render(<SessionSummary s={summary()} highlights={[highlight({ sessionId: "s1" }), transcriptHl({ sessionId: "s1" }), sceneHl({ sessionId: "s1" }), roomHl({ sessionId: "other" })]} onReplay={onReplay} />);
    expect(container.textContent).toContain("1m 30s"); expect(container.textContent).toContain("Fired most");
    fireEvent.click(screen.getByText("▶ Replay this session")); expect(onReplay).toHaveBeenCalledWith("rec-1");
    fireEvent.click(screen.getByText("⤓ flags CSV")); fireEvent.click(screen.getByText("⤓ summary .md"));
    expect(d.names).toEqual(["jev-s1-flags.csv", "jev-s1.md"]);
    rerender(<SessionSummary s={summary({ warnings: 0, topFired: [], recording: undefined, title: undefined })} highlights={[]} />);
    expect(container.textContent).not.toContain("Fired most"); expect(screen.queryByText("▶ Replay this session")).toBeNull();
    fireEvent.click(screen.getByText("⤓ summary .md"));
    expect(d.names.length).toBe(3);
    d.restore();
  });
});

describe("GlmLog", () => {
  test("idle text and items", () => {
    const { container, rerender } = render(<GlmLog items={[]} />);
    expect(container.textContent).toContain("GLM is idle");
    rerender(<GlmLog items={[glm(), glm({ id: "g2", status: "running", tokens: undefined, kind: "refine" })]} />);
    expect(container.querySelectorAll(".glm-item").length).toBe(2); expect(container.textContent).toContain("800 tok");
  });
});

describe("Versions", () => {
  test("diffs per version, toggle, restore through the dialog", async () => {
    const restore = spyOn(api, "restoreVersion").mockResolvedValue({ ok: true } as any);
    const v1 = qset([question()], { version: 1, reason: "seed" });
    const v2 = qset([question({ question: { type: "noul", instructions: "changed", criteria: { true: "y" } } }), choiceQ(), scoreQ()], { version: 2, reason: "rule added" });
    const v3 = qset([choiceQ(), scoreQ({ question: { type: "score", instructions: "How hyped?", criteria: ["Flat", "Warm", "Hot", "On fire", "Nuclear"] } })], { version: 3, reason: "restored", restoredFrom: 1 });
    const v4 = qset([choiceQ(), scoreQ({ question: { type: "score", instructions: "How hyped?", criteria: ["Flat", "Warm", "Hot", "On fire", "Nuclear"] } })], { version: 4, reason: "no-op" });
    const { container } = render(<><Versions history={[v1, v2, v3, v4]} /><DialogHost /></>);
    expect(container.querySelector(".version.open .chip.v")?.textContent).toBe("v4");
    expect(container.textContent).toContain("2 questions: Mood, Hype");
    fireEvent.click(screen.getByText("v3"));
    expect(container.textContent).toContain("(from v1)"); expect(container.querySelectorAll(".version.open").length).toBe(1);
    expect(container.querySelector(".badge.del")?.textContent).toBe("−1");
    fireEvent.click(screen.getByText("v2"));
    expect(container.querySelectorAll(".diff-q").length).toBe(3); expect(container.querySelectorAll(".badge.add").length).toBeGreaterThan(0);
    expect(container.textContent).toContain("− Is the host talking about politics?");
    fireEvent.click(screen.getByText("↺ restore this version"));
    await waitFor(() => expect(screen.getByText("Restore version 2?")).toBeTruthy());
    fireEvent.click(screen.getByText("Cancel"));
    expect(restore).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("↺ restore this version"));
    await waitFor(() => expect(screen.getByText("Restore")).toBeTruthy());
    fireEvent.click(screen.getByText("Restore"));
    await waitFor(() => expect(restore).toHaveBeenCalledWith(2));
    await waitFor(() => expect(getState().toasts.some((t) => t.title === "Restored v2 as a new version")).toBe(true));
    restore.mockRejectedValue(new Error("x"));
    fireEvent.click(screen.getByText("↺ restore this version"));
    await waitFor(() => expect(screen.getByText("Restore")).toBeTruthy());
    fireEvent.click(screen.getByText("Restore"));
    await waitFor(() => expect(restore).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByText("v2"));
    expect(container.querySelectorAll(".version.open").length).toBe(0);
    restore.mockRestore();
  });
});

describe("ActivityLog", () => {
  test("totals, filters, search, export, scroll pin", () => {
    const d = downloads();
    const entries = [logEntry(), logEntry({ id: "l0", latencyMs: 450 }), logEntry({ id: "l2", actor: "glm", kind: "compile", ok: false, latencyMs: 900, inputTokens: undefined, cost: 0.002, costKind: "estimated" }), logEntry({ id: "l3", actor: "vision", kind: "caption", questions: undefined, cost: undefined, sessionId: undefined }), logEntry({ id: "l4", actor: "deepgram", kind: "minute", latencyMs: undefined }), logEntry({ id: "l5", actor: "system", kind: "connect", detail: "connected @koursk1" }), logEntry({ id: "l6", actor: "weird" as any, kind: "x" })];
    const { container } = render(<ActivityLog entries={entries} totals={totals()} />);
    expect(container.querySelectorAll(".log-total").length).toBe(5); expect(container.querySelectorAll(".log-row:not(.head)").length).toBe(7);
    expect(container.querySelector(".log-total.jev")?.textContent).toContain("p50 450 ms");
    fireEvent.click(screen.getByRole("button", { name: "✎ GLM" }));
    expect(container.querySelectorAll(".log-row:not(.head)").length).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "✎ GLM" })); fireEvent.click(screen.getByText("errors"));
    expect(container.querySelectorAll(".log-row.err").length).toBe(1); expect(container.querySelectorAll(".log-row:not(.head)").length).toBe(1);
    fireEvent.click(screen.getByText("errors"));
    fireEvent.change(screen.getByLabelText("filter log"), { target: { value: "koursk" } });
    expect(container.querySelectorAll(".log-row:not(.head)").length).toBe(1);
    fireEvent.change(screen.getByLabelText("filter log"), { target: { value: "zzz" } });
    expect(screen.getByText("No activity yet.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("filter log"), { target: { value: "" } });
    fireEvent.click(screen.getByTitle("export CSV"));
    expect(d.names[0]).toMatch(/^awesome-jev-log-.*\.csv$/);
    const list = container.querySelector(".log-list")!;
    Object.defineProperty(list, "scrollHeight", { value: 1000, configurable: true }); Object.defineProperty(list, "clientHeight", { value: 100, configurable: true });
    list.scrollTop = 0; fireEvent.scroll(list);
    expect(screen.getByText("newest ↓")).toBeTruthy();
    fireEvent.click(screen.getByText("newest ↓"));
    expect(screen.queryByText("newest ↓")).toBeNull();
    render(<ActivityLog entries={[]} totals={totals({ session: 0, estimated: 0 })} />);
    d.restore();
  });
});

describe("Toasts", () => {
  test("highlight toasts open / watch, info toast body, undo action, dismiss, lifetimes", async () => {
    dispatch({ type: "ws", msg: hello() });
    act(() => dispatch({ type: "clearToasts" }));
    const onOpen = spyOn({ f: (_: unknown) => {} }, "f"), onWatch = spyOn({ f: (_: number) => {} }, "f"), run = spyOn({ f: () => {} }, "f");
    const { container } = render(<Toasts onOpen={onOpen} onWatch={onWatch} />);
    push({ type: "highlight", highlight: highlight({ id: "t1" }), fresh: true });
    push({ type: "highlight", highlight: transcriptHl({ id: "t2", severity: "warn" }), fresh: true });
    push({ type: "highlight", highlight: sceneHl({ id: "t3" }), fresh: true });
    push({ type: "highlight", highlight: roomHl({ id: "t4", severity: undefined }), fresh: true });
    await waitFor(() => expect(container.querySelectorAll(".toast").length).toBe(4));
    expect(container.textContent).toContain("Alice: Hello host"); expect(container.textContent).toContain("Politics again"); expect(container.textContent).toContain("room activity"); expect(container.querySelector(".toast.warn")).not.toBeNull();
    fireEvent.click(container.querySelector(".toast-main")!); expect(onOpen).toHaveBeenCalled();
    fireEvent.click(container.querySelector('[title="watch this moment"]')!); expect(onWatch).toHaveBeenCalled();
    // The stack is capped at five: the oldest highlight toasts fall off.
    act(() => { toast({ kind: "error", title: "Boom", body: "detail" }); toast({ kind: "undo", title: "Deleted", action: { label: "Undo", run }, durationMs: 30 }); toast({ kind: "info", title: "Info" }); });
    await waitFor(() => expect(container.querySelectorAll(".toast").length).toBe(5));
    expect(container.textContent).not.toContain("Alice: Hello host");
    fireEvent.click(screen.getByText("Undo")); expect(run).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText("Deleted")).toBeNull());
    const error = [...container.querySelectorAll(".toast")].find((t) => t.textContent?.includes("Boom"))!;
    expect((error.querySelector(".toast-bar") as HTMLElement).style.animationDuration).toBe("8000ms");
    fireEvent.click(error.querySelector('[aria-label="dismiss"]')!);
    await waitFor(() => expect(screen.queryByText("Boom")).toBeNull());
    act(() => dispatch({ type: "clearToasts" }));
    act(() => toast({ kind: "info", title: "Short", durationMs: 20 }));
    await waitFor(() => expect(screen.queryByText("Short")).toBeNull());
  });
});
