// 2D layout editor for multi-tool drawer inserts: draws the container and
// the placed tool outlines, drags items around, rotates the selection via a
// round handle (Shift snaps to 15°), and flags conflicts. Pure
// view/controller — the geometry lives in js/holders.js.
//
// Placed labels are drawn here too, and dragged and rotated with the same
// gestures the trace editor's label mode uses: grab the glyphs to move, grab
// the round handle below them to turn. Auto-placement is only a starting
// point, so a drag writes a manual position and rotation onto the item and
// the layout keeps them from then on.

import { pointInPolygon } from '../contour.js';
import { placeLoop, layoutPockets, layoutConflicts, worldToItemLocal } from '../holders.js';
import { labelBounds } from '../text.js';

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

// A label the user has turned by hand. Auto-placement and the layout's
// `follow` flag (js/holders.js layoutLabelGeometry) decide a label's starting
// angle; dragging the round handle stores `item.labelRot`, the extra turn ON
// TOP of that angle. Keeping it as an extra turn rather than an absolute one
// is what makes the two settle together: with follow on the label still rides
// round with its tool, and the hand-made twist survives a re-layout either
// way. Rotating the placed glyph loops about the label's anchor gives exactly
// what generating them at the summed angle would, because labelLoops() rotates
// about that same point last (js/text.js).
//
// Applied here rather than in js/holders.js so the editor's hit test and every
// export path read one identical geometry, with one copy of the arithmetic.
export function withManualLabelRot(placed, items) {
  return (placed || []).map(L => {
    if (L.src !== 'item') return L;
    const it = (items || [])[L.i];
    const extra = it && Number.isFinite(it.labelRot) ? it.labelRot : 0;
    if (!extra) return { ...L, autoRot: L.rot, manualRot: 0 };
    const a = (extra * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
    const loops = L.loops.map(loop => loop.map(q => {
      const dx = q.x - L.at.x, dy = q.y - L.at.y;
      return { x: L.at.x + dx * cos - dy * sin, y: L.at.y + dx * sin + dy * cos };
    }));
    return { ...L, loops, bounds: labelBounds(loops),
      rot: L.rot + extra, autoRot: L.rot, manualRot: extra };
  });
}

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
    // Placed labels, as layoutLabelGeometry() returns them: the app owns the
    // label settings, so it hands over a function that recomputes them and the
    // free-floating layout-label array a drag of one of those writes through.
    this.labels = [];
    this.selLabel = -1;
    this.layoutLabels = [];
    this._labelFn = null;
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
    this.refreshLabels();
    this.draw();
  }

  // The plate the layout is cut or printed on. Pass null for "no limit".
  setBed(bed) {
    this.bed = bed && bed.w > 0 && bed.h > 0 ? bed : null;
    if (!this.bed) this.bedSel = false;
  }

  bedLoop() { return this.bed ? bedLoop(this.container, this.bed) : null; }

  // Where placed labels come from. `fn()` returns the label geometry for the
  // layout as it stands (empty when labelling is off), `extra` is the state's
  // free-floating layout-label array.
  setLabelSource(fn, extra) {
    this._labelFn = typeof fn === 'function' ? fn : null;
    this.layoutLabels = extra || [];
    this.refreshLabels();
  }

  // Re-ask for the label geometry: after a move, a rotate, or any change to
  // the layout under it. Cheap enough to call on every pointermove.
  refreshLabels() {
    this.labels = (this._labelFn ? this._labelFn() : []) || [];
    if (this.selLabel >= this.labels.length) this.selLabel = -1;
  }

  // Back to auto-placement for item `i`: drop the manual position and the
  // manual turn, so the label goes back to tracking its pocket.
  resetLabelPlacement(i) {
    const it = this.items[i];
    if (!it || (!it.labelAt && !Number.isFinite(it.labelRot))) return false;
    delete it.labelAt;
    delete it.labelRot;
    this.refreshLabels();
    this.draw();
    return true;
  }

  // The round rotate handle for a placed label, below its anchor in the
  // label's own frame — the trace editor's handle, in layout mm.
  _labelHandle(L) {
    if (!L || !L.at) return null;
    const th = ((L.rot || 0) * Math.PI) / 180;
    const off = (L.height || 6) * 0.75 + 3;
    return { x: L.at.x - Math.sin(th) * off, y: L.at.y + Math.cos(th) * off };
  }

  // Topmost placed label whose glyph box contains the point, or -1.
  _hitLabel(mm) {
    const pad = 1;
    for (let i = this.labels.length - 1; i >= 0; i--) {
      const b = this.labels[i].bounds;
      if (!b) continue;
      if (mm.x >= b.minX - pad && mm.x <= b.maxX + pad &&
          mm.y >= b.minY - pad && mm.y <= b.maxY + pad) return i;
    }
    return -1;
  }

  // What a label drag writes to: the placed item for a tool label, the
  // free-floating entry for a drawer label.
  _labelTarget(L) {
    return L.src === 'item' ? this.items[L.i] : this.layoutLabels[L.i];
  }

  // Start a label move or rotate. Selecting a tool's label selects the tool
  // too, so the selection panel shows whose label is being moved.
  _labelDown(e, mm, idx, part) {
    const L = this.labels[idx];
    const target = this._labelTarget(L);
    if (!target) return false;
    this.selLabel = idx;
    this.bedSel = false;
    this._drag = part === 'rotate'
      ? { kind: 'labelRotate', src: L.src, target, at: { x: L.at.x, y: L.at.y },
          rot0: L.src === 'item'
            ? (Number.isFinite(target.labelRot) ? target.labelRot : 0)
            : (target.rot || 0),
          a0: Math.atan2(mm.y - L.at.y, mm.x - L.at.x), x0: mm.x, y0: mm.y }
      : { kind: 'labelMove', src: L.src, target,
          gx: L.at.x - mm.x, gy: L.at.y - mm.y, x0: mm.x, y0: mm.y };
    this.canvas.setPointerCapture(e.pointerId);
    if (L.src === 'item' && this.sel !== L.i) {
      this.sel = L.i;
      if (this.cb.onSelect) this.cb.onSelect(L.i);
    }
    this.draw();
    return true;
  }

  // Live label drag: a move stores the position, a rotate the extra turn.
  // Manual wins from here on, which is the whole point (labelling PRD,
  // "Auto-placement is a starting point, never a lock").
  _labelMove(mm, shift) {
    const d = this._drag;
    // A press that has not travelled yet writes nothing. Pens and touchscreens
    // emit a pointermove on essentially every tap, and without this a tap
    // meant to select the tool would quietly store the label's own auto
    // position as a manual one and drop it out of auto-placement for good,
    // with nothing on screen moving to say so.
    if (!d.moved) {
      const slop = 2 / this.view.scale; // 2 screen px, in mm
      if (Math.hypot(mm.x - d.x0, mm.y - d.y0) <= slop) return;
      d.moved = true;
    }
    if (d.kind === 'labelMove') {
      const at = { x: mm.x + d.gx, y: mm.y + d.gy };
      if (d.src === 'item') d.target.labelAt = { dx: at.x - d.target.x, dy: at.y - d.target.y };
      else { d.target.x = at.x; d.target.y = at.y; }
    } else {
      let deg = d.rot0 + ((Math.atan2(mm.y - d.at.y, mm.x - d.at.x) - d.a0) * 180) / Math.PI;
      if (shift) deg = Math.round(deg / 15) * 15; // Shift snaps to 15°, as in the trace editor
      deg = Math.round(deg * 10) / 10;
      if (d.src === 'item') d.target.labelRot = deg;
      else d.target.rot = deg;
    }
    this.refreshLabels();
  }

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
    // The selected label's rotate handle, before anything else can claim it.
    if (this.selLabel >= 0 && this.labels[this.selLabel]) {
      const lh = this._labelHandle(this.labels[this.selLabel]);
      if (lh && Math.hypot(mm.x - lh.x, mm.y - lh.y) < tolPx &&
          this._labelDown(e, mm, this.selLabel, 'rotate')) return;
    }
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
    // Topmost item under the pointer, found before the plate OR a label is
    // offered the press. Once a layout has to be tiled the plate's edge
    // necessarily runs through the drawer, and a tool sitting on a seam has to
    // stay selectable and draggable; the plate keeps every other point of its
    // edge. The same rule settles labels: a label's box is the box of the
    // whole string, which is routinely wider than the pocket it names and, on
    // a layered build, sits right on top of it, so letting it take the press
    // would leave the tool underneath impossible to drag.
    let hit = -1;
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (pointInPolygon(mm, placeLoop(this.items[i].outer, this.items[i]))) { hit = i; break; }
    }
    // A label's own glyphs, wherever no tool is under the pointer. Labels are
    // auto-placed in the gap beside their pocket, so this is where they are.
    if (hit < 0) {
      const labelHit = this._hitLabel(mm);
      if (labelHit >= 0 && this._labelDown(e, mm, labelHit, 'move')) return;
    }
    // The plate outline, grabbed anywhere along its edge that is not a tool.
    const bl = hit < 0 ? this.bedLoop() : null;
    if (bl && distToLoop(mm, bl) < Math.max(tolPx, 8 / this.view.scale)) {
      const off = this.bed.offset || (this.bed.offset = { x: 0, y: 0 });
      this._drag = { kind: 'bed', x0: mm.x, y0: mm.y, ox: off.x || 0, oy: off.y || 0 };
      this.bedSel = true;
      this.sel = -1;
      this.selLabel = -1;
      this.canvas.setPointerCapture(e.pointerId);
      if (this.cb.onSelect) this.cb.onSelect(-1);
      this.draw();
      return;
    }
    if (hit >= 0) {
      this.sel = hit;
      this.bedSel = false;
      this.selLabel = -1;
      this._drag = { kind: 'move', idx: hit, dx: this.items[hit].x - mm.x, dy: this.items[hit].y - mm.y };
      this.canvas.setPointerCapture(e.pointerId);
      if (this.cb.onSelect) this.cb.onSelect(hit);
      this.draw();
      return;
    }
    this.sel = -1;
    this.bedSel = false;
    this.selLabel = -1;
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
    if (this._drag.kind === 'labelMove' || this._drag.kind === 'labelRotate') {
      this._labelMove(mm, !!e.shiftKey);
      this.draw();
      if (this.cb.onChange) this.cb.onChange(false);
      return;
    }
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
    // Labels ride along live: an auto-placed one tracks its pocket, a
    // hand-placed one keeps the offset the user gave it.
    this.refreshLabels();
    this.draw();
    if (this.cb.onChange) this.cb.onChange(false);
  }

  _up(e) {
    if (!this._drag) return;
    this._drag = null;
    this.refreshConflicts();
    this.refreshLabels();
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

    this._drawLabels();
  }

  // Placed labels, on top of everything, as filled glyph outlines: what the
  // laser engraves or the printer debosses, not a canvas font. The selected
  // one gets a dashed box and the round rotate handle.
  _drawLabels() {
    const { ctx } = this;
    this.labels.forEach((L, i) => {
      if (!L.loops || !L.loops.length) return;
      const sel = i === this.selLabel;
      ctx.beginPath();
      for (const loop of L.loops) {
        loop.forEach((p, k) => {
          const s = this.mmToScreen(p);
          if (k === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
        });
        ctx.closePath();
      }
      ctx.fillStyle = 'rgba(16,185,129,0.22)';
      ctx.fill('evenodd');
      ctx.strokeStyle = sel ? '#10b981' : 'rgba(16,185,129,0.85)';
      ctx.lineWidth = sel ? 1.8 : 1.2;
      ctx.stroke();
      if (!sel) return;
      const b = L.bounds;
      if (b) {
        const c1 = this.mmToScreen({ x: b.minX, y: b.minY });
        const c2 = this.mmToScreen({ x: b.maxX, y: b.maxY });
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = '#10b981';
        ctx.lineWidth = 1;
        ctx.strokeRect(c1.x, c1.y, c2.x - c1.x, c2.y - c1.y);
        ctx.restore();
      }
      const hnd = this._labelHandle(L);
      if (!hnd) return;
      const a = this.mmToScreen(L.at), h = this.mmToScreen(hnd);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y); ctx.lineTo(h.x, h.y);
      ctx.strokeStyle = '#10b981';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(h.x, h.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#10b981';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    });
  }
}
