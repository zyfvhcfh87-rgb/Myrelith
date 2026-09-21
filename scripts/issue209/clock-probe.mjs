/* Disposable Issue #209 research probe. No PCM leaves the worklet. */
const button = document.querySelector('#start')
const resultNode = document.querySelector('#result')
const params = new URLSearchParams(location.search)
const microphoneHint = params.get('microphone') ?? ''
const speakerHint = params.get('speaker') ?? ''
const audible = params.get('audible') === '1'
const mainThreadStallMs = Number(params.get('stallMs') ?? 0)

window.__probeDone = false
window.__probeResult = null

function summarize(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]
  return { min: sorted[0], median: at(0.5), p95: at(0.95), max: sorted.at(-1) }
}

function referenceOnsets(rows) {
  const onsets = []
  let active = false
  for (const row of rows) {
    const now = row.referenceRms > 0.04
    if (now && !active) onsets.push(row.frame)
    active = now
  }
  return onsets
}

function acousticLag(rows, rate) {
  const firstReference = rows.findIndex((row) => row.referenceRms > 0.04)
  if (firstReference < 0) return { resolved: false, reason: 'reference absent' }
  const baselineRows = rows.slice(0, firstReference)
  const baseline = summarize(baselineRows.map((row) => row.micRms))?.median ?? 0
  const quantum = rows[0]?.length ?? 128
  const maxLag = Math.ceil(0.35 * rate / quantum)
  const scores = []
  for (let lag = 0; lag <= maxLag; lag += 1) {
    let score = 0
    for (let i = firstReference; i + lag < rows.length; i += 1) {
      score += rows[i].referenceRms * Math.max(0, rows[i + lag].micRms - baseline)
    }
    scores.push(score)
  }
  const bestScore = Math.max(...scores)
  const bestLag = scores.indexOf(bestScore)
  const typicalScore = summarize(scores)?.median ?? 0
  const microphonePeak = Math.max(...rows.map((row) => row.micRms))
  const resolved = bestScore > 0.01
    && bestScore > typicalScore * 1.5
    && microphonePeak > Math.max(baseline * 2, baseline + 0.003)
  return {
    resolved,
    lagBlocks: bestLag,
    lagMs: bestLag * quantum / rate * 1000,
    baselineRms: baseline,
    peakRms: microphonePeak,
    peakToMedianCorrelation: typicalScore > 0 ? bestScore / typicalScore : null,
    reason: resolved ? null : 'No reliable acoustic pulse correlation',
  }
}

async function run() {
  button.disabled = true
  resultNode.textContent = 'Requesting microphone...'
  let stream = null
  let context = null
  let source = null
  let node = null
  let referenceBus = null
  let speakerGain = null
  let track = null
  let endedEvents = 0
  let muteEvents = 0
  const rows = []
  const deliveryLagsMs = []
  const receiptIntervalErrorsMs = []
  let previousReceipt = null
  let workletSummary = null
  let sinkResult = 'not requested'

  try {
    // This request is made directly in the button's click turn.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    })
    const devices = await navigator.mediaDevices.enumerateDevices()
    const selectedMicrophone = devices.find((device) =>
      device.kind === 'audioinput' && device.label.includes(microphoneHint) && microphoneHint)
    if (selectedMicrophone && stream.getAudioTracks()[0].getSettings().deviceId !== selectedMicrophone.deviceId) {
      stream.getTracks().forEach((item) => item.stop())
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: selectedMicrophone.deviceId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      })
    }
    track = stream.getAudioTracks()[0]
    track.addEventListener('ended', () => { endedEvents += 1 })
    track.addEventListener('mute', () => { muteEvents += 1 })

    context = new AudioContext({ sampleRate: 48_000 })
    const selectedSpeaker = devices.find((device) =>
      device.kind === 'audiooutput' && device.label.includes(speakerHint) && speakerHint)
    if (selectedSpeaker && typeof context.setSinkId === 'function') {
      try {
        await context.setSinkId(selectedSpeaker.deviceId)
        sinkResult = `selected: ${selectedSpeaker.label}`
      } catch (error) {
        sinkResult = `selection failed: ${error.name}`
      }
    } else if (speakerHint) {
      sinkResult = selectedSpeaker ? 'setSinkId unavailable' : 'speaker not listed'
    }
    await context.audioWorklet.addModule('/clock-probe-worklet.js')
    await context.resume()
    node = new AudioWorkletNode(context, 'issue209-clock-probe', {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
    source = context.createMediaStreamSource(stream)
    source.connect(node, 0, 0)
    node.connect(context.destination) // The worklet always outputs zero.
    referenceBus = context.createGain()
    referenceBus.connect(node, 0, 1)
    if (audible) {
      speakerGain = context.createGain()
      speakerGain.gain.value = 0.18
      referenceBus.connect(speakerGain)
      speakerGain.connect(context.destination)
    }
    node.port.onmessage = (event) => {
      if (event.data?.type === 'batch') {
        rows.push(...event.data.rows)
        const last = event.data.rows.at(-1)
        if (last) {
          const arrivedAt = performance.now()
          deliveryLagsMs.push((context.currentTime - (last.frame + last.length) / context.sampleRate) * 1000)
          if (previousReceipt) {
            const expectedMs = (last.frame - previousReceipt.frame) / context.sampleRate * 1000
            receiptIntervalErrorsMs.push(arrivedAt - previousReceipt.arrivedAt - expectedMs)
          }
          previousReceipt = { frame: last.frame, arrivedAt }
        }
      } else if (event.data?.type === 'done') {
        workletSummary = event.data
      }
    }

    const pulseTimes = [0.5, 1, 1.5, 2].map((offset) => context.currentTime + offset)
    for (const time of pulseTimes) {
      const oscillator = context.createOscillator()
      const envelope = context.createGain()
      oscillator.frequency.value = 1_500
      envelope.gain.setValueAtTime(0, time)
      envelope.gain.linearRampToValueAtTime(0.7, time + 0.003)
      envelope.gain.setValueAtTime(0.7, time + 0.035)
      envelope.gain.linearRampToValueAtTime(0, time + 0.04)
      oscillator.connect(envelope)
      envelope.connect(referenceBus)
      oscillator.start(time)
      oscillator.stop(time + 0.045)
    }
    if (mainThreadStallMs > 0) {
      setTimeout(() => {
        const until = performance.now() + mainThreadStallMs
        while (performance.now() < until) { /* measured main-thread stall */ }
      }, 1_150)
    }
    await new Promise((resolve) => setTimeout(resolve, 2_650))
    const done = new Promise((resolve) => {
      const previous = node.port.onmessage
      node.port.onmessage = (event) => {
        previous(event)
        if (event.data?.type === 'done') resolve()
      }
    })
    node.port.postMessage({ type: 'flush' })
    await done

    const rate = context.sampleRate
    const onsets = referenceOnsets(rows)
    const settings = track.getSettings()
    const outputTimestamp = context.getOutputTimestamp?.() ?? null
    const result = {
      browser: navigator.userAgent,
      device: track.label,
      microphone: {
        sampleRate: settings.sampleRate ?? null,
        channelCount: settings.channelCount ?? null,
        latencyMs: typeof settings.latency === 'number' ? settings.latency * 1000 : null,
        echoCancellation: settings.echoCancellation ?? null,
        noiseSuppression: settings.noiseSuppression ?? null,
        autoGainControl: settings.autoGainControl ?? null,
        readyStateBeforeStop: track.readyState,
      },
      output: {
        sinkResult,
        audible,
        sampleRate: rate,
        baseLatencyMs: context.baseLatency * 1000,
        outputLatencyMs: typeof context.outputLatency === 'number' ? context.outputLatency * 1000 : null,
        timestampAvailable: outputTimestamp !== null,
      },
      scheduledPulseFrames: pulseTimes.map((time) => Math.round(time * rate)),
      referenceOnsetFrames: onsets,
      referenceOnsetErrorSamples: onsets.map((frame, index) => frame - Math.floor(pulseTimes[index] * rate / (rows[0]?.length ?? 128)) * (rows[0]?.length ?? 128)),
      worklet: {
        blocks: workletSummary.blocks,
        firstFrame: workletSummary.firstFrame,
        lastEndFrame: workletSummary.previousEnd,
        discontinuities: workletSummary.gaps,
        blockLengths: [...new Set(rows.map((row) => row.length))],
        deliveryLagMs: summarize(deliveryLagsMs),
        receiptIntervalErrorMs: summarize(receiptIntervalErrorsMs),
      },
      microphoneLevel: summarize(rows.map((row) => row.micRms)),
      acoustic: audible ? acousticLag(rows, rate) : { resolved: false, reason: 'audible output disabled' },
      mainThreadStallMs,
    }
    result.microphone.endedEventsBeforeOwnStop = endedEvents
    track.stop()
    await new Promise((resolve) => setTimeout(resolve, 80))
    result.microphone.readyStateAfterStop = track.readyState
    result.microphone.endedEventsAfterOwnStop = endedEvents
    result.microphone.muteEvents = muteEvents
    window.__probeResult = result
    resultNode.textContent = JSON.stringify(result, null, 2)
  } catch (error) {
    window.__probeResult = { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
    resultNode.textContent = JSON.stringify(window.__probeResult, null, 2)
  } finally {
    stream?.getTracks().forEach((item) => item.stop())
    source?.disconnect()
    node?.disconnect()
    referenceBus?.disconnect()
    speakerGain?.disconnect()
    await context?.close().catch(() => undefined)
    window.__probeDone = true
    button.disabled = false
  }
}

button.addEventListener('click', () => { void run() })
