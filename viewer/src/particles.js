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
  if (shape.randomDirection) dir.lerp(randomUnit(new THREE.Vector3()), shape.randomDirection).normalize();
  if (shape.rotation?.some((v) => v)) {
    const e = new THREE.Euler(shape.rotation[0] * DEG, shape.rotation[1] * DEG, shape.rotation[2] * DEG, 'ZXY');
    pos.applyEuler(e);
    dir.applyEuler(e);
  }
  if (shape.position) pos.add(new THREE.Vector3(...shape.position));
  return dir;
}

// ---------------------------------------------------------------- rendering

const QUAD_VERTEX = /* glsl */ `
uniform vec2 uBend;
uniform float uMode; // 0 billboard, 1 stretched, 2 horizontal, 3 vertical
uniform float uLengthScale;
uniform float uVelocityScale;
uniform float uMaxSize; // fraction of the view height at that depth
uniform float uScale;
uniform vec2 uSheet;
attribute vec3 iPos;
attribute vec4 iColor;
attribute vec4 iMisc; // size, rotation, sheet frame, unused
attribute vec3 iVel;
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
  if (uMode == 2.0) {
    // horizontal: flat in the emitter's XZ plane
    vec3 local = vec3(mat2(c, -s, s, c) * corner * iMisc.x, 0.0).xzy;
    mv = modelViewMatrix * vec4(iPos + local / max(uScale, 1e-4) * uScale, 1.0);
  } else if (uMode == 1.0) {
    // stretched along the screen-space velocity
    vec3 v = (modelViewMatrix * vec4(iVel, 0.0)).xyz;
    vec2 axis = length(v.xy) > 1e-4 ? normalize(v.xy) : vec2(0.0, 1.0);
    float len = size * uLengthScale + length(v) * uVelocityScale;
    mv.xy += axis * corner.y * len + vec2(-axis.y, axis.x) * corner.x * size;
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
attribute vec4 iColor;
varying vec2 vUv;
varying vec4 vColor;
varying float vDepth;
void main() {
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  float depth = max(-mv.z, 0.0);
  mv.xy += vec2(uBend.x, -uBend.y) * depth * depth;
  vDepth = -mv.z;
  vUv = uv;
  vColor = iColor;
  gl_Position = projectionMatrix * mv;
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
function particleLook(materials, name) {
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
  const tint = c._TintColor ? c._TintColor.map((v) => v * 2) : c._MainColor && /Additive/i.test(shader) ? [...c._MainColor.slice(0, 3), 1] : c._Color ?? [1, 1, 1, 1];
  // Combined without VERTEX_COLORS ignores the particle color (3.60 Ireland seagulls: dark grey start color)
  const vertexColors = shader !== 'SYBO/Bend/Combined' || !!f._HasVertexColors || !!def?.keywords?.includes('VERTEX_COLORS_ENABLED');
  return { map: def ? materials.tex(def, '_MainTex') : null, src, dst, fadeMode, tint, vertexColors };
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
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
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
    this.spin = new Float32Array(this.max);
    this.color0 = new Float32Array(this.max * 4);
    this.rand = new Float32Array(this.max * 2);
    this.axis = new Float32Array(this.max * 3);
    this.heading = new Float32Array(this.max * 3); // direction of travel (velocity-aligned meshes)
    this.ids = new Int32Array(this.max); // stable particle ids, for birth sub-emitters
    this.index = new Map(); // id -> slot
    this.nextId = 1;
    this.subs = []; // { emitter, type: 0 birth | 2 death, probability }
    this.sources = null; // as a sub-emitter: where its parent's particles start it
    this.spawnOffset = null; // weather: emission follows the camera
    this.count = 0;
    this.time = 0;
    this.emitAcc = 0;
    this.burstDone = new Set();
    // Non-looping systems (fireworks) replay so a still scene keeps them alive
    this.period = def.loop ? def.duration : def.duration + (def.lifetime?.max ?? 5) + 1;
    this.delay = sample(def.delay, 0);

    const look = particleLook(materials, def.render.material);
    if (this.mesh) {
      this.material = makeMaterial(look, MESH_VERTEX, {});
      // One instanced mesh per mesh the system picks from (Paris Summer Games' balloon colors)
      const geometries = Array.isArray(meshGeometry) ? meshGeometry : [meshGeometry];
      this.parts = geometries.map((g, k) => {
        const colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(this.max * 4), 4).setUsage(THREE.DynamicDrawUsage);
        const geometry = g.clone();
        geometry.setAttribute('iColor', colorAttr);
        geometry.computeBoundingBox();
        const size = geometry.boundingBox.getSize(new THREE.Vector3());
        return {
          object: new THREE.InstancedMesh(geometry, this.material, this.max),
          colorAttr,
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
      geo.setAttribute('iPos', this.posAttr);
      geo.setAttribute('iColor', this.colorAttr);
      geo.setAttribute('iMisc', this.miscAttr);
      geo.setAttribute('iVel', this.velAttr);
      geo.instanceCount = 0;
      const sheet = def.sheet ? new THREE.Vector2(def.sheet.x, def.sheet.y) : new THREE.Vector2(1, 1);
      this.material = makeMaterial(look, QUAD_VERTEX, {
        uMode: { value: [0, 1, 2, 3].includes(def.render.mode) ? def.render.mode : 0 },
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
      object.renderOrder = 3000;
      object.name = `${node.name}_particles`;
      node.add(object);
    }
    this.gravityLocal = null;
  }

  spawn(offset = null) {
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
    this.size0[i] = sample(d.size, t);
    this.rot[i] = -sample(d.rotation, t);
    this.spin[i] = d.rotationOverLife ? -sample(d.rotationOverLife, 0) : 0;
    const col = sampleColor(d.color, t, Math.random(), new THREE.Vector4());
    this.color0.set([col.x, col.y, col.z, col.w], i * 4);
    this.rand.set([Math.random(), Math.random()], i * 2);
    randomUnit(dir);
    this.axis.set([dir.x, dir.y, dir.z], i * 3);
    for (const sub of this.subs) if (sub.type === 0 && Math.random() < sub.probability) sub.emitter.start(this, id, i);
  }

  /** As a sub-emitter: one run of this system, at (and following, for births) a parent particle. */
  start(parent, id, i) {
    if (!parent.toSub) parent.toSub = new Map();
    if (!parent.toSub.has(this)) {
      // Parent particle space -> this emitter's space (pieces never move)
      parent.node.updateWorldMatrix(true, false);
      this.node.updateWorldMatrix(true, false);
      parent.toSub.set(this, new THREE.Matrix4().copy(this.node.matrixWorld).invert().multiply(parent.node.matrixWorld));
    }
    const pos = new THREE.Vector3().fromArray(parent.local.pos, i * 3).applyMatrix4(parent.toSub.get(this));
    this.sources.push({ parent, follow: id, pos, time: 0, acc: 0, bursts: new Set() });
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
      for (; s.acc >= 1; s.acc -= 1) this.spawn(s.pos);
      d.bursts.forEach((b, k) => {
        for (let n = 0; n < (b.cycles || 1); n++) {
          if (s.time >= b.time + n * b.interval && !s.bursts.has(`${k}:${n}`)) {
            s.bursts.add(`${k}:${n}`);
            const count = Math.round(sample(b.count, 0));
            for (let m = 0; m < count; m++) this.spawn(s.pos);
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
    move(this.spin, 1);
    move(this.color0, 4);
    move(this.rand, 2);
    move(this.axis, 3);
    move(this.heading, 3);
  }

  step(dt) {
    const d = this.def;
    if (!this.gravityLocal) {
      // World down and the emitter's scale, in its local frame (pieces never move)
      this.node.updateWorldMatrix(true, false);
      const inv = new THREE.Matrix4().copy(this.node.matrixWorld).invert();
      this.gravityLocal = new THREE.Vector3(0, -9.81, 0).transformDirection(inv).multiplyScalar(9.81);
      const s = new THREE.Vector3().setFromMatrixScale(this.node.matrixWorld);
      this.scale = (Math.abs(s.x) + Math.abs(s.y) + Math.abs(s.z)) / 3;
      if (this.material.uniforms.uScale) this.material.uniforms.uScale.value = this.scale;
      this.downScale = 1 / Math.max(this.scale, 1e-4); // gravity in world units per second²
    }
    this.time += dt;
    const local = this.time - this.delay;
    if (this.sources) this.emitSources(dt);
    else if (local >= 0) {
      const cycle = Math.floor(local / this.period);
      const inCycle = local - cycle * this.period;
      const emitting = d.loop || inCycle < d.duration;
      if (emitting) {
        const t = inCycle / Math.max(d.duration, 1e-3);
        this.emitAcc += sample(d.rate, t) * dt;
        while (this.emitAcc >= 1) {
          this.spawn(this.spawnOffset);
          this.emitAcc -= 1;
        }
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
    const g = sample(d.gravity, 0) * this.downScale;
    const vel = d.velocity;
    const force = d.force;
    for (let i = this.count - 1; i >= 0; i--) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        for (const sub of this.subs) if (sub.type === 2 && Math.random() < sub.probability) sub.emitter.start(this, null, i);
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
        v[p] -= sample(force.x, lt, this.rand[i * 2]) * dt;
        v[p + 1] += sample(force.y, lt, this.rand[i * 2]) * dt;
        v[p + 2] += sample(force.z, lt, this.rand[i * 2]) * dt;
      }
      let ex = 0;
      let ey = 0;
      let ez = 0;
      if (vel) {
        ex = -sample(vel.x, lt, this.rand[i * 2 + 1]);
        ey = sample(vel.y, lt, this.rand[i * 2 + 1]);
        ez = sample(vel.z, lt, this.rand[i * 2 + 1]);
      }
      const pos = this.local.pos;
      const x0 = pos[p];
      const y0 = pos[p + 1];
      const z0 = pos[p + 2];
      pos[p] += (v[p] + ex) * dt;
      pos[p + 1] += (v[p + 1] + ey) * dt;
      pos[p + 2] += (v[p + 2] + ez) * dt;
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
      }
      this.parts.forEach((p, k) => {
        p.object.count = counts[k];
        p.object.instanceMatrix.needsUpdate = true;
        p.colorAttr.needsUpdate = true;
      });
      return;
    }
    const sheet = d.sheet;
    for (let i = 0; i < this.count; i++) {
      const lt = this.age[i] / this.life[i];
      const size = this.size0[i] * (d.sizeOverLife ? sample(d.sizeOverLife, lt, this.rand[i * 2]) : 1);
      let frame = 0;
      if (sheet) {
        const frames = sheet.row == null ? sheet.x * sheet.y : sheet.x;
        frame = Math.floor(((sample(sheet.frame, lt, this.rand[i * 2]) * (sheet.cycles || 1)) % 1) * frames);
        if (sheet.row != null) frame += (sheet.row < 0 ? Math.floor(this.rand[i * 2 + 1] * sheet.y) : sheet.row) * sheet.x;
      }
      this.posAttr.setXYZ(i, this.local.pos[i * 3], this.local.pos[i * 3 + 1], this.local.pos[i * 3 + 2]);
      this.velAttr.setXYZ(i, this.local.vel[i * 3], this.local.vel[i * 3 + 1], this.local.vel[i * 3 + 2]);
      this.miscAttr.setXYZW(i, size, this.rot[i], frame, 0);
      this.color(i, lt, col, life);
      this.colorAttr.setXYZW(i, col.x, col.y, col.z, col.w);
    }
    this.object.geometry.instanceCount = this.count;
    for (const a of [this.posAttr, this.velAttr, this.miscAttr, this.colorAttr]) {
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
    if (key) nodes.push([o, particles[key]]);
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
      e.subs.push({ emitter: sub, type: link.type, probability: link.probability });
    }
  }
}

let weather = null;

/**
 * Snow along the whole run. Some themes only snow around their start train (2.27 North
 * Pole); this emitter uses that snow and lays its flakes around the camera instead, in
 * world space, so they fall in place as the camera moves.
 */
export function setWeather(scene, def, materials) {
  if (weather) {
    weather.root.removeFromParent();
    weather = null;
  }
  if (!def) return;
  const group = new THREE.Group();
  group.name = 'weather';
  scene.add(group);
  weather = new Emitter(group, group, { ...def, local: true, prewarm: false }, materials, null);
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

export function setWeatherVisible(visible) {
  if (weather) weather.root.visible = visible;
}

/** Steps and uploads every live emitter near the camera; drops those of removed pieces. */
export function updateParticles(dt, camera) {
  const cam = camera.getWorldPosition(new THREE.Vector3());
  const at = new THREE.Vector3();
  dt = Math.min(dt, 0.1);
  for (const e of emitters) {
    if (e.weather) {
      // Just ahead of and above the camera, where the flakes are seen
      const ahead = camera.getWorldDirection(at).setY(0).normalize().multiplyScalar(60);
      e.spawnOffset.copy(cam).add(ahead).add(new THREE.Vector3(0, 30, 0));
      e.object.visible = e.root.visible;
      if (e.root.visible) {
        e.step(dt);
        e.upload();
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
    e.object.getWorldPosition(at);
    const near = at.distanceTo(cam) < ACTIVE_DISTANCE;
    for (const part of e.parts ?? [e]) part.object.visible = near;
    if (!near) continue;
    if (!e.warmed) {
      // Looping systems start full, as if they had been running (sub-emitters follow their parent)
      e.warmed = true;
      if (e.def.loop && !e.sources) e.advance(Math.min(e.def.duration + (e.def.lifetime?.max ?? 0), 20));
    }
    e.step(dt);
    e.upload();
  }
}

/** Particle count, for the status line. */
export const particleCount = () => [...emitters].reduce((n, e) => n + e.count, 0);
