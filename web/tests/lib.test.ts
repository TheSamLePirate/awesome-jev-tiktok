import { describe, expect, mock, spyOn, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { ago, answerShort, answerText, bytes, clock, confidenceOf, csvRow, download, duration, fmtTime, hue, initials, mmss, money, pct, tok, when } from "../lib/format";
import { authToken, usePref, withToken } from "../lib/prefs";
import { useHotkeys } from "../lib/hotkeys";
import { notificationPermission, notificationsSupported, notifyIfHidden, requestNotifications } from "../lib/notify";
import { chime, primeAudio, resetAudioForTests } from "../lib/audio";
import { FakeAudioContext, FakeNotification, defineValue } from "./setup";

describe("format", () => {
  test("times, percentages, initials, hues", () => {
    expect(fmtTime(0)).toMatch(/\d/); expect(clock).toBe(fmtTime);
    expect(pct(0.256)).toBe("26%");
    expect(initials("alice")).toBe("AL"); expect(initials("🔥 hot")).toBe("🔥"); expect(initials("  ")).toBe("?");
    expect(hue("abc")).toBe(hue("abc")); expect(hue("abc")).not.toBe(hue("abd"));
  });
  test("ago buckets", () => { const n = 1_000_000; expect(ago(n - 1000, n)).toBe("now"); expect(ago(n - 30_000, n)).toBe("30s"); expect(ago(n - 120_000, n)).toBe("2m"); expect(ago(n - 7_200_000, n)).toBe("2h"); expect(ago(n + 5000, n)).toBe("now"); });
  test("mmss, money, tokens, bytes, duration, when", () => {
    expect(mmss(65_000)).toBe("1:05"); expect(mmss(3_725_000)).toBe("1:02:05"); expect(mmss(-5)).toBe("0:00");
    expect(money(0.0123)).toBe("$0.012"); expect(money(0.00001)).toBe("$0.00001"); expect(money(0)).toBe("—");
    expect(tok(undefined)).toBe(""); expect(tok(999)).toBe("999"); expect(tok(1500)).toBe("1.5k");
    expect(bytes(2.5e9)).toBe("2.50 GB"); expect(bytes(3.2e6)).toBe("3.2 MB"); expect(bytes(4000)).toBe("4 KB");
    expect(duration(undefined)).toBe("—"); expect(duration(3700)).toBe("1h 1m"); expect(duration(90)).toBe("1m 30s"); expect(duration(5)).toBe("5s");
    expect(when(0)).toMatch(/\d/);
  });
  test("answers", () => {
    expect(answerText({ type: "noul", noul: 0.82 })).toBe("82%");
    expect(answerText({ type: "choice", choice: "very_fun", probabilities: {}, confidence: 0.91 })).toBe("very fun · 91%");
    expect(answerText({ type: "score", score: 1.6, legend: { "2": "Hot: fast" }, probabilities: {}, confidence: 0.77 })).toBe("Hot · 77%");
    expect(answerText({ type: "score", score: 1.6, legend: {}, probabilities: {}, confidence: 0.77 })).toBe("1.6 · 77%");
    expect(answerShort({ type: "noul", noul: 0.5 })).toBe("50%"); expect(answerShort({ type: "choice", choice: "a_b", probabilities: {}, confidence: 1 })).toBe("a b");
    expect(answerShort({ type: "score", score: 2, legend: { "2": "Hot. fast" }, probabilities: {}, confidence: 1 })).toBe("Hot"); expect(answerShort({ type: "score", score: 2, legend: {}, probabilities: {}, confidence: 1 })).toBe("");
    expect(confidenceOf({ type: "noul", noul: 0.75 })).toBeCloseTo(0.5); expect(confidenceOf({ type: "choice", choice: "x", probabilities: {}, confidence: 0.3 })).toBe(0.3);
  });
  test("csv and download", async () => {
    expect(csvRow(["a", 'say "hi"', null, 3])).toBe('"a","say ""hi""","","3"');
    const clicks: string[] = [];
    const click = spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { clicks.push(this.download); });
    download("file.csv", "a,b", "text/csv");
    expect(clicks).toEqual(["file.csv"]);
    await new Promise((r) => setTimeout(r, 1100));
    click.mockRestore();
  });
});

describe("prefs", () => {
  test("usePref reads, writes and survives bad JSON", () => {
    localStorage.setItem("jev.bad", "{nope");
    const { result } = renderHook(() => usePref("jev.bad", 7));
    expect(result.current[0]).toBe(7);
    act(() => result.current[1](8));
    expect(result.current[0]).toBe(8); expect(localStorage.getItem("jev.bad")).toBe("8");
    act(() => result.current[1]((v) => v + 1));
    expect(result.current[0]).toBe(9);
    const again = renderHook(() => usePref("jev.bad", 0));
    expect(again.result.current[0]).toBe(9);
  });
  test("usePref falls back to memory when storage throws", () => {
    const g = spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    const s = spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    const { result } = renderHook(() => usePref("jev.x", "d"));
    expect(result.current[0]).toBe("d");
    act(() => result.current[1]("e"));
    expect(result.current[0]).toBe("e");
    expect(authToken()).toBe("");
    g.mockRestore(); s.mockRestore();
  });
  test("authToken remembers ?token= and withToken appends it", () => {
    expect(authToken()).toBe("");
    expect(withToken("/hls/live.m3u8")).toBe("/hls/live.m3u8");
    window.happyDOM.setURL("http://localhost:5173/?token=se%20cret");
    expect(authToken()).toBe("se cret");
    window.happyDOM.setURL("http://localhost:5173/");
    expect(authToken()).toBe("se cret");
    expect(withToken("/hls/live.m3u8")).toBe("/hls/live.m3u8?token=se%20cret");
    expect(withToken("/a?x=1")).toBe("/a?x=1&token=se%20cret");
  });
});

describe("hotkeys", () => {
  const key = (k: string, init: KeyboardEventInit = {}, target: EventTarget = window) => act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })); });
  test("fires bare keys only, honours when/global/typing and the latest map", () => {
    const a = mock(() => {}), g = mock(() => {}), w = mock(() => {});
    const { rerender, unmount } = renderHook(({ keys }) => useHotkeys(keys), { initialProps: { keys: [{ key: "a", label: "a", help: "", run: a }, { key: "g", label: "g", help: "", global: true, run: g }, { key: "w", label: "w", help: "", when: () => false, run: w }] } });
    key("a"); expect(a).toHaveBeenCalledTimes(1);
    key("a", { metaKey: true }); key("a", { ctrlKey: true }); key("a", { altKey: true }); key("a", { repeat: true }); expect(a).toHaveBeenCalledTimes(1);
    key("w"); expect(w).not.toHaveBeenCalled();
    key("z"); expect(a).toHaveBeenCalledTimes(1);
    const input = document.createElement("input"); document.body.appendChild(input);
    key("a", {}, input); expect(a).toHaveBeenCalledTimes(1);
    key("g", {}, input); expect(g).toHaveBeenCalledTimes(1);
    const div = document.createElement("div"); div.contentEditable = "true"; document.body.appendChild(div);
    key("a", {}, div); expect(a).toHaveBeenCalledTimes(1);
    const b = mock(() => {});
    rerender({ keys: [{ key: "b", label: "b", help: "", run: b }] });
    key("a"); key("b"); expect(a).toHaveBeenCalledTimes(1); expect(b).toHaveBeenCalledTimes(1);
    unmount(); key("b"); expect(b).toHaveBeenCalledTimes(1);
    input.remove(); div.remove();
  });
});

describe("notify", () => {
  test("permission helpers", async () => {
    expect(notificationsSupported()).toBe(true);
    expect(notificationPermission()).toBe("default");
    FakeNotification.permission = "granted";
    expect(await requestNotifications()).toBe("granted");
    const saved = (globalThis as any).Notification; delete (globalThis as any).Notification;
    expect(notificationsSupported()).toBe(false); expect(notificationPermission()).toBe("unsupported"); expect(await requestNotifications()).toBe("denied");
    notifyIfHidden("t", "b", "tag");
    (globalThis as any).Notification = saved;
  });
  test("notifyIfHidden only fires when granted and hidden, closes on click and after 8 s", async () => {
    notifyIfHidden("t", "b", "tag"); expect(FakeNotification.created.length).toBe(0);
    FakeNotification.permission = "granted";
    notifyIfHidden("t", "b", "tag"); expect(FakeNotification.created.length).toBe(0);
    const undo = defineValue(document, "visibilityState", "hidden");
    const st = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => { fn(); return 0 as any; }) as any);
    notifyIfHidden("title", "body", "tag");
    st.mockRestore();
    expect(FakeNotification.created.length).toBe(1);
    const n = FakeNotification.created[0];
    expect(n.title).toBe("title"); expect(n.options?.body).toBe("body"); expect(n.closed).toBe(true);
    const focus = spyOn(window, "focus").mockImplementation(() => {});
    n.onclick?.(); expect(focus).toHaveBeenCalled();
    // A constructor that throws is swallowed.
    const saved = (globalThis as any).Notification;
    (globalThis as any).Notification = class { static permission = "granted"; constructor() { throw new Error("nope"); } };
    notifyIfHidden("t", "b", "tag");
    (globalThis as any).Notification = saved; undo(); focus.mockRestore();
  });
});

describe("audio", () => {
  // The module keeps one context for the page; reset it so the lazy creation is observable here.
  test("primeAudio creates the context on the first gesture, chime plays two tones per severity", async () => {
    resetAudioForTests();
    const n = FakeAudioContext.instances.length;
    primeAudio();
    expect(FakeAudioContext.instances.length).toBe(n);
    window.dispatchEvent(new Event("pointerdown"));
    expect(FakeAudioContext.instances.length).toBe(n + 1);
    window.dispatchEvent(new Event("keydown"));
    expect(FakeAudioContext.instances.length).toBe(n + 1);
    const c = FakeAudioContext.instances.at(-1)!;
    chime(); expect(c.started.length).toBe(2);
    chime("warn"); expect(c.started.length).toBe(4);
    c.state = "suspended"; chime("info"); expect(c.resume).toHaveBeenCalled();
    // A refused resume is swallowed.
    c.resume.mockRejectedValue(new Error("no gesture")); c.state = "suspended"; chime("warn");
    await new Promise((r) => setTimeout(r, 5));
    expect(c.started.length).toBe(8);
  });
  test("no AudioContext available: chime is a no-op", () => {
    resetAudioForTests();
    FakeAudioContext.failConstruct = true;
    const n = FakeAudioContext.instances.length;
    chime("warn");
    expect(FakeAudioContext.instances.length).toBe(n);
  });
});
