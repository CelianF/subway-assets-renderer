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
  }
  const bg = text.match(/BackgroundLayer:\n {4}Prefab: \{fileID: \d+, guid: (\w+)/);
  if (bg && guidIndex.has(bg[1])) {
    out.background = {
      prefab: stem(guidIndex.get(bg[1])),
      distance: number('DistanceFromPlayer'),
      tint: color('    Tint'),
      gradientA: color('GradientA'),
      gradientB: color('GradientB'),
    };
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

/** RandomChildRandomizer components: GameObject name -> activation probability.
 *
 * At runtime the game enables one random child of such a node (with that probability)
 * and disables the others; the glb export contains all of them. */
function parseRandomizers(file, guidIndex) {
  const docs = yamlDocs(read(file));
  const names = new Map();
  for (const { doc, kind, fid } of docs) {
    if (kind === '1') {
      const nm = doc.match(/m_Name: (.*)/);
      names.set(fid, nm ? nm[1].trim() : '');
    }
  }
  const out = {};
  for (const { doc } of docs) {
    if (!doc.startsWith('!u!114')) continue;
    const script = doc.match(/m_Script: .*guid: (\w+)/);
    if (!script || !guidIndex.has(script[1])) continue;
    if (stem(guidIndex.get(script[1])) !== 'RandomChildRandomizer') continue;
    const go = doc.match(/m_GameObject: \{fileID: (\d+)/);
    const prob = doc.match(/_activationProbability: ([\d.]+)/);
    if (go && names.has(go[1])) out[names.get(go[1])] = prob ? num(prob[1]) : 1.0;
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
  for (const line of lines(read(file))) {
    const s = line.trim();
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
  log(`Themes: ${Object.keys(themes).join(', ')}`);

  // Boundary transitions (tube entrances/exits, …) per theme
  const boundaries = {};
  for (const theme of Object.keys(themes)) {
    const p = find(`${theme}_Boundaries.asset`);
    if (p) boundaries[theme] = parseBoundaries(p, guidIndex);
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
  const nameLists = [...Object.values(themes).flatMap((slots) => Object.values(slots)), ...transitionPrefabs];
  for (const names of nameLists) {
    for (const name of names) {
      if (name in prefabs) continue;
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
  for (const [name, info] of Object.entries(prefabs)) {
    const prefabPath = prefabFile(name);
    if (!prefabPath || !info.glb) continue;
    const randomizers = parseRandomizers(prefabPath, guidIndex);
    if (Object.keys(randomizers).length) info.randomizers = randomizers;
    const lodHidden = parseLodGroups(prefabPath);
    if (lodHidden.length) info.lodHidden = lodHidden;
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
  }

  // Materials used by those prefabs
  const usedMats = new Set(Object.values(prefabs).flatMap((p) => p.materials ?? []));
  const matFiles = new Map([...byName].filter(([n]) => n.endsWith('.mat')).map(([n, p]) => [stem(n), p]));
  const materials = {};
  for (const name of sortedStrings(usedMats)) {
    if (matFiles.has(name)) materials[name] = parseMaterial(matFiles.get(name), guidIndex, root);
  }

  // Textures referenced by materials -> data/tex/
  const outTex = path.join(out, 'tex');
  mkdirSync(outTex, { recursive: true });
  for (const mat of Object.values(materials)) {
    for (const tex of Object.values(mat.textures)) {
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

  const settings = path.join(root, 'ExportedProject', 'ProjectSettings', 'ProjectSettings.asset');
  const version = existsSync(settings) ? read(settings).match(/bundleVersion: (.+)/) : null;
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
  log(`Prefabs: ${Object.keys(prefabs).length} (${empty.length} without geometry, ${missing.length} missing glb)`);
  log(`Materials: ${Object.keys(materials).length}/${usedMats.size} resolved; shaders: ${JSON.stringify(shaders)}`);
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
    const prefabs = Object.fromEntries(sortedStrings(names).filter((n) => n in manifest.prefabs).map((n) => [n, manifest.prefabs[n]]));
    const mats = new Set(Object.values(prefabs).flatMap((p) => p.materials ?? []));
    const materials = Object.fromEntries(sortedStrings(mats).filter((m) => m in manifest.materials).map((m) => [m, manifest.materials[m]]));
    const files = new Set([
      ...Object.values(prefabs).map((p) => p.glb).filter(Boolean),
      ...Object.values(prefabs).flatMap((p) => Object.values(p.trackConfigs ?? {}).map((c) => c.glb)).filter(Boolean),
      ...Object.values(prefabs).flatMap((p) => Object.values(p.meshAnimations ?? {}).flatMap((a) => a.frames)),
      ...Object.values(materials).flatMap((m) => Object.values(m.textures).map((t) => t.url)).filter(Boolean),
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
