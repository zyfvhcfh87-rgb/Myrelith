# Timeline speed sections design QA

## Evidence

- Source visual truth: `C:\Users\Aryel\AppData\Local\Temp\codex-clipboard-ec44b368-72d1-4a5e-a619-c2a1ce67174f.png`
- Browser-rendered implementation: `C:\Users\Aryel\.codex\visualizations\2026\08\14\019fff98-733c-75c0-9093-0f6f2a72caa7\timeline-speed-lane-implementation.png`
- Focused implementation crop: `C:\Users\Aryel\.codex\visualizations\2026\08\14\019fff98-733c-75c0-9093-0f6f2a72caa7\timeline-speed-lane-focus.png`
- Combined comparison: `C:\Users\Aryel\.codex\visualizations\2026\08\14\019fff98-733c-75c0-9093-0f6f2a72caa7\timeline-speed-lane-comparison.png`
- State: dark editor, selected linked A/V fixture, playhead at clip frame 180, Detail Zoom, and held speed sections of 100%, 50%, and 100%.
- Viewport: 1440 x 900 CSS px at device pixel ratio 1.
- Source pixels: 963 x 332.
- Implementation pixels: 1440 x 900. Focus crop: 1145 x 270.
- Density normalization: the focused implementation crop was proportionally downsampled to 963 px wide and stacked with the unscaled reference in the 963 x 607 comparison image.
- Comparison scope: the supplied Resolve screenshot is an interaction reference for a clip-attached speed section lane, not a request to reskin Myrelith as Resolve.

## Findings

- No actionable P0, P1, or P2 differences remain.
- Fonts and typography: the compact 8 px percentage labels use Myrelith's existing timeline type treatment and stay readable in Detail Zoom. No foreign Resolve typography was copied into the product.
- Spacing and layout rhythm: the 13 px lane sits directly below the video content inside the existing 35 px clip height. It does not enlarge tracks, overlap trim handles, or duplicate onto linked audio.
- Colors and visual tokens: normal sections use the existing navy family, slow sections use a restrained violet, fast/freeze states have distinct semantic colors, and white boundaries retain contrast against every tone.
- Image quality and asset fidelity: the clip filmstrip remains sharp and uncropped above the lane. This interaction does not require a new image or icon asset.
- Copy and content: `Speed at playhead`, boundary guidance, whole-clip fallback, and frame/percentage labels describe the authored behavior without leaking implementation terminology.
- Affordance and state: section boundaries align to exact clip-local frames; labels clearly identify the active rate; the selected clip, playhead, waveform, and Inspector stay visually coherent.

## Browser verification

- Created a 1920 x 1080, 30 fps project and imported a generated 8-second H.264/AAC fixture.
- Dragged the fixture to V1 and confirmed linked video/audio placement.
- Scrubbed to clip frame 60 and chose 50% in `Speed at playhead`.
- Scrubbed to clip frame 180 and chose 100%, producing the visible bounded 100% / 50% / 100% sections.
- Confirmed the linked audio retimes with the video but does not render a duplicate speed lane.
- Confirmed the Inspector reports the authored point and updated 300-frame duration.
- Confirmed the three percentage labels and exact boundary lines at Detail Zoom.
- Browser console warnings/errors: none.

## Full-view comparison evidence

The 1440 x 900 editor capture shows the complete Myrelith workspace without clipped persistent controls, broken panel layout, or timeline overlap. The new lane remains subordinate to the clip imagery and uses the established navy editor shell.

## Focused-region comparison evidence

The combined image compares the supplied Resolve speed-change strip directly with the implemented Myrelith timeline. Both show one clip divided into labeled rate sections with vertical boundaries and a continuous relation to the source imagery. Myrelith intentionally uses a compact in-clip strip instead of Resolve's expanded header and chevrons so it fits the existing track density and interaction language.

## Comparison history

- Pass 1: [P2] the speed strip appeared on both the video and its linked audio clip, creating redundant visual weight and drifting from the reference's video-owned lane. Fixed by restricting the presentation lane to video tracks while preserving linked timing semantics.
- Pass 2: the focused comparison shows one video-owned strip with three readable sections and no audio duplication. No P0/P1/P2 findings remain.

## Implementation checklist

- [x] Author speed boundaries at the exact playhead frame.
- [x] Keep explicit whole-clip retiming available as a separate control.
- [x] Show persisted rate sections and boundary lines below video content.
- [x] Keep linked audio timing correct without a duplicate lane.
- [x] Surface ordinary and effect-parameter keyframes without duplicate frame markers.
- [x] Verify the complete interaction in the browser with a clean console.

## Follow-up polish

- None required for handoff.

final result: passed
