import { Effect, PubSub, Queue, Ref, Scope, Stream } from "effect";
import type { CostTotals, Decision, GlmActivity, HealthInfo, LiveEvent, LogActor, LogEntry, MessageDecision, PollState, ServerMessage, ServerMessageBody } from "../shared/protocol";

const RECENT_EVENTS = 200;
const RECENT_DECISIONS = 120;
const RECENT_GLM = 50;
const RECENT_MSG_DECISIONS = 300;
const RECENT_LOG = 600;

interface Rings {
  seq: number;
  sessionId: string | null;
  events: LiveEvent[];
  decisions: Decision[];
  glm: GlmActivity[];
  msgDecisions: MessageDecision[];
  log: LogEntry[];
  totals: CostTotals;
  health: HealthInfo;
  poll: PollState | null;
}

const zeroActors = (): Record<LogActor, number> => ({ jev: 0, glm: 0, vision: 0, deepgram: 0, system: 0 });
export const initialHealth = (): HealthInfo => ({ ffmpeg: "off", recorder: "off", deepgram: "off", lastTickAt: 0, chatBacklog: 0, chatDropped: 0, breaker: null, rateLimitedUntil: 0, budget: { spent: 0, cap: 0, stopped: false }, diskFreeBytes: null });

/** A mutable ring: push in place, so a publish does not copy the whole buffer. */
const pushRing = <T>(xs: T[], item: T, cap: number) => { xs.push(item); if (xs.length > cap) xs.splice(0, xs.length - cap); };

/**
 * Broadcast channel to every connected UI, plus ring buffers so late joiners get context.
 * All state lives in one Ref so a `snapshot` is consistent with the sequence number it reports: a client can
 * apply exactly the messages published after its `hello` and nothing twice.
 */
export class Bus extends Effect.Service<Bus>()("Bus", {
  effect: Effect.gen(function* () {
    const hub = yield* PubSub.bounded<ServerMessage>(4096);
    const state = yield* Ref.make<Rings>({ seq: 0, sessionId: null, events: [], decisions: [], glm: [], msgDecisions: [], log: [], totals: { session: 0, boot: 0, byActor: zeroActors(), estimated: 0, reserved: 0 }, health: initialHealth(), poll: null });

    const apply = (r: Rings, msg: ServerMessageBody): void => {
      switch (msg.type) {
        case "event": pushRing(r.events, msg.event, RECENT_EVENTS); break;
        case "decision": pushRing(r.decisions, msg.decision, RECENT_DECISIONS); break;
        case "messageDecision": pushRing(r.msgDecisions, msg.decision, RECENT_MSG_DECISIONS); break;
        case "log": pushRing(r.log, msg.entry, RECENT_LOG); break;
        case "health": r.health = msg.health; break;
        case "session": r.sessionId = msg.sessionId; break;
        case "poll": r.poll = msg.poll; break;
        case "glm": {
          const i = r.glm.findIndex((a) => a.id === msg.activity.id);
          if (i >= 0) r.glm[i] = msg.activity; else pushRing(r.glm, msg.activity, RECENT_GLM);
          break;
        }
        default: break;
      }
    };

    /** Stamp a sequence number, update the rings and broadcast, atomically with respect to `snapshot`. */
    const publish = (body: ServerMessageBody) =>
      Ref.modify(state, (r) => { r.seq += 1; apply(r, body); const msg: ServerMessage = { ...body, seq: r.seq }; return [msg, r] as const; }).pipe(
        Effect.flatMap((msg) => PubSub.publish(hub, msg).pipe(Effect.as(msg))),
      );

    const log = (entry: Omit<LogEntry, "id" | "ts"> & { ts?: number }) =>
      Effect.gen(function* () {
        const r = yield* Ref.get(state);
        const full: LogEntry = { id: crypto.randomUUID(), ts: entry.ts ?? Date.now(), sessionId: r.sessionId ?? undefined, ...entry };
        const totals = yield* Ref.modify(state, (r) => {
          const c = full.cost ?? 0;
          if (c) {
            r.totals.boot += c;
            r.totals.session += c;
            r.totals.byActor[full.actor] = (r.totals.byActor[full.actor] ?? 0) + c;
            if (full.costKind === "estimated") r.totals.estimated += c;
          }
          return [{ ...r.totals, byActor: { ...r.totals.byActor } }, r] as const;
        });
        yield* publish({ type: "log", entry: full, totals });
      });

    return {
      publish: (body: ServerMessageBody) => publish(body).pipe(Effect.asVoid),
      event: (event: LiveEvent) => publish({ type: "event", event }).pipe(Effect.asVoid),
      stream: Stream.fromPubSub(hub),
      /** A subscription that exists as soon as this effect returns (no missed message between subscribe and run). */
      subscribe: PubSub.subscribe(hub) as Effect.Effect<Queue.Dequeue<ServerMessage>, never, Scope.Scope>,
      /** Consistent view of every ring plus the sequence it was taken at. */
      snapshot: Ref.get(state).pipe(Effect.map((r) => ({ seq: r.seq, sessionId: r.sessionId, events: [...r.events], decisions: [...r.decisions], glm: [...r.glm], msgDecisions: [...r.msgDecisions], log: [...r.log], totals: { ...r.totals, byActor: { ...r.totals.byActor } }, health: r.health, poll: r.poll }))),
      recentDecisions: Ref.get(state).pipe(Effect.map((r) => [...r.decisions])),
      recentLog: Ref.get(state).pipe(Effect.map((r) => [...r.log])),
      totals: Ref.get(state).pipe(Effect.map((r) => ({ ...r.totals, byActor: { ...r.totals.byActor } }))),
      health: Ref.get(state).pipe(Effect.map((r) => r.health)),
      poll: Ref.get(state).pipe(Effect.map((r) => r.poll)),
      /** Update part of the health record and broadcast it. */
      setHealth: (patch: Partial<HealthInfo>) =>
        Ref.modify(state, (r) => { r.health = { ...r.health, ...patch }; return [r.health, r] as const; }).pipe(Effect.flatMap((h) => publish({ type: "health", health: h })), Effect.asVoid),
      /** A session starts: session totals restart from zero and log entries are tagged with the session id. */
      beginSession: (sessionId: string) =>
        Ref.update(state, (r) => { r.sessionId = sessionId; r.totals.session = 0; r.totals.estimated = 0; r.totals.reserved = 0; r.totals.byActor = zeroActors(); return r; }).pipe(Effect.andThen(publish({ type: "session", sessionId })), Effect.asVoid),
      /** Money reserved for calls in flight (admission control). */
      reserve: (usd: number) => Ref.update(state, (r) => { r.totals.reserved = Math.max(0, r.totals.reserved + usd); return r; }),
      /** Drop the live rings only (a replay seek): the session id and its totals stay. */
      clearRings: Ref.update(state, (r) => { r.events = []; r.decisions = []; r.msgDecisions = []; return r; }),
      /** Drop everything tied to the finished session; the activity log and GLM history are kept. */
      clearSession: Ref.update(state, (r) => { r.events = []; r.decisions = []; r.msgDecisions = []; r.sessionId = null; r.poll = null; return r; }).pipe(Effect.andThen(publish({ type: "session", sessionId: null })), Effect.asVoid),
      /** Append one activity-log entry, update the running totals and broadcast both. */
      log,
    };
  }),
}) {}
