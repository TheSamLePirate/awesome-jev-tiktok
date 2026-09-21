import { Duration, Effect, Ref, Stream } from "effect";
import { Bus } from "./bus";
import { Jev } from "./jev";
import { Store } from "./store";
import { Window } from "./window";
import { SettingsStore } from "./settings";
import type { AssistState, ChatEvent, GiftEvent, Highlight, JevAnswer, JevQuestion, PollState, RetentionTag, SessionSummary } from "../shared/protocol";
import type { JevApi } from "./jev";

/**
 * Built-in jev helpers that run beside the user's rules. Each one is a trigger (a flag, a gift, the host speaking,
 * a chat message during a poll) and one small typed question; the answers close prompts, fold duplicates, create
 * tasks or count votes. They share one budget (settings.assist.sessionUsd) and stay off in a dry run.
 */
/** What the session lets the helpers do to the pipeline (the safe repairs). */
export interface AssistOps { restartMedia: Effect.Effect<boolean>; disableTranscription: Effect.Effect<boolean> }
export interface AssistOptions { sessionId: string; mode: "live" | "replay" | "simulate"; dryRun: boolean; ops?: AssistOps; /** tests shorten these */ timing?: Partial<AssistTiming> }
export interface AssistTiming { /** wait after the host spoke before judging what changed */ speechDebounceMs: number; /** a thanks prompt nobody acted on goes away */ thanksTtlMs: number; /** a prompt older than this is not judged "answered" any more */ answerWindowMs: number; /** the app's own checks (regime, budget, health) */ opsIntervalMs: number; /** how often "can the host be interrupted" is judged */ interruptMs: number; /** rule hygiene */ hygieneMs: number; /** one applied repair per this long */ repairCooldownMs: number }
const DEFAULT_TIMING: AssistTiming = { speechDebounceMs: 12_000, thanksTtlMs: 4 * 60_000, answerWindowMs: 10 * 60_000, opsIntervalMs: 30_000, interruptMs: 10_000, hygieneMs: 10 * 60_000, repairCooldownMs: 5 * 60_000 };

// ---- pure helpers (tested directly) ----
/** "question => answer" or "question | answer", one per line; blank lines and lines without a separator are skipped. */
export const parseFaq = (text: string): { id: string; question: string; answer: string }[] =>
  text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const m = l.match(/^(.+?)\s*(?:=>|\|)\s*(.+)$/); return m ? { question: m[1].trim(), answer: m[2].trim() } : null; }).filter((x): x is { question: string; answer: string } => !!x && !!x.question && !!x.answer).slice(0, 40).map((e, i) => ({ id: `f${i + 1}`, ...e }));

/** "in 5 minutes", "dans 10 min", "in an hour" → a due time; null when the promise carries no delay. */
export const promiseDue = (text: string, now: number): number | null => {
  const t = text.toLowerCase();
  const m = t.match(/\b(?:in|dans|within|d'ici)\s+(\d{1,3})\s*(min|minute|minutes|mn|h|hour|hours|heure|heures|sec|s|seconds|secondes)\b/);
  if (m) { const n = Number(m[1]); const u = m[2]; return now + n * (u.startsWith("h") ? 3_600_000 : u.startsWith("s") ? 1000 : 60_000); }
  if (/\b(in|dans)\s+(an|one|une|un)\s+(hour|heure)\b/.test(t)) return now + 3_600_000;
  if (/\b(in|dans)\s+(a|one|une)\s+(minute)\b/.test(t)) return now + 60_000;
  return null;
};

/** Case-insensitive "the host said the viewer's name": the handle, the nickname, or their first word (≥ 3 letters). */
export const mentionsName = (speech: string, handle: string, nickname?: string): boolean => {
  const s = speech.toLowerCase();
  const names = [handle, nickname ?? ""].flatMap((n) => [n, n.split(/[\s._-]+/)[0]]).map((n) => n.toLowerCase().replace(/^@/, "")).filter((n) => n.length >= 3);
  return names.some((n) => s.includes(n));
};

const bucket = <T extends string>(n: number, edges: [number, T][], fallback: T): T => { for (const [max, label] of edges) if (n <= max) return label; return fallback; };
/** Facts about the pipeline that jev cannot see in the health record: repeats and floods without effect. */
export const anomalies = (f: { transcriptLines: string[]; captions: { ts: number; text: string }[]; chatVelocity: string; flagsLast5Min: number; now: number }) => {
  const last = f.transcriptLines.slice(-5);
  const transcriptRepeating = last.length >= 4 && new Set(last.map((l) => l.trim().toLowerCase())).size === 1;
  const c = f.captions;
  const captionsFrozen = c.length >= 2 && c.every((x) => x.text === c[0].text) && f.now - c[0].ts > 5 * 60_000;
  const floodWithoutFlags = f.chatVelocity === "flood" && f.flagsLast5Min === 0;
  return { transcriptRepeating, captionsFrozen, floodWithoutFlags };
};
/** Rank a finished session for the retention helper's state, from its summary and stats. */
export const retentionFacts = (s: SessionSummary) => {
  const minutes = Math.round((s.endedAt - s.startedAt) / 60_000);
  return { duration: bucket(minutes, [[3, "under_3_min"], [15, "short"], [60, "normal"]], "long"), chat: bucket(s.chatCount, [[0, "none"], [20, "few"], [200, "some"]], "many"), flags: bucket(s.highlights, [[0, "none"], [3, "few"]], "many"), peak_viewers: bucket(s.peakViewers, [[1, "none"], [10, "handful"], [100, "dozens"]], "hundreds_or_more"), ended: s.reason };
};

const noul = (instructions: string, criteria?: { true?: string; false?: string }): JevQuestion => ({ type: "noul", instructions, criteria });

export const runAssist = (opts: AssistOptions) => Effect.gen(function* () {
  const settings = yield* SettingsStore;
  const bus = yield* Bus;
  const store = yield* Store;
  const win = yield* Window;
  const jev = yield* Jev;
  const timing = { ...DEFAULT_TIMING, ...opts.timing };
  const spent = yield* Ref.make(0);
  const capHit = yield* Ref.make(false);

  /** One jev call under the assist budget; null when off, dry, capped or failed (the helpers then do nothing). */
  const ask = (feature: string, state: unknown, questions: Record<string, JevQuestion>): Effect.Effect<Record<string, JevAnswer> | null> =>
    Effect.gen(function* () {
      const st = yield* settings.get;
      if (opts.dryRun) return null;
      const cap = st.assist.sessionUsd;
      if (cap > 0 && (yield* Ref.get(spent)) >= cap) {
        if (!(yield* Ref.getAndSet(capHit, true))) yield* bus.log({ actor: "system", kind: "assist", detail: `assist budget of $${cap.toFixed(2)} reached; the helpers pause until the next session`, ok: false });
        return null;
      }
      const r = yield* jev.decide(state, questions).pipe(Effect.either);
      if (r._tag === "Left") { yield* bus.log({ actor: "jev", kind: "assist", detail: `${feature}: ${r.left.message}`, ok: false, questions: Object.keys(questions).length, costKind: r.left.kind === "timeout" ? "unknown" : undefined }); return null; }
      const total = yield* Ref.updateAndGet(spent, (x) => x + r.right.cost);
      yield* bus.setAssist({ spent: total });
      yield* bus.log({ actor: "jev", kind: "assist", detail: `${feature}: ${Object.entries(r.right.answers).map(([k, a]) => `${k}=${a.type === "noul" ? a.noul.toFixed(2) : a.type === "choice" ? a.choice : a.score}`).join(" ")}`, ok: true, latencyMs: r.right.latencyMs, inputTokens: r.right.inputTokens, outputTokens: r.right.outputTokens, cost: r.right.cost, costKind: r.right.costConfirmed ? "confirmed" : "unknown", questions: Object.keys(questions).length });
      return r.right.answers;
    });

  const publish = (h: Highlight, fresh: boolean) => bus.publish({ type: "highlight", highlight: h, fresh });
  const resolve = (id: string, by: NonNullable<Highlight["resolvedBy"]>, extra: Partial<Highlight> = {}) =>
    Effect.gen(function* () { const h = yield* store.updateHighlight(id, { resolved: true, resolvedBy: by, ...extra }); if (h) yield* publish(h, false); return h; });
  const openPrompts = Effect.map(store.highlights, (hs) => hs.filter((h) => h.sessionId === opts.sessionId && !h.resolved && h.severity !== "warn"));

  // ---- dedupe: a new chat flag against the open ones ----
  const dedupe = (h: Highlight) =>
    Effect.gen(function* () {
      const st = yield* settings.get;
      if (!st.assist.dedupe || !h.message) return false;
      const now = Date.now();
      const candidates = (yield* openPrompts).filter((o) => o.id !== h.id && o.message && !o.duplicateOf && now - o.ts < timing.answerWindowMs && o.message.handle !== h.message!.handle).slice(-8);
      if (!candidates.length) return false;
      const questions = Object.fromEntries(candidates.map((c) => [`same_as_${c.id.slice(0, 8)}`, noul(`Is new_message asking essentially the same thing as open_messages["${c.id.slice(0, 8)}"]? Same request, question or topic counts even with different words; a different question about the same live does not.`, { true: "both would be answered by the same reply from the host", false: "they need different replies" })]));
      const answers = yield* ask("dedupe", { new_message: { handle: h.message.handle, text: h.message.text }, open_messages: Object.fromEntries(candidates.map((c) => [c.id.slice(0, 8), { handle: c.message!.handle, text: c.message!.text }])) }, questions);
      if (!answers) return false;
      const best = candidates.map((c) => ({ c, p: answers[`same_as_${c.id.slice(0, 8)}`] })).filter((x) => x.p?.type === "noul" && x.p.noul >= 0.7).sort((a, b) => (b.p as { noul: number }).noul - (a.p as { noul: number }).noul)[0];
      if (!best) return false;
      const primary = best.c;
      const dup = { ids: [...(primary.duplicates?.ids ?? []), h.id], handles: [...new Set([...(primary.duplicates?.handles ?? []), h.message.handle])] };
      const p = yield* store.updateHighlight(primary.id, { duplicates: dup });
      if (p) yield* publish(p, false);
      yield* resolve(h.id, "duplicate", { duplicateOf: primary.id });
      yield* bus.log({ actor: "system", kind: "assist", detail: `@${h.message.handle} asks the same as @${primary.message!.handle} (×${dup.ids.length + 1})`, ok: true });
      return true;
    });

  // ---- FAQ: a prepared answer for a flagged question ----
  const faq = (h: Highlight) =>
    Effect.gen(function* () {
      const st = yield* settings.get;
      if (!st.assist.faq || !h.message) return;
      const entries = parseFaq(st.assist.faqText);
      if (!entries.length) return;
      const criteria: Record<string, string> = Object.fromEntries(entries.map((e) => [e.id, `the message is asking: "${e.question}"`]));
      criteria.none = "no prepared answer fits this message";
      const answers = yield* ask("faq", { message: { handle: h.message.handle, text: h.message.text }, prepared_questions: Object.fromEntries(entries.map((e) => [e.id, e.question])) }, { faq: { type: "choice", instructions: "Which prepared question does this chat message ask, if any? Pick none unless the prepared answer would really answer it.", criteria } });
      const a = answers?.faq;
      if (!a || a.type !== "choice" || a.choice === "none" || a.confidence < 0.5) return;
      const e = entries.find((x) => x.id === a.choice);
      if (!e) return;
      const u = yield* store.updateHighlight(h.id, { assist: { kind: "faq", question: e.question, answer: e.answer } });
      if (u) yield* publish(u, false);
    });

  // ---- thanks: a gift becomes a task, closed when the host says the name (free) or jev hears a thank-you ----
  const onGift = (g: GiftEvent) =>
    Effect.gen(function* () {
      const st = yield* settings.get;
      if (!st.assist.thanks) return;
      const open = (yield* openPrompts).find((h) => h.assist?.kind === "thanks" && h.assist.handle === g.handle);
      // A small gift on its own is below the floor; from a gifter who already has a task it adds to it.
      if (!open && g.diamonds * g.count < st.assist.thanksMinDiamonds) return;
      if (open) {
        // Same gifter again: one task, updated count.
        const a = open.assist as Extract<NonNullable<Highlight["assist"]>, { kind: "thanks" }>;
        const u = yield* store.updateHighlight(open.id, { assist: { ...a, gift: g.giftName, count: a.count + g.count, diamonds: a.diamonds + g.diamonds * g.count } });
        if (u) yield* publish(u, false);
        return;
      }
      const h: Highlight = { id: crypto.randomUUID(), ts: g.ts, kind: "room", flags: [], pinned: false, resolved: false, sessionId: opts.sessionId, severity: "info", assist: { kind: "thanks", handle: g.handle, nickname: g.nickname, avatar: g.avatar, gift: g.giftName, count: g.count, diamonds: g.diamonds * g.count } };
      yield* store.addHighlight(h);
      yield* publish(h, true);
    });

  // ---- the host spoke: answered prompts, thanked gifters, promises ----
  const onSpeech = Effect.gen(function* () {
    const st = yield* settings.get;
    const now = Date.now();
    const lines = yield* win.recentTranscript(90_000, now);
    if (!lines.length) return;
    const open = yield* openPrompts;
    // Thanks: a name in the speech closes the task without a call; otherwise ask, and expire old ones.
    for (const h of open.filter((x) => x.assist?.kind === "thanks")) {
      const a = h.assist as Extract<NonNullable<Highlight["assist"]>, { kind: "thanks" }>;
      const since = lines.filter((l) => l.ts >= h.ts).map((l) => l.text).join(" ");
      if (now - h.ts > timing.thanksTtlMs) { yield* resolve(h.id, "expired"); continue; }
      if (!since) continue;
      if (mentionsName(since, a.handle, a.nickname)) { yield* resolve(h.id, "thanked"); continue; }
      const ans = yield* ask("thanks", { gifter: { handle: a.handle, nickname: a.nickname ?? "", gift: a.gift }, host_speech_since_gift: since.slice(-800) }, { thanked: noul("Did the host thank this gifter, or acknowledge their gift, in this speech?", { true: "a thank-you, a shout-out or a mention of the gift", false: "no acknowledgement" }) });
      if (ans?.thanked?.type === "noul" && ans.thanked.noul >= 0.7) yield* resolve(h.id, "thanked");
    }
    // Answered: each open chat prompt younger than the window, against what the host said since it.
    if (st.assist.autoResolve) {
      const prompts = open.filter((x) => x.message && !x.duplicateOf && now - x.ts < timing.answerWindowMs).slice(-6);
      for (const h of prompts) {
        const since = lines.filter((l) => l.ts >= h.ts).map((l) => l.text).join(" ").slice(-900);
        if (since.length < 20) continue;
        const ans = yield* ask("answered", { viewer_message: { handle: h.message!.handle, text: h.message!.text }, host_speech_since_message: since }, { answered: noul("Did the host reply to this viewer's message, or address what it asks, in this speech?", { true: "the host answers the question, reacts to it, or reads it out and responds", false: "the host talks about something else" }) });
        if (ans?.answered?.type === "noul" && ans.answered.noul >= 0.75) yield* resolve(h.id, "answered");
      }
    }
    // Promises: the last few seconds of speech, once.
    if (st.assist.promises) {
      const recent = lines.filter((l) => now - l.ts < timing.speechDebounceMs + 10_000);
      const text = recent.map((l) => l.text).join(" ").trim();
      if (text.length < 15) return;
      // One promise per minute at most: the next speech batch still contains the same words.
      if (open.some((x) => x.assist?.kind === "promise" && (now - x.ts < 60_000 || x.assist.text === text))) return;
      const ans = yield* ask("promise", { host_speech_last_20s: text.slice(-600) }, { promise: noul("Did the host just promise to do something later in this live (a giveaway, answering something later, showing or sending something, a link, a song, a guest)?", { true: "a concrete commitment for later in the stream", false: "no commitment, or something they are doing right now" }) });
      if (ans?.promise?.type === "noul" && ans.promise.noul >= 0.75) {
        const h: Highlight = { id: crypto.randomUUID(), ts: now, kind: "transcript", flags: [], pinned: false, resolved: false, sessionId: opts.sessionId, severity: "info", transcript: { from: recent[0].ts, to: recent[recent.length - 1].ts, lines: recent }, assist: { kind: "promise", text: text.slice(-220), dueAt: promiseDue(text, now) ?? undefined } };
        yield* store.addHighlight(h);
        yield* publish(h, true);
      }
    }
  }).pipe(Effect.catchAllCause((c) => Effect.logWarning(`assist speech: ${c.toString().slice(0, 200)}`)));

  // ---- poll: each chat message is a vote while a poll runs ----
  const voters = yield* Ref.make<Set<string>>(new Set());
  const onChat = (m: ChatEvent) =>
    Effect.gen(function* () {
      const poll = yield* bus.poll;
      if (!poll || poll.endedAt !== null || m.ts < poll.startedAt) return;
      if ((yield* Ref.get(voters)).has(m.handle)) return;
      const criteria: Record<string, string> = Object.fromEntries(poll.options.map((o, i) => [`o${i + 1}`, `the message votes for "${o}" (its name, number, letter or an obvious equivalent)`]));
      criteria.none = "the message is not a vote";
      const ans = yield* ask("poll", { poll_question: poll.question, options: Object.fromEntries(poll.options.map((o, i) => [`o${i + 1}`, o])), message: { handle: m.handle, text: m.text } }, { vote: { type: "choice", instructions: "Which option does this chat message vote for, if any?", criteria } });
      const a = ans?.vote;
      const cur = yield* bus.poll;
      if (!cur || cur.id !== poll.id || cur.endedAt !== null) return;
      const chosen = a?.type === "choice" && a.choice !== "none" && a.confidence >= 0.5 ? poll.options[Number(a.choice.slice(1)) - 1] : undefined;
      const next: PollState = { ...cur, judged: cur.judged + 1 };
      if (chosen !== undefined) {
        yield* Ref.update(voters, (v) => v.add(m.handle));
        next.counts = { ...cur.counts, [chosen]: (cur.counts[chosen] ?? 0) + 1 };
        next.voters = cur.voters + 1;
        next.recent = [...cur.recent, { handle: m.handle, nickname: m.nickname, avatar: m.avatar, option: chosen, ts: m.ts }].slice(-12);
      }
      yield* bus.publish({ type: "poll", poll: next });
    }).pipe(Effect.catchAllCause((c) => Effect.logWarning(`assist poll: ${c.toString().slice(0, 200)}`)));

  // A new poll starts with fresh voters.
  const lastPollId = yield* Ref.make<string | null>(null);

  // ---- the app's own state: attention regime, budget degradation, repairs ----
  const lastRepairAt = yield* Ref.make(0);
  const sessionStart = Date.now();
  const ops = Effect.gen(function* () {
    const st = yield* settings.get;
    const now = Date.now();
    const snap = yield* win.snapshot(now, st.timing.windowMs);
    const health = yield* bus.health;
    const totals = yield* bus.totals;
    const hs = (yield* store.highlights).filter((h) => h.sessionId === opts.sessionId);
    const flags5 = hs.filter((h) => now - h.ts < 5 * 60_000).length;
    const open = hs.filter((h) => !h.resolved && h.severity !== "warn").length;
    const cur = yield* bus.assist;
    const questions: Record<string, JevQuestion> = {};
    const state: Record<string, unknown> = {};
    if (st.assist.regime && opts.mode !== "replay") {
      state.room = { chat_velocity: snap.activity.chat_velocity, viewers_trend: snap.activity.viewers_trend, likes_last_30s: snap.activity.likes_last_30s, host_speaking: !!snap.transcript_last_30s, open_prompts: bucket(open, [[0, "none"], [2, "few"]], "many"), flags_last_5_min: bucket(flags5, [[0, "none"], [2, "few"]], "many") };
      questions.regime = { type: "choice", instructions: "How much attention does this live room need from the assistant right now?", criteria: { calm: "little is happening: quiet or silent chat, no prompts, the host idle or talking to nobody; the assistant can look less often", normal: "an ordinary live: some chat, the host talking, a prompt now and then", hot: "a lot at once: busy or flooding chat, several open prompts, likes or gifts bursting; every second counts" } };
    }
    const cap = st.budget.sessionUsd;
    if (st.assist.degrade && cap > 0 && opts.mode !== "replay") {
      const pct = totals.session / cap;
      const elapsedMin = (now - sessionStart) / 60_000;
      const ratePerHour = elapsedMin > 1 ? (totals.session / elapsedMin) * 60 : 0;
      if (pct >= 0.8 && !cur.budgetAlert) { yield* bus.setAssist({ budgetAlert: true }); yield* bus.log({ actor: "system", kind: "budget", detail: `80 % of the session budget spent ($${totals.session.toFixed(2)} of $${cap.toFixed(2)})`, ok: false }); }
      if (pct < 0.5 && cur.degrade > 0) yield* bus.setAssist({ degrade: 0, degradeReason: undefined });
      else if (pct >= 0.6) {
        state.budget = { spent_share: bucket(pct, [[0.7, "sixty_to_seventy_percent"], [0.85, "seventy_to_eighty_five_percent"], [0.95, "eighty_five_to_ninety_five_percent"]], "almost_all"), spend_rate: bucket(ratePerHour / Math.max(cap, 0.01), [[0.5, "slow"], [1.5, "steady"]], "fast"), minutes_elapsed: bucket(elapsedMin, [[30, "under_half_hour"], [90, "under_ninety_min"]], "long"), chat_velocity: snap.activity.chat_velocity, vision_on: st.media.vision && cur.degrade < 1, chat_judging_on: st.decisions.judgeMessages && cur.degrade < 2 };
        questions.degrade = { type: "choice", instructions: "The session budget is running out. Which paid features should the assistant keep so the budget lasts until the end of the live?", criteria: { keep_all: "the money will last: keep everything", pause_vision: "stop captioning video frames (the cheapest loss) and keep judging chat and the room", room_only: "also stop judging chat messages; keep only the room questions until the end" } };
      }
    }
    if (st.assist.repair && opts.mode !== "replay") {
      const lines = (yield* win.recentTranscript(120_000, now)).map((l) => l.text);
      const caps = (yield* win.snapshot(now, st.timing.windowMs)).scene;
      const an = anomalies({ transcriptLines: lines, captions: caps.map((text) => ({ ts: now - (caps.length > 1 ? 6 * 60_000 : 0), text })), chatVelocity: snap.activity.chat_velocity, flagsLast5Min: flags5, now });
      const trouble = health.ffmpeg === "exited" || health.deepgram === "backoff" || health.deepgram === "gave-up" || (health.lastTickAt > 0 && now - health.lastTickAt > 15_000) || health.chatBacklog > 50 || snap.sources.transcript.state === "error" || snap.sources.video.state === "error" || an.transcriptRepeating || an.captionsFrozen || an.floodWithoutFlags;
      if (trouble) {
        state.health = { ffmpeg: health.ffmpeg, transcription: health.deepgram, transcription_detail: health.deepgramDetail ?? "", seconds_since_last_decision: health.lastTickAt ? bucket((now - health.lastTickAt) / 1000, [[5, "fresh"], [15, "late"]], "stalled") : "none_yet", chat_backlog: bucket(health.chatBacklog, [[5, "none"], [50, "some"]], "large"), sources: { audio: snap.sources.transcript.state, video: snap.sources.video.state, chat: snap.sources.chat.state }, transcript_repeating_itself: an.transcriptRepeating, video_captions_frozen: an.captionsFrozen, chat_flooding_with_no_flag: an.floodWithoutFlags, media_restart_recently: now - (yield* Ref.get(lastRepairAt)) < timing.repairCooldownMs };
        questions.repair = { type: "choice", instructions: "The live pipeline reports trouble. What should the assistant do?", criteria: { none: "nothing is really wrong or it is already recovering on its own", restart_media: "the media pipeline (ffmpeg: audio, frames, video) is stuck or exited: restart it", disable_transcription: "speech-to-text keeps failing or repeating garbage: turn it off for this live so the rest keeps working", reconnect: "the stream itself is gone or every source is dead: reconnect the session", alert: "a person must look (a bad key, no credit, a rule gap): tell the operator" } };
      } else if (cur.repair && cur.repair.action !== "none") yield* bus.setAssist({ repair: { action: "none", detail: "recovered", at: now, applied: false } });
    }
    if (!Object.keys(questions).length) return;
    const ans = yield* ask("ops", state, questions);
    if (!ans) return;
    const patch: Partial<AssistState> = {};
    if (ans.regime?.type === "choice" && ans.regime.confidence >= 0.4) patch.regime = ans.regime.choice as AssistState["regime"];
    if (ans.degrade?.type === "choice" && ans.degrade.confidence >= 0.4) {
      const level = ans.degrade.choice === "room_only" ? 2 : ans.degrade.choice === "pause_vision" ? 1 : 0;
      if (level !== cur.degrade) { patch.degrade = level; patch.degradeReason = level ? `budget: ${ans.degrade.choice.replace(/_/g, " ")}` : undefined; yield* bus.log({ actor: "system", kind: "budget", detail: level === 2 ? "budget getting low: vision and chat judging paused, room rules continue" : level === 1 ? "budget getting low: vision captions paused" : "budget fine again: everything back on", ok: level === 0 }); }
    }
    if (ans.repair?.type === "choice") {
      const action = ans.repair.choice as NonNullable<AssistState["repair"]>["action"];
      let applied = false;
      const since = now - (yield* Ref.get(lastRepairAt));
      if (action === "restart_media" && opts.ops && since >= timing.repairCooldownMs) { applied = yield* opts.ops.restartMedia; if (applied) yield* Ref.set(lastRepairAt, now); }
      if (action === "disable_transcription" && opts.ops && since >= timing.repairCooldownMs) { applied = yield* opts.ops.disableTranscription; if (applied) yield* Ref.set(lastRepairAt, now); }
      const detail = action === "none" ? "" : action === "restart_media" ? (applied ? "media pipeline restarted" : "media restart suggested") : action === "disable_transcription" ? (applied ? "transcription turned off for this live" : "turning transcription off suggested") : action === "reconnect" ? "reconnecting the session suggested" : "the operator should look at the health bar";
      if (action !== "none" || cur.repair?.action !== "none") patch.repair = { action, detail, at: now, applied };
      if (action !== "none") yield* bus.log({ actor: "system", kind: "repair", detail: `jev: ${action.replace(/_/g, " ")} · ${detail}`, ok: applied });
    }
    if (Object.keys(patch).length) yield* bus.setAssist(patch);
  }).pipe(Effect.catchAllCause((c) => Effect.logWarning(`assist ops: ${c.toString().slice(0, 200)}`)));

  // ---- can the host be interrupted? judged from the last seconds of speech ----
  const interrupt = Effect.gen(function* () {
    const st = yield* settings.get;
    if (!st.assist.interruptibility || opts.mode === "replay") return;
    const now = Date.now();
    const lines = yield* win.recentTranscript(20_000, now);
    const speech = lines.map((l) => l.text).join(" ");
    const snap = yield* win.snapshot(now, st.timing.windowMs);
    const cur = yield* bus.assist;
    if (!speech.trim()) { if (cur.interruptible !== "free") yield* bus.setAssist({ interruptible: "free" }); return; }
    const ans = yield* ask("interrupt", { host_speech_last_20s: speech.slice(-500), words_per_10s: bucket(speech.split(/\s+/).length / 2, [[8, "slow"], [20, "normal"]], "fast"), chat_velocity: snap.activity.chat_velocity }, { interruptible: { type: "choice", instructions: "Can the host take a prompt from the assistant right now without breaking their flow?", criteria: { free: "the host pauses, reads chat, or chats casually: a prompt fits", talking: "the host talks steadily; a prompt can wait a few seconds", busy: "the host is mid-story, mid-explanation or emotional: do not interrupt now" } } });
    if (ans?.interruptible?.type === "choice" && ans.interruptible.confidence >= 0.4 && ans.interruptible.choice !== cur.interruptible) yield* bus.setAssist({ interruptible: ans.interruptible.choice as AssistState["interruptible"] });
  }).pipe(Effect.catchAllCause((c) => Effect.logWarning(`assist interrupt: ${c.toString().slice(0, 200)}`)));

  // ---- rule hygiene: keep / refine / pause / remove, from fires, verdicts and confidence ----
  const hygiene = Effect.gen(function* () {
    const st = yield* settings.get;
    if (!st.assist.ruleHygiene || opts.mode === "replay") return;
    const set = yield* store.current;
    const rules = yield* store.rules;
    const fb = yield* store.feedback;
    const hs = yield* store.highlights;
    const decisions = yield* bus.recentDecisions;
    const sessions = new Set(hs.map((h) => h.sessionId).filter(Boolean));
    const questions: Record<string, JevQuestion> = {};
    const state: Record<string, unknown> = {};
    for (const r of rules) {
      const qs = set.questions.filter((q) => q.ruleId === r.id);
      if (!qs.length) continue;
      const ids = new Set(qs.map((q) => q.id));
      const fired = hs.filter((h) => h.flags.some((f) => ids.has(f.questionId)));
      const firedSessions = new Set(fired.map((h) => h.sessionId).filter(Boolean));
      const verdicts = qs.reduce((a, q) => { const f = fb[q.id]; return f ? { wrong: a.wrong + f.wrong, missed: a.missed + f.missed, correct: a.correct + f.correct } : a; }, { wrong: 0, missed: 0, correct: 0 });
      const conf = decisions.flatMap((d) => qs.map((q) => d.answers[q.id]).filter(Boolean)).map((a) => (a!.type === "noul" ? Math.abs(a!.noul - 0.5) * 2 : a!.confidence));
      const avgConf = conf.length ? conf.reduce((a, b) => a + b, 0) / conf.length : null;
      state[r.id] = { rule: r.text.slice(0, 200), kind: r.kind ?? "jev", paused: !!r.paused, fires_this_session: bucket(fired.filter((h) => h.sessionId === opts.sessionId).length, [[0, "none"], [3, "few"], [15, "some"]], "many"), sessions_seen: sessions.size, sessions_where_it_fired: firedSessions.size, verdicts: { wrong: verdicts.wrong, missed: verdicts.missed, correct: verdicts.correct }, average_confidence: avgConf === null ? "unknown" : bucket(avgConf, [[0.4, "low"], [0.7, "medium"]], "high") };
      questions[r.id] = { type: "choice", instructions: `What should the operator do with rule "${r.id}"? Judge from its facts in the state.`, criteria: { keep: "it works: it fires sometimes, verdicts are mostly correct or absent, confidence is fine", refine: "it fires but the operator marked it wrong or missed several times, or confidence stays low: the wording needs work", pause: "it never fires across several sessions, or it fires too much with no value: switch it off for now", remove: "it is clearly useless or redundant and wastes calls" } };
    }
    if (!Object.keys(questions).length) return;
    const ans = yield* ask("hygiene", { rules: state }, questions);
    if (!ans) return;
    const now = Date.now();
    const advice: AssistState["ruleAdvice"] = {};
    for (const [id, a] of Object.entries(ans)) if (a.type === "choice" && a.confidence >= 0.5 && (a.choice === "refine" || a.choice === "pause" || a.choice === "remove")) { const f = state[id] as { fires_this_session: string; sessions_seen: number; sessions_where_it_fired: number; verdicts: { wrong: number; missed: number }; average_confidence: string }; advice[id] = { advice: a.choice as "refine" | "pause" | "remove", reason: `fires ${f.fires_this_session} · in ${f.sessions_where_it_fired}/${f.sessions_seen} sessions · ${f.verdicts.wrong} wrong, ${f.verdicts.missed} missed · confidence ${f.average_confidence}`, at: now }; }
    yield* bus.setAssist({ ruleAdvice: advice });
  }).pipe(Effect.catchAllCause((c) => Effect.logWarning(`assist hygiene: ${c.toString().slice(0, 200)}`)));

  const loop = (every: number, job: Effect.Effect<void>, first = every) => Effect.gen(function* () { yield* Effect.sleep(Duration.millis(first)); while (true) { yield* job; yield* Effect.sleep(Duration.millis(every)); } }).pipe(Effect.forkScoped);
  yield* loop(timing.opsIntervalMs, ops);
  yield* loop(timing.interruptMs, interrupt);
  yield* loop(timing.hygieneMs, hygiene, Math.min(timing.hygieneMs, 60_000));

  // ---- wiring: one subscription, a debounced speech job ----
  const speechDue = yield* Ref.make<number | null>(null);
  const sub = yield* bus.subscribe;
  yield* Stream.fromQueue(sub).pipe(
    Stream.runForEach((msg) => Effect.gen(function* () {
      if (msg.type === "highlight" && msg.fresh && msg.highlight.kind === "message" && msg.highlight.severity !== "warn" && !msg.highlight.assist) {
        const folded = yield* dedupe(msg.highlight).pipe(Effect.catchAllCause((c) => Effect.logWarning(`assist dedupe: ${c.toString().slice(0, 200)}`).pipe(Effect.as(false))));
        if (!folded) yield* faq(msg.highlight).pipe(Effect.catchAllCause((c) => Effect.logWarning(`assist faq: ${c.toString().slice(0, 200)}`)));
      } else if (msg.type === "event" && msg.event.kind === "gift") yield* onGift(msg.event).pipe(Effect.catchAllCause((c) => Effect.logWarning(`assist gift: ${c.toString().slice(0, 200)}`)));
      else if (msg.type === "event" && msg.event.kind === "transcript" && msg.event.final && msg.event.text.trim()) yield* Ref.set(speechDue, Date.now() + timing.speechDebounceMs);
      else if (msg.type === "event" && msg.event.kind === "chat") yield* onChat(msg.event);
      else if (msg.type === "poll") { const id = msg.poll?.id ?? null; if (id !== (yield* Ref.get(lastPollId))) { yield* Ref.set(lastPollId, id); yield* Ref.set(voters, new Set()); } }
    })),
    Effect.forkScoped,
  );
  yield* Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(Duration.millis(Math.max(250, Math.min(2000, timing.speechDebounceMs / 4))));
      const due = yield* Ref.get(speechDue);
      if (due === null || Date.now() < due) continue;
      yield* Ref.set(speechDue, null);
      yield* onSpeech;
    }
  }).pipe(Effect.forkScoped);

  return { spent: Ref.get(spent) };
});

/** Start a poll (replacing a running one) or end the current one; returns the new state. */
export const startPoll = (question: string, options: string[]) =>
  Effect.gen(function* () {
    const bus = yield* Bus;
    const poll: PollState = { id: crypto.randomUUID(), question: question.trim().slice(0, 200), options: options.map((o) => o.trim().slice(0, 60)).filter(Boolean).slice(0, 8), startedAt: Date.now(), endedAt: null, counts: {}, voters: 0, judged: 0, recent: [] };
    yield* bus.publish({ type: "poll", poll });
    yield* bus.log({ actor: "system", kind: "poll", detail: `poll started: ${poll.question} · ${poll.options.join(" / ")}`, ok: true });
    return poll;
  });
export const endPoll = Effect.gen(function* () {
  const bus = yield* Bus;
  const cur = yield* bus.poll;
  if (!cur || cur.endedAt !== null) return cur;
  const poll: PollState = { ...cur, endedAt: Date.now() };
  yield* bus.publish({ type: "poll", poll });
  yield* bus.log({ actor: "system", kind: "poll", detail: `poll ended: ${Object.entries(poll.counts).map(([o, n]) => `${o} ${n}`).join(" · ") || "no votes"}`, ok: true });
  return poll;
});
export const clearPoll = Effect.flatMap(Bus, (bus) => bus.publish({ type: "poll", poll: null }));

/** Rank a finished session's recording: keep / ok / expendable, for the retention helper. Null when jev fails or is off. */
export const retentionVerdict = (jev: JevApi, summary: SessionSummary): Effect.Effect<{ keep: RetentionTag; reason: string } | null> =>
  Effect.gen(function* () {
    const facts = retentionFacts(summary);
    const r = yield* jev.decide({ session: facts }, { keep: { type: "choice", instructions: "How valuable is the recording of this finished live, for a streamer who keeps the good ones and lets the disk clean the rest?", criteria: { keep: "a real live worth revisiting: long or eventful, real chat, flags, viewers", ok: "an ordinary live: keep while there is room", expendable: "a test, a false start, or a few minutes with nobody watching: delete first when the disk is low" } } }).pipe(Effect.either);
    if (r._tag === "Left" || r.right.answers.keep?.type !== "choice") return null;
    const a = r.right.answers.keep;
    return { keep: a.choice as RetentionTag, reason: `${facts.duration.replace(/_/g, " ")} · chat ${facts.chat} · flags ${facts.flags} · viewers ${facts.peak_viewers.replace(/_/g, " ")}` };
  });

/** Which recordings to delete to get `needBytes` back: expendable ones first, oldest first, never the current session. */
export const purgePlan = (list: { id: string; keep?: RetentionTag; createdAt: number; sizeBytes: number }[], needBytes: number, currentId: string | null): string[] => {
  const out: string[] = [];
  let got = 0;
  for (const r of list.filter((x) => x.keep === "expendable" && x.id !== currentId).sort((a, b) => a.createdAt - b.createdAt)) { if (got >= needBytes) break; out.push(r.id); got += r.sizeBytes; }
  return out;
};
