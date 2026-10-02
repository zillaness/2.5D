# Real photos: the test set

Photos of a sheet of paper with a steel rule lying on it, measured by the
suite on every run. Each `name.jpg` has a `name.json` beside it naming two
graduations on the rule, marked once by hand, and the true distance between
them. `baselines.json` records each photo's error when it was added; a later
change that makes any photo worse fails `npm test`.

## Adding a photo

1. Take the photo as you would for the app: the whole sheet in frame, a steel
   rule lying flat on it, from roughly above.
2. Open `test/mark-photo.html` from a local server (`npm run serve`, then
   `/test/mark-photo.html`) and choose the photo. It is downscaled to about
   2400 px on the long side and re-encoded with only the focal length kept
   from the camera's EXIF: location, timestamps and the camera's serial
   number are not written.
3. Click two graduations as far apart as the rule allows, with the loupe, and
   type their distance. Pick the paper size. If the sheet is on a pale desk
   the app may not find it on its own; mark the four corners too.
4. Download both files into this folder and run `npm test`. The first run
   records the baseline; commit all three.

`node test/real-photos.mjs` prints a line per photo; `--record` rewrites every
baseline, for after a change that made the numbers better.

## The sidecar

```json
{
  "paper": "A4",
  "rule": { "a": { "x": 412.5, "y": 1180.25 }, "b": { "x": 1930, "y": 1162.5 }, "mm": 200 },
  "corners": null,
  "note": "plain copier paper, oak desk, window light",
  "source": { "f35": 26, "focalMm": 5.7, "width": 4032, "height": 3024 }
}
```

`paper` is a key of `PAPER_SIZES` in `js/paperSizes.js` (`custom` needs
`customW` and `customH` in mm). Points are in the downscaled photo's pixels,
in `rectify`'s convention: pixel k's value sits at coordinate k. `corners`
is `null` or four points, TL TR BR BL, used as a person's dragged corners
would be. `source` is a note on the original and is not read.

## What the figure means

The error is the app's geometric error plus the error of the two hand marks.
At 8 px/mm a mark a pixel off is 0.12 mm, so the figures are a ceiling on the
app's own error, not a measurement of it. What matters is that they never
rise. The suite also reports what the lens fit would make of each photo, and
whether the wrong-paper check fired, without asserting either.
