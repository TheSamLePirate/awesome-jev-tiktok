// A small synthetic session (no real viewers, no real stream) that the e2e replay test plays back in dry-run mode.
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { LiveEvent } from "../shared/protocol";

export const FIXTURE_ID = "e2e_host-2026-09-21T00-00-00-000Z";
export const FIXTURE_USER = "e2e_host";
/** Chat text that the keyword rule of the replay test matches. */
export const LINK_MESSAGE = "regardez ça https://example.test/promo";

export function syntheticEvents(t0: number): LiveEvent[] {
  const viewer = (n: number) => ({ userId: `u${n}`, handle: `viewer${n}`, nickname: `Viewer ${n}` });
  const chat = (id: number, at: number, n: number, text: string): LiveEvent => ({ kind: "chat", id: `m${id}`, ts: t0 + at, ...viewer(n), text });
  return [
    { kind: "stream", ts: t0, state: "live", username: FIXTURE_USER, title: "Session e2e" },
    { kind: "viewers", ts: t0 + 100, count: 42 },
    { kind: "caption", ts: t0 + 200, text: "A person speaking at a desk, a lamp on the left." },
    { kind: "transcript", id: "t1", ts: t0 + 300, endTs: t0 + 1800, text: "Bonjour à tous, on commence la session.", final: true },
    chat(1, 400, 1, "salut tout le monde"),
    chat(2, 900, 2, "c'est quoi le sujet ce soir ?"),
    { kind: "member", ts: t0 + 1000, handle: "viewer3", nickname: "Viewer 3" },
    chat(3, 1500, 3, LINK_MESSAGE),
    { kind: "transcript", id: "t2", ts: t0 + 2000, endTs: t0 + 4000, text: "Ce soir on parle des tests de bout en bout.", final: true },
    { kind: "like", ts: t0 + 2500, count: 5, total: 5 },
    chat(4, 3000, 1, "super"),
    { kind: "viewers", ts: t0 + 3500, count: 45 },
    { kind: "gift", id: "g1", ts: t0 + 4000, handle: "viewer2", giftName: "Rose", count: 1, diamonds: 1 },
    { kind: "caption", ts: t0 + 4500, text: "The person raises a hand." },
    { kind: "transcript", id: "t3", ts: t0 + 5000, endTs: t0 + 6500, text: "Merci pour la rose !", final: true },
    chat(5, 6000, 2, "de rien"),
    { kind: "social", ts: t0 + 6500, handle: "viewer4", action: "follow" },
    chat(6, 8000, 4, "je viens de m'abonner"),
    { kind: "transcript", id: "t4", ts: t0 + 9000, endTs: t0 + 10_500, text: "Bienvenue aux nouveaux.", final: true },
    { kind: "viewers", ts: t0 + 10_000, count: 50 },
    chat(7, 12_000, 1, "à demain"),
    { kind: "transcript", id: "t5", ts: t0 + 14_000, endTs: t0 + 15_000, text: "On se retrouve demain, bonne soirée.", final: true },
    { kind: "stream", ts: t0 + 16_000, state: "offline", username: FIXTURE_USER },
  ];
}

export function writeSyntheticRecording(dir: string) {
  const t0 = Date.parse("2026-09-21T00:00:00.000Z");
  const events = syntheticEvents(t0);
  const first = events[0].ts, last = events.at(-1)!.ts;
  writeFileSync(path.join(dir, `${FIXTURE_ID}.jsonl`), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(path.join(dir, `${FIXTURE_ID}.meta.json`), JSON.stringify({
    username: FIXTURE_USER, startedAt: t0, videos: [], title: "Session e2e",
    stats: { eventCount: events.length, chatCount: events.filter((e) => e.kind === "chat").length, transcriptCount: events.filter((e) => e.kind === "transcript").length, first, last },
    endedAt: last + 1,
  }, null, 1));
}
