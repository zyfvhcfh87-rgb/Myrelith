/**
 * app/EditorShell.tsx — Lazy editor-only composition root.
 *
 * The launcher never imports this module eagerly. Every editor panel, runtime
 * lifecycle, shortcut, and editor stylesheet therefore begins loading only
 * when a project entry action explicitly prepares the editor boundary.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ComponentType,
} from 'react'
import './layout.css'
import Toolbar from '../ui/Toolbar'
import ToolButtons from '../ui/ToolButtons'
import MediaPool from '../ui/MediaPool'
import Preview from '../ui/Preview'
import SourceMonitor from '../ui/SourceMonitor'
import Inspector from '../ui/Inspector'
import TransportBar from '../ui/TransportBar'
import Timeline from '../ui/timeline/Timeline'
import TimelineZoomControls from '../ui/timeline/TimelineZoomControls'
import WorkspaceControls from '../ui/WorkspaceControls'
import WorkspaceResizeHandle from '../ui/WorkspaceResizeHandle'
import { PluginInspectorSurfaces, PluginPreviewSurface } from '../ui/plugins/PluginEditorSurfaces'
import { fitWorkspaceLayout } from '../ui/workspaceLayout'
import {
  WORKSPACE_PANEL_LIMITS,
  useWorkspaceLayoutStore,
} from '../state/workspaceLayoutStore'
import { useUndoRedoShortcuts } from './useUndoRedoShortcuts'
import { useEditShortcuts } from './useEditShortcuts'
import { initMediaVisuals } from './mediaVisualsController'
import { initMediaCapabilityLifecycle } from './mediaCapabilityController'
import { initSelectionReconciliation } from './selectionReconciliationController'
import { initProxyController } from './proxyController'
import { initMotionAnalysisRuntime } from './motionAnalysisRuntime'
import { getPluginAppController } from './pluginAppController'
import { setPreviewPluginBinding } from './previewController'
import {
  clearMediaPlacementPreview,
  teardownMediaPlacementUi,
} from './mediaPlacementController'
import {
  isEditorFileDropTarget,
  isFileDrag,
} from '../ui/fileDrag'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'
import { EditorContextMenuHost } from '../ui/EditorContextMenu'

const pluginAppController = getPluginAppController()

export interface EditorShellProps {
  closing: boolean
}

export default function EditorShell({ closing }: EditorShellProps) {
  const shellRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ width: 1440, height: 900 })
  const [workspaceAnnouncement, setWorkspaceAnnouncement] = useState('')
  const [ProxyBenchmarkPanel, setProxyBenchmarkPanel] = useState<ComponentType | null>(null)
  const workspace = useWorkspaceLayoutStore()
  const documentId = useDocumentStore((state) => state.doc.id)
  const fitted = fitWorkspaceLayout(workspace, viewport)
  useUndoRedoShortcuts()
  useEditShortcuts()
  useEffect(() => {
    setPreviewPluginBinding(pluginAppController)
    return () => { setPreviewPluginBinding(null) }
  }, [])
  useEffect(() => {
    if (
      !import.meta.env.DEV
      || new URLSearchParams(window.location.search).get('proxyBenchmark') !== '1'
    ) return
    let active = true
    void import('../dev/ProxyEditingBenchmarkPanel').then((module) => {
      if (active) setProxyBenchmarkPanel(() => module.default)
    }, (cause) => {
      console.warn('[EditorShell] proxy benchmark panel failed to load:', cause)
    })
    return () => { active = false }
  }, [])
  useEffect(() => initMediaCapabilityLifecycle(), [])
  useEffect(() => initSelectionReconciliation(), [])
  useEffect(() => {
    let unmounted = false
    let release: (() => Promise<void>) | null = null
    void initProxyController().then((acquiredRelease) => {
      if (unmounted) {
        void acquiredRelease().catch((cause) => {
          console.warn('[EditorShell] proxy controller cleanup failed:', cause)
        })
      } else release = acquiredRelease
    }, (cause) => {
      console.warn('[EditorShell] proxy controller initialization failed:', cause)
    })
    return () => {
      unmounted = true
      if (release) {
        void release().catch((cause) => {
          console.warn('[EditorShell] proxy controller cleanup failed:', cause)
        })
      }
    }
  }, [])
  useEffect(() => {
    let unmounted = false
    let release: (() => Promise<void>) | null = null
    void initMotionAnalysisRuntime().then((acquiredRelease) => {
      if (unmounted) {
        void acquiredRelease().catch((cause) => {
          console.warn('[EditorShell] motion analysis cleanup failed:', cause)
        })
      } else release = acquiredRelease
    }, (cause) => {
      console.warn('[EditorShell] motion analysis initialization failed:', cause)
    })
    return () => {
      unmounted = true
      if (release) {
        void release().catch((cause) => {
          console.warn('[EditorShell] motion analysis cleanup failed:', cause)
        })
      }
    }
  }, [])
  useEffect(() => {
    initMediaVisuals()
  }, [])
  useEffect(() => {
    const onDragOver = (event: DragEvent): void => {
      if (!isFileDrag(event.dataTransfer)) return
      event.preventDefault()
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = isEditorFileDropTarget(event.target)
          ? 'copy'
          : 'none'
      }
    }
    const onDrop = (event: DragEvent): void => {
      if (!isFileDrag(event.dataTransfer)) return
      event.preventDefault()
      clearMediaPlacementPreview()
    }
    const onDragLeave = (event: DragEvent): void => {
      if (!isFileDrag(event.dataTransfer)) return
      if (event.relatedTarget != null) return
      clearMediaPlacementPreview()
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    window.addEventListener('dragleave', onDragLeave)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('dragleave', onDragLeave)
      teardownMediaPlacementUi()
    }
  }, [])
  useEffect(() => () => teardownMediaPlacementUi(), [documentId])
  useEffect(() => {
    const shell = shellRef.current
    if (!shell) return
    const measure = (): void => {
      const bounds = shell.getBoundingClientRect()
      const width = Math.max(720, Math.round(bounds.width || window.innerWidth))
      const height = Math.max(570, Math.round(bounds.height || window.innerHeight))
      setViewport((current) => (
        current.width === width && current.height === height
          ? current
          : { width, height }
      ))
    }
    measure()
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure)
      observer.observe(shell)
      return () => observer.disconnect()
    }
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  const previewSize = useCallback((property: string, value: number): void => {
    shellRef.current?.style.setProperty(property, `${value}px`)
  }, [])
  const previewMedia = useCallback(
    (value: number) => previewSize('--workspace-media-width', value),
    [previewSize],
  )
  const previewInspector = useCallback(
    (value: number) => previewSize('--workspace-inspector-width', value),
    [previewSize],
  )
  const previewTimeline = useCallback(
    (value: number) => previewSize('--workspace-timeline-height', value),
    [previewSize],
  )
  const cancelMedia = useCallback(
    () => previewMedia(fitted.mediaWidth),
    [fitted.mediaWidth, previewMedia],
  )
  const cancelInspector = useCallback(
    () => previewInspector(fitted.inspectorWidth),
    [fitted.inspectorWidth, previewInspector],
  )
  const cancelTimeline = useCallback(
    () => previewTimeline(fitted.timelineHeight),
    [fitted.timelineHeight, previewTimeline],
  )
  const commitMedia = useCallback((value: number): void => {
    useWorkspaceLayoutStore.getState().setPanelSize('media', value)
  }, [])
  const commitInspector = useCallback((value: number): void => {
    useWorkspaceLayoutStore.getState().setPanelSize('inspector', value)
  }, [])
  const commitTimeline = useCallback((value: number): void => {
    useWorkspaceLayoutStore.getState().setPanelSize('timeline', value)
  }, [])
  const shellStyle = {
    '--workspace-media-width': `${fitted.mediaWidth}px`,
    '--workspace-inspector-width': `${fitted.inspectorWidth}px`,
    '--workspace-timeline-height': `${fitted.timelineHeight}px`,
  } as CSSProperties

  return (
    <EditorContextMenuHost closing={closing}>
    <div
      ref={shellRef}
      className="app-shell"
      data-closing={closing ? 'true' : undefined}
      aria-busy={closing}
      style={shellStyle}
    >
      <header className="area-toolbar">
        <Toolbar />
      </header>
      <section className="area-workspace" inert={closing}>
        <WorkspaceControls onAnnounce={setWorkspaceAnnouncement} />
        <span
          className="workspace-status visually-hidden"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {workspaceAnnouncement}
        </span>
      </section>
      <aside
        id="workspace-media-panel"
        className="area-media-pool"
        data-media-pool-scroll
        data-collapsed={fitted.mediaWidth === 0 ? 'true' : undefined}
        aria-hidden={fitted.mediaWidth === 0 || undefined}
        inert={closing || fitted.mediaWidth === 0}
      >
        <MediaPool />
      </aside>
      <WorkspaceResizeHandle
        className="area-media-resize"
        controls="workspace-media-panel"
        label="Resize Media panel"
        orientation="vertical"
        value={fitted.mediaWidth}
        min={WORKSPACE_PANEL_LIMITS.media.min}
        max={fitted.mediaMax}
        direction={1}
        onPreview={previewMedia}
        onCommit={commitMedia}
        onCancel={cancelMedia}
        onAnnounce={setWorkspaceAnnouncement}
        disabled={closing}
      />
      <main className="area-preview" inert={closing}>
        <Preview />
        <SourceMonitor />
        <PluginPreviewSurface />
      </main>
      <WorkspaceResizeHandle
        className="area-inspector-resize"
        controls="workspace-inspector-panel"
        label="Resize Inspector panel"
        orientation="vertical"
        value={fitted.inspectorWidth}
        min={WORKSPACE_PANEL_LIMITS.inspector.min}
        max={fitted.inspectorMax}
        direction={-1}
        onPreview={previewInspector}
        onCommit={commitInspector}
        onCancel={cancelInspector}
        onAnnounce={setWorkspaceAnnouncement}
        disabled={closing}
      />
      <aside
        id="workspace-inspector-panel"
        className="area-inspector"
        data-collapsed={fitted.inspectorWidth === 0 ? 'true' : undefined}
        aria-hidden={fitted.inspectorWidth === 0 || undefined}
        inert={closing || fitted.inspectorWidth === 0}
      >
        <Inspector />
        <PluginInspectorSurfaces />
      </aside>
      <section className="area-transport" inert={closing}>
        <ToolButtons />
        <TransportBar />
        <TimelineZoomControls />
      </section>
      <WorkspaceResizeHandle
        className="area-timeline-resize"
        controls="workspace-timeline-panel"
        label="Resize Timeline panel"
        orientation="horizontal"
        value={fitted.timelineHeight}
        min={WORKSPACE_PANEL_LIMITS.timeline.min}
        max={fitted.timelineMax}
        direction={-1}
        onPreview={previewTimeline}
        onCommit={commitTimeline}
        onCancel={cancelTimeline}
        onAnnounce={setWorkspaceAnnouncement}
        disabled={closing}
      />
      <section
        id="workspace-timeline-panel"
        className="area-timeline"
        data-timeline-scroll
        data-collapsed={fitted.timelineHeight === 0 ? 'true' : undefined}
        aria-hidden={fitted.timelineHeight === 0 || undefined}
        inert={closing || fitted.timelineHeight === 0}
      >
        <Timeline />
      </section>
      {ProxyBenchmarkPanel ? <ProxyBenchmarkPanel /> : null}
      <MediaDropStatus />
    </div>
    </EditorContextMenuHost>
  )
}

function MediaDropStatus() {
  const status = useTransportStore((state) => state.mediaPlacementStatus)
  return (
    <span
      className="visually-hidden"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid="media-drop-status"
    >
      {status}
    </span>
  )
}
