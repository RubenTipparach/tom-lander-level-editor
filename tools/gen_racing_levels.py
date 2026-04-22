"""Generate sample racing levels for the Tom Lander web terrain editor.

Each level produces three files in samples/racing/:

  <name>.png     16-color Picotron-palette heightmap (128x128 by default).
  <name>.track   Plain-text track file (key=value + CSV) compatible with
                 the editor's race-track import/export.
  <name>.json    Combined level descriptor consumed by the game runtime
                 (level_loader.lua). Contains Map, Track, and Markers.

Run:  python tools/gen_racing_levels.py
"""
from __future__ import annotations

import json
import math
import os
import random
import struct
import sys
import zlib
from dataclasses import dataclass, field
from typing import Callable, List, Optional, Tuple

PALETTE = [
    (0x00,0x00,0x00),(0x1D,0x2B,0x53),(0x7E,0x25,0x53),(0x00,0x87,0x51),
    (0xAB,0x52,0x36),(0x5F,0x57,0x4F),(0xC2,0xC3,0xC7),(0xFF,0xF1,0xE8),
    (0xFF,0x00,0x4D),(0xFF,0xA3,0x00),(0xFF,0xEC,0x27),(0x00,0xE4,0x36),
    (0x29,0xAD,0xFF),(0x83,0x76,0x9C),(0xFF,0x77,0xA8),(0xFF,0xCC,0xAA),
    (0x1C,0x5E,0xAC),(0x00,0xA5,0xA1),(0x75,0x4E,0x97),(0x12,0x53,0x59),
    (0x74,0x2F,0x29),(0x49,0x2D,0x38),(0xA2,0x88,0x79),(0xFF,0xAC,0xC5),
    (0xC3,0x00,0x4C),(0xEB,0x6B,0x00),(0x90,0xEC,0x42),(0x00,0xB2,0x51),
    (0x64,0xDF,0xF6),(0xBD,0x9A,0xDF),(0xE4,0x0D,0xAB),(0xFF,0x85,0x6D),
]


# ───────── tiny PNG writer (no Pillow dependency) ─────────

def write_png(path: str, pixels: List[List[int]]):
    """Write an RGBA PNG. ``pixels`` is a list of rows of palette indices."""
    h = len(pixels)
    w = len(pixels[0])
    raw = bytearray()
    for row in pixels:
        raw.append(0)  # filter byte: None
        for idx in row:
            r, g, b = PALETTE[idx & 31]
            raw.extend((r, g, b, 0xFF))
    sig = b'\x89PNG\r\n\x1a\n'
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)  # RGBA, 8-bit
    idat = zlib.compress(bytes(raw), 9)
    with open(path, 'wb') as f:
        f.write(sig)
        f.write(chunk(b'IHDR', ihdr))
        f.write(chunk(b'IDAT', idat))
        f.write(chunk(b'IEND', b''))


# ───────── Perlin noise ─────────

class Perlin:
    def __init__(self, seed: int):
        rng = random.Random(seed)
        p = list(range(256))
        rng.shuffle(p)
        self.perm = p + p

    @staticmethod
    def _fade(t): return t * t * t * (t * (t * 6 - 15) + 10)

    @staticmethod
    def _grad(h, x, y):
        h &= 7
        u = x if h < 4 else y
        v = y if h < 4 else x
        return ((-u) if (h & 1) else u) + ((-v) if (h & 2) else v)

    def noise(self, x, y):
        xi = int(math.floor(x)) & 255
        yi = int(math.floor(y)) & 255
        xf = x - math.floor(x)
        yf = y - math.floor(y)
        u = self._fade(xf); v = self._fade(yf)
        aa = self.perm[self.perm[xi] + yi]
        ab = self.perm[self.perm[xi] + yi + 1]
        ba = self.perm[self.perm[xi + 1] + yi]
        bb = self.perm[self.perm[xi + 1] + yi + 1]
        x1 = self._lerp(self._grad(aa, xf, yf), self._grad(ba, xf - 1, yf), u)
        x2 = self._lerp(self._grad(ab, xf, yf - 1), self._grad(bb, xf - 1, yf - 1), u)
        return self._lerp(x1, x2, v)

    @staticmethod
    def _lerp(a, b, t): return a + t * (b - a)

    def fractal(self, x, y, octaves=5, persistence=0.5, lacunarity=2.0):
        total = 0.0; amp = 1.0; freq = 1.0; mx = 0.0
        for _ in range(octaves):
            total += self.noise(x * freq, y * freq) * amp
            mx += amp; amp *= persistence; freq *= lacunarity
        return (total / mx + 1.0) * 0.5


# ───────── Track shape helpers ─────────

@dataclass
class Checkpoint:
    x: int
    z: int
    y: int = 8
    time: int = 30
    name: str = ''

@dataclass
class LevelSpec:
    name: str
    file_basename: str
    width: int = 128
    height: int = 128
    seed: int = 1
    has_water: bool = True
    has_grass: bool = True
    base_terrain: str = 'island'   # 'island' | 'canyon' | 'mountains'
    track_shape: str = 'circle'    # 'circle' | 'oval' | 'figure8' | 'spline'
    checkpoint_count: int = 8
    track_width: int = 8           # tiles
    track_height: int = 1          # palette idx for track surface
    laps: int = 3
    spawn_offset: Tuple[int, int] = (0, -2)   # offset from CP1 (x, z)
    spline_points: Optional[List[Tuple[float, float]]] = None
    markers: List[dict] = field(default_factory=list)
    night_mode: bool = False
    terrain: Optional[dict] = None  # ground_to_mid / mid_to_high overrides


def build_path(spec: LevelSpec) -> List[Tuple[float, float]]:
    """Return ordered (x, z) centers in tile space for the racing path."""
    cx = spec.width / 2
    cz = spec.height / 2
    rng = random.Random(spec.seed * 17 + 31)

    if spec.track_shape == 'circle':
        rad = min(spec.width, spec.height) * 0.34
        return [
            (cx + math.cos(2 * math.pi * i / spec.checkpoint_count) * rad
                * (1 + (rng.random() * 0.20 - 0.10)),
             cz + math.sin(2 * math.pi * i / spec.checkpoint_count) * rad
                * (1 + (rng.random() * 0.20 - 0.10)))
            for i in range(spec.checkpoint_count)
        ]
    if spec.track_shape == 'oval':
        ra = spec.width * 0.38
        rb = spec.height * 0.28
        return [
            (cx + math.cos(2 * math.pi * i / spec.checkpoint_count) * ra,
             cz + math.sin(2 * math.pi * i / spec.checkpoint_count) * rb)
            for i in range(spec.checkpoint_count)
        ]
    if spec.track_shape == 'figure8':
        out = []
        for i in range(spec.checkpoint_count):
            t = 2 * math.pi * i / spec.checkpoint_count
            x = cx + math.sin(t) * spec.width * 0.30
            z = cz + math.sin(t * 2) * spec.height * 0.22
            out.append((x, z))
        return out
    if spec.track_shape == 'spline' and spec.spline_points:
        return list(spec.spline_points)
    raise ValueError(f'unknown track_shape {spec.track_shape}')


def carve_track(heights: List[List[int]], path: List[Tuple[float, float]],
                track_width: int, track_height: int):
    """Flatten the track corridor to ``track_height`` along the closed path."""
    h = len(heights); w = len(heights[0])
    half = track_width / 2.0 + 0.5
    n = len(path)
    seg_min = []
    for i in range(n):
        a = path[i]; b = path[(i + 1) % n]
        seg_min.append((a, b))

    for y in range(h):
        for x in range(w):
            best = 1e9
            for (a, b) in seg_min:
                d = point_segment_dist(x, y, a[0], a[1], b[0], b[1])
                if d < best: best = d
            if best <= half:
                heights[y][x] = track_height
            elif best <= half + 1.5:
                # smooth shoulder (lift slightly)
                heights[y][x] = max(track_height, min(heights[y][x], track_height + 2))


def add_track_walls(heights: List[List[int]], path: List[Tuple[float, float]],
                    track_width: int, wall_height: int = 12, thickness: float = 1.5):
    """Raise pixels just outside the track to form contoured walls."""
    h = len(heights); w = len(heights[0])
    inner = track_width / 2.0 + 0.5
    outer = inner + thickness
    n = len(path)
    for y in range(h):
        for x in range(w):
            best = 1e9
            for i in range(n):
                a = path[i]; b = path[(i + 1) % n]
                d = point_segment_dist(x, y, a[0], a[1], b[0], b[1])
                if d < best: best = d
            if inner < best <= outer:
                heights[y][x] = max(heights[y][x], wall_height)


def point_segment_dist(px, py, ax, ay, bx, by):
    dx = bx - ax; dy = by - ay
    L2 = dx * dx + dy * dy
    if L2 < 1e-9: return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
    qx = ax + t * dx; qy = ay + t * dy
    return math.hypot(px - qx, py - qy)


# ───────── Base terrain ─────────

def base_island(spec: LevelSpec) -> List[List[int]]:
    p = Perlin(spec.seed)
    w, h = spec.width, spec.height
    grid = [[0] * w for _ in range(h)]
    cx, cy = w / 2, h / 2
    for y in range(h):
        for x in range(w):
            n = p.fractal(x / w * 4.0, y / h * 4.0, octaves=5)
            dx = (x - cx) / cx; dy = (y - cy) / cy
            dist = math.hypot(dx, dy)
            falloff = max(0.0, 1.0 - min(1.0, dist / 0.95))
            falloff = falloff ** 1.5
            ridge = max(0.0, 1.0 - 1.6 * abs(n - 0.5))
            v = 1 + (n * 0.6 + ridge * 0.4) * falloff * 18
            if dist > 0.92: v = 0  # sea border
            grid[y][x] = max(0, min(31, int(round(v))))
    return grid

def base_canyon(spec: LevelSpec) -> List[List[int]]:
    p = Perlin(spec.seed)
    w, h = spec.width, spec.height
    grid = [[0] * w for _ in range(h)]
    for y in range(h):
        for x in range(w):
            n = p.fractal(x / w * 3.0, y / h * 3.0, octaves=4)
            normalX = x / w
            wobble = p.fractal(y * 0.04, 0.5, 3, 0.5, 2.0) * 0.18 - 0.09
            dist_center = abs(normalX - 0.5 + wobble)
            wall = 0.0
            if dist_center < 0.18: wall = 0.0
            else: wall = min(1.0, (dist_center - 0.18) / 0.18)
            v = 4 + n * 4 + wall * 22
            grid[y][x] = max(0, min(31, int(round(v))))
    return grid

def base_mountains(spec: LevelSpec) -> List[List[int]]:
    p = Perlin(spec.seed)
    w, h = spec.width, spec.height
    grid = [[0] * w for _ in range(h)]
    for y in range(h):
        for x in range(w):
            n = p.fractal(x / w * 3.5, y / h * 3.5, octaves=6)
            ridged = (1.0 - abs(n * 2 - 1)) ** 1.6
            grid[y][x] = max(0, min(31, int(round(ridged * 26 + 1))))
    return grid


# ───────── Build a level ─────────

def build_level(spec: LevelSpec, out_dir: str):
    if spec.base_terrain == 'island':    grid = base_island(spec)
    elif spec.base_terrain == 'canyon':  grid = base_canyon(spec)
    else:                                grid = base_mountains(spec)

    path = build_path(spec)
    add_track_walls(grid, path, spec.track_width, wall_height=11)
    carve_track(grid, path, spec.track_width, spec.track_height)

    # Ensure spawn area is flat
    spx, spz = path[0]
    sx = int(round(spx + spec.spawn_offset[0]))
    sz = int(round(spz + spec.spawn_offset[1]))
    for y in range(max(0, sz - 3), min(spec.height, sz + 4)):
        for x in range(max(0, sx - 3), min(spec.width, sx + 4)):
            grid[y][x] = spec.track_height

    os.makedirs(out_dir, exist_ok=True)
    png_path   = os.path.join(out_dir, spec.file_basename + '.png')
    track_path = os.path.join(out_dir, spec.file_basename + '.track')
    json_path  = os.path.join(out_dir, spec.file_basename + '.json')

    write_png(png_path, grid)

    # Build checkpoints
    checkpoints: List[Checkpoint] = []
    for i, (x, z) in enumerate(path):
        checkpoints.append(Checkpoint(
            x=int(round(x)), z=int(round(z)),
            y=8, time=30,
            name=f'CP {i + 1}',
        ))

    # .track file
    with open(track_path, 'w', encoding='utf-8') as f:
        f.write(f'name={spec.name}\n')
        f.write(f'laps={spec.laps}\n')
        f.write(f'width={spec.track_width}\n')
        f.write(f'checkpoints={len(checkpoints)}\n')
        for cp in checkpoints:
            f.write(f'{cp.x},{cp.z},{cp.y},{cp.time},{cp.name}\n')

    # JSON level descriptor (game-loadable + editor-compatible)
    level = {
        'Map': {
            'name': spec.name,
            'image': f'assets/racing_maps/{spec.file_basename}.png',
            'width': spec.width,
            'height': spec.height,
            'has_water': spec.has_water,
            'has_grass': spec.has_grass,
            'spawn_aseprite': [sx, sz],
            'terrain': spec.terrain,
        },
        'Track': {
            'name': spec.name,
            'laps': spec.laps,
            'width': spec.track_width,
            'checkpoints': [
                {'x': cp.x, 'z': cp.z, 'y': cp.y, 'time': cp.time, 'name': cp.name}
                for cp in checkpoints
            ],
        },
        'Markers': spec.markers,
        'DualContour': False,
        'NightMode': spec.night_mode,
    }
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(level, f, indent=2)

    print(f'  wrote {png_path}  ({spec.width}x{spec.height})')
    print(f'  wrote {track_path}')
    print(f'  wrote {json_path}')


# ───────── Specs ─────────

def specs() -> List[LevelSpec]:
    return [
        LevelSpec(
            name='Resort Cruise',
            file_basename='resort_cruise',
            width=128, height=128, seed=42,
            has_water=True, has_grass=True,
            base_terrain='island',
            track_shape='circle',
            checkpoint_count=8,
            track_width=8, track_height=2,
            laps=3,
            spawn_offset=(0, -3),
            markers=[
                {'X': 64, 'Z': 30, 'HeightOffset': 0, 'Name': 'Start Pad', 'Group': 'A'},
                {'X': 96, 'Z': 64, 'HeightOffset': 0, 'Name': 'Pit Stop',  'Group': 'B'},
                {'X': 32, 'Z': 64, 'HeightOffset': 0, 'Name': 'Pit Stop',  'Group': 'B'},
            ],
        ),
        LevelSpec(
            name='Canyon Sprint',
            file_basename='canyon_racing_level',
            width=128, height=256, seed=7,
            has_water=False, has_grass=False,
            base_terrain='canyon',
            track_shape='spline',
            spline_points=[
                (64, 220), (60, 190), (66, 160), (62, 130),
                (68, 100), (60,  70), (66,  40), (64,  18),
                (66,  40), (60,  70), (68, 100), (62, 130), (66, 160), (60, 190),
            ],
            checkpoint_count=8,
            track_width=10, track_height=4,
            laps=2,
            spawn_offset=(0, 4),
            terrain={
                'ground_to_mid': 8, 'mid_to_high': 27,
                'ground_mid_blend': 2.0, 'mid_high_blend': 3.0,
            },
            markers=[
                {'X': 64, 'Z': 220, 'HeightOffset': 0, 'Name': 'Start',    'Group': 'A'},
                {'X': 64, 'Z':  18, 'HeightOffset': 0, 'Name': 'Apex',     'Group': 'D'},
            ],
        ),
        LevelSpec(
            name='Mountain Loop',
            file_basename='mountain_loop_level',
            width=128, height=128, seed=99,
            has_water=False, has_grass=True,
            base_terrain='mountains',
            track_shape='figure8',
            checkpoint_count=10,
            track_width=7, track_height=3,
            laps=2,
            spawn_offset=(0, -3),
            markers=[
                {'X': 64, 'Z': 64, 'HeightOffset': 0, 'Name': 'Apex Camera', 'Group': 'C'},
            ],
        ),
    ]


def main():
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'samples', 'racing')
    out = os.path.normpath(out)
    print(f'Writing levels to: {out}')
    for spec in specs():
        print(f'\n[{spec.name}]')
        build_level(spec, out)
    print('\nDone.')


if __name__ == '__main__':
    main()
