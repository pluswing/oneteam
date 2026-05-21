import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiTarget = process.env.VITE_API_TARGET ?? "http://127.0.0.1:3580";
const webPort = Number(process.env.VITE_PORT ?? "3579");

export default defineConfig({
  plugins: [react()],
  root: ".",
  server: {
    host: "127.0.0.1",
    port: webPort,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true
  }
});
