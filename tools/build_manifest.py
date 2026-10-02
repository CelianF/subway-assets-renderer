#!/usr/bin/env python3
"""Build the viewer manifest from an AssetRipper export of Subway Surfers.

Reads theme slot tables (MonoBehaviour/*_Theme.asset), resolves theme
inheritance, parses materials, measures each prefab glb and copies the
referenced glbs into the viewer's data folder.

Usage: python3 tools/build_manifest.py "/path/to/69.1 assets" [--out viewer/public/data]
"""
import argparse
import json
import os
import re
import shutil
import struct
import sys
from pathlib import Path

GUID_RE = re.compile(r"guid: ([0-9a-f]{32})")

# Built-in Unity shaders referenced by fileID with the zero guid
BUILTIN_SHADERS = {
    "10720": "Mobile/Particles/Additive",
    "10721": "Mobile/Particles/Alpha Blended",
    "10750": "Unlit/Texture",
    "10752": "Unlit/Transparent",
    "10753": "Unlit/Transparent Cutout",
    "10755": "Unlit/Color",
    "10770": "UI/Default",
    "46": "Standard",
}


def log(*a):
    print(*a, file=sys.stderr)


# ---------------------------------------------------------------- guid index

def build_guid_index(project: Path) -> dict:
    """guid -> asset path (without .meta) for every asset in ExportedProject."""
    index = {}
    for meta in project.rglob("*.meta"):
        with open(meta, errors="ignore") as f:
            m = GUID_RE.search(f.read(300))
        if m:
            index[m.group(1)] = meta.with_suffix("")
    return index


# ---------------------------------------------------------------- themes

def parse_theme(path: Path) -> dict:
    """Return {'parent': guid|None, 'slots': [(type_guid, [prefab_guid...])]}."""
    parent = None
    slots = []
    for line in path.read_text(errors="ignore").splitlines():
        m = GUID_RE.search(line)
        stripped = line.strip()
        if stripped.startswith("_parent:"):
            parent = m.group(1) if m else None
        elif stripped.startswith("- Type:") and m:
            slots.append((m.group(1), []))
        elif stripped.startswith("- {fileID:") and m and slots:
            slots[-1][1].append(m.group(1))
    return {"parent": parent, "slots": slots}


def resolve_theme(guid, guid_index, cache) -> dict:
    """slot name -> [prefab names], with parent slots overridden by children."""
    if guid in cache:
        return cache[guid]
    path = guid_index.get(guid)
    if path is None or path.suffix != ".asset":
        return {}
    theme = parse_theme(path)
    slots = dict(resolve_theme(theme["parent"], guid_index, cache)) if theme["parent"] else {}
    for type_guid, prefabs in theme["slots"]:
        type_path = guid_index.get(type_guid)
        slot = type_path.stem if type_path else f"?{type_guid}"
        slots[slot] = [guid_index[g].stem for g in prefabs if g in guid_index]
    cache[guid] = slots
    return slots


def parse_boundaries(path: Path, guid_index) -> dict:
    """<Theme>_Boundaries.asset: transition pieces placed where a boundary run starts/ends
    (e.g. tube_start/tube_end around boundary_tube), plus per-boundary track settings."""
    name = lambda g: guid_index[g].stem if g in guid_index else None
    transitions, track_infos = [], {}
    section, current = None, None
    for line in path.read_text(errors="ignore").splitlines():
        s = line.strip()
        if s in ("TrackInfos:", "TransitionInfo:"):
            section = s[:-1]
            continue
        m = GUID_RE.search(s)
        if section == "TrackInfos":
            if s.startswith("- BoundaryType:") and m:
                current = track_infos.setdefault(name(m.group(1)), {})
            elif current is not None and ":" in s and not s.startswith("-"):
                k, v = s.split(":", 1)
                current[k.strip()] = v.strip() == "1"
        elif section == "TransitionInfo":
            if s.startswith("- BoundaryType:") and m:
                current = {"slot": name(m.group(1)), "exceptions": []}
                transitions.append(current)
            elif current is None:
                continue
            elif s.startswith("AssetType:") and m:
                current["prefab"] = name(m.group(1))
            elif s.startswith("Transition:"):
                current["at"] = "end" if s.split(":")[1].strip() == "1" else "start"
            elif s.startswith("Probability:"):
                current["probability"] = float(s.split(":")[1])
            elif s.startswith("- {fileID") and m:
                current["exceptions"].append(name(m.group(1)))
    return {"transitions": [t for t in transitions if t.get("prefab")], "trackInfos": track_infos}


def parse_theme_config(path: Path, guid_index) -> dict:
    """<Theme>_Config.asset (ThemeConfig): fog, camera far plane, skybox material, skyline."""
    text = path.read_text(errors="ignore")
    color = lambda key: (lambda m: [float(m.group(i)) for i in range(1, 5)] if m else None)(
        re.search(key + r": \{r: ([\d.e-]+), g: ([\d.e-]+), b: ([\d.e-]+), a: ([\d.e-]+)\}", text))
    number = lambda key: (lambda m: float(m.group(1)) if m else None)(re.search(r"\n  " + key + r": ([\d.e-]+)", text))
    ref = lambda key: (lambda m: guid_index.get(m.group(1)) if m else None)(re.search(key + r": \{fileID: \d+, guid: (\w+)", text))
    out = {
        "fog": {"color": color("FogColor"), "start": number("FogStartDistance"), "end": number("FogEndDistance")},
        "cameraFar": number("CameraFar"),
        "trainLight": color("TrainLight"),
    }
    skybox = ref("  Skybox")
    if skybox and skybox.suffix == ".mat":
        mat = skybox.read_text(errors="ignore")
        c = lambda key: (lambda m: [float(m.group(i)) for i in range(1, 4)] if m else None)(
            re.search(key + r": \{r: ([\d.e-]+), g: ([\d.e-]+), b: ([\d.e-]+)", mat))
        power = re.search(r"_Power: ([\d.e-]+)", mat)
        out["sky"] = {"top": c("_TopColor"), "bottom": c("_BottomColor"), "power": float(power.group(1)) if power else 1}
    bg = re.search(r"BackgroundLayer:\n    Prefab: \{fileID: \d+, guid: (\w+)", text)
    if bg and bg.group(1) in guid_index:
        out["background"] = {
            "prefab": guid_index[bg.group(1)].stem,
            "distance": number("DistanceFromPlayer"),
            "tint": color("    Tint"),
            "gradientA": color("GradientA"),
            "gradientB": color("GradientB"),
        }
    return out


# Prefabs the viewer needs beyond theme slots
EXTRA_PREFABS = ["_Common_LightSignal_Light_Green", "_Common_LightSignal_Light_Red"]


TRACK_TYPES = {
    0: "Invisible", 1: "TrackNormal", 2: "TrackShadow", 3: "TrackShadowStart", 4: "TrackShadowEnd",
    5: "TrackShadowStartEnd", 6: "GroundNormal", 7: "GroundShadow", 8: "GroundShadowStart",
    9: "GroundShadowEnd", 10: "GroundShadowStartEnd",
}


def parse_track_configs(prefab: Path, guid_index) -> dict:
    """TrackController `_configurations`: TrackType -> {mesh, materials} (meshes assigned at runtime)."""
    configs = {}
    current = None
    in_mats = False
    for line in prefab.read_text(errors="ignore").splitlines():
        s = line.strip()
        if s.startswith("- TrackType:"):
            current = {"mesh": None, "materials": []}
            configs[TRACK_TYPES.get(int(s.split(":")[1]), s.split(":")[1].strip())] = current
            in_mats = False
        elif current is None:
            continue
        elif s.startswith("MeshLOD0:"):
            m = GUID_RE.search(s)
            current["mesh"] = guid_index[m.group(1)].stem if m and m.group(1) in guid_index else None
        elif s.startswith("Materials:"):
            in_mats = True
        elif in_mats and s.startswith("- {fileID:"):
            m = GUID_RE.search(s)
            if m and m.group(1) in guid_index:
                current["materials"].append(guid_index[m.group(1)].stem)
        elif not s.startswith("- "):
            in_mats = False
            if not s.startswith(("MeshLOD", "Materials")):
                current = None
    return configs


def parse_randomizers(prefab: Path, guid_index) -> dict:
    """RandomChildRandomizer components: GameObject name -> activation probability.

    At runtime the game enables one random child of such a node (with that probability)
    and disables the others; the glb export contains all of them.
    """
    text = prefab.read_text(errors="ignore")
    names = {}
    for doc in text.split("\n--- "):
        m = re.match(r"!u!1 &(\d+)", doc)
        if m:
            nm = re.search(r"m_Name: (.*)", doc)
            names[m.group(1)] = nm.group(1).strip() if nm else ""
    out = {}
    for doc in text.split("\n--- "):
        if not doc.startswith("!u!114"):
            continue
        script = re.search(r"m_Script: .*guid: (\w+)", doc)
        if not script or script.group(1) not in guid_index:
            continue
        if guid_index[script.group(1)].stem != "RandomChildRandomizer":
            continue
        go = re.search(r"m_GameObject: \{fileID: (\d+)", doc)
        prob = re.search(r"_activationProbability: ([\d.]+)", doc)
        if go and go.group(1) in names:
            out[names[go.group(1)]] = float(prob.group(1)) if prob else 1.0
    return out


def parse_lod_groups(prefab: Path) -> list:
    """Names of GameObjects whose renderers only belong to LOD1+ of a LODGroup.

    The game swaps between high/low models by screen size; the glb export
    contains every level at once, so the viewer keeps LOD0 only.
    """
    docs = prefab.read_text(errors="ignore").split("\n--- ")
    go_names, owner = {}, {}
    for doc in docs:
        m = re.match(r"!u!(\d+) &(\d+)", doc)
        if not m:
            continue
        if m.group(1) == "1":
            nm = re.search(r"m_Name: (.*)", doc)
            go_names[m.group(2)] = nm.group(1).strip() if nm else ""
        else:
            go = re.search(r"m_GameObject: \{fileID: (\d+)", doc)
            if go:
                owner[m.group(2)] = go.group(1)
    lod0, lower = set(), set()
    for doc in docs:
        if not doc.startswith("!u!205 "):
            continue
        for level, block in enumerate(re.split(r"\n\s*- screenRelativeHeight:", doc)[1:]):
            for rid in re.findall(r"renderer: \{fileID: (\d+)", block):
                name = go_names.get(owner.get(rid, ""), None)
                if name is not None:
                    (lod0 if level == 0 else lower).add(name)
    return sorted(lower - lod0)


def slot_category(slot: str) -> str:
    prefix = slot.split("_", 1)[0]
    return prefix if prefix in {"boundary", "track", "obstacle", "train", "special", "prop"} else "other"


# ---------------------------------------------------------------- glb stats

def _qrot(q, v):
    x, y, z, w = q
    vx, vy, vz = v
    tx, ty, tz = 2 * (y * vz - z * vy), 2 * (z * vx - x * vz), 2 * (x * vy - y * vx)
    return (vx + w * tx + y * tz - z * ty, vy + w * ty + z * tx - x * tz, vz + w * tz + x * ty - y * tx)


def glb_stats(path: Path) -> dict:
    """Mesh/material counts and world-space AABB of a glb (from accessor bounds)."""
    data = path.read_bytes()
    json_len = struct.unpack("<I", data[12:16])[0]
    gltf = json.loads(data[20:20 + json_len])
    nodes, meshes, accessors = gltf.get("nodes", []), gltf.get("meshes", []), gltf.get("accessors", [])
    lo, hi = [float("inf")] * 3, [float("-inf")] * 3

    def walk(i, parent_xf):
        node = nodes[i]
        t = node.get("translation", [0, 0, 0])
        r = node.get("rotation", [0, 0, 0, 1])
        s = node.get("scale", [1, 1, 1])

        def xf(p):
            p = _qrot(r, [p[k] * s[k] for k in range(3)])
            return parent_xf([p[k] + t[k] for k in range(3)])

        if "mesh" in node:
            for prim in meshes[node["mesh"]]["primitives"]:
                acc = accessors[prim["attributes"]["POSITION"]]
                for corner in range(8):
                    p = xf([(acc["min"], acc["max"])[(corner >> k) & 1][k] for k in range(3)])
                    for k in range(3):
                        lo[k], hi[k] = min(lo[k], p[k]), max(hi[k], p[k])
        for c in node.get("children", []):
            walk(c, xf)

    for root in gltf["scenes"][gltf.get("scene", 0)]["nodes"]:
        walk(root, lambda p: p)

    has_geo = lo[0] != float("inf")
    return {
        "meshes": len(meshes),
        "materials": sorted({m.get("name", "") for m in gltf.get("materials", [])}),
        "bbox": [[round(v, 3) for v in lo], [round(v, 3) for v in hi]] if has_geo else None,
    }


# ---------------------------------------------------------------- materials

def shader_name(ref_line: str, guid_index) -> str:
    m = GUID_RE.search(ref_line)
    fid = re.search(r"fileID: (\d+)", ref_line)
    if m and m.group(1) != "0000000000000000f000000000000000":
        path = guid_index.get(m.group(1))
        if path and path.suffix == ".shader":
            first = path.read_text(errors="ignore").split("\n", 1)[0]
            sm = re.match(r'Shader "([^"]+)"', first)
            return sm.group(1) if sm else path.stem
        return f"?{m.group(1)}"
    return BUILTIN_SHADERS.get(fid.group(1) if fid else "", f"builtin:{fid.group(1) if fid else '?'}")


def parse_material(path: Path, guid_index, export_root: Path) -> dict:
    """Minimal parser for Unity .mat YAML (serializedVersion 8)."""
    mat = {"shader": None, "keywords": [], "renderQueue": -1, "textures": {}, "floats": {}, "colors": {}}
    section = None
    tex_name = None
    for line in path.read_text(errors="ignore").splitlines():
        s = line.strip()
        if s.startswith("m_Shader:"):
            mat["shader"] = shader_name(s, guid_index)
        elif s.startswith("m_CustomRenderQueue:"):
            mat["renderQueue"] = int(s.split(":")[1])
        elif s in ("m_ValidKeywords:", "m_TexEnvs:", "m_Floats:", "m_Colors:", "m_Ints: {}", "m_InvalidKeywords: []"):
            section = s.rstrip(":")
        elif s.startswith("m_") and not s.startswith(("m_Texture", "m_Scale", "m_Offset")):
            section = None
        elif section == "m_ValidKeywords" and s.startswith("- "):
            mat["keywords"].append(s[2:])
        elif section == "m_TexEnvs":
            if s.endswith(":") and not s.startswith("m_"):
                tex_name = s[:-1]
            elif s.startswith("m_Texture:") and tex_name:
                m = GUID_RE.search(s)
                if m and m.group(1) in guid_index:
                    mat["textures"][tex_name] = {"path": str(guid_index[m.group(1)].relative_to(export_root))}
            elif s.startswith(("m_Scale:", "m_Offset:")) and tex_name in mat["textures"]:
                nums = [float(v) for v in re.findall(r"-?[\d.]+(?:e-?\d+)?", s.split(":", 1)[1])]
                mat["textures"][tex_name]["scale" if s.startswith("m_Scale") else "offset"] = nums
        elif section == "m_Floats" and ":" in s:
            k, v = s.split(":", 1)
            try:
                mat["floats"][k] = float(v)
            except ValueError:
                pass
        elif section == "m_Colors" and ":" in s:
            k, v = s.split(":", 1)
            mat["colors"][k] = [float(x) for x in re.findall(r"-?[\d.]+(?:e-?\d+)?", v)]
    return mat


# ---------------------------------------------------------------- main

def copy_if_newer(src: Path, dst: Path):
    if not dst.exists() or dst.stat().st_mtime < src.stat().st_mtime:
        shutil.copy2(src, dst)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("export", type=Path, help="AssetRipper export root (contains ExportedProject/ and Files/)")
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parent.parent / "viewer/public/data")
    args = ap.parse_args()

    root = args.export.resolve()
    project = root / "ExportedProject" / "Assets"
    glb_dir = root / "Files" / "Assets" / "PrefabHierarchyObject"
    mesh_dir = root / "Files" / "Assets" / "Mesh"
    if not project.is_dir() or not glb_dir.is_dir():
        sys.exit(f"Not an AssetRipper export: {root}")

    log("Indexing guids...")
    guid_index = build_guid_index(project)
    log(f"  {len(guid_index)} assets")

    # Themes
    theme_cache = {}
    themes = {}
    for path in sorted((project / "MonoBehaviour").glob("*_Theme.asset")):
        if path.stem.startswith("_"):
            continue  # abstract parent themes (e.g. _Common_Theme)
        guid = GUID_RE.search((path.parent / (path.name + ".meta")).read_text()).group(1)
        themes[path.stem.removesuffix("_Theme")] = resolve_theme(guid, guid_index, theme_cache)
    log(f"Themes: {', '.join(themes)}")

    # Boundary transitions (tube entrances/exits, …) per theme
    boundaries = {}
    for theme in themes:
        path = project / "MonoBehaviour" / f"{theme}_Boundaries.asset"
        if path.exists():
            boundaries[theme] = parse_boundaries(path, guid_index)
    log(f"Transitions: {sum(len(b['transitions']) for b in boundaries.values())} in {len(boundaries)} themes")

    theme_configs = {}
    for theme in themes:
        path = project / f"{theme}_Config.asset"
        if path.exists():
            theme_configs[theme] = parse_theme_config(path, guid_index)
    log(f"Theme configs: {len(theme_configs)}")

    # Prefabs referenced by any theme
    out_glb = args.out / "glb"
    out_glb.mkdir(parents=True, exist_ok=True)
    prefabs = {}
    missing, empty = [], []
    transition_prefabs = [[t["prefab"] for t in b["transitions"]] for b in boundaries.values()]
    transition_prefabs.append(EXTRA_PREFABS)
    transition_prefabs.append([c["background"]["prefab"] for c in theme_configs.values() if "background" in c])
    for names in [n for slots in themes.values() for n in slots.values()] + transition_prefabs:
        if True:
            for name in names:
                if name in prefabs:
                    continue
                src = glb_dir / f"{name}.glb"
                if not src.exists():
                    missing.append(name)
                    prefabs[name] = {"glb": None}
                    continue
                stats = glb_stats(src)
                if stats["bbox"] is None:
                    empty.append(name)
                copy_if_newer(src, out_glb / src.name)
                prefabs[name] = {"glb": f"glb/{src.name}", **stats}

    # Random variant groups (only one child is active in game)
    for name, info in prefabs.items():
        prefab_path = project / "GameObject" / f"{name}.prefab"
        if prefab_path.exists() and info.get("glb"):
            randomizers = parse_randomizers(prefab_path, guid_index)
            if randomizers:
                info["randomizers"] = randomizers
            lod_hidden = parse_lod_groups(prefab_path)
            if lod_hidden:
                info["lodHidden"] = lod_hidden

    # Runtime-assigned track meshes (TrackController configurations)
    out_mesh = args.out / "mesh"
    out_mesh.mkdir(parents=True, exist_ok=True)
    for name, info in prefabs.items():
        prefab_path = project / "GameObject" / f"{name}.prefab"
        if not prefab_path.exists():
            continue
        configs = parse_track_configs(prefab_path, guid_index)
        if not configs:
            continue
        for cfg in configs.values():
            src = mesh_dir / f"{cfg['mesh']}.glb" if cfg["mesh"] else None
            if src and src.exists():
                copy_if_newer(src, out_mesh / src.name)
                cfg["glb"] = f"mesh/{src.name}"
            elif cfg["mesh"]:
                missing.append(f"mesh:{cfg['mesh']}")
        info["trackConfigs"] = configs
        info["materials"] = sorted(set(info.get("materials", [])) | {m for c in configs.values() for m in c["materials"]})
    empty = [n for n in empty if "trackConfigs" not in prefabs[n]]

    # Materials used by those prefabs
    used_mats = {m for p in prefabs.values() for m in p.get("materials", [])}
    # Materials live both in Material/ and loose at the Assets root; Material/ wins on name clashes
    mat_files = {p.stem: p for p in project.glob("*.mat")}
    mat_files.update({p.stem: p for p in (project / "Material").glob("*.mat")})
    materials = {}
    for name in sorted(used_mats):
        if name in mat_files:
            materials[name] = parse_material(mat_files[name], guid_index, root)

    # Textures referenced by materials -> data/tex/
    out_tex = args.out / "tex"
    out_tex.mkdir(parents=True, exist_ok=True)
    for mat in materials.values():
        for tex in mat["textures"].values():
            src = root / tex.pop("path")
            if src.suffix.lower() not in (".png", ".jpg", ".jpeg"):
                tex["unsupported"] = src.name  # e.g. cubemaps (.asset) — handled later
                continue
            copy_if_newer(src, out_tex / src.name)
            tex["url"] = f"tex/{src.name}"

    manifest = {
        "source": str(root),
        "world": {"laneWidth": 20.0, "lanes": 3, "cellDepth": 11.25, "cellHeight": 14.0},
        "themes": {
            theme: {
                cat: {slot: names for slot, names in sorted(slots.items()) if slot_category(slot) == cat}
                for cat in ("boundary", "track", "special", "obstacle", "train", "prop", "other")
            }
            for theme, slots in themes.items()
        },
        "boundaries": boundaries,
        "themeConfigs": theme_configs,
        "prefabs": prefabs,
        "materials": materials,
    }
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=1))

    shaders = {}
    for m in materials.values():
        shaders[m["shader"]] = shaders.get(m["shader"], 0) + 1
    log(f"Randomizer groups: {sum(len(p.get('randomizers', {})) for p in prefabs.values())} in {sum('randomizers' in p for p in prefabs.values())} prefabs")
    log(f"LOD1+ renderers removed: {sum(len(p.get('lodHidden', [])) for p in prefabs.values())} in {sum('lodHidden' in p for p in prefabs.values())} prefabs")
    log(f"Prefabs: {len(prefabs)} ({len(empty)} without geometry, {len(missing)} missing glb)")
    log(f"Materials: {len(materials)}/{len(used_mats)} resolved; shaders: {shaders}")
    if empty:
        log(f"  no geometry: {', '.join(sorted(empty))}")
    if missing:
        log(f"  missing glb: {', '.join(sorted(missing))}")
    log(f"Wrote {args.out / 'manifest.json'}")


if __name__ == "__main__":
    main()
