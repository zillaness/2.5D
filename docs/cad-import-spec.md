# Spec: CAD / drawing import → editable trace

Status: **draft for review** (not yet built). Owner: TBD.

## 1. Goal & value

Let a user start from an **existing drawing** instead of a photo of a physical
object, and still land in the same trace → sections → export pipeline. Two
acquisition paths:

1. **Vector CAD file** — a `.dxf` or `.svg` (later `.pdf`) the user already
   has. Parsed geometrically: exact, deterministic, true-scale.
2. **Photo / scan of a drawing** — a picture of a printed or on-screen
   drawing. Vectorized with computer vision: best-effort, then cleaned up by
   hand.

The payoff is the same as the object pipeline: a messy or non-editable input
becomes a clean vector profile you can extrude and re-export as **STL / DXF /
SVG**. Everything downstream (trace editor, multi-select cleanup, holes,
sections, exporters) already exists — this feature only adds a new front end.

**Non-goal:** being a general CAD viewer or a full raster-to-CAD converter.
It extracts a *2.5D profile* (one plan view → outline + holes), not a full 3D
model or a faithful multi-view reconstruction.

## 2. Fidelity reality check (set expectations up front)

| Input | Fidelity | Effort | Notes |
|---|---|---|---|
| SVG (vector) | Exact | Low | Native `DOMParser`; flatten curves |
| DXF (vector) | Exact | Low–Med | Small parser; layers + units |
| PDF (vector) | Exact | Med | Needs pdf.js; heavier |
| Clean scan of a drawing | Good | Med | Deskew + line-art vectorize |
| Photo of a drawing | Rough | High | Perspective, lighting, JPEG noise |

The vector paths are the real win: precise and cheap. The raster paths are
"assisted tracing," never magic — the UI must say so.

## 3. Architecture fit (browser-only, no server)

- New **source type** in Step 1, alongside "Photo of object":
  **CAD file** and **Photo of drawing**.
- Every importer returns the existing trace model:
  `{ outer: [{x,y}mm], holes: [[...]], units, layers?, views?, warnings }`.
- Steps 2 (trace edit) and 3 (sections + export) are **unchanged**.
- All parsing is client-side so the single-file / artifact / Pages builds keep
  working offline:
  - SVG → `DOMParser` (native).
  - DXF → a small vendored/authored ASCII-DXF parser (no DWG — binary/proprietary).
  - PDF → pdf.js (Phase 3 only; adds weight).
  - Raster → reuse the existing contour pipeline + new line-art handling.

New modules: `js/import/svgImport.js`, `js/import/dxfImport.js`,
`js/import/rasterVectorize.js` (later). A thin `importResultToTrace()` adapter
feeds `traceEditor.setTrace()` and seeds the base section.

## 4. Scale & units (where the reference goes)

- **Vector files carry scale.** SVG has `viewBox` + unit hints; DXF has
  `$INSUNITS` and real coordinates. Use them → true mm, **no paper/coin
  reference needed**. If units are ambiguous (unitless SVG), ask the user to
  confirm the intended unit or set scale by two points.
- **Raster (photo/scan of a drawing) has no inherent scale.** Preference
  order:
  1. **OCR-assisted, from the drawing itself** — read the **title block** for
     the units (e.g. "UNITS: MM", "INCHES", a scale like "1:2") and read a
     **dimension number** off the drawing, then set scale from that dimension.
     Because matching a number to the correct edge is unreliable, this is
     **assisted, not fully automatic**: OCR proposes the units + a list of
     detected dimension values (with positions); the user taps the value and
     the edge it applies to, and the app derives px→mm. (Tesseract.js / WASM.)
  2. **Two-point dimension (manual fallback)** — click two points, type the
     real distance (`50`, `2"`). Reuses the units parser. Always available,
     no heavy dependency.
  3. **Reuse the object reference** — a ruler / scale bar / coin in the shot.

## 5. The hard part: separating the part from the annotation

Engineering drawings are line art full of stuff that is **not** the part:
multiple views, dimension & extension lines, leaders, arrowheads, centerlines,
hidden (dashed) lines, hatching/section fill, borders, title block, and text.

Strategy (vector):
- **Layers** — DXF usually separates `DIM`, `TEXT`, `CENTER`, `HATCH`,
  `BORDER`. Show a layer list with checkboxes; default-off the obvious
  annotation layers. SVG groups/classes similarly.
- **Line type** — dashed/dotted = centerline/hidden → excluded by default.
- **Entity type** — ignore TEXT/MTEXT/DIMENSION/LEADER entities.
- **Geometry** — join endpoints within tolerance, find closed loops, classify
  outer vs holes by area + containment (ray casting; same helpers the mesh
  already uses).

Strategy (raster):
- Preprocess: grayscale → deskew (reuse the homography if a sheet border is
  visible, else Hough-line angle) → adaptive threshold → thin/skeletonize.
- Vectorize: fill enclosed regions and trace boundaries (the app already
  traces filled masks) **or** centerline-trace the strokes.
- The user then **prunes** stray dimension/text geometry with the existing
  multi-select + delete, and cleans curves with the existing arc/line fit.

Multi-view drawings: cluster geometry into candidate views by bounding box,
**highlight the largest as a suggestion, and require the user to confirm/pick**
which view is the plan (top) view. (Leaning to "always choose" rather than
silently guessing — the suggestion just saves a click when it's obvious.)

This view detection is deliberately more than we need for 2.5D — it is the
**groundwork for the 3D goal below**. Even in v1 we detect and label the
top / front / side views; v1 just uses the one the user picks.

## 6. UI flow

1. **Step 1 source selector:** Photo of object · CAD file · Photo of drawing.
2. **CAD file:** drop `.dxf` / `.svg` → preview with a **layer/view panel**
   (checkboxes + highlight) → "Use as trace." Units shown; override if unitless.
3. **Photo of drawing:** load like an object photo but in **line-art mode**,
   with the **two-point scale** tool; then into the trace editor.
4. Lands in **Step 2** exactly like a photo trace. Steps 2–3 identical.

## 7. Phasing (recommended)

Scope answered: **both** paths wanted; formats **DXF + SVG + PDF** (not DWG —
see §9); OCR-assisted scale from the title block + a dimension; view selection
**user-confirmed**. Because two of these add megabytes to the offline file, the
heavy pieces are grouped last behind a bundle-weight decision (§10).

- **Phase 1 — Vector import (DXF + SVG).** Deterministic, no new dependency, no
  bundle bloat. Layer/entity filtering, units from `$INSUNITS`/`viewBox`,
  segment→closed-loop assembly, outer/hole classification, view detection with
  user pick. Lands via the existing `loadOutlineIntoSession()`. **This alone
  satisfies "upload a CAD drawing → get CAD out."**
- **Phase 2 — Photo/scan of a drawing, manual scale.** Line-art vectorize
  (deskew → threshold → trace/skeletonize) + **two-point scale** (no heavy
  dependency), leaning on the existing multi-select/arc-fit tools to prune
  annotation and clean curves. Flat scans first, then perspective photos.
- **Phase 3 — Heavy deps (gated on §10 bundle decision).**
  - **PDF (vector)** import via pdf.js (~1–2 MB).
  - **OCR-assisted scale** via Tesseract.js (~2–4 MB): read title-block units
    + dimension numbers, user confirms the value↔edge mapping.
- **DWG:** not parsed offline (§9); dropping a `.dwg` shows an "export as DXF"
  message. A hosted-only WASM reader is a possible later stretch.

## 7a. Horizon — full 3D from multi-view drawings

The end goal (explicitly desired): reconstruct a **true 3D solid** from an
orthographic sheet (top + front + side), not just a top-view 2.5D extrusion.
The classic, tractable approach that fits this app:

- Extract the closed outline of each of the three standard views (the view
  detection in Phase 1 already isolates them).
- Extrude each view as an infinite prism along its viewing axis, then take the
  **boolean intersection** of the three prisms — the maximal solid consistent
  with all silhouettes. Correct for the large class of parts whose faces are
  axis-aligned; a well-known method with known limits (can't recover blind
  internal detail or non-silhouette features, and mismatched/rounded views need
  care).
- Requires a real 3D CSG kernel (mesh boolean intersection) — a bigger
  dependency than the current 2.5D Clipper+extrude path. This is a separate
  large effort, sequenced **after** the import phases; the import work is a
  prerequisite and is designed with it in mind.

## 8. Testing (matches the existing headless harness)

- **Vector:** synthetic SVG and DXF with known geometry (rect + circular hole,
  known units) → assert extracted outer/hole dimensions in mm, unit handling,
  annotation-layer exclusion, and that the result builds a watertight solid.
- **Raster:** render a synthetic "drawing" (part outline + dimension lines +
  text) to a canvas → assert the part outline is recovered and the annotations
  are excluded (or prunable), plus deskew accuracy on a rotated copy.

## 9. Risks / limitations

- Raster fidelity is inherently limited; photos of drawings worst of all.
  Position as **assisted**, with cleanup expected.
- Multi-view drawings are ambiguous → require a user-confirmed view pick.
- **DWG** is binary/proprietary. No solid pure-JS reader; LibreDWG-WASM is
  several MB, version-sensitive, and GPL (awkward to inline in a permissive
  single-file app). → not offline; show "export as DXF" (every DWG tool can).
- OCR value↔edge association is unreliable if fully automatic → keep it
  user-confirmed.
- **Bundle weight:** pdf.js + Tesseract would grow the ~750 KB offline file to
  several MB — the core value prop is a small double-click file. See §10.
- Splines/beziers are flattened to polylines (lossy but fine for extrusion;
  the arc-fit tool can re-idealize).
- Text-as-outlines can leak into the trace → mitigated by prune tools + area
  filters.

## 10. Decisions

Resolved: build **both** paths; formats **DXF + SVG + PDF**; **DWG** →
export-to-DXF message; view selection **user-confirmed**; raster scale via
**OCR-assisted + two-point manual**; **3D-from-views** is a horizon goal after
imports.

**Still open — heavy-dependency packaging (the one real call):** how should
pdf.js (~1–2 MB) and Tesseract.js (~2–4 MB) ship, given the offline file is
~750 KB today?

- **A. Inline everything** — one self-contained file, but it grows to several
  MB. Simplest mental model; heavier download.
- **B. Lazy/hosted-only heavy deps** — keep the offline file lean; PDF import
  and OCR load their WASM on demand (works on the hosted / Pages build and
  online; the pure-offline file keeps vector DXF/SVG + two-point raster scale
  only). Preserves the small-file value prop.
- **C. Defer Phase 3** — ship Phases 1–2 now (vector + raster with two-point
  scale, no heavy deps), add PDF/OCR later once B vs A is decided.

Recommendation: **start Phase 1 now regardless** (no bundle impact), and pick
**B** for the eventual heavy deps.
