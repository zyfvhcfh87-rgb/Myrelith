import type { Transition } from '../schema';

/** Which clip edge a trim moves. */
export type TrimEdge = 'start' | 'end'

export interface CrossfadeSettings {
  durationFrames: number
  audio: Transition['audio']
}
