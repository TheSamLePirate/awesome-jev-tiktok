import { Effect, Layer, ManagedRuntime, Ref, Scope, Exit, Stream, Fiber } from "effect";
import path from "node:path";
import { AppConfig } from "./config";
import { Bus } from "./bus";
import { Window } from "./window";
import { Store } from "./store";
import { Jev } from "./jev";
import { Glm } from "./glm";
import { connectTikTok } from "./tiktok";
import { runMedia, HLS_DIR } from "./media";
import { runLoops } from "./loop";
import { recorder, replayEvents } from "./replay";
import { ALL_SOURCES, type FeedbackRequest, type LiveEvent, type Rule, type ServerMessage, type Source, type StreamStatusEvent } from "../shared/protocol";

const MainLayer = Layer.mergeAll(Bus.Default, Window.Default, Store.Default, Jev.Default, Glm.Default);
const runtime = ManagedRuntime.make(MainLayer);
const cfg = await runtime.runPromise(AppConfig);

// ---------------- session lifecycle ----------------
const status = await runtime.runPromise(Ref.make<StreamStatusEvent>({ kind: "stream", ts: Date.now(), state: "offline", username: cfg.tiktokUsername }));
const hlsUrl = await runtime.runPromise(Ref.make<string | null>(null));
let session: { scope: Scope.CloseableScope; username: string } | null = null;

const setStatus = (s: Partial<StreamStatusEvent>) =>
  Effect.gen(function* () {
    const bus = yield* Bus;
    const next = yield* Ref.updateAndGet(status, (cur) => ({ ...cur, ...s, ts: Date.now() }));
    yield* bus.event(next);
  });

const stopSession = Effect.gen(function* () {
  if (!session) return;
  const s = session;
  session = null;
  yield* Scope.close(s.scope, Exit.void);
  yield* Ref.set(hlsUrl, null);
  yield* setStatus({ state: "offline" });
});

/** Connect to a live (or a replay file), start ffmpeg + Deepgram + vision, and the jev loops. */
const startSession = (username: string, replayFile: string) =>
  Effect.gen(function* () {
    if (session) yield* stopSession;
    const scope = yield* Scope.make();
    session = { scope, username };
    const bus = yield* Bus;
    const win = yield* Window;

    const boot = Effect.gen(function* () {
      yield* setStatus({ state: "connecting", username, detail: replayFile ? `replaying ${replayFile}` : undefined });
      let events: Stream.Stream<LiveEvent, Error>;
      if (replayFile) {
        events = replayEvents(replayFile);
        yield* setStatus({ state: "live", title: "replay" });
      } else {
        const tt = yield* connectTikTok(username, cfg.tiktokSessionId);
        events = tt.events;
        yield* setStatus({ state: "live", title: tt.title });
        if (tt.flvUrl) {
          yield* runMedia(tt.flvUrl).pipe(Effect.catchAll((e) => Effect.logWarning(`media: ${String(e)}`)));
          yield* Ref.set(hlsUrl, "/hls/live.m3u8");
        } else {
          yield* Effect.logWarning("no FLV url in room info; running chat-only");
        }
      }
      const record = yield* recorder(path.join("recordings", `${username}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`));
      // Fan every source event into the window, the UI, and the recorder.
      yield* events.pipe(
        Stream.tap((e) => Effect.all([win.ingest(e), bus.event(e), replayFile ? Effect.void : record(e)])),
        Stream.runDrain,
        Effect.tapError((e) => setStatus({ state: "error", detail: e.message })),
        Effect.andThen(setStatus({ state: "offline" })),
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
      Effect.tapError((e) => setStatus({ state: "error", detail: (e as Error).message ?? String(e) })),
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
      return { ok: false as const, error: r.left.message };
    }
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
      return { ok: false as const, error: r.left.message };
    }
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
    glm: yield* bus.recentGlm,
    hlsUrl: yield* Ref.get(hlsUrl),
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
      const username = (body.username ?? cfg.tiktokUsername).replace(/^@/, "").trim();
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
    if (url.pathname === "/api/recordings") {
      const glob = new Bun.Glob("*.jsonl");
      const files = [...glob.scanSync({ cwd: "recordings" })].sort().reverse();
      return json(files.map((f) => path.join("recordings", f)));
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
