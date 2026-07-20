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

It's a static site, but browsers need it served over HTTP for ES modules:

```sh
cd 2.5D
python3 -m http.server 8000     # or: npx serve .
# open http://localhost:8000
```

Hosting it on GitHub Pages (or any static host) works as-is.

## Workflow

**1 — Photo & paper.** Load a photo (file picker or drag & drop). Pick the
paper size and its orientation *as seen in the photo*. The app tries to find
the paper's corners automatically; drag the four handles to fine-tune — a
magnifier loupe appears while dragging. The yellow edge marks the paper's top.
Scroll to zoom, drag empty space to pan, double-click to re-fit.

**2 — Trace & holes.** The paper is rectified to a flat, true-scale image and
the object is segmented against the paper colour. You get:

- **Detection threshold / noise cleanup** sliders (with Otsu auto-threshold),
  and a mask overlay toggle to see exactly what's being picked up.
- **Simplify** (Douglas-Peucker tolerance in mm) and **smoothing** (corner
  rounding) for the traced outline.
- **Hole detection** — enclosed background regions become holes automatically.
- **Trace correction** — drag any vertex, click an edge to insert one,
  right/Alt-click (or Delete) to remove one, delete whole holes, and undo with
  Ctrl+Z.
- **Manual holes** — place circular holes by clicking, then edit their exact
  centre and diameter in millimetres (e.g. for mounting holes the camera can't
  see).

**3 — Model & export.** Enter the thickness, choose an edge style for the top
and bottom edges — square, chamfer (45°) or fillet (quarter-round) with a size
in mm — and preview the solid in 3D. Export a binary **STL** (millimetres,
z-up, centred at the origin) or the outline as **SVG** at true scale (handy
for laser cutting or importing into CAD).

## Tips for good photos

- Shoot from directly above, with the object roughly centred over the paper.
  The homography corrects perspective and skew exactly, but ordinary lens
  (radial) distortion isn't modelled — it's smallest near the image centre.
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
npm install          # playwright-core only
npm test             # needs a Chromium; set CHROMIUM_PATH if not auto-found
```
