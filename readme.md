# Tom Lander Web Terrain Editor

A self-contained, browser-based level editor for Tom Lander. Reads and writes
**unified racing-level JSON** documents that the game's `level_loader.lua`
consumes directly: one JSON file per level with the heightmap path, map
config, race checkpoints, and entity markers all in one place. Heightmaps are
side files (PNG, Picotron 32-color palette).

## Run

Double-click **`web-run.bat`** (Windows). The script:

1. Detects whether this folder sits inside the game repo at
   `utilities/WebTerrainEditor/`. If so, it serves the *game root* so the editor
   can fetch real maps and textures via relative URLs.
2. Otherwise it serves *this folder only*. The editor works fully via
   `File > Open`; the bundled `assets/` ships with the textures needed by the
   tileset previews so the 3D and "3D Textured" view still work.
3. Starts a Python `http.server` (or a PowerShell fallback) on
   `http://localhost:8765/` and opens your default browser.

Stop the server with `Ctrl+C` in the terminal window.

## Features (parity with the C# editor)

* **Heightmap PNG IO** using the Picotron 32-color palette. Files are
  byte-identical to those produced by the desktop editor.
* **Brush tools**: Paint, Erase, Smooth — same midpoint-circle radius algorithm.
* **Race-track checkpoints**: edited inline; saved inside the unified level
  JSON's `Track` block. `Track > Export to Lua snippet` still produces a
  paste-friendly `checkpoints_aseprite = { ... }` block if you need it.
* **Markers / entities**: stored in the same level JSON's `Markers` array
  with the schema `{X, Z, HeightOffset, Name, Group}` and eight group colors
  (A...H).
* **Tileset presets**: Island and Desert; threshold sliders for low/mid/high
  bands; live previews of the four textures.
* **2D view modes**: palette colors, flat zone colors, full-resolution
  textured preview.
* **3D view**: WebGL2, orbit + zoom, lit terrain mesh, optional textured mode.
  Race-track ribbons and marker stakes are drawn as 3D overlays.
* **Procedural generation**: Island, Desert Canyon, Rolling Hills, Plateau,
  Mountains. Same Perlin-noise + falloff as `TerrainGenerator.cs`.
* **Undo / redo**: separate stacks for heightmap edits and marker edits.
  `Ctrl+Z` / `Ctrl+Y` (or `Ctrl+Shift+Z`).
* **Snapshots**: `Edit > Save Snapshot` keeps a named full-state snapshot in
  browser localStorage. Restore from `Edit > Manage Snapshots`. Useful for
  branching exploratory edits without committing files.
* **Dual-contour flag** (Act 3 / Act 4): same checkbox, persisted to the JSON
  sidecar.

## File operations

| What                       | Format                               | File                                 |
| -------------------------- | ------------------------------------ | ------------------------------------ |
| Level descriptor           | JSON (Map + Track + Markers)         | `<level>.json`                       |
| Heightmap                  | PNG (Picotron palette)               | `<level>.png`  (referenced by JSON)  |
| Race track Lua snippet     | Lua (export only)                    | `track_<name>.lua`                   |

If your browser supports the **File System Access API** (recent
Chrome/Edge/Brave), `Save` writes back to the file you opened. Otherwise the
editor falls back to a download.

## Hotkeys

| Key                        | Action                                   |
| -------------------------- | ---------------------------------------- |
| `0`...`9`                  | Pick palette height                      |
| `[` / `]`                  | Brush radius down / up                   |
| `Ctrl+Z` / `Ctrl+Y`        | Undo / Redo                              |
| `Ctrl+Shift+Z`             | Redo                                     |
| `Ctrl+S`                   | Save (or Save As if no handle)           |
| `Ctrl+O`                   | Open PNG                                 |
| `Ctrl+N`                   | New heightmap                            |

Mouse: left-click paints; right-click pans (or deletes when in checkpoint /
marker mode); scroll zooms toward the cursor.

## Porting to another repo

The folder is self-contained: `index.html`, `css/`, `js/`, `assets/`,
`samples/`, and `web-run.bat`. Drop the whole folder anywhere and double-click
`web-run.bat`. Adjust `js/maps.js` to point at the heightmap and texture paths
your project uses. Use `File > Set Game Root URL` at runtime to change the base
URL the preset Maps menu fetches from.
