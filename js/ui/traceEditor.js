// Step 2 editor: show the rectified paper, overlay the traced outline and
// holes, and let the user fix the trace: drag vertices, click an edge to
// insert a vertex, alt/right-click to delete one, place and adjust circular
// holes, with undo.

import { Viewport, prepareCanvas } from './viewport.js';
import { pointInPolygon, fitCircle, resampleClosed } from '../contour.js';
import {
  REGION_LOOP_BASE, resolvePoint, resolveEdge, measureInfo, remapRefs,
  pointSegDist, angleBetweenDeg, dist as ptDist, filletArc, arcPointsN,
} from '../measure.js';
import { solveConstraints } from '../constraints.js';

const VERT_R = 4.5;
const HIT_R = 8;
// Extra sections ("regions") reuse the loop-addressing scheme: loop index
// -1 = outer outline, 0..n-1 = traced holes, REGION_LOOP_BASE + i = the
// footprint of sections[i] (i >= 1; sections[0] is the base = outer).
// (The constant lives in measure.js so refs share the addressing.)

const MEASURE_COL = '#cf8aff';
const CONSTRAIN_COL = '#9ad8ff';

export class TraceEditor {
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.cb = callbacks; // { onChange, onSelect }
    this.vp = new Viewport(canvas);

    this.rectified = null;   // canvas with rectified image
    this.maskOverlay = null; // canvas tinting segmented pixels
    this.showMask = false;
    this.pxPerMm = 4;

    this.outer = [];         // [{x,y}] mm
    this.holes = [];         // [[{x,y}]] mm (traced holes)
    this.circles = [];       // [{cx, cy, d}] mm (manual holes)
    this.sections = [];      // shared with app state; [0]=base (no pts), [i>0].pts = footprint
    this._draftRegion = null; // in-progress region polygon (mode 'region')

    this.mode = 'edit';      // 'edit' | 'addhole' | 'pan'
    this.showPoints = true;  // vertex control handles on/off
    this._placedIdx = null;  // circle being sized by a place-drag
    this._holeStart = null;
    this._newHoleSized = false;
    this._lastMm = null;     // for whole-loop dragging
    // Prototype for newly placed holes; kept in sync with the last edited one
    // so a row of identical screw holes takes one setup.
    this.holeTemplate = {
      d: 5, type: 'through', side: 'top', depth: 3,
      csAngle: 90, csDia: 9, cbDia: 9, cbDepth: 3,
      edgeTop: { mode: 'none', size: 0.5 },
      edgeBottom: { mode: 'none', size: 0.5 },
      screw: { std: 'custom', size: '', fit: 'clearance' },
    };
    this.selection = null;   // {type:'vertex', loop, idx} | {type:'circle', idx} | {type:'holeloop', loop}
    this.selectedVerts = [];  // multi-selection: [{loop, idx}] for group move/delete/fit
    // Measurement annotations + geometric constraints (refs into the trace;
    // see measure.js). Both live-update as the trace is edited.
    this.measurements = [];
    this.constraints = [];
    // First-class tangent arcs: each owns a fixed run of vertices [lo, lo+len)
    // on `loop` and re-derives them as a fillet of its two neighbouring edges
    // at radius r on every solve, so they stay tangent live. Dropped (reverting
    // to plain points) if a structural edit disturbs the run or its neighbours.
    this.arcs = [];
    // First-class straight segments: a run collapsed to its two endpoints,
    // with the removed interior points stashed so Release can restore them
    // (a reversible straighten). Each is { loop, lo, len:2, stash:[{x,y}] }.
    this.lines = [];
    this._arcSeq = 0; // stable ids so 'tangent to arc' constraints survive re-indexing
    this._reprojecting = false;
    this._pendingPick = null; // measure mode: first of a two-entity pick
    this._picks = [];         // constrain mode: up to two picked entities
    this._hoverSnap = null;   // snap marker under the cursor (measure/constrain)
    this._ghost = null;       // solved-preview geometry while dragging
    this.dragging = false;
    this.panning = false;
    this.lastPos = null;
    this.undoStack = [];
    this._circleResize = false; // true when dragging a hole's rim (resize)
    this._groupDrag = null;     // {start, orig:[{x,y}]} while moving a vertex group
    this._marquee = null;       // {x0,y0,x1,y1} screen rect while Shift-dragging

    canvas.addEventListener('pointerdown', e => this._down(e));
    canvas.addEventListener('pointermove', e => this._move(e));
    canvas.addEventListener('pointerup', e => this._up(e));
    canvas.addEventListener('pointercancel', e => this._up(e));
    canvas.addEventListener('dblclick', () => {
      if (this.mode === 'region' && this._draftRegion) {
        // The double-click's two single clicks each added a point — drop them.
        this._draftRegion.splice(-2, 2);
        this.commitDraftRegion();
        return;
      }
      this.vp.fit();
      this.draw();
    });
    canvas.addEventListener('viewportchange', () => this.draw());
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    this._pendingFit = false;
    new ResizeObserver(() => {
      // A fit requested while the canvas was hidden (0×0) runs once it has size.
      if (this._pendingFit && canvas.clientWidth > 0 && canvas.clientHeight > 0) {
        this._pendingFit = false;
        this.vp.fit();
      }
      this.draw();
    }).observe(canvas);
  }

  setRectified(rectCanvas, pxPerMm) {
    this.rectified = rectCanvas;
    this.pxPerMm = pxPerMm;
    this.vp.setContent(rectCanvas.width, rectCanvas.height);
    if (this.canvas.clientWidth > 0 && this.canvas.clientHeight > 0) this.vp.fit();
    else this._pendingFit = true;
    this.draw();
  }

  setMaskOverlay(canvas) {
    this.maskOverlay = canvas;
    this.draw();
  }

  // keepRefs: an index-preserving replacement (e.g. rotate) keeps
  // measurements/constraints; a real re-trace or import drops loop refs.
  setTrace(outer, holes, keepUndo = false, keepRefs = false) {
    this.outer = outer || [];
    this.holes = holes || [];
    if (!keepUndo) this.undoStack.length = 0;
    if (!keepRefs) this._refsOp({ op: 'clearLoops' });
    else this._reprojectArcsLive(); // e.g. after a 90° rotate — keep fillets tangent
    this.selection = null;
    this.selectedVerts = [];
    this._notifySelect();
    this.draw();
  }

  setCircles(circles) {
    this.circles = circles;
    this.draw();
  }

  setSections(sections) {
    this.sections = sections;
    this.draw();
  }

  getTrace() {
    return { outer: this.outer, holes: this.holes, circles: this.circles };
  }

  setMode(mode) {
    if (this.mode === 'region' && mode !== 'region') this._draftRegion = null;
    if (mode !== 'measure') this._pendingPick = null;
    if (mode !== 'constrain') this._picks = [];
    this._hoverSnap = null;
    this.mode = mode;
    this.canvas.style.cursor = mode === 'pan' ? 'grab'
      : (mode === 'region' || mode === 'measure' || mode === 'constrain')
        ? 'crosshair' : 'default';
    if (this.cb.onPicksChanged) this.cb.onPicksChanged();
    this.draw();
  }

  // ---- undo ----

  _snapshot() {
    return structuredClone({
      outer: this.outer, holes: this.holes, circles: this.circles,
      sections: this.sections,
      measurements: this.measurements, constraints: this.constraints,
      arcs: this.arcs, lines: this.lines,
    });
  }

  pushUndo() {
    this.undoStack.push(this._snapshot());
    if (this.undoStack.length > 60) this.undoStack.shift();
  }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return false;
    this.outer = s.outer;
    this.holes = s.holes;
    this.circles = s.circles;
    // The sections array is shared with app state — restore it in place so
    // every holder of the reference sees the undone contents.
    this.sections.length = 0;
    this.sections.push(...s.sections);
    if (this.cb.onSectionsChanged) this.cb.onSectionsChanged();
    this.measurements = s.measurements || [];
    this.constraints = s.constraints || [];
    this.arcs = s.arcs || [];
    this.lines = s.lines || [];
    this._ensureArcIds();
    this._notifyAnnos();
    this.selection = null;
    this.selectedVerts = [];
    this._notifySelect();
    this._changed();
    return true;
  }

  // ---- coordinate helpers ----

  _mmToScreen(p) {
    return this.vp.toScreen({ x: p.x * this.pxPerMm, y: p.y * this.pxPerMm });
  }

  _screenToMm(sp) {
    const wp = this.vp.toWorld(sp);
    return { x: wp.x / this.pxPerMm, y: wp.y / this.pxPerMm };
  }

  _loop(loopIdx) {
    if (loopIdx === -1) return this.outer;
    if (loopIdx >= REGION_LOOP_BASE) {
      const s = this.sections[loopIdx - REGION_LOOP_BASE];
      return s && s.pts;
    }
    return this.holes[loopIdx];
  }

  _isRegionLoop(loopIdx) {
    return typeof loopIdx === 'number' && loopIdx >= REGION_LOOP_BASE;
  }

  // ---- measurements + constraints: shared plumbing ----

  // Ref-resolution adapter over the live geometry (see measure.js). `arc(id)`
  // returns a fillet arc's current fitted circle so it can be a tangent datum.
  _geo() {
    return {
      loop: l => this._loop(l) || null,
      circle: i => this.circles[i] || null,
      arc: id => this._arcCircle(this.arcs.find(a => a.id === id), l => this._loop(l)),
    };
  }

  // Fit an arc entity's current owned points to a circle → { cx, cy, r }.
  _arcCircle(arc, loopFn) {
    if (!arc) return null;
    const pts = loopFn(arc.loop);
    if (!pts || arc.lo + arc.len > pts.length) return null;
    const fit = fitCircle(pts.slice(arc.lo, arc.lo + arc.len));
    return fit ? { cx: fit.cx, cy: fit.cy, r: fit.r } : null;
  }

  // Give every arc a stable id (older saves / undo states may lack one) and
  // keep the sequence ahead of them.
  _ensureArcIds() {
    for (const a of this.arcs) if (a.id == null) a.id = ++this._arcSeq;
    for (const a of this.arcs) this._arcSeq = Math.max(this._arcSeq, a.id);
  }

  // Drop 'tangent to arc' constraints whose target arc no longer exists.
  _pruneArcConstraints() {
    const ids = new Set(this.arcs.map(a => a.id));
    const before = this.constraints.length;
    this.constraints = this.constraints.filter(c =>
      !(c.type === 'ltan' && c.refs[1] && c.refs[1].kind === 'arcent' && !ids.has(c.refs[1].id)));
    return this.constraints.length !== before;
  }

  // Remap both annotation sets across a structural edit; notify if pruned.
  _refsOp(op, loopLen = 0) {
    const m0 = this.measurements.length, c0 = this.constraints.length, a0 = this.arcs.length;
    const l0 = this.lines.length;
    this.measurements = remapRefs(this.measurements, op, loopLen);
    this.constraints = remapRefs(this.constraints, op, loopLen);
    this.arcs = this._remapSpans(this.arcs, op);
    this.lines = this._remapSpans(this.lines, op);
    this._pruneArcConstraints();
    if (this.measurements.length !== m0 || this.constraints.length !== c0 ||
        this.arcs.length !== a0 || this.lines.length !== l0 || op.op !== 'splice') this._notifyAnnos();
  }

  // Arcs and lines both own a fixed vertex run (plus, for arcs, their two
  // bracketing edges), so a structural edit overlapping that guarded span
  // reverts the entity to plain points; an edit strictly before it just
  // shifts the run. `pad` = extra guard on each side (2 for arcs' neighbours,
  // 0 for lines).
  _remapSpans(list, op) {
    if (op.op === 'deleteCircle') return list;
    if (op.op === 'clearLoops') return [];
    const out = [];
    for (const s of list) {
      const pad = s.stash !== undefined ? 0 : 2; // lines carry a stash; arcs don't
      if (op.op === 'deleteLoop') {
        if (s.loop === op.loop) continue; // loop gone → entity gone
        const same = (a, b) => (a >= 0 && a < REGION_LOOP_BASE && b >= 0 && b < REGION_LOOP_BASE) ||
          (a >= REGION_LOOP_BASE && b >= REGION_LOOP_BASE);
        out.push(same(s.loop, op.loop) && s.loop > op.loop ? { ...s, loop: s.loop - 1 } : s);
        continue;
      }
      if (s.loop !== op.loop) { out.push(s); continue; }
      const guardLo = s.lo - pad, guardHi = s.lo + s.len + (pad ? pad - 1 : 0);
      const spliceHi = op.lo + op.removed;
      if (spliceHi <= guardLo) out.push({ ...s, lo: s.lo + (op.added - op.removed) });
      else if (op.lo > guardHi) out.push(s);
      // otherwise the edit disturbs the entity → drop it (reverts to points)
    }
    return out;
  }

  // Re-derive every arc's owned vertices as a fillet of its neighbouring
  // edges. `loopFn(loopIdx)` returns the (mutable) point array; arcs are
  // rewritten in place at a fixed vertex count. Returns the surviving arcs
  // (invalid ones dropped). Never changes array lengths, so no ref remap.
  _reprojectArcsOn(loopFn) {
    const kept = [];
    for (const arc of this.arcs) {
      const pts = loopFn(arc.loop);
      const n = pts ? pts.length : 0;
      if (!pts || n - arc.len < 4 || arc.lo < 0 || arc.lo + arc.len > n) continue;
      const P1 = pts[(arc.lo - 1 + n) % n], P1b = pts[(arc.lo - 2 + n) % n];
      const P2 = pts[(arc.lo + arc.len) % n], P2b = pts[(arc.lo + arc.len + 1) % n];
      const f = filletArc(P1b, P1, P2, P2b, arc.r);
      if (!f) continue;
      const np = arcPointsN(f.C.x, f.C.y, f.r, f.T1, f.T2, f.mid, arc.len);
      for (let i = 0; i < arc.len; i++) pts[arc.lo + i] = np[i];
      kept.push(arc);
    }
    return kept;
  }

  // Reproject arcs on the live geometry (drops invalid ones from this.arcs).
  _reprojectArcsLive() {
    if (!this.arcs.length || this._reprojecting) return;
    this._reprojecting = true;
    this.arcs = this._reprojectArcsOn(l => this._loop(l) || null);
    this._reprojecting = false;
  }

  _hasSolvables() { return this.constraints.length > 0 || this.arcs.length > 0; }

  _notifyAnnos() {
    if (this.cb.onAnnosChanged) this.cb.onAnnosChanged();
  }

  // Run the solver on the live geometry, then reproject fillet arcs so they
  // stay tangent to the freshly-solved edges. extraAnchors pin e.g. the
  // dragged vertex so the solver moves everything else around it.
  solveNow(extraAnchors = []) {
    if (!this._hasSolvables()) return null;
    const res = this.constraints.length
      ? solveConstraints(this._geo(), this.constraints, { extraAnchors }) : null;
    this._reprojectArcsLive();
    return res;
  }

  // Solve a deep copy for the drag ghost preview. Returns cloned geometry
  // ({outer, holes, circles, sections}) or null when nothing would move.
  _solveGhost(extraAnchors) {
    if (!this._hasSolvables()) return null;
    const g = structuredClone({
      outer: this.outer, holes: this.holes, circles: this.circles,
      sections: this.sections.map(s => ({ pts: s.pts })),
    });
    const loopFn = l => l === -1 ? g.outer
      : l >= REGION_LOOP_BASE ? (g.sections[l - REGION_LOOP_BASE] && g.sections[l - REGION_LOOP_BASE].pts)
      : g.holes[l];
    if (this.constraints.length) {
      const ghostGeo = {
        loop: loopFn,
        circle: i => g.circles[i] || null,
        arc: id => this._arcCircle(this.arcs.find(a => a.id === id), loopFn),
      };
      solveConstraints(ghostGeo, this.constraints, { extraAnchors });
    }
    this._reprojectArcsOn(loopFn); // preview tangent fillets on the clone
    return g;
  }

  // Anchors for the current drag (the geometry the user is holding).
  _dragAnchors() {
    if (this._groupDrag) return this.selectedVerts.map(v => ({ kind: 'vert', loop: v.loop, idx: v.idx }));
    const sel = this.selection;
    if (!sel) return [];
    if (sel.type === 'vertex') return [{ kind: 'vert', loop: sel.loop, idx: sel.idx }];
    if (sel.type === 'circle') return [{ kind: 'center', idx: sel.idx }];
    if (sel.type === 'holeloop' && !this._isRegionLoop(sel.loop) && sel.loop >= 0) {
      const pts = this.holes[sel.loop] || [];
      return pts.map((_, i) => ({ kind: 'vert', loop: sel.loop, idx: i }));
    }
    return [];
  }

  // ---- hit testing ----

  _hitVertex(sp) {
    if (!this.showPoints) return null;
    const check = (loopIdx, pts) => {
      for (let i = 0; i < pts.length; i++) {
        const v = this._mmToScreen(pts[i]);
        if (Math.hypot(v.x - sp.x, v.y - sp.y) <= HIT_R) {
          return { type: 'vertex', loop: loopIdx, idx: i };
        }
      }
      return null;
    };
    for (let s = 1; s < this.sections.length; s++) {
      if (!this.sections[s].pts) continue;
      const r = check(REGION_LOOP_BASE + s, this.sections[s].pts);
      if (r) return r;
    }
    for (let h = 0; h < this.holes.length; h++) {
      const r = check(h, this.holes[h]);
      if (r) return r;
    }
    return check(-1, this.outer);
  }

  // Largest diameter drawn for a hole (bore, recess, or rim treatment).
  _holeMaxDia(c) {
    const rim = e => (e && e.mode !== 'none' ? (e.size || 0) * 2 : 0);
    const onTop = c.side !== 'bottom';
    let topDia = c.d, botDia = c.d;
    if (c.type === 'cs') { if (onTop) topDia = Math.max(topDia, c.csDia || 0); else botDia = Math.max(botDia, c.csDia || 0); }
    if (c.type === 'cb') { if (onTop) topDia = Math.max(topDia, c.cbDia || 0); else botDia = Math.max(botDia, c.cbDia || 0); }
    if (c.type === 'blind') { if (onTop) botDia = 0; else topDia = 0; }
    return Math.max(c.d, topDia + rim(c.edgeTop), botDia + rim(c.edgeBottom));
  }

  // Hit-test a hole. region: 'resize' when near the bore rim (drag = change
  // diameter), 'move' when in the interior/centre (drag = reposition).
  _hitCircle(sp) {
    for (let i = 0; i < this.circles.length; i++) {
      const c = this.circles[i];
      const ctr = this._mmToScreen({ x: c.cx, y: c.cy });
      const rimR = (c.d / 2) * this.pxPerMm * this.vp.scale;
      const recessR = (this._holeMaxDia(c) / 2) * this.pxPerMm * this.vp.scale;
      const d = Math.hypot(ctr.x - sp.x, ctr.y - sp.y);
      const onRim = Math.abs(d - rimR) <= HIT_R || Math.abs(d - recessR) <= HIT_R;
      const inInterior = d <= Math.max(HIT_R, 10) || d < rimR - HIT_R;
      if (inInterior) return { type: 'circle', idx: i, region: 'move' };
      if (onRim) return { type: 'circle', idx: i, region: 'resize' };
    }
    return null;
  }

  _hitEdge(sp) {
    if (!this.showPoints) return null;
    let best = null, bestD = HIT_R;
    const check = (loopIdx, pts) => {
      for (let i = 0; i < pts.length; i++) {
        const a = this._mmToScreen(pts[i]);
        const b = this._mmToScreen(pts[(i + 1) % pts.length]);
        const dx = b.x - a.x, dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        if (len2 < 1e-9) continue;
        let t = ((sp.x - a.x) * dx + (sp.y - a.y) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        const px = a.x + dx * t, py = a.y + dy * t;
        const d = Math.hypot(px - sp.x, py - sp.y);
        if (d < bestD) {
          bestD = d;
          best = { loop: loopIdx, idx: i, t };
        }
      }
    };
    check(-1, this.outer);
    for (let h = 0; h < this.holes.length; h++) check(h, this.holes[h]);
    for (let s = 1; s < this.sections.length; s++) {
      if (this.sections[s].pts) check(REGION_LOOP_BASE + s, this.sections[s].pts);
    }
    return best;
  }

  // Snap-pick an entity for measuring/constraining. Priority: vertex →
  // circle centre / rim → edge midpoint → point on edge → traced-hole
  // interior (as a fitted circle). `full` (measure mode) enables the
  // midpoint / on-edge / hole-fit targets; constrain mode wants only
  // verts, edges, and circles.
  _snapPick(sp, full) {
    const mkPos = ref => ({ ref, pos: this._refPos(ref) });
    const vHit = this._hitVertex(sp);
    if (vHit) return mkPos({ kind: 'vert', loop: vHit.loop, idx: vHit.idx });

    for (let i = 0; i < this.circles.length; i++) {
      const c = this.circles[i];
      const ctr = this._mmToScreen({ x: c.cx, y: c.cy });
      const rimR = (c.d / 2) * this.pxPerMm * this.vp.scale;
      const d = Math.hypot(ctr.x - sp.x, ctr.y - sp.y);
      if (d <= Math.max(HIT_R, Math.min(10, rimR - HIT_R))) {
        return mkPos({ kind: 'center', idx: i });
      }
      if (Math.abs(d - rimR) <= HIT_R) return mkPos({ kind: 'circle', idx: i });
    }

    const eHit = this._hitEdge(sp);
    if (eHit) {
      // Constrain mode: a click on a fillet arc's run picks the whole arc
      // (as a tangent datum) rather than an interior edge.
      if (!full) {
        const arc = this._arcAtEdge(eHit.loop, eHit.idx);
        if (arc) return mkPos({ kind: 'arcent', id: arc.id });
      }
      if (full) {
        // Prefer the midpoint when the cursor is close to it.
        const pts = this._loop(eHit.loop);
        const a = pts[eHit.idx], b = pts[(eHit.idx + 1) % pts.length];
        const mid = this._mmToScreen({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        if (Math.hypot(mid.x - sp.x, mid.y - sp.y) <= HIT_R) {
          return mkPos({ kind: 'mid', loop: eHit.loop, idx: eHit.idx });
        }
      }
      return mkPos({ kind: 'edge', loop: eHit.loop, idx: eHit.idx, t: eHit.t });
    }

    if (full) {
      const mm = this._screenToMm(sp);
      for (let h = 0; h < this.holes.length; h++) {
        if (pointInPolygon(mm, this.holes[h])) return mkPos({ kind: 'holeloop', loop: h });
      }
    }
    return null;
  }

  // Arc spans for export, per loop: { outer:[...], holes:[[...],...] }, each
  // descriptor { lo, len, cx, cy, r, sweep } with a signed image-space sweep.
  arcExportSpans() {
    const desc = (loop, pts) => this.arcs
      .filter(a => a.loop === loop && a.lo + a.len <= pts.length && a.lo + a.len - 1 < pts.length)
      .map(a => {
        const fit = fitCircle(pts.slice(a.lo, a.lo + a.len));
        if (!fit) return null;
        let sweep = 0;
        for (let i = a.lo; i < a.lo + a.len - 1; i++) {
          let d = Math.atan2(pts[i + 1].y - fit.cy, pts[i + 1].x - fit.cx) -
            Math.atan2(pts[i].y - fit.cy, pts[i].x - fit.cx);
          while (d <= -Math.PI) d += Math.PI * 2;
          while (d > Math.PI) d -= Math.PI * 2;
          sweep += d;
        }
        return { lo: a.lo, len: a.len, cx: fit.cx, cy: fit.cy, r: fit.r, sweep };
      })
      .filter(Boolean);
    return {
      outer: desc(-1, this.outer),
      holes: this.holes.map((h, i) => desc(i, h)),
    };
  }

  // The arc entity that owns edge `edgeIdx` (verts idx→idx+1) on `loop`, or null.
  _arcAtEdge(loop, edgeIdx) {
    return this.arcs.find(a => a.loop === loop && edgeIdx >= a.lo && edgeIdx < a.lo + a.len - 1) || null;
  }

  // Screen position of a ref (for markers); circle-ish refs use the centre.
  _refPos(ref) {
    const geo = this._geo();
    if (ref.kind === 'arcent') {
      const c = geo.arc(ref.id);
      return c ? this._mmToScreen({ x: c.cx, y: c.cy }) : null;
    }
    if (ref.kind === 'edge') {
      const e = resolveEdge(ref, geo);
      if (!e) return null;
      const t = ref.t ?? 0.5;
      return this._mmToScreen({ x: e.a.x + (e.b.x - e.a.x) * t, y: e.a.y + (e.b.y - e.a.y) * t });
    }
    if (ref.kind === 'circle' || ref.kind === 'holeloop') {
      const c = ref.kind === 'circle' ? this.circles[ref.idx] : null;
      if (c) return this._mmToScreen({ x: c.cx, y: c.cy });
      const info = measureInfo({ type: 'rad', refs: [ref] }, geo);
      return info ? this._mmToScreen({ x: info.cx, y: info.cy }) : null;
    }
    const p = resolvePoint(ref, geo);
    return p ? this._mmToScreen(p) : null;
  }

  // ---- measure mode ----

  _sameRef(a, b) {
    return a && b && a.kind === b.kind && a.loop === b.loop && a.idx === b.idx;
  }

  _measureDown(sp) {
    const pick = this._snapPick(sp, true);
    const isPt = r => r && (r.kind === 'vert' || r.kind === 'mid' || r.kind === 'onedge' || r.kind === 'center');
    if (!pick) {
      // Empty click: a lone pending edge commits as a length measurement.
      if (this._pendingPick && this._pendingPick.kind === 'edge') {
        this._addMeasurement({ type: 'elen', refs: [this._strip(this._pendingPick)] });
      }
      this._pendingPick = null;
      this.panning = true;
      this.draw();
      return;
    }
    const ref = pick.ref;
    if (ref.kind === 'circle' || ref.kind === 'holeloop') {
      // One click = a radius/diameter measurement.
      this._pendingPick = null;
      this._addMeasurement({ type: 'rad', refs: [this._strip(ref)] });
      return;
    }
    // On-edge pick acts as a point when a point measurement is in progress,
    // else as the edge itself.
    const prev = this._pendingPick;
    if (!prev) {
      this._pendingPick = ref;
      this.draw();
      return;
    }
    if (this._sameRef(prev, ref) && prev.kind === 'edge') {
      this._addMeasurement({ type: 'elen', refs: [this._strip(prev)] });
      this._pendingPick = null;
      return;
    }
    const prevPt = isPt(prev), curPt = isPt(ref);
    let m = null;
    if (prevPt && curPt) m = { type: 'p2p', refs: [prev, ref] };
    else if (prevPt && ref.kind === 'edge') m = { type: 'p2e', refs: [prev, this._strip(ref)] };
    else if (prev.kind === 'edge' && curPt) m = { type: 'p2e', refs: [ref, this._strip(prev)] };
    else if (prev.kind === 'edge' && ref.kind === 'edge') {
      m = { type: 'e2e', refs: [this._strip(prev), this._strip(ref)] };
    }
    this._pendingPick = null;
    if (m) this._addMeasurement(m);
    else this.draw();
  }

  // Drop the transient pick parameter (edge picks carry a t for markers).
  _strip(ref) {
    if (ref.kind !== 'edge') return ref;
    const { t, ...rest } = ref;
    return rest;
  }

  _addMeasurement(m) {
    this.measurements.push(m);
    this._notifyAnnos();
    this.draw();
  }

  removeMeasurement(i) {
    this.measurements.splice(i, 1);
    this._notifyAnnos();
    this.draw();
  }

  clearMeasurements() {
    this.measurements = [];
    this._pendingPick = null;
    this._notifyAnnos();
    this.draw();
  }

  cancelPendingPick() {
    if (!this._pendingPick && !this._picks.length) return false;
    this._pendingPick = null;
    this._picks = [];
    if (this.cb.onPicksChanged) this.cb.onPicksChanged();
    this.draw();
    return true;
  }

  // ---- constrain mode ----

  _constrainDown(sp) {
    const pick = this._snapPick(sp, false);
    if (!pick) {
      this._picks = [];
      this.panning = true;
      if (this.cb.onPicksChanged) this.cb.onPicksChanged();
      this.draw();
      return;
    }
    let ref = pick.ref;
    if (ref.kind === 'edge') ref = this._strip(ref);
    const i = this._picks.findIndex(p => this._sameRef(p, ref));
    if (i >= 0) this._picks.splice(i, 1);            // click again = unpick
    else {
      this._picks.push(ref);
      if (this._picks.length > 2) this._picks.shift(); // keep the newest two
    }
    if (this.cb.onPicksChanged) this.cb.onPicksChanged();
    this.draw();
  }

  // Current picks, for the panel to decide which constraints apply.
  getPicks() { return this._picks.slice(); }

  // Measured value of the current picks, used to prefill dimension inputs:
  // {len} for one edge, {angle} for two edges, {dist} for point/point|edge.
  picksValue() {
    const geo = this._geo();
    const p = this._picks;
    const asPt = r => r.kind === 'vert' || r.kind === 'center' || r.kind === 'circle'
      ? resolvePoint(r.kind === 'circle' ? { kind: 'center', idx: r.idx } : r, geo) : null;
    if (p.length === 1 && p[0].kind === 'edge') {
      const e = resolveEdge(p[0], geo);
      return e ? { len: ptDist(e.a, e.b) } : null;
    }
    if (p.length === 2 && p[0].kind === 'edge' && p[1].kind === 'edge') {
      const A = resolveEdge(p[0], geo), B = resolveEdge(p[1], geo);
      return A && B ? { angle: angleBetweenDeg(A.a, A.b, B.a, B.b) } : null;
    }
    if (p.length === 2) {
      const edge = p.find(r => r.kind === 'edge');
      const pts = p.filter(r => r.kind !== 'edge').map(asPt);
      if (edge && pts.length === 1 && pts[0]) {
        const e = resolveEdge(edge, geo);
        return e ? { dist: pointSegDist(pts[0], e.a, e.b).d } : null;
      }
      if (pts.length === 2 && pts[0] && pts[1]) return { dist: ptDist(pts[0], pts[1]) };
    }
    return null;
  }

  // Build + apply a constraint from the current picks. Returns true when it
  // was added (picks matched the type's signature).
  addConstraintFromPicks(type, value) {
    const p = this._picks;
    const circ = r => r.kind === 'circle' || r.kind === 'center';
    const asCenter = r => circ(r) ? { kind: 'center', idx: r.idx } : r;
    const asCircle = r => circ(r) ? { kind: 'circle', idx: r.idx } : r;
    const edges = p.filter(r => r.kind === 'edge');
    const others = p.filter(r => r.kind !== 'edge');
    let refs = null;
    switch (type) {
      case 'h': case 'v': case 'len':
        if (p.length === 1 && edges.length === 1) refs = [edges[0]];
        break;
      case 'perp': case 'para': case 'equal': case 'collin': case 'angle':
        if (edges.length === 2) refs = edges;
        break;
      case 'conc':
        if (p.length === 2 && p.every(circ)) refs = p.map(asCircle);
        break;
      case 'ltan': {
        // One edge + one circle or fillet arc: drive the edge tangent to it.
        const tgt = others.find(r => circ(r) || r.kind === 'arcent');
        if (p.length === 2 && edges.length === 1 && tgt) {
          refs = [edges[0], tgt.kind === 'arcent' ? tgt : asCircle(tgt)];
        }
        break;
      }
      case 'dist':
        if (p.length === 2 && edges.length <= 1 && others.every(r => r.kind === 'vert' || circ(r))) {
          const pts = others.map(asCenter);
          refs = edges.length ? [pts[0], edges[0]] : pts;
        }
        break;
      case 'anchor':
        if (p.length === 1 && (p[0].kind === 'vert' || circ(p[0]))) refs = [asCenter(p[0])];
        break;
    }
    if (!refs) return false;
    this.pushUndo();
    const c = { type, refs };
    if (value !== undefined) c.value = value;
    this.constraints.push(c);
    this._picks = [];
    this.solveNow();
    if (this.cb.onPicksChanged) this.cb.onPicksChanged();
    this._notifyAnnos();
    this._changed();
    return true;
  }

  removeConstraint(i) {
    this.pushUndo();
    this.constraints.splice(i, 1);
    this._notifyAnnos();
    this._changed();
  }

  clearConstraints() {
    if (!this.constraints.length) return;
    this.pushUndo();
    this.constraints = [];
    this._picks = [];
    if (this.cb.onPicksChanged) this.cb.onPicksChanged();
    this._notifyAnnos();
    this._changed();
  }

  // ---- pointer handling ----

  _down(e) {
    if (!this.rectified) return;
    this.canvas.setPointerCapture(e.pointerId);
    const sp = this.vp.eventPos(e);
    this.lastPos = sp;

    if (e.button === 1 || this.mode === 'pan') {
      this.panning = true;
      return;
    }

    if (this.mode === 'region' && e.button === 0) {
      // Click to add draft points; commit via double-click or Enter.
      const mm = this._screenToMm(sp);
      if (!this._draftRegion) this._draftRegion = [];
      this._draftRegion.push(mm);
      this.draw();
      return;
    }

    if (this.mode === 'measure' || this.mode === 'constrain') {
      if (e.button !== 0) { this.panning = true; return; }
      if (this.mode === 'measure') this._measureDown(sp);
      else this._constrainDown(sp);
      return;
    }

    if (this.mode === 'addhole' && e.button === 0) {
      const mm = this._screenToMm(sp);
      this.pushUndo();
      this.circles.push({ cx: mm.x, cy: mm.y, ...structuredClone(this.holeTemplate) });
      this.selection = { type: 'circle', idx: this.circles.length - 1 };
      // Dragging outward now sizes the new hole; a plain click keeps the
      // template diameter.
      this._placedIdx = this.circles.length - 1;
      this._holeStart = mm;
      this._newHoleSized = false;
      this.dragging = true;
      this._notifySelect();
      this._changed();
      return;
    }

    // edit mode
    const vHit = this._hitVertex(sp);
    const cHit = vHit ? null : this._hitCircle(sp);

    if (e.button === 2 || e.altKey) {
      if (vHit) { this._deleteVertex(vHit); return; }
      if (cHit) { this._deleteCircle(cHit.idx); return; }
      this.panning = true;
      return;
    }

    // Ctrl/Cmd+click on a vertex toggles it in the multi-selection.
    if (vHit && (e.ctrlKey || e.metaKey)) {
      this._toggleVert(vHit);
      this.selection = null;
      this._notifySelect();
      this.draw();
      return;
    }

    if (vHit) {
      if (this._vertInMulti(vHit) && this.selectedVerts.length > 1) {
        // Drag the whole group.
        this.pushUndo();
        const mm0 = this._screenToMm(sp);
        this._groupDrag = {
          start: mm0,
          orig: this.selectedVerts.map(v => ({ ...this._loop(v.loop)[v.idx] })),
        };
        this.dragging = true;
        return;
      }
      this.selectedVerts = [];
      this.selection = vHit;
      this.pushUndo();
      this.dragging = true;
      this._notifySelect();
      this.draw();
      return;
    }
    if (cHit) {
      this.selectedVerts = [];
      this.selection = { type: 'circle', idx: cHit.idx };
      this._circleResize = cHit.region === 'resize';
      this.pushUndo();
      this.dragging = true;
      this._notifySelect();
      this.draw();
      return;
    }

    const eHit = this._hitEdge(sp);
    if (eHit) {
      // Insert a vertex on the edge and start dragging it.
      this.selectedVerts = [];
      this.pushUndo();
      const pts = this._loop(eHit.loop);
      const a = pts[eHit.idx], b = pts[(eHit.idx + 1) % pts.length];
      const np = { x: a.x + (b.x - a.x) * eHit.t, y: a.y + (b.y - a.y) * eHit.t };
      this._refsOp({ op: 'splice', loop: eHit.loop, lo: eHit.idx + 1, removed: 0, added: 1 }, pts.length);
      pts.splice(eHit.idx + 1, 0, np);
      this.selection = { type: 'vertex', loop: eHit.loop, idx: eHit.idx + 1 };
      this.dragging = true;
      this._notifySelect();
      this._changed();
      return;
    }

    // Shift+drag on empty space starts a marquee multi-selection.
    if (e.shiftKey) {
      this._marquee = { x0: sp.x, y0: sp.y, x1: sp.x, y1: sp.y };
      this.dragging = true;
      return;
    }

    // Inside a traced hole (or a section footprint): select + drag the loop.
    const mm = this._screenToMm(sp);
    for (let h = 0; h < this.holes.length; h++) {
      if (pointInPolygon(mm, this.holes[h])) {
        this.selectedVerts = [];
        this.selection = { type: 'holeloop', loop: h };
        this.pushUndo();
        this.dragging = true;
        this._lastMm = mm;
        this._notifySelect();
        this.draw();
        return;
      }
    }
    for (let s = 1; s < this.sections.length; s++) {
      if (this.sections[s].pts && pointInPolygon(mm, this.sections[s].pts)) {
        this.selectedVerts = [];
        this.selection = { type: 'holeloop', loop: REGION_LOOP_BASE + s };
        this.pushUndo();
        this.dragging = true;
        this._lastMm = mm;
        this._notifySelect();
        this.draw();
        return;
      }
    }

    this.selection = null;
    this.selectedVerts = [];
    this.panning = true;
    this._notifySelect();
    this.draw();
  }

  // ---- multi-selection helpers ----

  _vertKey(v) { return `${v.loop}:${v.idx}`; }
  _vertInMulti(v) { return this.selectedVerts.some(s => s.loop === v.loop && s.idx === v.idx); }
  _toggleVert(v) {
    const i = this.selectedVerts.findIndex(s => s.loop === v.loop && s.idx === v.idx);
    if (i >= 0) this.selectedVerts.splice(i, 1);
    else this.selectedVerts.push({ loop: v.loop, idx: v.idx });
  }
  clearMultiSelect() {
    this.selectedVerts = [];
    this.draw();
  }

  // Commit or cancel an in-progress region draft (mode 'region').
  commitDraftRegion() {
    const pts = this._draftRegion;
    this._draftRegion = null;
    if (pts && pts.length >= 3 && this.cb.onRegionDrawn) {
      this.pushUndo();
      this.cb.onRegionDrawn(pts);
      this._changed();
      return true;
    }
    this.draw();
    return false;
  }

  cancelDraftRegion() {
    this._draftRegion = null;
    this.draw();
  }

  _move(e) {
    if (!this.rectified) return;
    const sp = this.vp.eventPos(e);
    if (this.panning && this.lastPos) {
      this.vp.pan(sp.x - this.lastPos.x, sp.y - this.lastPos.y);
      this.lastPos = sp;
      this.draw();
      return;
    }
    // Marquee selection
    if (this.dragging && this._marquee) {
      this._marquee.x1 = sp.x; this._marquee.y1 = sp.y;
      this.draw();
      return;
    }
    // Group move of a vertex multi-selection
    if (this.dragging && this._groupDrag) {
      const mm = this._screenToMm(sp);
      const maxX = this.rectified.width / this.pxPerMm;
      const maxY = this.rectified.height / this.pxPerMm;
      const dx = mm.x - this._groupDrag.start.x, dy = mm.y - this._groupDrag.start.y;
      this.selectedVerts.forEach((v, i) => {
        const loop = this._loop(v.loop);
        if (!loop) return;
        const o = this._groupDrag.orig[i];
        loop[v.idx] = {
          x: Math.max(0, Math.min(maxX, o.x + dx)),
          y: Math.max(0, Math.min(maxY, o.y + dy)),
        };
      });
      this._ghost = this._hasSolvables() ? this._solveGhost(this._dragAnchors()) : null;
      this._changed(true);
      return;
    }
    if (this.dragging && this.selection) {
      const mm = this._screenToMm(sp);
      const maxX = this.rectified.width / this.pxPerMm;
      const maxY = this.rectified.height / this.pxPerMm;
      mm.x = Math.max(0, Math.min(maxX, mm.x));
      mm.y = Math.max(0, Math.min(maxY, mm.y));
      if (this._placedIdx !== null) {
        // Sizing a just-placed hole: radius follows the drag distance.
        const c = this.circles[this._placedIdx];
        const dist = Math.hypot(mm.x - this._holeStart.x, mm.y - this._holeStart.y);
        if (!this._newHoleSized && dist * this.pxPerMm * this.vp.scale > 5) {
          this._newHoleSized = true;
        }
        if (this._newHoleSized) c.d = Math.max(0.4, dist * 2);
      } else if (this.selection.type === 'vertex') {
        const pts = this._loop(this.selection.loop);
        pts[this.selection.idx] = mm;
      } else if (this.selection.type === 'circle' && this._circleResize) {
        // Dragging the rim resizes the bore diameter.
        const c = this.circles[this.selection.idx];
        c.d = Math.max(0.4, 2 * Math.hypot(mm.x - c.cx, mm.y - c.cy));
      } else if (this.selection.type === 'circle') {
        const c = this.circles[this.selection.idx];
        c.cx = mm.x; c.cy = mm.y;
      } else if (this.selection.type === 'holeloop' && this._lastMm) {
        const dx = mm.x - this._lastMm.x, dy = mm.y - this._lastMm.y;
        const loop = this._loop(this.selection.loop);
        if (loop) for (const p of loop) { p.x += dx; p.y += dy; }
        this._lastMm = mm;
      }
      // Constrained drag: preview where the solver + fillet arcs will land.
      this._ghost = this._hasSolvables() && this._placedIdx === null
        ? this._solveGhost(this._dragAnchors()) : null;
      this._changed(true);
      return;
    }
    if (this.mode === 'edit') this._updateHoverCursor(sp);
    if (this.mode === 'measure' || this.mode === 'constrain') {
      this._hoverSnap = this._snapPick(sp, this.mode === 'measure');
      this.draw();
    }
  }

  _updateHoverCursor(sp) {
    const v = this._hitVertex(sp);
    if (v) { this.canvas.style.cursor = 'pointer'; return; }
    const c = this._hitCircle(sp);
    if (c) {
      this.canvas.style.cursor = c.region === 'resize' ? 'nwse-resize' : 'move';
      return;
    }
    this.canvas.style.cursor = this._hitEdge(sp) ? 'copy' : 'default';
  }

  _up() {
    if (this._marquee) {
      this._applyMarquee(this._marquee);
      this._marquee = null;
      this.dragging = false;
      this.draw();
      return;
    }
    if (this.dragging) {
      if (this._placedIdx !== null) {
        const c = this.circles[this._placedIdx];
        c.d = Math.round(c.d * 20) / 20; // 0.05 mm steps
        const { cx, cy, ...rest } = c;
        this.holeTemplate = structuredClone(rest);
        const placed = this._placedIdx;
        this._placedIdx = null;
        this._holeStart = null;
        if (this.cb.onHolePlaced) this.cb.onHolePlaced(placed);
      }
      if (this.selection && this.selection.type === 'circle' && this._circleResize) {
        this.circles[this.selection.idx].d = Math.round(this.circles[this.selection.idx].d * 20) / 20;
      }
      // Commit the constrained result the ghost was previewing.
      if (this._ghost) {
        this.solveNow(this._dragAnchors());
        this._ghost = null;
      }
      this._changed();
    }
    this.dragging = false;
    this.panning = false;
    this.lastPos = null;
    this._lastMm = null;
    this._groupDrag = null;
    this._circleResize = false;
  }

  // Select every vertex whose screen position falls inside the marquee rect.
  _applyMarquee(m) {
    const xa = Math.min(m.x0, m.x1), xb = Math.max(m.x0, m.x1);
    const ya = Math.min(m.y0, m.y1), yb = Math.max(m.y0, m.y1);
    if (xb - xa < 3 && yb - ya < 3) return; // ignore a stray click
    const sel = [];
    const scan = (loopIdx, pts) => {
      for (let i = 0; i < pts.length; i++) {
        const s = this._mmToScreen(pts[i]);
        if (s.x >= xa && s.x <= xb && s.y >= ya && s.y <= yb) sel.push({ loop: loopIdx, idx: i });
      }
    };
    scan(-1, this.outer);
    for (let h = 0; h < this.holes.length; h++) scan(h, this.holes[h]);
    for (let s = 1; s < this.sections.length; s++) {
      if (this.sections[s].pts) scan(REGION_LOOP_BASE + s, this.sections[s].pts);
    }
    this.selectedVerts = sel;
    this.selection = null;
    this._notifySelect();
  }

  // ---- edit ops ----

  _deleteVertex(sel) {
    const pts = this._loop(sel.loop);
    if (!pts) return;
    if (sel.loop === -1 && pts.length <= 3) return; // outline must stay a polygon
    this.pushUndo();
    this._refsOp({ op: 'splice', loop: sel.loop, lo: sel.idx, removed: 1, added: 0 }, pts.length);
    pts.splice(sel.idx, 1);
    if (pts.length < 3) {
      this._refsOp({ op: 'deleteLoop', loop: sel.loop });
      if (this._isRegionLoop(sel.loop)) {
        this.sections.splice(sel.loop - REGION_LOOP_BASE, 1);
        if (this.cb.onSectionsChanged) this.cb.onSectionsChanged();
      } else if (sel.loop >= 0) {
        this.holes.splice(sel.loop, 1);
      }
    }
    this.selection = null;
    this._notifySelect();
    this._changed();
  }

  _deleteCircle(idx) {
    this.pushUndo();
    this._refsOp({ op: 'deleteCircle', idx });
    this.circles.splice(idx, 1);
    this.selection = null;
    this._notifySelect();
    this._changed();
  }

  deleteSelected() {
    if (this.selectedVerts.length) { this._deleteVertGroup(); return; }
    if (!this.selection) return;
    if (this.selection.type === 'vertex') this._deleteVertex(this.selection);
    else if (this.selection.type === 'circle') this._deleteCircle(this.selection.idx);
    else if (this.selection.type === 'holeloop') this.deleteSelectedHole();
  }

  // Delete every vertex in the multi-selection, per loop, keeping each loop a
  // valid polygon (>= 3 points) and never emptying the outer outline.
  _deleteVertGroup() {
    this.pushUndo();
    const byLoop = new Map();
    for (const v of this.selectedVerts) {
      if (!byLoop.has(v.loop)) byLoop.set(v.loop, []);
      byLoop.get(v.loop).push(v.idx);
    }
    // Phase 1: remove vertices in place (loop indexing unaffected); note loops
    // that would collapse for phase 2.
    const collapseHoles = [], collapseSections = [];
    for (const [loop, idxs] of byLoop) {
      const pts = this._loop(loop);
      if (!pts) continue;
      if (pts.length - idxs.length < 3) {
        if (loop === -1) continue; // never empty the outer outline
        if (this._isRegionLoop(loop)) collapseSections.push(loop - REGION_LOOP_BASE);
        else collapseHoles.push(loop);
        continue;
      }
      const drop = new Set(idxs);
      // Remap refs as individual descending deletions so indices stay valid.
      let len = pts.length;
      for (const k of [...idxs].sort((a, b) => b - a)) {
        this._refsOp({ op: 'splice', loop, lo: k, removed: 1, added: 0 }, len--);
      }
      const kept = pts.filter((_, i) => !drop.has(i));
      pts.length = 0;
      pts.push(...kept);
    }
    // Phase 2: drop collapsed loops from the back so indices stay valid.
    for (const h of collapseHoles.sort((a, b) => b - a)) {
      this._refsOp({ op: 'deleteLoop', loop: h });
      this.holes.splice(h, 1);
    }
    for (const s of collapseSections.sort((a, b) => b - a)) {
      this._refsOp({ op: 'deleteLoop', loop: REGION_LOOP_BASE + s });
      this.sections.splice(s, 1);
    }
    this.selectedVerts = [];
    this.selection = null;
    if (this.cb.onSectionsChanged) this.cb.onSectionsChanged();
    this._notifySelect();
    this._changed();
  }

  // Delete the whole loop containing the selection (traced hole or circle).
  deleteSelectedHole() {
    if (!this.selection) return;
    if (this.selection.type === 'circle') { this._deleteCircle(this.selection.idx); return; }
    const loop = this.selection.type === 'holeloop' ? this.selection.loop
      : (this.selection.type === 'vertex' ? this.selection.loop : -1);
    if (this._isRegionLoop(loop)) { this.deleteSelectedSection(); return; }
    if (loop >= 0) {
      this.pushUndo();
      this._refsOp({ op: 'deleteLoop', loop });
      this.holes.splice(loop, 1);
      this.selection = null;
      this._notifySelect();
      this._changed();
    }
  }

  // Which section (index into sections) the selection belongs to, or -1.
  selectedSectionIndex() {
    const sel = this.selection;
    if (!sel) return -1;
    const loop = sel.type === 'vertex' || sel.type === 'holeloop' ? sel.loop : -2;
    return this._isRegionLoop(loop) ? loop - REGION_LOOP_BASE : -1;
  }

  deleteSelectedSection() {
    const idx = this.selectedSectionIndex();
    if (idx < 1) return; // never the base
    this.pushUndo();
    this._refsOp({ op: 'deleteLoop', loop: REGION_LOOP_BASE + idx });
    this.sections.splice(idx, 1);
    this.selection = null;
    if (this.cb.onSectionsChanged) this.cb.onSectionsChanged();
    this._notifySelect();
    this._changed();
  }

  // ---- normalize traced holes to perfect circles (explicit action only) ----

  // Fit a circle to hole loop `loopIdx` and replace the polygon with a
  // manual circle hole. Returns the fit or null.
  _loopToCircle(loopIdx) {
    const pts = this.holes[loopIdx];
    if (!pts || pts.length < 3) return null;
    const fit = fitCircle(resampleClosed(pts, 64));
    if (!fit) return null;
    this._refsOp({ op: 'deleteLoop', loop: loopIdx });
    this.holes.splice(loopIdx, 1);
    this.circles.push({
      cx: fit.cx, cy: fit.cy, d: Math.round(fit.r * 2 * 20) / 20,
      type: 'through', side: 'top', depth: 3,
      csAngle: 90, csDia: 9, cbDia: 9, cbDepth: 3,
      edgeTop: { mode: 'none', size: 0.5 },
      edgeBottom: { mode: 'none', size: 0.5 },
      screw: { std: 'custom', size: '', fit: 'clearance' },
    });
    return fit;
  }

  // Convert the selected traced hole. Returns the fit or null.
  convertSelectedToCircle() {
    const sel = this.selection;
    const loop = sel && (sel.type === 'holeloop' ? sel.loop
      : (sel.type === 'vertex' && sel.loop >= 0 ? sel.loop : -1));
    if (loop === -1 || loop == null) return null;
    this.pushUndo();
    const fit = this._loopToCircle(loop);
    if (!fit) { this.undoStack.pop(); return null; }
    this.selection = { type: 'circle', idx: this.circles.length - 1 };
    this._notifySelect();
    this._changed();
    return fit;
  }

  // Convert every traced hole that fits a circle well (rms within tolerance).
  // Returns how many were converted.
  convertAllRoundHoles() {
    const candidates = [];
    for (let h = 0; h < this.holes.length; h++) {
      const fit = fitCircle(resampleClosed(this.holes[h], 64));
      if (fit && fit.rms <= Math.max(0.2, fit.r * 0.1)) candidates.push(h);
    }
    if (!candidates.length) return 0;
    this.pushUndo();
    for (const h of candidates.reverse()) this._loopToCircle(h); // back-to-front
    this.selection = null;
    this._notifySelect();
    this._changed();
    return candidates.length;
  }

  // ---- normalize / edit a run of outline points (multi-select ops) ----

  // The contiguous span of the current vertex multi-selection on one loop:
  // { loop, lo, hi } inclusive (endpoints preserved, interior operated on),
  // or null if the selection isn't usable.
  _selectionSpan(minCount = 3) {
    const vs = this.selectedVerts;
    if (vs.length < minCount) return null;
    const loop = vs[0].loop;
    if (!vs.every(v => v.loop === loop)) return null;
    const pts = this._loop(loop);
    if (!pts) return null;
    const idxs = vs.map(v => v.idx).sort((a, b) => a - b);
    return { loop, lo: idxs[0], hi: idxs[idxs.length - 1], pts };
  }

  hasMultiRun(minCount = 3) { return !!this._selectionSpan(minCount); }

  _reselectRun(loop, lo, newLen) {
    this.selectedVerts = [];
    for (let i = 0; i < newLen; i++) this.selectedVerts.push({ loop, idx: lo + i });
  }

  // Replace the interior of the selected span with a straight line (keep
  // endpoints). Returns true on success.
  fitLineToSelection() {
    const span = this._selectionSpan(3);
    if (!span) return false;
    const { loop, lo, hi, pts } = span;
    this.pushUndo();
    this._refsOp({ op: 'splice', loop, lo: lo + 1, removed: hi - lo - 1, added: 0 }, pts.length);
    pts.splice(lo + 1, hi - lo - 1); // drop interior points
    this._reselectRun(loop, lo, 2);
    if (this.cb.onSectionsChanged) this.cb.onSectionsChanged();
    this._notifySelect();
    this._changed();
    return true;
  }

  // Fit a circular arc through the selected span and rebuild it as a smooth
  // arc (endpoints preserved). Returns the fit radius or null.
  fitArcToSelection() {
    const span = this._selectionSpan(3);
    if (!span) return null;
    const { loop, lo, hi, pts } = span;
    const run = pts.slice(lo, hi + 1);
    const fit = fitCircle(run);
    if (!fit) return null;
    this.pushUndo();
    const arc = this._arcPoints(fit.cx, fit.cy, fit.r, run[0], run[run.length - 1], run[(run.length / 2) | 0]);
    this._refsOp({ op: 'splice', loop, lo, removed: hi - lo + 1, added: arc.length }, pts.length);
    pts.splice(lo, hi - lo + 1, ...arc);
    this._reselectRun(loop, lo, arc.length);
    this._lastArc = { loop, lo, len: arc.length, A: run[0], B: run[run.length - 1], mid: run[(run.length / 2) | 0] };
    if (this.cb.onSectionsChanged) this.cb.onSectionsChanged();
    this._notifySelect();
    this._changed();
    return Math.round(fit.r * 100) / 100;
  }

  // Re-fit the last arc to an explicit radius, keeping its endpoints and side.
  setSelectedArcRadius(rMm) {
    const la = this._lastArc;
    if (!la || !(rMm > 0)) return false;
    const pts = this._loop(la.loop);
    if (!pts) return false;
    const A = pts[la.lo], B = pts[la.lo + la.len - 1];
    if (!A || !B) return false;
    // Centre lies on the perpendicular bisector of AB at distance h from the
    // midpoint; two solutions — pick the side matching the original bulge.
    const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
    const half = Math.hypot(B.x - A.x, B.y - A.y) / 2;
    if (rMm < half) rMm = half; // radius can't be smaller than the chord half
    const h = Math.sqrt(Math.max(0, rMm * rMm - half * half));
    let nx = -(B.y - A.y), ny = (B.x - A.x);
    const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
    const c1 = { x: mx + nx * h, y: my + ny * h };
    const c2 = { x: mx - nx * h, y: my - ny * h };
    const dist = (c, p) => Math.abs(Math.hypot(p.x - c.x, p.y - c.y) - rMm);
    const c = dist(c1, la.mid) <= dist(c2, la.mid) ? c1 : c2;
    this.pushUndo();
    const arc = this._arcPoints(c.x, c.y, rMm, A, B, la.mid);
    this._refsOp({ op: 'splice', loop: la.loop, lo: la.lo, removed: la.len, added: arc.length }, pts.length);
    pts.splice(la.lo, la.len, ...arc);
    la.len = arc.length;
    this._reselectRun(la.loop, la.lo, arc.length);
    if (this.cb.onSectionsChanged) this.cb.onSectionsChanged();
    this._notifySelect();
    this._changed();
    return true;
  }

  // Round the selected corner into an arc tangent to both adjacent straight
  // edges (apply-once cleanup — traced fillets rarely come out tangent). The
  // run must be a rounded/blunt corner bracketed by straight segments on each
  // side. Radius = the run's current fitted radius, shrunk if it wouldn't fit
  // between the corner and the neighbouring vertices. Returns { ok, r } or
  // { ok:false, reason }.
  makeTangentSelection() {
    const span = this._selectionSpan(3);
    if (!span) return { ok: false, reason: 'Select a run of 3+ points on one outline first.' };
    this.pushUndo();
    const res = this._makeTangentSpan(span.loop, span.lo, span.hi);
    if (!res.ok) { this.undoStack.pop(); return res; }
    this._reselectRun(res.loop, res.lo, res.len);
    if (this.cb.onSectionsChanged) this.cb.onSectionsChanged();
    this._notifyAnnos();
    this._notifySelect();
    this._changed();
    return { ok: true, r: res.r };
  }

  // Convert the corner run [lo..hi] on `loop` into a fillet arc tangent to the
  // two straight edges bracketing it, registering a live arc entity. Does NOT
  // push undo or notify (callers batch that). With opts.auto it also gates on a
  // clean circular fit + genuine-fillet geometry, so it can be run blind over
  // detected candidates. Returns { ok, loop, lo, len, r } or { ok:false }.
  _makeTangentSpan(loop, lo, hi, { auto = false } = {}) {
    const pts = this._loop(loop);
    if (!pts) return { ok: false, reason: 'No such outline.' };
    const n = pts.length, len = hi - lo + 1;
    if (len < 3) return { ok: false, reason: 'Select a run of 3+ points on one outline first.' };
    if (n - len < 4) return { ok: false, reason: 'Need a straight edge on each side of the corner.' };
    const runPts = pts.slice(lo, hi + 1);
    const fit = fitCircle(runPts);
    if (!fit) return { ok: false, reason: 'Could not fit an arc to that selection.' };
    const P1 = pts[(lo - 1 + n) % n], P1b = pts[(lo - 2 + n) % n];
    const P2 = pts[(hi + 1) % n], P2b = pts[(hi + 2) % n];
    const f = filletArc(P1b, P1, P2, P2b, fit.r);
    if (!f) return { ok: false, reason: 'Adjacent edges are parallel or the corner is too shallow.' };
    if (auto) {
      // Only convert a run that is genuinely a clean circular fillet.
      if (!(fit.r > 0.3)) return { ok: false };
      if (fit.rms > Math.max(0.15, fit.r * 0.04)) return { ok: false };
      // The derived tangent points must land near the run's own endpoints, else
      // this isn't the fillet of these two edges.
      const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) <= Math.max(0.6, fit.r * 0.25);
      const okEnds = (near(f.T1, runPts[0]) && near(f.T2, runPts[runPts.length - 1])) ||
        (near(f.T2, runPts[0]) && near(f.T1, runPts[runPts.length - 1]));
      if (!okEnds) return { ok: false };
    }
    const arc = this._arcPoints(f.C.x, f.C.y, f.r, f.T1, f.T2, f.mid);
    // Drop only arcs overlapping this edited region (so detect can add several).
    this.arcs = this.arcs.filter(a => a.loop !== loop || a.lo + a.len <= lo || a.lo > hi);
    this._refsOp({ op: 'splice', loop, lo, removed: len, added: arc.length }, n);
    pts.splice(lo, len, ...arc);
    this.arcs.push({ id: ++this._arcSeq, loop, lo, len: arc.length, r: Math.round(f.r * 100) / 100 });
    this._lastArc = { loop, lo, len: arc.length, A: f.T1, B: f.T2, mid: f.mid };
    return { ok: true, loop, lo, len: arc.length, r: Math.round(f.r * 100) / 100 };
  }

  // Signed turn angle at each vertex of a closed loop (+ = left/CCW).
  _turnAngles(pts) {
    const n = pts.length, turn = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
      const v1x = b.x - a.x, v1y = b.y - a.y, v2x = c.x - b.x, v2y = c.y - b.y;
      if (Math.hypot(v1x, v1y) < 1e-9 || Math.hypot(v2x, v2y) < 1e-9) continue;
      turn[i] = Math.atan2(v1x * v2y - v1y * v2x, v1x * v2x + v1y * v2y);
    }
    return turn;
  }

  // Maximal runs [lo,hi] of consistently-curving vertices that look like a
  // circular arc (moderate, same-sign turns; total sweep 15°–165°), i.e.
  // fillet candidates — not sharp corners (one big turn) or full circles.
  _arcRuns(pts) {
    const n = pts.length;
    const turn = this._turnAngles(pts);
    const TMIN = 2 * Math.PI / 180, TMAX = 60 * Math.PI / 180;
    const curved = i => Math.abs(turn[i]) > TMIN && Math.abs(turn[i]) < TMAX;
    const runs = [];
    let i = 0;
    while (i < n) {
      if (!curved(i)) { i++; continue; }
      const sign = Math.sign(turn[i]);
      let j = i, sweep = 0;
      while (j < n && curved(j) && Math.sign(turn[j]) === sign) { sweep += turn[j]; j++; }
      const abs = Math.abs(sweep);
      if (j - i >= 3 && abs >= 15 * Math.PI / 180 && abs <= 165 * Math.PI / 180) runs.push([i, j - 1]);
      i = j;
    }
    return runs;
  }

  // Auto-detect fillet arcs across the outline, traced holes and sections, and
  // convert each clean circular run into a live fillet-arc entity. Returns the
  // number converted. (Mirrors convertAllRoundHoles for the outline.)
  detectFillets() {
    const candidates = [];
    const scan = loop => {
      const pts = this._loop(loop);
      if (!pts || pts.length < 8) return;
      for (const [lo, hi] of this._arcRuns(pts)) candidates.push({ loop, lo, hi });
    };
    scan(-1);
    for (let h = 0; h < this.holes.length; h++) scan(h);
    for (let s = 1; s < this.sections.length; s++) if (this.sections[s].pts) scan(REGION_LOOP_BASE + s);
    if (!candidates.length) return 0;
    // A detected run includes its two tangent-transition vertices; trim them so
    // they become the straight-edge anchors the fillet math reads from.
    for (const c of candidates) {
      if (c.hi - c.lo + 1 >= 5) { c.lo += 1; c.hi -= 1; }
    }
    this.pushUndo();
    // Convert back-to-front within each loop so a splice never shifts an
    // as-yet-unprocessed (lower-index) candidate on the same loop.
    candidates.sort((a, b) => a.loop !== b.loop ? b.loop - a.loop : b.lo - a.lo);
    let count = 0;
    for (const c of candidates) {
      if (this._makeTangentSpan(c.loop, c.lo, c.hi, { auto: true }).ok) count++;
    }
    if (!count) { this.undoStack.pop(); return 0; }
    this.selection = null;
    this.selectedVerts = [];
    if (this.cb.onSectionsChanged) this.cb.onSectionsChanged();
    this._notifyAnnos();
    this._notifySelect();
    this._changed();
    return count;
  }

  // The arc entity owning the current selection span, or null.
  _selectedArc() {
    const span = this._selectionSpan(2);
    if (!span) return null;
    const len = span.hi - span.lo + 1;
    return this.arcs.find(a => a.loop === span.loop && a.lo === span.lo && a.len === len) || null;
  }

  // Re-radius the fillet arc under the selection (persistent path). Falls back
  // to the one-shot _lastArc re-fit when the selection isn't a live arc.
  setArcRadius(rMm) {
    if (!(rMm > 0)) return false;
    const arc = this._selectedArc();
    if (arc) {
      this.pushUndo();
      arc.r = Math.round(rMm * 100) / 100;
      this._reprojectArcsLive();
      this._reselectRun(arc.loop, arc.lo, arc.len);
      this._notifySelect();
      this._changed();
      return true;
    }
    return this.setSelectedArcRadius(rMm);
  }

  // Release the selected fillet arc back to plain, independently-editable
  // points (keeps the current shape, drops the live-tangent behaviour).
  releaseSelectedArc() {
    const arc = this._selectedArc();
    if (!arc) return false;
    this.pushUndo();
    this.arcs = this.arcs.filter(a => a !== arc);
    this._pruneArcConstraints();
    this._notifyAnnos();
    this._changed();
    return true;
  }

  // Collapse the selected span to a straight segment between its two extreme
  // points, removing (and stashing) the interior points. Reversible via
  // releaseSelectedLine. Returns { ok, removed } or { ok:false, reason }.
  straightenSelection() {
    const span = this._selectionSpan(2);
    if (!span) return { ok: false, reason: 'Ctrl-click two points on one outline first.' };
    const { loop, lo, hi, pts } = span;
    if (hi - lo < 1) return { ok: false, reason: 'Pick two separated points.' };
    if (loop === -1 && pts.length - (hi - lo - 1) < 3) {
      return { ok: false, reason: 'That would collapse the outline below a triangle.' };
    }
    this.pushUndo();
    const stash = pts.slice(lo + 1, hi).map(p => ({ x: p.x, y: p.y }));
    // Drop any managed line/arc overlapping this loop's edited region.
    this.lines = this.lines.filter(l => l.loop !== loop);
    this.arcs = this.arcs.filter(a => a.loop !== loop || a.lo + a.len <= lo || a.lo > hi);
    this._pruneArcConstraints();
    this._refsOp({ op: 'splice', loop, lo: lo + 1, removed: hi - lo - 1, added: 0 }, pts.length);
    pts.splice(lo + 1, hi - lo - 1);
    this._reselectRun(loop, lo, 2);
    this.lines.push({ loop, lo, len: 2, stash });
    if (this.cb.onSectionsChanged) this.cb.onSectionsChanged();
    this._notifyAnnos();
    this._notifySelect();
    this._changed();
    return { ok: true, removed: stash.length };
  }

  // The line entity owning the current 2-point selection span, or null.
  _selectedLine() {
    const span = this._selectionSpan(2);
    if (!span) return null;
    if (span.hi - span.lo !== 1) return null;
    return this.lines.find(l => l.loop === span.loop && l.lo === span.lo) || null;
  }

  // Restore a straightened segment's stashed interior points.
  releaseSelectedLine() {
    const line = this._selectedLine();
    if (!line) return false;
    this.pushUndo();
    if (line.stash && line.stash.length) {
      const pts = this._loop(line.loop);
      this._refsOp({ op: 'splice', loop: line.loop, lo: line.lo + 1, removed: 0, added: line.stash.length }, pts.length);
      pts.splice(line.lo + 1, 0, ...line.stash.map(p => ({ x: p.x, y: p.y })));
      this._reselectRun(line.loop, line.lo, line.stash.length + 2);
    }
    this.lines = this.lines.filter(l => l !== line);
    if (this.cb.onSectionsChanged) this.cb.onSectionsChanged();
    this._notifyAnnos();
    this._notifySelect();
    this._changed();
    return true;
  }

  // Points along the arc of circle (cx,cy,r) from A to B, choosing the sweep
  // whose midpoint is nearest `nearMid`. Spacing ~ chord tolerance.
  _arcPoints(cx, cy, r, A, B, nearMid) {
    let a0 = Math.atan2(A.y - cy, A.x - cx);
    let a1 = Math.atan2(B.y - cy, B.x - cx);
    const norm = a => { while (a <= -Math.PI) a += 2 * Math.PI; while (a > Math.PI) a -= 2 * Math.PI; return a; };
    let sweep = norm(a1 - a0);
    // Test the midpoint of this sweep against nearMid; flip if the other way is closer.
    const mAng = a0 + sweep / 2;
    const mPt = { x: cx + r * Math.cos(mAng), y: cy + r * Math.sin(mAng) };
    const mPtAlt = { x: cx + r * Math.cos(mAng + Math.PI), y: cy + r * Math.sin(mAng + Math.PI) };
    if (nearMid && Math.hypot(mPtAlt.x - nearMid.x, mPtAlt.y - nearMid.y) <
        Math.hypot(mPt.x - nearMid.x, mPt.y - nearMid.y)) {
      sweep = sweep > 0 ? sweep - 2 * Math.PI : sweep + 2 * Math.PI;
    }
    const arcLen = Math.abs(sweep) * r;
    const n = Math.max(2, Math.min(200, Math.round(arcLen / 0.5)));
    const out = [];
    for (let k = 0; k <= n; k++) {
      const a = a0 + sweep * (k / n);
      out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    return out;
  }

  // Insert a midpoint on every edge of the selected span (add detail).
  densifySelection() {
    const span = this._selectionSpan(2);
    if (!span) return false;
    const { loop, lo, hi, pts } = span;
    this.pushUndo();
    const dense = [pts[lo]];
    for (let i = lo; i < hi; i++) {
      const a = pts[i], b = pts[i + 1];
      dense.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, b);
    }
    this._refsOp({ op: 'splice', loop, lo, removed: hi - lo + 1, added: dense.length }, pts.length);
    pts.splice(lo, hi - lo + 1, ...dense);
    this._reselectRun(loop, lo, dense.length);
    if (this.cb.onSectionsChanged) this.cb.onSectionsChanged();
    this._notifySelect();
    this._changed();
    return true;
  }

  // Thin the selected span with Douglas–Peucker (keep endpoints).
  simplifySelection(tolMm = 0.3) {
    const span = this._selectionSpan(3);
    if (!span) return false;
    const { loop, lo, hi, pts } = span;
    const run = pts.slice(lo, hi + 1);
    const keep = new Uint8Array(run.length);
    keep[0] = keep[run.length - 1] = 1;
    const stack = [[0, run.length - 1]];
    while (stack.length) {
      const [s, e] = stack.pop();
      const a = run[s], b = run[e];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1e-9;
      let maxD = 0, maxI = -1;
      for (let i = s + 1; i < e; i++) {
        const d = Math.abs(dx * (a.y - run[i].y) - (a.x - run[i].x) * dy) / len;
        if (d > maxD) { maxD = d; maxI = i; }
      }
      if (maxD > tolMm) { keep[maxI] = 1; stack.push([s, maxI], [maxI, e]); }
    }
    const kept = run.filter((_, i) => keep[i]);
    if (kept.length === run.length) return false;
    this.pushUndo();
    this._refsOp({ op: 'splice', loop, lo, removed: hi - lo + 1, added: kept.length }, pts.length);
    pts.splice(lo, hi - lo + 1, ...kept);
    this._reselectRun(loop, lo, kept.length);
    if (this.cb.onSectionsChanged) this.cb.onSectionsChanged();
    this._notifySelect();
    this._changed();
    return true;
  }

  // Screen position/radius of a circle hole (CSS px) for UI overlays.
  circleScreenPos(idx) {
    const c = this.circles[idx];
    if (!c) return null;
    const p = this._mmToScreen({ x: c.cx, y: c.cy });
    return { x: p.x, y: p.y, r: (c.d / 2) * this.pxPerMm * this.vp.scale };
  }

  selectedCircle() {
    if (this.selection && this.selection.type === 'circle') {
      return { ...structuredClone(this.circles[this.selection.idx]), idx: this.selection.idx };
    }
    return null;
  }

  updateSelectedCircle(props) {
    const sel = this.selection;
    if (!sel || sel.type !== 'circle') return;
    Object.assign(this.circles[sel.idx], structuredClone(props));
    // Next placed hole inherits the last edited one (position excluded).
    const { cx, cy, ...rest } = this.circles[sel.idx];
    this.holeTemplate = structuredClone(rest);
    this._changed();
  }

  _notifySelect() {
    if (this.cb.onSelect) this.cb.onSelect(this.selection);
  }

  _changed(throttled = false) {
    // Keep fillet arcs tangent after any change (except while a constrained
    // drag is previewing via the ghost — the release commit handles it then).
    if (!this._ghost) this._reprojectArcsLive();
    this.draw();
    if (this.cb.onChange) this.cb.onChange(throttled);
  }

  // ---- rendering ----

  draw() {
    const ctx = prepareCanvas(this.canvas);
    const { w: vw, h: vh } = this.vp.viewSize();
    ctx.clearRect(0, 0, vw, vh);
    if (!this.rectified) return;

    const s = this.vp.scale;
    ctx.save();
    ctx.translate(this.vp.ox, this.vp.oy);
    ctx.scale(s, s);
    ctx.imageSmoothingEnabled = s < 4;
    ctx.drawImage(this.rectified, 0, 0);
    if (this.showMask && this.maskOverlay) ctx.drawImage(this.maskOverlay, 0, 0);
    ctx.restore();

    const drawLoop = (pts, loopIdx, stroke, fill) => {
      if (pts.length < 2) return;
      const loopSelected = this.selection && this.selection.type === 'holeloop' &&
        this.selection.loop === loopIdx;
      ctx.beginPath();
      const p0 = this._mmToScreen(pts[0]);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < pts.length; i++) {
        const p = this._mmToScreen(pts[i]);
        ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      if (fill) { ctx.fillStyle = fill; ctx.fill('evenodd'); }
      ctx.strokeStyle = loopSelected ? '#ffd257' : stroke;
      ctx.lineWidth = loopSelected ? 3 : 2;
      ctx.stroke();

      const showVerts = this.mode === 'edit' && this.showPoints && s * this.pxPerMm > 0.5;
      if (!showVerts) return;
      for (let i = 0; i < pts.length; i++) {
        const p = this._mmToScreen(pts[i]);
        const sel = this.selection && this.selection.type === 'vertex' &&
          this.selection.loop === loopIdx && this.selection.idx === i;
        const multi = this.selectedVerts.length &&
          this.selectedVerts.some(v => v.loop === loopIdx && v.idx === i);
        ctx.beginPath();
        ctx.arc(p.x, p.y, sel || multi ? VERT_R + 2 : VERT_R, 0, Math.PI * 2);
        ctx.fillStyle = multi ? '#53a9ff' : (sel ? '#ffd257' : '#ffffff');
        ctx.fill();
        ctx.strokeStyle = multi ? '#0c1015' : (sel ? '#8a6d00' : stroke);
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    };

    drawLoop(this.outer, -1, '#37d67a', 'rgba(55, 214, 122, 0.08)');
    for (let h = 0; h < this.holes.length; h++) {
      drawLoop(this.holes[h], h, '#ff7d5c', 'rgba(255, 125, 92, 0.12)');
    }

    // Section footprints (extra thickness regions)
    for (let sc = 1; sc < this.sections.length; sc++) {
      const sec = this.sections[sc];
      if (!sec.pts || sec.pts.length < 3) continue;
      drawLoop(sec.pts, REGION_LOOP_BASE + sc, '#3fc6d4', 'rgba(63, 198, 212, 0.10)');
      let cxm = 0, cym = 0;
      for (const p of sec.pts) { cxm += p.x; cym += p.y; }
      const ctr = this._mmToScreen({ x: cxm / sec.pts.length, y: cym / sec.pts.length });
      ctx.font = 'bold 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#3fc6d4';
      const zb = sec.zBase || 0;
      ctx.fillText(
        `${sec.name || 'Section'} · ${zb > 0 ? `${zb}–${(zb + sec.thickness).toFixed(1)}` : sec.thickness} mm`,
        ctr.x, ctr.y
      );
    }

    // In-progress region draft
    if (this._draftRegion && this._draftRegion.length) {
      const pts = this._draftRegion.map(p => this._mmToScreen(p));
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.strokeStyle = '#3fc6d4';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      for (const p of pts) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, VERT_R, 0, Math.PI * 2);
        ctx.fillStyle = '#3fc6d4';
        ctx.fill();
      }
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#3fc6d4';
      const last = pts[pts.length - 1];
      ctx.fillText(
        pts.length < 3 ? 'click to add points…' : 'double-click or Enter to close',
        last.x + 10, last.y - 10
      );
    }

    // Manual screw holes
    for (let i = 0; i < this.circles.length; i++) {
      const c = this.circles[i];
      const ctr = this._mmToScreen({ x: c.cx, y: c.cy });
      const r = (c.d / 2) * this.pxPerMm * s;
      const sel = this.selection && this.selection.type === 'circle' && this.selection.idx === i;
      const col = sel ? '#ffd257' : '#78aaff';
      ctx.beginPath();
      ctx.arc(ctr.x, ctr.y, r, 0, Math.PI * 2);
      ctx.fillStyle = sel ? 'rgba(255, 210, 87, 0.20)' : 'rgba(120, 170, 255, 0.16)';
      ctx.fill();
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      if (c.type === 'blind') ctx.setLineDash([5, 4]); // blind bore: dashed
      ctx.stroke();
      ctx.setLineDash([]);
      // Recess circle (countersink / counterbore), dashed
      const maxDia = this._holeMaxDia(c);
      if (maxDia > c.d + 0.01) {
        ctx.beginPath();
        ctx.arc(ctr.x, ctr.y, (maxDia / 2) * this.pxPerMm * s, 0, Math.PI * 2);
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // Center cross
      ctx.beginPath();
      ctx.moveTo(ctr.x - 6, ctr.y); ctx.lineTo(ctr.x + 6, ctr.y);
      ctx.moveTo(ctr.x, ctr.y - 6); ctx.lineTo(ctr.x, ctr.y + 6);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // Feature label ("CS↑", "CB↓", "BL↑"), plus screw size if set
      if (c.type !== 'through' || (c.screw && c.screw.std !== 'custom')) {
        const abbr = { through: '', blind: 'BL', cs: 'CS', cb: 'CB' }[c.type] || '';
        const arrow = c.type === 'through' ? '' : (c.side === 'bottom' ? '↓' : '↑');
        const sizeTxt = c.screw && c.screw.std !== 'custom' ? c.screw.size : '';
        const label = [abbr + arrow, sizeTxt].filter(Boolean).join(' ');
        ctx.font = 'bold 11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = col;
        ctx.fillText(label, ctr.x, ctr.y + Math.max(r, 8) + 4);
      }
    }

    // Constrained-drag ghost: where the solver will put things on release.
    if (this._ghost) this._drawGhost(ctx);

    // Live fillet arcs + managed straight lines, then measurement/constraint overlays.
    this._drawArcs(ctx);
    this._drawLines(ctx);
    this._drawMeasurements(ctx);
    this._drawConstraints(ctx);

    // Picked/pending entities + the snap marker (measure/constrain modes).
    if (this.mode === 'measure' && this._pendingPick) {
      this._highlightRef(ctx, this._pendingPick, MEASURE_COL);
    }
    if (this.mode === 'constrain') {
      for (const r of this._picks) this._highlightRef(ctx, r, '#ffd257');
    }
    if ((this.mode === 'measure' || this.mode === 'constrain') &&
        this._hoverSnap && this._hoverSnap.pos && !this.panning) {
      const { x, y } = this._hoverSnap.pos;
      const col = this.mode === 'measure' ? MEASURE_COL : CONSTRAIN_COL;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 1.6, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
    }

    // Marquee selection rectangle
    if (this._marquee) {
      const m = this._marquee;
      const x = Math.min(m.x0, m.x1), y = Math.min(m.y0, m.y1);
      const w = Math.abs(m.x1 - m.x0), h = Math.abs(m.y1 - m.y0);
      ctx.fillStyle = 'rgba(83, 169, 255, 0.12)';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = '#53a9ff';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
    }

    if (this.cb.onDraw) this.cb.onDraw();
  }

  // ---- measurement / constraint rendering ----

  _fmtLen(mm) {
    return this.cb.formatLen ? this.cb.formatLen(mm) : `${mm.toFixed(2)} mm`;
  }

  // Small labelled pill, centred on (x, y).
  _dimLabel(ctx, x, y, text, color) {
    ctx.font = 'bold 11px system-ui, sans-serif';
    const w = ctx.measureText(text).width + 10;
    const h = 16;
    ctx.fillStyle = 'rgba(12, 16, 21, 0.85)';
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - h / 2, w, h, 4);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
  }

  // Tint each live fillet arc's owned run + a centre tick, so it reads as a
  // managed tangent arc rather than plain vertices.
  _drawArcs(ctx) {
    if (!this.arcs.length) return;
    const selArc = this._selectedArc();
    for (const arc of this.arcs) {
      const pts = this._loop(arc.loop);
      if (!pts || arc.lo + arc.len > pts.length) continue;
      ctx.beginPath();
      const p0 = this._mmToScreen(pts[arc.lo]);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < arc.len; i++) {
        const p = this._mmToScreen(pts[arc.lo + i]);
        ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = arc === selArc ? '#ffd257' : '#8bd6c0';
      ctx.lineWidth = arc === selArc ? 3.5 : 2.5;
      ctx.globalAlpha = 0.85;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  // Tint each managed straight segment so it reads as a locked line.
  _drawLines(ctx) {
    if (!this.lines.length) return;
    const selLine = this._selectedLine();
    for (const line of this.lines) {
      const pts = this._loop(line.loop);
      if (!pts || line.lo + 1 >= pts.length) continue;
      const a = this._mmToScreen(pts[line.lo]);
      const b = this._mmToScreen(pts[line.lo + 1]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = line === selLine ? '#ffd257' : '#c7b4ff';
      ctx.lineWidth = line === selLine ? 3.5 : 2.5;
      ctx.globalAlpha = 0.85;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  _drawMeasurements(ctx) {
    if (!this.measurements.length) return;
    const geo = this._geo();
    const S = p => this._mmToScreen(p);
    ctx.lineWidth = 1.5;
    for (const m of this.measurements) {
      const info = measureInfo(m, geo);
      if (!info) continue;
      ctx.strokeStyle = MEASURE_COL;
      if (info.type === 'p2p' || info.type === 'elen') {
        const a = S(info.a), b = S(info.b);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        ctx.stroke();
        for (const p of [a, b]) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
          ctx.fillStyle = MEASURE_COL;
          ctx.fill();
        }
        this._dimLabel(ctx, (a.x + b.x) / 2, (a.y + b.y) / 2 - 12, this._fmtLen(info.d), MEASURE_COL);
      } else if (info.type === 'p2e') {
        const p = S(info.p), f = S(info.foot);
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y); ctx.lineTo(f.x, f.y);
        ctx.stroke();
        ctx.setLineDash([]);
        for (const q of [p, f]) {
          ctx.beginPath();
          ctx.arc(q.x, q.y, 2.5, 0, Math.PI * 2);
          ctx.fillStyle = MEASURE_COL;
          ctx.fill();
        }
        this._dimLabel(ctx, (p.x + f.x) / 2, (p.y + f.y) / 2 - 12, this._fmtLen(info.d), MEASURE_COL);
      } else if (info.type === 'e2e') {
        const mA = S({ x: (info.A.a.x + info.A.b.x) / 2, y: (info.A.a.y + info.A.b.y) / 2 });
        const mB = S({ x: (info.B.a.x + info.B.b.x) / 2, y: (info.B.a.y + info.B.b.y) / 2 });
        for (const E of [info.A, info.B]) {
          const a = S(E.a), b = S(E.b);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
          ctx.lineWidth = 3;
          ctx.globalAlpha = 0.5;
          ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.lineWidth = 1.5;
        }
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(mA.x, mA.y); ctx.lineTo(mB.x, mB.y);
        ctx.stroke();
        ctx.setLineDash([]);
        const txt = info.gap !== null
          ? `${info.angle.toFixed(1)}° · gap ${this._fmtLen(info.gap)}`
          : `${info.angle.toFixed(1)}°`;
        this._dimLabel(ctx, (mA.x + mB.x) / 2, (mA.y + mB.y) / 2 - 12, txt, MEASURE_COL);
      } else if (info.type === 'rad') {
        const c = S({ x: info.cx, y: info.cy });
        const r = info.r * this.pxPerMm * this.vp.scale;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(c.x, c.y);
        ctx.lineTo(c.x + r * Math.SQRT1_2, c.y - r * Math.SQRT1_2);
        ctx.stroke();
        this._dimLabel(ctx, c.x, c.y - r - 12, `⌀ ${this._fmtLen(info.r * 2)}`, MEASURE_COL);
      }
    }
  }

  _drawConstraints(ctx) {
    if (!this.constraints.length) return;
    const geo = this._geo();
    const edgeMid = ref => {
      const e = resolveEdge(ref, geo);
      return e ? this._mmToScreen({ x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 }) : null;
    };
    const ptPos = ref => {
      const p = resolvePoint(ref.kind === 'circle' ? { kind: 'center', idx: ref.idx } : ref, geo);
      return p ? this._mmToScreen(p) : null;
    };
    const GLYPH = {
      h: 'H', v: 'V', perp: '⊥', para: '∥', equal: '=', collin: '⋯',
      conc: '◎', anchor: '⚓',
    };
    for (const c of this.constraints) {
      let text = GLYPH[c.type] || '?';
      if (c.type === 'len' || c.type === 'dist') text = this._fmtLen(c.value);
      if (c.type === 'angle') text = `${c.value}°`;
      // Badge position: between the involved entities.
      const spots = c.refs
        .map(r => r.kind === 'edge' ? edgeMid(r) : ptPos(r))
        .filter(Boolean);
      if (!spots.length) continue;
      const x = spots.reduce((s, p) => s + p.x, 0) / spots.length;
      const y = spots.reduce((s, p) => s + p.y, 0) / spots.length;
      if (spots.length === 2) {
        ctx.setLineDash([2, 4]);
        ctx.strokeStyle = CONSTRAIN_COL;
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        ctx.moveTo(spots[0].x, spots[0].y);
        ctx.lineTo(spots[1].x, spots[1].y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
      this._dimLabel(ctx, x, y + 12, text, CONSTRAIN_COL);
    }
  }

  _highlightRef(ctx, ref, color) {
    const geo = this._geo();
    ctx.strokeStyle = color;
    if (ref.kind === 'arcent') {
      const c = geo.arc(ref.id);
      if (!c) return;
      const ctr = this._mmToScreen({ x: c.cx, y: c.cy });
      ctx.beginPath();
      ctx.arc(ctr.x, ctr.y, c.r * this.pxPerMm * this.vp.scale, 0, Math.PI * 2);
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }
    if (ref.kind === 'edge') {
      const e = resolveEdge(ref, geo);
      if (!e) return;
      const a = this._mmToScreen(e.a), b = this._mmToScreen(e.b);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.lineWidth = 4;
      ctx.globalAlpha = 0.6;
      ctx.stroke();
      ctx.globalAlpha = 1;
      return;
    }
    if (ref.kind === 'circle' || ref.kind === 'holeloop') {
      const c = ref.kind === 'circle' ? this.circles[ref.idx] : null;
      if (c) {
        const ctr = this._mmToScreen({ x: c.cx, y: c.cy });
        ctx.beginPath();
        ctx.arc(ctr.x, ctr.y, (c.d / 2) * this.pxPerMm * this.vp.scale + 3, 0, Math.PI * 2);
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      return;
    }
    const p = resolvePoint(ref, geo);
    if (!p) return;
    const s = this._mmToScreen(p);
    ctx.beginPath();
    ctx.arc(s.x, s.y, VERT_R + 3.5, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  _drawGhost(ctx) {
    const g = this._ghost;
    const stroke = loop => {
      if (!loop || loop.length < 2) return;
      ctx.beginPath();
      const p0 = this._mmToScreen(loop[0]);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < loop.length; i++) {
        const p = this._mmToScreen(loop[i]);
        ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      ctx.stroke();
    };
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 5]);
    stroke(g.outer);
    for (const h of g.holes) stroke(h);
    for (let s = 1; s < g.sections.length; s++) stroke(g.sections[s].pts);
    for (const c of g.circles) {
      const ctr = this._mmToScreen({ x: c.cx, y: c.cy });
      ctx.beginPath();
      ctx.arc(ctr.x, ctr.y, (c.d / 2) * this.pxPerMm * this.vp.scale, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
}
