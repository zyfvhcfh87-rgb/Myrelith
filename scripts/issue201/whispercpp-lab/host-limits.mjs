// Host guards supplement the unchanged core 120s/window and 12-window limits.
export const HOST_LIMITS = Object.freeze({ inputVerificationMs: 30_000, browserLaunchMs: 12_000,
  browserInternalLaunchMs: 10_000, setupOperationMs: 10_000, overallMs: 3_600_000,
  ordinaryCaseMs: 30_000, speechCaseMs: 300_000, cancelCaseMs: 180_000,
  longCaseMs: 1_800_000, journalMs: 1_000, sampleDrainMs: 500,
  serverCloseMs: 500, forcedServerCloseMs: 250, profileCleanupMs: 3_000 })
export function caseDeadlineMs(name) {
  if (name === '300-second-bounded-workload') return HOST_LIMITS.longCaseMs
  if (/^(?:transcribe-|offline-|one-second-speech-window$|corrupt-audio-rejection$)/.test(name)) return HOST_LIMITS.speechCaseMs
  if (/^cancel-(?:model-load|prepare|infer)$/.test(name) || name === 'project-replacement') return HOST_LIMITS.cancelCaseMs
  return HOST_LIMITS.ordinaryCaseMs
}
