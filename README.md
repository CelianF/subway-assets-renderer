# Subway Assets Renderer

Environment viewer for Subway Surfers themes: lays out a city's environment pieces as a run, with trains and obstacles as toggleable layers.

No game assets are included in this repo. You need your own AssetRipper export.

## Pipeline

```
APK ──(rename to .zip, open in AssetRipper)──▶ export folder
export folder ──tools/build_manifest.py──▶ viewer/public/data/ (manifest.json, glb/, mesh/, tex/)
viewer/ (Vite + three.js) ──▶ browser
```

## Usage

```sh
python3 tools/build_manifest.py "/path/to/69.1 assets"
cd viewer && npm install && npm run dev
```

URL params: `theme`, `seed`, `sections`, `cam` (`game` | `overview` | `side`), `trains=0`, `obstacles=0`.

## How the game's data maps to the viewer

- **Themes** (`MonoBehaviour/<City>_Theme.asset`) map *slot types* (`boundary_high_left`, `train_static_3`, `obstacle_barrier_jump`, …) to prefab variants. Themes inherit from `_Common_Theme`.
- **Grid** (`WorldConstants`): 3 lanes × 20 units, cells 11.25 deep, so a boundary segment is 180 deep (16 cells).
- **Tracks**: `*_tracks_general` holds no geometry. Its TrackController assigns a mesh and materials per `TrackType` at runtime, and the manifest records those configs.
- **Materials**: most use `SYBO/Bend/Combined`, an übershader with feature toggles. The export only keeps its property block, so it is reimplemented in the viewer.
- **Layout**: the game's route generation logic is stripped from the export. `viewer/src/layout.js` generates a plausible sequence from the same pieces.
