import * as THREE from 'three';

// UnityEngine.Rendering.BlendMode -> three.js blend factors
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

// UnityEngine.Rendering.CullMode: 0 Off, 1 Front, 2 Back
const SIDE = [THREE.DoubleSide, THREE.BackSide, THREE.FrontSide];

// Curved-world bend shared by every material (SYBO/Bend/* shaders bend in the vertex stage).
// Offset grows with the square of the view depth, like the game's BendShaderController.
export const bend = { value: new THREE.Vector2(0, 0) }; // x: left/right, y: down/up

// Depth at which `degrees` is reached: tan(heading) = 2·k·D
const BEND_REFERENCE_DEPTH = 600;

/** Sets the horizontal bend from a heading angle (degrees, + = right) and vertical likewise (+ = down). */
export function setBendDegrees(horizontal, vertical = 0) {
  const k = (deg) => Math.tan(THREE.MathUtils.degToRad(deg)) / (2 * BEND_REFERENCE_DEPTH);
  bend.value.set(k(horizontal), k(vertical));
}

function addBend(mat) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uBend = bend;
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'uniform vec2 uBend;\nvoid main() {')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        float bendDepth = max(-mvPosition.z, 0.0);
        mvPosition.xy += vec2(uBend.x, -uBend.y) * bendDepth * bendDepth;
        gl_Position = projectionMatrix * mvPosition;`,
      );
  };
  mat.customProgramCacheKey = () => 'bend';
  return mat;
}

const textureLoader = new THREE.TextureLoader();
const textureCache = new Map();

function loadTexture(url) {
  if (!textureCache.has(url)) {
    const tex = textureLoader.load(url);
    tex.flipY = false; // glTF UV convention
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    textureCache.set(url, tex);
  }
  return textureCache.get(url);
}

/**
 * Builds three.js materials from the manifest's parsed Unity materials.
 * Basic unlit approximation of SYBO/Bend/Combined; the custom shader comes later.
 */
export class MaterialLibrary {
  constructor(manifest, baseUrl) {
    this.defs = manifest.materials;
    this.baseUrl = baseUrl;
    this.cache = new Map();
  }

  get(name, fallback) {
    if (this.cache.has(name)) return this.cache.get(name);
    const def = this.defs[name];
    const mat = addBend(def ? this.build(name, def) : this.fromFallback(name, fallback));
    this.cache.set(name, mat);
    return mat;
  }

  build(name, def) {
    const f = def.floats;
    const c = def.colors;
    const mat = new THREE.MeshBasicMaterial({ name });

    const main = def.textures._MainTex;
    if (main?.url) {
      const tex = loadTexture(`${this.baseUrl}/${main.url}`);
      const hasXform = main.scale?.some((v) => v !== 1) || main.offset?.some((v) => v !== 0);
      if (hasXform) {
        mat.map = tex.clone();
        mat.map.repeat.set(...main.scale);
        mat.map.offset.set(...main.offset);
      } else {
        mat.map = tex;
      }
    }

    if (f._HasTint && c._Color) mat.color.setRGB(c._Color[0], c._Color[1], c._Color[2], THREE.SRGBColorSpace);
    if (f._HasMultiplier && f._Multiplier != null) mat.color.multiplyScalar(f._Multiplier);
    mat.vertexColors = !!f._HasVertexColors;
    mat.side = SIDE[f._CullMode ?? 2] ?? THREE.FrontSide;
    mat.depthWrite = (f._ZWrite ?? 1) !== 0;

    const src = f._SrcMode ?? 1;
    const dst = f._DstMode ?? 0;
    const transparent = !(src === 1 && dst === 0) || def.renderQueue >= 2500;
    if (transparent) {
      mat.transparent = true;
      mat.blending = THREE.CustomBlending;
      mat.blendSrc = BLEND[src];
      mat.blendDst = BLEND[dst];
    }
    // Overlays modeled flush with another surface (train windows, lights, baked shadows,
    // glows) z-fight in three.js; bias them towards the camera so they win like in game
    if (transparent || /_(glass|lights?|shadow|glow)$/i.test(name)) {
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = -1;
      mat.polygonOffsetUnits = -4;
    }
    if (def.renderQueue > 0) mat.userData.renderQueue = def.renderQueue;
    mat.userData.unity = def;
    return mat;
  }

  fromFallback(name, fallback) {
    const mat = new THREE.MeshBasicMaterial({ name, map: fallback?.map ?? null });
    if (!fallback?.map) mat.color.set(0xff00ff); // unresolved material: make it obvious
    return mat;
  }
}
