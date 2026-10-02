import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'lil-gui';
import { MaterialLibrary } from './materials.js';
import { generateLayout } from './layout.js';

const DATA = '/data';
const params = new URLSearchParams(location.search);

// ---------------------------------------------------------------- scene

const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: params.has('shot') });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fd3f0);

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 1, 8000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;

const CAMERA_PRESETS = {
  // Roughly the in-game chase camera: behind and above the middle lane
  game: { pos: [0, 45, -60], target: [0, 15, 80] },
  overview: { pos: [420, 380, -200], target: [0, 0, 500] },
  side: { pos: [260, 60, 300], target: [0, 20, 300] },
};

function applyCamera(name) {
  const p = CAMERA_PRESETS[name];
  camera.position.set(...p.pos);
  controls.target.set(...p.target);
  controls.update();
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

function loadGlb(url) {
  if (!glbCache.has(url)) glbCache.set(url, loader.loadAsync(`${DATA}/${url}`).then((g) => g.scene));
  return glbCache.get(url);
}

function applyMaterial(mesh, mat) {
  mesh.material = mat;
  mesh.renderOrder = mat.userData.renderQueue ?? 2000;
}

/** Instantiates a prefab (or one of its runtime track configs) with manifest materials. */
async function instantiate(name, trackType) {
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
  const obj = (await loadGlb(prefab.glb)).clone();
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
};

const layers = { environment: new THREE.Group(), track: new THREE.Group(), train: new THREE.Group(), obstacle: new THREE.Group() };
Object.values(layers).forEach((g) => scene.add(g));
let buildId = 0;

async function rebuild() {
  const id = ++buildId;
  const { items, length } = generateLayout(manifest, state.theme, state);
  status.textContent = `Loading ${state.theme}…`;
  const objs = await Promise.all(
    items.map(async (it) => {
      try {
        const obj = await instantiate(it.prefab, it.trackType);
        if (obj) obj.position.set(...it.pos);
        return [it, obj];
      } catch (e) {
        console.warn('Failed to load', it.prefab, e);
        return [it, null];
      }
    }),
  );
  if (id !== buildId) return; // superseded by a newer rebuild
  Object.values(layers).forEach((g) => g.clear());
  for (const [it, obj] of objs) if (obj) layers[it.layer].add(obj);
  updateVisibility();
  const missing = objs.filter(([, o]) => !o).length;
  status.textContent = `${state.theme} · seed ${state.seed} · ${items.length} pieces · ${Math.round(length)} units${missing ? ` · ${missing} without geometry` : ''}`;
  window.__ready = true;
}

function updateVisibility() {
  layers.train.visible = state.trains;
  layers.obstacle.visible = state.obstacles;
}

// ---------------------------------------------------------------- UI

const gui = new GUI({ title: 'Environment' });
gui.add(state, 'theme', Object.keys(manifest.themes)).onChange(rebuild);
gui.add(state, 'seed', 1, 9999, 1).onFinishChange(rebuild);
gui.add(state, 'sections', 1, 40, 1).onFinishChange(rebuild);
gui.add({ shuffle: () => ((state.seed = Math.floor(Math.random() * 9999) + 1), gui.controllersRecursive().forEach((c) => c.updateDisplay()), rebuild()) }, 'shuffle');
gui.add(state, 'trains').onChange(updateVisibility);
gui.add(state, 'obstacles').onChange(updateVisibility);
gui.add(state, 'camera', Object.keys(CAMERA_PRESETS)).onChange(applyCamera);
if (params.has('shot')) gui.hide();

applyCamera(state.camera);
await rebuild();

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
