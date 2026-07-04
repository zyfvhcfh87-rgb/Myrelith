/**
 * ui/Preview.tsx — Program monitor. Phase 3.1 placeholder; Phase 3.4 gives
 * it the real <canvas>, transfers control to the render worker once on
 * mount, and subscribes to transportStore.playheadFrame (rAF-throttled).
 * Layering: ui/ imports state/ only (nothing yet).
 */

export default function Preview() {
  return (
    <div className="panel-placeholder">
      <span className="placeholder-title">Preview</span>
      <span className="placeholder-note">canvas arrives in Phase 3.4</span>
    </div>
  )
}
