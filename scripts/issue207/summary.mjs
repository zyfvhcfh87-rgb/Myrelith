/** Markdown record for the Issue #207 measured run. Research only. */

import { PUBLIC_SUPPORT_CLAIM } from './protocol.mjs'

export function assertResearchClaim(result) {
  if (result.publicSupportClaim !== false || PUBLIC_SUPPORT_CLAIM !== false) {
    throw new Error('Issue #207 publicSupportClaim must stay false')
  }
}

export function decodeCell(cell) {
  if (!cell || cell.canRead === false) return 'unsupported'
  const video = cell.decode?.video
  const audio = cell.decode?.audio
  const issues = []
  if (video?.skipped === 'not-decodable') issues.push('video-undecodable')
  if (audio?.skipped === 'not-decodable') issues.push('audio-undecodable')
  if (video && !video.skipped && video.ok !== true) issues.push('video-seek')
  if (audio && !audio.skipped && audio.ok !== true) issues.push('audio-seek')
  if (issues.length) return `limited (${issues.join(', ')})`
  if (cell.decode?.ok) return 'ready'
  return 'limited'
}

function correctnessText(entry) {
  if (!entry) return 'n/a'
  if (entry.error) return entry.error
  if (entry.kind === 'video') {
    const rgb = (entry.rgb ?? []).join(',')
    return entry.matchesFixtureColor ? `color ${rgb} matches fixture` : `color ${rgb} missed fixture`
  }
  if (entry.kind === 'audio') {
    if (entry.finite !== true) return 'non-finite samples'
    return entry.nearSilence ? `near silence (peak ${entry.peak})` : `finite peak ${entry.peak}`
  }
  return 'n/a'
}

function sequentialText(entry) {
  if (!entry || entry.skipped) return entry?.skipped ?? 'n/a'
  if (entry.error && entry.count == null) return entry.error
  const count = entry.count ?? 0
  const extra = entry.error ? `; ${entry.error}` : ''
  return `${count} closed${entry.capped ? ', capped' : ''}${extra}`
}

function rate(value) {
  return typeof value === 'number' ? value.toFixed(1) : 'n/a'
}

function heapDelta(cell) {
  const before = cell.cdpJsHeapBefore
  const after = cell.cdpJsHeapAfter
  if (typeof before !== 'number' || typeof after !== 'number') return 'unmeasured'
  return String(after - before)
}

export function renderMarkdown(result) {
  assertResearchClaim(result)
  const lines = [
    '# Issue #207 measured run',
    '',
    `Schema \`${result.schema}\`. Host ${result.machine.platform}/${result.machine.arch}.`,
    'Firefox and Safari cells are **U** (Issue #208). `publicSupportClaim` is **false**. This run does not ship formats.',
    '',
    '## Decisions',
    '',
    '| Candidate | Recommendation |',
    '|---|---|',
  ]
  for (const decision of result.decisions) {
    lines.push(`| \`${decision.id}\` | **${decision.recommendation}** |`)
  }
  lines.push('', '## Demux (Node, Mediabunny 1.50.9)', '', '| Fixture | Format | Codecs | canDecode (Node) |', '|---|---|---|---|')
  for (const [name, probe] of Object.entries(result.demux)) {
    const codecs = (probe.tracks ?? []).map((track) => `${track.kind}:${track.codec ?? 'null'}`).join(', ') || 'none'
    const decode = (probe.tracks ?? []).map((track) => String(track.canDecode)).join(',') || 'n/a'
    lines.push(`| \`${name}\` | ${probe.format?.name ?? (probe.failClosed ? 'fail-closed' : 'unread')} | ${codecs} | ${decode} |`)
  }
  if (result.browser) {
    lines.push('', '## Chromium decode / encode', '')
    lines.push(`Host: \`${result.browser.host?.userAgent ?? 'unknown'}\`. Isolated: ${result.browser.host?.crossOriginIsolated}. HEVC observation: ${result.browser.host?.hevcHardwareObservation}. AV1 observation: ${result.browser.host?.av1HardwareObservation}. Firefox/Safari: **U**.`)
    lines.push('', '| Fixture | Direct decode | Notes |', '|---|---|---|')
    for (const [name, cell] of Object.entries(result.browser.fixtures ?? {})) {
      lines.push(`| \`${name}\` | ${decodeCell(cell)} | ${cell.format?.name ?? cell.error ?? ''} |`)
    }
    lines.push(
      '',
      '## Correctness, seek, throughput, memory',
      '',
      'Correctness checks the first closed sequential sample against the fixture: solid `#315b7d` for video, near-silence for `anullsrc` audio. Random-access seek is `getSample` at frames 0 and 15. Sequential decode walks up to one second and closes every sample before the next. JS heap is a coarse Chromium sample; native/GPU RSS stays **unmeasured**. Filmstrip and waveform stay out of this lab because they live in the production graph.',
      '',
      '| Fixture | Random seek | Sequential | Correctness | Throughput | JS heap delta | Peak owned RGBA |',
      '|---|---|---|---|---|---:|---:|',
    )
    for (const [name, cell] of Object.entries(result.browser.fixtures ?? {})) {
      const seek = [cell.decode?.video, cell.decode?.audio]
        .map((entry) => (entry?.skipped ? entry.skipped : entry?.ok === true ? 'ok' : 'miss'))
        .join(' / ')
      const sequential = `v ${sequentialText(cell.sequential?.video)}; a ${sequentialText(cell.sequential?.audio)}`
      const correctness = `v ${correctnessText(cell.correctness?.video)}; a ${correctnessText(cell.correctness?.audio)}`
      const throughput = `v ${rate(cell.throughput?.videoSamplesPerSecond)}/s; a ${rate(cell.throughput?.audioFramesPerSecond)} frames/s`
      const rgba = cell.knownResources?.peakOwnedRgbaBytes ?? 'n/a'
      lines.push(`| \`${name}\` | ${seek} | ${sequential} | ${correctness} | ${throughput} | ${heapDelta(cell)} | ${rgba} |`)
    }
    lines.push('', '## A/V sync', '')
    lines.push('Timestamp pairs compare independently decoded samples. The audio-clock rows start a muted `AudioContext`, derive an integer frame from `currentTime`, and fetch that video sample. That is not product playback.')
    lines.push('', '| Fixture | Sample timestamps | Audio clock |', '|---|---|---|')
    for (const [name, cell] of Object.entries(result.browser.fixtures ?? {})) {
      const sync = cell.avSync
      const syncText = !sync
        ? 'n/a'
        : sync.applicable
          ? (sync.withinOneFrame ? 'within one frame' : 'outside one frame')
          : `n/a (${sync.reason ?? 'missing'})`
      const clock = cell.audioClock
      let clockText = 'not requested'
      if (clock?.applicable) {
        clockText = clock.clockAdvanced
          ? `frame ${clock.derivedFrame} ${clock.withinOneFrame ? 'within one frame' : 'outside one frame'}`
          : `clock did not advance (state ${clock.audioContextState ?? 'unknown'})`
      } else if (clock?.reason && clock.reason !== 'not-requested') {
        clockText = clock.reason
      }
      lines.push(`| \`${name}\` | ${syncText} | ${clockText} |`)
    }
    lines.push('', '## Failure recovery', '')
    lines.push('Open-cancel disposes the Input while `getTracks()` is still pending. Decode-cancel closes the first sequential sample, disposes the Input, and then pulls again. Owned samples must return to zero.')
    const openCancel = result.browser.fixtures?.['avc-aac.mp4']?.cancel
    lines.push(`- Open cancel \`avc-aac.mp4\`: ${openCancel ? JSON.stringify(openCancel) : 'not run'}`)
    for (const [name, entry] of Object.entries(result.browser.recovery?.decodeCancel ?? {})) {
      lines.push(`- Decode cancel \`${name}\`: ${JSON.stringify(entry)}`)
    }
    lines.push('', '### Existing fallback path (already shipped, not a new format)', '')
    const fallbacks = result.browser.fallbacks
    if (fallbacks) {
      const proresDirect = fallbacks.direct?.prores?.tracks?.find((track) => track.kind === 'video')
      const proresAfter = fallbacks.fallback?.prores?.tracks?.find((track) => track.kind === 'video')
      const ac3Direct = fallbacks.direct?.ac3?.tracks?.find((track) => track.kind === 'audio')
      const ac3After = fallbacks.fallback?.ac3?.tracks?.find((track) => track.kind === 'audio')
      lines.push(`- ProRes direct \`canDecode\`: ${proresDirect?.nativeCanDecode}; after \`registerProresDecoder\`: ${proresAfter?.nativeCanDecode}; random-access seek: ${fallbacks.fallback?.prores?.decode?.video?.ok}; sequential: ${sequentialText(fallbacks.fallback?.prores?.sequential?.video)}`)
      lines.push(`- AC-3 direct \`canDecode\`: ${ac3Direct?.nativeCanDecode}; after \`registerAc3Decoder\`: ${ac3After?.nativeCanDecode}; random-access seek: ${fallbacks.fallback?.ac3?.decode?.audio?.ok}; sequential: ${sequentialText(fallbacks.fallback?.ac3?.sequential?.audio)}`)
      lines.push(`- Encoder registration attempted: ${fallbacks.encoderRegistration === true}`)
      lines.push(`- Register call: ${fallbacks.registerMs ?? fallbacks.compileMs} ms. First ProRes fallback measure: ${fallbacks.fallback?.prores?.durationMs ?? 'n/a'} ms. First AC-3 fallback measure: ${fallbacks.fallback?.ac3?.durationMs ?? 'n/a'} ms. Those durations include demux and decode, not a separate WASM compile timer.`)
    }
    lines.push('', '### Native encoder probes', '')
    for (const row of result.browser.encoders?.video ?? []) {
      lines.push(`- video \`${row.id}\`: ${row.supported ? 'supported' : 'unsupported'}`)
    }
    for (const row of result.browser.encoders?.audio ?? []) {
      lines.push(`- audio \`${row.id}\`: ${row.supported ? 'supported' : 'unsupported'}`)
    }
  } else {
    lines.push('', 'Browser lab skipped (`--node-only`). Chromium cells remain **U** until `npm run qa:issue207:research`.', '')
  }
  lines.push('', '## Payload sizes', '')
  for (const payload of result.sizes.payloads) {
    const bundle = payload.primaryBundle
    const detail = bundle
      ? `${bundle.bytes} bytes at \`${bundle.path}\``
      : `${payload.totalBytes} bytes on disk, no primary script`
    lines.push(`- ${payload.packageName}: ${detail} (${payload.license})`)
  }
  lines.push('', '## Left unmeasured on purpose', '')
  lines.push('- Firefox and Safari (Issue #208).')
  lines.push('- Product filmstrip, waveform, and audio-master playback. This lab does not import the production graph.')
  lines.push('- Native decoder RSS and GPU memory. Known RGBA above is the closed sample\'s display size, not process RSS.')
  lines.push('- MPEG-2, DTS, DNx, MXF, BRAW, R3D, HAP, and any WASM encoder. No spike ran.')
  return `${lines.join('\n')}\n`
}
