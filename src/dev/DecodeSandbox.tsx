/**
 * dev/DecodeSandbox.tsx — TEMPORARY Phase 2.5 scratch harness. Not shipped;
 * deleted once the real Preview/Timeline UI exists (Phase 3).
 *
 * Purpose: validate the decode pipeline (demux → chunks → worker → canvas)
 * in isolation, wired STRAIGHT to pipeline/ and engine/ — deliberately
 * bypassing every store. The dependency rules for ui/ do not apply to dev/.
 *
 * Manual gate (plan §2.5) runs here: scrub smoothness, flat memory,
 * zero unclosed-VideoFrame warnings, fast backward stepping.
 *
 * Implementation notes:
 * - transferControlToOffscreen() works ONCE per canvas element, so each
 *   loaded file gets a brand-new imperative <canvas> (also dodges React
 *   StrictMode double-effects entirely — setup runs in the event handler).
 * - Scrub events are coalesced to one renderFrameAt per animation frame;
 *   the bridge + worker handle superseding on top of that.
 */

import { useEffect, useRef, useState } from 'react'
import type { MediaAsset } from '../domain/schema'
import { createChunkSource } from '../pipeline/decode'
import { deserializeDecoderConfig, loadAsset } from '../pipeline/demux'
import type { RenderResult } from '../engine/worker-bridge'
import { createDecodeWorker, DecodeWorkerBridge } from '../engine/worker-bridge'

export default function DecodeSandbox() {
  const canvasHostRef = useRef<HTMLDivElement>(null)
  const bridgeRef = useRef<DecodeWorkerBridge | null>(null)
  const latestFrameRef = useRef(0)
  const rafPendingRef = useRef(false)

  const [asset, setAsset] = useState<MediaAsset | null>(null)
  const [codec, setCodec] = useState('')
  const [status, setStatus] = useState('pick a video file to begin (H.264 MP4 recommended)')
  const [error, setError] = useState<string | null>(null)
  const [frame, setFrame] = useState(0)
  const [lastRender, setLastRender] = useState<RenderResult | null>(null)

  // Dispose the worker only when the whole sandbox unmounts.
  useEffect(() => () => bridgeRef.current?.dispose(), [])

  /** Coalesce scrub events: at most one renderFrameAt per animation frame. */
  function requestRender(targetFrame: number): void {
    latestFrameRef.current = targetFrame
    if (rafPendingRef.current) return
    rafPendingRef.current = true
    requestAnimationFrame(() => {
      rafPendingRef.current = false
      const bridge = bridgeRef.current
      if (!bridge) return
      void bridge.renderFrameAt(latestFrameRef.current).then((result) => {
        if (result.status !== 'superseded') setLastRender(result)
        if (result.status === 'error' && result.message) setError(result.message)
      })
    })
  }

  function stepBy(delta: number): void {
    if (!asset) return
    const next = Math.min(Math.max(0, frame + delta), asset.durationFrames - 1)
    setFrame(next)
    requestRender(next)
  }

  async function handleFile(file: File): Promise<void> {
    // Tear down any previous session; every file gets a fresh canvas+worker.
    bridgeRef.current?.dispose()
    bridgeRef.current = null
    canvasHostRef.current?.replaceChildren()
    setAsset(null)
    setError(null)
    setLastRender(null)
    setFrame(0)

    try {
      setStatus(`demuxing ${file.name}…`)
      const loaded = await loadAsset(file)
      if (!loaded.videoTrack) throw new Error('file has no video track')
      if (!loaded.asset.frameRate) throw new Error('could not detect a frame rate')
      if (!loaded.asset.decoderConfigB64) throw new Error('no decoder config (unsupported codec?)')

      const config = deserializeDecoderConfig(loaded.asset.decoderConfigB64)
      setCodec(config.codec)

      const canvas = document.createElement('canvas')
      canvas.style.maxWidth = '100%'
      canvas.style.maxHeight = '60vh'
      canvas.style.background = '#000'
      canvas.style.border = '1px solid #333'
      canvasHostRef.current?.replaceChildren(canvas)

      setStatus(`configuring decoder (${config.codec})…`)
      const bridge = new DecodeWorkerBridge(createDecodeWorker())
      bridge.setSource(
        loaded.asset.frameRate,
        createChunkSource(loaded.videoTrack, loaded.asset.frameRate),
      )
      bridge.onWorkerError = (message) => setError(message)
      bridge.init(canvas.transferControlToOffscreen())
      await bridge.configure(config)

      bridgeRef.current = bridge
      setAsset(loaded.asset)
      setStatus('ready — scrub away!')
      requestRender(0)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('failed')
    }
  }

  const mono: React.CSSProperties = { fontFamily: 'ui-monospace, monospace' }

  return (
    <div
      style={{
        fontFamily: 'system-ui, sans-serif',
        background: '#141414',
        color: '#e8e8e8',
        minHeight: '100vh',
        padding: 24,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <h1 style={{ margin: 0, fontSize: 18 }}>
        WebCut DecodeSandbox <small style={{ color: '#888' }}>(temporary Phase 2.5 harness)</small>
      </h1>

      <input
        type="file"
        accept="video/*,.mp4,.mov,.mkv,.webm"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void handleFile(file)
        }}
      />

      <div style={{ color: error ? '#ff7b7b' : '#9ad29a', ...mono }}>
        {error ? `error: ${error}` : status}
      </div>

      {asset && (
        <div style={{ color: '#aaa', fontSize: 13, ...mono }}>
          {asset.fileName} · {asset.width}×{asset.height} ·{' '}
          {asset.frameRate ? `${asset.frameRate.num}/${asset.frameRate.den} fps` : '? fps'} ·{' '}
          {asset.durationFrames} frames · {codec}
        </div>
      )}

      <div ref={canvasHostRef} />

      {asset && (
        <>
          <input
            type="range"
            min={0}
            max={Math.max(0, asset.durationFrames - 1)}
            value={frame}
            onChange={(e) => {
              const f = Number(e.target.value)
              setFrame(f)
              requestRender(f)
            }}
            style={{ width: '100%' }}
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', ...mono }}>
            <button onClick={() => stepBy(-1)}>◀ −1 frame</button>
            <button onClick={() => stepBy(1)}>+1 frame ▶</button>
            <span>frame {frame}</span>
            {lastRender && (
              <span style={{ color: '#888' }}>
                {' · '}
                {lastRender.status}
                {lastRender.status === 'drawn' && (
                  <>
                    {' '}
                    in {lastRender.decodeMs.toFixed(1)}ms
                    {lastRender.decodeMs < 2 ? ' ⚡ (cache)' : ''}
                  </>
                )}
              </span>
            )}
          </div>
        </>
      )}

      <p style={{ color: '#666', fontSize: 12, maxWidth: 640 }}>
        Gate checks: scrub the slider hard for a minute, watch DevTools →
        Console for VideoFrame warnings (must be zero), take heap snapshots
        before/after (memory must return to baseline), and hold "−1 frame"
        (must stay instant thanks to the ring buffer).
      </p>
    </div>
  )
}
