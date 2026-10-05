import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FlyControls } from './flyControls.js';
import { prepareCutaway, registerPiece, updatePieces, cutawayDebug, largestIslandCenter } from './cutaway.js';
import { MaterialLibrary, setBendDegrees, globals, setFog, createSky, setTrackCuts, setReversedDepth, texturesReady } from './materials.js';
import { generateLayout, mulberry32, DEFAULT_GEN, itemsToStudio, studioCatalog, gameModes, TRAIN_VARIANTS, buildingPieces, landmarkVariants, trainLength, FIXABLE, FIX_LABELS, wallItems } from './layout.js';
import { createSettings, createWorkbar } from './settings.js';
import { createStudio } from './studio.js';
import { createUI, prettyTheme } from './ui.js';
import { addCredit } from './credit.js';
import { attachParticles, updateParticles, setWeather, setWeatherVisible, setWeatherCover } from './particles.js';

const params = new URLSearchParams(location.search);

// Debug flags kept across maps (storage can be missing or blocked: then they just reset)
function storedFlag(key) {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}
function storeFlag(key, on) {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch {
    // not kept
  }
}
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
  // Debug: ?cam=x,y,z,tx,ty,tz places the camera anywhere
  const custom = /^-?[\d.]+(,-?[\d.]+){5}$/.test(name) ? name.split(',').map(Number) : null;
  const p = custom ? { pos: custom.slice(0, 3), target: custom.slice(3) } : CAMERA_PRESETS[name] ?? CAMERA_PRESETS.game;
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
function applyRandomizers(obj, randomizers, seed, prefabName = '', forced = null) {
  const rng = mulberry32(seed);
  const table = sanitizedTable(Object.entries(randomizers));
  const groups = [];
  obj.traverse((o) => nodeKey(table, o.name) && groups.push(o));
  for (const group of groups) {
    const children = [...group.children];
    const groupName = Object.keys(randomizers).find((k) => THREE.PropertyBinding.sanitizeNodeName(k) === nodeKey(table, group.name)) ?? group.name;
    const entry = table[nodeKey(table, group.name)];
    const { probability = entry, weights = null } = typeof entry === 'object' ? entry : {};
    let keep = null;
    if (forced?.[groupName]) {
      // Showcase: this variant (by name)
      const want = THREE.PropertyBinding.sanitizeNodeName(forced[groupName]);
      keep = children.find((c) => c.name === want || c.name.replace(/_\d+$/, '') === want) ?? null;
    } else if (rng() < probability) {
      if (weights) {
        // WeightedChildRandomizer: by the weight of each child (by name)
        const childKey = (c) => (c.name in weights ? c.name : Object.keys(weights).find((k) => THREE.PropertyBinding.sanitizeNodeName(k) === c.name.replace(/_\d+$/, '')));
        // Variants left out in Generation > Landmark weigh nothing (unless that's all of them)
        const allowed = (c) => state.gen.variants[`${prefabName}|${groupName}|${childKey(c)}`] !== false;
        const anyAllowed = children.some((c) => childKey(c) && allowed(c));
        const weightOf = (c) => (anyAllowed && !allowed(c) ? 0 : weights[childKey(c)] ?? 0);
        let r = rng() * children.reduce((n, c) => n + weightOf(c), 0);
        keep = children.find((c) => (r -= weightOf(c)) < 0) ?? null;
      } else keep = children[Math.floor(rng() * children.length)];
    }
    for (const child of children) if (child !== keep) child.removeFromParent();
  }
}

// Animator clips (the Underwater kraken throwing a train car), baked by the importer into
// one loop per Animator: played on repeat with a pause, each piece at its own phase
const mixers = new Set(); // { root, mixer }
const animatorFiles = new Map();

/**
 * Skinned meshes the prefab glb left out (the kraken's arm): the mesh glb has joints and
 * weights but no skin, so the skeleton is rebuilt from the bone names and bind poses.
 */
async function applySkinned(obj, list) {
  const key = (name) => THREE.PropertyBinding.sanitizeNodeName(name);
  const findIn = (root, name) => {
    let found = null;
    root.traverse((o) => (found ??= o.name === key(name) || o.name.replace(/_\d+$/, '') === key(name) ? o : null));
    return found;
  };
  for (const sk of list) {
    const holder = findIn(obj, sk.node);
    if (!holder) continue; // its variant wasn't picked
    // The bones: in the nearest subtree around the renderer that holds them all
    let bones = null;
    if (sk.bonePaths) {
      // Exact paths below the prefab root (rigs sharing bone names)
      const found = sk.bonePaths.map((path) => nodeByPath(obj, path));
      if (found.every(Boolean)) bones = found;
    }
    for (let scope = holder.parent; scope && !bones; scope = scope.parent) {
      const found = sk.bones.map((b) => findIn(scope, b));
      if (found.every(Boolean)) bones = found;
    }
    let geometry = null;
    (await loadGlb(sk.mesh)).traverse((o) => (geometry ??= o.isMesh ? o.geometry : null));
    if (!bones || !geometry?.attributes.skinIndex) continue;
    const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial({ name: sk.materials[0] ?? 'DefaultMaterial' }));
    mesh.name = `${holder.name}_skinned`;
    mesh.frustumCulled = false; // bounds follow the bones
    holder.add(mesh);
    obj.updateMatrixWorld(true);
    // Unity skins with bone × bind pose (bind poses include the renderer's transform);
    // three.js applies the bind matrix (the mesh's own transform) as well, so take it out
    const meshInverse = mesh.matrixWorld.clone().invert();
    const inverses = sk.bindPoses.map((m) => new THREE.Matrix4().fromArray(m).multiply(meshInverse));
    mesh.bind(new THREE.Skeleton(bones, inverses), mesh.matrixWorld);
  }
}

/** Blend-shape meshes rebuilt by the builder (the glb leaves them out): one mesh per renderer. */
const morphMeshFiles = new Map();
async function applyMorphMeshes(obj, list) {
  for (const m of list) {
    const holder = findNode(obj, m.node);
    if (!holder) continue; // its variant wasn't picked
    if (!morphMeshFiles.has(m.url)) morphMeshFiles.set(m.url, fetch(dataUrl(m.url)).then((r) => r.json()).catch(() => null));
    const data = await morphMeshFiles.get(m.url);
    if (!data) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(data.uvs, 2));
    if (data.colors) geometry.setAttribute('color', new THREE.Float32BufferAttribute(data.colors, 4));
    geometry.setIndex(data.indices);
    let start = 0;
    data.groups.forEach((count, i) => (geometry.addGroup(start, count, i), (start += count)));
    const count = data.positions.length / 3;
    geometry.morphAttributes.position = data.morphs.map((shape) => {
      const delta = new Float32Array(count * 3);
      shape.indices.forEach((v, k) => delta.set(shape.deltas.slice(k * 3, k * 3 + 3), v * 3));
      return new THREE.BufferAttribute(delta, 3);
    });
    geometry.morphTargetsRelative = true;
    geometry.computeVertexNormals();
    const materials = data.groups.map((_, i) => new THREE.MeshBasicMaterial({ name: m.materials[i] ?? m.materials[0] ?? 'DefaultMaterial' }));
    const mesh = new THREE.Mesh(geometry, materials.length > 1 ? materials : materials[0]);
    mesh.name = `${holder.name}_morph`;
    mesh.frustumCulled = false; // bounds change with the shapes
    mesh.morphTargetDictionary = Object.fromEntries(data.morphs.map((shape, i) => [shape.name, i]));
    mesh.morphTargetInfluences = data.morphs.map(() => 0);
    // The glb may keep the renderer's static mesh (bone-less renderers): replaced, not doubled
    for (const c of [...holder.children]) if (c.isMesh && c.children.every((k) => k.userData.cutaway)) c.removeFromParent(); // (with their cutaway copies)
    if (holder.isMesh) holder.visible = false;
    holder.add(mesh);
  }
}

async function applyAnimators(obj, url, seed) {
  if (!animatorFiles.has(url)) animatorFiles.set(url, fetch(dataUrl(url)).then((r) => r.json()).catch(() => []));
  const rng = mulberry32(seed ^ 0x616e696d);
  for (const anim of await animatorFiles.get(url)) {
    const mixer = animationMixer(obj, anim);
    if (!mixer) continue;
    mixer.setTime(rng() * anim.duration);
    mixers.add({ root: obj, mixer });
  }
}

/** A playing mixer for a baked clip ({ node, duration, tracks }) under obj, or null. */
function animationMixer(obj, anim) {
  const root = findNode(obj, anim.node);
  if (!root) return null; // its variant wasn't picked
  // Unity paths ("Armature/Bone/Bone.007") walked child by child from the Animator
  const find = (path) => {
    let node = root;
    for (const part of path ? path.split('/') : []) {
      const name = THREE.PropertyBinding.sanitizeNodeName(part);
      node = node?.children.find((c) => c.name === name || c.name.replace(/_\d+$/, '') === name);
    }
    return node;
  };
  const Track = { quaternion: THREE.QuaternionKeyframeTrack, position: THREE.VectorKeyframeTrack, scale: THREE.VectorKeyframeTrack };
  // A constant position or rotation on the animated object itself (an Animator's root
  // motion) would pin it to that value: 3.70 Ireland's idle sheep sat in the middle of the
  // road (their clip holds them at 0, the building places them 44 to the side)
  const constant = (t) => {
    const n = t.values.length / t.times.length;
    return t.values.every((v, i) => Math.abs(v - t.values[i % n]) < 1e-4);
  };
  const tracks = anim.tracks.map((t) => {
    if (!t.path && (t.property === 'position' || t.property === 'quaternion') && constant(t)) return null;
    const node = find(t.path);
    if (!node) return null;
    if (t.property === 'morph') {
      // Blend shape weights go to the rebuilt mesh under the renderer's node
      const mesh = node.morphTargetDictionary ? node : node.children.find((c) => c.morphTargetDictionary?.[t.name] != null);
      return mesh ? new THREE.NumberKeyframeTrack(`${mesh.uuid}.morphTargetInfluences[${t.name}]`, t.times, t.values) : null;
    }
    return new Track[t.property](`${node.uuid}.${t.property}`, t.times, t.values);
  }).filter(Boolean);
  if (!tracks.length) return null;
  const mixer = new THREE.AnimationMixer(root);
  mixer.clipAction(new THREE.AnimationClip(anim.node, anim.duration, tracks)).play();
  return mixer;
}

async function nameRandomGroups() {
  const used = new Set(Object.values(manifest.themes[state.theme] ?? {}).flatMap((slots) => Object.values(slots).flat()));
  await Promise.all(
    [...used].map(async (name) => {
      const prefab = manifest.prefabs[name];
      const unnamed = Object.entries(prefab?.randomizers ?? {}).filter(([, entry]) => typeof entry !== 'object');
      if (!unnamed.length || !prefab.glb) return;
      const scene = await loadGlb(prefab.glb).catch(() => null);
      for (const [group, probability] of unnamed) {
        const kids = findNode(scene ?? new THREE.Group(), group)?.children.map((c) => c.name) ?? [];
        if (kids.length) prefab.randomizers[group] = { probability, weights: Object.fromEntries(kids.map((k) => [k, 1])) };
      }
    }),
  );
}

function findNode(obj, name) {
  const key = THREE.PropertyBinding.sanitizeNodeName(name);
  let found = null;
  obj.traverse((o) => (found ??= o.name === key ? o : null));
  return found;
}

/**
 * Trails swept by a triggered clip (3.60 Ireland rainbow): the game draws them as the
 * player passes; here the finished trail is laid down as a ribbon, and the clip is left
 * on its last frame so what rides along (the rainbow's sparks) waits at the trail's end.
 */
function applyTrails(obj, trails) {
  const v = new THREE.Vector3();
  const inv = new THREE.Matrix4();
  for (const trail of trails) {
    const mixer = animationMixer(obj, trail.animation);
    const node = findNode(obj, trail.node);
    if (!mixer || !node) continue;
    const points = [];
    const steps = Math.max(2, Math.round(trail.animation.duration * 30));
    for (let i = 0; i <= steps; i++) {
      mixer.setTime((i / steps) * trail.animation.duration * 0.9999); // stop short of the wrap
      obj.updateMatrixWorld(true);
      inv.copy(obj.matrixWorld).invert();
      points.push(node.getWorldPosition(v).applyMatrix4(inv).clone());
    }
    // Width across the trail, in the plane it sweeps (faces the run, like View alignment there)
    const a = points[0];
    const b = points[Math.floor(points.length / 2)];
    const c = points[points.length - 1];
    const normal = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a)).normalize();
    if (normal.lengthSq() < 0.5) normal.set(0, 0, 1);
    const pos = [];
    const uv = [];
    const index = [];
    const tangent = new THREE.Vector3();
    const side = new THREE.Vector3();
    points.forEach((p, i) => {
      tangent.subVectors(points[Math.min(i + 1, points.length - 1)], points[Math.max(i - 1, 0)]).normalize();
      side.crossVectors(tangent, normal).multiplyScalar(trail.width / 2);
      pos.push(p.x + side.x, p.y + side.y, p.z + side.z, p.x - side.x, p.y - side.y, p.z - side.z);
      const u = 1 - i / (points.length - 1); // Stretch: 0 at the head
      uv.push(u, 0, u, 1);
      if (i) index.push(2 * i - 2, 2 * i - 1, 2 * i, 2 * i - 1, 2 * i + 1, 2 * i);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geometry.setIndex(index);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ name: trail.material }));
    mesh.name = `${node.name}_trail`;
    mesh.frustumCulled = false;
    obj.add(mesh);
  }
}

/**
 * Script-driven scenery motion (manifest "motions"): spin, bob (offset), pulse (scale), sway
 * and breathe (candle glows), flicker. Nodes by path below the prefab root ("name#k": the
 * k-th sibling of that name), so every copy moves; older manifests name the node only.
 */
const motions = new Set(); // { root, node, m, base…, state }
/**
 * A node by its path below the prefab root ("a/b#1/c": "#k" the k-th sibling of that name,
 * default the first). obj is the instance: the glb's root node sits under its wrapper.
 */
function nodeByPath(obj, path) {
  const walk = (start) => {
    let node = start;
    for (const part of path.split('/')) {
      const cut = part.lastIndexOf('#');
      const name = THREE.PropertyBinding.sanitizeNodeName(cut < 0 ? part : part.slice(0, cut));
      const k = cut < 0 ? 0 : Number(part.slice(cut + 1));
      node = node?.children.filter((c) => c.name === name || c.name.replace(/_\d+$/, '') === name)[k];
    }
    return node ?? null;
  };
  return walk(obj) ?? (obj.children.length === 1 ? walk(obj.children[0]) : null);
}
/**
 * Unity's built-in meshes, which the glb leaves out (3.70 Cambridge's owl eyes: glowing
 * planes). Shapes as Unity builds them: plane 10x10 facing up, quad 1x1 facing -Z.
 */
const BUILTIN_GEOMETRY = {
  plane: () => new THREE.PlaneGeometry(10, 10).rotateX(-Math.PI / 2),
  quad: () => new THREE.PlaneGeometry(1, 1).rotateY(Math.PI),
  cube: () => new THREE.BoxGeometry(1, 1, 1),
  sphere: () => new THREE.SphereGeometry(0.5, 24, 16),
  cylinder: () => new THREE.CylinderGeometry(0.5, 0.5, 2, 24),
  capsule: () => new THREE.CapsuleGeometry(0.5, 1, 8, 16),
};
const builtinGeometries = new Map();
function addBuiltinMeshes(obj, list) {
  for (const b of list) {
    const node = nodeByPath(obj, b.path);
    if (!node || !BUILTIN_GEOMETRY[b.mesh]) continue; // its variant wasn't picked
    if (!builtinGeometries.has(b.mesh)) builtinGeometries.set(b.mesh, BUILTIN_GEOMETRY[b.mesh]());
    // Named like the glb's materials, so the library swaps in the real one below
    const mesh = new THREE.Mesh(builtinGeometries.get(b.mesh), new THREE.MeshBasicMaterial({ name: b.materials[0] }));
    mesh.name = `${node.name}_builtin`;
    node.add(mesh);
  }
}

/**
 * A one-sided offset (2.x OffsetEffect, 2.34 Copenhagen's lift) rides from its start
 * towards its offset, kept within the piece: the fraction of the offset it may travel.
 */
function rideReach(obj, node, direction, bbox) {
  const len = Math.hypot(...direction);
  if (!bbox || !len) return 1;
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(node);
  if (box.isEmpty()) return 1;
  const room = [0, 1, 2].map((i) => (direction[i] > 0 ? bbox[1][i] - box.max.getComponent(i) : direction[i] < 0 ? box.min.getComponent(i) - bbox[0][i] : Infinity));
  const limit = Math.min(...room.map((r, i) => (direction[i] ? Math.max(r, 0) / Math.abs(direction[i]) : Infinity)));
  return Math.min(1, limit);
}

function resolveMotionNode(obj, m) {
  return m.path ? nodeByPath(obj, m.path) : findNode(obj, m.node);
}
function applyMotions(obj, list, seed, bbox = null) {
  const rng = mulberry32(seed ^ 0x6d6f7665);
  // One clock per piece: flicker patterns play in step (2.34 Copenhagen's gate frames take
  // turns, its tunnel LEDs chase right to left), each piece at its own time
  const phase = rng() * 100;
  for (const m of list) {
    const node = resolveMotionNode(obj, m);
    if (!node) continue; // its variant wasn't picked
    motions.add({
      root: obj,
      node,
      m,
      phase,
      reach: m.oneSided ? rideReach(obj, node, m.direction, bbox) : 1,
      pos: node.position.clone(),
      scale: node.scale.clone(),
      quat: node.quaternion.clone(),
      axis: m.axis ? new THREE.Vector3(...m.axis).normalize() : m.rotation ? new THREE.Vector3(...m.rotation.axis).normalize() : null,
      angle: 0,
      target: null,
      sign: rng() < 0.5 ? 1 : -1,
      grow: rng() < 0.5,
      size: m.scale ? m.scale.min + rng() * (m.scale.max - m.scale.min) : 1,
    });
  }
}
const motionQuat = new THREE.Quaternion();
function updateMotion(mo, dt, time) {
  const { m, node } = mo;
  const t = time + mo.phase;
  if (m.type === 'spin') node.rotateOnAxis(mo.axis, ((m.speed * Math.PI) / 180) * dt);
  else if (m.type === 'offset') {
    // SinUtils: sin(time × frequency); 2.x offsets ride from the start and back
    const s = m.oneSided ? ((1 - Math.cos(t * m.frequency)) / 2) * mo.reach : Math.sin(t * m.frequency);
    node.position.set(mo.pos.x + m.direction[0] * s, mo.pos.y + m.direction[1] * s, mo.pos.z + m.direction[2] * s);
  } else if (m.type === 'scale') {
    const s = Math.sin(t * m.frequency) + m.offset;
    const f = (c, i) => (m.additive ? mo.scale.getComponent(i) + m.amount[i] * s : mo.scale.getComponent(i) * (1 + m.amount[i] * s));
    node.scale.set(f('x', 0), f('y', 1), f('z', 2));
  } else if (m.type === 'sway') {
    if (m.rotation && mo.axis) {
      // Toward a random angle in [min, max], alternating sides, at speed degrees a second
      if (mo.target == null || Math.abs(mo.target - mo.angle) < 1e-3) {
        mo.sign = -mo.sign;
        mo.target = mo.sign * (m.rotation.min + Math.random() * (m.rotation.max - m.rotation.min));
      }
      const step = m.rotation.speed * dt;
      mo.angle += Math.max(-step, Math.min(step, mo.target - mo.angle));
      node.quaternion.copy(mo.quat).multiply(motionQuat.setFromAxisAngle(mo.axis, (mo.angle * Math.PI) / 180));
    }
    if (m.scale) {
      // Back and forth between min and max at speed units a second, on the scale axis
      mo.size += (mo.grow ? 1 : -1) * m.scale.speed * dt * 0.1;
      if (mo.size >= m.scale.max) (mo.size = m.scale.max), (mo.grow = false);
      if (mo.size <= m.scale.min) (mo.size = m.scale.min), (mo.grow = true);
      const a = m.scale.axis;
      node.scale.set(mo.scale.x * (a[0] ? mo.size : 1), mo.scale.y * (a[1] ? mo.size : 1), mo.scale.z * (a[2] ? mo.size : 1));
    }
  } else if (m.type === 'flicker') {
    const i = Math.floor(t * m.speed) % m.pattern.length;
    node.visible = m.pattern[i] !== '0';
  }
}

let motionTime = 0;
function updateAnimators(dt) {
  motionTime += dt;
  for (const mo of motions) {
    // Same lifetime rule as the mixers: gone once its piece left the scene
    if (mo.root.parent) (mo.attached = true), updateMotion(mo, dt, motionTime);
    else if (mo.attached || (mo.loadWait = (mo.loadWait ?? 0) + dt) > 60) motions.delete(mo);
  }
  for (const m of mixers) {
    // A run's pieces join the scene only once all are loaded: gone means removed after that
    if (m.root.parent) m.attached = true;
    else if (m.attached || (m.loadWait = (m.loadWait ?? 0) + dt) > 60) mixers.delete(m);
    if (m.root.parent) m.mixer.update(dt);
  }
}

// MeshAnimation flipbooks (water ripples, fire, wing flaps): the game swaps a node's mesh
// through a list of frames; the glb only holds the first one
const meshAnimations = new Set(); // { root, meshes, frames, duration, offset, delay, loop }

async function applyMeshAnimations(obj, anims, seed) {
  const rng = mulberry32(seed ^ 0x6d657368);
  const table = sanitizedTable(Object.entries(anims)); // GLTFLoader renames "X (1)" to "X_(1)"
  const jobs = [];
  obj.traverse((o) => {
    const key = nodeKey(table, o.name);
    if (!key) return;
    const anim = table[key];
    // One primitive: the node is the mesh; several: a group of meshes
    const meshes = o.isMesh ? [o] : o.children.filter((c) => c.isMesh);
    if (!meshes.length) return;
    jobs.push(
      Promise.all(anim.frames.map((url) => loadGlb(url))).then((scenes) => {
        const frames = scenes.map((scene) => {
          const geos = [];
          scene.traverse((m) => m.isMesh && geos.push(m.geometry));
          return geos;
        });
        for (const mesh of meshes) {
          // Full frames replace the cutaway's floor/upper split; too small to need it
          mesh.userData.cutaway = false;
          for (const child of [...mesh.children]) if (child.name.endsWith('_upper')) mesh.remove(child);
        }
        const duration = anim.duration[0] + rng() * (anim.duration[1] - anim.duration[0]);
        meshAnimations.add({
          root: obj,
          meshes,
          frames,
          duration: Math.max(duration, 1e-3),
          offset: anim.randomStart ? rng() * duration : 0,
          delay: anim.delay,
          loop: anim.loop,
        });
      }),
    );
  });
  await Promise.all(jobs);
}

function updateMeshAnimations(time) {
  for (const a of meshAnimations) {
    if (a.root.parent) a.attached = true;
    if (!a.root.parent) {
      // Removed by a rebuild (pieces only join the scene once the whole run has loaded)
      if (a.attached || time - (a.created ??= time) > 60) meshAnimations.delete(a);
      continue;
    }
    const t = Math.max(0, time - a.delay) / a.duration + a.offset / a.duration;
    const n = (a.frames ?? a.nodes).length;
    const i = a.loop ? Math.floor(t * n) % n : Math.min(n - 1, Math.floor(t * n));
    if (a.nodes) {
      a.nodes.forEach((node, k) => (node.visible = false));
      a.nodes[i].visible = true; // frames can repeat (wings go 1..6..2)
      continue;
    }
    a.meshes.forEach((mesh, k) => {
      const geo = a.frames[i][k] ?? a.frames[i][0];
      if (geo && mesh.geometry !== geo) mesh.geometry = geo;
    });
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
  // Only the standard single-lamp housing (red lamp at y -13.4) has a slot for the common
  // green lamp; themed housings (Transylvania, Cosmic Crossroads) stay red
  const standard = red && Math.abs(red.position.x) < 0.1 && Math.abs(red.position.y + 13.4) < 0.5 && Math.abs(red.position.z + 0.06) < 0.5;
  const canGreen = !!green || standard;
  const wantGreen = canGreen && (color ? color === 'green' : rng() < 0.5);
  if (color === 'off') {
    red?.removeFromParent();
    green?.removeFromParent();
    return;
  }
  if (red && green) {
    (wantGreen ? red : green).removeFromParent();
  } else if (red && wantGreen && standard && manifest.prefabs._Common_LightSignal_Light_Green?.glb) {
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
async function instantiate(name, trackType, layer, variantSeed = 1, signalSeed = null, signalColor = null, cutMode = null, worldZ = 0, variants = null) {
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
  // 1.x composites: trains chained from single cars, shadow stretches from two half pieces
  if (prefab?.parts) {
    const group = new THREE.Group();
    group.name = name;
    const kids = await Promise.all(prefab.parts.map((p, i) => instantiate(p.prefab, null, layer, variantSeed + 7919 * (i + 1), null, null, cutMode)));
    kids.forEach((kid, i) => {
      if (!kid) return;
      kid.position.set(...prefab.parts[i].pos);
      group.add(kid);
    });
    return group;
  }
  // ≤ 1.43: a chunk of the classic level library, or one of its trains/obstacles (studio)
  if (prefab?.node) {
    const obj = await instantiateChunk(prefab, layer, variantSeed, worldZ);
    if (!obj || !prefab.offset) return obj;
    const group = new THREE.Group();
    obj.position.set(...prefab.offset);
    group.add(obj);
    return group;
  }
  // Particle-only prefabs (glows, steam) have no geometry of their own
  if (!prefab?.glb || (!prefab.bbox && !prefab.particles)) return null;
  const cutaway = layer === 'environment' ? 'floor' : layer === 'track' ? null : 'all';
  const source = await loadGlb(prefab.glb, { cutaway });
  // Skinned meshes need their own skeleton (a plain clone keeps the source's bones)
  const obj = prefab.animators ? cloneSkinned(source) : source.clone();
  removeLowLods(obj, prefab.lodHidden);
  if (prefab.randomizers) applyRandomizers(obj, prefab.randomizers, variantSeed, name, variants);
  if (prefab.skinned) await applySkinned(obj, prefab.skinned);
  if (prefab.morphMeshes) await applyMorphMeshes(obj, prefab.morphMeshes);
  if (prefab.animators) await applyAnimators(obj, prefab.animators, variantSeed);
  if (prefab.meshAnimations) await applyMeshAnimations(obj, prefab.meshAnimations, variantSeed);
  if (prefab.motions) applyMotions(obj, prefab.motions, variantSeed, prefab.bbox);
  else if (prefab.spinners) applyMotions(obj, prefab.spinners.map((sp) => ({ type: 'spin', ...sp })), variantSeed); // 0.1.7 manifests
  if (prefab.trails) applyTrails(obj, prefab.trails);
  if (prefab.builtinMeshes) addBuiltinMeshes(obj, prefab.builtinMeshes);
  obj.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const out = mats.map((m) => materials.get(m.name, m, cut));
    if (out.length === 1) applyMaterial(o, out[0]);
    else o.material = out;
  });
  if (prefab.effectPlayers) applyEffectPlayers(obj, prefab.effectPlayers, variantSeed);
  if (prefab.placeholders) await fillPlaceholders(obj, prefab.placeholders, { layer, seed: variantSeed, cutMode, signalSeed, signalColor });
  if (prefab.particles && state.particles) {
    const table = sanitizedTable(Object.entries(prefab.particles));
    await attachParticles(obj, table, materials, (n) => nodeKey(table, n), async (url) => {
      let geometry = null;
      (await loadGlb(url)).traverse((o) => o.isMesh && (geometry ??= o.geometry));
      return geometry;
    });
  }
  if (signalSeed != null) await applySignalColor(obj, signalSeed, signalColor);
  return obj;
}

// RandomizerHold.cs: the road's look follows this sequence, a step every 3000 units
const HOLD_INDICES = [0, 1, 2, 3, 0, 4, 5, 1, 0, 2, 4, 1, 3, 2, 0, 5, 1, 0, 3, 1, 3];

/**
 * A classic chunk cloned out of the level library, its variants picked like the game's
 * scripts: Randomizer (one child), RandomizerHold (the road's look, by distance), Mirror
 * (children flipped left/right), RandomizeOffset (a random allowed lane). Coins and
 * pickups are left out; trains and obstacles follow the layer toggles.
 */
async function instantiateChunk(prefab, layer, seed, worldZ, { keepObstacles = false } = {}) {
  const library = await loadGlb(prefab.glb, { cutaway: 'floor' });
  const source = library.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(prefab.node));
  if (!source) return null;
  const obj = source.clone();
  obj.position.set(0, 0, 0);
  obj.updateMatrixWorld(true); // distances along the chunk, for RandomizerHold
  const rng = mulberry32(seed);
  const holdStart = state.seed % HOLD_INDICES.length;
  let chunkStep = null;
  const nodes = [];
  obj.traverse((o) => nodes.push(o));
  for (const o of nodes) {
    const x = o.userData;
    if (!o.parent && o !== obj) continue; // removed with an ancestor
    // In the studio the chunks keep their scenery only: trains and obstacles are placed by hand
    const placed = prefab.chunk && !keepObstacles && state.obstacleMode === 'studio' && (x.layer === 'train' || x.layer === 'obstacle');
    const toggled = !keepObstacles && ((x.layer === 'train' && !state.trains) || (x.layer === 'obstacle' && !state.obstacles));
    if (x.hide || placed || toggled) {
      o.removeFromParent();
      continue;
    }
    if (x.pick === 'random' && o.children.length) {
      const keep = o.children[Math.floor(rng() * o.children.length)];
      for (const c of [...o.children]) if (c !== keep) c.removeFromParent();
    } else if (x.pick === 'hold' && x.hold?.length) {
      const z = worldZ + new THREE.Vector3().setFromMatrixPosition(o.matrixWorld).z;
      // The game keeps one look (tunnel, forest, city…) for 3000 units; mixed, each chunk
      // draws its own from the same sequence (so with the game's proportions)
      const step = state.gen.classicMix ? (chunkStep ??= Math.floor(mulberry32(seed ^ 0x686f6c64)() * HOLD_INDICES.length)) : Math.floor(z / 3000);
      const slot = HOLD_INDICES[(holdStart + step + holdStart) % HOLD_INDICES.length];
      const keep = o.children[x.hold[slot]];
      for (const c of [...o.children]) if (c !== keep) c.removeFromParent();
    }
    if (x.mirror && rng() < 0.5) for (const c of o.children) c.position.x *= -1;
    if (x.lanes?.length) o.position.x = x.lanes[Math.floor(rng() * x.lanes.length)];
  }
  if (prefab.chunk) placeMovingTrains(obj);
  obj.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const out = mats.map((m) => materials.get(m.name, m, 0));
    if (out.length === 1) applyMaterial(o, out[0]);
    else o.material = out;
  });
  return obj;
}

/**
 * MovingTrain.cs: a moving train meets the player at its anchor and runs ahead of it until
 * then, so two trains sharing a lane never touch in the game even when their anchors are
 * closer than a train's length. Shown standing still, each one moves forward (into track
 * its run sweeps anyway) just enough to clear the one before it.
 */
function placeMovingTrains(obj) {
  const lanes = new Map();
  obj.updateMatrixWorld(true);
  obj.traverse((o) => {
    if (!(o.userData.moving > 0) || !o.children.length) return;
    const box = new THREE.Box3().setFromObject(o.children[0]);
    if (box.isEmpty()) return;
    const lane = Math.round(new THREE.Vector3().setFromMatrixPosition(o.matrixWorld).x);
    if (!lanes.has(lane)) lanes.set(lane, []);
    lanes.get(lane).push({ train: o.children[0], min: box.min.z, max: box.max.z });
  });
  for (const trains of lanes.values()) {
    let end = -Infinity;
    for (const t of trains.sort((a, b) => a.min - b.min)) {
      const shift = Math.max(0, end + 1 - t.min);
      t.train.position.z += shift;
      end = t.max + shift;
    }
  }
}

/**
 * 1.x placeholders: empty nodes the game fills with one prefab from a weighted list (tube
 * sides, beach props, fountains, the signal's red or green light). Spawned pieces can
 * have placeholders of their own.
 */
async function fillPlaceholders(obj, placeholders, { layer, seed, cutMode, signalSeed, signalColor }) {
  const rng = mulberry32(seed ^ 0x706c6163);
  const table = sanitizedTable(Object.entries(placeholders));
  const jobs = [];
  obj.traverse((node) => {
    const key = nodeKey(table, node.name);
    if (!key) return;
    const { prefabs, probability, all } = table[key];
    if (rng() >= probability) return;
    let picks = all ? prefabs : [weightedPick(rng, prefabs)];
    // Signal lights: the run's red/green choice, not a random one. Named lamps, or (1.44
    // "extra_lights_place": event_3/event_5) two lamps where red is the upper one
    let red = prefabs.find((p) => /red/i.test(p.name));
    let green = prefabs.find((p) => /green/i.test(p.name));
    if ((!red || !green) && /light/i.test(key) && prefabs.length === 2) {
      const top = (p) => manifest.prefabs[p.name]?.bbox?.[1][1] ?? 0;
      [green, red] = [...prefabs].sort((a, b) => top(a) - top(b));
    }
    if (signalSeed != null && red && green) {
      if (signalColor === 'off') return;
      const wantGreen = signalColor ? signalColor === 'green' : mulberry32(signalSeed)() < 0.5;
      picks = [wantGreen ? green : red];
    }
    for (const pick of picks) {
      jobs.push(
        instantiate(pick.name, null, layer, Math.floor(rng() * 2 ** 31), null, null, cutMode).then((child) => child && node.add(child)),
      );
    }
  });
  await Promise.all(jobs);
}

function weightedPick(rng, list) {
  let r = rng() * list.reduce((n, p) => n + (p.weight || 1), 0);
  return list.find((p) => (r -= p.weight || 1) < 0) ?? list[0];
}

/** 1.x EffectPlayer: shows its effect children one after the other (ripples, wing flaps). */
function applyEffectPlayers(obj, players, seed) {
  const rng = mulberry32(seed ^ 0x65666678);
  const table = sanitizedTable(Object.entries(players));
  obj.traverse((node) => {
    const key = nodeKey(table, node.name);
    if (!key) return;
    const fx = table[key];
    const byName = new Map();
    node.traverse((o) => o !== node && byName.set(THREE.PropertyBinding.sanitizeNodeName(o.name), o));
    const frames = fx.children.map((n) => byName.get(THREE.PropertyBinding.sanitizeNodeName(n))).filter(Boolean);
    if (frames.length < 2) return;
    // As EffectPlayer.cs: a cycle lasts a random time in [duration, maxDuration], split
    // evenly between frames; a frame changes on the first update after its wait runs out
    // and the wait restarts from there, so at the game's 60 fps each frame lasts whole
    // updates, at least two (Mexico's fire: 24 frames in 0.32 s plays in 0.8 s)
    const cycle = fx.maxDuration > fx.duration ? fx.duration + rng() * (fx.maxDuration - fx.duration) : fx.duration;
    const tick = 1 / 60;
    const perFrame = (Math.ceil(Math.max(cycle / frames.length, 0) / tick - 1e-6) + 1) * tick;
    const duration = perFrame * frames.length;
    meshAnimations.add({ root: obj, nodes: frames, duration, offset: fx.randomStart ? rng() * duration : 0, delay: 0, loop: fx.loop });
  });
}

// ---------------------------------------------------------------- run

// Race arenas (Subway PvP): maps that fill the race's start and finish pieces. Their
// stations and gates are unfinished placeholders the race never shows
const startTheme = manifest.theme ?? Object.keys(manifest.themes)[0];
const isArena = ['boundary_super_epic_start_right', 'boundary_super_epic_start_left'].some((slot) =>
  Object.values(manifest.themes[startTheme] ?? {}).some((c) => c[slot]?.some((n) => manifest.prefabs[n]?.bbox)),
);

const state = {
  theme: startTheme,
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
  particles: params.get('particles') !== '0', // smoke, steam, glows, sparks
  weather: params.get('weather') !== '0', // snow along the whole run (themes that snow at the start)
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
  gen: {
    ...structuredClone(DEFAULT_GEN),
    ...(isArena ? { sections: { ...DEFAULT_GEN.sections, station: false, gate: false } } : {}),
    showcase: params.get('showcase') === '1' || storedFlag('debug:showcase'),
    // Game mode whose route lays the obstacles (?mode=chase|mysteryHurdles|race, &skin=);
    // race arenas open as a race
    mode: params.get('mode') in (manifest.modes ?? {}) ? params.get('mode') : isArena && manifest.modes?.race ? 'race' : 'normal',
    skin: params.get('skin'),
  },
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
    localStorage.setItem(`studio-platforms:${ENV_ID}`, '1'); // lists saved from now on hold their platforms
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
        const obj = await instantiate(it.prefab, it.trackType, it.layer, it.variantSeed, it.signalSeed, it.signalColor, it.cut, it.pos[2], it.variants);
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
  if (!dynamicOnly) setWeatherCover(coveredRanges(layout.items));
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
    : `${prettyTheme(state.theme)} · seed ${state.seed} · ${layout.items.length} pieces · ${Math.round(length)} units${missing ? ` · ${missing} without geometry` : ''}`;
  studio?.relayout();
  ui?.themeChanged(state.theme);
  ui?.setInspecting(only);
  if (only) frameInspection(items);
  // The home page preview: once textures are in, or it comes out black
  else texturesReady().then(() => id === buildId && ui?.themeLoaded(state.theme));
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
/** Stretches of the run under a roof (tubes, stations, pillar halls): [z0, z1) each. */
function coveredRanges(items) {
  const ranges = [];
  const covered = items.filter((it) => /^boundary_(tube|station_|pillars_)/.test(it.slot)).sort((a, b) => a.pos[2] - b.pos[2]);
  for (const it of covered) {
    const z0 = it.pos[2];
    const z1 = z0 + Math.max(manifest.prefabs[it.prefab]?.bbox?.[1][2] ?? 180, 90);
    const last = ranges[ranges.length - 1];
    if (last && z0 <= last[1] + 1) last[1] = Math.max(last[1], z1);
    else ranges.push([z0, z1]);
  }
  return ranges;
}

/** The theme's largest looping box of snow (2.27 North Pole: around the start train only). */
function themeSnow() {
  let best = null;
  let volume = 0;
  for (const p of Object.values(manifest.prefabs)) {
    for (const [name, def] of Object.entries(p.particles ?? {})) {
      if (!/snow/i.test(name) || !def.loop || def.shape?.type !== 5) continue;
      const v = def.shape.box.reduce((a, b) => a * b, 1);
      if (v > volume) [best, volume] = [def, v];
    }
  }
  return best;
}
let weatherTheme = null;

function applyThemeLook() {
  const cfg = manifest.themeConfigs?.[state.theme] ?? {};
  if (weatherTheme !== state.theme) {
    weatherTheme = state.theme;
    setWeather(scene, themeSnow(), materials);
  }
  setWeatherVisible(state.particles && state.weather && !state.inspect && !studio?.active);
  // No fog/skyline while inspecting: the camera frames pieces from far away
  // (nor in the studio's top view, 600 units above the run)
  setFog(cfg.fog, state.fog && !state.inspect && !studio?.active, state.fogScale);
  // A sky material that came without its colors (cloud Space Station: no shader, no
  // properties) shows the fog color, as the sky behind the haze
  const fogRGB = cfg.fog?.color?.slice(0, 3);
  const skyCfg = cfg.sky?.top || cfg.sky?.bottom || !fogRGB ? cfg.sky : { top: fogRGB, bottom: fogRGB, power: 1 };
  sky.setColors(skyCfg, skyCfg?.texture ? dataUrl(skyCfg.texture) : null);
  if (skylineTheme !== state.theme) {
    skylineTheme = state.theme;
    skylineGroup.clear();
    if (cfg.background) loadSkyline(cfg.background);
    if (cfg.skylineLayers) loadSkylineLayers(cfg.skylineLayers);
  }
  skylineGroup.visible = state.skyline && state.skylineOpacity > 0 && !state.inspect;
  skylineUniforms.uOpacity.value = state.skylineOpacity;
  globals.uAltRatio.value = state.altColors;
}

/**
 * BackgroundLayer: a skyline silhouette kept at a fixed distance ahead of the camera,
 * unaffected by fog. ColorMode 0: flat tint; 1: the config's vertical gradient; 2: the
 * mesh's vertex colors (decoded by the builder: the glb lost them). Older manifests have
 * no mode: gradient, lightly tinted.
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
    defines: { COLOR_MODE: bg.colorMode ?? -1 },
    vertexColors: bg.colorMode === 2 && !!bg.mesh,
    vertexShader: `varying float vY; varying vec3 vColor; void main() { vY = position.y;
      #ifdef USE_COLOR
        vColor = color.rgb;
      #else
        vColor = vec3(1.0);
      #endif
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 uA; uniform vec3 uB; uniform vec3 uTint; uniform vec2 uRange; uniform float uOpacity; varying float vY; varying vec3 vColor;
      void main() { float t = clamp((vY - uRange.x) / max(uRange.y - uRange.x, 1.0), 0.0, 1.0);
      #if COLOR_MODE == 0
        vec3 c = uTint;
      #elif COLOR_MODE == 1
        vec3 c = mix(uB, uA, t);
      #elif COLOR_MODE == 2
        vec3 c = vColor;
      #else
        vec3 c = mix(uB, uA, t) * mix(vec3(1.0), uTint, 0.35);
      #endif
        gl_FragColor = vec4(c, uOpacity); }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  let geometry = null;
  if (bg.mesh) {
    geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(bg.mesh.positions, 3));
    if (bg.mesh.colors) geometry.setAttribute('color', new THREE.Float32BufferAttribute(bg.mesh.colors, 4));
    geometry.setIndex(bg.mesh.indices);
  }
  // Only Multi Skyline meshes take the layer's coloring; the rest keep their own material,
  // unfogged (3.68 Cosmic Crossroads: a whole dome of planets, glows and trims)
  const vertexColored = mat.clone();
  vertexColored.vertexColors = true;
  vertexColored.uniforms = mat.uniforms;
  const unfogged = new Map();
  const own = (m) => {
    if (!unfogged.has(m.name)) {
      const base = materials.get(m.name, m);
      const copy = base.clone();
      if (base.uniforms) copy.uniforms = { ...base.uniforms, uFogOn: { value: 0 } };
      // Same pass as the sky layer so the render order below applies (blending is custom)
      copy.transparent = true;
      unfogged.set(m.name, copy);
    }
    return unfogged.get(m.name);
  };
  // A plain city atlas (<Theme>_environment) stands in for the skyline material too: 2.11's
  // Space Station skyline had no material at all, the cloud one got the atlas
  const isSkyline = (m) => !manifest.materials[m.name] || /Skyline/.test(manifest.materials[m.name].shader) || /_environment$/.test(m.name);
  obj.traverse((o) => {
    if (o.isMesh) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      if (mats.every(isSkyline) && geometry) o.geometry = geometry;
      // Vertex color mode without a decoded mesh: the glb's own colors
      const skylineMat = mat.vertexColors || !o.geometry.attributes.color || bg.colorMode !== 2 ? mat : vertexColored;
      const out = mats.map((m) => (isSkyline(m) ? skylineMat : own(m)));
      o.material = out.length === 1 ? out[0] : out;
      o.frustumCulled = false;
      // Behind the level, in front of the sky. The skyline sky goes first, then its other
      // objects in Unity queue order: Cosmic Crossroads' planets don't write depth and
      // would otherwise vanish behind the sky dome
      const queue = Math.min(...mats.map((m) => (isSkyline(m) ? 0 : manifest.materials[m.name]?.renderQueue ?? 2000)));
      o.renderOrder = queue ? -1000 + (queue - 2000) / 1000 : -1500;
    }
  });
  obj.userData.distance = bg.distance ?? 1000;
  skylineGroup.add(obj);
}

/**
 * 1.x skyline: layers of flat silhouettes (one color per layer, Custom/Distorted/Skyline),
 * farthest first. Fill objects repeat across the view; single objects (monuments) stand
 * once each within the skyline limits.
 */
async function loadSkylineLayers(cfg) {
  const layers = [...cfg.layers].sort((a, b) => a.index - b.index);
  const maxIndex = Math.max(...layers.map((l) => l.index));
  const rng = mulberry32(0x736b79);
  for (const layer of layers) {
    const group = new THREE.Group();
    const color = new THREE.Color(...(layer.tint ?? [1, 1, 1]).slice(0, 3));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: color }, ...skylineUniforms },
      vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform vec3 uColor; uniform float uOpacity; void main() { gl_FragColor = vec4(uColor, uOpacity); }',
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const place = async (name, x) => {
      const prefab = manifest.prefabs[name];
      if (!prefab?.glb || !prefab.bbox) return null;
      const obj = (await loadGlb(prefab.glb)).clone();
      obj.position.x = x;
      obj.traverse((o) => {
        if (!o.isMesh) return;
        o.material = mat;
        o.frustumCulled = false;
        o.renderOrder = -1000 + layer.index; // farther layers first
      });
      group.add(obj);
      return prefab;
    };
    // Fill: side by side across a wide span, each tile one of the fill prefabs
    const span = 4000;
    for (let x = -span; x < span; ) {
      const name = layer.fill[Math.floor(rng() * layer.fill.length)];
      if (!name) break;
      const [lo, hi] = manifest.prefabs[name]?.bbox ?? [[0], [0]];
      const width = Math.max(hi[0] - lo[0], 50);
      await place(name, x - lo[0]);
      x += width;
    }
    for (const name of layer.singles) await place(name, cfg.limits[0] + rng() * (cfg.limits[1] - cfg.limits[0]));
    group.userData.distance = cfg.distance + (maxIndex - layer.index) * 150 - (layer.offset ?? 0);
    skylineGroup.add(group);
  }
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
  // (particles never: their bounds are the emitter's quad, not where the particles fly)
  Object.values(layers).forEach((g) => g.traverse((o) => o.isMesh && !o.userData.particles && (o.frustumCulled = culled))); // not the sky/skyline
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

/** Pillar halls / stations of the run in the studio: the "Fix" buttons this map needs. */
function fixables() {
  const layout = currentLayout('studio');
  return FIXABLE.filter((key) => wallItems(layout, key).length > 0);
}

/**
 * "Fix pillars" / "Fix platforms": every pillar hall gets its middle-lane pillars, every
 * station its platforms. Whatever stands where they go (trains, obstacles, older copies)
 * is cleared first. Outside the studio, pillars come back by turning pillar obstacles on.
 * Returns how many were put back.
 */
function fixMissing(key) {
  if (key === 'pillar' && state.obstacleMode !== 'studio') {
    state.gen.obstacles.pillar = true;
    generation.refresh();
    return regen();
  }
  const wanted = wallItems(currentLayout('studio'), key);
  const size = catalog().sizes?.[key];
  const overlaps = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;
  // Spans of an item along its lane (trains: their tiles, start train: its wagon, obstacles: their footprint)
  const spanOf = (it) => {
    if (it.type === 'train' || it.type === 'noTracks') return [it.z0, it.z1];
    if (it.type === 'startTrain') return [it.z - 30, it.z + 100];
    const s = catalog().sizes?.[it.key];
    return s ? [it.z + s.z0, it.z + s.z1] : [it.z - 5, it.z + 5];
  };
  // Where the new pieces stand: pillars in the middle lane, platforms over both outer tracks
  const spots = wanted.map((w) =>
    key === 'pillar'
      ? { lanes: [0], z0: w.z + (size?.z0 ?? -22), z1: w.z + (size?.z1 ?? 24) }
      : { lanes: [-20, 20], z0: w.z, z1: w.z + 180 },
  );
  const blocked = (it) => {
    if (it.type === 'signal' || it.type === 'noTracks') return false;
    if (it.type === 'obstacle' && it.key === key) return spots.some((sp) => overlaps(...spanOf(it), sp.z0, sp.z1));
    const lane = it.lane ?? 0;
    return spots.some((sp) => sp.lanes.includes(lane) && overlaps(...spanOf(it), sp.z0, sp.z1));
  };
  state.studio = [...state.studio.filter((it) => !blocked(it)), ...wanted];
  saveStudio();
  rebuild({ dynamicOnly: true });
  return wanted.length;
}
const catalog = () => studioCatalog(manifest, state.theme, trainTheme(), state.gen);
const modes = gameModes(manifest);
const isNormal = () => !manifest.modes?.[state.gen.mode];
const skinsOf = () => modes.find((m) => m.key === state.gen.mode)?.skins ?? [];
if (!skinsOf().some(([key]) => key === state.gen.skin)) state.gen.skin = skinsOf()[0]?.[0] ?? null;
/** Switches the game mode (generation panel and studio): its pieces, route and scenery. */
function setGameMode(key, skin = null) {
  state.gen.mode = key;
  state.gen.skin = skin ?? skinsOf()[0]?.[0] ?? null;
  generation.refresh();
  return rebuild().then(() => studio.refresh());
}
// "low_01" -> "Low 01" ("med" pieces read as "Medium")
const pieceLabel = (key) => key.replace(/^med_/, 'medium_').replace(/^(\w)/, (c) => c.toUpperCase()).replace('_', ' ');
for (const piece of buildingPieces(manifest, state.theme)) state.gen.pieces[piece.key] ??= true;
// Manifests built before random groups carried their children's names (any map imported
// before 3.68 support): read the names from the glbs, so pickers and the showcase see them
await nameRandomGroups();
for (const v of landmarkVariants(manifest, state.theme)) state.gen.variants[v.key] ??= true;
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
            {
              type: 'select',
              label: 'Game mode',
              obj: state.gen,
              key: 'mode',
              options: Object.fromEntries(modes.map((m) => [m.label, m.key])),
              visible: () => modes.length > 1,
              onChange: (key) => setGameMode(key),
            },
            {
              type: 'select',
              label: 'Skin',
              obj: state.gen,
              key: 'skin',
              options: () => Object.fromEntries(skinsOf().map(([key, label]) => [label, key])),
              visible: () => skinsOf().length > 1,
              onChange: (skin) => setGameMode(state.gen.mode, skin),
            },
            { type: 'note', label: 'Game modes lay the obstacles of their own route, between buildings', visible: () => !isNormal() },
            { type: 'select', label: 'Trains from', obj: state, key: 'trainEnv', options: trainOptions, onChange: async (id) => (id !== 'same' && (await mergeEnvironment(id)), regen()) },
          ],
        },
        {
          title: 'Map sections',
          visible: isNormal,
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
          title: 'Scenery',
          visible: () => hasSlot('classic_chunk'),
          controls: [
            {
              type: 'toggle',
              label: 'Mix scenery',
              title: 'Each section picks its own look (tunnel, forest, city…). Off: long stretches of one look, as in the game',
              obj: state.gen,
              key: 'classicMix',
              onChange: regen,
            },
          ],
        },
        {
          title: 'Fix',
          visible: () => isNormal() && hasSlot('boundary_pillars_mid') && hasSlot('obstacle_pillar'),
          controls: [{ type: 'button', label: FIX_LABELS.pillar, title: 'Put a pillar back in every pillar hall spot that has none', action: () => fixMissing('pillar') }],
        },
        {
          title: 'Landmark',
          visible: () => isNormal() && state.gen.sections.epic !== false && landmarkVariants(manifest, state.theme).length > 0,
          controls: landmarkVariants(manifest, state.theme).map((v) => ({
            type: 'toggle',
            label: v.label,
            obj: state.gen.variants,
            key: v.key,
            onChange: regen,
            extra: { label: '👁', title: 'Preview the landmark', action: () => (generation.close(), inspectPieces([v.prefab])) },
          })),
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
        {
          title: 'Particles',
          controls: [
            { type: 'toggle', label: 'Smoke, glows, sparks', obj: state, key: 'particles', onChange: () => (rebuild(), applyThemeLook()) },
            { type: 'toggle', label: 'Snow along the run', obj: state, key: 'weather', visible: () => !!themeSnow(), onChange: applyThemeLook },
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
  fromRun: () => runToStudio(),
  getMode: () => ({ mode: state.gen.mode, skin: state.gen.skin ?? skinsOf()[0]?.[0] ?? null, skins: skinsOf() }),
  setMode: (key, skin) => setGameMode(key, skin),
  fixables: () => fixables(),
  fixMissing: (key) => fixMissing(key),
  // Skin of a train placed with "Any" before skins were fixed at placement
  actualVariant: (it) => {
    const shown = window.__viewer?.items?.find((i) => i.group === `studio${it.lane}@${it.z0}` && i.slot.startsWith('train_') && i.slot !== 'train_ramp');
    return shown ? Object.keys(TRAIN_VARIANTS).find((v) => TRAIN_VARIANTS[v].test(shown.prefab)) ?? null : null;
  },
  onExit: () => exitStudio(),
});

/**
 * The auto-generated run as studio items. Classic chunks pick their trains and obstacles
 * when instantiated, so those are read from the chunks as the run lays them out.
 */
async function runToStudio(mode = 'random') {
  const items = currentLayout(mode).items;
  const chunks = items.filter((it) => manifest.prefabs[it.prefab]?.chunk);
  if (!chunks.length) return itemsToStudio(items);
  const out = [];
  const v = new THREE.Vector3();
  for (const it of chunks) {
    const obj = await instantiateChunk(manifest.prefabs[it.prefab], it.layer, it.variantSeed, it.pos[2], { keepObstacles: true });
    if (!obj) continue;
    obj.position.set(...it.pos);
    obj.updateMatrixWorld(true);
    const ramps = [];
    const trains = [];
    const box = new THREE.Box3();
    obj.traverse((o) => {
      // Names as exported, less three.js's "_2", "_3"… for repeats; classic node names hold no digits
      const name = o.name.replace(/(_\d+)+$/, '');
      o.getWorldPosition(v);
      const lane = Math.max(-20, Math.min(20, Math.round(v.x / 20) * 20));
      let m;
      if ((m = name.match(/^(?:train_|Classic_Train_Static_\d_)(cargo|standard|sub)/i))) {
        box.setFromObject(o);
        if (box.isEmpty()) return;
        const cars = Math.max(1, Math.round((box.max.z - box.min.z) / 60));
        trains.push({ lane, z: Math.round(box.min.z), cars, variant: { cargo: 'cargo', standard: 'passenger', sub: 'subway' }[m[1].toLowerCase()] });
      } else if (/^(train_ramp|Classic_Ramp)$/.test(name)) ramps.push({ lane, z: v.z });
      else if ((m = name.match(/^(?:blocker_|Classic_Blocker_)(jump|roll|standard)$/i))) out.push({ type: 'obstacle', key: m[1].toLowerCase(), lane, z: Math.round(v.z) });
      else if (/^(lightSignal|Classic_LightSignal)$/.test(name)) out.push({ type: 'signal', x: Math.round(v.x), z: Math.round(v.z), color: 'green' });
    });
    for (const t of trains) {
      // A ramp just in front of the train in its lane
      const ramp = ramps.find((r) => r.lane === t.lane && Math.abs(t.z - (r.z + 30)) < 15);
      const z0 = ramp ? Math.round(ramp.z - 36) : t.z;
      if (out.some((o) => o.type === 'train' && o.lane === t.lane && o.z0 === z0)) continue; // node and its mesh child
      out.push({ type: 'train', lane: t.lane, z0, z1: t.z + trainLength(t.cars), kind: 'static', variant: t.variant, ramp: !!ramp });
    }
  }
  return out;
}

async function enterStudio() {
  settings.close();
  generation.close();
  rendering.close();
  if (state.obstacleMode !== 'studio') {
    // Start from the run on screen when nothing was placed yet
    if (!state.studio.length) {
      state.studio = await runToStudio(state.obstacleMode);
      saveStudio();
    } else migrateStudioPlatforms();
    state.obstacleMode = 'studio';
  }
  fly.enabled = orbit.enabled = false;
  document.body.classList.add('studio');
  rebuild().then(() => (studio.enter(), applyThemeLook(), applyBend()));
}

/**
 * Station platforms became studio items (wiped and "fixed" like pillars). Lists saved
 * before have none: they get the run's platforms once, so stations don't lose them.
 */
function migrateStudioPlatforms() {
  const key = `studio-platforms:${ENV_ID}`;
  try {
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, '1');
  } catch {
    return;
  }
  if (state.studio.some((it) => it.type === 'obstacle' && it.key === 'platform')) return;
  state.studio = [...state.studio, ...wallItems(currentLayout('studio'), 'platform')];
  saveStudio();
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
// Debug menu (K): tools for checking imports
const debugMenu = createSettings(
  document.getElementById('ui'),
  [
    {
      tab: 'Debug',
      groups: [
        {
          title: 'Generation',
          controls: [
            {
              type: 'toggle',
              label: 'Show everything',
              title: 'No randomness: every building piece, section and landmark variant once, one after the other',
              obj: state.gen,
              key: 'showcase',
              // A debug mode for going through maps: stays on from one map to the next
              onChange: () => (storeFlag('debug:showcase', state.gen.showcase), regen()),
            },
          ],
        },
      ],
    },
  ],
  { title: 'Debug' },
);

addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.code === 'KeyK' && !e.metaKey && !e.ctrlKey && !studio.active) {
    settings.close();
    generation.close();
    rendering.close();
    debugMenu.toggle();
    return;
  }
  if (e.code === 'Tab') {
    e.preventDefault();
    document.body.classList.toggle('ui-hidden');
  } else if (e.code === 'KeyM' && !studio.active) {
    settings.toggle();
  } else if (e.code === 'Escape' && (settings.isOpen() || generation.isOpen() || debugMenu.isOpen())) {
    settings.close();
    generation.close();
    debugMenu.close();
  }
});

applyCamera(state.camera);
// Debug: start further down the run (?z=1800), e.g. to check a showcase chunk
if (params.get('z')) {
  const dz = Number(params.get('z')) || 0;
  camera.position.z += dz;
  orbit.target.z += dz;
  camera.lookAt(orbit.target);
}
setControlMode(state.controls);
window.__viewer = { motions, fly, renderScreenshot, screenshot, state, camera, layers, cutawayDebug, largestIslandCenter, sky, scene, THREE, settings, enterStudio, exitStudio, rebuild };
await rebuild();

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const now = clock.getElapsedTime();
  const dt = now - globals.uTime.value;
  globals.uTime.value = now;
  updateMeshAnimations(now);
  updateAnimators(dt);
  updateParticles(dt, studio.active ? studio.camera : camera);
  if (orbit.enabled) orbit.update();
  fly.update();
  updateSkyline();
  updateCutaway();
  renderer.setRenderTarget(viewTarget);
  renderer.render(scene, studio.active ? studio.camera : camera);
  renderer.setRenderTarget(null);
  renderer.render(blitScene, blitCamera);
});
