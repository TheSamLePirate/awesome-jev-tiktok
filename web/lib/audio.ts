import type { Severity } from "@shared/protocol";

/** One lazily created AudioContext for the whole page (browsers cap the number of contexts), resumed on first use. */
let ctx: AudioContext | null = null;
const getCtx = () => { if (!ctx) { try { ctx = new AudioContext(); } catch { return null; } } if (ctx.state === "suspended") void ctx.resume().catch(() => {}); return ctx; };

/** Resume on the first user gesture so a chime can play later without one. */
export const primeAudio = () => { const once = () => { getCtx(); window.removeEventListener("pointerdown", once); window.removeEventListener("keydown", once); }; window.addEventListener("pointerdown", once); window.addEventListener("keydown", once); };

/** A soft two-tone chime, generated locally so there is no asset to load. Warnings use a lower, longer pair. */
export function chime(severity: Severity = "info") {
  const c = getCtx();
  if (!c) return;
  const play = (f: number, t: number, d = 0.35) => { const o = c.createOscillator(); const g = c.createGain(); o.type = "sine"; o.frequency.value = f; g.gain.value = 0.0001; o.connect(g).connect(c.destination); o.start(c.currentTime + t); g.gain.exponentialRampToValueAtTime(0.08, c.currentTime + t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + t + d); o.stop(c.currentTime + t + d + 0.05); };
  if (severity === "warn") { play(523, 0, 0.3); play(392, 0.16, 0.45); }
  else { play(880, 0); play(1174, 0.12); }
}
