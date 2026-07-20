// Step 2 editor: show the rectified paper, overlay the traced outline and
// holes, and let the user fix the trace: drag vertices, click an edge to
// insert a vertex, alt/right-click to delete one, place and adjust circular
// holes, with undo.

import { Viewport, prepareCanvas } from './viewport.js';
import { pointInPolygon, fitCircle, resampleClosed } from '../contour.js';

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
    return structuredClone({ outer: this.outer, holes: this.holes, circles: this.circles });
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

  _hitCircle(sp) {
    for (let i = 0; i < this.circles.length; i++) {
      const c = this.circles[i];
      const ctr = this._mmToScreen({ x: c.cx, y: c.cy });
      const rimR = (c.d / 2) * this.pxPerMm * this.vp.scale;
      const recessR = (this._holeMaxDia(c) / 2) * this.pxPerMm * this.vp.scale;
      const d = Math.hypot(ctr.x - sp.x, ctr.y - sp.y);
      if (d <= Math.max(HIT_R, 10) || Math.abs(d - rimR) <= HIT_R ||
          Math.abs(d - recessR) <= HIT_R) {
        return { type: 'circle', idx: i };
      }
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

    // Inside a traced hole: select and drag the whole loop.
    const mm = this._screenToMm(sp);
    for (let h = 0; h < this.holes.length; h++) {
      if (pointInPolygon(mm, this.holes[h])) {
        this.selection = { type: 'holeloop', loop: h };
        this.pushUndo();
        this.dragging = true;
        this._lastMm = mm;
        this._notifySelect();
        this.draw();
        return;
      }
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
      } else if (this.selection.type === 'circle') {
        const c = this.circles[this.selection.idx];
        c.cx = mm.x; c.cy = mm.y;
      } else if (this.selection.type === 'holeloop' && this._lastMm) {
        const dx = mm.x - this._lastMm.x, dy = mm.y - this._lastMm.y;
        for (const p of this.holes[this.selection.loop]) { p.x += dx; p.y += dy; }
        this._lastMm = mm;
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
      this._changed();
    }
    this.dragging = false;
    this.panning = false;
    this.lastPos = null;
    this._lastMm = null;
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
    else if (this.selection.type === 'holeloop') this.deleteSelectedHole();
  }

  // Delete the whole loop containing the selection (traced hole or circle).
  deleteSelectedHole() {
    if (!this.selection) return;
    if (this.selection.type === 'circle') { this._deleteCircle(this.selection.idx); return; }
    const loop = this.selection.type === 'holeloop' ? this.selection.loop
      : (this.selection.type === 'vertex' ? this.selection.loop : -1);
    if (loop >= 0) {
      this.pushUndo();
      this.holes.splice(loop, 1);
      this.selection = null;
      this._notifySelect();
      this._changed();
    }
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

    if (this.cb.onDraw) this.cb.onDraw();
  }
}
