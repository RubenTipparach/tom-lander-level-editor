// Map presets matching the C# MapConfig.AllMaps and Tilesets.
// Paths are relative to the configured "game root" URL (default: ../../).

export const TILESETS = [
  {
    name: 'Island (Sand/Grass/Rock)',
    lowToMid: 3, midToHigh: 10,
    hasWater: true,
    lowTex: 'assets/textures/14.png',
    midTex: 'assets/textures/15.png',
    highTex: 'assets/textures/16.png',
    waterTex: 'assets/textures/12.png',
    lowColor: [194, 178, 128],
    midColor: [76, 153, 0],
    highColor: [128, 128, 128],
    waterColor: [41, 173, 255],
  },
  {
    name: 'Desert (Sand/Desert/Rock)',
    lowToMid: 8, midToHigh: 27,
    hasWater: false,
    lowTex: 'assets/textures/14.png',
    midTex: 'assets/dessert_1.png',
    highTex: 'assets/dessert_rock.png',
    waterTex: 'assets/textures/12.png',
    lowColor: [210, 180, 120],
    midColor: [180, 140, 90],
    highColor: [140, 100, 70],
    waterColor: [41, 173, 255],
  },
  {
    // Arctic / snow set. Game-side mapping in heightmap.lua: ice (low) -> snow (mid) -> snow_rock (high).
    name: 'Arctic (Ice/Snow/Snowy Rock)',
    lowToMid: 4, midToHigh: 14,
    hasWater: true,
    lowTex: 'assets/ice.png',
    midTex: 'assets/snow.png',
    highTex: 'assets/snow_rock.png',
    waterTex: 'assets/ice.png',
    lowColor: [200, 220, 235],
    midColor: [240, 245, 250],
    highColor: [180, 190, 205],
    waterColor: [160, 200, 220],
  },
];

export const MAPS = [
  {
    displayName: 'Island (Act 1)', mapKey: 'act1',
    heightmapPath: 'assets/textures/64.png',
    width: 128, height: 128,
    tilesetIdx: 0,
  },
  {
    displayName: 'Desert Canyon (Act 2)', mapKey: 'act2',
    heightmapPath: 'assets/map_act_2.png',
    width: 128, height: 256,
    tilesetIdx: 1,
  },
  {
    displayName: 'Desert City (Act 2 M9)', mapKey: 'act2_m9',
    heightmapPath: 'assets/map_act_2_m9.png',
    width: 128, height: 128,
    tilesetIdx: 1,
  },
];

export const MISSIONS = [
  ['M1: Engine Test',         0],
  ['M2: Cargo Delivery',      0],
  ['M3: Scientific Mission',  0],
  ['M4: Ocean Rescue',        0],
  ['M5: Secret Weapon',       0],
  ['M6: Alien Invasion',      0],
  ['M7: Trench Run',          1],
  ['M8: VIP Extraction',      2],
  ['M9: Tank Defense',        2],
  ['M10: Firefighting',       2],
];

// Clone a tileset preset and apply runtime threshold edits. The terrain object
// returned is the canonical "current terrain" used by views.
export function makeTerrainFromTileset(idx) {
  const ts = TILESETS[idx];
  return {
    name: ts.name,
    lowToMid: ts.lowToMid,
    midToHigh: ts.midToHigh,
    hasWater: ts.hasWater,
    lowTex: ts.lowTex,
    midTex: ts.midTex,
    highTex: ts.highTex,
    waterTex: ts.waterTex,
    lowColor: [...ts.lowColor],
    midColor: [...ts.midColor],
    highColor: [...ts.highColor],
    waterColor: [...ts.waterColor],
  };
}
