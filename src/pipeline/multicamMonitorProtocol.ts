/** Structured-clone boundary. Every received bitmap has exactly one closer. */
export interface MulticamMonitorSource {
  readonly id: string
  readonly blob: Blob
  readonly representation: 'original' | 'proxy'
  readonly width: number
  readonly height: number
  readonly firstTimestampUs: number
  readonly endTimestampUs: number
}
export interface MulticamMonitorLedger {
  readonly inputs: number
  readonly nativeDecoders: number
  readonly nativeFrames: number
  readonly createdDecoders: number
  readonly closedDecoders: number
  readonly frameBytes: number
  readonly peakDecoders: number
  readonly peakFrames: number
  readonly peakFrameBytes: number
  readonly scratchSurfaces: number
  readonly scratchBytes: number
}
export type MulticamMonitorRequest =
  | { readonly type: 'open'; readonly sources: readonly MulticamMonitorSource[]; readonly width: number; readonly height: number }
  | { readonly type: 'frame'; readonly id: string; readonly requestId: number; readonly sourceTimeUs: number }
  | { readonly type: 'close' }
export type MulticamMonitorReply =
  | { readonly type: 'ready'; readonly ledger: MulticamMonitorLedger }
  | { readonly type: 'frame'; readonly id: string; readonly requestId: number; readonly timestampUs: number; readonly bitmap: ImageBitmap; readonly ledger: MulticamMonitorLedger }
  | { readonly type: 'closed'; readonly ledger: MulticamMonitorLedger }
  | { readonly type: 'failure'; readonly detail: string; readonly ledger: MulticamMonitorLedger }

export function multicamMonitorLedgerIsZero(value: MulticamMonitorLedger): boolean {
  return value.inputs === 0 && value.nativeDecoders === 0 && value.nativeFrames === 0
    && value.frameBytes === 0 && value.scratchSurfaces === 0 && value.scratchBytes === 0
    && Number.isSafeInteger(value.createdDecoders) && value.createdDecoders >= 0
    && value.createdDecoders === value.closedDecoders
}
