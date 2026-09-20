import { Effect, Layer, Logger, LogLevel, ManagedRuntime, Stream } from "effect";
import { AppConfig } from "./config";
import { Bus } from "./bus";
import { Window } from "./window";
import { Store } from "./store";
import { Jev } from "./jev";
import { Glm } from "./glm";
import { Gate } from "./gate";
import { SettingsStore } from "./settings";
import { Session } from "./session";
import { makeServer } from "./http";

// Service graph: Settings → Bus → Gate → (Jev, Glm) ; Window, Store ; Session on top of everything.
const Base = Layer.mergeAll(Bus.Default, Window.Default, Store.Default).pipe(Layer.provideMerge(SettingsStore.Default));
const WithGate = Gate.Default.pipe(Layer.provideMerge(Base));
const WithModels = Layer.mergeAll(Jev.Default, Glm.Default).pipe(Layer.provideMerge(WithGate));
const MainLayer = Session.Default.pipe(Layer.provideMerge(WithModels), Layer.provide(Logger.minimumLogLevel(LogLevel.Info)));

const runtime = ManagedRuntime.make(MainLayer);
const cfg = await runtime.runPromise(AppConfig);

const server = makeServer({ runtime, cfg });

// Broadcast every bus message to all UI sockets.
runtime.runFork(
  Effect.scoped(Effect.gen(function* () {
    const bus = yield* Bus;
    const sub = yield* bus.subscribe;
    yield* Stream.fromQueue(sub).pipe(Stream.runForEach((m) => Effect.sync(() => server.publish("ui", JSON.stringify(m)))));
  })),
);

console.log(`awesome-jev server on http://${cfg.host}:${server.port}  (jev=${cfg.jevModel}, glm=${cfg.glmModel}, vision=${cfg.visionModel})${cfg.token ? " · token auth on" : cfg.host === "127.0.0.1" ? " · loopback only" : " · NO AUTH on a non-loopback interface: set JEV_TOKEN"}`);
if (!cfg.openrouterKey) console.warn("[boot] OPENROUTER_API_KEY is empty: set it in .env or in Settings before connecting");

// Clean shutdown: end the session (finalize the archive), flush the store, close the runtime.
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[boot] ${signal}: shutting down`);
  server.stop(true);
  await runtime.dispose().catch((e) => console.error("[boot] dispose", e));
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

const startFromEnv = cfg.replay ? Effect.flatMap(Session, (s) => s.start({ replayId: cfg.replay.replace(/^recordings\//, "").replace(/\.jsonl$/, "") })) : cfg.tiktokUsername ? Effect.flatMap(Session, (s) => s.start({ username: cfg.tiktokUsername })) : null;
if (startFromEnv) runtime.runFork(startFromEnv.pipe(Effect.tap((r) => Effect.logInfo(`autostart: ${JSON.stringify(r)}`))));
