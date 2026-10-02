import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'lil-gui';
import { FlyControls } from './flyControls.js';
import { prepareCutaway, registerPiece, updatePieces, cutawayDebug, largestIslandCenter } from './cutaway.js';
import { MaterialLibrary, setBendDegrees, globals, setFog, createSky } from './materials.js';
import { generateLayout, mulberry32 } from './layout.js';

const DATA = '/data';
const params = new URLSearchParams(location.search);

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
  theme: params.get('theme') ?? Object.keys(manifest.themes)[0],
  seed: Number(params.get('seed') ?? 1),
  sections: Number(params.get('sections') ?? 12),
  obstacles: params.get('obstacles') !== '0',
  trains: params.get('trains') !== '0',
  signals: params.get('signals') !== '0',
  trainTheme: params.get('trainTheme') ?? 'same',
  fog: params.get('fog') !== '0',
  fogScale: Number(params.get('fogScale') ?? 1),
  glass: 1,
  skyline: true,
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
  signal: new THREE.Group(),
};
Object.values(layers).forEach((g) => scene.add(g));
let buildId = 0;

async function rebuild() {
  const id = ++buildId;
  // ?prefab=Name[,Name…] shows only those pieces, side by side (debug / inspection)
  const only = params.get('prefab')?.split(',');
  const { items, length } = only
    ? { items: only.map((prefab, i) => ({ prefab, layer: 'environment', pos: [i * 120, 0, 0], variantSeed: 1 })), length: 0 }
    : generateLayout(manifest, state.theme, { ...state, trainTheme: state.trainTheme === 'same' ? null : state.trainTheme });
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
  status.textContent = `${state.theme} · seed ${state.seed} · ${items.length} pieces · ${Math.round(length)} units${missing ? ` · ${missing} without geometry` : ''}`;
  window.__ready = true;
}

const CUTAWAY_LAYERS = ['environment', 'train', 'obstacle', 'signal'];

// ---------------------------------------------------------------- theme look

const skylineGroup = new THREE.Group();
scene.add(skylineGroup);
let skylineTheme = null;

/** Fog, sky and skyline from the theme's ThemeConfig. */
function applyThemeLook() {
  const cfg = manifest.themeConfigs?.[state.theme] ?? {};
  setFog(cfg.fog, state.fog, state.fogScale);
  sky.setColors(cfg.sky);
  if (skylineTheme !== state.theme) {
    skylineTheme = state.theme;
    skylineGroup.clear();
    if (cfg.background) loadSkyline(cfg.background);
  }
  skylineGroup.visible = state.skyline;
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
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, screenshot.transparent ? 0 : 1);
  renderer.clear();
  renderer.render(scene, shotCam);
  const pixels = new Uint8Array(width * height * 4);
  renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
  renderer.setRenderTarget(null);
  renderer.setClearColor(0x000000, 1);
  sky.visible = true;
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
gui.add(state, 'trainTheme', ['same', ...Object.keys(manifest.themes)]).name('trains from').onChange(rebuild);
gui.add(state, 'obstacles').onChange(updateVisibility);
gui.add(state, 'signals').name('signal lights').onChange(updateVisibility);

const lookFolder = gui.addFolder('Rendering');
lookFolder.add(state, 'fog').onChange(applyThemeLook);
lookFolder.add(state, 'fogScale', 0.25, 6, 0.05).name('fog distance ×').onChange(applyThemeLook);
lookFolder.add(state, 'skyline').onChange(applyThemeLook);
lookFolder.add(state, 'glass', 0, 1, 0.01).name('glass opacity').onChange((v) => materials.setGlassOpacity(v));

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
