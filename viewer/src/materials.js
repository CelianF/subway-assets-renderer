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

const MAX_CUTS = 32;
export const MAX_ALT_ZONES = 16; // studio challenge zones (setAltZones)

// Depth bias, in steps towards the camera. three flips the slope factor for the reversed
// depth buffer but not the constant units, so those are flipped here
let reversedDepth = false;
export function setReversedDepth(on) {
  reversedDepth = on;
}
function depthBias(mat, steps) {
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -steps;
  mat.polygonOffsetUnits = (reversedDepth ? 4 : -4) * steps;
}

export const globals = {
  uTime: { value: 0 },
  uFogColor: { value: new THREE.Color(0.63, 0.69, 0.74) },
  uFogRange: { value: new THREE.Vector2(428, 600) }, // ThemeConfig FogStart/EndDistance
  uFogOn: { value: 1 },
  uBend: bend,
  uResolution: { value: new THREE.Vector2(1920, 1080) }, // render target size (screen-space masks)
  uAltRatio: { value: 0 }, // _AlternateColorRatio (New York "Play2Plant" variant textures)
  // Challenge zones (setAltZones): (z0, z1, runner z, looping) where the main textures show,
  // the alternate ones elsewhere; a looping zone only shows them around its runner, from
  // uAltReach.x behind it to .y ahead. Count -1: no zones, uAltRatio everywhere
  uAltZoneCount: { value: -1 },
  uAltZones: { value: Array.from({ length: MAX_ALT_ZONES }, () => new THREE.Vector4()) },
  uAltReach: { value: new THREE.Vector2() },
  // Studio "no tracks" zones: (track x, z0, z1); rails hide inside, fill ground shows only inside
  uCutCount: { value: 0 },
  uCuts: { value: Array.from({ length: MAX_CUTS }, () => new THREE.Vector3()) },
};

/**
 * Event challenge cities (3.19 New York Play2Plant's Green Jam, St Petersburg's Christmas):
 * the main textures are the challenge look (green city, Christmas decorations), the
 * alternate ones the city without it (grey, plain). Inside the zones the challenge shows;
 * null: no challenge, the main textures everywhere.
 */
export function setAltZones(zones, reach = null) {
  if (!zones) {
    globals.uAltZoneCount.value = -1;
    globals.uAltRatio.value = 0;
    return;
  }
  const list = zones.slice(0, MAX_ALT_ZONES);
  list.forEach(([z0, z1], i) => globals.uAltZones.value[i].set(z0, z1, z0, reach ? 1 : 0));
  globals.uAltZoneCount.value = list.length;
  if (reach) globals.uAltReach.value.set(reach[0], reach[1]);
}
/** Where zone `i`'s runner is (looping zones: the look shows around it). */
export function setAltRunner(i, z) {
  globals.uAltZones.value[i].z = z;
}

/**
 * A copy of a material drawn only outside ('outside') or inside ('inside') the given zones
 * along the run ([z0, z1) each); `zones` is shared, so updating it moves every copy's cut.
 */
export function zoneClipped(material, side, zones) {
  const copy = material.clone();
  copy.defines = { ...material.defines, ZONE_CLIP: side === 'outside' ? 1 : 2 };
  copy.uniforms = { ...material.uniforms, uZoneCount: zones.count, uZones: zones.list };
  return copy;
}
export const makeZoneUniforms = () => ({
  count: { value: 0 },
  list: { value: Array.from({ length: MAX_ALT_ZONES }, () => new THREE.Vector2()) },
});

/** Sets the "no tracks" zones the track materials cut out. */
export function setTrackCuts(zones) {
  const list = zones.slice(0, MAX_CUTS);
  list.forEach((z, i) => globals.uCuts.value[i].set(z.lane, z.z0, z.z1));
  globals.uCutCount.value = list.length;
}

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
attribute vec4 color; // VertexWave: vertex color red = sway weight, alpha = phase offset (2.x)
#define WAVE_ALPHA color.a
#elif defined(USE_COLOR_ALPHA)
#define WAVE_ALPHA color.a
#else
#define WAVE_ALPHA 1.0
#endif
uniform vec3 uWaveDir;
uniform vec3 uWavePlane;
uniform vec3 uWaveParams; // frequency, speed, height
uniform vec3 uWaveScales; // _SpeedScales: speed per axis
uniform vec3 uWaveExtra; // _OffsetScale, _VertexColorWeight, _IgnoreVertexColor (2.x)
#endif
#ifdef WATER_WAVE
uniform vec4 uWaterWave; // amplitude x, amplitude z, frequency x, frequency z
uniform vec2 uWaterSpeed; // speed x, speed z
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
varying vec3 vWorld;
varying vec3 vNormalW;
#ifdef USE_COLOR
varying vec3 vColor;
#endif
#ifdef USE_COLOR_ALPHA
varying float vColorA; // RGBA vertex colors: their alpha fades transparent pieces (3.70 Haunted Hood smoke)
#endif
#include <clipping_planes_pars_vertex>
#include <skinning_pars_vertex>
#include <morphtarget_pars_vertex>

void main() {
  // Unity applies tiling/offset (and scrolls) with V pointing up; glTF UVs have V
  // flipped, so convert to Unity space and back or scrolling runs the wrong way.
  vec2 offset = uMainST.zw;
#ifdef SCROLL
  // Unity _Time.x. A flipped tiling (-3) flips the scroll with it, so the pattern moves the
  // way its flipped arrows point: race speed pads (boost: tiling -3, scroll +20; slow:
  // tiling 3, scroll -20) run in opposite directions, forward and back
  offset += uScroll * sign(uMainST.xy) * uTime / 20.0;
#endif
  vec2 unityUv = vec2(uv.x, 1.0 - uv.y) * uMainST.xy + offset;
  vUv = vec2(unityUv.x, 1.0 - unityUv.y);
  vec3 p = position;
  vec3 n = normal;
#ifdef USE_SKINNING
  // Animated rigs (the Underwater kraken): three.js bone skinning
  vec3 objectNormal = normal;
  vec3 transformed = position;
#include <skinbase_vertex>
#include <skinnormal_vertex>
#include <skinning_vertex>
  p = transformed;
  n = objectNormal;
#endif
#ifdef USE_MORPHTARGETS
  {
    // Blend shapes (the Cosmic Crossroads monster's mouth)
    vec3 transformed = p;
#include <morphinstance_vertex>
#include <morphtarget_vertex>
    p = transformed;
  }
#endif
#ifdef WAVE
  // SYBO VertexWave: a sine travelling across the wave plane (radians per unit, per second),
  // each axis at its own speed; vertex color red weights it (0 at a plant's base)
  vec3 wp = (modelMatrix * vec4(p, 1.0)).xyz;
#ifdef WAVE_2X
  // 2.x SYBO/Bend/VertexWave (from its compiled code): the wave travels along _WaveDirection,
  // vertices move along _WavePlaneNormal (object space); vertex alpha offsets the phase,
  // red weights the motion; _Time.x * 10 = half a second's worth
  vec3 phase = vec3(uTime * 0.5 * uWaveParams.y) * uWaveScales + dot(wp, -uWaveDir) * uWaveParams.x + uWaveExtra.x * WAVE_ALPHA;
  p += sin(phase) * uWaveParams.z * uWavePlane * mix(color.r, 1.0, uWaveExtra.z) * uWaveExtra.y;
#else
  vec3 phase = uTime * uWaveParams.y * uWaveScales + dot(wp, uWavePlane) * uWaveParams.x;
  p += uWaveDir * sin(phase) * uWaveParams.z * color.r;
#endif
#endif
#ifdef LAVA
  p.y += (texture2D(uDisplaceTex, uv + vec2(1.0, -1.0) * uDisplaceScroll * uTime / 20.0).r - 0.5) * uMeshDisplace;
#endif
#ifdef WATER_WAVE
  // Bend/Wave (1.x water): two sine swells across the surface (world space, sizes in units)
  vec3 ww = (modelMatrix * vec4(p, 1.0)).xyz;
  p.y += sin(ww.x * uWaterWave.z * 0.01 + uTime * uWaterSpeed.x) * uWaterWave.x * 0.25
       + sin(ww.z * uWaterWave.w * 0.01 + uTime * uWaterSpeed.y) * uWaterWave.y * 0.25;
#endif
  vWorld = (modelMatrix * vec4(p, 1.0)).xyz;
  vNormalW = normalize(mat3(modelMatrix) * n);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float depth = max(-mv.z, 0.0);
  mv.xy += vec2(uBend.x, -uBend.y) * depth * depth;
  vDepth = -mv.z;
  vNormalV = normalize(normalMatrix * n);
  vViewDir = normalize(-mv.xyz);
#ifdef USE_COLOR
  vColor = color.rgb; // vec3 or vec4 (RGBA vertex colors) depending on the mesh
#endif
#ifdef USE_COLOR_ALPHA
  vColorA = color.a;
#endif
  gl_Position = projectionMatrix * mv;
  vec4 mvPosition = mv;
#include <clipping_planes_vertex>
}
`;

// Track cut-outs (studio "no tracks" zones): TRACK_CUT 1 hides inside, 2 shows only inside
const CUT_GLSL = /* glsl */ `
#include <clipping_planes_pars_fragment>
varying vec3 vWorld;
#ifdef TRACK_CUT
uniform int uCutCount;
uniform vec3 uCuts[${32}];
bool inCut() {
  for (int i = 0; i < ${32}; i++) {
    if (i >= uCutCount) break;
    if (abs(vWorld.x - uCuts[i].x) < 10.0 && vWorld.z >= uCuts[i].y && vWorld.z < uCuts[i].z) return true;
  }
  return false;
}
#endif
#ifdef ZONE_CLIP
// A piece shown only inside (ZONE_CLIP 2) or outside (1) zones along the run: the No Floor
// floor's activated and default states, cut exactly at the studio zone's ends
uniform int uZoneCount;
uniform vec2 uZones[${MAX_ALT_ZONES}];
bool inZone() {
  for (int i = 0; i < ${MAX_ALT_ZONES}; i++) {
    if (i >= uZoneCount) break;
    if (vWorld.z >= uZones[i].x && vWorld.z < uZones[i].y) return true;
  }
  return false;
}
#endif
`;
const CUT_MAIN = /* glsl */ `
#include <clipping_planes_fragment>
#ifdef TRACK_CUT
#if TRACK_CUT == 1
  if (inCut()) discard;
#else
  if (!inCut()) discard;
#endif
#endif
#ifdef ZONE_CLIP
#if ZONE_CLIP == 1
  if (inZone()) discard;
#else
  if (!inZone()) discard;
#endif
#endif
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
uniform vec4 uColor2;
uniform float uMultiplier;
uniform sampler2D uRefTex;
uniform vec4 uRefColor;
uniform vec4 uRimColor;
uniform float uRimPower;
uniform float uRimAmount;
uniform float uFogMultiplier;
uniform float uTime;
uniform sampler2D uAltTex;
uniform sampler2D uAltRef;
uniform float uAltRatio;
uniform int uAltZoneCount;
uniform vec4 uAltZones[${MAX_ALT_ZONES}];
uniform vec2 uAltReach;
uniform sampler2D uMaskTex;
uniform vec2 uResolution;
uniform vec4 uUvWobble; // 1.x water: x amplitude, x frequency, y amplitude, y frequency
uniform vec2 uUvWobbleSpeed;
#ifdef WATER_DISTORT
uniform sampler2D uDisplaceTex; // Specials/Water: a scrolling noise ripples the texture
uniform vec2 uDisplaceScroll;
uniform float uDisplaceStrength;
#endif
varying vec2 vUv;
varying float vDepth;
varying vec3 vNormalV;
varying vec3 vViewDir;
varying vec3 vNormalW;

#ifdef CUBE_STRIP
// Unity cubemap exported as a vertical strip of faces: +X, -X, +Y, -Y, +Z, -Z
vec3 sampleCubeStrip(sampler2D strip, vec3 d) {
  d.x = -d.x; // the glb export mirrors X
  vec3 a = abs(d);
  float face; vec2 st; float ma;
  if (a.x >= a.y && a.x >= a.z) { ma = a.x; face = d.x > 0.0 ? 0.0 : 1.0; st = vec2(d.x > 0.0 ? -d.z : d.z, -d.y); }
  else if (a.y >= a.z) { ma = a.y; face = d.y > 0.0 ? 2.0 : 3.0; st = vec2(d.x, d.y > 0.0 ? d.z : -d.z); }
  else { ma = a.z; face = d.z > 0.0 ? 4.0 : 5.0; st = vec2(d.z > 0.0 ? d.x : -d.x, -d.y); }
  // Half a texel in from each face's edges, and the top mip level: across a face boundary
  // the lookup jumps, which would pick a blurry mip and draw seams (the strips come pre-blurred)
  float inset = 0.5 / float(textureSize(strip, 0).x);
  vec2 uv = clamp((st / ma + 1.0) * 0.5, inset, 1.0 - inset);
  return textureLod(strip, vec2(uv.x, (face + uv.y) / 6.0), 0.0).rgb;
}
#endif
#ifdef USE_COLOR
varying vec3 vColor;
#endif
#ifdef USE_COLOR_ALPHA
varying float vColorA; // RGBA vertex colors: their alpha fades transparent pieces (3.70 Haunted Hood smoke)
#endif
${FOG_GLSL}
${CUT_GLSL}
// Alternate texture share here: the challenge zones' look fades in over 40 at their edges
// (and at the edges of the window around a looping zone's runner)
float altWindow(float z0, float z1) {
  return smoothstep(z0 - 20.0, z0 + 20.0, vWorld.z) * (1.0 - smoothstep(z1 - 20.0, z1 + 20.0, vWorld.z));
}
float altRatio() {
  if (uAltZoneCount < 0) return uAltRatio;
  float inside = 0.0;
  for (int i = 0; i < ${MAX_ALT_ZONES}; i++) {
    if (i >= uAltZoneCount) break;
    vec4 zone = uAltZones[i];
    float shown = altWindow(zone.x, zone.y);
    if (zone.w > 0.5) shown *= altWindow(zone.z - uAltReach.x, zone.z + uAltReach.y);
    inside = max(inside, shown);
  }
  return 1.0 - inside;
}

void main() {
${CUT_MAIN}
  vec2 uv = vUv;
#ifdef UV_WOBBLE
  uv.x += sin(vUv.y * uUvWobble.y * 6.2832 + uTime * uUvWobbleSpeed.x) * uUvWobble.x;
  uv.y += sin(vUv.x * uUvWobble.w * 6.2832 + uTime * uUvWobbleSpeed.y) * uUvWobble.z * 0.1;
#endif
#ifdef WATER_DISTORT
  uv += (texture2D(uDisplaceTex, vUv + vec2(1.0, -1.0) * uDisplaceScroll * uTime / 20.0).r - 0.5) * uDisplaceStrength;
#endif
  vec4 c = texture2D(uMap, uv);
  vec3 base = c.rgb;
#ifdef ALTERNATE
  c = mix(c, texture2D(uAltTex, vUv), altRatio());
#endif
#ifdef GRADIENT
  c.rgb = mix(uColor.rgb, uColor2.rgb, c.r);
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
#if defined(USE_COLOR_ALPHA) && FADE_MODE == 1
  c.a *= vColorA;
#endif
#ifdef REFLECTIONS
#ifdef CUBE_STRIP
  vec3 viewDir = normalize(vWorld - cameraPosition);
  vec3 refl = sampleCubeStrip(uRefTex, reflect(viewDir, normalize(vNormalW)));
#else
  vec3 n = normalize(vNormalV);
  vec3 refl = texture2D(uRefTex, n.xy * 0.5 + 0.5).rgb;
#endif
#ifdef ALTERNATE
  refl = mix(refl, texture2D(uAltRef, n.xy * 0.5 + 0.5).rgb, altRatio());
#endif
#ifdef DISTORTED_REFLECT
  // 1.x "Unlit with overlay and Reflection": faint head-on, strong at grazing angles, and
  // scaled by the texture's brightness (dark paint barely reflects)
  c.rgb += refl * uRefColor.rgb * (1.0 - clamp(-dot(viewDir, normalize(vNormalW)), 0.0, 1.0)) * 0.495 * (base.r + base.g + base.b);
#else
  c.rgb += refl * uRefColor.rgb * uRefColor.a;
#endif
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
${CUT_GLSL}

void main() {
${CUT_MAIN}
  vec4 m = texture2D(uMap, vUv);
  if (max(m.r, m.g) < uAlphaKill) discard;
  vec3 c = mix(uMainColor.rgb, uFoamColor.rgb, m.r) + vec3(m.r * 0.6); // foam fill is bright
  gl_FragColor = vec4(mix(c, uFogColor, fogFactor(vDepth)), 1.0);
}
`;

// Bend/Panning Texture And Double Alpha (2.x) and SYBO/Bend/Legacy/Texture And Double Alpha
// (Seattle's fountain jets): a panning color texture, its alpha a panning mask times a
// static fade along the jet. A panner's
// "time" picks the component of Unity's _Time (0: t/20, 1: t, 2: 2t, 3: 3t)
const DOUBLE_ALPHA_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform sampler2D uAlphaTex;
uniform sampler2D uStaticAlpha;
uniform vec4 uPan; // main xy, alpha zw (UV per second, Unity's V up)
uniform float uMultiplier;
uniform float uTime;
varying vec2 vUv;
varying float vDepth;
${FOG_GLSL}
${CUT_GLSL}

vec2 pan(vec2 speed) {
  vec2 u = vec2(vUv.x, 1.0 - vUv.y) + speed * uTime;
  return vec2(u.x, 1.0 - u.y);
}

void main() {
${CUT_MAIN}
  vec4 c = texture2D(uMap, pan(uPan.xy));
  c.rgb *= uMultiplier;
  c.a *= texture2D(uAlphaTex, pan(uPan.zw)).a * texture2D(uStaticAlpha, vUv).a;
  gl_FragColor = vec4(mix(c.rgb, uFogColor, fogFactor(vDepth)), c.a);
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
${CUT_GLSL}

void main() {
${CUT_MAIN}
  float d = texture2D(uDisplaceTex, vUv + vec2(1.0, -1.0) * uDisplaceScroll * uTime / 20.0).r - 0.5;
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
uniform sampler2D uMap;
uniform vec2 uMapRange; // texel centers at the bottom and top: no repeat bleed
varying float vY;
void main() {
  float y = clamp(vY, 0.0, 1.0);
  // TEXTURE_ENABLED: screen-space vertical gradient texture (flipY off: Unity's v = 1 - ours)
  vec3 t = texture2D(uMap, vec2(0.5, 1.0 - mix(uMapRange.x, uMapRange.y, y))).rgb;
  gl_FragColor = vec4(t * mix(uBottom, uTop, pow(y, uPower)), 1.0);
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
      uMap: { value: WHITE },
      uMapRange: { value: new THREE.Vector2(0, 1) },
    },
    depthTest: false,
    depthWrite: false,
  });
  const sky = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  sky.frustumCulled = false;
  sky.renderOrder = -10000;
  /** @param textureUrl the sky's gradient texture (resolved url), if it has one */
  sky.setColors = ({ top, bottom, power } = {}, textureUrl = null) => {
    if (top) mat.uniforms.uTop.value.setRGB(top[0], top[1], top[2]);
    if (bottom) mat.uniforms.uBottom.value.setRGB(bottom[0], bottom[1], bottom[2]);
    if (power) mat.uniforms.uPower.value = power;
    const map = textureUrl ? loadTexture(textureUrl) : WHITE;
    mat.uniforms.uMap.value = map;
    const fit = () => {
      const h = map.image?.height ?? 0;
      mat.uniforms.uMapRange.value.set(h ? 0.5 / h : 0, h ? 1 - 0.5 / h : 1);
    };
    if (map.image) fit();
    else map.onUpdate = fit; // first upload, once loaded
  };
  return sky;
}

// ---------------------------------------------------------------- textures

const textureLoader = new THREE.TextureLoader();
const textureCache = new Map();
const WHITE = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
WHITE.needsUpdate = true;

const pendingTextures = new Set();

/** Resolves once every texture requested so far has loaded (or failed). */
export function texturesReady() {
  return Promise.all([...pendingTextures]);
}

function loadTexture(url) {
  if (!textureCache.has(url)) {
    let done;
    const pending = new Promise((resolve) => (done = resolve));
    pendingTextures.add(pending);
    const settle = () => (pendingTextures.delete(pending), done());
    const tex = textureLoader.load(url, settle, undefined, settle);
    tex.flipY = false; // glTF UV convention
    tex.colorSpace = THREE.NoColorSpace; // gamma workflow: sample raw sRGB values
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    textureCache.set(url, tex);
  }
  return textureCache.get(url);
}

/** Unity's built-in Default-Particle: a soft disc fading out to the edges (color and alpha). */
let defaultParticleTex = null;
function defaultParticle() {
  if (defaultParticleTex) return defaultParticleTex;
  const n = 64;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const d = Math.hypot((x + 0.5) / n - 0.5, (y + 0.5) / n - 0.5) * 2;
      const a = Math.max(0, 1 - d) ** 2;
      const v = Math.round(a * 255); // color fades too: additive blending ignores alpha
      data.set([v, v, v, v], (y * n + x) * 4);
    }
  }
  defaultParticleTex = new THREE.DataTexture(data, n, n);
  defaultParticleTex.colorSpace = THREE.NoColorSpace;
  defaultParticleTex.magFilter = defaultParticleTex.minFilter = THREE.LinearFilter;
  defaultParticleTex.needsUpdate = true;
  return defaultParticleTex;
}

// ---------------------------------------------------------------- library

const color4 = (c, fallback = [1, 1, 1, 1]) => new THREE.Vector4(...(c ?? fallback));

// Pre-3.0 games used one shader per effect ("Bend/Additive", "Bend/UVScroll", …) instead
// of the keyword-driven SYBO/Bend/Combined. Translate them into Combined settings.
// BlendMode: 0 Zero, 1 One, 2 DstColor, 5 SrcAlpha, 10 OneMinusSrcAlpha.
const LEGACY_SHADERS = [
  [/Additive/i, { FADE_MODE: 2, _SrcMode: 1, _DstMode: 1, _ZWrite: 0, _HasTint: 1 }],
  [/Multiply/i, { FADE_MODE: 3, _SrcMode: 2, _DstMode: 0, _ZWrite: 0 }],
  [/Transparent|Alpha/i, { FADE_MODE: 1, _SrcMode: 5, _DstMode: 10, _ZWrite: 0, _HasTint: 1 }],
  [/UV ?(\w+ )?Scroll/i, { _HasScroll: 1, _HasTint: 1 }], // UVScroll, 1.x "UV Lava Scroll"
  [/Reflection/i, { _HasReflections: 1, _HasTint: 1 }],
  [/Diffuse|MatCap/i, { _HasTint: 1 }],
  // VertexWaveGradient (2.x tulips): grey petals gradient-mapped from _Color to _Color2
  [/VertexWaveGradient/i, { _HasGradient: 1 }],
  [/VertexWave$/i, { _HasTint: 1 }],
];

// 1.x "Custom/Distorted/*" (Distorted = curved world). The export keeps property blocks
// only, so blend modes come from the shader names. Order matters: first match wins.
const DISTORTED_SHADERS = [
  [/Premultiplied/i, { FADE_MODE: 2, _SrcMode: 1, _DstMode: 10, _ZWrite: 0, _HasTint: 1 }],
  [/Additive/i, { FADE_MODE: 2, _SrcMode: 1, _DstMode: 1, _ZWrite: 0, _HasTint: 1 }],
  [/Multiply/i, { FADE_MODE: 3, _SrcMode: 2, _DstMode: 0, _ZWrite: 0 }],
  [/Alpha Blended|Transparent/i, { FADE_MODE: 1, _SrcMode: 5, _DstMode: 10, _ZWrite: 0, _HasTint: 1 }],
];

function translateDistorted(def) {
  const floats = { ...def.floats };
  const colors = { ...def.colors };
  const textures = { ...def.textures };
  const flags = DISTORTED_SHADERS.find(([re]) => re.test(def.shader))?.[1];
  if (flags) Object.assign(floats, flags);
  // Tints: particles-style _TintColor is doubled; additive/premultiplied use _MainColor
  if (/Alpha Blended/i.test(def.shader) && colors._TintColor) colors._Color = colors._TintColor.map((v) => Math.min(v * 2, 1));
  else if (/Additive|Premultiplied/i.test(def.shader)) {
    const tint = colors._MainColor ?? colors._TintColor;
    if (tint) colors._Color = [...tint.slice(0, 3), 1];
  } else if (!/Transparent/i.test(def.shader)) delete colors._Color; // "overlay" tints: unknown blend, left out
  if (/Reflection/i.test(def.shader) && textures._Cube) {
    textures._RefCube = { ...textures._Cube, cubeStrip: true };
    colors._RefColor = colors._ReflectColor ?? [1, 1, 1, 0.5];
    floats._HasReflections = 1;
    floats._DistortedReflect = 1;
  }
  if (/SPmask/i.test(def.shader) && textures._Mask) {
    textures._MaskTex = textures._Mask;
    floats._ScreenMask = 1;
  }
  const renderQueue = def.renderQueue > 0 ? def.renderQueue : floats._DstMode ? 3000 : 2000;
  return { ...def, floats, colors, textures, renderQueue };
}

function translateLegacy(def) {
  if (/^Custom\/Distorted\//.test(def.shader) && !/Skyline/.test(def.shader)) return translateDistorted(def);
  if (/^Bend\/Wave \(UV Distorted\)/.test(def.shader)) {
    // 1.x water: scrolling, UV-wobbled texture on a gently swelling surface
    return { ...def, floats: { ...def.floats, _HasScroll: 1, _WaterWave: 1 }, renderQueue: def.renderQueue > 0 ? def.renderQueue : 2000 };
  }
  if (!/^(SYBO\/)?Bend\//.test(def.shader) || /Combined|Specials|Common\/ScreenMask|Legacy\/VertexWave/.test(def.shader)) return def;
  const floats = { ...def.floats };
  // Pre-3.0 additive shaders keep their color in _TintColor (2.8 Cambridge's red owl eyes)
  if (def.colors?._TintColor && !def.colors._Color) def = { ...def, colors: { ...def.colors, _Color: def.colors._TintColor } };
  for (const [re, flags] of LEGACY_SHADERS) if (re.test(def.shader)) Object.assign(floats, flags, def.floats.FADE_MODE != null ? {} : {});
  if (floats._ColorMultiplier != null) Object.assign(floats, { _HasMultiplier: 1, _Multiplier: floats._ColorMultiplier });
  // Bend/UVScroll scrolls by _Time.y (seconds), the Combined shader by _Time.x (seconds / 20):
  // 2.11 Space Station's lane glow is 0.12 there, 2.4 in 3.70's Combined copy
  if (/^Bend\/UVScroll$/.test(def.shader) && def.colors?._ScrollSpeed) {
    return { ...def, floats, renderQueue: def.renderQueue > 0 ? def.renderQueue : floats._DstMode ? 3000 : 2000, colors: { ...def.colors, _ScrollSpeed: def.colors._ScrollSpeed.map((v) => v * 20) } };
  }
  // Legacy transparent queues were left at -1 (shader default)
  const renderQueue = def.renderQueue > 0 ? def.renderQueue : floats._DstMode ? 3000 : 2000;
  return { ...def, floats, renderQueue };
}

export class MaterialLibrary {
  constructor(manifest, baseUrl) {
    this.defs = manifest.materials;
    this.baseUrl = baseUrl;
    this.cache = new Map();
    this.glassOpacity = 1; // multiplier on transparent glass alpha (UI)
  }

  tex(def, name) {
    const t = def.textures[name];
    if (t?.builtin === 'Default-Particle') return defaultParticle();
    if (!t?.url) return null;
    return loadTexture(t.url.startsWith('/') ? t.url : `${this.baseUrl}/${t.url}`); // merged envs use absolute paths
  }

  /** @param cut 0: normal; 1: hidden inside "no tracks" zones (rails); 2: only inside them (fill ground) */
  get(name, fallback, cut = 0) {
    const key = cut ? `${name}|cut${cut}` : name;
    if (this.cache.has(key)) return this.cache.get(key);
    const def = this.defs[name];
    let mat;
    // AssetRipper's filler for sub-meshes the renderer has no material for; Unity skips them
    if (name === 'DefaultMaterial') mat = Object.assign(new THREE.MeshBasicMaterial(), { name, visible: false });
    else if (!def) mat = this.fromFallback(name, fallback);
    else if (def.shader === 'SYBO/Bend/Specials/Fountain') mat = this.fountain(name, def);
    else if (def.shader === 'SYBO/Bend/Specials/NoFloorLava') mat = this.lava(name, def);
    else if (/Bend\/(Legacy\/|Panning )Texture And Double Alpha$/.test(def.shader)) mat = this.doubleAlpha(name, def);
    else mat = this.combined(name, translateLegacy(def)); // incl. VertexWave, ScreenMask and pre-3.0 Bend/* shaders
    if (cut && mat.defines) {
      mat.defines.TRACK_CUT = cut;
      // Track pieces give way to any floor laid over them (platforms, landmarks, plazas):
      // where two floors overlap, the boundary's wins instead of flickering
      if (!mat.polygonOffset) depthBias(mat, -1);
    }
    this.cache.set(key, mat);
    return mat;
  }

  /** SYBO/Bend/Combined: keyword-driven übershader. */
  combined(name, def) {
    const f = def.floats;
    const c = def.colors;
    const main = def.textures._MainTex;
    const keywords = new Set(def.keywords);
    const on = (flag, keyword) => !!f[flag] || keywords.has(keyword);
    // Shaders without a FADE_MODE property (e.g. Specials/Water) fade by their blend mode:
    // additive must fade to black and multiply to white, or the fog color gets added/multiplied in
    const src = f._SrcMode ?? 1;
    const dst = f._DstMode ?? 0;
    const fadeMode = f.FADE_MODE ?? (src === 1 && dst === 1 ? 2 : src === 2 ? 3 : src === 5 && dst === 10 ? 1 : 0);

    const defines = { FADE_MODE: fadeMode };
    if (on('_HasTint', 'TINT_ENABLED') || fadeMode === 1) defines.TINT = '';
    if (on('_HasMultiplier', 'MULTIPLIER_ENABLED')) defines.MULTIPLIER = '';
    if (on('_HasScroll', 'SCROLL_ENABLED')) defines.SCROLL = '';
    if (on('_HasRim', 'RIM_ENABLED')) defines.RIM = '';
    if (on('_HasFogMultiplier', 'FOG_MULTIPLIER_ENABLED')) defines.FOG_MULTIPLIER = '';
    const refTex = this.tex(def, '_RefCube');
    if (on('_HasReflections', 'REFLECTIONS_ENABLED') && refTex) defines.REFLECTIONS = '';
    if (defines.REFLECTIONS !== undefined && def.textures._RefCube?.cubeStrip) defines.CUBE_STRIP = '';
    if (defines.CUBE_STRIP !== undefined && f._DistortedReflect) defines.DISTORTED_REFLECT = '';
    if (f._WaterWave) Object.assign(defines, { WATER_WAVE: '', UV_WOBBLE: '' });
    // SYBO/Bend/Specials/Water (Ireland's river and sea): the texture scrolls by
    // _TextureScrollSpeed, rippled by a scrolling _DisplaceTex, always tinted by _Color
    const water = def.shader === 'SYBO/Bend/Specials/Water';
    if (water) Object.assign(defines, { SCROLL: '', WATER_DISTORT: '', TINT: '' });
    // Only the shared foam texture is a channel-packed mask; themed fountain textures are color
    if (/_Common_FountainTexture/i.test(main?.url ?? '')) defines.MASK_TEXTURE = '';
    const altTex = this.tex(def, '_AlternateTex');
    if (on('_HasAlternateColors', 'ALTERNATE_COLORS_ENABLED') && altTex) defines.ALTERNATE = '';
    const maskTex = def.shader === 'SYBO/Bend/Common/ScreenMask' || f._ScreenMask ? this.tex(def, '_MaskTex') : null;
    if (maskTex) defines.SCREEN_MASK = '';
    const wave = /(^|\/)(Legacy\/)?VertexWave|^Bend\/Wave \(Vertex Color Control\)/.test(def.shader); // 1.x flags
    if (f._HasGradient) defines.GRADIENT = '';
    if (wave) defines.WAVE = '';
    const wave2x = def.shader === 'SYBO/Bend/VertexWave';
    if (wave2x) defines.WAVE_2X = '';

    const tint = color4(c._Color);
    const mat = new THREE.ShaderMaterial({
      name,
      defines,
      clipping: true,
      vertexShader: COMBINED_VERTEX,
      fragmentShader: COMBINED_FRAGMENT,
      vertexColors: on('_HasVertexColors', 'VERTEX_COLORS_ENABLED'),
      uniforms: {
        ...globals,
        uMap: { value: this.tex(def, '_MainTex') ?? WHITE },
        uMainST: { value: new THREE.Vector4(...(main?.scale ?? [1, 1]), ...(main?.offset ?? [0, 0])) },
        uColor: { value: tint },
        uColor2: { value: color4(c._Color2) },
        uMultiplier: { value: f._Multiplier ?? 1 },
        uScroll: { value: new THREE.Vector2(...((water ? c._TextureScrollSpeed : c._ScrollSpeed) ?? [0, 0]).slice(0, 2)) },
        uDisplaceTex: { value: water ? this.tex(def, '_DisplaceTex') ?? WHITE : WHITE },
        uDisplaceScroll: { value: new THREE.Vector2(...(c._DisplaceScrollSpeed ?? [0, 0]).slice(0, 2)) },
        uDisplaceStrength: { value: f._DisplaceStrength ?? 0 },
        uRefTex: { value: refTex ?? WHITE },
        uRefColor: { value: color4(c._RefColor, [1, 1, 1, 0]) },
        uRimColor: { value: color4(c._RimColor) },
        uRimPower: { value: f._RimPower ?? 2.75 },
        uRimAmount: { value: f._RimAmount ?? 1.5 },
        uFogMultiplier: { value: f._FogMultiplier ?? 1 },
        uAltTex: { value: altTex ?? WHITE },
        uAltRef: { value: this.tex(def, '_AlternateRef') ?? refTex ?? WHITE },
        uMaskTex: { value: maskTex ?? WHITE },
        // 2.x: directions mirrored on X like the glb
        uWaveDir: { value: new THREE.Vector3(...(c._WaveDirection ?? [0, 0, 0]).slice(0, 3)).multiply(wave2x ? new THREE.Vector3(-1, 1, 1) : new THREE.Vector3(1, 1, 1)) },
        uWavePlane: { value: new THREE.Vector3(...(c._WavePlaneNormal ?? [0, 0, 0]).slice(0, 3)).multiply(wave2x ? new THREE.Vector3(-1, 1, 1) : new THREE.Vector3(1, 1, 1)) },
        uWaveExtra: { value: new THREE.Vector3(f._OffsetScale ?? 0, f._VertexColorWeight ?? 1, f._IgnoreVertexColor ? 1 : 0) },
        uWaveParams: { value: new THREE.Vector3(f._Frequency ?? 1, f._Speed ?? 1, f._WaveHeight ?? 0) },
        uWaveScales: { value: new THREE.Vector3(...(c._SpeedScales?.slice(0, 3).some((v) => v) ? c._SpeedScales.slice(0, 3) : [1, 1, 1])) },
        uWaterWave: { value: new THREE.Vector4(f._AmplitudeX ?? 0, f._AmplitudeZ ?? 0, f._FrequenceyX ?? 1, f._FrequenceyZ ?? 1) },
        uWaterSpeed: { value: new THREE.Vector2(f._SpeedX ?? 1, f._SpeedZ ?? 1) },
        uUvWobble: { value: new THREE.Vector4(f._xDistortionAplitude ?? 0, f._xDistortionFrequency ?? 0, f._yDistortionAplitude ?? 0, f._yDistortionFrequency ?? 0) },
        uUvWobbleSpeed: { value: new THREE.Vector2(f._xDistortionSpeed ?? 0, f._yDistortionSpeed ?? 0) },
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
      clipping: true,
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

  doubleAlpha(name, def) {
    const f = def.floats;
    const c = def.colors;
    const TIME = [1 / 20, 1, 2, 3];
    const speed = (k, time) => (c[k] ?? [0, 0]).slice(0, 2).map((v) => v * (TIME[f[time] ?? 0] ?? 1));
    const mat = new THREE.ShaderMaterial({
      name,
      defines: {},
      clipping: true,
      vertexShader: COMBINED_VERTEX,
      fragmentShader: DOUBLE_ALPHA_FRAGMENT,
      uniforms: {
        ...globals,
        uMainST: { value: new THREE.Vector4(1, 1, 0, 0) },
        uMap: { value: this.tex(def, '_MainTexture') ?? WHITE },
        uAlphaTex: { value: this.tex(def, '_AlphaTex') ?? WHITE },
        uStaticAlpha: { value: this.tex(def, '_StaticAlphaTex') ?? WHITE },
        uPan: { value: new THREE.Vector4(...speed('_MainTexturePannerSpeed', '_MainTexturePannerTime'), ...speed('_AlphaPannerSpeed', '_AlphaPannerTime')) },
        uMultiplier: { value: f._ColorMultiplier ?? 1 },
      },
    });
    // Alpha blended (2.x's shader has no blend properties)
    const blend = { _SrcMode: f._SrcMode ?? 5, _DstMode: f._DstMode ?? 10, _ZWrite: 0, _CullMode: f._CullMode ?? 0 };
    this.applyRenderState(mat, name, { ...def, floats: { ...f, ...blend }, renderQueue: def.renderQueue > 0 ? def.renderQueue : 3000 });
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
      clipping: true,
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
    if (transparent || /_(glass|lights?|shadow|glow)$/i.test(name)) depthBias(mat, 1);
    if (def.renderQueue > 0) mat.userData.renderQueue = def.renderQueue;
    mat.userData.unity = def;
  }

  fromFallback(name, fallback) {
    const map = fallback?.map ?? null;
    if (map) map.colorSpace = THREE.NoColorSpace;
    return new THREE.ShaderMaterial({
      name,
      defines: { FADE_MODE: 0, TINT: '' },
      clipping: true,
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
