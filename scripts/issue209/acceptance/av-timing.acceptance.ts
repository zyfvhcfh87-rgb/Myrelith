/**
 * Issue #209 Steps 13–15: A/V capture probes through the production worker.
 * ISSUE209_AV=fake (default) uses Chromium's fake camera/mic and display;
 * ISSUE209_AV=real uses the MacBook camera, the default microphone, and the
 * real screen (auto-selected: the native chooser is browser UI). Captures are
 * deleted inside the probe; only numbers are printed.
 */
import { test } from '@playwright/test'

const real = process.env.ISSUE209_AV === 'real'
// Tab capture needs no OS screen-recording permission and is the only surface
// with browser-provided audio; the target tab flashes and beeps together.
const tabCapture = (process.env.ISSUE209_SCENARIOS ?? '').includes('tab')
test.use({
  // Headless Chrome has no audio output for tab mirroring, so tab scenarios run
  // headed (brief visible window, an explicit exception). Tab capture keeps output unmuted so the tab's audio can be captured at all;
  // the probe asks Chrome to suppress local playback of the captured tab.
  launchOptions: { args: [...(tabCapture ? [] : ['--mute-audio']), '--enable-precise-memory-info', '--autoplay-policy=no-user-gesture-required',
    ...(tabCapture ? ['--auto-select-tab-capture-source-by-title=Capture Target']
      : ['--auto-select-desktop-capture-source=Entire screen', '--use-fake-ui-for-media-stream']),
    ...(real ? [] : ['--use-fake-device-for-media-stream'])] },
  permissions: ['camera', 'microphone'],
  headless: !tabCapture,
})

const scenarios = (process.env.ISSUE209_SCENARIOS ?? 'camera,camera-crash,screen,screen-silent-long,screen-mic').split(',')
const queries: Record<string, string> = {
  camera: 'mode=camera&seconds=10',
  'camera-crash': 'mode=camera&seconds=6&crash=1',
  screen: 'mode=screen&seconds=8',
  'screen-silent-long': 'mode=screen&seconds=20&audio=1',
  'screen-mic': 'mode=screen&seconds=8&audio=0&mic=1',
  'screen-crash': 'mode=screen&seconds=6&crash=1',
  'tab-sync': 'mode=screen&seconds=10&audio=1&analyze=1',
  'tab-silent': 'mode=screen&seconds=15&audio=0',
  'tab-mic': 'mode=screen&seconds=8&audio=0&mic=1',
  'tab-crash': 'mode=screen&seconds=6&audio=1&crash=1',
}

for (const scenario of scenarios) {
  test(`A/V probe: ${scenario} (${real ? 'real devices' : 'fake devices'})`, async ({ page, context }) => {
    test.setTimeout(120_000)
    if (scenario.startsWith('tab')) {
      const target = await context.newPage()
      await target.goto('/scripts/issue209/av-probe/target.html')
      await page.bringToFront()
    }
    await page.goto(`/scripts/issue209/av-probe/index.html?${queries[scenario]}`)
    await page.getByRole('button', { name: 'Run A/V capture probe' }).click()
    if (scenario.startsWith('tab')) {
      // Begin flashing/beeping once capture (and local-playback suppression) is live.
      await page.waitForTimeout(500)
      for (const other of context.pages()) {
        await other.evaluate(() => (window as unknown as { startFlashing?: () => void }).startFlashing?.()).catch(() => {})
      }
    }
    const result = await page.waitForFunction(() => (window as unknown as { __probe?: unknown }).__probe,
      undefined, { timeout: 110_000 }).then((handle) => handle.jsonValue())
    process.stdout.write(`ISSUE209_RESULT ${JSON.stringify({ scenario, devices: real ? 'real' : 'fake', ...result as object })}\n`)
  })
}
