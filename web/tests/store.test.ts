import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { PROTOCOL_VERSION, type ServerMessage } from "@shared/protocol";
import { dismissToast, dispatch, getState, markSeen, reducer, shallowEq, startSocket, toast, useStore } from "../lib/store";
import { chat, decision, glm, health, hello, highlight, logEntry, messageDecision, qset, replayInfo, settings, snapshot, summary, totals, watchState, T0, type Body } from "./fixtures";

const ws = (body: Body, seq = 2) => ({ type: "ws", msg: { ...body, seq } as ServerMessage } as const);

describe("reducer", () => {
  beforeEach(() => dispatch({ type: "ws", msg: hello() }));
  test("watch state comes with hello and follows watch messages", () => {
    expect(getState().watch).toEqual(watchState());
    dispatch({ type: "ws", msg: { type: "watch", seq: 9, watch: watchState({ armed: true, username: "amy", nextCheck: T0 }) } });
    expect(getState().watch).toMatchObject({ armed: true, username: "amy" });
  });
  test("hello builds the state, derives question scopes and replays recent events", () => {
    const s = getState();
    expect(s.connected).toBe(true); expect(s.protocolMismatch).toBe(false);
    expect(s.windowQs.map((q) => q.id)).toEqual(["q1", "q2", "q3"]); expect(s.messageQs.map((q) => q.id)).toEqual(["m1", "k1"]);
    expect(s.chat.length).toBe(2); expect(s.transcript.length).toBe(1); expect(s.captions.length).toBe(1); expect(s.viewers).toEqual([{ ts: T0 + 1300, count: 67 }]); expect(s.social.length).toBe(1);
    expect(s.messageDecisions.c1.fired).toEqual(["m1"]); expect(s.highlights.length).toBe(4); expect(s.sessionId).toBe("s1");
  });
  test("hello with a protocol mismatch and no questions", () => {
    dispatch({ type: "ws", msg: hello({ protocol: PROTOCOL_VERSION + 1, questions: null as any }) });
    expect(getState().protocolMismatch).toBe(true); expect(getState().windowQs).toEqual([]);
  });
  test("events: chat cap, transcript interim/final/blank, caption, viewers, social, stream, unknown", () => {
    for (let i = 0; i < 305; i++) dispatch(ws({ type: "event", event: chat({ id: `x${i}`, ts: T0 + i }) }));
    expect(getState().chat.length).toBe(300); expect(getState().messageDecisions.c1).toBeUndefined();
    dispatch(ws({ type: "event", event: { kind: "transcript", ts: T0, text: "partial", final: false } }));
    expect(getState().interim).toBe("partial");
    dispatch(ws({ type: "event", event: { kind: "transcript", ts: T0, text: "  ", final: true } }));
    expect(getState().interim).toBe(""); expect(getState().transcript.length).toBe(1);
    dispatch(ws({ type: "event", event: { kind: "transcript", id: "tid", ts: T0, text: " done ", final: true } }));
    expect(getState().transcript.at(-1)).toEqual({ id: "tid", ts: T0, text: "done" });
    dispatch(ws({ type: "event", event: { kind: "caption", ts: T0, text: "scene" } }));
    dispatch(ws({ type: "event", event: { kind: "viewers", ts: T0, count: 9 } }));
    dispatch(ws({ type: "event", event: { kind: "gift", id: "g", ts: T0, handle: "bob", giftName: "Rose", count: 1, diamonds: 1 } }));
    dispatch(ws({ type: "event", event: { kind: "social", ts: T0, handle: "bob", action: "follow" } }));
    dispatch(ws({ type: "event", event: { kind: "stream", ts: T0, state: "offline", username: "x" } }));
    expect(getState().status?.state).toBe("offline");
    const before = getState();
    dispatch(ws({ type: "event", event: { kind: "like", ts: T0, count: 1, total: 2 } }));
    expect(getState()).toBe(before);
  });
  test("decisions, message decisions (only for known chat), questions, glm upsert, video, settings, recording, replay, health, session, log", () => {
    dispatch(ws({ type: "snapshot", snapshot: snapshot() })); expect(getState().snapshot?.activity.viewers).toBe(67);
    dispatch(ws({ type: "decision", decision: decision({ tick: 2 }) })); expect(getState().decisions.length).toBe(2);
    dispatch(ws({ type: "messageDecision", decision: messageDecision({ messageId: "c2", fired: [] }) })); expect(getState().messageDecisions.c2.fired).toEqual([]);
    const s1 = getState(); dispatch(ws({ type: "messageDecision", decision: messageDecision({ messageId: "nope" }) })); expect(getState()).toBe(s1);
    dispatch(ws({ type: "questions", set: qset([], { version: 9 }), history: [], rules: [] })); expect(getState().questions?.version).toBe(9); expect(getState().windowQs).toEqual([]);
    dispatch(ws({ type: "glm", activity: glm({ id: "g1", status: "error" }) })); expect(getState().glm[0].status).toBe("error"); expect(getState().glm.length).toBe(1);
    dispatch(ws({ type: "glm", activity: glm({ id: "g2" }) })); expect(getState().glm.length).toBe(2);
    dispatch(ws({ type: "video", video: { kind: "hls", url: "/hls/live.m3u8", startTs: T0 } })); expect(getState().video?.kind).toBe("hls");
    dispatch(ws({ type: "settings", settings: settings({ updatedAt: 5 }) })); expect(getState().settings?.updatedAt).toBe(5);
    dispatch(ws({ type: "recording", recording: { active: true, segments: 1, finalizing: false } })); expect(getState().recording.active).toBe(true);
    dispatch(ws({ type: "replay", replay: replayInfo() })); expect(getState().replay?.id).toBe("rec-1");
    dispatch(ws({ type: "health", health: health({ chatBacklog: 3 }) })); expect(getState().health?.chatBacklog).toBe(3);
    dispatch(ws({ type: "session", sessionId: "s2" })); expect(getState().sessionId).toBe("s2");
    dispatch(ws({ type: "log", entry: logEntry({ id: "l2" }), totals: totals({ session: 1 }) })); expect(getState().log.length).toBe(2); expect(getState().totals.session).toBe(1);
    const s2 = getState(); dispatch(ws({ type: "zzz" } as any)); expect(getState()).toBe(s2);
  });
  test("highlights: upsert, fresh toast + unseen, removal, seen", () => {
    dispatch(ws({ type: "highlight", highlight: highlight({ id: "h9", ts: T0 + 50 }), fresh: true }));
    let s = getState();
    expect(s.highlights[0].id).toBe("h9"); expect(s.unseen).toEqual(["h9"]); expect(s.toasts.at(-1)?.id).toBe("hl-h9"); expect(s.toasts.at(-1)?.title).toBe("Question to host");
    dispatch(ws({ type: "highlight", highlight: highlight({ id: "h9", ts: T0 + 50, pinned: true }), fresh: false }));
    s = getState(); expect(s.highlights[0].pinned).toBe(true); expect(s.highlights.length).toBe(5);
    markSeen(); expect(getState().unseen).toEqual([]); const same = getState(); markSeen(); expect(getState()).toBe(same);
    dispatch(ws({ type: "highlightRemoved", id: "h9" }));
    s = getState(); expect(s.highlights.some((h) => h.id === "h9")).toBe(false); expect(s.toasts.some((t) => t.id === "hl-h9")).toBe(false);
  });
  test("reset keeps highlights/settings, drops session data; seek keeps unseen and video", () => {
    dispatch(ws({ type: "video", video: { kind: "hls", url: "/hls/live.m3u8", startTs: T0 } }));
    dispatch(ws({ type: "highlight", highlight: highlight({ id: "h9" }), fresh: true }));
    dispatch(ws({ type: "reset", reason: "seek", summary: null }));
    expect(getState().unseen).toEqual(["h9"]); expect(getState().video).not.toBeNull(); expect(getState().chat).toEqual([]); expect(getState().summary).toBeNull();
    dispatch(ws({ type: "reset", reason: "ended", summary: summary() }));
    expect(getState().unseen).toEqual([]); expect(getState().video).toBeNull(); expect(getState().summary?.sessionId).toBe("s1"); expect(getState().highlights.length).toBe(5); expect(getState().toasts.some((t) => t.kind === "highlight")).toBe(false);
  });
  test("connected, toasts (cap 5, replace by id), dismiss, clear", () => {
    const s0 = getState(); dispatch({ type: "connected", value: true }); expect(getState()).toBe(s0);
    dispatch({ type: "connected", value: false }); expect(getState().connected).toBe(false);
    for (let i = 0; i < 7; i++) toast({ kind: "info", title: `t${i}` });
    expect(getState().toasts.length).toBe(5);
    toast({ id: "fixed", kind: "error", title: "a" }); toast({ id: "fixed", kind: "error", title: "b" });
    expect(getState().toasts.filter((t) => t.id === "fixed").length).toBe(1); expect(getState().toasts.find((t) => t.id === "fixed")?.title).toBe("b");
    dismissToast("fixed"); expect(getState().toasts.some((t) => t.id === "fixed")).toBe(false);
    const s1 = getState(); dismissToast("missing"); expect(getState()).toBe(s1);
    dispatch({ type: "clearToasts" }); expect(getState().toasts).toEqual([]); const s2 = getState(); dispatch({ type: "clearToasts" }); expect(getState()).toBe(s2);
    expect(reducer(getState(), { type: "seen" })).toBe(getState());
  });
});

describe("useStore and shallowEq", () => {
  test("shallowEq semantics", () => {
    expect(shallowEq(1, 1)).toBe(true); expect(shallowEq(1, 2)).toBe(false); expect(shallowEq(null, {})).toBe(false); expect(shallowEq({}, null as any)).toBe(false);
    expect(shallowEq([1], { 0: 1 } as any)).toBe(false); expect(shallowEq({ a: 1 }, { a: 1 })).toBe(true); expect(shallowEq({ a: 1 }, { a: 1, b: 2 })).toBe(false); expect(shallowEq({ a: 1 }, { a: 2 })).toBe(false); expect(shallowEq("a" as any, "a" as any)).toBe(true);
  });
  test("selectors yield stable identities and re-render only on real change", () => {
    dispatch({ type: "ws", msg: hello() });
    let renders = 0;
    const { result } = renderHook(() => { renders++; return useStore((s) => ({ n: s.chat.length })); });
    const first = result.current;
    act(() => dispatch({ type: "connected", value: false }));
    expect(result.current).toBe(first);
    act(() => dispatch(ws({ type: "event", event: chat({ id: "new" }) })));
    expect(result.current.n).toBe(3); expect(renders).toBeGreaterThanOrEqual(2);
    const custom = renderHook(() => useStore((s) => s.chat.length, (a, b) => a === b));
    expect(custom.result.current).toBe(3);
  });
});

describe("startSocket", () => {
  class FakeWS {
    static instances: FakeWS[] = [];
    onopen: (() => void) | null = null; onmessage: ((e: { data: string }) => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null;
    close = mock(() => { this.onclose?.(); });
    constructor(public url: string) { FakeWS.instances.push(this); }
  }
  test("connects with the token, orders messages around hello, dedupes by seq, reconnects with backoff", () => {
    const saved = (globalThis as any).WebSocket; (globalThis as any).WebSocket = FakeWS;
    const timers: { fn: () => void; ms: number }[] = [];
    const st = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms: number) => { timers.push({ fn, ms }); return 42 as any; }) as any);
    const ct = spyOn(globalThis, "clearTimeout").mockImplementation((() => {}) as any);
    const stop = startSocket("tok en");
    expect(startSocket("again")).toBeUndefined();
    const w = FakeWS.instances[0];
    expect(w.url).toBe("ws://localhost:5173/ws?token=tok%20en");
    dispatch({ type: "connected", value: false });
    w.onopen?.(); expect(getState().connected).toBe(true);
    // Before hello: junk and pending messages are buffered.
    w.onmessage?.({ data: "{not json" }); w.onmessage?.({ data: JSON.stringify({ nope: 1 }) }); w.onmessage?.({ data: JSON.stringify(42) });
    w.onmessage?.({ data: JSON.stringify({ type: "session", sessionId: "late", seq: 7 }) });
    w.onmessage?.({ data: JSON.stringify({ type: "session", sessionId: "older", seq: 3 }) });
    w.onmessage?.({ data: JSON.stringify(hello({ seq: 5, sessionId: "hello" })) });
    expect(getState().sessionId).toBe("late");
    w.onmessage?.({ data: JSON.stringify({ type: "session", sessionId: "dup", seq: 7 }) }); expect(getState().sessionId).toBe("late");
    w.onmessage?.({ data: JSON.stringify({ type: "session", sessionId: "next", seq: 8 }) }); expect(getState().sessionId).toBe("next");
    w.onmessage?.({ data: JSON.stringify({ type: "session", sessionId: "noseq" }) }); expect(getState().sessionId).toBe("noseq");
    w.onerror?.(); expect(w.close).toHaveBeenCalled(); expect(getState().connected).toBe(false);
    expect(timers.at(-1)?.ms).toBe(2000);
    timers.at(-1)!.fn(); expect(FakeWS.instances.length).toBe(2);
    FakeWS.instances[1].onclose?.(); expect(timers.at(-1)?.ms).toBe(4000);
    for (let i = 0; i < 5; i++) { timers.at(-1)!.fn(); FakeWS.instances.at(-1)!.onclose?.(); }
    expect(timers.at(-1)?.ms).toBe(15_000);
    stop?.(); expect(ct).toHaveBeenCalled();
    st.mockRestore(); ct.mockRestore(); (globalThis as any).WebSocket = saved;
  });
});
