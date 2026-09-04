// Step 1 editor: show the photo, drag the four paper-corner handles.
// A magnifier loupe appears while dragging for pixel-accurate placement.

import { Viewport, prepareCanvas } from './viewport.js';

const HANDLE_R = 9;
const LABELS = ['TL', 'TR', 'BR', 'BL'];

export class CornerEditor {
  constructor(canvas, onChange) {
    this.canvas = canvas;
    this.onChange = onChange;
    this.vp = new Viewport(canvas);
    this.image = null;      // HTMLImageElement
    this.corners = null;    // [{x,y} x4] in image px, TL TR BR BL
    this.refMode = 'corners'; // 'corners' (rectangle) | 'coin' (scale only) | 'bar' (scale only)
    this.bar = null;          // { ax, ay, bx, by } image px — two points a known distance apart
    this.barDrag = null;      // 'a' | 'b' | 'mid'
    this.barLabel = '';       // caption drawn at the bar's midpoint (set by the app)
    this.coin = null;       // { cx, cy, r } in image px
    this.coinDrag = null;   // 'center' | 'radius'
    this.dragIdx = -1;
    this.panning = false;
    this.lastPos = null;
    this.pointer = null;

    canvas.addEventListener('pointerdown', e => this._down(e));
    canvas.addEventListener('pointermove', e => this._move(e));
    canvas.addEventListener('pointerup', e => this._up(e));
    canvas.addEventListener('pointercancel', e => this._up(e));
    canvas.addEventListener('dblclick', () => { this.vp.fit(); this.draw(); });
    canvas.addEventListener('viewportchange', () => this.draw());
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    this._pendingFit = false;
    new ResizeObserver(() => {
      if (this._pendingFit && canvas.clientWidth > 0 && canvas.clientHeight > 0) {
        this._pendingFit = false;
        this.vp.fit();
      }
      this.draw();
    }).observe(canvas);
  }

  setImage(image) {
    this.image = image;
    // Accept an HTMLImageElement (naturalWidth) or a canvas (width).
    this.vp.setContent(image.naturalWidth || image.width, image.naturalHeight || image.height);
    if (this.canvas.clientWidth > 0 && this.canvas.clientHeight > 0) this.vp.fit();
    else this._pendingFit = true;
    this.draw();
  }

  setCorners(corners) {
    this.corners = corners;
    this.draw();
  }

  setRefMode(mode) {
    this.refMode = mode;
    if (mode === 'coin' && !this.coin && this.image) {
      const iw = this.image.naturalWidth, ih = this.image.naturalHeight;
      this.coin = { cx: iw / 2, cy: ih / 2, r: Math.min(iw, ih) / 8 };
    }
    if (mode === 'bar' && !this.bar && this.image) {
      const iw = this.image.naturalWidth, ih = this.image.naturalHeight;
      this.bar = { ax: iw * 0.3, ay: ih * 0.5, bx: iw * 0.7, by: ih * 0.5 };
    }
    this.draw();
  }

  setCoin(coin) { this.coin = coin; this.draw(); }
  getCoin() { return this.coin; }

  setBar(bar) { this.bar = bar; this.draw(); }
  getBar() { return this.bar; }
  setBarLabel(text) { this.barLabel = text || ''; this.draw(); }

  _hitBar(sp) {
    if (!this.bar) return null;
    const a = this.vp.toScreen({ x: this.bar.ax, y: this.bar.ay });
    const b = this.vp.toScreen({ x: this.bar.bx, y: this.bar.by });
    if (Math.hypot(a.x - sp.x, a.y - sp.y) <= HANDLE_R + 6) return 'a';
    if (Math.hypot(b.x - sp.x, b.y - sp.y) <= HANDLE_R + 6) return 'b';
    // Anywhere along the line drags the whole bar.
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    if (len2 > 0) {
      const t = Math.max(0, Math.min(1, ((sp.x - a.x) * dx + (sp.y - a.y) * dy) / len2));
      const px = a.x + dx * t, py = a.y + dy * t;
      if (Math.hypot(px - sp.x, py - sp.y) <= 8) return 'mid';
    }
    return null;
  }

  _hitCorner(sp) {
    if (!this.corners) return -1;
    for (let i = 0; i < 4; i++) {
      const c = this.vp.toScreen(this.corners[i]);
      if (Math.hypot(c.x - sp.x, c.y - sp.y) <= HANDLE_R + 6) return i;
    }
    return -1;
  }

  // Coin handle under the pointer: 'center', 'radius', or null.
  _hitCoin(sp) {
    if (!this.coin) return null;
    const ctr = this.vp.toScreen({ x: this.coin.cx, y: this.coin.cy });
    if (Math.hypot(ctr.x - sp.x, ctr.y - sp.y) <= HANDLE_R + 6) return 'center';
    const rimPx = this.coin.r * this.vp.scale;
    const d = Math.hypot(ctr.x - sp.x, ctr.y - sp.y);
    if (Math.abs(d - rimPx) <= HANDLE_R + 4) return 'radius';
    return null;
  }

  _down(e) {
    if (!this.image) return;
    this.canvas.setPointerCapture(e.pointerId);
    const sp = this.vp.eventPos(e);
    this.lastPos = sp;
    if (e.button === 1 || e.button === 2) {
      this.panning = true;
      return;
    }
    if (this.refMode === 'coin') {
      const hit = this._hitCoin(sp);
      if (hit) { this.coinDrag = hit; return; }
      this.panning = true;
      return;
    }
    if (this.refMode === 'bar') {
      const hit = this._hitBar(sp);
      if (hit) { this.barDrag = hit; this._barLastWp = this.vp.toWorld(sp); return; }
      this.panning = true;
      return;
    }
    const hit = this._hitCorner(sp);
    if (hit >= 0) {
      this.dragIdx = hit;
    } else {
      this.panning = true;
    }
  }

  _move(e) {
    if (!this.image) return;
    const sp = this.vp.eventPos(e);
    this.pointer = sp;
    if (this.panning && this.lastPos) {
      this.vp.pan(sp.x - this.lastPos.x, sp.y - this.lastPos.y);
      this.lastPos = sp;
      this.draw();
      return;
    }
    if (this.coinDrag) {
      const wp = this.vp.toWorld(sp);
      if (this.coinDrag === 'center') { this.coin.cx = wp.x; this.coin.cy = wp.y; }
      else this.coin.r = Math.max(2, Math.hypot(wp.x - this.coin.cx, wp.y - this.coin.cy));
      this.draw();
      return;
    }
    if (this.barDrag) {
      const wp = this.vp.toWorld(sp);
      if (this.barDrag === 'a') { this.bar.ax = wp.x; this.bar.ay = wp.y; }
      else if (this.barDrag === 'b') { this.bar.bx = wp.x; this.bar.by = wp.y; }
      else {
        const dx = wp.x - this._barLastWp.x, dy = wp.y - this._barLastWp.y;
        this.bar.ax += dx; this.bar.ay += dy; this.bar.bx += dx; this.bar.by += dy;
        this._barLastWp = wp;
      }
      this.draw();
      return;
    }
    if (this.dragIdx >= 0) {
      const wp = this.vp.toWorld(sp);
      const iw = this.image.naturalWidth || this.image.width;
      const ih = this.image.naturalHeight || this.image.height;
      this.corners[this.dragIdx] = {
        x: Math.max(0, Math.min(iw, wp.x)),
        y: Math.max(0, Math.min(ih, wp.y)),
      };
      this.draw();
      return;
    }
    // Hover feedback
    if (this.refMode === 'coin') this.canvas.style.cursor = this._hitCoin(sp) ? 'grab' : 'default';
    if (this.refMode === 'bar') this.canvas.style.cursor = this._hitBar(sp) ? 'grab' : 'default';
    else this.canvas.style.cursor = this._hitCorner(sp) >= 0 ? 'grab' : 'default';
    this.draw();
  }

  _up(e) {
    if ((this.dragIdx >= 0 || this.coinDrag || this.barDrag) && this.onChange) this.onChange();
    this.dragIdx = -1;
    this.coinDrag = null;
    this.barDrag = null;
    this.panning = false;
    this.lastPos = null;
    this.draw();
  }

  draw() {
    const ctx = prepareCanvas(this.canvas);
    const { w: vw, h: vh } = this.vp.viewSize();
    ctx.clearRect(0, 0, vw, vh);
    if (!this.image) return;

    const s = this.vp.scale;
    ctx.save();
    ctx.translate(this.vp.ox, this.vp.oy);
    ctx.scale(s, s);
    ctx.imageSmoothingEnabled = s < 4;
    ctx.drawImage(this.image, 0, 0);
    ctx.restore();

    if (this.refMode === 'coin') { this._drawCoin(ctx, vw, vh); return; }
    if (this.refMode === 'bar') { this._drawBar(ctx, vw, vh); return; }

    if (!this.corners) return;
    const pts = this.corners.map(c => this.vp.toScreen(c));

    // Quad outline + translucent fill
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(80, 170, 255, 0.10)';
    ctx.fill();
    ctx.strokeStyle = '#53a9ff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Top edge marker (maps to the paper's top/width edge)
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    ctx.lineTo(pts[1].x, pts[1].y);
    ctx.strokeStyle = '#ffd257';
    ctx.lineWidth = 3;
    ctx.stroke();

    for (let i = 0; i < 4; i++) {
      const p = pts[i];
      ctx.beginPath();
      ctx.arc(p.x, p.y, HANDLE_R, 0, Math.PI * 2);
      ctx.fillStyle = i === this.dragIdx ? '#ffd257' : 'rgba(20, 26, 33, 0.85)';
      ctx.fill();
      ctx.strokeStyle = i === this.dragIdx ? '#fff' : '#53a9ff';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = i === this.dragIdx ? '#1c2027' : '#cfe3ff';
      ctx.font = 'bold 10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(LABELS[i], p.x, p.y);
    }

    // Loupe while dragging
    if (this.dragIdx >= 0 && this.pointer) {
      this._drawLoupe(ctx, this.corners[this.dragIdx], vw, vh);
    }
  }

  _drawBar(ctx, vw, vh) {
    if (!this.bar) return;
    const a = this.vp.toScreen({ x: this.bar.ax, y: this.bar.ay });
    const b = this.vp.toScreen({ x: this.bar.bx, y: this.bar.by });
    ctx.beginPath();
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = '#ffd257';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    // End ticks so the endpoints read as "measure from here to here".
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len * 9, ny = dx / len * 9;
    for (const p of [a, b]) {
      ctx.beginPath();
      ctx.moveTo(p.x - nx, p.y - ny); ctx.lineTo(p.x + nx, p.y + ny);
      ctx.stroke();
    }
    for (const [p, key] of [[a, 'a'], [b, 'b']]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, HANDLE_R, 0, Math.PI * 2);
      ctx.fillStyle = this.barDrag === key ? '#ffd257' : 'rgba(20,26,33,0.85)';
      ctx.fill();
      ctx.strokeStyle = '#ffd257'; ctx.lineWidth = 2; ctx.stroke();
    }
    if (this.barLabel) {
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      ctx.font = 'bold 12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      const tw = ctx.measureText(this.barLabel).width + 12;
      ctx.fillStyle = 'rgba(20,26,33,0.85)';
      ctx.fillRect(mx - tw / 2, my - 22, tw, 18);
      ctx.fillStyle = '#ffd257';
      ctx.fillText(this.barLabel, mx, my - 9);
    }
    if (this.barDrag === 'a' || this.barDrag === 'b') {
      const wp = this.barDrag === 'a' ? { x: this.bar.ax, y: this.bar.ay } : { x: this.bar.bx, y: this.bar.by };
      this._drawLoupe(ctx, wp, vw, vh);
    }
  }

  _drawCoin(ctx, vw, vh) {
    if (!this.coin) return;
    const ctr = this.vp.toScreen({ x: this.coin.cx, y: this.coin.cy });
    const r = this.coin.r * this.vp.scale;
    ctx.beginPath();
    ctx.arc(ctr.x, ctr.y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 210, 87, 0.10)';
    ctx.fill();
    ctx.strokeStyle = '#ffd257';
    ctx.lineWidth = 2;
    ctx.stroke();
    // Centre handle
    ctx.beginPath();
    ctx.arc(ctr.x, ctr.y, HANDLE_R, 0, Math.PI * 2);
    ctx.fillStyle = this.coinDrag === 'center' ? '#ffd257' : 'rgba(20,26,33,0.85)';
    ctx.fill();
    ctx.strokeStyle = '#ffd257'; ctx.lineWidth = 2; ctx.stroke();
    // Radius handle (at angle 0)
    const rh = { x: ctr.x + r, y: ctr.y };
    ctx.beginPath();
    ctx.arc(rh.x, rh.y, HANDLE_R - 2, 0, Math.PI * 2);
    ctx.fillStyle = this.coinDrag === 'radius' ? '#ffd257' : '#53a9ff';
    ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
    // Loupe while adjusting
    if (this.coinDrag) {
      const wp = this.coinDrag === 'center'
        ? { x: this.coin.cx, y: this.coin.cy }
        : { x: this.coin.cx + this.coin.r, y: this.coin.cy };
      this._drawLoupe(ctx, wp, vw, vh);
    }
  }

  _drawLoupe(ctx, worldPt, vw, vh) {
    const R = 70, ZOOM = 4;
    const sp = this.vp.toScreen(worldPt);
    // Place the loupe away from the pointer
    let lx = sp.x + 110, ly = sp.y - 110;
    if (lx + R > vw) lx = sp.x - 110;
    if (ly - R < 0) ly = sp.y + 110;

    ctx.save();
    ctx.beginPath();
    ctx.arc(lx, ly, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#000';
    ctx.fillRect(lx - R, ly - R, R * 2, R * 2);
    const srcR = R / ZOOM;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      this.image,
      worldPt.x - srcR, worldPt.y - srcR, srcR * 2, srcR * 2,
      lx - R, ly - R, R * 2, R * 2
    );
    // Crosshair
    ctx.strokeStyle = '#ffd257';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(lx - R, ly); ctx.lineTo(lx + R, ly);
    ctx.moveTo(lx, ly - R); ctx.lineTo(lx, ly + R);
    ctx.stroke();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(lx, ly, R, 0, Math.PI * 2);
    ctx.strokeStyle = '#53a9ff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}
