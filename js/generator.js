// Procedural terrain generators: Perlin noise + various presets.
// Mirrors TerrainGenerator.cs.

import { Heightmap } from './heightmap.js';

let _perm = null;

function initPerm(seed) {
  const rng = mulberry32(seed >>> 0);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  _perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) _perm[i] = p[i & 255];
}

function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

function grad(hash, x, y) {
  const h = hash & 7;
  const u = h < 4 ? x : y;
  const v = h < 4 ? y : x;
  return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
}

function perlin(x, y) {
  const xi = Math.floor(x) & 255, yi = Math.floor(y) & 255;
  const xf = x - Math.floor(x), yf = y - Math.floor(y);
  const u = fade(xf), v = fade(yf);
  const aa = _perm[_perm[xi] + yi];
  const ab = _perm[_perm[xi] + yi + 1];
  const ba = _perm[_perm[xi + 1] + yi];
  const bb = _perm[_perm[xi + 1] + yi + 1];
  const x1 = lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u);
  const x2 = lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u);
  return lerp(x1, x2, v);
}

function lerp(a, b, t) { return a + t * (b - a); }

function fractalNoise(x, y, octaves, persistence, lacunarity) {
  let total = 0, amp = 1, freq = 1, max = 0;
  for (let i = 0; i < octaves; i++) {
    total += perlin(x * freq, y * freq) * amp;
    max += amp;
    amp *= persistence;
    freq *= lacunarity;
  }
  return (total / max + 1) * 0.5;
}

function mulberry32(a) {
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generate(kind, opts) {
  const { width = 128, height = 128, seed = 1, scale = 4, octaves = 5, maxHeight = 20 } = opts;
  initPerm(seed);
  const data = new Heightmap(width, height);
  const persistence = 0.5;
  const cx = width / 2, cy = height / 2;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nx = x / width * scale, ny = y / height * scale;
      let h = 0;
      const noise = fractalNoise(nx, ny, octaves, persistence, 2.0);

      if (kind === 'island') {
        const dx = (x - cx) / cx, dy = (y - cy) / cy;
        const dist = Math.sqrt(dx*dx + dy*dy);
        const radius = 0.4;
        let f = 1 - Math.max(0, Math.min(1, dist / radius));
        f *= f;
        h = noise * f * maxHeight;
        if (h <= 0) h = 0;
      } else if (kind === 'canyon') {
        const normalX = x / width;
        const center = fractalNoise(ny * 2, 0.5, 3, 0.5, 2.0) * 0.2 - 0.1;
        const dist = Math.abs(normalX - 0.5 + center);
        const half = 0.15;
        const wallBlend = dist < half ? 0 : Math.min(1, (dist - half) / 0.15);
        const floor = 5;
        h = floor + noise * 4 + wallBlend * (maxHeight - floor);
      } else if (kind === 'plateau') {
        const dx = (x - cx) / cx, dy = (y - cy) / cy;
        const dist = Math.sqrt(dx*dx + dy*dy);
        const edge = Math.max(0, Math.min(1, (0.35 - dist) * 8));
        h = 2 + edge * (maxHeight - 2) + noise * 3;
      } else if (kind === 'mountains') {
        const ridged = 1 - Math.abs(noise * 2 - 1);
        h = ridged * ridged * maxHeight;
      } else { // hills
        h = 1 + noise * (maxHeight - 1);
      }

      data.data[y * width + x] = Math.max(0, Math.min(31, Math.round(h)));
    }
  }
  return data;
}
