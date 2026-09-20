import { Effect, ManagedRuntime, Schema } from "effect";
import path from "node:path";
import type { AppConfig } from "./config";
import { Bus } from "./bus";
import { Store, UNDO_MS } from "./store";
import { Glm } from "./glm";
import { Gate } from "./gate";
import { SettingsStore, SECTIONS } from "./settings";
import { Session } from "./session";
import { hlsDir } from "./media";
import { listRecordings, peekRecording, deleteRecording, searchEvents, momentContext, sessionTimeline, isSafeId, recordingExists, recordingsDir } from "./replay";
import { ALL_SOURCES, PROTOCOL_VERSION, type FeedbackRequest, type Rule, type ServerMessage, type Source } from "../shared/protocol";

// ---------------- request schemas ----------------
const SourceS = Schema.Literal("transcript", "video", "chat");
const ConnectBody = Schema.Struct({ username: Schema.optional(Schema.String), replay: Schema.optional(Schema.String), offsetMs: Schema.optional(Schema.Number), simulate: Schema.optional(Schema.Boolean) });
const SeekBody = Schema.Struct({ offsetMs: Schema.Number });
const RuleBody = Schema.Struct({ text: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2000)), sources: Schema.optional(Schema.Array(SourceS)), kind: Schema.optional(Schema.Literal("jev", "keyword")), pattern: Schema.optional(Schema.String.pipe(Schema.maxLength(500))), flags: Schema.optional(Schema.String.pipe(Schema.pattern(/^[gimsuy]{0,6}$/))), label: Schema.optional(Schema.String.pipe(Schema.maxLength(40))), scope: Schema.optional(Schema.Literal("window", "message")) });
const RulePatch = Schema.Struct({ paused: Schema.optional(Schema.Boolean) });
const JevAnswerS = Schema.Union(
  Schema.Struct({ type: Schema.Literal("noul"), noul: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("choice"), choice: Schema.String, probabilities: Schema.Record({ key: Schema.String, value: Schema.Number }), confidence: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("score"), score: Schema.Number, legend: Schema.Record({ key: Schema.String, value: Schema.String }), probabilities: Schema.Record({ key: Schema.String, value: Schema.Number }), confidence: Schema.Number }),
);
const FeedbackBody = Schema.Struct({ questionId: Schema.String, verdict: Schema.optionalWith(Schema.Literal("wrong", "missed", "correct"), { default: () => "wrong" as const }), answer: JevAnswerS, stateExcerpt: Schema.Unknown, expected: Schema.optional(Schema.String.pipe(Schema.maxLength(2000))), note: Schema.optional(Schema.String.pipe(Schema.maxLength(2000))), highlightId: Schema.optional(Schema.String), rewrite: Schema.optionalWith(Schema.Boolean, { default: () => true }) });
const HighlightPatch = Schema.Struct({ pinned: Schema.optional(Schema.Boolean), resolved: Schema.optional(Schema.Boolean) });
const ClearBody = Schema.Struct({ mode: Schema.optionalWith(Schema.Literal("resolved", "all"), { default: () => "resolved" as const }) });
/** Any subset of sections; unknown sections and keys are ignored by `applyPatch`. */
const SettingsBody = Schema.Record({ key: Schema.String, value: Schema.Record({ key: Schema.String, value: Schema.Unknown }) }).pipe(Schema.filter((o) => Object.keys(o).every((k) => (SECTIONS as readonly string[]).includes(k)) || "unknown settings section"));
const TestBody = Schema.Struct({ which: Schema.Literal("openrouter", "deepgram", "models"), value: Schema.optional(Schema.String) });

const json = (data: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(data), { ...init, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...(init.headers ?? {}) } });
const fail = (error: string, status = 400, code?: string) => json({ ok: false, error, code }, { status });

class BadRequest extends Error { constructor(message: string, readonly status = 400) { super(message); } }
const decodeBody = async <A, I>(req: Request, schema: Schema.Schema<A, I>): Promise<A> => {
  const raw = await req.json().catch(() => { throw new BadRequest("body is not valid JSON"); });
  const r = Schema.decodeUnknownEither(schema)(raw);
  if (r._tag === "Left") throw new BadRequest(`invalid body: ${r.left.message.split("\n")[0].slice(0, 200)}`);
  return r.right;
};

/** RFC 7233 single-range parsing: "bytes=a-b", "bytes=a-", "bytes=-n". Null = not a range we serve (416 or full body). */
export const parseRange = (header: string | null, size: number): { start: number; end: number } | "invalid" | null => {
  if (!header) return null;
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return "invalid";
  if (m[1] === "" && m[2] === "") return "invalid";
  if (m[1] === "") { const n = Math.min(size, Number(m[2])); return n === 0 ? "invalid" : { start: size - n, end: size - 1 }; }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(size - 1, Number(m[2]));
  if (start >= size || start > end) return "invalid";
  return { start, end };
};

type Services = Bus | Store | Glm | Gate | SettingsStore | Session;
export interface HttpDeps { runtime: ManagedRuntime.ManagedRuntime<Services, any>; cfg: AppConfig }

export const makeServer = ({ runtime, cfg }: HttpDeps) => {
  const run = <A, E>(e: Effect.Effect<A, E, Services>) => runtime.runPromise(e);

  // ---------------- composed operations ----------------
  const hello = Effect.gen(function* () {
    const bus = yield* Bus;
    const store = yield* Store;
    const session = yield* Session;
    const snap = yield* bus.snapshot;
    const msg: ServerMessage = {
      type: "hello", seq: snap.seq, protocol: PROTOCOL_VERSION,
      status: yield* session.status,
      questions: yield* store.current, history: yield* store.history, rules: yield* store.rules,
      recent: snap.events, decisions: snap.decisions, messageDecisions: snap.msgDecisions, glm: snap.glm, log: snap.log,
      highlights: yield* store.highlights,
      settings: yield* (yield* SettingsStore).public,
      video: yield* session.video, recording: yield* session.recording, replay: yield* session.replayInfo,
      totals: snap.totals, health: snap.health, summary: yield* session.summary, sessionId: snap.sessionId,
    };
    return msg;
  });

  const publishQuestions = Effect.gen(function* () {
    const store = yield* Store; const bus = yield* Bus;
    yield* bus.publish({ type: "questions", set: yield* store.current, history: yield* store.history, rules: yield* store.rules });
  });

  const addRule = (body: Schema.Schema.Type<typeof RuleBody>) =>
    Effect.gen(function* () {
      const store = yield* Store;
      const glm = yield* Glm;
      const bus = yield* Bus;
      const sources = (body.sources ?? [...ALL_SOURCES]).filter((x): x is Source => ALL_SOURCES.includes(x));
      if (sources.length === 0) return { ok: false as const, error: "pick at least one source" };
      const rule: Rule = { id: `r-${crypto.randomUUID().slice(0, 8)}`, text: body.text.trim(), sources, createdAt: Date.now(), kind: body.kind ?? "jev" };
      if (rule.kind === "keyword") {
        // Local rule: no GLM, no jev. The pattern is validated here; a bad regex never reaches the loop.
        const pattern = (body.pattern ?? "").trim();
        if (!pattern) return { ok: false as const, error: "pattern required" };
        try { new RegExp(pattern, body.flags ?? "i"); } catch (e) { return { ok: false as const, error: `invalid pattern: ${(e as Error).message}` }; }
        const scope = body.scope ?? (sources.includes("chat") ? "message" : "window");
        const qid = `kw_${rule.id.slice(2)}`;
        const q = { id: qid, label: (body.label ?? rule.text).slice(0, 24), ruleId: rule.id, scope, sources, question: { type: "noul" as const, instructions: `Local pattern /${pattern}/${body.flags ?? "i"}` }, alert: { noulAbove: 0.5 }, local: { pattern, flags: body.flags ?? "i" } };
        yield* store.addRule(rule);
        yield* store.append(`keyword rule added: ${rule.text}`, [q]);
        yield* bus.log({ actor: "system", kind: "rule", detail: `keyword rule /${pattern}/ → ${qid}`, ok: true });
        yield* publishQuestions;
        return { ok: true as const, rule, questions: [q] };
      }
      yield* store.addRule(rule);
      const id = crypto.randomUUID();
      yield* bus.publish({ type: "glm", activity: { id, ts: Date.now(), kind: "compile", status: "running", summary: `compiling rule: ${rule.text}` } });
      const set = yield* store.current;
      const r = yield* glm.compileRule(rule, set.questions).pipe(Effect.either);
      if (r._tag === "Left") {
        yield* store.removeRule(rule.id);
        yield* bus.publish({ type: "glm", activity: { id, ts: Date.now(), kind: "compile", status: "error", summary: r.left.message } });
        yield* bus.log({ actor: "glm", kind: "compile", detail: `${rule.text.slice(0, 80)} → ${r.left.message}`, ok: false });
        yield* publishQuestions;
        return { ok: false as const, error: r.left.message };
      }
      yield* bus.log({ actor: "glm", kind: "compile", detail: `${rule.text.slice(0, 80)} → ${r.right.questions.map((q) => q.id).join(", ")}`, ok: true, latencyMs: r.right.latencyMs, inputTokens: r.right.usage.inputTokens, outputTokens: r.right.usage.outputTokens, cost: r.right.usage.cost, costKind: r.right.usage.costConfirmed ? "confirmed" : "unknown" });
      yield* store.append(`rule added: ${rule.text}`, r.right.questions);
      yield* bus.publish({ type: "glm", activity: { id, ts: Date.now(), kind: "compile", status: "done", summary: `wrote ${r.right.questions.map((q) => `${q.id} (${q.question.type}, ${q.scope})`).join(", ")}`, tokens: r.right.tokens } });
      yield* publishQuestions;
      return { ok: true as const, rule, questions: r.right.questions };
    });

  const feedback = (fb: FeedbackRequest) =>
    Effect.gen(function* () {
      const store = yield* Store;
      const glm = yield* Glm;
      const bus = yield* Bus;
      const set = yield* store.current;
      const q = set.questions.find((x) => x.id === fb.questionId);
      if (!q) return { ok: false as const, error: "unknown question" };
      yield* bus.log({ actor: "system", kind: "feedback", detail: `${q.label}: ${fb.verdict}${fb.expected ? ` · expected "${fb.expected.slice(0, 60)}"` : ""}${fb.note ? ` · ${fb.note.slice(0, 80)}` : ""}`, ok: true });
      if (fb.verdict === "correct" || fb.rewrite === false || q.local) return { ok: true as const, rewritten: false };
      const rules = yield* store.rules;
      const id = crypto.randomUUID();
      yield* bus.publish({ type: "glm", activity: { id, ts: Date.now(), kind: "refine", status: "running", summary: `you said "${q.label}" was ${fb.verdict}${fb.note ? `: ${fb.note}` : ""}; GLM is rewriting it` } });
      const r = yield* glm.refine(q, rules.find((r) => r.id === q.ruleId), { feedback: [fb] }).pipe(Effect.either);
      if (r._tag === "Left") {
        yield* bus.publish({ type: "glm", activity: { id, ts: Date.now(), kind: "refine", status: "error", summary: r.left.message } });
        yield* bus.log({ actor: "glm", kind: "refine", detail: `${q.label}: ${r.left.message}`, ok: false });
        return { ok: false as const, error: r.left.message };
      }
      yield* bus.log({ actor: "glm", kind: "refine", detail: `${q.label}: ${r.right.rationale}`, ok: true, latencyMs: r.right.latencyMs, inputTokens: r.right.usage.inputTokens, outputTokens: r.right.usage.outputTokens, cost: r.right.usage.cost, costKind: r.right.usage.costConfirmed ? "confirmed" : "unknown" });
      const applied = yield* store.replace(`refined "${q.label}" after feedback: ${r.right.rationale}`, r.right.question, set.version).pipe(Effect.either);
      if (applied._tag === "Left") {
        yield* bus.publish({ type: "glm", activity: { id, ts: Date.now(), kind: "refine", status: "error", summary: `not applied: ${applied.left.message}` } });
        return { ok: false as const, error: applied.left.message };
      }
      yield* bus.publish({ type: "glm", activity: { id, ts: Date.now(), kind: "refine", status: "done", summary: r.right.rationale, tokens: r.right.tokens } });
      yield* publishQuestions;
      return { ok: true as const, rewritten: true, question: r.right.question };
    });

  // ---------------- auth ----------------
  const authorized = (req: Request, url: URL) => {
    if (!cfg.token) return true;
    const h = req.headers.get("authorization");
    if (h && h.toLowerCase().startsWith("bearer ") && h.slice(7).trim() === cfg.token) return true;
    return url.searchParams.get("token") === cfg.token;
  };

  const handle = async (req: Request, srv: Bun.Server<{ id: string }>): Promise<Response | undefined> => {
    const url = new URL(req.url);
    const p = url.pathname;
    const protectedPath = p === "/ws" || p.startsWith("/api/") || p.startsWith("/hls/") || p.startsWith("/recordings/");
    if (protectedPath && !authorized(req, url)) return fail("unauthorized", 401, "auth");

    if (p === "/ws") return srv.upgrade(req, { data: { id: crypto.randomUUID() } }) ? undefined : new Response("upgrade failed", { status: 400 });

    if (p.startsWith("/hls/")) {
      const name = path.basename(p);
      if (!/^[\w.-]+\.(m3u8|ts)$/.test(name)) return new Response("not found", { status: 404 });
      const f = Bun.file(path.join(hlsDir(), name));
      if (!(await f.exists())) return new Response("not found", { status: 404 });
      const isPlaylist = name.endsWith(".m3u8");
      // Segments never change once written: cache them; the playlist must not be cached.
      return new Response(f, { headers: { "Cache-Control": isPlaylist ? "no-store" : "public, max-age=3600, immutable", "Content-Type": isPlaylist ? "application/vnd.apple.mpegurl" : "video/mp2t" } });
    }

    if (p.startsWith("/recordings/") && req.method === "GET") {
      const name = path.basename(p);
      if (!isSafeId(name.replace(/\.(mp4|jsonl)$/, "")) || !/\.(mp4|jsonl)$/.test(name)) return new Response("not found", { status: 404 });
      const f = Bun.file(path.join(recordingsDir(), name));
      if (!(await f.exists())) return new Response("not found", { status: 404 });
      const size = f.size;
      const type = name.endsWith(".mp4") ? "video/mp4" : "application/x-ndjson";
      const range = parseRange(req.headers.get("range"), size);
      if (range === "invalid") return new Response("range not satisfiable", { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      if (range) return new Response(f.slice(range.start, range.end + 1), { status: 206, headers: { "Content-Type": type, "Content-Range": `bytes ${range.start}-${range.end}/${size}`, "Accept-Ranges": "bytes", "Content-Length": String(range.end - range.start + 1) } });
      return new Response(f, { headers: { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": String(size) } });
    }

    if (p.startsWith("/api/")) return api(req, url, p);

    // Production: serve the built UI (index.html for unknown routes so /?view=director works).
    const rel = p === "/" ? "index.html" : p.slice(1);
    const dist = path.resolve("dist", rel);
    if (!dist.startsWith(path.resolve("dist"))) return new Response("not found", { status: 404 });
    const f = Bun.file(dist);
    if (await f.exists()) return new Response(f, { headers: { "Cache-Control": rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache" } });
    const index = Bun.file(path.resolve("dist", "index.html"));
    if (await index.exists()) return new Response(index, { headers: { "Cache-Control": "no-cache" } });
    return new Response("not found (run `bun run build` or use the Vite dev server)", { status: 404 });
  };

  const api = async (req: Request, url: URL, p: string): Promise<Response> => {
    const m = req.method;
    if (p === "/api/state") return json(await run(hello));
    if (p === "/api/health") {
      const [health, status, totals] = await run(Effect.all([Effect.flatMap(Bus, (b) => b.health), Effect.flatMap(Session, (s) => s.status), Effect.flatMap(Bus, (b) => b.totals)]));
      return json({ ok: true, health, status, totals, uptimeSec: Math.round(process.uptime()) });
    }
    if (p === "/api/connect" && m === "POST") {
      const body = await decodeBody(req, ConnectBody);
      const replayId = body.replay ? path.basename(body.replay).replace(/\.jsonl$/, "") : undefined;
      if (replayId !== undefined && !isSafeId(replayId)) return fail("invalid recording id");
      if (replayId === undefined && !(body.username ?? "").trim() && !(await run(Effect.flatMap(SettingsStore, (s) => s.get))).tiktok.username) return fail("username required");
      const r = await run(Effect.flatMap(Session, (s) => s.start({ username: body.username, replayId, offsetMs: Math.max(0, body.offsetMs ?? 0), simulate: !!body.simulate && !!replayId })));
      return r.ok ? json(r) : json(r, { status: 409 });
    }
    if (p === "/api/disconnect" && m === "POST") return json(await run(Effect.flatMap(Session, (s) => s.stop())));
    if (p === "/api/replay/seek" && m === "POST") {
      const body = await decodeBody(req, SeekBody);
      const r = await run(Effect.flatMap(Session, (s) => s.seek(body.offsetMs)));
      return r.ok ? json(r) : json(r, { status: 409 });
    }
    // The event index of the current session: the live recording being written, or the recording being replayed.
    if (p === "/api/search") {
      const ev = await run(Effect.flatMap(Session, (s) => s.sessionEvents));
      if (!ev) return fail("no session", 409);
      const kinds = (url.searchParams.get("kinds") ?? "chat,transcript").split(",").filter((k): k is "chat" | "transcript" => k === "chat" || k === "transcript");
      return json(searchEvents(ev, (url.searchParams.get("q") ?? "").slice(0, 200), kinds));
    }
    if (p === "/api/context") {
      const ev = await run(Effect.flatMap(Session, (s) => s.sessionEvents));
      if (!ev) return fail("no session", 409);
      return json(momentContext(ev, Number(url.searchParams.get("ts")) || Date.now(), Math.min(300_000, Number(url.searchParams.get("span")) || 30_000)));
    }
    if (p === "/api/timeline") {
      const [ev, cur, st] = await run(Effect.all([Effect.flatMap(Session, (s) => s.sessionEvents), Effect.flatMap(Session, (s) => s.current), Effect.flatMap(SettingsStore, (s) => s.get)]));
      if (!ev || !cur || cur.mode === "replay") return json(null);
      const segs = cur.videos.map((v) => ({ url: `/recordings/${v.file}`, startTs: v.startTs, endTs: v.endTs ?? Date.now() }));
      return json(sessionTimeline(ev, segs, Date.now() - st.media.dvrMinutes * 60_000));
    }
    if (p === "/api/rules" && m === "POST") {
      const body = await decodeBody(req, RuleBody);
      const r = await run(addRule(body));
      return r.ok ? json(r) : json(r, { status: 422 });
    }
    const rm = p.match(/^\/api\/rules\/([\w-]+)(?:\/(restore))?$/);
    if (rm && m === "DELETE") {
      const r = await run(Effect.gen(function* () { const store = yield* Store; const res = yield* store.removeRule(rm[1]); if (res) yield* publishQuestions; return res; }));
      return r ? json({ ok: true, undoMs: UNDO_MS }) : fail("not found", 404);
    }
    if (rm && rm[2] === "restore" && m === "POST") {
      const r = await run(Effect.gen(function* () { const store = yield* Store; const res = yield* store.restoreRule(rm[1]); if (res) yield* publishQuestions; return res; }));
      return r ? json({ ok: true, rule: r.rule }) : fail("nothing to restore (undo window passed)", 404);
    }
    if (rm && m === "PATCH") {
      const body = await decodeBody(req, RulePatch);
      if (body.paused === undefined) return fail("nothing to change");
      await run(Effect.gen(function* () { const store = yield* Store; yield* store.setRulePaused(rm[1], body.paused!); yield* publishQuestions; yield* (yield* Bus).log({ actor: "system", kind: "rule", detail: `rule ${rm[1]} ${body.paused ? "paused" : "resumed"}`, ok: true }); }));
      return json({ ok: true });
    }
    const vm = p.match(/^\/api\/versions\/(\d+)\/restore$/);
    if (vm && m === "POST") {
      const r = await run(Effect.gen(function* () { const store = yield* Store; const res = yield* store.restoreVersion(Number(vm[1])); if (res) { yield* publishQuestions; yield* (yield* Bus).log({ actor: "system", kind: "rule", detail: `restored question set v${vm[1]} as v${res.version}`, ok: true }); } return res; }));
      return r ? json({ ok: true, set: r }) : fail("version not found", 404);
    }
    if (p === "/api/feedback" && m === "POST") {
      const body = await decodeBody(req, FeedbackBody);
      const r = await run(feedback(body as FeedbackRequest));
      return r.ok ? json(r) : json(r, { status: 422 });
    }
    const hm = p.match(/^\/api\/highlights\/([\w-]+)(?:\/(restore))?$/);
    if (hm && hm[2] === "restore" && m === "POST") {
      const h = await run(Effect.gen(function* () { const store = yield* Store; const bus = yield* Bus; const r = yield* store.restoreHighlight(hm[1]); if (r._tag === "Some") yield* bus.publish({ type: "highlight", highlight: r.value, fresh: false }); return r; }));
      return h._tag === "Some" ? json({ ok: true, highlight: h.value }) : fail("nothing to restore (undo window passed)", 404);
    }
    if (hm && m === "PATCH") {
      const body = await decodeBody(req, HighlightPatch);
      const h = await run(Effect.gen(function* () {
        const store = yield* Store; const bus = yield* Bus;
        const h = yield* store.updateHighlight(hm[1], body);
        if (h) yield* bus.publish({ type: "highlight", highlight: h, fresh: false });
        return h;
      }));
      return h ? json({ ok: true, highlight: h }) : fail("not found", 404);
    }
    if (hm && m === "DELETE") {
      const ok = await run(Effect.gen(function* () { const store = yield* Store; const bus = yield* Bus; const ok = yield* store.removeHighlight(hm[1]); if (ok) yield* bus.publish({ type: "highlightRemoved", id: hm[1], undoMs: UNDO_MS }); return ok; }));
      return ok ? json({ ok: true, undoMs: UNDO_MS }) : fail("not found", 404);
    }
    if (p === "/api/highlights/clear" && m === "POST") {
      const body = await decodeBody(req, ClearBody);
      const removed = await run(Effect.gen(function* () {
        const store = yield* Store; const bus = yield* Bus;
        const removed = yield* store.clearHighlights(body.mode);
        for (const h of removed) yield* bus.publish({ type: "highlightRemoved", id: h.id, undoMs: UNDO_MS });
        return removed;
      }));
      return json({ ok: true, removed: removed.map((h) => h.id), undoMs: UNDO_MS });
    }
    if (p === "/api/settings" && m === "GET") return json(await run(Effect.flatMap(SettingsStore, (s) => s.public)));
    if (p === "/api/settings" && (m === "PUT" || m === "PATCH")) {
      const body = await decodeBody(req, SettingsBody);
      const pub = await run(Effect.gen(function* () {
        const s = yield* SettingsStore; const bus = yield* Bus; const gate = yield* Gate;
        const next = yield* s.update(body);
        yield* bus.publish({ type: "settings", settings: next });
        yield* bus.log({ actor: "system", kind: "settings", detail: `updated ${Object.entries(body).map(([k, v]) => `${k}.${Object.keys(v as object).join(",")}`).join(" ")}`, ok: true });
        if ((body as any).keys?.openrouter !== undefined || (body as any).budget !== undefined) yield* gate.reset;
        return next;
      }));
      return json({ ok: true, settings: pub });
    }
    if (p === "/api/settings/reset" && m === "POST") {
      const pub = await run(Effect.gen(function* () {
        const s = yield* SettingsStore; const bus = yield* Bus; const gate = yield* Gate;
        const next = yield* s.reset;
        yield* bus.publish({ type: "settings", settings: next });
        yield* bus.log({ actor: "system", kind: "settings", detail: "reset to .env defaults", ok: true });
        yield* gate.reset;
        return next;
      }));
      return json({ ok: true, settings: pub });
    }
    if (p === "/api/settings/test" && m === "POST") {
      const body = await decodeBody(req, TestBody);
      const st = await run(Effect.flatMap(SettingsStore, (s) => s.get));
      const t0 = performance.now();
      const ms = () => Math.round(performance.now() - t0);
      try {
        if (body.which === "openrouter") {
          const key = body.value && !body.value.startsWith("••") ? body.value : st.keys.openrouter;
          const r = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
          const j: any = await r.json().catch(() => ({}));
          return json({ ok: r.ok, ms: ms(), detail: r.ok ? `label "${j.data?.label ?? "key"}" · usage $${Number(j.data?.usage ?? 0).toFixed(2)}${j.data?.limit ? ` / $${j.data.limit}` : ""}` : `HTTP ${r.status}` });
        }
        if (body.which === "deepgram") {
          const key = body.value && !body.value.startsWith("••") ? body.value : st.keys.deepgram;
          const r = await fetch("https://api.deepgram.com/v1/auth/token", { headers: { Authorization: `Token ${key}` }, signal: AbortSignal.timeout(10_000) });
          return json({ ok: r.ok, ms: ms(), detail: r.ok ? "key accepted" : `HTTP ${r.status}` });
        }
        const r = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(15_000) });
        const j: any = await r.json();
        const ids: string[] = j.data.map((mm: any) => mm.id);
        const has = (id: string) => ids.includes(id);
        // jev lives behind the decisions API, not the chat model list: probe it with one tiny question.
        const jevOk = await fetch("https://openrouter.ai/api/alpha/decisions", { method: "POST", headers: { Authorization: `Bearer ${st.keys.openrouter}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: st.models.jev, state: "ping", questions: { ok: { type: "noul", instructions: "Is this a ping?" } } }), signal: AbortSignal.timeout(10_000) }).then((r) => r.ok).catch(() => false);
        return json({ ok: jevOk && has(st.models.glm) && has(st.models.vision), ms: ms(), detail: `jev ${jevOk ? "✓" : "✗"} · glm ${has(st.models.glm) ? "✓" : "✗"} · vision ${has(st.models.vision) ? "✓" : "✗"}`, models: { glm: ids.filter((i) => /^z-ai\//.test(i)), vision: j.data.filter((mm: any) => (mm.architecture?.input_modalities ?? []).includes("image")).map((mm: any) => mm.id).slice(0, 80), jev: ids.filter((i) => /^typesafe\//.test(i)) } });
      } catch (e) { return json({ ok: false, ms: ms(), detail: String((e as Error).message) }); }
    }
    if (p === "/api/record/start" && m === "POST") { const r = await run(Effect.flatMap(Session, (s) => s.startRecording)); return r.ok ? json(r) : json(r, { status: 409 }); }
    if (p === "/api/record/stop" && m === "POST") { const r = await run(Effect.flatMap(Session, (s) => s.stopRecording("stopped by user"))); return r.ok ? json(r) : json(r, { status: 409 }); }
    if (p === "/api/recordings" && m === "GET") return json(await run(listRecordings));
    const rec = p.match(/^\/api\/recordings\/([^/]+)(?:\/(peek))?$/);
    if (rec) {
      const id = decodeURIComponent(rec[1]);
      if (!isSafeId(id)) return fail("invalid recording id");
      if (m === "GET" && rec[2] === "peek") return (await run(recordingExists(id))) ? json(await run(peekRecording(id))) : fail("not found", 404);
      if (m === "DELETE") {
        const cur = await run(Effect.flatMap(Session, (s) => s.current));
        if (cur && (cur.id === id || cur.replayOf === id)) return fail(cur.replayOf === id ? "this recording is being replayed; disconnect first" : "this recording is the current session", 409);
        return json({ ok: await run(deleteRecording(id)) });
      }
    }
    return fail("not found", 404);
  };

  const server = Bun.serve<{ id: string }>({
    hostname: cfg.host,
    port: cfg.port,
    async fetch(req, srv) {
      try {
        const r = await handle(req, srv);
        return r;
      } catch (e) {
        if (e instanceof BadRequest) return fail(e.message, e.status);
        console.error("[http]", (e as Error)?.stack ?? e);
        return fail("internal error", 500, "internal");
      }
    },
    websocket: {
      open(ws) {
        ws.subscribe("ui");
        // The client buffers messages until `hello` and then applies only those newer than hello.seq.
        void runtime.runPromise(hello).then((msg) => ws.send(JSON.stringify(msg))).catch((e) => { console.error("[ws] hello failed", e); ws.close(1011, "hello failed"); });
      },
      message() {},
      close(ws) { ws.unsubscribe("ui"); },
    },
  });

  return server;
};
