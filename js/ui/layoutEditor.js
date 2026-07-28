// 2D layout editor for multi-tool drawer inserts: draws the container and
// the placed tool outlines, drags items around, rotates the selection via a
// round handle (Shift snaps to 15°), and flags conflicts. Pure
// view/controller — the geometry lives in js/holders.js.

import { pointInPolygon } from '../contour.js';
import { placeLoop, layoutPockets, layoutConflicts, worldToItemLocal } from '../holders.js';

export class LayoutEditor {
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cb = callbacks; // { onChange(final), onSelect(index) }
    this.container = null; // loop, layout mm (y down)
    this.items = [];       // shared ref: [{ outer, holes, circles, name, x, y, rot, depth, thickness }]
    this.clearance = 0.5;
    this.border = 5;
    this.sel = -1;
    this.view = { scale: 2, ox: 0, oy: 0 };
    this.conflicts = { collisions: new Set(), escaped: new Set() };
    this._drag = null;
    canvas.addEventListener('pointerdown', e => this._down(e));
    canvas.addEventListener('pointermove', e => this._move(e));
    canvas.addEventListener('pointerup', e => this._up(e));
    canvas.addEventListener('pointercancel', e => this._up(e));
  }

  setLayout(container, items, clearance, border) {
    this.container = container;
    this.items = items;
    this.clearance = clearance;
    this.border = border;
    if (this.sel >= items.length) this.sel = -1;
    this.fit();
    this.refreshConflicts();
    this.draw();
  }

  fit() {
    if (!this.container) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of this.container) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const pad = 30;
    const sx = (this.canvas.width - 2 * pad) / Math.max(1, maxX - minX);
    const sy = (this.canvas.height - 2 * pad) / Math.max(1, maxY - minY);
    const s = Math.min(sx, sy);
    this.view = {
      scale: s,
      ox: (this.canvas.width - (maxX - minX) * s) / 2 - minX * s,
      oy: (this.canvas.height - (maxY - minY) * s) / 2 - minY * s,
    };
  }

  mmToScreen(p) { return { x: p.x * this.view.scale + this.view.ox, y: p.y * this.view.scale + this.view.oy }; }
  screenToMm(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) * (this.canvas.width / r.width);
    const y = (e.clientY - r.top) * (this.canvas.height / r.height);
    return { x: (x - this.view.ox) / this.view.scale, y: (y - this.view.oy) / this.view.scale };
  }

  refreshConflicts() {
    if (!this.container) return;
    const pockets = layoutPockets(this.items, this.clearance);
    this.conflicts = layoutConflicts(this.container, pockets, this.border);
    this._pockets = pockets;
  }

  _centroid(item) {
    // Placement centre is (item.x, item.y) by construction.
    return { x: item.x, y: item.y };
  }
  _itemRadius(item) {
    const placed = placeLoop(item.outer, item);
    let r = 0;
    for (const p of placed) r = Math.max(r, Math.hypot(p.x - item.x, p.y - item.y));
    return r;
  }
  _rotHandle(item) {
    const a = (((item.rot || 0) - 90) * Math.PI) / 180;
    const r = this._itemRadius(item) + 6 / this.view.scale + 4;
    return { x: item.x + r * Math.cos(a), y: item.y + r * Math.sin(a) };
  }

  // The selected item's notch marker (pocket-boundary point), if any.
  _notchAt(idx) {
    const p = this._pockets && this._pockets[idx];
    return p && p.notchAt ? p.notchAt : null;
  }

  _down(e) {
    if (!this.container) return;
    const mm = this.screenToMm(e);
    const tolPx = 12 / this.view.scale;
    if (this.sel >= 0 && this.items[this.sel]) {
      const h = this._rotHandle(this.items[this.sel]);
      if (Math.hypot(mm.x - h.x, mm.y - h.y) < tolPx) {
        this._drag = { kind: 'rotate', idx: this.sel };
        this.canvas.setPointerCapture(e.pointerId);
        return;
      }
      const nAt = this._notchAt(this.sel);
      if (nAt && Math.hypot(mm.x - nAt.x, mm.y - nAt.y) <
          Math.max(tolPx, (this.items[this.sel].notch.dia || 25) / 2)) {
        this._drag = { kind: 'notch', idx: this.sel };
        this.canvas.setPointerCapture(e.pointerId);
        return;
      }
    }
    // Topmost item under the pointer.
    for (let i = this.items.length - 1; i >= 0; i--) {
      const placed = placeLoop(this.items[i].outer, this.items[i]);
      if (pointInPolygon(mm, placed)) {
        this.sel = i;
        this._drag = { kind: 'move', idx: i, dx: this.items[i].x - mm.x, dy: this.items[i].y - mm.y };
        this.canvas.setPointerCapture(e.pointerId);
        if (this.cb.onSelect) this.cb.onSelect(i);
        this.draw();
        return;
      }
    }
    this.sel = -1;
    if (this.cb.onSelect) this.cb.onSelect(-1);
    this.draw();
  }

  _move(e) {
    if (!this._drag) return;
    const mm = this.screenToMm(e);
    const it = this.items[this._drag.idx];
    if (!it) return;
    if (this._drag.kind === 'move') {
      it.x = mm.x + this._drag.dx;
      it.y = mm.y + this._drag.dy;
    } else if (this._drag.kind === 'notch') {
      // Store in item-local coords; the pocket builder snaps it to the
      // boundary, so dragging anywhere pulls the notch to the nearest edge.
      const local = worldToItemLocal(it, mm);
      it.notch.x = local.x;
      it.notch.y = local.y;
      this._pockets = layoutPockets(this.items, this.clearance); // live marker
    } else {
      let deg = (Math.atan2(mm.y - it.y, mm.x - it.x) * 180) / Math.PI + 90;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      it.rot = ((deg % 360) + 360) % 360;
    }
    this.draw();
    if (this.cb.onChange) this.cb.onChange(false);
  }

  _up(e) {
    if (!this._drag) return;
    this._drag = null;
    this.refreshConflicts();
    this.draw();
    if (this.cb.onChange) this.cb.onChange(true);
  }

  draw() {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!this.container) return;
    const loopPath = loop => {
      ctx.beginPath();
      loop.forEach((p, i) => {
        const s = this.mmToScreen(p);
        if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
      });
      ctx.closePath();
    };

    // Container + border inset hint.
    loopPath(this.container);
    ctx.fillStyle = 'rgba(127,127,127,0.08)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(127,127,127,0.9)';
    ctx.lineWidth = 2;
    ctx.stroke();

    const pockets = this._pockets || layoutPockets(this.items, this.clearance);
    this.items.forEach((item, i) => {
      const conflicted = this.conflicts.collisions.has(i) || this.conflicts.escaped.has(i);
      const selected = i === this.sel;
      // Pocket (clearance) outline.
      const p = pockets[i] && pockets[i].pocket;
      if (p) {
        loopPath(p);
        ctx.fillStyle = conflicted ? 'rgba(239,68,68,0.15)' : 'rgba(59,130,246,0.12)';
        ctx.fill();
        ctx.strokeStyle = conflicted ? '#ef4444' : (selected ? '#3b82f6' : 'rgba(59,130,246,0.7)');
        ctx.lineWidth = selected ? 2.5 : 1.5;
        ctx.stroke();
      }
      // Tool outline + holes, thin.
      ctx.strokeStyle = conflicted ? 'rgba(239,68,68,0.8)' : 'rgba(127,127,127,0.8)';
      ctx.lineWidth = 1;
      loopPath(placeLoop(item.outer, item));
      ctx.stroke();
      for (const h of item.holes || []) { loopPath(placeLoop(h, item, item.outer)); ctx.stroke(); }
      // Name.
      const c = this.mmToScreen(this._centroid(item));
      ctx.fillStyle = conflicted ? '#ef4444' : 'rgba(127,127,127,0.95)';
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(item.name || `Tool ${i + 1}`, c.x, c.y - 4);
      // Finger-notch marker (draggable when selected).
      const nAt = pockets[i] && pockets[i].notchAt;
      if (nAt) {
        const ns = this.mmToScreen(nAt);
        const nr = ((item.notch && item.notch.dia) || 25) / 2 * this.view.scale;
        ctx.beginPath();
        ctx.arc(ns.x, ns.y, nr, 0, Math.PI * 2);
        ctx.strokeStyle = selected ? '#f59e0b' : 'rgba(245,158,11,0.6)';
        ctx.lineWidth = selected ? 2 : 1;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
        if (selected) {
          ctx.beginPath();
          ctx.arc(ns.x, ns.y, 6, 0, Math.PI * 2);
          ctx.fillStyle = '#f59e0b';
          ctx.fill();
          ctx.strokeStyle = '#fff';
          ctx.stroke();
        }
      }
      // Rotation handle for the selection.
      if (selected) {
        const h = this.mmToScreen(this._rotHandle(item));
        ctx.beginPath();
        ctx.moveTo(c.x, c.y); ctx.lineTo(h.x, h.y);
        ctx.strokeStyle = 'rgba(59,130,246,0.5)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(h.x, h.y, 7, 0, Math.PI * 2);
        ctx.fillStyle = '#3b82f6';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.stroke();
      }
    });
  }
}
