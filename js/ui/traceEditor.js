// Step 2 editor: show the rectified paper, overlay the traced outline and
// holes, and let the user fix the trace: drag vertices, click an edge to
// insert a vertex, alt/right-click to delete one, place and adjust circular
// holes, with undo.

import { Viewport, prepareCanvas } from './viewport.js';

const VERT_R = 4.5;
const HIT_R = 8;

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

    this.mode = 'edit';      // 'edit' | 'addhole' | 'pan'
    this.newHoleDia = 5;
    this.selection = null;   // {type:'vertex', loop, idx} | {type:'circle', idx}
    this.dragging = false;
    this.panning = false;
    this.lastPos = null;
    this.undoStack = [];

    canvas.addEventListener('pointerdown', e => this._down(e));
    canvas.addEventListener('pointermove', e => this._move(e));
    canvas.addEventListener('pointerup', e => this._up(e));
    canvas.addEventListener('pointercancel', e => this._up(e));
    canvas.addEventListener('dblclick', () => { this.vp.fit(); this.draw(); });
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
    this._notifySelect();
    this.draw();
  }

  setCircles(circles) {
    this.circles = circles;
    this.draw();
  }

  getTrace() {
    return { outer: this.outer, holes: this.holes, circles: this.circles };
  }

  setMode(mode) {
    this.mode = mode;
    this.canvas.style.cursor = mode === 'pan' ? 'grab' : 'default';
    this.draw();
  }

  // ---- undo ----

  _snapshot() {
    return {
      outer: this.outer.map(p => ({ ...p })),
      holes: this.holes.map(h => h.map(p => ({ ...p }))),
      circles: this.circles.map(c => ({ ...c })),
    };
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
    this.selection = null;
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
    return loopIdx === -1 ? this.outer : this.holes[loopIdx];
  }

  // ---- hit testing ----

  _hitVertex(sp) {
    const check = (loopIdx, pts) => {
      for (let i = 0; i < pts.length; i++) {
        const v = this._mmToScreen(pts[i]);
        if (Math.hypot(v.x - sp.x, v.y - sp.y) <= HIT_R) {
          return { type: 'vertex', loop: loopIdx, idx: i };
        }
      }
      return null;
    };
    for (let h = 0; h < this.holes.length; h++) {
      const r = check(h, this.holes[h]);
      if (r) return r;
    }
    return check(-1, this.outer);
  }

  _hitCircle(sp) {
    for (let i = 0; i < this.circles.length; i++) {
      const c = this.circles[i];
      const ctr = this._mmToScreen({ x: c.cx, y: c.cy });
      const rimR = (c.d / 2) * this.pxPerMm * this.vp.scale;
      const d = Math.hypot(ctr.x - sp.x, ctr.y - sp.y);
      if (d <= Math.max(HIT_R, 10) || Math.abs(d - rimR) <= HIT_R) {
        return { type: 'circle', idx: i };
      }
    }
    return null;
  }

  _hitEdge(sp) {
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

    if (this.mode === 'addhole' && e.button === 0) {
      const mm = this._screenToMm(sp);
      this.pushUndo();
      this.circles.push({ cx: mm.x, cy: mm.y, d: this.newHoleDia });
      this.selection = { type: 'circle', idx: this.circles.length - 1 };
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

    if (vHit) {
      this.selection = vHit;
      this.pushUndo();
      this.dragging = true;
      this._notifySelect();
      this.draw();
      return;
    }
    if (cHit) {
      this.selection = cHit;
      this.pushUndo();
      this.dragging = true;
      this._notifySelect();
      this.draw();
      return;
    }

    const eHit = this._hitEdge(sp);
    if (eHit) {
      // Insert a vertex on the edge and start dragging it.
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

    this.selection = null;
    this.panning = true;
    this._notifySelect();
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
    if (this.dragging && this.selection) {
      const mm = this._screenToMm(sp);
      const maxX = this.rectified.width / this.pxPerMm;
      const maxY = this.rectified.height / this.pxPerMm;
      mm.x = Math.max(0, Math.min(maxX, mm.x));
      mm.y = Math.max(0, Math.min(maxY, mm.y));
      if (this.selection.type === 'vertex') {
        const pts = this._loop(this.selection.loop);
        pts[this.selection.idx] = mm;
      } else if (this.selection.type === 'circle') {
        const c = this.circles[this.selection.idx];
        c.cx = mm.x; c.cy = mm.y;
      }
      this._changed(true);
      return;
    }
    if (this.mode === 'edit') {
      const hit = this._hitVertex(sp) || this._hitCircle(sp) || this._hitEdge(sp);
      this.canvas.style.cursor = hit ? 'pointer' : 'default';
    }
  }

  _up() {
    if (this.dragging) this._changed();
    this.dragging = false;
    this.panning = false;
    this.lastPos = null;
  }

  // ---- edit ops ----

  _deleteVertex(sel) {
    const pts = this._loop(sel.loop);
    if (sel.loop === -1 && pts.length <= 3) return; // outline must stay a polygon
    this.pushUndo();
    pts.splice(sel.idx, 1);
    if (sel.loop >= 0 && pts.length < 3) this.holes.splice(sel.loop, 1);
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
    if (!this.selection) return;
    if (this.selection.type === 'vertex') this._deleteVertex(this.selection);
    else if (this.selection.type === 'circle') this._deleteCircle(this.selection.idx);
  }

  // Delete the whole loop containing the selection (traced hole or circle).
  deleteSelectedHole() {
    if (!this.selection) return;
    if (this.selection.type === 'circle') { this._deleteCircle(this.selection.idx); return; }
    if (this.selection.type === 'vertex' && this.selection.loop >= 0) {
      this.pushUndo();
      this.holes.splice(this.selection.loop, 1);
      this.selection = null;
      this._notifySelect();
      this._changed();
    }
  }

  selectedCircle() {
    if (this.selection && this.selection.type === 'circle') {
      return { ...this.circles[this.selection.idx], idx: this.selection.idx };
    }
    return null;
  }

  updateSelectedCircle(props) {
    const sel = this.selection;
    if (!sel || sel.type !== 'circle') return;
    Object.assign(this.circles[sel.idx], props);
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
      ctx.beginPath();
      const p0 = this._mmToScreen(pts[0]);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < pts.length; i++) {
        const p = this._mmToScreen(pts[i]);
        ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      if (fill) { ctx.fillStyle = fill; ctx.fill('evenodd'); }
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 2;
      ctx.stroke();

      const showVerts = this.mode === 'edit' && s * this.pxPerMm > 0.5;
      if (!showVerts) return;
      for (let i = 0; i < pts.length; i++) {
        const p = this._mmToScreen(pts[i]);
        const sel = this.selection && this.selection.type === 'vertex' &&
          this.selection.loop === loopIdx && this.selection.idx === i;
        ctx.beginPath();
        ctx.arc(p.x, p.y, sel ? VERT_R + 2 : VERT_R, 0, Math.PI * 2);
        ctx.fillStyle = sel ? '#ffd257' : '#ffffff';
        ctx.fill();
        ctx.strokeStyle = sel ? '#8a6d00' : stroke;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    };

    drawLoop(this.outer, -1, '#37d67a', 'rgba(55, 214, 122, 0.08)');
    for (let h = 0; h < this.holes.length; h++) {
      drawLoop(this.holes[h], h, '#ff7d5c', 'rgba(255, 125, 92, 0.12)');
    }

    // Manual circular holes
    for (let i = 0; i < this.circles.length; i++) {
      const c = this.circles[i];
      const ctr = this._mmToScreen({ x: c.cx, y: c.cy });
      const r = (c.d / 2) * this.pxPerMm * s;
      const sel = this.selection && this.selection.type === 'circle' && this.selection.idx === i;
      ctx.beginPath();
      ctx.arc(ctr.x, ctr.y, r, 0, Math.PI * 2);
      ctx.fillStyle = sel ? 'rgba(255, 210, 87, 0.20)' : 'rgba(120, 170, 255, 0.16)';
      ctx.fill();
      ctx.strokeStyle = sel ? '#ffd257' : '#78aaff';
      ctx.lineWidth = 2;
      ctx.stroke();
      // Center cross
      ctx.beginPath();
      ctx.moveTo(ctr.x - 6, ctr.y); ctx.lineTo(ctr.x + 6, ctr.y);
      ctx.moveTo(ctr.x, ctr.y - 6); ctx.lineTo(ctr.x, ctr.y + 6);
      ctx.strokeStyle = sel ? '#ffd257' : '#78aaff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}
