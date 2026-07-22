// Funny Looking Rock -- internal revision number.
// Single source of truth: bump this on each meaningful change; the header stamps
// it on load so you can tell which build you're looking at.
//
//   v2.8  skew correction: the card 4 corners give a homography into true mm, so
//         off-square photos read correctly (card no longer just a scale number).
//   v2.7  card is now optional -- scale self-calibrates from the known cut
//         spacing (square-on photo); card stays as an override.
//   v2.6  bow<->blade connection is now a real CSG boolean union (Manifold, WASM,
//         bundled) instead of a hand-weld — keygen's technique in the browser.
//   v2.5  mirror the warding cross-section to match a real key's handedness (a
//         paracentric keyway is handed; the previous section was flipped).
//   v2.4  generic bow (BEST) now has a full-height neck so the wide paddle no
//         longer butts into cut #1.
//   v2.3  tip now bevels only the top edge (warding stays full-size) so the tip
//         actually fits the keyway, instead of squeezing the whole section.
//   v2.2  when the key can't be auto-seen, lay the cut lines out at the blank's
//         real spacing inside the card (no more stacked pile); scroll-to-zoom and
//         drag-to-pan the photo for precise placement.
//   v2.1  shoulder line stays square to the (fitted) back edge; cut handles are
//         thin height lines instead of key-blocking dots; red/orange legend.
//   v2.0  Set scale auto-detects the card (Otsu + convex extreme corners); you
//         only nudge if it's off.
//   v1.9  rebuilt decode as a manual tracer: green BACK-edge line = depth datum,
//         red dot per cut you drag into each valley (slide both ways); 3D panel
//         hidden until Generate; in-app "How this works" diagram.
//   v1.8  fix auto-place tip landing on the wrong side (decode ran off the key);
//         anchor cuts at known positions + valley-snap (no global mis-register);
//         rotate / mirror / flip photo controls.
//   v1.7  scale is now set by dragging the card's 4 corners (in-page, no prompt()
//         which the sandboxed artifact iframe blocked); live px/mm readout.
//   v1.6  bow welded to blade as one watertight manifold; bow matched to blade
//         thickness so the key prints flat; version badge in the header.
//   v1.5  flat-print + single-manifold groundwork, app-side decode UI, real bows.
export const VERSION = 'v2.8';
