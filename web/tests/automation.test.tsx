import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HealthBar } from "../components/HealthBar";
import { RulesPanel } from "../components/RulesPanel";
import { Recordings } from "../components/Recordings";
import { Director } from "../Director";
import { api } from "../lib/api";
import { resetAudioForTests } from "../lib/audio";
import { dispatch, getState } from "../lib/store";
import { assistState, decision, health, hello, highlight, localQ, push, qset, question, recording, rule, snapshot, status } from "./fixtures";
import { FakeAudioContext } from "./setup";

describe("assist state in the store", () => {
  test("comes with hello and follows assist messages", () => {
    act(() => dispatch({ type: "ws", msg: hello() }));
    expect(getState().assist).toEqual(assistState());
    push({ type: "assist", assist: assistState({ regime: "hot", degrade: 1 }) });
    expect(getState().assist).toMatchObject({ regime: "hot", degrade: 1 });
  });
});

describe("HealthBar shows jev's decisions about the app", () => {
  const now = Date.now();
  beforeEach(() => act(() => dispatch({ type: "ws", msg: hello() })));
  test("budget warning at 80 %, degradation levels, repairs applied or suggested with a reconnect button, the regime", async () => {
    const disconnect = spyOn(api, "disconnect").mockResolvedValue({ ok: true } as any);
    const watch = spyOn(api, "watch").mockResolvedValue({ ok: true, watch: {} } as any);
    const h = health({ budget: { spent: 1.7, cap: 2, stopped: false } });
    const { container, rerender } = render(<HealthBar health={h} live now={now} />);
    expect(container.querySelector(".healthbar") === null).toBe(true);
    push({ type: "assist", assist: assistState({ budgetAlert: true }) });
    expect(container.textContent).toContain("budget: 85% spent");
    push({ type: "assist", assist: assistState({ budgetAlert: true, degrade: 1 }) });
    expect(container.textContent).toContain("vision paused"); expect(container.textContent).not.toContain("85%");
    push({ type: "assist", assist: assistState({ degrade: 2, repair: { action: "restart_media", detail: "media pipeline restarted", at: now, applied: true }, regime: "calm" }) });
    expect(container.textContent).toContain("vision and chat judging paused"); expect(container.querySelector(".health-item.ok")?.textContent).toContain("jev repaired: media pipeline restarted"); expect(container.textContent).toContain("room calm");
    push({ type: "assist", assist: assistState({ repair: { action: "reconnect", detail: "reconnecting the session suggested", at: now, applied: false }, regime: "normal" }) });
    expect(container.textContent).toContain("jev suggests: reconnecting the session suggested"); expect(container.textContent).not.toContain("room normal");
    fireEvent.click(screen.getByText("reconnect"));
    await waitFor(() => expect(watch).toHaveBeenCalledWith(true));
    expect(disconnect).toHaveBeenCalled();
    // Old repairs and "none" are not shown; nothing shows when not live.
    push({ type: "assist", assist: assistState({ repair: { action: "alert", detail: "look", at: now - 11 * 60_000, applied: false } }) });
    expect(container.querySelector(".healthbar") === null).toBe(true);
    push({ type: "assist", assist: assistState({ degrade: 2 }) });
    rerender(<HealthBar health={h} live={false} now={now} />);
    expect(container.querySelector(".healthbar") === null).toBe(true);
    // A stopped budget takes precedence over the 80 % line.
    push({ type: "assist", assist: assistState({ budgetAlert: true }) });
    rerender(<HealthBar health={health({ budget: { spent: 2, cap: 2, stopped: true } })} live now={now} />);
    expect(container.textContent).toContain("budget reached"); expect(container.textContent).not.toContain("% spent");
    disconnect.mockRejectedValue(new Error("x")); push({ type: "assist", assist: assistState({ repair: { action: "reconnect", detail: "r", at: now, applied: false } }) }); fireEvent.click(screen.getByText("reconnect"));
    disconnect.mockRestore(); watch.mockRestore();
  });
});

describe("rule advice in the rules panel", () => {
  test("a chip per advised rule; apply pauses, removes with undo, or opens the editor; dismiss hides it; a paused rule hides a pause advice", async () => {
    const pause = spyOn(api, "pauseRule").mockResolvedValue({ ok: true } as any);
    const remove = spyOn(api, "removeRule").mockResolvedValue({ ok: true, undoMs: 60_000 } as any);
    const recs = spyOn(api, "recordings").mockResolvedValue([]);
    act(() => dispatch({ type: "ws", msg: hello() }));
    const at = Date.now();
    push({ type: "assist", assist: assistState({ ruleAdvice: { r1: { advice: "pause", reason: "fires none · in 0/3 sessions", at }, r2: { advice: "remove", reason: "useless", at }, r3: { advice: "refine", reason: "2 wrong", at }, r4: { advice: "pause", reason: "x", at } } }) });
    const rules = [rule(), rule({ id: "r2", text: "mood", sources: ["chat"] }), rule({ id: "r3", text: "links", kind: "keyword", sources: ["chat"] }), rule({ id: "r4", text: "already paused", paused: true })];
    const { container } = render(<RulesPanel rules={rules} questions={qset([question(), localQ({ ruleId: "r3" })])} compiling={false} />);
    expect(container.querySelectorAll(".rule-advice").length).toBe(3);
    expect(container.querySelector(".rule-advice.pause")?.textContent).toContain("jev suggests: pause it"); expect(container.textContent).toContain("fires none · in 0/3 sessions");
    fireEvent.click(container.querySelectorAll(".rule-advice .chip-btn")[0]);
    await waitFor(() => expect(pause).toHaveBeenCalledWith("r1", true));
    await waitFor(() => expect(container.querySelectorAll(".rule-advice").length).toBe(2));
    fireEvent.click(container.querySelector(".rule-advice.remove .chip-btn")!);
    await waitFor(() => expect(remove).toHaveBeenCalledWith("r2"));
    await waitFor(() => expect(getState().toasts.some((t) => t.title === "Rule removed")).toBe(true));
    fireEvent.click(container.querySelector(".rule-advice.refine .chip-btn")!);
    await waitFor(() => expect(container.querySelector(".rule-edit")).not.toBeNull());
    expect(container.querySelectorAll(".rule-advice").length).toBe(0);
    // A fresh advice for the same rule shows again; dismiss hides it without a call.
    push({ type: "assist", assist: assistState({ ruleAdvice: { r1: { advice: "pause", reason: "again", at: at + 1 } } }) });
    expect(container.querySelectorAll(".rule-advice").length).toBe(1);
    fireEvent.click(screen.getByText("dismiss"));
    expect(container.querySelectorAll(".rule-advice").length).toBe(0);
    pause.mockRejectedValue(new Error("x"));
    push({ type: "assist", assist: assistState({ ruleAdvice: { r1: { advice: "pause", reason: "again", at: at + 2 } } }) });
    fireEvent.click(container.querySelector(".rule-advice .chip-btn")!);
    await new Promise((r) => setTimeout(r, 10));
    expect(container.querySelectorAll(".rule-advice").length).toBe(1);
    pause.mockRestore(); remove.mockRestore(); recs.mockRestore();
  });
});

describe("recordings keep badge", () => {
  test("shows jev's retention verdict with its reason", async () => {
    const list = spyOn(api, "recordings").mockResolvedValue([recording({ keep: "keep", keepReason: "long · chat many" }), recording({ id: "rec-2", keep: "expendable", keepReason: "under 3 min" }), recording({ id: "rec-3", keep: "ok" }), recording({ id: "rec-4" })]);
    const { container } = render(<Recordings live={false} active />);
    await waitFor(() => expect(container.querySelectorAll(".rec").length).toBe(4));
    expect([...container.querySelectorAll(".badge[class*='keep-']")].map((b) => b.textContent)).toEqual(["keep", "expendable", "ok"]);
    expect(container.querySelector(".badge.keep-keep")?.getAttribute("title")).toBe("jev's retention verdict: long · chat many");
    expect(container.querySelector(".badge.keep-ok")?.getAttribute("title")).toBe("jev's retention verdict: ");
    list.mockRestore();
  });
});

describe("director chime waits for a pause", () => {
  beforeEach(() => {
    window.happyDOM.setURL("http://localhost:5173/?view=director");
    localStorage.setItem("jev.director", JSON.stringify({ sound: true }));
    const t = Date.now();
    act(() => dispatch({ type: "ws", msg: hello({ status: status({ ts: t - 65_000 }), decisions: [decision({ ts: t })], highlights: [] }) }));
    push({ type: "snapshot", snapshot: snapshot() });
  });
  afterEach(() => window.happyDOM.setURL("http://localhost:5173/"));
  test("a prompt while the host is busy is held, then rings when jev says free; a warning rings at once", async () => {
    resetAudioForTests();
    render(<Director />);
    push({ type: "assist", assist: assistState({ interruptible: "busy" }) });
    push({ type: "highlight", highlight: highlight({ id: "n1", ts: Date.now() }), fresh: true });
    expect(FakeAudioContext.instances.at(-1)?.started.length ?? 0).toBe(0);
    push({ type: "highlight", highlight: highlight({ id: "w1", ts: Date.now(), severity: "warn" }), fresh: true });
    expect(FakeAudioContext.instances.at(-1)?.started.length).toBe(2); // the warning chime (two tones)
    push({ type: "assist", assist: assistState({ interruptible: "free" }) });
    await waitFor(() => expect(FakeAudioContext.instances.at(-1)?.started.length).toBe(4)); // the held prompt chime
    // Nothing held: a switch changes nothing.
    push({ type: "assist", assist: assistState({ interruptible: "busy" }) });
    push({ type: "assist", assist: assistState({ interruptible: "free" }) });
    expect(FakeAudioContext.instances.at(-1)?.started.length).toBe(4);
  });
});
