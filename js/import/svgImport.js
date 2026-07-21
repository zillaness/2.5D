// SVG → flattened polylines, using the browser's DOMParser.
//
// Walks the element tree accumulating transforms, flattens path/line/polyline/
// polygon/rect/circle/ellipse into polylines in user units, and derives a
// user-unit→mm scale from width/height vs viewBox. Fill presence is recorded
// so obviously-solid shapes can be preferred. SVG y is down, matching the
// app's trace space, so no flip is needed here.

const CSS_MM = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, q: 0.25 };
const CURVE_STEPS = 24;

function lenToMm(v) {
  if (v == null) return null;
  const m = String(v).trim().match(/^(-?[\d.]+)\s*([a-z%]*)$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = (m[2] || 'px').toLowerCase();
  if (unit === '%' || !(unit in CSS_MM)) return null;
  return n * CSS_MM[unit];
}

// 2x3 affine [a,b,c,d,e,f]: x' = a·x + c·y + e, y' = b·x + d·y + f.
const IDENT = [1, 0, 0, 1, 0, 0];
function mul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
function apply(m, x, y) { return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }; }

function parseTransform(str) {
  let m = IDENT;
  const re = /(\w+)\s*\(([^)]*)\)/g;
  let g;
  while ((g = re.exec(str))) {
    const a = g[2].trim().split(/[\s,]+/).map(Number);
    switch (g[1]) {
      case 'matrix': if (a.length === 6) m = mul(m, a); break;
      case 'translate': m = mul(m, [1, 0, 0, 1, a[0] || 0, a[1] || 0]); break;
      case 'scale': m = mul(m, [a[0] || 1, 0, 0, a.length > 1 ? a[1] : a[0], 0, 0]); break;
      case 'rotate': {
        const r = (a[0] || 0) * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
        if (a.length >= 3) {
          m = mul(m, [1, 0, 0, 1, a[1], a[2]]);
          m = mul(m, [c, s, -s, c, 0, 0]);
          m = mul(m, [1, 0, 0, 1, -a[1], -a[2]]);
        } else m = mul(m, [c, s, -s, c, 0, 0]);
        break;
      }
      case 'skewX': m = mul(m, [1, 0, Math.tan((a[0] || 0) * Math.PI / 180), 1, 0, 0]); break;
      case 'skewY': m = mul(m, [1, Math.tan((a[0] || 0) * Math.PI / 180), 0, 1, 0, 0]); break;
    }
  }
  return m;
}

function cubic(p0, p1, p2, p3, out) {
  for (let i = 1; i <= CURVE_STEPS; i++) {
    const t = i / CURVE_STEPS, u = 1 - t;
    out.push({
      x: u*u*u*p0.x + 3*u*u*t*p1.x + 3*u*t*t*p2.x + t*t*t*p3.x,
      y: u*u*u*p0.y + 3*u*u*t*p1.y + 3*u*t*t*p2.y + t*t*t*p3.y,
    });
  }
}
function quad(p0, p1, p2, out) {
  for (let i = 1; i <= CURVE_STEPS; i++) {
    const t = i / CURVE_STEPS, u = 1 - t;
    out.push({ x: u*u*p0.x + 2*u*t*p1.x + t*t*p2.x, y: u*u*p0.y + 2*u*t*p1.y + t*t*p2.y });
  }
}

// SVG elliptical arc (endpoint form) → polyline points appended to `out`.
function svgArc(p0, rx, ry, xRotDeg, large, sweep, p1, out) {
  if (rx === 0 || ry === 0) { out.push(p1); return; }
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = xRotDeg * Math.PI / 180, cosP = Math.cos(phi), sinP = Math.sin(phi);
  const dx = (p0.x - p1.x) / 2, dy = (p0.y - p1.y) / 2;
  const x1p = cosP * dx + sinP * dy, y1p = -sinP * dx + cosP * dy;
  let lam = (x1p*x1p)/(rx*rx) + (y1p*y1p)/(ry*ry);
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
  const sign = large === sweep ? -1 : 1;
  let num = rx*rx*ry*ry - rx*rx*y1p*y1p - ry*ry*x1p*x1p;
  num = Math.max(0, num);
  const co = sign * Math.sqrt(num / (rx*rx*y1p*y1p + ry*ry*x1p*x1p) || 0);
  const cxp = co * rx * y1p / ry, cyp = -co * ry * x1p / rx;
  const cx = cosP * cxp - sinP * cyp + (p0.x + p1.x) / 2;
  const cy = sinP * cxp + cosP * cyp + (p0.y + p1.y) / 2;
  const ang = (ux, uy, vx, vy) => {
    const d = Math.sqrt((ux*ux+uy*uy)*(vx*vx+vy*vy));
    let a = Math.acos(Math.max(-1, Math.min(1, (ux*vx+uy*vy)/d)));
    if (ux*vy - uy*vx < 0) a = -a;
    return a;
  };
  let th0 = ang(1, 0, (x1p-cxp)/rx, (y1p-cyp)/ry);
  let dth = ang((x1p-cxp)/rx, (y1p-cyp)/ry, (-x1p-cxp)/rx, (-y1p-cyp)/ry);
  if (!sweep && dth > 0) dth -= 2*Math.PI;
  if (sweep && dth < 0) dth += 2*Math.PI;
  const n = Math.max(2, Math.ceil(Math.abs(dth) / (Math.PI/24)));
  for (let i = 1; i <= n; i++) {
    const th = th0 + dth * (i/n);
    const x = cosP*rx*Math.cos(th) - sinP*ry*Math.sin(th) + cx;
    const y = sinP*rx*Math.cos(th) + cosP*ry*Math.sin(th) + cy;
    out.push({ x, y });
  }
}

// Flatten a path `d` into subpaths: [{ pts, closed }].
function flattenPath(d) {
  const toks = d.match(/[a-zA-Z]|-?\.?\d[\d.eE+-]*/g) || [];
  let i = 0;
  const subs = [];
  let cur = null, start = null, pos = { x: 0, y: 0 }, prevC = null, prevQ = null, cmd = '';
  const nnum = () => parseFloat(toks[i++]);
  const startSub = () => { cur = { pts: [], closed: false }; subs.push(cur); };
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const rx = v => rel ? pos.x + v : v, ry = v => rel ? pos.y + v : v;
    if (C === 'M') {
      pos = { x: rx(nnum()), y: ry(nnum()) };
      startSub(); start = { ...pos }; cur.pts.push({ ...pos });
      cmd = rel ? 'l' : 'L';
      prevC = prevQ = null;
      continue;
    }
    if (!cur) startSub();
    switch (C) {
      case 'L': pos = { x: rx(nnum()), y: ry(nnum()) }; cur.pts.push({ ...pos }); prevC = prevQ = null; break;
      case 'H': pos = { x: rel ? pos.x + nnum() : nnum(), y: pos.y }; cur.pts.push({ ...pos }); prevC = prevQ = null; break;
      case 'V': pos = { x: pos.x, y: rel ? pos.y + nnum() : nnum() }; cur.pts.push({ ...pos }); prevC = prevQ = null; break;
      case 'C': {
        const p1 = { x: rx(nnum()), y: ry(nnum()) }, p2 = { x: rx(nnum()), y: ry(nnum()) }, p3 = { x: rx(nnum()), y: ry(nnum()) };
        cubic(pos, p1, p2, p3, cur.pts); prevC = p2; prevQ = null; pos = p3; break;
      }
      case 'S': {
        const p1 = prevC ? { x: 2*pos.x - prevC.x, y: 2*pos.y - prevC.y } : { ...pos };
        const p2 = { x: rx(nnum()), y: ry(nnum()) }, p3 = { x: rx(nnum()), y: ry(nnum()) };
        cubic(pos, p1, p2, p3, cur.pts); prevC = p2; prevQ = null; pos = p3; break;
      }
      case 'Q': {
        const p1 = { x: rx(nnum()), y: ry(nnum()) }, p2 = { x: rx(nnum()), y: ry(nnum()) };
        quad(pos, p1, p2, cur.pts); prevQ = p1; prevC = null; pos = p2; break;
      }
      case 'T': {
        const p1 = prevQ ? { x: 2*pos.x - prevQ.x, y: 2*pos.y - prevQ.y } : { ...pos };
        const p2 = { x: rx(nnum()), y: ry(nnum()) };
        quad(pos, p1, p2, cur.pts); prevQ = p1; prevC = null; pos = p2; break;
      }
      case 'A': {
        const rxx = nnum(), ryy = nnum(), rot = nnum(), large = nnum(), sweep = nnum();
        const p1 = { x: rx(nnum()), y: ry(nnum()) };
        svgArc(pos, rxx, ryy, rot, large, sweep, p1, cur.pts); pos = p1; prevC = prevQ = null; break;
      }
      case 'Z': cur.closed = true; if (start) pos = { ...start }; prevC = prevQ = null; break;
      default: i++; // skip unknown token
    }
  }
  return subs.filter(s => s.pts.length >= 2);
}

function num(el, attr, dflt = 0) {
  const v = parseFloat(el.getAttribute(attr));
  return Number.isFinite(v) ? v : dflt;
}

export function parseSVG(text) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = doc.querySelector('svg');
  const warnings = [];
  if (!svg || doc.querySelector('parsererror')) {
    return { polylines: [], unitScale: 1, unitName: 'unitless', unitsKnown: false, layers: new Set(), warnings: ['Could not parse SVG.'] };
  }

  // Unit scale: real width (mm) / viewBox width. Fall back to unknown.
  const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  let unitScale = 1, unitName = 'unitless', unitsKnown = false;
  const wMm = lenToMm(svg.getAttribute('width'));
  if (vb.length === 4 && vb[2] > 0 && wMm && !/px$/.test(svg.getAttribute('width') || '')) {
    unitScale = wMm / vb[2]; unitName = 'mm'; unitsKnown = true;
  } else if (wMm && /px$|^\d+$/.test((svg.getAttribute('width') || '').trim()) === false && wMm) {
    unitScale = 1;
  }

  const polylines = [];
  const layers = new Set();
  const walk = (el, m) => {
    const t = el.getAttribute && el.getAttribute('transform');
    const cm = t ? mul(m, parseTransform(t)) : m;
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    const layer = (el.getAttribute && (el.getAttribute('id') || el.parentNode?.getAttribute?.('id'))) || '0';
    const filled = el.getAttribute && el.getAttribute('fill') && el.getAttribute('fill') !== 'none';
    const add = (pts, closed) => {
      if (pts.length < 2) return;
      layers.add(layer);
      polylines.push({ pts: pts.map(p => apply(cm, p.x, p.y)), closed, layer, linetype: '', filled: !!filled });
    };
    switch (tag) {
      case 'line': add([{ x: num(el, 'x1'), y: num(el, 'y1') }, { x: num(el, 'x2'), y: num(el, 'y2') }], false); break;
      case 'polyline':
      case 'polygon': {
        const nums = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number);
        const pts = [];
        for (let k = 0; k + 1 < nums.length; k += 2) pts.push({ x: nums[k], y: nums[k + 1] });
        add(pts, tag === 'polygon');
        break;
      }
      case 'rect': {
        const x = num(el, 'x'), y = num(el, 'y'), w = num(el, 'width'), h = num(el, 'height');
        if (w > 0 && h > 0) add([{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }], true);
        break;
      }
      case 'circle': {
        const cx = num(el, 'cx'), cy = num(el, 'cy'), r = num(el, 'r');
        if (r > 0) { const pts = []; for (let k = 0; k <= 48; k++) { const a = k/48*Math.PI*2; pts.push({ x: cx + r*Math.cos(a), y: cy + r*Math.sin(a) }); } add(pts, true); }
        break;
      }
      case 'ellipse': {
        const cx = num(el, 'cx'), cy = num(el, 'cy'), rx = num(el, 'rx'), ry = num(el, 'ry');
        if (rx > 0 && ry > 0) { const pts = []; for (let k = 0; k <= 64; k++) { const a = k/64*Math.PI*2; pts.push({ x: cx + rx*Math.cos(a), y: cy + ry*Math.sin(a) }); } add(pts, true); }
        break;
      }
      case 'path': {
        for (const s of flattenPath(el.getAttribute('d') || '')) add(s.pts, s.closed);
        break;
      }
    }
    for (const child of (el.children || [])) walk(child, cm);
  };
  walk(svg, IDENT);

  return { polylines, unitScale, unitName, unitsKnown, layers, warnings };
}
