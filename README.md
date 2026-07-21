# 2.5D — photo → traced outline → printable solid

Take a picture of an object lying on a sheet of paper, type in the object's
thickness, and get a 3D-printable STL back.

The paper is the trick: its size is known (A4, US Letter, any ISO sheet, or a
custom size), so once you mark its four corners the app removes the camera's
perspective and skew with a homography and knows the real size of every pixel.
The object is then traced automatically at millimetre scale, you clean up the
trace and add holes, and the outline is extruded by the thickness — with
optional chamfers or fillets on the top and bottom edges.

Tools like TraceFinity go the other way — scanning an object to carve a
matching *cutout* (for foam inserts, organizers). This app is the opposite: it
builds the **positive solid** of the object itself, so you can reprint a flat
part, a bracket, a gasket, a game piece, a knob backplate…

Everything runs in the browser. No server, no build step, no uploads — your
photo never leaves your machine.

| 1 — Photo & paper | 2 — Trace & holes | 3 — Model & export |
| --- | --- | --- |
| ![corners](docs/step1-corners.png) | ![trace](docs/step2-trace.png) | ![model](docs/step3-model.png) |

## Running it

**No hosting needed** — grab [`dist/2.5d-local.html`](dist/2.5d-local.html)
(one self-contained ~700 KB file, everything inlined) and double-click it. It
runs entirely offline; rebuild it after source changes with `npm run build`.

For development, the un-bundled source needs a static server (browsers block
ES modules over `file://`):

```sh
cd 2.5D
python3 -m http.server 8000     # or: npx serve .
# open http://localhost:8000
```

### Hosting on GitHub Pages (optional)

GitHub Pages serves a repo's files as a website, free, straight from GitHub —
no server of your own, and since this app is plain static files with no build
step, it works as-is:

1. On GitHub open **Settings → Pages** for this repository.
2. Under **Build and deployment**, set **Source** to *Deploy from a branch*,
   pick the branch (e.g. `main` after merging) and folder **/ (root)**, and
   save.
3. After a minute the site is live at `https://<user>.github.io/<repo>/`
   (for this repo: `https://zillaness.github.io/2.5D/`). Every push to that
   branch redeploys automatically.

Notes: the site URL is public to anyone who has it (Pages from a free-plan
repo is always a public site), but that only exposes the app itself — photos
are processed entirely in the visitor's browser and never uploaded anywhere.
If you'd rather not publish at all, the single-file `dist/2.5d-local.html` is
the fully offline option.

## Workflow

**1 — Photo & reference.** Load a photo (file picker or drag & drop) and pick a
**reference** to set real-world scale:

- **Rectangle** — a sheet of paper (defaults to US Letter), or a
  **credit/ID card** or **US bill** you always have on hand. Its corners are
  auto-detected; drag the four handles to fine-tune (a magnifier loupe appears
  while dragging, the yellow edge marks the top). A rectangle corrects
  perspective and skew exactly.
- **Coin** — scale only. Drag a circle over a coin (US quarter, dime, €2, …,
  or a custom diameter) and its edge handle to the rim. Shoot straight down,
  since a coin can't correct perspective. Best for small objects where a full
  sheet of paper is overkill.

A **Rotate photo** control uprights a sideways shot in 90° steps (the corners
rotate with it). Or skip the photo entirely and **import a vector drawing** —
see below.

### Import a CAD drawing (DXF / SVG)

Step 1 has an **Import CAD file** button: drop a `.dxf` or `.svg` and its
geometry lands straight in the trace at true scale (units come from the file —
DXF `$INSUNITS`, SVG `width`/`viewBox`). Segments are stitched into closed
loops, obvious annotation layers/linetypes (dimensions, centre/hidden lines,
hatching, title block) are filtered out, and the outer boundary + holes are
detected automatically. Curves come in as curves: DXF `ARC`/`CIRCLE`/`ELLIPSE`
**and polyline vertex bulges**, plus SVG `A` arcs and `<circle>`/`<ellipse>`,
are all flattened — so a 2.5D SVG/DXF export (fillet arcs as bulges/`A`, holes
as true circles) re-imports as the same curved geometry, not faceted chamfers. A multi-view sheet shows a **view picker** — click the
plan/top view to use it. Everything then edits and exports like any other
trace. (`.dwg` is binary and unsupported — export it as DXF from your CAD app.)

**2 — Trace & holes.** The photo is rectified to a flat, true-scale image and
the object is segmented against the background colour. You get:

- **Detection threshold / noise cleanup** sliders (with Otsu auto-threshold),
  and a mask overlay toggle to see exactly what's being picked up.
- **Simplify** (Douglas-Peucker tolerance in mm) and **smoothing** (corner
  rounding) for the traced outline.
- **Rotate 90° left/right** — reorient the rectified image and all traced
  geometry together, handy when the shot came out sideways.
- **Lens distortion** — a slider (with an **Auto** button that reads the
  paper's edges) that straightens barrel/pincushion bowing so measurements stay
  accurate to the corners, not just the centre. See the note under Tips.
- **Hole detection** — enclosed background regions become holes automatically.
- **Trace correction** — drag any vertex, click an edge to insert one,
  right/Alt-click (or Delete) to remove one, delete whole holes, and undo with
  Ctrl+Z.
- **Multi-select & run cleanup** — Ctrl/⌘-click points or Shift-drag a marquee
  to select several; drag the group to move it, Delete to remove it. On a
  selected run: **Fit arc** (least-squares circle → smooth arc with an editable
  radius), **Fit line** (straighten), **Tangent** (round a blunt/rough corner
  into a **live fillet arc** — see below), **Densify** (add points), **Reduce**
  (thin points).
- **Straighten (reversible)** — Ctrl-click any two points and **Straighten**
  collapses the run between them to a single straight segment, removing the
  in-between points but **stashing** them: **Restore points** brings them back.
  The result is a managed straight line (tinted), which pairs with the tangent
  constraint below.
- **Live tangent fillets** — the **Tangent** button turns a selected corner run
  into a first-class fillet arc that *stays* tangent to both adjacent edges as
  you edit: drag a neighbouring vertex, or apply an H/V/perpendicular
  constraint to an adjacent edge, and the fillet re-derives itself to keep
  meeting both edges cleanly. Its radius is editable (and shown in the arc
  field), and **Release** turns it back into plain, independently-editable
  points. Any edit that reaches inside the fillet's run also releases it
  automatically. Fillets are saved with projects and library outlines. (Under
  the hood the arc is stored symbolically — corner + radius — and rasterised to
  points only for the mesh/export, so the solid pipeline is unchanged.)
- **Normalize traced holes** — an explicit button (never automatic) replaces a
  photo-detected hole with a least-squares fitted perfect circle, which is then
  draggable and editable like any placed hole; "All round holes" converts every
  round-ish one at once.
- **Detect fillets** — the outline counterpart: scans the outline, traced holes
  and sections for cleanly-rounded corners (e.g. from an imported drawing, or a
  2.5D arc re-imported from DXF/SVG) and converts each into a **live fillet arc**
  entity — so imported curves become editable and re-export as true arcs.
  Conservative by design: only well-fitting circular runs bracketed by straight
  edges are converted, so sharp corners and noisy traces are left alone. Traced hole loops can also be dragged whole, and the
  vertex control points can be toggled on/off.
- **Screw holes** — click to place round holes (or **click-drag to size one on
  the spot**; a floating ⌀ box appears right at the hole for typing the exact
  value), then give each one a type:
  - **Through**, **blind** (flat-bottom pocket with a depth), **countersunk**
    (cone for flat-head screws) or **counterbored** (cylindrical recess for
    socket-head screws), each from the **top or bottom** face.
  - Pick a screw from the built-in **metric (M2–M10) or SAE (#2-56–3/8-16)
    table** and a fit, and the bore is sized with the print-friendly
    **±½-pitch rule**: *clearance* = nominal + ½ pitch (screw slides through),
    *thread-into-print* = nominal − ½ pitch (the screw cuts its own thread).
    That's deliberately looser than a machinist's tap drill (nominal − pitch):
    a tap cuts clean threads, a screw biting into printed plastic needs more
    room. The computed ⌀ is shown with its math and stays editable.
  - Countersink ⌀/angle (90° metric, 82° SAE) and counterbore ⌀/depth are
    seeded from head dimensions with printing clearance — all editable.
  - **Heat-set inserts** (M2–M8): pick the size and the hole becomes a blind
    pocket at the recommended melt-in diameter and depth (from a brass-insert
    table, not the screw-bore rule) — editable, since values vary by brand.
  - Each hole's **rim** can also get its own edge break — square, **chamfer**
    (45°) or **fillet** (quarter-round) with a size in mm, independently at the
    top and bottom face. Rows appear only where the hole actually opens (a
    blind hole has one rim; a countersink already breaks its own face's edge).
    Handy for de-burring-style chamfers on print-facing holes or a soft fillet
    where a strap or cable passes through.
  - Newly placed holes copy the last one you edited, so a row of identical
    screw holes takes one setup. Position and every dimension can also be
    typed exactly in mm.

**Measure — 📏.** Read dimensions straight off the photo instead of exporting
to a slicer to check them. The measure tool snaps to corners, edge midpoints,
hole centres and points-on-edges; what you pick decides what you get:

- **Two points** — straight-line distance, with Δx/Δy in the panel.
- **Point + edge** — perpendicular distance (edge offsets, wall thicknesses).
- **One edge** (click it twice, or once then empty space) — its length.
- **Two edges** — the angle between them; near-parallel edges (< 5°) also
  report the **face-to-face gap**, like a caliper across two faces.
- **A hole** (traced or placed) — radius and ⌀ via least-squares circle fit.

The panel always shows the part's overall W×H, outline perimeter and area.
Measurements persist as on-canvas annotations that **live-update as you edit
the trace**, are deletable one-by-one, and follow the mm/in toggle.

**Constraints — ⊾.** Square up a traced outline instead of nudging vertices by
eye. Pick one or two entities (corner, edge, hole), then apply:

- **H / V** — force an edge horizontal or vertical.
- **⊥ Perpendicular / ∥ Parallel / = Equal length / ⋯ Collinear** — between
  two edges.
- **◎ Concentric** — two placed holes share a centre.
- **◠ Tangent to ⌀/arc** — pick a straight edge + a hole/circle **or a fillet
  arc (corner radius)** and the edge is driven tangent to it (its distance to
  the centre equals the radius), re-solving live as you move things. Click
  anywhere on a fillet to pick it as the tangent target.
- **Length… / Angle… / Distance…** — dimension constraints with a typed value
  (prefilled with the current measurement): fix an edge's length, the angle
  between two edges, or the distance point↔point / point↔edge /
  **hole-centre↔edge** — the way to locate a hole exactly off a datum edge.
- **⚓ Anchor** — pin a point so the solver moves everything else around it.

Constraints stay active: drag any point and a dashed **ghost preview** shows
where the solver will put the geometry; release to commit. They're listed in
the panel with per-item delete, survive undo, and are saved with projects and
library outlines. (The solver is an iterative projection pass — conflicting
constraints settle on a compromise rather than erroring.)

**Units** — display defaults to millimetres with an mm/in toggle in the
header, but every dimension field parses any unit regardless of the toggle and
converts to mm: `12.7`, `12,7` (comma decimal), `.5"`, `1/2 in`, `1 1/2"`,
`3/8"`, `12 mm`, `1.2 cm`, `0.3 m`, `2 ft`, and feet-inches like `1' 6"` or
`1 ft 6-1/2 in`.

**Projects** — the 💾 Project button (header) saves or restores everything:
the reference/paper settings, corners (or coin), the trace with all holes and
sections, and the rectified image, as a JSON file or via copy/paste. That copy/paste path matters in embedded
views that block file downloads (the Claude artifact does): copy the project
there, paste it into the offline `dist/2.5d-local.html` or a hosted copy, and
export from that — no re-tracing.

**3 — Model & export.** Enter the thickness, choose an edge style for the top
and bottom edges — square, chamfer (45°) or fillet (quarter-round) with a size
in mm — and preview the solid in 3D.

**Sections — different thicknesses & overhangs.** The model isn't limited to
one height. Draw extra sections with the **▱ Section** tool in step 2 (click
points, double-click or Enter to close), then give each its own **thickness**
and **floor offset** in step 3: a raised boss on a thinner plate, a stepped
part, or an overhang that floats above the build plate (floor offset > 0 —
your slicer will want supports if nothing is underneath). Each section is a
watertight shell; overlapping sections are exported together and every slicer
unions them. **Bed-level sections (floor offset 0) are clipped to the object
outline** — they re-thickness the part but can't add material beyond its
silhouette, so a roughly-drawn section never leaves stray tabs. A section with
a **floor offset > 0 keeps its full footprint** (it's treated as a deliberate
overhang/cantilever that may reach past the outline); you'll see a warning if a
bed-level section spilled over and was trimmed. Screw holes cut through every section they pass through, and the
countersink/counterbore/blind feature automatically lands on the true entry
face — the topmost section for "from top" holes, the bottommost for "from
bottom".

**Suggest regions.** In step 2, **▨ Suggest regions** scans the photo for
visually-distinct areas inside the object — a boss catching the light, a
shadowed pocket, a differently-coloured pad — and drops each in as an **editable
section** (drag its control points like any trace). It's the footprint helper
for sections, the counterpart to hole-detection and Detect fillets: conservative
(only reasonably large, compact patches that stand out from the object's median
brightness), user-confirmed, and fully editable or deletable. **It can only
guess the *where*, never the *how tall*** — a single flat photo carries no depth,
so each suggested region comes in at the base thickness and **you set its
thickness / floor offset** in step 3 (taller = a raised boss; floor offset > 0 =
an overhang). For true auto-height you'd need multiple views (photogrammetry —
see the horizon).

**Export.** A binary **STL** (millimetres, z-up, centred at the origin), or
the outline as **SVG** or **DXF** at true scale (for laser cutting or CAD; the
2D exports use the base outline). The 2D exports are **arc-aware**: fillet arcs
come out as real arcs (SVG `A` commands, DXF polyline **bulges**) and screw
holes as true circles (SVG arc subpaths, DXF **CIRCLE** entities) instead of
many-sided polygons — cleaner geometry for a CAD or laser hand-off. An **export
quality** preset (coarse → extra fine) bundles the round-feature resolution and
curve-segment count. Every export carries the app version in its
header/metadata. The **💾 Project**
button also has an **outline library** that saves drawer/toolbox/tray outlines
to this browser for reuse (foundation for the upcoming foam/Gridfinity
exports).

## Tips for good photos

- Shoot from directly above, with the object roughly centred over the paper.
  The homography corrects perspective and skew exactly. Ordinary lens (radial)
  distortion — smallest near the image centre — is now correctable: nudge the
  **Lens distortion** slider in step 2 until the paper edges look straight, or
  press **Auto** to estimate it from those edges. Helps most with wide-angle /
  phone-macro shots and objects near the frame edge.
- Use flat, diffuse light. Hard shadows next to the object are the main cause
  of a fat trace; if a shadow gets picked up, raise the threshold or fix the
  outline by hand.
- Contrast matters: a dark or coloured object on white paper works best. A
  white object on white paper won't segment well.
- Keep the paper flat (tape the corners) and all four corners in frame.
- Only the outer silhouette is captured — this is a 2.5D tool. Internal
  pockets, steps, or overhangs need real CAD.

Accuracy on synthetic test images is ~0.1 mm; on real photos it's limited by
camera distortion, shadowing and how flat the paper is — expect a few tenths
of a millimetre with a careful photo.

## How it works

- `js/homography.js` — 4-point DLT homography; inverse-mapped bilinear
  rectification of the paper at up to 8 px/mm.
- `js/detectPaper.js` — automatic corner finding: brightness/saturation
  scoring, Otsu threshold, largest connected component, convex hull, best
  quadrilateral.
- `js/segment.js` — object segmentation by colour distance from the paper
  (median border colour), with shadow-tolerant weighting, morphological
  cleanup, connected components.
- `js/contour.js` — exact boundary loops from the mask (directed pixel-edge
  walking, so holes come for free), collinear collapse, RDP simplification,
  Chaikin smoothing.
- `js/mesh.js` — solid construction: outline minus holes via Clipper
  (robust against self-intersections from manual edits), chamfer/fillet as a
  stack of inward polygon offsets, side walls stitched by an arc-length "zip"
  that preserves sharp corners, caps triangulated with earcut. If an offset
  would split or empty the shape (treatment bigger than a feature), it clamps
  and flattens there instead of producing a broken mesh.
- `js/exporters.js` — binary STL and true-scale SVG.
- Rendering: three.js; polygon clipping: clipper-lib; triangulation: earcut —
  all vendored in `vendor/` (MIT / ISC / Boost licences, see the files).

## Tests

An end-to-end test renders a synthetic photo with a known homography, drives
the app headlessly and checks corner detection (< 3 px), trace accuracy
(< 0.2 mm), mesh dimensions, chamfer/fillet insets, and that every generated
mesh is watertight (each edge shared by exactly two triangles) — including
degenerate cases like fillets meeting at half thickness and treatments larger
than the shape:

```sh
npm install          # playwright-core + esbuild only
npm test             # needs a Chromium; set CHROMIUM_PATH if not auto-found
npm run build        # regenerate dist/2.5d-local.html
```

## Roadmap

### Shipped

Card/bill/coin references, **vector CAD import (DXF/SVG)** with a multi-view
picker, heat-set inserts, DXF export, STL quality presets, hole drag rework
(centre = move, rim = resize), point multi-select (Ctrl-click + marquee) with
group move/delete, arc/line fitting and densify/reduce on a selected run,
rotate view 90° (both the trace step and the corner-setting step), radial
lens-distortion correction, the container outline library, **in-app
measurement tools** (point/edge distances, angles, face-to-face gaps, radii,
part size) and **geometric constraints** (H/V, perpendicular, parallel, equal,
collinear, concentric, dimensioned length/angle/distance, anchors, with live
ghost-preview solving), and **live tangent fillet arcs** (first-class arcs that
re-derive themselves to stay tangent to their neighbouring edges as you edit,
with an editable radius and a release-to-points escape hatch) are all **done**
and in the app.

*(PDF drawing import — "picture of a CAD drawing → CAD out" — moved to the
separate **Blueprint** fork, which owns the CAD-drawing-import direction.)*

### Next up

- *(The arc workflow is complete end-to-end: create fillets → they stay tangent
  live → export as true arcs/circles → re-import as arcs → **Detect fillets**
  turns imported curves back into editable arc entities.)* Open threads live in
  the horizon/tabled lists below.

### Horizon

- **Keys** — trace your own key's blade profile and pick a keyway/blank
  (Schlage C, Kwikset KW1/4, …), optionally auto-detecting the type. Keys are
  small, so the coin or card reference is the right scale.
- **Full 3D from multi-view drawings** — reconstruct a solid from top/front/
  side by extruding each view and intersecting (needs a 3D boolean kernel).
  The Phase 1 view detection is the groundwork; see `docs/cad-import-spec.md`.

### Tabled (deprioritized for now)

- Multi-tool scanning → drawer/toolbox layout — scan several tools, save their
  traces, and pack them into a drawer or toolbox insert (per-tool pockets,
  nesting). The outline library is the seed for this.
- Photo/scan line-art vectorization (two-point scale) — only needed to recover
  geometry from a pure raster photo of a drawing; PDF (in the Blueprint fork)
  covers the common case.
- Tool-foam negative export (block minus offset outline).
- Gridfinity bin with the object as a cutout.
- Custom Gridfinity baseplates shaped to a saved outline.
- Surface textures / knurling via a second detection threshold.
- Photogrammetry — multi-photo full-3D reconstruction.
