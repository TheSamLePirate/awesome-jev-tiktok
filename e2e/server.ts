// Boots the real server for the e2e suite: fresh isolated runtime + recordings directories, a synthetic recording
// to replay, the production build served from dist/, no autostart. Playwright kills this process at the end.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { writeSyntheticRecording } from "./fixture-recording";

const root = path.resolve(import.meta.dir, "..");
const tmp = path.join(root, "e2e", ".tmp");
rmSync(tmp, { recursive: true, force: true });
mkdirSync(path.join(tmp, "recordings"), { recursive: true });
mkdirSync(path.join(tmp, "runtime"), { recursive: true });
writeSyntheticRecording(path.join(tmp, "recordings"));

if (!process.env.E2E_SKIP_BUILD || !existsSync(path.join(root, "dist", "index.html"))) execSync("bun run build", { cwd: root, stdio: "inherit" });

process.env.PORT = process.env.E2E_PORT ?? "3999";
process.env.HOST = "127.0.0.1";
process.env.JEV_RUNTIME_DIR = path.join(tmp, "runtime");
process.env.JEV_RECORDINGS_DIR = path.join(tmp, "recordings");
process.env.TIKTOK_USERNAME = "";
process.env.REPLAY = "";
process.env.JEV_TOKEN = "";
process.chdir(root);
await import("../server/index");
