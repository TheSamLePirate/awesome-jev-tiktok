import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  root: "web",
  resolve: { alias: { "@shared": path.resolve(__dirname, "shared") } },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3001",
      "/hls": "http://localhost:3001",
      "/recordings": "http://localhost:3001",
      "/ws": { target: "ws://localhost:3001", ws: true },
    },
  },
  build: { outDir: "../dist", emptyOutDir: true },
});
