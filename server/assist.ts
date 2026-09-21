import { Duration, Effect, Ref, Stream } from "effect";
import { Bus } from "./bus";
import { Jev } from "./jev";
import { Store } from "./store";
import { Window } from "./window";
import { SettingsStore } from "./settings";
import type { ChatEvent, GiftEvent, Highlight, JevAnswer, JevQuestion, PollState } from "../shared/protocol";

/**
 * Built-in jev helpers that run beside the user's rules. Each one is a trigger (a flag, a gift, the host speaking,
 * a chat message during a poll) and one small typed question; the answers close prompts, fold duplicates, create
 * tasks or count votes. They share one budget (settings.assist.sessionUsd) and stay off in a dry run.
 */
export interface AssistOptions { sessionId: string; mode: "live" | "replay" | "simulate"; dryRun: boolean; /** tests shorten these */ timing?: Partial<AssistTiming> }
export interface AssistTiming { /** wait after the host spoke before judging what changed */ speechDebounceMs: number; /** a thanks prompt nobody acted on goes away */ thanksTtlMs: number; /** a prompt older than this is not judged "answered" any more */ answerWindowMs: number }
const DEFAULT_TIMING: AssistTiming = { speechDebounceMs: 12_000, thanksTtlMs: 4 * 60_000, answerWindowMs: 10 * 60_000 };

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
      yield* Ref.update(spent, (x) => x + r.right.cost);
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
