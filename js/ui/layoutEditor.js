// 2D layout editor for multi-tool drawer inserts: draws the container and
// the placed tool outlines, drags items around, rotates the selection via a
// round handle (Shift snaps to 15°), optionally snaps drags, nudges and
// rotations to a grid, and flags conflicts. Pure view/controller — the
// geometry lives in js/holders.js.

import { pointInPolygon } from '../contour.js';
import { placeLoop, layoutPockets, layoutConflicts, worldToItemLocal } from '../holders.js';

// The build plate as a loop in layout mm. `bed` is { w, h, offset, shape }:
// `offset` is where the layout's bounding box sits on the plate, so zero puts
// the layout's top-left corner on the plate's own, and a shape (a saved
// container outline, for a round or cut-cornered plate) is dropped into that
// same corner. Exported because the step-4 panel needs the same rectangle
// for its fit readout, and two copies of this arithmetic would drift.
export function bedLoop(container, bed) {
  if (!container || !container.length || !bed || !(bed.w > 0) || !(bed.h > 0)) return null;
  let minX = Infinity, minY = Infinity;
  for (const p of container) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); }
  const off = bed.offset || { x: 0, y: 0 };
  const x0 = minX - (off.x || 0), y0 = minY - (off.y || 0);
  const sh = bed.shape && bed.shape.outer;
  if (sh && sh.length >= 3) {
    let sx = Infinity, sy = Infinity;
    for (const p of sh) { sx = Math.min(sx, p.x); sy = Math.min(sy, p.y); }
    return sh.map(p => ({ x: p.x - sx + x0, y: p.y - sy + y0 }));
  }
  return [
    { x: x0, y: y0 }, { x: x0 + bed.w, y: y0 },
    { x: x0 + bed.w, y: y0 + bed.h }, { x: x0, y: y0 + bed.h },
  ];
}

// Distance from a point to a closed loop's nearest edge, in the loop's units.
function distToLoop(p, loop) {
  let best = Infinity;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    const vx = b.x - a.x, vy = b.y - a.y;
    const len = vx * vx + vy * vy;
    let t = len > 0 ? ((p.x - a.x) * vx + (p.y - a.y) * vy) / len : 0;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy)));
  }
  return best;
}

// The snap grid. 5 mm is the default pitch; the step-4 panel offers 42 mm as
// well when the container is a Gridfinity bin, because that is the cell pitch
// a bin's tools want to line up with. A snapped rotation is a quarter turn:
// the finer 15° step stays on Shift, where it already was.
const SNAP_DEFAULT_PITCH = 5;
const SNAP_ROT_DEG = 90;
const SNAP_SHIFT_ROT_DEG = 15;

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
    // Photos inside traces: each item may carry a thumb cropped from the
    // photo it was traced from. Decoded images are cached by data URL, so a
    // redraw never re-decodes and a folder of a hundred tools decodes once.
    this.showPhotos = true;
    this._thumbs = new Map();
    // The build plate: { w, h, offset, shape } or null for "no limit". The
    // offset object is shared with the layout state, so a drag writes through.
    this.bed = null;
    this.bedSel = false;
    // Snap to grid: { on, pitch } in layout mm, mirrored from
    // state.layout.snap. Snapping is a property of the gesture and not of the
    // layout, so it quantises what a drag or an arrow-key nudge writes and
    // never touches a value that is already stored. Turning it on moves
    // nothing.
    this.snap = { on: false, pitch: SNAP_DEFAULT_PITCH };
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

  // The snap grid in force, from state.layout.snap. Read on every refresh, so
  // the toggle and the pitch field take effect on the next gesture and on no
  // stored value at all.
  setSnap(snap) {
    const pitch = snap && Number.isFinite(snap.pitch) && snap.pitch > 0
      ? snap.pitch : SNAP_DEFAULT_PITCH;
    this.snap = { on: !!(snap && snap.on), pitch };
  }

  // One coordinate put on the snap grid. The grid is absolute layout mm, so
  // two tools snapped at the same pitch line up with each other and with the
  // container's own origin, and the float dust of dividing by 0.1 or 42 never
  // reaches a stored value.
  _snapMm(v) {
    if (!this.snap.on || !(this.snap.pitch > 0)) return v;
    const p = this.snap.pitch;
    return Math.round(Math.round(v / p) * p * 1e6) / 1e6;
  }

  // The angle a rotation-handle drag lands on: a quarter turn with snap on,
  // the existing 15° while Shift is held, free otherwise. Shift wins, so a
  // finer angle is still reachable without leaving the snap grid behind.
  _snapDeg(deg, shift) {
    if (shift) return Math.round(deg / SNAP_SHIFT_ROT_DEG) * SNAP_SHIFT_ROT_DEG;
    if (this.snap.on) return Math.round(deg / SNAP_ROT_DEG) * SNAP_ROT_DEG;
    return deg;
  }

  // How far one arrow-key press moves the selected item: one pitch with snap
  // on, otherwise the 1 mm / 10 mm the plate nudge already uses.
  snapStep(coarse) {
    if (this.snap.on && this.snap.pitch > 0) return this.snap.pitch;
    return coarse ? 10 : 1;
  }

  // Arrow-key nudge for the selected item, in steps of snapStep(). With snap
  // on the item lands on the grid rather than one pitch off it, which is what
  // makes a nudge and a drag agree.
  nudgeItem(dx, dy, coarse = false) {
    const it = this.items[this.sel];
    if (!it) return false;
    const step = this.snapStep(coarse);
    it.x = this._snapMm(it.x + dx * step);
    it.y = this._snapMm(it.y + dy * step);
    this.refreshConflicts();
    this.draw();
    if (this.cb.onChange) this.cb.onChange(true);
    return true;
  }

  // The plate the layout is cut or printed on. Pass null for "no limit".
  setBed(bed) {
    this.bed = bed && bed.w > 0 && bed.h > 0 ? bed : null;
    if (!this.bed) this.bedSel = false;
  }

  bedLoop() { return this.bed ? bedLoop(this.container, this.bed) : null; }

  // Move the plate itself by (dx, dy) mm. The stored offset is the layout's
  // position ON the plate, so moving the plate right moves the layout left
  // across it: the two run opposite by definition.
  nudgeBed(dx, dy) {
    if (!this.bed) return false;
    const off = this.bed.offset || (this.bed.offset = { x: 0, y: 0 });
    off.x = (off.x || 0) - dx;
    off.y = (off.y || 0) - dy;
    this.draw();
    return true;
  }

  fit() {
    if (!this.container) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    // The plate is part of the picture when there is one, so a layout parked
    // in one corner of a big bed still shows the whole bed.
    const bl = this.bedLoop();
    for (const p of bl ? this.container.concat(bl) : this.container) {
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

  // The decoded thumbnail for an item, or null while it is still decoding
  // (the load handler redraws once) or if it will never decode.
  _thumbImage(thumb) {
    if (!thumb || !thumb.dataUrl || typeof Image === 'undefined') return null;
    const key = thumb.dataUrl;
    if (this._thumbs.has(key)) {
      const cached = this._thumbs.get(key);
      return cached && cached.naturalWidth ? cached : null;
    }
    const im = new Image();
    this._thumbs.set(key, im);
    im.onload = () => this.draw();
    im.onerror = () => this._thumbs.set(key, null);
    im.src = key;
    return im.naturalWidth ? im : null;
  }

  // The item's own outline centre: what placeLoop rotates about.
  _itemCentre(item) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of item.outer) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  }

  // The photo, clipped to the outline and carried through the item's own
  // rotation and position, drawn at reduced alpha under everything else so
  // the pocket stroke and the conflict tint stay legible on top of it.
  _drawPhoto(item) {
    const im = this._thumbImage(item.thumb);
    if (!im) return;
    const c = this._itemCentre(item);
    const s = this.view.scale;
    const { ctx } = this;
    ctx.save();
    ctx.translate(item.x * s + this.view.ox, item.y * s + this.view.oy);
    ctx.rotate(((item.rot || 0) * Math.PI) / 180);
    ctx.scale(s, s);
    ctx.beginPath();
    item.outer.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x - c.x, p.y - c.y); else ctx.lineTo(p.x - c.x, p.y - c.y);
    });
    ctx.closePath();
    ctx.clip();
    const o = (item.thumb.origin && Number.isFinite(item.thumb.origin.x))
      ? item.thumb.origin : { x: 0, y: 0 };
    const mpp = item.thumb.mmPerPx;
    ctx.globalAlpha = 0.85;
    ctx.drawImage(im, o.x - c.x, o.y - c.y, im.naturalWidth * mpp, im.naturalHeight * mpp);
    ctx.restore();
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
    // Topmost item under the pointer, found before the plate is offered the
    // press. Once a layout has to be tiled the plate's edge necessarily runs
    // through the drawer, and a tool sitting on a seam has to stay selectable
    // and draggable; the plate keeps every other point of its edge.
    let hit = -1;
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (pointInPolygon(mm, placeLoop(this.items[i].outer, this.items[i]))) { hit = i; break; }
    }
    // The plate outline, grabbed anywhere along its edge that is not a tool.
    const bl = hit < 0 ? this.bedLoop() : null;
    if (bl && distToLoop(mm, bl) < Math.max(tolPx, 8 / this.view.scale)) {
      const off = this.bed.offset || (this.bed.offset = { x: 0, y: 0 });
      this._drag = { kind: 'bed', x0: mm.x, y0: mm.y, ox: off.x || 0, oy: off.y || 0 };
      this.bedSel = true;
      this.sel = -1;
      this.canvas.setPointerCapture(e.pointerId);
      if (this.cb.onSelect) this.cb.onSelect(-1);
      this.draw();
      return;
    }
    if (hit >= 0) {
      this.sel = hit;
      this.bedSel = false;
      this._drag = { kind: 'move', idx: hit, dx: this.items[hit].x - mm.x, dy: this.items[hit].y - mm.y };
      this.canvas.setPointerCapture(e.pointerId);
      if (this.cb.onSelect) this.cb.onSelect(hit);
      this.draw();
      return;
    }
    this.sel = -1;
    this.bedSel = false;
    if (this.cb.onSelect) this.cb.onSelect(-1);
    this.draw();
  }

  _move(e) {
    if (!this._drag) return;
    const mm = this.screenToMm(e);
    if (this._drag.kind === 'bed') {
      // The plate follows the pointer; the offset runs the other way.
      this.bed.offset.x = this._drag.ox - (mm.x - this._drag.x0);
      this.bed.offset.y = this._drag.oy - (mm.y - this._drag.y0);
      this.draw();
      if (this.cb.onChange) this.cb.onChange(false);
      return;
    }
    const it = this.items[this._drag.idx];
    if (!it) return;
    if (this._drag.kind === 'move') {
      it.x = this._snapMm(mm.x + this._drag.dx);
      it.y = this._snapMm(mm.y + this._drag.dy);
    } else if (this._drag.kind === 'notch') {
      // Store in item-local coords; the pocket builder snaps it to the
      // boundary, so dragging anywhere pulls the notch to the nearest edge.
      const local = worldToItemLocal(it, mm);
      it.notch.x = local.x;
      it.notch.y = local.y;
      this._pockets = layoutPockets(this.items, this.clearance); // live marker
    } else {
      const deg = this._snapDeg(
        (Math.atan2(mm.y - it.y, mm.x - it.x) * 180) / Math.PI + 90, e.shiftKey);
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

    // The build plate, dashed and under the container, so the drawer is seen
    // sitting on the sheet it will be cut from.
    const bl = this.bedLoop();
    if (bl) {
      loopPath(bl);
      ctx.fillStyle = 'rgba(245,158,11,0.05)';
      ctx.fill();
      ctx.save();
      ctx.setLineDash([8, 5]);
      ctx.strokeStyle = this.bedSel ? '#f59e0b' : 'rgba(245,158,11,0.55)';
      ctx.lineWidth = this.bedSel ? 2.5 : 1.5;
      ctx.stroke();
      ctx.restore();
    }

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
      // Photo first, so everything below draws over it.
      if (this.showPhotos && item.thumb) this._drawPhoto(item);
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
