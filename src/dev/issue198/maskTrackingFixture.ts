/** Browser-only silent fixture; no production module imports this generator. */
import { BufferTarget, CanvasSource, Mp4OutputFormat, Output } from 'mediabunny'

/** Same deterministic texture/motion as the accepted issue-110 tracker gate. */
export async function maskTrackingVideo(): Promise<Blob> {
  const canvas = new OffscreenCanvas(160, 90), texture = new OffscreenCanvas(220, 130)
  const ctx = canvas.getContext('2d'), paint = texture.getContext('2d')
  if (!ctx || !paint) throw new Error('2D OffscreenCanvas is unavailable')
  paint.fillStyle = '#10182b'; paint.fillRect(0, 0, 220, 130)
  for (let y = 0; y < 130; y += 7) for (let x = 0; x < 220; x += 9) {
    paint.fillStyle = `hsl(${(x * 19 + y * 23) % 360} 78% ${30 + ((x + y) % 5) * 10}%)`
    paint.fillRect(x + ((y / 7) % 2) * 2, y, 6, 5)
  }
  paint.strokeStyle = '#fff4c7'; paint.lineWidth = 2; paint.strokeRect(68, 39, 50, 50)
  paint.fillStyle = '#ff4fa3'; paint.fillRect(100, 61, 5, 5)
  const target = new BufferTarget(), output = new Output({ format: new Mp4OutputFormat(), target })
  const source = new CanvasSource(canvas, { codec: 'avc', bitrate: 2_000_000, keyFrameInterval: 1 })
  output.addVideoTrack(source, { frameRate: 30 })
  let started = false, closed = false, finalized = false
  try {
    await output.start(); started = true
    for (let frame = 0; frame < 32; frame++) {
      ctx.fillStyle = frame >= 18 ? '#07090e' : '#000'; ctx.fillRect(0, 0, 160, 90)
      if (frame < 18) ctx.drawImage(texture, -24 + frame, -20)
      await source.add(frame / 30, 1 / 30)
    }
    source.close(); closed = true
    await output.finalize(); finalized = true
    if (!target.buffer?.byteLength) throw new Error('Tracking fixture is empty')
    return new Blob([target.buffer], { type: 'video/mp4' })
  } finally {
    try { if (started && !closed) source.close() }
    finally {
      if (!finalized) await output.cancel().catch(() => undefined)
      canvas.width = canvas.height = texture.width = texture.height = 0
    }
  }
}
