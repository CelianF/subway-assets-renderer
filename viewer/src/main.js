import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'lil-gui';
import { FlyControls } from './flyControls.js';
import { prepareCutaway, registerPiece, updatePieces, cutawayDebug, largestIslandCenter } from './cutaway.js';
import { MaterialLibrary, bend, setBendDegrees } from './materials.js';
import { generateLayout, mulberry32 } from './layout.js';

const DATA = '/data';
const params = new URLSearchParams(location.search);

// ---------------------------------------------------------------- scene

const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: params.has('shot') });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fd3f0);

// near = 2 (not 1) doubles depth precision; distant coplanar details z-fight less
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 2, 8000);
const orbit = new OrbitControls(camera, canvas);
orbit.enableDamping = true;
const fly = new FlyControls(camera, canvas);

const CAMERA_PRESETS = {
  // Roughly the in-game chase camera: behind and above the middle lane
  game: { pos: [0, 45, -60], target: [0, 15, 80] },
  overview: { pos: [420, 380, -200], target: [0, 0, 500] },
  side: { pos: [260, 60, 300], target: [0, 20, 300] },
};

function applyCamera(name) {
  const p = CAMERA_PRESETS[name];
  // Side view starts inside the left-hand buildings: cut them away
  state.cutaway = name === 'side';
  gui.controllersRecursive().forEach((c) => c.updateDisplay());
  camera.position.set(...p.pos);
  camera.lookAt(...p.target);
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
});

const status = document.getElementById('status');

// ---------------------------------------------------------------- assets

const manifest = await (await fetch(`${DATA}/manifest.json`)).json();
const materials = new MaterialLibrary(manifest, DATA);
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
      loader.loadAsync(`${DATA}/${url}`).then((g) => {
        if (cutaway) prepareCutaway(g.scene, cutaway === 'floor' ? FLOOR_Y : -Infinity);
        return g.scene;
      }),
    );
  }
  return glbCache.get(key);
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

function applyMaterial(mesh, mat) {
  mesh.material = mat;
  mesh.renderOrder = mat.userData.renderQueue ?? 2000;
}

/** Instantiates a prefab (or one of its runtime track configs) with manifest materials. */
async function instantiate(name, trackType, layer, variantSeed = 1) {
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
  return obj;
}

// ---------------------------------------------------------------- run

const state = {
  theme: params.get('theme') ?? Object.keys(manifest.themes)[0],
  seed: Number(params.get('seed') ?? 1),
  sections: Number(params.get('sections') ?? 12),
  obstacles: params.get('obstacles') !== '0',
  trains: params.get('trains') !== '0',
  camera: params.get('cam') ?? 'game',
  controls: 'fly',
  cutaway: false,
  bend: Number(params.get('bend') ?? 0),
  bendVertical: Number(params.get('bendV') ?? 0),
  fov: 55,
};

const layers = { environment: new THREE.Group(), track: new THREE.Group(), train: new THREE.Group(), obstacle: new THREE.Group() };
Object.values(layers).forEach((g) => scene.add(g));
let buildId = 0;

async function rebuild() {
  const id = ++buildId;
  // ?prefab=Name[,Name…] shows only those pieces, side by side (debug / inspection)
  const only = params.get('prefab')?.split(',');
  const { items, length } = only
    ? { items: only.map((prefab, i) => ({ prefab, layer: 'environment', pos: [i * 120, 0, 0], variantSeed: 1 })), length: 0 }
    : generateLayout(manifest, state.theme, state);
  status.textContent = `Loading ${state.theme}…`;
  const objs = await Promise.all(
    items.map(async (it) => {
      try {
        const obj = await instantiate(it.prefab, it.trackType, it.layer, it.variantSeed);
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
  status.textContent = `${state.theme} · seed ${state.seed} · ${items.length} pieces · ${Math.round(length)} units${missing ? ` · ${missing} without geometry` : ''}`;
  window.__ready = true;
}

const CUTAWAY_LAYERS = ['environment', 'train', 'obstacle'];

/** Hides the geometry islands (buildings, train cars, …) the camera is inside. */
function updateCutaway() {
  updatePieces(CUTAWAY_LAYERS.flatMap((layer) => layers[layer].children), state.cutaway ? camera.position : null);
}

function applyBend() {
  setBendDegrees(state.bend, state.bendVertical);
  // Bent geometry can appear outside its unbent bounds: skip frustum culling while bending
  const culled = state.bend === 0 && state.bendVertical === 0;
  scene.traverse((o) => o.isMesh && (o.frustumCulled = culled));
}

function updateVisibility() {
  layers.train.visible = state.trains;
  layers.obstacle.visible = state.obstacles;
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

  const target = new THREE.WebGLRenderTarget(width, height, { samples: 4, colorSpace: THREE.SRGBColorSpace });
  const shotCam = camera.clone();
  shotCam.aspect = width / height;
  shotCam.updateProjectionMatrix();

  const bg = scene.background;
  if (screenshot.transparent) scene.background = null;
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, screenshot.transparent ? 0 : 1);
  renderer.clear();
  renderer.render(scene, shotCam);
  const pixels = new Uint8Array(width * height * 4);
  renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
  renderer.setRenderTarget(null);
  renderer.setClearColor(0x000000, 1);
  scene.background = bg;
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

/** Saves a screenshot PNG via a download. */
async function takeScreenshot() {
  const out = renderScreenshot();
  const { width, height } = out;
  const blob = await new Promise((r) => out.toBlob(r, 'image/png'));
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `subway_${state.theme}_seed${state.seed}_${stamp}.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  flashStatus(`Saved ${a.download} (${width}×${height})`);
}

let statusTimer;
function flashStatus(msg) {
  const prev = status.textContent;
  status.textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (status.textContent = prev), 2500);
}

// ---------------------------------------------------------------- UI

const gui = new GUI({ title: 'Environment' });
gui.add(state, 'theme', Object.keys(manifest.themes)).onChange(rebuild);
gui.add(state, 'seed', 1, 9999, 1).onFinishChange(rebuild);
gui.add(state, 'sections', 1, 40, 1).onFinishChange(rebuild);
gui.add({ shuffle: () => ((state.seed = Math.floor(Math.random() * 9999) + 1), gui.controllersRecursive().forEach((c) => c.updateDisplay()), rebuild()) }, 'shuffle');
gui.add(state, 'trains').onChange(updateVisibility);
gui.add(state, 'obstacles').onChange(updateVisibility);

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
shotFolder.add({ take: () => takeScreenshot() }, 'take').name('📷 Save screenshot (P)');
addEventListener('keydown', (e) => {
  if (e.code === 'KeyP' && !(e.target instanceof HTMLInputElement)) takeScreenshot();
});
if (params.has('shot')) gui.hide();

applyCamera(state.camera);
setControlMode(state.controls);
window.__viewer = { renderScreenshot, screenshot, state, camera, layers, cutawayDebug, largestIslandCenter };
await rebuild();

renderer.setAnimationLoop(() => {
  if (orbit.enabled) orbit.update();
  fly.update();
  updateCutaway();
  renderer.render(scene, camera);
});
