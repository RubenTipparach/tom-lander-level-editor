// Top-level wiring for the web terrain editor.

import { PALETTE, isDarkSwatch, colorToCss } from './palette.js';
import { Heightmap, loadImage } from './heightmap.js';
import { MarkerSet, GROUP_COLORS, makeMarker } from './markers.js';
import { Track } from './track.js';
import { Terrain2D } from './terrain2d.js';
import { Terrain3D } from './terrain3d.js';
import { generate } from './generator.js';
import { TILESETS, MAPS, makeTerrainFromTileset } from './maps.js';
import { buildLevelJson, parseLevelJson } from './level.js';
import {
  listLibrary, getEntry, saveEntry, renameEntry, deleteEntry,
  changeType, entryPngBlob, defaultImagePath, librarySize,
} from './library.js';
import {
  HAS_FS, downloadBlob, saveBlob, writeToHandle, pickPng,
  listSnapshots, saveSnapshot, deleteSnapshot, renameSnapshot,
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
  dirty: false,           // Any unsaved edits to heightmap/markers/track/settings
};

// Mark the current map as dirty (unsaved edits) and refresh the title asterisk.
function markDirty() {
  state.dirty = true;
  updateTitle();
}
function clearDirty() {
  state.dirty = false;
  if (state.heightmap) state.heightmap.dirty = false;
  updateTitle();
}

// Modal to prompt the user when an action would replace the current (dirty) map.
// Returns one of: "save" (saved and OK to continue), "discard", or "cancel".
async function confirmDiscardOrSave() {
  if (!state.dirty) return 'discard';  // Nothing to preserve.
  const dlg = $('unsavedDialog');
  const nameEl = $('unsavedName');
  nameEl.value = state.filePath || `map-${new Date().toISOString().slice(0,10)}`;
  return new Promise(resolve => {
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      const choice = dlg.returnValue;
      if (choice === 'save') {
        const name = (nameEl.value || '').trim();
        if (!name) { resolve('cancel'); return; }
        if (!state.heightmap) { resolve('discard'); return; }
        saveSnapshot(name, snapshotPayload());
        state.filePath = name;
        clearDirty();
        buildMapsMenu();
        status(`Saved local map "${name}".`);
        resolve('save');
      } else if (choice === 'discard') {
        resolve('discard');
      } else {
        resolve('cancel');
      }
    };
    dlg.addEventListener('close', onClose);
    dlg.showModal();
  });
}

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

  // Sample maps (ship with the editor)
  for (let i = 0; i < MAPS.length; i++) {
    const m = MAPS[i];
    const b = document.createElement('button');
    b.textContent = `${m.displayName}  (${m.width}x${m.height})`;
    b.onclick = () => loadMapPreset(i);
    MAPS_MENU.appendChild(b);
  }

  // Local Maps flyout: user snapshots saved to localStorage
  MAPS_MENU.appendChild(document.createElement('hr'));
  const flyoutWrap = document.createElement('div');
  flyoutWrap.className = 'flyout';

  const flyoutBtn = document.createElement('button');
  flyoutBtn.textContent = 'Local Maps \u25B8';   // ▸
  flyoutBtn.className = 'flyout-toggle';
  flyoutBtn.onclick = (e) => { e.stopPropagation(); flyoutWrap.classList.toggle('open'); };
  flyoutWrap.appendChild(flyoutBtn);

  const flyoutPanel = document.createElement('div');
  flyoutPanel.className = 'flyout-panel';

  const snapshots = listSnapshots();
  const names = Object.keys(snapshots).sort();
  if (names.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'flyout-empty';
    empty.textContent = '(no saved maps yet)';
    flyoutPanel.appendChild(empty);
  } else {
    for (const name of names) {
      const meta = snapshots[name];
      const row = document.createElement('div');
      row.className = 'flyout-row';

      const load = document.createElement('button');
      load.className = 'flyout-load';
      load.textContent = `${name}  (${meta.width}x${meta.height})`;
      load.onclick = async () => {
        if (await confirmDiscardOrSave() === 'cancel') return;
        restoreSnapshot(meta);
        state.filePath = name;
        updateTitle();
        status(`Loaded local map "${name}".`);
        // Close menus
        document.querySelectorAll('#menubar .menu.open').forEach(m => m.classList.remove('open'));
        flyoutWrap.classList.remove('open');
      };
      row.appendChild(load);

      const rename = document.createElement('button');
      rename.className = 'flyout-rename';
      rename.title = 'Rename';
      rename.textContent = '\u270E';  // ✎ pencil
      rename.onclick = (e) => {
        e.stopPropagation();
        const next = prompt(`Rename "${name}" to:`, name);
        if (next == null) return;                  // user cancelled
        const trimmed = next.trim();
        if (!trimmed || trimmed === name) return;  // no-op
        // Auto-suffix on collision instead of refusing.
        const target = uniqueSnapshotName(trimmed, name);
        if (!renameSnapshot(name, target)) {
          alert(`Could not rename "${name}".`);
          return;
        }
        if (state.filePath === name) {
          state.filePath = target;
          updateTitle();
        }
        status(target === trimmed
          ? `Renamed local map "${name}" → "${target}".`
          : `Renamed to "${target}" ("${trimmed}" already existed).`);
        buildMapsMenu();
        document.querySelector('#menubar .menu:has(#mapsDropdown)')?.classList.add('open');
        flyoutWrap.classList.add('open');
      };
      row.appendChild(rename);

      const del = document.createElement('button');
      del.className = 'flyout-del';
      del.title = 'Delete';
      del.textContent = '\u00D7';  // ×
      del.onclick = (e) => {
        e.stopPropagation();
        if (!confirm(`Delete local map "${name}"?`)) return;
        deleteSnapshot(name);
        buildMapsMenu();  // refresh
        // Keep the Maps menu open so the user can see the removal
        document.querySelector('#menubar .menu:has(#mapsDropdown)')?.classList.add('open');
        flyoutWrap.classList.add('open');
      };
      row.appendChild(del);

      flyoutPanel.appendChild(row);
    }
  }

  // "Save current as new local map" action
  flyoutPanel.appendChild(document.createElement('hr'));
  const saveBtn = document.createElement('button');
  saveBtn.className = 'flyout-save';
  saveBtn.textContent = '\u2795 Save current as local map\u2026';  // ➕
  saveBtn.onclick = (e) => {
    e.stopPropagation();
    if (!state.heightmap) { alert('Load or generate a heightmap first.'); return; }
    const name = uniqueSnapshotName(state.filePath || 'untitled');
    saveSnapshot(name, snapshotPayload());
    state.filePath = name;
    clearDirty();
    buildMapsMenu();
    openLocalMapsFlyout();
    status(`Saved local map "${name}".`);
  };
  flyoutPanel.appendChild(saveBtn);

  flyoutWrap.appendChild(flyoutPanel);
  MAPS_MENU.appendChild(flyoutWrap);
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
    case 'save-json': downloadJson(); break;
    case 'set-game-root': showGameRootDialog(); break;
    case 'undo': performUndo(); break;
    case 'redo': performRedo(); break;
    case 'snapshot-save': quickSnapshot(); break;
    case 'snapshot-manage': openSnapshotDialog(); break;
    case 'lib-save': quickLibrarySave(); break;
    case 'lib-manage': openLibraryDialog(); break;
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

// 2D view is ALWAYS the heightmap palette — you need to see the actual
// height values while painting. The "Flat Zones" / "3D Textured" toggles
// only affect the 3D preview now.
$('toggleZones').onclick = () => {
  $('toggleZones').classList.toggle('active');
  $('toggleTextured').classList.remove('active');
  view3d.setTextured(false);
};
$('toggleTextured').onclick = () => {
  $('toggleTextured').classList.toggle('active');
  $('toggleZones').classList.remove('active');
  const on = $('toggleTextured').classList.contains('active');
  view3d.setTextured(on);
};
$('reset3D').onclick = () => view3d.resetCamera();

// ───── Soft brush + falloff editor ─────
// Falloff is a small array of strengths in [0..1], indexed by normalized
// distance from the brush center (0 = center, length-1 = rim). The user
// edits it as a tiny pixel graph in the toolbar — drawing a column sets
// that distance bucket's strength to (1 - row / height).

const FALLOFF_LEN = 64;       // backing-pixel width of the editor canvas
const FALLOFF_HEIGHT = 20;    // backing-pixel height of the editor canvas
const falloffArr = new Float32Array(FALLOFF_LEN);
function defaultFalloff() {
  for (let i = 0; i < FALLOFF_LEN; i++) falloffArr[i] = 1 - (i / (FALLOFF_LEN - 1));
}
defaultFalloff();

function falloffStrengthAt(norm) {
  const i = Math.max(0, Math.min(FALLOFF_LEN - 1, Math.round(norm * (FALLOFF_LEN - 1))));
  return falloffArr[i];
}

const falloffCanvas = $('falloffEditor');
const falloffCtx = falloffCanvas.getContext('2d');
falloffCtx.imageSmoothingEnabled = false;

function drawFalloffEditor() {
  const w = falloffCanvas.width, h = falloffCanvas.height;
  // background
  falloffCtx.fillStyle = '#181820';
  falloffCtx.fillRect(0, 0, w, h);
  // bars
  for (let x = 0; x < FALLOFF_LEN; x++) {
    const s = falloffArr[x];
    const barH = Math.round(s * h);
    falloffCtx.fillStyle = state.softBrush ? '#5fa3e0' : '#5a5a64';
    falloffCtx.fillRect(x, h - barH, 1, barH);
  }
  // mid line
  falloffCtx.fillStyle = 'rgba(255,255,255,0.06)';
  falloffCtx.fillRect(0, Math.floor(h / 2), w, 1);
}
drawFalloffEditor();

function falloffPosFromEvent(e) {
  const rect = falloffCanvas.getBoundingClientRect();
  const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
  const x = Math.max(0, Math.min(FALLOFF_LEN - 1,
    Math.floor(cx / rect.width * FALLOFF_LEN)));
  const yPx = Math.max(0, Math.min(FALLOFF_HEIGHT - 1,
    Math.floor(cy / rect.height * FALLOFF_HEIGHT)));
  // y=0 (top) → strength 1; y=H-1 (bottom) → strength 0.
  const s = 1 - (yPx + 0.5) / FALLOFF_HEIGHT;
  return [x, Math.max(0, Math.min(1, s))];
}

let falloffPainting = false;
let falloffLast = null;
falloffCanvas.addEventListener('mousedown', e => {
  if (e.button === 2) { defaultFalloff(); drawFalloffEditor(); return; }
  if (e.button !== 0) return;
  falloffPainting = true;
  falloffLast = falloffPosFromEvent(e);
  falloffArr[falloffLast[0]] = falloffLast[1];
  drawFalloffEditor();
});
falloffCanvas.addEventListener('mousemove', e => {
  if (!falloffPainting) return;
  const cur = falloffPosFromEvent(e);
  // Linear-fill columns between last and current so quick drags don't gap.
  const [x0, s0] = falloffLast, [x1, s1] = cur;
  const lo = Math.min(x0, x1), hi = Math.max(x0, x1);
  for (let x = lo; x <= hi; x++) {
    const t = (lo === hi) ? 1 : (x - x0) / (x1 - x0 || 1);
    falloffArr[x] = s0 + (s1 - s0) * Math.max(0, Math.min(1, t));
  }
  falloffLast = cur;
  drawFalloffEditor();
});
window.addEventListener('mouseup', () => { falloffPainting = false; });
falloffCanvas.addEventListener('contextmenu', e => e.preventDefault());

$('falloffReset').onclick = () => { defaultFalloff(); drawFalloffEditor(); };

$('softBrush').onchange = () => {
  state.softBrush = $('softBrush').checked;
  view2d.softBrush = state.softBrush;
  view2d.falloffFn = falloffStrengthAt;
  drawFalloffEditor();
};
// Always hand the function over so toggling the checkbox at any time works.
view2d.falloffFn = falloffStrengthAt;
state.softBrush = false;

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
  markDirty();
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
  markDirty();
  status(state.markers.dualContour ? 'Dual contouring enabled. Save to persist.'
                                   : 'Dual contouring disabled. Save to persist.');
};

$('nightMode').onchange = () => {
  state.markers.nightMode = $('nightMode').checked;
  markDirty();
  status(state.markers.nightMode ? 'Night mode enabled. Save to persist.'
                                 : 'Night mode disabled. Save to persist.');
};

// ───── Altitude limit ─────
// Defaults match Mission 7 (Trench Run): 30 world units, 10s warning.
// When the box is unchecked, the JSON's altitude_limit is null and the game
// applies no ceiling (same behaviour as Act 1 island maps today).

const DEFAULT_ALTITUDE_LIMIT = 30;
const DEFAULT_ALTITUDE_WARN  = 10;

function pushAltitudeIntoMapMeta() {
  if (!state.mapMeta) state.mapMeta = {};
  if ($('altitudeOn').checked) {
    state.mapMeta.altitude_limit         = clamp(parseInt($('altitudeLimit').value) || DEFAULT_ALTITUDE_LIMIT, 1, 200);
    state.mapMeta.altitude_warning_time  = clamp(parseInt($('altitudeWarn').value)  || DEFAULT_ALTITUDE_WARN, 1, 60);
  } else {
    state.mapMeta.altitude_limit        = null;
    state.mapMeta.altitude_warning_time = null;
  }
}
function syncAltitudeUiFromMapMeta() {
  const lim  = state.mapMeta?.altitude_limit;
  const warn = state.mapMeta?.altitude_warning_time;
  $('altitudeOn').checked    = lim != null;
  $('altitudeLimit').value   = lim  ?? DEFAULT_ALTITUDE_LIMIT;
  $('altitudeWarn').value    = warn ?? DEFAULT_ALTITUDE_WARN;
  $('altitudeLimit').disabled = !$('altitudeOn').checked;
  $('altitudeWarn').disabled  = !$('altitudeOn').checked;
}
$('altitudeOn').onchange = () => {
  $('altitudeLimit').disabled = !$('altitudeOn').checked;
  $('altitudeWarn').disabled  = !$('altitudeOn').checked;
  pushAltitudeIntoMapMeta();
  markDirty();
  status($('altitudeOn').checked
    ? `Altitude limit ${$('altitudeLimit').value} (warn ${$('altitudeWarn').value}s). Save to persist.`
    : 'Altitude limit removed. Save to persist.');
};
$('altitudeLimit').oninput = () => { pushAltitudeIntoMapMeta(); markDirty(); };
$('altitudeWarn').oninput  = () => { pushAltitudeIntoMapMeta(); markDirty(); };
syncAltitudeUiFromMapMeta();

async function applyTileset(idx) {
  state.tilesetIdx = idx;
  state.terrain = makeTerrainFromTileset(idx);
  $('lowMid').value = state.terrain.lowToMid;
  $('midHigh').value = state.terrain.midToHigh;
  updateTextureLabels();
  await loadTerrainTextures();
  view2d.setTerrain(state.terrain);
  view3d.setTerrain(state.terrain);
  markDirty();
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
  markDirty();
};
view2d.onCursor = (x, y, h) => {
  if (state.heightmap && x >= 0 && x < state.heightmap.width && y >= 0 && y < state.heightmap.height)
    $('cursorInfo').textContent = `Tile (${x},${y})  Height ${h}`;
  else
    $('cursorInfo').textContent = '';
};
view2d.onTrackChange = () => { refreshTrackUI(); view3d.setTrack(state.track); markDirty(); };
view2d.onMarkerChange = () => { refreshMarkerUI(); view3d.setMarkers(state.markers); markDirty(); };
view2d.onMarkerSelect = i => selectMarkerInList(i);

// ───── Track UI ─────

const cpListEl = $('cpList');
$('trackName').oninput  = () => { state.track.name = $('trackName').value; markDirty(); };
$('trackLaps').oninput  = () => { state.track.laps = clamp(parseInt($('trackLaps').value || '1'), 1, 10); markDirty(); };
$('trackWidth').oninput = () => { state.track.width = clamp(parseInt($('trackWidth').value || '2'), 2, 30); view2d.draw(); view3d.setTrack(state.track); markDirty(); };
$('cpHeight').oninput = () => updateSelectedCpProps();
$('cpTime').oninput   = () => updateSelectedCpProps();
$('cpName').oninput   = () => updateSelectedCpProps();
$('cpUp').onclick     = () => moveCp(-1);
$('cpDown').onclick   = () => moveCp(1);
$('cpDelete').onclick = () => {
  const i = currentCpIndex();
  if (i >= 0) { state.track.removeAt(i); refreshTrackUI(); view2d.draw(); view3d.setTrack(state.track); markDirty(); }
};

function refreshTrackUI() {
  $('trackName').value = state.track.name;
  $('trackLaps').value = state.track.laps;
  $('trackWidth').value = state.track.width;
  cpListEl.innerHTML = '';
  state.track.checkpoints.forEach((cp, i) => {
    const li = document.createElement('li');
    li.textContent = `${i + 1}. ${cp.Name} (${cp.X},${cp.Z}) h=${cp.HeightAboveGround} t=${cp.TimeLimit}s`;
    li.draggable = true;
    li.dataset.idx = i;
    li.onclick = () => selectCp(i);

    li.addEventListener('dragstart', e => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(i));
      li.classList.add('drag');
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('drag');
      cpListEl.querySelectorAll('li').forEach(el => el.classList.remove('drop-above', 'drop-below'));
    });
    li.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const r = li.getBoundingClientRect();
      const above = (e.clientY - r.top) < r.height / 2;
      li.classList.toggle('drop-above', above);
      li.classList.toggle('drop-below', !above);
    });
    li.addEventListener('dragleave', () => {
      li.classList.remove('drop-above', 'drop-below');
    });
    li.addEventListener('drop', e => {
      e.preventDefault();
      const from = parseInt(e.dataTransfer.getData('text/plain'));
      if (Number.isNaN(from)) return;
      const r = li.getBoundingClientRect();
      const above = (e.clientY - r.top) < r.height / 2;
      let to = i + (above ? 0 : 1);
      // Splicing: account for removing the source first.
      if (from < to) to -= 1;
      if (from === to) return;
      const arr = state.track.checkpoints;
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved);
      _selectedCp = to;
      refreshTrackUI();
      selectCp(to);
      view3d.setTrack(state.track);
      markDirty();
    });

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
  markDirty();
}
function moveCp(dir) {
  const i = currentCpIndex();
  const j = i + dir;
  if (i < 0 || j < 0 || j >= state.track.checkpoints.length) return;
  const arr = state.track.checkpoints;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  refreshTrackUI(); selectCp(j);
  view3d.setTrack(state.track);
  markDirty();
}

async function newTrack() {
  const decision = await confirmDiscardOrSave();
  if (decision === 'cancel') return;
  const w = state.heightmap?.width ?? 128;
  const h = state.heightmap?.height ?? 128;
  state.track = new Track();
  state.track.generateCircle(8, w, h, Math.floor(Math.random() * 99999));
  view2d.setTrack(state.track);
  view3d.setTrack(state.track);
  refreshTrackUI();
  markDirty();  // new track replaced the old one
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
  markDirty();
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
  markDirty();
};
$('markerClear').onclick = () => {
  if (!state.markers.markers.length) return;
  if (!confirm('Clear all markers?')) return;
  state.markers.pushUndo();
  state.markers.markers.length = 0;
  _selectedMarker = -1;
  refreshMarkerUI();
  view2d.draw(); view3d.setMarkers(state.markers);
  markDirty();
};

// ───── File operations ─────

const fileOpen = $('fileOpen');
fileOpen.onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  if (await confirmDiscardOrSave() === 'cancel') { e.target.value = ''; return; }
  await loadHeightmapFile(f);
  e.target.value = '';
};
async function openPng() { fileOpen.click(); }

// ── Open Level (unified JSON) ─────────────────────────────────────────────
async function openLevel() { $('fileOpenLevel').click(); }
$('fileOpenLevel').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  if (await confirmDiscardOrSave() === 'cancel') { e.target.value = ''; return; }
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

  // Preferred path: heightmap bytes are embedded in the JSON.
  if (parsed.map.heightmap_bytes) {
    const w = parsed.map.width;
    const h = parsed.map.height;
    const bytes = parsed.map.heightmap_bytes;
    if (bytes.length !== w * h) {
      console.error(`[level-editor] Invalid heightmap_b64 in "${f.name}": expected ${w * h} bytes, got ${bytes.length}`);
      status(`Invalid heightmap_b64: expected ${w * h} bytes, got ${bytes.length}.`);
      return;
    }
    console.log(`[level-editor] Loaded "${f.name}" via embedded heightmap_b64 (${w}x${h}, ${bytes.length} bytes).`);
    state.heightmap = new Heightmap(w, h);
    state.heightmap.data = new Uint8Array(bytes);
    state.heightmap.filePath = f.name || 'level.json';
  } else {
    console.error(`[level-editor] "${f.name}" has no heightmap_b64 — falling back to sibling PNG lookup.`);

    // Fallback: look for a sibling PNG sharing the JSON's base name
    // (e.g. canyon_run.json → canyon_run.png), then the explicit map.image
    // if that existed, then any fallbacks under ./samples/.
    const baseName = (f.name || 'level').replace(/\.json$/i, '');
    const fallbackPaths = [];
    fallbackPaths.push(`assets/racing_maps/${baseName}.png`);
    if (parsed.map.image && parsed.map.image !== `assets/racing_maps/${baseName}.png`) {
      fallbackPaths.push(parsed.map.image);
    }
    const candidates = [];
    const roots = uniqueRoots(state.gameRoot, './');
    for (const root of roots) {
      for (const p of fallbackPaths) candidates.push(root + p);
    }
    candidates.push('./samples/racing/' + baseName + '.png');
    if (parsed.map.image) {
      candidates.push('./samples/racing/' + parsed.map.image.split('/').pop());
    }

    console.groupCollapsed(`[level-editor] PNG fallback: trying ${candidates.length} path(s)`);
    let png = null, pngUrl = null;
    const attempts = [];
    for (const u of candidates) {
      try {
        const r = await fetch(u);
        if (r.ok) {
          png = await r.blob();
          pngUrl = u;
          console.log(`✓ ${u}  →  ${png.size} bytes`);
          break;
        } else {
          attempts.push({ url: u, status: r.status });
          console.warn(`✗ ${u}  →  HTTP ${r.status}`);
        }
      } catch (err) {
        attempts.push({ url: u, error: String(err) });
        console.warn(`✗ ${u}  →  ${err}`);
      }
    }
    console.groupEnd();

    // No autoload found — ask via dialog for the PNG.
    if (!png) {
      console.error(
        `[level-editor] All ${candidates.length} PNG fallback paths failed for "${f.name}". Prompting user.`,
        attempts,
      );
      const picked = await askForFile({
        title: 'Heightmap PNG required',
        message: `"${f.name}" has no embedded heightmap and no sibling PNG was found. Choose a PNG for this level.`,
        which: 'png',
      });
      if (!picked) {
        console.error(`[level-editor] User cancelled PNG picker — level not loaded.`);
        status('No PNG selected — level not loaded.');
        return;
      }
      png = picked;
      pngUrl = picked.name;
      console.log(`[level-editor] User supplied PNG: ${picked.name} (${picked.size} bytes).`);
    }

    try {
      state.heightmap = await Heightmap.fromPng(png);
    } catch (err) {
      console.error(`[level-editor] Heightmap.fromPng failed for "${pngUrl}":`, err);
      status(`Failed to decode PNG "${pngUrl}": ${err.message || err}`);
      return;
    }
    state.heightmap.filePath = (pngUrl || 'level.png').split('/').pop();
    console.log(`[level-editor] Loaded "${f.name}" via fallback PNG "${pngUrl}" (${state.heightmap.width}x${state.heightmap.height}).`);
  }
  state.filePath = (f.name || 'level').replace(/\.json$/i, '');
  state.markers = parsed.markers;
  state.track   = parsed.track;
  state.mapMeta = parsed.map;

  // Apply the tileset carried in the JSON so texture selection and threshold
  // defaults match what the game will use. If the JSON named a tileset we
  // don't recognize, fall through to the default (island, idx 0) and toast
  // the user instead of silently swapping textures on them.
  if (parsed.tilesetWarning) {
    console.warn(`[level-editor] Unknown tileset "${parsed.tilesetWarning}" in JSON. Falling back to "island".`);
    showToast(`Tileset "${parsed.tilesetWarning}" not found. Using default (island).`, 'warn');
  }
  if (parsed.tilesetIdx != null) {
    await applyTileset(parsed.tilesetIdx);
    if ($('tileset')) $('tileset').value = parsed.tilesetIdx;
  }

  view2d.setHeightmap(state.heightmap, state.terrain);
  view2d.setMarkers(state.markers);
  view2d.setTrack(state.track);
  view3d.setHeightmap(state.heightmap, state.terrain);
  view3d.setMarkers(state.markers);
  view3d.setTrack(state.track);
  $('dualContour').checked = !!state.markers.dualContour;
  $('nightMode').checked = !!state.markers.nightMode;
  syncAltitudeUiFromMapMeta();
  refreshMarkerUI();
  refreshTrackUI();
  clearDirty();
  status(`Loaded level "${parsed.map.name}" — ${state.track.checkpoints.length} checkpoints, ${state.markers.markers.length} markers.`);
}

// ── Open PNG only (with optional JSON sidecar) ───────────────────────────
async function loadHeightmapFile(f) {
  try {
    state.heightmap = await Heightmap.fromPng(f);
    state.heightmap.filePath = f.name;
    state.filePath = f.name.replace(/\.png$/i, '');

    console.log(`[level-editor] Loaded PNG "${f.name}" (${state.heightmap.width}x${state.heightmap.height}).`);

    // Try to auto-find a matching JSON sidecar by convention (e.g.
    // canyon_run.png → canyon_run.json in the game assets).
    const baseName = state.filePath;
    let sidecarText = null, sidecarUrl = null;
    const candidates = [];
    const roots = uniqueRoots(state.gameRoot, './');
    for (const root of roots) candidates.push(root + `assets/racing_maps/${baseName}.json`);
    candidates.push(`./samples/racing/${baseName}.json`);

    console.groupCollapsed(`[level-editor] JSON sidecar autoload: trying ${candidates.length} path(s)`);
    for (const u of candidates) {
      try {
        const r = await fetch(u);
        if (r.ok) {
          sidecarText = await r.text();
          sidecarUrl = u;
          console.log(`✓ ${u}`);
          break;
        } else {
          console.warn(`✗ ${u}  →  HTTP ${r.status}`);
        }
      } catch (err) {
        console.warn(`✗ ${u}  →  ${err}`);
      }
    }
    console.groupEnd();

    // If no sidecar was autoloaded, offer a dialog so the user can pick one.
    if (!sidecarText) {
      console.warn(`[level-editor] No JSON sidecar autoloaded for "${f.name}" — asking user.`);
      const pickedJson = await askForFile({
        title: 'Optional: JSON sidecar?',
        message: `Loaded ${f.name}. If you have a matching level JSON (track + markers), choose it now. Otherwise cancel to open the PNG alone.`,
        which: 'json',
      });
      if (pickedJson) {
        sidecarUrl = pickedJson.name;
        try {
          sidecarText = await pickedJson.text();
          console.log(`[level-editor] User supplied sidecar: ${pickedJson.name} (${pickedJson.size} bytes).`);
        } catch (err) {
          console.error(`[level-editor] Failed to read picked sidecar:`, err);
        }
      } else {
        console.log(`[level-editor] User declined sidecar — opening PNG alone.`);
      }
    }

    if (sidecarText) {
      try {
        const parsed = parseLevelJson(sidecarText);
        state.markers = parsed.markers;
        state.track   = parsed.track;
        state.mapMeta = parsed.map;
        if (parsed.tilesetWarning) {
          console.warn(`[level-editor] Unknown tileset "${parsed.tilesetWarning}" in sidecar JSON. Falling back to "island".`);
          showToast(`Tileset "${parsed.tilesetWarning}" not found. Using default (island).`, 'warn');
        }
        if (parsed.tilesetIdx != null) {
          await applyTileset(parsed.tilesetIdx);
          if ($('tileset')) $('tileset').value = parsed.tilesetIdx;
        }
        console.log(`[level-editor] Parsed sidecar "${sidecarUrl}": ${state.track.checkpoints.length} checkpoints, ${state.markers.markers.length} markers.`);
      } catch (e) {
        console.error(`[level-editor] Sidecar JSON parse FAILED for "${sidecarUrl}":`, e);
        state.markers = new MarkerSet();
        state.track   = new Track();
        state.mapMeta = null;
      }
    } else {
      state.markers = new MarkerSet();
      state.track   = new Track();
      state.mapMeta = null;
    }

    view2d.setHeightmap(state.heightmap, state.terrain);
    view2d.setMarkers(state.markers);
    view2d.setTrack(state.track);
    view3d.setHeightmap(state.heightmap, state.terrain);
    view3d.setMarkers(state.markers);
    view3d.setTrack(state.track);
    refreshMarkerUI();
    refreshTrackUI();
    $('dualContour').checked = !!state.markers.dualContour;
    $('nightMode').checked = !!state.markers.nightMode;
    syncAltitudeUiFromMapMeta();
    clearDirty();
    const extra = sidecarText
      ? ` with ${state.track.checkpoints.length} checkpoints + ${state.markers.markers.length} markers`
      : ' (no JSON sidecar)';
    status(`Loaded ${f.name} (${state.heightmap.width}x${state.heightmap.height})${extra}.`);
  } catch (e) {
    console.error(`[level-editor] loadHeightmapFile FAILED for "${f.name}":`, e);
    status('Failed to load PNG: ' + e.message);
  }
}

// ── Save Level (unified JSON + PNG) ──────────────────────────────────────
function currentLevelJson() {
  // Capture latest UI values into mapMeta so the save round-trips them.
  pushAltitudeIntoMapMeta();
  return buildLevelJson({
    heightmap:  state.heightmap,
    markers:    state.markers,
    track:      state.track,
    terrain:    state.terrain,
    tilesetIdx: state.tilesetIdx,
    mapMeta:    {
      ...(state.mapMeta || {}),
      name:     state.mapMeta?.name || (state.track.name || state.filePath || 'Untitled'),
      basename: stripExt(state.filePath) || 'untitled',
      image:    state.mapMeta?.image || `assets/racing_maps/${stripExt(state.filePath) || 'untitled'}.png`,
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
    clearDirty();
    status('Saved level.');
  } else {
    await saveLevelAs();
  }
}
async function saveLevelAs() {
  if (!state.heightmap) return;
  const base = stripExt(state.filePath) || 'untitled';
  const json = new Blob([currentLevelJson()], { type: 'application/json' });
  const jh = await saveBlob(json, base + '.json',
    [{ description: 'Racing Level JSON', accept: { 'application/json': ['.json'] } }]);
  if (jh) state.jsonHandle = jh;

  const png = await state.heightmap.toPngBlob();
  const ph = await saveBlob(png, base + '.png',
    [{ description: 'Heightmap PNG', accept: { 'image/png': ['.png'] } }]);
  if (ph) state.pngHandle = ph;

  clearDirty();
  status('Saved level (JSON + PNG).');
}
async function downloadPng() {
  if (!state.heightmap) return;
  const b = await state.heightmap.toPngBlob();
  downloadBlob(b, (stripExt(state.filePath) || 'heightmap') + '.png');
}
function downloadJson() {
  if (!state.heightmap) { status('Load or generate a heightmap first.'); return; }
  const b = new Blob([currentLevelJson()], { type: 'application/json' });
  downloadBlob(b, (stripExt(state.filePath) || 'level') + '.json');
}

async function loadMapPreset(idx) {
  if (await confirmDiscardOrSave() === 'cancel') return;
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
    syncAltitudeUiFromMapMeta();
    refreshMarkerUI();
    clearDirty();
    status(`Loaded preset map: ${m.displayName} (${state.heightmap.width}x${state.heightmap.height}).`);
  } catch (e) {
    status(`Failed to load ${url}: ${e.message}. Set Game Root URL via File menu.`);
  }
}

// ───── New / Generate ─────

const newDlg = $('newMapDialog');
async function openNewDialog() {
  if (await confirmDiscardOrSave() === 'cancel') return;
  newDlg.showModal();
}
// Ensure the level has a START marker. Does nothing if one already exists.
// Defaults to the center of the heightmap. Returns true if it added one.
function ensureStartMarker() {
  if (!state.heightmap || !state.markers) return false;
  for (const m of state.markers.markers) {
    const grp = String(m.Group || '').toUpperCase();
    const nam = String(m.Name || '').toLowerCase();
    if (grp === 'START' || nam === 'start_node') return false;  // already present
  }
  const cx = Math.floor(state.heightmap.width  / 2);
  const cz = Math.floor(state.heightmap.height / 2);
  state.markers.markers.push(makeMarker(cx, cz, {
    group: 'START',
    name:  'Start',
    height: 0,
  }));
  return true;
}

$('newMapOk').onclick = e => {
  const w = clamp(parseInt($('newMapW').value), 16, 512);
  const h = clamp(parseInt($('newMapH').value), 16, 512);
  const d = clamp(parseInt($('newMapDefault').value), 0, 31);
  state.heightmap = new Heightmap(w, h, d);
  state.heightmap.filePath = 'untitled.png';
  state.filePath = 'untitled';
  state.markers = new MarkerSet();
  ensureStartMarker();  // default: every new map gets a START marker at center
  view2d.setHeightmap(state.heightmap, state.terrain);
  view2d.setMarkers(state.markers);
  view3d.setHeightmap(state.heightmap, state.terrain);
  view3d.setMarkers(state.markers);
  refreshMarkerUI();
  clearDirty();
  status(`New ${w}x${h} heightmap.`);
};

const genDlg = $('generateDialog');
let _genKind = 'island';
async function showGenerate(kind) {
  if (await confirmDiscardOrSave() === 'cancel') return;
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
  // Every freshly-generated level gets a default START marker if none exists.
  if (ensureStartMarker()) view2d.setMarkers(state.markers);
  view2d.setHeightmap(state.heightmap, state.terrain);
  view3d.setHeightmap(state.heightmap, state.terrain);
  view3d.setMarkers(state.markers);
  refreshMarkerUI();
  markDirty();  // generated content not saved anywhere yet
  status(`Generated ${_genKind} (${opts.width}x${opts.height}, seed=${opts.seed}).`);
};

// ───── Snapshots (named state checkpoints in localStorage) ─────

// Ask the user for a file via a <dialog>, then open the native file picker
// from the dialog's button click (fresh user-gesture tick — this reliably
// works even after prior `await`s). Returns the picked File, or null.
function askForFile({ title, message, which }) {
  // which: 'png' | 'json'
  const inputId = which === 'json' ? 'fileAskJson' : 'fileAskPng';
  const inp = $(inputId);
  const dlg = $('askFileDialog');
  $('askFileTitle').textContent = title || 'Choose a file';
  $('askFileMessage').textContent = message || '';

  return new Promise(resolve => {
    let settled = false;
    const settle = (file) => {
      if (settled) return;
      settled = true;
      inp.removeEventListener('change', onInputChange);
      dlg.removeEventListener('close', onDlgClose);
      $('askFilePickBtn').removeEventListener('click', onPick);
      inp.value = '';
      if (dlg.open) dlg.close();
      resolve(file);
    };
    const onInputChange = () => {
      const f = inp.files && inp.files[0] ? inp.files[0] : null;
      settle(f);
    };
    const onDlgClose = () => {
      // If user dismissed the dialog without picking, resolve null.
      // (If a file was picked, onInputChange already settled.)
      settle(null);
    };
    const onPick = () => {
      // Trigger the native picker from inside the button click — this is a
      // fresh user gesture so the browser will honour .click() reliably.
      inp.click();
    };
    inp.addEventListener('change', onInputChange);
    dlg.addEventListener('close', onDlgClose);
    $('askFilePickBtn').addEventListener('click', onPick);
    dlg.showModal();
  });
}

// Small helper: pop open the Maps → Local Maps flyout so a freshly-saved
// entry is immediately visible to the user.
function openLocalMapsFlyout() {
  const mapsMenu = document.querySelector('#menubar .menu:has(#mapsDropdown)');
  if (mapsMenu) mapsMenu.classList.add('open');
  const fly = document.querySelector('#mapsDropdown .flyout');
  if (fly) fly.classList.add('open');
}

// Return a snapshot name guaranteed not to collide with an existing entry.
// "map" → "map" if free, else "map (1)", "map (2)", ... The `exclude` arg is
// the name being renamed; it's allowed to match itself (no-op rename).
function uniqueSnapshotName(base, exclude) {
  const snaps = listSnapshots();
  const trimmed = (base || 'untitled').trim() || 'untitled';
  // Strip a trailing " (N)" so re-saving doesn't cascade to " (1) (1)".
  const root = trimmed.replace(/\s*\(\d+\)\s*$/, '');
  if (!snaps[trimmed] || trimmed === exclude) return trimmed;
  if (!snaps[root] || root === exclude) return root;
  for (let n = 1; n < 10000; n++) {
    const candidate = `${root} (${n})`;
    if (!snaps[candidate] || candidate === exclude) return candidate;
  }
  return `${root} (${Date.now()})`;
}

function quickSnapshot() {
  if (!state.heightmap) return;
  const base = state.filePath || 'untitled';
  const name = uniqueSnapshotName(base);
  saveSnapshot(name, snapshotPayload());
  state.filePath = name;
  clearDirty();
  buildMapsMenu();
  openLocalMapsFlyout();
  status(`Saved local map "${name}".`);
}
function snapshotPayload() {
  pushAltitudeIntoMapMeta();
  return {
    width: state.heightmap.width,
    height: state.heightmap.height,
    data: arrayBufferToBase64(state.heightmap.data.buffer),
    markers: state.markers.toJsonString(),
    track: JSON.stringify({
      name: state.track.name, laps: state.track.laps,
      width: state.track.width, checkpoints: state.track.checkpoints,
    }),
    tilesetIdx: state.tilesetIdx,
    terrainEdits: { lowToMid: state.terrain.lowToMid, midToHigh: state.terrain.midToHigh },
    mapMeta: state.mapMeta || null,
  };
}
function restoreSnapshot(payload) {
  const buf = base64ToArrayBuffer(payload.data);
  state.heightmap = new Heightmap(payload.width, payload.height);
  state.heightmap.data = new Uint8Array(buf);
  state.markers = MarkerSet.fromJsonString(payload.markers);
  // track was historically a .track-text string; now it's a JSON object.
  state.track = new Track();
  try {
    const t = JSON.parse(payload.track);
    state.track.name = t.name ?? 'Untitled';
    state.track.laps = t.laps ?? 3;
    state.track.width = t.width ?? 6;
    state.track.checkpoints = t.checkpoints ?? [];
  } catch { /* leave defaults */ }
  state.tilesetIdx = payload.tilesetIdx ?? 0;
  tilesetSel.value = state.tilesetIdx;
  state.terrain = makeTerrainFromTileset(state.tilesetIdx);
  if (payload.terrainEdits) {
    state.terrain.lowToMid = payload.terrainEdits.lowToMid;
    state.terrain.midToHigh = payload.terrainEdits.midToHigh;
  }
  state.mapMeta = payload.mapMeta || null;
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
  syncAltitudeUiFromMapMeta();
  clearDirty();
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
  state.filePath = name;
  clearDirty();
  buildMapsMenu();
  $('snapName').value = '';
  refreshSnapshotList();
  snapDlg.close();          // close the legacy dialog
  openLocalMapsFlyout();    // reveal the new entry in the flyout
  status(`Saved local map "${name}".`);
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
    load.onclick = async () => {
      if (await confirmDiscardOrSave() === 'cancel') return;
      restoreSnapshot(meta);
      status(`Loaded snapshot "${name}".`);
      snapDlg.close();
    };
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

// ───── Library (localStorage-backed level collection) ─────

const libDlg = $('libraryDialog');

function quickLibrarySave() {
  if (!state.heightmap) { alert('Load or generate a heightmap first.'); return; }
  const suggested = (state.filePath || 'level').replace(/\.(png|json)$/i, '');
  const name = (prompt('Save as (library name):', suggested) || '').trim();
  if (!name) return;
  const type = confirm('OK = Racing map.\nCancel = Campaign map.') ? 'racing' : 'campaign';
  saveCurrentToLibrary(name, type)
    .then(() => status(`Saved "${name}" to ${type} library.`))
    .catch(e => status('Library save failed: ' + e.message));
}

async function saveCurrentToLibrary(name, type) {
  const png = await state.heightmap.toPngBlob();
  // Stamp the level JSON with the canonical export-image path for this type.
  const meta = { ...(state.mapMeta || {}) };
  meta.image = defaultImagePath(name, type);
  meta.basename = name;
  if (!meta.name) meta.name = state.track.name || name;
  state.mapMeta = meta;
  const levelJson = currentLevelJson();
  await saveEntry({
    name, type, levelJson, pngBlob: png,
    width: state.heightmap.width, height: state.heightmap.height,
  });
}

function openLibraryDialog() {
  $('libSaveName').value = (state.filePath || '').replace(/\.(png|json)$/i, '');
  refreshLibraryList();
  libDlg.showModal();
}

$('libSaveBtn').onclick = async () => {
  const name = $('libSaveName').value.trim();
  if (!name) { alert('Name is required.'); return; }
  if (!state.heightmap) { alert('Load or generate a heightmap first.'); return; }
  const type = $('libSaveType').value;
  if (getEntry(name) && !confirm(`"${name}" already exists. Overwrite?`)) return;
  try {
    await saveCurrentToLibrary(name, type);
    refreshLibraryList();
    status(`Saved "${name}" to ${type} library.`);
  } catch (e) {
    alert('Save failed: ' + e.message);
  }
};

function refreshLibraryList() {
  const grouped = listLibrary();
  fillLibSection('libListRacing',   grouped.racing,   'racing');
  fillLibSection('libListCampaign', grouped.campaign, 'campaign');
  $('libCountRacing').textContent   = `(${grouped.racing.length})`;
  $('libCountCampaign').textContent = `(${grouped.campaign.length})`;
  const kb = (librarySize() / 1024).toFixed(1);
  $('libSize').textContent = `Library size: ${kb} KB in browser localStorage.`;
}

function fillLibSection(ulId, entries, type) {
  const ul = $(ulId);
  ul.innerHTML = '';
  if (!entries.length) {
    const li = document.createElement('li');
    li.className = 'lib-empty';
    li.textContent = '(empty)';
    li.style.display = 'block';
    ul.appendChild(li);
    return;
  }
  for (const e of entries) {
    const li = document.createElement('li');
    const date = new Date(e.savedAt).toLocaleString();
    const dim = (e.width && e.height) ? `${e.width}x${e.height}` : '';

    const left = document.createElement('div');
    left.innerHTML = `<span class="lib-name">${escapeHtml(e.name)}</span>
                      <div class="lib-meta">${dim}  ${date}</div>`;
    li.appendChild(left);

    const otherType = type === 'racing' ? 'campaign' : 'racing';
    const moveBtn = document.createElement('button');
    moveBtn.type = 'button';
    moveBtn.textContent = `→ ${otherType}`;
    moveBtn.title = `Move to ${otherType}`;
    moveBtn.onclick = () => { changeType(e.name, otherType); refreshLibraryList(); };

    const actions = document.createElement('div');
    actions.className = 'lib-actions';
    const load = mkBtn('Load',   () => { loadFromLibrary(e.name); libDlg.close(); });
    const exp  = mkBtn('Export', () => exportLibraryEntry(e.name));
    const ren  = mkBtn('Rename', () => {
      const n = prompt('Rename to:', e.name);
      if (!n || n === e.name) return;
      try { renameEntry(e.name, n.trim()); refreshLibraryList(); }
      catch (err) { alert(err.message); }
    });
    const del  = mkBtn('Delete', () => {
      if (confirm(`Delete "${e.name}" from library?`)) { deleteEntry(e.name); refreshLibraryList(); }
    });
    del.classList.add('danger');
    actions.append(load, exp, ren, del);

    li.appendChild(moveBtn);
    li.appendChild(actions);
    ul.appendChild(li);
  }
}

function mkBtn(text, fn) {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = text; b.onclick = fn;
  return b;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadFromLibrary(name) {
  const e = getEntry(name);
  if (!e) { status('Library entry not found: ' + name); return; }
  const parsed = parseLevelJson(e.levelJson);
  if (e.pngBase64) {
    const blob = await entryPngBlob(e);
    state.heightmap = await Heightmap.fromPng(blob);
  } else {
    state.heightmap = new Heightmap(parsed.map.width, parsed.map.height);
  }
  state.heightmap.filePath = parsed.map.image.split('/').pop();
  state.filePath = e.name;
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
  syncAltitudeUiFromMapMeta();
  refreshMarkerUI();
  refreshTrackUI();
  status(`Loaded "${name}" from library (${e.type}).`);
  updateTitle();
}

async function exportLibraryEntry(name) {
  const e = getEntry(name);
  if (!e) return;
  // Download JSON and PNG side by side. Browsers serialize the two clicks.
  downloadBlob(new Blob([e.levelJson], { type: 'application/json' }), `${name}.json`);
  if (e.pngBase64) downloadBlob(await entryPngBlob(e), `${name}.png`);
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

// Lightweight toast for non-blocking warnings (e.g. unknown tileset on load).
// Stacks vertically; each toast auto-dismisses after a few seconds, and the
// container is created lazily so older HTML without it still works.
function showToast(msg, kind = 'warn') {
  let host = document.getElementById('toastHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toastHost';
    document.body.appendChild(host);
  }
  const t = document.createElement('div');
  t.className = `toast toast-${kind}`;
  t.textContent = msg;
  host.appendChild(t);
  // Force reflow so the CSS transition runs from the initial state.
  void t.offsetWidth;
  t.classList.add('toast-visible');
  setTimeout(() => {
    t.classList.remove('toast-visible');
    setTimeout(() => t.remove(), 300);
  }, 5000);
}
function updateTitle() {
  const name = state.filePath || 'untitled';
  const dirty = state.dirty || state.heightmap?.dirty;
  $('title').textContent = name + (dirty ? ' *' : '');
  document.title = `Tom Lander Web Terrain Editor - ${name}${dirty ? ' *' : ''}`;
}

// Click the title in the menubar to rename the current map. If the current
// name matches a local-library entry, the localStorage entry is renamed too.
$('title').classList.add('clickable-title');
$('title').title = 'Click to rename';
$('title').addEventListener('click', () => {
  const current = state.filePath || '';
  const next = prompt('Rename map to:', current || 'untitled');
  if (next == null) return;                         // cancelled
  const trimmed = next.trim();
  if (!trimmed || trimmed === current) return;      // no-op

  // Auto-suffix on collision so "Canyon Run" → "Canyon Run (1)" when needed.
  const target = uniqueSnapshotName(trimmed, current);
  const snaps = listSnapshots();
  if (current && snaps[current]) {
    renameSnapshot(current, target);
    buildMapsMenu();  // refresh the Local Maps flyout
    status(target === trimmed
      ? `Renamed local map "${current}" → "${target}".`
      : `Renamed to "${target}" ("${trimmed}" already existed).`);
  } else {
    status(`Renamed to "${target}". Save to persist as a local map.`);
  }
  state.filePath = target;
  updateTitle();
});
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function stripExt(s) { return (s || '').replace(/\.(png|json)$/i, ''); }

// Browser close / reload guard
window.addEventListener('beforeunload', (e) => {
  if (state.dirty) {
    e.preventDefault();
    e.returnValue = '';  // Chrome requires this
  }
});

function autoDetectGameRoot() {
  // When served at /utilities/level-editor/ inside the game repo, the
  // game's assets are two levels up. When served standalone, they're alongside.
  return location.pathname.includes('/utilities/level-editor/') ? '../../' : './';
}
function uniqueRoots(...roots) {
  const norm = r => (r.endsWith('/') ? r : r + '/');
  const seen = new Set(); const out = [];
  for (const r of roots) { const n = norm(r); if (!seen.has(n)) { seen.add(n); out.push(n); } }
  return out;
}

// initial state — start with the textured 3D view on (matches game shader).
view2d.setViewMode('palette');  // 2D is always the heightmap palette view
view3d.setTextured(true);
updateTextureLabels();
loadTerrainTextures().catch(()=>{});
status(HAS_FS
  ? 'Ready. Use File > Open or pick a preset map.'
  : 'Ready (browser does not support File System Access — Save will trigger a download). Use File > Open.');
