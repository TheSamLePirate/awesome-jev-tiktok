import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Director } from "../Director";
import { api } from "../lib/api";
import { dispatch } from "../lib/store";
import { decision, health, hello, highlight, messageDecision, push, question, roomHl, sceneHl, snapshot, status, transcriptHl, T0 } from "./fixtures";

const key = (k: string) => act(() => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });

describe("Director", () => {
  afterEach(() => { window.happyDOM.setURL("http://localhost:5173/"); });
  test("live stage: meters, cards of every kind, pin / dismiss, ticker, waiting count, settings panel", async () => {
    const patch = spyOn(api, "patchHighlight").mockResolvedValue({ ok: true } as any);
    const now = Date.now();
    act(() => dispatch({ type: "ws", msg: hello({ decisions: [decision({ ts: now, skipped: ["q3"] })], highlights: [highlight({ ts: now - 1000 }), transcriptHl({ ts: now - 2000 }), sceneHl({ ts: now - 3000 }), roomHl({ ts: now - 4000, pinned: true }), highlight({ id: "old", ts: now - 600_000 }), highlight({ id: "res", resolved: true, ts: now })], messageDecisions: [messageDecision()] }) }));
    push({ type: "snapshot", snapshot: snapshot({ sources: { transcript: { state: "error", ageMs: 1 }, video: { state: "missing", ageMs: -1 }, chat: { state: "available", ageMs: 1 } } }) });
    const { container } = render(<Director />);
    expect(container.querySelector(".d-live.on")?.textContent).toBe("LIVE"); expect(container.textContent).toContain("👁 67"); expect(container.textContent).toContain("1 waiting"); expect(container.textContent).toContain("🎙 🎥 unavailable");
    expect(container.querySelectorAll(".dm").length).toBe(3); expect(container.querySelectorAll(".dm.fired").length).toBe(1); expect(container.querySelectorAll(".dm.skipped").length).toBe(1);
    expect(container.querySelectorAll(".dc").length).toBe(4); expect(container.querySelector(".dc.pinned")).not.toBeNull(); expect(container.querySelector(".dc.warn")).not.toBeNull();
    expect(container.textContent).toContain("💬 Reply to Alice"); expect(container.textContent).toContain("🎙 You said"); expect(container.textContent).toContain("🎥 Check the camera"); expect(container.textContent).toContain("✦ Room"); expect(container.textContent).toContain("bob: wow");
    expect(container.querySelectorAll(".d-chat span").length).toBe(2); expect(container.querySelector(".d-chat .hot")).not.toBeNull();
    // Pinned first, then newest first: h4 (pinned), h1, h2, h3.
    expect([...container.querySelectorAll(".dc")].map((c) => c.getAttribute("aria-label"))).toEqual(["✦ Room", "💬 Reply to Alice", "🎙 You said", "🎥 Check the camera"]);
    fireEvent.click(container.querySelector(".dc.pinned .dc-pin[aria-label='unpin']")!); expect(patch).toHaveBeenCalledWith("h4", { pinned: false });
    fireEvent.click(container.querySelectorAll(".dc")[1].querySelector(".dc-pin[aria-label='keep']")!); expect(patch).toHaveBeenCalledWith("h1", { pinned: true });
    fireEvent.click(container.querySelector(".dc [aria-label='dismiss']")!); expect(patch).toHaveBeenCalledWith("h4", { resolved: true });
    key("x"); expect(patch).toHaveBeenCalledTimes(4);
    key("g");
    expect(screen.getByText("Director view")).toBeTruthy();
    const ranges = container.querySelectorAll('.d-panel input[type="range"]');
    fireEvent.change(ranges[0], { target: { value: "10" } }); fireEvent.change(ranges[1], { target: { value: "2" } }); fireEvent.change(ranges[2], { target: { value: "1.5" } });
    expect(JSON.parse(localStorage.getItem("jev.director")!)).toMatchObject({ ttlSec: 10, maxCards: 2, scale: 1.5 });
    expect((container.querySelector(".director") as HTMLElement).style.fontSize).toBe("24px");
    expect(container.querySelectorAll(".dc").length).toBe(2);
    const boxes = container.querySelectorAll('.d-panel input[type="checkbox"]');
    fireEvent.click(boxes[0]); expect(container.querySelector(".d-meters")).toBeNull();
    fireEvent.click(boxes[1]); expect(container.querySelector(".d-chat")).toBeNull();
    fireEvent.click(boxes[2]); expect(container.querySelector(".dc.warn")).toBeNull();
    fireEvent.click(boxes[3]); expect(document.body.classList.contains("transparent")).toBe(true);
    fireEvent.click(boxes[3]); expect(document.body.classList.contains("transparent")).toBe(false);
    const qBoxes = container.querySelectorAll('.d-qs input[type="checkbox"]');
    fireEvent.click(qBoxes[0]); expect(JSON.parse(localStorage.getItem("jev.director")!).hidden).toEqual(["q1"]);
    fireEvent.click(qBoxes[0]); expect(JSON.parse(localStorage.getItem("jev.director")!).hidden).toEqual([]);
    fireEvent.click(qBoxes[3]); fireEvent.click(boxes[0]);
    expect(container.querySelectorAll(".dm").length).toBe(3); expect(container.textContent).not.toContain("waiting");
    key("Escape"); expect(screen.queryByText("Director view")).toBeNull();
    fireEvent.click(screen.getByLabelText("director settings")); expect(screen.getByText("Director view")).toBeTruthy();
    patch.mockRejectedValue(new Error("x")); key("x");
    fireEvent.click(container.querySelector(".dc .dc-pin[aria-label='keep']")!);
    fireEvent.click(container.querySelector(".dc .dc-pin[aria-label='dismiss']")!);
    await new Promise((r) => setTimeout(r, 10));
    patch.mockRestore();
  });
  test("state labels: offline console, stream state, paused, stale; URL overrides; idle text", () => {
    window.happyDOM.setURL("http://localhost:5173/?view=director&transparent=1&scale=1.25&warnings=0");
    act(() => dispatch({ type: "ws", msg: hello({ decisions: [], highlights: [sceneHl({ ts: Date.now() })], questions: { version: 1, createdAt: T0, reason: "x", questions: [question(), question({ id: "a" }), question({ id: "b" }), question({ id: "c" }), question({ id: "d" }), question({ id: "e" })] } }) }));
    const { container } = render(<Director />);
    expect(container.querySelectorAll(".dm").length).toBe(5); expect(container.querySelector(".director.transparent")).not.toBeNull(); expect((container.querySelector(".director") as HTMLElement).style.fontSize).toBe("20px");
    expect(container.querySelectorAll(".dc").length).toBe(0); expect(container.querySelector(".d-idle")?.textContent).toContain("waiting for decisions"); expect(container.querySelector(".d-live.warn")?.textContent).toBe("no decision");
    push({ type: "decision", decision: decision({ ts: Date.now() }) });
    expect(container.querySelector(".d-idle")?.textContent).toContain("nothing to act on"); expect(container.textContent).toContain("last decision 0 s ago");
    push({ type: "snapshot", snapshot: snapshot({ sources: { transcript: { state: "error", ageMs: 1 }, video: { state: "available", ageMs: 1 }, chat: { state: "available", ageMs: 1 } } }) });
    expect(container.textContent).toContain("transcript unavailable");
    push({ type: "health", health: health({ budget: { spent: 2, cap: 2, stopped: true } }) });
    expect(container.querySelector(".d-live.warn")?.textContent).toBe("paid calls paused"); expect(container.textContent).toContain("decisions paused");
    push({ type: "health", health: health({ breaker: { until: Date.now() + 10_000, reason: "402" } }) });
    expect(container.querySelector(".d-live.warn")?.textContent).toBe("paid calls paused");
    push({ type: "health", health: health() });
    push({ type: "event", event: status({ state: "offline", detail: "stream ended" }) });
    expect(container.querySelector(".d-live")?.textContent).toBe("offline"); expect(container.textContent).toContain("stream ended");
    act(() => dispatch({ type: "connected", value: false }));
    expect(container.querySelector(".d-live")?.textContent).toBe("console offline");
    act(() => dispatch({ type: "ws", msg: hello({ seq: 9, status: null as any, decisions: [] }) }));
    expect(container.querySelector(".d-live")?.textContent).toBe("offline");
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
  });
});
