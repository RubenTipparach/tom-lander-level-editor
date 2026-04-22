// Markers (entities) — JSON sidecar to the heightmap PNG.
// Schema matches the C# MarkerData (PascalCase fields).

import { History } from './history.js';

export const GROUP_COLORS = [
  ['A', [255, 80, 80]],
  ['B', [80, 255, 80]],
  ['C', [80, 120, 255]],
  ['D', [255, 200, 50]],
  ['E', [255, 100, 255]],
  ['F', [80, 255, 255]],
  ['G', [255, 160, 80]],
  ['H', [180, 180, 180]],
];

export function groupColor(group) {
  for (const [name, c] of GROUP_COLORS) if (name === group) return c;
  return GROUP_COLORS[0][1];
}

export function makeMarker(x, z, opts = {}) {
  return {
    X: x | 0,
    Z: z | 0,
    HeightOffset: opts.height ?? 0,
    Name: opts.name ?? 'Marker',
    Group: opts.group ?? 'A',
  };
}

export class MarkerSet {
  constructor() {
    this.markers = [];
    this.dualContour = false;
    this.nightMode = false;
    this.history = new History();
  }
  clone() {
    const m = new MarkerSet();
    m.markers = this.markers.map(x => ({ ...x }));
    m.dualContour = this.dualContour;
    m.nightMode = this.nightMode;
    return m;
  }
  snapshot() {
    return JSON.stringify({ markers: this.markers, dual: this.dualContour, night: this.nightMode });
  }
  restore(snap) {
    const o = JSON.parse(snap);
    this.markers = o.markers;
    this.dualContour = o.dual;
    this.nightMode = !!o.night;
  }
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

  add(x, z, opts) {
    const m = makeMarker(x, z, {
      ...opts,
      name: (opts?.name ?? 'Marker') + ' ' + (this.markers.length + 1),
    });
    this.markers.push(m);
    return m;
  }
  removeAt(i) {
    if (i >= 0 && i < this.markers.length) this.markers.splice(i, 1);
  }
  findNear(tx, tz, radius = 3) {
    const r2 = radius * radius;
    for (let i = 0; i < this.markers.length; i++) {
      const dx = this.markers[i].X - tx;
      const dz = this.markers[i].Z - tz;
      if (dx*dx + dz*dz <= r2) return i;
    }
    return -1;
  }

  toJsonString() {
    return JSON.stringify({
      Markers: this.markers,
      DualContour: this.dualContour,
      NightMode: this.nightMode,
    }, null, 2);
  }

  static fromJsonString(s) {
    const ms = new MarkerSet();
    if (!s) return ms;
    try {
      const o = JSON.parse(s);
      ms.markers = (o.Markers || []).map(m => ({
        X: m.X | 0,
        Z: m.Z | 0,
        HeightOffset: m.HeightOffset ?? 0,
        Name: m.Name ?? 'Marker',
        Group: m.Group ?? 'A',
      }));
      ms.dualContour = !!o.DualContour;
      ms.nightMode = !!o.NightMode;
    } catch (e) { /* malformed → empty */ }
    return ms;
  }
}
