// File IO helpers. Uses File System Access API (Chromium) when available;
// falls back to Save As download.

export const HAS_FS = 'showSaveFilePicker' in window;

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
}

export async function saveBlob(blob, suggestedName, types) {
  if (HAS_FS) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName, types });
      const w = await handle.createWritable();
      await w.write(blob); await w.close();
      return handle;
    } catch (e) {
      if (e.name === 'AbortError') return null;
      console.warn('FS API failed, downloading instead', e);
    }
  }
  downloadBlob(blob, suggestedName);
  return null;
}

export async function writeToHandle(handle, blob) {
  const w = await handle.createWritable();
  await w.write(blob); await w.close();
}

export async function pickPng() {
  if (HAS_FS) {
    try {
      const [h] = await window.showOpenFilePicker({
        types: [{ description: 'Heightmap PNG', accept: { 'image/png': ['.png'] } }],
        multiple: false,
      });
      const f = await h.getFile();
      return { file: f, handle: h };
    } catch (e) {
      if (e.name === 'AbortError') return null;
    }
  }
  return null;
}

// localStorage-backed snapshots
const SNAP_KEY = 'webTerrainEditor.snapshots.v1';
export function listSnapshots() {
  try { return JSON.parse(localStorage.getItem(SNAP_KEY) || '{}'); }
  catch { return {}; }
}
export function saveSnapshot(name, payload) {
  const all = listSnapshots();
  all[name] = { savedAt: Date.now(), ...payload };
  localStorage.setItem(SNAP_KEY, JSON.stringify(all));
}
export function deleteSnapshot(name) {
  const all = listSnapshots();
  delete all[name];
  localStorage.setItem(SNAP_KEY, JSON.stringify(all));
}
