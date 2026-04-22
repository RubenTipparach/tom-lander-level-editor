// Race track data — list of checkpoints with .track text IO and Lua export.
// File format matches RaceTrackData.cs SaveToFile / LoadFromFile.

export function makeCheckpoint(x, z, name) {
  return {
    X: x | 0, Z: z | 0,
    HeightAboveGround: 10,
    TimeLimit: 30,
    Name: name || `CP ${x},${z}`,
  };
}

export class Track {
  constructor() {
    this.checkpoints = [];
    this.laps = 3;
    this.name = 'Custom Track';
    this.width = 6;
  }

  add(x, z) {
    const cp = makeCheckpoint(x, z, `CP ${this.checkpoints.length + 1}`);
    this.checkpoints.push(cp);
    return cp;
  }
  removeAt(i) {
    if (i >= 0 && i < this.checkpoints.length) this.checkpoints.splice(i, 1);
  }
  findNear(tx, tz, radius = 3) {
    const r2 = radius * radius;
    for (let i = 0; i < this.checkpoints.length; i++) {
      const dx = this.checkpoints[i].X - tx;
      const dz = this.checkpoints[i].Z - tz;
      if (dx*dx + dz*dz <= r2) return i;
    }
    return -1;
  }

  generateCircle(n, w, h, seed = 0) {
    this.checkpoints.length = 0;
    const rng = mulberry32(seed >>> 0);
    const cx = w / 2, cz = h / 2;
    const baseR = Math.min(w, h) * 0.35;
    for (let i = 0; i < n; i++) {
      const a = i * Math.PI * 2 / n;
      const wob = 1 + (rng() * 0.4 - 0.2);
      const r = baseR * wob;
      const x = Math.max(2, Math.min(w - 3, Math.round(cx + Math.cos(a) * r)));
      const z = Math.max(2, Math.min(h - 3, Math.round(cz + Math.sin(a) * r)));
      this.checkpoints.push(makeCheckpoint(x, z, `CP ${i + 1}`));
    }
  }

  exportLua(mapW, mapH) {
    const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const out = [];
    out.push(`-- Track: ${this.name}`);
    out.push(`-- Map size: ${mapW}x${mapH}`);
    out.push(`-- Laps: ${this.laps}`);
    out.push(`Mission.total_laps = ${this.laps}`);
    out.push(``);
    out.push(`checkpoints_aseprite = {`);
    for (const cp of this.checkpoints) {
      out.push(`    {x = ${cp.X}, z = ${cp.Z}, y = ${cp.HeightAboveGround}, time = ${cp.TimeLimit}, name = "${esc(cp.Name)}"},`);
    }
    out.push(`}`);
    return out.join('\n');
  }
}

function mulberry32(a) {
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
