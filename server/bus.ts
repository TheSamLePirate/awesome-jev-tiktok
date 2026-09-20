import { Effect, PubSub, Ref, Stream } from "effect";
import type { Decision, GlmActivity, LiveEvent, MessageDecision, ServerMessage } from "../shared/protocol";

const RECENT_EVENTS = 200;
const RECENT_DECISIONS = 120;
const RECENT_GLM = 50;
const RECENT_MSG_DECISIONS = 300;

/** Broadcast channel to every connected UI, plus ring buffers so late joiners get context. */
export class Bus extends Effect.Service<Bus>()("Bus", {
  effect: Effect.gen(function* () {
    const hub = yield* PubSub.unbounded<ServerMessage>();
    const events = yield* Ref.make<LiveEvent[]>([]);
    const decisions = yield* Ref.make<Decision[]>([]);
    const glm = yield* Ref.make<GlmActivity[]>([]);
    const msgDecisions = yield* Ref.make<MessageDecision[]>([]);

    const push = <T>(ref: Ref.Ref<T[]>, item: T, cap: number) =>
      Ref.update(ref, (xs) => (xs.length >= cap ? [...xs.slice(xs.length - cap + 1), item] : [...xs, item]));

    const publish = (msg: ServerMessage) =>
      Effect.gen(function* () {
        if (msg.type === "event") yield* push(events, msg.event, RECENT_EVENTS);
        if (msg.type === "decision") yield* push(decisions, msg.decision, RECENT_DECISIONS);
        if (msg.type === "messageDecision") yield* push(msgDecisions, msg.decision, RECENT_MSG_DECISIONS);
        if (msg.type === "glm") {
          yield* Ref.update(glm, (xs) => {
            const i = xs.findIndex((a) => a.id === msg.activity.id);
            if (i >= 0) return xs.map((a, j) => (j === i ? msg.activity : a));
            return xs.length >= RECENT_GLM ? [...xs.slice(1), msg.activity] : [...xs, msg.activity];
          });
        }
        yield* PubSub.publish(hub, msg);
      });

    return {
      publish,
      event: (event: LiveEvent) => publish({ type: "event", event }),
      stream: Stream.fromPubSub(hub),
      recentEvents: Ref.get(events),
      recentDecisions: Ref.get(decisions),
      recentGlm: Ref.get(glm),
      recentMessageDecisions: Ref.get(msgDecisions),
    };
  }),
}) {}
