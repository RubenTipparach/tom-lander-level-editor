// Local file library: keeps a named collection of levels in browser
// localStorage so you can iterate without ever touching disk.
//
// Storage shape (localStorage key 'webTE.library.v1'):
//   { entries: { "<name>": { name, type, savedAt, levelJson, pngBase64,
//                            width, height } } }
//
// type is "racing" | "campaign". The PNG is base64-encoded only inside
// localStorage; exports always produce a real PNG file alongside the JSON.

const KEY = 'webTE.library.v1';

function read() {
  try {
    const s = localStorage.getItem(KEY);
    if (!s) return { entries: {} };
    const o = JSON.parse(s);
    if (!o.entries) o.entries = {};
    return o;
  } catch { return { entries: {} }; }
}
function write(state) {
  localStorage.setItem(KEY, JSON.stringify(state));
}

export function listLibrary() {
  const all = read().entries;
  const grouped = { racing: [], campaign: [] };
  for (const e of Object.values(all)) {
    (grouped[e.type] || (grouped[e.type] = [])).push(e);
  }
  for (const k of Object.keys(grouped))
    grouped[k].sort((a, b) => a.name.localeCompare(b.name));
  return grouped;
}

export function getEntry(name) {
  return read().entries[name] || null;
}

export async function saveEntry({ name, type, levelJson, pngBlob, width, height }) {
  if (!name) throw new Error('name required');
  if (type !== 'racing' && type !== 'campaign')
    throw new Error('type must be "racing" or "campaign"');
  const pngBase64 = pngBlob ? await blobToBase64(pngBlob) : null;
  const state = read();
  state.entries[name] = {
    name, type,
    savedAt: Date.now(),
    levelJson: typeof levelJson === 'string' ? levelJson : JSON.stringify(levelJson),
    pngBase64,
    width, height,
  };
  write(state);
}

export function renameEntry(oldName, newName) {
  if (!newName || oldName === newName) return false;
  const state = read();
  const e = state.entries[oldName];
  if (!e) return false;
  if (state.entries[newName]) throw new Error(`"${newName}" already exists`);
  e.name = newName;
  state.entries[newName] = e;
  delete state.entries[oldName];
  write(state);
  return true;
}

export function deleteEntry(name) {
  const state = read();
  if (!state.entries[name]) return false;
  delete state.entries[name];
  write(state);
  return true;
}

export function changeType(name, newType) {
  if (newType !== 'racing' && newType !== 'campaign') return false;
  const state = read();
  const e = state.entries[name];
  if (!e) return false;
  e.type = newType;
  write(state);
  return true;
}

// Export an entry's PNG as a Blob for download.
export async function entryPngBlob(entry) {
  if (!entry.pngBase64) return null;
  return await base64ToBlob(entry.pngBase64, 'image/png');
}

// Default export-image path the level descriptor expects, derived from type.
export function defaultImagePath(name, type) {
  return type === 'campaign'
    ? `assets/maps/${name}.png`
    : `assets/racing_maps/${name}.png`;
}

// Approximate total bytes of the library in localStorage (for the UI).
export function librarySize() {
  const s = localStorage.getItem(KEY);
  return s ? s.length : 0;
}

// ───── helpers ─────

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onloadend = () => {
      const s = r.result;
      const i = s.indexOf(',');
      res(i >= 0 ? s.slice(i + 1) : s);
    };
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}
async function base64ToBlob(b64, mime) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Blob([u8], { type: mime });
}
