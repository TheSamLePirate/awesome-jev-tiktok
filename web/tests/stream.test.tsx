import { describe, expect, mock, spyOn, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ScenePanel, Transcript } from "../components/Transcript";
import { Gauges } from "../components/Gauges";
import { DialogHost } from "../components/Dialog";
import { api } from "../lib/api";
import { dispatch, getState } from "../lib/store";
import { choiceQ, decision, hello, localQ, question, sceneHl, scoreQ, transcriptHl, T0 } from "./fixtures";

const sources = (video: any, transcript: any) => ({ transcript, video, chat: { state: "available", ageMs: 1 } });

describe("ScenePanel", () => {
  test("waits for a frame, shows the caption, the scene flag and source states", () => {
    const onOpen = mock(() => {});
    const { container, rerender } = render(<ScenePanel captions={[]} highlights={[]} onOpen={onOpen} />);
    expect(container.textContent).toContain("waiting for first frame");
    const flag = sceneHl({ ts: T0 + 5000 });
    rerender(<ScenePanel captions={[{ ts: T0, text: "old" }, { ts: T0 + 4000, text: "An empty chair." }]} highlights={[flag]} sources={sources({ state: "available", ageMs: 500 }, { state: "stale", ageMs: 12_000 }) as any} onOpen={onOpen} />);
    expect(container.querySelector(".caption.flagged")).not.toBeNull(); expect(container.textContent).toContain("An empty chair.");
    fireEvent.click(screen.getByText("Off camera")); expect(onOpen).toHaveBeenCalledWith(flag);
    expect(container.querySelector(".live-pill.ok")?.textContent).toBe("live");
    rerender(<ScenePanel captions={[{ ts: T0, text: "x" }]} highlights={[sceneHl({ ts: T0 + 60_000 })]} sources={sources({ state: "missing", ageMs: -1 }, { state: "error", ageMs: 5, error: "boom" }) as any} onOpen={onOpen} />);
    expect(container.querySelector(".caption.flagged")).toBeNull(); expect(container.querySelector(".live-pill.bad")?.textContent).toBe("no data");
    rerender(<ScenePanel captions={[{ ts: T0, text: "x" }]} highlights={[]} sources={sources({ state: "error", ageMs: 5, error: "boom" }, undefined) as any} onOpen={onOpen} />);
    expect(container.querySelector(".live-pill.bad")?.textContent).toBe("error");
    rerender(<ScenePanel captions={[{ ts: T0, text: "x" }]} highlights={[]} sources={sources({ state: "stale", ageMs: 9000 }, undefined) as any} onOpen={onOpen} />);
    expect(container.querySelector(".live-pill.warn")?.textContent).toBe("stale · 9 s");
  });
});

describe("Transcript", () => {
  test("lines, interim, marked ranges, empty states, scroll pin", () => {
    const onOpen = mock(() => {});
    const lines = [{ id: "a", ts: T0 + 500, text: "before" }, { id: "b", ts: T0 + 1000, text: "Let us talk about the election." }, { id: "c", ts: T0 + 3000, text: "Politics again." }, { id: "d", ts: T0 + 9000, text: "later" }];
    const { container, rerender } = render(<Transcript lines={[]} interim="" highlights={[]} onOpen={onOpen} />);
    expect(container.textContent).toContain("Listening…");
    rerender(<Transcript lines={[]} interim="" highlights={[]} sources={sources(undefined, { state: "error", ageMs: 1, error: "deepgram down" }) as any} onOpen={onOpen} />);
    expect(container.textContent).toContain("deepgram down");
    const h = transcriptHl();
    rerender(<Transcript lines={lines} interim="typing" highlights={[h, transcriptHl({ id: "res", resolved: true })]} sources={sources(undefined, { state: "available", ageMs: 1 }) as any} onOpen={onOpen} />);
    expect(container.querySelectorAll(".line").length).toBe(5); expect(container.querySelector(".line.interim")?.textContent).toContain("typing");
    expect(container.querySelectorAll("button.line.marked").length).toBe(3); expect(container.querySelectorAll(".mark-label").length).toBe(1);
    expect(container.querySelector(".speaking.on")).not.toBeNull(); expect(container.textContent).toContain("4 lines");
    fireEvent.click(container.querySelector("button.line.marked")!); expect(onOpen).toHaveBeenCalledWith(h);
    const log = container.querySelector(".transcript")!;
    Object.defineProperty(log, "scrollHeight", { value: 900, configurable: true }); Object.defineProperty(log, "clientHeight", { value: 100, configurable: true });
    log.scrollTop = 0; fireEvent.scroll(log);
    fireEvent.click(screen.getByText("newest ↓"));
    expect(screen.queryByText("newest ↓")).toBeNull();
    rerender(<Transcript lines={lines} interim="" highlights={[]} onOpen={onOpen} />);
    expect(container.querySelector(".speaking.on")).toBeNull();
  });
});

describe("Gauges", () => {
  test("empty, skeleton, paused, skipped, noul / choice / score bodies, fired and unsure", () => {
    const qs = [question(), choiceQ(), scoreQ(), localQ({ scope: "window", id: "k2" })];
    const { container, rerender } = render(<Gauges questions={[]} decisions={[]} pausedRuleIds={new Set()} unsureBelow={0.35} live />);
    expect(container.textContent).toContain("No room rules yet");
    rerender(<Gauges questions={qs} decisions={[]} pausedRuleIds={new Set(["r3"])} unsureBelow={0.35} live />);
    expect(container.querySelectorAll(".skeleton").length).toBe(3); expect(container.textContent).toContain("rule paused");
    const d = decision({ answers: { ...decision().answers, k2: { type: "noul", noul: 1 } }, fired: ["q1", "k2"], skipped: ["q3"] });
    rerender(<Gauges questions={qs} decisions={[decision({ tick: 0, answers: { q1: { type: "noul", noul: 0.2 } }, fired: [] }), d]} pausedRuleIds={new Set()} unsureBelow={0.9} live />);
    expect(container.querySelectorAll(".gauge.fired").length).toBe(2); expect(container.querySelectorAll(".fire-badge").length).toBe(2);
    expect(container.textContent).toContain("not evaluated this tick"); expect(container.querySelectorAll(".gauge.unsure").length).toBe(3);
    expect(container.querySelector(".g-hero")?.textContent).toContain("%"); expect(container.querySelectorAll(".g-row").length).toBe(3); expect(container.querySelectorAll(".g-tick").length).toBe(2);
    fireEvent.click(screen.getByText("+1 more")); expect(container.querySelectorAll(".g-row").length).toBe(4);
    fireEvent.click(screen.getByText("fewer")); expect(container.querySelectorAll(".g-row").length).toBe(3);
    expect(container.textContent).toContain("regex"); expect(container.querySelectorAll(".chip").length).toBe(1);
    rerender(<Gauges questions={qs} decisions={[d]} pausedRuleIds={new Set()} unsureBelow={0.9} live={false} />);
    expect(container.textContent).not.toContain("not evaluated this tick"); expect(container.querySelector(".g-score-name")?.textContent).toBe("Warm");
    const objQ = question({ id: "q5", question: { type: "noul", instructions: { nested: true } } });
    rerender(<Gauges questions={[objQ]} decisions={[]} pausedRuleIds={new Set()} unsureBelow={0.35} live />);
    expect(container.querySelector(".gauge")?.getAttribute("title")).toBe('{"nested":true}');
  });
  test("disagree opens the rating prompt and sends feedback", async () => {
    dispatch({ type: "ws", msg: hello() });
    const feedback = spyOn(api, "feedback").mockResolvedValue({ ok: true, rewritten: true } as any);
    const { container } = render(<><Gauges questions={[question(), choiceQ(), scoreQ()]} decisions={[decision()]} pausedRuleIds={new Set()} unsureBelow={0.35} live /><DialogHost /></>);
    const dlg = container.querySelector("dialog")!;
    const btns = container.querySelectorAll('button[aria-label^="disagree"]');
    fireEvent.click(btns[0]);
    await waitFor(() => expect(dlg.open).toBe(true));
    expect(dlg.textContent).toContain('"Host topic" answered 82%');
    fireEvent.click(screen.getByText("Cancel"));
    expect(feedback).not.toHaveBeenCalled();
    fireEvent.click(btns[1]);
    await waitFor(() => expect(dlg.textContent).toContain("answered focused"));
    fireEvent.click(screen.getByText("Cancel"));
    fireEvent.click(btns[2]);
    await waitFor(() => expect(dlg.textContent).toContain("answered 1.4"));
    fireEvent.change(container.querySelector("dialog textarea")!, { target: { value: "should be hot" } });
    fireEvent.click(screen.getByText("Send and rewrite"));
    await waitFor(() => expect(feedback).toHaveBeenCalled());
    expect(feedback.mock.calls[0][0]).toMatchObject({ questionId: "q3", verdict: "wrong", note: "should be hot" });
    await waitFor(() => expect(getState().toasts.some((t) => t.title === 'GLM rewrote "Hype"')).toBe(true));
    feedback.mockResolvedValue({ ok: true, rewritten: false } as any);
    act(() => dispatch({ type: "ws", msg: { ...hello(), seq: 50 } as any }));
    act(() => dispatch({ type: "ws", msg: { type: "snapshot", snapshot: null as any, seq: 51 } }));
    fireEvent.click(btns[0]);
    await waitFor(() => expect(dlg.open).toBe(true));
    fireEvent.click(screen.getByText("Send and rewrite"));
    await waitFor(() => expect(getState().toasts.some((t) => t.title === "Feedback recorded")).toBe(true));
    expect(feedback.mock.calls[1][0]).toMatchObject({ stateExcerpt: null, note: undefined });
    feedback.mockRejectedValue(new Error("api down"));
    fireEvent.click(btns[0]);
    await waitFor(() => expect(dlg.open).toBe(true));
    fireEvent.click(screen.getByText("Send and rewrite"));
    await waitFor(() => expect(feedback).toHaveBeenCalledTimes(3));
    feedback.mockRestore();
  });
});
