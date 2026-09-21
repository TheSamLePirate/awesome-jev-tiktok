import { describe, expect, mock, spyOn, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReviewStrip, Timeline } from "../components/Timeline";
import { api } from "../lib/api";
import { highlight, replayInfo, sceneHl, timeline, transcriptHl, T0 } from "./fixtures";

/** Keys are dispatched on an element (never on the window itself), as a browser does; they bubble to the window listener. */
const keyOn = (target: EventTarget, key: string, init: KeyboardEventInit = {}) => act(() => { (target === window ? document.body : target).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })); });

describe("Timeline", () => {
  test("live mode: labels, seek by click and keys, hover tip, marks, search with results", async () => {
    const search = spyOn(api, "search").mockResolvedValue([{ ts: T0 + 1000, offsetMs: 1000, kind: "chat", text: "hello world", handle: "alice", nickname: "Alice" }, { ts: T0 + 5000, offsetMs: 5000, kind: "transcript", text: "world peace" }]);
    const context = spyOn(api, "context").mockResolvedValue({ ts: T0 + 1000, transcript: [], chat: [], captions: [] });
    const onSeek = mock((_ts: number) => {}), onLive = mock(() => {}), onReview = mock(() => {}), onQuery = mock(() => {});
    const now = Date.now();
    const tl = timeline({ startTs: now - 100_000, endTs: now, dvrStartTs: now - 50_000 });
    const hls = [highlight({ ts: now - 20_000 }), transcriptHl({ ts: now - 30_000 }), sceneHl({ ts: now - 10_000, severity: "warn" }), highlight({ id: "old", ts: now - 900_000 })];
    const { container, rerender } = render(<Timeline mode={{ kind: "live", timeline: tl, playingTs: now - 2000, behindSec: 2, reviewTs: null }} highlights={hls} onSeek={onSeek} onLive={onLive} onReview={onReview} query="" onQuery={onQuery} />);
    expect(container.querySelector(".rb-tag.live")?.textContent).toBe("LIVE"); expect(container.querySelectorAll(".rb-mark").length).toBe(3); expect(container.querySelector(".rb-mark.warn")).not.toBeNull(); expect(container.querySelector(".rb-nodvr")).not.toBeNull();
    expect(container.querySelector(".rb-remaining")?.textContent).toBe("live");
    const track = container.querySelector(".rb-track")!;
    Object.defineProperty(track, "getBoundingClientRect", { value: () => ({ left: 100, width: 200 }), configurable: true });
    fireEvent.mouseMove(track, { clientX: 150 });
    expect(container.querySelector(".rb-tip")).not.toBeNull();
    fireEvent.mouseLeave(track); expect(container.querySelector(".rb-tip")).toBeNull();
    // The live edge is the component's own clock, a few ms after the test's `now`.
    const last = () => onSeek.mock.calls.at(-1)![0];
    const nearNow = () => { expect(last()).toBeGreaterThanOrEqual(now); expect(last()).toBeLessThanOrEqual(Date.now()); };
    fireEvent.click(track, { clientX: 400 }); nearNow();
    fireEvent.click(track, { clientX: 0 }); expect(onSeek).toHaveBeenLastCalledWith(now - 100_000);
    fireEvent.keyDown(track, { key: "Home" }); expect(onSeek).toHaveBeenLastCalledWith(now - 100_000);
    fireEvent.keyDown(track, { key: "End" }); expect(onLive).toHaveBeenCalledTimes(1);
    keyOn(track, "ArrowLeft"); expect(onSeek).toHaveBeenLastCalledWith(now - 12_000);
    keyOn(document.body, "ArrowRight"); nearNow();
    keyOn(window, "l"); expect(onLive).toHaveBeenCalledTimes(2);
    keyOn(window, "l", { metaKey: true }); expect(onLive).toHaveBeenCalledTimes(2);
    const seeks = onSeek.mock.calls.length;
    const btn = document.createElement("button"); document.body.appendChild(btn); keyOn(btn, "ArrowLeft"); expect(onSeek).toHaveBeenCalledTimes(seeks); btn.remove();
    const other = document.createElement("input"); document.body.appendChild(other); keyOn(other, "ArrowLeft"); expect(onSeek).toHaveBeenCalledTimes(seeks); other.remove();
    // Reviewing: the tag becomes a button back to live.
    rerender(<Timeline mode={{ kind: "live", timeline: tl, playingTs: now - 30_000, behindSec: 30, reviewTs: now - 30_000 }} highlights={hls} onSeek={onSeek} onLive={onLive} onReview={onReview} query="" onQuery={onQuery} />);
    expect(container.querySelector(".replaybar.reviewing")).not.toBeNull(); expect(container.querySelector(".rb-remaining")?.textContent).toMatch(/^−0:3\d$/);
    fireEvent.click(screen.getByText("⏪ REVIEW · back to live")); expect(onLive).toHaveBeenCalledTimes(3);
    // Search: ⌘K focuses, typing calls onQuery, a query opens the results, arrows/enter navigate, Escape closes.
    const input = screen.getByLabelText("search the session") as HTMLInputElement;
    keyOn(window, "k", { metaKey: true }); expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "wor" } }); expect(onQuery).toHaveBeenCalledWith("wor");
    rerender(<Timeline mode={{ kind: "live", timeline: tl, playingTs: now, behindSec: 0, reviewTs: null }} highlights={hls} onSeek={onSeek} onLive={onLive} onReview={onReview} query="wor" onQuery={onQuery} />);
    await waitFor(() => expect(search).toHaveBeenCalledWith("wor", ["chat", "transcript"]));
    await waitFor(() => expect(container.querySelectorAll(".rb-hit").length).toBe(2));
    expect(container.querySelector(".rb-results-head")?.textContent).toContain("2 results"); expect(container.querySelectorAll("mark").length).toBe(2);
    keyOn(input, "ArrowDown"); expect(container.querySelectorAll(".rb-hit")[1].classList.contains("on")).toBe(true);
    keyOn(input, "ArrowUp"); expect(container.querySelectorAll(".rb-hit")[0].classList.contains("on")).toBe(true);
    fireEvent.mouseEnter(container.querySelectorAll(".rb-hit")[1]);
    keyOn(input, "Enter");
    await waitFor(() => expect(onReview).toHaveBeenCalled());
    expect(onSeek).toHaveBeenLastCalledWith(T0 + 4000); expect(context).toHaveBeenCalledWith(T0 + 5000);
    expect(container.querySelector(".rb-results")).toBeNull();
    fireEvent.focus(input); expect(container.querySelector(".rb-results")).not.toBeNull();
    fireEvent.mouseDown(container.querySelector(".rb-results")!);
    // Kind toggles re-run the search at once (no debounce); the last kind cannot be switched off.
    fireEvent.click(screen.getByText("🎙 speech")); await waitFor(() => expect(search).toHaveBeenLastCalledWith("wor", ["chat"]));
    fireEvent.click(screen.getByText("💬 chat")); await new Promise((r) => setTimeout(r, 30)); expect(search).toHaveBeenLastCalledWith("wor", ["chat"]);
    fireEvent.click(screen.getByText("🎙 speech")); await waitFor(() => expect(search).toHaveBeenLastCalledWith("wor", ["chat", "transcript"]));
    fireEvent.click(container.querySelectorAll(".rb-hit")[0]);
    await waitFor(() => expect(onSeek).toHaveBeenLastCalledWith(T0 + 1000));
    fireEvent.focus(input);
    fireEvent.click(container.querySelector('.rb-results-head [aria-label="close"]')!); expect(container.querySelector(".rb-results")).toBeNull();
    fireEvent.focus(input); keyOn(input, "Escape"); expect(container.querySelector(".rb-results")).toBeNull();
    // A context fetch that fails still lands the seek; the review gets no context.
    context.mockRejectedValue(new Error("x"));
    fireEvent.focus(input);
    await waitFor(() => expect(container.querySelector(".rb-results")).not.toBeNull());
    fireEvent.click(container.querySelectorAll(".rb-hit")[1]);
    await waitFor(() => expect(onReview).toHaveBeenLastCalledWith(null, "wor"));
    search.mockResolvedValue([]);
    rerender(<Timeline mode={{ kind: "live", timeline: tl, playingTs: now, behindSec: 0, reviewTs: null }} highlights={hls} onSeek={onSeek} onLive={onLive} onReview={onReview} query="zzz" onQuery={onQuery} />);
    await waitFor(() => expect(container.querySelector(".rb-results-head")?.textContent).toContain("no match"));
    keyOn(input, "ArrowDown"); keyOn(input, "Enter");
    search.mockRejectedValue(new Error("x"));
    rerender(<Timeline mode={{ kind: "live", timeline: tl, playingTs: now, behindSec: 0, reviewTs: null }} highlights={hls} onSeek={onSeek} onLive={onLive} onReview={onReview} query="err" onQuery={onQuery} />);
    await waitFor(() => expect(search).toHaveBeenLastCalledWith("err", ["chat", "transcript"]));
    rerender(<Timeline mode={{ kind: "live", timeline: tl, playingTs: null, behindSec: 0, reviewTs: null }} highlights={[]} onSeek={onSeek} onLive={onLive} onReview={onReview} query="" onQuery={onQuery} />);
    search.mockRestore(); context.mockRestore();
  });
  test("replay mode: tag, who, remaining, End seeks to the end, dry-run note", () => {
    const onSeek = mock(() => {}), onLive = mock(() => {});
    const rp = replayInfo({ startedAt: Date.now() - 1000, offsetMs: 10_000 });
    const { container, rerender } = render(<Timeline mode={{ kind: "replay", replay: rp }} highlights={[]} onSeek={onSeek} onLive={onLive} onReview={() => {}} query="" onQuery={() => {}} />);
    expect(container.querySelector(".rb-tag")?.textContent).toContain("REPLAY"); expect(container.textContent).toContain("dry"); expect(container.querySelector(".rb-who")?.textContent).toBe("@koursk1 · Débat");
    expect(container.querySelector(".rb-remaining")?.textContent).toMatch(/^−/); expect(container.querySelector(".rb-video span")).not.toBeNull();
    fireEvent.keyDown(container.querySelector(".rb-track")!, { key: "End" }); expect(onSeek).toHaveBeenLastCalledWith(rp.tEnd);
    keyOn(window, "l"); expect(onLive).not.toHaveBeenCalled();
    rerender(<Timeline mode={{ kind: "replay", replay: replayInfo({ title: undefined, dryRun: false, buckets: [] }) }} highlights={[]} onSeek={onSeek} onLive={onLive} onReview={() => {}} query="" onQuery={() => {}} />);
    expect(container.textContent).not.toContain("dry"); expect(container.querySelector(".rb-title")).toBeNull();
  });
});

describe("ReviewStrip", () => {
  test("shows host and chat around the moment, hits, dvr note, buttons", () => {
    const onClose = mock(() => {}), onLive = mock(() => {});
    const ctx = { ts: T0, transcript: [{ ts: T0 + 500, text: "at the moment" }, { ts: T0 + 20_000, text: "later" }], chat: [{ ts: T0 - 200, handle: "bob", nickname: "", text: "now" }, { ts: T0 + 9000, handle: "amy", nickname: "Amy", text: "after" }], captions: [{ ts: T0, text: "a chair" }] };
    const { container, rerender } = render(<ReviewStrip ctx={ctx} q="moment" live inDvr={false} onClose={onClose} onLive={onLive} />);
    expect(container.querySelectorAll(".review-col p.hit").length).toBe(2); expect(container.querySelector("mark")?.textContent).toBe("moment"); expect(container.textContent).toContain("video not in DVR window"); expect(container.textContent).toContain("🎥 a chair");
    fireEvent.click(screen.getByText("● Back to live")); expect(onLive).toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("close review")); expect(onClose).toHaveBeenCalled();
    rerender(<ReviewStrip ctx={{ ts: T0, transcript: [], chat: [], captions: [] }} live={false} inDvr onClose={onClose} onLive={onLive} />);
    expect(container.textContent).toContain("silence"); expect(container.textContent).toContain("quiet"); expect(screen.queryByText("● Back to live")).toBeNull();
  });
});
