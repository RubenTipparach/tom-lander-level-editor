// 2D heightmap canvas: pan/zoom + brush + checkpoint and marker overlays.

import { PALETTE } from './palette.js';
import { Heightmap } from './heightmap.js';
import { groupColor } from './markers.js';

const TILE_PX_MAX = 64;
const TILE_PX_MIN = 0.5;

export class Terrain2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.heightmap = null;
    this.terrain = null;
    this.markers = null;
    this.track = null;
    this.textures = { low: null, mid: null, high: null, water: null };
    this.viewMode = 'palette'; // 'palette' | 'zones' | 'textured'

    this.tool = 'paint';
    this.brushHeight = 1;
    this.brushRadius = 0;
    // Soft-brush state. softBrush=false means hard brush (every pixel in
    // radius gets full effect). When true, falloffFn(normDist) gives the
    // per-pixel strength weight in [0..1].
    this.softBrush = false;
    this.falloffFn = null;

    // view transform
    this.zoom = 4;
    this.panX = 0;
    this.panY = 0;

    // input
    this.painting = false;
    this.panning = false;
    this.dragCp = -1;
    this.dragMarker = -1;
    this.lastTile = [-1, -1];
    this.cursorTile = [-1, -1];

    this._backbuffer = document.createElement('canvas');
    this._buffMode = '';

    // events
    this.onChange = () => {};
    this.onCursor = () => {};
    this.onTrackChange = () => {};
    this.onMarkerChange = () => {};
    this.onMarkerSelect = () => {};

    canvas.addEventListener('mousedown', e => this.onMouseDown(e));
    canvas.addEventListener('mousemove', e => this.onMouseMove(e));
    window.addEventListener('mouseup', e => this.onMouseUp(e));
    canvas.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    canvas.addEventListener('mouseleave', () => { this.cursorTile = [-1, -1]; this.draw(); });
    canvas.addEventListener('contextmenu', e => e.preventDefault());

    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(r.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(r.height * dpr));
    this.ctx.imageSmoothingEnabled = false;
    this.draw();
  }

  setHeightmap(hm, terrain) {
    this.heightmap = hm;
    this.terrain = terrain;
    if (hm) this.fitView();
    this.invalidateBuffer();
    this.draw();
  }
  setTerrain(t) { this.terrain = t; this.invalidateBuffer(); this.draw(); }
  setMarkers(m) { this.markers = m; this.draw(); }
  setTrack(t) { this.track = t; this.draw(); }
  setTextures(tex) { this.textures = { ...this.textures, ...tex }; this.invalidateBuffer(); this.draw(); }
  setViewMode(m) { this.viewMode = m; this.invalidateBuffer(); this.draw(); }

  fitView() {
    const r = this.canvas.getBoundingClientRect();
    const z = Math.max(1, Math.min(r.width / this.heightmap.width, r.height / this.heightmap.height));
    this.zoom = z;
    this.panX = (r.width - this.heightmap.width * z) / 2;
    this.panY = (r.height - this.heightmap.height * z) / 2;
  }

  invalidateBuffer() { this._buffMode = ''; }

  rebuildBuffer() {
    if (!this.heightmap) return;
    const hm = this.heightmap;
    const mode = this.viewMode + '/' +
      (this.terrain?.lowToMid ?? '') + '/' + (this.terrain?.midToHigh ?? '') + '/' +
      hm.width + 'x' + hm.height;
    if (mode === this._buffMode) return;

    if (this.viewMode === 'textured' && this.textures.low) {
      this._renderTextured();
    } else if (this.viewMode === 'zones' && this.terrain) {
      this._renderZones();
    } else {
      this._renderPalette();
    }
    this._buffMode = mode;
  }

  _renderPalette() {
    const hm = this.heightmap;
    this._backbuffer.width = hm.width;
    this._backbuffer.height = hm.height;
    const ctx = this._backbuffer.getContext('2d');
    const id = hm.toImageData();
    ctx.putImageData(id, 0, 0);
  }

  _renderZones() {
    const hm = this.heightmap, t = this.terrain;
    this._backbuffer.width = hm.width;
    this._backbuffer.height = hm.height;
    const ctx = this._backbuffer.getContext('2d');
    const id = ctx.createImageData(hm.width, hm.height);
    for (let i = 0; i < hm.data.length; i++) {
      const h = hm.data[i];
      let c;
      if (t.hasWater && h === 0) c = t.waterColor;
      else if (h >= t.midToHigh) c = t.highColor;
      else if (h >= t.lowToMid) c = t.midColor;
      else c = t.lowColor;
      const o = i * 4;
      id.data[o] = c[0]; id.data[o+1] = c[1]; id.data[o+2] = c[2]; id.data[o+3] = 255;
    }
    ctx.putImageData(id, 0, 0);
  }

  _renderTextured() {
    const hm = this.heightmap, t = this.terrain;
    const tex = this.textures.low;
    const tw = tex.width, th = tex.height;
    this._backbuffer.width = hm.width * tw;
    this._backbuffer.height = hm.height * th;
    const ctx = this._backbuffer.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    for (let ty = 0; ty < hm.height; ty++) {
      for (let tx = 0; tx < hm.width; tx++) {
        const h = hm.data[ty * hm.width + tx];
        let img;
        if (t.hasWater && h === 0) {
          ctx.fillStyle = `rgb(${t.waterColor[0]},${t.waterColor[1]},${t.waterColor[2]})`;
          ctx.fillRect(tx * tw, ty * th, tw, th);
          continue;
        } else if (h >= t.midToHigh) img = this.textures.high;
        else if (h >= t.lowToMid) img = this.textures.mid;
        else img = this.textures.low;
        ctx.drawImage(img, tx * tw, ty * th, tw, th);
      }
    }
  }

  // ───── Coords ─────

  cssToTile(cx, cy) {
    const dpr = window.devicePixelRatio || 1;
    const sx = cx * dpr, sy = cy * dpr;
    return [Math.floor((sx - this.panX * dpr) / (this.zoom * dpr)),
            Math.floor((sy - this.panY * dpr) / (this.zoom * dpr))];
  }
  tileToCss(tx, ty) {
    return [this.panX + tx * this.zoom, this.panY + ty * this.zoom];
  }

  // ───── Mouse ─────

  onMouseDown(e) {
    if (!this.heightmap) return;
    e.preventDefault();
    this.canvas.focus();
    const rect = this.canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    const [tx, ty] = this.cssToTile(cx, cy);
    const searchR = Math.max(3, Math.floor(8 / this.zoom));

    if (e.button === 2 || e.button === 1) {
      // right-click delete in cp/marker mode; otherwise pan
      if (this.tool === 'checkpoints' && this.track) {
        const i = this.track.findNear(tx, ty, searchR);
        if (i >= 0) { this.track.removeAt(i); this.onTrackChange(); this.draw(); return; }
      }
      if ((this.tool === 'markers' || this.tool === 'markers-move') && this.markers) {
        const i = this.markers.findNear(tx, ty, searchR);
        if (i >= 0) { this.markers.pushUndo(); this.markers.removeAt(i); this.onMarkerChange(); this.draw(); return; }
      }
      this.panning = true;
      this._panStart = [cx, cy, this.panX, this.panY];
      this.canvas.style.cursor = 'grabbing';
      return;
    }

    if (e.button !== 0) return;

    if (this.tool === 'checkpoints' && this.track) {
      const i = this.track.findNear(tx, ty, searchR);
      if (i >= 0) { this.dragCp = i; this.canvas.style.cursor = 'grab'; }
      else if (tx >= 0 && tx < this.heightmap.width && ty >= 0 && ty < this.heightmap.height) {
        this.track.add(tx, ty); this.onTrackChange(); this.draw();
      }
      return;
    }
    if (this.tool === 'markers' && this.markers) {
      const i = this.markers.findNear(tx, ty, searchR);
      if (i >= 0) {
        this.markers.pushUndo();
        this.dragMarker = i;
        this.onMarkerSelect(i);
        this.canvas.style.cursor = 'grab';
      } else if (tx >= 0 && tx < this.heightmap.width && ty >= 0 && ty < this.heightmap.height) {
        this.markers.pushUndo();
        const m = this.markers.add(tx, ty, this._defaultMarker || {});
        this.onMarkerChange();
        this.draw();
      }
      return;
    }
    if (this.tool === 'markers-move' && this.markers) {
      const i = this.markers.findNear(tx, ty, searchR);
      if (i >= 0) {
        this.markers.pushUndo();
        this.dragMarker = i;
        this.onMarkerSelect(i);
        this.canvas.style.cursor = 'grab';
      }
      return;
    }

    // Brush tools
    this.heightmap.pushUndo();
    this.painting = true;
    this.lastTile = [-2, -2];
    this.paintAt(cx, cy);
  }

  onMouseMove(e) {
    if (!this.heightmap) return;
    const rect = this.canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    const [tx, ty] = this.cssToTile(cx, cy);

    if (this.panning) {
      const [sx, sy, px, py] = this._panStart;
      this.panX = px + (cx - sx);
      this.panY = py + (cy - sy);
      this.draw(); return;
    }
    if (this.dragCp >= 0 && this.track) {
      if (tx >= 0 && tx < this.heightmap.width && ty >= 0 && ty < this.heightmap.height) {
        this.track.checkpoints[this.dragCp].X = tx;
        this.track.checkpoints[this.dragCp].Z = ty;
        this.draw();
      }
      return;
    }
    if (this.dragMarker >= 0 && this.markers) {
      if (tx >= 0 && tx < this.heightmap.width && ty >= 0 && ty < this.heightmap.height) {
        this.markers.markers[this.dragMarker].X = tx;
        this.markers.markers[this.dragMarker].Z = ty;
        this.draw();
      }
      return;
    }
    if (this.painting) this.paintAt(cx, cy);

    if (tx !== this.cursorTile[0] || ty !== this.cursorTile[1]) {
      this.cursorTile = [tx, ty];
      this.onCursor(tx, ty, this.heightmap.get(tx, ty));
      this.draw();
    }
  }

  onMouseUp(e) {
    if (this.panning) { this.panning = false; this.canvas.style.cursor = 'crosshair'; }
    if (this.painting) {
      this.painting = false;
      this.lastTile = [-1, -1];
      this.onChange();
    }
    if (this.dragCp >= 0) {
      this.dragCp = -1;
      this.canvas.style.cursor = 'crosshair';
      this.onTrackChange();
    }
    if (this.dragMarker >= 0) {
      this.dragMarker = -1;
      this.canvas.style.cursor = 'crosshair';
      this.onMarkerChange();
    }
  }

  onWheel(e) {
    e.preventDefault();
    const oldZoom = this.zoom;
    const factor = e.deltaY < 0 ? 1.25 : 0.8;
    this.zoom = Math.max(TILE_PX_MIN, Math.min(TILE_PX_MAX, this.zoom * factor));
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const ratio = this.zoom / oldZoom;
    this.panX = mx - (mx - this.panX) * ratio;
    this.panY = my - (my - this.panY) * ratio;
    this.draw();
  }

  paintAt(cx, cy) {
    const [tx, ty] = this.cssToTile(cx, cy);
    if (tx === this.lastTile[0] && ty === this.lastTile[1]) return;
    this.lastTile = [tx, ty];

    const fn = this.softBrush ? this.falloffFn : null;
    if (this.tool === 'smooth') this.heightmap.smoothBrush(tx, ty, this.brushRadius, fn);
    else if (this.tool === 'erase') this.heightmap.paintBrush(tx, ty, this.brushRadius, 0, fn);
    else this.heightmap.paintBrush(tx, ty, this.brushRadius, this.brushHeight, fn);

    this.invalidateBuffer();
    this.draw();
    this.onChange(false);
  }

  // ───── Draw ─────

  draw() {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#181820';
    ctx.fillRect(0, 0, this.canvas.width / dpr, this.canvas.height / dpr);
    if (!this.heightmap) return;

    this.rebuildBuffer();
    ctx.imageSmoothingEnabled = false;
    const dw = this.heightmap.width * this.zoom;
    const dh = this.heightmap.height * this.zoom;
    ctx.drawImage(this._backbuffer, this.panX, this.panY, dw, dh);

    // Grid
    if (this.zoom >= 8) {
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= this.heightmap.width; x++) {
        const sx = this.panX + x * this.zoom;
        ctx.moveTo(sx + 0.5, this.panY);
        ctx.lineTo(sx + 0.5, this.panY + dh);
      }
      for (let y = 0; y <= this.heightmap.height; y++) {
        const sy = this.panY + y * this.zoom;
        ctx.moveTo(this.panX, sy + 0.5);
        ctx.lineTo(this.panX + dw, sy + 0.5);
      }
      ctx.stroke();
    }

    // Brush cursor
    const isPaintTool = this.tool === 'paint' || this.tool === 'erase' || this.tool === 'smooth';
    if (isPaintTool && this.cursorTile[0] >= 0) {
      const [tx, ty] = this.cursorTile;
      const [sx, sy] = this.tileToCss(tx, ty);
      const r = (this.brushRadius + 0.5) * this.zoom;
      ctx.strokeStyle = 'rgba(255, 255, 0, 0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx + this.zoom / 2, sy + this.zoom / 2, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Border
    ctx.strokeStyle = 'rgba(220,220,220,0.45)';
    ctx.lineWidth = 1;
    ctx.strokeRect(this.panX + 0.5, this.panY + 0.5, dw, dh);

    // Track overlay
    if (this.track && this.track.checkpoints.length > 0) this._drawTrack(ctx);
    // Marker overlay
    if (this.markers && this.markers.markers.length > 0) this._drawMarkers(ctx);
  }

  _drawTrack(ctx) {
    const cps = this.track.checkpoints;
    const half = this.zoom / 2;
    const halfW = this.track.width / 2 * this.zoom;
    const centers = cps.map(cp => {
      const [sx, sy] = this.tileToCss(cp.X, cp.Z);
      return [sx + half, sy + half];
    });
    if (cps.length > 1) {
      ctx.lineWidth = 1.5;
      for (let i = 0; i < cps.length; i++) {
        const next = (i + 1) % cps.length;
        const [x1, y1] = centers[i], [x2, y2] = centers[next];
        const dx = x2 - x1, dy = y2 - y1;
        const len = Math.hypot(dx, dy);
        if (len < 0.01) continue;
        const px = -dy / len * halfW, py = dx / len * halfW;
        ctx.strokeStyle = 'rgba(255,200,50,0.55)';
        ctx.beginPath();
        ctx.moveTo(x1 + px, y1 + py); ctx.lineTo(x2 + px, y2 + py);
        ctx.moveTo(x1 - px, y1 - py); ctx.lineTo(x2 - px, y2 - py);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,200,50,0.25)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    ctx.font = `bold ${Math.max(9, Math.min(14, this.zoom * 0.8))}px Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let i = 0; i < cps.length; i++) {
      const [cx, cy] = centers[i];
      const prev = (i - 1 + cps.length) % cps.length;
      const next = (i + 1) % cps.length;
      const tdx = centers[next][0] - centers[prev][0];
      const tdy = centers[next][1] - centers[prev][1];
      const tlen = Math.hypot(tdx, tdy);
      let gx = halfW, gy = 0;
      if (tlen > 0.01) { gx = -tdy / tlen * halfW; gy = tdx / tlen * halfW; }

      ctx.strokeStyle = i === 0 ? 'rgba(60,255,80,0.9)' : 'rgba(255,255,255,0.75)';
      ctx.lineWidth = i === 0 ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.moveTo(cx - gx, cy - gy); ctx.lineTo(cx + gx, cy + gy);
      ctx.stroke();

      const mr = Math.max(8, this.zoom * 0.5);
      ctx.fillStyle = i === 0 ? 'rgba(60,255,80,0.85)'
                    : i === cps.length - 1 ? 'rgba(255,80,80,0.85)'
                    : 'rgba(255,220,50,0.85)';
      ctx.beginPath();
      ctx.arc(cx, cy, mr, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#fff';
      ctx.stroke();

      ctx.fillStyle = '#000';
      ctx.fillText((i + 1), cx + 0.5, cy + 0.5);
      ctx.fillStyle = '#fff';
      ctx.fillText((i + 1), cx, cy);
    }
  }

  _drawMarkers(ctx) {
    const half = this.zoom / 2;
    ctx.font = `bold ${Math.max(9, Math.min(14, this.zoom * 0.8))}px Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    for (let i = 0; i < this.markers.markers.length; i++) {
      const m = this.markers.markers[i];
      const [sx, sy] = this.tileToCss(m.X, m.Z);
      const cx = sx + half, cy = sy + half;
      const ds = Math.max(4, this.zoom * 0.6);
      const c = groupColor(m.Group);
      ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},0.85)`;
      ctx.beginPath();
      ctx.moveTo(cx, cy - ds);
      ctx.lineTo(cx + ds, cy);
      ctx.lineTo(cx, cy + ds);
      ctx.lineTo(cx - ds, cy);
      ctx.closePath();
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#fff';
      ctx.stroke();

      const label = m.Name || String(i + 1);
      ctx.fillStyle = '#000';
      ctx.fillText(label, cx + 0.5, cy + ds + 1.5);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, cx, cy + ds + 1);
    }
  }

  setDefaultMarker(opts) { this._defaultMarker = opts; }
}
