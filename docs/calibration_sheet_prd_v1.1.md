---
file: calibration_sheet_prd_v1.1.md
version: 1.1
author: Sam Cao
created: 2026-09-27
last_updated: 2026-09-28
description: PRD for printable calibration sheets that carry their own paper size, layout version and sheet number, check their print scale against the real paper edge, combine into multi-sheet setups for large parts, and support a parallax correction.
ai_update: Update last_updated and version. Rename file to match. Append changelog at bottom.
---

# PRD: Calibration sheets that check their own print scale

Status: **DRAFT v1.1, awaiting sign-off.** · 2026-09-28 · target branch
`claude/2.5d-photo-stl-s3-y0oodn`

Sam, 2026-09-27: is there a pattern or fiducial that could be printed on a
sheet of paper that would help with accuracy, whether or not the print scale
can be guaranteed? Then: one sheet that can figure out whether its scale is
right.

Sam, 2026-09-28, on v1.0: dashes or some other encoding are fine. The print
should carry the paper size and a version number, so the design can change
later. Photos should still show the real paper edge, as a double check for the
wrong scale or the wrong paper. Several sheets should work together for a more
accurate picture of a larger piece. It should print from the app. The target
is still mostly flat parts, but are there patterns that help with parallax?

The answer rests on one fact. The paper's size does not depend on the printer,
and the printed marks' size does. With both in the same photo, the ratio
between them is the print scale, so the app measures it instead of assuming
it. The printed marks also say which paper they were laid out for, which
layout version they are, and which sheet of a set, so the app can check the
paper it sees against the paper the print expected.

| The case | What the sheets do |
|---|---|
| The print scale cannot be guaranteed | Measure it against the paper's edges, per axis, correct for it, and report the percentage. "Fit to page" becomes a number on screen. |
| Trust only the 8.5 × 11 | The default. The paper's physical size sets absolute scale. The print only sets the shape. |
| A 1:1 print is available | Used when the paper's edges cannot be measured, for example on a white desk. Labelled unverified, or verified once with a ruler. |
| The wrong paper, or the wrong setting | The print says what paper it was made for; the edges say what paper it is on. Any disagreement is reported, never absorbed. |
| A part bigger than one sheet | Several numbered sheets laid around it, fitted together on one plane, so the part is measured between calibrated points instead of beyond them. |
| A thick part | Phase 3: the exact plane plus the camera's focal length gives the camera's height, and the part's typed thickness gives the correction. A sheet raised on a book of known height does the same without trusting the phone. |

The work comes in three phases, each usable on its own: one sheet, several
sheets, then parallax.

## Problem

A trace is exactly as accurate as the four corners it was rectified from. The
app finds those corners coarsely, lets a person nudge them, and never checks
that the paper is the size it was told.

### The current workflow, verified in code at v1.27.5

1. The object goes on a sheet, US Letter by default (`DEFAULT_SIZE` in
   `js/paperSizes.js`), and is photographed from above.
2. On load, `autoDetect` (`js/main.js:485`) calls `detectPaperCorners`
   (`js/detectPaper.js:112`). It downscales the photo to 480 px on the long
   side, thresholds a "paperness" score with Otsu, takes the largest bright
   component and collapses its convex hull to four corners. One detection
   pixel is about eight source pixels on a 12 MP photo, so the result is coarse
   by construction. On the suite's clean 1000 × 1400 synthetic photo it lands
   2.4 px from truth (`test/e2e.mjs:166` allows 10), about 0.7 mm at that scale.
3. A toast suggests fine-tuning, and the person drags the handles with the
   loupe in `js/ui/cornerEditor.js`. This is the manual step, and the
   2026-09-19 adversarial review found it the most dangerous input in the app:
   a corner nudged half a millimetre wide on a drawer scan made a strip of wall
   segment as "Tool 1".
4. Paper size is picked by hand. Orientation is guessed from the quad's side
   lengths (`guessOrientation`, `js/main.js:313`). Nothing checks the chosen
   size against the photo. Select Letter, photograph A4, and every trace comes
   back 2.8 percent wide and 5.9 percent short, silently.
5. Lens distortion is opt-in. The Auto button (`js/main.js:5856`) fits one
   radial term to the straightness of the paper edges, sampled by
   `detectEdgePoints` (`js/lens.js:71`): 24 points per edge, on a 640 px
   downscale, to the nearest whole pixel.
6. `doRectify` (`js/main.js:604`) hands the four corners to `rectify`
   (`js/homography.js:64`), which solves an exact four-point homography
   (`computeHomography`, `js/homography.js:34`) and resamples the sheet at
   5.73 px/mm for Letter.
7. The segmenter samples the paper's colour from a border band and marks every
   pixel that differs as object (`computeDiffMap`, `js/segment.js:8`), clearing
   a 2 mm margin at the edge (`js/main.js:1869`).

### Where it breaks

- **Every downstream millimetre inherits the corner error**, and the corners
  come from a 480 px detector and a human drag.
- **Corners are the worst place to measure a sheet.** Curl, dog-ears and
  shadows collect there. The middle of each edge is straighter and better lit,
  and nothing uses it for position.
- **The reference size is never checked.** A wrong paper selection is a silent
  anisotropic error of several percent.
- **Light desks defeat detection.** Paper on a white or pale surface gives the
  detector nothing to threshold, and the whole step becomes manual.
- **There is no accuracy figure.** Four points determine a homography exactly,
  so there are no residuals, and nothing can tell the person how good a photo
  is.
- **Lens correction is fitted from the weakest feature in the frame**: a soft,
  low-contrast paper edge, at whole-pixel resolution.

What is manual today: fine-tuning the corners, picking the paper size, and
pressing Auto for the lens.

### Large parts

A part bigger than the sheet uses Capture area, Extend (`captureFrac`,
`js/main.js:72`; README "Capture area"). The four-corner homography is then
extrapolated past the paper, and `computeDiffMap` switches to a dual model in
which a pixel is background if it resembles either the paper or the
surrounding surface (`js/segment.js:39`). Extrapolation is where a homography
is weakest: any corner error grows with distance from the sheet, and the lens
estimate only ever saw the sheet's edges. The graph-paper reference handles
taped-together sheets, but only by counting squares on commercial paper.

### Parallax

The homography is exact for the paper's plane only. An object of thickness
`t` photographed from height `D` shows its top outline magnified by
`D / (D - t)` about the point directly below the camera. A 10 mm thick tool
shot from 400 mm reads 2.6 percent large: 2.6 mm on 100 mm, against a
paper-tolerance floor of about 0.3 mm. From 600 mm it is 1.7 percent. Even a
3 mm part reads 0.76 percent large from 400 mm. Nothing in `js/` models it:
there is no parallax, focal-length or EXIF handling anywhere.

Centring the part under the camera, which the README advises, does not help
with size. The magnification is a uniform scale about the point below the
camera, so it changes the part's size by the same factor wherever the part
lies. Centring only reduces how far the outline is shifted sideways. Only
distance, or a correction, reduces the size error.

## Success criteria

### Phase 1: one sheet

1. **It recognises its own sheet.** A photo of either layout, on either stock,
   is recognised on load with no setting changed.
2. **It reads its own identity.** Any 45 mm of visible code track yields the
   layout version, the paper size the sheet was made for, and the sheet
   number. A code word corrupted in any single cell is rejected, never misread
   as a different value.
3. **It knows its print scale.** On synthetic photos printed at 100 percent, at
   96 percent about the page centre, and at 94 percent anchored top left with a
   1 mm registration offset and 0.5° of feed skew, the reported scale is within
   0.2 percent of truth on each axis. It says "1:1" within ±0.5 percent and
   names the percentage otherwise.
4. **It corrects for it.** An object traced on the 96 percent sheet measures
   within 0.1 mm of true on a high-resolution synthetic photo, the same as on
   the 1:1 sheet.
5. **The paper edge is a real double check.** A Letter layout printed on A4 is
   reported as exactly that. A paper picker set to the wrong size is overridden
   by the sheet, with a message. Paper edges that cannot be measured give a
   result labelled unverified, never a silent assumption.
6. **Partial cover does not break it.** With one frame side fully covered, the
   fit from the other three is within 0.1 mm of the full fit on the synthetic.
   A sheet with 40 percent of its area out of the photo is still identified
   and fitted when readable code shows on two sides that are not parallel.
7. **Rough corners are enough.** Hand-placed corners up to 5 mm off produce the
   same fit to within 0.05 mm, so the white-desk case needs only a rough drag.
8. **It reports an honest accuracy figure.** Every sheet-mode rectification
   shows a fit in millimetres, and that number rises measurably when the
   synthetic sheet is bent or the lens correction is withheld. A figure that
   does not respond to real error is decoration.
9. **It prints from the app.** Any layout, any number of numbered sheets up to
   the phase 2 limit, from a button in Step 1, through the browser's own print
   dialog, with no file to find first.
10. **Plain paper gets better too.** Edge-fitted corners bring the existing
    synthetic's corner error under 1 px, from 2.4.
11. **Recognition is cheap.** It adds under 200 ms, measured warm, to loading a
    12 MP photo.
12. **Nothing moves for saved work.** Projects saved before this load with
    their stored corners, unchanged. Coin, grid, scale bar and drawer scan
    behave as before. The save format gains only additive fields.

### Phase 2: several sheets

13. **Freehand sets work.** Up to eight sheets in one photo, laid down by hand
    with gaps and at any rotation, are each identified and fitted together on
    one plane. Nobody aligns anything.
14. **More sheets measure large parts better, and it is shown, not claimed.**
    Four sheets around a 500 mm synthetic part, rendered with lens distortion
    and pixel noise, measure it within 0.2 mm. The same part calibrated from
    one sheet at one end is measured in the same test and must come out worse.
15. **One print job, one scale.** Sheets printed in one job share a print
    scale, so one sheet with visible edges verifies the set. A sheet from a
    different job, or on different paper, is verified on its own edges.
16. **Duplicates are survivable.** Two sheets carrying the same number are
    still treated as two sheets, with a note to print a fresh set.

### Phase 3: parallax

17. **Corrected with the phone's focal length.** With an EXIF focal length
    present, a 10 mm synthetic part rendered with true parallax from 400 mm
    measures within 0.2 mm. Uncorrected, the same render reads 2.6 mm large on
    100 mm.
18. **Corrected without trusting the phone.** A sheet raised on a surface of
    stated height recovers the camera height within 3 percent with no EXIF at
    all, and flags an EXIF focal length that disagrees by more than 3 percent.
19. **The correction is visible.** The readout names it ("parallax: 2.4 percent
    at 10 mm, corrected"), so a changed dimension never comes as a surprise.
20. **No data, no correction, and it says so.** Without EXIF or a raised sheet,
    nothing is corrected, the readout says parallax is uncorrected, and it
    carries the stand-back advice.

## Scope

### In

- Edge-fitted corners for plain paper: sub-pixel samples along the middle of
  each edge, a robust line per edge, corners at the intersections.
- Printable sheets in two layouts, US Letter and A4, generated in-app from one
  layout module that the detector also reads. A frame line for geometry and a
  code track that carries layout version, paper size, sheet number and
  position.
- Printing from the app: a print panel in Step 1 for layout, sheet count and a
  download.
- Recognition, the fit, lens estimation, the print-scale measurement, the paper
  double check and the verdict, for one sheet and then for several.
- Masking the printed band out of segmentation, and a warning when a trace
  touches the window edge.
- A one-time ruler verification of a print (droppable).
- Parallax correction from EXIF focal length and from a raised sheet (phase 3).
- Tests for each criterion, a README section per phase, and this PRD's status
  line.

### Out

- **Any pattern in the middle of a sheet.** It would be traced as part of the
  object.
- **Sheets tiled under a part that crosses their bands.** Tracing across a
  band needs the mask to hide only the printed ink and bridge the part across
  it. Possible later; phase 2 places sheets around the part instead.
- **Stitching several photos.** A separate, larger feature. Numbered sheets
  seen in two photos are the natural tie points for it later.
- **Measuring a part's height from the photo.** Parallax correction uses the
  thickness already typed for extrusion. Stereo or two-photo height
  measurement is out.
- **Parts that are not prismatic.** The correction assumes straight walls, so
  the top outline is the widest one.
- **Registering the underside photo** (`js/backphoto.js`) against the sheet.
- **Drawer scan step 7.** A sheet on a drawer's bottom is the natural
  reference object for it, and phase 2 makes that possible, but the step waits
  on its own open question 6.
- **Colour or low-visibility patterns.** Many people print in black and white.
- **Full camera calibration.** Only the focal length is used, from EXIF or
  from a raised sheet. The principal point is taken as the image centre.

## Constraints

- Single-file, fully client-side, no server, no user-facing build step. No new
  vendored library: no OpenCV, no in-browser PDF generator.
- **Printed sheets outlive the code.** Layout v1's geometry and its code
  payload are frozen the day it ships. The version field is how any later
  layout is told apart, and v1 stays recognised for good. So every field that
  phase 2 or 3 will need is in the v1 payload, even though they ship later.
- Black ink only, printable on any laser or inkjet, nothing within 10 mm of the
  paper edge, which clears the hardware margin of every common printer and
  leaves the real paper edge clean for the double check.
- Deterministic: no `Date.now()` or `Math.random()` in detection or encoding.
- Save-format keys stay stable; anything new is additive and optional. Ids
  keep their names.
- Memory: detection reads source pixels along its profiles only, or shares the
  one full-size read `rectify` already makes. It never holds a second
  full-size copy.
- **The synthetic suite cannot show the frame beating the paper edge**, because
  a rendered paper edge is perfect: no curl, no shadow, no pale desk. The math
  and every degradation path can be tested synthetically. The real-world
  claims need Sam's own photos, and each phase ends in a checkpoint that asks
  for them.
- EXIF is present in a photo uploaded straight from a phone in most browsers,
  and missing from screenshots, edited images and photos passed through most
  messaging apps. Phase 3 has to behave well without it, and its checkpoint
  confirms what Sam's own phone and browser keep.

## Design

### Why a frame, and not a pattern across the sheet

The segmenter finds the object as whatever is not paper-coloured
(`computeDiffMap`). Ink under the object is, to it, more object. So a sheet's
middle stays blank, and every printed feature goes around the edge.

That costs little. A plane homography is best constrained by features spread
around the outside of the region, not scattered through it. Around the edge
go two things. A solid line is the geometry: four long straight lines, each
fitted from a few hundred sub-pixel samples. A code track beside it is the
identity and the position: it says what sheet this is and where along the
frame any visible stretch sits, and its cells add hundreds of point features
along the lines.

### The sheet

Distances are from the paper edge, in millimetres, portrait.

| Zone | Letter (215.9 × 279.4) | A4 (210 × 297) |
|---|---|---|
| Blank: hardware margin, and the clean paper edge | 0 to 10 | 0 to 10 |
| Frame line, 2 mm, black, closed | 10 to 12; centreline rectangle 193.9 × 257.4 | 10 to 12; centreline rectangle 188 × 275 |
| Gap | 12 to 13 | 12 to 13 |
| Clock row, 1.5 mm cells | 13 to 14.5 | 13 to 14.5 |
| Two data rows, 1.5 mm cells | 14.5 to 17.5 | 14.5 to 17.5 |
| Quiet gap | 17.5 to 18.5 | 17.5 to 18.5 |
| Label and ruler strip, bottom only | 18.5 to 34.5 | 18.5 to 34.5 |
| Clean window for the object | 178.9 × 226.4 | 173 × 244 |

The window is about 30 percent smaller than a plain Letter sheet's usable area
(211.9 × 275.4 after today's 2 mm margin). That is the price of the band, and
open question 1. It matters only when the part sits on the sheet; in phase 2
the part sits between sheets.

The frame line is the first ink inward from every edge, which is what lets the
detector find it before reading any code. The code track sits inside it with a
1 mm gap so it cannot pull the line's fitted centre.

The bottom strip carries, for people: "2.5D calibration sheet · US Letter
8.5 × 11 in (215.9 × 279.4 mm) · layout v1 · sheet 2 of 4 · Print at Actual
size. The app checks the scale either way." It also carries a 150 mm ruler
with 1, 5 and 10 mm ticks, for checking a print by eye. The app never relies
on the text; the code carries everything it needs.

### The code

The clock row alternates black and white 1.5 mm cells, like a QR code's timing
line. It tells the reader exactly where every cell is, even where the print
was scaled, and every black clock cell's centre is a point with known design
coordinates. One cell is left white at the start of each code word. Three
white cells in a row never happen anywhere else, so that missing tooth marks
word boundaries without a separate marker.

The two data rows carry one bit per cell, 28 bits per word, which makes a word
15 cells, 22.5 mm, long. Words run end to end along each side, so any 45 mm of
visible track contains at least one complete word.

| Field | Bits | Carries |
|---|---|---|
| Layout version | 4 | 1 for this design; 0 reserved; up to 15 later layouts |
| Paper size | 4 | The stock the layout was made for: Letter, A4, and room for Legal, A3, Tabloid, A5 |
| Sheet number | 5 | 1 to 31, for sets of sheets used together |
| Position | 6 | Which word this is, counted around the frame, so a visible stretch knows where it sits |
| Checksum | 8 | CRC-8 over the other fields |
| Reserved | 1 | 0 |

A Letter sheet carries 34 words: ten along each long side, seven along each
short one. A3, the largest stock in the table, needs 56, so the six-bit
position covers every size the payload names.

The checksum is what keeps a misread from becoming a wrong answer. A word with
a bad cell fails it and is dropped. A word that passes it by chance, one time
in 256, still has to agree with every other word read on the same sheet and
with its own measured position along the frame, so a bad word is caught twice
over. Words are read clockwise, and a sheet turned upside down reads them
backwards; the missing tooth sits at a word's start, so trying both directions
and keeping the one that checks settles orientation.

Cells stay readable down to about 4 px/mm in the photo, six pixels per cell,
which is the sheet filling about a third of a 12 MP photo's long side.

### Printing from the app

"Print calibration sheets" in the Step 1 paper panel opens a small panel:

- **Paper**: US Letter or A4, defaulting to the paper picker's choice.
- **Sheets**: 1 to 8, numbered 1 to N, all in one print job. One job means one
  printer at one scale, which phase 2 relies on.
- **Print**: opens the browser's print dialog on a page carrying each sheet as
  SVG in real millimetres, one per page, with `@page` set to the stock size
  and zero margin.
- **Download**: the same pages as SVG, for printing elsewhere.

The panel says, once and plainly: choose Actual size or 100 percent if the
dialog offers it, and if it doesn't, print anyway, because the app measures
whatever scale comes out. Browsers and PDF viewers both default to shrinking
things onto the page, and the sheet exists so nobody has to get that dialog
right. A committed static PDF set, generated by the suite's own Chromium at
development time, is open question 2.

### Recognition, one sheet

Recognition starts from rough corners, from `detectPaperCorners` or from a
person's drag, and gives up quietly when there is no frame.

1. Map perpendicular profiles through the rough homography into the source
   photo, about one per millimetre along each side, each running from 5 mm
   outside the rough paper edge to 40 mm inside it. The 40 mm covers a
   94 percent print anchored at one corner, whose far frame lines move up to
   16 mm inward, plus 5 mm of rough-corner error and the code track behind it.
2. On each profile find the paper edge (the brightness step) if there is one,
   then the **first** dark dip inward. Accept a dip whose width is 2 mm times a
   plausible print scale, within 40 percent.
3. Locate each crossing at sub-pixel precision in the source image, never in a
   resampled one, and fit a line per side robustly.
4. Sample the code track alongside each fitted line: find the clock cells, the
   missing teeth, and read the words. Keep the words that pass the checksum
   and agree with each other.
5. With at least one good word, the sheet's layout, paper and number are known,
   and so are the design coordinates of every visible clock cell. With none,
   the fit falls back to the line alone: all four sides required, the layout
   named by the frame's aspect ratio, no sheet number, one sheet only.

Graph paper fails at step 2 on dip width, a printed page of text fails at
step 3, and a plain sheet finds nothing.

### The fit: shape from the frame, scale from the paper

The printed features are crisp and printed straight, so they are trusted for
the eight sensitive numbers of a homography. The paper edge is softer, but a
whole edge is plenty to pin down a handful of robust numbers.

1. **Points and lines.** Each black clock cell's centre, the midpoint of its
   two edges, is a point with known design coordinates. Each frame-line dip's
   centre, not its edges, constrains one direction. Centres, because ink spread
   and optical blur move edges symmetrically and leave centres where they were.
2. **Lens.** Fit the radial term to the straightness of the frame lines
   together with the paper edges, reusing the golden-section search in
   `estimateDistortion`, and iterate with the homography until it settles.
3. **Homography.** A least-squares fit over every visible point, with the
   frame lines as extra constraints. It reuses the 8 × 8 solver in
   `js/homography.js` through the normal equations, with Hartley coordinate
   normalisation first, because pixel and millimetre coordinates in one system
   are badly conditioned without it. Partial cover only removes points; any
   readable stretch on two sides that are not parallel is enough.
4. **The paper, in design coordinates.** Map the paper-edge samples through the
   homography and fit a rectangle with five parameters: scale across, scale
   down, rotation, and the two offsets. Those are the print scale, the feed
   skew and the registration offset.
5. **Fit figure.** The RMS distance between where the clock cells are and
   where the fitted homography puts them, in true millimetres, together with
   the paper edges' residual from the fitted rectangle. A bent sheet and an
   uncorrected lens both show up in it.

### The paper edge double check

Three independent statements about the paper meet here: the size the print
says it was made for, the size the paper picker says, and the shape the paper
edges actually have. The edges win, because they are the only one measured
from the physical sheet in this photo.

| What the photo shows | Verdict |
|---|---|
| Letter code, Letter edges, frame at 100 percent of the sheet | "Printed at 1:1 on Letter" |
| Letter code, Letter edges, frame at 96 percent | "Printed at 96.2 percent across and 96.3 percent down, corrected for. Fit to page was probably on; nothing needs reprinting." |
| Letter code, A4-shaped edges | "This Letter sheet was printed on A4 paper." Scale from the A4 edges; the print scale is measured against them. |
| Code and edges agree, picker disagrees | The sheet overrides the picker, and says so. |
| Edges not visible, or matching no known stock | "Print scale unverified." Design coordinates are taken as true, which assumes a 1:1 print, unless a ruler verification is on record. |

The paper's aspect ratio names its stock because an isotropic print scale
leaves aspect untouched: Letter is 0.7727, A4 0.7071. The print scale is the
stock's known width and height over their measured values, per axis.

"1:1" allows ±0.5 percent because a true 1:1 print on a sheet cut 0.3 percent
large reads 0.3 percent off, and a verdict that calls good prints bad gets
ignored.

Step 1 draws what it found: the paper outline it measured and the frame it
fitted, over the photo. A person can see the double check, not just read it.
The panel asks for the whole sheet to be in the photo, because the check needs
the edges.

### What the fit produces

The final mapping, from a rectangle on the paper's plane in true millimetres
to source pixels, is a homography, and a homography is fixed by four point
pairs. So for one sheet the fit's whole output is the paper's four corners,
placed through that mapping and re-distorted into photo coordinates, plus
`k1`. They go into `state.corners` and `state.lens`, and `rectify`, the save
format, the queue, undo and every step after Step 1 run unchanged. The handles
move to the fitted corners.

Dragging a handle re-runs recognition from the new corners, which is exactly
how the white-desk case gets started. A checkbox turns the sheet fit off for
anyone who wants their own corners to rule.

### Segmentation, one sheet

The window sits at a printed offset from the frame, while the paper edge sits
wherever the printer's registration put it. So the masked band is defined from
the frame and carried into sheet coordinates through the fitted rectangle, not
measured from the paper edge. It replaces the uniform 2 mm margin with
per-side insets (`js/main.js:1869`). The paper colour for `computeDiffMap` is
sampled just inside the window's rim, where there is never ink. A trace within
1 mm of the window edge gets a warning that the object may run into the band.

### When the paper edges cannot be seen

On a white desk the paper edge has no contrast, but the frame and the code
still do. The fit then takes design coordinates as true, which assumes a 1:1
print, and places the paper nominally around the frame. The verdict reads
"Print scale unverified: the paper's edges are not visible against this
surface", unless a ruler verification is on record, in which case it uses that
and says so.

### Verifying a print once

For paper that cannot be trusted or cannot be seen, the frame is itself a
ruler: its outside edges are 195.9 × 259.4 mm apart on Letter at 100 percent.
Measure both with a steel rule, type them in, and that print's scale is known
on both axes, feed direction included, which is the direction printers most
often get wrong. A steel rule reads to about 0.25 mm over 200 mm, roughly
0.1 percent. Stored per browser, keyed by layout and sheet number.

### Several sheets (phase 2)

**Where they go.** Around the part, on the table, rather than under it. A part
lying between sheets on every side is measured between calibrated points, where
a homography is at its best. A part hanging off one sheet is measured beyond
them, where it is at its worst. Two sheets on opposite sides are the minimum
worth having; four, one per side, is the recommendation. The part lies on the
table, so it never crosses a band, and the existing dual background model
(paper or surface, `js/segment.js:39`) already handles what surrounds it.

**Finding them.** A set cannot rely on one rough quad. The detector searches
the whole photo, at reduced resolution, for straight dark segments of the
frame line's width, then keeps only those with readable code beside them. The
code says which sheet each segment belongs to, so grouping is by sheet number,
not by guessing which lines make a rectangle.

**Fitting them.** All the sheets lie on one plane. So there is one mapping
from the table to the photo, eight numbers and one lens term, shared by every
sheet, and each sheet adds only where it lies on the table and its print
scale: five numbers. Sheet 1 anchors the table's coordinates. With eight
sheets that is about fifty unknowns against hundreds of points, a small
nonlinear least-squares problem, initialised from each sheet's own
single-sheet fit. It needs a general Gauss-Newton solver, which the codebase
does not have yet.

**Scale.** Sheets from one print job share one print scale, so it is fitted
once and any sheet with visible edges verifies the set. A sheet from another
job, or on another paper, gets its own scale from its own edges.

**Output.** The rectified area is a rectangle on the table covering the sheets
and the part, at the drawer scan's higher ceiling (`SCAN_MAX_LONG_SIDE_PX`,
`js/main.js:284`). It is still four corners, a width, a height and `k1`, so
`rectify` is unchanged. The background model generalises from one paper
rectangle to a list of them, and every sheet's band is masked.

**What it does not buy.** Sheets from one ream share one cut error, so more
sheets improve the geometry over a large area but not the per-ream scale floor.
And the whole area comes from one photo, so a large part gets fewer pixels per
millimetre: a 600 mm part in a 12 MP photo gets about 5 px/mm.

### Parallax (phase 3)

**What no flat pattern can do.** No flat pattern can measure the camera's
height from a photo taken straight down. A camera close to the paper with a
wide lens and a camera far away with a narrow lens take the identical picture
of a flat plane. That is geometry, not a missing feature, and it is why the
answer to "a pattern that fixes parallax" needs one extra fact from outside
the plane.

**Route 1: the phone's focal length.** Given the focal length, the exact
homography from the sheets gives the camera's full position: its height above
the plane and the point directly below it. EXIF usually carries the focal
length as a 35 mm equivalent, which converts to pixels through the image
diagonal. Then every traced outline at height `t` is corrected by one uniform
scale of `(D - t) / D` about the point below the camera. That formula holds
whatever the camera's tilt. With EXIF good to roughly 2 to 5 percent, the
residual error is that fraction of the original: the 10 mm part from 400 mm
goes from 2.6 percent to around 0.1 percent. This route needs no extra
printing, only phase 1's exact homography; a four-corner fit is too noisy to
recover a camera position from.

**Route 2: a sheet at a known height.** Lay one sheet of the set on a flat
book or box and type its height. That sheet appears magnified by
`D / (D - h)` next to the sheets on the table, and that ratio gives `D`
directly, with no focal length needed. Two details make it work. The app can
tell a raised sheet from a differently scaled print, because a raised sheet's
paper edges are magnified along with its frame, while a print scale changes
only the frame; it then asks for the height. And when the raised sheet came
from the same print job as the others, their print scale cancels, so the
magnification is measured from frames alone and the paper's cut tolerance
never enters. A book measured to 0.5 mm at 25 mm gives `D` to about 2 percent.
It checks EXIF, or replaces it when EXIF is missing or wrong, as it can be
when a phone crops digitally.

**Which height, and what gets corrected.** The height is the thickness Sam
already types for extrusion. The outer outline is corrected at the base
section's thickness, and a section of another thickness at its own. The
recommendation is to correct the image rather than the outline: rectify at the
top plane of the base section, so the part is traced at true size and what is
traced is what is built. The paper-plane things, the bands and the paper
regions, are carried into that raster by the same known scale.

**The free part.** Parallax scales with `t / D`, so doubling the distance
halves it. From 800 to 1000 mm, on a phone's 2× or 3× lens, the 10 mm part
drops from 2.6 percent to about 1 percent before any correction. Once the
camera height is known, the readout says it and names the effect, which
teaches the habit.

### The accuracy floor

With the sheets, the paper plane's shape comes from the printed features and
its absolute scale from the paper. The scale carries the paper's cut
tolerance, about ±0.8 mm on Letter's 279.4 mm and up to ±2 mm on A4 under
ISO 216. Sheets within one ream are near-identical, so it is a fixed error per
ream rather than noise that averages away. A shadow along one edge biases that
edge's position by a tenth of a millimetre or two. The ruler verification gets
under the paper tolerance. Phase 3 is the only thing here that touches
parallax.

## Plan

Each step is one commit, `node test/e2e.mjs` green, with the suite's printed
total quoted in the message. Each phase ends with a README section and a
checkpoint that needs a person.

### Phase 1: one sheet

1. **Edge-fitted corners for plain paper.** A new `js/edgeFit.js`:
   full-resolution sub-pixel profiles along the middle of each edge, 15 mm
   clear of the corners, a robust line per edge, corners by intersection,
   converted back to photo coordinates through the lens model. Accepted only
   when every edge fits well and the corners stay close to the coarse ones.
   New photos get better corners; saved projects keep theirs. **Checkpoint:**
   the before and after numbers, plus a few of Sam's real photos, because this
   step alone may deliver much of the shape accuracy, and that should be known
   before the sheet is built.
2. **The layout and the code.** `js/calibSheet.js`: the layout constants for
   Letter and A4, the word encoder and decoder with its CRC, and the SVG
   generator for a numbered set. Tests: every field round-trips; every
   single-cell corruption of a word is rejected; the SVG's frame, track and
   window match the constants the detector reads.
3. **Printing from the app.** The Step 1 panel, the print page, the SVG
   download. Test: the page's `@page` size and every sheet's number and paper
   field are what the panel asked for.
4. **Recognition.** Profiles, dips, line fits, code reading, the fallback to
   line only. Tests: synthetic sheets at 1:1, with blur, with radial
   distortion, from corners placed 5 mm off, with one side covered, with
   40 percent of the sheet out of frame.
5. **The fit.** Least-squares homography with normalisation, lens, the fit
   figure. Tests: criteria 6, 7 and 8.
6. **The double check and the verdict.** The five-parameter rectangle, stock
   identification, the verdict table, the four-corner output, the Step 1
   overlay and panel. Tests: 100 percent, 96 percent centred, 94 percent
   anchored with offset and skew, Letter on A4, a wrong picker, a white desk.
   **Checkpoint:** real photos of printed sheets, one printed with Fit to page
   on.
7. **Segmentation and integration.** The frame-relative mask, the window-edge
   warning, recognition on every load including the queue, the checkbox, an
   additive `sheet` block in projects. Tests: a traced object at 96 percent
   measures true; an old project loads unchanged.
8. **Ruler verification.** The two-number entry, its storage and its use. The
   step to drop if the phase runs short.
9. **README** and this PRD's status line.

### Phase 2: several sheets

10. **Whole-photo search.** Frame-line segments at reduced resolution, kept
    only where code reads beside them, grouped by sheet number. Tests: one to
    eight sheets at random poses; duplicates; a sheet half out of frame.
11. **The joint fit.** A small Gauss-Newton solver, one shared plane and lens,
    a pose and scale per sheet, one scale per print job. Tests: criteria 14
    and 15.
12. **Rectification and segmentation for a set.** The table rectangle, the
    list of paper regions in the background model, every band masked.
    **Checkpoint:** a real large part photographed with four sheets.
13. **README.**

### Phase 3: parallax

14. **EXIF and camera position.** Read the focal length from the JPEG's EXIF;
    decompose the homography into the camera's height and the point below it;
    show both. Tests: synthetic renders with known camera positions, tilted and
    straight down.
15. **The correction.** Rectify at the base section's top plane, per-section
    correction for the rest, the readout. Tests: criteria 17, 19 and 20.
16. **The raised sheet.** Detection by magnified paper edges, the height
    prompt, the EXIF cross-check. Tests: criterion 18. **Checkpoint:** what
    EXIF survives on Sam's own phone and browser, and one real thick part.
17. **README**, including that centring the part does not fix its size.

Steps 1 and 2 are independent of each other. Everything else runs in order,
and each phase can ship without the next.

## Open questions (recommendation first)

Decided on 2026-09-28: the frame carries encoded information (Sam: dashes or
any other encoding). v1.0's question 1, frame only or frame plus markers, is
closed.

1. **Is a window about 30 percent smaller worth it?** Recommendation: yes.
   Anything bigger than 178.9 × 226.4 mm on Letter goes between sheets in
   phase 2, or on a plain sheet or graph paper today. Shrinking the cells to
   1.2 mm wins about 1 mm per side back, at the cost of needing about 5 px/mm
   in the photo instead of 4.
2. **A committed static PDF set as well as printing from the app?**
   Recommendation: yes, four numbered Letter sheets and four A4, generated by
   the suite's Chromium, so a sheet can be printed without opening the app.
   Printing from the app stays the main route.
3. **Apply the lens fit automatically in sheet mode?** Recommendation: yes,
   with the slider as override. The Auto button asks for a click today because
   paper-edge estimates deserve a human look. Estimates from printed lines do
   not.
4. **Should a dragged corner re-fit, or override?** Recommendation: re-fit and
   snap, with one checkbox to turn the sheet fit off. The white-desk case needs
   a rough drag to start the fit, and manual control lives in one explicit
   place instead of happening by accident.
5. **Store a ruler verification per browser or per project?** Recommendation:
   per browser, keyed by layout and sheet number, copied into every project
   that used it. It describes a physical print on a desk, not a project.
6. **Accept a sheet printed above 100 percent?** Recommendation: yes. A frame
   side lost to the printer's margin is handled like a covered one, which the
   code now makes cheap.
7. **Edge-fitted corners on by default for plain paper?** Recommendation: yes,
   behind the acceptance guard. Saved projects keep their corners.
8. **Sheets around the part only, or also tiled under it?** Recommendation:
   around only, in phase 2. Tiling under a part means tracing across bands,
   which needs ink-only masking and bridging, and around is also the more
   accurate arrangement.
9. **How many sheets in one photo?** Recommendation: up to eight in the print
   panel and the tests. The payload allows 31, but more sheets in one photo
   means fewer pixels on each.
10. **Parallax as phase 3 here, or its own PRD?** Recommendation: phase 3 here.
    Route 2 is built on phase 2, route 1 needs phase 1's exact homography, and
    neither changes anything on the printed sheet, so it can be cut without
    regret.
11. **Correct the image or the outline?** Recommendation: the image, rectified
    at the part's top plane, so what is traced is what is built.
12. **Are the payload fields right?** Layout version, paper size, sheet number,
    position and a checksum. They freeze with layout v1, so anything else a
    sheet should ever say has to be named now.

## Decision needed

Sign-off on the scope, the three phases and the plan. Questions 1, 8 and 10
change what gets built. Question 12 cannot be revisited after the first sheet
is printed.

## CHANGELOG

- v1.0 (2026-09-27): Initial draft, from Sam's 2026-09-27 questions on a
  printable fiducial that works whether or not the print scale can be trusted.
- v1.1 (2026-09-28): From Sam's notes on v1.0. The frame gains a code track
  carrying layout version, paper size, sheet number and position, with a
  checksum, which makes partial cover work and adds point features for a
  least-squares fit. The paper edge double check is spelled out as a verdict
  table against the encoded paper size. Printing from the app becomes its own
  section and plan step. Phase 2 adds several sheets fitted together on one
  plane, placed around a large part. Phase 3 adds parallax correction from
  EXIF focal length or a raised sheet, and records that no flat pattern can
  measure camera height from a straight-down photo. The window shrinks from
  187.9 × 235.4 to 178.9 × 226.4 mm on Letter to make room for the code.
