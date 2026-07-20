// Step 2 editor: show the rectified paper, overlay the traced outline and
// holes, and let the user fix the trace: drag vertices, click an edge to
// insert a vertex, alt/right-click to delete one, place and adjust circular
// holes, with undo.

import { Viewport, prepareCanvas } from './viewport.js';
import { pointInPolygon, fitCircle, resampleClosed } from '../contour.js';

const VERT_R = 4.5;
const HIT_R = 8;
// Extra sections ("regions") reuse the loop-addressing scheme: loop index
// -1 = outer outline, 0..n-1 = traced holes, REGION_LOOP_BASE + i = the
// footprint of sections[i] (i >= 1; sections[0] is the base = outer).
const REGION_LOOP_BASE = 1000;

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

  setTrace(outer, holes, keepUndo = false) {
    this.outer = outer || [];
    this.holes = holes || [];
    if (!keepUndo) this.undoStack.length = 0;
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
    this.mode = mode;
    this.canvas.style.cursor = mode === 'pan' ? 'grab'
      : mode === 'region' ? 'crosshair' : 'default';
    this.draw();
  }

  // ---- undo ----

  _snapshot() {
    return structuredClone({
      outer: this.outer, holes: this.holes, circles: this.circles,
      sections: this.sections,
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
      this._changed(true);
      return;
    }
    if (this.mode === 'edit') this._updateHoverCursor(sp);
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
    pts.splice(sel.idx, 1);
    if (pts.length < 3) {
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
      const kept = pts.filter((_, i) => !drop.has(i));
      pts.length = 0;
      pts.push(...kept);
    }
    // Phase 2: drop collapsed loops from the back so indices stay valid.
    for (const h of collapseHoles.sort((a, b) => b - a)) this.holes.splice(h, 1);
    for (const s of collapseSections.sort((a, b) => b - a)) this.sections.splice(s, 1);
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
    pts.splice(la.lo, la.len, ...arc);
    la.len = arc.length;
    this._reselectRun(la.loop, la.lo, arc.length);
    if (this.cb.onSectionsChanged) this.cb.onSectionsChanged();
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
}
