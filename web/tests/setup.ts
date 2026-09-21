// Preloaded before every web test (bun test --preload): a DOM, React's act environment and the browser APIs happy-dom lacks.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, mock } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost:5173/", width: 1680, height: 1000 });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** Minimal Notification: records constructions, supports close/onclick, permission is a mutable static. */
export class FakeNotification {
  static permission: NotificationPermission = "default";
  static created: FakeNotification[] = [];
  static requestPermission = mock(async () => FakeNotification.permission);
  closed = false;
  onclick: (() => void) | null = null;
  constructor(public title: string, public options?: NotificationOptions) { FakeNotification.created.push(this); }
  close() { this.closed = true; }
}
(globalThis as any).Notification = FakeNotification;

/** Minimal AudioContext: enough for the chime (oscillator + gain + ramps), with call tracking. */
export class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static failConstruct = false;
  state: "running" | "suspended" = "running";
  currentTime = 0;
  destination = {};
  resume = mock(async () => { this.state = "running"; });
  started: number[] = [];
  constructor() { if (FakeAudioContext.failConstruct) throw new Error("no audio"); FakeAudioContext.instances.push(this); }
  createOscillator() { const node: any = { type: "sine", frequency: { value: 0 }, connect: (n: any) => n, start: (t: number) => this.started.push(t), stop: () => {} }; return node; }
  createGain() { const node: any = { gain: { value: 0, exponentialRampToValueAtTime: () => {} }, connect: (n: any) => n }; return node; }
}
(globalThis as any).AudioContext = FakeAudioContext;

// Media elements: pause/load are no-ops; play() is refused, as a browser does without a user gesture (every caller must swallow it).
const media = (globalThis as any).HTMLMediaElement?.prototype;
if (media) { media.play = function () { return Promise.reject(new Error("NotAllowedError: play() blocked")); }; media.pause = function () {}; media.load = function () {}; }
if (!(URL as any).revokeObjectURL) (URL as any).revokeObjectURL = () => {};
if (!(URL as any).createObjectURL) (URL as any).createObjectURL = () => "blob:test";

const { cleanup } = await import("@testing-library/react");
/** Override an accessor (happy-dom getters such as document.visibilityState) for one test; returns the undo. */
export const defineValue = (o: object, k: string, value: unknown) => { Object.defineProperty(o, k, { value, configurable: true }); return () => { delete (o as any)[k]; }; };

// A failing test must not leak its spies into the next file: restore everything after each test.
afterEach(() => { cleanup(); mock.restore(); try { localStorage.clear(); } catch {} FakeNotification.created = []; FakeNotification.permission = "default"; FakeAudioContext.failConstruct = false; if (Object.prototype.hasOwnProperty.call(document, "visibilityState")) delete (document as any).visibilityState; });
