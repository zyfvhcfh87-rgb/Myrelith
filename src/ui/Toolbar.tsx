/**
 * ui/Toolbar.tsx — Top bar: brand, keyboard hints, and the Phase 5.2 export
 * entry point. The heavy workflow mounts only while its dialog is open, so
 * ordinary document/playhead changes keep this bar render-inert.
 */

import { useRef, useState } from 'react'
import ExportDialog from './ExportDialog'

export default function Toolbar() {
  const [exportOpen, setExportOpen] = useState(false)
  const exportButtonRef = useRef<HTMLButtonElement | null>(null)

  const closeExport = (): void => {
    setExportOpen(false)
    requestAnimationFrame(() => exportButtonRef.current?.focus())
  }

  return (
    <div className="toolbar">
      <strong>WebCut</strong>
      <span className="placeholder-note">S splits at playhead · Del ripple-deletes</span>
      <button
        ref={exportButtonRef}
        type="button"
        className="toolbar-export"
        aria-haspopup="dialog"
        aria-expanded={exportOpen}
        onClick={() => setExportOpen(true)}
      >
        Export
      </button>
      {exportOpen && <ExportDialog onClose={closeExport} />}
    </div>
  )
}
