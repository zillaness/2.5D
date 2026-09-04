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
  **credit/ID card** or a **banknote** you always have on hand. Currency is
  grouped into submenus in the picker (US & Canadian bills, euro €5–€100, UK
  £5–£50, Australian $5–$100) so the list stays tidy. Corners are auto-detected;
  drag the four handles to fine-tune (a magnifier loupe appears while dragging,
  the yellow edge marks the top). A rectangle corrects perspective and skew
  exactly.
- **Graph paper / dot grid / cutting mat** — calibrate off a printed grid
  instead of the sheet's edges. Pick the pitch (metric 1–10 mm, imperial
  1/10–1 in, cutting-mat presets, or a custom one) and put the four handles on
  grid intersections or dots — **the squares they span are counted for you**
  (type the counts to override). Corrects perspective exactly, and the sheet's
  edges never have to be in frame — so it suits objects bigger than the paper,
  or laid across two sheets. See "Graph paper, dot grids & cutting mats" below.
- **Scale bar** — the universal manual override: drag a bar's two ends onto
  any two points a known distance apart (the 0 and 30 cm marks on a mat's
  ruler, a tape measure, a part you've measured) and type the distance
  (mm or inches). Scale only, like the coin, so shoot straight down.
- **Coin** — scale only. Drag a circle over a coin (US, Canadian, euro, UK, or
  Australian — grouped by country in the picker, round denominations only — or a
  custom diameter) and its edge handle to the rim. Shoot straight down,
  since a coin can't correct perspective. Best for small objects where a full
  sheet of paper is overkill.

A **Rotate photo** control uprights a sideways shot in 90° steps (the corners
rotate with it). Or skip the photo entirely and **import a vector drawing** —
see below.

**Capture area — object larger than / beside the reference.** By default the
rectified image is cropped to the reference rectangle, so the object has to sit
*on* it. Set **Capture area** to *Extend* and the perspective-corrected plane
grows beyond the reference, so a small card can calibrate a big object that
overhangs it — or one placed beside it — with full perspective correction, not
just scale. Keep the object on the **same flat surface** as the reference and
all four reference corners **visible**. The segmenter then treats both the paper
*and* the surrounding surface as background (so it still finds the object), and
any area outside the photo comes back as a black no-data border. It's less
forgiving than a reference the object fits on — a bigger sheet is still best
when you have one — but it beats being limited to the paper's footprint.

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

**Labels — emboss & deboss (🅰 Label).** Put a part number, a name or a mark on
a face. Click the part to place a label, **drag it anywhere**, and drag its round
handle to rotate to **any angle** (Shift snaps to 15°). Set the **cap height**,
the **depth** (how far it stands proud or sinks in), the face (**top or bottom**),
a font, and **Mirror** for stamps — bottom-face labels mirror by default so they
read correctly when you flip the part over. Text comes from the platform's own
fonts, so nothing is bundled and letter counters (the middle of *O*, *A*, *8*)
stay open.

- **Emboss** — each letter becomes its own raised prism seated on the face and
  trimmed to the part, unioned by your slicer exactly like overlapping sections.
- **Deboss** — carved as glyph-shaped blind recesses in a **single watertight
  shell**: vertical glyph walls, an exact-depth floor, letter counters left
  standing — the same construction as a blind screw hole, generalized to
  arbitrary outlines, still with no 3D boolean kernel involved. Each label
  gets its **own exact depth** (mixed depths on one face are fine).
  Countersinks, counterbores and blind holes now **keep their shape on the
  debossed face too**, as long as they sit clear of the lettering; a feature
  that overlaps a glyph (or a glyph crowding an edge chamfer/fillet) falls
  back to the previous two-layer split, demoting only that overlapping
  feature to a plain bore, with a warning.

Labels live in the trace overlay (green = emboss, orange = deboss) and are saved
with the project.

**Holders & organizers (step 3).** Instead of printing the object, print a
*home* for it. Pick **Foam-style insert** under *Holder / organizer* and the
3D view previews a rounded slab with the tool pocketed into the top:
**clearance** around the outline so it drops in, **pocket depth** (defaults
to the object's thickness), a **floor** beneath (0 punches the pocket
through), a **border** of slab material, and a **finger notch** on any edge
for lifting the tool out. Traced holes in the tool stay as **support
pillars** — they poke into the tool's own openings (a tape-roll core, a
wrench's hang hole) exactly the way letter counters stand in a debossed
label, and it's the same single-shell recess construction, so the insert is
one watertight mesh with an exact-depth floor. Export as **STL**, or as a
true-scale **cut template SVG** (slab + pocket + pillars) for cutting real
Kaizen foam on a laser or with a knife.

**Finger notches, placeable.** Every pocket can carry a finger notch and you
control where it sits: in the single-tool foam and Gridfinity modes pick an
edge or **Custom position…** and slide the notch anywhere around the outline
(live 3D preview); in the layout editor tick **Finger notch** on a selected
tool and **drag the amber marker** — it snaps to the pocket boundary
wherever you drop it, rides along with moves and rotations, and counts
toward collision/border checks (a notch pointing at a Gridfinity wall
flags red and bumps the bin size).

**Multi-tool drawer layouts.** Pick **Multi-tool drawer insert** to open the
layout editor: choose a container (a plain rectangle, or a **saved container
outline** — photograph the drawer itself on paper and save its trace), then
add tools from the **outline library** or drop in the currently traced
outline. Drag tools to place them, drag the round handle to rotate (Shift
snaps 15°); anything overlapping another pocket or crossing the border turns
red and blocks export until fixed. Each tool pockets at its **own depth**
(saved with the tool, overridable per placement — one insert can hold a
6 mm wrench next to a 2.5 mm ruler). Library entries now carry a **kind**
(tool / container) and their thickness. Preview in 3D, export the insert as
STL, or export the whole layout as a true-scale template SVG for cutting
foam. Layouts save with the project, geometry embedded, so they survive a
different browser.

**Bigger than your laser bed? It tiles.** A bench drawer is wider than any
laser, so set your **bed / sheet size** in the layout editor (presets for
common laser and printer beds, or custom) and the cut template exports as
**tiles that each fit the bed**, in one SVG laid out like a map of the
drawer — labelled A1, A2, B1… with dashed seam edges on a separate "marks"
layer you can engrave or ignore. Seams are straight (foam butts together in
the drawer) and are placed, within the window that keeps every tile on the
bed, where they cross the fewest pockets; the readout tells you whether
every seam found clear foam or how many had to pass through a pocket. Cut
one tile per bed load.

**Puzzle tabs.** Tick **Puzzle tabs on the seams** and each seam gets
jigsaw knobs on one tile with the matching sockets on its neighbour, so cut
foam locks together instead of just butting. Head diameter, neck, reach,
spacing and **fit** are yours: fit 0 is the exact negative; a laser kerf
loosens a knob-in-socket fit by roughly twice the kerf, so **−0.2** or so
gives foam a snug interference fit. Tabs keep clear of seam ends (where
seams cross) and of any pocket within reach, shifting along the seam to
find room; the readout counts the tabs and says if a seam segment was too
crowded for one. Tiles that give a knob are planned with the reach already
deducted (the last tile in a row or column only receives sockets, so it
keeps the full bed), which means every tile *with* its knobs still fits.

The STL still exports as one piece and warns when it's over the bed —
splitting a *printed* insert with registration features is a separate job,
not done yet.

**Gridfinity bins.** Pick **Gridfinity bin** and the tool pockets into a
spec-true bin on the 42 mm grid: footprint auto-snaps to the smallest
N×M·42−0.5 that fits the pocket plus minimum wall, height in 7 mm units
(auto from the pocket depth), the standard base profile per cell
(35.6 → 41.5 over 4.75 mm), an optional **stacking lip** (2.6 × 4.4,
default on) and optional **magnet holes** (⌀6.5 × 2.4 at 26 mm centres,
default off). Base pads, body-with-pocket and lip are built as
watertight lofts and prisms — no CSG kernel — and mate with standard
baseplates.

**Multi-tool Gridfinity bins (the foam hybrid).** In the layout editor,
switch the container to **Gridfinity bin (N×M cells)** — the same drag-and
-rotate layout then carves into a spec bin body instead of a flat slab:
every tool gets its own pocket depth, the bin's minimum wall is enforced as
the border, height auto-sizes in 7 mm units, and the lip/magnet toggles
follow the Gridfinity settings. That's Kaizen-style tool foam with a
Gridfinity base, from photos.

**Custom Gridfinity baseplates.** Pick **Gridfinity baseplate** with the
*drawer itself* traced (photograph the drawer bottom on/around paper —
beyond-paper capture helps) and get a baseplate in exactly that shape: spec
sockets on every full 42 mm cell that fits inside the outline, partial
cells left solid, a configurable floor underneath. Print it, drop it in
the drawer, snap standard bins onto it.

**Holsters & wall holders.** Pick **Holster** and the outline becomes a band
around the tool: **clearance** so it slides in and out, **wall** thickness,
**band height**, an optional **floor** (0 = open-through for long tools). A
**flat side** (any edge) gives a velcro-able face; **mounting** adds a back
plate — its own watertight shell extruded along the wall normal and rotated
into place, so the **keyhole tab** (nail/screw-head hang, slot upward) and
**screw wings** get real through-holes pointing into the wall with no 3D
booleans involved. Prints band-upright, plate vertical. That completes the
holders roadmap (`docs/holders-prd.md`) — every phase shipped without a CSG
kernel.

**Underside view — an optional fork after tracing (step 2).** Most objects
sit flat, so nothing ever asks you for a second photo. Once your outline is
finished, a **⤵ Add underside view…** button appears; take it only if the
part has recesses or overhangs on its bottom. (A single top-down photo
can't tell you whether it does — both faces share one silhouette — so
there's nothing honest to auto-detect here; it's your call.)

Taking the fork: flip the object over on the same paper, photograph it, and
the shot is corner-detected, rectified, **mirrored and aligned to the
outline you already traced** — the outline is *reused, never re-traced*, so
underside mode locks outline editing and leaves you just the ▱ Section
tool. **Draw the undercuts** — any section you draw here is created as an
undercut automatically (amber on the canvas, cyan being ordinary top-side
sections) — or let **▨ Suggest underside regions** propose them; nudge the
alignment (**180° / ±2° / Auto**) if a symmetric part lands rotated.
**✓ Done** returns to the top view.

Sections created this way are **underside sections**: instead of extruding,
they carve a bottom-face recess — you set the *off-bed depth* (how far that
area floats above the bed) in step 3, and the recess rides the same
single-shell machinery as deboss labels, so the part stays one watertight
mesh. Two flat photos still carry no depth: the back photo answers *where*,
the depth stays yours. The back photo and its alignment save with the
project.

**Suggest regions.** In step 2, **▨ Suggest regions** scans the photo for
visually-distinct areas inside the object — a boss catching the light, a
shadowed pocket, a differently-coloured pad — and drops each in as an **editable
section** (drag its control points like any trace). It's the footprint helper
for sections, the counterpart to hole-detection and Detect fillets: conservative
(only reasonably large, compact patches that stand out from the object's median
brightness), user-confirmed, and fully editable or deletable. Overlapping
bright/dark fragments of one feature are **deduped to a single suggestion**,
outlines are **smoothed** for easy editing, and patches over a hole are skipped.
Each is tagged **raised** (catches light) or a possible **recess** (shadowed) —
raised ones come in as a small boss above the base by default. **It can only
guess the *where*, never the *how tall*** — a single flat photo carries no depth,
so **you set the height / floor offset** in step 3 (taller = a raised boss; floor
offset > 0 = an overhang; a true recess is a deboss). For real auto-height you'd
need multiple views (photogrammetry — see the horizon).

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

**Graph paper, dot grids & cutting mats as the reference.** Pick **Graph
paper / dot grid / cutting mat** and calibrate off the printed grid instead
of the sheet's edges: choose the pitch — **metric** (1, 2, 2.5, 4, 5, 10 mm),
**imperial** (1/10, 1/8, 1/5, 1/4, 1/2, 1 in), a **cutting-mat** preset, or a
custom pitch — drop the four handles on four grid intersections (or dots)
that make a rectangle, and say how many squares they span. Line grids and
dot grids work identically.

**Cutting mats** deserve a word, because for most makers they're the best
reference in the house: big, dead flat, and already on the bench. They print
*two* pitches at once — 1 in majors over ½ in (or ⅛ in) minors, or 1 cm under
bold 5 cm — so count whichever squares you can see clearly; when the photo
reads back the *other* ruling of the same family, the check recognises it as
consistent rather than flagging a miscount (and a real off-by-one still gets
caught, since 9-for-10 lands on a ratio no ruling family produces). Their
dark surface segments a light object beautifully and a dark object poorly —
that's contrast physics, not a setting.

The point is that **the sheet's own edges never have to be in frame**, so
this handles objects bigger than the paper, objects lying across two sheets
taped together, or a shot cropped tight. Perspective is still corrected
exactly, because four known-spaced points is all a homography needs.

**You don't count the squares — the app does.** When you continue to the
trace, it rectifies at a provisional count, reads the grid's period straight
off the image, and derives how many squares the handles actually span (a
pure ratio, so the provisional guess drops out). Handles on real
intersections give whole numbers; if the reading isn't whole it says so and
suggests nudging the handles. On a cutting mat with bold majors over fine
minors it counts in the bold ruling — the one you'd name. Typing a count by
hand overrides the auto-count for that handle placement, and **⟲ Auto-count
squares** re-reads on demand.

For a cutting mat, put the handles on the *printed grid's outer corners* —
those are sharp and exactly the labelled size — rather than the mat's
physical edge, which is rounded and varies by brand.

Independently of the count, after rectifying, 2.5D measures the printed
pitch back out of the photo and tells you whether it agrees with the pitch
you chose: *"Grid checks out — printed pitch reads 4.98 mm"*, or
a warning with the ratio when it doesn't (counting 9 squares as 10 shows up
as a clean 111%). If the grid is too fine or washed out to read back, it
says so rather than staying quiet.

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

The run ends with its own check total (`244 checks run. All 244 checks
passed ✔`) so the number quoted in a commit message can be copied from the
output rather than counted by hand.
## Roadmap

### Shipped

**Core pipeline.** Card/bill/coin references, **graph-paper, dot-grid and
cutting-mat references** with auto-detected square counts and a scale-bar
override, **vector CAD import (DXF/SVG)** with a multi-view picker, heat-set
inserts, DXF export, STL quality presets, hole drag rework (centre = move,
rim = resize), point multi-select (Ctrl-click + marquee) with group
move/delete, arc/line fitting and densify/reduce on a selected run, rotate
view 90° (both the trace step and the corner-setting step), radial
lens-distortion correction, the container outline library, **in-app
measurement tools** (point/edge distances, angles, face-to-face gaps, radii,
part size), **geometric constraints** (H/V, perpendicular, parallel, equal,
collinear, concentric, dimensioned length/angle/distance, anchors, with live
ghost-preview solving), **live tangent fillet arcs**, **emboss / deboss
labels**, and a **front + back photo fork** so undersides and overhangs
become bottom-face undercuts.

**Holders & organizers** (the whole `docs/holders-prd.md` arc, v1.11–v1.17,
plus the follow-on work through v1.23): foam inserts with placeable finger
notches, multi-tool drawer and toolbox layouts with per-tool pocket depths,
Gridfinity bins and custom baseplates, wall-mount holsters, true-scale **cut
template SVG** export, **bed tiling** with pocket-avoiding seams, and
**puzzle-tab interlocks** so two bed-sized foam tiles lock into one drawer
insert.

*(PDF drawing import — "picture of a CAD drawing → CAD out" — moved to the
separate **Blueprint** fork, which owns the CAD-drawing-import direction.)*

### Next up

- **Nesting / auto-sort for drawer layouts** — pack tool outlines into a
  drawer automatically instead of dragging each one. Would work on the true
  offset outlines rather than bounding boxes, since interleaving a plier and
  a screwdriver is the entire value of a foam insert, and would score against
  the existing `layoutPockets` / `layoutConflicts` predicates so a nested
  result is conflict-free by construction. **Awaiting sign-off** — see
  `docs/nesting_prd_v1.0.md`.
- **STL tiling of printed inserts** — cut templates already tile to the bed;
  the STL still exports whole and only warns when it overruns. Printed tiles
  need registration features (dowels or keys) rather than the laser-cut
  puzzle tabs.

### Horizon

- **3MF export** — colours and per-object metadata that STL cannot carry.
- **Keys** — trace your own key's blade profile and pick a keyway/blank
  (Schlage C, Kwikset KW1/4, …), optionally auto-detecting the type. Keys are
  small, so the coin or card reference is the right scale.
- **Full 3D from multi-view drawings** — reconstruct a solid from top/front/
  side by extruding each view and intersecting (needs a 3D boolean kernel).
  The Phase 1 view detection is the groundwork; see `docs/cad-import-spec.md`.

### Tabled (deprioritized for now)

- Photo/scan line-art vectorization (two-point scale) — only needed to recover
  geometry from a pure raster photo of a drawing; PDF (in the Blueprint fork)
  covers the common case.
- Surface textures / knurling via a second detection threshold.
- Photogrammetry — multi-photo full-3D reconstruction.

### Known gaps

- The grid and cutting-mat auto-count is validated against synthetic fixtures
  only; it has not been checked against real photographs of real graph paper.
- Puzzle-tab kerf compensation (the `fit` field) is verified in tests but has
  not been cut on a real laser.
