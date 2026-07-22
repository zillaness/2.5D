// Copyright (C) 2026 Projects and Mods
// GPL-3.0-or-later WITH Commons Clause (non-commercial) - see LICENSE.

// Funny Looking Rock -- internal revision number.
// Single source of truth: bump this on each meaningful change; the header stamps
// it on load so you can tell which build you're looking at.
//
//   v4.0  nicer keys: BEST gets its own fuller SFIC-style bow (was the bare
//         generic paddle); the generic/BEST bows now have concave "waist" fillets
//         easing the neck into the head + finer arcs; the blade tip is a rounded
//         (circular-eased) nose instead of a straight chamfer.
//   v3.9  shape-based bow auto-detection: flood-fill finds the keyring hole (the
//         bow's unique feature) — else the silhouette's principal-axis wide end —
//         and orients back[0] to the bow, so the bitting can't default backwards.
//   v3.8  correct the read-direction note: keygen numbers Schlage bow->tip (same
//         as us, so Schlage codes transfer directly) — BEST/SFIC is the lone
//         exception at tip->bow, so only BEST codes need reversing.
//   v3.7  green back-edge line now labels the TIP end with an arrow; a "Flip
//         bow<->tip" button reverses the reading; warn that reading direction is
//         per-keyway (this app numbers bow->tip).
//   v3.2  add playing/trading card (2.5x3.5 in) as a 6th reference-size preset.
//   v3.1  reference-size picker (CR80/CR79/CR100 + 1/2 & 1/3 CR80 key tags) drives
//         the scale+skew homography; clarify flat-on-bed print + card-corrects-skew.
//   v3.0  drop the shoulder (no longer a decode datum) — two datums now: back edge
//         + cut dots; nicer realistic key diagram opens in a modal window.
//   v2.9  card detect fits lines to the edges (not rounded corners); drag card
//         EDGES to align; brought back the labelled key diagram (bow left, cuts up).
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
export const VERSION = 'v4.0';
