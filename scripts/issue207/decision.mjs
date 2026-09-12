/** Go / no-go evaluator. An all-no-go matrix still closes Issue #207. */

import { CANDIDATES, candidateById } from './ranking.mjs'
import { FORBIDDEN_VOCABULARY, MEDIABUNNY_AUDIO_CODECS, MEDIABUNNY_VIDEO_CODECS } from './protocol.mjs'

const NAMED_AUDIO = new Set(['pcm-s16', 'mp3', 'flac', 'vorbis'])

function codecsNamed(probe, names) {
  const found = new Set((probe?.tracks ?? []).map((track) => track.codec).filter(Boolean))
  return names.filter((name) => found.has(name))
}

function trackCodecs(probe) {
  return (probe?.tracks ?? []).map((track) => track.codec)
}

export function evaluateCandidate(id, evidence) {
  const candidate = candidateById(id)
  const probes = evidence.demux?.[id] ?? evidence.demux ?? {}
  if (candidate.id === 'honesty-audio') {
    const files = {
      'pcm-s16.wav': 'pcm-s16',
      'mp3.mp3': 'mp3',
      'flac.flac': 'flac',
      'vorbis.ogg': 'vorbis',
    }
    const named = Object.entries(files)
      .filter(([name, codec]) => codecsNamed(probes[name], [codec]).length > 0)
      .map(([, codec]) => codec)
    const browser = evidence.browser?.fixtures ?? {}
    const decoded = Object.keys(files).filter((name) => {
      const cell = browser[name]
      return cell?.decode?.ok === true || probes[name]?.tracks?.some((track) => track.canDecode)
    })
    const demuxed = named.length === 4
    return {
      id,
      recommendation: demuxed ? 'bounded-child' : 'no-go',
      reason: demuxed
        ? 'Mediabunny already names WAVE PCM, MP3, FLAC, and OGG Vorbis. The child issue is documentation, fixtures, and Media Pool copy only — no new decoder, README claim, or export pair. Native decode remains a per-host matrix cell.'
        : `Honesty-audio did not demux all four named families (named=${named.join(',') || 'none'}).`,
      reopen: [
        'Do not ship a format claim until a child issue adds fixtures plus browser evidence and copy.',
        'Keep import and export independent: WAV delivery (#204) is not an import-support claim.',
      ],
      observations: { named, decoded },
      childShape: candidate.childShape,
    }
  }

  if (candidate.id === 'mpeg-ts-mov') {
    const mov = probes['avc-aac.mov']
    const ts = probes['avc-aac.ts']
    const mpeg2 = probes['mpeg2-aac.ts']
    const movOk = trackCodecs(mov).includes('avc') && trackCodecs(mov).includes('aac')
    const tsOk = trackCodecs(ts).includes('avc') && trackCodecs(ts).includes('aac')
    const mpeg2VideoNamed = trackCodecs(mpeg2).includes('mpeg2')
    const mpeg2VideoPresent = (mpeg2?.tracks ?? []).some((track) => track.kind === 'video')
    return {
      id,
      recommendation: movOk || tsOk ? 'bounded-child' : 'no-go',
      reason: [
        movOk ? 'QTFF/MOV already names AVC+AAC.' : 'MOV did not name AVC+AAC.',
        tsOk ? 'MPEG-TS already names AVC+AAC.' : 'MPEG-TS did not name AVC+AAC.',
        mpeg2VideoNamed
          ? 'Unexpected: MPEG-2 received a codec id.'
          : mpeg2VideoPresent
            ? 'MPEG-2 video appeared as an unnamed track.'
            : 'MPEG-2 video was omitted from MPEG-TS tracks rather than reported. Do not advertise MPEG-TS generally.',
      ].join(' '),
      reopen: [
        'A child may document MOV/MPEG-TS wrapping of already-named codecs and optionally report omitted TS streams.',
        'A child must not add MPEG-2, remote HLS, or a second demuxer.',
      ],
      observations: {
        movOk,
        tsOk,
        mpeg2VideoNamed,
        mpeg2VideoPresent,
        mpeg2TrackCodecs: trackCodecs(mpeg2),
      },
      childShape: candidate.childShape,
    }
  }

  if (candidate.paperVocabularyBlock) {
    const named = FORBIDDEN_VOCABULARY.filter((token) => (
      MEDIABUNNY_VIDEO_CODECS.includes(token) || MEDIABUNNY_AUDIO_CODECS.includes(token)
    ))
    const leaked = Object.values(probes).flatMap((probe) => trackCodecs(probe)).filter((codec) => (
      codec && FORBIDDEN_VOCABULARY.some((token) => String(codec).toLowerCase().includes(token))
    ))
    return {
      id,
      recommendation: 'no-go',
      reason: `Blocked at Mediabunny 1.50.9 vocabulary (${(candidate.blockedNames ?? []).join(', ')}). CustomVideoDecoder.supports() only receives the closed VideoCodec union, so a Myrelith-only decoder cannot hook these ids. No WASM spike was run.`,
      reopen: [
        'A reviewed Mediabunny upgrade that names the codec and maps demux packets.',
        'Decoder-only, locally bundled, lazy, realm-registered, budgeted, cancellable, license-reviewed.',
        'Independent import vs export; no encoder fallback; no unrestricted FFmpeg.',
      ],
      observations: { vocabularyLeak: named, probeLeak: leaked },
      childShape: null,
    }
  }

  if (candidate.id === 'hevc-software-fallback') {
    const native = evidence.browser?.fixtures?.['hevc-aac.mp4']?.decode
    return {
      id,
      recommendation: 'no-go',
      reason: 'HEVC is already native-gated. There is no reviewed Mediabunny HEVC fallback family. A software WASM decoder would be a new payload, must not substitute a different export codec, and is not justified by demand evidence (no analytics).',
      reopen: [
        'Proven demand on hosts whose native HEVC canDecode is false.',
        'A pinned, license-reviewed, lazy decoder module under the AC-3 size neighborhood unless a new budget is accepted.',
        'Export remains native-only; no HEVC substitution.',
      ],
      observations: { nativeDecode: native ?? null },
      childShape: null,
    }
  }

  if (candidate.id === 'ac3-prores-encode') {
    const encode = evidence.browser?.encoders ?? {}
    const productImportsEncoder = evidence.product?.registersAc3Encoder === true
    return {
      id,
      recommendation: 'no-go',
      reason: 'ARCHITECTURE.md and Issue #16 forbid local encoder fallbacks. @mediabunny/ac3 encoder registration is not a product encode path. ProRes has no encoder in the pinned package set.',
      reopen: [
        'A separate architecture decision that revises the native-only export contract.',
        'License, size, lifecycle, and semantic gates from Issue #16.',
      ],
      observations: { encode, productImportsEncoder },
      childShape: null,
    }
  }

  throw new Error(`No evaluator for ${id}`)
}

export function evaluateAll(evidence) {
  return CANDIDATES.map((candidate) => evaluateCandidate(candidate.id, evidence))
}

export function boundedChildCount(decisions) {
  return decisions.filter((entry) => entry.recommendation === 'bounded-child').length
}
