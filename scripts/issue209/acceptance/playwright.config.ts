/**
 * Issue #209 real-device acceptance. NOT part of `npm run test:browser`:
 * it uses the host's real microphone/camera/screen and one explicitly audible
 * loopback pass. Run only with the user's consent:
 *   npx playwright test --config scripts/issue209/acceptance/playwright.config.ts
 * Recordings are deleted after measurement; only numbers are reported.
 */
import { defineConfig } from '@playwright/test'

const port = 41_733

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.acceptance\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  reporter: 'list',
  outputDir: '../../../.tmp/playwright-issue209-acceptance',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    headless: true,
    // Quiet by default; the loopback test opts into audible output itself.
    launchOptions: { args: ['--mute-audio'] },
    viewport: { width: 1440, height: 900 },
    permissions: ['microphone'],
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium', channel: 'chromium' } }],
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
