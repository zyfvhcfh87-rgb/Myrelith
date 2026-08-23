import { useState } from 'react'
import {
  cancelProxyGeneration,
  clearAllProxies,
  formatBytes,
  removeProxy,
  requestProxyGeneration,
} from '../app/proxyController'
import { useProxyStore } from '../state/proxyStore'

export function ProxyStorageSummary() {
  const storage = useProxyStore((state) => state.storage)
  const [clearing, setClearing] = useState(false)
  const origin = storage.originUsageBytes !== null && storage.originQuotaBytes !== null
    ? `${formatBytes(storage.originUsageBytes)} of ${formatBytes(storage.originQuotaBytes)} origin storage used`
    : 'Browser quota estimate unavailable'
  const summary = storage.supported
    ? `${storage.itemCount} · ${formatBytes(storage.cacheBytes)}`
    : storage.error ?? 'Unavailable'
  return (
    <details className="proxy-storage" aria-label="Local proxy storage">
      <summary>
        <strong>Proxies</strong>
        <span>{summary}</span>
      </summary>
      <div>
        <span>
          {storage.supported
            ? origin
            : storage.error ?? 'OPFS proxy storage is unavailable in this browser.'}
        </span>
        {storage.supported && storage.persisted === false ? (
          <span>Browser-managed storage may be evicted under pressure.</span>
        ) : null}
      </div>
      {storage.itemCount > 0 ? (
        <button
          type="button"
          disabled={clearing}
          onClick={() => {
            if (!window.confirm('Clear all disposable editing proxies? Projects and original media are not affected.')) {
              return
            }
            setClearing(true)
            void clearAllProxies().finally(() => setClearing(false))
          }}
        >
          {clearing ? 'Clearing…' : 'Clear proxies'}
        </button>
      ) : null}
    </details>
  )
}

export interface ProxyControlsProps {
  readonly assetId: string
  readonly fileName: string
}

export function ProxyControls({ assetId, fileName }: ProxyControlsProps) {
  const item = useProxyStore((state) => state.assets.get(assetId))
  const [removing, setRemoving] = useState(false)
  const active = item?.phase === 'queued' || item?.phase === 'generating'
  const action = item?.entry
    ? 'Regenerate'
    : item?.phase === 'error' ? 'Retry proxy' : 'Generate proxy'
  return (
    <section
      className="media-proxy"
      data-phase={item?.phase ?? 'checking'}
      aria-label={`Editing proxy for ${fileName}`}
      onDragStart={(event) => event.stopPropagation()}
    >
      <div className="media-proxy-heading">
        <span>Editing proxy</span>
        <span>{item?.phase ?? 'checking'}</span>
      </div>
      <p aria-live="polite">
        {item?.detail ?? 'Checking local proxy support…'}
      </p>
      {item?.phase === 'generating' ? (
        <progress
          aria-label={`Proxy generation progress for ${fileName}`}
          max={1}
          value={item.progress}
        />
      ) : null}
      <div className="media-proxy-actions">
        {active ? (
          <button draggable={false} type="button" onClick={() => cancelProxyGeneration(assetId)}>
            Cancel
          </button>
        ) : (
          <button
            type="button"
            draggable={false}
            disabled={!item?.canGenerate || removing}
            onClick={() => requestProxyGeneration(assetId)}
          >
            {action}
          </button>
        )}
        {item?.entry ? (
          <button
            type="button"
            draggable={false}
            disabled={active || removing}
            onClick={() => {
              setRemoving(true)
              void removeProxy(assetId).finally(() => setRemoving(false))
            }}
          >
            {removing ? 'Removing…' : 'Remove proxy'}
          </button>
        ) : null}
      </div>
    </section>
  )
}
