import { Buffer } from 'node:buffer'
import { expect, test, type Page } from '@playwright/test'

const VISIBLE_CLIP_ID = 'visible-linked-clip'
const OFFSCREEN_CLIP_ID = 'offscreen-linked-clip'

function collectPageProblems(page: Page, problems: string[]): void {
  page.on('console', (message) => {
    if (message.type() === 'warning' || message.type() === 'error') {
      problems.push(`${message.type()}: ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => {
    problems.push(`pageerror: ${error.message}`)
  })
}

function clipFixture(id: string, startFrame: number) {
  return {
    id,
    assetId: 'linked-av-source',
    name: 'linked-offline.mov',
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: 120 },
    sourceTimeMap: {
      sourceStartTicks: 0,
      sourceDurationTicks: 120_000_000,
      rate: { numerator: 1, denominator: 1 },
      speedCurve: { originFrame: 0, points: [] },
    },
    timelineRange: { startFrame, durationFrames: 120 },
    transform: {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    },
    opacity: 1,
    blendMode: 'normal',
    volume: 1,
    lensCorrection: null,
    visual: {
      crop: { left: 0, right: 0, top: 0, bottom: 0 },
      flipHorizontal: false,
      flipVertical: false,
      scaleLocked: true,
    },
    audio: {
      enabled: true,
      balance: 0,
      fadeInFrames: 0,
      fadeOutFrames: 0,
    },
    animation: { tracks: [], effectTracks: [] },
    effects: [],
    linkGroupId: 'offscreen-linked-pair',
  }
}

function trackFixture(
  id: string,
  kind: 'video' | 'audio',
  clips: object[],
  hidden = false,
) {
  return {
    id,
    kind,
    name: id,
    clips,
    transitions: [],
    hidden,
    muted: false,
    solo: false,
    locked: false,
  }
}

function linkedProjectFixture(hiddenVideoPartner = false): string {
  const durationMicroseconds = 4_000_000
  return JSON.stringify({
    format: 'myrelith-project',
    formatVersion: 5,
    document: {
      schemaVersion: 16,
      id: 'offscreen-linked-preview-doc',
      name: 'Offscreen linked preview',
      frameRate: { num: 30, den: 1 },
      width: 1_920,
      height: 1_080,
      audioSampleRate: 48_000,
      tracks: [
        trackFixture(
          'V1',
          'video',
          [clipFixture(
            hiddenVideoPartner ? OFFSCREEN_CLIP_ID : VISIBLE_CLIP_ID,
            hiddenVideoPartner ? 20_000_000 : 100,
          )],
          hiddenVideoPartner,
        ),
        trackFixture('V2', 'video', []),
        trackFixture('V3', 'video', []),
        trackFixture('V4', 'video', []),
        trackFixture('A1', 'audio', [clipFixture(
          hiddenVideoPartner ? VISIBLE_CLIP_ID : OFFSCREEN_CLIP_ID,
          hiddenVideoPartner ? 100 : 20_000_000,
        )]),
        trackFixture('A2', 'audio', []),
        trackFixture('A3', 'audio', []),
        trackFixture('A4', 'audio', []),
      ],
      markers: [],
      captionTracks: [],
    },
    assets: [{
      id: 'linked-av-source',
      fileName: 'linked-offline.mov',
      mimeType: 'video/quicktime',
      size: 1_024,
      lastModified: 1_725_000_000_000,
      kind: 'video',
      durationMicroseconds,
      sourceBounds: {
        video: { status: 'exact', firstTimestampUs: 0, endTimestampUs: durationMicroseconds },
        audio: { status: 'exact', firstTimestampUs: 0, endTimestampUs: durationMicroseconds },
      },
      nativeFrameRate: { num: 30, den: 1 },
      width: 1_920,
      height: 1_080,
      hasAudio: true,
      audioSampleRate: 48_000,
      audioChannels: 2,
    }],
    collections: [],
  })
}

test('offscreen linked clip joins a live keyboard trim preview', async ({ page }) => {
  const problems: string[] = []
  collectPageProblems(page, problems)
  const serialized = linkedProjectFixture()
  await page.goto('/')
  await page.getByRole('button', { name: 'Open a project', exact: true }).click()
  await page.locator('.project-file-input').setInputFiles({
    name: 'offscreen-linked-preview.myrelith',
    mimeType: 'application/json',
    buffer: Buffer.from(serialized),
  })
  await page.getByRole('button', { name: 'Open with 1 offline', exact: true }).click()

  const visible = page.getByTestId(`clip-${VISIBLE_CLIP_ID}`)
  const offscreen = page.getByTestId(`clip-${OFFSCREEN_CLIP_ID}`)
  await expect(visible).toBeVisible()
  await expect(offscreen).toHaveCount(0)
  const committedStyle = await visible.getAttribute('style')

  await visible.focus()
  await visible.press('[')
  await visible.press('ArrowRight')

  await expect(offscreen).toHaveCount(1)
  await expect(offscreen).toHaveAttribute('data-virtual-gesture-host', 'true')
  await expect(offscreen).toHaveClass(/dragging/)
  await expect(offscreen).toHaveCSS('width', '1px')
  await expect(visible.locator('.clip-edit-badge')).toHaveText('trim-start +1')

  await visible.press('Enter')

  await expect(offscreen).toHaveCount(0)
  await expect.poll(() => visible.getAttribute('style')).not.toBe(committedStyle)
  expect(problems).toEqual([])
})

test('hidden offscreen video partner remains an invisible live host', async ({ page }) => {
  const problems: string[] = []
  collectPageProblems(page, problems)
  await page.goto('/')
  await page.getByRole('button', { name: 'Open a project', exact: true }).click()
  await page.locator('.project-file-input').setInputFiles({
    name: 'hidden-video-linked-preview.myrelith',
    mimeType: 'application/json',
    buffer: Buffer.from(linkedProjectFixture(true)),
  })
  await page.getByRole('button', { name: 'Open with 1 offline', exact: true }).click()

  const visible = page.getByTestId(`clip-${VISIBLE_CLIP_ID}`)
  const offscreen = page.getByTestId(`clip-${OFFSCREEN_CLIP_ID}`)
  await expect(visible).toBeVisible()
  await expect(offscreen).toHaveCount(0)

  await visible.focus()
  await visible.press('[')
  await visible.press('ArrowRight')

  await expect(offscreen).toHaveCount(1)
  await expect(offscreen).toHaveAttribute('data-virtual-gesture-host', 'true')
  await expect(offscreen).toHaveCSS('opacity', '0')
  await expect(offscreen).toHaveCSS('width', '1px')

  await visible.press('Escape')
  await expect(offscreen).toHaveCount(0)
  expect(problems).toEqual([])
})
