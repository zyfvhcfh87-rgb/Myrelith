/**
 * ui/Toolbar.tsx — Top bar: brand + keyboard hints. The timeline tools
 * live in ui/ToolButtons.tsx inside the transport strip (user request);
 * Export lands here in Phase 5.2. Layering: ui/ imports state/ only
 * (currently nothing — this bar is render-inert).
 */

export default function Toolbar() {
  return (
    <div className="toolbar">
      <strong>WebCut</strong>
      <span className="placeholder-note">S splits at playhead · Del ripple-deletes</span>
    </div>
  )
}
