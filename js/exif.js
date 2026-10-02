// The camera's focal length from a JPEG's EXIF block, and nothing else.
//
// One photo of a flat rectangle cannot always say how long the lens was: tip
// the phone forward about one axis and one pair of the sheet's edges stays
// parallel, which leaves the focal length, and with it the sheet's true
// proportions, undetermined. Phones write the focal length into the file, so
// this reads exactly those two tags and stops. GPS, timestamps and the camera's
// serial number are never read, never stored, and never leave the browser;
// project saves re-encode the photo through a canvas, which drops EXIF anyway.
//
// Returns { f35, focalMm, w, h } (any may be null) or null when the file has no
// readable EXIF. f35 is the 35 mm-equivalent focal length, which converts to
// pixels through the image diagonal: f_px = f35 / 43.27 * diagonal_px.

const TAG_EXIF_IFD = 0x8769;
const TAG_FOCAL = 0x920a;      // RATIONAL, millimetres
const TAG_FOCAL_35 = 0xa405;   // SHORT, millimetres, 35 mm equivalent
const TAG_PIXEL_W = 0xa002;    // SHORT or LONG
const TAG_PIXEL_H = 0xa003;

export const FILM_DIAGONAL_MM = Math.hypot(36, 24);

export function readFocalLength(buffer) {
  try {
    const v = new DataView(buffer);
    if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null;
    let p = 2;
    while (p + 4 <= v.byteLength) {
      if (v.getUint8(p) !== 0xff) return null;
      const marker = v.getUint8(p + 1);
      if (marker === 0xda || marker === 0xd9) return null;   // image data: no EXIF before it
      const len = v.getUint16(p + 2);
      if (marker === 0xe1 && p + 10 <= v.byteLength &&
          v.getUint32(p + 4) === 0x45786966 && v.getUint16(p + 8) === 0) {  // "Exif\0\0"
        return readTiff(v, p + 10, Math.min(v.byteLength, p + 2 + len));
      }
      p += 2 + len;
    }
  } catch { /* a truncated or odd file has no usable focal length */ }
  return null;
}

function readTiff(v, base, end) {
  const order = v.getUint16(base);
  const le = order === 0x4949;
  if (!le && order !== 0x4d4d) return null;
  const u16 = o => v.getUint16(base + o, le);
  const u32 = o => v.getUint32(base + o, le);
  if (u16(2) !== 42) return null;
  const entries = ifd => {
    const out = new Map();
    if (base + ifd + 2 > end) return out;
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (base + e + 12 > end) break;
      out.set(u16(e), { type: u16(e + 2), count: u32(e + 4), at: e + 8 });
    }
    return out;
  };
  const ifd0 = entries(u32(4));
  const ptr = ifd0.get(TAG_EXIF_IFD);
  if (!ptr) return null;
  const exif = entries(u32(ptr.at));
  let f35 = null, focalMm = null;
  const t35 = exif.get(TAG_FOCAL_35);
  if (t35 && t35.type === 3) f35 = u16(t35.at) || null;
  const tf = exif.get(TAG_FOCAL);
  if (tf && tf.type === 5) {
    const off = u32(tf.at);
    if (base + off + 8 <= end) {
      const num = u32(off), den = u32(off + 4);
      if (den) focalMm = num / den;
    }
  }
  const dim = tag => {
    const t = exif.get(tag);
    if (!t) return null;
    return t.type === 3 ? u16(t.at) : t.type === 4 ? u32(t.at) : null;
  };
  if (!f35 && !focalMm) return null;
  return { f35, focalMm, w: dim(TAG_PIXEL_W), h: dim(TAG_PIXEL_H) };
}

// Focal length in pixels for an image of the given size, or null. Only for a
// photo still the size the camera wrote: a crop moves the principal point and
// a resize changes the diagonal the 35 mm figure is relative to, and neither
// can be undone from the tags alone, so either makes the number untrustworthy.
export function focalPixels(focal, imgW, imgH) {
  if (!focal || !(focal.f35 > 0)) return null;
  if (focal.w > 0 && focal.h > 0) {
    const same = (a, b) => Math.abs(a - b) <= 2;
    const fits = (same(focal.w, imgW) && same(focal.h, imgH)) || (same(focal.w, imgH) && same(focal.h, imgW));
    if (!fits) return null;
  }
  return (focal.f35 / FILM_DIAGONAL_MM) * Math.hypot(imgW, imgH);
}
