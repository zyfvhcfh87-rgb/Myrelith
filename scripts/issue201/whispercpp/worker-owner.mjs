// Host ownership prototype. Caller retains media/cache admission until dispose
// resolves and its own cache transactions drain. No worker is created here.
export function createSpeechWorkerOwner({ worker, owner, onDisposed,
  setTimer = setTimeout, clearTimer = clearTimeout, now = () => performance.now() }) {
  if (typeof owner !== 'string' || owner.length < 1 || owner.length > 64) throw Error('owner');
  let id = 0, pending = null, disposed = false, closing = null, timer = null;
  const clear = () => { if (timer !== null) clearTimer(timer); timer = null; };
  function terminate(reason, cooperativeZero = false) {
    if (disposed) return;
    disposed = true; clear();
    const started = now();
    worker.terminate(); // Synchronous host boundary, distinct from native zero.
    worker.removeEventListener('message', onMessage);
    worker.removeEventListener('error', onError);
    const report = { reason, terminationReturned: true, terminationMs: now() - started, cooperativeZero };
    const request = pending; pending = null;
    request?.reject(Error(reason));
    // Publish disposal even if caller observation throws. Resources are already
    // terminated; a new owner must never borrow this worker.
    closing?.resolve(report);
    onDisposed(report);
  }
  function onError() { terminate('worker-error'); }
  function onMessage(event) {
    if (disposed) return;
    const value = event.data;
    if (!pending || value?.v !== 1 || value.owner !== owner || !Number.isSafeInteger(value.id) || value.id !== pending.id) return;
    if (now() >= pending.deadline) { terminate(pending.kind === 'close' ? 'close-deadline' : 'host-deadline'); return; }
    if (value.kind === 'error') { terminate(value.code ?? 'worker-error', value.cooperativeZero === true); return; }
    if (pending.kind === 'close' && value.kind === 'closed') {
      terminate('closed', value.cooperativeZero === true); return;
    }
    if ((pending.kind === 'load' && value.kind !== 'ready') || (pending.kind === 'run' && value.kind !== 'result')) {
      terminate('unexpected-worker-reply'); return;
    }
    clear(); const request = pending; pending = null; request.resolve(value);
  }
  worker.addEventListener('message', onMessage);
  worker.addEventListener('error', onError);
  function request(kind, payload, transfer) {
    if (disposed || closing || pending) return Promise.reject(Error('worker-unavailable'));
    return new Promise((resolve, reject) => {
      pending = { id: ++id, kind, resolve, reject, deadline: now() + 120000 };
      timer = setTimer(() => terminate('host-deadline'), 120000);
      try { worker.postMessage({ v: 1, owner, id, kind, ...payload }, transfer); }
      catch { terminate('post-failed'); }
    });
  }
  return {
    load: (model, wasm) => request('load', { model, wasm }, [model, wasm]),
    run: (pcm, language) => request('run', { pcm, language }, [pcm]),
    dispose(reason = 'cancelled') {
      if (closing) return closing.promise;
      if (disposed) return Promise.resolve({ reason: 'already-terminated', terminationReturned: true, cooperativeZero: false });
      let resolve; const promise = new Promise(done => { resolve = done; });
      closing = { promise, resolve };
      if (pending) { terminate(reason); return promise; }
      pending = { id: ++id, kind: 'close', resolve: () => {}, reject: () => {}, deadline: now() + 100 };
      timer = setTimer(() => terminate('close-deadline'), 100);
      try { worker.postMessage({ v: 1, owner, id, kind: 'close' }); }
      catch { terminate('close-post-failed'); }
      return promise;
    },
  };
}
