// The browser side of the real-photo test set (Part A step 2 of
// docs/calibration_and_backlog_prd_v1.2.md): what test/mark-photo.html needs
// to turn a phone photo into a fixture, and what test/e2e.mjs uses to build
// the synthetic photo its self-test feeds through the same path.
//
// A fixture photo is the phone's JPEG downscaled to about 2400 px on the long
// side and re-encoded with a fresh EXIF block that carries the focal length
// and the new pixel size, and nothing else. Location, timestamps, the
// camera's serial number and the maker notes are not copied; they are simply
// never written. The focal length survives a uniform downscale because the
// 35 mm-equivalent figure is relative to the image diagonal, so it stays true
// as long as the pixel-dimension tags say the new size (js/exif.js checks).

import { readFocalLength, focalPixels } from '../js/exif.js';

export const DEFAULT_LONG_SIDE = 2400;
export const DEFAULT_QUALITY = 0.9;

// Decode a File or Blob to an Image. The browser applies the EXIF orientation
// while decoding, so what comes back is upright, which is also what the app
// sees when it loads the same file.
export function decodeImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('could not decode the image')); };
    img.src = url;
  });
}

// The camera's focal length from the original file, trusted only when the
// decoded image is still the size the camera wrote (an edited or cropped
// photo keeps its tags but not their meaning). Returns { f35, focalMm, w, h,
// trusted } or null when the file carries no focal length.
export async function readPhotoFocal(blob, img) {
  const buf = await blob.slice(0, 262144).arrayBuffer();
  const focal = readFocalLength(buf);
  if (!focal) return null;
  const trusted = focalPixels(focal, img.naturalWidth, img.naturalHeight) != null;
  return { ...focal, trusted };
}

// Draw the image onto a canvas no longer than maxLong on its long side.
export function downscale(img, maxLong = DEFAULT_LONG_SIDE) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const s = Math.min(1, maxLong / Math.max(iw, ih));
  const c = document.createElement('canvas');
  c.width = Math.round(iw * s); c.height = Math.round(ih * s);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

// A minimal EXIF APP1 segment: one IFD0 entry pointing at an Exif IFD that
// holds FocalLength (rational, mm), PixelXDimension, PixelYDimension and
// FocalLengthIn35mmFilm. Any field left null is left out. Little-endian TIFF,
// tags in ascending order as the standard requires. Returns the whole
// segment, marker and length included, ready to splice in after SOI.
export function exifSegment({ f35 = null, focalMm = null, w = null, h = null } = {}) {
  const entries = [];
  const rational = focalMm > 0 ? ratio(focalMm) : null;
  if (rational) entries.push({ tag: 0x920a, type: 5, count: 1, data: rational });
  if (w > 0) entries.push({ tag: 0xa002, type: 4, count: 1, value: Math.round(w) });
  if (h > 0) entries.push({ tag: 0xa003, type: 4, count: 1, value: Math.round(h) });
  if (f35 > 0) entries.push({ tag: 0xa405, type: 3, count: 1, value: Math.round(f35) });
  entries.sort((a, b) => a.tag - b.tag);

  const ifd0At = 8;
  const exifAt = ifd0At + 2 + 12 + 4;
  const dataAt = exifAt + 2 + 12 * entries.length + 4;
  const dataLen = entries.reduce((n, e) => n + (e.data ? 8 : 0), 0);
  const tiff = new DataView(new ArrayBuffer(dataAt + dataLen));
  tiff.setUint8(0, 0x49); tiff.setUint8(1, 0x49);
  tiff.setUint16(2, 42, true); tiff.setUint32(4, ifd0At, true);
  tiff.setUint16(ifd0At, 1, true);
  tiff.setUint16(ifd0At + 2, 0x8769, true); tiff.setUint16(ifd0At + 4, 4, true);
  tiff.setUint32(ifd0At + 6, 1, true); tiff.setUint32(ifd0At + 10, exifAt, true);
  tiff.setUint32(ifd0At + 14, 0, true);
  tiff.setUint16(exifAt, entries.length, true);
  let dp = dataAt;
  entries.forEach((e, i) => {
    const at = exifAt + 2 + 12 * i;
    tiff.setUint16(at, e.tag, true); tiff.setUint16(at + 2, e.type, true);
    tiff.setUint32(at + 4, e.count, true);
    if (e.data) {
      tiff.setUint32(at + 8, dp, true);
      tiff.setUint32(dp, e.data[0], true); tiff.setUint32(dp + 4, e.data[1], true);
      dp += 8;
    } else if (e.type === 3) {
      tiff.setUint16(at + 8, e.value, true); tiff.setUint16(at + 10, 0, true);
    } else {
      tiff.setUint32(at + 8, e.value, true);
    }
  });
  tiff.setUint32(exifAt + 2 + 12 * entries.length, 0, true);

  const seg = new Uint8Array(2 + 2 + 6 + tiff.byteLength);
  const sv = new DataView(seg.buffer);
  sv.setUint16(0, 0xffe1);
  sv.setUint16(2, 2 + 6 + tiff.byteLength);
  seg.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4);
  seg.set(new Uint8Array(tiff.buffer), 10);
  return seg;
}

function ratio(x) {
  const den = 1000;
  return [Math.round(x * den), den];
}

// Splice an APP1 segment in right after the SOI marker of a JPEG.
export function spliceExif(jpeg, seg) {
  if (jpeg.length < 2 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('not a JPEG');
  const out = new Uint8Array(jpeg.length + seg.length);
  out.set(jpeg.subarray(0, 2), 0);
  out.set(seg, 2);
  out.set(jpeg.subarray(2), 2 + seg.length);
  return out;
}

// A canvas to the fixture's JPEG bytes, with the focal length written back
// against the canvas's own pixel size. focal is what readPhotoFocal returned,
// or null; an untrusted focal length is dropped rather than copied, since the
// app would only distrust it again.
export async function encodeFixture(canvas, focal, quality = DEFAULT_QUALITY) {
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', quality));
  const jpeg = new Uint8Array(await blob.arrayBuffer());
  const keep = focal && focal.trusted !== false && (focal.f35 > 0 || focal.focalMm > 0);
  if (!keep) return jpeg;
  return spliceExif(jpeg, exifSegment({
    f35: focal.f35, focalMm: focal.focalMm, w: canvas.width, h: canvas.height,
  }));
}

// The sidecar the suite reads (test/realPhotos.mjs validates it). Points are
// in rectify's pixel convention, where pixel k's value sits at coordinate k:
// a click at the centre of pixel k lands at k + 0.5 in canvas coordinates, so
// the page subtracts the half pixel before storing.
export function makeSidecar({ paper, customW, customH, rule, corners, note, source }) {
  const sc = {
    paper,
    rule: { a: pt(rule.a), b: pt(rule.b), mm: Number(rule.mm) },
    corners: corners && corners.length === 4 ? corners.map(pt) : null,
    note: note || '',
    source: source || null,
  };
  if (paper === 'custom') { sc.customW = Number(customW); sc.customH = Number(customH); }
  return sc;
}

function pt(p) {
  return { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 };
}
