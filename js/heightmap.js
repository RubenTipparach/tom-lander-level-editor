// Heightmap data: 2D Uint8 array of palette indices (0..31).
// PNG load/save uses Picotron palette colors so files are byte-identical
// to those produced by the C# TerrainEditor.

import { PALETTE, findExact, findNearest } from './palette.js';
import { History } from './history.js';

export class Heightmap {
  constructor(w, h, fill = 0) {
    this.width = w;
    this.height = h;
    this.data = new Uint8Array(w * h);
    if (fill) this.data.fill(fill & 31);
    this.filePath = '';
    this.dirty = false;
    this.history = new History();
  }

  clone() {
    const c = new Heightmap(this.width, this.height);
    c.data.set(this.data);
    c.filePath = this.filePath;
    c.dirty = this.dirty;
    return c;
  }

  snapshot() { return new Uint8Array(this.data); }
  restore(buf) { this.data.set(buf); this.dirty = true; }

  pushUndo() { this.history.push(this.snapshot()); }
  undo() {
    const s = this.history.undo(this.snapshot());
    if (!s) return false;
    this.restore(s); return true;
  }
  redo() {
    const s = this.history.redo(this.snapshot());
    if (!s) return false;
    this.restore(s); return true;
  }

  get(x, y) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return 0;
    return this.data[y * this.width + x];
  }
  set(x, y, h) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    this.data[y * this.width + x] = Math.max(0, Math.min(31, h | 0));
    this.dirty = true;
  }

  // Midpoint circle scanline fill.
  static circlePixels(cx, cy, radius) {
    const out = [];
    if (radius === 0) { out.push([cx, cy]); return out; }
    let x = radius, y = 0, d = 1 - radius;
    const rows = new Map();
    function add(row, x1, x2) {
      const lo = Math.min(x1, x2), hi = Math.max(x1, x2);
      const cur = rows.get(row);
      if (cur) { cur[0] = Math.min(cur[0], lo); cur[1] = Math.max(cur[1], hi); }
      else rows.set(row, [lo, hi]);
    }
    while (x >= y) {
      add(cy + y, cx - x, cx + x);
      add(cy - y, cx - x, cx + x);
      add(cy + x, cx - y, cx + y);
      add(cy - x, cx - y, cx + y);
      y++;
      if (d <= 0) d += 2 * y + 1;
      else { x--; d += 2 * (y - x) + 1; }
    }
    for (const [row, [lo, hi]] of rows)
      for (let px = lo; px <= hi; px++) out.push([px, row]);
    return out;
  }

  // strengthAt(normDist) → 0..1 weight at a given normalized distance from
  // the brush center (0 = center, 1 = rim). When omitted, the brush is hard
  // (every pixel in the radius gets full effect).
  paintBrush(cx, cy, radius, h, strengthAt) {
    const pix = Heightmap.circlePixels(cx, cy, radius);
    if (!strengthAt || radius <= 0) {
      for (const [x, y] of pix) this.set(x, y, h);
      return;
    }
    for (const [x, y] of pix) {
      if (x < 0 || x >= this.width || y < 0 || y >= this.height) continue;
      const dx = x - cx, dy = y - cy;
      const norm = Math.min(1, Math.hypot(dx, dy) / radius);
      const s = Math.max(0, Math.min(1, strengthAt(norm)));
      if (s <= 0) continue;
      const i = y * this.width + x;
      const cur = this.data[i];
      const blended = Math.round(cur + (h - cur) * s);
      this.data[i] = Math.max(0, Math.min(31, blended));
    }
    this.dirty = true;
  }

  smoothBrush(cx, cy, radius, strengthAt) {
    const pix = Heightmap.circlePixels(cx, cy, radius);
    let sum = 0, n = 0;
    for (const [x, y] of pix) {
      if (x >= 0 && x < this.width && y >= 0 && y < this.height) {
        sum += this.data[y * this.width + x]; n++;
      }
    }
    if (!n) return;
    const avg = sum / n;
    for (const [x, y] of pix) {
      if (x < 0 || x >= this.width || y < 0 || y >= this.height) continue;
      const i = y * this.width + x;
      let s = 0.5;
      if (strengthAt && radius > 0) {
        const dx = x - cx, dy = y - cy;
        const norm = Math.min(1, Math.hypot(dx, dy) / radius);
        s = Math.max(0, Math.min(1, strengthAt(norm)));
        if (s <= 0) continue;
      }
      const cur = this.data[i];
      this.data[i] = Math.max(0, Math.min(31, Math.round(cur + (avg - cur) * s)));
    }
    this.dirty = true;
  }

  // ───── PNG IO ─────

  // Build an ImageData using palette colors for the heightmap.
  toImageData() {
    const id = new ImageData(this.width, this.height);
    for (let i = 0; i < this.data.length; i++) {
      const h = this.data[i] & 31;
      const [r, g, b] = PALETTE[h];
      const o = i * 4;
      id.data[o] = r; id.data[o+1] = g; id.data[o+2] = b; id.data[o+3] = 255;
    }
    return id;
  }

  // Encode as PNG Blob via OffscreenCanvas / canvas.
  async toPngBlob() {
    const c = document.createElement('canvas');
    c.width = this.width; c.height = this.height;
    const ctx = c.getContext('2d');
    ctx.putImageData(this.toImageData(), 0, 0);
    return await new Promise((res) => c.toBlob(res, 'image/png'));
  }

  // Construct from an ImageData (palette mapping per pixel).
  static fromImageData(id) {
    const hm = new Heightmap(id.width, id.height);
    for (let i = 0; i < hm.data.length; i++) {
      const o = i * 4;
      const r = id.data[o], g = id.data[o+1], b = id.data[o+2];
      let idx = findExact(r, g, b);
      if (idx < 0) idx = findNearest(r, g, b);
      hm.data[i] = idx;
    }
    return hm;
  }

  // Load a PNG from a Blob/File/URL into a new Heightmap.
  static async fromPng(source) {
    let url;
    if (source instanceof Blob) url = URL.createObjectURL(source);
    else url = source;
    try {
      const img = await loadImage(url);
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const id = ctx.getImageData(0, 0, c.width, c.height);
      return Heightmap.fromImageData(id);
    } finally {
      if (source instanceof Blob) URL.revokeObjectURL(url);
    }
  }
}

export function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}
