import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: "web",
  resolve: { alias: { "@shared": path.resolve(here, "shared") } },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3001",
      "/hls": "http://localhost:3001",
      "/recordings": "http://localhost:3001",
      "/ws": { target: "ws://localhost:3001", ws: true },
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    // hls.js is loaded on demand by the player; it must not sit in the main chunk.
    rollupOptions: { output: { manualChunks: (id: string) => (id.includes("node_modules/hls.js") ? "hls" : id.includes("node_modules/react") ? "react" : undefined) } },
  },
});
