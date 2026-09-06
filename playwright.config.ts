import { defineConfig } from '@playwright/test'

const browserTestPort = 41_732
const browserTestUrl = `http://127.0.0.1:${browserTestPort}`

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: '.tmp/playwright',
  use: {
    baseURL: browserTestUrl,
    headless: true,
    // Browser tests inspect decoded audio and meters without using speakers.
    launchOptions: { args: ['--mute-audio'] },
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [{
    name: 'chromium',
    use: { browserName: 'chromium', channel: 'chromium' },
  }],
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${browserTestPort} --strictPort`,
    url: browserTestUrl,
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
