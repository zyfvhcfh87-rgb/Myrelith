export const PERFORMANCE_ARTIFACT_SCHEMA_VERSION = 2 as const
export const PERFORMANCE_HARNESS_VERSION = 'issue-54-v3' as const

export type PerformanceMetricId =
  | 'launcher-interactive-ms'
  | 'editor-first-usable-frame-ms'
  | 'scrub-input-to-present-ms'
  | 'frame-render-ms'
  | 'dropped-frames'
  | 'audio-underruns'
  | 'import-readiness-ms'
  | 'memory-plateau-mib'
  | 'memory-growth-kib-per-batch'
  | 'export-real-time-ratio'

export type PerformanceMetricUnit =
  | 'ms'
  | 'count'
  | 'MiB'
  | 'KiB/batch'
  | 'ratio'

export interface DistributionSummary {
  readonly count: number
  readonly minimum: number
  readonly maximum: number
  readonly mean: number
  readonly median: number
  readonly p75: number
  readonly p95: number
  /** Population variance, in the square of the metric's unit. */
  readonly variance: number
  readonly standardDeviation: number
}

export interface MeasuredPerformanceMetric {
  readonly status: 'measured'
  readonly unit: PerformanceMetricUnit
  readonly samples: readonly number[]
  readonly summary: DistributionSummary
  readonly definition: string
}

export interface UnavailablePerformanceMetric {
  readonly status: 'unavailable'
  readonly unit: PerformanceMetricUnit
  readonly samples: readonly []
  readonly summary: null
  readonly definition: string
  readonly reason: string
}

export type PerformanceMetric =
  | MeasuredPerformanceMetric
  | UnavailablePerformanceMetric

export interface PerformanceFixtureSummary {
  readonly version: string
  readonly fingerprint: string
  readonly assetCount: number
  readonly assetKinds: Readonly<Record<'video' | 'audio' | 'image', number>>
  readonly representative4kAssetCount: number
  readonly trackCount: number
  readonly videoTrackCount: number
  readonly audioTrackCount: number
  readonly clipCount: number
  readonly transitionCount: number
  readonly textClipCount: number
  readonly durationFrames: number
  readonly durationSeconds: number
  readonly width: number
  readonly height: number
  readonly frameRate: string
}

export interface HostPerformanceMetadata {
  readonly branch: string | null
  readonly commit: string | null
  readonly dirty: boolean | null
  readonly dirtyFingerprint: string | null
  readonly nodeVersion: string | null
  readonly platform: string
  readonly architecture: string | null
  readonly osRelease: string | null
  readonly cpuModel: string | null
  readonly logicalProcessors: number | null
  readonly totalMemoryGiB: number | null
  readonly browserChannel: string
  readonly browserVersion: string
  readonly command: string
}

export interface BrowserPerformanceMetadata {
  readonly userAgent: string
  readonly platform: string
  readonly language: string
  readonly logicalProcessors: number | null
  readonly deviceMemoryGiB: number | null
  readonly viewportWidth: number
  readonly viewportHeight: number
  readonly devicePixelRatio: number
  readonly crossOriginIsolated: boolean
  readonly webCodecs: boolean
  readonly offscreenCanvas: boolean
}

export interface AvailableGpuIdentity {
  readonly status: 'available'
  readonly value: string
}

export interface UnavailableGpuIdentity {
  readonly status: 'unavailable'
  readonly reason: string
}

export type GpuIdentity = AvailableGpuIdentity | UnavailableGpuIdentity

export interface AvailableGpuAccelerationIdentity {
  readonly status: 'available'
  readonly mode: 'hardware' | 'software' | 'mixed'
  readonly basis: readonly string[]
}

export type GpuAccelerationIdentity =
  | AvailableGpuAccelerationIdentity
  | UnavailableGpuIdentity

export interface ChromiumGpuDevice {
  readonly vendorId: number
  readonly deviceId: number
  readonly subSysId: number | null
  readonly revision: number | null
  readonly vendorString: string | null
  readonly deviceString: string | null
  readonly driverVendor: string | null
  readonly driverVersion: string | null
}

export interface ChromiumPerformanceMetadata {
  readonly source: 'cdp:SystemInfo.getInfo'
  readonly renderer: GpuIdentity
  readonly vendor: GpuIdentity
  readonly driverVendor: GpuIdentity
  readonly driverVersion: GpuIdentity
  readonly acceleration: GpuAccelerationIdentity
  readonly devices: readonly ChromiumGpuDevice[]
  readonly featureStatus: Readonly<Record<string, string>>
}

export interface ChromiumProcessMemoryEntry {
  readonly pid: number
  readonly type: string
  readonly cpuTimeSeconds: number
  readonly rssBytes: number | null
  readonly privateBytes: number | null
  readonly metricBytes: number
}

export interface ChromiumProcessMemoryBatchSample {
  readonly batchIndex: number
  readonly source: 'cdp:SystemInfo.getProcessInfo+host-os-process'
  readonly hostSampler: string
  readonly primaryMetric: 'private-bytes' | 'rss-bytes'
  readonly totalBytes: number
  readonly processes: readonly ChromiumProcessMemoryEntry[]
}

export interface ChromiumProcessMemoryEvidence {
  readonly status: 'measured' | 'unavailable'
  readonly source: 'cdp:SystemInfo.getProcessInfo+host-os-process'
  readonly scope: string
  readonly platform: string
  readonly hostSampler: string | null
  readonly primaryMetric: 'private-bytes' | 'rss-bytes' | null
  readonly reason: string | null
  readonly samples: readonly ChromiumProcessMemoryBatchSample[]
}

export interface PerformanceRunOptions {
  readonly sampleCount: number
  readonly playbackRuns: number
  readonly playbackDurationMs: number
  /** Post-warmup scrub batches; each batch requests one host process sample. */
  readonly memoryBatches: number
  readonly scrubsPerMemoryBatch: number
  readonly exportFrames: number
  readonly skipExport: boolean
}

export interface PerformanceResourceEvidence {
  readonly benchmarkObjectUrlsCreated: number
  readonly benchmarkObjectUrlsRevoked: number
  readonly importedObjectUrlsRevoked: number
  readonly previewDisposed: boolean
  readonly transportDisposed: boolean
  readonly exportDisposed: boolean
  readonly documentStoreRestored: boolean
  readonly mediaStoreRestored: boolean
  readonly transportStoreRestored: boolean
  readonly projectSessionUnchanged: boolean
  readonly storesRestored: boolean
}

export type ProposedGateStatistic =
  | 'median'
  | 'p75'
  | 'p95'
  | 'maximum'

export interface ProposedPerformanceGate {
  readonly metric: PerformanceMetricId
  readonly statistic: ProposedGateStatistic
  readonly operator: '<='
  readonly threshold: number
  readonly rationale: string
  /** Advisory only until representative-device baselines ratify the proposal. */
  readonly disposition: 'proposal'
  readonly evaluation: 'pass' | 'fail' | 'unavailable'
}

export interface PerformanceArtifact {
  readonly schemaVersion: typeof PERFORMANCE_ARTIFACT_SCHEMA_VERSION
  readonly harnessVersion: typeof PERFORMANCE_HARNESS_VERSION
  readonly capturedAt: string
  readonly metadata: {
    readonly host: HostPerformanceMetadata
    readonly browser: BrowserPerformanceMetadata
    readonly chromium: ChromiumPerformanceMetadata
  }
  readonly fixture: PerformanceFixtureSummary
  readonly options: PerformanceRunOptions
  readonly metrics: Readonly<Record<PerformanceMetricId, PerformanceMetric>>
  readonly proposedGates: readonly ProposedPerformanceGate[]
  readonly memoryEvidence: ChromiumProcessMemoryEvidence
  readonly warnings: readonly string[]
  readonly consoleProblems: readonly string[]
  readonly resources: PerformanceResourceEvidence
}

function finiteSamples(samples: readonly number[]): number[] {
  if (samples.length === 0) {
    throw new RangeError('A measured metric requires at least one sample')
  }
  const values = samples.map((sample) => {
    if (!Number.isFinite(sample)) {
      throw new TypeError('Performance samples must be finite numbers')
    }
    return sample
  })
  return values.toSorted((left, right) => left - right)
}

/** R-7 quantile interpolation, matching the common spreadsheet definition. */
export function quantile(sortedSamples: readonly number[], probability: number): number {
  if (sortedSamples.length === 0) {
    throw new RangeError('A quantile requires at least one sample')
  }
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new RangeError('Quantile probability must be from 0 to 1')
  }
  const index = (sortedSamples.length - 1) * probability
  const lowerIndex = Math.floor(index)
  const upperIndex = Math.ceil(index)
  const lower = sortedSamples[lowerIndex]
  const upper = sortedSamples[upperIndex]
  return lower + (upper - lower) * (index - lowerIndex)
}

export function summarizeDistribution(
  samples: readonly number[],
): DistributionSummary {
  const sorted = finiteSamples(samples)
  const count = sorted.length
  const total = sorted.reduce((sum, sample) => sum + sample, 0)
  const mean = total / count
  const variance = sorted.reduce(
    (sum, sample) => sum + (sample - mean) ** 2,
    0,
  ) / count
  return {
    count,
    minimum: sorted[0],
    maximum: sorted[count - 1],
    mean,
    median: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p95: quantile(sorted, 0.95),
    variance,
    standardDeviation: Math.sqrt(variance),
  }
}

export function measuredMetric(
  unit: PerformanceMetricUnit,
  definition: string,
  samples: readonly number[],
): MeasuredPerformanceMetric {
  const copied = [...samples]
  return {
    status: 'measured',
    unit,
    samples: copied,
    summary: summarizeDistribution(copied),
    definition,
  }
}

export function unavailableMetric(
  unit: PerformanceMetricUnit,
  definition: string,
  reason: string,
): UnavailablePerformanceMetric {
  return {
    status: 'unavailable',
    unit,
    samples: [],
    summary: null,
    definition,
    reason,
  }
}

interface GateProposal {
  readonly metric: PerformanceMetricId
  readonly statistic: ProposedGateStatistic
  readonly threshold: number
  readonly rationale: string
}

const GATE_PROPOSALS: readonly GateProposal[] = Object.freeze([
  {
    metric: 'launcher-interactive-ms',
    statistic: 'p95',
    threshold: 1_500,
    rationale: 'Keep the project launcher responsive on a supported baseline device.',
  },
  {
    metric: 'editor-first-usable-frame-ms',
    statistic: 'p95',
    threshold: 3_000,
    rationale: 'Bound the isolated stress editor time to the presentation boundary after its first drawn fixture frame.',
  },
  {
    metric: 'scrub-input-to-present-ms',
    statistic: 'p95',
    threshold: 100,
    rationale: 'Keep stress-fixture scrubbing below a visibly disruptive interaction delay.',
  },
  {
    metric: 'frame-render-ms',
    statistic: 'p95',
    threshold: 33.34,
    rationale: 'Target the 30 fps frame budget for worker decode and composition.',
  },
  {
    metric: 'dropped-frames',
    statistic: 'median',
    threshold: 0,
    rationale: 'Sustain short representative playback trials without presentation gaps.',
  },
  {
    metric: 'audio-underruns',
    statistic: 'maximum',
    threshold: 0,
    rationale: 'Keep scheduled audio ahead of the AudioContext clock in every trial.',
  },
  {
    metric: 'import-readiness-ms',
    statistic: 'p95',
    threshold: 2_000,
    rationale: 'Bound content inspection and first-frame readiness for a generated 4K still.',
  },
  {
    metric: 'memory-growth-kib-per-batch',
    statistic: 'p95',
    threshold: 1_024,
    rationale: 'Treat sustained post-warmup Chromium process-memory growth as a leak investigation trigger.',
  },
  {
    metric: 'export-real-time-ratio',
    statistic: 'p75',
    threshold: 1,
    rationale: 'Target real-time-or-faster export for the bounded 4K procedural segment.',
  },
])

function gateValue(
  summary: DistributionSummary,
  statistic: ProposedGateStatistic,
): number {
  return summary[statistic]
}

export function evaluateProposedGates(
  metrics: Readonly<Record<PerformanceMetricId, PerformanceMetric>>,
): ProposedPerformanceGate[] {
  return GATE_PROPOSALS.map((proposal) => {
    const metric = metrics[proposal.metric]
    const evaluation = metric.status === 'unavailable'
      ? 'unavailable'
      : gateValue(metric.summary, proposal.statistic) <= proposal.threshold
        ? 'pass'
        : 'fail'
    return {
      ...proposal,
      operator: '<=',
      disposition: 'proposal',
      evaluation,
    }
  })
}

function decimal(value: number): string {
  if (Math.abs(value) >= 100) return value.toFixed(1)
  if (Math.abs(value) >= 10) return value.toFixed(2)
  return value.toFixed(3)
}

export function performanceArtifactMarkdown(artifact: PerformanceArtifact): string {
  const metricRows = (Object.entries(artifact.metrics) as Array<
    [PerformanceMetricId, PerformanceMetric]
  >).map(([id, metric]) => {
    if (metric.status === 'unavailable') {
      return `| ${id} | unavailable | — | — | — | — | ${metric.reason} |`
    }
    const summary = metric.summary
    return `| ${id} | ${metric.unit} | ${decimal(summary.median)} | ${decimal(summary.p75)} | ${decimal(summary.p95)} | ${decimal(summary.variance)} | ${summary.count} samples |`
  })
  const gateRows = artifact.proposedGates.map((gate) => (
    `| ${gate.metric} ${gate.statistic} | ${gate.operator} ${gate.threshold} | ${gate.evaluation} | ${gate.rationale} |`
  ))
  const warningLines = artifact.warnings.length === 0
    ? ['- None.']
    : artifact.warnings.map((warning) => `- ${warning}`)
  const consoleLines = artifact.consoleProblems.length === 0
    ? ['- No browser warnings or errors were captured.']
    : artifact.consoleProblems.map((problem) => `- ${problem}`)
  const host = artifact.metadata.host
  const dirtyState = host.dirty === null
    ? 'not captured'
    : host.dirty ? 'dirty' : 'clean'
  const gpu = artifact.metadata.chromium
  const gpuValue = (identity: GpuIdentity): string => identity.status === 'available'
    ? identity.value
    : `unavailable (${identity.reason})`
  const acceleration = gpu.acceleration.status === 'available'
    ? gpu.acceleration.mode
    : `unavailable (${gpu.acceleration.reason})`
  const memoryEvidence = artifact.memoryEvidence
  const memoryProvenance = memoryEvidence.status === 'measured'
    ? `${memoryEvidence.primaryMetric} via ${memoryEvidence.hostSampler}; ${memoryEvidence.samples.length} complete CDP process-table samples`
    : `unavailable (${memoryEvidence.reason})`

  return [
    '# WebCut performance evidence',
    '',
    `Captured: ${artifact.capturedAt}`,
    `Harness: ${artifact.harnessVersion}; schema: ${artifact.schemaVersion}`,
    `Fixture: ${artifact.fixture.version}`,
    `Fixture fingerprint: ${artifact.fixture.fingerprint}`,
    `Source: ${host.branch ?? 'not captured'} @ ${host.commit ?? 'not captured'}`,
    `Dirty fingerprint: ${host.dirtyFingerprint ?? 'not captured'} (${dirtyState})`,
    `Runtime: ${host.browserChannel} ${host.browserVersion}; ${artifact.metadata.browser.userAgent}`,
    `Device: ${host.platform} ${host.osRelease ?? 'unknown'}/${host.architecture ?? 'unknown'}, ${host.cpuModel ?? 'unknown CPU'}, ${host.logicalProcessors ?? 'unknown'} logical processors, ${host.totalMemoryGiB ?? 'unknown'} GiB host memory (${artifact.metadata.browser.deviceMemoryGiB ?? 'unknown'} GiB browser-reported)`,
    `GPU: ${gpuValue(gpu.renderer)}; vendor: ${gpuValue(gpu.vendor)}; driver: ${gpuValue(gpu.driverVendor)} ${gpuValue(gpu.driverVersion)}; acceleration: ${acceleration}; source: ${gpu.source}`,
    `Memory provenance: ${memoryProvenance}. Scope: ${memoryEvidence.scope}`,
    '',
    '## Fixture',
    '',
    `${artifact.fixture.assetCount} assets (${artifact.fixture.assetKinds.video} video, ${artifact.fixture.assetKinds.audio} audio, ${artifact.fixture.assetKinds.image} still), ${artifact.fixture.representative4kAssetCount} representative 4K sources, ${artifact.fixture.trackCount} tracks, ${artifact.fixture.clipCount} clips, ${artifact.fixture.transitionCount} transitions, ${artifact.fixture.textClipCount} text clips, ${artifact.fixture.durationSeconds / 60} minutes at ${artifact.fixture.frameRate}.`,
    '',
    '## Measurements',
    '',
    '| Metric | Unit | Median | p75 | p95 | Variance | Notes |',
    '|---|---:|---:|---:|---:|---:|---|',
    ...metricRows,
    '',
    '## Proposed gates',
    '',
    'These evaluations are advisory. Ratify thresholds only after repeated baselines across supported device profiles; one run is never a product claim.',
    '',
    '| Statistic | Proposal | This run | Rationale |',
    '|---|---:|---|---|',
    ...gateRows,
    '',
    '## Warnings',
    '',
    ...warningLines,
    '',
    '## Browser console',
    '',
    ...consoleLines,
    '',
    '## Resource cleanup',
    '',
    `Created/revoked benchmark URLs: ${artifact.resources.benchmarkObjectUrlsCreated}/${artifact.resources.benchmarkObjectUrlsRevoked}. Imported URLs revoked: ${artifact.resources.importedObjectUrlsRevoked}. Preview/transport/export disposed: ${artifact.resources.previewDisposed}/${artifact.resources.transportDisposed}/${artifact.resources.exportDisposed}. Document/media/transport restored and project session unchanged: ${artifact.resources.documentStoreRestored}/${artifact.resources.mediaStoreRestored}/${artifact.resources.transportStoreRestored}/${artifact.resources.projectSessionUnchanged}. Aggregate restoration: ${artifact.resources.storesRestored}.`,
    '',
    `Reproduce: \`${artifact.metadata.host.command}\``,
    '',
  ].join('\n')
}
