import type { ChatEvent, Snapshot, Source } from "../shared/protocol";

export const sourceKey = (sources: readonly Source[]) => [...sources].sort().join("+");

/** What jev reads when a source has nothing: silence is an observation, unavailability is not. */
const speechText = (snap: Snapshot) => {
  if (snap.transcript_last_30s) return snap.transcript_last_30s;
  const h = snap.sources?.transcript;
  return h && (h.state === "missing" || h.state === "error") ? "(audio unavailable)" : "(silence)";
};
const sceneText = (snap: Snapshot) => {
  if (snap.scene.length) return snap.scene;
  const h = snap.sources?.video;
  return [h && (h.state === "missing" || h.state === "error") ? "(video unavailable)" : "(no frame yet)"];
};

/** The state jev sees for a window question: only the media the rule asked for. Irrelevant state distracts jev. */
export function projectWindow(snap: Snapshot, sources: readonly Source[]) {
  const s = new Set(sources);
  const out: Record<string, unknown> = {};
  if (s.has("transcript")) out.host_speech_last_30s = speechText(snap);
  if (s.has("video")) out.video_scene = sceneText(snap);
  if (s.has("chat")) {
    out.chat_recent = snap.chat_recent;
    out.activity = snap.activity;
  } else {
    out.activity = { viewers: snap.activity.viewers, viewers_trend: snap.activity.viewers_trend, likes_last_30s: snap.activity.likes_last_30s, gifts_last_60s: snap.activity.gifts_last_60s };
  }
  return out;
}

/** The state for a per-message question: the message, plus whatever context the rule's sources allow. */
export function projectMessage(m: ChatEvent, snap: Snapshot, sources: readonly Source[]) {
  const s = new Set(sources);
  const context: Record<string, unknown> = { previous_chat: snap.chat_recent.filter((c) => !(c.handle === m.handle && c.text === m.text)).slice(-8) };
  if (s.has("transcript")) context.host_speech_last_30s = speechText(snap);
  if (s.has("video")) context.video_scene = sceneText(snap).slice(-1);
  return { message: { handle: m.handle, nickname: m.nickname, text: m.text }, context };
}

/**
 * A fingerprint of the business content jev would judge, ignoring what changes every tick without meaning
 * (timestamps, `secs_ago`, the raw viewer count). Equal fingerprints = the same decision, so the call can be skipped.
 * Content expiry changes the fingerprint too (a pruned transcript line changes the text), so a decision that should
 * turn off still gets re-evaluated.
 */
export function fingerprint(snap: Snapshot, sources: readonly Source[]): string {
  const s = new Set(sources);
  const parts: unknown[] = [];
  if (s.has("transcript")) parts.push(speechText(snap));
  if (s.has("video")) parts.push(sceneText(snap));
  if (s.has("chat")) parts.push(snap.chat_recent.map((c) => `${c.handle}${c.text}`), snap.activity.chat_velocity, snap.activity.new_joins_last_30s);
  parts.push(snap.activity.viewers_trend, snap.activity.likes_last_30s, snap.activity.gifts_last_60s);
  return JSON.stringify(parts);
}
