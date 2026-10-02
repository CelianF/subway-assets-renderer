import * as THREE from 'three';

// Hides only the geometry "islands" (connected triangle groups — a building,
// a roof, a train car) whose bounds contain the camera. The floor is split off
// first so it is never hidden.

const islandData = new WeakMap(); // geometry -> { islands: [{box, tris}], fullIndex }
const MARGIN = 1.5; // grow island boxes a bit so the near plane doesn't clip walls

/**
 * Prepares a loaded glb scene (once per template, before cloning).
 * @param floorY triangles entirely at or below this height stay visible; -Infinity = no floor
 */
export function prepareCutaway(root, floorY) {
  root.updateMatrixWorld(true);
  const meshes = [];
  root.traverse((o) => o.isMesh && meshes.push(o));
  const v = new THREE.Vector3();
  for (const mesh of meshes) {
    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    const index = geo.index?.array ?? Uint32Array.from({ length: pos.count }, (_, i) => i);
    if (floorY > -Infinity) {
      const ys = new Float32Array(pos.count);
      for (let i = 0; i < pos.count; i++) ys[i] = v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).y;
      const floor = [];
      const upper = [];
      for (let t = 0; t < index.length; t += 3) {
        const a = index[t], b = index[t + 1], c = index[t + 2];
        (Math.max(ys[a], ys[b], ys[c]) <= floorY ? floor : upper).push(a, b, c);
      }
      if (!upper.length) continue;
      if (floor.length) {
        // Floor stays on the original mesh, the rest moves to a child mesh
        mesh.geometry = subsetGeometry(geo, floor);
        const top = new THREE.Mesh(subsetGeometry(geo, upper), mesh.material);
        top.name = `${mesh.name}_upper`;
        mesh.add(top);
        markCutaway(top, Uint32Array.from(upper));
        continue;
      }
    }
    if (!geo.index) geo.setIndex(Array.from(index));
    markCutaway(mesh, Uint32Array.from(index));
  }
}

function subsetGeometry(geo, indices) {
  const g = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(geo.attributes)) g.setAttribute(name, attr);
  g.setIndex(indices);
  return g;
}

function markCutaway(mesh, index) {
  mesh.userData.cutaway = true;
  islandData.set(mesh.geometry, { islands: findIslands(mesh.geometry.attributes.position, index), fullIndex: index });
}

/** Connected components over triangles; vertices are welded by position (UV seams split them). */
function findIslands(pos, index) {
  const weld = new Map();
  const vid = new Int32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const key = `${Math.round(pos.getX(i) * 100)},${Math.round(pos.getY(i) * 100)},${Math.round(pos.getZ(i) * 100)}`;
    let id = weld.get(key);
    if (id === undefined) weld.set(key, (id = weld.size));
    vid[i] = id;
  }
  const parent = Int32Array.from({ length: weld.size }, (_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  for (let t = 0; t < index.length; t += 3) {
    const a = find(vid[index[t]]);
    parent[find(vid[index[t + 1]])] = a;
    parent[find(vid[index[t + 2]])] = a;
  }
  const groups = new Map();
  const v = new THREE.Vector3();
  for (let t = 0; t < index.length; t += 3) {
    const root = find(vid[index[t]]);
    let g = groups.get(root);
    if (!g) groups.set(root, (g = { box: new THREE.Box3(), tris: [] }));
    for (let k = 0; k < 3; k++) g.box.expandByPoint(v.fromBufferAttribute(pos, index[t + k]));
    g.tris.push(index[t], index[t + 1], index[t + 2]);
  }
  return clusterIslands([...groups.values()]).map((g) => ({ box: g.box.expandByScalar(MARGIN), tris: g.tris }));
}

const TOUCH = 0.25; // islands closer than this belong to the same asset

/**
 * Merges islands whose bounds touch: buildings are often separate wall/floor slabs,
 * and the camera standing in the room is inside none of them individually.
 */
function clusterIslands(islands) {
  const parent = islands.map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  const grown = islands.map((isl) => isl.box.clone().expandByScalar(TOUCH));
  for (let i = 0; i < islands.length; i++) {
    for (let j = i + 1; j < islands.length; j++) {
      if (grown[i].intersectsBox(grown[j])) parent[find(j)] = find(i);
    }
  }
  const clusters = new Map();
  islands.forEach((isl, i) => {
    const root = find(i);
    const c = clusters.get(root);
    if (!c) clusters.set(root, { box: isl.box.clone(), tris: [...isl.tris] });
    else {
      c.box.union(isl.box);
      for (const t of isl.tris) c.tris.push(t);
    }
  });
  return [...clusters.values()];
}

const pieces = new WeakMap(); // piece root -> { box, parts: [{ mesh, boxes }], whole, group }
const partState = new WeakMap(); // mesh -> { shared, key }

// Side buildings are facades open at the back: standing behind one counts as inside
const SIDE_X = 15; // clusters centered further than this from the track are side buildings

/**
 * Per-instance state; call after adding a cloned piece to the scene.
 * @param openBacks extend side-building bounds away from the track (environment pieces)
 * @param whole hide the entire piece (and its group) once the camera is inside any part (trains)
 * @param group pieces sharing a group hide together (a train and its ramp)
 */
export function registerPiece(obj, { openBacks = false, whole = false, group = null } = {}) {
  obj.updateMatrixWorld(true);
  const parts = [];
  const box = new THREE.Box3();
  obj.traverse((o) => {
    if (!o.userData.cutaway) return;
    const data = islandData.get(o.geometry);
    if (!data) return;
    const boxes = data.islands.map((isl) => {
      const b = isl.box.clone().applyMatrix4(o.matrixWorld);
      if (openBacks) {
        const cx = (b.min.x + b.max.x) / 2;
        if (cx > SIDE_X) b.max.x = Infinity;
        else if (cx < -SIDE_X) b.min.x = -Infinity;
      }
      box.union(b);
      return b;
    });
    parts.push({ mesh: o, boxes });
  });
  pieces.set(obj, { box, parts, whole, group: group ?? obj });
}

/** Indices of the islands of one part that contain the camera, as a key string. */
function insideKey(boxes, cameraPos) {
  let key = '';
  boxes.forEach((b, i) => b.containsPoint(cameraPos) && (key += `${i},`));
  return key;
}

/** Updates hidden islands of all pieces for the world-space camera position (null = show all). */
export function updatePieces(objs, cameraPos) {
  // Pass 1: which islands contain the camera; whole pieces mark their group
  const keys = new Map();
  const hitGroups = new Set();
  for (const obj of objs) {
    const piece = pieces.get(obj);
    if (!piece) continue;
    const near = cameraPos && piece.box.containsPoint(cameraPos);
    const partKeys = piece.parts.map(({ boxes }) => (near ? insideKey(boxes, cameraPos) : ''));
    keys.set(obj, partKeys);
    if (piece.whole && partKeys.some(Boolean)) hitGroups.add(piece.group);
  }
  // Pass 2: apply (whole pieces in a hit group hide every island)
  for (const [obj, partKeys] of keys) {
    const piece = pieces.get(obj);
    const all = piece.whole && hitGroups.has(piece.group);
    piece.parts.forEach(({ mesh, boxes }, i) => applyKey(mesh, all ? boxes.map((_, k) => `${k},`).join('') : partKeys[i]));
  }
}

function applyKey(mesh, key) {
  const state = partState.get(mesh) ?? { shared: mesh.geometry, key: '' };
  if (key === state.key) return;
  if (mesh.geometry !== state.shared) mesh.geometry.dispose();
  if (!key) {
    mesh.geometry = state.shared; // back to the shared template geometry
    partState.delete(mesh);
    return;
  }
  // Instance-specific index without the hidden islands (attributes stay shared)
  const { islands } = islandData.get(state.shared);
  const skip = new Set(key.split(',').filter(Boolean).map(Number));
  mesh.geometry = subsetGeometry(state.shared, islands.filter((_, i) => !skip.has(i)).flatMap((isl) => isl.tris));
  partState.set(mesh, { shared: state.shared, key });
}

/** Debug: pieces whose bounds contain `pos`, and how many islands are hidden in each. */
export function cutawayDebug(objs, pos) {
  return objs
    .filter((o) => pieces.get(o)?.box.containsPoint(pos))
    .map((o) => ({
      name: o.name,
      parts: pieces.get(o).parts.length,
      hidden: pieces.get(o).parts.map((p) => partState.get(p.mesh)?.key ?? '').join('|'),
    }));
}

/** Debug: world-space center of the largest island of a piece (to park the camera in). */
export function largestIslandCenter(obj) {
  let best = null;
  for (const { mesh: part } of pieces.get(obj)?.parts ?? []) {
    const data = islandData.get(partState.get(part)?.shared ?? part.geometry);
    for (const isl of data?.islands ?? []) {
      const size = isl.box.getSize(new THREE.Vector3()).length();
      if (!best || size > best.size) best = { size, center: part.localToWorld(isl.box.getCenter(new THREE.Vector3())) };
    }
  }
  return best?.center;
}
