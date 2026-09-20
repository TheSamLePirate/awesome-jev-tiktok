import { Data, Effect, Option, Schema } from "effect";
import { mkdir, readFile, rename, rm, stat, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";

/** Every filesystem failure is a typed error, so loops can log and continue instead of dying as a defect. */
export class FsError extends Data.TaggedError("FsError")<{ op: string; path: string; cause: unknown }> {
  get message() { return `${this.op} ${this.path}: ${(this.cause as Error)?.message ?? String(this.cause)}`; }
}

const wrap = <A>(op: string, p: string, f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: (cause) => new FsError({ op, path: p, cause }) });

export const ensureDir = (dir: string) => wrap("mkdir", dir, () => mkdir(dir, { recursive: true })).pipe(Effect.asVoid);
export const remove = (p: string, opts: { recursive?: boolean } = {}) => wrap("rm", p, () => rm(p, { force: true, recursive: opts.recursive ?? false }));
export const readText = (p: string) => wrap("read", p, () => readFile(p, "utf8"));
export const fileStat = (p: string) => wrap("stat", p, () => stat(p));
export const exists = (p: string) => fileStat(p).pipe(Effect.map(() => true), Effect.orElseSucceed(() => false));
export const move = (from: string, to: string) => wrap("rename", from, () => rename(from, to));
export const copy = (from: string, to: string) => wrap("copy", from, () => copyFile(from, to));

/**
 * Write a file atomically: the content goes to a temp file next to the target (with the requested mode),
 * then a rename replaces the target. A crash mid-write leaves the previous version intact.
 */
export const atomicWrite = (file: string, data: string | Uint8Array, mode = 0o600) =>
  Effect.gen(function* () {
    yield* ensureDir(path.dirname(file));
    const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
    yield* wrap("write", tmp, () => writeFile(tmp, data, { mode }));
    yield* wrap("rename", tmp, () => rename(tmp, file)).pipe(Effect.tapError(() => remove(tmp).pipe(Effect.ignore)));
  });

export class JsonError extends Data.TaggedError("JsonError")<{ path: string; message: string }> {}

/** Read and validate a JSON file. `None` when the file does not exist; a typed failure when it is corrupt. */
export const readJson = <A, I>(file: string, schema: Schema.Schema<A, I>) =>
  Effect.gen(function* () {
    const present = yield* exists(file);
    if (!present) return Option.none<A>();
    const text = yield* readText(file);
    const raw = yield* Effect.try({ try: () => JSON.parse(text) as unknown, catch: (e) => new JsonError({ path: file, message: `invalid JSON: ${(e as Error).message}` }) });
    const value = yield* Schema.decodeUnknown(schema)(raw).pipe(Effect.mapError((e) => new JsonError({ path: file, message: `schema: ${e.message.slice(0, 300)}` })));
    return Option.some(value);
  });

/** Free bytes on the volume holding `dir`, or null when unavailable. */
export const diskFree = (dir: string) =>
  Effect.tryPromise(async () => {
    const { statfs } = await import("node:fs/promises");
    const s = await statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  }).pipe(Effect.orElseSucceed(() => null as number | null));
