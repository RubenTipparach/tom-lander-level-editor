// Unified racing-level descriptor: one self-contained JSON document containing
// the map metadata, RAW heightmap bytes, race track checkpoints, and entity
// markers. The heightmap is base64-encoded as palette indices (0..31, one byte
// per tile) directly in Map.heightmap_b64. The JSON NEVER references an
// external PNG — a self-contained file cannot drift out of sync with a sidecar
// that a user might rename, delete, or mis-path.
//
//   {
//     "Map":   { name, width, height, heightmap_b64, has_water, has_grass,
//                spawn_aseprite=[x,z], terrain={...}|null, edge_walls?,
//                landing_pads?, altitude_limit?, altitude_warning_time?,
//                clamp_edges? },
//     "Track": { name, laps, width, checkpoints=[{x,z,y,time,name}, ...] },
//     "Markers":     [...],
//     "DualContour": false,
//     "NightMode":   false
//   }

import { Heightmap } from './heightmap.js';
import { MarkerSet } from './markers.js';
import { Track } from './track.js';

// Base64 helpers for Uint8Array (palette-index bytes, 0..31 each).
function bytesToBase64(buf) {
  // btoa expects a binary string; build it in chunks to avoid call-stack limits
  // on large maps (e.g. 512x512 = 262144 bytes).
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
function base64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function buildLevelJson({ heightmap, markers, track, terrain, mapMeta }) {
  return JSON.stringify({
    Map: {
      name:           mapMeta?.name ?? 'Untitled',
      width:          heightmap.width,
      height:         heightmap.height,
      heightmap_b64:  bytesToBase64(heightmap.data),
      has_water:      mapMeta?.has_water ?? !!terrain?.hasWater,
      has_grass:      mapMeta?.has_grass ?? true,
      spawn_aseprite: mapMeta?.spawn_aseprite ?? [
        track?.checkpoints?.[0]?.X ?? Math.floor(heightmap.width / 2),
        track?.checkpoints?.[0]?.Z ?? Math.floor(heightmap.height / 2),
      ],
      terrain:        mapMeta?.terrain ?? null,
      edge_walls:     mapMeta?.edge_walls ?? null,
      landing_pads:   mapMeta?.landing_pads ?? null,
      altitude_limit: mapMeta?.altitude_limit ?? null,
      altitude_warning_time: mapMeta?.altitude_warning_time ?? null,
      clamp_edges:    mapMeta?.clamp_edges ?? null,
      image:          mapMeta?.image ?? null,  // optional legacy sidecar path
    },
    Track: {
      name:        track?.name ?? mapMeta?.name ?? 'Untitled Track',
      laps:        track?.laps ?? 3,
      width:       track?.width ?? 6,
      checkpoints: (track?.checkpoints ?? []).map(cp => ({
        x: cp.X, z: cp.Z, y: cp.HeightAboveGround, time: cp.TimeLimit, name: cp.Name,
      })),
    },
    Markers:     markers?.markers ?? [],
    DualContour: !!markers?.dualContour,
    NightMode:   !!markers?.nightMode,
  }, null, 2);
}

// Parse a unified-JSON document into the editor's runtime models. The caller
// is responsible for fetching the heightmap PNG referenced by Map.image
// (because that depends on which directory served it).
export function parseLevelJson(text) {
  const o = JSON.parse(text);
  const m = o.Map || {};
  const t = o.Track || {};

  const markers = new MarkerSet();
  markers.markers = (o.Markers || []).map(x => ({
    X: x.X | 0, Z: x.Z | 0,
    HeightOffset: x.HeightOffset ?? 0,
    Name: x.Name ?? 'Marker',
    Group: x.Group ?? 'A',
  }));
  markers.dualContour = !!o.DualContour;
  markers.nightMode   = !!o.NightMode;

  const track = new Track();
  track.name  = t.name  ?? 'Untitled Track';
  track.laps  = t.laps  ?? 3;
  track.width = t.width ?? 6;
  track.checkpoints = (t.checkpoints || []).map(cp => ({
    X: cp.x | 0, Z: cp.z | 0,
    HeightAboveGround: cp.y ?? 8,
    TimeLimit: cp.time ?? 30,
    Name: cp.name ?? '',
  }));

  // Decode embedded heightmap bytes if present (authoritative).
  let heightmapBytes = null;
  if (typeof m.heightmap_b64 === 'string' && m.heightmap_b64.length > 0) {
    try { heightmapBytes = base64ToBytes(m.heightmap_b64); }
    catch (e) { /* malformed — caller falls back to image path */ }
  }

  return {
    map: {
      name:                  m.name ?? 'Untitled',
      image:                 m.image ?? '',
      width:                 m.width ?? 128,
      height:                m.height ?? 128,
      heightmap_bytes:       heightmapBytes,  // Uint8Array or null
      has_water:             m.has_water !== false,
      has_grass:             m.has_grass !== false,
      spawn_aseprite:        m.spawn_aseprite ?? [64, 64],
      terrain:               m.terrain ?? null,
      edge_walls:            m.edge_walls ?? null,
      landing_pads:          m.landing_pads ?? null,
      altitude_limit:        m.altitude_limit ?? null,
      altitude_warning_time: m.altitude_warning_time ?? null,
      clamp_edges:           m.clamp_edges ?? null,
    },
    track,
    markers,
  };
}
