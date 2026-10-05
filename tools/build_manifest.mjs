#!/usr/bin/env node
// Build the viewer manifest from an AssetRipper export of Subway Surfers.
//
// Reads theme slot tables (MonoBehaviour/*_Theme.asset), resolves theme
// inheritance, parses materials, measures each prefab glb and copies the
// referenced glbs into the viewer's data folder.
//
// Usage: node tools/build_manifest.mjs "/path/to/69.1 assets" [--out viewer/public/data] [--split] [--source-name <name>]
// Also runs as a worker thread (server/api.js): workerData = { exportDir, out, split, sourceName }.
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';

const GUID_RE = /guid: ([0-9a-f]{32})/;
const GUID_RE_G = /guid: ([0-9a-f]{32})/g;

// Built-in Unity shaders referenced by fileID with the zero guid
const BUILTIN_SHADERS = {
  10720: 'Mobile/Particles/Additive',
  10721: 'Mobile/Particles/Alpha Blended',
  10750: 'Unlit/Texture',
  10752: 'Unlit/Transparent',
  10753: 'Unlit/Transparent Cutout',
  10755: 'Unlit/Color',
  10770: 'UI/Default',
  46: 'Standard',
};

// ---------------------------------------------------------------- helpers

const read = (p) => readFileSync(p, 'utf8');
const lines = (text) => text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
const stem = (p) => path.parse(p).name;
const suffix = (p) => path.extname(p);
const partsOf = (p) => p.split(path.sep).filter(Boolean);
const num = (s) => {
  const t = String(s).trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) throw new Error(`could not convert string to float: '${t}'`);
  return Number(t);
};

/** Path ordering by components, like sorted() on pathlib paths. */
function comparePaths(a, b) {
  const pa = partsOf(a);
  const pb = partsOf(b);
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return pa.length - pb.length;
}

const sortedStrings = (iterable) => [...iterable].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** round(x, n) with ties to even on the exact binary value. */
function round(x, n) {
  const r = Number(x.toFixed(n));
  const frac = Math.abs(x).toFixed(100).split('.')[1];
  if (frac[n] === '5' && /^0*$/.test(frac.slice(n + 1))) {
    const down = Math.trunc(x * 10 ** n) / 10 ** n;
    const lastDigit = n > 0 ? Number(frac[n - 1]) : Math.trunc(Math.abs(x)) % 10;
    return lastDigit % 2 === 0 ? down : r;
  }
  return r;
}

/** Files under dir (recursive), in directory order. */
function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else yield full;
  }
}

function listDir(dir) {
  try {
    return readdirSync(dir).map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

/** Unity YAML documents with their class id and file id ("!u!<kind> &<fid>"). */
function yamlDocs(text) {
  return text.split('\n--- ').map((doc) => {
    const m = doc.match(/^!u!(\d+) &(\d+)/);
    return { doc, kind: m?.[1], fid: m?.[2] };
  });
}

// ---------------------------------------------------------------- guid index

/** guid -> asset path (without .meta) for every asset in ExportedProject. */
function buildGuidIndex(project) {
  const index = new Map();
  for (const meta of walk(project)) {
    if (!meta.endsWith('.meta')) continue;
    const m = read(meta).slice(0, 300).match(GUID_RE);
    if (m) index.set(m[1], meta.slice(0, -'.meta'.length));
  }
  return index;
}

// ---------------------------------------------------------------- themes

/** { parent: guid|null, slots: [[typeGuid, [prefabGuid...]]] } */
function parseTheme(file) {
  let parent = null;
  const slots = [];
  for (const line of lines(read(file))) {
    const m = line.match(GUID_RE);
    const s = line.trim();
    if (s.startsWith('_parent:')) parent = m ? m[1] : null;
    else if (s.startsWith('- Type:') && m) slots.push([m[1], []]);
    else if (s.startsWith('- {fileID:') && m && slots.length) slots.at(-1)[1].push(m[1]);
  }
  return { parent, slots };
}

/** slot name -> [prefab names], with parent slots overridden by children. */
function resolveTheme(guid, guidIndex, cache) {
  if (cache.has(guid)) return cache.get(guid);
  const file = guidIndex.get(guid);
  if (file === undefined || suffix(file) !== '.asset') return {};
  const theme = parseTheme(file);
  const slots = theme.parent ? { ...resolveTheme(theme.parent, guidIndex, cache) } : {};
  for (const [typeGuid, prefabs] of theme.slots) {
    const typePath = guidIndex.get(typeGuid);
    const slot = typePath ? stem(typePath) : `?${typeGuid}`;
    slots[slot] = prefabs.filter((g) => guidIndex.has(g)).map((g) => stem(guidIndex.get(g)));
  }
  cache.set(guid, slots);
  return slots;
}

/** <Theme>_Boundaries.asset: transition pieces placed where a boundary run starts/ends
 * (e.g. tube_start/tube_end around boundary_tube), plus per-boundary track settings. */
function parseBoundaries(file, guidIndex) {
  const name = (g) => (guidIndex.has(g) ? stem(guidIndex.get(g)) : null);
  const transitions = [];
  const trackInfos = {};
  let section = null;
  let current = null;
  for (const line of lines(read(file))) {
    const s = line.trim();
    if (s === 'TrackInfos:' || s === 'TransitionInfo:') {
      section = s.slice(0, -1);
      continue;
    }
    const m = s.match(GUID_RE);
    if (section === 'TrackInfos') {
      if (s.startsWith('- BoundaryType:') && m) {
        current = trackInfos[name(m[1])] ??= {};
      } else if (current !== null && s.includes(':') && !s.startsWith('-')) {
        const i = s.indexOf(':');
        current[s.slice(0, i).trim()] = s.slice(i + 1).trim() === '1';
      }
    } else if (section === 'TransitionInfo') {
      if (s.startsWith('- BoundaryType:') && m) {
        current = { slot: name(m[1]), exceptions: [] };
        transitions.push(current);
      } else if (current === null) {
        continue;
      } else if (s.startsWith('AssetType:') && m) {
        current.prefab = name(m[1]);
      } else if (s.startsWith('Transition:')) {
        current.at = s.split(':')[1].trim() === '1' ? 'end' : 'start';
      } else if (s.startsWith('Probability:')) {
        current.probability = num(s.split(':')[1]);
      } else if (s.startsWith('- {fileID') && m) {
        current.exceptions.push(name(m[1]));
      }
    }
  }
  return { transitions: transitions.filter((t) => t.prefab), trackInfos };
}

/** <Theme>_Config.asset (ThemeConfig): fog, camera far plane, skybox material, skyline. */
function parseThemeConfig(file, guidIndex) {
  const text = read(file);
  const color = (key, src = text, n = 4) => {
    const re = n === 4
      ? new RegExp(`${key}: \\{r: ([\\d.e-]+), g: ([\\d.e-]+), b: ([\\d.e-]+), a: ([\\d.e-]+)\\}`)
      : new RegExp(`${key}: \\{r: ([\\d.e-]+), g: ([\\d.e-]+), b: ([\\d.e-]+)`);
    const m = src.match(re);
    return m ? m.slice(1, n + 1).map(num) : null;
  };
  const number = (key) => {
    const m = text.match(new RegExp(`\\n  ${key}: ([\\d.e-]+)`));
    return m ? num(m[1]) : null;
  };
  const ref = (key) => {
    const m = text.match(new RegExp(`${key}: \\{fileID: \\d+, guid: (\\w+)`));
    return m ? guidIndex.get(m[1]) ?? null : null;
  };
  const out = {
    fog: { color: color('FogColor'), start: number('FogStartDistance'), end: number('FogEndDistance') },
    cameraFar: number('CameraFar'),
    trainLight: color('TrainLight'),
  };
  const skybox = ref('  Skybox');
  if (skybox && suffix(skybox) === '.mat') {
    const mat = read(skybox);
    const power = mat.match(/_Power: ([\d.e-]+)/);
    out.sky = { top: color('_TopColor', mat, 3), bottom: color('_BottomColor', mat, 3), power: power ? num(power[1]) : 1 };
    // TEXTURE_ENABLED (3.60 Ireland): a vertical gradient texture, times the colors
    const texGuid = mat.match(/_MainTex:\n\s+m_Texture: \{fileID: \d+, guid: (\w+)/)?.[1];
    if (/_HasTexture: 1\b/.test(mat) && texGuid && guidIndex.has(texGuid)) out.sky.texture = guidIndex.get(texGuid);
  }
  const bg = text.match(/BackgroundLayer:\n {4}Prefab: \{fileID: \d+, guid: (\w+)/);
  if (bg && guidIndex.has(bg[1])) {
    out.background = {
      prefab: stem(guidIndex.get(bg[1])),
      distance: number('DistanceFromPlayer'),
      tint: color('    Tint'),
      gradientA: color('GradientA'),
      gradientB: color('GradientB'),
      colorMode: Number(text.match(/BackgroundLayer:[\s\S]*?\n {4}ColorMode: (\d+)/)?.[1] ?? 1), // 0 tint, 1 gradient, 2 vertex colors
    };
    // Vertex colors (3.60 Ireland): the glb lost them (compressed mesh), decoded from the asset
    if (out.background.colorMode === 2) {
      const meshes = [...read(guidIndex.get(bg[1])).matchAll(/MeshFilter:[\s\S]*?m_Mesh: \{fileID: \d+, guid: (\w+)/g)].map(([, g]) => guidIndex.get(g));
      const mesh = meshes.length === 1 && meshes[0] && existsSync(meshes[0]) ? compressedMesh(read(meshes[0])) : null;
      if (mesh?.colors) out.background.mesh = mesh;
    }
  }
  return out;
}

/** Unity PackedBitVector: `count` values of `bits` bits, packed LSB first. */
function unpackBits(hex, count, bits) {
  const data = Buffer.from(hex, 'hex');
  const out = new Array(count);
  let byte = 0;
  let bit = 0;
  for (let i = 0; i < count; i++) {
    let x = 0;
    for (let got = 0; got < bits; ) {
      x += ((data[byte] >> bit) & ((1 << Math.min(bits - got, 8 - bit)) - 1)) * 2 ** got;
      const n = Math.min(bits - got, 8 - bit);
      bit += n;
      got += n;
      if (bit === 8) (byte++, (bit = 0));
    }
    out[i] = x;
  }
  return out;
}

/**
 * A mesh asset stored with m_MeshCompression (no vertex buffer): positions, RGBA colors
 * and triangles in glb space (X mirrored, winding flipped), or null.
 */
function compressedMesh(text) {
  const vector = (name) => {
    const block = text.split(`\n    ${name}:\n`)[1]?.split(/\n {4}m_/)[0] ?? '';
    const field = (key) => block.match(new RegExp(`${key}: ?(.*)`))?.[1].trim() ?? '';
    const count = Number(field('m_NumItems'));
    const bits = Number(field('m_BitSize'));
    if (!count || !bits) return null;
    const raw = unpackBits(field('m_Data'), count, bits);
    if (!block.includes('m_Range')) return raw;
    const range = Number(field('m_Range'));
    const start = Number(field('m_Start'));
    const max = 2 ** bits - 1;
    return raw.map((x) => start + (x * range) / max);
  };
  const v = vector('m_Vertices');
  const tris = vector('m_Triangles');
  if (!v || !tris) return null;
  const c = vector('m_FloatColors');
  const count = v.length / 3;
  // First UV channel (m_UVInfo: 4 bits per channel, dimension - 1 in the low 2); V flipped like glTF
  const uvAll = vector('m_UV');
  const info = Number(text.match(/m_UVInfo: (\d+)/)?.[1] ?? 0);
  const uvDim = info ? (info & 3) + 1 : 2;
  const uvs = uvAll && uvAll.length >= count * uvDim ? Array.from({ length: count * 2 }, (_, k) => round(k % 2 ? 1 - uvAll[(k >> 1) * uvDim + 1] : uvAll[(k >> 1) * uvDim], 5)) : null;
  const groups = [...text.matchAll(/\n {4}indexCount: (\d+)/g)].map(([, n]) => Number(n));
  const positions = [];
  for (let i = 0; i < v.length; i += 3) positions.push(round(-v[i], 4), round(v[i + 1], 4), round(v[i + 2], 4));
  const indices = [];
  for (let i = 0; i + 2 < tris.length; i += 3) indices.push(tris[i], tris[i + 2], tris[i + 1]);
  return { positions, indices, uvs, groups, colors: c && c.length === count * 4 ? c.map((x) => round(x, 4)) : null };
}

/** Mesh blend shapes at full weight (last frame of each channel): [{ name, indices, deltas }], glb space. */
function blendShapes(text) {
  const block = text.split('\n  m_Shapes:')[1]?.split(/\n  m_\w/)[0] ?? '';
  const vertices = [...block.matchAll(/- vertex: \{x: ([^,]+), y: ([^,]+), z: ([^}]+)\}[\s\S]*?\n\s+index: (\d+)/g)].map(([, x, y, z, i]) => [Number(x), Number(y), Number(z), Number(i)]);
  const shapes = [...(block.split('\n    shapes:')[1] ?? '').matchAll(/firstVertex: (\d+)\n\s+vertexCount: (\d+)/g)].map(([, f, n]) => [Number(f), Number(n)]);
  const channels = [...(block.split('\n    channels:')[1] ?? '').matchAll(/name: (.*)\n\s+nameHash: \d+\n\s+frameIndex: (\d+)\n\s+frameCount: (\d+)/g)].map(([, name, f, n]) => ({ name: name.trim(), shape: Number(f) + Number(n) - 1 }));
  return channels.filter((ch) => shapes[ch.shape]).map(({ name, shape }) => {
    const [first, n] = shapes[shape];
    const list = vertices.slice(first, first + n);
    return { name, indices: list.map((v) => v[3]), deltas: list.flatMap(([x, y, z]) => [round(-x, 4), round(y, 4), round(z, 4)]) };
  });
}

/**
 * AssetRipper writes all-zero vertex colors for compressed meshes (m_MeshCompression), so
 * additive vertex-colored glows vanish (3.70 Transylvania's window light on the tube floor)
 * and colored meshes go black. Puts the real colors back into the glb: each node's
 * renderer mesh is decoded from its asset and matched to the glb primitives, by vertex
 * order where it lines up, else vertex by vertex on position. Returns the primitives fixed.
 */
function fixZeroColors(glbFile, prefabFile, guidIndex) {
  const docs = yamlDocs(read(prefabFile));
  const names = new Map();
  for (const { doc, kind, fid } of docs) if (kind === '1') names.set(fid, doc.match(/m_Name: (.*)/)?.[1].trim() ?? '');
  const meshOfNode = new Map(); // GameObject name -> mesh asset (MeshFilter)
  for (const { doc, kind } of docs) {
    if (kind !== '33') continue;
    const go = names.get(doc.match(/m_GameObject: \{fileID: (\d+)/)?.[1]);
    const mesh = guidIndex.get(doc.match(/m_Mesh: \{[^}]*guid: (\w+)/)?.[1]);
    if (go && mesh && existsSync(mesh)) meshOfNode.set(go, mesh);
  }
  if (!meshOfNode.size) return 0;
  const data = readFileSync(glbFile);
  const jsonLen = data.readUInt32LE(12);
  const json = JSON.parse(data.toString('utf8', 20, 20 + jsonLen));
  const binStart = 20 + jsonLen + 8;
  const view = (ai) => {
    const a = json.accessors[ai];
    const bv = json.bufferViews[a.bufferView];
    const size = { 5126: 4, 5123: 2, 5121: 1 }[a.componentType];
    const n = { VEC3: 3, VEC4: 4 }[a.type];
    return { a, n, size, stride: bv.byteStride ?? size * n, start: binStart + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0) };
  };
  const readComp = (v, i, c) => {
    const o = v.start + i * v.stride + c * v.size;
    if (v.a.componentType === 5126) return data.readFloatLE(o);
    const raw = v.size === 1 ? data.readUInt8(o) : data.readUInt16LE(o);
    return v.a.normalized ? raw / (v.size === 1 ? 255 : 65535) : raw;
  };
  const writeComp = (v, i, c, x) => {
    const o = v.start + i * v.stride + c * v.size;
    if (v.a.componentType === 5126) data.writeFloatLE(x, o);
    else if (v.size === 1) data.writeUInt8(Math.round(Math.min(Math.max(x, 0), 1) * 255), o);
    else data.writeUInt16LE(Math.round(Math.min(Math.max(x, 0), 1) * 65535), o);
  };
  const decoded = new Map();
  let fixed = 0;
  for (const node of json.nodes ?? []) {
    if (node.mesh == null) continue;
    // Multi-material renderers: AssetRipper names the node's primitives after the GameObject
    const file = meshOfNode.get(node.name) ?? meshOfNode.get(node.name?.replace(/_\d+$/, ''));
    if (!file) continue;
    if (!decoded.has(file)) {
      const text = read(file);
      const mesh = /m_MeshCompression: [1-9]/.test(text) ? compressedMesh(text) : null;
      const subs = [...text.matchAll(/\n {4}firstVertex: (\d+)\n {4}vertexCount: (\d+)/g)].map(([, f, n]) => [Number(f), Number(n)]);
      decoded.set(file, mesh?.colors ? { ...mesh, subs } : null);
    }
    const mesh = decoded.get(file);
    if (!mesh) continue;
    const count = mesh.positions.length / 3;
    // Unity vertices by rounded position (glb space), for primitives in another order
    let byPos = null;
    const key = (x, y, z) => `${Math.round(x * 100)},${Math.round(y * 100)},${Math.round(z * 100)}`;
    json.meshes[node.mesh].primitives.forEach((prim, k) => {
      if (prim.attributes.COLOR_0 == null || prim.attributes.POSITION == null) return;
      const col = view(prim.attributes.COLOR_0);
      const pos = view(prim.attributes.POSITION);
      for (let i = 0; i < col.a.count; i++) for (let c = 0; c < col.n; c++) if (readComp(col, i, c) !== 0) return; // has colors
      const [first, n] = mesh.subs[k] ?? [0, count];
      const near = (i, u) => [0, 1, 2].every((c) => Math.abs(readComp(pos, i, c) - mesh.positions[u * 3 + c]) < 0.05);
      let map = null;
      if (n === pos.a.count && Array.from({ length: Math.min(n, 64) }, (_, i) => i).every((i) => near(i, first + i))) {
        map = (i) => first + i;
      } else {
        if (!byPos) {
          byPos = new Map();
          for (let u = count - 1; u >= 0; u--) byPos.set(key(mesh.positions[u * 3], mesh.positions[u * 3 + 1], mesh.positions[u * 3 + 2]), u);
        }
        map = (i) => byPos.get(key(readComp(pos, i, 0), readComp(pos, i, 1), readComp(pos, i, 2)));
      }
      let hits = 0;
      for (let i = 0; i < col.a.count; i++) {
        const u = map(i);
        if (u == null) continue;
        hits++;
        for (let c = 0; c < col.n; c++) writeComp(col, i, c, mesh.colors[u * 4 + c] ?? 1);
      }
      if (hits) fixed++;
    });
  }
  if (fixed) writeFileSync(glbFile, data);
  return fixed;
}

/**
 * SkinnedMeshRenderers without bones, animated by blend shapes only (3.68 Cosmic
 * Crossroads monster). The glb export has no morph targets and its vertex order drifts
 * from Unity's at seams, so the whole mesh is rebuilt from the (compressed) asset.
 * Returns [{ node, materials, data: { positions, uvs, colors, indices, groups, morphs } }].
 */
function parseMorphMeshes(file, guidIndex) {
  const docs = yamlDocs(read(file));
  const names = new Map();
  for (const { doc, kind, fid } of docs) if (kind === '1') names.set(fid, doc.match(/m_Name: (.*)/)?.[1].trim() ?? '');
  const out = [];
  for (const { doc, kind } of docs) {
    if (kind !== '137' || !/\n {2}m_Bones: \[\]/.test(doc)) continue;
    const go = doc.match(/m_GameObject: \{fileID: (\d+)/)?.[1];
    const meshFile = guidIndex.get(doc.match(/\n {2}m_Mesh: \{[^}]*guid: (\w+)/)?.[1]);
    if (!names.has(go) || !meshFile || !existsSync(meshFile)) continue;
    const text = read(meshFile);
    const morphs = blendShapes(text);
    const mesh = morphs.length ? compressedMesh(text) : null;
    if (!mesh?.uvs) continue;
    const materials = [...(doc.split('\n  m_Materials:')[1]?.split(/\n  \w/)[0] ?? '').matchAll(/guid: (\w+)/g)].map(([, g]) => guidIndex.get(g)).filter(Boolean).map((p) => stem(p));
    out.push({ node: names.get(go), materials, data: { ...mesh, morphs } });
  }
  return out;
}

// Chase-mode asset types -> the regular theme slot that looks the same
const CHUNK_SLOT_ALIASES = {
  ct_moving_obstacle_jump: 'obstacle_barrier_jump',
  ct_moving_obstacle_standard: 'obstacle_barrier_standard',
  ct_moving_obstacle_roll: 'obstacle_barrier_roll',
  ct_moving_obstacle_full: 'obstacle_barrier_full',
  ct_moving_obstacle_train_platform: 'obstacle_train_platform',
  ct_vanish_obstacles_train: 'train_static_1',
  ct_vanish_obstacles_train_3: 'train_static_3',
  ct_vanish_obstacles_train_5: 'train_static_5',
  ct_vanish_obstacles_moving_train_3: 'train_moving_3',
  ct_vanish_obstacles_moving_train_5: 'train_moving_5',
  ct_vanish_obstacles_full: 'obstacle_barrier_full',
  ct_vanish_obstacles_standard: 'obstacle_barrier_standard',
  ct_vanish_obstacles_train_platform: 'obstacle_train_platform',
};

/** Chase chunk prefab: ChunkAssetPlacer components (slot + position) with the
 * RandomChildRandomizer / MirrorRandomizer structure above them, and its length. */
function parseChunk(file, guidIndex) {
  const text = read(file);
  const transforms = new Map(); // fid -> [pos, father, scale]
  const goTransform = new Map();
  const scriptsOnGo = new Map();
  const placers = [];
  for (const { doc, kind, fid } of yamlDocs(text)) {
    if (!kind) continue;
    const go = doc.match(/m_GameObject: \{fileID: (\d+)/);
    if (kind === '4') {
      const pos = doc.match(/m_LocalPosition: \{x: ([-\d.e]+), y: ([-\d.e]+), z: ([-\d.e]+)\}/);
      const scale = doc.match(/m_LocalScale: \{x: ([-\d.e]+)/);
      const father = doc.match(/m_Father: \{fileID: (\d+)/);
      transforms.set(fid, [[1, 2, 3].map((i) => num(pos[i])), father ? father[1] : '0', scale ? num(scale[1]) : 1.0]);
      if (go) goTransform.set(go[1], fid);
    } else if (kind === '114' && go) {
      const script = doc.match(/m_Script: .*guid: (\w+)/);
      const name = script && guidIndex.has(script[1]) ? stem(guidIndex.get(script[1])) : '';
      if (!scriptsOnGo.has(go[1])) scriptsOnGo.set(go[1], {});
      scriptsOnGo.get(go[1])[name] = doc;
      const asset = doc.match(/_assetType: \{fileID: \d+, guid: (\w+)/);
      if (name === 'ChunkAssetPlacer' && asset && guidIndex.has(asset[1])) placers.push([go[1], stem(guidIndex.get(asset[1]))]);
    }
  }
  const owner = new Map([...goTransform].map(([go, tid]) => [tid, go]));

  const ancestors = (tid) => {
    const chain = [];
    while (transforms.has(tid)) {
      chain.push(tid);
      tid = transforms.get(tid)[1];
    }
    return chain;
  };
  // Uniform scales only (all chunk props are): child offsets scale with their parents
  const world = (tid) => {
    const chain = ancestors(tid).map((t) => transforms.get(t));
    let acc = [0.0, 0.0, 0.0];
    for (let i = 0; i < chain.length; i++) {
      let parentScale = 1.0;
      for (const [, , s] of chain.slice(i + 1)) parentScale *= s;
      acc = acc.map((v, k) => v + chain[i][0][k] * parentScale);
    }
    return acc;
  };
  const worldScale = (tid) => ancestors(tid).reduce((s, t) => s * transforms.get(t)[2], 1.0);

  const placements = [];
  for (const [go, rawSlot] of placers) {
    const slot = CHUNK_SLOT_ALIASES[rawSlot] ?? rawSlot;
    if (slot.startsWith('track_') || slot.startsWith('boundary_')) continue; // rails/boundaries come from the run generator
    const tid = goTransform.get(go);
    const [x, y, z] = world(tid);
    const entry = { slot, pos: [-x, y, z] }; // Unity -> glTF: mirror X
    const scale = worldScale(tid);
    if (Math.abs(scale - 1) > 1e-3) entry.scale = round(scale, 4);
    const chain = ancestors(tid);
    chain.forEach((t, i) => {
      const scripts = scriptsOnGo.get(owner.get(t)) ?? {};
      if ('RandomChildRandomizer' in scripts && i > 0 && !('group' in entry)) {
        const prob = scripts.RandomChildRandomizer.match(/_activationProbability: ([\d.]+)/);
        entry.group = t;
        entry.option = chain[i - 1];
        entry.groupProbability = prob ? num(prob[1]) : 1.0;
      }
      if ('MirrorRandomizer' in scripts && !('mirror' in entry)) {
        const prob = scripts.MirrorRandomizer.match(/_mirrorProbability: ([\d.]+)/);
        entry.mirror = t;
        entry.mirrorX = -world(t)[0];
        entry.mirrorProbability = prob ? num(prob[1]) : 0.5;
      }
    });
    placements.push(entry);
  }
  const exitZ = text.match(/ExitAnchorOffset:\s*\n\s*x: [-\d.]+\s*\n\s*y: [-\d.]+\s*\n\s*z: ([-\d.]+)/);
  return { length: exitZ ? num(exitZ[1]) * 11.25 : 540.0, placements };
}

/** ThemeConfig.ThemeEffects entry: segmented ground effects (Floor Is Lava's lava)
 * that the game leapfrogs under the runner. Returns the segment node names and size. */
function parseThemeEffect(file, guidIndex) {
  const docs = yamlDocs(read(file));
  const goNames = new Map();
  const transformGo = new Map();
  for (const { doc, kind, fid } of docs) {
    if (kind === '1') {
      const nm = doc.match(/m_Name: (.*)/);
      goNames.set(fid, nm ? nm[1].trim() : '');
    } else if (kind === '4') {
      const go = doc.match(/m_GameObject: \{fileID: (\d+)/);
      if (go) transformGo.set(fid, go[1]);
    }
  }
  for (const { doc } of docs) {
    const size = doc.match(/_segmentSize: ([\d.]+)/);
    if (!doc.startsWith('!u!114') || !size) continue;
    const segments = [...doc.matchAll(/_segment[AB]: \{fileID: (\d+)/g)].map((m) => goNames.get(transformGo.get(m[1]) ?? '') ?? null);
    const script = doc.match(/m_Script: .*guid: (\w+)/);
    return {
      prefab: stem(file),
      script: script && guidIndex.has(script[1]) ? stem(guidIndex.get(script[1])) : null,
      segmentSize: num(size[1]),
      segments: segments.filter(Boolean),
    };
  }
  return null;
}

// Prefabs the viewer needs beyond theme slots
const EXTRA_PREFABS = ['_Common_LightSignal_Light_Green', '_Common_LightSignal_Light_Red'];

// ---------------------------------------------------------------- 1.x themes
//
// 1.x games have no *_Theme.asset: one MonoBehaviour per city maps generic prefabs
// (high_01_left_gen, track_shadow_mid_gen, …) to the city's own, and carries the fog,
// sky gradient and skyline layers. Trains come as single cars the game chains in code,
// so they are assembled here as composite prefabs ({ parts: [{ prefab, pos }] }).

/** Generic prefab name (without _gen) -> regular theme slot. */
const LEGACY_SLOTS = [
  [/^(low|med|high)_\d+_(left|right)$/, (m) => `boundary_${m[1] === 'med' ? 'medium' : m[1]}_${m[2]}`],
  [/^epic_\d+_(start|mid|end)$/, (m) => `boundary_epic_${m[1]}`],
  [/^gates_base$/, () => 'boundary_gate'],
  [/^gates_(left|mid|right|sides)$/, (m) => `special_gate_${m[1]}`],
  [/^(pillars|station)_(start|mid|end)$/, (m) => `boundary_${m[1]}_${m[2]}`],
  [/^station_platforms$/, () => 'special_station_platform'],
  [/^tube$/, () => 'boundary_tube'],
  [/^track_gates$/, () => 'track_gates'],
  [/^track(_shadow_(start|mid|end))?$/, () => 'track_track'],
  [/^ground(_shadow_mid)?$/, () => 'track_ground'],
  [/^blocker_(jump|roll|standard)$/, (m) => `obstacle_barrier_${m[1]}`],
  [/^bush_\d+$/, () => 'obstacle_bush'],
  [/^(dumpster|lightSignal|pillar|powerBox)$/, (m) => `obstacle_${m[1]}`],
  [/^extra_(\d+)$/, (m) => `decoration_extra_${m[1].padStart(2, '0')}`],
  [/^event_(\d+)$/, (m) => `decoration_event_${m[1].padStart(2, '0')}`],
  [/^train_ramp$/, () => 'train_ramp'],
  [/^train_start$/, () => 'prop_train_start'],
];
// What the 2.x+ TrackInfos say for these boundaries (1.x keeps it in code)
const LEGACY_TRACK_INFOS = {
  boundary_epic_start: { SpawnTracks: false, ShowShadows: false },
  boundary_epic_mid: { SpawnTracks: false, ShowShadows: false },
  boundary_epic_end: { SpawnTracks: false, ShowShadows: false },
  boundary_gate: { SpawnTracks: false, ShowShadows: false },
  boundary_station_start: { SpawnTracks: true, ShowShadows: true },
  boundary_station_mid: { SpawnTracks: true, ShowShadows: true },
  boundary_station_end: { SpawnTracks: true, ShowShadows: true },
  boundary_pillars_start: { SpawnTracks: true, ShowShadows: true },
  boundary_pillars_mid: { SpawnTracks: true, ShowShadows: true },
  boundary_pillars_end: { SpawnTracks: true, ShowShadows: true },
  boundary_tube: { SpawnTracks: true, ShowShadows: true },
};
// _environmentKind._type of _environmentTransitionConfigs -> boundary slot
const LEGACY_ENVIRONMENT_KINDS = { 2: 'boundary_tube' };
// Train cars per variant: the moving train's first car is the locomotive
const LEGACY_TRAIN_CARS = { Cargo: ['cargo', 'cargo'], Standard: ['standard', 'standard_front'], Subway: ['sub', 'sub_front'] };
const LEGACY_TRAINS = [['static', [1, 2, 3, 5]], ['moving', [3, 5]]];

function parseLegacyTheme(file, guidIndex) {
  const text = read(file);
  const name = text.match(/\n {2}m_Name: (.*)/)[1].trim();
  const prefabName = (g) => (guidIndex.has(g) ? stem(guidIndex.get(g)) : null);
  const color = (key, src = text) => {
    const m = src.match(new RegExp(`${key}: \\{r: ([\\d.e-]+), g: ([\\d.e-]+), b: ([\\d.e-]+), a: ([\\d.e-]+)\\}`));
    return m ? m.slice(1, 5).map(num) : null;
  };
  const number = (key, src = text) => {
    const m = src.match(new RegExp(`\\n *${key}: ([\\d.e-]+)`));
    return m ? num(m[1]) : null;
  };

  // Generic -> themed prefabs
  const slots = {};
  const cars = {}; // generic car name ("standard_front") -> themed prefab
  const shortPieces = {}; // "track_shadow_short_start" -> themed prefab
  const roles = {}; // themed prefab -> generic role ("high_01_left"): themed names vary
  const themedOf = {}; // generic prefab ("event_3_gen") -> the city's own
  const block = text.split('\n  _prefabMappingsGeneric:')[1] ?? '';
  // Key case varies (1.70: genericPrefab/themePrefab, 1.118: GenericPrefab/ThemePrefab)
  for (const [, g1, g2] of block.matchAll(/GenericPrefab: \{fileID: \d+, guid: (\w+)[^\n]*\n\s*ThemePrefab: \{fileID: \d+, guid: (\w+)/gi)) {
    const generic = prefabName(g1)?.replace(/_gen$/, '');
    const themed = prefabName(g2);
    if (!generic || !themed) continue;
    roles[themed] ??= generic;
    themedOf[`${generic}_gen`] ??= themed;
    const car = generic.match(/^train_(cargo|standard|sub)(?:_\d+)?(_front)?$/);
    if (car) {
      cars[car[1] + (car[2] ?? '')] = themed;
      continue;
    }
    if (/_shadow_short_(start|end)$/.test(generic)) {
      shortPieces[generic] = themed;
      continue;
    }
    for (const [re, slotOf] of LEGACY_SLOTS) {
      const m = generic.match(re);
      if (!m) continue;
      const list = (slots[slotOf(m)] ??= []);
      if (!list.includes(themed)) list.push(themed);
      break;
    }
  }

  // Composite prefabs: trains from cars, one-segment shadowed stretches from two short pieces
  const composites = {};
  for (const [kind, counts] of LEGACY_TRAINS) {
    for (const n of counts) {
      for (const [variant, [body, front]] of Object.entries(LEGACY_TRAIN_CARS)) {
        const car = (i) => cars[kind === 'moving' && i === 0 ? front : body] ?? cars[body];
        if (!cars[body]) continue;
        const prefab = `${name}_Train_${kind[0].toUpperCase()}${kind.slice(1)}_${n}_${variant}`;
        composites[prefab] = Array.from({ length: n }, (_, i) => ({ prefab: car(i), pos: [0, 0, 30 + 60 * i] }));
        (slots[`train_${kind}_${n}`] ??= []).push(prefab);
      }
    }
  }
  for (const kind of ['track', 'ground']) {
    const start = shortPieces[`${kind}_shadow_short_start`];
    const end = shortPieces[`${kind}_shadow_short_end`];
    if (!start || !end) continue;
    const prefab = `${name}_${kind}_shadow_start_end`;
    composites[prefab] = [{ prefab: start, pos: [0, 0, 0] }, { prefab: end, pos: [0, 0, 90] }];
    roles[prefab] = `${kind}_shadow_start_end`;
    (slots[`track_${kind === 'track' ? 'track' : 'ground'}`] ??= []).push(prefab);
  }

  // Tube entrances/exits
  const transitions = [];
  for (const cfg of (text.split('\n  _environmentTransitionConfigs:')[1] ?? '').split(/\n {2}- _environmentKind:/).slice(1)) {
    const slot = LEGACY_ENVIRONMENT_KINDS[number('_type', cfg)];
    if (!slot) continue;
    for (const at of ['start', 'end']) {
      const part = cfg.split(`_transition${at === 'start' ? 'Start' : 'End'}:`)[1]?.split('_transition')[0] ?? '';
      const m = part.match(/Prefab: \{fileID: \d+, guid: (\w+)/);
      if (m && prefabName(m[1])) transitions.push({ slot, at, prefab: prefabName(m[1]), probability: number('SpawnProbability', part) ?? 1, exceptions: [] });
    }
  }

  // Skyline: layers of silhouettes in one flat color, tinted per layer, behind a sky gradient
  const bgText = text.split('\n  _background:')[1]?.split('\n  _distantObjectGlobalConfig:')[0] ?? '';
  const layers = bgText.split(/\n {4}- Name: /).slice(1).map((layer) => {
    const list = (key) => [...(layer.split(`${key}:`)[1]?.split(/\n {6}\w/)[0] ?? '').matchAll(GUID_RE_G)].map(([, g]) => prefabName(g)).filter(Boolean);
    return {
      name: layer.split('\n')[0].trim(),
      fill: list('SkylineFillObjectPrefabs'),
      singles: list('SingleObjectPrefabs'),
      tint: color('_commonMaterialTintColor', layer),
      index: number('LayerIndex', layer) ?? 0,
      offset: number('z', (layer.match(/_offsetFromLayerDefault: \{[^}]*\}/)?.[0] ?? '').replace(/[{},]/g, '\n')) ?? 0,
    };
  });
  // Before the layered skyline (1.55): background silhouettes and monuments in one color,
  // the sky gradient under _fogGradient*, and fog distances fixed in the shaders
  if (!layers.length) {
    const refs = (key) => [...new Set([...(text.split(`\n  ${key}:`)[1]?.split(/\n {2}\w/)[0] ?? '').matchAll(GUID_RE_G)].map(([, g]) => prefabName(g)).filter(Boolean))];
    const tint = color('_fogSilhouetteColor');
    const fill = refs('_backgroundPrefabs');
    const singles = refs('_monumentPrefabs');
    if (fill.length) layers.push({ name: 'Back', fill, singles: [], tint, index: 1, offset: 0 });
    if (singles.length) layers.push({ name: 'Front', fill: [], singles, tint, index: 2, offset: 0 });
  }
  const config = {
    fog: { color: color('_fogColor'), start: number('_fogStartDistance') ?? 428, end: number('_fogEndDistance') ?? 784 },
    sky: {
      top: (color('GradientTopColor') ?? color('_fogGradientTop'))?.slice(0, 3) ?? null,
      bottom: (color('GradientBottomColor') ?? color('_fogGradientBottom'))?.slice(0, 3) ?? null,
      power: 1,
    },
  };
  if (layers.length) {
    config.skylineLayers = {
      distance: number('_backgroundStartDistance') ?? 1000,
      spacing: number('LayerSpacing', bgText) ?? 5,
      limits: [number('SkylineLeftLimit', bgText) ?? -350, number('SkylineRightLimit', bgText) ?? 750],
      layers,
    };
  }
  return { name, slots, composites, roles, themedOf, transitions, config, trackInfos: { ...LEGACY_TRACK_INFOS } };
}

const TRACK_TYPES = {
  0: 'Invisible', 1: 'TrackNormal', 2: 'TrackShadow', 3: 'TrackShadowStart', 4: 'TrackShadowEnd',
  5: 'TrackShadowStartEnd', 6: 'GroundNormal', 7: 'GroundShadow', 8: 'GroundShadowStart',
  9: 'GroundShadowEnd', 10: 'GroundShadowStartEnd',
};

/** TrackController `_configurations`: TrackType -> {mesh, materials} (meshes assigned at runtime). */
function parseTrackConfigs(file, guidIndex) {
  const configs = {};
  let current = null;
  let inMats = false;
  for (const line of lines(read(file))) {
    const s = line.trim();
    if (s.startsWith('- TrackType:')) {
      const value = s.split(':')[1];
      current = { mesh: null, materials: [] };
      configs[TRACK_TYPES[parseInt(value, 10)] ?? value.trim()] = current;
      inMats = false;
    } else if (current === null) {
      continue;
    } else if (s.startsWith('MeshLOD0:') || s.startsWith('Mesh:')) { // "Mesh" before LODs (2.x)
      const m = s.match(GUID_RE);
      current.mesh = m && guidIndex.has(m[1]) ? stem(guidIndex.get(m[1])) : null;
    } else if (s.startsWith('Materials:')) {
      inMats = true;
    } else if (inMats && s.startsWith('- {fileID:')) {
      const m = s.match(GUID_RE);
      if (m && guidIndex.has(m[1])) current.materials.push(stem(guidIndex.get(m[1])));
    } else if (!s.startsWith('- ')) {
      inMats = false;
      if (!s.startsWith('Mesh') && !s.startsWith('Materials')) current = null;
    }
  }
  return configs;
}

/** RandomChildRandomizer / WeightedChildRandomizer components: GameObject name ->
 * activation probability, or { probability, weights: child name -> weight }.
 *
 * At runtime the game enables one random child of such a node (with that probability)
 * and disables the others; the glb export contains all of them. */
function parseRandomizers(file, guidIndex) {
  const docs = yamlDocs(read(file));
  const names = new Map();
  const childrenOf = new Map(); // GameObject -> child GameObjects (Transform order)
  const goOfTransform = new Map();
  for (const { doc, kind, fid } of docs) {
    if (kind === '1') {
      const nm = doc.match(/m_Name: (.*)/);
      names.set(fid, nm ? nm[1].trim() : '');
    }
    if (kind === '4') goOfTransform.set(fid, doc.match(/m_GameObject: \{fileID: (\d+)/)?.[1]);
  }
  for (const { doc, kind } of docs) {
    if (kind !== '4') continue;
    const kids = [...(doc.split('m_Children:')[1]?.split('m_Father')[0] ?? '').matchAll(/fileID: (\d+)/g)].map(([, t]) => goOfTransform.get(t));
    childrenOf.set(doc.match(/m_GameObject: \{fileID: (\d+)/)?.[1], kids.filter(Boolean));
  }
  const out = {};
  for (const { doc } of docs) {
    if (!doc.startsWith('!u!114')) continue;
    const script = doc.match(/m_Script: .*guid: (\w+)/);
    if (!script || !guidIndex.has(script[1])) continue;
    const kind = stem(guidIndex.get(script[1]));
    // Every "pick one child" randomizer, future ones included (*ChildRandomizer), plus the
    // distance one; ActivationRandomizer (on/off) and TransformRandomizer (jitter) leave
    // everything shown
    if (!/ChildRandomizer$/.test(kind)) continue;
    const go = doc.match(/m_GameObject: \{fileID: (\d+)/);
    const prob = doc.match(/_activationProbability: ([\d.]+)/);
    if (!go || !names.has(go[1])) continue;
    const probability = prob ? num(prob[1]) : 1.0;
    // WeightedChildRandomizer (3.x): children picked by weight ("static" kraken 2, "active" 2, "active_animated" 1)
    const weighted = [...doc.matchAll(/- GameObject: \{fileID: (\d+)\}\n\s+Weight: ([\d.]+)/g)].filter(([, fid]) => names.has(fid));
    // RandomChildRandomizer: any child, equally (named, so the showcase can lay each one)
    // DistanceRequiredChildRandomizer (3.68): a unique filler at most every _minimumDistance,
    // the fallback filler otherwise (here: the fallback twice as often)
    const filler = (key) => names.get(doc.match(new RegExp(`${key}: \\{fileID: (\\d+)`))?.[1]);
    const distance = kind === 'DistanceRequiredChildRandomizer' ? [[filler('_uniqueFiller'), 1], [filler('_fallbackFiller'), 2]].filter(([n]) => n) : [];
    const kids = (childrenOf.get(go[1]) ?? []).filter((fid) => names.has(fid));
    const weights = distance.length ? distance : weighted.length ? weighted.map(([, fid, w]) => [names.get(fid), num(w)]) : kids.map((fid) => [names.get(fid), 1]);
    out[names.get(go[1])] = weights.length ? { probability, weights: Object.fromEntries(weights) } : probability;
  }
  return out;
}

/**
 * Animator components (the Underwater kraken that throws a train car): the controller's
 * states from its default one, following each state's first transition, baked into one
 * looping clip per Animator. Poses (one-frame clips) are held HOLD seconds; tracks are
 * sampled at 30 fps from Unity's Hermite curves, converted to glb space (X mirrored).
 * Returns [{ node, duration, tracks: [{ path, property, times, values }] }].
 */
function parseAnimators(file, guidIndex) {
  const HOLD = 1.5;
  const FPS = 30;
  const docs = yamlDocs(read(file));
  const names = new Map();
  for (const { doc, kind, fid } of docs) if (kind === '1') names.set(fid, doc.match(/m_Name: (.*)/)?.[1].trim() ?? '');
  const out = [];
  for (const { doc, kind } of docs) {
    if (kind !== '95') continue;
    const go = doc.match(/m_GameObject: \{fileID: (\d+)/)?.[1];
    const controller = guidIndex.get(doc.match(/m_Controller: \{[^}]*guid: (\w+)/)?.[1]);
    if (!names.has(go) || !controller || !existsSync(controller)) continue;
    const cdocs = new Map(yamlDocs(read(controller)).filter((d) => d.fid).map((d) => [d.fid, d]));
    // The default state's chain, then chains the game starts by script (a trigger plays
    // "attack", which leads on to "post"): states no transition leads to, in list order
    const states = [...cdocs.values()].filter((d) => d.kind === '1102');
    const next = (sdoc) => {
      const transition = sdoc.split('m_Transitions:')[1]?.match(/fileID: (\d+)/)?.[1];
      return transition && cdocs.get(transition)?.doc.match(/m_DstState: \{fileID: (\d+)/)?.[1];
    };
    const targets = new Set(states.map((d) => next(d.doc)).filter(Boolean));
    const defaultState = [...cdocs.values()].find((d) => d.kind === '1107')?.doc.match(/m_DefaultState: \{fileID: (\d+)/)?.[1];
    const sequence = [];
    for (const head of [defaultState, ...states.map((d) => d.fid).filter((f) => !targets.has(f))]) {
      for (let state = head; state && cdocs.has(state) && !sequence.some((st) => st.fid === state); state = next(cdocs.get(state).doc)) {
        const clip = guidIndex.get(cdocs.get(state).doc.match(/m_Motion: \{[^}]*guid: (\w+)/)?.[1]);
        sequence.push({ fid: state, clip });
      }
    }
    const tracks = new Map(); // path|property -> { times, values }
    let start = 0;
    for (const { clip } of sequence) {
      if (!clip || !existsSync(clip)) continue;
      const text = read(clip);
      const stop = Number(text.match(/m_StopTime: ([\d.eE+-]+)/)?.[1] ?? 0);
      const length = stop < 0.1 ? HOLD : stop;
      sampleClipTracks(text, stop, length, start, tracks, FPS);
      start += length;
    }
    if (tracks.size) out.push({ node: names.get(go), duration: round(start, 4), tracks: [...tracks.values()] });
  }
  // Legacy Animation components (3.70 Haunted Hood's sheep beamed up into the UFO): the game
  // plays them on a trigger or at spawn; here they loop, holding the last frame a moment.
  // Clips that sweep a trail are laid down by parseTrails instead.
  const trailed = new Set(parseTrails(file, guidIndex).map((t) => t.animation.node));
  for (const { doc, kind } of docs) {
    if (kind !== '111') continue;
    const go = doc.match(/m_GameObject: \{fileID: (\d+)/)?.[1];
    const clip = guidIndex.get(doc.match(/\n {2}m_Animation: \{[^}]*guid: (\w+)/)?.[1]);
    if (!names.has(go) || trailed.has(names.get(go)) || !clip || !existsSync(clip)) continue;
    const text = read(clip);
    const lastKey = Math.max(0, ...[...text.matchAll(/\n\s+time: ([\d.eE+-]+)/g)].map(([, t]) => Number(t)));
    const stop = Math.max(Number(text.match(/m_StopTime: ([\d.eE+-]+)/)?.[1] ?? 0), lastKey);
    if (stop <= 0) continue;
    const tracks = new Map();
    sampleClipTracks(text, stop, stop, 0, tracks, FPS);
    if (!tracks.size) continue;
    const looping = /m_LoopTime: 1/.test(text) || /m_WrapMode: 2/.test(doc);
    const duration = looping ? stop : stop + HOLD;
    for (const t of tracks.values()) {
      const n = t.values.length / t.times.length;
      t.times.push(round(duration, 4));
      t.values.push(...t.values.slice(-n));
    }
    out.push({ node: names.get(go), duration: round(duration, 4), tracks: [...tracks.values()] });
  }
  return out;
}

/**
 * Script-driven motion on scenery: RotationEffect (spin), OffsetEffect (bob), ScaleEffect
 * (pulse), RotateAndScaleTransform (sway / breathe: candle glows), MeshFlickering (on/off
 * pattern). Each names its node by path below the prefab root, "name#k" the k-th sibling
 * of that name, so identical copies (three candle glows) all move. glb space (X mirrored).
 */
function parseMotions(file, guidIndex) {
  const docs = yamlDocs(read(file));
  const names = new Map();
  const goOfTransform = new Map();
  const transformOf = new Map();
  const fatherOf = new Map();
  const childrenOf = new Map();
  const goOfComponent = new Map();
  for (const { doc, kind, fid } of docs) {
    if (kind === '1') names.set(fid, doc.match(/m_Name: (.*)/)?.[1].trim() ?? '');
    const go = doc.match(/m_GameObject: \{fileID: (\d+)/)?.[1];
    if (go) goOfComponent.set(fid, go);
    if (kind === '4' || kind === '224') {
      goOfTransform.set(fid, go);
      transformOf.set(go, fid);
      fatherOf.set(fid, doc.match(/m_Father: \{fileID: (\d+)/)?.[1]);
      childrenOf.set(fid, [...(doc.split('m_Children:')[1]?.split('m_Father')[0] ?? '').matchAll(/fileID: (\d+)/g)].map(([, t]) => t));
    }
  }
  const pathOf = (go) => {
    const parts = [];
    for (let t = transformOf.get(go); t && fatherOf.get(t) && fatherOf.get(t) !== '0'; t = fatherOf.get(t)) {
      const name = names.get(goOfTransform.get(t));
      const same = (childrenOf.get(fatherOf.get(t)) ?? []).filter((c) => names.get(goOfTransform.get(c)) === name);
      parts.unshift(`${name}#${Math.max(0, same.indexOf(t))}`);
    }
    return parts.join('/');
  };
  const vec = (doc, key) => {
    const m = doc.match(new RegExp(`${key}: \\{x: ([^,]+), y: ([^,]+), z: ([^}]+)\\}`));
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const num = (doc, key, fallback = 0) => Number(doc.match(new RegExp(`\\n\\s+${key}: ([\\d.eE+-]+)`))?.[1] ?? fallback);
  const axis = ([x, y, z]) => [x, -y, -z]; // rotation axes: as quaternions convert
  const out = [];
  for (const { doc } of docs) {
    if (!doc.startsWith('!u!114')) continue;
    const kind = stem(guidIndex.get(doc.match(/m_Script: .*guid: (\w+)/)?.[1]) ?? '');
    const go = doc.match(/m_GameObject: \{fileID: (\d+)/)?.[1];
    if (!names.has(go)) continue;
    let motion = null;
    let target = go;
    if (kind === 'RotationEffect') {
      const a = vec(doc, '_axis');
      if (a && num(doc, '_speed')) motion = { type: 'spin', axis: axis(a), speed: num(doc, '_speed') };
    } else if (kind === 'OffsetEffect') {
      const d = vec(doc, '_direction');
      if (d) motion = { type: 'offset', direction: [-d[0], d[1], d[2]], frequency: num(doc, '_frequency', 2) };
    } else if (kind === 'ScaleEffect') {
      motion = {
        type: 'scale',
        additive: num(doc, '_additiveScale') === 1,
        offset: num(doc, '_amplitudeOffset'),
        amount: ['X', 'Y', 'Z'].map((c) => (num(doc, `_scaleIn${c}`) === 1 ? num(doc, `_scaleAmount${c}`) : 0)),
        frequency: num(doc, '_frequency', 2),
      };
    } else if (kind === 'RotateAndScaleTransform') {
      target = goOfTransform.get(doc.match(/_transform: \{fileID: (\d+)/)?.[1]) ?? go;
      motion = { type: 'sway' };
      if (num(doc, '_enableRotation') === 1) motion.rotation = { axis: axis(vec(doc, '_rotationAxis') ?? [0, 1, 0]), min: num(doc, '_minRotationRange'), max: num(doc, '_maxRotationRange'), speed: num(doc, '_rotationSpeed') };
      if (num(doc, '_enableScaling') === 1) motion.scale = { axis: (vec(doc, '_scaleAxis') ?? [0, 1, 0]).map(Math.abs), min: num(doc, '_minScale', 1), max: num(doc, '_maxScale', 1), speed: num(doc, '_scaleSpeed') };
      if (!motion.rotation && !motion.scale) motion = null;
    } else if (kind === 'MeshFlickering') {
      target = goOfComponent.get(doc.match(/_Mesh: \{fileID: (\d+)/)?.[1]) ?? go;
      const pattern = doc.match(/_FlickerPattern: (.*)/)?.[1].trim().replace(/^'|'$/g, '');
      if (pattern) motion = { type: 'flicker', speed: num(doc, '_FlickerSpeed', 1), pattern };
    }
    if (motion && names.has(target)) out.push({ path: pathOf(target), node: names.get(target), ...motion });
  }
  return out;
}

/**
 * Samples a clip's transform curves (Unity Hermite) at `fps` into `tracks`
 * (path|property -> { path, property, times, values }), in glb space, from `start` seconds.
 */
function sampleClipTracks(text, stop, length, start, tracks, fps = 30) {
  const frames = Math.max(1, Math.round(length * fps));
  for (const [section, property] of [['m_RotationCurves', 'quaternion'], ['m_PositionCurves', 'position'], ['m_ScaleCurves', 'scale']]) {
    const block = text.split(`\n  ${section}:`)[1]?.split(/\n  \w/)[0] ?? '';
    for (const item of block.split('\n  - curve:').slice(1)) {
      const curvePath = item.match(/\n\s+path: (.*)/)?.[1].trim() ?? '';
      const n = property === 'quaternion' ? 4 : 3;
      const vec = (s) => {
        const v = ['x', 'y', 'z', 'w'].slice(0, n).map((c) => Number(s.match(new RegExp(`${c}: ([^,}]+)`))?.[1]));
        return v;
      };
      const keys = [...item.matchAll(/time: ([^\n]+)\n\s+value: (\{[^}]*\})\n\s+inSlope: (\{[^}]*\})\n\s+outSlope: (\{[^}]*\})/g)].map(([, t, v, i, o]) => ({ t: Number(t), v: vec(v), i: vec(i), o: vec(o) }));
      if (!keys.length) continue;
      const at = (time) => {
        if (time <= keys[0].t) return keys[0].v;
        const k = keys.findIndex((key) => key.t >= time);
        if (k < 0) return keys[keys.length - 1].v;
        const a = keys[k - 1];
        const b = keys[k];
        const dt = b.t - a.t;
        const u = (time - a.t) / dt;
        const [h00, h10, h01, h11] = [2 * u ** 3 - 3 * u ** 2 + 1, u ** 3 - 2 * u ** 2 + u, -2 * u ** 3 + 3 * u ** 2, u ** 3 - u ** 2];
        // Infinite tangents are steps
        return a.v.map((av, c) => (!Number.isFinite(a.o[c]) || !Number.isFinite(b.i[c]) ? av : h00 * av + h10 * dt * a.o[c] + h01 * b.v[c] + h11 * dt * b.i[c]));
      };
      const key = `${curvePath}|${property}`;
      if (!tracks.has(key)) tracks.set(key, { path: curvePath, property, times: [], values: [] });
      const track = tracks.get(key);
      for (let f = 0; f <= frames; f++) {
        const v = at(Math.min((f / frames) * stop, stop));
        // Unity -> glb: X mirrored (position -x; rotation x, -y, -z, w)
        const g = property === 'position' ? [-v[0], v[1], v[2]] : property === 'quaternion' ? [v[0], -v[1], -v[2], v[3]] : v;
        track.times.push(round(start + (f / frames) * length, 4));
        track.values.push(...g.map((x) => round(x, 5)));
      }
    }
  }
  // Rotation keyed as Euler angles (degrees, Unity's Z, X, Y order): converted per frame to
  // quaternions, unless the clip also has the quaternion curve for that path
  const eulerBlock = text.split('\n  m_EulerCurves:')[1]?.split(/\n  \w/)[0] ?? '';
  for (const item of eulerBlock.split('\n  - curve:').slice(1)) {
    const curvePath = item.match(/\n\s+path: (.*)/)?.[1].trim() ?? '';
    const key = `${curvePath}|quaternion`;
    if (tracks.has(key)) continue;
    const vec = (str) => ['x', 'y', 'z'].map((c) => Number(str.match(new RegExp(`${c}: ([^,}]+)`))?.[1]));
    const keys = [...item.matchAll(/time: ([^\n]+)\n\s+value: (\{[^}]*\})\n\s+inSlope: (\{[^}]*\})\n\s+outSlope: (\{[^}]*\})/g)].map(([, t, v, i, o]) => ({ t: Number(t), v: vec(v), i: vec(i), o: vec(o) }));
    if (!keys.length) continue;
    const at = (time) => {
      if (time <= keys[0].t) return keys[0].v;
      const k = keys.findIndex((kk) => kk.t >= time);
      if (k < 0) return keys[keys.length - 1].v;
      const a = keys[k - 1];
      const b = keys[k];
      const dt = b.t - a.t;
      const u = (time - a.t) / dt;
      return a.v.map((av, c) => (!Number.isFinite(a.o[c]) || !Number.isFinite(b.i[c]) ? av : (2 * u ** 3 - 3 * u ** 2 + 1) * av + (u ** 3 - 2 * u ** 2 + u) * dt * a.o[c] + (-2 * u ** 3 + 3 * u ** 2) * b.v[c] + (u ** 3 - u ** 2) * dt * b.i[c]));
    };
    const track = { path: curvePath, property: 'quaternion', times: [], values: [] };
    tracks.set(key, track);
    for (let f = 0; f <= frames; f++) {
      const [ex, ey, ez] = at(Math.min((f / frames) * stop, stop)).map((d) => (d * Math.PI) / 360); // half angles
      const qx = [Math.sin(ex), 0, 0, Math.cos(ex)];
      const qy = [0, Math.sin(ey), 0, Math.cos(ey)];
      const qz = [0, 0, Math.sin(ez), Math.cos(ez)];
      const mul = ([ax, ay, az, aw], [bx, by, bz, bw]) => [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
      const q = mul(mul(qy, qx), qz); // Unity: Z first, then X, then Y
      track.times.push(round(start + (f / frames) * length, 4));
      track.values.push(...[q[0], -q[1], -q[2], q[3]].map((x) => round(x, 5))); // X mirrored, as above
    }
  }
  // Blend shape weights (SkinnedMeshRenderer "blendShape.<name>", 0-100) -> morph influences
  const floats = text.split('\n  m_FloatCurves:')[1]?.split(/\n  \w/)[0] ?? '';
  for (const item of floats.split('\n  - serializedVersion: 2').slice(1)) {
    const name = item.match(/\n\s+attribute: blendShape\.(.*)/)?.[1].trim();
    if (!name || !/\n\s+classID: 137\b/.test(item)) continue;
    const curvePath = item.match(/\n\s+path: (.*)/)?.[1].trim() ?? '';
    const keys = [...item.matchAll(/time: ([^\n]+)\n\s+value: ([^\n]+)\n\s+inSlope: ([^\n]+)\n\s+outSlope: ([^\n]+)/g)].map(([, t, v, i, o]) => ({ t: Number(t), v: Number(v), i: Number(i), o: Number(o) }));
    if (!keys.length) continue;
    const at = (time) => {
      if (time <= keys[0].t) return keys[0].v;
      const k = keys.findIndex((key) => key.t >= time);
      if (k < 0) return keys[keys.length - 1].v;
      const a = keys[k - 1];
      const b = keys[k];
      const dt = b.t - a.t;
      const u = (time - a.t) / dt;
      if (!Number.isFinite(a.o) || !Number.isFinite(b.i)) return a.v;
      return (2 * u ** 3 - 3 * u ** 2 + 1) * a.v + (u ** 3 - 2 * u ** 2 + u) * dt * a.o + (-2 * u ** 3 + 3 * u ** 2) * b.v + (u ** 3 - u ** 2) * dt * b.i;
    };
    const key = `${curvePath}|morph|${name}`;
    if (!tracks.has(key)) tracks.set(key, { path: curvePath, property: 'morph', name, times: [], values: [] });
    const track = tracks.get(key);
    for (let f = 0; f <= frames; f++) {
      track.times.push(round(start + (f / frames) * length, 4));
      track.values.push(round(at(Math.min((f / frames) * stop, stop)) / 100, 5));
    }
  }
}

/**
 * TrailRenderers swept by a legacy Animation clip (3.60 Ireland: the rainbow drawn over the
 * sea when the player passes). Returns [{ node, material, width, animation: { node,
 * duration, tracks } }] so the viewer can lay the finished trail down as a ribbon.
 */
function parseTrails(file, guidIndex) {
  const docs = yamlDocs(read(file));
  const names = new Map();
  const transformOf = new Map(); // GameObject -> its Transform
  const goOf = new Map(); // Transform -> GameObject
  const fatherOf = new Map(); // Transform -> parent Transform
  const clipOf = new Map(); // GameObject -> legacy clip file
  for (const { doc, kind, fid } of docs) {
    const go = doc.match(/m_GameObject: \{fileID: (\d+)/)?.[1];
    if (kind === '1') names.set(fid, doc.match(/m_Name: (.*)/)?.[1].trim() ?? '');
    if (kind === '4') {
      transformOf.set(go, fid);
      goOf.set(fid, go);
      fatherOf.set(fid, doc.match(/m_Father: \{fileID: (\d+)/)?.[1]);
    }
    if (kind === '111') {
      const clip = guidIndex.get(doc.match(/\n {2}m_Animation: \{[^}]*guid: (\w+)/)?.[1]);
      if (clip && existsSync(clip)) clipOf.set(go, clip);
    }
  }
  const out = [];
  for (const { doc, kind } of docs) {
    if (kind !== '96') continue;
    const go = doc.match(/m_GameObject: \{fileID: (\d+)/)?.[1];
    let animated = null;
    for (let t = transformOf.get(go); t && t !== '0' && !animated; t = fatherOf.get(t)) if (clipOf.has(goOf.get(t))) animated = goOf.get(t);
    const material = guidIndex.get(doc.match(/m_Materials:\n\s+- \{fileID: \d+, guid: (\w+)/)?.[1]);
    if (!animated || !material) continue; // a still trail draws nothing
    const text = read(clipOf.get(animated));
    const lastKey = Math.max(0, ...[...text.matchAll(/\n\s+time: ([\d.eE+-]+)/g)].map(([, t]) => Number(t)));
    const stop = Math.max(Number(text.match(/m_StopTime: ([\d.eE+-]+)/)?.[1] ?? 0), lastKey);
    const tracks = new Map();
    sampleClipTracks(text, stop, stop, 0, tracks);
    if (!tracks.size) continue;
    const width = Number(doc.match(/widthMultiplier: ([\d.eE+-]+)/)?.[1] ?? 1) * Number(doc.match(/widthCurve:\n\s+m_Curve:\n(?:.*\n)*?\s+value: ([\d.eE+-]+)/)?.[1] ?? 1);
    out.push({ node: names.get(go), material: stem(material), width: round(width, 4), animation: { node: names.get(animated), duration: round(stop, 4), tracks: [...tracks.values()] } });
  }
  return out;
}

/**
 * SkinnedMeshRenderers: the prefab glb leaves skinned meshes out (the kraken's arm), and
 * the mesh's own glb has positions, UVs, joints and weights but no skin. Returns what the
 * viewer needs to rebuild it: [{ node, mesh (glb name), bones: [GameObject names],
 * bindPoses: [16 floats, column-major, glb space], materials: [names] }].
 */
function parseSkinnedMeshes(file, guidIndex) {
  const docs = yamlDocs(read(file));
  const names = new Map();
  const goOfTransform = new Map();
  const fatherOf = new Map();
  for (const { doc, kind, fid } of docs) {
    if (kind === '1') names.set(fid, doc.match(/m_Name: (.*)/)?.[1].trim() ?? '');
    if (kind === '4') {
      goOfTransform.set(fid, doc.match(/m_GameObject: \{fileID: (\d+)/)?.[1]);
      fatherOf.set(fid, doc.match(/m_Father: \{fileID: (\d+)/)?.[1]);
    }
  }
  // Path below the prefab root: rigs with the same bone names (3.62 Sakura Tokyo's dino and
  // robot) are told apart by their parents
  const pathOf = (fid) => {
    const parts = [];
    for (let t = fid; t && t !== '0' && fatherOf.get(t) !== '0'; t = fatherOf.get(t)) parts.unshift(names.get(goOfTransform.get(t)));
    return parts.join('/');
  };
  const out = [];
  for (const { doc, kind } of docs) {
    if (kind !== '137') continue;
    const go = doc.match(/m_GameObject: \{fileID: (\d+)/)?.[1];
    const meshFile = guidIndex.get(doc.match(/\n {2}m_Mesh: \{[^}]*guid: (\w+)/)?.[1]);
    if (!names.has(go) || !meshFile || !existsSync(meshFile)) continue;
    const list = (key) => [...(doc.split(`\n  ${key}:`)[1]?.split(/\n  \w/)[0] ?? '').matchAll(/- \{fileID: (\d+)(?:, guid: (\w+))?/g)];
    const bones = list('m_Bones').map(([, fid]) => names.get(goOfTransform.get(fid)) ?? null);
    const bonePaths = list('m_Bones').map(([, fid]) => pathOf(fid));
    const materials = list('m_Materials').map(([, , guid]) => guidIndex.get(guid)).filter(Boolean).map((p) => stem(p));
    // Bind poses (row-major eRC) mirrored on X like the glb: entries in row 0 or column 0
    // (not both) change sign; stored column-major for THREE.Matrix4.fromArray
    const mesh = read(meshFile);
    const poses = (mesh.split('\n  m_BindPose:')[1]?.split(/\n  \w/)[0] ?? '').split('\n  - ').slice(1).map((m) => {
      const e = (r, c) => Number(m.match(new RegExp(`e${r}${c}: ([^\\n]+)`))?.[1] ?? (r === c ? 1 : 0));
      const col = [];
      for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) col.push(round(((r === 0) !== (c === 0) ? -1 : 1) * e(r, c), 6));
      return col;
    });
    if (!bones.length || bones.includes(null) || poses.length !== bones.length) continue;
    out.push({ node: names.get(go), mesh: stem(meshFile), bones, bonePaths, bindPoses: poses, materials });
  }
  return out;
}

/** MeshAnimation components (water ripples, fire, wing flaps): mesh flipbooks.
 *
 * GameObject name -> { frames: [mesh names], duration: [min, max], loop, randomStart, delay }.
 * The glb export only holds the first frame. */
function parseMeshAnimations(file, guidIndex) {
  const docs = yamlDocs(read(file));
  const names = new Map();
  for (const { doc, kind, fid } of docs) {
    if (kind === '1') names.set(fid, doc.match(/m_Name: (.*)/)?.[1].trim() ?? '');
  }
  const out = {};
  for (const { doc } of docs) {
    if (!doc.startsWith('!u!114') || !/\n {2}_meshes:/.test(doc) || !/_durationMin:/.test(doc)) continue;
    const go = doc.match(/m_GameObject: \{fileID: (\d+)/);
    const block = doc.match(/\n {2}_meshes:\n((?: {2}- .*\n)+)/);
    if (!go || !names.has(go[1]) || !block) continue;
    const frames = [...block[1].matchAll(GUID_RE_G)].map(([, g]) => guidIndex.get(g)).filter(Boolean).map((p) => stem(p));
    if (frames.length < 2) continue;
    const field = (key, fallback) => {
      const m = doc.match(new RegExp(`\\n {2}${key}: ([\\d.e-]+)`));
      return m ? num(m[1]) : fallback;
    };
    out[names.get(go[1])] = {
      frames,
      duration: [field('_durationMin', 1), field('_durationMax', 1)],
      loop: field('_looping', 1) !== 0,
      randomStart: field('_randomStart', 0) !== 0,
      delay: field('_startDelay', 0),
    };
  }
  return out;
}

/** 1.x placeholders: empty nodes the game fills at runtime with one prefab from a list
 * (Placeholder + MultiplePlaceholderPrefabProvider): tube sides, water ripples, props.
 *
 * GameObject name -> { prefabs: [{ name, weight }], probability, all }. */
function parsePlaceholders(file, guidIndex) {
  const docs = yamlDocs(read(file));
  const names = new Map();
  for (const { doc, kind, fid } of docs) {
    if (kind === '1') names.set(fid, doc.match(/m_Name: (.*)/)?.[1].trim() ?? '');
  }
  const byGo = new Map();
  for (const { doc } of docs) {
    if (!doc.startsWith('!u!114')) continue;
    const go = doc.match(/m_GameObject: \{fileID: (\d+)/)?.[1];
    if (!go || !names.has(go)) continue;
    const entry = byGo.get(go) ?? { prefabs: [], probability: 1, all: false };
    const list = doc.match(/\n {2}_prefabList:\n((?: {2}[- ] .*\n?)+)/);
    if (list) {
      for (const [, g, w] of list[1].matchAll(/Target: \{fileID: \d+, guid: (\w+)[^\n]*\n\s*Weight: ([\d.e-]+)/g)) {
        if (guidIndex.has(g)) entry.prefabs.push({ name: stem(guidIndex.get(g)), weight: num(w) });
      }
      entry.all = /\n {2}_spawnAll: 1/.test(doc);
    }
    const prob = doc.match(/\n {2}_spawnProbability: ([\d.e-]+)/);
    if (prob) entry.probability = num(prob[1]);
    byGo.set(go, entry);
  }
  const out = {};
  for (const [go, entry] of byGo) if (entry.prefabs.length) out[names.get(go)] = entry;
  return out;
}

/** 1.x EffectPlayer: shows its effect children one after the other (water ripples, wings).
 *
 * GameObject name -> { children: [names in order], duration, loop, randomStart }. */
function parseEffectPlayers(file) {
  const docs = yamlDocs(read(file));
  const names = new Map();
  for (const { doc, kind, fid } of docs) {
    if (kind === '1') names.set(fid, doc.match(/m_Name: (.*)/)?.[1].trim() ?? '');
  }
  const out = {};
  for (const { doc } of docs) {
    if (!doc.startsWith('!u!114') || !/\n {2}_effectList:/.test(doc)) continue;
    const go = doc.match(/m_GameObject: \{fileID: (\d+)/)?.[1];
    const list = doc.match(/\n {2}_effectList:\n((?: {2}- .*\n)+)/);
    if (!go || !names.has(go) || !list) continue;
    const children = [...list[1].matchAll(/fileID: (\d+)/g)].map(([, id]) => names.get(id)).filter(Boolean);
    const field = (key, fallback) => {
      const m = doc.match(new RegExp(`\\n {2}${key}: ([\\d.e-]+)`));
      return m ? num(m[1]) : fallback;
    };
    if (children.length > 1) {
      out[names.get(go)] = {
        children,
        duration: field('_duration', 1),
        maxDuration: field('_maxDuration', 0),
        loop: field('_doLoop', 1) !== 0,
        randomStart: field('_doRandomizeStartingIndex', 0) !== 0,
      };
    }
  }
  return out;
}

// ---------------------------------------------------------------- classic (≤ 1.43)
//
// The first games have no themes at all: the level is a library of hand-built chunks in
// the main scene (Level/Chunks/<difficulty>/<chunk>), each a complete stretch of run with
// its ground, trains and obstacles. Scripts pick variants at runtime (Randomizer: one
// child; RandomizerHold: the road's look, held over 3000 units; Mirror: flip left/right;
// RandomizeOffset: a random lane). Each chunk is cut out of the scene glb into its own
// glb, those behaviors stored as glTF node extras for the viewer.

/** Reads a glb into { json, bin }. */
function readGlb(file) {
  const data = readFileSync(file);
  const jsonLen = data.readUInt32LE(12);
  const json = JSON.parse(data.toString('utf8', 20, 20 + jsonLen));
  const binStart = 20 + jsonLen + 8;
  if (data.length < binStart) return { json, bin: Buffer.alloc(0) }; // no binary chunk
  return { json, bin: data.subarray(binStart, binStart + data.readUInt32LE(20 + jsonLen)) };
}

/** A glb of one node's subtree (root reset to the origin), with node extras and renames; no textures. */
function glbSubset({ json, bin }, rootIdx, extras, rename = new Map(), skip = new Set(), geometryFor = () => null) {
  const nodes = [];
  const nodeMap = new Map();
  const meshMap = new Map();
  const matMap = new Map();
  const accMap = new Map();
  const meshes = [];
  const materials = [];
  const accessors = [];
  const bufferViews = [];
  const chunks = [];
  let offset = 0;
  const byContent = new Map(); // identical data (the scene repeats meshes per instance) stored once
  const addAccessor = (ai) => {
    if (accMap.has(ai)) return accMap.get(ai);
    const a = json.accessors[ai];
    const bv = json.bufferViews[a.bufferView];
    const size = { 5126: 4, 5125: 4, 5123: 2, 5122: 2, 5121: 1, 5120: 1 }[a.componentType];
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[a.type];
    const elem = size * n;
    const stride = bv.byteStride ?? elem;
    const start = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    // De-interleaved: only this accessor's bytes (position/normal/uv share one view)
    const length = a.count * elem;
    const bytes = Buffer.alloc(length);
    if (stride === elem) bin.copy(bytes, 0, start, start + length);
    else for (let i = 0; i < a.count; i++) bin.copy(bytes, i * elem, start + i * stride, start + i * stride + elem);
    const key = `${a.componentType}:${a.type}:${a.count}:${a.normalized ? 1 : 0}:${createHash('sha1').update(bytes).digest('hex')}`;
    if (byContent.has(key)) {
      accMap.set(ai, byContent.get(key));
      return byContent.get(key);
    }
    const pad = (4 - (offset % 4)) % 4;
    if (pad) chunks.push(Buffer.alloc(pad));
    offset += pad;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: length, ...(bv.target ? { target: bv.target } : {}) });
    chunks.push(bytes);
    offset += length;
    const { bufferView, byteOffset, ...rest } = a;
    accessors.push({ ...rest, bufferView: bufferViews.length - 1 });
    accMap.set(ai, accessors.length - 1);
    byContent.set(key, accessors.length - 1);
    return accessors.length - 1;
  };
  const addMaterial = (mi) => {
    if (mi == null) return undefined;
    if (!matMap.has(mi)) {
      materials.push({ name: json.materials[mi].name ?? `material_${mi}` });
      matMap.set(mi, materials.length - 1);
    }
    return matMap.get(mi);
  };
  // New accessor from a typed array (geometry rebuilt from the mesh assets)
  const addArray = (data, type, target) => {
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const key = `new:${type}:${createHash('sha1').update(bytes).digest('hex')}`;
    if (byContent.has(key)) return byContent.get(key);
    const pad = (4 - (offset % 4)) % 4;
    if (pad) chunks.push(Buffer.alloc(pad));
    offset += pad;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
    chunks.push(Buffer.from(bytes));
    offset += bytes.length;
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3 }[type];
    const acc = { bufferView: bufferViews.length - 1, componentType: data instanceof Uint32Array ? 5125 : 5126, count: data.length / n, type };
    if (type === 'VEC3') {
      acc.min = [0, 1, 2].map((c) => Math.min(...data.filter((_, i) => i % 3 === c)));
      acc.max = [0, 1, 2].map((c) => Math.max(...data.filter((_, i) => i % 3 === c)));
    }
    accessors.push(acc);
    byContent.set(key, accessors.length - 1);
    return accessors.length - 1;
  };
  const readPositions = (ai) => {
    const a = json.accessors[ai];
    const bv = json.bufferViews[a.bufferView];
    const stride = bv.byteStride ?? 12;
    const start = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const out = new Float32Array(a.count * 3);
    for (let i = 0; i < a.count; i++) for (let c = 0; c < 3; c++) out[i * 3 + c] = bin.readFloatLE(start + i * stride + c * 4);
    return out;
  };
  const addMesh = (mi) => {
    if (meshMap.has(mi)) return meshMap.get(mi);
    const m = json.meshes[mi];
    meshes.push({
      name: m.name,
      primitives: m.primitives.map((p, pi) => {
        const material = p.material != null ? { material: addMaterial(p.material) } : {};
        // Primitives rebuilt whole from a mesh asset: ones without UVs (Unity 3.5 exports) and
        // swapped meshes (the classic shaders are unlit, so the dropped normals aren't missed)
        const geo = (p.mode ?? 4) === 4 ? geometryFor(mi, pi, () => readPositions(p.attributes.POSITION), p.attributes.TEXCOORD_0 != null) : null;
        if (geo) {
          return {
            attributes: { POSITION: addArray(geo.positions, 'VEC3', 34962), TEXCOORD_0: addArray(geo.uvs, 'VEC2', 34962) },
            indices: addArray(geo.indices, 'SCALAR', 34963),
            ...material,
          };
        }
        return {
          attributes: Object.fromEntries(Object.entries(p.attributes).map(([k, v]) => [k, addAccessor(v)])),
          ...(p.indices != null ? { indices: addAccessor(p.indices) } : {}),
          ...material,
          ...(p.mode != null ? { mode: p.mode } : {}),
        };
      }),
    });
    meshMap.set(mi, meshes.length - 1);
    return meshes.length - 1;
  };
  const addNode = (ni, isRoot) => {
    const n = json.nodes[ni];
    const out = { name: rename.get(ni) ?? n.name };
    nodes.push(out);
    nodeMap.set(ni, nodes.length - 1);
    if (!isRoot) for (const k of ['translation', 'rotation', 'scale']) if (n[k]) out[k] = n[k];
    if (n.mesh != null) out.mesh = addMesh(n.mesh);
    if (extras.has(ni)) out.extras = extras.get(ni);
    const kids = (n.children ?? []).filter((c) => !skip.has(c));
    if (kids.length) out.children = kids.map((c) => addNode(c, false));
    return nodeMap.get(ni);
  };
  addNode(rootIdx, true);
  const binOut = Buffer.concat(chunks);
  const gltf = { asset: { version: '2.0', generator: 'subway-assets-renderer classic chunk' }, scene: 0, scenes: [{ nodes: [0] }], nodes, meshes, materials, accessors, bufferViews, buffers: [{ byteLength: binOut.length }] };
  const jsonBuf = Buffer.from(JSON.stringify(gltf));
  const jsonPad = Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20);
  const binPad = Buffer.alloc((4 - (binOut.length % 4)) % 4);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  const jsonHead = Buffer.alloc(8);
  jsonHead.writeUInt32LE(jsonBuf.length + jsonPad.length, 0);
  jsonHead.writeUInt32LE(0x4e4f534a, 4);
  const binHead = Buffer.alloc(8);
  binHead.writeUInt32LE(binOut.length + binPad.length, 0);
  binHead.writeUInt32LE(0x004e4942, 4);
  const total = 12 + 8 + jsonBuf.length + jsonPad.length + 8 + binOut.length + binPad.length;
  header.writeUInt32LE(total, 8);
  return Buffer.concat([header, jsonHead, jsonBuf, jsonPad, binHead, binOut, binPad]);
}

// Coins and pickups (with their glows: hide the whole coin, "coin moving" in 1.10)
const CHANNEL_SIZES_35 = [12, 12, 4, 8, 8, 16]; // vertex, normal, color, uv0, uv1, tangent

/**
 * A Unity 3.5 mesh asset's vertices (positions, UVs) and per-submesh triangles. Submeshes
 * are mostly triangle strips there (topology 2); Unity's strips alternate winding and use
 * repeated indices as joins.
 */
function meshAsset(file) {
  const text = read(file);
  const count = Number(text.match(/\n {4}m_VertexCount: (\d+)/)?.[1] ?? 0);
  const hex = text.match(/_typelessdata: ([0-9a-f]+)/)?.[1];
  if (!count || !hex) return null;
  const data = Buffer.from(hex, 'hex');
  const streams = [...text.matchAll(/m_Streams\[\d\]:\n\s+channelMask: (\d+)\n\s+offset: (\d+)\n\s+stride: (\d+)/g)].map(([, mask, off, stride]) => ({ mask: Number(mask), offset: Number(off), stride: Number(stride) }));
  const locate = (channel) => {
    for (const st of streams) {
      if (!(st.mask & (1 << channel))) continue;
      let at = 0;
      for (let c = 0; c < channel; c++) if (st.mask & (1 << c)) at += CHANNEL_SIZES_35[c];
      return { base: st.offset + at, stride: st.stride };
    }
    return null;
  };
  const pos = locate(0);
  const uv = locate(3);
  if (!pos || !uv) return null;
  const positions = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < 3; c++) positions[i * 3 + c] = data.readFloatLE(pos.base + i * pos.stride + c * 4);
    uvs[i * 2] = data.readFloatLE(uv.base + i * uv.stride);
    uvs[i * 2 + 1] = 1 - data.readFloatLE(uv.base + i * uv.stride + 4); // glTF V points down
  }
  const indexBuffer = Buffer.from(text.match(/\n {2}m_IndexBuffer: ([0-9a-f]*)/)?.[1] ?? '', 'hex');
  const submeshes = [...text.matchAll(/- firstByte: (\d+)\n\s+indexCount: (\d+)\n\s+isTriStrip: (\d+)/g)].map(([, first, n, topology]) => {
    const idx = [];
    for (let i = 0; i < Number(n); i++) idx.push(indexBuffer.readUInt16LE(Number(first) + i * 2));
    if (topology === '0') return idx;
    const tris = [];
    for (let i = 0; i + 2 < idx.length; i++) {
      const [a, b, c] = [idx[i], idx[i + 1], idx[i + 2]];
      if (a === b || b === c || a === c) continue;
      if (i % 2) tris.push(b, a, c);
      else tris.push(a, b, c);
    }
    return tris;
  });
  return { positions, uvs, submeshes };
}

/**
 * A glb primitive rebuilt from its submesh in the mesh asset: the glb export welded seam
 * vertices (no UVs to tell them apart), so the asset's own vertices replace them. X is
 * mirrored like the export does, which flips the winding. Null when the submesh doesn't hold the
 * primitive's vertices (unless positions is null: a different mesh, swapped in).
 */
function submeshGeometry(asset, sub, positions) {
  const tris = asset.submeshes[sub];
  if (!tris?.length) return null;
  const key = (x, y, z) => `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;
  const remap = new Map();
  const used = [];
  const indices = new Uint32Array(tris.length);
  tris.forEach((v, i) => {
    if (v * 3 >= asset.positions.length) return;
    if (!remap.has(v)) remap.set(v, used.push(v) - 1);
    indices[i - (i % 3) + [0, 2, 1][i % 3]] = remap.get(v); // mirrored, so the winding flips
  });
  if (positions) {
    const keys = new Set(used.map((v) => key(asset.positions[v * 3], asset.positions[v * 3 + 1], asset.positions[v * 3 + 2])));
    let found = 0;
    for (let i = 0; i < positions.length / 3; i++) if (keys.has(key(-positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]))) found++;
    if (found < (positions.length / 3) * 0.9) return null;
  }
  const outPos = new Float32Array(used.length * 3);
  const outUV = new Float32Array(used.length * 2);
  used.forEach((v, i) => {
    outPos[i * 3] = -asset.positions[v * 3];
    outPos[i * 3 + 1] = asset.positions[v * 3 + 1];
    outPos[i * 3 + 2] = asset.positions[v * 3 + 2];
    outUV[i * 2] = asset.uvs[v * 2];
    outUV[i * 2 + 1] = asset.uvs[v * 2 + 1];
  });
  return { positions: outPos, uvs: outUV, indices };
}

const CLASSIC_HIDE = /^(coins?( moving)?|random_coins|randomPickup|SpawnPoint|MissionTrigger|easterEgg)$/i;

/** Finds the classic level (Level/Chunks) in a scene export; returns chunk glbs to write. */
function parseClassic(root, project, guidIndex, log) {
  const sceneDir = path.join(root, 'Files', 'Assets', 'SceneHierarchyObject');
  for (const glbFile of listDir(sceneDir).filter((p) => p.endsWith('.glb'))) {
    const glb = readGlb(glbFile);
    const { json } = glb;
    const level = json.nodes.findIndex((n) => n.name === 'Level' && n.children?.some((c) => json.nodes[c].name === 'Chunks'));
    if (level < 0) continue;
    const sceneFile = path.join(project, 'Scenes', `${stem(glbFile)}.unity`);
    if (!existsSync(sceneFile)) continue;
    log(`Classic level in ${path.basename(sceneFile)}`);

    // Scene objects: names, components, transform tree
    const scripts = new Map();
    for (const [g, p] of guidIndex) if (p.endsWith('.cs')) scripts.set(g, stem(p));
    const docs = yamlDocs(read(sceneFile));
    const goName = new Map();
    const goComps = new Map(); // go -> [{ script, doc }]
    const goTransform = new Map();
    const transformGo = new Map();
    const transformChildren = new Map();
    const goMeshAsset = new Map(); // go -> mesh asset file (MeshFilter)
    for (const { doc, kind, fid } of docs) {
      if (kind === '1') goName.set(fid, doc.match(/m_Name: (.*)/)?.[1].trim() ?? '');
      else if (kind === '4' || kind === '224') {
        const go = doc.match(/m_GameObject: \{fileID: (\d+)/)?.[1];
        goTransform.set(go, fid);
        transformGo.set(fid, go);
        const kids = doc.split('m_Children:')[1]?.split(/\n {2}m_Father/)[0] ?? '';
        transformChildren.set(fid, [...kids.matchAll(/fileID: (\d+)/g)].map(([, id]) => id));
      } else if (kind === '33') {
        const go = doc.match(/m_GameObject: \{fileID: (\d+)/)?.[1];
        const g = doc.match(/m_Mesh: \{fileID: \d+, guid: (\w+)/)?.[1];
        if (go && g && guidIndex.has(g)) goMeshAsset.set(go, guidIndex.get(g));
      } else if (kind === '114') {
        const go = doc.match(/m_GameObject: \{fileID: (\d+)/)?.[1];
        const script = scripts.get(doc.match(/m_Script: .*guid: (\w+)/)?.[1]) ?? '';
        if (!goComps.has(go)) goComps.set(go, []);
        goComps.get(go).push({ script, doc });
      }
    }
    // Pair scene objects with glb nodes: same child order, checked by name
    const nodeOfGo = new Map();
    const pair = (ni, go) => {
      nodeOfGo.set(go, ni);
      const kidsT = transformChildren.get(goTransform.get(go)) ?? [];
      const kidsN = json.nodes[ni].children ?? [];
      kidsT.forEach((t, k) => {
        const cgo = transformGo.get(t);
        const name = goName.get(cgo);
        const ci = json.nodes[kidsN[k]]?.name === name ? kidsN[k] : kidsN.find((c) => json.nodes[c].name === name && ![...nodeOfGo.values()].includes(c));
        if (ci != null) pair(ci, cgo);
      });
    };
    const levelGo = [...goName].find(([go, n]) => n === 'Level' && (transformChildren.get(goTransform.get(go)) ?? []).some((t) => goName.get(transformGo.get(t)) === 'Chunks'))?.[0];
    if (!levelGo) continue;
    pair(level, levelGo);

    // Node behaviors as extras
    const extras = new Map();
    const field = (doc, key) => doc.match(new RegExp(`\\n {2}${key}: ([^\\n]+)`))?.[1].trim();
    for (const [go, ni] of nodeOfGo) {
      const out = {};
      const name = goName.get(go);
      for (const { script, doc } of goComps.get(go) ?? []) {
        if (script === 'Randomizer') out.pick = 'random';
        else if (script === 'RandomizerHold') {
          const kidsT = transformChildren.get(goTransform.get(go)) ?? [];
          const order = [...(doc.split('\n  children:')[1] ?? '').matchAll(/fileID: (\d+)/g)].map(([, id]) => kidsT.indexOf(goTransform.get(id)));
          out.pick = 'hold';
          out.hold = order;
        } else if (script === 'Mirror') out.mirror = true;
        else if (script === 'RandomizeOffset') {
          const lanes = [];
          if (field(doc, '  left') !== '0') lanes.push(-20);
          if (field(doc, '  mid') !== '0') lanes.push(0);
          if (field(doc, '  right') !== '0') lanes.push(20);
          if (lanes.length) out.lanes = lanes;
        } else if (script === 'MovingTrain') out.moving = Number(field(doc, 'speed') ?? 1);
        else if (script === 'CoinPlaceholder' || script === 'Coin') out.hide = true;
      }
      if (CLASSIC_HIDE.test(name)) out.hide = true;
      if (/^trains?_|^random_trainType$|^train_ramp$/i.test(name)) out.layer = 'train';
      else if (/^blocker$|^lightSignal$|^powerbox/i.test(name)) out.layer = 'obstacle';
      if (Object.keys(out).length) extras.set(ni, out);
    }

    // Local bounds of a subtree (its root at the origin)
    const subtreeBbox = (ni) => {
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      const visit = (i, parentXf, isRoot) => {
        const node = json.nodes[i];
        const t = isRoot ? [0, 0, 0] : node.translation ?? [0, 0, 0];
        const r = isRoot ? [0, 0, 0, 1] : node.rotation ?? [0, 0, 0, 1];
        const sc = isRoot ? [1, 1, 1] : node.scale ?? [1, 1, 1];
        const xf = (p) => {
          const q = qrot(r, [0, 1, 2].map((k) => p[k] * sc[k]));
          return parentXf([0, 1, 2].map((k) => q[k] + t[k]));
        };
        if (node.mesh != null && !extras.get(i)?.hide) {
          for (const prim of json.meshes[node.mesh].primitives) {
            const acc = json.accessors[prim.attributes.POSITION];
            for (let corner = 0; corner < 8; corner++) {
              const p = xf([0, 1, 2].map((k) => ((corner >> k) & 1 ? acc.max : acc.min)[k]));
              for (let k = 0; k < 3; k++) {
                lo[k] = Math.min(lo[k], p[k]);
                hi[k] = Math.max(hi[k], p[k]);
              }
            }
          }
        }
        for (const c of node.children ?? []) visit(c, xf, false);
      };
      visit(ni, (p) => p, true);
      return lo[0] === Infinity ? null : [lo.map((v) => round(v, 3)), hi.map((v) => round(v, 3))];
    };

    // Chunks: the ones a normal run can use (no tutorial, jetpack or turbo-start sets)
    const chunks = [];
    const rename = new Map();
    const skip = new Set();
    for (const [go, ni] of nodeOfGo) {
      const tc = (goComps.get(go) ?? []).find((c) => c.script === 'TrackChunk');
      if (!tc) continue;
      const num = (key, fallback) => {
        const v = field(tc.doc, key);
        return v != null && /^-?[\d.e+-]+$/.test(v) ? Number(v) : fallback;
      };
      const group = json.nodes.find((n) => n.children?.includes(ni))?.name ?? '';
      const chunk = {
        group,
        zSize: num('zSize', 40),
        probability: num('probability', 1),
        zMin: num('zMinimum', 0),
        zMax: num('zMaximumActive', 0) ? num('zMaximum', Infinity) : null,
      };
      if (num('isTutorial', 0) === 1 || num('TurboHeadstart', 0) !== 0 || chunk.probability <= 0) {
        skip.add(ni);
        continue;
      }
      const name = `Classic_${group}_${goName.get(go)}`.replace(/[^A-Za-z0-9_-]+/g, '_');
      let unique = name;
      for (let k = 2; chunks.some((c) => c.name === unique); k++) unique = `${name}_${k}`;
      rename.set(ni, unique);
      chunks.push({ name: unique, chunk, bbox: subtreeBbox(ni) });
    }
    // The intro (start train, inspector's bag): overlaps the first chunk, which leaves the
    // ground to it
    const introNode = json.nodes.findIndex((n) => n.name === 'Intro_environment');
    if (introNode >= 0) {
      rename.set(introNode, 'Classic_Intro');
      chunks.push({ name: 'Classic_Intro', chunk: { intro: true, zSize: 0, probability: 0, zMin: 0, zMax: 0 }, bbox: subtreeBbox(introNode) });
    }
    // One glb for the chunk library (and intro): chunks share their road and building meshes
    const library = level;
    const chunksNode = json.nodes[level].children.find((c) => json.nodes[c].name === 'Chunks');
    const introParent = json.nodes.findIndex((n) => n.children?.includes(introNode));
    for (const c of json.nodes[level].children) if (c !== chunksNode && c !== introParent) skip.add(c);
    // Chunks outside the Chunks group (the jetpack landing set) aren't in the library: drop them
    const under = (i, root) => i === root || (json.nodes[root].children ?? []).some((c) => under(i, c));
    for (let k = chunks.length - 1; k >= 0; k--) {
      const ni = [...rename].find(([, n]) => n === chunks[k].name)?.[0];
      if (!chunks[k].chunk.intro && chunksNode != null && !under(ni, chunksNode)) chunks.splice(k, 1);
    }
    const kept = new Set(chunks.filter((c) => !c.chunk.intro).map((c) => [...rename].find(([, n]) => n === c.name)[0]));
    const hasKept = (i) => kept.has(i) || (json.nodes[i].children ?? []).some(hasKept);
    for (const c of json.nodes[chunksNode].children ?? []) if (!hasKept(c)) skip.add(c); // empty groups
    // Fog from the scene's RenderSettings
    const rs = docs.find((d) => d.kind === '104')?.doc ?? '';
    const color = rs.match(/m_FogColor: \{r: ([\d.e-]+), g: ([\d.e-]+), b: ([\d.e-]+), a: ([\d.e-]+)\}/);
    const config = {
      fog: {
        color: color ? color.slice(1, 5).map(Number) : null,
        start: Number(rs.match(/m_LinearFogStart: ([\d.e-]+)/)?.[1] ?? 428),
        end: Number(rs.match(/m_LinearFogEnd: ([\d.e-]+)/)?.[1] ?? 784),
      },
    };
    // ThemeAssets (the scene's skin): fog and sky colors, skyline silhouettes, as in 1.55.
    // One skin per season; the build shows Globals.UPDATE_DEFAULT_SEASON's (1.4 Halloween,
    // 1.5 Christmas), which also swaps material textures and, through ThemeShiftMeshes,
    // "<anything>_X" meshes for "<season>_X"
    const scriptDir = path.join(project, 'Scripts', 'Assembly-CSharp');
    const globalsFile = path.join(scriptDir, 'Globals.cs');
    const season = existsSync(globalsFile) ? read(globalsFile).match(/UPDATE_DEFAULT_SEASON = PlayerInfo\.Season\.(\w+)/)?.[1] : null;
    const themeGo = [...goName].find(([, n]) => n === 'ThemeAssets')?.[0];
    const skins = (goComps.get(themeGo) ?? []).map((c) => c.doc).find((d) => /\n {2}assets:/.test(d))?.split(/\n {2}assets:/)[1].split(/\n {2}\w/)[0].split(/\n {2}- theme: /).slice(1) ?? [];
    const seasonal = season && season !== 'none' ? skins.find((k, i) => i > 0 && k.slice(0, 3) === season.slice(0, 3)) : null;
    const skin = seasonal ?? skins[0];
    const textureSwaps = new Map(); // material name -> texture file
    let meshPrefix = null;
    if (seasonal) {
      meshPrefix = seasonal.split('\n')[0].trim();
      for (const [, tex, mat] of seasonal.matchAll(/- texture: \{[^}]*guid: (\w+)[^}]*\}\n\s+material: \{[^}]*guid: (\w+)/g)) {
        if (guidIndex.get(tex) && guidIndex.get(mat)?.endsWith('.mat')) textureSwaps.set(stem(guidIndex.get(mat)), guidIndex.get(tex));
      }
      log(`  season: ${season} (${textureSwaps.size} textures)`);
    }
    if (skin) {
      const rgba = (key) => {
        const m = skin.match(new RegExp(`\\n {4}${key}: \\{r: ([\\d.e-]+), g: ([\\d.e-]+), b: ([\\d.e-]+), a: ([\\d.e-]+)\\}`));
        return m ? m.slice(1, 5).map(Number) : null;
      };
      const refs = (key) => [...new Set([...(skin.split(`\n    ${key}:`)[1]?.split(/\n {4}\w/)[0] ?? '').matchAll(GUID_RE_G)].map(([, g]) => guidIndex.get(g)).filter((p) => p?.endsWith('.prefab')).map((p) => stem(p)))];
      config.fog.color = rgba('fogColor') ?? config.fog.color;
      // No gradient before 1.55: the sky plane sits past the fog's end, so it shows the fog color
      const fogRGB = config.fog.color?.slice(0, 3) ?? null;
      config.sky = { top: rgba('fogGradientTop')?.slice(0, 3) ?? fogRGB, bottom: rgba('fogGradientBottom')?.slice(0, 3) ?? fogRGB, power: 1 };
      const tint = rgba('fogSilhouetteColor');
      const layers = [];
      const fill = refs('backgroundPrefabs');
      const singles = refs('monumentPrefabs');
      if (fill.length) layers.push({ name: 'Back', fill, singles: [], tint, index: 1, offset: 0 });
      if (singles.length) layers.push({ name: 'Front', fill: [], singles, tint, index: 2, offset: 0 });
      if (layers.length) config.skylineLayers = { distance: 1000, spacing: 5, limits: [-350, 750], layers };
    }
    // The scene is the same for every World Tour city; the city of the build shows in the
    // Facebook share icon Globals.cs points at ("fblogo_vancouver.png")
    // (Globals.cs, or SocialManager.cs in 1.10: any script that names it)
    let city = null;
    for (const f of listDir(scriptDir).filter((p) => p.endsWith('.cs'))) {
      city = read(f).match(/fblogo_([a-z]+)\.png/i)?.[1] ?? null;
      if (city) break;
    }
    const MULTI_WORD = { losangeles: 'LosAngeles', newyork: 'NewYork', sanfrancisco: 'SanFrancisco', buenosaires: 'BuenosAires', hongkong: 'HongKong', stpetersburg: 'StPetersburg', riodejaneiro: 'RioDeJaneiro', mexicocity: 'MexicoCity' };
    const SEASON_NAMES = { xmas: 'Xmas', halloween: 'Halloween', easter: 'Easter' };
    const name = (city ? MULTI_WORD[city.toLowerCase()] ?? city[0].toUpperCase() + city.slice(1).toLowerCase() : 'Classic') + (seasonal ? SEASON_NAMES[season] ?? '' : '');
    log(`  ${chunks.filter((c) => !c.chunk.intro).length} chunks${introNode >= 0 ? ' + intro' : ''}, city: ${name}`);
    // Meshes the glb export left without UVs (Unity 3.5 builds): rebuilt from the assets
    const assetOfMesh = new Map();
    for (const [go, ni] of nodeOfGo) {
      const mesh = json.nodes[ni].mesh;
      if (mesh != null && goMeshAsset.has(go) && !assetOfMesh.has(mesh)) assetOfMesh.set(mesh, goMeshAsset.get(go));
    }
    const assetCache = new Map();
    let rebuilt = 0;
    let failed = 0;
    let swapped = 0;
    const loadAsset = (file) => {
      if (!assetCache.has(file)) assetCache.set(file, meshAsset(file));
      return assetCache.get(file);
    };
    const geometryFor = (mi, pi, positions, hasUVs) => {
      const file = assetOfMesh.get(mi);
      if (!file || !existsSync(file)) return null;
      if (meshPrefix) {
        const base = stem(file);
        const swap = path.join(path.dirname(file), `${meshPrefix}_${base.slice(base.indexOf('_') + 1)}.asset`);
        const geo = swap !== file && existsSync(swap) && loadAsset(swap) ? submeshGeometry(loadAsset(swap), pi, null) : null;
        if (geo) {
          swapped++;
          return geo;
        }
      }
      if (hasUVs) return null;
      const asset = loadAsset(file);
      const geo = asset ? submeshGeometry(asset, pi, positions()) : null;
      if (geo) rebuilt++;
      else failed++;
      return geo;
    };
    // Studio pieces: one of each train, the ramp, blockers and the signal, as found in the
    // chunks (the game has no separate prefabs for them)
    const PIECES = {
      train_static_1: [['train_cargo', 'Cargo'], ['train_standard', 'Standard'], ['train_sub', 'Subway']],
      train_static_3: [['train_cargo_3', 'Cargo'], ['train_standard_3', 'Standard'], ['train_sub_3', 'Subway']],
      train_static_5: [['train_cargo_5', 'Cargo'], ['train_standard_5', 'Standard'], ['train_sub_5', 'Subway']],
      train_ramp: [['train_ramp', 'Ramp']],
      obstacle_barrier_jump: [['blocker_jump', 'Blocker_Jump']],
      obstacle_barrier_roll: [['blocker_roll', 'Blocker_Roll']],
      obstacle_barrier_standard: [['blocker_standard', 'Blocker_Standard']],
      obstacle_lightSignal: [['lightSignal', 'LightSignal']],
    };
    const inLibrary = new Set();
    const collect = (i) => {
      if (skip.has(i)) return;
      inLibrary.add(i);
      for (const c of json.nodes[i].children ?? []) collect(c);
    };
    collect(library);
    const pieces = [];
    for (const [slot, options] of Object.entries(PIECES)) {
      for (const [node, label] of options) {
        const ni = json.nodes.findIndex((n, i) => n.name === node && n.mesh != null && inLibrary.has(i) && !rename.has(i) && !extras.get(i)?.hide);
        if (ni < 0) continue;
        const name = `Classic_${slot.startsWith('train_static') ? `Train_Static_${slot.slice(-1)}_` : ''}${label}`;
        rename.set(ni, name);
        // Trains start at their origin elsewhere (the studio lays them from there); these
        // have it a wagon's half length in
        let bbox = subtreeBbox(ni);
        const offset = slot.startsWith('train_static') && bbox ? [0, 0, -bbox[0][2]] : null;
        if (offset) bbox = bbox.map(([x, y, z]) => [x, y, round(z + offset[2], 3)]);
        pieces.push({ name, slot, bbox, offset });
      }
    }
    const libraryGlb = glbSubset(glb, library, extras, rename, skip, geometryFor);
    if (rebuilt || failed) log(`  Primitives rebuilt from mesh assets (UVs): ${rebuilt}${failed ? `, ${failed} left without` : ''}`);
    if (swapped) log(`  Primitives swapped for ${meshPrefix} meshes: ${swapped}`);
    return { name, chunks, pieces, config, library: libraryGlb, textureSwaps };
  }
  return null;
}

// ---------------------------------------------------------------- particles

/** Minimal reader for one Unity YAML document: nested maps, "- " lists, inline {a: b} maps. */
function parseUnityYaml(doc) {
  const rows = doc.split('\n').slice(1).filter((l) => l.trim()).map((l) => ({ indent: l.search(/\S/), text: l.trim() }));
  let i = 0;
  const scalar = (v) => {
    v = v.trim();
    if (v === '[]') return [];
    if (v === '{}') return {};
    if (v.startsWith('{') && v.endsWith('}')) {
      const out = {};
      for (const part of v.slice(1, -1).split(/,\s*(?=\w+:)/)) {
        const k = part.indexOf(':');
        out[part.slice(0, k).trim()] = scalar(part.slice(k + 1));
      }
      return out;
    }
    return /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(v) ? Number(v) : v;
  };
  function block(indent) {
    if (i < rows.length && rows[i].indent === indent && rows[i].text.startsWith('- ')) {
      const list = [];
      while (i < rows.length && rows[i].indent === indent && rows[i].text.startsWith('- ')) {
        const first = rows[i].text.slice(2);
        if (/^[\w]+:( |$)/.test(first)) {
          rows[i] = { indent: indent + 2, text: first }; // the item's first key, then its siblings
          list.push(block(indent + 2));
        } else {
          list.push(scalar(first));
          i++;
        }
      }
      return list;
    }
    const map = {};
    while (i < rows.length && rows[i].indent === indent && !rows[i].text.startsWith('- ')) {
      const { text } = rows[i];
      const k = text.indexOf(':');
      const key = text.slice(0, k);
      const rest = text.slice(k + 1).trim();
      i++;
      if (rest) map[key] = scalar(rest);
      else if (i < rows.length && (rows[i].indent > indent || (rows[i].indent === indent && rows[i].text.startsWith('- ')))) map[key] = block(rows[i].indent);
      else map[key] = null;
    }
    return map;
  }
  const top = block(rows[0]?.indent ?? 0);
  const keys = Object.keys(top);
  return keys.length === 1 && top[keys[0]] && typeof top[keys[0]] === 'object' ? top[keys[0]] : top; // "ParticleSystem:" wrapper
}

const curveKeys = (c) => (Array.isArray(c?.m_Curve) ? c.m_Curve.map((k) => [k.time, k.value]) : []);
/** MinMaxCurve -> { mode, min, max, curve, minCurve } (mode: 0 constant, 1 curve, 2 random between constants, 3 between curves) */
function minMaxCurve(c, fallback = 0) {
  if (c == null) return { mode: 0, min: fallback, max: fallback };
  if (typeof c === 'number') return { mode: 0, min: c, max: c }; // very old serializations
  const out = { mode: c.minMaxState ?? 0, min: c.minScalar ?? c.scalar ?? fallback, max: c.scalar ?? fallback };
  if (out.mode === 1 || out.mode === 3) {
    out.curve = curveKeys(c.maxCurve);
    if (out.mode === 3) out.minCurve = curveKeys(c.minCurve);
  }
  return out;
}
const rgba = (c) => (c ? [c.r ?? 1, c.g ?? 1, c.b ?? 1, c.a ?? 1] : [1, 1, 1, 1]);
/** Gradient -> { colors: [[t, r, g, b]], alphas: [[t, a]] } */
function gradient(g) {
  if (!g) return null;
  const nc = g.m_NumColorKeys ?? 2;
  const na = g.m_NumAlphaKeys ?? 2;
  const colors = [];
  const alphas = [];
  for (let k = 0; k < Math.max(nc, na); k++) {
    const key = rgba(g[`key${k}`]);
    if (k < nc) colors.push([(g[`ctime${k}`] ?? 0) / 65535, key[0], key[1], key[2]]);
    if (k < na) alphas.push([(g[`atime${k}`] ?? 0) / 65535, key[3]]);
  }
  return { colors, alphas };
}
/** MinMaxGradient -> { mode, min, max, gradient, minGradient } */
function minMaxGradient(c) {
  if (!c) return { mode: 0, max: [1, 1, 1, 1] };
  const out = { mode: c.minMaxState ?? 0, min: rgba(c.minColor), max: rgba(c.maxColor) };
  if ([1, 3, 4].includes(out.mode)) out.gradient = gradient(c.maxGradient);
  if (out.mode === 3) out.minGradient = gradient(c.minGradient);
  return out;
}
const vec3 = (v, f = 0) => [v?.x ?? f, v?.y ?? f, v?.z ?? f];

/** ParticleSystem + ParticleSystemRenderer components: GameObject name -> emitter description. */
function parseParticles(file, guidIndex) {
  const docs = yamlDocs(read(file));
  const names = new Map();
  for (const { doc, kind, fid } of docs) {
    if (kind === '1') names.set(fid, doc.match(/m_Name: (.*)/)?.[1].trim() ?? '');
  }
  const goOf = (doc) => doc.match(/m_GameObject: \{fileID: (\d+)/)?.[1];
  const renderers = new Map();
  for (const { doc, kind } of docs) if (kind === '199') renderers.set(goOf(doc), parseUnityYaml(doc));
  const systemGo = new Map(); // ParticleSystem fileID -> GameObject (for sub-emitter links)
  for (const { doc, kind, fid } of docs) if (kind === '198') systemGo.set(fid, goOf(doc));
  const out = {};
  for (const { doc, kind } of docs) {
    if (kind !== '198') continue;
    const go = goOf(doc);
    const r = renderers.get(go);
    if (!names.has(go) || !r || r.m_Enabled === 0) continue;
    const ps = parseUnityYaml(doc);
    const init = ps.InitialModule ?? {};
    const shape = ps.ShapeModule ?? {};
    const emission = ps.EmissionModule ?? {};
    const mod = (name) => (ps[name]?.enabled ? ps[name] : null);
    const matGuid = (r.m_Materials ?? []).map((m) => m?.guid).find((g) => g && guidIndex.has(g));
    const meshGuid = r.m_Mesh?.guid;
    const radius = typeof shape.radius === 'object' && shape.radius ? shape.radius.value : shape.radius;
    const size = mod('SizeModule');
    const color = mod('ColorModule');
    const rot = mod('RotationModule');
    const vel = mod('VelocityModule');
    const force = mod('ForceModule');
    const uv = mod('UVModule');
    out[names.get(go)] = {
      duration: ps.lengthInSec ?? 5,
      loop: ps.looping !== 0,
      prewarm: ps.prewarm === 1,
      delay: minMaxCurve(ps.startDelay),
      local: (ps.moveWithTransform ?? 0) !== 1, // simulation space: 0 local, 1 world
      lifetime: minMaxCurve(init.startLifetime, 5),
      speed: minMaxCurve(init.startSpeed, 5),
      size: minMaxCurve(init.startSize, 1),
      rotation: minMaxCurve(init.startRotation),
      color: minMaxGradient(init.startColor),
      gravity: minMaxCurve(init.gravityModifier),
      max: Math.min(init.maxNumParticles ?? 1000, 400),
      shape: shape.enabled === 0 ? null : {
        type: shape.type ?? 4,
        radius: radius ?? 1,
        angle: shape.angle ?? 25,
        arc: (typeof shape.arc === 'object' ? shape.arc?.value : shape.arc) ?? 360,
        box: shape.m_Scale ? vec3(shape.m_Scale, 1) : [shape.boxX ?? 1, shape.boxY ?? 1, shape.boxZ ?? 1],
        position: vec3(shape.m_Position),
        rotation: vec3(shape.m_Rotation),
        randomDirection: shape.randomDirectionAmount ?? shape.randomDirection ?? 0,
        // Mesh shapes (6, 13, 14) without their mesh fire from the origin along +Z
        hasMesh: [shape.m_Mesh, shape.m_MeshRenderer, shape.m_SkinnedMeshRenderer].some((m) => m?.fileID),
      },
      rate: minMaxCurve(emission.enabled === 0 ? 0 : emission.rateOverTime ?? emission.rate, 0),
      bursts: (emission.enabled === 0 ? [] : emission.m_Bursts ?? []).map((b) => ({
        time: b.time ?? 0,
        count: minMaxCurve(b.countCurve ?? b.minCount, b.minCount ?? 1),
        cycles: b.cycleCount ?? 1,
        interval: b.repeatInterval ?? 0.01,
      })),
      sizeOverLife: size ? minMaxCurve(size.curve, 1) : null,
      colorOverLife: color ? minMaxGradient(color.gradient) : null,
      rotationOverLife: rot ? minMaxCurve(rot.curve) : null,
      velocity: vel ? {
        x: minMaxCurve(vel.x),
        y: minMaxCurve(vel.y),
        z: minMaxCurve(vel.z),
        world: vel.inWorldSpace === 1,
        // Orbital (radians/s around the system's axes) and radial: 3.60 Ireland seagulls circle this way
        ...(vel.orbitalX ? {
          orbital: { x: minMaxCurve(vel.orbitalX), y: minMaxCurve(vel.orbitalY), z: minMaxCurve(vel.orbitalZ) },
          orbitalOffset: [minMaxCurve(vel.orbitalOffsetX), minMaxCurve(vel.orbitalOffsetY), minMaxCurve(vel.orbitalOffsetZ)].map((c) => c.max),
          radial: minMaxCurve(vel.radial),
        } : {}),
      } : null,
      force: force ? { x: minMaxCurve(force.x), y: minMaxCurve(force.y), z: minMaxCurve(force.z), world: force.inWorldSpace === 1 } : null,
      sheet: uv && (uv.tilesX > 1 || uv.tilesY > 1) ? { x: uv.tilesX, y: uv.tilesY, frame: minMaxCurve(uv.frameOverTime), cycles: uv.cycles ?? 1, row: uv.animationType === 1 ? (uv.randomRow ? -1 : uv.rowIndex ?? 0) : null } : null,
      render: {
        mode: r.m_RenderMode ?? 0,
        material: matGuid ? stem(guidIndex.get(matGuid)) : null,
        mesh: meshGuid && guidIndex.has(meshGuid) ? stem(guidIndex.get(meshGuid)) : null,
        lengthScale: r.m_LengthScale ?? 2,
        velocityScale: r.m_VelocityScale ?? 0,
        maxSize: r.m_MaxParticleSize ?? 0.5,
        alignment: r.m_RenderAlignment ?? 0, // 0 view, 1 world, 2 local, 3 facing, 4 velocity
      },
    };
    // Sub-emitters (fireworks): systems started by this one's particles, at their birth
    // (type 0, following them) or death (type 2). Named after their nodes.
    // (fileIDs read as text: 18 digits don't survive as numbers)
    const subBlock = mod('SubModule') ? doc.split('\n  SubModule:')[1]?.split(/\n  \w/)[0] ?? '' : '';
    const subs = [...subBlock.matchAll(/emitter: \{fileID: (\d+)\}\n\s+type: (\d+)(?:\n\s+properties: \d+)?(?:\n\s+emitProbability: ([\d.]+))?/g)]
      .map(([, fid, type, prob]) => ({ node: names.get(systemGo.get(fid)), type: Number(type), probability: prob != null ? Number(prob) : 1 }))
      .filter((e) => e.node && (e.type === 0 || e.type === 2));
    if (subs.length) out[names.get(go)].subEmitters = subs;
  }
  return out;
}

/** Names of GameObjects whose renderers only belong to LOD1+ of a LODGroup.
 *
 * The game swaps between high/low models by screen size; the glb export
 * contains every level at once, so the viewer keeps LOD0 only. */
function parseLodGroups(file) {
  const docs = yamlDocs(read(file));
  const goNames = new Map();
  const owner = new Map();
  for (const { doc, kind, fid } of docs) {
    if (!kind) continue;
    if (kind === '1') {
      const nm = doc.match(/m_Name: (.*)/);
      goNames.set(fid, nm ? nm[1].trim() : '');
    } else {
      const go = doc.match(/m_GameObject: \{fileID: (\d+)/);
      if (go) owner.set(fid, go[1]);
    }
  }
  const lod0 = new Set();
  const lower = new Set();
  for (const { doc } of docs) {
    if (!doc.startsWith('!u!205 ')) continue;
    doc.split(/\n\s*- screenRelativeHeight:/).slice(1).forEach((block, level) => {
      for (const [, rid] of block.matchAll(/renderer: \{fileID: (\d+)/g)) {
        const name = goNames.get(owner.get(rid) ?? '');
        if (name !== undefined) (level === 0 ? lod0 : lower).add(name);
      }
    });
  }
  return sortedStrings([...lower].filter((n) => !lod0.has(n)));
}

function slotCategory(slot) {
  const prefix = slot.split('_')[0];
  return ['boundary', 'track', 'obstacle', 'train', 'special', 'prop'].includes(prefix) ? prefix : 'other';
}

// ---------------------------------------------------------------- glb stats

function qrot([x, y, z, w], [vx, vy, vz]) {
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + y * tz - z * ty, vy + w * ty + z * tx - x * tz, vz + w * tz + x * ty - y * tx];
}

/** The JSON chunk of a glb. */
function glbJson(file) {
  const data = readFileSync(file);
  return JSON.parse(data.toString('utf8', 20, 20 + data.readUInt32LE(12)));
}

/** Mesh/material counts and world-space AABB of a glb (from accessor bounds). */
function glbStats(file) {
  const gltf = glbJson(file);
  const nodes = gltf.nodes ?? [];
  const meshes = gltf.meshes ?? [];
  const accessors = gltf.accessors ?? [];
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];

  const visit = (i, parentXf) => {
    const node = nodes[i];
    const t = node.translation ?? [0, 0, 0];
    const r = node.rotation ?? [0, 0, 0, 1];
    const s = node.scale ?? [1, 1, 1];
    const xf = (p) => {
      const q = qrot(r, [0, 1, 2].map((k) => p[k] * s[k]));
      return parentXf([0, 1, 2].map((k) => q[k] + t[k]));
    };
    if ('mesh' in node) {
      for (const prim of meshes[node.mesh].primitives) {
        const acc = accessors[prim.attributes.POSITION];
        for (let corner = 0; corner < 8; corner++) {
          const p = xf([0, 1, 2].map((k) => ((corner >> k) & 1 ? acc.max : acc.min)[k]));
          for (let k = 0; k < 3; k++) {
            lo[k] = Math.min(lo[k], p[k]);
            hi[k] = Math.max(hi[k], p[k]);
          }
        }
      }
    }
    for (const c of node.children ?? []) visit(c, xf);
  };
  for (const root of gltf.scenes[gltf.scene ?? 0].nodes) visit(root, (p) => p);

  const hasGeo = lo[0] !== Infinity;
  return {
    meshes: meshes.length,
    materials: sortedStrings(new Set((gltf.materials ?? []).map((m) => m.name ?? ''))),
    bbox: hasGeo ? [lo.map((v) => round(v, 3)), hi.map((v) => round(v, 3))] : null,
  };
}

/**
 * Whether a glb has a surface inside the runner's corridor (|x| < 25, 2 < y < 30, any z):
 * tells walls and cards that would block the tracks from arches that span them.
 */
function blocksCorridor(file) {
  const data = readFileSync(file);
  const jsonLen = data.readUInt32LE(12);
  const gltf = JSON.parse(data.toString('utf8', 20, 20 + jsonLen));
  const bin = data.subarray(20 + jsonLen + 8);
  const read = (ai) => {
    const a = gltf.accessors[ai];
    const bv = gltf.bufferViews[a.bufferView];
    const C = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array, 5121: Uint8Array }[a.componentType];
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
    const stride = bv.byteStride ? bv.byteStride / C.BYTES_PER_ELEMENT : n;
    const start = bin.byteOffset + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const raw = new C(bin.buffer.slice(start, start + ((a.count - 1) * stride + n) * C.BYTES_PER_ELEMENT));
    return { raw, stride, count: a.count };
  };
  // Exact: clip the triangle by the corridor's four planes; anything left intersects
  const PLANES = [[0, 1, -25], [0, -1, 25], [1, 1, 2], [1, -1, 30]]; // axis, sign, bound: sign*(p[axis]-bound) > 0
  const crosses = (tri) => {
    let poly = tri;
    for (const [axis, sign, bound] of PLANES) {
      const d = (p) => sign * (p[axis] - bound);
      const out = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        const da = d(a);
        const db = d(b);
        if (da > 0) out.push(a);
        if (da > 0 !== db > 0) {
          const t = da / (da - db);
          out.push([0, 1, 2].map((c) => a[c] + (b[c] - a[c]) * t));
        }
      }
      poly = out;
      if (!poly.length) return false;
    }
    return true;
  };
  let hit = false;
  const visit = (i, parentXf) => {
    if (hit) return;
    const node = gltf.nodes[i];
    const t = node.translation ?? [0, 0, 0];
    const r = node.rotation ?? [0, 0, 0, 1];
    const sc = node.scale ?? [1, 1, 1];
    const xf = (p) => {
      const q = qrot(r, [0, 1, 2].map((k) => p[k] * sc[k]));
      return parentXf([0, 1, 2].map((k) => q[k] + t[k]));
    };
    if ('mesh' in node) {
      for (const prim of gltf.meshes[node.mesh].primitives) {
        const pos = read(prim.attributes.POSITION);
        const P = (v) => xf([pos.raw[v * pos.stride], pos.raw[v * pos.stride + 1], pos.raw[v * pos.stride + 2]]);
        const idx = prim.indices != null ? read(prim.indices) : null;
        const tris = idx ? idx.count : pos.count;
        for (let k = 0; k + 2 < tris && !hit; k += 3) {
          if (crosses([0, 1, 2].map((j) => P(idx ? idx.raw[k + j] : k + j)))) hit = true;
        }
      }
    }
    for (const c of node.children ?? []) visit(c, xf);
  };
  for (const root of gltf.scenes[gltf.scene ?? 0].nodes) visit(root, (p) => p);
  return hit;
}

// ---------------------------------------------------------------- materials

function shaderName(refLine, guidIndex) {
  const m = refLine.match(GUID_RE);
  const fid = refLine.match(/fileID: (\d+)/);
  if (m && m[1] !== '0000000000000000f000000000000000') {
    const file = guidIndex.get(m[1]);
    if (file && suffix(file) === '.shader') {
      const sm = read(file).split('\n', 1)[0].match(/^Shader "([^"]+)"/);
      return sm ? sm[1] : stem(file);
    }
    return `?${m[1]}`;
  }
  return BUILTIN_SHADERS[fid ? fid[1] : ''] ?? `builtin:${fid ? fid[1] : '?'}`;
}

const NUMBERS_RE = /-?[\d.]+(?:e-?\d+)?/g;
const MAT_SECTIONS = new Set(['m_ValidKeywords:', 'm_TexEnvs:', 'm_Floats:', 'm_Colors:', 'm_Ints: {}', 'm_InvalidKeywords: []']);

/** Minimal parser for Unity .mat YAML (serializedVersion 8). */
function parseMaterial(file, guidIndex, exportRoot) {
  const mat = { shader: null, keywords: [], renderQueue: -1, textures: {}, floats: {}, colors: {} };
  let section = null;
  let texName = null;
  let pairName = null; // Unity 5 "- first: / name: _MainTex / second: …", Unity 4 "data: / first: / name: …"
  for (const line of lines(read(file))) {
    const s = line.trim();
    if (section && s.startsWith('name:') && pairName === '') {
      pairName = s.slice(5).trim();
      continue;
    }
    if (section && s === 'data:') continue;
    if (section && (s === '- first:' || s === 'first:')) {
      pairName = '';
      continue;
    }
    if (section && pairName && s.startsWith('second:')) {
      const value = s.slice(7).trim();
      if (section === 'm_TexEnvs') texName = pairName;
      else if (section === 'm_Floats' && value) {
        try {
          mat.floats[pairName] = num(value);
        } catch {
          // not a float
        }
      } else if (section === 'm_Colors' && value) mat.colors[pairName] = (value.match(NUMBERS_RE) ?? []).map(num);
      continue;
    }
    if (s.startsWith('m_Shader:')) {
      mat.shader = shaderName(s, guidIndex);
    } else if (s.startsWith('m_CustomRenderQueue:')) {
      mat.renderQueue = parseInt(s.split(':')[1], 10);
    } else if (MAT_SECTIONS.has(s)) {
      section = s.replace(/:+$/, '');
    } else if (s.startsWith('m_') && !['m_Texture', 'm_Scale', 'm_Offset'].some((p) => s.startsWith(p))) {
      section = null;
    } else if (section === 'm_ValidKeywords' && s.startsWith('- ')) {
      mat.keywords.push(s.slice(2));
    } else if (section === 'm_TexEnvs') {
      if (s.endsWith(':') && !s.startsWith('m_')) {
        texName = s.slice(0, -1);
      } else if (s.startsWith('m_Texture:') && texName) {
        const m = s.match(GUID_RE);
        if (m && guidIndex.has(m[1])) mat.textures[texName] = { path: path.relative(exportRoot, guidIndex.get(m[1])) };
        // Unity's built-in "Default-Particle" (a soft round glow), not in any export
        else if (/fileID: 10300, guid: 0000000000000000f000000000000000/.test(s)) mat.textures[texName] = { builtin: 'Default-Particle' };
      } else if ((s.startsWith('m_Scale:') || s.startsWith('m_Offset:')) && texName in mat.textures) {
        const nums = (s.slice(s.indexOf(':') + 1).match(NUMBERS_RE) ?? []).map(num);
        mat.textures[texName][s.startsWith('m_Scale') ? 'scale' : 'offset'] = nums;
      }
    } else if (section === 'm_Floats' && s.includes(':')) {
      const i = s.indexOf(':');
      try {
        mat.floats[s.slice(0, i)] = num(s.slice(i + 1));
      } catch {
        // nested value, not a float
      }
    } else if (section === 'm_Colors' && s.includes(':')) {
      const i = s.indexOf(':');
      mat.colors[s.slice(0, i)] = (s.slice(i + 1).match(NUMBERS_RE) ?? []).map(num);
    }
  }
  return mat;
}

// ---------------------------------------------------------------- main

function copyIfNewer(src, dst) {
  const srcStat = statSync(src);
  if (!existsSync(dst) || statSync(dst).mtimeMs < srcStat.mtimeMs) {
    copyFileSync(src, dst);
    utimesSync(dst, srcStat.atime, srcStat.mtime);
  }
}

const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 1));

/**
 * @param {{ exportDir: string, out?: string, split?: boolean, sourceName?: string }} options
 * @param {(line: string) => void} log
 */
export function buildManifest({ exportDir, out, split = false, sourceName }, log = console.error) {
  const finalOut = path.resolve(out ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'viewer', 'public', 'data'));
  out = split ? path.join(finalOut, '_all') : finalOut; // combined staging, split per theme at the end

  const root = path.resolve(exportDir);
  const project = path.join(root, 'ExportedProject', 'Assets');
  const glbDir = path.join(root, 'Files', 'Assets', 'PrefabHierarchyObject');
  const meshDir = path.join(root, 'Files', 'Assets', 'Mesh');
  const isDir = (p) => existsSync(p) && statSync(p).isDirectory();
  if (!isDir(project) || !isDir(glbDir)) throw new Error(`Not an AssetRipper export: ${root}`);

  log('Indexing guids...');
  const guidIndex = buildGuidIndex(project);
  log(`  ${guidIndex.size} assets`);

  // Assets by file name. Newer exports sort assets into per-type folders (Material/,
  // GameObject/, …); older games ship bundles with real project paths
  // (Art/Themes/<City>/…), so never assume a folder. Per-type folders win on clashes.
  const byName = new Map();
  const byDepth = (a, b) => partsOf(b).length - partsOf(a).length;
  for (const p of [...guidIndex.values()].sort(byDepth)) byName.set(path.basename(p), p);
  for (const folder of ['Material', 'GameObject', 'MonoBehaviour']) {
    for (const p of listDir(path.join(project, folder))) {
      if (!p.endsWith('.meta')) byName.set(path.basename(p), p);
    }
  }
  const find = (name) => byName.get(name);

  // Primary-content glbs by name: PrefabHierarchyObject/ and Mesh/ first, then anywhere
  // (prefabs from bundles with project paths land under Files/Assets/Art/…). A prefab and
  // its model can share a name (2.2: prefabs/tracks/X and models/tracks/X): the prefab's
  // export carries its materials, the model's only Default-Material.
  const allGlbs = [...walk(path.join(root, 'Files'))].filter((p) => p.endsWith('.glb')).sort(byDepth);
  const hasMaterials = (p) => glbJson(p).materials?.some((m) => m.name !== 'Default-Material') ?? false;
  const byNamePreferring = (prefer) => {
    const map = new Map();
    for (const p of allGlbs) {
      const prev = map.get(path.basename(p));
      if (!prev || (!prefer(prev) && prefer(p))) map.set(path.basename(p), p);
    }
    return map;
  };
  const prefabGlbs = byNamePreferring(hasMaterials);
  for (const p of listDir(glbDir)) if (p.endsWith('.glb')) prefabGlbs.set(path.basename(p), p);
  const meshGlbs = byNamePreferring((p) => !hasMaterials(p));
  for (const p of listDir(meshDir)) if (p.endsWith('.glb')) meshGlbs.set(path.basename(p), p);

  // Themes
  const themeCache = new Map();
  const themes = {};
  const themeByGuid = new Map();
  const themeFiles = [...byName].filter(([n]) => n.endsWith('_Theme.asset')).map(([, p]) => p).sort(comparePaths);
  for (const p of themeFiles) {
    if (stem(p).startsWith('_')) continue; // abstract parent themes (e.g. _Common_Theme)
    const guid = read(`${p}.meta`).match(GUID_RE)[1];
    themes[stem(p).replace(/_Theme$/, '')] = resolveTheme(guid, guidIndex, themeCache);
    themeByGuid.set(guid, stem(p).replace(/_Theme$/, ''));
  }
  // 1.x: no theme assets, a mapping MonoBehaviour per city instead
  const legacy = {};
  if (!themeFiles.length) {
    for (const [n, p] of byName) {
      if (!n.endsWith('.asset') || !read(p).includes('\n  _prefabMappingsGeneric:')) continue;
      const theme = parseLegacyTheme(p, guidIndex);
      legacy[theme.name] = theme;
      themes[theme.name] = theme.slots;
    }
  }
  // ≤ 1.43: no themes either, the level is a scene of hand-built chunks
  const classic = !Object.keys(themes).length ? parseClassic(root, project, guidIndex, log) : null;
  if (classic) {
    themes[classic.name] = { classic_chunk: classic.chunks.map((c) => c.name) };
    for (const p of classic.pieces) (themes[classic.name][p.slot] ??= []).push(p.name);
  }
  log(`Themes: ${Object.keys(themes).join(', ')}${Object.keys(legacy).length ? ' (1.x format)' : ''}${classic ? ' (classic chunks)' : ''}`);

  // Boundary transitions (tube entrances/exits, …) per theme
  const boundaries = {};
  for (const theme of Object.keys(themes)) {
    const p = find(`${theme}_Boundaries.asset`);
    if (p) boundaries[theme] = parseBoundaries(p, guidIndex);
    else if (legacy[theme]) boundaries[theme] = { transitions: legacy[theme].transitions, trackInfos: legacy[theme].trackInfos };
  }
  const transitionCount = Object.values(boundaries).reduce((n, b) => n + b.transitions.length, 0);
  log(`Transitions: ${transitionCount} in ${Object.keys(boundaries).length} themes`);

  const chunks = {};
  const chunkFiles = [...byName].filter(([n]) => n.startsWith('Chase_Chunk_') && n.endsWith('.prefab')).map(([, p]) => p).sort(comparePaths);
  for (const p of chunkFiles) {
    const chunk = parseChunk(p, guidIndex);
    if (chunk.placements.length) chunks[stem(p).replace(/^Chase_Chunk_/, '')] = chunk;
  }
  const placementCount = Object.values(chunks).reduce((n, c) => n + c.placements.length, 0);
  log(`Chunks: ${Object.keys(chunks).length} (${placementCount} placements)`);

  // Configs point at their theme; match on that, as names differ in old games
  // (theme "1.65_Amsterdam", config "Amsterdam_Config")
  const configByTheme = new Map();
  for (const [n, p] of byName) {
    if (!n.endsWith('_Config.asset')) continue;
    const m = read(p).match(/\n  Theme: \{fileID: \d+, guid: (\w+)/);
    if (m && themeByGuid.has(m[1])) configByTheme.set(themeByGuid.get(m[1]), p);
  }
  const themeConfigs = {};
  for (const theme of Object.keys(themes)) {
    const p = configByTheme.get(theme) ?? find(`${theme}_Config.asset`);
    if (!p) continue;
    themeConfigs[theme] = parseThemeConfig(p, guidIndex);
    const effectsBlock = read(p).match(/ThemeEffects:\n((?:  - .*\n)+)/);
    const effects = [];
    for (const [, g] of (effectsBlock ? effectsBlock[1] : '').matchAll(GUID_RE_G)) {
      const effectPath = guidIndex.get(g);
      const effect = effectPath && suffix(effectPath) === '.prefab' ? parseThemeEffect(effectPath, guidIndex) : null;
      if (effect) effects.push(effect);
    }
    if (effects.length) themeConfigs[theme].effects = effects;
  }
  for (const [theme, info] of Object.entries(legacy)) themeConfigs[theme] ??= info.config;
  if (classic) themeConfigs[classic.name] ??= classic.config;
  log(`Theme configs: ${Object.keys(themeConfigs).length}`);

  // Slot types declare their length in cells (BoundaryType.CellDepth); bounding boxes
  // are unreliable because decoration overhangs and placeholders are empty
  const firstByName = new Map();
  for (const p of guidIndex.values()) if (!firstByName.has(path.basename(p))) firstByName.set(path.basename(p), p);
  const slotDepths = {};
  for (const slots of Object.values(themes)) {
    for (const slot of Object.keys(slots)) {
      const p = firstByName.get(`${slot}.asset`);
      const depth = p ? read(p).match(/CellDepth: (\d+)/) : null;
      if (depth) slotDepths[slot] = parseInt(depth[1], 10);
    }
  }

  // Prefabs referenced by any theme
  const outGlb = path.join(out, 'glb');
  mkdirSync(outGlb, { recursive: true });
  const prefabs = {};
  const prefabGlbSrc = new Map(); // prefab name -> the glb it was built from
  const missing = [];
  let empty = [];
  const transitionPrefabs = Object.values(boundaries).map((b) => b.transitions.map((t) => t.prefab));
  transitionPrefabs.push(EXTRA_PREFABS);
  transitionPrefabs.push(Object.values(themeConfigs).filter((c) => c.background).map((c) => c.background.prefab));
  transitionPrefabs.push(Object.values(themeConfigs).flatMap((c) => (c.effects ?? []).map((e) => e.prefab)));
  // 1.x: skyline layers, and the cars / short pieces composites are built from
  const composites = new Map(Object.values(legacy).flatMap((t) => Object.entries(t.composites)));
  transitionPrefabs.push(Object.values(themeConfigs).flatMap((c) => (c.skylineLayers?.layers ?? []).flatMap((l) => [...l.fill, ...l.singles])));
  transitionPrefabs.push([...composites.values()].flatMap((parts) => parts.map((p) => p.prefab)));
  const classicNames = new Set([...(classic?.chunks ?? []), ...(classic?.pieces ?? [])].map((c) => c.name));
  const nameLists = [...Object.values(themes).flatMap((slots) => Object.values(slots)), ...transitionPrefabs];
  // 1.x placeholder contents (and theirs, recursively)
  // Placeholders can name generic prefabs ("event_3_gen"): the game swaps in the city's own
  const themedOf = Object.assign({}, ...Object.values(legacy).map((t) => t.themedOf));
  const placeholderTargets = [];
  {
    const seen = new Set();
    const queue = nameLists.flat();
    while (queue.length) {
      const name = queue.pop();
      if (seen.has(name)) continue;
      seen.add(name);
      const file = find(`${name}.prefab`);
      if (!file) continue;
      for (const entry of Object.values(parsePlaceholders(file, guidIndex))) {
        for (const { name } of entry.prefabs) {
          const target = themedOf[name] ?? name;
          placeholderTargets.push(target);
          queue.push(target);
        }
      }
    }
  }
  nameLists.push(placeholderTargets);
  for (const names of nameLists) {
    for (const name of names) {
      if (name in prefabs || composites.has(name) || classicNames.has(name)) continue;
      const src = prefabGlbs.get(`${name}.glb`);
      if (!src) {
        missing.push(name);
        prefabs[name] = { glb: null };
        continue;
      }
      const stats = glbStats(src);
      if (stats.bbox === null) empty.push(name);
      copyIfNewer(src, path.join(outGlb, path.basename(src)));
      prefabs[name] = { glb: `glb/${path.basename(src)}`, ...stats };
      prefabGlbSrc.set(name, src);
    }
  }

  // Classic chunks: one library glb, each chunk a node of it, with its selection settings
  if (classic) {
    const file = path.join(outGlb, 'Classic_chunks.glb');
    writeFileSync(file, classic.library);
    const { materials } = glbStats(file);
    for (const c of classic.chunks) prefabs[c.name] = { glb: 'glb/Classic_chunks.glb', node: c.name, meshes: 1, materials, bbox: c.bbox, chunk: c.chunk };
    for (const p of classic.pieces) prefabs[p.name] = { glb: 'glb/Classic_chunks.glb', node: p.name, meshes: 1, materials, bbox: p.bbox, ...(p.offset ? { offset: p.offset } : {}) };
  }

  // 1.x: the generic role of each themed prefab (name rules in the viewer use it)
  for (const t of Object.values(legacy)) {
    for (const [name, role] of Object.entries(t.roles)) if (prefabs[name] && role !== name) prefabs[name].role = role;
  }

  // Composites: their parts placed side by side
  for (const [name, parts] of composites) {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const { prefab, pos } of parts) {
      const bb = prefabs[prefab]?.bbox;
      if (!bb) continue;
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], bb[0][k] + pos[k]);
        hi[k] = Math.max(hi[k], bb[1][k] + pos[k]);
      }
    }
    if (lo[0] === Infinity) {
      missing.push(name);
      continue;
    }
    prefabs[name] = {
      parts,
      meshes: parts.reduce((n, p) => n + (prefabs[p.prefab]?.meshes ?? 0), 0),
      materials: sortedStrings(new Set(parts.flatMap((p) => prefabs[p.prefab]?.materials ?? []))),
      bbox: [lo, hi],
    };
  }

  // The .prefab a glb was exported from sits at the same path in the project; by name
  // alone, 2.2+ also has the model's prefab (models/…/X.prefab) without components
  const filesAssets = path.join(root, 'Files', 'Assets');
  const prefabFile = (name) => {
    const src = prefabGlbSrc.get(name);
    const sibling = src && path.join(project, path.relative(filesAssets, src)).replace(/\.glb$/, '.prefab');
    return sibling && existsSync(sibling) ? sibling : find(`${name}.prefab`);
  };

  // Random variant groups (only one child is active in game), LODs, mesh flipbooks
  const outMesh = path.join(out, 'mesh');
  mkdirSync(outMesh, { recursive: true });
  let colorFixes = 0;
  for (const [name, info] of Object.entries(prefabs)) {
    const prefabPath = prefabFile(name);
    if (!prefabPath || !info.glb) continue;
    colorFixes += fixZeroColors(path.join(out, info.glb), prefabPath, guidIndex);
    const randomizers = parseRandomizers(prefabPath, guidIndex);
    if (Object.keys(randomizers).length) info.randomizers = randomizers;
    const lodHidden = parseLodGroups(prefabPath);
    if (lodHidden.length) info.lodHidden = lodHidden;
    const skinned = parseSkinnedMeshes(prefabPath, guidIndex).filter((sk) => {
      const src = meshGlbs.get(`${sk.mesh}.glb`);
      if (!src) return false;
      copyIfNewer(src, path.join(outMesh, path.basename(src)));
      sk.mesh = `mesh/${path.basename(src)}`;
      return true;
    });
    if (skinned.length) {
      info.skinned = skinned;
      info.materials = sortedStrings(new Set([...(info.materials ?? []), ...skinned.flatMap((sk) => sk.materials)]));
    }
    const motions = parseMotions(prefabPath, guidIndex);
    if (motions.length) info.motions = motions;
    const morphMeshes = parseMorphMeshes(prefabPath, guidIndex).map(({ node, materials: mats, data }) => {
      const file = `mesh/${name}_${node.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`;
      writeFileSync(path.join(out, file), JSON.stringify(data));
      return { node, materials: mats, url: file };
    });
    if (morphMeshes.length) {
      info.morphMeshes = morphMeshes;
      info.materials = sortedStrings(new Set([...(info.materials ?? []), ...morphMeshes.flatMap((m) => m.materials)]));
    }
    const animators = parseAnimators(prefabPath, guidIndex);
    if (animators.length) {
      mkdirSync(path.join(out, 'anim'), { recursive: true });
      writeFileSync(path.join(out, 'anim', `${name}.json`), JSON.stringify(animators));
      info.animators = `anim/${name}.json`;
    }
    const trails = parseTrails(prefabPath, guidIndex);
    if (trails.length) {
      info.trails = trails;
      info.materials = sortedStrings(new Set([...(info.materials ?? []), ...trails.map((t) => t.material)]));
    }
    const animations = parseMeshAnimations(prefabPath, guidIndex);
    for (const anim of Object.values(animations)) {
      anim.frames = anim.frames.map((mesh) => {
        const src = meshGlbs.get(`${mesh}.glb`);
        if (!src) return null;
        copyIfNewer(src, path.join(outMesh, path.basename(src)));
        return `mesh/${path.basename(src)}`;
      });
    }
    const complete = Object.entries(animations).filter(([, a]) => a.frames.every(Boolean));
    if (complete.length) info.meshAnimations = Object.fromEntries(complete);
    const placeholders = parsePlaceholders(prefabPath, guidIndex);
    for (const entry of Object.values(placeholders)) {
      entry.prefabs = entry.prefabs.map((p) => ({ ...p, name: themedOf[p.name] ?? p.name })).filter((p) => prefabs[p.name]?.glb);
    }
    const filled = Object.entries(placeholders).filter(([, e]) => e.prefabs.length);
    if (filled.length) info.placeholders = Object.fromEntries(filled);
    const effects = parseEffectPlayers(prefabPath);
    if (Object.keys(effects).length) info.effectPlayers = effects;
    const particles = parseParticles(prefabPath, guidIndex);
    for (const p of Object.values(particles)) {
      // Mesh particles (leaves, debris) need their mesh
      if (p.render.mode === 4 && p.render.mesh) {
        const src = meshGlbs.get(`${p.render.mesh}.glb`);
        if (src) {
          copyIfNewer(src, path.join(outMesh, path.basename(src)));
          p.render.meshGlb = `mesh/${path.basename(src)}`;
        }
      }
      if (p.render.material) info.materials = sortedStrings(new Set([...(info.materials ?? []), p.render.material]));
    }
    if (Object.keys(particles).length) info.particles = particles;
  }

  // Runtime-assigned track meshes (TrackController configurations)
  for (const [name, info] of Object.entries(prefabs)) {
    const prefabPath = prefabFile(name);
    if (!prefabPath) continue;
    const configs = parseTrackConfigs(prefabPath, guidIndex);
    if (!Object.keys(configs).length) continue;
    for (const cfg of Object.values(configs)) {
      const src = cfg.mesh ? meshGlbs.get(`${cfg.mesh}.glb`) : null;
      if (src && existsSync(src)) {
        copyIfNewer(src, path.join(outMesh, path.basename(src)));
        cfg.glb = `mesh/${path.basename(src)}`;
      } else if (cfg.mesh) {
        missing.push(`mesh:${cfg.mesh}`);
      }
    }
    info.trackConfigs = configs;
    info.materials = sortedStrings(new Set([...(info.materials ?? []), ...Object.values(configs).flatMap((c) => c.materials)]));
  }
  empty = empty.filter((n) => !('trackConfigs' in prefabs[n]));

  // Decorations that are also modeled inside other pieces (Edinburgh's barrels in the
  // station, Buenos Aires' event streets in the buildings) are parts of those pieces,
  // positioned in place; the viewer must not scatter them on their own
  const decorations = new Set(Object.values(themes).flatMap((slots) => Object.entries(slots).filter(([slot]) => slot.startsWith('decoration_')).flatMap(([, names]) => names)));
  for (const [name, info] of Object.entries(prefabs)) {
    if (!info.glb || decorations.has(name)) continue;
    for (const node of glbJson(path.join(out, info.glb)).nodes ?? []) {
      const base = (node.name ?? '').replace(/ \(\d+\)$/, ''); // Unity's duplicate suffix
      if (decorations.has(base) && prefabs[base]) prefabs[base].embedded = true;
    }
    // 1.x: spawned into another piece's placeholder (tube sides, props on a beach)
    // (decorations themselves are checked below)
    for (const entry of Object.values(info.placeholders ?? {})) {
      for (const { name: target } of entry.prefabs) if (decorations.has(target)) prefabs[target].embedded = true;
    }
  }

  // Decorations with a wall or card across the runner's corridor (Washington's giant
  // event pieces, Arabia's flat cards): never centered over the tracks
  for (const name of decorations) {
    const info = prefabs[name];
    if (info?.glb && info.bbox && blocksCorridor(path.join(out, info.glb))) info.blocksTracks = true;
  }

  // Materials used by those prefabs
  const usedMats = new Set(Object.values(prefabs).flatMap((p) => p.materials ?? []));
  const matFiles = new Map([...byName].filter(([n]) => n.endsWith('.mat')).map(([n, p]) => [stem(n), p]));
  const materials = {};
  for (const name of sortedStrings(usedMats)) {
    if (matFiles.has(name)) materials[name] = parseMaterial(matFiles.get(name), guidIndex, root);
  }
  // The classic build's season skin (ThemeAssets): other textures on the same materials
  for (const [name, file] of classic?.textureSwaps ?? []) {
    if (materials[name]) materials[name].textures._MainTex = { ...materials[name].textures._MainTex, path: path.relative(root, file) };
  }

  // Textures referenced by materials -> data/tex/
  const outTex = path.join(out, 'tex');
  mkdirSync(outTex, { recursive: true });
  for (const mat of Object.values(materials)) {
    for (const tex of Object.values(mat.textures)) {
      if (tex.builtin) continue;
      const src = path.join(root, tex.path);
      delete tex.path;
      if (!['.png', '.jpg', '.jpeg'].includes(suffix(src).toLowerCase())) {
        tex.unsupported = path.basename(src); // e.g. cubemaps (.asset) — handled later
        continue;
      }
      copyIfNewer(src, path.join(outTex, path.basename(src)));
      tex.url = `tex/${path.basename(src)}`;
    }
  }
  for (const config of Object.values(themeConfigs)) {
    const src = config.sky?.texture;
    if (!src) continue;
    if (['.png', '.jpg', '.jpeg'].includes(suffix(src).toLowerCase())) {
      copyIfNewer(src, path.join(outTex, path.basename(src)));
      config.sky.texture = `tex/${path.basename(src)}`;
    } else delete config.sky.texture;
  }

  const settings = path.join(root, 'ExportedProject', 'ProjectSettings', 'ProjectSettings.asset');
  const bundleVersion = existsSync(settings) ? read(settings).match(/bundleVersion: (.+)/)?.[1].trim() : null;
  // Old exports (1.44) have no bundleVersion: download sites put it in the file name
  // ("com.kiloo.subwaysurf_1.44.0-70_…apk", "Subway+Surfers_3.69.2_APKPure.apk")
  const nameVersion = (sourceName ?? '').match(/(?:^|[_+\s-])(\d+\.\d+(?:\.\d+)?)(?=[-_+\s(]|\.(?:apk|xapk|zip)$|$)/i)?.[1] ?? null;
  const version = bundleVersion || nameVersion ? [null, bundleVersion || nameVersion] : null;
  const categories = ['boundary', 'track', 'special', 'obstacle', 'train', 'prop', 'other'];
  const manifest = {
    source: { name: sourceName || path.basename(root), gameVersion: version ? version[1].trim() : null },
    world: { laneWidth: 20.0, lanes: 3, cellDepth: 11.25, cellHeight: 14.0 },
    themes: Object.fromEntries(Object.entries(themes).map(([theme, slots]) => [
      theme,
      Object.fromEntries(categories.map((cat) => [
        cat,
        Object.fromEntries(sortedStrings(Object.keys(slots)).filter((s) => slotCategory(s) === cat).map((s) => [s, slots[s]])),
      ])),
    ])),
    boundaries,
    themeConfigs,
    slotDepths,
    chunks,
    prefabs,
    materials,
  };
  mkdirSync(out, { recursive: true });
  writeJson(path.join(out, 'manifest.json'), manifest);

  const shaders = {};
  for (const m of Object.values(materials)) shaders[m.shader] = (shaders[m.shader] ?? 0) + 1;
  const withKey = (key) => Object.values(prefabs).filter((p) => key in p);
  const sumKeys = (key) => withKey(key).reduce((n, p) => n + Object.keys(p[key]).length, 0);
  log(`Randomizer groups: ${sumKeys('randomizers')} in ${withKey('randomizers').length} prefabs`);
  log(`LOD1+ renderers removed: ${sumKeys('lodHidden')} in ${withKey('lodHidden').length} prefabs`);
  log(`Mesh animations: ${sumKeys('meshAnimations')} in ${withKey('meshAnimations').length} prefabs`);
  log(`Placeholders: ${sumKeys('placeholders')} in ${withKey('placeholders').length} prefabs; effect players: ${sumKeys('effectPlayers')}`);
  log(`Particle systems: ${sumKeys('particles')} in ${withKey('particles').length} prefabs`);
  log(`Prefabs: ${Object.keys(prefabs).length} (${empty.length} without geometry, ${missing.length} missing glb)`);
  log(`Materials: ${Object.keys(materials).length}/${usedMats.size} resolved; shaders: ${JSON.stringify(shaders)}`);
  if (colorFixes) log(`  vertex colors restored: ${colorFixes} mesh parts (compressed meshes)`);
  if (empty.length) log(`  no geometry: ${sortedStrings(empty).join(', ')}`);
  if (missing.length) log(`  missing glb: ${sortedStrings(missing).join(', ')}`);
  log(`Wrote ${path.join(out, 'manifest.json')}`);
  if (split) splitByTheme(manifest, out, finalOut, log);
}

/** One environment folder per theme with only the files that theme uses. */
function splitByTheme(manifest, staging, out, log) {
  for (const theme of Object.keys(manifest.themes)) {
    const config = manifest.themeConfigs[theme] ?? {};
    const names = new Set(Object.values(manifest.themes[theme]).flatMap((slots) => Object.values(slots).flat()));
    for (const t of manifest.boundaries[theme]?.transitions ?? []) names.add(t.prefab);
    for (const n of EXTRA_PREFABS) names.add(n);
    if (config.background) names.add(config.background.prefab);
    for (const e of config.effects ?? []) names.add(e.prefab);
    for (const l of config.skylineLayers?.layers ?? []) for (const n of [...l.fill, ...l.singles]) names.add(n);
    for (const n of [...names]) for (const part of manifest.prefabs[n]?.parts ?? []) names.add(part.prefab);
    for (const queue = [...names]; queue.length; ) {
      for (const entry of Object.values(manifest.prefabs[queue.pop()]?.placeholders ?? {})) {
        for (const { name } of entry.prefabs) if (!names.has(name)) names.add(name), queue.push(name);
      }
    }
    const prefabs = Object.fromEntries(sortedStrings(names).filter((n) => n in manifest.prefabs).map((n) => [n, manifest.prefabs[n]]));
    const mats = new Set(Object.values(prefabs).flatMap((p) => p.materials ?? []));
    const materials = Object.fromEntries(sortedStrings(mats).filter((m) => m in manifest.materials).map((m) => [m, manifest.materials[m]]));
    const files = new Set([
      ...Object.values(prefabs).map((p) => p.glb).filter(Boolean),
      ...Object.values(prefabs).flatMap((p) => Object.values(p.trackConfigs ?? {}).map((c) => c.glb)).filter(Boolean),
      ...Object.values(prefabs).flatMap((p) => Object.values(p.meshAnimations ?? {}).flatMap((a) => a.frames)),
      ...Object.values(prefabs).flatMap((p) => Object.values(p.particles ?? {}).map((e) => e.render.meshGlb)).filter(Boolean),
      ...Object.values(prefabs).map((p) => p.animators).filter(Boolean),
      ...Object.values(prefabs).flatMap((p) => (p.skinned ?? []).map((sk) => sk.mesh)),
      ...Object.values(prefabs).flatMap((p) => (p.morphMeshes ?? []).map((m) => m.url)),
      ...Object.values(materials).flatMap((m) => Object.values(m.textures).map((t) => t.url)).filter(Boolean),
      ...(config.sky?.texture ? [config.sky.texture] : []),
    ]);
    const dest = path.join(out, theme);
    rmSync(dest, { recursive: true, force: true });
    for (const rel of files) {
      mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
      try {
        linkSync(path.join(staging, rel), path.join(dest, rel));
      } catch {
        copyFileSync(path.join(staging, rel), path.join(dest, rel));
      }
    }
    const { themes, boundaries, themeConfigs, prefabs: _p, materials: _m, ...rest } = manifest;
    const env = {
      ...rest,
      theme,
      themes: { [theme]: themes[theme] },
      boundaries: theme in boundaries ? { [theme]: boundaries[theme] } : {},
      themeConfigs: theme in themeConfigs ? { [theme]: themeConfigs[theme] } : {},
      prefabs,
      materials,
    };
    writeJson(path.join(dest, 'manifest.json'), env);
    log(`  environment ${theme}: ${Object.keys(prefabs).length} prefabs, ${files.size} files`);
  }
  rmSync(staging, { recursive: true, force: true });
}

// ---------------------------------------------------------------- entry points

if (!isMainThread && workerData?.exportDir) {
  // server/api.js: log lines go back to the job, errors reject the worker
  buildManifest(workerData, (line) => parentPort.postMessage(line));
} else if (isMainThread && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opts = { split: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') opts.out = args[++i];
    else if (args[i] === '--split') opts.split = true;
    else if (args[i] === '--source-name') opts.sourceName = args[++i];
    else if (args[i] === '-h' || args[i] === '--help') {
      console.log('Usage: node tools/build_manifest.mjs <export> [--out <dir>] [--split] [--source-name <name>]');
      process.exit(0);
    } else opts.exportDir = args[i];
  }
  if (!opts.exportDir) {
    console.error('Usage: node tools/build_manifest.mjs <export> [--out <dir>] [--split] [--source-name <name>]');
    process.exit(2);
  }
  try {
    buildManifest(opts);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
