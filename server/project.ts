import type { ChatEvent, Snapshot, Source } from "../shared/protocol";

export const sourceKey = (sources: readonly Source[]) => [...sources].sort().join("+");

/** The state jev sees for a window question: only the media the rule asked for. Irrelevant state distracts jev. */
export function projectWindow(snap: Snapshot, sources: readonly Source[]) {
  const s = new Set(sources);
  const out: Record<string, unknown> = {};
  if (s.has("transcript")) out.host_speech_last_30s = snap.transcript_last_30s || "(silence)";
  if (s.has("video")) out.video_scene = snap.scene.length ? snap.scene : ["(no frame yet)"];
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
  if (s.has("transcript")) context.host_speech_last_30s = snap.transcript_last_30s || "(silence)";
  if (s.has("video")) context.video_scene = snap.scene.slice(-1);
  return { message: { handle: m.handle, nickname: m.nickname, text: m.text }, context };
}
