import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FlyControls } from './flyControls.js';
import { prepareCutaway, registerPiece, updatePieces, cutawayDebug, largestIslandCenter } from './cutaway.js';
import { MaterialLibrary, setBendDegrees, globals, setFog, createSky, setTrackCuts, setReversedDepth } from './materials.js';
import { generateLayout, mulberry32, DEFAULT_GEN, itemsToStudio, studioCatalog, TRAIN_VARIANTS, buildingPieces } from './layout.js';
import { createSettings, createWorkbar } from './settings.js';
import { createStudio } from './studio.js';
import { createUI } from './ui.js';
import { addCredit } from './credit.js';

const params = new URLSearchParams(location.search);
addCredit();
// One environment (= one map) per page; maps are picked on the home page
const ENV_ID = params.get('env');
if (!ENV_ID) location.replace('/');
const DATA = `/envs/${encodeURIComponent(ENV_ID)}`;

// ---------------------------------------------------------------- scene

const canvas = document.getElementById('view');
// Reversed depth with a 32-bit float depth buffer keeps precision nearly constant down the
// whole run, so near-coplanar surfaces far away stop z-fighting. The canvas's own depth
// buffer is 24-bit fixed point, so the scene renders offscreen (viewTarget) and is copied.
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: params.has('shot'), reversedDepthBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
setReversedDepth(renderer.capabilities.reversedDepthBuffer);

/** Multisampled render target with a float depth buffer. */
function floatDepthTarget(width, height) {
  const target = new THREE.WebGLRenderTarget(width, height, { samples: 4, depthTexture: new THREE.DepthTexture(width, height, THREE.FloatType) });
  target.resolveDepthBuffer = false; // only the depth format matters, never read back
  return target;
}
const drawingSize = renderer.getDrawingBufferSize(new THREE.Vector2());
const viewTarget = floatDepthTarget(drawingSize.x, drawingSize.y);
// Copies the offscreen view to the canvas as-is (gamma workflow: values are already final)
const blitScene = new THREE.Scene();
const blitCamera = new THREE.OrthographicCamera(); // unused by the shader; reversed depth needs updateProjectionMatrix()
const blit = new THREE.Mesh(
  new THREE.PlaneGeometry(2, 2),
  new THREE.ShaderMaterial({
    uniforms: { uMap: { value: viewTarget.texture } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: 'uniform sampler2D uMap; varying vec2 vUv; void main() { gl_FragColor = texture2D(uMap, vUv); }',
    depthTest: false,
    depthWrite: false,
  }),
);
blit.frustumCulled = false;
blitScene.add(blit);

const scene = new THREE.Scene();
// Theme skybox gradient, drawn as a full-screen quad behind everything (gamma workflow)
const sky = createSky();
scene.add(sky);

// near = 2 (not 1) doubles depth precision; distant coplanar details z-fight less
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 2, 8000);
const orbit = new OrbitControls(camera, canvas);
orbit.enableDamping = true;
const fly = new FlyControls(camera, canvas);

const CAMERA_PRESETS = {
  // camConfig_Run: offset (0, 33, -33) from the runner (placed 90 into the run), FOV 68
  game: { pos: [0, 33, 57], target: [0, 9, 120], fov: 68 },
  overview: { pos: [420, 380, -200], target: [0, 0, 500], fov: 55 },
  side: { pos: [260, 60, 300], target: [0, 20, 300], fov: 55 },
};

function applyCamera(name) {
  const p = CAMERA_PRESETS[name];
  // Side view starts inside the left-hand buildings: cut them away
  state.cutaway = name === 'side';
  camera.position.set(...p.pos);
  camera.lookAt(...p.target);
  if (p.fov) {
    state.fov = camera.fov = p.fov;
    camera.updateProjectionMatrix();
  }
  settings?.refresh();
  orbit.target.set(...p.target);
  if (orbit.enabled) orbit.update();
}

function setControlMode(mode) {
  fly.enabled = mode === 'fly';
  orbit.enabled = mode === 'orbit';
  if (orbit.enabled) {
    // Orbit around a point in front of the camera so switching doesn't jump
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    orbit.target.copy(camera.position).addScaledVector(forward, 150);
    orbit.update();
  }
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  renderer.getDrawingBufferSize(globals.uResolution.value);
  viewTarget.setSize(globals.uResolution.value.x, globals.uResolution.value.y);
});
renderer.getDrawingBufferSize(globals.uResolution.value);

const status = document.getElementById('status');

// ---------------------------------------------------------------- assets

const manifestRes = await fetch(`${DATA}/manifest.json`);
if (!manifestRes.ok) location.replace('/');
const manifest = await manifestRes.json();
const envList = await (await fetch('/api/envs')).json().catch(() => []);
const envInfo = envList.find((e) => e.id === ENV_ID) ?? { id: ENV_ID, theme: manifest.theme };
document.title = `${envInfo.theme} · Subway Viewer`;
const materials = new MaterialLibrary(manifest, DATA);

/**
 * Merges another environment's trains into this manifest ("trains from" option).
 * Its file paths become absolute so they load from that environment's folder.
 */
const mergedEnvs = new Set();
async function mergeEnvironment(envId) {
  if (mergedEnvs.has(envId)) return;
  const base = `/envs/${encodeURIComponent(envId)}`;
  const other = await (await fetch(`${base}/manifest.json`)).json();
  const abs = (url) => (url && !url.startsWith('/') ? `${base}/${url}` : url);
  for (const [name, prefab] of Object.entries(other.prefabs)) {
    if (manifest.prefabs[name]) continue;
    const copy = structuredClone(prefab);
    copy.glb = abs(copy.glb);
    for (const cfg of Object.values(copy.trackConfigs ?? {})) cfg.glb = abs(cfg.glb);
    manifest.prefabs[name] = copy;
  }
  for (const [name, mat] of Object.entries(other.materials)) {
    if (manifest.materials[name]) continue;
    const copy = structuredClone(mat);
    for (const t of Object.values(copy.textures)) t.url = abs(t.url);
    manifest.materials[name] = copy;
  }
  manifest.themes[other.theme] = other.themes[other.theme];
  mergedEnvs.add(envId);
}

/** Relative manifest paths live in this environment's folder; merged ones are absolute. */
const dataUrl = (url) => (url.startsWith('/') ? url : `${DATA}/${url}`);
const loader = new GLTFLoader();
const glbCache = new Map();

// Triangles entirely at or below this height (piece space) count as floor
const FLOOR_Y = 3;

/** Loads a glb once; `cutaway` prepares it for hiding islands around the camera. */
function loadGlb(url, { cutaway = null } = {}) {
  const key = `${url}|${cutaway}`;
  if (!glbCache.has(key)) {
    glbCache.set(
      key,
      loader.loadAsync(dataUrl(url)).then((g) => {
        prepareGeometry(g.scene);
        if (cutaway) prepareCutaway(g.scene, cutaway === 'floor' ? FLOOR_Y : -Infinity);
        return g.scene;
      }),
    );
  }
  return glbCache.get(key);
}

/**
 * The exported meshes have no normals (reflections/rim need them) and vertex-color
 * materials may land on meshes without colors (unset attributes read as black).
 */
function prepareGeometry(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    const geo = o.geometry;
    if (!geo.attributes.normal) geo.computeVertexNormals();
    const wantsColors = manifest.materials[o.material?.name]?.floats?._HasVertexColors;
    if (wantsColors && !geo.attributes.color) {
      geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 3).fill(1), 3));
    }
  });
}

/**
 * Looks up a loaded node in a table keyed by Unity GameObject names. GLTFLoader
 * sanitizes names ("Wagon (1)" -> "Wagon_(1)") and suffixes duplicates ("_low" -> "_low_1").
 */
function nodeKey(table, name) {
  if (name in table) return name;
  const base = name.replace(/_\d+$/, '');
  return base in table ? base : null;
}

function sanitizedTable(entries) {
  return Object.fromEntries(entries.map(([k, v]) => [THREE.PropertyBinding.sanitizeNodeName(k), v]));
}

/** Keeps LOD0 only: the export contains every LODGroup level, which overlap and z-fight. */
function removeLowLods(obj, lodHidden = []) {
  const hidden = sanitizedTable(lodHidden.map((n) => [n, true]));
  const remove = [];
  // A "X_low" next to a "X_high" sibling is a LOD pair even when its LODGroup lives in
  // a nested prefab the export dropped (e.g. train ramps)
  // Skipped when the LODGroup data already hid the "_high" one (some themes swap the names)
  const lowWithHigh = (o) => {
    const m = o.name.match(/^(.*)_low(_\d+)?$/);
    if (!m || nodeKey(hidden, `${m[1]}_high`)) return false;
    return o.parent?.children.some((c) => c.name.replace(/_\d+$/, '') === `${m[1]}_high`);
  };
  obj.traverse((o) => (nodeKey(hidden, o.name) || /_LOD[1-9](_\d+)?$/.test(o.name) || lowWithHigh(o)) && remove.push(o));
  remove.forEach((o) => o.removeFromParent());
}

/**
 * Mimics the game's RandomChildRandomizer: with probability p one random child
 * stays, all others are removed (the export contains every variant at once).
 */
function applyRandomizers(obj, randomizers, seed) {
  const rng = mulberry32(seed);
  const table = sanitizedTable(Object.entries(randomizers));
  const groups = [];
  obj.traverse((o) => nodeKey(table, o.name) && groups.push(o));
  for (const group of groups) {
    const children = [...group.children];
    const keep = rng() < table[nodeKey(table, group.name)] ? children[Math.floor(rng() * children.length)] : null;
    for (const child of children) if (child !== keep) child.removeFromParent();
  }
}

/**
 * Signal lights show red or green. Themes whose signal has both lights keep one;
 * London-style signals only carry the red light, so green swaps in the green light
 * mesh on the lower lamp of the housing.
 */
async function applySignalColor(obj, seed, color = null) {
  const rng = mulberry32(seed);
  let red = null;
  let green = null;
  obj.traverse((o) => {
    if (o.name.startsWith('_Common_LightSignal_Light_Red')) red ??= o;
    if (o.name.startsWith('_Common_LightSignal_Light_Green')) green ??= o;
  });
  const wantGreen = color ? color === 'green' : rng() < 0.5;
  if (color === 'off') {
    red?.removeFromParent();
    green?.removeFromParent();
    return;
  }
  if (red && green) {
    (wantGreen ? red : green).removeFromParent();
  } else if (red && wantGreen && manifest.prefabs._Common_LightSignal_Light_Green?.glb) {
    const light = (await loadGlb(manifest.prefabs._Common_LightSignal_Light_Green.glb)).clone();
    light.position.copy(red.position);
    light.position.y -= 11.3; // red lamp -> green lamp in the single-light housing
    light.quaternion.copy(red.quaternion);
    light.scale.copy(red.scale);
    light.traverse((o) => o.isMesh && applyMaterial(o, materials.get(o.material.name, o.material)));
    red.parent.add(light);
    red.removeFromParent();
  }
}

function applyMaterial(mesh, mat) {
  // Unity's untextured placeholder material: helper geometry never visible in game
  if (mat.name === 'DefaultMaterial') mesh.visible = false;
  mesh.material = mat;
  mesh.renderOrder = mat.userData.renderQueue ?? 2000;
}

/** Instantiates a prefab (or one of its runtime track configs) with manifest materials. */
async function instantiate(name, trackType, layer, variantSeed = 1, signalSeed = null, signalColor = null, cutMode = null) {
  // Rails hide inside studio "no tracks" zones; fill ground only shows inside them
  const cut = layer === 'track' ? (cutMode === 'inside' ? 2 : 1) : 0;
  const prefab = manifest.prefabs[name];
  // Runtime track meshes; old games leave the table empty and model the rails in the prefab
  const config = trackType && prefab.trackConfigs?.[trackType]?.glb ? prefab.trackConfigs[trackType] : null;
  if (config) {
    const obj = (await loadGlb(config.glb)).clone();
    let i = 0;
    obj.traverse((o) => {
      if (o.isMesh) applyMaterial(o, materials.get(config.materials[i++] ?? config.materials[0], o.material, cut));
    });
    return obj;
  }
  if (!prefab?.glb || !prefab.bbox) return null;
  const cutaway = layer === 'environment' ? 'floor' : layer === 'track' ? null : 'all';
  const obj = (await loadGlb(prefab.glb, { cutaway })).clone();
  removeLowLods(obj, prefab.lodHidden);
  if (prefab.randomizers) applyRandomizers(obj, prefab.randomizers, variantSeed);
  obj.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const out = mats.map((m) => materials.get(m.name, m, cut));
    if (out.length === 1) applyMaterial(o, out[0]);
    else o.material = out;
  });
  if (signalSeed != null) await applySignalColor(obj, signalSeed, signalColor);
  return obj;
}

// ---------------------------------------------------------------- run

const state = {
  theme: manifest.theme ?? Object.keys(manifest.themes)[0],
  seed: Number(params.get('seed') ?? 1),
  sections: Number(params.get('sections') ?? 12),
  obstacles: params.get('obstacles') !== '0',
  trains: params.get('trains') !== '0',
  signals: params.get('signals') !== '0',
  walls: params.get('walls') !== '0',
  trainEnv: 'same', // environment id whose trains are used
  fog: params.get('fog') !== '0',
  fogScale: Number(params.get('fogScale') ?? 1),
  glass: 1,
  skyline: true,
  skylineOpacity: 1,
  skylineDistance: 1,
  obstacleMode: params.get('obstacleMode') ?? 'random',
  inspect: params.get('prefab')?.split(',') ?? null, // prefab names shown alone, or null for the run
  altColors: Number(params.get('altColors') ?? 0),
  camera: params.get('cam') ?? 'game',
  controls: 'fly',
  cutaway: false,
  bend: Number(params.get('bend') ?? 0),
  bendVertical: Number(params.get('bendV') ?? 0),
  fov: 55,
  gen: structuredClone(DEFAULT_GEN),
  studio: loadStudio(),
};

// Studio placements are kept per environment in this browser
function loadStudio() {
  try {
    return JSON.parse(localStorage.getItem(`studio:${ENV_ID}`) ?? '[]');
  } catch {
    return [];
  }
}
function saveStudio() {
  try {
    localStorage.setItem(`studio:${ENV_ID}`, JSON.stringify(state.studio));
  } catch {
    // storage full or blocked: placements still live for this session
  }
}

const layers = {
  environment: new THREE.Group(),
  track: new THREE.Group(),
  train: new THREE.Group(),
  obstacle: new THREE.Group(),
  wall: new THREE.Group(), // gate walls, open on one lane
  signal: new THREE.Group(),
  effect: new THREE.Group(), // ThemeConfig effects (Floor Is Lava's lava ground)
};
Object.values(layers).forEach((g) => scene.add(g));
let buildId = 0;

// Rebuilt on studio edits; rails too, since "no tracks" zones cut them
const DYNAMIC_LAYERS = new Set(['train', 'obstacle', 'signal', 'wall', 'track']);
let runLength = 0;

/** Current layout for the given mode (studio placements or generated obstacles). */
function currentLayout(mode = state.obstacleMode) {
  return generateLayout(manifest, state.theme, { ...state, obstacleMode: mode, trainTheme: trainTheme() });
}

/**
 * Builds the run. `dynamicOnly` re-creates only trains/obstacles/signals/walls: the
 * environment is deterministic for a seed, so studio edits don't reload the city.
 */
async function rebuild({ dynamicOnly = false } = {}) {
  const id = ++buildId;
  // Inspection: only the given pieces, side by side along X
  const only = state.inspect;
  const layout = only ? { items: inspectLayout(only), length: 0 } : currentLayout();
  const { length } = layout;
  const items = dynamicOnly ? layout.items.filter((i) => DYNAMIC_LAYERS.has(i.layer)) : layout.items;
  setTrackCuts(state.obstacleMode === 'studio' && !only ? state.studio.filter((it) => it.type === 'noTracks') : []);
  applyThemeLook();
  if (!dynamicOnly) status.textContent = `Loading ${state.theme}…`;
  const objs = await Promise.all(
    items.map(async (it) => {
      try {
        const obj = await instantiate(it.prefab, it.trackType, it.layer, it.variantSeed, it.signalSeed, it.signalColor, it.cut);
        if (obj) {
          obj.position.set(...it.pos);
          if (it.scale) obj.scale.setScalar(it.scale);
        }
        return [it, obj];
      } catch (e) {
        console.warn('Failed to load', it.prefab, e);
        return [it, null];
      }
    }),
  );
  if (id !== buildId) return; // superseded by a newer rebuild
  if (window.__viewer) window.__viewer.items = layout.items;
  runLength = length;
  for (const [name, g] of Object.entries(layers)) if (!dynamicOnly || DYNAMIC_LAYERS.has(name)) g.clear();
  for (const [it, obj] of objs) {
    if (!obj) continue;
    layers[it.layer].add(obj);
    if (it.layer !== 'track') {
      registerPiece(obj, { openBacks: it.layer === 'environment', whole: it.layer === 'train', group: it.group });
    }
  }
  if (!only && !dynamicOnly) await addThemeEffects(length, id);
  updateVisibility();
  applyBend();
  const missing = objs.filter(([, o]) => !o).length;
  status.textContent = only
    ? `Inspecting ${only.length} piece${only.length > 1 ? 's' : ''}`
    : `${state.theme} · seed ${state.seed} · ${layout.items.length} pieces · ${Math.round(length)} units${missing ? ` · ${missing} without geometry` : ''}`;
  studio?.relayout();
  ui?.themeChanged(state.theme);
  ui?.setInspecting(only);
  if (only) frameInspection(items);
  else ui?.themeLoaded(state.theme);
  window.__ready = true;
}

/**
 * ThemeConfig effects: segmented grounds the game leapfrogs under the runner
 * (Floor Is Lava's lava). Laid out statically over the whole run here.
 */
async function addThemeEffects(length, id) {
  for (const effect of manifest.themeConfigs?.[state.theme]?.effects ?? []) {
    const prefab = manifest.prefabs[effect.prefab];
    if (!prefab?.glb || !effect.segments.length) continue;
    const root = await loadGlb(prefab.glb);
    if (id !== buildId) return;
    const segment = root.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(effect.segments[0]));
    if (!segment) continue;
    segment.traverse((o) => o.isMesh && applyMaterial(o, materials.get(o.material.name, o.material)));
    for (let z = -effect.segmentSize; z < length + effect.segmentSize; z += effect.segmentSize) {
      const copy = segment.clone();
      copy.position.set(0, segment.position.y, z);
      layers.effect.add(copy);
    }
  }
}

/** Theme whose trains are used: this map's, or a merged environment's. */
function trainTheme() {
  if (state.trainEnv === 'same') return null;
  return envList.find((e) => e.id === state.trainEnv)?.theme ?? null;
}

/** Pieces for inspection, spaced by their width so they don't overlap. */
function inspectLayout(names) {
  if (state.inspectTogether) return names.map((prefab) => ({ prefab, layer: 'environment', pos: [0, 0, 0], variantSeed: state.seed }));
  let x = 0;
  return names.map((prefab) => {
    const bb = manifest.prefabs[prefab]?.bbox ?? [[-50, 0, 0], [50, 0, 0]];
    const pos = [x - bb[0][0], 0, 0];
    x += bb[1][0] - bb[0][0] + 20;
    return { prefab, layer: 'environment', pos, variantSeed: state.seed };
  });
}

/** Orbit camera around the inspected pieces. */
function frameInspection(items) {
  const box = new THREE.Box3();
  for (const it of items) {
    const bb = manifest.prefabs[it.prefab]?.bbox;
    if (!bb) continue;
    box.expandByPoint(new THREE.Vector3(...bb[0]).add(new THREE.Vector3(...it.pos)));
    box.expandByPoint(new THREE.Vector3(...bb[1]).add(new THREE.Vector3(...it.pos)));
  }
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2;
  state.controls = 'orbit';
  setControlMode('orbit');
  // Side buildings face the track: look at them from the track side
  const side = Math.abs(center.x) > 15 ? -Math.sign(center.x) : 1;
  camera.position.copy(center).add(new THREE.Vector3(0.7 * side, 0.45, -0.7).normalize().multiplyScalar(radius * 2.2));
  orbit.target.copy(center);
  orbit.update();
  settings?.refresh();
}

const CUTAWAY_LAYERS = ['environment', 'train', 'obstacle', 'wall', 'signal'];

// ---------------------------------------------------------------- theme look

const skylineGroup = new THREE.Group();
const skylineUniforms = { uOpacity: { value: 1 } };
scene.add(skylineGroup);
let skylineTheme = null;

/** Fog, sky and skyline from the theme's ThemeConfig. */
function applyThemeLook() {
  const cfg = manifest.themeConfigs?.[state.theme] ?? {};
  // No fog/skyline while inspecting: the camera frames pieces from far away
  // (nor in the studio's top view, 600 units above the run)
  setFog(cfg.fog, state.fog && !state.inspect && !studio?.active, state.fogScale);
  sky.setColors(cfg.sky);
  if (skylineTheme !== state.theme) {
    skylineTheme = state.theme;
    skylineGroup.clear();
    if (cfg.background) loadSkyline(cfg.background);
  }
  skylineGroup.visible = state.skyline && state.skylineOpacity > 0 && !state.inspect;
  skylineUniforms.uOpacity.value = state.skylineOpacity;
  globals.uAltRatio.value = state.altColors;
}

/**
 * BackgroundLayer: a skyline silhouette kept at a fixed distance ahead of the camera,
 * colored with the config's vertical gradient (ColorMode 1) and unaffected by fog.
 */
async function loadSkyline(bg) {
  const prefab = manifest.prefabs[bg.prefab];
  if (!prefab?.glb || !prefab.bbox) return;
  const obj = (await loadGlb(prefab.glb)).clone();
  const [lo, hi] = prefab.bbox;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uA: { value: new THREE.Vector3(...(bg.gradientA ?? [1, 1, 1])) },
      uB: { value: new THREE.Vector3(...(bg.gradientB ?? [1, 1, 1])) },
      uTint: { value: new THREE.Vector3(...(bg.tint ?? [1, 1, 1])) },
      uRange: { value: new THREE.Vector2(Math.max(lo[1], 0), hi[1]) },
      ...skylineUniforms,
      ...globals, // fog color: a faded skyline melts into the haze
    },
    vertexShader: `varying float vY; void main() { vY = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 uA; uniform vec3 uB; uniform vec3 uTint; uniform vec2 uRange; uniform float uOpacity; varying float vY;
      void main() { float t = clamp((vY - uRange.x) / max(uRange.y - uRange.x, 1.0), 0.0, 1.0);
        gl_FragColor = vec4(mix(uB, uA, t) * mix(vec3(1.0), uTint, 0.35), uOpacity); }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  obj.traverse((o) => {
    if (o.isMesh) {
      o.material = mat;
      o.frustumCulled = false;
      o.renderOrder = -1000; // behind the level, in front of the sky
    }
  });
  obj.userData.distance = bg.distance ?? 1000;
  skylineGroup.add(obj);
}

function updateSkyline() {
  for (const obj of skylineGroup.children) obj.position.set(0, 0, camera.position.z + obj.userData.distance * state.skylineDistance);
}

/** Hides the geometry islands (buildings, train cars, …) the camera is inside. */
function updateCutaway() {
  updatePieces(CUTAWAY_LAYERS.flatMap((layer) => layers[layer].children), state.cutaway ? camera.position : null);
}

function applyBend() {
  // The studio's top view needs the run straight
  if (studio?.active) setBendDegrees(0, 0);
  else setBendDegrees(state.bend, state.bendVertical);
  // Bent geometry can appear outside its unbent bounds: skip frustum culling while bending
  const culled = state.bend === 0 && state.bendVertical === 0;
  Object.values(layers).forEach((g) => g.traverse((o) => o.isMesh && (o.frustumCulled = culled))); // not the sky/skyline
}

function updateVisibility() {
  // Everything placed is shown; what is placed is decided in the studio
  layers.train.visible = state.trains;
  layers.obstacle.visible = state.obstacles;
  layers.signal.visible = state.signals;
  layers.wall.visible = true; // gate walls are part of the gate section
}

// ---------------------------------------------------------------- screenshot

const RESOLUTIONS = {
  window: null,
  '1080p': [1920, 1080],
  '1440p': [2560, 1440],
  '4K': [3840, 2160],
  '8K': [7680, 4320],
};
const screenshot = { resolution: '4K', transparent: false };

/** Renders the scene offscreen at the chosen resolution (no UI) into a 2D canvas. */
function renderScreenshot() {
  const [w, h] = RESOLUTIONS[screenshot.resolution] ?? [canvas.width, canvas.height];
  const max = renderer.capabilities.maxRenderbufferSize ?? renderer.capabilities.maxTextureSize;
  const scale = Math.min(1, max / Math.max(w, h));
  const width = Math.floor(w * scale);
  const height = Math.floor(h * scale);

  // Raw RGBA8: shaders already output gamma-space values
  const target = floatDepthTarget(width, height);
  const shotCam = camera.clone();
  shotCam.aspect = width / height;
  shotCam.updateProjectionMatrix();

  sky.visible = !screenshot.transparent;
  const screenRes = globals.uResolution.value.clone();
  globals.uResolution.value.set(width, height);
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, screenshot.transparent ? 0 : 1);
  renderer.clear();
  renderer.render(scene, shotCam);
  const pixels = new Uint8Array(width * height * 4);
  renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
  renderer.setRenderTarget(null);
  renderer.setClearColor(0x000000, 1);
  sky.visible = true;
  globals.uResolution.value.copy(screenRes);
  target.dispose();

  // WebGL rows are bottom-up; flip into a 2D canvas
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  const img = ctx.createImageData(width, height);
  const row = width * 4;
  for (let y = 0; y < height; y++) img.data.set(pixels.subarray((height - 1 - y) * row, (height - y) * row), y * row);
  ctx.putImageData(img, 0, 0);
  return out;
}

/** Screenshot as a PNG blob plus a descriptive file name (the UI downloads and lists it). */
async function screenshotBlob() {
  const out = renderScreenshot();
  const blob = await new Promise((r) => out.toBlob(r, 'image/png'));
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const what = state.inspect ? state.inspect[0] : `${state.theme}_seed${state.seed}`;
  return { blob, name: `subway_${what}_${stamp}.png`, width: out.width, height: out.height };
}

/** Small JPEG of the theme from the game camera, for the theme bar. */
function themeThumbnail() {
  const saved = { pos: camera.position.clone(), quat: camera.quaternion.clone(), fov: camera.fov, res: screenshot.resolution };
  const p = CAMERA_PRESETS.game;
  camera.position.set(...p.pos);
  camera.lookAt(...p.target);
  camera.fov = p.fov;
  camera.updateProjectionMatrix();
  updateSkyline();
  RESOLUTIONS.thumb = [320, 180];
  screenshot.resolution = 'thumb';
  let url = null;
  try {
    url = renderScreenshot().toDataURL('image/jpeg', 0.7);
  } finally {
    delete RESOLUTIONS.thumb;
    screenshot.resolution = saved.res;
    camera.position.copy(saved.pos);
    camera.quaternion.copy(saved.quat);
    camera.fov = saved.fov;
    camera.updateProjectionMatrix();
  }
  return url;
}

// ---------------------------------------------------------------- UI

const trainOptions = () => {
  const o = { 'This map': 'same' };
  for (const e of envList) if (e.id !== ENV_ID) o[`${e.theme} (v${e.gameVersion})`] = e.id;
  return o;
};
const shuffle = () => {
  state.seed = Math.floor(Math.random() * 9999) + 1;
  rebuild();
  generation.refresh();
};
const regen = () => rebuild();
const catalog = () => studioCatalog(manifest, state.theme, trainTheme());
// "low_01" -> "Low 01" ("med" pieces read as "Medium")
const pieceLabel = (key) => key.replace(/^med_/, 'medium_').replace(/^(\w)/, (c) => c.toUpperCase()).replace('_', ' ');
for (const piece of buildingPieces(manifest, state.theme)) state.gen.pieces[piece.key] ??= true;
const toggles = (obj, entries, onChange = regen) => entries.filter(([, , show = true]) => show).map(([key, label]) => ({ type: 'toggle', label, obj, key, onChange }));
const hasSlot = (slot) => Object.values(manifest.themes[state.theme]).some((c) => c[slot]?.length);
const isAuto = () => state.obstacleMode !== 'studio';

// Generation: its own panel (toolbar button), what the run is made of
const generation = createSettings(
  document.getElementById('ui'),
  [
    {
      tab: 'Generation',
      groups: [
        {
          title: 'Run',
          controls: [
            { type: 'slider', label: 'Seed', obj: state, key: 'seed', min: 1, max: 9999, step: 1, lazy: true, onChange: regen },
            { type: 'button', label: '🎲 Shuffle', action: shuffle },
            { type: 'slider', label: 'Sections', obj: state, key: 'sections', min: 1, max: 40, step: 1, lazy: true, onChange: regen },
            { type: 'select', label: 'Trains from', obj: state, key: 'trainEnv', options: trainOptions, onChange: async (id) => (id !== 'same' && (await mergeEnvironment(id)), regen()) },
          ],
        },
        {
          title: 'Map sections',
          controls: toggles(state.gen.sections, [
            ['buildings', 'Buildings'],
            ['station', 'Stations', hasSlot('boundary_station_mid')],
            ['tube', 'Tubes', hasSlot('boundary_tube')],
            ['pillars', 'Pillar halls', hasSlot('boundary_pillars_mid')],
            ['gate', 'Gates', hasSlot('boundary_gate')],
            ['epic', 'Landmark', hasSlot('boundary_epic_start')],
          ]),
        },
        {
          title: 'Building pieces',
          visible: () => state.gen.sections.buildings !== false,
          controls: [
            ...buildingPieces(manifest, state.theme).map((piece) => ({
              type: 'toggle',
              label: pieceLabel(piece.key),
              obj: state.gen.pieces,
              key: piece.key,
              onChange: regen,
              extra: { label: '👁', title: 'Preview this piece', action: () => (generation.close(), inspectPieces(piece.prefabs, { together: true })) },
            })),
            { type: 'button', label: 'All pieces', action: () => (Object.keys(state.gen.pieces).forEach((k) => (state.gen.pieces[k] = true)), regen(), generation.refresh()) },
          ],
        },
      ],
    },
  ],
  { title: 'Generation' },
);

// Rendering: studio-like bar at the bottom, so the scene stays visible while tuning
const rendering = createWorkbar(
  document.getElementById('ui'),
  [
    {
      title: 'Atmosphere',
      columns: [
        {
          title: 'Fog',
          controls: [
            { type: 'toggle', label: 'Enabled', obj: state, key: 'fog', onChange: applyThemeLook },
            { type: 'slider', label: 'Distance ×', obj: state, key: 'fogScale', min: 0.25, max: 6, step: 0.05, onChange: applyThemeLook },
          ],
        },
        {
          title: 'Skyline',
          controls: [
            { type: 'toggle', label: 'Enabled', obj: state, key: 'skyline', onChange: applyThemeLook },
            { type: 'slider', label: 'Opacity', obj: state, key: 'skylineOpacity', min: 0, max: 1, step: 0.01, onChange: applyThemeLook },
            { type: 'slider', label: 'Distance ×', obj: state, key: 'skylineDistance', min: 0.3, max: 3, step: 0.05, onChange: applyThemeLook },
          ],
        },
      ],
    },
    {
      title: 'Bend',
      columns: [
        {
          title: 'Horizontal (− left / + right)',
          controls: [{ type: 'slider', label: 'Degrees', obj: state, key: 'bend', min: -45, max: 45, step: 0.5, onChange: applyBend }],
        },
        {
          title: 'Vertical (+ down)',
          controls: [{ type: 'slider', label: 'Degrees', obj: state, key: 'bendVertical', min: -30, max: 30, step: 0.5, onChange: applyBend }],
        },
        {
          title: 'Reset',
          controls: [{ type: 'button', label: 'Straight', action: () => ((state.bend = state.bendVertical = 0), applyBend(), rendering.refresh()) }],
        },
      ],
    },
    {
      title: 'Materials',
      columns: [
        {
          title: 'Glass',
          controls: [{ type: 'slider', label: 'Opacity', obj: state, key: 'glass', min: 0, max: 1, step: 0.01, onChange: (v) => materials.setGlassOpacity(v) }],
        },
        {
          title: 'Alternate colors (New York)',
          controls: [{ type: 'slider', label: 'Amount', obj: state, key: 'altColors', min: 0, max: 1, step: 0.01, onChange: (v) => (globals.uAltRatio.value = v) }],
        },
      ],
    },
  ],
  { title: '🎨 Rendering' },
);

const settings = createSettings(
  document.getElementById('ui'),
  [
    {
      tab: 'Camera',
      groups: [
        {
          controls: [
            { type: 'button', label: '🎥 Reset to game camera', action: () => (applyCamera('game'), settings.refresh()) },
            { type: 'toggle', label: 'Hide piece around camera', obj: state, key: 'cutaway' },
            { type: 'slider', label: 'Fly speed', hint: '− / =', obj: fly, key: 'speed', min: 5, max: 3000, step: 1 },
            { type: 'slider', label: 'Field of view', hint: 'wheel', obj: state, key: 'fov', min: 20, max: 110, step: 1, onChange: setFov },
            { type: 'note', label: 'Drag: look · WASD: move · Space/Shift: up/down · Ctrl: sprint · −/=: speed · Wheel: field of view' },
          ],
        },
      ],
    },
    {
      tab: 'Screenshot',
      groups: [
        {
          controls: [
            { type: 'select', label: 'Resolution', obj: screenshot, key: 'resolution', options: Object.fromEntries(Object.keys(RESOLUTIONS).map((k) => [k, k])) },
            { type: 'toggle', label: 'Transparent background', obj: screenshot, key: 'transparent' },
            { type: 'button', label: '📷 Save screenshot (P)', primary: true, action: () => (settings.close(), ui.takeShot()) },
          ],
        },
      ],
    },
  ],
  { title: 'Settings' },
);
fly.onSpeedChange = () => settings.refresh();
fly.onWheel = (deltaY) => setFov(THREE.MathUtils.clamp(state.fov + (deltaY > 0 ? 2 : -2), 20, 110));

function setFov(v) {
  state.fov = camera.fov = v;
  camera.updateProjectionMatrix();
  if (settings.isOpen()) settings.refresh();
}

/** Shows only the given prefabs (piece browser, 👁 previews); "Back to run" restores the run. */
function inspectPieces(names, { together = false } = {}) {
  state.inspect = names;
  state.inspectTogether = together; // a building's left + right halves, assembled in place
  rebuild();
}

// ---------------------------------------------------------------- studio

const studio = createStudio({
  scene,
  renderer,
  canvas,
  root: document.getElementById('ui'),
  getCatalog: catalog,
  getLength: () => runLength,
  getList: () => state.studio,
  setList: (list) => {
    state.studio = list;
    saveStudio();
    rebuild({ dynamicOnly: true });
  },
  fromRun: () => itemsToStudio(currentLayout('random').items),
  // Skin of a train placed with "Any" before skins were fixed at placement
  actualVariant: (it) => {
    const shown = window.__viewer?.items?.find((i) => i.group === `studio${it.lane}@${it.z0}` && i.slot.startsWith('train_') && i.slot !== 'train_ramp');
    return shown ? Object.keys(TRAIN_VARIANTS).find((v) => TRAIN_VARIANTS[v].test(shown.prefab)) ?? null : null;
  },
  onExit: () => exitStudio(),
});

function enterStudio() {
  settings.close();
  generation.close();
  rendering.close();
  if (state.obstacleMode !== 'studio') {
    // Start from the run on screen when nothing was placed yet
    if (!state.studio.length) {
      state.studio = itemsToStudio(currentLayout().items);
      saveStudio();
    }
    state.obstacleMode = 'studio';
  }
  fly.enabled = orbit.enabled = false;
  document.body.classList.add('studio');
  rebuild().then(() => (studio.enter(), applyThemeLook(), applyBend()));
}

function exitStudio() {
  studio.exit();
  applyThemeLook();
  applyBend();
  document.body.classList.remove('studio');
  setControlMode(state.controls);
  settings.refresh();
}

const ui = createUI(manifest, {
  getState: () => state,
  env: envInfo,
  inspect: (names) => inspectPieces(names),
  exitInspect: () => {
    state.inspect = null;
    state.controls = 'fly';
    setControlMode('fly');
    applyCamera('game');
    rebuild();
  },
  screenshot: screenshotBlob,
  openSettings: () => (generation.close(), rendering.close(), settings.open()),
  openGeneration: () => (settings.close(), rendering.close(), generation.open()),
  openRendering: () => (settings.close(), generation.close(), rendering.toggle()),
  openStudio: () => enterStudio(),
  thumbnail: themeThumbnail,
  saveThumbnail: async (dataUrl) => {
    const blob = await (await fetch(dataUrl)).blob();
    await fetch(`/api/envs/${encodeURIComponent(ENV_ID)}/thumbnail`, { method: 'PUT', body: blob });
    envInfo.thumbnail = true;
  },
});
if (params.has('shot')) document.getElementById('ui').classList.add('hidden');

// Tab hides / shows the whole interface; M or the toolbar opens the settings menu
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.code === 'Tab') {
    e.preventDefault();
    document.body.classList.toggle('ui-hidden');
  } else if (e.code === 'KeyM' && !studio.active) {
    settings.toggle();
  } else if (e.code === 'Escape' && (settings.isOpen() || generation.isOpen())) {
    settings.close();
    generation.close();
  }
});

applyCamera(state.camera);
setControlMode(state.controls);
window.__viewer = { fly, renderScreenshot, screenshot, state, camera, layers, cutawayDebug, largestIslandCenter, sky, scene, THREE, settings, enterStudio, exitStudio };
await rebuild();

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  globals.uTime.value = clock.getElapsedTime();
  if (orbit.enabled) orbit.update();
  fly.update();
  updateSkyline();
  updateCutaway();
  renderer.setRenderTarget(viewTarget);
  renderer.render(scene, studio.active ? studio.camera : camera);
  renderer.setRenderTarget(null);
  renderer.render(blitScene, blitCamera);
});
