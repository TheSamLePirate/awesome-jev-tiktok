import { describe, expect, mock, spyOn, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { T0 } from "./fixtures";

let supported = true;
class FakeHls {
  static last: FakeHls | null = null;
  static isSupported = () => supported;
  static Events = { MANIFEST_PARSED: "manifestParsed", LEVEL_UPDATED: "levelUpdated", ERROR: "error" };
  static ErrorTypes = { MEDIA_ERROR: "mediaError", NETWORK_ERROR: "networkError" };
  levels: any[] = [{ details: { fragments: [{ programDateTime: T0, start: 0 }, { programDateTime: T0 + 4000, start: 4 }, { programDateTime: null, start: 8 }] } }];
  currentLevel = 0; liveSyncPosition: number | undefined = 10; playingDate: Date | null = new Date(T0 + 2000);
  handlers: Record<string, ((ev: string, data?: any) => void)[]> = {};
  loadSource = mock((_url: string) => {}); attachMedia = mock(() => {}); startLoad = mock(() => {}); recoverMediaError = mock(() => {}); swapAudioCodec = mock(() => {}); destroy = mock(() => {});
  constructor(public cfg: any) { FakeHls.last = this; }
  on(ev: string, fn: any) { (this.handlers[ev] ??= []).push(fn); }
  emit(ev: string, data?: any) { act(() => { for (const f of this.handlers[ev] ?? []) f(ev, data); }); }
}
mock.module("hls.js", () => ({ default: FakeHls }));
const { VideoPane } = await import("../components/VideoPane");

const hlsSource = { kind: "hls" as const, url: "/hls/live.m3u8", startTs: T0 };
const base = { live: true, muted: true, onToggleMute: () => {}, size: "compact" as const };

describe("VideoPane", () => {
  test("no source: idle messages; HUD chips, mute, record and size controls", async () => {
    const onToggleMute = mock(() => {}), onRecord = mock(() => {}), onToggleSize = mock(() => {});
    const { container, rerender } = render(<VideoPane source={null} live={false} muted onToggleMute={onToggleMute} />);
    expect(container.textContent).toContain("not connected");
    rerender(<VideoPane source={null} {...base} onToggleMute={onToggleMute} viewers={12} recording={{ active: false, finalizing: true }} onRecord={onRecord} onToggleSize={onToggleSize} title="Titre" />);
    expect(container.textContent).toContain("waiting for stream"); expect(container.querySelector(".hud-live")?.textContent).toBe("LIVE"); expect(container.textContent).toContain("👁 12"); expect(container.textContent).toContain("finalizing…");
    expect(container.querySelector(".hud-title")).toBeNull();
    fireEvent.click(screen.getByText("REC")); expect(onRecord).toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("large player")); expect(onToggleSize).toHaveBeenCalled();
    rerender(<VideoPane source={hlsSource} {...base} onToggleMute={onToggleMute} size="large" onToggleSize={onToggleSize} title="Titre" reviewTs={T0} recording={{ active: true, since: Date.now() - 65_000, finalizing: false }} onRecord={onRecord} />);
    expect(container.querySelector(".hud-title")?.textContent).toBe("Titre"); expect(container.querySelector(".hud-chip.dvr")).not.toBeNull(); expect(screen.getByLabelText("compact player")).toBeTruthy();
    expect(container.querySelector(".hud-btn.rec.on")?.textContent).toContain("REC 1:05");
    await waitFor(() => expect(container.querySelector(".hud-btn.rec.on")?.textContent).toContain("REC 1:06"), { timeout: 2500 });
    fireEvent.click(screen.getByLabelText("unmute")); expect(onToggleMute).toHaveBeenCalledTimes(1);
    fireEvent.click(container.querySelector("video")!); expect(onToggleMute).toHaveBeenCalledTimes(2);
    rerender(<VideoPane source={hlsSource} {...base} muted={false} onToggleMute={onToggleMute} />);
    expect(screen.getByLabelText("mute")).toBeTruthy(); expect((container.querySelector("video") as HTMLVideoElement).muted).toBe(false);
  });

  test("hls.js player: config, events, DVR seeks, playing position, errors and teardown", async () => {
    localStorage.setItem("jev.token", "tk");
    const onPlayingTs = mock((_ts: number | null, _behind: number) => {}), onSeekResult = mock((_ts: number, _ok: boolean) => {});
    const realSetTimeout = globalThis.setTimeout;
    const { container, rerender, unmount } = render(<VideoPane source={hlsSource} {...base} reviewTs={T0 + 5000} onPlayingTs={onPlayingTs} onSeekResult={onSeekResult} />);
    await waitFor(() => expect(FakeHls.last).not.toBeNull());
    const hls = FakeHls.last!;
    const video = container.querySelector("video") as HTMLVideoElement;
    expect(hls.loadSource).toHaveBeenCalledWith("/hls/live.m3u8"); expect(hls.attachMedia).toHaveBeenCalled();
    const xhr = { setRequestHeader: mock(() => {}) }; hls.cfg.xhrSetup(xhr); expect(xhr.setRequestHeader).toHaveBeenCalledWith("Authorization", "Bearer tk");
    expect(container.querySelector(".video.loading")).not.toBeNull();
    hls.emit("manifestParsed"); expect(container.querySelector(".video.playing")).not.toBeNull();
    // The initial review seek waited for the level; it applies on LEVEL_UPDATED.
    await new Promise((r) => realSetTimeout(r, 150));
    hls.emit("levelUpdated");
    expect(video.currentTime).toBe(5); expect(onSeekResult).toHaveBeenLastCalledWith(T0 + 5000, true);
    hls.emit("levelUpdated");
    // Later seeks apply directly; before the first fragment is out of the window; null goes back to the live edge.
    rerender(<VideoPane source={hlsSource} {...base} reviewTs={T0 - 10_000} onPlayingTs={onPlayingTs} onSeekResult={onSeekResult} />);
    await waitFor(() => expect(onSeekResult).toHaveBeenLastCalledWith(T0 - 10_000, false));
    expect(video.currentTime).toBe(0);
    rerender(<VideoPane source={hlsSource} {...base} reviewTs={null} onPlayingTs={onPlayingTs} onSeekResult={onSeekResult} />);
    await waitFor(() => expect(video.currentTime).toBe(10));
    hls.liveSyncPosition = undefined; Object.defineProperty(video, "duration", { value: NaN, configurable: true });
    rerender(<VideoPane source={hlsSource} {...base} reviewTs={T0 + 4500} onPlayingTs={onPlayingTs} onSeekResult={onSeekResult} />);
    await waitFor(() => expect(video.currentTime).toBe(4.5));
    rerender(<VideoPane source={hlsSource} {...base} reviewTs={null} onPlayingTs={onPlayingTs} onSeekResult={onSeekResult} />);
    await waitFor(() => expect(onPlayingTs).toHaveBeenCalled());
    expect(onPlayingTs.mock.calls[0][0]).toBe(T0 + 2000);
    hls.playingDate = null;
    await waitFor(() => expect(onPlayingTs.mock.calls.at(-1)?.[0]).toBeNull(), { timeout: 2000 });
    hls.currentLevel = -1; hls.levels = [];
    rerender(<VideoPane source={hlsSource} {...base} reviewTs={T0 + 1} onPlayingTs={onPlayingTs} onSeekResult={onSeekResult} />);
    await waitFor(() => expect(onSeekResult).toHaveBeenLastCalledWith(T0 + 1, false));
    // Errors: non-fatal ignored; network → retry (loadSource again); media → recover up to 4 times (codec swap on the 3rd), then failed.
    hls.emit("error", { fatal: false }); expect(container.querySelector(".video.retrying")).toBeNull();
    hls.emit("error", { fatal: true, type: "networkError" });
    expect(container.textContent).toContain("reconnecting…");
    await waitFor(() => expect(hls.loadSource).toHaveBeenCalledTimes(2), { timeout: 3500 });
    expect(hls.startLoad).toHaveBeenCalled();
    for (let i = 0; i < 4; i++) hls.emit("error", { fatal: true, type: "mediaError" });
    expect(hls.recoverMediaError).toHaveBeenCalledTimes(4); expect(hls.swapAudioCodec).toHaveBeenCalledTimes(1);
    hls.emit("error", { fatal: true, type: "mediaError" });
    expect(container.textContent).toContain("playback failed");
    const reload = spyOn(location, "reload").mockImplementation(() => {});
    fireEvent.click(screen.getByText("reload")); expect(reload).toHaveBeenCalled(); reload.mockRestore();
    hls.emit("error", { fatal: true, type: "mediaError" });
    unmount();
    expect(hls.destroy).toHaveBeenCalled();
    localStorage.clear();
  });

  test("native HLS (no MSE): src set directly, seeks map through getStartDate; a refused play() is swallowed", async () => {
    supported = false;
    // Autoplay refused by the browser: every play() rejection is caught, nothing crashes.
    const play = spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.reject(new Error("NotAllowedError")));
    const onSeekResult = mock((_ts: number, _ok: boolean) => {});
    const { container, rerender } = render(<VideoPane source={hlsSource} {...base} reviewTs={null} onSeekResult={onSeekResult} />);
    const video = container.querySelector("video") as HTMLVideoElement & { getStartDate?: () => Date };
    await waitFor(() => expect(video.getAttribute("src")).toBe("/hls/live.m3u8"));
    Object.defineProperty(video, "duration", { value: 100, configurable: true });
    rerender(<VideoPane source={hlsSource} {...base} reviewTs={T0 + 3000} onSeekResult={onSeekResult} />);
    await new Promise((r) => setTimeout(r, 150));
    expect(onSeekResult).not.toHaveBeenCalled();
    video.getStartDate = () => new Date(T0);
    rerender(<VideoPane source={hlsSource} {...base} reviewTs={T0 + 3000} onSeekResult={onSeekResult} />);
    rerender(<VideoPane source={hlsSource} {...base} reviewTs={T0 + 3001} onSeekResult={onSeekResult} />);
    await waitFor(() => expect(onSeekResult).toHaveBeenLastCalledWith(T0 + 3001, true));
    expect(video.currentTime).toBeCloseTo(3.001);
    rerender(<VideoPane source={hlsSource} {...base} reviewTs={T0 + 500_000} onSeekResult={onSeekResult} />);
    await waitFor(() => expect(onSeekResult).toHaveBeenLastCalledWith(T0 + 500_000, false));
    rerender(<VideoPane source={hlsSource} {...base} reviewTs={null} onSeekResult={onSeekResult} />);
    await waitFor(() => expect(video.currentTime).toBe(100));
    video.getStartDate = () => new Date(NaN);
    rerender(<VideoPane source={hlsSource} {...base} reviewTs={T0 + 1} onSeekResult={onSeekResult} />);
    await new Promise((r) => setTimeout(r, 150));
    expect(onSeekResult).toHaveBeenCalledTimes(2);
    expect(play.mock.calls.length).toBeGreaterThan(3);
    play.mockRestore();
    supported = true;
  });

  test("recorded segments: sync to the replay clock, gaps and resync", async () => {
    let tick: (() => void) | null = null;
    const realSetInterval = globalThis.setInterval;
    const si = spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms?: number) => (ms === 2000 ? ((tick = fn), 99 as any) : realSetInterval(fn, ms))) as any);
    const startedAt = Date.now();
    const source = { kind: "file" as const, t0: T0, startedAt, segments: [{ url: "/recordings/a.mp4", startTs: T0, endTs: T0 + 60_000 }, { url: "/recordings/b.mp4", startTs: T0 + 120_000, endTs: T0 + 180_000 }] };
    const { container, rerender } = render(<VideoPane source={source} {...base} live={false} viewers={3} onPlayingTs={() => {}} />);
    const video = container.querySelector("video") as HTMLVideoElement;
    expect(container.textContent).toContain("▶ replay"); expect(video.getAttribute("src")).toBe("/recordings/a.mp4"); expect(container.querySelector(".video.loading")).not.toBeNull();
    act(() => { fireEvent(video, new Event("loadedmetadata")); });
    expect(container.querySelector(".video.playing")).not.toBeNull(); expect(video.currentTime).toBeLessThan(2);
    video.currentTime = 30; act(() => tick!()); expect(video.currentTime).toBeLessThan(2);
    Object.defineProperty(video, "paused", { value: true, configurable: true }); act(() => tick!());
    // Jump the replay clock into the gap, then into the second segment.
    rerender(<VideoPane source={{ ...source, startedAt: startedAt - 90_000 }} {...base} live={false} />);
    act(() => { fireEvent(video, new Event("loadedmetadata")); });
    expect(container.textContent).toContain("no video for this moment");
    rerender(<VideoPane source={{ ...source, startedAt: startedAt - 90_000, segments: [source.segments[0]] }} {...base} live={false} />);
    act(() => tick!());
    expect(container.textContent).toContain("no video for this moment");
    rerender(<VideoPane source={{ ...source, startedAt: startedAt - 130_000 }} {...base} live={false} />);
    await waitFor(() => expect(video.getAttribute("src")).toBe("/recordings/b.mp4"));
    si.mockRestore();
  });
});
