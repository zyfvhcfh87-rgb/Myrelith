import { openAudioAlignmentSource } from '../pipeline/audioAlignmentDecode'
import type { AudioAlignmentWorkerRequest, AudioAlignmentWorkerReply } from '../pipeline/audioAlignmentProtocol'

let source: Awaited<ReturnType<typeof openAudioAlignmentSource>> | null = null
let phase: 'idle' | 'opening' | 'ready' | 'decoding' | 'done' = 'idle'
function send(reply: AudioAlignmentWorkerReply, transfer: Transferable[] = []): void {
  self.postMessage(reply, { transfer })
}
self.onmessage = (event: MessageEvent<AudioAlignmentWorkerRequest>) => {
  const message = event.data
  void (async () => {
    if (message.type === 'open' && phase === 'idle') {
      phase = 'opening'
      source = await openAudioAlignmentSource(message.blob, message.sourceId, message.budget)
      phase = 'ready'
      send({ type: 'opened', facts: source.facts })
    } else if (message.type === 'decode' && phase === 'ready' && source) {
      phase = 'decoding'
      const fingerprint = await source.decode(message.window, (fraction) => send({ type: 'progress', fraction }))
      source.close()
      source = null
      phase = 'done'
      send({ type: 'complete', fingerprint }, [fingerprint.values.buffer])
    } else throw new Error('Unexpected audio worker command')
  })().catch((cause) => {
    source?.close()
    source = null
    phase = 'done'
    send({ type: 'failure', detail: (cause instanceof Error ? cause.message : String(cause)).slice(0, 2048) })
  })
}
