import { Effect, Layer, ManagedRuntime, Ref, Scope, Exit, Stream, Fiber } from "effect";
import path from "node:path";
import { AppConfig } from "./config";
import { Bus } from "./bus";
import { Window } from "./window";
import { Store } from "./store";
import { Jev } from "./jev";
import { Glm } from "./glm";
import { SettingsStore } from "./settings";
import { connectTikTok } from "./tiktok";
import { runMedia, HLS_DIR } from "./media";
import { rm } from "node:fs/promises";
import { runLoops } from "./loop";
import { recorder, replayEvents, writeMeta, readMeta, recordingSpan, listRecordings, peekRecording, deleteRecording, type RecordingMeta } from "./replay";
import { ALL_SOURCES, type FeedbackRequest, type LiveEvent, type RecordingState, type Rule, type ServerMessage, type Source, type StreamStatusEvent, type VideoSegment, type VideoSource } from "../shared/protocol";

const MainLayer = Layer.mergeAll(Bus.Default, Window.Default, Store.Default, Jev.Default, Glm.Default).pipe(Layer.provideMerge(SettingsStore.Default));
const runtime = ManagedRuntime.make(MainLayer);
const cfg = await runtime.runPromise(AppConfig);

// ---------------- session lifecycle ----------------
const status = await runtime.runPromise(Ref.make<StreamStatusEvent>({ kind: "stream", ts: Date.now(), state: "offline", username: cfg.tiktokUsername }));
const video = await runtime.runPromise(Ref.make<VideoSource | null>(null));
interface Session {
  scope: Scope.CloseableScope;
  username: string;
  /** recordings/<user>-<time> (no extension) for this session's files. */
  base: string;
  flvUrl: string | null;
  meta: RecordingMeta;
  /** Video segment currently being written: the automatic one from session start, or an on-demand one. */
  rec: { proc: Bun.Subprocess | null; file: string; startTs: number } | null;
  /** When this session is a replay: the id of the recording it plays. */
  replayOf?: string;
}
let session: Session | null = null;

const recordingState = (): RecordingState => ({ active: !!session?.rec, file: session?.rec?.file, since: session?.rec?.startTs, segments: session?.meta.videos.length ?? 0, sessionId: session && !session.replayOf ? path.basename(session.base) : undefined, replayOf: session?.replayOf });
const publishRecording = Effect.flatMap(Bus, (bus) => bus.publish({ type: "recording", recording: recordingState() }));

/** Start an on-demand video segment: its own ffmpeg (stream copy) so it can start and stop independently of the main media pipeline. */
const startRecording = Effect.gen(function* () {
  const s = session;
  const bus = yield* Bus;
  if (!s || !s.flvUrl) return { ok: false as const, error: "no live video to record" };
  if (s.rec) return { ok: false as const, error: "already recording" };
  const n = s.meta.videos.length + 1;
  const file = `${s.base}.rec${n}.mp4`;
  const proc = Bun.spawn(["ffmpeg", "-loglevel", "error", "-nostdin", "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5", "-i", s.flvUrl, "-map", "0:v", "-map", "0:a", "-c", "copy", "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-y", file], { stdout: "ignore", stderr: "pipe" });
  const startTs = Date.now();
  s.rec = { proc, file, startTs };
  s.meta.videos.push({ file: path.basename(file), startTs, endTs: null });
  yield* writeMeta(s.base, s.meta);
  yield* bus.log({ actor: "system", kind: "record", detail: `recording started → ${path.basename(file)}`, ok: true });
  yield* publishRecording;
  return { ok: true as const, file };
});

/** Stop the current video segment, close its timestamps in the meta, and finalize it into a seekable MP4. */
const stopRecording = (reason: string) =>
  Effect.gen(function* () {
    const s = session;
    const bus = yield* Bus;
    if (!s || !s.rec) return { ok: false as const, error: "not recording" };
    const rec = s.rec;
    s.rec = null;
    const endTs = Date.now();
    const v = s.meta.videos.find((x) => x.file === path.basename(rec.file));
    if (v) v.endTs = endTs;
    yield* writeMeta(s.base, s.meta);
    if (rec.proc) { try { rec.proc.kill("SIGINT"); } catch {} yield* Effect.promise(() => Promise.race([rec.proc!.exited, new Promise((r) => setTimeout(r, 3000))])).pipe(Effect.ignore); try { rec.proc.kill(); } catch {} }
    yield* bus.log({ actor: "system", kind: "record", detail: `recording stopped (${reason}) · ${Math.round((endTs - rec.startTs) / 1000)} s`, ok: true });
    yield* publishRecording;
    yield* Effect.forkDaemon(finalizeRecording(rec.file));
    return { ok: true as const, file: rec.file };
  });

const setStatus = (s: Partial<StreamStatusEvent>) =>
  Effect.gen(function* () {
    const bus = yield* Bus;
    const next = yield* Ref.updateAndGet(status, (cur) => ({ ...cur, ...s, ts: Date.now() }));
    yield* bus.event(next);
    yield* bus.log({ actor: "system", kind: next.state, detail: `@${next.username}${next.title ? ` · ${next.title}` : ""}${next.detail ? ` · ${next.detail}` : ""}`, ok: next.state !== "error" });
  });

/** Wipe everything that belonged to the live session, on every client. Rules, versions, settings and the log survive. */
const clearSessionData = (reason: string) =>
  Effect.gen(function* () {
    const bus = yield* Bus;
    const win = yield* Window;
    const store = yield* Store;
    yield* win.reset;
    yield* bus.clearSession;
    yield* store.clearHighlights("unpinned");
    yield* Ref.set(video, null);
    yield* Effect.promise(() => rm(HLS_DIR, { recursive: true, force: true })).pipe(Effect.ignore);
    yield* bus.publish({ type: "reset", reason });
    yield* bus.log({ actor: "system", kind: "cleared", detail: `session data cleared: ${reason}`, ok: true });
  });

/**
 * The live recording is a fragmented MP4 (survives a hard kill, but has no seek index).
 * Remux it in place into a regular faststart MP4 so replay can seek anywhere. Stream copy: seconds, no quality loss.
 */
const finalizeRecording = (file: string) =>
  Effect.gen(function* () {
    const bus = yield* Bus;
    if (!(yield* Effect.promise(() => Bun.file(file).exists()))) return;
    const tmp = file.replace(/\.mp4$/, ".tmp.mp4");
    const t0 = Date.now();
    const code = yield* Effect.promise(() => Bun.spawn(["ffmpeg", "-loglevel", "error", "-y", "-i", file, "-c", "copy", "-movflags", "+faststart", tmp], { stdout: "ignore", stderr: "pipe" }).exited);
    if (code === 0) {
      yield* Effect.promise(() => Bun.write(file, Bun.file(tmp)).then(() => rm(tmp, { force: true })));
      yield* bus.log({ actor: "system", kind: "record", detail: `finalized ${path.basename(file)} (seekable mp4)`, ok: true, latencyMs: Date.now() - t0 });
    } else {
      yield* Effect.promise(() => rm(tmp, { force: true }));
      yield* bus.log({ actor: "system", kind: "record", detail: `finalize failed for ${path.basename(file)} (ffmpeg exit ${code}); fragmented file kept`, ok: false });
    }
  }).pipe(Effect.catchAll((e) => Effect.logWarning(`finalize: ${String(e)}`)));

/** End the current session (stream ended, error, or user disconnect): stop media, mark offline, clear data. */
const endSession = (state: "offline" | "error", reason: string, detail?: string) =>
  Effect.gen(function* () {
    if (session?.rec) yield* stopRecording(reason);
    const s = session;
    session = null;
    if (s) yield* Scope.close(s.scope, Exit.void);
    yield* setStatus({ state, detail, title: undefined });
    yield* clearSessionData(reason);
    yield* publishRecording;
  });

const stopSession = endSession("offline", "disconnected by user");

/** Connect to a live (or a replay file), start ffmpeg + Deepgram + vision, and the jev loops. */
const startSession = (username: string, replayFile: string) =>
  Effect.gen(function* () {
    if (session) yield* stopSession;
    const scope = yield* Scope.make();
    const base = path.join("recordings", `${username}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    session = { scope, username, base, flvUrl: null, meta: { username, startedAt: Date.now(), videos: [] }, rec: null, replayOf: replayFile ? path.basename(replayFile).replace(/\.jsonl$/, "") : undefined };
    const bus = yield* Bus;
    const win = yield* Window;

    const boot = Effect.gen(function* () {
      yield* setStatus({ state: "connecting", username, detail: replayFile ? `replaying ${replayFile}` : undefined });
      let events: Stream.Stream<LiveEvent, Error>;
      const me = session!;
      const base = me.base;
      if (replayFile) {
        const rbase = replayFile.replace(/\.jsonl$/, "");
        const meta = yield* readMeta(rbase);
        const span = yield* recordingSpan(replayFile);
        yield* setStatus({ state: "live", title: meta._tag === "Some" && meta.value.title ? `replay · ${meta.value.title}` : "replay" });
        // Every video segment that exists on disk, positioned on the event timeline.
        const segments: VideoSegment[] = [];
        for (const v of meta._tag === "Some" ? meta.value.videos : []) {
          const f = path.join("recordings", v.file);
          if (!(yield* Effect.promise(() => Bun.file(f).exists()))) continue;
          let endTs = v.endTs;
          if (endTs === null) { const p = Bun.spawn(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], { stdout: "pipe", stderr: "ignore" }); const d = Number((yield* Effect.promise(() => new Response(p.stdout).text())).trim()) || 0; endTs = v.startTs + d * 1000; }
          segments.push({ url: `/recordings/${v.file}`, startTs: v.startTs, endTs });
        }
        if (segments.length) {
          const src: VideoSource = { kind: "file", segments, t0: span.first, startedAt: Date.now() };
          yield* Ref.set(video, src);
          yield* bus.publish({ type: "video", video: src });
        }
        events = replayEvents(replayFile);
      } else {
        const st = yield* (yield* SettingsStore).get;
        const tt = yield* connectTikTok(username, st.tiktok.sessionId);
        events = tt.events;
        me.flvUrl = tt.flvUrl;
        me.meta.title = tt.title;
        yield* setStatus({ state: "live", title: tt.title });
        if (tt.flvUrl) {
          // Automatic segment from the start when the setting is on; it runs inside the main ffmpeg, so proc is null.
          const auto = st.media.recordVideo ? `${base}.mp4` : null;
          if (auto) { me.rec = { proc: null, file: auto, startTs: Date.now() }; me.meta.videos.push({ file: path.basename(auto), startTs: me.rec.startTs, endTs: null }); }
          yield* runMedia(tt.flvUrl, auto).pipe(Effect.catchAll((e) => Effect.logWarning(`media: ${String(e)}`)));
          if (st.media.hls) yield* Ref.set(video, { kind: "hls", url: "/hls/live.m3u8" });
        } else {
          yield* Effect.logWarning("no FLV url in room info; running chat-only");
        }
        yield* writeMeta(base, me.meta);
        yield* publishRecording;
      }
      const record = yield* recorder(`${base}.jsonl`);
      // Fan every source event into the window, the UI, and the recorder.
      // When the event stream ends (stream offline) or fails, tear the whole session down and clear its data.
      yield* events.pipe(
        Stream.tap((e) => Effect.all([win.ingest(e), bus.event(e), replayFile ? Effect.void : record(e)])),
        Stream.runDrain,
        Effect.matchEffect({
          onFailure: (e) => Effect.forkDaemon(endSession("error", `stream error: ${e.message}`, e.message)),
          onSuccess: () => Effect.forkDaemon(endSession("offline", replayFile ? "replay finished" : "live ended")),
        }),
        Effect.forkScoped,
      );
      // Also pipe transcript/caption events that media.ts emitted directly to the bus into the recorder.
      if (!replayFile) {
        yield* bus.stream.pipe(
          Stream.filter((m): m is Extract<ServerMessage, { type: "event" }> => m.type === "event" && (m.event.kind === "transcript" || m.event.kind === "caption")),
          Stream.runForEach((m) => record(m.event)),
          Effect.forkScoped,
        );
      }
      yield* runLoops;
    }).pipe(
      Effect.tapError((e) => Effect.forkDaemon(endSession("error", `connect failed: ${(e as Error).message ?? String(e)}`, (e as Error).message ?? String(e)))),
      Effect.catchAll(() => Effect.void),
    );

    yield* Scope.extend(boot, scope);
  });

// ---------------- GLM-driven rule management ----------------
const addRule = (text: string, sources: Source[]) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const glm = yield* Glm;
    const bus = yield* Bus;
    const rule: Rule = { id: `r-${crypto.randomUUID().slice(0, 8)}`, text, sources, createdAt: Date.now() };
    yield* store.addRule(rule);
    const id = crypto.randomUUID();
    yield* bus.publish({ type: "glm", activity: { id, ts: Date.now(), kind: "compile", status: "running", summary: `compiling rule: ${text}` } });
    const set = yield* store.current;
    const r = yield* glm.compileRule(rule, set.questions).pipe(Effect.either);
    if (r._tag === "Left") {
      yield* store.removeRule(rule.id);
      yield* bus.publish({ type: "glm", activity: { id, ts: Date.now(), kind: "compile", status: "error", summary: r.left.message } });
      yield* bus.log({ actor: "glm", kind: "compile", detail: `${text.slice(0, 80)} → ${r.left.message}`, ok: false });
      return { ok: false as const, error: r.left.message };
    }
    yield* bus.log({ actor: "glm", kind: "compile", detail: `${text.slice(0, 80)} → ${r.right.questions.map((q) => q.id).join(", ")}`, ok: true, latencyMs: r.right.latencyMs, inputTokens: r.right.usage.inputTokens, outputTokens: r.right.usage.outputTokens, cost: r.right.usage.cost });
    const next = yield* store.append(`rule added: ${text}`, r.right.questions);
    yield* bus.publish({ type: "glm", activity: { id, ts: Date.now(), kind: "compile", status: "done", summary: `wrote ${r.right.questions.map((q) => `${q.id} (${q.question.type}, ${q.scope})`).join(", ")}`, tokens: r.right.tokens } });
    yield* bus.publish({ type: "questions", set: next, history: yield* store.history, rules: yield* store.rules });
    return { ok: true as const, rule, questions: r.right.questions };
  });

const removeRule = (ruleId: string) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const bus = yield* Bus;
    yield* store.removeRule(ruleId);
    const next = yield* store.dropRule(ruleId);
    yield* bus.publish({ type: "questions", set: next, history: yield* store.history, rules: yield* store.rules });
  });

const feedback = (fb: FeedbackRequest) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const glm = yield* Glm;
    const bus = yield* Bus;
    const set = yield* store.current;
    const q = set.questions.find((x) => x.id === fb.questionId);
    if (!q) return { ok: false as const, error: "unknown question" };
    const rules = yield* store.rules;
    const id = crypto.randomUUID();
    yield* bus.publish({ type: "glm", activity: { id, ts: Date.now(), kind: "refine", status: "running", summary: `you disagreed with "${q.label}"${fb.note ? `: ${fb.note}` : ""}; GLM is rewriting it` } });
    const r = yield* glm.refine(q, rules.find((r) => r.id === q.ruleId), { feedback: [fb] }).pipe(Effect.either);
    if (r._tag === "Left") {
      yield* bus.publish({ type: "glm", activity: { id, ts: Date.now(), kind: "refine", status: "error", summary: r.left.message } });
      yield* bus.log({ actor: "glm", kind: "refine", detail: `${q.label}: ${r.left.message}`, ok: false });
      return { ok: false as const, error: r.left.message };
    }
    yield* bus.log({ actor: "glm", kind: "refine", detail: `${q.label}: ${r.right.rationale}`, ok: true, latencyMs: r.right.latencyMs, inputTokens: r.right.usage.inputTokens, outputTokens: r.right.usage.outputTokens, cost: r.right.usage.cost });
    const next = yield* store.replace(`refined "${q.label}" after feedback: ${r.right.rationale}`, r.right.question);
    yield* bus.publish({ type: "glm", activity: { id, ts: Date.now(), kind: "refine", status: "done", summary: r.right.rationale, tokens: r.right.tokens } });
    yield* bus.publish({ type: "questions", set: next, history: yield* store.history, rules });
    return { ok: true as const, question: r.right.question };
  });

// ---------------- HTTP + WebSocket ----------------
const json = (data: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(data), { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });

const hello = Effect.gen(function* () {
  const bus = yield* Bus;
  const store = yield* Store;
  const msg: ServerMessage = {
    type: "hello",
    status: yield* Ref.get(status),
    questions: yield* store.current,
    history: yield* store.history,
    rules: yield* store.rules,
    recent: yield* bus.recentEvents,
    decisions: yield* bus.recentDecisions,
    messageDecisions: yield* bus.recentMessageDecisions,
    highlights: yield* store.highlights,
    log: yield* bus.recentLog,
    settings: yield* (yield* SettingsStore).public,
    glm: yield* bus.recentGlm,
    video: yield* Ref.get(video),
    recording: recordingState(),
  };
  return msg;
});

const server = Bun.serve<{ id: string }>({
  port: cfg.port,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") return srv.upgrade(req, { data: { id: crypto.randomUUID() } }) ? undefined : new Response("upgrade failed", { status: 400 });
    if (url.pathname.startsWith("/hls/")) {
      const f = Bun.file(path.join(HLS_DIR, path.basename(url.pathname)));
      if (!(await f.exists())) return new Response("not found", { status: 404 });
      return new Response(f, { headers: { "Cache-Control": "no-store", "Content-Type": url.pathname.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t" } });
    }
    if (url.pathname === "/api/state") return json(await runtime.runPromise(hello));
    if (url.pathname === "/api/connect" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { username?: string; replay?: string };
      const username = (body.username ?? (await runtime.runPromise(Effect.flatMap(SettingsStore, (s) => s.get))).tiktok.username).replace(/^@/, "").trim();
      const replay = body.replay ?? "";
      if (!username && !replay) return json({ ok: false, error: "username required" }, { status: 400 });
      runtime.runFork(startSession(username || "replay", replay));
      return json({ ok: true });
    }
    if (url.pathname === "/api/disconnect" && req.method === "POST") { await runtime.runPromise(stopSession); return json({ ok: true }); }
    if (url.pathname === "/api/rules" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { text?: string; sources?: Source[] };
      if (!body.text?.trim()) return json({ ok: false, error: "text required" }, { status: 400 });
      const sources = (body.sources ?? [...ALL_SOURCES]).filter((x): x is Source => ALL_SOURCES.includes(x));
      if (sources.length === 0) return json({ ok: false, error: "pick at least one source" }, { status: 400 });
      return json(await runtime.runPromise(addRule(body.text.trim(), sources)));
    }
    const rm = url.pathname.match(/^\/api\/rules\/([^/]+)$/);
    if (rm && req.method === "DELETE") { await runtime.runPromise(removeRule(rm[1])); return json({ ok: true }); }
    if (url.pathname === "/api/feedback" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as FeedbackRequest | null;
      if (!body?.questionId) return json({ ok: false, error: "bad body" }, { status: 400 });
      return json(await runtime.runPromise(feedback(body)));
    }
    const hm = url.pathname.match(/^\/api\/highlights\/([^/]+)$/);
    if (hm && req.method === "PATCH") {
      const body = (await req.json().catch(() => ({}))) as { pinned?: boolean; resolved?: boolean };
      const h = await runtime.runPromise(Effect.gen(function* () {
        const store = yield* Store; const bus = yield* Bus;
        const h = yield* store.updateHighlight(hm[1], body);
        if (h) yield* bus.publish({ type: "highlight", highlight: h, fresh: false });
        return h;
      }));
      return h ? json({ ok: true, highlight: h }) : json({ ok: false, error: "not found" }, { status: 404 });
    }
    if (hm && req.method === "DELETE") {
      await runtime.runPromise(Effect.gen(function* () { const store = yield* Store; const bus = yield* Bus; yield* store.removeHighlight(hm[1]); yield* bus.publish({ type: "highlightRemoved", id: hm[1] }); }));
      return json({ ok: true });
    }
    if (url.pathname === "/api/highlights/clear" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { mode?: "resolved" | "all" };
      const remaining = await runtime.runPromise(Effect.gen(function* () {
        const store = yield* Store; const bus = yield* Bus;
        const before = yield* store.highlights;
        yield* store.clearHighlights(body.mode ?? "resolved");
        const after = yield* store.highlights;
        const kept = new Set(after.map((h) => h.id));
        for (const h of before) if (!kept.has(h.id)) yield* bus.publish({ type: "highlightRemoved", id: h.id });
        return after.length;
      }));
      return json({ ok: true, remaining });
    }
    if (url.pathname === "/api/settings" && req.method === "GET") return json(await runtime.runPromise(Effect.flatMap(SettingsStore, (s) => s.public)));
    if (url.pathname === "/api/settings" && (req.method === "PUT" || req.method === "PATCH")) {
      const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body) return json({ ok: false, error: "bad body" }, { status: 400 });
      const pub = await runtime.runPromise(Effect.gen(function* () {
        const s = yield* SettingsStore; const bus = yield* Bus;
        const next = yield* s.update(body);
        yield* bus.publish({ type: "settings", settings: next });
        yield* bus.log({ actor: "system", kind: "settings", detail: `updated ${Object.entries(body).map(([k, v]) => `${k}.${Object.keys(v as object).join(",")}`).join(" ")}`, ok: true });
        return next;
      }));
      return json({ ok: true, settings: pub });
    }
    if (url.pathname === "/api/settings/reset" && req.method === "POST") {
      const pub = await runtime.runPromise(Effect.gen(function* () {
        const s = yield* SettingsStore; const bus = yield* Bus;
        const next = yield* s.reset;
        yield* bus.publish({ type: "settings", settings: next });
        yield* bus.log({ actor: "system", kind: "settings", detail: "reset to .env defaults", ok: true });
        return next;
      }));
      return json({ ok: true, settings: pub });
    }
    if (url.pathname === "/api/settings/test" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { which?: "openrouter" | "deepgram"; value?: string };
      const st = await runtime.runPromise(Effect.flatMap(SettingsStore, (s) => s.get));
      const t0 = performance.now();
      try {
        if (body.which === "openrouter") {
          const key = body.value && !body.value.startsWith("••") ? body.value : st.keys.openrouter;
          const r = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}` } });
          const j: any = await r.json().catch(() => ({}));
          return json({ ok: r.ok, ms: Math.round(performance.now() - t0), detail: r.ok ? `label "${j.data?.label ?? "key"}" · usage $${Number(j.data?.usage ?? 0).toFixed(2)}${j.data?.limit ? ` / $${j.data.limit}` : ""}` : `HTTP ${r.status}` });
        }
        if (body.which === "deepgram") {
          const key = body.value && !body.value.startsWith("••") ? body.value : st.keys.deepgram;
          const r = await fetch("https://api.deepgram.com/v1/auth/token", { headers: { Authorization: `Token ${key}` } });
          return json({ ok: r.ok, ms: Math.round(performance.now() - t0), detail: r.ok ? "key accepted" : `HTTP ${r.status}` });
        }
        if (body.which === "models") {
          const r = await fetch("https://openrouter.ai/api/v1/models");
          const j: any = await r.json();
          const ids: string[] = j.data.map((m: any) => m.id);
          const has = (id: string) => ids.includes(id);
          // jev lives behind the decisions API, not the chat model list: probe it with one tiny question.
          const jevOk = await fetch("https://openrouter.ai/api/alpha/decisions", { method: "POST", headers: { Authorization: `Bearer ${st.keys.openrouter}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: st.models.jev, state: "ping", questions: { ok: { type: "noul", instructions: "Is this a ping?" } } }) }).then((r) => r.ok).catch(() => false);
          return json({ ok: jevOk && has(st.models.glm) && has(st.models.vision), ms: Math.round(performance.now() - t0), detail: `jev ${jevOk ? "✓" : "✗"} · glm ${has(st.models.glm) ? "✓" : "✗"} · vision ${has(st.models.vision) ? "✓" : "✗"}`, models: { glm: ids.filter((i) => /^z-ai\//.test(i)), vision: j.data.filter((m: any) => (m.architecture?.input_modalities ?? []).includes("image")).map((m: any) => m.id).slice(0, 80), jev: ids.filter((i) => /^typesafe\//.test(i)) } });
        }
        return json({ ok: false, error: "unknown test" }, { status: 400 });
      } catch (e) { return json({ ok: false, detail: String((e as Error).message) }); }
    }
    if (url.pathname === "/api/record/start" && req.method === "POST") return json(await runtime.runPromise(startRecording));
    if (url.pathname === "/api/record/stop" && req.method === "POST") return json(await runtime.runPromise(stopRecording("stopped by user")));
    if (url.pathname === "/api/recordings") return json(await runtime.runPromise(listRecordings));
    const rec = url.pathname.match(/^\/api\/recordings\/([^/]+)(?:\/(peek))?$/);
    if (rec && req.method === "GET" && rec[2] === "peek") return json(await runtime.runPromise(peekRecording(rec[1])));
    if (rec && req.method === "DELETE") {
      if (session && (path.basename(session.base) === rec[1] || session.replayOf === rec[1])) return json({ ok: false, error: session.replayOf === rec[1] ? "this recording is being replayed; disconnect first" : "this recording is the current session" }, { status: 409 });
      return json({ ok: await runtime.runPromise(deleteRecording(rec[1])) });
    }
    if (url.pathname.startsWith("/recordings/") && req.method === "GET") {
      const f = Bun.file(path.join("recordings", path.basename(url.pathname)));
      if (!(await f.exists())) return new Response("not found", { status: 404 });
      const size = f.size;
      const range = req.headers.get("range");
      const type = url.pathname.endsWith(".mp4") ? "video/mp4" : "application/octet-stream";
      if (range) {
        const m = range.match(/bytes=(\d*)-(\d*)/);
        const start = m && m[1] ? Number(m[1]) : 0;
        const end = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
        return new Response(f.slice(start, end + 1), { status: 206, headers: { "Content-Type": type, "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes", "Content-Length": String(end - start + 1) } });
      }
      return new Response(f, { headers: { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": String(size) } });
    }
    // Production: serve the built UI.
    const dist = path.resolve("dist", url.pathname === "/" ? "index.html" : url.pathname.slice(1));
    const f = Bun.file(dist);
    if (await f.exists()) return new Response(f);
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      ws.subscribe("ui");
      void runtime.runPromise(hello).then((m) => ws.send(JSON.stringify(m)));
    },
    message() {},
    close(ws) { ws.unsubscribe("ui"); },
  },
});

// Broadcast every bus message to all UI sockets.
runtime.runFork(
  Effect.gen(function* () {
    const bus = yield* Bus;
    yield* bus.stream.pipe(Stream.runForEach((m) => Effect.sync(() => server.publish("ui", JSON.stringify(m)))));
  }),
);

console.log(`awesome-jev server on http://localhost:${server.port}  (jev=${cfg.jevModel}, glm=${cfg.glmModel}, vision=${cfg.visionModel})`);
if (cfg.replay) runtime.runFork(startSession("replay", cfg.replay));
else if (cfg.tiktokUsername) runtime.runFork(startSession(cfg.tiktokUsername, ""));
