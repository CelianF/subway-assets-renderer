import * as THREE from 'three';
import { globals } from './materials.js';

// Unity particle systems (smoke, steam, glows, fireflies, sparks, dust, leaves), from the
// manifest's per-node emitter descriptions (tools/build_manifest.mjs parseParticles).
// Simulated on the CPU in the emitter's own space and drawn as one instanced mesh per
// emitter: camera-facing quads (billboard, stretched, horizontal, vertical) or the
// particle mesh. Unity local space is left-handed; the glb export mirrors X, so emitted
// positions and directions are mirrored the same way.

const emitters = new Set();
const ACTIVE_DISTANCE = 3000; // emitters farther from the camera than this pause
const STEP = 1 / 30;

// ---------------------------------------------------------------- curves

function evalKeys(keys, t) {
  if (!keys?.length) return 1;
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, v0] = keys[i - 1];
      const [t1, v1] = keys[i];
      return v0 + ((v1 - v0) * (t - t0)) / Math.max(t1 - t0, 1e-6);
    }
  }
  return keys[keys.length - 1][1];
}

/** MinMaxCurve at normalized time t with random r. */
function sample(c, t = 0, r = Math.random()) {
  if (!c) return 0;
  switch (c.mode) {
    case 1:
      return c.curve?.length ? c.max * evalKeys(c.curve, t) : c.max;
    case 2: {
      // Random between two curves, one multiplier (maps built before curves were kept for
      // this mode: random between the two values)
      if (!c.curve?.length) return c.min + (c.max - c.min) * r;
      const lo = evalKeys(c.minCurve, t);
      return c.max * (lo + (evalKeys(c.curve, t) - lo) * r);
    }
    case 3: // random between two constants
      return c.min + (c.max - c.min) * r;
    default:
      return c.max;
  }
}

function evalGradient(g, t, out) {
  if (!g) return out.set(1, 1, 1, 1);
  const pick = (keys, n) => {
    if (!keys.length) return n === 3 ? [1, 1, 1] : [1];
    if (t <= keys[0][0]) return keys[0].slice(1);
    for (let i = 1; i < keys.length; i++) {
      if (t <= keys[i][0]) {
        const a = keys[i - 1];
        const b = keys[i];
        const f = (t - a[0]) / Math.max(b[0] - a[0], 1e-6);
        return a.slice(1).map((v, k) => v + (b[k + 1] - v) * f);
      }
    }
    return keys[keys.length - 1].slice(1);
  };
  const [r, gg, b] = pick(g.colors, 3);
  const [a] = pick(g.alphas, 1);
  return out.set(r, gg, b, a);
}

const tmpA = new THREE.Vector4();
const tmpB = new THREE.Vector4();
const tmpCenter = new THREE.Vector3();
const tmpRel = new THREE.Vector3();
const forceTmp = new THREE.Vector3();
const TRAIL_POINTS = 48; // positions kept per particle trail (spread over the trail's lifetime)
const tmpEuler = new THREE.Euler();
/** MinMaxGradient at normalized time t with random r. */
function sampleColor(c, t, r, out) {
  if (!c) return out.set(1, 1, 1, 1);
  switch (c.mode) {
    case 1:
      return evalGradient(c.gradient, t, out);
    case 2:
      return out.set(...c.min).lerp(tmpA.set(...c.max), r);
    case 3:
      evalGradient(c.minGradient, t, tmpA);
      evalGradient(c.gradient, t, tmpB);
      return out.copy(tmpA).lerp(tmpB, r);
    case 4:
      return evalGradient(c.gradient, r, out);
    default:
      return out.set(...(c.max ?? [1, 1, 1, 1]));
  }
}

// ---------------------------------------------------------------- shapes

const DEG = Math.PI / 180;
const randomUnit = (v) => {
  const z = Math.random() * 2 - 1;
  const a = Math.random() * Math.PI * 2;
  const s = Math.sqrt(1 - z * z);
  return v.set(Math.cos(a) * s, Math.sin(a) * s, z);
};

/** Spawn position and direction in Unity shape space. */
/** A cone in Shape scaling mode (older manifests: one whose root scale stretches it). */
const shapeCone = (shape) => [4, 7, 8, 9].includes(shape.type) && (shape.scaling === 2 || !!shape.scale);

function shapeSpawn(shape, pos, dir) {
  if (!shape) {
    pos.set(0, 0, 0);
    return randomUnit(dir);
  }
  const radius = shape.radius ?? 1;
  const arc = (shape.arc ?? 360) * DEG;
  switch (shape.type) {
    case 0: // sphere
    case 1:
      randomUnit(dir);
      pos.copy(dir).multiplyScalar(shape.type === 1 ? radius : radius * Math.cbrt(Math.random()));
      break;
    case 2: // hemisphere
    case 3:
      randomUnit(dir);
      dir.z = Math.abs(dir.z);
      pos.copy(dir).multiplyScalar(shape.type === 3 ? radius : radius * Math.cbrt(Math.random()));
      break;
    case 4: // cone: spawn on the base disc, aim out by the cone angle
    case 7:
    case 8:
    case 9: {
      const a = Math.random() * arc;
      const rf = shape.type === 7 || shape.type === 9 ? 1 : Math.sqrt(Math.random());
      const tilt = (shape.angle ?? 25) * DEG * rf;
      pos.set(Math.cos(a) * radius * rf, Math.sin(a) * radius * rf, 0);
      dir.set(Math.cos(a) * Math.sin(tilt), Math.sin(a) * Math.sin(tilt), Math.cos(tilt));
      break;
    }
    case 5: // box
    case 15:
    case 16: {
      const [x, y, z] = shape.box ?? [1, 1, 1];
      pos.set((Math.random() - 0.5) * x, (Math.random() - 0.5) * y, (Math.random() - 0.5) * z);
      dir.set(0, 0, 1);
      break;
    }
    case 10: // circle
    case 11:
    case 17: {
      const a = Math.random() * arc;
      const rf = shape.type === 10 ? Math.sqrt(Math.random()) : 1;
      pos.set(Math.cos(a) * radius * rf, Math.sin(a) * radius * rf, 0);
      dir.set(Math.cos(a), Math.sin(a), 0);
      break;
    }
    case 12: // single-sided edge: a line along X, emitting along +Y
      pos.set((Math.random() * 2 - 1) * radius, 0, 0);
      dir.set(0, 1, 0);
      break;
    case 18: {
      // rectangle
      const [x, y] = shape.box ?? [1, 1, 1];
      pos.set((Math.random() - 0.5) * x, (Math.random() - 0.5) * y, 0);
      dir.set(0, 0, 1);
      break;
    }
    default: // mesh shapes: from the emitter's origin (along +Z when no mesh is set)
      pos.set(0, 0, 0);
      if (shape.hasMesh === false) dir.set(0, 0, 1);
      else randomUnit(dir);
  }
  // (not on Shape-scaling cones, the 1.x smoke and steam: in game they rise in their cone,
  // one way; 1.98 Atlanta, 1.92 Berlin. Matched by eye)
  if (shape.randomDirection && !shapeCone(shape)) {
    const r = randomUnit(new THREE.Vector3());
    // A cone's random directions stay on its open side (1.98 Atlanta's barbecue smoke and
    // smoke bombs rise one way only, never back under the grill)
    if ([4, 7, 8, 9].includes(shape.type) && r.dot(dir) < 0) r.negate();
    dir.lerp(r, shape.randomDirection).normalize();
  }
  if (shape.rotation?.some((v) => v)) {
    // Unity's Euler turns by Z, then X, then Y: three's 'YXZ' (with 'ZXY', Y went first and
    // 3.67 Fantasy Fest's arrows, pitched up 32° then turned to the track, flew flat)
    const e = new THREE.Euler(shape.rotation[0] * DEG, shape.rotation[1] * DEG, shape.rotation[2] * DEG, 'YXZ');
    pos.applyEuler(e);
    dir.applyEuler(e);
  }
  if (shape.position) pos.add(new THREE.Vector3(...shape.position));
  // Shape scaling mode: the emitter's own scale moves the start positions only
  if (shape.scale) pos.multiply(new THREE.Vector3(...shape.scale));
  return dir;
}

// ---------------------------------------------------------------- rendering

const QUAD_VERTEX = /* glsl */ `
uniform vec2 uBend;
uniform float uMode; // 0 billboard, 1 stretched, 2 horizontal, 3 vertical
uniform float uOriented; // 3D-rotated quads in the emitter's frame (Local/World alignment)
uniform float uLengthScale;
uniform float uVelocityScale;
uniform float uMaxSize; // fraction of the view height at that depth
uniform float uScale;
uniform vec2 uSheet;
attribute vec3 iPos;
attribute vec4 iColor;
attribute vec4 iMisc; // size, rotation, sheet frame, unused
attribute vec3 iVel;
attribute vec2 iTilt; // 3D start rotation about X and Y
varying vec2 vUv;
varying vec4 vColor;
varying float vDepth;
void main() {
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  float size = iMisc.x * uScale;
  float depth = max(-mv.z, 0.0);
  size = min(size, uMaxSize * depth * 2.0 / projectionMatrix[1][1]);
  vec2 corner = position.xy;
  float c = cos(iMisc.y), s = sin(iMisc.y);
  if (uOriented > 0.5) {
    // turned like Unity's Euler: Z (the 2D rotation), then X, then Y
    vec3 q = vec3(mat2(c, -s, s, c) * position.xy * iMisc.x, 0.0);
    float cx = cos(iTilt.x), sx = sin(iTilt.x), cy = cos(iTilt.y), sy = sin(iTilt.y);
    q = vec3(q.x, cx * q.y - sx * q.z, sx * q.y + cx * q.z);
    q = vec3(cy * q.x + sy * q.z, q.y, -sy * q.x + cy * q.z);
    mv = modelViewMatrix * vec4(iPos + q, 1.0);
  } else if (uMode == 2.0) {
    // horizontal: flat in the emitter's XZ plane
    vec3 local = vec3(mat2(c, -s, s, c) * corner * iMisc.x, 0.0).xzy;
    mv = modelViewMatrix * vec4(iPos + local / max(uScale, 1e-4) * uScale, 1.0);
  } else if (uMode == 1.0) {
    // stretched along the velocity in 3D, turned about it to face the camera: on screen
    // only, a particle flying straight away (Cosmic Crossroads' stars into the portal) had
    // no direction and stood upright
    vec3 v = (modelViewMatrix * vec4(iVel, 0.0)).xyz;
    vec3 axis = length(v) > 1e-4 ? normalize(v) : vec3(0.0, 1.0, 0.0);
    vec3 side = cross(axis, normalize(-mv.xyz));
    side = length(side) > 1e-4 ? normalize(side) : vec3(1.0, 0.0, 0.0);
    float len = size * uLengthScale + length(v) * uVelocityScale;
    mv.xyz += axis * corner.y * len + side * corner.x * size;
  } else {
    mv.xy += mat2(c, -s, s, c) * corner * size;
  }
  depth = max(-mv.z, 0.0);
  mv.xy += vec2(uBend.x, -uBend.y) * depth * depth;
  vDepth = -mv.z;
  float frame = floor(iMisc.z);
  vec2 cell = vec2(mod(frame, uSheet.x), floor(frame / uSheet.x));
  vUv = (vec2(uv.x, 1.0 - uv.y) + cell) / uSheet; // sheet rows top to bottom
  vColor = iColor;
  gl_Position = projectionMatrix * mv;
}
`;

const MESH_VERTEX = /* glsl */ `
uniform vec2 uBend;
uniform vec2 uSheet;
attribute vec4 iColor;
attribute float iFrame;
varying vec2 vUv;
varying vec4 vColor;
varying float vDepth;
void main() {
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  float depth = max(-mv.z, 0.0);
  mv.xy += vec2(uBend.x, -uBend.y) * depth * depth;
  vDepth = -mv.z;
  // Texture sheet frames (Cambridge's bats flap their wings): glb UVs start top-left
  vec2 cell = vec2(mod(iFrame, uSheet.x), floor(iFrame / uSheet.x));
  vUv = (uv + cell) / uSheet;
  vColor = iColor;
  gl_Position = projectionMatrix * mv;
}
`;

// Particle trails: a ribbon through each particle's recent positions, turned to face the
// camera; aPrev is the next point back along the trail, aSide the ribbon edge
const TRAIL_VERTEX = /* glsl */ `
uniform vec2 uBend;
attribute vec3 aPrev;
attribute float aSide;
attribute float aWidth;
attribute vec4 aColor;
varying vec2 vUv;
varying vec4 vColor;
varying float vDepth;
void main() {
  vec4 a = modelViewMatrix * vec4(position, 1.0);
  vec4 b = modelViewMatrix * vec4(aPrev, 1.0);
  vec2 d = a.xy - b.xy;
  d = length(d) > 1e-5 ? normalize(d) : vec2(0.0, 1.0);
  a.xy += vec2(-d.y, d.x) * aSide * aWidth * 0.5;
  float depth = max(-a.z, 0.0);
  a.xy += vec2(uBend.x, -uBend.y) * depth * depth;
  vDepth = -a.z;
  vUv = vec2(0.5);
  vColor = aColor;
  gl_Position = projectionMatrix * a;
}
`;

const FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform vec4 uTint;
uniform vec3 uFogColor;
uniform vec2 uFogRange;
uniform float uFogOn;
varying vec2 vUv;
varying vec4 vColor;
varying float vDepth;
void main() {
#ifdef VERTEX_COLORS
  vec4 c = texture2D(uMap, vUv) * vColor * uTint;
#else
  vec4 c = texture2D(uMap, vUv) * uTint;
#endif
  float fog = uFogOn * clamp((vDepth - uFogRange.x) / max(uFogRange.y - uFogRange.x, 1.0), 0.0, 1.0);
#if FADE_MODE == 2
  c.rgb *= 1.0 - fog; // additive fades to nothing
#elif FADE_MODE == 3
  c.rgb = mix(c.rgb, vec3(1.0), fog); // multiply fades to neutral
#elif FADE_MODE == 4
  c *= 1.0 - fog; // premultiplied
#else
  c.rgb = mix(c.rgb, uFogColor, fog);
#endif
  if (c.a < 0.003 && c.r + c.g + c.b < 0.003) discard;
  gl_FragColor = c;
}
`;

const WHITE = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
WHITE.needsUpdate = true;
// Soft round dot for systems without a material
const DOT = (() => {
  const n = 32;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const d = Math.hypot(x - n / 2 + 0.5, y - n / 2 + 0.5) / (n / 2);
      const a = Math.max(0, 1 - d) ** 2 * 255;
      data.set([255, 255, 255, a], (y * n + x) * 4);
    }
  }
  const t = new THREE.DataTexture(data, n, n);
  t.needsUpdate = true;
  return t;
})();

/** Blend, texture and tint of a particle material (Unity built-in, SYBO, 1.x Custom). */
export function particleLook(materials, name, renderMode = 0) {
  // Unity's built-in Sprites-Default: a white square, alpha blended, in the particle color
  if (name === '__builtin_Sprites-Default') return { map: WHITE, src: 5, dst: 10, fadeMode: 1, tint: [1, 1, 1, 1], vertexColors: true };
  const def = name ? materials.defs[name] : null;
  const shader = def?.shader ?? 'Particles/Additive';
  const f = def?.floats ?? {};
  const c = def?.colors ?? {};
  let blend;
  // Blend factors when the material has them (Combined, Bend/Particle Effect…), else from the name
  if (f._SrcMode != null && f._DstMode != null) blend = [f._SrcMode, f._DstMode];
  else if (/Premultipl/i.test(shader)) blend = [1, 10];
  else if (/Additive/i.test(shader)) blend = [/Premul/i.test(shader) ? 1 : 5, 1];
  else if (/Multiply/i.test(shader)) blend = [2, 0];
  else blend = [5, 10];
  const [src, dst] = blend;
  const fadeMode = src === 2 ? 3 : dst === 1 ? 2 : src === 1 && dst === 10 ? 4 : 1;
  // Legacy particle shaders double _TintColor (0.5 grey = unchanged)
  let tint = c._TintColor ? c._TintColor.map((v) => v * 2) : c._MainColor && /Additive/i.test(shader) ? [...c._MainColor.slice(0, 3), 1] : c._Color ?? [1, 1, 1, 1];
  // Combined's color multiplier (3.12 Copenhagen's firework rays: 1.5, gold-white, not orange)
  const mult = f._HasMultiplier || def?.keywords?.includes('MULTIPLIER_ENABLED') ? f._Multiplier ?? 1 : 1;
  if (mult !== 1) tint = [...tint.slice(0, 3).map((v) => v * mult), tint[3] ?? 1];
  // Combined without VERTEX_COLORS: meshes cut from the city atlas ignore the particle
  // color (3.60 Ireland seagulls: dark grey start color, Sydney's fish: red). The rest keep
  // it, their tints and fades live there: billboards (cloud Space Station's purple fog),
  // white masks (Cambridge's black bats), fading meshes (Cambridge's tube light beam)
  const atlas = /_environment[^/]*$/i.test(def?.textures?._MainTex?.url ?? '');
  const vertexColors = shader !== 'SYBO/Bend/Combined' || renderMode !== 4 || !atlas || !!f._HasVertexColors || !!def?.keywords?.includes('VERTEX_COLORS_ENABLED');
  // Pre-3.0 particle shaders (Bend/Particle_AlphaBlend) name their texture _Texture
  let map = def ? materials.tex(def, '_MainTex') ?? materials.tex(def, '_Texture') : null;
  // A mesh particle whose material has no texture is plain (Unity's "white" default), not
  // the soft dot: Vancouver's train start leaves came out black around a colored middle
  if (!map && def && renderMode === 4) map = WHITE;
  // One/Zero with depth writes: drawn as a solid (3.68 Cosmic Crossroads' rocks and cars
  // flying into the portal showed their far faces through, sorted as transparent)
  const opaque = src === 1 && dst === 0 && f._ZWrite !== 0;
  return { map, src, dst, fadeMode, tint, vertexColors, opaque };
}

const BLEND = [
  THREE.ZeroFactor,
  THREE.OneFactor,
  THREE.DstColorFactor,
  THREE.SrcColorFactor,
  THREE.OneMinusDstColorFactor,
  THREE.SrcAlphaFactor,
  THREE.OneMinusSrcColorFactor,
  THREE.DstAlphaFactor,
  THREE.OneMinusDstAlphaFactor,
  THREE.SrcAlphaSaturateFactor,
  THREE.OneMinusSrcAlphaFactor,
];

function makeMaterial(look, vertexShader, extraUniforms) {
  return new THREE.ShaderMaterial({
    defines: { FADE_MODE: look.fadeMode, ...(look.vertexColors ? { VERTEX_COLORS: '' } : {}) },
    vertexShader,
    fragmentShader: FRAGMENT,
    uniforms: {
      ...globals,
      uMap: { value: look.map ?? DOT },
      uTint: { value: new THREE.Vector4(...look.tint) },
      ...extraUniforms,
    },
    transparent: !look.opaque,
    depthWrite: !!look.opaque,
    blending: look.opaque ? THREE.NoBlending : THREE.CustomBlending,
    blendSrc: BLEND[look.src],
    blendDst: BLEND[look.dst],
    side: THREE.DoubleSide,
  });
}

// ---------------------------------------------------------------- emitters

const UP = new THREE.Vector3(0, 1, 0);

class Emitter {
  constructor(node, root, def, materials, meshGeometry) {
    this.root = root;
    this.def = def;
    this.node = node;
    this.max = Math.max(1, def.max);
    this.mesh = def.render.mode === 4 && meshGeometry;
    this.local = { pos: new Float32Array(this.max * 3), vel: new Float32Array(this.max * 3) };
    this.age = new Float32Array(this.max);
    this.life = new Float32Array(this.max);
    this.size0 = new Float32Array(this.max);
    this.rot = new Float32Array(this.max);
    this.tilt = new Float32Array(this.max * 2);
    this.spin = new Float32Array(this.max);
    this.color0 = new Float32Array(this.max * 4);
    this.rand = new Float32Array(this.max * 2);
    this.axis = new Float32Array(this.max * 3);
    this.heading = new Float32Array(this.max * 3); // direction of travel (velocity-aligned meshes)
    this.ids = new Int32Array(this.max); // stable particle ids, for birth sub-emitters
    this.index = new Map(); // id -> slot
    this.nextId = 1;
    this.subs = []; // { emitter, type: 0 birth | 2 death, probability, inheritColor }
    this.sources = null; // as a sub-emitter: where its parent's particles start it
    this.spawnOffset = null; // weather: emission follows the camera
    this.drift = null; // node-space units/s every particle moves by (world-space systems on a moving node)
    this.travel = 0; // units/s the system moves at (riding with the runner): rate-over-distance emission
    this.worldLock = null; // world-space system on a node that moves: its node's last world position
    this.count = 0;
    this.time = 0;
    this.emitAcc = 0;
    this.burstDone = new Set();
    // Non-looping systems (fireworks) replay so a still scene keeps them alive
    this.period = def.loop ? def.duration : def.duration + (def.lifetime?.max ?? 5) + 1;
    this.delay = sample(def.delay, 0);

    const look = particleLook(materials, def.render.material, def.render.mode);
    if (this.mesh) {
      this.material = makeMaterial(look, MESH_VERTEX, { uSheet: { value: def.sheet ? new THREE.Vector2(def.sheet.x, def.sheet.y) : new THREE.Vector2(1, 1) } });
      // One instanced mesh per mesh the system picks from (Paris Summer Games' balloon colors)
      const geometries = Array.isArray(meshGeometry) ? meshGeometry : [meshGeometry];
      this.parts = geometries.map((g, k) => {
        const colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(this.max * 4), 4).setUsage(THREE.DynamicDrawUsage);
        const geometry = g.clone();
        geometry.setAttribute('iColor', colorAttr);
        const frameAttr = new THREE.InstancedBufferAttribute(new Float32Array(this.max), 1).setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute('iFrame', frameAttr);
        geometry.computeBoundingBox();
        const size = geometry.boundingBox.getSize(new THREE.Vector3());
        return {
          object: new THREE.InstancedMesh(geometry, this.material, this.max),
          colorAttr,
          frameAttr,
          weight: def.render.variants?.[k]?.weight ?? 1,
          // Modeled standing up (balloons) rather than lengthwise (fish, lasers)
          upright: size.y > 1.2 * Math.max(size.x, size.z),
        };
      });
      this.object = this.parts[0].object;
      this.colorAttr = this.parts[0].colorAttr;
    } else {
      const geo = new THREE.InstancedBufferGeometry();
      const quad = new THREE.PlaneGeometry(1, 1);
      geo.index = quad.index;
      geo.setAttribute('position', quad.attributes.position);
      geo.setAttribute('uv', quad.attributes.uv);
      const dyn = (n) => new THREE.InstancedBufferAttribute(new Float32Array(this.max * n), n).setUsage(THREE.DynamicDrawUsage);
      this.posAttr = dyn(3);
      this.colorAttr = dyn(4);
      this.miscAttr = dyn(4);
      this.velAttr = dyn(3);
      this.tiltAttr = dyn(2);
      geo.setAttribute('iTilt', this.tiltAttr);
      geo.setAttribute('iPos', this.posAttr);
      geo.setAttribute('iColor', this.colorAttr);
      geo.setAttribute('iMisc', this.miscAttr);
      geo.setAttribute('iVel', this.velAttr);
      geo.instanceCount = 0;
      const sheet = def.sheet ? new THREE.Vector2(def.sheet.x, def.sheet.y) : new THREE.Vector2(1, 1);
      this.material = makeMaterial(look, QUAD_VERTEX, {
        uMode: { value: [0, 1, 2, 3].includes(def.render.mode) ? def.render.mode : 0 },
        uOriented: { value: (def.rotationX || def.rotationY) && def.render.mode === 0 && [1, 2].includes(def.render.alignment) ? 1 : 0 },
        uLengthScale: { value: def.render.lengthScale ?? 2 },
        uVelocityScale: { value: def.render.velocityScale ?? 0 },
        uMaxSize: { value: def.render.maxSize || 0.5 },
        uScale: { value: 1 },
        uSheet: { value: sheet },
      });
      this.object = new THREE.Mesh(geo, this.material);
    }
    for (const object of this.parts?.map((p) => p.object) ?? [this.object]) {
      object.frustumCulled = false;
      object.userData.particles = true;
      Object.defineProperty(object.userData, 'emitter', { value: this, configurable: true }); // (for probes; out of clone()'s JSON copy)
      object.renderOrder = 3000;
      object.name = `${node.name}_particles`;
      node.add(object);
    }
    if (def.trail) this.initTrail(materials);
    this.gravityLocal = null;
  }

  /** Trail module: per particle, its last TRAIL_POINTS positions, drawn as one ribbon. */
  initTrail(materials) {
    const K = TRAIL_POINTS;
    const n = this.max;
    this.trail = { pos: new Float32Array(n * K * 3), time: new Float32Array(n * K), count: new Uint8Array(n), life: new Float32Array(n) };
    const geo = new THREE.BufferGeometry();
    const attr = (size) => new THREE.BufferAttribute(new Float32Array(n * K * 2 * size), size).setUsage(THREE.DynamicDrawUsage);
    this.trailAttrs = { position: attr(3), aPrev: attr(3), aSide: attr(1), aWidth: attr(1), aColor: attr(4) };
    for (const [k, a] of Object.entries(this.trailAttrs)) geo.setAttribute(k, a);
    const index = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < K - 1; j++) {
        const v = (i * K + j) * 2;
        index.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
      }
    }
    geo.setIndex(index);
    geo.setDrawRange(0, 0);
    // The renderer's second material; untextured ones are plain (white), not the soft dot
    const look = particleLook(materials, this.def.trail.material ?? this.def.render.material, 0);
    const mat = makeMaterial({ ...look, map: look.map ?? WHITE, vertexColors: true }, TRAIL_VERTEX, {});
    this.trailObject = new THREE.Mesh(geo, mat);
    this.trailObject.frustumCulled = false;
    this.trailObject.userData.particles = true;
    this.trailObject.renderOrder = 3000;
    this.trailObject.name = `${this.node.name}_trails`;
    this.node.add(this.trailObject);
  }

  uploadTrail() {
    const tr = this.trail;
    const td = this.def.trail;
    const K = TRAIL_POINTS;
    const { position, aPrev, aSide, aWidth, aColor } = this.trailAttrs;
    const pts = [];
    const col = new THREE.Vector4();
    const life = new THREE.Vector4();
    const pcol = new THREE.Vector4();
    const minD2 = (td.minVertexDistance ?? 0.2) ** 2;
    for (let i = 0; i < this.count; i++) {
      const p = i * 3;
      const base = i * K;
      const x = this.local.pos[p];
      const y = this.local.pos[p + 1];
      const z = this.local.pos[p + 2];
      // Record the head once it has moved far enough, and no oftener than the trail's life
      // allows for the points kept (else a fast spark used them up in a fraction of it: 3.12
      // Copenhagen's firework trails were cut at 0.4 s, the game's last 0.75-1.5 s)
      let c = tr.count[i];
      const h = base * 3;
      const gap = tr.life[i] / (K - 2);
      if (!c || ((x - tr.pos[h]) ** 2 + (y - tr.pos[h + 1]) ** 2 + (z - tr.pos[h + 2]) ** 2 >= minD2 && this.time - tr.time[base] >= gap)) {
        tr.pos.copyWithin(h + 3, h, h + (K - 1) * 3);
        tr.time.copyWithin(base + 1, base, base + K - 1);
        tr.pos[h] = x;
        tr.pos[h + 1] = y;
        tr.pos[h + 2] = z;
        tr.time[base] = this.time;
        c = Math.min(c + 1, K - 1);
      }
      while (c > 1 && this.time - tr.time[base + c - 1] > tr.life[i]) c--;
      tr.count[i] = c;
      // The head (the particle now), then the recorded points
      pts.length = 0;
      pts.push([x, y, z, 0]);
      for (let j = 0; j < c; j++) pts.push([tr.pos[h + j * 3], tr.pos[h + j * 3 + 1], tr.pos[h + j * 3 + 2], this.time - tr.time[base + j]]);
      const lt = this.age[i] / this.life[i];
      // Size affects Width (manifests from before it was kept: off, as they drew)
      const widthScale = td.sizeWidth ? this.size0[i] * (this.def.sizeOverLife ? sample(this.def.sizeOverLife, lt, this.rand[i * 2]) : 1) : 1;
      sampleColor(td.colorOverLife, lt, this.rand[i * 2], life);
      if (td.inheritColor) this.color(i, lt, pcol, col);
      for (let j = 0; j < K; j++) {
        const q = pts[Math.min(j, pts.length - 1)];
        const prev = j + 1 < pts.length ? pts[j + 1] : pts.length > 1 ? [2 * q[0] - pts[pts.length - 2][0], 2 * q[1] - pts[pts.length - 2][1], 2 * q[2] - pts[pts.length - 2][2]] : q;
        const u = Math.min(q[3] / Math.max(tr.life[i], 1e-3), 1);
        const w = j < pts.length && pts.length > 1 ? sample(td.width, u, this.rand[i * 2 + 1]) * widthScale : 0;
        sampleColor(td.colorOverTrail, u, this.rand[i * 2 + 1], col);
        col.multiply(life);
        if (td.inheritColor) col.multiply(pcol);
        for (let s = 0; s < 2; s++) {
          const v = (base + j) * 2 + s;
          position.setXYZ(v, q[0], q[1], q[2]);
          aPrev.setXYZ(v, prev[0], prev[1], prev[2]);
          aSide.setX(v, s ? 1 : -1);
          aWidth.setX(v, w);
          aColor.setXYZW(v, col.x, col.y, col.z, col.w);
        }
      }
    }
    for (const a of Object.values(this.trailAttrs)) {
      a.needsUpdate = true;
      a.addUpdateRange(0, this.count * K * 2 * a.itemSize);
    }
    this.trailObject.geometry.setDrawRange(0, this.count * (K - 1) * 6);
  }

  spawn(offset = null, tint = null) {
    if (this.count >= this.max) return;
    const i = this.count++;
    const id = this.nextId++;
    this.ids[i] = id;
    this.index.set(id, i);
    const d = this.def;
    const t = (this.time % this.period) / Math.max(d.duration, 1e-3);
    const pos = new THREE.Vector3();
    const dir = new THREE.Vector3();
    shapeSpawn(d.shape, pos, dir);
    const speed = sample(d.speed, t);
    pos.x = -pos.x; // Unity -> glb space
    dir.x = -dir.x;
    if (this.shapeScale) pos.multiply(this.shapeScale);
    if (offset) pos.add(offset);
    if (this.covered?.(pos.z)) {
      // Weather: no snow inside tubes, stations, pillar halls
      this.count--;
      this.index.delete(id);
      return;
    }
    this.local.pos.set([pos.x, pos.y, pos.z], i * 3);
    this.local.vel.set([dir.x * speed, dir.y * speed, dir.z * speed], i * 3);
    this.age[i] = 0;
    this.life[i] = Math.max(sample(d.lifetime, t), 0.05);
    if (this.trail) {
      this.trail.count[i] = 0;
      this.trail.life[i] = sample(d.trail.lifetime, 0) * this.life[i]; // a fraction of the particle's life
    }
    this.size0[i] = sample(d.size, t);
    this.rot[i] = -sample(d.rotation, t);
    // Unity turns particles the other way (as the 2D rotation above), and glb space mirrors
    // x, which flips turns about Y back: Changan's fog then faces the camera as broad sheets,
    // as in game (the other sign showed it edge-on, as streaks)
    this.tilt.set([-sample(d.rotationX, t), sample(d.rotationY, t)], i * 2);
    this.spin[i] = d.rotationOverLife ? -sample(d.rotationOverLife, 0) : 0;
    const col = sampleColor(d.color, t, Math.random(), new THREE.Vector4());
    if (tint) col.multiply(tint);
    this.color0.set([col.x, col.y, col.z, col.w], i * 4);
    this.rand.set([Math.random(), Math.random()], i * 2);
    randomUnit(dir);
    this.axis.set([dir.x, dir.y, dir.z], i * 3);
    for (const sub of this.subs) if (sub.type === 0 && Math.random() < sub.probability) sub.emitter.start(this, id, i, sub.inheritColor);
  }

  /** As a sub-emitter: one run of this system, at (and following, for births) a parent particle. */
  start(parent, id, i, inheritColor = false) {
    if (!parent.toSub) parent.toSub = new Map();
    if (!parent.toSub.has(this)) {
      // Parent particle space -> this emitter's space (pieces never move)
      parent.node.updateWorldMatrix(true, false);
      this.node.updateWorldMatrix(true, false);
      parent.toSub.set(this, new THREE.Matrix4().copy(this.node.matrixWorld).invert().multiply(parent.node.matrixWorld));
    }
    const pos = new THREE.Vector3().fromArray(parent.local.pos, i * 3).applyMatrix4(parent.toSub.get(this));
    const tint = inheritColor ? new THREE.Vector4().fromArray(parent.color0, i * 4) : null;
    this.sources.push({ parent, follow: id, pos, tint, time: 0, acc: 0, bursts: new Set() });
  }

  /** Emission for each run its parent started: rate and bursts over the system's duration. */
  emitSources(dt) {
    const d = this.def;
    this.sources = this.sources.filter((s) => {
      if (s.follow != null) {
        const i = s.parent.index.get(s.follow);
        if (i == null) s.follow = null; // parent particle gone: stays where it was
        else s.pos.fromArray(s.parent.local.pos, i * 3).applyMatrix4(s.parent.toSub.get(this));
      }
      s.time += dt;
      if (s.time > d.duration && !(d.loop && s.follow != null)) return false;
      const t = Math.min(s.time / Math.max(d.duration, 1e-3), 1);
      s.acc += sample(d.rate, t) * dt;
      for (; s.acc >= 1; s.acc -= 1) this.spawn(s.pos, s.tint);
      d.bursts.forEach((b, k) => {
        for (let n = 0; n < (b.cycles || 1); n++) {
          if (s.time >= b.time + n * b.interval && !s.bursts.has(`${k}:${n}`)) {
            s.bursts.add(`${k}:${n}`);
            const count = Math.round(sample(b.count, 0));
            for (let m = 0; m < count; m++) this.spawn(s.pos, s.tint);
          }
        }
      });
      return true;
    });
  }

  kill(i) {
    const j = --this.count;
    this.index.delete(this.ids[i]);
    if (i !== j) {
      this.ids[i] = this.ids[j];
      this.index.set(this.ids[i], i);
    }
    if (i === j) return;
    const move = (arr, n) => arr.copyWithin(i * n, j * n, j * n + n);
    move(this.local.pos, 3);
    move(this.local.vel, 3);
    move(this.age, 1);
    move(this.life, 1);
    move(this.size0, 1);
    move(this.rot, 1);
    move(this.tilt, 2);
    move(this.spin, 1);
    move(this.color0, 4);
    move(this.rand, 2);
    move(this.axis, 3);
    move(this.heading, 3);
    if (this.trail) {
      move(this.trail.pos, TRAIL_POINTS * 3);
      move(this.trail.time, TRAIL_POINTS);
      move(this.trail.count, 1);
      move(this.trail.life, 1);
    }
  }

  step(dt) {
    const d = this.def;
    if (!this.gravityLocal) {
      // World down and the emitter's scale, in its local frame (pieces never move)
      this.node.updateWorldMatrix(true, false);
      // Shape scaling mode: the transform's scale (here the parents': 1.104 Dubai's aquarium
      // bubble placeholders are squashed to 0.56) only spreads the start positions; speeds and
      // sizes stay unscaled (the bubbles rose 22 instead of 40)
      if (this.def.shape?.scaling === 2 && !this.shapeScale) {
        const s = new THREE.Vector3().setFromMatrixScale(this.node.matrixWorld);
        if (Math.abs(s.x - 1) + Math.abs(s.y - 1) + Math.abs(s.z - 1) > 1e-3) {
          this.shapeScale = s;
          for (const object of [...(this.parts?.map((q) => q.object) ?? [this.object]), this.trailObject]) object?.scale.set(1 / s.x, 1 / s.y, 1 / s.z);
          this.object.updateWorldMatrix(true, false);
        }
      }
      // (world vectors through the inverse frame, scale included: 1.98 Atlanta's fountain is
      // turned 90° on X and stretched 2.3 x 2.4 x 4.5, its world-down force must stay down)
      const frame = this.shapeScale ? this.object.matrixWorld : this.node.matrixWorld;
      const inv = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().copy(frame).invert());
      this.toLocal = inv;
      this.gravityLocal = new THREE.Vector3(0, -9.81, 0).applyMatrix3(inv); // per unit of gravity modifier
      const s = new THREE.Vector3().setFromMatrixScale(frame);
      this.scale = (Math.abs(s.x) + Math.abs(s.y) + Math.abs(s.z)) / 3;
      if (this.material.uniforms.uScale) this.material.uniforms.uScale.value = this.scale;
    }
    this.time += dt;
    // Unity removes the particles that die this frame before emitting: the other way, a full
    // system dropped what came due as a slot freed, then filled both at once (3.68 Cosmic
    // Crossroads' two cars flew into the portal merged, born in the same frame)
    for (let i = this.count - 1; i >= 0; i--) {
      if (this.age[i] + dt < this.life[i]) continue;
      for (const sub of this.subs) if (sub.type === 2 && Math.random() < sub.probability) sub.emitter.start(this, null, i, sub.inheritColor);
      this.kill(i);
    }
    const local = this.time - this.delay;
    if (this.sources) this.emitSources(dt);
    else if (local >= 0) {
      const cycle = Math.floor(local / this.period);
      const inCycle = local - cycle * this.period;
      const emitting = d.loop || inCycle < d.duration;
      if (emitting) {
        const t = inCycle / Math.max(d.duration, 1e-3);
        this.emitAcc += (sample(d.rate, t) + (d.distanceRate && this.travel ? sample(d.distanceRate, t) * this.travel : 0)) * dt;
        while (this.emitAcc >= 1) {
          this.spawn(this.spawnOffset);
          this.emitAcc -= 1;
        }
      }
      // (a burst at the very end still fires, on the step that reaches it: 3.67 Fantasy Fest's
      // landmark arrows have their only volley at 1 s of a 1 s system)
      if (emitting || inCycle - dt < d.duration) {
        d.bursts.forEach((b, k) => {
          for (let n = 0; n < (b.cycles || 1); n++) {
            const key = `${cycle}:${k}:${n}`;
            if (inCycle >= b.time + n * b.interval && !this.burstDone.has(key)) {
              this.burstDone.add(key);
              const count = Math.round(sample(b.count, 0));
              for (let m = 0; m < count; m++) this.spawn(this.spawnOffset);
            }
          }
        });
        if (this.burstDone.size > 256) this.burstDone.clear();
      }
    }
    const g = sample(d.gravity, 0);
    const vel = d.velocity;
    const force = d.force;
    for (let i = this.count - 1; i >= 0; i--) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        for (const sub of this.subs) if (sub.type === 2 && Math.random() < sub.probability) sub.emitter.start(this, null, i, sub.inheritColor);
        this.kill(i);
        continue;
      }
      const p = i * 3;
      const v = this.local.vel;
      if (g) {
        v[p] += this.gravityLocal.x * g * dt;
        v[p + 1] += this.gravityLocal.y * g * dt;
        v[p + 2] += this.gravityLocal.z * g * dt;
      }
      const lt = this.age[i] / this.life[i];
      if (force) {
        // (randomizePerFrame: a new pick every frame, the confetti flutters; else one per particle)
        const rf = force.perFrame ? Math.random() : this.rand[i * 2];
        const fx = -sample(force.x, lt, force.perFrame ? Math.random() : rf) * dt;
        const fy = sample(force.y, lt, force.perFrame ? Math.random() : rf) * dt;
        const fz = sample(force.z, lt, force.perFrame ? Math.random() : rf) * dt;
        if (force.world) {
          const f = forceTmp.set(fx, fy, fz).applyMatrix3(this.toLocal);
          v[p] += f.x;
          v[p + 1] += f.y;
          v[p + 2] += f.z;
        } else {
          v[p] += fx;
          v[p + 1] += fy;
          v[p + 2] += fz;
        }
      }
      let ex = 0;
      let ey = 0;
      let ez = 0;
      if (vel) {
        ex = -sample(vel.x, lt, this.rand[i * 2 + 1]);
        ey = sample(vel.y, lt, this.rand[i * 2 + 1]);
        ez = sample(vel.z, lt, this.rand[i * 2 + 1]);
      }
      // Noise module: a smooth push through the system's space (sums of sines standing in for
      // Unity's Perlin noise; its strength in units/s, its frequency per unit)
      if (d.noise) {
        const nz = d.noise;
        const amt = sample(nz.strength, lt, this.rand[i * 2]) * sample(nz.amount, lt, this.rand[i * 2]) * (this.scale ?? 1);
        const fq = nz.frequency / (this.scale ?? 1);
        const tt = this.time * (sample(nz.scroll, lt) + 0.3);
        const px = this.local.pos[p] * fq;
        const py = this.local.pos[p + 1] * fq;
        const pz = this.local.pos[p + 2] * fq;
        const seed = this.ids[i] * 1.618;
        ex += amt * Math.sin(py * 2.1 + pz * 1.3 + tt + seed) * Math.cos(px * 0.7 + seed);
        ey += amt * Math.sin(pz * 1.9 + px * 1.1 + tt * 1.3 + seed * 2.0) * Math.cos(py * 0.8);
        ez += amt * Math.sin(px * 1.7 + py * 1.5 + tt * 0.7 + seed * 3.0) * Math.cos(pz * 0.9);
      }
      // Limit velocity, on the whole velocity (velocity module included): past the limit, the
      // speed eases back by dampen (a fraction per frame at 30 fps, as Unity keeps it framerate-independent). 3.12 Copenhagen's
      // firework sparks shoot out, then hang where they burst
      if (d.limit) {
        const lim = sample(d.limit.speed, lt, this.rand[i * 2 + 1]) * (this.scale ?? 1);
        const tx = v[p] + ex;
        const ty = v[p + 1] + ey;
        const tz = v[p + 2] + ez;
        const sp = Math.hypot(tx, ty, tz);
        if (sp > lim) {
          const k = 1 - (1 - d.limit.dampen) ** (dt * 30);
          const f = (sp - (sp - lim) * k) / sp;
          v[p] = tx * f - ex;
          v[p + 1] = ty * f - ey;
          v[p + 2] = tz * f - ez;
        }
      }
      const pos = this.local.pos;
      const x0 = pos[p];
      const y0 = pos[p + 1];
      const z0 = pos[p + 2];
      pos[p] += (v[p] + ex) * dt;
      pos[p + 1] += (v[p + 1] + ey) * dt;
      pos[p + 2] += (v[p + 2] + ez) * dt;
      if (this.drift) {
        pos[p] += this.drift.x * dt;
        pos[p + 1] += this.drift.y * dt;
        pos[p + 2] += this.drift.z * dt;
      }
      if (vel?.orbital) this.orbit(i, lt, dt);
      // Direction of travel from the actual move, orbits included
      this.heading[p] = (pos[p] - x0) / dt;
      this.heading[p + 1] = (pos[p + 1] - y0) / dt;
      this.heading[p + 2] = (pos[p + 2] - z0) / dt;
      this.rot[i] += this.spin[i] * dt;
    }
  }

  /** Velocity module's orbital (radians/s about the system's axes) and radial speeds. */
  orbit(i, lt, dt) {
    const vel = this.def.velocity;
    const r = this.rand[i * 2 + 1];
    const o = vel.orbitalOffset ?? [0, 0, 0];
    // Unity -> glb space mirrors X: rotations about Y and Z turn the other way
    tmpCenter.set(-o[0], o[1], o[2]);
    tmpRel.fromArray(this.local.pos, i * 3).sub(tmpCenter);
    const radial = sample(vel.radial, lt, r);
    const len = tmpRel.length();
    if (radial && len > 1e-4) tmpRel.multiplyScalar(1 + (radial * dt) / len);
    tmpEuler.set(sample(vel.orbital.x, lt, r) * dt, -sample(vel.orbital.y, lt, r) * dt, -sample(vel.orbital.z, lt, r) * dt);
    tmpRel.applyEuler(tmpEuler).add(tmpCenter);
    tmpRel.toArray(this.local.pos, i * 3);
  }

  /** Texture sheet frame of particle i at life fraction lt (0 without a sheet). */
  frameOf(i, lt) {
    const sheet = this.def.sheet;
    if (!sheet) return 0;
    const frames = sheet.row == null ? sheet.x * sheet.y : sheet.x;
    let frame = Math.floor(((sample(sheet.frame, lt, this.rand[i * 2]) * (sheet.cycles || 1)) % 1) * frames);
    if (sheet.row != null) frame += (sheet.row < 0 ? Math.floor(this.rand[i * 2 + 1] * sheet.y) : sheet.row) * sheet.x;
    return frame;
  }

  upload() {
    const d = this.def;
    const col = new THREE.Vector4();
    const life = new THREE.Vector4();
    if (this.mesh) {
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const axis = new THREE.Vector3();
      const facing = new THREE.Matrix4();
      const zero = new THREE.Vector3();
      // World up in the emitter's frame (3.60 Ireland seagull emitters are turned 90° on X)
      const up = this.gravityLocal ? this.gravityLocal.clone().negate().normalize() : new THREE.Vector3(0, 1, 0);
      const byVelocity = d.render.alignment === 4;
      const counts = this.parts.map(() => 0);
      const total = this.parts.reduce((n, p) => n + p.weight, 0);
      for (let i = 0; i < this.count; i++) {
        const lt = this.age[i] / this.life[i];
        const size = this.size0[i] * (d.sizeOverLife ? sample(d.sizeOverLife, lt, this.rand[i * 2]) : 1);
        // Each particle keeps one mesh for its life (picked from its id)
        let k = 0;
        if (this.parts.length > 1) {
          let r = (((Math.sin(this.ids[i] * 12.9898) * 43758.5453) % 1) + 1) % 1 * total;
          k = this.parts.findIndex((p) => (r -= p.weight) < 0);
          if (k < 0) k = 0;
        }
        const part = this.parts[k];
        axis.fromArray(this.heading, i * 3);
        if (byVelocity && axis.lengthSq() > 1e-6) {
          // Velocity alignment: the mesh's +Z along the direction of travel (swimming fish,
          // lasers); meshes modeled standing up (rising balloons) keep their top that way
          if (part.upright) q.setFromUnitVectors(UP, axis.normalize());
          else q.setFromRotationMatrix(facing.lookAt(axis, zero, up));
        } else {
          axis.fromArray(this.axis, i * 3);
          q.setFromAxisAngle(axis, this.rot[i]);
        }
        m.compose(new THREE.Vector3().fromArray(this.local.pos, i * 3), q, new THREE.Vector3(size, size, size));
        const n = counts[k]++;
        part.object.setMatrixAt(n, m);
        this.color(i, lt, col, life);
        part.colorAttr.setXYZW(n, col.x, col.y, col.z, col.w);
        part.frameAttr.setX(n, this.frameOf(i, lt));
      }
      this.parts.forEach((p, k) => {
        p.object.count = counts[k];
        p.object.instanceMatrix.needsUpdate = true;
        p.colorAttr.needsUpdate = true;
        p.frameAttr.needsUpdate = true;
      });
      return;
    }
    for (let i = 0; i < this.count; i++) {
      const lt = this.age[i] / this.life[i];
      // (Shape-scaling cones, the 1.x smoke: old puffs up to 30% bigger, matched to the game by eye)
      const grow = d.shape && shapeCone(d.shape) ? 1 + 0.3 * lt : 1;
      const size = grow * this.size0[i] * (d.sizeOverLife ? sample(d.sizeOverLife, lt, this.rand[i * 2]) : 1);
      const frame = this.frameOf(i, lt);
      this.posAttr.setXYZ(i, this.local.pos[i * 3], this.local.pos[i * 3 + 1], this.local.pos[i * 3 + 2]);
      this.velAttr.setXYZ(i, this.local.vel[i * 3], this.local.vel[i * 3 + 1], this.local.vel[i * 3 + 2]);
      this.miscAttr.setXYZW(i, size, this.rot[i], frame, 0);
      this.tiltAttr.setXY(i, this.tilt[i * 2], this.tilt[i * 2 + 1]);
      this.color(i, lt, col, life);
      this.colorAttr.setXYZW(i, col.x, col.y, col.z, col.w);
    }
    this.object.geometry.instanceCount = this.count;
    for (const a of [this.posAttr, this.velAttr, this.miscAttr, this.colorAttr, this.tiltAttr]) {
      a.needsUpdate = true;
      a.addUpdateRange(0, this.count * a.itemSize);
    }
  }

  color(i, lt, out, tmp) {
    out.fromArray(this.color0, i * 4);
    if (this.def.colorOverLife) out.multiply(sampleColor(this.def.colorOverLife, lt, this.rand[i * 2], tmp));
  }

  /** Runs `seconds` of simulation at once (prewarm). */
  advance(seconds) {
    for (let t = 0; t < seconds; t += STEP * 3) this.step(STEP * 3);
  }
}

// ---------------------------------------------------------------- api

/**
 * Adds the prefab's particle systems under their nodes.
 * @param particles manifest prefab.particles (node name -> emitter)
 * @param meshGeometry async (glb url) -> BufferGeometry, for mesh particles
 */
export async function attachParticles(root, particles, materials, nodeKey, meshGeometry) {
  const nodes = [];
  root.traverse((o) => {
    const key = nodeKey(o.name);
    if (!key) return;
    // A system inside a same-named holder: the holder doesn't get a copy
    let nested = 0;
    for (let p = o.parent; p; p = p.parent) if (nodeKey(p.name) === key) nested++;
    if (nested === (particles[key].nested ?? 0)) nodes.push([o, particles[key]]);
  });
  const made = [];
  for (const [node, def] of nodes) {
    let geometry = def.render.mode === 4 && def.render.meshGlb ? await meshGeometry(def.render.meshGlb) : null;
    if (def.render.mode === 4 && !geometry) continue; // mesh particles without their mesh
    if (geometry && def.render.variants?.length > 1) {
      const all = await Promise.all(def.render.variants.map((v) => meshGeometry(v.meshGlb)));
      if (all.every(Boolean)) geometry = all;
    }
    const emitter = new Emitter(node, root, def, materials, geometry);
    emitters.add(emitter);
    made.push(emitter);
  }
  // Sub-emitters: the parent's own descendants first (two fireworks share child names)
  const within = (node, ancestor) => {
    for (let n = node; n; n = n.parent) if (n === ancestor) return true;
    return false;
  };
  for (const e of made) {
    for (const link of e.def.subEmitters ?? []) {
      const key = THREE.PropertyBinding.sanitizeNodeName(link.node); // node keys are sanitized ("star (1)" -> "star_(1)")
      const named = made.filter((s) => s !== e && nodeKey(s.node.name) === key);
      const sub = named.find((s) => within(s.node, e.node)) ?? named[0];
      if (!sub) continue;
      sub.sources ??= [];
      e.subs.push({ emitter: sub, type: link.type, probability: link.probability, inheritColor: !!link.inheritColor });
    }
  }
  return made;
}

let weather = null;

/**
 * Snow along the whole run. Some themes only snow around their start train (2.27 North
 * Pole); this emitter uses that snow and lays its flakes around the camera instead, in
 * world space, so they fall in place as the camera moves.
 */
export async function setWeather(scene, def, materials, meshGeometry) {
  const token = ++weatherToken;
  if (weather) {
    weather.root.removeFromParent();
    emitters.delete(weather);
    weather = null;
  }
  if (!def) return;
  // Mesh particles (Vancouver's leaves): every mesh the system picks from
  let geometry = null;
  if (def.render.mode === 4) {
    const urls = def.render.variants?.length > 1 ? def.render.variants.map((v) => v.meshGlb) : [def.render.meshGlb];
    const all = await Promise.all(urls.map((url) => (url ? meshGeometry(url) : null)));
    if (token !== weatherToken || !all.every(Boolean)) return;
    geometry = all.length > 1 ? all : all[0];
  }
  const group = new THREE.Group();
  group.name = 'weather';
  group.visible = weatherVisible;
  scene.add(group);
  weather = new Emitter(group, group, { ...def, local: true, prewarm: false }, materials, geometry);
  weather.spawnOffset = new THREE.Vector3();
  weather.weather = true;
  weather.covered = (z) => weatherCover.some(([a, b]) => z >= a && z < b);
  emitters.add(weather);
}

/** Stretches of the run [z0, z1) under a roof, where no snow falls. */
export function setWeatherCover(ranges) {
  weatherCover = ranges;
  if (weather) weather.covered = (z) => weatherCover.some(([a, b]) => z >= a && z < b);
}
let weatherCover = [];

let weatherToken = 0;
let weatherVisible = true;

export function setWeatherVisible(visible) {
  weatherVisible = visible;
  if (weather) weather.root.visible = visible;
}

const MAX_STEP = 0.05; // longest single simulation step (s)

/** A trigger group's time, counting its laps: { action, cycle, laps, last }. */
function clockTime(c) {
  const t = c.action.time;
  if (t < c.last) c.laps++;
  c.last = t;
  return c.laps * c.cycle + t;
}

/** Steps and uploads every live emitter near the camera; drops those of removed pieces. */
export function updateParticles(dt, camera) {
  const cam = camera.getWorldPosition(new THREE.Vector3());
  const at = new THREE.Vector3();
  // Sped-up time runs in several steps; frozen time runs none (particles hold still)
  const steps = Math.ceil(dt / MAX_STEP);
  const h = steps ? dt / steps : 0;
  const run = (e) => {
    for (let n = 0; n < steps; n++) e.step(h);
  };
  for (const e of emitters) {
    if (e.weather) {
      // Just ahead of and above the camera, where the flakes are seen
      const ahead = camera.getWorldDirection(at).setY(0).normalize().multiplyScalar(60);
      e.spawnOffset.copy(cam).add(ahead).add(new THREE.Vector3(0, 30, 0));
      for (const part of e.parts ?? [e]) part.object.visible = e.root.visible;
      if (e.root.visible && steps) {
        run(e);
        e.upload();
        if (e.trail) e.uploadTrail();
      }
      continue;
    }
    // A run's pieces join the scene only once all are loaded: gone means removed after that
    if (e.root.parent) e.attached = true;
    else if (!e.attached && (e.loadWait = (e.loadWait ?? 0) + dt) < 60) continue;
    if (!e.root.parent) {
      for (const part of e.parts ?? [e]) part.object.geometry.dispose();
      e.material.dispose();
      emitters.delete(e);
      continue;
    }
    if (e.worldLock) keepInWorld(e);
    e.object.getWorldPosition(at);
    const near = at.distanceTo(cam) < ACTIVE_DISTANCE;
    for (const part of e.parts ?? [e]) part.object.visible = near;
    if (!near) continue;
    let fresh = false;
    if (!e.warmed) {
      // Looping systems start full, as if they had been running (sub-emitters follow their parent)
      e.warmed = fresh = true;
      if (e.def.loop && !e.sources) e.advance(Math.min(e.def.duration + (e.def.lifetime?.max ?? 0), 20));
    }
    if (!steps && !fresh) continue;
    // A triggered system keeps to its group's clock (fired with the clip and the other systems)
    if (e.clock) e.time = clockTime(e.clock) - dt;
    run(e);
    e.upload();
    if (e.trail) e.uploadTrail();
  }
}

/**
 * A world-space system whose node moves (a theme effect that follows the camera) or turns
 * (3.67 Fantasy Fest's dragon smoke, on a jaw that snaps shut): its particles stay where they
 * are in the world, the node's change of frame taken back off them. A jump (camera reset, new
 * map) carries them along instead.
 */
const lockPos = new THREE.Vector3();
const lockMat = new THREE.Matrix4();
const lockLin = new THREE.Matrix3();
const lockV = new THREE.Vector3();
function keepInWorld(e) {
  // (the frame the particles are kept in: the node's, or its unscaled child in Shape scaling)
  const frame = e.parts?.[0]?.object ?? e.object;
  frame.updateWorldMatrix(true, false);
  lockPos.setFromMatrixPosition(frame.matrixWorld);
  const last = e.worldLock;
  last.matrix ??= new THREE.Matrix4();
  // (an anchored effect moves by itself: its particles stay even when it jumps back to loop)
  if (last.ready && (last.anchored || lockPos.distanceTo(last.pos) < 300)) {
    // old node space -> world -> new node space
    lockMat.copy(frame.matrixWorld).invert().multiply(last.matrix);
    lockLin.setFromMatrix4(lockMat);
    const pos = e.local.pos;
    const vel = e.local.vel;
    for (let i = 0; i < e.count; i++) {
      lockV.fromArray(pos, i * 3).applyMatrix4(lockMat).toArray(pos, i * 3);
      lockV.fromArray(vel, i * 3).applyMatrix3(lockLin).toArray(vel, i * 3);
    }
  }
  last.pos.copy(lockPos);
  last.matrix.copy(frame.matrixWorld);
  last.ready = true;
}

/** Particle count, for the status line. */
export const particleCount = () => [...emitters].reduce((n, e) => n + e.count, 0);
