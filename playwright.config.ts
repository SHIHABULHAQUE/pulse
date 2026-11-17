import { defineConfig } from '@playwright/test';

// E2E runs against the production build: one Node process serving the web app and /ws.
// Run `pnpm build` first (the `e2e` script does this).
const PORT = 8788;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  reporter: [['list']],
  outputDir: './e2e/.results',
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Uses the locally installed Chrome so no browser download is needed; set PW_CHANNEL= to use bundled Chromium.
    channel: process.env.PW_CHANNEL ?? 'chrome',
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'node apps/server/dist/index.js',
    url: `http://localhost:${PORT}/health`,
    reuseExistingServer: false,
    env: { PORT: String(PORT), DATA_DIR: '', LOG_LEVEL: 'warn' }
  }
});
