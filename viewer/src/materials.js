import * as THREE from 'three';

// Reimplementation of SYBO's mobile shaders (the export only keeps their property
// blocks). The Unity project renders in Gamma color space, so all math here is done
// on raw sRGB values: textures are sampled without decoding and written as-is.

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

// ---------------------------------------------------------------- shared uniforms

// Curved-world bend (BendShaderController): offset grows with the square of view depth
export const bend = { value: new THREE.Vector2(0, 0) }; // x: left/right, y: down/up

// Depth at which `degrees` is reached: tan(heading) = 2·k·D
const BEND_REFERENCE_DEPTH = 600;

/** Sets the horizontal bend from a heading angle (degrees, + = right) and vertical likewise (+ = down). */
export function setBendDegrees(horizontal, vertical = 0) {
  const k = (deg) => Math.tan(THREE.MathUtils.degToRad(deg)) / (2 * BEND_REFERENCE_DEPTH);
  bend.value.set(k(horizontal), k(vertical));
}

export const globals = {
  uTime: { value: 0 },
  uFogColor: { value: new THREE.Color(0.63, 0.69, 0.74) },
  uFogRange: { value: new THREE.Vector2(428, 600) }, // ThemeConfig FogStart/EndDistance
  uFogOn: { value: 1 },
  uBend: bend,
  uResolution: { value: new THREE.Vector2(1920, 1080) }, // render target size (screen-space masks)
  uAltRatio: { value: 0 }, // _AlternateColorRatio (New York "Play2Plant" variant textures)
};

/** Applies a theme's fog (ThemeConfig); `scale` stretches the distances for free roaming. */
export function setFog({ color, start, end } = {}, enabled = true, scale = 1) {
  if (color) globals.uFogColor.value.setRGB(color[0], color[1], color[2]); // raw gamma values
  if (start != null) globals.uFogRange.value.set(start * scale, end * scale);
  globals.uFogOn.value = enabled ? 1 : 0;
}

// ---------------------------------------------------------------- shaders

const COMBINED_VERTEX = /* glsl */ `
uniform vec2 uBend;
uniform float uTime;
uniform vec4 uMainST;
uniform vec2 uScroll;
#ifdef WAVE
#ifndef USE_COLOR
attribute vec3 color; // VertexWave: vertex color = sway weight
#endif
uniform vec3 uWaveDir;
uniform vec3 uWavePlane;
uniform vec3 uWaveParams; // frequency, speed, height
#endif
#ifdef LAVA
uniform sampler2D uDisplaceTex;
uniform vec2 uDisplaceScroll;
uniform float uMeshDisplace;
#endif
varying vec2 vUv;
varying float vDepth;
varying vec3 vNormalV;
varying vec3 vViewDir;
#ifdef USE_COLOR
varying vec3 vColor;
#endif

void main() {
  vUv = uv * uMainST.xy + uMainST.zw;
#ifdef SCROLL
  vUv += uScroll * uTime / 20.0; // Unity _Time.x
#endif
  vec3 p = position;
#ifdef WAVE
  vec3 wp = (modelMatrix * vec4(p, 1.0)).xyz;
  float phase = uTime * uWaveParams.y * 0.1 + dot(wp, uWavePlane) * uWaveParams.x * 0.1;
  p += uWaveDir * sin(phase) * uWaveParams.z * color.r;
#endif
#ifdef LAVA
  p.y += (texture2D(uDisplaceTex, uv + uDisplaceScroll * uTime / 20.0).r - 0.5) * uMeshDisplace;
#endif
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float depth = max(-mv.z, 0.0);
  mv.xy += vec2(uBend.x, -uBend.y) * depth * depth;
  vDepth = -mv.z;
  vNormalV = normalize(normalMatrix * normal);
  vViewDir = normalize(-mv.xyz);
#ifdef USE_COLOR
  vColor = color;
#endif
  gl_Position = projectionMatrix * mv;
}
`;

const FOG_GLSL = /* glsl */ `
uniform vec3 uFogColor;
uniform vec2 uFogRange;
uniform float uFogOn;
float fogFactor(float depth) {
  return uFogOn * clamp((depth - uFogRange.x) / max(uFogRange.y - uFogRange.x, 1.0), 0.0, 1.0);
}
`;

const COMBINED_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform vec4 uColor;
uniform float uMultiplier;
uniform sampler2D uRefTex;
uniform vec4 uRefColor;
uniform vec4 uRimColor;
uniform float uRimPower;
uniform float uRimAmount;
uniform float uFogMultiplier;
uniform sampler2D uAltTex;
uniform sampler2D uAltRef;
uniform float uAltRatio;
uniform sampler2D uMaskTex;
uniform vec2 uResolution;
varying vec2 vUv;
varying float vDepth;
varying vec3 vNormalV;
varying vec3 vViewDir;
#ifdef USE_COLOR
varying vec3 vColor;
#endif
${FOG_GLSL}

void main() {
  vec4 c = texture2D(uMap, vUv);
#ifdef ALTERNATE
  c = mix(c, texture2D(uAltTex, vUv), uAltRatio);
#endif
#ifdef MASK_TEXTURE
  c = vec4(vec3(c.r), c.r); // channel-packed masks (fountain foam): red = fill
#endif
#ifdef TINT
  c *= uColor;
#endif
#ifdef USE_COLOR
  c.rgb *= vColor;
#endif
#ifdef REFLECTIONS
  vec3 n = normalize(vNormalV);
  vec3 refl = texture2D(uRefTex, n.xy * 0.5 + 0.5).rgb;
#ifdef ALTERNATE
  refl = mix(refl, texture2D(uAltRef, n.xy * 0.5 + 0.5).rgb, uAltRatio);
#endif
  c.rgb += refl * uRefColor.rgb * uRefColor.a;
#endif
#ifdef SCREEN_MASK
  // ScreenMask (rails): a highlight band picked by screen height, added on top
  c.rgb += texture2D(uMaskTex, vec2(0.5, 1.0 - gl_FragCoord.y / uResolution.y)).rgb;
#endif
#ifdef RIM
  float rim = pow(1.0 - clamp(dot(normalize(vNormalV), normalize(vViewDir)), 0.0, 1.0), uRimPower) * uRimAmount;
  c.rgb += uRimColor.rgb * rim;
#endif
#ifdef MULTIPLIER
  c.rgb *= uMultiplier;
#endif
  float fog = fogFactor(vDepth);
#ifdef FOG_MULTIPLIER
  fog = clamp(fog * uFogMultiplier, 0.0, 1.0);
#endif
#if FADE_MODE == 2
  c.rgb = mix(c.rgb, vec3(0.0), fog); // additive fades to nothing
#elif FADE_MODE == 3
  c.rgb = mix(c.rgb, vec3(1.0), fog); // multiply fades to neutral
#else
  c.rgb = mix(c.rgb, uFogColor, fog);
#endif
  gl_FragColor = c;
}
`;

// SYBO/Bend/Specials/Fountain: scrolling channel-packed mask, alpha-killed
const FOUNTAIN_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform vec4 uMainColor;
uniform vec4 uFoamColor;
uniform float uAlphaKill;
varying vec2 vUv;
varying float vDepth;
${FOG_GLSL}

void main() {
  vec4 m = texture2D(uMap, vUv);
  if (max(m.r, m.g) < uAlphaKill) discard;
  vec3 c = mix(uMainColor.rgb, uFoamColor.rgb, m.r) + vec3(m.r * 0.6); // foam fill is bright
  gl_FragColor = vec4(mix(c, uFogColor, fogFactor(vDepth)), 1.0);
}
`;

// SYBO/Bend/Specials/NoFloorLava: noise-distorted scrolling lava, channels remapped to colors
const LAVA_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform sampler2D uDisplaceTex;
uniform vec2 uDisplaceScroll;
uniform float uDisplaceStrength;
uniform vec3 uColorR;
uniform vec3 uColorG;
uniform vec3 uColorB;
uniform float uTime;
varying vec2 vUv;
varying float vDepth;
${FOG_GLSL}

void main() {
  float d = texture2D(uDisplaceTex, vUv + uDisplaceScroll * uTime / 20.0).r - 0.5;
  vec3 t = texture2D(uMap, vUv + d * uDisplaceStrength).rgb;
  vec3 c = t.r * uColorR + t.g * uColorG + t.b * uColorB;
  gl_FragColor = vec4(mix(c, uFogColor, fogFactor(vDepth)), 1.0);
}
`;

// SYBO/Skybox: screen-space vertical gradient
const SKY_VERTEX = /* glsl */ `
varying float vY;
void main() {
  vY = position.y * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0); // mid-depth: never clipped (depth test is off anyway)
}
`;
const SKY_FRAGMENT = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uBottom;
uniform float uPower;
varying float vY;
void main() {
  gl_FragColor = vec4(mix(uBottom, uTop, pow(clamp(vY, 0.0, 1.0), uPower)), 1.0);
}
`;

/** Full-screen gradient drawn behind everything (ThemeConfig skybox material). */
export function createSky() {
  const mat = new THREE.ShaderMaterial({
    vertexShader: SKY_VERTEX,
    fragmentShader: SKY_FRAGMENT,
    uniforms: {
      uTop: { value: new THREE.Color(0.6, 0.65, 0.7) },
      uBottom: { value: new THREE.Color(0.74, 0.83, 0.91) },
      uPower: { value: 3 },
    },
    depthTest: false,
    depthWrite: false,
  });
  const sky = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  sky.frustumCulled = false;
  sky.renderOrder = -10000;
  sky.setColors = ({ top, bottom, power } = {}) => {
    if (top) mat.uniforms.uTop.value.setRGB(top[0], top[1], top[2]);
    if (bottom) mat.uniforms.uBottom.value.setRGB(bottom[0], bottom[1], bottom[2]);
    if (power) mat.uniforms.uPower.value = power;
  };
  return sky;
}

// ---------------------------------------------------------------- textures

const textureLoader = new THREE.TextureLoader();
const textureCache = new Map();
const WHITE = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
WHITE.needsUpdate = true;

function loadTexture(url) {
  if (!textureCache.has(url)) {
    const tex = textureLoader.load(url);
    tex.flipY = false; // glTF UV convention
    tex.colorSpace = THREE.NoColorSpace; // gamma workflow: sample raw sRGB values
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    textureCache.set(url, tex);
  }
  return textureCache.get(url);
}

// ---------------------------------------------------------------- library

const color4 = (c, fallback = [1, 1, 1, 1]) => new THREE.Vector4(...(c ?? fallback));

export class MaterialLibrary {
  constructor(manifest, baseUrl) {
    this.defs = manifest.materials;
    this.baseUrl = baseUrl;
    this.cache = new Map();
    this.glassOpacity = 1; // multiplier on transparent glass alpha (UI)
  }

  tex(def, name) {
    const t = def.textures[name];
    if (!t?.url) return null;
    return loadTexture(t.url.startsWith('/') ? t.url : `${this.baseUrl}/${t.url}`); // merged envs use absolute paths
  }

  get(name, fallback) {
    if (this.cache.has(name)) return this.cache.get(name);
    const def = this.defs[name];
    let mat;
    if (!def) mat = this.fromFallback(name, fallback);
    else if (def.shader === 'SYBO/Bend/Specials/Fountain') mat = this.fountain(name, def);
    else if (def.shader === 'SYBO/Bend/Specials/NoFloorLava') mat = this.lava(name, def);
    else mat = this.combined(name, def); // incl. Legacy/VertexWave and Common/ScreenMask variants
    this.cache.set(name, mat);
    return mat;
  }

  /** SYBO/Bend/Combined: keyword-driven übershader. */
  combined(name, def) {
    const f = def.floats;
    const c = def.colors;
    const main = def.textures._MainTex;
    const keywords = new Set(def.keywords);
    const on = (flag, keyword) => !!f[flag] || keywords.has(keyword);
    const fadeMode = f.FADE_MODE ?? 0;

    const defines = { FADE_MODE: fadeMode };
    if (on('_HasTint', 'TINT_ENABLED') || fadeMode === 1) defines.TINT = '';
    if (on('_HasMultiplier', 'MULTIPLIER_ENABLED')) defines.MULTIPLIER = '';
    if (on('_HasScroll', 'SCROLL_ENABLED')) defines.SCROLL = '';
    if (on('_HasRim', 'RIM_ENABLED')) defines.RIM = '';
    if (on('_HasFogMultiplier', 'FOG_MULTIPLIER_ENABLED')) defines.FOG_MULTIPLIER = '';
    const refTex = this.tex(def, '_RefCube');
    if (on('_HasReflections', 'REFLECTIONS_ENABLED') && refTex) defines.REFLECTIONS = '';
    if (/fountain/i.test(main?.url ?? '')) defines.MASK_TEXTURE = '';
    const altTex = this.tex(def, '_AlternateTex');
    if (on('_HasAlternateColors', 'ALTERNATE_COLORS_ENABLED') && altTex) defines.ALTERNATE = '';
    const maskTex = def.shader === 'SYBO/Bend/Common/ScreenMask' ? this.tex(def, '_MaskTex') : null;
    if (maskTex) defines.SCREEN_MASK = '';
    const wave = def.shader === 'SYBO/Bend/Legacy/VertexWave';
    if (wave) defines.WAVE = '';

    const tint = color4(c._Color);
    const mat = new THREE.ShaderMaterial({
      name,
      defines,
      vertexShader: COMBINED_VERTEX,
      fragmentShader: COMBINED_FRAGMENT,
      vertexColors: on('_HasVertexColors', 'VERTEX_COLORS_ENABLED'),
      uniforms: {
        ...globals,
        uMap: { value: this.tex(def, '_MainTex') ?? WHITE },
        uMainST: { value: new THREE.Vector4(...(main?.scale ?? [1, 1]), ...(main?.offset ?? [0, 0])) },
        uColor: { value: tint },
        uMultiplier: { value: f._Multiplier ?? 1 },
        uScroll: { value: new THREE.Vector2(c._ScrollSpeed?.[0] ?? 0, c._ScrollSpeed?.[1] ?? 0) },
        uRefTex: { value: refTex ?? WHITE },
        uRefColor: { value: color4(c._RefColor, [1, 1, 1, 0]) },
        uRimColor: { value: color4(c._RimColor) },
        uRimPower: { value: f._RimPower ?? 2.75 },
        uRimAmount: { value: f._RimAmount ?? 1.5 },
        uFogMultiplier: { value: f._FogMultiplier ?? 1 },
        uAltTex: { value: altTex ?? WHITE },
        uAltRef: { value: this.tex(def, '_AlternateRef') ?? refTex ?? WHITE },
        uMaskTex: { value: maskTex ?? WHITE },
        uWaveDir: { value: new THREE.Vector3(...(c._WaveDirection ?? [0, 0, 0]).slice(0, 3)) },
        uWavePlane: { value: new THREE.Vector3(...(c._WavePlaneNormal ?? [0, 0, 0]).slice(0, 3)) },
        uWaveParams: { value: new THREE.Vector3(f._Frequency ?? 1, f._Speed ?? 1, f._WaveHeight ?? 0) },
      },
    });
    this.applyRenderState(mat, name, def);
    if (fadeMode === 1 && /glass/i.test(name)) {
      mat.userData.glass = true;
      mat.userData.baseAlpha = tint.w;
      tint.w *= this.glassOpacity;
    }
    return mat;
  }

  fountain(name, def) {
    const c = def.colors;
    const main = def.textures._MainTex;
    const mat = new THREE.ShaderMaterial({
      name,
      defines: { SCROLL: '' },
      vertexShader: COMBINED_VERTEX,
      fragmentShader: FOUNTAIN_FRAGMENT,
      uniforms: {
        ...globals,
        uMap: { value: this.tex(def, '_MainTex') ?? WHITE },
        uMainST: { value: new THREE.Vector4(...(main?.scale ?? [1, 1]), ...(main?.offset ?? [0, 0])) },
        uScroll: { value: new THREE.Vector2(c._TextureScrollSpeed?.[0] ?? 0, c._TextureScrollSpeed?.[1] ?? 0) },
        uMainColor: { value: color4(c._MainColor) },
        uFoamColor: { value: color4(c._FoamColor) },
        uAlphaKill: { value: def.floats._AlphaKillValue ?? 0.5 },
      },
    });
    this.applyRenderState(mat, name, def);
    return mat;
  }

  lava(name, def) {
    const f = def.floats;
    const c = def.colors;
    const main = def.textures._MainTex;
    const rgb = (k) => new THREE.Vector3(...(c[k] ?? [1, 1, 1]).slice(0, 3));
    const mat = new THREE.ShaderMaterial({
      name,
      defines: { SCROLL: '', LAVA: '' },
      vertexShader: COMBINED_VERTEX,
      fragmentShader: LAVA_FRAGMENT,
      uniforms: {
        ...globals,
        uMap: { value: this.tex(def, '_MainTex') ?? WHITE },
        uMainST: { value: new THREE.Vector4(...(main?.scale ?? [1, 1]), ...(main?.offset ?? [0, 0])) },
        uScroll: { value: new THREE.Vector2(c._TextureScrollSpeed?.[0] ?? 0, c._TextureScrollSpeed?.[1] ?? 0) },
        uDisplaceTex: { value: this.tex(def, '_DisplaceTex') ?? WHITE },
        uDisplaceScroll: { value: new THREE.Vector2(c._DisplaceScrollSpeed?.[0] ?? 0, c._DisplaceScrollSpeed?.[1] ?? 0) },
        uDisplaceStrength: { value: f._DisplaceStrength ?? 0.1 },
        uMeshDisplace: { value: f._MeshDisplaceStrength ?? 0 },
        uColorR: { value: rgb('_ColorR') },
        uColorG: { value: rgb('_ColorG') },
        uColorB: { value: rgb('_ColorB') },
      },
    });
    this.applyRenderState(mat, name, def);
    return mat;
  }

  /** Blend / cull / depth state from the Unity material's _SrcMode/_DstMode/_CullMode/_ZWrite. */
  applyRenderState(mat, name, def) {
    const f = def.floats;
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
  }

  fromFallback(name, fallback) {
    const map = fallback?.map ?? null;
    if (map) map.colorSpace = THREE.NoColorSpace;
    return new THREE.ShaderMaterial({
      name,
      defines: { FADE_MODE: 0, TINT: '' },
      vertexShader: COMBINED_VERTEX,
      fragmentShader: COMBINED_FRAGMENT,
      uniforms: {
        ...globals,
        uMap: { value: map ?? WHITE },
        uMainST: { value: new THREE.Vector4(1, 1, 0, 0) },
        uScroll: { value: new THREE.Vector2() },
        uColor: { value: map ? new THREE.Vector4(1, 1, 1, 1) : new THREE.Vector4(1, 0, 1, 1) }, // magenta = unresolved
        uMultiplier: { value: 1 },
        uRefTex: { value: WHITE },
        uRefColor: { value: new THREE.Vector4() },
        uRimColor: { value: new THREE.Vector4() },
        uRimPower: { value: 1 },
        uRimAmount: { value: 0 },
        uFogMultiplier: { value: 1 },
        uAltTex: { value: WHITE },
        uAltRef: { value: WHITE },
        uMaskTex: { value: WHITE },
      },
    });
  }

  /** Scales the alpha of transparent glass materials (UI slider). */
  setGlassOpacity(v) {
    this.glassOpacity = v;
    for (const mat of this.cache.values()) {
      if (mat.userData.glass) mat.uniforms.uColor.value.w = mat.userData.baseAlpha * v;
    }
  }
}
