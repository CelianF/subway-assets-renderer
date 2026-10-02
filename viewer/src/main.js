import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'lil-gui';
import { FlyControls } from './flyControls.js';
import { prepareCutaway, registerPiece, updatePieces, cutawayDebug, largestIslandCenter } from './cutaway.js';
import { MaterialLibrary, setBendDegrees, globals, setFog, createSky } from './materials.js';
import { generateLayout, mulberry32 } from './layout.js';
import { createUI } from './ui.js';

const params = new URLSearchParams(location.search);
// One environment (= one map) per page; maps are picked on the home page
const ENV_ID = params.get('env');
if (!ENV_ID) location.replace('/');
const DATA = `/envs/${encodeURIComponent(ENV_ID)}`;

// ---------------------------------------------------------------- scene

const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: params.has('shot') });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);

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
  gui.controllersRecursive().forEach((c) => c.updateDisplay());
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
  const lowWithHigh = (o) => {
    const m = o.name.match(/^(.*)_low(_\d+)?$/);
    return m && o.parent?.children.some((c) => c.name.replace(/_\d+$/, '') === `${m[1]}_high`);
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
async function applySignalColor(obj, seed) {
  const rng = mulberry32(seed);
  let red = null;
  let green = null;
  obj.traverse((o) => {
    if (o.name.startsWith('_Common_LightSignal_Light_Red')) red ??= o;
    if (o.name.startsWith('_Common_LightSignal_Light_Green')) green ??= o;
  });
  const wantGreen = rng() < 0.5;
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
async function instantiate(name, trackType, layer, variantSeed = 1, signalSeed = null) {
  const prefab = manifest.prefabs[name];
  const config = trackType && prefab.trackConfigs?.[trackType];
  if (config) {
    if (!config.glb) return null;
    const obj = (await loadGlb(config.glb)).clone();
    let i = 0;
    obj.traverse((o) => {
      if (o.isMesh) applyMaterial(o, materials.get(config.materials[i++] ?? config.materials[0], o.material));
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
    const out = mats.map((m) => materials.get(m.name, m));
    if (out.length === 1) applyMaterial(o, out[0]);
    else o.material = out;
  });
  if (signalSeed != null) await applySignalColor(obj, signalSeed);
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
  obstacleMode: params.get('obstacleMode') ?? 'random',
  inspect: params.get('prefab')?.split(',') ?? null, // prefab names shown alone, or null for the run
  altColors: Number(params.get('altColors') ?? 0),
  camera: params.get('cam') ?? 'game',
  controls: 'fly',
  cutaway: false,
  bend: Number(params.get('bend') ?? 0),
  bendVertical: Number(params.get('bendV') ?? 0),
  fov: 55,
};

const layers = {
  environment: new THREE.Group(),
  track: new THREE.Group(),
  train: new THREE.Group(),
  obstacle: new THREE.Group(),
  wall: new THREE.Group(), // gate walls, open on one lane
  signal: new THREE.Group(),
};
Object.values(layers).forEach((g) => scene.add(g));
let buildId = 0;

async function rebuild() {
  const id = ++buildId;
  // Inspection: only the given pieces, side by side along X
  const only = state.inspect;
  const { items, length } = only
    ? { items: inspectLayout(only), length: 0 }
    : generateLayout(manifest, state.theme, { ...state, trainTheme: trainTheme() });
  applyThemeLook();
  status.textContent = `Loading ${state.theme}…`;
  const objs = await Promise.all(
    items.map(async (it) => {
      try {
        const obj = await instantiate(it.prefab, it.trackType, it.layer, it.variantSeed, it.signalSeed);
        if (obj) obj.position.set(...it.pos);
        return [it, obj];
      } catch (e) {
        console.warn('Failed to load', it.prefab, e);
        return [it, null];
      }
    }),
  );
  if (id !== buildId) return; // superseded by a newer rebuild
  if (window.__viewer) window.__viewer.items = items;
  Object.values(layers).forEach((g) => g.clear());
  for (const [it, obj] of objs) {
    if (!obj) continue;
    layers[it.layer].add(obj);
    if (it.layer !== 'track') {
      registerPiece(obj, { openBacks: it.layer === 'environment', whole: it.layer === 'train', group: it.group });
    }
  }
  updateVisibility();
  applyBend();
  const missing = objs.filter(([, o]) => !o).length;
  status.textContent = only
    ? `Inspecting ${only.length} piece${only.length > 1 ? 's' : ''}`
    : `${state.theme} · seed ${state.seed} · ${items.length} pieces · ${Math.round(length)} units${missing ? ` · ${missing} without geometry` : ''}`;
  ui?.themeChanged(state.theme);
  ui?.setInspecting(only);
  if (only) frameInspection(items);
  else ui?.themeLoaded(state.theme);
  window.__ready = true;
}

/** Theme whose trains are used: this map's, or a merged environment's. */
function trainTheme() {
  if (state.trainEnv === 'same') return null;
  return envList.find((e) => e.id === state.trainEnv)?.theme ?? null;
}

/** Pieces for inspection, spaced by their width so they don't overlap. */
function inspectLayout(names) {
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
  gui.controllersRecursive().forEach((c) => c.updateDisplay());
}

const CUTAWAY_LAYERS = ['environment', 'train', 'obstacle', 'wall', 'signal'];

// ---------------------------------------------------------------- theme look

const skylineGroup = new THREE.Group();
scene.add(skylineGroup);
let skylineTheme = null;

/** Fog, sky and skyline from the theme's ThemeConfig. */
function applyThemeLook() {
  const cfg = manifest.themeConfigs?.[state.theme] ?? {};
  // No fog/skyline while inspecting: the camera frames pieces from far away
  setFog(cfg.fog, state.fog && !state.inspect, state.fogScale);
  sky.setColors(cfg.sky);
  if (skylineTheme !== state.theme) {
    skylineTheme = state.theme;
    skylineGroup.clear();
    if (cfg.background) loadSkyline(cfg.background);
  }
  skylineGroup.visible = state.skyline && !state.inspect;
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
    },
    vertexShader: `varying float vY; void main() { vY = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 uA; uniform vec3 uB; uniform vec3 uTint; uniform vec2 uRange; varying float vY;
      void main() { float t = clamp((vY - uRange.x) / max(uRange.y - uRange.x, 1.0), 0.0, 1.0);
        gl_FragColor = vec4(mix(uB, uA, t) * mix(vec3(1.0), uTint, 0.35), 1.0); }`,
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
  for (const obj of skylineGroup.children) obj.position.set(0, 0, camera.position.z + obj.userData.distance);
}

/** Hides the geometry islands (buildings, train cars, …) the camera is inside. */
function updateCutaway() {
  updatePieces(CUTAWAY_LAYERS.flatMap((layer) => layers[layer].children), state.cutaway ? camera.position : null);
}

function applyBend() {
  setBendDegrees(state.bend, state.bendVertical);
  // Bent geometry can appear outside its unbent bounds: skip frustum culling while bending
  const culled = state.bend === 0 && state.bendVertical === 0;
  Object.values(layers).forEach((g) => g.traverse((o) => o.isMesh && (o.frustumCulled = culled))); // not the sky/skyline
}

function updateVisibility() {
  layers.train.visible = state.trains;
  layers.obstacle.visible = state.obstacles;
  layers.signal.visible = state.signals;
  layers.wall.visible = state.walls;
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
  const target = new THREE.WebGLRenderTarget(width, height, { samples: 4 });
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

const gui = new GUI({ title: 'Environment' });
gui.add(state, 'seed', 1, 9999, 1).onFinishChange(rebuild);
gui.add(state, 'sections', 1, 40, 1).onFinishChange(rebuild);
gui.add({ shuffle: () => ((state.seed = Math.floor(Math.random() * 9999) + 1), gui.controllersRecursive().forEach((c) => c.updateDisplay()), rebuild()) }, 'shuffle');
gui.add(state, 'trains').onChange(updateVisibility);
const trainOptions = { 'this map': 'same' };
for (const e of envList) if (e.id !== ENV_ID) trainOptions[`${e.theme} (v${e.gameVersion})`] = e.id;
gui.add(state, 'trainEnv', trainOptions).name('trains from').onChange(async (id) => {
  if (id !== 'same') await mergeEnvironment(id);
  rebuild();
});
gui.add(state, 'obstacles').name('barriers').onChange(updateVisibility);
gui.add(state, 'walls').name('walls (gates)').onChange(updateVisibility);
gui.add(state, 'obstacleMode', { 'random': 'random', "game's chase chunks": 'chunks' }).name('obstacle layout').onChange(rebuild);
gui.add(state, 'signals').name('signal lights').onChange(updateVisibility);

const lookFolder = gui.addFolder('Rendering');
lookFolder.add(state, 'fog').onChange(applyThemeLook);
lookFolder.add(state, 'fogScale', 0.25, 6, 0.05).name('fog distance ×').onChange(applyThemeLook);
lookFolder.add(state, 'skyline').onChange(applyThemeLook);
lookFolder.add(state, 'glass', 0, 1, 0.01).name('glass opacity').onChange((v) => materials.setGlassOpacity(v));
lookFolder.add(state, 'altColors', 0, 1, 0.01).name('alternate colors (NY)').onChange((v) => (globals.uAltRatio.value = v));

const bendFolder = gui.addFolder('Bend');
const onBend = applyBend;
bendFolder.add(state, 'bend', -45, 45, 0.5).name('bend° (− left / + right)').onChange(onBend);
bendFolder.add(state, 'bendVertical', -30, 30, 0.5).name('vertical° (+ down)').onChange(onBend);
bendFolder.add({ reset: () => ((state.bend = state.bendVertical = 0), bendFolder.controllers.forEach((c) => c.updateDisplay()), onBend()) }, 'reset').name('straight');

const camFolder = gui.addFolder('Camera');
camFolder.add(state, 'camera', Object.keys(CAMERA_PRESETS)).name('preset').onChange(applyCamera);
camFolder.add(state, 'cutaway').name('hide piece around camera');
camFolder.add(state, 'controls', ['fly', 'orbit']).name('mode').onChange(setControlMode);
const speedCtrl = camFolder.add(fly, 'speed', 5, 3000, 1).name('fly speed');
fly.onSpeedChange = () => speedCtrl.updateDisplay();
camFolder.add(state, 'fov', 20, 110, 1).onChange((v) => ((camera.fov = v), camera.updateProjectionMatrix()));
camFolder
  .add({ help: 'Drag: look · WASD: move · Space: up · Shift: down · Alt: fast · Wheel: speed' }, 'help')
  .name('fly keys')
  .disable();

const shotFolder = gui.addFolder('Screenshot');
shotFolder.add(screenshot, 'resolution', Object.keys(RESOLUTIONS));
shotFolder.add(screenshot, 'transparent').name('transparent bg');
shotFolder.add({ take: () => ui.takeShot() }, 'take').name('📷 Save screenshot (P)');

const ui = createUI(manifest, {
  getState: () => state,
  env: envInfo,
  inspect: (names) => {
    state.inspect = names;
    rebuild();
  },
  exitInspect: () => {
    state.inspect = null;
    state.controls = 'fly';
    setControlMode('fly');
    applyCamera('game');
    rebuild();
  },
  screenshot: screenshotBlob,
  thumbnail: themeThumbnail,
  saveThumbnail: async (dataUrl) => {
    const blob = await (await fetch(dataUrl)).blob();
    await fetch(`/api/envs/${encodeURIComponent(ENV_ID)}/thumbnail`, { method: 'PUT', body: blob });
    envInfo.thumbnail = true;
  },
});
if (params.has('shot')) {
  gui.hide();
  document.getElementById('ui').classList.add('hidden');
}

applyCamera(state.camera);
setControlMode(state.controls);
window.__viewer = { renderScreenshot, screenshot, state, camera, layers, cutawayDebug, largestIslandCenter, sky, scene, THREE };
await rebuild();

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  globals.uTime.value = clock.getElapsedTime();
  if (orbit.enabled) orbit.update();
  fly.update();
  updateSkyline();
  updateCutaway();
  renderer.render(scene, camera);
});
