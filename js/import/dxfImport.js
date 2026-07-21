// Minimal ASCII DXF (AutoCAD R12+) reader → flattened polylines.
//
// DXF is a flat stream of (groupCode, value) pairs. We walk the ENTITIES
// section, turn each drawable entity into a polyline in drawing units, and
// tag it with its layer and linetype so annotation layers / centrelines can be
// filtered out. Arcs, circles and ellipses are flattened; splines are
// approximated through their fit/control points. Text, dimensions, hatching
// and other non-geometry entities are ignored. Units come from $INSUNITS.

const INSUNITS = { 0: [1, 'unitless', false], 1: [25.4, 'in', true], 2: [304.8, 'ft', true],
  4: [1, 'mm', true], 5: [10, 'cm', true], 6: [1000, 'm', true], 8: [0.0254, 'µm', true] };

const ARC_STEP = Math.PI / 24; // 7.5° flattening step

function flattenArc(cx, cy, r, a0, a1) {
  // a0,a1 in radians, sweep CCW from a0 to a1 (a1 already normalized > a0).
  const sweep = a1 - a0;
  const n = Math.max(2, Math.ceil(Math.abs(sweep) / ARC_STEP));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + sweep * (i / n);
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

export function parseDXF(text) {
  // Tokenize into [code, value] pairs.
  const lines = text.split(/\r\n|\r|\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) { i -= 1; continue; } // resync on stray line
    pairs.push([code, lines[i + 1]]);
  }

  const warnings = [];
  const polylines = [];
  const layers = new Set();
  let unitScale = 1, unitName = 'unitless', unitsKnown = false;

  // $INSUNITS in HEADER.
  for (let i = 0; i < pairs.length - 1; i++) {
    if (pairs[i][0] === 9 && pairs[i][1].trim() === '$INSUNITS') {
      const v = parseInt(pairs[i + 1][1], 10);
      const u = INSUNITS[v];
      if (u) { [unitScale, unitName, unitsKnown] = u; }
      break;
    }
  }

  // Find ENTITIES section span.
  let start = -1, end = pairs.length;
  for (let i = 0; i < pairs.length - 1; i++) {
    if (pairs[i][0] === 0 && pairs[i][1].trim() === 'SECTION' &&
        pairs[i + 1][0] === 2 && pairs[i + 1][1].trim() === 'ENTITIES') { start = i + 2; break; }
  }
  if (start < 0) { warnings.push('No ENTITIES section found.'); return { polylines, unitScale, unitName, unitsKnown, layers, warnings }; }
  for (let i = start; i < pairs.length; i++) {
    if (pairs[i][0] === 0 && pairs[i][1].trim() === 'ENDSEC') { end = i; break; }
  }

  // Split the entities span into entity records (each starts with code 0).
  let rec = null;
  const records = [];
  for (let i = start; i < end; i++) {
    const [code, valRaw] = pairs[i];
    if (code === 0) { rec = { type: valRaw.trim(), g: [] }; records.push(rec); }
    else if (rec) rec.g.push([code, valRaw]);
  }

  const num = (rec, code, dflt = undefined) => {
    for (const [c, v] of rec.g) if (c === code) return parseFloat(v);
    return dflt;
  };
  const str = (rec, code, dflt = '') => {
    for (const [c, v] of rec.g) if (c === code) return v.trim();
    return dflt;
  };
  const push = (pts, closed, rec) => {
    if (pts.length >= 2) {
      const layer = str(rec, 8, '0');
      layers.add(layer);
      polylines.push({ pts, closed, layer, linetype: str(rec, 6, '').toUpperCase() });
    }
  };

  for (const r of records) {
    switch (r.type) {
      case 'LINE': {
        const x1 = num(r, 10), y1 = num(r, 20), x2 = num(r, 11), y2 = num(r, 21);
        if ([x1, y1, x2, y2].every(Number.isFinite)) push([{ x: x1, y: y1 }, { x: x2, y: y2 }], false, r);
        break;
      }
      case 'CIRCLE': {
        const cx = num(r, 10), cy = num(r, 20), rad = num(r, 40);
        if ([cx, cy, rad].every(Number.isFinite)) push(flattenArc(cx, cy, rad, 0, Math.PI * 2), true, r);
        break;
      }
      case 'ARC': {
        const cx = num(r, 10), cy = num(r, 20), rad = num(r, 40);
        let a0 = (num(r, 50) || 0) * Math.PI / 180, a1 = (num(r, 51) || 0) * Math.PI / 180;
        if (a1 <= a0) a1 += Math.PI * 2;
        if ([cx, cy, rad].every(Number.isFinite)) push(flattenArc(cx, cy, rad, a0, a1), false, r);
        break;
      }
      case 'LWPOLYLINE': {
        const pts = [];
        let curX = null;
        for (const [c, v] of r.g) {
          if (c === 10) curX = parseFloat(v);
          else if (c === 20 && curX !== null) { pts.push({ x: curX, y: parseFloat(v) }); curX = null; }
        }
        const closed = (num(r, 70, 0) & 1) === 1;
        push(pts, closed, r);
        break;
      }
      case 'POLYLINE': {
        // Vertices are separate VERTEX records until SEQEND — handled below.
        r._polyClosed = (num(r, 70, 0) & 1) === 1;
        r._collecting = true;
        break;
      }
      case 'VERTEX':
        break; // collected in the POLYLINE second pass below
      case 'ELLIPSE': {
        const cx = num(r, 10), cy = num(r, 20);
        const mx = num(r, 11) || 0, my = num(r, 21) || 0; // major axis endpoint (rel)
        const ratio = num(r, 40) || 1;
        let a0 = num(r, 41), a1 = num(r, 42);
        a0 = Number.isFinite(a0) ? a0 : 0; a1 = Number.isFinite(a1) ? a1 : Math.PI * 2;
        if (a1 <= a0) a1 += Math.PI * 2;
        const majLen = Math.hypot(mx, my), rot = Math.atan2(my, mx);
        if (majLen > 0) {
          const n = Math.max(8, Math.ceil((a1 - a0) / ARC_STEP));
          const pts = [];
          for (let i = 0; i <= n; i++) {
            const t = a0 + (a1 - a0) * (i / n);
            const ex = majLen * Math.cos(t), ey = majLen * ratio * Math.sin(t);
            pts.push({ x: cx + ex * Math.cos(rot) - ey * Math.sin(rot),
                       y: cy + ex * Math.sin(rot) + ey * Math.cos(rot) });
          }
          push(pts, Math.abs((a1 - a0) - Math.PI * 2) < 1e-6, r);
        }
        break;
      }
      case 'SPLINE': {
        // Approximate by connecting fit points (code 11/21), else control
        // points (10/20). Not a true NURBS eval — good enough; arc-fit can
        // re-idealize.
        const fit = [], ctrl = [];
        let fx = null, cx = null;
        for (const [c, v] of r.g) {
          if (c === 11) fx = parseFloat(v);
          else if (c === 21 && fx !== null) { fit.push({ x: fx, y: parseFloat(v) }); fx = null; }
          else if (c === 10) cx = parseFloat(v);
          else if (c === 20 && cx !== null) { ctrl.push({ x: cx, y: parseFloat(v) }); cx = null; }
        }
        const pts = fit.length >= 2 ? fit : ctrl;
        const closed = (num(r, 70, 0) & 1) === 1;
        if (pts.length >= 2) push(pts, closed, r);
        break;
      }
      default:
        break; // TEXT, MTEXT, DIMENSION, HATCH, INSERT, etc. — ignored
    }
  }

  // Second pass: old-style POLYLINE + VERTEX + SEQEND.
  for (let i = 0; i < records.length; i++) {
    if (records[i].type !== 'POLYLINE') continue;
    const closed = records[i]._polyClosed;
    const layerRec = records[i];
    const pts = [];
    let j = i + 1;
    for (; j < records.length && records[j].type === 'VERTEX'; j++) {
      const x = num(records[j], 10), y = num(records[j], 20);
      if (Number.isFinite(x) && Number.isFinite(y)) pts.push({ x, y });
    }
    push(pts, closed, layerRec);
  }

  return { polylines, unitScale, unitName, unitsKnown, layers, warnings };
}
