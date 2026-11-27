import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  use: {
    baseURL: "http://127.0.0.1:4173",
    viewport: { width: 393, height: 852 },
    reducedMotion: "reduce",
    channel: process.env.DRINK_PASS_BROWSER_CHANNEL || undefined,
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 4173 --strictPort",
    env: {
      VITE_SUPABASE_URL: "http://127.0.0.1:4173",
      VITE_SUPABASE_PUBLISHABLE_KEY: "local-playwright-key",
    },
    url: "http://127.0.0.1:4173",
  },
});
