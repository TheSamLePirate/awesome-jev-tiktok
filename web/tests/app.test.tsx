import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "../App";
import { api, request } from "../lib/api";
import { dispatch, getState } from "../lib/store";
import { chat, decision, glm, health, hello, highlight, push, recording, replayInfo, snapshot, status, summary, timeline, watchState, T0 } from "./fixtures";
import { FakeAudioContext, FakeNotification, defineValue } from "./setup";

/** Keys land on the focused element (or the body), as in a browser; they bubble to the window listeners. */
const key = (k: string, init: KeyboardEventInit = {}) => act(() => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })); });
const spies: { mockRestore: () => void }[] = [];
const spy = <T extends object, K extends keyof T>(o: T, k: K) => { const s = spyOn(o, k as any); spies.push(s); return s; };

describe("App", () => {
  let scrollInto: ReturnType<typeof spyOn>;
  beforeEach(() => {
    spy(api, "recordings").mockResolvedValue([recording()]);
    spy(api, "timeline").mockResolvedValue(timeline());
    spy(api, "context").mockResolvedValue({ ts: T0, transcript: [{ ts: T0, text: "moment" }], chat: [], captions: [] });
    spy(api, "connect").mockResolvedValue({ ok: true, sessionId: "s" } as any);
    spy(api, "disconnect").mockResolvedValue({ ok: true } as any);
    spy(api, "startRecording").mockResolvedValue({ ok: true, file: "f" } as any);
    spy(api, "stopRecording").mockResolvedValue({ ok: true, file: "f" } as any);
    spy(api, "seekReplay").mockResolvedValue({ ok: true, offsetMs: 0 } as any);
    spy(api, "patchHighlight").mockResolvedValue({ ok: true } as any);
    scrollInto = spy(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    act(() => dispatch({ type: "ws", msg: hello() }));
    act(() => dispatch({ type: "clearToasts" }));
  });
  afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

  test("boots blurred, then shows header KPIs, panels, tabs by click and keyboard, help sheet", async () => {
    act(() => dispatch({ type: "ws", msg: { ...hello(), status: null as any, seq: 2 } as any }));
    const { container } = render(<App />);
    expect(container.querySelector(".app.booting")).not.toBeNull();
    act(() => dispatch({ type: "ws", msg: hello({ seq: 3 }) }));
    push({ type: "snapshot", snapshot: snapshot() });
    expect(container.querySelector(".app.booting")).toBeNull();
    expect(container.querySelector(".status-pill.live .status-state")?.textContent).toBe("live"); expect(container.querySelector(".status-title")?.textContent).toBe("Débat du soir");
    const kpis = container.querySelector(".kpis")!.textContent!;
    expect(kpis).toContain("320ms"); expect(kpis).toContain("$0.012/ $2"); expect(kpis).toContain("v3· 5"); expect(kpis).toContain("67"); expect(kpis).toContain("steady"); expect(kpis).toContain("idle");
    expect(container.querySelector(".firing-pill")?.textContent).toBe("1 firing"); expect(container.querySelectorAll(".gauge").length).toBe(3); expect(container.querySelectorAll(".msg-group").length).toBe(1);
    expect(container.querySelector("#tab-flagged .count")?.textContent).toBe("3");
    push({ type: "decision", decision: decision({ tick: 2, cached: true, fired: [] }) });
    push({ type: "glm", activity: glm({ id: "g9", status: "running" }) });
    expect(container.querySelector(".kpis")!.textContent).toContain("cached"); expect(container.querySelector(".kpi.busy")).not.toBeNull(); expect(container.querySelector("#tab-glm .pip")).not.toBeNull(); expect(container.textContent).toContain("quiet");
    push({ type: "health", health: health({ budget: { spent: 0, cap: 0, stopped: false } }) });
    expect(container.querySelector(".kpis")!.textContent).not.toContain("/ $");
    // Tabs: click, arrow keys, number hotkeys, comma for settings.
    fireEvent.click(container.querySelector("#tab-rules")!);
    expect((container.querySelector("#panel-rules") as HTMLElement).hidden).toBe(false); expect((container.querySelector("#panel-flagged") as HTMLElement).hidden).toBe(true);
    fireEvent.keyDown(container.querySelector("#tab-rules")!, { key: "ArrowRight" }); expect(container.querySelector("#tab-versions")?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(container.querySelector("#tab-versions")!, { key: "ArrowLeft" }); expect(container.querySelector("#tab-rules")?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(container.querySelector("#tab-rules")!, { key: "Enter" });
    for (const [k, id] of [["4", "glm"], ["5", "log"], ["6", "replays"], ["7", "state"], [",", "settings"], ["3", "versions"], ["1", "flagged"]] as const) { key(k); expect(container.querySelector(`#tab-${id}`)?.getAttribute("aria-selected")).toBe("true"); }
    key("7"); expect(container.querySelector(".state")?.textContent).toContain("chat_velocity");
    key("8"); expect(container.querySelector("#tab-settings")?.getAttribute("aria-selected")).toBe("true");
    key("?"); expect(screen.getByText("Keyboard")).toBeTruthy(); expect(container.querySelector(".sheet")?.textContent).toContain("video player: compact / large");
    fireEvent.click(container.querySelector(".sheet")!); expect(screen.getByText("Keyboard")).toBeTruthy();
    fireEvent.click(container.querySelector(".overlay")!); expect(screen.queryByText("Keyboard")).toBeNull();
    key("?"); key("Escape"); expect(screen.queryByText("Keyboard")).toBeNull();
    const input = screen.getByLabelText("filter chat") as HTMLInputElement; input.focus(); key("Escape"); expect(document.activeElement).not.toBe(input);
    key("/"); await waitFor(() => expect(document.activeElement?.id).toBe("hl-search"));
    key("m"); expect(localStorage.getItem("jev.muted")).toBeNull();
    key("Escape"); expect(document.activeElement?.id).not.toBe("hl-search");
    key("m"); expect(localStorage.getItem("jev.muted")).toBe("false");
    key("s"); expect(localStorage.getItem("jev.sound")).toBe("true");
    key("v"); expect(localStorage.getItem("jev.videoSize")).toBe('"large"'); expect(container.querySelector(".stream-top.large")).not.toBeNull();
    const open = (spy(window, "open") as any).mockImplementation(() => null) as ReturnType<typeof spyOn>;
    key("d"); expect(open).toHaveBeenCalledWith("/?view=director", "jev-director", "width=1280,height=720");
    fireEvent.click(screen.getByTitle("open the director view for the host (d)")); expect(open).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByLabelText("keyboard shortcuts")); expect(screen.getByText("Keyboard")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("alert chime")); expect(localStorage.getItem("jev.sound")).toBe("false");
  });

  test("no free-text field is autofilled: every tab, the search and the username input carry a name and autocomplete off", () => {
    const { container } = render(<App />);
    const seen = new Map<string, Element>();
    const collect = () => { for (const el of container.querySelectorAll('input:not([type="checkbox"]):not([type="range"]):not([type="file"]), textarea')) seen.set(el.getAttribute("name") ?? el.getAttribute("aria-label") ?? el.outerHTML, el); };
    collect();
    for (const k of ["2", "3", "4", "5", "6", "7", ","]) { key(k); collect(); }
    key("1"); collect();
    const names = [...seen.keys()];
    expect(names).toEqual(expect.arrayContaining(["tiktok-handle", "flagged-search", "chat-filter", "recordings-search", "log-filter", "rule-text", "set-tiktok-username", "set-keys-openrouter"]));
    for (const [name, el] of seen) {
      expect(`${name}:${el.getAttribute("name")}`).toMatch(/:.+$/);
      expect(`${name}:${el.getAttribute("autocomplete")}`).toMatch(/:(off|new-password)$/);
      if (el.tagName === "INPUT" && (el.getAttribute("type") ?? "text") !== "number") { expect(`${name}:${el.getAttribute("spellcheck")}`).toMatch(/:false$/); expect(`${name}:${el.getAttribute("autocapitalize")}`).toMatch(/:off$/); }
      expect(`${name}:${el.getAttribute("data-1p-ignore")}:${el.getAttribute("data-lpignore")}`).toMatch(/:true:true$/);
      expect(`${name}:${el.getAttribute("aria-label") ?? el.id}`).toMatch(/:.+$/);
    }
    expect(container.querySelector("form.connect")?.getAttribute("autocomplete")).toBe("off");
  });

  test("connect form, replay picker, connecting spinner, error status, disconnect, username adoption", async () => {
    act(() => dispatch({ type: "ws", msg: hello({ seq: 2, status: status({ state: "offline", username: "replay" }), summary: summary() }) }));
    (api.recordings as any).mockRejectedValueOnce(new Error("listing failed"));
    const { container } = render(<App />);
    await waitFor(() => expect(api.recordings).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector(".replay-picker")).toBeNull();
    // The list is fetched again whenever the stream state changes.
    push({ type: "event", event: status({ state: "connecting", username: "replay" }) });
    push({ type: "event", event: status({ state: "offline", username: "replay" }) });
    const input = screen.getByLabelText("tiktok username") as HTMLInputElement;
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "@someone" } });
    expect(input.value).toBe("someone");
    fireEvent.submit(container.querySelector("form.connect")!);
    expect(container.textContent).toContain("Connecting");
    await waitFor(() => expect(api.connect).toHaveBeenCalledWith("@someone", undefined));
    await waitFor(() => expect(container.textContent).not.toContain("Connecting"));
    await waitFor(() => expect(container.querySelector(".replay-picker")).not.toBeNull());
    fireEvent.change(container.querySelector(".replay-picker")!, { target: { value: "rec-1" } });
    await waitFor(() => expect(api.connect).toHaveBeenLastCalledWith("replay", "rec-1"));
    fireEvent.change(container.querySelector(".replay-picker")!, { target: { value: "" } });
    expect(container.textContent).toContain("Session ended");
    fireEvent.click(screen.getByText("▶ Replay this session"));
    await waitFor(() => expect(api.connect).toHaveBeenLastCalledWith("replay", "rec-1"));
    (api.connect as any).mockRejectedValue(new Error("nope"));
    fireEvent.submit(container.querySelector("form.connect")!);
    await waitFor(() => expect(api.connect).toHaveBeenCalledTimes(4));
    push({ type: "event", event: status({ state: "error", detail: "stream offline" }) });
    expect(container.querySelector(".conn-error")?.textContent).toBe("stream offline");
    push({ type: "event", event: status({ state: "live", username: "koursk1" }) });
    expect(input.value).toBe("someone");
    fireEvent.click(screen.getByText("Disconnect"));
    await waitFor(() => expect(api.disconnect).toHaveBeenCalled());
    (api.disconnect as any).mockRejectedValue(new Error("x")); fireEvent.click(screen.getByText("Disconnect"));
    fireEvent.submit(container.querySelector("form.connect")!);
    expect(api.connect).toHaveBeenCalledTimes(4);
  });

  test("watching an account: the eye button arms it, the pill counts down and disarms, live shows auto-reconnect", async () => {
    spy(api, "watch").mockResolvedValue({ ok: true, watch: watchState() } as any);
    act(() => dispatch({ type: "ws", msg: hello({ seq: 2, status: status({ state: "offline", username: "" }) }) }));
    const { container } = render(<App />);
    const eye = screen.getByLabelText("connect when live") as HTMLButtonElement;
    expect(eye.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("tiktok username"), { target: { value: "amy" } });
    fireEvent.click(eye);
    await waitFor(() => expect(api.watch).toHaveBeenCalledWith(true, "amy"));
    push({ type: "watch", watch: watchState({ armed: true, username: "amy", nextCheck: Date.now() + 42_000, lastCheck: Date.now() - 1000, lastResult: "offline" }) });
    expect(container.querySelector(".watch-pill")?.textContent).toContain("waiting for @amy"); expect(container.querySelector(".watch-pill")?.textContent).toMatch(/next check in 4[12] s/);
    expect(screen.queryByLabelText("connect when live") === null).toBe(true);
    push({ type: "watch", watch: watchState({ armed: true, username: "amy", nextCheck: Date.now() + 5000, lastResult: "error", detail: "tiktok down" }) });
    expect(container.querySelector(".watch-pill.error")?.textContent).toContain("tiktok down");
    fireEvent.click(screen.getByLabelText("stop watching"));
    await waitFor(() => expect(api.watch).toHaveBeenLastCalledWith(false));
    push({ type: "event", event: status({ state: "live", username: "amy" }) });
    expect(container.querySelector(".watch-pill.on")?.textContent).toContain("auto-reconnect");
    (api.watch as any).mockRejectedValue(new Error("x")); fireEvent.click(screen.getByLabelText("stop watching"));
    await new Promise((r) => setTimeout(r, 5));
  });

  test("adopts the server's streamer name, shows banners, api error toasts, unsaved settings guard", async () => {
    const { container } = render(<App />);
    expect((screen.getByLabelText("tiktok username") as HTMLInputElement).value).toBe("koursk1");
    act(() => dispatch({ type: "connected", value: false }));
    expect(container.textContent).toContain("Connection to the server lost");
    act(() => dispatch({ type: "ws", msg: hello({ seq: 5, protocol: 99 }) }));
    const reload = spy(location, "reload").mockImplementation(() => {});
    fireEvent.click(screen.getByText("Reload the console")); expect(reload).toHaveBeenCalled();
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = mock(async () => new Response(JSON.stringify({ ok: false, error: "too many requests" }), { status: 429 }));
    await request("/api/w").catch(() => {});
    await waitFor(() => expect(getState().toasts.some((t) => t.title === "Slow down")).toBe(true));
    // A 401 means the session ended: the sign-in covers the console instead of a toast.
    (globalThis as any).fetch = mock(async () => new Response(JSON.stringify({ ok: false, error: "no token" }), { status: 401 }));
    await request("/api/x").catch(() => {});
    await waitFor(() => expect(getState().authRequired).toBe(true));
    expect(container.querySelector(".login")).not.toBeNull(); expect(container.textContent).toContain("Sign in again");
    act(() => dispatch({ type: "auth", required: false }));
    expect(container.querySelector(".login") === null).toBe(true);
    (globalThis as any).fetch = mock(async () => new Response("", { status: 500 }));
    await request("/api/y").catch(() => {});
    await waitFor(() => expect(getState().toasts.some((t) => t.title === "HTTP 500")).toBe(true));
    (globalThis as any).fetch = realFetch;
    const ev = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(ev); expect(ev.defaultPrevented).toBe(false);
    key(","); fireEvent.change(container.querySelector("#set-tiktok-username")!, { target: { value: "dirty" } });
    const ev2 = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(ev2); expect(ev2.defaultPrevented).toBe(true);
  });

  test("fresh highlights: chime, notification, muted viewers, toast opens the flagged card", async () => {
    localStorage.setItem("jev.sound", "true"); localStorage.setItem("jev.notify", "true"); localStorage.setItem("jev.mutedUsers", JSON.stringify(["u-muted"]));
    FakeNotification.permission = "granted";
    const undo = defineValue(document, "visibilityState", "hidden");
    const { container } = render(<App />);
    act(() => { window.dispatchEvent(new Event("pointerdown")); });
    const ctx = FakeAudioContext.instances.at(-1)!;
    const tones = ctx.started.length;
    push({ type: "highlight", highlight: highlight({ id: "fresh", severity: "warn", ts: Date.now() }), fresh: true });
    await waitFor(() => expect(ctx.started.length).toBe(tones + 2));
    expect(FakeNotification.created[0]?.title).toBe("⚠ Question to host");
    push({ type: "highlight", highlight: highlight({ id: "muted", message: chat({ id: "cm", userId: "u-muted" }), ts: Date.now() }), fresh: true });
    await waitFor(() => expect(getState().toasts.some((t) => t.id === "hl-muted")).toBe(false));
    push({ type: "highlight", highlight: highlight({ id: "tr", kind: "transcript", message: undefined, transcript: { from: T0, to: T0, lines: [{ ts: T0, text: "said" }] }, ts: Date.now() }), fresh: true });
    push({ type: "highlight", highlight: highlight({ id: "sc", kind: "scene", message: undefined, scene: { ts: T0, text: "scene" }, ts: Date.now() }), fresh: true });
    push({ type: "highlight", highlight: highlight({ id: "rm", kind: "room", message: undefined, ts: Date.now() }), fresh: true });
    await waitFor(() => expect(FakeNotification.created.map((n) => `${n.title}|${n.options?.body}`)).toEqual(["⚠ Question to host|Alice: Hello host, what time is it?", "Question to host|said", "Question to host|scene", "Question to host|"]));
    key("2");
    fireEvent.click(container.querySelector(".toast-main")!);
    expect(container.querySelector("#tab-flagged")?.getAttribute("aria-selected")).toBe("true"); expect(container.querySelector(".hl.focused")).not.toBeNull();
    fireEvent.click(container.querySelector('.hl.focused [aria-label="show in chat"]')!);
    expect(scrollInto).toHaveBeenCalled();
    key("2");
    fireEvent.click(container.querySelector(".msg .flag.open")!);
    expect(container.querySelector("#tab-flagged")?.getAttribute("aria-selected")).toBe("true");
    undo();
  });

  test("live timeline polling, DVR review, back to live, recording toggle with confirmation", async () => {
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".replaybar")).not.toBeNull());
    expect(container.querySelector(".app.replaying")).not.toBeNull();
    push({ type: "video", video: { kind: "hls", url: "/hls/live.m3u8", startTs: T0 } });
    // Native HLS in this DOM: the player maps seeks through getStartDate and reports whether the moment is in the DVR window.
    await waitFor(() => expect(container.querySelector(".video video")).not.toBeNull());
    const videoEl = container.querySelector(".video video") as HTMLVideoElement & { getStartDate?: () => Date };
    videoEl.getStartDate = () => new Date(Date.now() - 60_000);
    Object.defineProperty(videoEl, "duration", { value: 60, configurable: true });
    const track = container.querySelector(".rb-track")!;
    Object.defineProperty(track, "getBoundingClientRect", { value: () => ({ left: 0, width: 100 }), configurable: true });
    fireEvent.click(track, { clientX: 50 });
    await waitFor(() => expect(api.context).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(container.querySelector(".review")).not.toBeNull());
    expect(container.querySelector(".hud-chip.dvr")).not.toBeNull();
    // Half-way through a 5-minute timeline is before the 60 s DVR start: the strip says so.
    await waitFor(() => expect(container.querySelector(".review .badge.mod")?.textContent).toContain("video not in DVR window"));
    // A seek whose context is still debounced, then back to live: the pending fetch is dropped, no stale strip.
    fireEvent.click(track, { clientX: 60 });
    fireEvent.click(screen.getByText("● Back to live"));
    await waitFor(() => expect(container.querySelector(".review")).toBeNull());
    await new Promise((r) => setTimeout(r, 400));
    expect(api.context).toHaveBeenCalledTimes(1); expect(container.querySelector(".review")).toBeNull();
    fireEvent.click(track, { clientX: 40 });
    await waitFor(() => expect(container.querySelector(".review")).not.toBeNull());
    expect(api.context).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByLabelText("close review"));
    expect(container.querySelector(".review")).toBeNull();
    // The player's mute button and the session search (a hit opens the review with the query highlighted).
    fireEvent.click(container.querySelector('.video .hud-btn[aria-label="unmute"]')!);
    expect(localStorage.getItem("jev.muted")).toBe("false");
    spy(api, "search").mockResolvedValue([{ ts: Date.now() - 20_000, offsetMs: 100_000, kind: "chat", text: "hello world", handle: "alice", nickname: "Alice" }]);
    const search = screen.getByLabelText("search the session") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "world" } });
    await waitFor(() => expect(container.querySelectorAll(".rb-hit").length).toBe(1));
    search.focus();
    key("Enter");
    await waitFor(() => expect(container.querySelector(".review")).not.toBeNull());
    expect(container.querySelector(".review-col")?.textContent).toContain("moment");
    fireEvent.click(screen.getByLabelText("close review"));
    key("Escape"); expect(document.activeElement).not.toBe(search);
    // "Watch this moment" from a flagged card: the same debounced context fetch, the strip opens again.
    fireEvent.click(container.querySelector('.hl [aria-label="watch this moment"]')!);
    await waitFor(() => expect(api.context).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(container.querySelector(".review")).not.toBeNull());
    key("r");
    await waitFor(() => expect(api.startRecording).toHaveBeenCalled());
    push({ type: "recording", recording: { active: true, since: Date.now(), segments: 1, finalizing: false } });
    key("r");
    await waitFor(() => expect(screen.getByText("Stop recording?")).toBeTruthy());
    fireEvent.click(screen.getByText("Cancel"));
    expect(api.stopRecording).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector(".hud-btn.rec")!);
    await waitFor(() => expect(screen.getByText("Stop")).toBeTruthy());
    fireEvent.click(screen.getByText("Stop"));
    await waitFor(() => expect(api.stopRecording).toHaveBeenCalled());
    (api.stopRecording as any).mockRejectedValue(new Error("x")); (api.startRecording as any).mockRejectedValue(new Error("x"));
    key("r"); await waitFor(() => expect(screen.getByText("Stop")).toBeTruthy()); fireEvent.click(screen.getByText("Stop"));
    push({ type: "recording", recording: { active: false, segments: 1, finalizing: true } });
    key("r");
    await waitFor(() => expect(api.startRecording).toHaveBeenCalledTimes(2));
    // A failing context fetch leaves the strip of the previous moment in place (the watch click above opened it).
    expect(container.querySelector(".review") !== null).toBe(true);
    (api.context as any).mockRejectedValue(new Error("x")); (api.timeline as any).mockRejectedValue(new Error("x"));
    fireEvent.click(track, { clientX: 30 });
    await waitFor(() => expect(api.context).toHaveBeenCalledTimes(5));
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelector(".review") !== null).toBe(true);
  });

  test("replay session: seeks go to the server, recording hotkey is off, state panel without snapshot", async () => {
    act(() => dispatch({ type: "ws", msg: hello({ seq: 2, status: status({ username: "replay" }), replay: replayInfo({ startedAt: Date.now() }) }) }));
    const { container } = render(<App />);
    expect(container.querySelector(".rb-tag")?.textContent).toContain("REPLAY");
    const track = container.querySelector(".rb-track")!;
    Object.defineProperty(track, "getBoundingClientRect", { value: () => ({ left: 0, width: 100 }), configurable: true });
    fireEvent.click(track, { clientX: 50 });
    await waitFor(() => expect(api.seekReplay).toHaveBeenCalled());
    expect((api.seekReplay as any).mock.calls[0][0]).toBeGreaterThan(0);
    (api.seekReplay as any).mockRejectedValue(new Error("x")); fireEvent.click(track, { clientX: 10 });
    key("r"); expect(api.startRecording).not.toHaveBeenCalled();
    expect((screen.getByLabelText("tiktok username") as HTMLInputElement).value).toBe("");
    key("7"); expect(container.textContent).toContain("no snapshot yet");
    push({ type: "event", event: status({ state: "offline", username: "sim" }) });
    expect(container.querySelector(".replaybar")).toBeNull();
  });
});
