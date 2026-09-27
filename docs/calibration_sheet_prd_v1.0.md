---
file: calibration_sheet_prd_v1.0.md
version: 1.0
author: Sam Cao
created: 2026-09-27
last_updated: 2026-09-27
description: PRD for a printable calibration sheet that the app recognises in a photo, uses for precise geometry, and checks its own print scale against the physical size of the paper it is printed on.
ai_update: Update last_updated and version. Rename file to match. Append changelog at bottom.
---

# PRD: A calibration sheet that checks its own print scale

Status: **DRAFT, awaiting sign-off.** · 2026-09-27 · target branch
`claude/2.5d-photo-stl-s3-y0oodn`

Sam, 2026-09-27: is there a pattern or fiducial that could be printed on a
sheet of paper that would help with accuracy? What if we can't guarantee the
scale of the print? Maybe a design if you can get a 1:1 print, and a design
that just helps and only trusts the 8.5 × 11. Then, after talking it through:
one sheet that can figure out whether its scale is right.

The answer rests on one fact. The paper's size does not depend on the printer,
and the printed marks' size does. With both in the same photo, the ratio
between them is the print scale, so the app can measure it instead of assuming
it. One sheet covers all three cases:

| The case | What the sheet does |
|---|---|
| The print scale cannot be guaranteed | Measures it against the paper's edges, per axis, corrects for it, and reports the percentage. "Fit to page" stops being a failure and becomes a number on screen. |
| Trust only the 8.5 × 11 | The default. The paper's physical size sets absolute scale. The print only sets the shape. |
| A 1:1 print is available | Used when the paper's edges cannot be measured, for example on a white desk. The design scale is taken as true and labelled unverified, or verified once with a ruler (plan step 6). |

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

### What the sheet will not fix

Parallax from the object's own thickness. It belongs here, before anything is
built, because for a thick object it is the largest error left.

The homography is exact for the paper's plane. An object of thickness `t`
photographed from height `D` shows its top outline magnified by
`D / (D - t)` about the point directly below the camera. A 10 mm thick tool
shot from 400 mm reads 2.6 percent large: 2.6 mm on 100 mm, against a
paper-tolerance floor of about 0.3 mm. From 600 mm it is 1.7 percent. Nothing
in the app models it today (`js/` has no parallax, focal-length or EXIF
handling), and this sheet does not change that. It is listed in Out as the
obvious follow-on.

The sheet is still worth building. For thin parts the plane is the part, the
unchecked paper size and the light-desk failure are real on their own, and any
parallax correction will need an exact plane to start from.

## Success criteria

1. **It recognises its own sheet.** A photo of either layout, on either stock,
   is recognised on load with no setting changed.
2. **It knows its print scale.** On synthetic photos printed at 100 percent, at
   96 percent about the page centre, and at 94 percent anchored top left with a
   1 mm registration offset and 0.5° of feed skew, the reported scale is within
   0.2 percent of truth on each axis. It says "1:1" within ±0.5 percent and
   names the percentage otherwise.
3. **It corrects for it.** An object traced on the 96 percent sheet measures
   within 0.1 mm of true on a high-resolution synthetic photo, the same as on
   the 1:1 sheet.
4. **Rough corners are enough.** Hand-placed corners up to 5 mm off produce the
   same fit to within 0.05 mm, so the white-desk case needs only a rough drag.
5. **It reports an honest accuracy figure.** Every sheet-mode rectification
   shows a fit in millimetres, and that number rises measurably when the
   synthetic sheet is bent or the lens correction is withheld. A figure that
   does not respond to real error is decoration.
6. **It knows the stock.** Letter and A4 paper are told apart from the measured
   aspect. A Letter layout printed on A4 is reported as exactly that.
7. **It degrades loudly.** Paper edges that cannot be measured give a
   design-scale result labelled unverified. A frame side covered by the object
   gives the plain-paper path and a sentence saying which side and why.
8. **Plain paper gets better too.** Edge-fitted corners bring the existing
   synthetic's corner error under 1 px, from 2.4.
9. **Recognition is cheap.** It adds under 150 ms, measured warm, to loading a
   12 MP photo.
10. **Nothing moves for saved work.** Projects saved before this load with
    their stored corners, unchanged. Coin, grid, scale bar and drawer scan
    behave as before. The save format gains only additive fields.

## Scope

### In

- Edge-fitted corners for plain paper: sub-pixel samples along the middle of
  each edge, a robust line per edge, corners at the intersections.
- A printable sheet in two layouts, US Letter and A4, generated in-app from one
  layout module that the detector also reads.
- Automatic recognition, the frame fit, lens estimation from the frame, the
  print-scale measurement, stock identification and the verdict.
- The band between the paper edge and the printed window masked out of
  segmentation, and a warning when a trace touches the window edge.
- A one-time ruler verification of a print (plan step 6, droppable).
- Tests for each criterion in one contiguous block, a README section, and this
  PRD's status line.

### Out

- **Coded markers.** Not needed for v1; see Design. They would buy partial
  visibility and tiling across several sheets, and neither is asked for.
- **Any pattern in the middle of the sheet.** It would be traced as part of the
  object.
- **Parallax correction for thick objects.** The largest remaining error for
  them, see Problem. A separate PRD; EXIF focal length is the likely route.
- **Objects larger than the printed window**, and capture beyond the paper
  (`captureFrac > 0`), in sheet mode. Both mean crossing the band. A plain
  sheet or graph paper still covers them.
- **Drawer scan step 7.** A sheet laid in a drawer is the natural reference
  object for it, but that step waits on its own open question 6.
- **Registering the underside photo** (`js/backphoto.js`) against the sheet.
- **Colour or low-visibility patterns.** Many people print in black and white.
- **Full camera calibration.** Focal length and principal point are not
  estimated.

## Constraints

- Single-file, fully client-side, no server, no user-facing build step. No new
  vendored library: no OpenCV, no in-browser PDF generator.
- **Printed sheets outlive the code.** Layout v1's geometry is frozen the day
  it ships. A later layout is a v2 that the detector tells apart from v1, and
  v1 stays recognised for good.
- Black ink only, printable on any laser or inkjet, nothing within 10 mm of the
  paper edge, which clears the hardware margin of every common printer.
- Deterministic: no `Date.now()` or `Math.random()` in detection.
- Save-format keys stay stable; anything new is additive and optional. Ids
  keep their names.
- Memory: detection reads source pixels along its profiles only, or shares the
  one full-size read `rectify` already makes. It never holds a second
  full-size copy.
- **The synthetic suite cannot show the frame beating the paper edge**, because
  a rendered paper edge is perfect: no curl, no shadow, no pale desk. The math
  and every degradation path can be tested synthetically. The real-world claim
  needs a handful of Sam's own photos, a plain sheet and a printed sheet under
  the same light. That is a checkpoint in the plan, and it needs a person.

## Design

### Why a frame, and not a pattern across the sheet

The segmenter finds the object as whatever is not paper-coloured
(`computeDiffMap`). Ink under the object is, to it, more object. So the
sheet's middle has to stay blank, and every printed feature goes around the
edge.

That costs little. A plane homography is best constrained by features spread
around the outside of the region, not scattered through it. And once
everything lives at the perimeter, a single printed rectangle beats a ring of
markers: four long straight lines, each fitted from a few hundred sub-pixel
samples, are more precise than marker corners, need no decoder, and survive the
object covering part of any side. Identity comes from geometry instead of
codes. The frame's aspect ratio names the layout, and the paper's aspect ratio
names the stock.

### The sheet

Distances are from the paper edge, in millimetres, portrait.

| Zone | Letter (215.9 × 279.4) | A4 (210 × 297) |
|---|---|---|
| Blank: hardware margin, and clean paper for edge finding | 0 to 10 | 0 to 10 |
| Frame line, 2 mm, black, closed | 10 to 12; centreline rectangle 193.9 × 257.4 | 10 to 12; centreline rectangle 188 × 275 |
| Quiet gap, left, right and top | 12 to 14 | 12 to 14 |
| Ruler and label strip, bottom only | 12 to 30 | 12 to 30 |
| Clean window for the object | 187.9 × 235.4 | 182 × 253 |

The window is about a quarter smaller than a plain Letter sheet's usable area
(211.9 × 275.4 after today's 2 mm margin). That is the price of the frame, and
it is open question 2.

The frame is the first ink inward from every edge, which is what lets the
detector find it without codes. The label ("2.5D calibration sheet, US Letter,
layout v1. Print at Actual size. The app checks the scale either way.") and the
ruler sit inside the frame for that reason. The ruler is a 150 mm bar with 1, 5
and 10 mm ticks, standing at least 1 mm off the frame line so it cannot pull
the line's fitted centre. Its strip also makes the sheet asymmetric, which is
how the detector tells the bottom from the top.

### Recognition

Recognition starts from rough corners, from `detectPaperCorners` or from a
person's drag, and gives up quietly when there is no frame.

1. Map perpendicular profiles through the rough homography into the source
   photo, about one per millimetre along each side, each running from 5 mm
   outside the rough paper edge to 35 mm inside it. The 35 mm covers a
   94 percent print anchored at one corner, whose far frame lines move up to
   16 mm inward, plus 5 mm of rough-corner error.
2. On each profile find the paper edge (the brightness step) if there is one,
   then the **first** dark dip inward. Accept a dip whose width is 2 mm times a
   plausible print scale, within 40 percent.
3. Locate each crossing at sub-pixel precision in the source image, never in a
   resampled one.
4. The sheet is recognised when all four sides have dips on at least 30 percent
   of their profiles, each side's dips fit a line, and the four lines rectify
   to the aspect of a known layout within 1 percent. Graph paper fails on dip
   width, a printed page of text fails on the lines, and a plain sheet finds
   nothing.

### The fit: shape from the frame, scale from the paper

The two features are good at different things. The printed line is crisp and
printed straight, so it is trusted for the eight sensitive numbers of a
homography. The paper edge is softer, but a whole edge is plenty to pin down a
handful of robust numbers.

1. **Frame lines.** Take each dip's centre, not its edges: ink spread and
   optical blur widen a line symmetrically and leave its centre where it was.
   Fit one line per side to the centres, robustly, after undistorting with the
   current lens estimate.
2. **Lens.** Fit the radial term to the straightness of the four frame lines
   together with the four paper edges, reusing the golden-section search in
   `estimateDistortion`. Iterate with step 1 until the lines stop moving.
3. **Homography.** The four frame corners, from the line intersections, map to
   the layout's design coordinates through the existing `computeHomography`.
   Four precisely fitted lines determine it exactly. The redundancy comes next.
4. **The paper, in design coordinates.** Map the paper-edge samples through
   that homography and fit a rectangle with five parameters: scale across,
   scale down, rotation, and the two offsets. Those are the print scale, the
   feed skew and the registration offset.
5. **Fit figure.** Four paper edges carry eight numbers and the rectangle uses
   five, so three are left over as a check. The residual of the paper edges
   from the fitted rectangle, in true millimetres, combined with the frame
   lines' scatter, is the accuracy figure of criterion 5. A bent sheet and an
   uncorrected lens both show up in it.

### The verdict

The frame's aspect names the layout. The paper's aspect, measured in design
coordinates, names the stock, because an isotropic print scale leaves aspect
untouched: Letter is 0.7727, A4 0.7071. The print scale is then the stock's
known width and height over their measured values, per axis.

Within ±0.5 percent on both axes the verdict is "Printed at 1:1". The band is
that wide because a true 1:1 print on a sheet cut 0.3 percent large reads
0.3 percent off, and a verdict that calls good prints bad gets ignored. Outside
it the verdict reads "Printed at 96.2 percent across and 96.3 percent down,
corrected for", with a note that Fit to page was probably on and that nothing
needs reprinting. A stock that disagrees with the selected paper size says so,
and the measured stock is used.

### What the fit produces: four corners and a lens coefficient

The final mapping, from the paper's true millimetres to source pixels, is a
homography, and a homography is fixed by four point pairs. So the fit's whole
output is the four paper corners, placed through that mapping and re-distorted
into photo coordinates, plus `k1`. They go into `state.corners` and
`state.lens`, and `rectify`, the save format, the queue, undo and every step
after Step 1 run unchanged. The only new downstream behaviour is the mask
below. The handles move to the fitted corners, so the overlay outlines the
sheet the app found.

Dragging a handle re-runs recognition from the new corners, which is exactly
how the white-desk case gets started. A checkbox turns the sheet fit off for
anyone who wants their own corners to rule.

### Segmentation: the window is printed, so the mask follows the frame

The window sits at a printed offset from the frame, while the paper edge sits
wherever the printer's registration put it. So the masked band is defined from
the frame and carried into sheet coordinates through the fitted rectangle, not
measured from the paper edge. It replaces the uniform 2 mm margin with
per-side insets (`js/main.js:1869`). The paper colour for `computeDiffMap` is
sampled just inside the window's rim, where there is never ink. A trace within
1 mm of the window edge gets a warning that the object may run into the band.

If the bottom strip cannot be told from the top, both short sides are masked
at the deeper inset, and the note says so.

### When the paper edges cannot be seen

On a white desk the paper edge has no contrast, but the frame still does. The
fit then takes design coordinates as true, which assumes a 1:1 print, and
places the paper nominally around the frame. The verdict reads "Print scale
unverified: the paper's edges are not visible against this surface", unless a
ruler verification is on record, in which case it uses that and says so.

### Printing it

"Print a calibration sheet" in the Step 1 paper panel opens a page carrying
the sheet as SVG in real millimetres, with `@page` set to the stock size and
zero margin, plus a Download SVG. Browsers and PDF viewers both default to
shrinking things onto the page, and the sheet exists so that nobody has to get
that dialog right. A static PDF of each layout, generated by the suite's own
Chromium at development time and committed to `docs/`, is open question 3.

### Verifying a print once (plan step 6)

For the case where the paper cannot be trusted or cannot be seen, the frame is
itself a ruler: its outside edges are 195.9 × 259.4 mm apart on Letter at
100 percent. Measure both with a steel rule, type them in, and that print's
scale is known on both axes, feed direction included, which is the direction
printers most often get wrong. A steel rule reads to about 0.25 mm over
200 mm, roughly 0.1 percent: modestly better than Letter stock's cut
tolerance, and much better than nothing on a white desk.

### The accuracy floor

With the sheet, the paper plane's shape comes from the frame and its absolute
scale from the paper. The scale then carries the paper's cut tolerance, about
±0.8 mm on Letter's 279.4 mm and up to ±2 mm on A4 under ISO 216. Sheets
within one ream are near-identical, so it is a fixed error per ream rather than
noise that averages away. A shadow along one edge biases that edge's position
by a tenth of a millimetre or two. Plan step 6 gets under the paper tolerance.
Nothing in this document gets under parallax.

## Plan

Each step is one commit, `node test/e2e.mjs` green, with the suite's printed
total quoted in the message.

1. **Edge-fitted corners for plain paper.** A new `js/edgeFit.js`:
   full-resolution sub-pixel profiles along the middle of each edge, 15 mm
   clear of the corners, a robust line per edge, corners by intersection,
   converted back to photo coordinates through the lens model. Accepted only
   when every edge fits well and the corners stay close to the coarse ones;
   otherwise the coarse corners stand. The existing corner check tightens from
   10 px toward criterion 8. New photos get better corners and saved projects
   keep theirs. **Checkpoint:** the before and after numbers, plus a few real
   photos from Sam, because this step alone may deliver much of what the sheet
   promises for shape, and that should be known before the sheet is built.
2. **The layout module and the print page.** `js/calibSheet.js`: the layout
   constants for Letter and A4, the SVG generator, the print page and its
   button. Test: the generated SVG's frame and window match the constants the
   detector reads.
3. **Recognition and the frame fit.** Profiles, dips, line fits, lens,
   homography. Tests: synthetic sheets at 1:1, with blur, with radial
   distortion, and from corners placed 5 mm off.
4. **The paper measurement and the verdict.** The five-parameter rectangle,
   stock identification, the fit figure, the final four corners, the Step 1
   panel. Tests: 100 percent, 96 percent centred, 94 percent anchored with
   offset and skew, Letter on A4, a bent sheet, a white desk. **Checkpoint:**
   real photos from Sam of printed sheets, at least one printed with Fit to
   page on.
5. **Segmentation and integration.** The frame-relative mask, the window-edge
   warning, recognition on every load including the queue, the checkbox, and
   an additive `sheet` block in projects. Tests: a traced object at 96 percent
   measures true, a frame side partly covered still fits, a side fully covered
   falls back with its sentence, and an old project loads unchanged.
6. **Ruler verification.** The two-number entry, its storage and its use. The
   step to drop if the session runs short.
7. **README** and this PRD's status line.

Steps 1 and 2 are independent of each other. Step 3 needs both. Everything
after runs in order.

## Open questions (recommendation first)

1. **Frame only, or frame plus coded markers?** Recommendation: frame only.
   Markers buy partial visibility and tiling across several sheets. Neither is
   asked for, and both cost a decoder and a dictionary that a frame never
   needs.
2. **Is a quarter less window worth it?** Recommendation: yes. Anything bigger
   than 187.9 × 235.4 mm goes on a plain sheet or graph paper, both of which
   keep working. The only way to win the area back is a thinner band, which
   costs profile length and robustness to scaled prints.
3. **Print page, static PDF, or both?** Recommendation: both. The in-app page
   is the source of truth, and the committed PDFs are for printing without
   opening the app. Neither route needs the print dialog set right.
4. **Apply the lens fit automatically in sheet mode?** Recommendation: yes,
   with the slider as override. The Auto button asks for a click today because
   paper-edge estimates deserve a human look. Estimates from a printed line do
   not.
5. **Should a dragged corner re-fit, or override?** Recommendation: re-fit and
   snap, with one checkbox to turn the sheet fit off. The white-desk case needs
   a rough drag to start the fit, and someone who wants manual control gets it
   in one explicit place instead of by accident.
6. **Store a ruler verification per browser or per project?** Recommendation:
   per browser, keyed by layout, and copied into every project that used it.
   It describes a physical print on a desk, not a project.
7. **Accept a sheet printed above 100 percent?** Recommendation: yes, when all
   four frame sides printed. A side lost to the printer's margin falls back
   exactly like a covered one.
8. **Edge-fitted corners on by default for plain paper?** Recommendation: yes,
   behind the acceptance guard. It is strictly more information than the coarse
   detector uses, and saved projects keep their corners.

## Decision needed

Sign-off on the scope and the plan. Questions 1, 2 and 3 change what gets
built, and question 6 changes what persists. The rest are defaults.

## CHANGELOG

- v1.0 (2026-09-27): Initial draft, from Sam's 2026-09-27 questions on a
  printable fiducial that works whether or not the print scale can be trusted.
