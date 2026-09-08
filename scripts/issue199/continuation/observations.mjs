// Reviewed product observations, prepared for a separate continuation review.
// No top-level browser work. Each selected segment requires an explicit grant.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { expect } from '@playwright/test'

export const continuationProductSource = '75b89ef6b70460a03ea99ca44d888b5ec06373ec'
const digest = (value) => createHash('sha256').update(value).digest('hex')
const TITLE = { text: 'Native curve title', kind: 'scalar', label: 'Opacity', owner: 'root-text' }
const VIDEO = { text: 'Offline video with held mask', kind: 'scalar', label: 'Opacity', owner: 'ordinary-video' }
const ADJUSTMENT = { text: 'Adjustment color', kind: 'scalar', label: 'Opacity', owner: 'adjustment' }
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function helpers(h) {
  const { page, settled, report } = h
  assert.equal(report.productSource, continuationProductSource, 'Continuation source differs from reviewed product')
  const workspace = () => page.getByRole('region', { name: 'Animation workspace', exact: true })
  const button = (name) => workspace().getByRole('button', { name, exact: true })
  const grid = () => page.getByRole('grid', { name: 'Animation keys', exact: true })
  const keyField = () => page.getByTestId('animation-key-frame')
  const glyph = (label, frame) => grid().getByRole('gridcell', { name: `${label}, local frame ${frame}`, exact: true })
  const handle = (which) => page.getByRole('button', { name: `Drag Bézier handle ${which}; numeric alternatives in key controls`, exact: true })

  async function peek() {
    return page.evaluate(() => {
      const q = window.__animationQA, d = q.document.getState(), t = q.transport.getState()
      return { past: d.past.length, future: d.future.length, activeSequenceId: d.activeSequenceId,
        focus: t.animationFocus, selection: t.animationSelection, lane: t.animationFocusedLane,
        playhead: t.playheadFrame, playing: t.isPlaying, preview: !!t.animationPreview,
        previewSelection: t.animationPreview?.selection, easing: t.animationPreview?.easing,
        effectOwner: t.effectDocumentPreview?.owner ?? null, origin: t.timelineOriginFrame,
        zoom: t.zoom, range: t.animationVisibleRange, status: t.animationStatus.message,
        clipboard: q.animation?.getClipboard() ?? null }
    })
  }
  async function remember(name) {
    return page.evaluate((name) => {
      const q = window.__animationQA, d = q.document.getState()
      q.checkpoints ??= {}
      q.checkpoints[name] = { project: d.project, past: d.past, future: d.future, clipboard: q.animation?.getClipboard() }
      const names = Object.keys(q.checkpoints)
      while (names.length > 4) delete q.checkpoints[names.shift()]
      return { past: d.past.length, future: d.future.length }
    }, name)
  }
  async function unchanged(name, { history = true, clipboard = true } = {}) {
    const facts = await page.evaluate(({ name, history, clipboard }) => {
      const q = window.__animationQA, d = q.document.getState(), p = q.checkpoints[name]
      return { project: d.project === p.project, history: !history || d.past === p.past && d.future === p.future,
        clipboard: !clipboard || q.animation?.getClipboard() === p.clipboard }
    }, { name, history, clipboard })
    assert.deepEqual(facts, { project: true, history: true, clipboard: true }, `${name}: immutable document/history/clipboard changed`)
  }
  async function sameProjectPayload(name) {
    const pair = await page.evaluate((name) => ({ before: window.__animationQA.checkpoints[name].project, after: window.__animationQA.document.getState().project }), name)
    assert.deepEqual(pair.after, pair.before, `${name}: reconstructed project payload differs`)
  }
  async function bounds(label) {
    const facts = await page.evaluate(() => ({
      rows: document.querySelectorAll('[data-animation-lane]').length,
      glyphs: document.querySelectorAll('[data-animation-glyph]').length,
      ghosts: document.querySelectorAll('.animation-key-ghost').length,
      samples: [...document.querySelectorAll('[data-curve-samples]')].map((node) => Number(node.getAttribute('data-curve-samples'))),
      viewport: innerWidth, width: document.documentElement.scrollWidth,
      activeDescendant: document.querySelector('[role="grid"][aria-label="Animation keys"]')?.getAttribute('aria-activedescendant'),
      focusedDescription: document.getElementById('animation-focused-description')?.textContent,
    }))
    assert.ok(facts.rows <= 40 && facts.glyphs <= 512 && facts.samples.every((count) => count <= 256), `${label}: structural bounds`)
    assert.ok(facts.width <= facts.viewport + 1, `${label}: document overflow`)
    report.observations.push({ name: label, structural: facts })
    return facts
  }
  async function measured(name, action) {
    const started = performance.now(); const value = await action(); await settled()
    report.observations.push({ name, milliseconds: performance.now() - started, qualification: 'Raw wall time including native automation and settling; no threshold, pure-index time or heap claim.' })
    return value
  }
  async function openDock() {
    if (!(await workspace().count())) await page.getByRole('button', { name: 'Animation', exact: true }).click()
    await expect(workspace()).toBeVisible(); await settled()
  }
  async function filter({ text = '', kind = 'all', animated = true, selected = false } = {}) {
    await workspace().getByRole('textbox', { name: 'Filter animation lanes' }).fill(text)
    await workspace().getByRole('combobox', { name: 'Animation lane kind' }).selectOption(kind)
    await workspace().getByRole('checkbox', { name: 'Animated only', exact: true }).setChecked(animated)
    await workspace().getByRole('checkbox', { name: 'Selected items', exact: true }).setChecked(selected)
    await settled()
  }
  async function focusLane(options) {
    await openDock(); await button('Dope sheet').click(); await filter(options)
    const row = grid().getByRole('rowheader', { name: new RegExp(`, ${escape(options.label)}, \\d+ keys(?:,|$)`) })
    await expect(row).toHaveCount(1); await row.click(); await grid().press('Home'); await settled()
    const at = await peek(); if (options.owner) assert.equal(at.focus.lane.owner.id, options.owner)
    await button('Fit keys').click(); await settled()
  }
  async function nativeField(testId, value) {
    const field = page.getByTestId(testId); await field.fill(String(value)); await field.press('Enter'); await settled()
    return field
  }
  async function assertFocused(frame, owner) {
    const at = await peek(); assert.equal(at.focus.frame, frame)
    if (owner) assert.equal(at.focus.lane.owner.id, owner)
    await expect(keyField()).toHaveValue(String(frame))
    const active = await bounds(`exact focus ${owner ?? ''}:${frame}`)
    assert.equal(active.activeDescendant, 'animation-focused-description')
    assert.ok(active.focusedDescription.includes(`local frame ${frame}`))
  }
  async function undoTo(name) {
    await grid().focus(); await grid().press('ControlOrMeta+Z'); await settled()
    await unchanged(name, { history: false, clipboard: false })
  }
  async function playhead(frame) {
    // Explicit transient scenario setup, not a claim of native playhead input.
    await page.evaluate((frame) => window.__animationQA.transport.getState().setPlayheadFrame(frame), frame)
    await settled(); assert.equal((await peek()).playhead, frame)
  }
  async function startPointer(target, dx, dy = 0, bypass = false) {
    await expect(target).toBeVisible(); const box = await target.boundingBox(); assert.ok(box)
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    await page.mouse.move(point.x, point.y)
    if (bypass) await page.keyboard.down('Alt')
    await page.mouse.down(); await page.mouse.move(point.x + dx, point.y + dy, { steps: 4 }); await settled()
    const captured = await page.evaluate(() => {
      const p = window.__animationQA.nativePointer
      return { trusted: p?.trusted, captured: p?.target.hasPointerCapture(p.id), id: p?.id, gesture: p?.gesture }
    })
    assert.equal(captured.trusted, true, 'Gesture did not begin from a trusted native event')
    assert.equal(captured.captured, true, 'Native pointer capture was not acquired')
    return { point, endPoint: { x: point.x + dx, y: point.y + dy }, box, captured, bypass }
  }
  async function loseCapture(pointer) {
    const released = await page.evaluate(() => {
      const q = window.__animationQA, p = q.nativePointer
      const before = { id: p.id, gesture: p.gesture, connected: p.target.isConnected, captured: p.target.hasPointerCapture(p.id), eventSequence: q.pointerEventSequence, captureEvents: q.pointerEvents.filter((event) => event.gesture === p.gesture && event.id === p.id && event.type === 'gotpointercapture') }
      p.target.releasePointerCapture(p.id)
      return { ...before, pendingCaptureAfterRelease: p.target.hasPointerCapture(p.id) }
    })
    report.observations.push({ name: 'Explicit capture release request', released })
    assert.equal(released.id, pointer.captured.id); assert.equal(released.gesture, pointer.captured.gesture)
    assert.equal(released.connected, true); assert.equal(released.captured, true)
    assert.equal(released.captureEvents.filter((event) => event.sameTarget && event.trusted && event.buttons === 1).length, 1, 'Expected actual trusted capture on this gesture before release')
    assert.equal(released.pendingCaptureAfterRelease, false)
    // Releasing capture clears a pending target. Process it with a real next
    // pointer event while the button stays held, before any possible up/commit.
    await page.mouse.move(pointer.endPoint.x + 1, pointer.endPoint.y, { steps: 1 })
    await settled()
    const loss = await page.evaluate((released) => {
      const q = window.__animationQA, p = q.nativePointer
      return { id: p.id, gesture: p.gesture, connected: p.target.isConnected, captured: p.target.hasPointerCapture(p.id), events: q.pointerEvents.filter((event) => event.sequence > released.eventSequence) }
    }, released)
    report.observations.push({ name: 'Native event processing after explicit capture release', loss })
    assert.equal(loss.id, released.id); assert.equal(loss.gesture, released.gesture)
    assert.equal(loss.connected, true); assert.equal(loss.captured, false)
    const current = loss.events.filter((event) => event.id === released.id && event.gesture === released.gesture)
    const lost = current.filter((event) => event.type === 'lostpointercapture' && event.sameTarget && event.trusted && event.buttons === 1)
    const moved = current.filter((event) => event.type === 'pointermove' && event.trusted && event.buttons === 1)
    assert.equal(lost.length, 1, 'Expected actual trusted lost capture on the captured element while held')
    assert.ok(moved.some((event) => event.sequence > lost[0].sequence), 'Expected a following trusted native pointer move while held')
    assert.ok(!current.some((event) => event.type === 'pointerup'), 'Capture cancellation must be checked before mouseup')
    return { released, loss }
  }
  async function releasePointer(pointer) {
    await page.mouse.up(); if (pointer.bypass) await page.keyboard.up('Alt'); await settled()
  }
  async function preparePointers() {
    await page.evaluate(() => {
      if (window.__animationQA.pointerObserversInstalled) return
      window.__animationQA.pointerObserversInstalled = true
      window.__animationQA.pointerEvents = []
      window.__animationQA.pointerEventSequence = 0
      window.__animationQA.pointerGestureSequence = 0
      document.addEventListener('pointerdown', (event) => {
        const target = event.composedPath().find((node) => node instanceof Element && node.matches('[data-animation-glyph],.animation-bezier-handle'))
        if (target) {
          const q = window.__animationQA
          q.nativePointer = { target, id: event.pointerId, trusted: event.isTrusted, gesture: ++q.pointerGestureSequence }
        }
      }, true)
      for (const type of ['gotpointercapture', 'lostpointercapture', 'pointercancel', 'pointermove', 'pointerup']) document.addEventListener(type, (event) => {
        const q = window.__animationQA, p = q.nativePointer
        if (!p || p.id !== event.pointerId) return
        const events = q.pointerEvents
        events.push({ sequence: ++q.pointerEventSequence, type, id: event.pointerId, gesture: p.gesture, trusted: event.isTrusted, sameTarget: event.target === p.target, buttons: event.buttons, x: event.clientX, y: event.clientY, target: { tag: event.target?.tagName, label: event.target?.getAttribute?.('aria-label') ?? null } })
        if (events.length > 256) events.shift()
      }, true)
    })
  }
  async function openFixture(file, offline, { expectPristine = true } = {}) {
    if (await page.getByRole('button', { name: 'Projects', exact: true }).count()) await page.getByRole('button', { name: 'Projects', exact: true }).click()
    await page.getByRole('button', { name: 'Open a project', exact: true }).click()
    await page.locator('input[type="file"][accept=".myrelith,.webcut"]').setInputFiles(file)
    await page.getByRole('button', { name: offline ? `Open with ${offline} offline` : 'Open project', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Animation', exact: true })).toBeVisible({ timeout: 30000 })
    await settled(); await h.bridge(); await preparePointers()
    if (expectPristine) assert.equal((await peek()).past, 0)
  }
  return { ...h, workspace, button, grid, keyField, glyph, handle, peek, remember, unchanged, sameProjectPayload, bounds, measured, openDock, filter, focusLane, nativeField, assertFocused, undoTo, playhead, startPointer, loseCapture, releasePointer, preparePointers, openFixture }
}

export async function prepareAnimationContinuation(h) {
  const q = helpers(h)
  await q.openFixture(join(h.fixtureRoot, 'mixed.myrelith'), 2)
  await h.page.getByTestId('clip-root-text').click(); await h.settled()
  const selected = await h.page.evaluate(() => window.__animationQA.transport.getState().selectedClipIds)
  assert.deepEqual(selected, ['root-text'])
  return { fixture: 'mixed.myrelith', nativeClipSelection: selected }
}

export async function runAnimationGestures(h) {
  const q = helpers(h), { page, step, settled, report } = q
  assert.equal(report.productSource, continuationProductSource)
  await q.preparePointers()
  await step('native key drag: exact movement, admitted preview, one release commit, undo/redo', async () => {
    await q.focusLane(TITLE); await q.grid().press('ArrowRight'); await settled(); await q.assertFocused(40, TITLE.owner)
    const before = await q.remember('key-drag'), zoom = (await q.peek()).zoom
    const pointer = await q.startPointer(q.glyph('Opacity', 40), zoom * 9, 0, true)
    await q.unchanged('key-drag'); assert.equal((await q.peek()).preview, true)
    const counts = await q.bounds('native key drag with selected ghosts'); assert.ok(counts.ghosts > 0)
    await q.releasePointer(pointer)
    const after = await q.peek(); assert.equal(after.past, before.past + 1); assert.equal(after.preview, false)
    await q.assertFocused(49, TITLE.owner); await q.undoTo('key-drag')
    await q.grid().press('ControlOrMeta+Shift+Z'); await settled(); await q.assertFocused(49, TITLE.owner)
    await q.undoTo('key-drag'); return { before, after, pointer }
  })
  for (const which of ['1', '2']) await step(`native Bézier handle ${which}: preview, one commit and exact undo`, async () => {
    await q.focusLane(TITLE); await q.button('Curve').click(); await settled()
    const before = await q.remember(`handle-${which}`)
    const pointer = await q.startPointer(q.handle(which), 12, which === '1' ? -8 : 8)
    await q.unchanged(`handle-${which}`); const preview = await q.peek()
    assert.equal(preview.preview, true); assert.equal(preview.easing.type, 'cubic-bezier')
    await q.bounds(`handle ${which} curve preview`); await q.releasePointer(pointer)
    assert.equal((await q.peek()).past, before.past + 1); assert.equal((await q.peek()).preview, false)
    await q.undoTo(`handle-${which}`); return { pointer, preview: preview.easing }
  })
  for (const target of ['key', 'handle-1', 'handle-2']) {
    for (const reason of ['escape', 'capture', 'close', 'mode', 'selection', 'viewport', 'playback', 'document', 'sequence']) {
      await step(`native ${target} cancellation: ${reason}`, async () => {
        await q.focusLane(TITLE)
        if (target === 'key') await q.grid().press('ArrowRight')
        else await q.button('Curve').click()
        await settled(); await q.playhead(1)
        // Give document-change cancellation one real, undoable UI edit.
        if (reason === 'document') { await q.button('+1f').click(); await settled() }
        const name = `${target}-${reason}`, before = await q.remember(name)
        const focus = (await q.peek()).focus.frame
        const pointer = await q.startPointer(target === 'key' ? q.glyph('Opacity', focus) : q.handle(target.at(-1)), target === 'key' ? (await q.peek()).zoom * 7 : 12, target === 'key' ? 0 : -8, target === 'key')
        await q.unchanged(name); assert.equal((await q.peek()).preview, true)
        // Cancellation shortcuts should not inherit the drag's optional snap modifier.
        if (pointer.bypass) { await page.keyboard.up('Alt'); pointer.bypass = false }
        if (reason === 'escape') await q.grid().press('Escape')
        if (reason === 'capture') await q.loseCapture(pointer)
        if (reason === 'close') { await q.button('Back to Timeline').focus(); await q.button('Back to Timeline').press('Enter') }
        if (reason === 'mode') { const toggle = q.button(target === 'key' ? 'Curve' : 'Dope sheet'); await toggle.focus(); await toggle.press('Enter') }
        if (reason === 'selection') await q.grid().press(target === 'key' ? 'Home' : 'End')
        if (reason === 'viewport') await q.grid().press('+')
        if (reason === 'playback') {
          const play = page.getByRole('button', { name: 'play', exact: true }); await play.focus(); await play.press('Space')
          await expect.poll(async () => (await q.peek()).playing).toBe(true)
        }
        if (reason === 'document') await q.grid().press('ControlOrMeta+Z')
        if (reason === 'sequence') await page.getByRole('combobox', { name: 'Active sequence' }).selectOption('dormant')
        await settled(); assert.equal((await q.peek()).preview, false, 'Cancellation left an animation preview')
        if (reason === 'capture') await q.unchanged(name)
        await q.releasePointer(pointer)
        if (reason === 'document') {
          assert.equal((await q.peek()).past, before.past - 1); assert.equal((await q.peek()).future, before.future + 1)
          await q.grid().press('ControlOrMeta+Shift+Z'); await settled(); await q.unchanged(name, { history: false })
          await q.grid().press('ControlOrMeta+Z'); await settled()
        } else await q.unchanged(name)
        if (reason === 'playback') { const pause = page.getByRole('button', { name: 'pause', exact: true }); await pause.focus(); await pause.press('Space'); await settled(); assert.equal((await q.peek()).playing, false) }
        if (reason === 'sequence') await page.getByRole('combobox', { name: 'Active sequence' }).selectOption('root')
        await q.bounds(name); return { before, pointer, after: await q.peek() }
      })
    }
  }
  await step('named sibling previews restore after a captured native animation cancellation', async () => {
    await q.focusLane(TITLE); await q.grid().press('ArrowRight'); await settled(); await q.remember('siblings')
    // Explicit canonical transient setup. This observes owner restoration, not
    // native color-grading/mask authoring or the later mask-tracking integration.
    await page.evaluate(() => {
      const q = window.__animationQA, d = q.document.getState(), t = q.transport.getState()
      t.setColorGradingPreview({ sequenceId: d.activeSequenceId, effectId: 'color', params: {}, document: d.doc })
      t.setMaskPreview({ sequenceId: d.activeSequenceId, effectId: 'mask', params: {}, document: d.doc })
    })
    assert.equal((await q.peek()).effectOwner, 'mask-gesture')
    const pointer = await q.startPointer(q.glyph('Opacity', 40), (await q.peek()).zoom * 8, 0, true)
    assert.equal((await q.peek()).effectOwner, 'animation-gesture')
    await q.grid().press('Escape'); await settled(); assert.equal((await q.peek()).effectOwner, 'mask-gesture')
    await q.releasePointer(pointer)
    await page.evaluate(() => window.__animationQA.transport.getState().setMaskPreview(null))
    assert.equal((await q.peek()).effectOwner, 'color-grading')
    await page.evaluate(() => window.__animationQA.transport.getState().setColorGradingPreview(null))
    assert.equal((await q.peek()).effectOwner, null); await q.unchanged('siblings')
    return { setup: 'Canonical named transient preview APIs; three owners at frozen75b89ef' }
  })
  await step('deliberate project departure cancels captured keys before replacing the portable project', async () => {
    await q.focusLane(TITLE); await q.grid().press('ArrowRight'); await settled()
    const pointer = await q.startPointer(q.glyph('Opacity', 40), (await q.peek()).zoom * 8, 0, true)
    assert.equal((await q.peek()).preview, true)
    await page.keyboard.up('Alt'); pointer.bypass = false
    const projects = page.getByRole('button', { name: 'Projects', exact: true }); await projects.focus(); await projects.press('Enter')
    await expect(page.getByRole('button', { name: 'Open a project', exact: true })).toBeVisible()
    await q.releasePointer(pointer); await q.openFixture(join(h.fixtureRoot, 'mixed.myrelith'), 2)
    assert.equal((await q.peek()).preview, false); assert.equal((await q.peek()).clipboard, null)
    const keys = await page.evaluate(() => window.__animationQA.document.getState().doc.tracks.flatMap((track) => track.clips).find((clip) => clip.id === 'root-text').animation.tracks.find((track) => track.property === 'opacity').keyframes.map((key) => key.frame))
    assert.deepEqual(keys, [0, 40, 80]); return { reopenedOriginalKeys: keys }
  })
  report.nativePointerEvents = await page.evaluate(() => window.__animationQA.pointerEvents)
}

export async function runAnimationEditing(h) {
  const q = helpers(h), { page, step, settled } = q
  await step('720x900 native Timeline and Inspector entry keep the full Animation controls reachable', async () => {
    await page.setViewportSize({ width: 720, height: 900 }); await settled(); await q.openDock()
    await q.bounds('native compact entry'); await q.button('Back to Timeline').click(); await settled()
    await page.getByRole('tab', { name: 'Animation', exact: true }).click()
    await page.getByRole('button', { name: 'Open Animation workspace', exact: true }).click(); await settled()
    await expect(q.grid()).toBeVisible(); await q.bounds('compact Inspector entry')
    await q.button('Back to Timeline').click(); await page.setViewportSize({ width: 1440, height: 900 }); await settled()
    await expect(page.getByRole('button', { name: 'Animation', exact: true })).toBeFocused()
  })
  await step('native input select/copy/paste/undo does not trigger Animation or global document commands', async () => {
    await q.openDock(); await q.remember('input-clipboard')
    const input = q.workspace().getByRole('textbox', { name: 'Filter animation lanes' })
    await input.fill('native text'); await input.press('ControlOrMeta+A'); await input.press('ControlOrMeta+C')
    await input.fill(''); await input.press('ControlOrMeta+V'); await expect(input).toHaveValue('native text')
    await input.press('ControlOrMeta+Z'); await q.unchanged('input-clipboard'); await input.fill('')
  })
  await step('full-sequence filters, exact out-of-clip keys, Shift range and native toggle', async () => {
    await q.focusLane(VIDEO); await q.assertFocused(-150, VIDEO.owner)
    await q.remember('negative-local'); await q.nativeField('animation-key-frame', -149); await q.assertFocused(-149, VIDEO.owner); await q.undoTo('negative-local')
    await q.grid().press('End'); await q.assertFocused(200, VIDEO.owner)
    await q.remember('after-clip'); await q.nativeField('animation-key-frame', 201); await q.assertFocused(201, VIDEO.owner); await q.undoTo('after-clip')
    await q.grid().press('Home'); await q.grid().press('Shift+End'); await settled()
    assert.deepEqual((await q.peek()).selection.map((key) => key.frame), [-150, 20, 200])
    await q.focusLane(TITLE); await q.grid().press('ArrowRight'); await settled()
    await q.glyph('Opacity', 40).click({ modifiers: ['ControlOrMeta'] }); assert.equal((await q.peek()).selection.length, 0)
    await q.glyph('Opacity', 40).click({ modifiers: ['ControlOrMeta'] }); assert.equal((await q.peek()).selection.length, 1)
    await q.filter({ text: '', kind: 'all', animated: false, selected: true })
    await expect(q.grid().getByRole('rowheader')).not.toHaveCount(0)
    await q.filter({ text: 'no-such-animation-property', animated: true })
    await expect(q.grid().getByRole('rowheader')).toHaveCount(0)
    await expect(q.workspace().locator('.animation-footer')).toContainText('0 lanes')
    await expect(q.workspace().getByRole('status')).toBeVisible()
    return { negativeLocal: -150, negativeGlobal: -30, afterClipLocal: 200, clipDuration: 60, negativeGlobalCanvasClaim: false }
  })
  await step('create/value/easing/invalid drafts with native numeric input and button activation', async () => {
    await q.focusLane(TITLE); await q.playhead(15); const before = await q.remember('set-key')
    await q.button('Set key at playhead').focus(); await q.button('Set key at playhead').press('Space'); await settled()
    assert.equal((await q.peek()).past, before.past + 1); await q.assertFocused(15, TITLE.owner)
    await q.nativeField('animation-key-value', .33); await expect(page.getByTestId('animation-key-value')).toHaveValue('0.33')
    for (const preset of ['Hold', 'Linear', 'Ease in/out']) {
      await page.getByRole('combobox', { name: 'Key easing' }).selectOption(preset); await settled()
      await expect(page.getByRole('combobox', { name: 'Key easing' })).toHaveValue(preset === 'Ease in/out' ? 'Custom Bézier' : preset)
    }
    for (const [id, rejected, accepted] of [['animation-key-frame', .5, '15'], ['animation-key-value', 2, '.33'], ['animation-bezier-x1', 2, '.42']]) {
      await q.remember(`invalid-${id}`); const field = await q.nativeField(id, rejected)
      await q.unchanged(`invalid-${id}`); assert.equal(Number(await field.inputValue()), Number(accepted)); await expect(field).toBeFocused()
    }
    await q.button('Curve').click(); await settled()
    const initial = await page.locator('.animation-curve-path').getAttribute('d')
    assert.ok((initial.match(/M /g) ?? []).length >= 2, 'The existing outgoing Hold transition was connected as a ramp')
    await q.button('Vertical zoom in').click(); const zoomed = await page.locator('.animation-curve-path').getAttribute('d'); assert.notEqual(zoomed, initial)
    await q.button('Pan curve up').click(); await q.button('Pan curve down').click(); await q.button('Vertical zoom out').click(); await q.button('Fit values').click()
    await expect(page.locator('.animation-curve-path')).toHaveAttribute('d', initial)
    await q.button('Horizontal zoom in').click(); await q.button('Horizontal zoom out').click(); await q.button('Pan animation right').click(); await q.button('Pan animation left').click(); await q.button('Reset view').click(); await q.button('Fit keys').click()
    await q.bounds('numeric/easing authoring'); return { createdLocalFrame: 15, value: .33 }
  })
  await step('native keyboard moves/duplicate/delete and audio scalar values stay inside Animation', async () => {
    await q.focusLane(TITLE); const before = await q.remember('native-key-commands')
    await q.grid().press('ControlOrMeta+ArrowRight'); await q.assertFocused(1, TITLE.owner)
    await q.grid().press('ControlOrMeta+Shift+ArrowRight'); await q.assertFocused(11, TITLE.owner)
    await q.grid().press('ControlOrMeta+Shift+ArrowLeft'); await q.assertFocused(1, TITLE.owner)
    await q.grid().press('ControlOrMeta+ArrowLeft'); await q.assertFocused(0, TITLE.owner)
    await q.sameProjectPayload('native-key-commands')
    await q.grid().press('ControlOrMeta+D'); await q.assertFocused(1, TITLE.owner)
    await q.grid().press('Delete'); await q.sameProjectPayload('native-key-commands')
    assert.equal((await q.peek()).past, before.past + 6)
    for (const [label, value] of [['Volume', .55], ['Balance', .25]]) {
      await q.focusLane({ text: 'Offline clip audio', kind: 'scalar', label, owner: 'ordinary-audio' }); await q.remember(`audio-${label}`)
      await q.nativeField('animation-key-value', value); await expect(page.getByTestId('animation-key-value')).toHaveValue(String(value)); await q.undoTo(`audio-${label}`)
    }
    return { keyboardEdits: 6, audioValues: 'Actual clip Volume and Balance properties; sources offline and output muted' }
  })
  await step('held paths and unavailable/future/title-effect intent retain their own editing limits', async () => {
    await q.focusLane({ text: VIDEO.text, kind: 'path', label: 'path', owner: VIDEO.owner })
    await expect(q.button('Set key at playhead')).toBeDisabled(); await expect(page.getByTestId('animation-key-value')).toHaveCount(0)
    const before = await q.remember('held-path'); await q.button('+1f').click(); await settled(); await q.assertFocused(1, VIDEO.owner)
    assert.equal((await q.peek()).past, before.past + 1); await q.undoTo('held-path')
    await q.button('Curve').click(); await settled()
    await expect(page.locator('[data-curve-samples]')).toHaveAttribute('data-curve-samples', '0')
    await q.unchanged('held-path', { history: false })
    for (const lane of [
      { text: VIDEO.text, kind: 'scalar', label: 'future-property', owner: VIDEO.owner },
      { text: VIDEO.text, kind: 'effect', label: 'intent', owner: VIDEO.owner },
      { text: TITLE.text, kind: 'effect', label: 'exposure', owner: TITLE.owner },
    ]) {
      await q.focusLane(lane); await q.remember(`unavailable-${lane.label}`)
      await expect(q.button('Set key at playhead')).toBeDisabled(); await expect(page.getByTestId('animation-key-value')).toBeDisabled()
      await q.button('Curve').click(); await settled(); await expect(page.locator('[data-curve-samples]')).toHaveAttribute('data-curve-samples', '0')
      await q.unchanged(`unavailable-${lane.label}`)
    }
    return { titleEffectGuard: 'Unavailable on frozen75b89ef; no later helper parity claim' }
  })
  await step('complete cross-owner mapping, incompatible mapping refusal, collision refusal and undo', async () => {
    await q.focusLane(TITLE); await q.grid().press('ArrowRight'); await settled()
    await q.filter({ text: '', kind: 'scalar', animated: true })
    // Fit all scalar keys first; select through actual glyphs, preserving two owners.
    await q.button('Fit keys').click(); await settled()
    const titleRow = q.grid().getByRole('row').filter({ has: page.getByRole('rowheader', { name: /Native curve title, Opacity,/ }) })
    const videoRow = q.grid().getByRole('row').filter({ has: page.getByRole('rowheader', { name: /Offline video with held mask, Opacity,/ }) })
    await titleRow.getByRole('gridcell', { name: 'Opacity, local frame 40', exact: true }).click()
    await videoRow.getByRole('gridcell', { name: 'Opacity, local frame 20', exact: true }).click({ modifiers: ['ControlOrMeta'] })
    await q.button('Copy').click(); const copied = (await q.peek()).clipboard; assert.equal(copied.lanes.length, 2)
    await q.remember('mapping'); await q.button('Map paste…').click()
    const mapped = () => q.workspace().getByRole('button', { name: /^Paste mapped lanes/ })
    await expect(mapped()).toBeDisabled()
    await page.setViewportSize({ width: 720, height: 900 }); await settled()
    await q.button('Assign focused property').scrollIntoViewIfNeeded(); await q.bounds('compact mapping controls')
    await h.shot('compact-mapping'); await page.setViewportSize({ width: 1440, height: 900 }); await settled()
    for (let i = 0; i < copied.lanes.length; i++) {
      const source = copied.lanes[i].address.owner.id, destination = source === TITLE.owner ? VIDEO : ADJUSTMENT
      await q.focusLane(destination); await q.button('Assign focused property').click()
      if (i + 1 < copied.lanes.length) { await expect(mapped()).toBeDisabled(); await q.button('Next copied lane').click() }
    }
    await q.unchanged('mapping')
    await q.playhead(220); await expect(mapped()).toBeEnabled(); await mapped().click(); await settled()
    const result = await q.peek(); assert.equal(result.selection.length, 2)
    assert.deepEqual(result.selection.map((key) => [key.lane.owner.id, key.frame]).sort(), [[ADJUSTMENT.owner, 200], [VIDEO.owner, 100]].sort())
    const after = await q.remember('mapping-collision'); await mapped().click(); await settled(); await q.unchanged('mapping-collision')
    assert.equal((await q.peek()).past, after.past); await expect(q.workspace().getByRole('status')).toContainText(/collid|collision|already|overwrite/i)
    await q.undoTo('mapping')
    // Last copied scalar mapped to a title-kind property must reject atomically.
    await q.focusLane({ text: TITLE.text, kind: 'title', label: 'Opacity', owner: TITLE.owner })
    await q.button('Assign focused property').click(); await q.remember('incompatible-mapping'); await mapped().click(); await settled(); await q.unchanged('incompatible-mapping')
    await expect(q.workspace().getByRole('status')).toContainText(/kind|interchanged|match/i)
    await q.button('Map paste…').click(); return { copied: copied.lanes.map((lane) => ({ address: lane.address, globalFrames: lane.globalFrames })), destinationGlobalFrames: [220, 320] }
  })
  await step('title key cut/paste original time and relative paste preserve authored spacing', async () => {
    await q.focusLane({ text: TITLE.text, kind: 'title', label: 'Opacity', owner: TITLE.owner })
    await q.grid().press('Shift+End'); await settled(); const before = await q.remember('title-cut')
    await q.button('Cut').click(); await settled(); assert.equal((await q.peek()).past, before.past + 1)
    await q.button('Paste original time').click(); await settled(); await q.sameProjectPayload('title-cut')
    await q.playhead(200); await q.button('Paste').click(); await settled()
    assert.deepEqual((await q.peek()).selection.map((key) => key.frame), [200, 265])
    return { originalLocalFrames: [5, 70], relativeLocalFrames: [200, 265] }
  })
  await step('explicit clip-effect to adjustment-effect mapping preserves parameter identity and spacing', async () => {
    await q.focusLane({ ...VIDEO, kind: 'effect', label: 'Exposure' }); await q.grid().press('Shift+End'); await settled()
    await q.button('Copy').click(); const copied = (await q.peek()).clipboard
    assert.equal(copied.lanes.length, 1); assert.equal(copied.lanes[0].address.effectId, 'color')
    assert.deepEqual(copied.lanes[0].globalFrames, [120, 150])
    await q.button('Map paste…').click()
    await q.focusLane({ ...ADJUSTMENT, kind: 'effect', label: 'Exposure' }); await q.button('Assign focused property').click()
    await q.playhead(260); const before = await q.remember('effect-mapping')
    await q.workspace().getByRole('button', { name: 'Paste mapped lanes (1/1)', exact: true }).click(); await settled()
    const after = await q.peek(); assert.equal(after.past, before.past + 1)
    assert.deepEqual(after.selection.map((key) => [key.lane.owner.id, key.lane.effectId, key.lane.parameter, key.frame]), [['adjustment', 'adjust-color', 'exposure', 140], ['adjustment', 'adjust-color', 'exposure', 170]])
    await q.button('Map paste…').click(); return { originalGlobalFrames: [120, 150], destinationGlobalFrames: [260, 290], destinationLocalFrames: [140, 170] }
  })
  await step('locked track refuses native keyboard edits without replacing document/history/clipboard', async () => {
    await q.button('Back to Timeline').click(); await page.getByRole('button', { name: 'lock track V1', exact: true }).click()
    await q.focusLane(TITLE); await q.remember('locked')
    await expect(q.button('Set key at playhead')).toBeDisabled(); await expect(q.button('Delete')).toBeDisabled()
    await q.grid().press('Delete'); await q.grid().press('ControlOrMeta+ArrowRight'); await settled(); await q.unchanged('locked')
    await q.button('Back to Timeline').click(); await page.getByRole('button', { name: 'lock track V1', exact: true }).click(); await q.openDock()
  })
}

export async function runAnimationPortableRoundTrip(h, serializeCanonical) {
  const q = helpers(h), { page, step, report, out, settled } = q
  await step('canonical portable save/reopen after mixed native edits preserves complete project payload', async () => {
    // The host callback invokes the accepted pure-domain snapshot/serializer/parser,
    // using the real production project and immutable descriptors read below.
    // This is portable API/file-open coverage, not an OS save picker claim.
    const loaded = [...new Set(report.requests.filter((url) => /\/(?:mediaStore|documentStore|index)-[^/]+\.js$/.test(url)))]
    const snapshot = await page.evaluate(async (urls) => {
      const q = window.__animationQA
      for (const url of urls) for (const value of Object.values(await import(url))) {
        if (typeof value === 'function' && typeof value.getState === 'function') {
          const state = value.getState(); if (state.descriptors instanceof Map && state.assets instanceof Map && Array.isArray(state.collections)) q.media = value
        }
      }
      if (!q.media) throw new Error('Already-loaded production media-store export unavailable')
      const media = q.media.getState()
      return { project: q.document.getState().project, assets: [...media.descriptors.values()], collections: media.collections }
    }, loaded)
    const video = snapshot.project.sequences.find((sequence) => sequence.id === 'root').tracks.flatMap((track) => track.clips).find((clip) => clip.id === VIDEO.owner)
    const negative = video.animation.tracks.find((track) => track.property === 'opacity').keyframes.find((key) => key.frame === -150)
    assert.equal(negative.sourceTimeTicks, -150000000, 'Canonical negative source-time intent is missing before save')
    assert.equal(video.sourceTimeMap.sourceDurationTicks, 60000000)
    const serialized = await serializeCanonical(snapshot)
    const file = join(out, 'animation-authored-roundtrip.myrelith'); writeFileSync(file, serialized)
    report.portableRoundTrip = { file, sha256: digest(serialized), bytes: Buffer.byteLength(serialized), source: continuationProductSource, sourceTimeIntent: { negativeLocalFrame: negative.frame, negativeSourceTimeTicks: negative.sourceTimeTicks, sourceTimeMap: video.sourceTimeMap }, method: 'Canonical domain APIs followed by real portable file-open UI; no OS picker assertion' }
    await q.openFixture(file, 2)
    const reopened = await page.evaluate(() => window.__animationQA.document.getState().project)
    assert.deepEqual(reopened, snapshot.project, 'Portable reopen changed authored/unknown/path/source payload')
    await q.openDock(); await q.focusLane(VIDEO); await q.assertFocused(-150, VIDEO.owner)
    await page.getByRole('combobox', { name: 'Active sequence' }).selectOption('dormant'); await settled()
    assert.equal((await q.peek()).activeSequenceId, 'dormant')
    await page.getByRole('combobox', { name: 'Active sequence' }).selectOption('root'); await settled()
    await h.shot('portable-roundtrip'); return report.portableRoundTrip
  })
}

export async function runAnimationLargeDocuments(h, supplemental) {
  const q = helpers(h), { page, step, report, settled, fixtureRoot } = q
  assert.equal(supplemental.productSource, continuationProductSource)
  for (const [name, facts] of Object.entries(supplemental.files)) assert.equal(digest(readFileSync(join(supplemental.directory, name))), facts.sha256, name)
  await step('100000-key fixture: cold entry, exact1024-key navigation and selected/all limits', async () => {
    await q.measured('100000 keys portable open', () => q.openFixture(join(supplemental.directory, 'dense-scalar.myrelith'), 1))
    await q.measured('100000 keys first dock/index/render wall time', () => q.openDock())
    await q.filter({ animated: true }); await q.bounds('100000 initial rows and glyphs')
    await expect(q.workspace().locator('.animation-footer')).toContainText('100000 keys')
    await q.focusLane({ text: 'Dense exact navigation', kind: 'scalar', label: 'Opacity', owner: 'dense-clip' })
    await q.grid().press('End'); await q.assertFocused(1023, 'dense-clip')
    await q.grid().press('Shift+Home'); assert.equal((await q.peek()).selection.length, 1024)
    await q.filter({ animated: true }); const previous = (await q.peek()).selection
    await q.grid().press('ControlOrMeta+A'); assert.deepEqual((await q.peek()).selection, previous)
    await expect(q.workspace().getByRole('status')).toContainText('4,096')
    await q.remember('dense-ticks')
    for (let frame = 0; frame < 10; frame++) await q.playhead(frame)
    await q.unchanged('dense-ticks'); await q.bounds('100000 after ten playhead ticks')
    report.observations.push({ name: 'Index reuse qualification', note: 'Unmodified production has no public build counter. Browser confirms stable document/DOM bounds; exact no-rebuild count remains the committed component spy evidence, not a browser measurement.' })
  })
  await step('100000 keys: warm filter/scroll/curve and native preview/commit bounds', async () => {
    for (let repeat = 0; repeat < 3; repeat++) {
      await q.measured(`warm changed filter lane-${9 - repeat}`, () => q.filter({ text: `lane-${9 - repeat}`, kind: 'effect', animated: true }))
      await q.bounds(`warm filter ${repeat + 1}`)
    }
    await q.filter({ kind: 'effect', animated: true }); await q.grid().getByRole('rowheader').first().click(); await q.grid().press('End'); await settled()
    const exact = (await q.peek()).focus
    await q.measured('warm native vertical wheel', async () => { await q.grid().hover(); await page.mouse.wheel(0, 5000) })
    await q.bounds('focused row pinned beyond virtual window'); assert.deepEqual((await q.peek()).focus, exact)
    await q.focusLane({ text: 'Dense exact navigation', kind: 'scalar', label: 'Opacity', owner: 'dense-clip' })
    await q.grid().press('End'); await q.button('Curve').click(); await settled()
    const curve = await q.bounds('1024-key available scalar curve'); assert.ok(curve.samples[0] > 0)
    await page.setViewportSize({ width: 720, height: 900 }); await settled(); await q.bounds('compact dense scalar curve')
    await q.button('Vertical zoom in').click(); await q.button('Vertical zoom out').click(); await q.button('Fit values').click(); await q.bounds('dense vertical zoom/reset')
    await page.setViewportSize({ width: 1440, height: 900 }); await settled()
    await q.button('Dope sheet').click(); await q.grid().press('Home'); await q.grid().press('Shift+End'); await settled()
    const before = await q.remember('dense-preview')
    // A single selected bucket can represent multiple keys; retain the complete
    //1024-key native range and drag its visible last bucket with Alt bypass.
    const bucket = q.grid().locator('.is-focused [data-animation-glyph][aria-selected="true"]').last()
    const zoom = (await q.peek()).zoom
    let pointer
    await q.measured('1024-selected native preview in100000-key project', async () => { pointer = await q.startPointer(bucket, Math.max(4, zoom * 10), 0, true) })
    await q.unchanged('dense-preview'); assert.equal((await q.peek()).preview, true)
    await q.bounds('dense selected ghosts included in512')
    await q.measured('1024-selected native release commit', () => q.releasePointer(pointer))
    assert.equal((await q.peek()).past, before.past + 1); assert.equal((await q.peek()).selection.length, 1024)
    await q.bounds('dense after release'); await q.undoTo('dense-preview')
  })
  await step('1280 dormant lanes plus1000 empty distant owners: far origins and pinned exact focus', async () => {
    await q.measured('1280 lanes and1000 empty owners portable open', () => q.openFixture(join(fixtureRoot, 'many-lanes.myrelith'), 1))
    await q.measured('many-owner first dock/index/render wall time', () => q.openDock())
    await q.filter({ kind: 'effect', animated: true })
    await expect(q.grid()).toHaveAttribute('aria-rowcount', '1280')
    await q.grid().getByRole('rowheader').first().click(); await q.grid().press('End'); await settled(); await q.assertFocused(1000000, 'dense-clip')
    await q.button('Reset view').click(); await q.grid().press('End'); await settled()
    const at = await q.peek(); assert.ok(Number.isSafeInteger(at.origin) && at.origin >= 0)
    assert.ok(at.range.startFrame <= 1000000 && at.range.endFrame >= 1000000)
    await q.grid().hover(); await page.mouse.wheel(0, 100000); await settled(); await q.bounds('1280-lane bottom with pinned focused row')
    await q.assertFocused(1000000, 'dense-clip'); await q.grid().press('Home'); await q.assertFocused(-100, 'dense-clip')
    await q.filter({ text: 'empty-999', kind: 'scalar', animated: false })
    await q.grid().getByRole('rowheader').first().click(); await q.grid().press('ArrowDown'); await settled()
    const far = await q.peek(); assert.ok(far.range.startFrame > 9000000, 'Distant nonanimated owner was not revealed')
    assert.ok(Number.isSafeInteger(far.origin)); await q.bounds('distant empty owner')
    await h.shot('many-lanes-far-owner'); return { dormantFocus: at, far }
  })
}
