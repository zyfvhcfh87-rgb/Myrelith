import { describe, expect, test } from 'vitest'
import { estimateDocumentMemory } from '../../domain/documentMemory'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../../domain/projectSettings'
import {
  PERFORMANCE_ARTIFACT_SCHEMA_VERSION,
  PERFORMANCE_HARNESS_VERSION,
  evaluateProposedGates,
  measuredMetric,
  performanceArtifactMarkdown,
  quantile,
  summarizeDistribution,
  unavailableMetric,
  type PerformanceArtifact,
  type PerformanceMetric,
  type PerformanceMetricId,
} from './contract'

describe('performance evidence contract', () => {
  test('summarizes a distribution with deterministic R-7 percentiles and variance', () => {
    const samples = [5, 1, 4, 2, 3]
    const summary = summarizeDistribution(samples)

    expect(samples).toEqual([5, 1, 4, 2, 3])
    expect(summary).toEqual({
      count: 5,
      minimum: 1,
      maximum: 5,
      mean: 3,
      median: 3,
      p75: 4,
      p95: 4.8,
      variance: 2,
      standardDeviation: Math.sqrt(2),
    })
    expect(quantile([10, 20], 0.75)).toBe(17.5)
  })

  test('rejects empty, non-finite, or invalid quantile input', () => {
    expect(() => summarizeDistribution([])).toThrow(/at least one sample/i)
    expect(() => summarizeDistribution([1, Number.NaN])).toThrow(/finite/i)
    expect(() => quantile([], 0.5)).toThrow(/at least one sample/i)
    expect(() => quantile([1], 1.1)).toThrow(/from 0 to 1/i)
  })

  test('keeps proposed gates advisory and reports unavailable evidence honestly', () => {
    const measured = measuredMetric('ms', 'test metric', [10, 20, 30])
    const unavailable = unavailableMetric('ratio', 'test metric', 'not supported')
    const metrics = Object.fromEntries([
      'launcher-interactive-ms',
      'editor-first-usable-frame-ms',
      'scrub-input-to-present-ms',
      'frame-render-ms',
      'dropped-frames',
      'audio-underruns',
      'import-readiness-ms',
      'memory-plateau-mib',
      'memory-growth-kib-per-batch',
      'telemetry-overhead-percent',
      'export-real-time-ratio',
    ].map((id) => [id, id === 'export-real-time-ratio' ? unavailable : measured])) as Record<
      PerformanceMetricId,
      PerformanceMetric
    >

    const gates = evaluateProposedGates(metrics)

    expect(gates).toHaveLength(10)
    expect(gates.every((gate) => gate.disposition === 'proposal')).toBe(true)
    expect(gates.find((gate) => gate.metric === 'export-real-time-ratio'))
      .toMatchObject({ evaluation: 'unavailable' })
  })

  test('renders a compact human-readable report beside the JSON contract', () => {
    const metric = measuredMetric('ms', 'test', [1, 2, 3])
    const metrics = Object.fromEntries([
      'launcher-interactive-ms',
      'editor-first-usable-frame-ms',
      'scrub-input-to-present-ms',
      'frame-render-ms',
      'dropped-frames',
      'audio-underruns',
      'import-readiness-ms',
      'memory-plateau-mib',
      'memory-growth-kib-per-batch',
      'telemetry-overhead-percent',
      'export-real-time-ratio',
    ].map((id) => [id, metric])) as PerformanceArtifact['metrics']
    const artifact = {
      schemaVersion: PERFORMANCE_ARTIFACT_SCHEMA_VERSION,
      harnessVersion: PERFORMANCE_HARNESS_VERSION,
      capturedAt: '2026-08-06T00:00:00.000Z',
      metadata: {
        host: {
          branch: 'feat/test',
          commit: 'abc123',
          dirty: false,
          dirtyFingerprint: `sha256:${'b'.repeat(64)}`,
          nodeVersion: 'v22',
          platform: 'win32',
          architecture: 'x64',
          osRelease: 'test-release',
          cpuModel: 'Test CPU',
          logicalProcessors: 8,
          totalMemoryGiB: 16,
          browserChannel: 'chromium',
          browserVersion: '150',
          command: 'node scripts/performance/run-benchmark.mjs',
        },
        browser: {
          userAgent: 'Chromium test',
          platform: 'Win32',
          language: 'en',
          logicalProcessors: 8,
          deviceMemoryGiB: 16,
          viewportWidth: 1440,
          viewportHeight: 900,
          devicePixelRatio: 1,
          crossOriginIsolated: false,
          webCodecs: true,
          offscreenCanvas: true,
        },
        chromium: {
          source: 'cdp:SystemInfo.getInfo',
          renderer: { status: 'available', value: 'ANGLE (Test GPU)' },
          vendor: { status: 'available', value: 'Test Vendor' },
          driverVendor: { status: 'available', value: 'Test Driver Vendor' },
          driverVersion: { status: 'available', value: '1.2.3' },
          acceleration: {
            status: 'available',
            mode: 'hardware',
            basis: ['gpu_compositing=enabled'],
          },
          devices: [{
            vendorId: 1,
            deviceId: 2,
            subSysId: null,
            revision: null,
            vendorString: 'Test Vendor',
            deviceString: 'Test GPU',
            driverVendor: 'Test Driver Vendor',
            driverVersion: '1.2.3',
          }],
          featureStatus: { gpu_compositing: 'enabled' },
        },
      },
      fixture: {
        version: 'fixture-v1',
        fingerprint: `sha256:${'a'.repeat(64)}`,
        assetCount: 100,
        assetKinds: { video: 45, audio: 25, image: 30 },
        representative4kAssetCount: 25,
        trackCount: 8,
        videoTrackCount: 4,
        audioTrackCount: 4,
        clipCount: 320,
        transitionCount: 39,
        textClipCount: 20,
        durationFrames: 54_000,
        durationSeconds: 1_800,
        width: 3_840,
        height: 2_160,
        frameRate: '30/1',
      },
      options: {
        sampleCount: 3,
        playbackRuns: 1,
        playbackDurationMs: 1_000,
        memoryBatches: 2,
        scrubsPerMemoryBatch: 2,
        exportFrames: 3,
        skipExport: false,
      },
      metrics,
      proposedGates: evaluateProposedGates(metrics),
      memoryEvidence: {
        status: 'measured',
        source: 'cdp:SystemInfo.getProcessInfo+host-os-process',
        scope: 'All CDP-reported Chromium processes.',
        platform: 'win32',
        hostSampler: 'powershell:Get-Process',
        primaryMetric: 'private-bytes',
        reason: null,
        samples: [{
          batchIndex: 1,
          source: 'cdp:SystemInfo.getProcessInfo+host-os-process',
          hostSampler: 'powershell:Get-Process',
          primaryMetric: 'private-bytes',
          totalBytes: 300,
          processes: [
            {
              pid: 10,
              type: 'renderer',
              cpuTimeSeconds: 1,
              rssBytes: 200,
              privateBytes: 100,
              metricBytes: 100,
            },
            {
              pid: 11,
              type: 'GPU',
              cpuTimeSeconds: 2,
              rssBytes: 300,
              privateBytes: 200,
              metricBytes: 200,
            },
          ],
        }],
      },
      telemetry: {
        documentMemory: estimateDocumentMemory(
          createTimelineDoc('Telemetry', DEFAULT_PROJECT_SETTINGS, 'telemetry'),
          [],
          [],
        ),
        overhead: {
          controlDurationsMs: [2],
          instrumentedDurationsMs: [2.1],
          overheadPercentSamples: [5],
        },
        healthSamples: [],
        cacheDrain: {
          status: 'unavailable',
          reason: 'test fixture',
          checkedSamples: 0,
        },
        longAnimationFrames: {
          status: 'unavailable',
          reason: 'test fixture',
          entryCount: 0,
          overflowed: false,
          durationMs: [],
        },
        userAgentSpecificMemory: {
          status: 'unavailable',
          reason: 'test fixture',
          bytes: null,
          breakdownCount: null,
        },
      },
      warnings: [],
      consoleProblems: [],
      resources: {
        benchmarkObjectUrlsCreated: 10,
        benchmarkObjectUrlsRevoked: 10,
        importedObjectUrlsRevoked: 3,
        previewDisposed: true,
        transportDisposed: true,
        exportDisposed: true,
        documentStoreRestored: true,
        mediaStoreRestored: true,
        transportStoreRestored: true,
        projectSessionUnchanged: true,
        storesRestored: true,
      },
    } satisfies PerformanceArtifact

    const report = performanceArtifactMarkdown(artifact)
    expect(report).toContain('# WebCut performance evidence')
    expect(report).toContain('Median | p75 | p95 | Variance')
    expect(report).toContain('one run is never a product claim')
    expect(report).toContain(`Fixture fingerprint: sha256:${'a'.repeat(64)}`)
    expect(report).toContain('GPU: ANGLE (Test GPU)')
    expect(report).toContain('Memory provenance: private-bytes via powershell:Get-Process')
    expect(report).toContain('Created/revoked benchmark URLs: 10/10')

    const manualReport = performanceArtifactMarkdown({
      ...artifact,
      metadata: {
        ...artifact.metadata,
        host: {
          ...artifact.metadata.host,
          branch: null,
          commit: null,
          dirty: null,
          dirtyFingerprint: null,
        },
      },
    })
    expect(manualReport).toContain('Source: not captured @ not captured')
    expect(manualReport).toContain('Dirty fingerprint: not captured (not captured)')
  })
})
