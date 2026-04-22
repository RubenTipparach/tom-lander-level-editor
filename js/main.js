// Top-level wiring for the web terrain editor.

import { PALETTE, isDarkSwatch, colorToCss } from './palette.js';
import { Heightmap, loadImage } from './heightmap.js';
import { MarkerSet, GROUP_COLORS } from './markers.js';
import { Track } from './track.js';
import { Terrain2D } from './terrain2d.js';
import { Terrain3D } from './terrain3d.js';
import { generate } from './generator.js';
import { TILESETS, MAPS, MISSIONS, makeTerrainFromTileset } from './maps.js';
import { buildLevelJson, parseLevelJson } from './level.js';
import {
  HAS_FS, downloadBlob, saveBlob, writeToHandle, pickPng,
  listSnapshots, saveSnapshot, deleteSnapshot,
} from './persistence.js';

// ───── State ─────

const state = {
  heightmap: null,
  markers: new MarkerSet(),
  track: new Track(),
  terrain: makeTerrainFromTileset(0),
  tilesetIdx: 0,
  filePath: '',           // base name without extension
  pngHandle: null,        // FS Access handle for the heightmap PNG
  jsonHandle: null,       // FS Access handle for the unified level JSON
  mapMeta: null,          // extra Map fields preserved across save/load
  gameRoot: localStorage.getItem('webTE.gameRoot') || autoDetectGameRoot(),
  selectedHeight: 1,
};

// ───── DOM refs ─────

const $ = id => document.getElementById(id);
const canvas2d = $('canvas2d');
const canvas3d = $('canvas3d');
const view2d = new Terrain2D(canvas2d);
const view3d = new Terrain3D(canvas3d);

view2d.setMarkers(state.markers);
view2d.setTrack(state.track);
view3d.setMarkers(state.markers);
view3d.setTrack(state.track);

// ───── Menus ─────

const MAPS_MENU = $('mapsDropdown');
function buildMapsMenu() {
  MAPS_MENU.innerHTML = '';
  for (let i = 0; i < MAPS.length; i++) {
    const m = MAPS[i];
    const b = document.createElement('button');
    b.textContent = `${m.displayName}  (${m.width}x${m.height})`;
    b.onclick = () => loadMapPreset(i);
    MAPS_MENU.appendChild(b);
  }
  MAPS_MENU.appendChild(document.createElement('hr'));
  for (let i = 0; i < MISSIONS.length; i++) {
    const [name, idx] = MISSIONS[i];
    const b = document.createElement('button');
    b.textContent = name;
    b.onclick = () => loadMapPreset(idx);
    MAPS_MENU.appendChild(b);
  }
}
buildMapsMenu();

document.querySelectorAll('#menubar .menu').forEach(menu => {
  const btn = menu.querySelector(':scope > button');
  btn.addEventListener('click', e => {
    e.stopPropagation();
    document.querySelectorAll('#menubar .menu').forEach(m => { if (m !== menu) m.classList.remove('open'); });
    menu.classList.toggle('open');
  });
});
document.body.addEventListener('click', () => {
  document.querySelectorAll('#menubar .menu.open').forEach(m => m.classList.remove('open'));
});
document.querySelectorAll('#menubar .dropdown button').forEach(b => {
  const act = b.dataset.act;
  if (!act) return;
  b.addEventListener('click', () => menuAction(act));
});

function menuAction(act) {
  switch (act) {
    case 'new': openNewDialog(); break;
    case 'open-level': openLevel(); break;
    case 'open': openPng(); break;
    case 'save-level': saveLevel(); break;
    case 'save-level-as': saveLevelAs(); break;
    case 'save-png': downloadPng(); break;
    case 'set-game-root': showGameRootDialog(); break;
    case 'undo': performUndo(); break;
    case 'redo': performRedo(); break;
    case 'snapshot-save': quickSnapshot(); break;
    case 'snapshot-manage': openSnapshotDialog(); break;
    case 'gen-island':    showGenerate('island'); break;
    case 'gen-canyon':    showGenerate('canyon'); break;
    case 'gen-hills':     showGenerate('hills'); break;
    case 'gen-plateau':   showGenerate('plateau'); break;
    case 'gen-mountains': showGenerate('mountains'); break;
    case 'track-new': newTrack(); break;
    case 'track-export-lua': exportTrackLua(); break;
    case 'track-clear': state.track.checkpoints.length = 0; refreshTrackUI(); view2d.draw(); view3d.markDirty(); break;
  }
}

// ───── Toolbar ─────

document.querySelectorAll('button.tool').forEach(b => {
  b.onclick = () => selectTool(b.dataset.tool);
});
function selectTool(tool) {
  document.querySelectorAll('button.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  view2d.tool = tool;
  $('trackPanel').classList.toggle('hidden', tool !== 'checkpoints');
  $('markerPanel').classList.toggle('hidden', tool !== 'markers' && tool !== 'markers-move');
}

$('brushHeight').oninput = e => { state.selectedHeight = clamp(parseInt(e.target.value || '0'), 0, 31); view2d.brushHeight = state.selectedHeight; updatePaletteSelection(); };
$('brushSize').oninput = e => { view2d.brushRadius = clamp(parseInt(e.target.value || '0'), 0, 32); view2d.draw(); };
$('brushDown').onclick = () => { view2d.brushRadius = Math.max(0, view2d.brushRadius - 1); $('brushSize').value = view2d.brushRadius; view2d.draw(); };
$('brushUp').onclick   = () => { view2d.brushRadius = Math.min(32, view2d.brushRadius + 1); $('brushSize').value = view2d.brushRadius; view2d.draw(); };

$('toggleZones').onclick = () => {
  $('toggleZones').classList.toggle('active');
  $('toggleTextured').classList.remove('active');
  view2d.setViewMode($('toggleZones').classList.contains('active') ? 'zones' : 'palette');
  view3d.setTextured(false);
};
$('toggleTextured').onclick = () => {
  $('toggleTextured').classList.toggle('active');
  $('toggleZones').classList.remove('active');
  const on = $('toggleTextured').classList.contains('active');
  view2d.setViewMode(on ? 'textured' : 'palette');
  view3d.setTextured(on);
};
$('reset3D').onclick = () => view3d.resetCamera();

// ───── Palette swatches ─────

const paletteEl = $('palette');
for (let i = 0; i < 32; i++) {
  const sw = document.createElement('div');
  sw.className = 'swatch' + (isDarkSwatch(i) ? ' dark' : '');
  sw.style.background = colorToCss(i);
  sw.textContent = i;
  sw.onclick = () => selectHeight(i);
  paletteEl.appendChild(sw);
}
function selectHeight(h) {
  state.selectedHeight = h;
  $('brushHeight').value = h;
  view2d.brushHeight = h;
  updatePaletteSelection();
}
function updatePaletteSelection() {
  paletteEl.querySelectorAll('.swatch').forEach((el, i) => el.classList.toggle('selected', i === state.selectedHeight));
}
selectHeight(1);

// ───── Tileset / terrain ─────

const tilesetSel = $('tileset');
TILESETS.forEach((t, i) => {
  const o = document.createElement('option');
  o.value = i; o.textContent = t.name;
  tilesetSel.appendChild(o);
});
tilesetSel.onchange = () => applyTileset(parseInt(tilesetSel.value));

$('lowMid').oninput = () => updateThresholds();
$('midHigh').oninput = () => updateThresholds();
function updateThresholds() {
  state.terrain.lowToMid = clamp(parseInt($('lowMid').value), 1, 30);
  state.terrain.midToHigh = clamp(parseInt($('midHigh').value), 2, 31);
  updateTextureLabels();
  view2d.invalidateBuffer(); view2d.draw();
  view3d.markDirty();
}
function updateTextureLabels() {
  const t = state.terrain;
  $('lblTexLow').textContent  = `H: 0-${t.lowToMid - 1}`;
  $('lblTexMid').textContent  = `H: ${t.lowToMid}-${t.midToHigh - 1}`;
  $('lblTexHigh').textContent = `H: ${t.midToHigh}-31`;
  $('lblTexWater').textContent = t.hasWater ? 'idx 0' : '(off)';
}

$('dualContour').onchange = () => {
  state.markers.dualContour = $('dualContour').checked;
  status(state.markers.dualContour ? 'Dual contouring enabled. Save to persist.'
                                   : 'Dual contouring disabled. Save to persist.');
};

$('nightMode').onchange = () => {
  state.markers.nightMode = $('nightMode').checked;
  status(state.markers.nightMode ? 'Night mode enabled. Save to persist.'
                                 : 'Night mode disabled. Save to persist.');
};

async function applyTileset(idx) {
  state.tilesetIdx = idx;
  state.terrain = makeTerrainFromTileset(idx);
  $('lowMid').value = state.terrain.lowToMid;
  $('midHigh').value = state.terrain.midToHigh;
  updateTextureLabels();
  await loadTerrainTextures();
  view2d.setTerrain(state.terrain);
  view3d.setTerrain(state.terrain);
}

async function loadTerrainTextures() {
  const t = state.terrain;
  const tryLoad = async (path) => {
    const roots = uniqueRoots(state.gameRoot, './');
    for (const r of roots) {
      try { return await loadImage(r + path); } catch { /* try next root */ }
    }
    return null;
  };
  const [low, mid, high, water] = await Promise.all([
    tryLoad(t.lowTex), tryLoad(t.midTex), tryLoad(t.highTex), tryLoad(t.waterTex),
  ]);
  view2d.setTextures({ low, mid, high, water });
  view3d.setTextureImages({ low, mid, high, water });
  drawTexPreview('texLow', low);
  drawTexPreview('texMid', mid);
  drawTexPreview('texHigh', high);
  drawTexPreview('texWater', water);
  if (low) state.terrain.lowColor = avgColor(low);
  if (mid) state.terrain.midColor = avgColor(mid);
  if (high) state.terrain.highColor = avgColor(high);
  if (water) state.terrain.waterColor = avgColor(water);
}

function avgColor(img) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let r=0,g=0,b=0,n=c.width*c.height;
  for (let i=0;i<d.length;i+=4){ r+=d[i]; g+=d[i+1]; b+=d[i+2]; }
  return [Math.round(r/n), Math.round(g/n), Math.round(b/n)];
}

function drawTexPreview(id, img) {
  const c = $(id);
  c.width = 64; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#222'; ctx.fillRect(0, 0, 64, 64);
  if (img) ctx.drawImage(img, 0, 0, 64, 64);
}

// ───── 2D view callbacks ─────

view2d.onChange = (final) => {
  view3d.markDirty();
  updateTitle();
};
view2d.onCursor = (x, y, h) => {
  if (state.heightmap && x >= 0 && x < state.heightmap.width && y >= 0 && y < state.heightmap.height)
    $('cursorInfo').textContent = `Tile (${x},${y})  Height ${h}`;
  else
    $('cursorInfo').textContent = '';
};
view2d.onTrackChange = () => { refreshTrackUI(); view3d.setTrack(state.track); };
view2d.onMarkerChange = () => { refreshMarkerUI(); view3d.setMarkers(state.markers); };
view2d.onMarkerSelect = i => selectMarkerInList(i);

// ───── Track UI ─────

const cpListEl = $('cpList');
$('trackName').oninput  = () => state.track.name = $('trackName').value;
$('trackLaps').oninput  = () => state.track.laps = clamp(parseInt($('trackLaps').value || '1'), 1, 10);
$('trackWidth').oninput = () => { state.track.width = clamp(parseInt($('trackWidth').value || '2'), 2, 30); view2d.draw(); view3d.setTrack(state.track); };
$('cpHeight').oninput = () => updateSelectedCpProps();
$('cpTime').oninput   = () => updateSelectedCpProps();
$('cpName').oninput   = () => updateSelectedCpProps();
$('cpUp').onclick     = () => moveCp(-1);
$('cpDown').onclick   = () => moveCp(1);
$('cpDelete').onclick = () => {
  const i = currentCpIndex();
  if (i >= 0) { state.track.removeAt(i); refreshTrackUI(); view2d.draw(); view3d.setTrack(state.track); }
};

function refreshTrackUI() {
  $('trackName').value = state.track.name;
  $('trackLaps').value = state.track.laps;
  $('trackWidth').value = state.track.width;
  cpListEl.innerHTML = '';
  state.track.checkpoints.forEach((cp, i) => {
    const li = document.createElement('li');
    li.textContent = `${i + 1}. ${cp.Name} (${cp.X},${cp.Z}) h=${cp.HeightAboveGround} t=${cp.TimeLimit}s`;
    li.onclick = () => selectCp(i);
    cpListEl.appendChild(li);
  });
  view2d.draw();
}

let _selectedCp = -1;
function selectCp(i) {
  _selectedCp = i;
  cpListEl.querySelectorAll('li').forEach((el, idx) => el.classList.toggle('selected', idx === i));
  if (i >= 0 && i < state.track.checkpoints.length) {
    const cp = state.track.checkpoints[i];
    $('cpHeight').value = cp.HeightAboveGround;
    $('cpTime').value = cp.TimeLimit;
    $('cpName').value = cp.Name;
  }
}
function currentCpIndex() { return _selectedCp; }
function updateSelectedCpProps() {
  const i = currentCpIndex();
  if (i < 0 || i >= state.track.checkpoints.length) return;
  const cp = state.track.checkpoints[i];
  cp.HeightAboveGround = parseInt($('cpHeight').value) || cp.HeightAboveGround;
  cp.TimeLimit = parseInt($('cpTime').value) || cp.TimeLimit;
  cp.Name = $('cpName').value;
  refreshTrackUI();
  selectCp(i);
  view3d.setTrack(state.track);
}
function moveCp(dir) {
  const i = currentCpIndex();
  const j = i + dir;
  if (i < 0 || j < 0 || j >= state.track.checkpoints.length) return;
  const arr = state.track.checkpoints;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  refreshTrackUI(); selectCp(j);
  view3d.setTrack(state.track);
}

function newTrack() {
  const w = state.heightmap?.width ?? 128;
  const h = state.heightmap?.height ?? 128;
  state.track = new Track();
  state.track.generateCircle(8, w, h, Math.floor(Math.random() * 99999));
  view2d.setTrack(state.track);
  view3d.setTrack(state.track);
  refreshTrackUI();
  status(`Generated ${state.track.checkpoints.length} checkpoints.`);
}

function exportTrackLua() {
  if (!state.track.checkpoints.length) { status('No checkpoints to export.'); return; }
  const w = state.heightmap?.width ?? 128;
  const h = state.heightmap?.height ?? 128;
  const blob = new Blob([state.track.exportLua(w, h)], { type: 'text/plain' });
  saveBlob(blob, `track_${state.track.name.replace(/\s+/g, '_').toLowerCase()}.lua`,
    [{ description: 'Lua', accept: { 'text/plain': ['.lua', '.txt'] } }]);
}

// ───── Marker UI ─────

const markerListEl = $('markerList');
const newGroupSel = $('newGroup');
const editGroupSel = $('markerGroup');
GROUP_COLORS.forEach(([name]) => {
  for (const sel of [newGroupSel, editGroupSel]) {
    const o = document.createElement('option');
    o.value = name; o.textContent = name;
    sel.appendChild(o);
  }
});

function syncDefaultMarker() {
  view2d.setDefaultMarker({
    group: newGroupSel.value,
    name: $('newPrefix').value || 'Marker',
    height: parseInt($('newHeight').value) || 0,
  });
}
newGroupSel.onchange = syncDefaultMarker;
$('newPrefix').oninput = syncDefaultMarker;
$('newHeight').oninput = syncDefaultMarker;
syncDefaultMarker();

let _selectedMarker = -1;
function refreshMarkerUI() {
  markerListEl.innerHTML = '';
  state.markers.markers.forEach((m, i) => {
    const li = document.createElement('li');
    li.textContent = `[${m.Group}] ${m.Name} (${m.X},${m.Z}) h=${m.HeightOffset}`;
    li.onclick = () => selectMarkerInList(i);
    markerListEl.appendChild(li);
  });
  if (_selectedMarker >= 0) selectMarkerInList(_selectedMarker, true);
  view2d.draw();
}
function selectMarkerInList(i, dontEdit) {
  _selectedMarker = i;
  markerListEl.querySelectorAll('li').forEach((el, idx) => el.classList.toggle('selected', idx === i));
  if (i < 0 || i >= state.markers.markers.length) return;
  if (dontEdit) return;
  const m = state.markers.markers[i];
  $('markerName').value = m.Name;
  $('markerX').value = m.X;
  $('markerZ').value = m.Z;
  $('markerHeight').value = m.HeightOffset;
  editGroupSel.value = m.Group;
}

function applyMarkerEdit() {
  const i = _selectedMarker;
  if (i < 0 || i >= state.markers.markers.length) return;
  state.markers.pushUndo();
  const m = state.markers.markers[i];
  m.Name = $('markerName').value;
  m.X = parseInt($('markerX').value) || 0;
  m.Z = parseInt($('markerZ').value) || 0;
  m.HeightOffset = parseInt($('markerHeight').value) || 0;
  m.Group = editGroupSel.value;
  refreshMarkerUI();
  view2d.draw(); view3d.setMarkers(state.markers);
}
['markerName', 'markerX', 'markerZ', 'markerHeight'].forEach(id => $(id).oninput = applyMarkerEdit);
editGroupSel.onchange = applyMarkerEdit;

$('markerDelete').onclick = () => {
  if (_selectedMarker < 0) return;
  state.markers.pushUndo();
  state.markers.removeAt(_selectedMarker);
  _selectedMarker = -1;
  refreshMarkerUI();
  view2d.draw(); view3d.setMarkers(state.markers);
};
$('markerClear').onclick = () => {
  if (!state.markers.markers.length) return;
  if (!confirm('Clear all markers?')) return;
  state.markers.pushUndo();
  state.markers.markers.length = 0;
  _selectedMarker = -1;
  refreshMarkerUI();
  view2d.draw(); view3d.setMarkers(state.markers);
};

// ───── File operations ─────

const fileOpen = $('fileOpen');
fileOpen.onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  await loadHeightmapFile(f);
  e.target.value = '';
};
async function openPng() { fileOpen.click(); }

// ── Open Level (unified JSON) ─────────────────────────────────────────────
async function openLevel() { $('fileOpenLevel').click(); }
$('fileOpenLevel').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  await loadLevelFile(f);
  e.target.value = '';
};
async function loadLevelFile(f) {
  let text;
  try { text = await f.text(); }
  catch (e) { status('Cannot read file: ' + e.message); return; }
  let parsed;
  try { parsed = parseLevelJson(text); }
  catch (e) { status('Invalid JSON: ' + e.message); return; }

  // Pull the heightmap PNG referenced by Map.image.
  const candidates = uniqueRoots(state.gameRoot, './').map(r => r + parsed.map.image)
    .concat(['./samples/racing/' + parsed.map.image.split('/').pop()]);
  let png = null;
  for (const u of candidates) {
    try { const r = await fetch(u); if (r.ok) { png = await r.blob(); break; } }
    catch { /* keep trying */ }
  }
  if (!png) {
    status(`Loaded JSON but could not fetch ${parsed.map.image}. Use File > Open PNG only to load the heightmap, or Set Game Root URL.`);
    return;
  }

  state.heightmap = await Heightmap.fromPng(png);
  state.heightmap.filePath = parsed.map.image.split('/').pop();
  state.filePath = (f.name || parsed.map.image.split('/').pop()).replace(/\.json$/i, '');
  state.markers = parsed.markers;
  state.track   = parsed.track;
  state.mapMeta = parsed.map;

  view2d.setHeightmap(state.heightmap, state.terrain);
  view2d.setMarkers(state.markers);
  view2d.setTrack(state.track);
  view3d.setHeightmap(state.heightmap, state.terrain);
  view3d.setMarkers(state.markers);
  view3d.setTrack(state.track);
  $('dualContour').checked = !!state.markers.dualContour;
  $('nightMode').checked = !!state.markers.nightMode;
  refreshMarkerUI();
  refreshTrackUI();
  status(`Loaded level "${parsed.map.name}" — ${state.track.checkpoints.length} checkpoints, ${state.markers.markers.length} markers.`);
  updateTitle();
}

// ── Open PNG only (legacy heightmap-only mode) ───────────────────────────
async function loadHeightmapFile(f) {
  try {
    state.heightmap = await Heightmap.fromPng(f);
    state.heightmap.filePath = f.name;
    state.filePath = f.name.replace(/\.png$/i, '');
    state.markers = new MarkerSet();
    state.track = new Track();
    state.mapMeta = null;
    view2d.setHeightmap(state.heightmap, state.terrain);
    view2d.setMarkers(state.markers);
    view2d.setTrack(state.track);
    view3d.setHeightmap(state.heightmap, state.terrain);
    view3d.setMarkers(state.markers);
    view3d.setTrack(state.track);
    refreshMarkerUI();
    refreshTrackUI();
    $('dualContour').checked = false;
    $('nightMode').checked = false;
    status(`Loaded PNG ${f.name} (${state.heightmap.width}x${state.heightmap.height}). Use File > Save Level to export a unified JSON.`);
    updateTitle();
  } catch (e) {
    status('Failed to load PNG: ' + e.message);
  }
}

// ── Save Level (unified JSON + PNG) ──────────────────────────────────────
function currentLevelJson() {
  return buildLevelJson({
    heightmap: state.heightmap,
    markers:   state.markers,
    track:     state.track,
    terrain:   state.terrain,
    mapMeta:   {
      ...(state.mapMeta || {}),
      name:     state.mapMeta?.name || (state.track.name || state.filePath || 'Untitled'),
      basename: state.filePath || 'untitled',
      image:    state.mapMeta?.image || `assets/racing_maps/${state.filePath || 'untitled'}.png`,
    },
  });
}

async function saveLevel() {
  if (!state.heightmap) return;
  if (HAS_FS && state.jsonHandle && state.pngHandle) {
    const png = await state.heightmap.toPngBlob();
    const json = new Blob([currentLevelJson()], { type: 'application/json' });
    await writeToHandle(state.pngHandle, png);
    await writeToHandle(state.jsonHandle, json);
    state.heightmap.dirty = false;
    status('Saved level.');
    updateTitle();
  } else {
    await saveLevelAs();
  }
}
async function saveLevelAs() {
  if (!state.heightmap) return;
  const base = state.filePath || 'untitled';
  const json = new Blob([currentLevelJson()], { type: 'application/json' });
  const jh = await saveBlob(json, base + '.json',
    [{ description: 'Racing Level JSON', accept: { 'application/json': ['.json'] } }]);
  if (jh) state.jsonHandle = jh;

  const png = await state.heightmap.toPngBlob();
  const ph = await saveBlob(png, base + '.png',
    [{ description: 'Heightmap PNG', accept: { 'image/png': ['.png'] } }]);
  if (ph) state.pngHandle = ph;

  state.heightmap.dirty = false;
  status('Saved level (JSON + PNG).');
  updateTitle();
}
async function downloadPng() {
  if (!state.heightmap) return;
  const b = await state.heightmap.toPngBlob();
  downloadBlob(b, (state.filePath || 'heightmap') + '.png');
}

async function loadMapPreset(idx) {
  const m = MAPS[idx];
  const base = m.heightmapPath.split('/').pop();
  const candidates = uniqueRoots(state.gameRoot, './').map(r => r + m.heightmapPath)
    .concat(['./samples/' + base]);
  let url = candidates[0], blob = null;
  for (const u of candidates) {
    try {
      const r = await fetch(u);
      if (r.ok) { blob = await r.blob(); url = u; break; }
    } catch { /* try next */ }
  }
  if (!blob) {
    status(`Failed to fetch ${m.heightmapPath} from any of: ${candidates.join(', ')}. Use File > Open instead, or set Game Root URL.`);
    return;
  }
  try {
    state.heightmap = await Heightmap.fromPng(blob);
    state.heightmap.filePath = m.heightmapPath;
    state.filePath = m.heightmapPath.split('/').pop();
    state.tilesetIdx = m.tilesetIdx;
    tilesetSel.value = m.tilesetIdx;
    state.terrain = makeTerrainFromTileset(m.tilesetIdx);
    $('lowMid').value = state.terrain.lowToMid;
    $('midHigh').value = state.terrain.midToHigh;
    updateTextureLabels();
    await loadTerrainTextures();
    view2d.setHeightmap(state.heightmap, state.terrain);
    view3d.setHeightmap(state.heightmap, state.terrain);
    // Try to fetch the JSON sidecar
    const jsonUrl = url.replace(/\.png$/i, '.json');
    try {
      const jr = await fetch(jsonUrl);
      if (jr.ok) state.markers = MarkerSet.fromJsonString(await jr.text());
      else state.markers = new MarkerSet();
    } catch { state.markers = new MarkerSet(); }
    view2d.setMarkers(state.markers);
    view3d.setMarkers(state.markers);
    $('dualContour').checked = state.markers.dualContour;
    $('nightMode').checked = !!state.markers.nightMode;
    refreshMarkerUI();
    status(`Loaded preset map: ${m.displayName} (${state.heightmap.width}x${state.heightmap.height}).`);
    updateTitle();
  } catch (e) {
    status(`Failed to load ${url}: ${e.message}. Set Game Root URL via File menu.`);
  }
}

// ───── New / Generate ─────

const newDlg = $('newMapDialog');
function openNewDialog() {
  newDlg.showModal();
}
$('newMapOk').onclick = e => {
  const w = clamp(parseInt($('newMapW').value), 16, 512);
  const h = clamp(parseInt($('newMapH').value), 16, 512);
  const d = clamp(parseInt($('newMapDefault').value), 0, 31);
  state.heightmap = new Heightmap(w, h, d);
  state.heightmap.filePath = 'untitled.png';
  state.filePath = 'untitled.png';
  state.markers = new MarkerSet();
  view2d.setHeightmap(state.heightmap, state.terrain);
  view2d.setMarkers(state.markers);
  view3d.setHeightmap(state.heightmap, state.terrain);
  view3d.setMarkers(state.markers);
  refreshMarkerUI();
  status(`New ${w}x${h} heightmap.`);
  updateTitle();
};

const genDlg = $('generateDialog');
let _genKind = 'island';
function showGenerate(kind) {
  _genKind = kind;
  $('genTitle').textContent = `Generate Terrain: ${kind}`;
  if (state.heightmap) { $('genW').value = state.heightmap.width; $('genH').value = state.heightmap.height; }
  genDlg.showModal();
}
$('genOk').onclick = e => {
  const opts = {
    width: clamp(parseInt($('genW').value), 16, 512),
    height: clamp(parseInt($('genH').value), 16, 512),
    seed: parseInt($('genSeed').value) || 1,
    scale: parseFloat($('genScale').value) || 4,
    octaves: clamp(parseInt($('genOct').value), 1, 9),
    maxHeight: clamp(parseInt($('genMax').value), 1, 31),
  };
  if (state.heightmap) state.heightmap.pushUndo();
  state.heightmap = generate(_genKind, opts);
  state.heightmap.filePath = state.filePath || 'generated.png';
  view2d.setHeightmap(state.heightmap, state.terrain);
  view3d.setHeightmap(state.heightmap, state.terrain);
  status(`Generated ${_genKind} (${opts.width}x${opts.height}, seed=${opts.seed}).`);
  updateTitle();
};

// ───── Snapshots (named state checkpoints in localStorage) ─────

function quickSnapshot() {
  if (!state.heightmap) return;
  const name = prompt('Snapshot name:', `snap-${new Date().toISOString().replace(/[-:]/g,'').slice(0,15)}`);
  if (!name) return;
  saveSnapshot(name, snapshotPayload());
  status(`Snapshot "${name}" saved (browser localStorage).`);
}
function snapshotPayload() {
  return {
    width: state.heightmap.width,
    height: state.heightmap.height,
    data: arrayBufferToBase64(state.heightmap.data.buffer),
    markers: state.markers.toJsonString(),
    track: state.track.toFileString(),
    tilesetIdx: state.tilesetIdx,
    terrainEdits: { lowToMid: state.terrain.lowToMid, midToHigh: state.terrain.midToHigh },
  };
}
function restoreSnapshot(payload) {
  const buf = base64ToArrayBuffer(payload.data);
  state.heightmap = new Heightmap(payload.width, payload.height);
  state.heightmap.data = new Uint8Array(buf);
  state.markers = MarkerSet.fromJsonString(payload.markers);
  state.track = Track.fromFileString(payload.track);
  state.tilesetIdx = payload.tilesetIdx ?? 0;
  tilesetSel.value = state.tilesetIdx;
  state.terrain = makeTerrainFromTileset(state.tilesetIdx);
  if (payload.terrainEdits) {
    state.terrain.lowToMid = payload.terrainEdits.lowToMid;
    state.terrain.midToHigh = payload.terrainEdits.midToHigh;
  }
  $('lowMid').value = state.terrain.lowToMid;
  $('midHigh').value = state.terrain.midToHigh;
  updateTextureLabels();
  loadTerrainTextures();
  view2d.setHeightmap(state.heightmap, state.terrain);
  view2d.setMarkers(state.markers);
  view2d.setTrack(state.track);
  view3d.setHeightmap(state.heightmap, state.terrain);
  view3d.setMarkers(state.markers);
  view3d.setTrack(state.track);
  refreshMarkerUI();
  refreshTrackUI();
  $('dualContour').checked = state.markers.dualContour;
  $('nightMode').checked = !!state.markers.nightMode;
  updateTitle();
}

const snapDlg = $('snapshotDialog');
function openSnapshotDialog() {
  refreshSnapshotList();
  snapDlg.showModal();
}
$('snapSaveBtn').onclick = () => {
  if (!state.heightmap) { alert('Load or generate a heightmap first.'); return; }
  const name = $('snapName').value.trim();
  if (!name) return;
  saveSnapshot(name, snapshotPayload());
  $('snapName').value = '';
  refreshSnapshotList();
  status(`Snapshot "${name}" saved.`);
};
function refreshSnapshotList() {
  const ul = $('snapList');
  ul.innerHTML = '';
  const all = listSnapshots();
  Object.keys(all).sort().forEach(name => {
    const meta = all[name];
    const li = document.createElement('li');
    const date = new Date(meta.savedAt).toLocaleString();
    li.innerHTML = `<span>${name}</span> <span style="color:#888;font-size:10px"> ${meta.width}x${meta.height} ${date}</span>`;
    li.style.display = 'flex'; li.style.justifyContent = 'space-between'; li.style.alignItems = 'center';
    const btns = document.createElement('span');
    const load = document.createElement('button');
    load.textContent = 'Load'; load.type = 'button';
    load.onclick = () => { restoreSnapshot(meta); status(`Loaded snapshot "${name}".`); snapDlg.close(); };
    const del = document.createElement('button');
    del.textContent = 'Delete'; del.className = 'danger'; del.type = 'button';
    del.onclick = () => { deleteSnapshot(name); refreshSnapshotList(); };
    btns.appendChild(load); btns.appendChild(del);
    li.appendChild(btns);
    ul.appendChild(li);
  });
  if (!Object.keys(all).length) {
    const li = document.createElement('li');
    li.textContent = '(no snapshots yet)';
    ul.appendChild(li);
  }
}

function arrayBufferToBase64(buf) {
  let bin = '';
  const b = new Uint8Array(buf);
  for (let i = 0; i < b.byteLength; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin);
}
function base64ToArrayBuffer(s) {
  const bin = atob(s);
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b.buffer;
}

// ───── Game root dialog ─────

const grDlg = $('gameRootDialog');
function showGameRootDialog() {
  $('gameRootInput').value = state.gameRoot;
  grDlg.showModal();
}
$('gameRootOk').onclick = () => {
  state.gameRoot = $('gameRootInput').value || '../../';
  localStorage.setItem('webTE.gameRoot', state.gameRoot);
  loadTerrainTextures();
};

// ───── Undo / Redo ─────

function performUndo() {
  if ((view2d.tool === 'markers' || view2d.tool === 'markers-move') && state.markers.history.canUndo()) {
    state.markers.undo();
    refreshMarkerUI(); view3d.setMarkers(state.markers);
    return;
  }
  if (state.heightmap && state.heightmap.undo()) {
    view2d.invalidateBuffer(); view2d.draw();
    view3d.markDirty(); updateTitle();
  }
}
function performRedo() {
  if ((view2d.tool === 'markers' || view2d.tool === 'markers-move') && state.markers.history.canRedo()) {
    state.markers.redo();
    refreshMarkerUI(); view3d.setMarkers(state.markers);
    return;
  }
  if (state.heightmap && state.heightmap.redo()) {
    view2d.invalidateBuffer(); view2d.draw();
    view3d.markDirty(); updateTitle();
  }
}

// ───── Hotkeys ─────

window.addEventListener('keydown', e => {
  const tag = (e.target.tagName || '').toLowerCase();
  const inField = tag === 'input' || tag === 'select' || tag === 'textarea';
  if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
    if (e.shiftKey) performRedo(); else performUndo();
    e.preventDefault(); return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) { performRedo(); e.preventDefault(); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { saveLevel(); e.preventDefault(); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'o' || e.key === 'O')) { openPng(); e.preventDefault(); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'n' || e.key === 'N')) { openNewDialog(); e.preventDefault(); return; }
  if (inField) return;
  if (e.key === '[') { view2d.brushRadius = Math.max(0, view2d.brushRadius - 1); $('brushSize').value = view2d.brushRadius; view2d.draw(); }
  else if (e.key === ']') { view2d.brushRadius = Math.min(32, view2d.brushRadius + 1); $('brushSize').value = view2d.brushRadius; view2d.draw(); }
  else if (e.key >= '0' && e.key <= '9') selectHeight(parseInt(e.key));
});

// ───── Misc ─────

function status(msg) { $('status').textContent = msg; }
function updateTitle() {
  const name = state.filePath || 'untitled';
  $('title').textContent = name + (state.heightmap?.dirty ? ' *' : '');
  document.title = `Tom Lander Web Terrain Editor - ${name}`;
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function autoDetectGameRoot() {
  // When served at /utilities/WebTerrainEditor/ inside the game repo, the
  // game's assets are two levels up. When served standalone, they're alongside.
  return location.pathname.includes('/utilities/WebTerrainEditor/') ? '../../' : './';
}
function uniqueRoots(...roots) {
  const norm = r => (r.endsWith('/') ? r : r + '/');
  const seen = new Set(); const out = [];
  for (const r of roots) { const n = norm(r); if (!seen.has(n)) { seen.add(n); out.push(n); } }
  return out;
}

// initial state
updateTextureLabels();
loadTerrainTextures().catch(()=>{});
status(HAS_FS
  ? 'Ready. Use File > Open or pick a preset map.'
  : 'Ready (browser does not support File System Access — Save will trigger a download). Use File > Open.');
