---
file: calibration_and_backlog_prd_v1.2.md
version: 1.2
author: Sam Cao
created: 2026-09-27
last_updated: 2026-09-29
description: PRD for printable calibration sheets that encode their paper, layout version, sheet and print job, check their print scale against the real paper edge, combine for large parts and drawers, and support a parallax correction; plus the outstanding backlog of drawer scale, scan review and nest speed.
ai_update: Update last_updated and version. Rename file to match. Append changelog at bottom.
---

# PRD: Calibration sheets, drawer scale, and the backlog

Status: **DRAFT v1.2.** Part A phase 1 is ready for sign-off. Part A phases 2
and 3 are sketched for a later sign-off, after phase 1's real-photo
checkpoint. Part B items can be signed off one at a time. · 2026-09-29 ·
target branch `claude/2.5d-photo-stl-s3-y0oodn`

Sam, 2026-09-27: is there a pattern or fiducial that could be printed on a
sheet of paper that would help with accuracy, whether or not the print scale
can be guaranteed? Then: one sheet that can figure out whether its scale is
right.

Sam, 2026-09-28, on v1.0: dashes or some other encoding are fine. The print
should carry the paper size and a version number. Photos should still show the
real paper edge, as a double check for the wrong scale or the wrong paper.
Several sheets should work together for a larger piece. It should print from
the app. Mostly flat parts, but are there patterns that help with parallax?

Sam, 2026-09-29, on v1.1: approved all twelve suggestions made against it, and
asked for one PRD covering this improvement and the outstanding work, such as
the drawer scale work.

This document has two parts. **Part A** is the calibration sheets, in three
phases that each ship on their own: one sheet, several sheets, parallax.
**Part B** is the rest of the backlog: drawer scale, the drawer scan review,
nest speed, and small fixes. A suggested order across both closes the
document.

---

# Part A: Calibration sheets

The idea rests on one fact. The paper's size does not depend on the printer,
and the printed marks' size does. With both in the same photo, the ratio
between them is the print scale, so the app measures it instead of assuming
it. The printed marks also say which paper they were laid out for, which
layout version they are, which sheet of a set, and which print job, so the app
can check the paper it sees against the paper the print expected.

| The case | What the sheets do |
|---|---|
| The print scale cannot be guaranteed | Measure it against the paper's edges, per axis, correct for it, and report the percentage. "Fit to page" becomes a number on screen. |
| Trust only the 8.5 × 11 | The default. The paper's physical size sets absolute scale. The print only sets the shape. |
| A 1:1 print is available | Used when the paper's edges cannot be measured, for example on a white desk. The scale comes from a print check made when the set was printed, or is labelled unverified. |
| The wrong paper, or the wrong setting | The print says what paper it was made for; the edges say what paper it is on. Any disagreement is reported, never absorbed. |
| A part bigger than one sheet | Several numbered sheets laid around it, fitted together on one plane, so the part is measured between calibrated points instead of beyond them. |
| A drawer | A sheet on the drawer's floor sits on the same plane as the tools, so it catches corners marked at the rim. |
| A thick part | Phase 3: the exact plane plus the camera's focal length gives the camera's height, and the part's typed thickness gives the correction. A sheet raised on a book of known height does the same without trusting the phone. |

## A.1 Problem

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
7. The segmenter samples one paper colour from a border band and marks every
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
- **One paper colour for the whole sheet.** Under a lamp, the far side of a
  sheet is darker than the near side, and `computeDiffMap` compares every
  pixel against a single median, so the dark side can read as object.

What is manual today: fine-tuning the corners, picking the paper size, and
pressing Auto for the lens.

### Large parts

A part bigger than the sheet uses Capture area, Extend (`captureFrac`,
`js/main.js:72`; README "Capture area"). The four-corner homography is then
extrapolated past the paper, and `computeDiffMap` switches to a dual model in
which a pixel is background if it resembles either the paper or the
surrounding surface (`js/segment.js:39`). Extrapolation is where a homography
is weakest: any corner error grows with distance from the sheet, and the lens
estimate only ever saw the sheet's edges.

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

## A.2 Success criteria

### Phase 1: one sheet

1. **It recognises its own sheet.** A photo of either layout, on either stock,
   is recognised on load with no setting changed.
2. **It reads its own identity.** Any 53 mm of visible code track yields the
   layout version, the paper size the sheet was made for, the sheet number and
   the print job. A code word corrupted in any single cell is rejected, never
   misread as a different value.
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
   result that names where its scale came from, never a silent assumption.
6. **Partial cover does not break it.** With one frame side fully covered, the
   fit from the other three is within 0.1 mm of the full fit on the synthetic.
   A sheet whose bottom frame side was lost to a printer's margin fits the
   same way. A sheet with 40 percent of its area out of the photo is still
   identified and fitted when readable code shows on two sides that are not
   parallel.
7. **Rough corners are enough.** Hand-placed corners up to 5 mm off produce the
   same fit to within 0.05 mm, so the white-desk case needs only a rough drag.
8. **It reports an honest accuracy figure.** Every sheet-mode rectification
   shows a fit in millimetres, and that number rises measurably when the
   synthetic sheet is bent or the lens correction is withheld. A figure that
   does not respond to real error is decoration.
9. **It prints from the app.** Either layout, any number of numbered sheets up
   to eight, from a button in Step 1, through the browser's own print dialog,
   with no file to find first.
10. **A print check is remembered.** A fresh set photographed once on a dark
    surface is recorded by print job and sheet. A later photo of those sheets
    on a white desk uses the recorded scale instead of "unverified", and says
    which check it came from.
11. **It says what is wrong with a photo before tracing.** A sheet under
    4 px/mm, a blurred or glared code track, and a fit figure over 0.2 mm each
    produce a specific instruction (move closer or use the 2× lens, hold still
    or change the light, flatten the sheet), tested on a synthetic render of
    each.
12. **Uneven light does not become object.** A synthetic sheet lit with a
    30 percent brightness gradient segments the part correctly, where the
    single-colour model marks the dark side as object. (Droppable step.)
13. **Plain paper gets better too.** Edge-fitted corners bring the existing
    synthetic's corner error under 1 px, from 2.4.
14. **Plain paper catches the wrong size.** With Letter selected, a synthetic A4
    sheet is flagged and a true Letter sheet is not, at any tilt up to 25°.
15. **Layout v1 is locked.** Regenerating either layout reproduces the
    committed reference geometry exactly; any change fails the suite with a
    message to make a v2. Synthetic sheet photos are rendered from the SVG the
    print page itself produces.
16. **Real photos are tests.** A committed set of Sam's photos, each with a
    steel rule on the sheet and two points on the rule marked once by hand, is
    measured on every run. No photo may measure worse than the figure recorded
    when it was added.
17. **Recognition is cheap.** It adds under 200 ms, measured warm, to loading a
    12 MP photo.
18. **Nothing moves for saved work.** Projects saved before this load with
    their stored corners, unchanged. Coin, grid, scale bar and drawer scan
    behave as before. The save format gains only additive fields.

### Phase 2: several sheets

19. **Freehand sets work.** Up to eight sheets in one photo, laid down by hand
    with gaps and at any rotation, are each identified and fitted together on
    one plane. Nobody aligns anything.
20. **More sheets measure large parts better, and it is shown, not claimed.**
    Four sheets around a 500 mm synthetic part, rendered with lens distortion
    and pixel noise, measure it within 0.2 mm. The same part calibrated from
    one sheet at one end is measured in the same test and must come out worse.
21. **One print job, one scale.** Sheets carrying the same job share a fitted
    print scale, so one sheet with visible edges verifies the set. A sheet from
    another job, or on other paper, is verified on its own edges.
22. **Duplicates are survivable.** Two sheets with the same job and number are
    still treated as two sheets, with a note to print a fresh set.
23. **A sheet on a drawer floor fixes the drawer's scale.** On a synthetic
    drawer 60 mm deep, photographed from 800 mm with its corners marked at the
    rim, tools read 7.5 percent small. A sheet on the floor reports the
    discrepancy within half a percentage point, one click rescales every tool
    to within 0.5 percent of true, and nothing changes before the click.

### Phase 3: parallax

24. **Corrected with the phone's focal length.** With an EXIF focal length
    present, a 10 mm synthetic part rendered with true parallax from 400 mm
    measures within 0.2 mm. Uncorrected, the same render reads 2.6 mm large on
    100 mm.
25. **Corrected without trusting the phone.** A sheet raised on a surface of
    stated height recovers the camera height within 3 percent with no EXIF at
    all, and flags an EXIF focal length that disagrees by more than 3 percent.
26. **The correction is visible.** The readout names it ("parallax: 2.4 percent
    at 10 mm, corrected") along with the camera height and tilt, so a changed
    dimension never comes as a surprise.
27. **No data, no correction, and it says so.** Without EXIF or a raised sheet,
    nothing is corrected, the readout says parallax is uncorrected, and it
    carries the stand-back advice.

## A.3 Scope

### In

- Edge-fitted corners and a wrong-paper check for plain paper.
- Printable sheets in two layouts, US Letter and A4, generated in-app from one
  layout module that the detector also reads: a frame line for geometry and a
  code track carrying layout version, paper size, sheet number, print job and
  position.
- Printing from the app, with a record of each print job, and the print check.
- Recognition, the fit, lens estimation, the print-scale measurement, the paper
  double check, the verdict and photo-quality guidance, for one sheet and then
  for several.
- Masking the printed band out of segmentation, a lighting model from the
  paper around the frame, and a warning when a trace touches the window edge.
- A locked reference layout, SVG-rendered synthetic photos, and a real-photo
  test set.
- A ruler verification of a print (droppable).
- Drawer scale from a sheet on the drawer floor (phase 2; see also Part B.1).
- Parallax correction from EXIF focal length and from a raised sheet (phase 3).
- Tests for each criterion, a README section per phase, and this PRD's status
  line.

### Out

- **Any pattern in the middle of a sheet.** It would be traced as part of the
  object.
- **Sheets tiled under a part that crosses their bands.** Tracing across a
  band needs the mask to hide only the printed ink and bridge the part across
  it. Possible later; phase 2 places sheets around the part instead.
- **Stitching several photos.** A separate, larger feature. Sheets carrying a
  job and a number are unique, which makes them the natural tie points for it
  later.
- **Measuring a part's height from the photo.** Parallax correction uses the
  thickness already typed for extrusion.
- **Parts that are not prismatic.** The correction assumes straight walls, so
  the top outline is the widest one.
- **Registering the underside photo** (`js/backphoto.js`) against the sheet.
- **Colour or low-visibility patterns.** Many people print in black and white.
- **Full camera calibration.** Only the focal length is used, from EXIF or
  from a raised sheet. The principal point is taken as the image centre.

## A.4 Constraints

- Single-file, fully client-side, no server, no user-facing build step. No new
  vendored library: no OpenCV, no in-browser PDF generator.
- **Printed sheets outlive the code.** Layout v1's geometry and its code
  payload are frozen the day it ships. The version field is how any later
  layout is told apart, and v1 stays recognised for good, which the locked
  reference layout enforces. Every field that phases 2 and 3 need is in the v1
  payload, even though they ship later.
- Black ink only, printable on any laser or inkjet. Nothing is printed within
  10 mm of the paper edge, which leaves the real edge clean for the double
  check and clears the hardware margin of most printers. Some older inkjets
  keep a larger bottom margin; a frame side lost that way is handled like a
  covered one, and a test covers it.
- Deterministic: no `Date.now()` or `Math.random()` in detection or encoding.
  The print job is drawn at print time from a clock that is injected, the way
  autosave's is, so tests can fix it.
- Save-format keys stay stable; anything new is additive and optional. Ids
  keep their names.
- Memory: detection reads source pixels along its profiles only, or shares the
  one full-size read `rectify` already makes. It never holds a second
  full-size copy.
- **The synthetic suite cannot show the frame beating the paper edge**, because
  a rendered paper edge is perfect: no curl, no shadow, no pale desk. That is
  what the real-photo test set is for.
- Real-photo test photos are downscaled to about 2400 px on the long side and
  kept under about 8 MB as a set. Location data is stripped before they are
  committed; the focal-length tags phase 3 needs are kept.
- EXIF is present in a photo uploaded straight from a phone in most browsers,
  and missing from screenshots, edited images and photos passed through most
  messaging apps. Phase 3 behaves well without it. Project saves already strip
  EXIF, because the photo is re-encoded through a canvas (`imageToDataURL`,
  `js/main.js:6369`), and phase 3 keeps it that way: it stores the focal length
  it derived and nothing else from the EXIF block.

## A.5 Design

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
(211.9 × 275.4 after today's 2 mm margin). It matters only when the part sits
on the sheet; in phase 2 the part sits between sheets.

The frame line is the first ink inward from every edge, which is what lets the
detector find it before reading any code. The code track sits inside it with a
1 mm gap so it cannot pull the line's fitted centre. Small L-shaped ticks in
the quiet gap mark the window's corners, so a person can see where the part
has to stay.

The bottom strip carries, for people: "2.5D calibration sheet · US Letter
8.5 × 11 in (215.9 × 279.4 mm) · layout v1 · sheet 2 of 4 · set 7F · Print at
Actual size. The app checks the scale either way." The set is the print job,
in two hex digits, so a person can tell two sets apart too. The strip also
carries a 150 mm ruler with 1, 5 and 10 mm ticks. The app never relies on the
text; the code carries everything it needs.

### The code

The clock row alternates black and white 1.5 mm cells, like a QR code's timing
line. It tells the reader exactly where every cell is, even where the print
was scaled, and every black clock cell's centre is a point with known design
coordinates. One cell is left white at the start of each code word. Three
white cells in a row never happen anywhere else, so that missing tooth marks
word boundaries without a separate marker.

The two data rows carry one bit per cell, 34 bits per word, 17 cells each.
With the missing tooth that makes a word 18 cells, 27 mm, long. Words run end
to end along each side, so any 53 mm of visible track contains at least one
complete word.

| Field | Bits | Carries |
|---|---|---|
| Layout version | 4 | 1 for this design; 0 reserved; up to 15 later layouts |
| Paper size | 4 | The stock the layout was made for: Letter, A4, and room for Legal, A3, Tabloid, A5 and others |
| Sheet number | 4 | 1 to 15 within a set; the print panel caps sets at 8 |
| Print job | 8 | Drawn at print time, the same on every sheet of one job |
| Position | 6 | Which word this is, counted around the frame |
| Checksum | 8 | CRC-8 over the other fields |

A Letter sheet carries 28 words: eight along each long side, six along each
short one. A3, the largest stock named, needs 46, so the six-bit position
covers every size the payload names. Because the layout's rules are all
insets from the paper edge, a stock added to the paper table later needs no
new layout version.

The print job is what lets the app know which sheets were printed together:
the same printer, the same job, one print scale. Phase 2 relies on that, phase
3's raised sheet relies on it, and so does the print check. Eight bits make a
collision between two of one person's sets a 1 in 256 chance, and the harm is
bounded: every sheet whose edges are visible is verified on its own anyway.

The checksum keeps a misread from becoming a wrong answer. A word with a bad
cell fails it and is dropped. A word that passes it by chance, one time in
256, still has to agree with every other word read on the same sheet and with
its own measured position along the frame, so a bad word is caught twice
over. Words are read clockwise, and a sheet turned upside down reads them
backwards; the missing tooth sits at a word's start, so trying both directions
and keeping the one that checks settles orientation.

Cells stay readable down to about 4 px/mm in the photo, six pixels per cell,
which is the sheet filling about a third of a 12 MP photo's long side.

### Printing from the app

"Print calibration sheets" in the Step 1 paper panel opens a small panel:

- **Paper**: US Letter or A4, defaulting to the paper picker's choice.
- **Sheets**: 1 to 8, numbered 1 to N, all in one print job with one job code.
- **Print**: opens the browser's print dialog on a page carrying each sheet as
  SVG in real millimetres, one per page, with `@page` set to the stock size
  and zero margin.
- **Download**: the same pages as SVG, for printing elsewhere.

The panel says, once and plainly:

- Choose Actual size or 100 percent if the dialog offers it. If it doesn't,
  print anyway: the app measures whatever scale comes out.
- Cardstock or heavier paper lies flatter than copy paper, and a curled sheet
  shows up as a worse fit figure.
- Matte paper and soft light work best. Laser toner has a slight sheen, and
  under a lamp at the wrong angle black cells can read as white.

Each print is recorded in this browser: job code, date, paper, sheet count.
That is what the print check and the Step 1 panel name ("your set 7F, printed
29 Sep"). A committed static PDF set, generated by the suite's own Chromium at
development time, is open question 2.

### The print check

Right after printing, the panel offers one more step: photograph the new
sheets together on a dark surface. The app recognises each one, measures its
print scale against its paper edges, and records it against the job and sheet
number. After that, any photo of those sheets where the edges cannot be
measured (a white desk, a sheet half covered) uses the recorded scale and says
so, instead of reporting "unverified".

When the edges can be measured and they disagree with the record by more than
the ±0.5 percent verdict band, the app believes the photo, says so, and offers
to update the record. That catches a reprint that happened to draw the same
job code.

The check is measured against paper edges, so it carries the paper's cut
tolerance. The ruler verification below is the way under that.

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
5. With at least one good word, the sheet's layout, paper, number and job are
   known, and so are the design coordinates of every visible clock cell. With
   none, the fit falls back to the line alone: all four sides required, the
   layout named by the frame's aspect ratio, no sheet number, one sheet only.

A side with no dips at all, because an object covers it or a printer's margin
swallowed it, is simply absent; steps 4 and 5 work from the sides that remain.
Graph paper fails at step 2 on dip width, a printed page of text fails at step
3, and a plain sheet finds nothing.

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
   are badly conditioned without it.
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
| Edges not visible, print check on record | "Scale from your print check of set 7F on 29 Sep." |
| Edges not visible, no record, or edges matching no known stock | "Print scale unverified." Design coordinates are taken as true, which assumes a 1:1 print. |

The paper's aspect ratio names its stock because an isotropic print scale
leaves aspect untouched: Letter is 0.7727, A4 0.7071. The print scale is the
stock's known width and height over their measured values, per axis. "1:1"
allows ±0.5 percent because a true 1:1 print on a sheet cut 0.3 percent large
reads 0.3 percent off, and a verdict that calls good prints bad gets ignored.

Step 1 draws what it found: the paper outline it measured and the frame it
fitted, over the photo, so a person can see the double check. The panel asks
for the whole sheet to be in the photo, because the check needs the edges.

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

### Photo-quality guidance

Recognition already measures what makes a photo good or bad, so the Step 1
panel says it before anyone traces:

| Signal | Threshold | Instruction |
|---|---|---|
| Pixels per millimetre on the sheet | under 4 | "The sheet is small in the photo. Move closer, or use the 2× lens." |
| Share of clock cells read cleanly | under 80 percent | "The code is blurred or glared. Hold still, tap to focus, or move the light." |
| Fit figure | over 0.2 mm | "The sheet may not be flat. Tape the corners down or use cardstock." |
| Camera tilt (phase 3) | over 10° | "Shoot from more directly above." |
| Parallax before correction (phase 3) | any | "Camera about 380 mm above the sheet: a 10 mm part reads 2.6 percent large before correction." |

The code track is a built-in sharpness and resolution test: if its cells read
cleanly, the photo resolves at least 1.5 mm features, which is finer than
anything the trace needs.

### Segmentation and lighting, one sheet

The window sits at a printed offset from the frame, while the paper edge sits
wherever the printer's registration put it. So the masked band is defined from
the frame and carried into sheet coordinates through the fitted rectangle, not
measured from the paper edge. It replaces the uniform 2 mm margin with
per-side insets (`js/main.js:1869`). A trace within 1 mm of the window edge
gets a warning that the object may run into the band.

The blank strip between the paper edge and the frame, and the quiet gaps, are
clean paper all the way around the part. Sampled there, they give the paper's
brightness and colour on every side, and a smooth low-order surface fitted to
those samples predicts the paper under the part. `computeDiffMap` then
compares each pixel against the paper predicted at that spot instead of one
median for the whole sheet. This step is droppable; without it, the paper
colour is simply sampled just inside the window's rim.

### When the paper edges cannot be seen

On a white desk the paper edge has no contrast, but the frame and the code
still do. With a print check on record for that job and sheet, its scale is
used and named. Without one, the fit takes design coordinates as true, which
assumes a 1:1 print, and the verdict reads "Print scale unverified: the
paper's edges are not visible against this surface."

### Verifying a print with a ruler

The print check inherits the paper's cut tolerance. For anyone who wants
under it, the frame is itself a ruler: its outside edges are 195.9 × 259.4 mm
apart on Letter at 100 percent. Measure both with a steel rule, type them in,
and that print's scale is known on both axes, feed direction included, which
is the direction printers most often get wrong. A steel rule reads to about
0.25 mm over 200 mm, roughly 0.1 percent. Stored with the print check, per
browser, keyed by job and sheet, and preferred over it when present.

### Plain paper: edge-fitted corners and the wrong-paper check

This is plan step 1 and needs no printing. `js/edgeFit.js` takes the coarse
corners, walks full-resolution profiles across the middle of each edge
(15 mm clear of the corners), finds the brightness step to sub-pixel
precision, fits a robust line per edge, and intersects the lines. The result
converts back to photo coordinates through the lens model. It is accepted only
when every edge fits well and the corners stay close to the coarse ones;
otherwise the coarse corners stand.

With precise corners the app can also check the paper size. A photo taken
close to straight down keeps the sheet's true aspect ratio, and a tilted one
can be corrected with the method whiteboard-scanning apps use (Zhang and He):
the two vanishing points of the sheet's edges give the focal length, and the
focal length gives the true aspect ratio. Letter (0.773) and A4 (0.707) are 9
percent apart, so a warning, "This looks like A4, not Letter", is reliable
well beyond ordinary tilt. It warns and offers to switch; it never switches on
its own, because the person may be using a custom sheet on purpose.

### Testing: a frozen layout and real photos

**The locked layout.** The reference geometry of layout v1, every rectangle
and cell of both stocks in millimetres, is committed as a fixture. A test
regenerates it from the layout module and compares. Any difference fails with
"Layout v1 is frozen; printed sheets depend on it. Add a v2 instead."

**Synthetic photos from the real artwork.** The suite renders its sheet
photos from the SVG the print page produces: drawn flat at high resolution,
then warped through a known homography, with blur, noise and lens distortion
where a test asks for them. A mismatch between what is printed and what the
detector expects fails a test before it fails on paper.

**Real photos.** A set of Sam's photos lives in `test/fixtures/real/`: a
plain sheet, a printed sheet at 1:1, one printed with Fit to page, one on a
pale desk, one under a lamp, and later a set and a drawer. Each has a steel
rule lying on the sheet, and a small sidecar file names two points on the
rule, marked once by hand, with their true distance. The suite rectifies each
photo and measures that distance on every run. When a photo is added its
error is recorded, and no later change may make it worse. The real-photo
checkpoints stop being one-off favours and become permanent tests.

### Several sheets (phase 2)

**Where they go.** Around the part, on the table, rather than under it. A part
lying between sheets on every side is measured between calibrated points,
where a homography is at its best. A part hanging off one sheet is measured
beyond them, where it is at its worst. Two sheets on opposite sides are the
minimum worth having; four, one per side, is the recommendation. The part lies
on the table, so it never crosses a band, and the existing dual background
model (paper or surface, `js/segment.js:39`) already handles what surrounds
it.

**Finding them.** `detectPaperCorners` keeps only the largest bright component.
Returning every bright, sheet-sized component instead gives each sheet its own
rough corners, and phase 1's recognition runs on each. A search of the whole
photo for straight dark segments of the frame line's width, kept only where
code reads beside them, handles what that misses, mainly white desks. The code
says which sheet each segment belongs to, so grouping is by job and number,
not by guessing which lines make a rectangle.

**Fitting them.** All the sheets lie on one plane. So there is one mapping
from the table to the photo, eight numbers and one lens term, shared by every
sheet, and each sheet adds only where it lies on the table and, per print job,
a print scale. Sheet 1 of the first job anchors the table's coordinates. With
eight sheets that is about fifty unknowns against hundreds of points, a small
nonlinear least-squares problem, initialised from each sheet's own
single-sheet fit. It needs a general Gauss-Newton solver, which the codebase
does not have yet.

**Output.** The rectified area is a rectangle on the table covering the sheets
and the part, at the drawer scan's higher ceiling (`SCAN_MAX_LONG_SIDE_PX`,
`js/main.js:284`). It is still four corners, a width, a height and `k1`, so
`rectify` is unchanged. The background model generalises from one paper
rectangle to a list of them, and every sheet's band is masked.

**Drawer scale.** This is drawer scan plan step 7, moved here on 2026-09-29.
A drawer scan rectifies from the drawer's corners and its typed width and
depth. Corners marked at the rim sit one drawer depth nearer the camera than
the tools, so every tool reads small: 7.5 percent for a 60 mm drawer shot from
800 mm. A sheet laid in a free corner of the drawer floor is on the tools'
plane. Recognised in the scan photo, its scale against the rim rectification
is exactly the rim-to-floor factor. The app then reports the discrepancy and
offers one click to rescale every scanned tool uniformly, the remedy that
drawer scan's open question 6 recommended; the typed numbers stay the default
until that click. The sheet itself is masked out of segmentation entirely, so
it never arrives as a tool. With corners marked on the floor the factor comes
out near 1 and nothing is offered. Part B.1 covers what can ship before phase
2.

**What it does not buy.** Sheets from one ream share one cut error, so more
sheets improve the geometry over a large area but not the per-ream scale floor.
And the whole area comes from one photo, so a large part gets fewer pixels per
millimetre: a 600 mm part in a 12 MP photo gets about 5 px/mm.

### Parallax (phase 3)

**What no flat pattern can do.** No flat pattern can measure the camera's
height from a photo taken straight down. A camera close to the paper with a
wide lens and a camera far away with a narrow lens take the identical picture
of a flat plane. That is geometry, not a missing feature, and it is why a fix
needs one extra fact from outside the plane.

**Route 1: the phone's focal length.** Given the focal length, the exact
homography gives the camera's full position: its height above the plane and
the point directly below it. EXIF usually carries the focal length as a 35 mm
equivalent, which converts to pixels through the image diagonal. Then every
traced outline at height `t` is corrected by one uniform scale of
`(D - t) / D` about the point below the camera. That formula holds whatever
the camera's tilt. With EXIF good to roughly 2 to 5 percent, the residual
error is that fraction of the original: the 10 mm part from 400 mm goes from
2.6 percent to around 0.1 percent. This needs phase 1's exact homography; a
four-corner fit is too noisy to recover a camera position from.

**Route 2: a sheet at a known height.** Lay one sheet of the set on a flat
book or box and type its height. That sheet appears magnified by
`D / (D - h)` next to the sheets on the table, and that ratio gives `D`
directly, with no focal length needed. The app tells a raised sheet from a
differently scaled print because a raised sheet's paper edges are magnified
along with its frame, while a print scale changes only the frame; it then asks
for the height. When the raised sheet carries the same print job as the
others, their print scale cancels, so the magnification is measured from
frames alone and the paper's cut tolerance never enters. A book measured to
0.5 mm at 25 mm gives `D` to about 2 percent. It checks EXIF, or replaces it
when EXIF is missing or wrong, as it can be when a phone crops digitally.

**Which height, and what gets corrected.** The height is the thickness already
typed for extrusion. The outer outline is corrected at the base section's
thickness, and a section of another thickness at its own. The image is
corrected rather than the outline: rectify at the top plane of the base
section, so the part is traced at true size and what is traced is what is
built. The paper-plane things, the bands and the paper regions, are carried
into that raster by the same known scale.

**The free part.** Parallax scales with `t / D`, so doubling the distance
halves it. From 800 to 1000 mm, on a phone's 2× or 3× lens, the 10 mm part
drops from 2.6 percent to about 1 percent before any correction. The
photo-quality panel names the camera height and the effect once they are
known, which teaches the habit.

### The accuracy floor

With the sheets, the paper plane's shape comes from the printed features and
its absolute scale from the paper. The scale carries the paper's cut
tolerance, about ±0.8 mm on Letter's 279.4 mm and up to ±2 mm on A4 under
ISO 216. Sheets within one ream are near-identical, so it is a fixed error per
ream rather than noise that averages away. A shadow along one edge biases that
edge's position by a tenth of a millimetre or two. The ruler verification gets
under the paper tolerance. Phase 3 is the only thing here that touches
parallax.

## A.6 Plan

Each step is one commit, `node test/e2e.mjs` green, with the suite's printed
total quoted in the message. Each phase ends with a README section and a
checkpoint that needs a person.

### Phase 1: one sheet

1. **Plain paper: edge-fitted corners and the wrong-paper check.**
   `js/edgeFit.js` and the aspect check. Tests: criteria 13 and 14; the
   existing corner check tightens from 10 px.
2. **The real-photo test set.** The fixture folder, the sidecar format, the
   measuring test, the recorded baselines. **Checkpoint:** Sam's first photos,
   plain sheets with a steel rule, which also measure how much step 1 alone
   delivered before the sheet is built.
3. **The layout and the code.** `js/calibSheet.js`: layout constants for
   Letter and A4, the word encoder and decoder with its CRC, the SVG generator
   for a numbered set, and the locked reference geometry. Tests: every field
   round-trips; every single-cell corruption is rejected; criterion 15.
4. **Printing from the app.** The Step 1 panel, the print page, the SVG
   download, the print record, the paper and lighting advice. Test: the page's
   `@page` size and every sheet's number, job and paper are what the panel
   asked for.
5. **SVG-rendered synthetic photos.** The renderer the remaining steps test
   against.
6. **Recognition.** Profiles, dips, line fits, code reading, the line-only
   fallback. Tests: 1:1, blur, radial distortion, corners 5 mm off, one side
   covered, the bottom side clipped, 40 percent out of frame.
7. **The fit.** Least-squares homography with normalisation, lens, the fit
   figure. Tests: criteria 6, 7 and 8.
8. **The double check, the verdict, the print check.** The five-parameter
   rectangle, stock identification, the verdict table, the print check and its
   record, the four-corner output, the Step 1 overlay and panel. Tests:
   criteria 3, 4, 5 and 10.
9. **Photo-quality guidance.** Criterion 11.
10. **Segmentation and integration.** The frame-relative mask, the window-edge
    warning, recognition on every load including the queue, the checkbox, an
    additive `sheet` block in projects. Tests: criterion 18; an object traced
    at 96 percent measures true. **Checkpoint:** real photos of printed
    sheets, one printed with Fit to page on, one under a lamp, added to the
    fixture set.
11. **Lighting model.** Criterion 12. Droppable.
12. **Ruler verification.** Droppable.
13. **README** and this PRD's status line.

### Phase 2: several sheets (sign-off after phase 1's checkpoint)

14. **Finding several sheets.** Every bright sheet-sized component as a seed;
    the whole-photo line search as the fallback. Tests: one to eight sheets at
    random poses; duplicates; a sheet half out of frame.
15. **The joint fit.** A small Gauss-Newton solver, one shared plane and lens,
    a pose per sheet, a scale per print job. Tests: criteria 20, 21, 22.
16. **Rectification and segmentation for a set.** The table rectangle, the
    list of paper regions in the background model, every band masked.
17. **Drawer scale from a sheet.** Recognition inside a drawer scan, the
    sheet masked out, the discrepancy report and the one-click rescale.
    Criterion 23. **Checkpoint:** a real large part with four sheets, and a
    real drawer with a sheet on its floor.
18. **README.**

### Phase 3: parallax (sign-off after phase 1's checkpoint)

19. **EXIF and camera position.** Read the focal length from the JPEG's EXIF;
    decompose the homography into the camera's height, tilt and the point
    below it; show them. Tests: synthetic renders with known camera positions,
    tilted and straight down.
20. **The correction.** Rectify at the base section's top plane, per-section
    correction for the rest, the readout. Tests: criteria 24, 26, 27.
21. **The raised sheet.** Detection by magnified paper edges, the height
    prompt, the EXIF cross-check. Criterion 25. **Checkpoint:** what EXIF
    survives on Sam's own phone and browser, and one real thick part.
22. **README**, including that centring the part does not fix its size.

---

# Part B: The backlog

Everything else outstanding, from `BURNDOWN.md`, the README's Next up and
Known gaps, and the drawer scan PRD, checked against the code on 2026-09-29.

## B.1 Drawer scale

**Problem.** Drawer scan step 7 never shipped (`docs/drawer_scan_prd_v1.0.md`,
status line). A drawer scan takes its scale from the drawer's corners and the
typed width and depth. Corners marked at the rim, which is where they are
easiest to see, make every tool read small: `L · (H - d) / H`, so 7.5 percent
for a 60 mm drawer from 800 mm, and a pocket cut 7.5 percent small does not
take the tool at all. Today the only defence is hint text; the README says as
much under "Not in v1". It is the largest error a shipped feature can make
without saying so.

**What already fixes it, later.** Part A phase 2, step 17: a calibration sheet
on the drawer floor, recognised automatically, with a one-click rescale.

**What can fix it now.** A coin on the drawer floor sits on the tools' plane
just as a sheet does, and the app already has a coin reference with a circle
handle and a table of coin sizes (`COIN_SIZES`, `js/paperSizes.js`). The
drawer scan's original step 7 was designed around exactly this: a reference
object cross-check that warns past 2 percent and changes no geometry, with the
one-click rescale of its open question 6.

- In the scan review, "Check the scale with a coin": pick the coin, fit the
  circle handle to it in the rectified drawer.
- The coin's measured diameter against its true one is the rim-to-floor
  factor. Past 2 percent: "Tools are reading 7.4 percent small. The corners
  were probably marked at the rim." One click rescales every scanned tool
  uniformly; nothing changes before it.
- The coin is masked out of segmentation, as the sheet will be.
- When phase 2 ships, the sheet becomes the preferred reference and the coin
  stays as the no-printing fallback.

**Success criteria.** On the synthetic 60 mm drawer from 800 mm with rim
corners, a coin on the floor reports the discrepancy within 1 percentage point
(a hand-fitted circle on a 24 mm coin at about 5 px/mm is good to roughly
0.2 mm), one click rescales to within 1 percent of true, and nothing moves
before the click. With floor corners, no warning. The project round-trips the
applied factor.

**Plan.** One commit for the coin check and the rescale, one for the README's
"Not in v1" paragraph. Open question 11.

## B.2 Drawer scan review: merge and thumbnails

**Problem.** Two pieces of the scan review were planned in the drawer scan
PRD's step 5 and dropped when the session ran short. Checked in code: the
review row (`scanSyncPanel`, `js/main.js:4016`) has a tick box, a name and a
bounding-box size, and nothing else, and there is no merge in `js/main.js` or
`js/scan.js`.

- **Merge.** When the segmenter splits one tool into two candidates, a
  two-colour handle for example, there is no way to join them. The drawer scan
  PRD settled how (its open question 4): merge the masks before tracing, so the
  result is one loop with no seam.
- **Thumbnails.** A row reading "Tool 4, 182 × 31 mm" does not say which tool
  it is. `js/scan.js` already anticipates a thumbnail per candidate (its
  comment near line 99).

The README's Next up, as written on 2026-09-21, described merge as joining
tools "the segmenter split because the tools were touching". That was wrong:
touching tools arrive as one candidate, which would need splitting, and the
drawer scan PRD's open question 7 keeps splitting out of scope on purpose. It
is corrected in the same commit as this document.

**Success criteria.** Every review row shows a thumbnail cropped from the
rectified drawer around its candidate. Selecting two rows and pressing Merge
yields one part with one outline and one name, traced from the union of the
masks; a merged part lands, nests and round-trips like any other; undo
restores the two.

**Plan.** One commit for thumbnails, one for merge.

## B.3 Nest speed and the overfull drawer

**Problem.** Measured warm on `test/nest-bench.mjs` (30 tools): Dense takes
about 2.6 s and 42,280 placement tests, Access about 0.45 s and 6,949. A test
costs the same 0.06 ms under either profile. Dense is slow because it tries
more: free rotation in 15° steps is 24 angles per tool, where Access tries 0°
and 180° only (`nestAngles`, `js/holders.js`). Every nest also runs all 20
restarts to completion. The nesting PRD's criterion 6 (30 tools under 2 s) is
not met by Dense.

The overfull drawer is the same problem's other face. The time budget
disarms itself while any tool is unplaced (README, Known gaps), which is
exactly when a person most wants the nest to finish.

**Design.** Measure before changing anything, because the last diagnosis of
this gap was wrong three times over before the bench had a warm-up. Then:

1. **Where the tests go.** Split the count into screening (candidates tested
   until `keepTop` pass) and settling (the binary-search slides of each kept
   candidate), per profile.
2. **Exact changes first**: anything that removes work without changing a
   single placement, verified by the pack coming out identical on every
   fixture.
3. **Then changes that alter packs**, each behind a quality gate:
   - **Early stop on restarts**: stop when neither the placed count nor the
     packed area has improved for a set number of restarts. This also bounds
     the overfull drawer.
   - **Coarse-to-fine rotation**: try 90° steps first, then refine around the
     best angles.

**Success criteria.** Dense places 30 tools in under 2 s, warm, on the bench.
Across the nest fixtures and the bench, no tool that placed before goes
unplaced, and packed area stays within 1 percent of today's result. An
overfull drawer (40 tools where 30 fit) finishes within 10 s and reports what
did not fit.

**Plan.** One commit for the measurement, then one per change, each quoting
the bench before and after. Open question 14.

## B.4 Small fixes

- **An inert control.** The nest panel's Rotation step select
  (`layNestRotStep`, `index.html:999`) stays live when Free rotation is off,
  but `nestAngles` then ignores it unless a tool is individually set to free
  rotation. The codebase's own rule, written beside the corridor option in
  `js/main.js`, is not to leave "a tick that does nothing". Dim it with a note
  when Free rotation is off and no tool is set free. Test: the control's state
  follows both conditions.
- **The rectified photo loses a generation on every re-edit** (README, Known
  gaps). Restoring a project decodes its rectified JPEG and saving re-encodes
  it at quality 0.85. Keep the loaded JPEG's data and write it back unchanged
  unless the rectification actually changed. Test: a re-edit round trip that
  touches only the trace leaves `rectified` byte-identical.

## B.5 Housekeeping, outside this PRD

Listed so nothing is lost; none of it is build work in this document.

- **Deploy.** gh-pages serves v1.25.0; the branch is at v1.27.5. Deploying is
  outward-facing and waits on Sam's go-ahead.
- **Branches.** GitHub's default branch is still
  `claude/object-thickness-photo-t8mw2k`, at v1.10.x. Sam repoints it to
  `claude/2.5d-photo-stl-s3-y0oodn` in the repository settings; then
  `claude/object-thickness-photo-t8mw2k` and `claude/readme-screenshots` can be
  deleted. Their only unique content is kept on
  `archive/v1.10.x-readme-screenshots`. Branch deletion is blocked inside
  these sessions.
- **Grid and cutting-mat auto-count on real photos.** Blocked on photographs.
  Part A's real-photo test set makes it a matter of adding graph paper and
  cutting mat photos to the same folder.
- **Puzzle-tab kerf** (`fit`) needs one real laser cut.
- **Logo PNG swap** needs the asset.
- **3MF export** is deferred with no decision.

---

## Suggested order

1. **Part A steps 1 and 2**: edge-fitted corners, the wrong-paper check, the
   real-photo test set. Every current user benefits, nothing needs printing,
   and the results say how much the sheet will add.
2. **B.1, the coin drawer check**, if approved: it closes the largest silent
   error in a shipped feature, with no printing.
3. **B.2 and B.4**: small, independent, easy to interleave.
4. **The rest of Part A phase 1.**
5. **B.3**, the nest, at any point; it touches nothing else.
6. **Part A phase 2**, after its sign-off, including the drawer sheet.
7. **Part A phase 3**, after its sign-off.

## Open questions (recommendation first)

Decided on 2026-09-28 and 2026-09-29, by Sam's notes and his approval of the
twelve suggestions:

- The frame carries encoded information.
- The payload is layout version, paper size, sheet number, print job, position
  and a checksum. It freezes with layout v1, so phase 1's sign-off is the last
  chance to add a field.
- The print check and the ruler verification are stored per browser, keyed by
  print job and sheet number.
- Sign-off is staged: phase 1 now, phases 2 and 3 after phase 1's checkpoint.
- Drawer scan step 7 moves into phase 2.

Still open:

1. **Is a window about 30 percent smaller worth it?** Recommendation: yes.
   Anything bigger than 178.9 × 226.4 mm on Letter goes between sheets in
   phase 2, or on a plain sheet or graph paper today. Cells of 1.2 mm would win
   about 1 mm per side back, at the cost of needing about 5 px/mm instead of 4.
2. **A committed static PDF set as well as printing from the app?**
   Recommendation: yes, four numbered Letter sheets and four A4, generated by
   the suite's Chromium, so a sheet can be printed without opening the app.
3. **Apply the lens fit automatically in sheet mode?** Recommendation: yes,
   with the slider as override. Estimates from printed lines don't need the
   human look that paper-edge estimates do.
4. **Should a dragged corner re-fit, or override?** Recommendation: re-fit and
   snap, with one checkbox to turn the sheet fit off.
5. **Accept a sheet printed above 100 percent?** Recommendation: yes. A frame
   side lost to the printer's margin is handled like a covered one.
6. **Edge-fitted corners on by default for plain paper?** Recommendation: yes,
   behind the acceptance guard. Saved projects keep their corners.
7. **Sheets around the part only, or also tiled under it?** Recommendation:
   around only, in phase 2. Under means tracing across bands, which needs
   ink-only masking, and around is the more accurate arrangement anyway.
8. **How many sheets in one photo?** Recommendation: up to eight. More sheets
   in one photo means fewer pixels on each.
9. **Parallax as phase 3 here, or its own PRD?** Recommendation: phase 3 here.
   It changes nothing on the printed sheet, so it can be cut without regret.
10. **Correct the image or the outline for parallax?** Recommendation: the
    image, rectified at the part's top plane, so what is traced is what is
    built.
11. **Ship the coin drawer check (B.1) before phase 2?** Recommendation: yes.
    It was the drawer scan's original step 7, it reuses the coin handle that
    already exists, and it closes a 7.5 percent silent error without anyone
    printing anything.
12. **Drawer rescale: one click, or automatic?** Recommendation: one click, as
    drawer scan's open question 6 recommended. The typed numbers stay the
    default and the only automatic scale; the reference offers the remedy.
13. **A small card-size sheet for drawers?** Recommendation: not yet. A full
    sheet in a free corner of the drawer is enough to start, and because the
    layout rules are insets from the edge, a card stock can be added to the
    paper table later without a new layout version.
14. **May the nest's speedups change packs?** Recommendation: yes, behind the
    quality gate in B.3, but only once the exact changes have been taken.
15. **The real-photo set's budget.** Recommendation: about 2400 px on the long
    side, under about 8 MB in total, location stripped, focal length kept.

## Decision needed

- **Part A phase 1**: sign-off, including a last look at the payload fields.
- **Part B**: B.1 (question 11), B.2, B.3 (question 14) and B.4 can each be
  signed off now. They are small and independent of Part A phase 1.
- **Part A phases 2 and 3**: after phase 1's real-photo checkpoint.

## CHANGELOG

- v1.0 (2026-09-27): Initial draft, from Sam's 2026-09-27 questions on a
  printable fiducial that works whether or not the print scale can be trusted.
- v1.1 (2026-09-28): From Sam's notes on v1.0. The frame gains a code track
  carrying layout version, paper size, sheet number and position, with a
  checksum. The paper edge double check becomes a verdict table. Printing from
  the app becomes its own step. Phase 2 adds several sheets on one plane, and
  phase 3 adds parallax correction from EXIF focal length or a raised sheet.
- v1.2 (2026-09-29): Sam approved all twelve suggestions against v1.1 and asked
  for one PRD covering the outstanding work too. Renamed from
  `calibration_sheet_prd_v1.1.md` to fit the wider scope. Part A gains a print
  job in the payload (sheet number shrinks to four bits, words grow to 27 mm),
  a locked reference layout and SVG-rendered synthetic photos, the plain-paper
  wrong-size check, a real-photo test set measured against a steel rule, the
  print check, photo-quality guidance, a lighting model from the paper around
  the frame, bright-component seeding for several sheets, paper and lighting
  advice at print time, a softened printer-margin claim with a clipped-side
  test, drawer scale from a sheet on the drawer floor, and staged sign-off.
  Part B adds the backlog: the drawer scale check with a coin, drawer scan
  merge and thumbnails, nest speed and the overfull drawer, two small fixes,
  and housekeeping.
