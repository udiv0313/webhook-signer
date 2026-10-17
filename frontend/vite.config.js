import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// In development the browser talks only to the Vite dev server (port 5173).
// Requests to /api/* are forwarded to the backend by Vite itself, so from the
// browser's point of view everything is same-origin and no CORS is needed.
export default defineConfig(({ mode }) => {
  // "" loads every variable from frontend/.env, not just VITE_* ones.
  // API_PROXY_TARGET has no VITE_ prefix, so it is only used here and is
  // never bundled into the browser JavaScript.
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.API_PROXY_TARGET || "http://localhost:3000";

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        "/api": { target: apiTarget },
      },
    },
  };
});
