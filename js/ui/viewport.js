// Shared pan/zoom viewport for the 2D canvas editors.
//
// World space = content pixels (photo or rectified image); screen space = CSS
// pixels on the canvas. Wheel zooms about the cursor; middle-drag (or an
// editor-chosen mode) pans; fit() letterboxes the content.

export class Viewport {
  constructor(canvas) {
    this.canvas = canvas;
    this.scale = 1;
    this.ox = 0;
    this.oy = 0;
    this.contentW = 1;
    this.contentH = 1;
    this.minScale = 0.02;
    this.maxScale = 64;

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      const factor = Math.exp(-e.deltaY * 0.0015);
      this.zoomAt(sx, sy, factor);
      canvas.dispatchEvent(new CustomEvent('viewportchange'));
    }, { passive: false });
  }

  setContent(w, h) {
    this.contentW = w;
    this.contentH = h;
  }

  viewSize() {
    return { w: this.canvas.clientWidth, h: this.canvas.clientHeight };
  }

  fit(pad = 20) {
    const { w: vw, h: vh } = this.viewSize();
    const s = Math.min((vw - pad * 2) / this.contentW, (vh - pad * 2) / this.contentH);
    this.scale = Math.max(this.minScale, Math.min(this.maxScale, s));
    this.ox = (vw - this.contentW * this.scale) / 2;
    this.oy = (vh - this.contentH * this.scale) / 2;
  }

  // Zoom so the world-space box (x0,y0)-(x1,y1) fills the view, centred,
  // with `pad` CSS px around it. No-op while the canvas is hidden (0×0).
  fitBox(x0, y0, x1, y1, pad = 20) {
    const { w: vw, h: vh } = this.viewSize();
    if (vw <= pad * 2 || vh <= pad * 2) return;
    const bw = Math.max(1e-6, Math.abs(x1 - x0)), bh = Math.max(1e-6, Math.abs(y1 - y0));
    const s = Math.min((vw - pad * 2) / bw, (vh - pad * 2) / bh);
    this.scale = Math.max(this.minScale, Math.min(this.maxScale, s));
    this.ox = vw / 2 - ((x0 + x1) / 2) * this.scale;
    this.oy = vh / 2 - ((y0 + y1) / 2) * this.scale;
  }

  zoomAt(sx, sy, factor) {
    const ns = Math.max(this.minScale, Math.min(this.maxScale, this.scale * factor));
    const f = ns / this.scale;
    this.ox = sx - (sx - this.ox) * f;
    this.oy = sy - (sy - this.oy) * f;
    this.scale = ns;
  }

  pan(dx, dy) {
    this.ox += dx;
    this.oy += dy;
  }

  toScreen(p) {
    return { x: p.x * this.scale + this.ox, y: p.y * this.scale + this.oy };
  }

  toWorld(p) {
    return { x: (p.x - this.ox) / this.scale, y: (p.y - this.oy) / this.scale };
  }

  // Pointer event -> screen CSS px within the canvas.
  eventPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
}

// Size the canvas backing store to its CSS size * devicePixelRatio and return
// a ctx already scaled so drawing uses CSS pixel coordinates.
export function prepareCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}
