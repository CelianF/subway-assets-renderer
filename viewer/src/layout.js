// Procedural run layout from a theme's slot table.
// Not the game's RouteGenerationSystem (its logic is stripped from the export) —
// just a plausible sequence of the same pieces on the game's grid.

const SEGMENT = 180; // 16 cells * 11.25

// Older games (2.x) list the shadowed track/ground pieces as separate prefabs in the
// slot instead of per-prefab track configs: pick them by name
const TRACK_TYPE_NAMES = {
  TrackNormal: /^(?!.*_shadow)/,
  GroundNormal: /^(?!.*_shadow)/,
  TrackShadow: /_shadow(_mid)?$/, // 1.x: track_shadow_mid
  TrackShadowStart: /_shadow_start$/,
  TrackShadowEnd: /_shadow_end$/,
  TrackShadowStartEnd: /_shadow_start_end$/,
};
const LANES = [-20, 0, 20]; // WorldConstants.CellWidth = 20

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

// BoundaryType.CellDepth per slot (cells of 11.25). The game's slot types are shared
// across versions; manifests built since the field was added carry their own copy.
const SLOT_CELLS = {
  boundary_epic_start: 32,
  boundary_epic_mid: 32,
  boundary_epic_end: 32,
  boundary_gate: 32,
  boundary_tube: 16,
  boundary_station_start: 8,
  boundary_station_mid: 16,
  boundary_station_end: 8,
  boundary_pillars_start: 8,
  boundary_pillars_mid: 16,
  boundary_pillars_end: 8,
  boundary_low_left: 16,
  boundary_low_right: 16,
  boundary_medium_left: 16,
  boundary_medium_right: 16,
  boundary_high_left: 16,
  boundary_high_right: 16,
};
const CELL = 11.25;

/**
 * Length a slot occupies along Z: its declared cell depth, else the piece's bounds
 * rounded down with slack (decoration overhangs the real end of most pieces).
 */
const OVERHANG = 30;
function slotLength(manifest, slot, prefab) {
  const cells = manifest.slotDepths?.[slot] ?? SLOT_CELLS[slot];
  if (cells) return cells * CELL;
  const maxZ = prefab?.bbox?.[1][2] ?? SEGMENT;
  return Math.max(SEGMENT / 2, Math.floor((maxZ + OVERHANG) / (SEGMENT / 2)) * (SEGMENT / 2));
}

export const TRAIN_KINDS = ['static', 'moving', 'falling'];
/** Length of a train of `cars` wagons: 70 for the first, 60 per extra wagon. */
export const trainLength = (cars) => 70 + 60 * (cars - 1);
const RAMP_LENGTH = 76; // ramp wagon in front of a train (origin 36 behind its start)

/** Generation filters ("advanced generation"); everything on by default. */
export const DEFAULT_GEN = {
  sections: { buildings: true, station: true, tube: true, pillars: true, gate: true, epic: true },
  trains: { static: true, moving: true, falling: true, ramps: true, start: true },
  obstacles: { jump: true, roll: true, standard: true, bush: true, dumpster: true, powerBox: true, pillar: true },
  signals: true,
  decorations: true,
  classicMix: true, // ≤ 1.43: scenery picked per chunk instead of the game's 3000-unit stretches
  pieces: {}, // building piece key ("low_01", "high_03"…) -> false to leave it out
  variants: {}, // landmark variant ("prefab|group|child") -> false to leave it out
  showcase: false, // debug: no randomness, every piece and landmark variant laid out once
  density: 1, // obstacles per distance (gaps shrink as it grows)
  trainShare: 0.55, // chance a spot gets a train rather than an obstacle
  mode: 'normal', // game mode whose route lays the obstacles (manifest.modes key)
  skin: null, // the mode's override set (race: subway / brawlStars); null: its first
};

// ---------------------------------------------------------------- game modes

const MODE_LABELS = { normal: 'Normal', chase: 'Chase', mysteryHurdles: 'Mystery Hurdles', race: 'Race' };
// The Brawl Stars race skin is Showdown (its start arch says so)
const SKIN_LABELS = { default: 'Default', subway: 'Subway Race', brawlStars: 'Showdown' };
const SKIN_ORDER = ['brawlStars']; // listed (and picked by default) first
// Studio names of the modes' own pieces (other slots: their name, tidied)
const MODE_PIECE_LABELS = {
  ct_moving_obstacle_standard: 'Moving barrier',
  ct_moving_obstacle_jump: 'Moving jump barrier',
  ct_moving_obstacle_roll: 'Moving roll barrier',
  ct_moving_obstacle_full: 'Moving full barrier',
  ct_moving_obstacle_train_platform: 'Moving train platform',
  ct_vanish_obstacles_standard: 'Vanishing barrier',
  ct_vanish_obstacles_jump: 'Vanishing jump barrier',
  ct_vanish_obstacles_roll: 'Vanishing roll barrier',
  ct_vanish_obstacles_full: 'Vanishing full barrier',
  ct_vanish_obstacles_train_platform: 'Vanishing train platform',
  ct_vanish_obstacles_train: 'Vanishing train (1 car)',
  ct_vanish_obstacles_train_3: 'Vanishing train (3 cars)',
  ct_vanish_obstacles_train_5: 'Vanishing train (5 cars)',
  ct_vanish_obstacles_moving_train_3: 'Vanishing moving train (3)',
  ct_vanish_obstacles_moving_train_5: 'Vanishing moving train (5)',
  hurdle_jump_easy: 'Mystery hurdle (easy)',
  hurdle_jump_medium: 'Mystery hurdle (medium)',
  hurdle_jump_hard: 'Mystery hurdle (hard)',
  hurdle_malfuntioning: 'Broken hurdle',
  speedpad_boost: 'Speed pad (boost)',
  speedpad_slow: 'Speed pad (slow)',
  race_start_line: 'Start line',
  race_finish_line: 'Finish line',
  race_start_line_backdrop: 'Start line backdrop',
};
// A vanishing piece is only its ghost effect: the game's chunks put the regular piece at the
// same spot, which it dissolves when the runner comes near. Studio items carry both.
const VANISH_BASE = {
  ct_vanish_obstacles_train: 'train_static_1',
  ct_vanish_obstacles_train_3: 'train_static_3',
  ct_vanish_obstacles_train_5: 'train_static_5',
  ct_vanish_obstacles_moving_train_3: 'train_moving_3',
  ct_vanish_obstacles_moving_train_5: 'train_moving_5',
  ct_vanish_obstacles_standard: 'obstacle_barrier_standard',
  ct_vanish_obstacles_jump: 'obstacle_barrier_jump',
  ct_vanish_obstacles_roll: 'obstacle_barrier_roll',
  ct_vanish_obstacles_full: 'obstacle_barrier_full',
  ct_vanish_obstacles_train_platform: 'obstacle_train_platform',
};
const tidy = (s) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** Game modes of this map for the mode pickers: [{ key, label, skins: [[key, label]] }], Normal first. */
export function gameModes(manifest) {
  const out = [{ key: 'normal', label: MODE_LABELS.normal, skins: [] }];
  for (const [key, mode] of Object.entries(manifest.modes ?? {})) {
    const prefabs = Object.values(mode.overrides).flatMap((slots) => Object.values(slots).flat());
    // The chase mode is dressed for the event running at the time: Halloween's is Trick or Treat
    const label = key === 'chase' && prefabs.some((n) => /_TOT_/.test(n)) ? '🎃 Trick or Treat' : MODE_LABELS[key] ?? tidy(key);
    const skins = Object.keys(mode.overrides).sort((a, b) => (SKIN_ORDER.includes(b) ? 1 : 0) - (SKIN_ORDER.includes(a) ? 1 : 0));
    out.push({ key, label, skins: skins.map((s) => [s, SKIN_LABELS[s] ?? tidy(s)]) });
  }
  return out;
}

/** The active mode's data and its override slots (skin as chosen, else the first). */
function activeMode(manifest, gen) {
  const mode = manifest.modes?.[gen?.mode];
  if (!mode) return { mode: null, overrides: {} };
  const skin = gen.skin in mode.overrides ? gen.skin : SKIN_ORDER.find((s) => s in mode.overrides) ?? Object.keys(mode.overrides)[0];
  return { mode, overrides: mode.overrides[skin] ?? {} };
}

/** Layer a chunk slot goes on: train-shaped pieces hide with the trains. */
const layerOf = (slot) =>
  slot === 'obstacle_lightSignal' ? 'signal' : /^(train_|ct_vanish_obstacles_(moving_)?train(_\d)?$)/.test(slot) ? 'train' : 'obstacle';

/**
 * Chunk names a mode's route lays, as the game's scheduler would: the intro section, then
 * (sequential) every entry in order, `repeats` times, or (weighted) picks by weight among
 * the entries whose [minZ, maxZ) window holds the distance, none again within repeatDistance.
 * `target`: distance a weighted route fills (a sequential one lays one pass).
 */
function routeChunks(mode, rng, target) {
  const { route, sections, chunks } = mode;
  const last = new Map(); // rolling sections: last pick
  const turns = new Map(); // alternating sections: next index
  const out = [];
  let z = 0;
  const push = (name) => {
    out.push(name);
    z += chunks[name].length;
  };
  const expand = (name, depth = 0) => {
    const s = sections[name];
    if (!s || depth > 12) return;
    const list = s.chunks ?? s.sections ?? [];
    if (!list.length) return;
    if (s.type === 'sequential') for (const c of list) push(c);
    else if (s.type === 'all') for (const c of [...list].sort(() => rng() - 0.5)) push(c);
    else if (s.type === 'one') push(pick(rng, list));
    else if (s.type === 'rolling') {
      // (a section can list one chunk twice: the race's Powers1)
      const others = list.filter((c) => c !== last.get(name));
      last.set(name, pick(rng, others.length ? others : list));
      push(last.get(name));
    } else if (s.type === 'alternating') {
      const i = turns.get(name) ?? 0;
      turns.set(name, i + 1);
      push(list[i % list.length]);
    } else if (s.type === 'composite') for (const sub of list) expand(sub, depth + 1);
    else if (s.type === 'compositeOne') expand(pick(rng, list), depth + 1);
  };
  if (route.intro) expand(route.intro);
  if (route.type === 'sequential') {
    // Where each entry runs (route distance), for the scenery it asks for
    out.spans = [];
    route.entries.forEach((e, index) => {
      const z0 = z;
      for (let i = 0; i < Math.max(1, e.repeats); i++) expand(e.section);
      out.spans.push({ index, section: e.section, z0, z1: z });
    });
    return out;
  }
  const used = new Map(); // section -> distance it was last laid at
  while (z < (target ?? 0)) {
    const open = route.entries.filter((e) => e.minZ <= z && (!e.maxZ || z < e.maxZ));
    const fresh = open.filter((e) => !used.has(e.section) || z - used.get(e.section) >= route.repeatDistance);
    const pool = fresh.length ? fresh : open;
    if (!pool.length) break;
    const total = pool.reduce((n, e) => n + e.weight, 0);
    let r = rng() * total;
    const entry = total > 0 ? pool.find((e) => (r -= e.weight) < 0) ?? pool[0] : pick(rng, pool);
    used.set(entry.section, z);
    const before = out.length;
    expand(entry.section);
    if (out.length === before) break;
  }
  return out;
}

// One pass of a sequential route stretches the run to fit, up to this length
const MAX_ROUTE_LENGTH = 30000;
const OBSTACLE_SLOTS = {
  jump: 'obstacle_barrier_jump',
  roll: 'obstacle_barrier_roll',
  standard: 'obstacle_barrier_standard',
  bush: 'obstacle_bush',
  dumpster: 'obstacle_dumpster',
  powerBox: 'obstacle_powerBox',
  pillar: 'obstacle_pillar',
  // Placed by the game's obstacle chunks only (no auto-run tool otherwise)
  platform: 'special_station_platform',
  full: 'obstacle_barrier_full',
  trainPlatform: 'obstacle_train_platform',
};
/** Studio obstacles the "Fix …" buttons put back from the auto run (pillars: their halls). */
/** Studio "Fix" buttons: pieces that belong to a section (pillar halls, stations). */
export const FIXABLE = ['pillar', 'platform'];
export const FIX_LABELS = { pillar: '🏛 Fix pillars', platform: '🚉 Fix platforms' };

/**
 * Where a run's pillar halls and stations want their pillars and platforms, as studio
 * items: a pillar in the middle lane every 180 (mid-segment), a platform piece every 180
 * along the station (it covers both outer tracks).
 */
export function wallItems(layout, key) {
  const out = [];
  if (key === 'pillar') {
    for (const [a, b] of layout.pillarHalls ?? []) for (let z = a + SEGMENT / 2; z < b; z += SEGMENT) out.push({ type: 'obstacle', key: 'pillar', lane: 0, z });
  } else if (key === 'platform') {
    for (const [a, b] of layout.stations ?? []) for (let z = a; z + SEGMENT <= b; z += SEGMENT) out.push({ type: 'obstacle', key: 'platform', lane: 0, z });
  }
  return out;
}

/**
 * ≤ 1.43: hand-built chunks laid end to end, as Track/TrackChunkCollection do: the chunks
 * whose [zMinimum, zMaximum) window holds the current distance and that aren't still in use,
 * picked by probability. About 720 units per section.
 */
function classicLayout(manifest, names, seed, sections, showcase = false) {
  const rng = mulberry32(seed);
  const all = names.map((name) => ({ name, ...manifest.prefabs[name]?.chunk }));
  const chunks = all.filter((c) => c.zSize > 0 && !c.intro);
  const target = Math.max(sections, 1) * 720;
  const items = [];
  // The run starts in the intro scene, laid over the first chunk
  const intro = all.find((c) => c.intro);
  if (intro) items.push({ prefab: intro.name, slot: 'classic_chunk', layer: 'environment', pos: [0, 0, 0], variantSeed: Math.floor(rng() * 2 ** 31) });
  let z = 0;
  const laid = [];
  if (showcase) {
    // Debug: every chunk once, by difficulty (as the game unlocks them)
    // (not the ones a run never picks: zMaximum below zMinimum, e.g. 1.10's jetpack landing)
    const usable = chunks.filter((c) => c.zMax == null || c.zMax > c.zMin);
    for (const chunk of usable.sort((a, b) => a.zMin - b.zMin || a.name.localeCompare(b.name))) {
      items.push({ prefab: chunk.name, slot: 'classic_chunk', layer: 'environment', pos: [0, 0, z], variantSeed: Math.floor(rng() * 2 ** 31) });
      z += chunk.zSize;
    }
    return { items, length: z };
  }
  while (z < target) {
    let pool = chunks.filter((c) => c.zMin <= z && z < (c.zMax ?? Infinity));
    if (!pool.length) pool = chunks.filter((c) => c.zMin <= z); // past every window: anything allowed so far
    if (!pool.length) break;
    // Track.cs never lays a chunk that is still in use: one laid less than 2000 units behind
    // the player, who runs 700 behind the end of the track
    const inUse = new Set(laid.filter((l) => l.end >= z - 2700).map((l) => l.name));
    if (pool.some((c) => !inUse.has(c.name))) pool = pool.filter((c) => !inUse.has(c.name));
    let r = rng() * pool.reduce((n, c) => n + c.probability, 0);
    const chunk = pool.find((c) => (r -= c.probability) < 0) ?? pool[0];
    items.push({ prefab: chunk.name, slot: 'classic_chunk', layer: 'environment', pos: [0, 0, z], variantSeed: Math.floor(rng() * 2 ** 31) });
    z += chunk.zSize;
    laid.push({ name: chunk.name, end: z });
  }
  return { items, length: z };
}

/** Wagon count for a span: the longest available train that fits, else the shortest. */
export function fitTrain(options, span) {
  if (!options.length) return 0;
  const fitting = options.filter((n) => trainLength(n) <= span + 6);
  return fitting.length ? fitting[fitting.length - 1] : options[0];
}
export { RAMP_LENGTH };

/** Building piece key shared by a left/right pair: "London_low_01_left" -> "low_01". */
export const buildingPieceKey = (name) => name.match(/(?:^|_)((?:low|med|medium|high)_\d+)_(?:left|right)$/i)?.[1]?.toLowerCase() ?? null;
/** Name to apply name rules to: 1.x pieces carry their generic role ("high_01_left_hawaiihd_2017" -> "high_01_left"). */
const roleOf = (manifest, name) => manifest.prefabs[name]?.role ?? name;

/**
 * Showcase: one forced pick per variant of a prefab's random groups ([null] without any),
 * so "show everything" lays every variant of every piece.
 */
export function prefabVariants(manifest, prefab) {
  const groups = Object.entries(manifest.prefabs[prefab]?.randomizers ?? {})
    .map(([g, e]) => [g, Object.keys((e && typeof e === 'object' && e.weights) || {})])
    .filter(([, kids]) => kids.length > 1);
  if (!groups.length) return [null];
  const n = Math.max(...groups.map(([, kids]) => kids.length));
  return Array.from({ length: n }, (_, i) => Object.fromEntries(groups.map(([g, kids]) => [g, kids[i % kids.length]])));
}

/**
 * Landmark variants a theme's game randomizer picks between (Underwater's kraken: static,
 * active, animated), for the generation picker: [{ key: "prefab|group|child", label }].
 */
export function landmarkVariants(manifest, themeName) {
  const slots = Object.assign({}, ...Object.values(manifest.themes[themeName]));
  const out = [];
  for (const slot of ['boundary_epic_start', 'boundary_epic_mid', 'boundary_epic_end']) {
    for (const prefab of slots[slot] ?? []) {
      for (const [group, entry] of Object.entries(manifest.prefabs[prefab]?.randomizers ?? {})) {
        for (const child of Object.keys(entry?.weights ?? {})) {
          const nice = (t) => t.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
          out.push({ key: `${prefab}|${group}|${child}`, label: `${nice(group)}: ${nice(child).toLowerCase()}`, prefab });
        }
      }
    }
  }
  return out;
}

/** Building pieces of a theme, grouped by height, for the "map sections" picker. */
export function buildingPieces(manifest, themeName) {
  const slots = Object.assign({}, ...Object.values(manifest.themes[themeName]));
  const out = {};
  for (const height of ['low', 'medium', 'high']) {
    for (const side of ['left', 'right']) {
      for (const name of slots[`boundary_${height}_${side}`] ?? []) {
        const key = buildingPieceKey(roleOf(manifest, name));
        if (!key) continue;
        (out[key] ??= { key, height, prefabs: [] }).prefabs.push(name);
      }
    }
  }
  return Object.values(out);
}

const hashString = (str) => [...str].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7) >>> 0;

/** Slots of a theme (optionally with another theme's trains), with the game mode's own pieces. */
function themeSlots(manifest, themeName, trainTheme, gen = null) {
  const slots = Object.assign({}, ...Object.values(manifest.themes[themeName]));
  if (trainTheme && trainTheme !== themeName && manifest.themes[trainTheme]) {
    Object.assign(slots, manifest.themes[trainTheme].train);
  }
  return Object.assign(slots, activeMode(manifest, gen).overrides);
}

// Train skins share a slot: <Theme>_Train_Static_3_Cargo / _Standard / _Subway
export const TRAIN_VARIANTS = { cargo: /_Cargo$/i, passenger: /_Standard$/i, subway: /_Subway$/i };

// Studio "Walls": pieces across the track (station platforms cover both outer tracks)
const STUDIO_WALLS = { pillar: true, platform: true };

/**
 * Footprint of each studio piece around its spot, from its model's bounds (glb space):
 * { x0, x1, z0, z1, wide } (wide: spans the tracks, so it sits on the middle one).
 * A vanishing piece shows the size of the piece under it.
 */
function pieceSizes(manifest, slots, keys) {
  const out = {};
  for (const key of keys) {
    const slot = OBSTACLE_SLOTS[key] ?? key;
    const bb = (slots[VANISH_BASE[slot] ?? slot] ?? []).map((n) => manifest.prefabs[n]?.bbox).find(Boolean);
    if (!bb) continue;
    const [[x0, , z0], [x1, , z1]] = bb;
    // (ghost trails and glows can reach far: a piece is never longer than a 5-car train)
    out[key] = { x0, x1, z0: Math.max(z0, -40), z1: Math.min(z1, 400), wide: x1 - x0 > 45 };
  }
  return out;
}

/** What the studio can place for this theme: obstacle tools and train kinds with their wagon counts. */
export function studioCatalog(manifest, themeName, trainTheme = null, gen = null) {
  const slots = themeSlots(manifest, themeName, trainTheme, gen);
  // The mode's own pieces (one tool per distinct piece: hurdle slots share their models)
  const modeLabel = gameModes(manifest).find((m) => m.key === gen?.mode && m.key !== 'normal')?.label ?? null;
  const modePieces = {};
  const seenPieces = new Set();
  for (const [slot, prefabs] of Object.entries(activeMode(manifest, gen).overrides)) {
    const key = prefabs.join('|');
    if (Object.values(OBSTACLE_SLOTS).includes(slot) || seenPieces.has(key) || !prefabs.some((n) => manifest.prefabs[n]?.bbox)) continue;
    seenPieces.add(key);
    modePieces[slot] = MODE_PIECE_LABELS[slot] ?? tidy(slot);
  }
  const has = (slot) => slots[slot]?.some((n) => manifest.prefabs[n]?.bbox);
  const trains = {};
  for (const kind of TRAIN_KINDS) {
    const cars = [1, 2, 3, 5].filter((n) => has(`train_${kind}_${n}`));
    if (cars.length) trains[kind] = cars;
  }
  const variantsOf = (kind) =>
    Object.keys(TRAIN_VARIANTS).filter((v) => [1, 2, 3, 5].some((n) => slots[`train_${kind}_${n}`]?.some((name) => TRAIN_VARIANTS[v].test(name))));
  return {
    trains,
    variants: Object.fromEntries(Object.keys(trains).map((k) => [k, variantsOf(k)])),
    ramp: has('train_ramp'),
    startTrain: has('prop_train_start'),
    obstacles: Object.fromEntries(Object.entries(OBSTACLE_SLOTS).filter(([k, slot]) => !(k in STUDIO_WALLS) && k !== 'trainPlatform' && has(slot))),
    // Pieces that span the track: pillars, station platforms
    walls: Object.fromEntries(Object.entries(OBSTACLE_SLOTS).filter(([k, slot]) => k in STUDIO_WALLS && has(slot))),
    // Train platforms (the mode's moving / vanishing ones too) go with the trains
    trainPieces: [...(has(OBSTACLE_SLOTS.trainPlatform) ? ['trainPlatform'] : []), ...Object.keys(modePieces).filter((k) => /train_platform$/.test(k))],
    sizes: pieceSizes(manifest, slots, [...Object.keys(OBSTACLE_SLOTS), ...Object.keys(modePieces)]),
    signal: has('obstacle_lightSignal'),
    pillars: has('boundary_pillars_mid') && has('obstacle_pillar'),
    // Classic maps model their rails into the chunks: no track to take out
    tracks: !slots.classic_chunk?.length,
    modeLabel,
    modePieces,
    modes: gameModes(manifest),
  };
}

/**
 * @param studio  list of hand-placed items for obstacleMode 'studio':
 *   { type: 'train', lane, z0, z1, kind, variant, ramp } | { type: 'obstacle', key, lane, z }
 *   | { type: 'signal', x, z, color } | { type: 'noTracks', lane, z0, z1 }   (lane = track x: 20 | 0 | -20)
 * @returns {{items: Array<{prefab, slot, layer, pos:[x,y,z], trackType?}>, length: number}}
 */
export function generateLayout(
  manifest,
  themeName,
  { seed = 1, sections = 12, trainTheme = null, obstacleMode = 'random', gen = DEFAULT_GEN, studio = [] } = {},
) {
  gen = { ...DEFAULT_GEN, ...gen };
  // Trains (and ramps) can come from another theme; a game mode brings its own pieces
  const slots = themeSlots(manifest, themeName, trainTheme, gen);
  const { mode, overrides: modeSlots } = activeMode(manifest, gen);
  // A game mode's run: its scenery (in the studio too, so both views match), and its
  // route lays the obstacles unless the studio places them
  const modeRun = !!mode && !slots.classic_chunk?.length;
  const routed = modeRun && obstacleMode !== 'studio';
  const has = (slot) => slots[slot]?.length > 0;
  const rng = mulberry32(seed);
  const items = [];
  const noTrackRanges = []; // [z0, z1) where the regular rails are replaced
  const platformRanges = []; // [z0, z1) where platforms cover the two outer tracks
  const pillarRanges = []; // [z0, z1) where pillars stand in the middle lane
  const pillarHalls = []; // [z0, z1) of every pillar hall / station ("Fix" buttons)
  const stations = [];
  // In the studio, platforms are items: the outer tracks they cover come from the list
  if (obstacleMode === 'studio') for (const it of studio) if (it.type === 'obstacle' && it.key === 'platform') platformRanges.push([it.z, it.z + SEGMENT]);
  const laneBlocks = []; // { x, z0, z1 }: single-lane stretches already taken (start train)
  let z = 0;

  let placeRng = rng; // studio items use their own stable generator
  // Showcase (debug): each slot's prefabs in turn instead of at random
  const turns = new Map();
  const choose = (key, list) => {
    if (!gen.showcase) return pick(placeRng, list);
    const n = turns.get(key) ?? 0;
    turns.set(key, n + 1);
    return list[n % list.length];
  };
  // Showcase: each prefab once per variant of its random groups
  const showcaseList = (list) => list.flatMap((prefab) => prefabVariants(manifest, prefab).map((variants) => ({ prefab, variants })));
  const showcaseCount = (slot) => showcaseList(slots[slot] ?? []).length;
  const count = (slot, lo, hi) => (gen.showcase ? Math.max(showcaseCount(slot), 1) : randInt(rng, lo, hi));
  const place = (slot, pos, layer = 'environment', extra = {}, nameFilter = null) => {
    if (!has(slot)) return null;
    const named = nameFilter ? slots[slot].filter((n) => nameFilter.test(roleOf(manifest, n))) : [];
    const list = named.length ? named : slots[slot];
    const key = `${slot}|${nameFilter ?? ''}`;
    const { prefab, variants } = gen.showcase ? choose(key, showcaseList(list)) : { prefab: choose(key, list), variants: null };
    // Per-instance seed for the prefab's random variant groups ("mode": a game mode's own piece)
    const own = slot in modeSlots ? { mode: true } : {};
    items.push({ prefab, slot, layer, pos, variantSeed: Math.floor(placeRng() * 2 ** 31), ...(variants ? { variants } : {}), ...own, ...extra });
    return prefab;
  };
  // ≤ 1.43: the game's hand-built chunks; in the studio, hand-placed trains and obstacles
  // on top (the chunks leave theirs out)
  if (slots.classic_chunk?.length) {
    const classic = classicLayout(manifest, slots.classic_chunk, seed, sections, gen.showcase);
    if (obstacleMode !== 'studio') return classic;
    items.push(...classic.items);
    placeStudio();
    return { items, length: classic.length };
  }

  // Boundary runs per side of the track, for the theme's transition pieces
  const runs = { left: [], right: [] };
  const addRun = (side, slot, z0, z1) => runs[side].push({ slot, z0, z1 });
  const placeRun = (slot) => {
    const prefab = place(slot, [0, 0, z]);
    if (!prefab) return;
    const z0 = z;
    z += slotLength(manifest, slot, manifest.prefabs[prefab]);
    addRun('left', slot, z0, z);
    addRun('right', slot, z0, z);
  };

  const sectionTypes = [
    { name: 'buildings', weight: 5, ok: () => true, build: buildings },
    { name: 'station', weight: 1, ok: () => has('boundary_station_mid'), build: station },
    { name: 'tube', weight: 1, ok: () => has('boundary_tube'), build: tube },
    { name: 'pillars', weight: 1, ok: () => has('boundary_pillars_mid'), build: pillars },
    { name: 'gate', weight: 0.5, ok: () => has('boundary_gate') && has('track_gates'), build: gate },
    { name: 'epic', weight: 0.4, ok: () => has('boundary_epic_start'), build: epic },
    // Game modes run between buildings: their sections ask for building boundaries
  ].filter((s) => s.ok() && gen.sections[s.name] !== false && (!modeRun || s.name === 'buildings'));
  // Nothing enabled (or available): plain buildings
  if (!sectionTypes.length) sectionTypes.push({ name: 'buildings', weight: 1, build: buildings });
  const buildingsType = sectionTypes.find((t) => t.name === 'buildings');

  function buildings(count = null) {
    if (gen.showcase) return showcaseBuildings();
    const n = count ?? randInt(rng, 2, 5);
    // Heights that still have an allowed piece on both sides ("map sections" picker)
    const allowed = (slot) => (slots[slot] ?? []).filter((nm) => gen.pieces[buildingPieceKey(roleOf(manifest, nm))] !== false);
    let heights = ['low', 'medium', 'high'].filter((h) => allowed(`boundary_${h}_left`).length && allowed(`boundary_${h}_right`).length);
    const usePieces = heights.length > 0;
    if (!usePieces) heights = ['low', 'medium', 'high'];
    for (let i = 0; i < n; i++) {
      const height = pick(rng, heights);
      // Ad slots replace a right-hand building now and then (in exports without an
      // active campaign they point at regular buildings)
      const sponsored = ['boundary_sponsored_right_front', 'boundary_sponsored_right_back'].filter(has);
      const right = sponsored.length && rng() < 0.15 ? pick(rng, sponsored) : `boundary_${height}_right`;
      placeAllowed(`boundary_${height}_left`, usePieces);
      if (right.startsWith('boundary_sponsored')) place(right, [0, 0, z]);
      else placeAllowed(right, usePieces);
      addRun('left', `boundary_${height}_left`, z, z + SEGMENT);
      addRun('right', right, z, z + SEGMENT);
      decorate(z);
      z += SEGMENT;
    }
  }
  /** Showcase: every building piece of each height, both sides, then the ad slots. */
  function showcaseBuildings() {
    for (const height of ['low', 'medium', 'high']) {
      const n = Math.max(showcaseCount(`boundary_${height}_left`), showcaseCount(`boundary_${height}_right`));
      for (let i = 0; i < n; i++) {
        place(`boundary_${height}_left`, [0, 0, z]);
        place(`boundary_${height}_right`, [0, 0, z]);
        addRun('left', `boundary_${height}_left`, z, z + SEGMENT);
        addRun('right', `boundary_${height}_right`, z, z + SEGMENT);
        decorate(z);
        z += SEGMENT;
      }
    }
    for (const ad of ['boundary_sponsored_right_front', 'boundary_sponsored_right_back'].filter(has)) {
      for (let i = 0; i < showcaseCount(ad); i++) {
        place('boundary_low_left', [0, 0, z]);
        place(ad, [0, 0, z]);
        addRun('left', 'boundary_low_left', z, z + SEGMENT);
        addRun('right', ad, z, z + SEGMENT);
        z += SEGMENT;
      }
    }
  }
  /** Places a building slot using only the pieces left on in the picker. */
  function placeAllowed(slot, restrict) {
    if (!restrict) return place(slot, [0, 0, z]);
    const names = slots[slot].filter((nm) => gen.pieces[buildingPieceKey(roleOf(manifest, nm))] !== false);
    const prefab = choose(slot, names);
    items.push({ prefab, slot, layer: 'environment', pos: [0, 0, z], variantSeed: Math.floor(placeRng() * 2 ** 31) });
    return prefab;
  }

  function station() {
    const start = z;
    placeRun('boundary_station_start');
    for (let i = count('boundary_station_mid', 1, 3); i > 0; i--) placeRun('boundary_station_mid');
    placeRun('boundary_station_end');
    // Raised platforms along both outer tracks, the length of the station (90 + n·180 + 90
    // tiles exactly with the 180-long platform piece)
    // (in the studio they are items, wiped and put back like the rest)
    if (has('special_station_platform')) stations.push([start, z]);
    if (obstacleMode === 'studio') return;
    for (let pz = start; pz + SEGMENT <= z; pz += SEGMENT) place('special_station_platform', [0, 0, pz]);
    if (has('special_station_platform')) platformRanges.push([start, z]);
  }
  function tube() {
    const start = z;
    for (let i = gen.showcase ? Math.max(showcaseCount('boundary_tube'), 2) : randInt(rng, 2, 4); i > 0; i--) placeRun('boundary_tube');
    // Old games list the tube entrance/exit as event decorations instead of transitions
    const transitions = manifest.boundaries?.[themeName]?.transitions ?? [];
    if (!transitions.some((t) => t.slot === 'boundary_tube')) {
      for (const slot of eventSlots) {
        const name = slots[slot][0];
        if (/tube_start/i.test(name)) items.push({ prefab: name, slot, layer: 'environment', pos: [0, 0, start], variantSeed: 1 });
        if (/tube_end/i.test(name)) items.push({ prefab: name, slot, layer: 'environment', pos: [0, 0, z], variantSeed: 1 });
      }
    }
  }

  // Event / extra decorations (decoration_event_*, decoration_extra_*): the game places
  // them from stripped code, so they are scattered plausibly by footprint here.
  const eventSlots = Object.keys(slots).filter((s) => /^decoration_(event|extra)_/.test(s) && has(s));
  // Decorations also modeled inside boundary pieces (manifest "embedded": Edinburgh's
  // barrels, Buenos Aires' event streets) are already placed by those pieces; scattered,
  // they float or sit on top of the buildings. Older manifests lack the flag: there,
  // segment-long side blocks are caught by size.
  const isSideBlock = (s) => {
    const bb = manifest.prefabs[slots[s][0]]?.bbox;
    const fullWidth = bb && bb[0][0] < -60 && bb[1][0] > 60;
    return !!bb && !fullWidth && bb[1][2] - bb[0][2] >= SEGMENT - 10;
  };
  const embedded = (s) => slots[s].every((n) => manifest.prefabs[n]?.embedded);
  // Picked among all of them so the free ones keep their odds; embedded picks place nothing
  const decoSlots = eventSlots.filter((s) => !/tube_(start|end)/i.test(slots[s][0]));
  function decorate(segZ) {
    if (!gen.decorations || !decoSlots.length || rng() > 0.35) return;
    const slot = pick(rng, decoSlots);
    if (embedded(slot) || isSideBlock(slot)) return;
    const prefab = manifest.prefabs[pick(rng, slots[slot])];
    const bb = prefab?.bbox;
    if (!bb) return;
    const name = slots[slot][0];
    const fullWidth = bb[0][0] < -60 && bb[1][0] > 60; // frames the tracks (terracotta army)
    // Modeled in place beside the tracks (the whole model on one side of its origin, like
    // Venice's wall panels): placed where it was modeled, not shifted again
    const inPlace = bb[0][0] > 0 || bb[1][0] < 0;
    // Never on the tracks: the game puts such pieces only where the outer tracks are covered
    // (rules the export doesn't keep), so a low piece reaching into |x| < 30 is left out
    if (inPlace && !fullWidth && bb[0][1] < 15 && bb[0][0] < 30 && bb[1][0] > -30) return;
    // Wide pieces span the tracks only if they leave the corridor open (arches, bunting)
    if (fullWidth && prefab.blocksTracks) return;
    if (fullWidth || inPlace) {
      place(slot, [0, 0, segZ], 'environment');
      return;
    }
    const side = rng() < 0.5 ? 1 : -1;
    const halfWidth = (bb[1][0] - bb[0][0]) / 2;
    const x = side * (36 + halfWidth); // on the street beside the tracks
    const floating = bb[0][1] < -4 && bb[1][1] - bb[0][1] < 40; // creatures modeled around their center
    const y = floating ? 30 + rng() * 25 : 0;
    place(slot, [x, y, segZ + 30 + rng() * 120], 'environment');
  }
  function pillars() {
    const start = z;
    placeRun('boundary_pillars_start');
    for (let i = count('boundary_pillars_mid', 1, 3); i > 0; i--) placeRun('boundary_pillars_mid');
    placeRun('boundary_pillars_end');
    // Like the game's Pillars chunk: a pillar in the middle lane every 180, mid-segment.
    // They come and go with the obstacles; in the studio they are items like the others
    // ("Fix pillars" puts back any that are missing)
    if (has('obstacle_pillar')) pillarHalls.push([start, z]);
    if (has('obstacle_pillar') && gen.obstacles.pillar && obstacleMode !== 'studio') {
      for (let pz = start + SEGMENT / 2; pz < z; pz += SEGMENT) place('obstacle_pillar', [0, 0, pz], 'obstacle');
      pillarRanges.push([start, z]);
    }
  }
  function gate() {
    const start = z;
    place('track_gates', [0, 0, z]);
    // The wall across the lanes, open on one lane (left/mid/right) or both sides
    const walls = ['special_gate_left', 'special_gate_mid', 'special_gate_right', 'special_gate_sides'].filter(has);
    if (walls.length) place(choose('gate_walls', walls), [0, 0, z], 'wall');
    placeRun('boundary_gate');
    z = Math.max(z, start + slotLength(manifest, 'track_gates', manifest.prefabs[slots.track_gates[0]]));
    noTrackRanges.push([start, z]);
  }
  // Landmark (Tower Bridge, …): start/mid/end are 360 each. Some themes model the
  // whole landmark in epic_start and keep mid/end as empty placeholders, which still
  // reserve their length.
  // When epic_start already spans the three slots, mid/end only keep their length: 3.62
  // Aloha Hawaii's still hold the template's blockout ("EPIC" letters in the canyon)
  function epic(variants = null) {
    let whole = false;
    for (const slot of ['boundary_epic_start', 'boundary_epic_mid', 'boundary_epic_end']) {
      const before = items.length;
      const z0 = z;
      placeRun(slot);
      if (slot === 'boundary_epic_start' && items.length > before) {
        // Showcase: the landmark's random groups set to one variant each time
        if (variants) items[before].variants = variants;
        whole = (manifest.prefabs[items[before].prefab]?.bbox?.[1][2] ?? 0) > 2.5 * (z - z0);
      } else if (whole) items.splice(before);
    }
  }

  // Showcase (debug): every section type in turn, the gate once per wall and the landmark
  // once per variant, buildings in between, so every piece loads
  if (gen.showcase) {
    const type = (name) => sectionTypes.find((t) => t.name === name);
    const steps = [];
    for (const name of ['buildings', 'station', 'tube', 'pillars']) if (type(name)) steps.push(() => type(name).build());
    if (type('gate')) {
      const walls = ['special_gate_left', 'special_gate_mid', 'special_gate_right', 'special_gate_sides'].filter(has).length;
      for (let i = 0; i < Math.max(walls, 1); i++) steps.push(gate);
    }
    if (type('epic')) {
      const groups = {};
      for (const v of landmarkVariants(manifest, themeName)) {
        const [, group, child] = v.key.split('|');
        (groups[group] ??= []).push(child);
      }
      const n = Math.max(1, ...Object.values(groups).map((c) => c.length));
      for (let i = 0; i < n; i++) steps.push(() => epic(Object.keys(groups).length ? Object.fromEntries(Object.entries(groups).map(([g, c]) => [g, c[i % c.length]])) : null));
    }
    for (const [i, step] of steps.entries()) {
      if (i > 0 && buildingsType) buildingsLink();
      step();
    }
  }
  // A short building stretch between showcase sections
  function buildingsLink() {
    for (let i = 0; i < 2; i++) {
      place('boundary_low_left', [0, 0, z]);
      place('boundary_low_right', [0, 0, z]);
      addRun('left', 'boundary_low_left', z, z + SEGMENT);
      addRun('right', 'boundary_low_right', z, z + SEGMENT);
      z += SEGMENT;
    }
  }

  // Random sections, but every run of 4+ sections shows the theme's landmark and a gate
  const total = sectionTypes.reduce((s, t) => s + t.weight, 0);
  const plan = Array.from({ length: sections }, () => {
    let r = rng() * total;
    return sectionTypes.find((t) => (r -= t.weight) < 0) ?? sectionTypes[0];
  });
  if (buildingsType) plan[0] = buildingsType; // open with plain buildings so the camera starts somewhere readable
  const force = (name, at) => {
    const type = sectionTypes.find((t) => t.name === name);
    if (type && sections >= 4 && !plan.includes(type)) plan[at] = type;
  };
  force('epic', Math.floor(sections / 2));
  force('gate', Math.max(1, Math.floor(sections / 4)));
  // Covered/special sections never touch: the game always puts open-air buildings between
  // them (unless buildings are switched off, then the chosen sections chain directly)
  const finalPlan = [];
  for (const section of plan) {
    const prev = finalPlan[finalPlan.length - 1];
    if (buildingsType && prev && prev !== buildingsType && section !== buildingsType) finalPlan.push(buildingsType);
    finalPlan.push(section);
  }
  const routeRng = mulberry32(seed ^ 0x5bd1e995);
  const pass = modeRun && mode.route.type === 'sequential' ? routeChunks(mode, routeRng, null) : null;
  // Race arenas (Subway PvP) fill the race's start and finish stretches with one big piece
  // each (boundary_super_epic_*, 2880 long): the route's first and last stretches ask for them
  const arenaSpans = pass && buildingsType ? superEpicSpans(pass.spans) : [];
  let routeStart = SEGMENT;
  if (arenaSpans.length) {
    // Shift the route so those stretches start on a building segment
    routeStart += (SEGMENT - ((SEGMENT + arenaSpans[0].z0) % SEGMENT)) % SEGMENT;
    for (const span of arenaSpans) {
      fillBuildings(routeStart + span.z0);
      const at = z;
      place(`boundary_super_epic_${span.kind}_left`, [0, 0, at]);
      place(`boundary_super_epic_${span.kind}_right`, [0, 0, at]);
      z += slotLength(manifest, `boundary_super_epic_${span.kind}_right`, null);
      addRun('left', `boundary_super_epic_${span.kind}_left`, at, z);
      addRun('right', `boundary_super_epic_${span.kind}_right`, at, z);
    }
  } else if (!gen.showcase) for (const section of finalPlan) section.build();
  // A sequential route (race, mystery hurdles) runs from its start to its end: more
  // buildings until it fits
  if (pass && buildingsType) {
    const passLength = pass.reduce((n, c) => n + mode.chunks[c].length, 0);
    fillBuildings(routeStart + Math.min(passLength, MAX_ROUTE_LENGTH) + SEGMENT);
  }
  const length = z;

  /** Buildings up to `until` (whole segments): runs of 2 to 5, as the buildings section. */
  function fillBuildings(until) {
    while (until - z >= SEGMENT) buildings(Math.min(randInt(rng, 2, 5), Math.floor((until - z) / SEGMENT)));
  }

  /**
   * Route stretches that ask for the super epic pieces: from the sections' constraints, or
   * (maps built before they were kept) the race's first and last stretches.
   */
  function superEpicSpans(spans) {
    if (!['start', 'end'].every((k) => has(`boundary_super_epic_${k}_right`) || has(`boundary_super_epic_${k}_left`))) return [];
    const out = [];
    for (const span of spans ?? []) {
      const constraints = mode.sections[span.section]?.constraints;
      const kind = constraints
        ? ['start', 'end'].find((k) => constraints.length && constraints.every((c) => c.includes(`super_epic_${k}`)))
        : gen.mode === 'race' && (span.index === 0 ? 'start' : span.index === spans.length - 1 ? 'end' : null);
      if (kind) out.push({ ...span, kind });
    }
    return out;
  }
  placeTransitions();

  // <Theme>_Boundaries TransitionInfo: pieces at the start/end of a run of one boundary
  // type (tube entrance/exit, building run caps), skipped next to an exception type
  function placeTransitions() {
    const transitions = manifest.boundaries?.[themeName]?.transitions ?? [];
    const done = new Set();
    for (const list of Object.values(runs)) {
      const merged = [];
      for (const r of list) {
        const last = merged[merged.length - 1];
        if (last && last.slot === r.slot && last.z1 === r.z0) last.z1 = r.z1;
        else merged.push({ ...r });
      }
      merged.forEach((run, i) => {
        for (const t of transitions) {
          if (t.slot !== run.slot) continue;
          const neighbor = merged[t.at === 'start' ? i - 1 : i + 1]?.slot;
          if (neighbor && t.exceptions.includes(neighbor)) continue;
          const tz = t.at === 'start' ? run.z0 : run.z1;
          const key = `${t.prefab}@${tz}`;
          if (done.has(key) || rng() >= t.probability) continue;
          done.add(key);
          items.push({ prefab: t.prefab, slot: `transition_${t.at}`, layer: 'environment', pos: [0, 0, tz], variantSeed: Math.floor(rng() * 2 ** 31) });
        }
      });
    }
  }

  // Rails: one piece per lane per segment, skipping gate stretches and boundaries whose
  // TrackInfos say SpawnTracks: false (landmarks that model their own floor and rails).
  // Under boundaries that say ShowShadows (stations, tubes, pillars) the shadowed variants
  // are used, with start/end pieces where the shadowed stretch begins and ends.
  const trackInfos = manifest.boundaries?.[themeName]?.trackInfos ?? {};
  const infoAt = (tz) => {
    const run = runs.left.find((r) => tz >= r.z0 && tz < r.z1);
    return run ? trackInfos[run.slot] : undefined;
  };
  const shadowedAt = (tz) => !!infoAt(tz)?.ShowShadows;
  for (let tz = 0; tz < length; tz += SEGMENT) {
    if (noTrackRanges.some(([a, b]) => tz >= a && tz < b)) continue;
    if (infoAt(tz)?.SpawnTracks === false) continue;
    let trackType = 'TrackNormal';
    if (shadowedAt(tz)) {
      const starts = !shadowedAt(tz - SEGMENT);
      const ends = !shadowedAt(tz + SEGMENT);
      trackType = starts && ends ? 'TrackShadowStartEnd' : starts ? 'TrackShadowStart' : ends ? 'TrackShadowEnd' : 'TrackShadow';
    }
    for (const x of LANES) {
      // Under station platforms the outer tracks are covered: plain ground, no rails
      const covered = x !== 0 && platformRanges.some(([a, b]) => tz >= a && tz < b) && has('track_ground');
      if (covered) place('track_ground', [x, 0, tz], 'track', { trackType: 'GroundNormal' }, TRACK_TYPE_NAMES.GroundNormal);
      else placeTrack(x, tz, trackType);
    }
  }

  /**
   * One 180-long rail piece. Studio "no tracks" zones are cut out by the track shader
   * (exact to the pixel, nothing squeezed); a plain-ground piece fills them, drawn only
   * inside the zone.
   */
  function placeTrack(x, tz, trackType) {
    place('track_track', [x, 0, tz], 'track', { trackType }, TRACK_TYPE_NAMES[trackType]);
    const cut = obstacleMode === 'studio' && studio.some((it) => it.type === 'noTracks' && it.lane === x && it.z0 < tz + SEGMENT && it.z1 > tz);
    if (cut && has('track_ground')) place('track_ground', [x, 0, tz], 'track', { trackType: 'GroundNormal', cut: 'inside' }, TRACK_TYPE_NAMES.GroundNormal);
  }

  // Older game versions ship no chase chunks: fall back to random obstacles
  if (obstacleMode === 'studio') placeStudio();
  else if (routed) placeRoute();
  else if (obstacleMode === 'chunks' && Object.keys(manifest.chunks ?? {}).length) placeChunks();
  else placeObstacles();

  function placeStudio() {
    for (const it of studio) {
      placeRng = mulberry32(hashString(JSON.stringify(it)) ^ seed);
      if (it.type === 'train') {
        const cars = studioCars(it);
        if (!cars) continue;
        const group = `studio${it.lane}@${it.z0}`;
        let tz = it.z0;
        if (it.ramp && has('train_ramp')) {
          place('train_ramp', [it.lane, 0, tz + 36], 'train', { group });
          tz += RAMP_LENGTH;
        }
        place(`train_${it.kind}_${cars}`, [it.lane, 0, tz], 'train', { group }, TRAIN_VARIANTS[it.variant] ?? null);
      } else if (it.type === 'startTrain') {
        place('prop_train_start', [it.lane, 0, it.z], 'train', { group: `start@${it.z}` });
      } else if (it.type === 'signal') {
        place('obstacle_lightSignal', [it.x, 0, it.z], 'signal', { signalSeed: Math.floor(placeRng() * 2 ** 31), signalColor: it.color });
      } else if (it.type === 'obstacle') {
        // Regular obstacles by tool key, a game mode's pieces by slot
        const slot = OBSTACLE_SLOTS[it.key] ?? it.key;
        const layer = layerOf(slot);
        const extra = { ...(it.scale ? { scale: it.scale } : {}), ...(layer === 'train' ? { group: `studio${it.lane}@${it.z}` } : {}) };
        const base = VANISH_BASE[slot];
        if (it.key === 'powerBox') powerBoxCluster(it.lane, it.z);
        // Height and scale kept from the game's chunks (a barrier on a train roof, small bushes)
        else place(slot, [it.lane, it.y ?? 0, it.z], layer, extra);
        if (base) place(base, [it.lane, it.y ?? 0, it.z], layerOf(base), { ...extra, ...(layerOf(base) === 'train' ? { group: `studio${it.lane}@${it.z}` } : {}) });
      }
    }
    placeRng = rng;
  }

  function studioCars(it) {
    return fitTrain([1, 2, 3, 5].filter((n) => has(`train_${it.kind}_${n}`)), it.z1 - it.z0 - (it.ramp && has('train_ramp') ? RAMP_LENGTH : 0));
  }

  // The game's chase chunks (ChunkAssetPlacer layouts) laid back to back. Their random
  // groups keep one option and MirrorRandomizer flips subtrees left/right.
  function placeChunks() {
    const names = Object.keys(manifest.chunks);
    const seen = new Set();
    let cz = SEGMENT;
    while (cz < length - SEGMENT) {
      const chunk = manifest.chunks[pick(rng, names)];
      if (noTrackRanges.some(([a, b]) => cz < b && cz + chunk.length > a - 30)) {
        cz += 90;
        continue;
      }
      placeChunk(chunk, cz, seen);
      cz += chunk.length;
    }
  }

  // A game mode's route: its scheduler's chunks back to back from the start of the run.
  // Weighted routes (chase) fill the run; sequential ones lay one pass, start to finish
  // (the race would loop into a second start line after its finish)
  function placeRoute() {
    const names = pass ?? routeChunks(mode, routeRng, length - 2 * SEGMENT);
    const seen = new Set();
    let cz = routeStart;
    for (const name of names) {
      const chunk = mode.chunks[name];
      if (cz + chunk.length > length - SEGMENT / 2) break;
      placeChunk(chunk, cz, seen);
      cz += chunk.length;
    }
  }

  /** One chunk's placements at cz: one option per random group, mirrored subtrees flipped. */
  function placeChunk(chunk, cz, seen) {
    const choice = new Map(); // group -> chosen option (or null)
    const mirrored = new Map(); // mirror node -> flip?
    for (const pl of chunk.placements) {
      if (pl.group && !choice.has(pl.group)) {
        const options = [...new Set(chunk.placements.filter((q) => q.group === pl.group).map((q) => q.option))];
        choice.set(pl.group, rng() < pl.groupProbability ? pick(rng, options) : null);
      }
      if (pl.mirror && !mirrored.has(pl.mirror)) mirrored.set(pl.mirror, rng() < pl.mirrorProbability);
    }
    for (const pl of chunk.placements) {
      if (pl.group && choice.get(pl.group) !== pl.option) continue;
      if (pl.slot.startsWith('special_gate')) continue; // gate walls need a gate section around them
      let [x, y, pz] = pl.pos;
      // (never pushed off the tracks: the race's Ramps1 has a ramp under a mirror node one
      // lane over; pieces modeled beside the tracks, like bushes, still swap sides)
      if (pl.mirror && mirrored.get(pl.mirror) && Math.abs(2 * pl.mirrorX - x) <= Math.max(20.5, Math.abs(x))) x = 2 * pl.mirrorX - x;
      const key = `${pl.slot}@${x},${pz + cz}`;
      if (seen.has(key)) continue; // a chase entity and its themed child share a spot
      seen.add(key);
      const layer = layerOf(pl.slot);
      // Trains in one lane of a chunk hide together in the cutaway
      const extra = layer === 'train' ? { group: `chunk${cz}x${x}` } : layer === 'signal' ? { signalSeed: Math.floor(rng() * 2 ** 31) } : {};
      if (pl.scale) extra.scale = pl.scale;
      place(pl.slot, [x, y, pz + cz], layer, extra);
    }
  }

  function placeObstacles() {
    // Run opening, like the game's Intro_Train chunk: the parked start train on the left track
    if (gen.trains.start && has('prop_train_start')) {
      place('prop_train_start', [20, 0, 150], 'train', { group: 'start' });
      laneBlocks.push({ x: 20, z0: 100, z1: 270 });
    }
    // Event themes (Floor Is Lava, Plant Invasion) add "falling" lava cargo trains
    const kindSlots = (kind) => [1, 2, 3, 5].map((n) => `train_${kind}_${n}`).filter(has);
    const trainSlots = [...(gen.trains.static ? kindSlots('static') : []), ...(gen.trains.moving ? kindSlots('moving') : [])];
    const fallingSlots = gen.trains.falling ? kindSlots('falling') : [];
    const enabled = (keys) => keys.filter((k) => gen.obstacles[k]).map((k) => OBSTACLE_SLOTS[k]).filter(has);
    const blockerSlots = enabled(['jump', 'roll', 'standard']);
    const props = enabled(['bush', 'dumpster', 'powerBox']);
    const obstacleSlots = blockerSlots.length ? blockerSlots : props;
    for (const x of LANES) {
      let oz = SEGMENT + randInt(rng, 0, 8) * 11.25;
      while (oz < length - SEGMENT) {
        // Keep gate stretches clear: nothing may start in or run into the wall
        const blocked = (from, to) =>
          noTrackRanges.some(([a, b]) => from < b && to > a - 30) ||
          (x === 0 && pillarRanges.some(([a, b]) => from < b && to > a - 10)) ||
          laneBlocks.some((l) => l.x === x && from < l.z1 && to > l.z0) ||
          (x !== 0 && platformRanges.some(([a, b]) => from < b && to > a - 10));
        if (blocked(oz, oz + 30)) {
          oz += 90;
          continue;
        }
        const anyTrain = trainSlots.length || fallingSlots.length;
        if (anyTrain && (rng() < gen.trainShare || !obstacleSlots.length)) {
          const slot = fallingSlots.length && (rng() < 0.15 || !trainSlots.length) ? pick(rng, fallingSlots) : pick(rng, trainSlots);
          const cars = Number(slot.split('_').pop()); // train_<kind>_<cars>
          // Some static trains get a ramp wagon in front (spans -36..40 around its origin)
          const ramp = slot.startsWith('train_static') && gen.trains.ramps && has('train_ramp') && rng() < 0.35 ? RAMP_LENGTH : 0;
          const trainLength = 70 + 60 * (cars - 1);
          if (blocked(oz, oz + ramp + trainLength)) {
            oz += 90;
            continue;
          }
          const group = `train${items.length}`; // ramp + train hide together in the cutaway
          if (ramp) place('train_ramp', [x, 0, oz + 36], 'train', { group });
          place(slot, [x, 0, oz + ramp], 'train', { group });
          // Signal light at the track edge before some trains (outer edge for side lanes)
          // Signal light between two tracks (the game's LightSignal sits at x = ±10)
          if (gen.signals && has('obstacle_lightSignal') && rng() < 0.5) {
            const sx = x === 0 ? (rng() < 0.5 ? -10 : 10) : Math.sign(x) * 10;
            place('obstacle_lightSignal', [sx, 0, oz - 15], 'signal', { signalSeed: Math.floor(rng() * 2 ** 31) });
          }
          oz += ramp + trainLength;
        } else if (obstacleSlots.length) {
          // Mostly barriers, sometimes the theme's props (bush, dumpster, power box)
          const slot = props.length && (rng() < 0.25 || !blockerSlots.length) ? pick(rng, props) : pick(rng, blockerSlots);
          if (slot === 'obstacle_powerBox') powerBoxCluster(x, oz);
          else place(slot, [x, 0, oz], 'obstacle');
          oz += 22.5;
        }
        oz += (randInt(rng, 6, 20) * 11.25) / Math.max(0.2, gen.density);
      }
    }
  }

  /** The game's power box carries two shrunken bushes as children (Pumpkin chunk). */
  function powerBoxCluster(x, pz) {
    place('obstacle_powerBox', [x, 0, pz], 'obstacle');
    if (!has('obstacle_bush')) return;
    place('obstacle_bush', [x + 4.97, 0.06, pz + 2.48], 'obstacle', { scale: 0.672 });
    place('obstacle_bush', [x - 4.64, 0.34, pz + 1.93], 'obstacle', { scale: 0.54 });
  }

  return { items, length, pillarHalls, stations };
}

/** Converts generated obstacle items into an editable studio list ("start from this run"). */
export function itemsToStudio(items) {
  const out = [];
  // Regular pieces under a vanishing effect come back with it
  const at = (slot, pos) => `${slot}@${pos[0]},${pos[1]},${pos[2]}`;
  const underVanish = new Set(items.filter((i) => VANISH_BASE[i.slot]).map((i) => at(VANISH_BASE[i.slot], i.pos)));
  // A ramp sits 40 in front of its train's origin (the game's chunks: 26 to 35); chunk
  // trains share a group per lane, so it's found by position
  const ramps = items.filter((i) => i.slot === 'train_ramp');
  const rampOf = (it) => ramps.find((r) => r.group === it.group && r.pos[0] === it.pos[0] && it.pos[2] - r.pos[2] > 24 && it.pos[2] - r.pos[2] < 42);
  for (const it of items) {
    const [x, , z] = it.pos;
    if (underVanish.has(at(it.slot, it.pos))) continue;
    const m = it.slot.match(/^train_(static|moving|falling)_(\d)$/);
    if (m) {
      const ramp = rampOf(it);
      const z0 = ramp ? z - RAMP_LENGTH : z; // the train stays put, its ramp comes with it
      const variant = Object.keys(TRAIN_VARIANTS).find((v) => TRAIN_VARIANTS[v].test(it.prefab)) ?? 'auto';
      out.push({ type: 'train', lane: x, z0, z1: z + trainLength(Number(m[2])), kind: m[1], variant, ramp: !!ramp });
    } else if (it.slot === 'prop_train_start') {
      out.push({ type: 'startTrain', lane: x, z });
    } else if (it.slot === 'special_station_platform') {
      // Station platforms: studio items too (placed with the scenery in auto runs)
      out.push({ type: 'obstacle', key: 'platform', lane: 0, z });
    } else if (it.slot === 'obstacle_lightSignal') {
      out.push({ type: 'signal', x, z, color: mulberry32(it.signalSeed)() < 0.5 ? 'green' : 'red' });
    } else if (it.layer === 'obstacle' || it.mode) {
      // A game mode's own pieces (vanishing trains included) keep their slot as tool key
      const key = Object.entries(OBSTACLE_SLOTS).find(([, slot]) => slot === it.slot)?.[0] ?? (it.mode ? it.slot : null);
      // A power box brings its two small bushes back itself
      const ofPowerBox = it.scale && it.slot === 'obstacle_bush' && items.some((p) => p.slot === 'obstacle_powerBox' && Math.abs(p.pos[0] - x) < 6 && Math.abs(p.pos[2] - z) < 6);
      if (!key || ofPowerBox) continue;
      const y = it.pos[1];
      out.push({ type: 'obstacle', key, lane: x, z, ...(y ? { y } : {}), ...(it.scale ? { scale: it.scale } : {}) });
    }
  }
  return out;
}
