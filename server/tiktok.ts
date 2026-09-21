import { Effect, Stream } from "effect";
import { ControlEvent, TikTokLiveConnection, WebcastEvent } from "tiktok-live-connector";
import type { LiveEvent } from "../shared/protocol";

export interface TikTokSession {
  events: Stream.Stream<LiveEvent, Error>;
  flvUrl: string | null;
  title: string;
}

const now = () => Date.now();
const handleOf = (u: any) => String(u?.displayId ?? u?.uniqueId ?? u?.id ?? "?");
/** Proto v2 puts avatar URLs in `avatarThumb.urlList`; prefer the jpeg variant, fall back to the first entry. */
const avatarOf = (u: any): string | undefined => {
  const list: string[] = u?.avatarThumb?.urlList ?? u?.avatarThumb?.url ?? u?.avatarMedium?.urlList ?? [];
  return list.find((x) => /\.jpe?g\?/.test(x)) ?? list[0];
};

/** One cheap question to TikTok: is this account streaming right now? (No socket, no room join.) */
export const isLive = (username: string, sessionId: string): Effect.Effect<boolean, Error> =>
  Effect.tryPromise({
    try: () => new TikTokLiveConnection(username, { fetchRoomInfoOnConnect: false, ...(sessionId ? { session: { cookie: { type: "cookie", value: { sessionId, ttTargetIdc: "useast2a" } } } } : {}) } as any).fetchIsLive(),
    catch: (e) => new Error(`is @${username} live? ${(e as Error).message ?? String(e)}`),
  });

/**
 * Connect to a TikTok live and expose its events as an Effect Stream.
 * The stream ends when the live ends, and FAILS when the connector drops the socket, so the session can react.
 * Field names verified against tiktok-live-connector 2.5 (payloads are proto v2: `content`, `user.displayId`, `total`).
 */
export const connectTikTok = (username: string, sessionId: string): Effect.Effect<TikTokSession, Error> =>
  Effect.gen(function* () {
    const conn = new TikTokLiveConnection(username, {
      fetchRoomInfoOnConnect: false,
      enableExtendedGiftInfo: false,
      ...(sessionId ? { session: { cookie: { type: "cookie", value: { sessionId, ttTargetIdc: "useast2a" } } } } : {}),
    } as any);

    const info: any = yield* Effect.tryPromise({ try: () => conn.fetchRoomInfo(), catch: (e) => new Error(`room info: ${(e as Error).message}`) });
    const data = info?.data ?? info;
    if (data?.status !== 2) return yield* Effect.fail(new Error(`@${username} is not live (status ${data?.status})`));
    const flv = data?.stream_url?.flv_pull_url ?? {};
    const flvUrl: string | null = flv.HD1 ?? flv.FULL_HD1 ?? flv.SD1 ?? flv.SD2 ?? Object.values(flv)[0] ?? data?.stream_url?.rtmp_pull_url ?? null;

    yield* Effect.tryPromise({ try: () => conn.connect(), catch: (e) => new Error(`connect: ${(e as Error).message}`) });

    const events = Stream.async<LiveEvent, Error>((emit) => {
      const push = (e: LiveEvent) => void emit.single(e);
      conn.on(WebcastEvent.CHAT, (m: any) =>
        push({ kind: "chat", id: String(m.common?.msgId ?? crypto.randomUUID()), ts: now(), userId: String(m.user?.id ?? ""), handle: handleOf(m.user), nickname: String(m.user?.nickname ?? ""), text: String(m.content ?? m.comment ?? ""), avatar: avatarOf(m.user), isFollower: m.user?.isFollower ?? undefined }));
      conn.on(WebcastEvent.GIFT, (m: any) => {
        if (m.repeatEnd === 0 && m.giftDetails?.giftType === 1) return; // streak still running
        push({ kind: "gift", id: String(m.common?.msgId ?? crypto.randomUUID()), ts: now(), handle: handleOf(m.user), nickname: String(m.user?.nickname ?? ""), avatar: avatarOf(m.user), giftName: String(m.giftDetails?.name ?? m.extendedGiftInfo?.name ?? `gift#${m.giftId}`), count: Number(m.repeatCount ?? 1), diamonds: Number(m.giftDetails?.diamondCount ?? 0) });
      });
      conn.on(WebcastEvent.LIKE, (m: any) => push({ kind: "like", ts: now(), count: Number(m.likeCount ?? m.count ?? 1), total: Number(m.totalLikeCount ?? m.total ?? 0) }));
      conn.on(WebcastEvent.MEMBER, (m: any) => push({ kind: "member", ts: now(), handle: handleOf(m.user), nickname: String(m.user?.nickname ?? ""), avatar: avatarOf(m.user) }));
      conn.on(WebcastEvent.SOCIAL, (m: any) => push({ kind: "social", ts: now(), handle: handleOf(m.user), nickname: String(m.user?.nickname ?? ""), avatar: avatarOf(m.user), action: /follow/i.test(m.displayType ?? m.action ?? "") ? "follow" : /share/i.test(m.displayType ?? m.action ?? "") ? "share" : "other" }));
      conn.on(WebcastEvent.ROOM_USER, (m: any) => push({ kind: "viewers", ts: now(), count: Number(m.total ?? m.viewerCount ?? 0) }));
      conn.on(WebcastEvent.STREAM_END, () => { push({ kind: "stream", ts: now(), state: "offline", username }); void emit.end(); });
      conn.on(ControlEvent.ERROR, (e: any) => push({ kind: "stream", ts: now(), state: "error", username, detail: String(e?.message ?? e?.info ?? e) }));
      // A dropped socket is a failure the session must see: it decides whether to reconnect or to end.
      conn.on(ControlEvent.DISCONNECTED, (e: any) => void emit.fail(new Error(`TikTok connection lost${e?.reason ? `: ${e.reason}` : ""}`)));
      return Effect.sync(() => { try { conn.disconnect(); } catch {} });
    });

    return { events, flvUrl, title: String(data?.title ?? "") };
  });
