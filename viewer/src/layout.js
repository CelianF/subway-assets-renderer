// Procedural run layout from a theme's slot table.
// Not the game's RouteGenerationSystem (its logic is stripped from the export) —
// just a plausible sequence of the same pieces on the game's grid.

const SEGMENT = 180; // 16 cells * 11.25

// Older games (2.x) list the shadowed track/ground pieces as separate prefabs in the
// slot instead of per-prefab track configs: pick them by name
const TRACK_TYPE_NAMES = {
  TrackNormal: /^(?!.*_shadow)/,
  GroundNormal: /^(?!.*_shadow)/,
  TrackShadow: /_shadow$/,
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
  pieces: {}, // building piece key ("low_01", "high_03"…) -> false to leave it out
  density: 1, // obstacles per distance (gaps shrink as it grows)
  trainShare: 0.55, // chance a spot gets a train rather than an obstacle
};
const OBSTACLE_SLOTS = {
  jump: 'obstacle_barrier_jump',
  roll: 'obstacle_barrier_roll',
  standard: 'obstacle_barrier_standard',
  bush: 'obstacle_bush',
  dumpster: 'obstacle_dumpster',
  powerBox: 'obstacle_powerBox',
  pillar: 'obstacle_pillar',
};

/** Wagon count for a span: the longest available train that fits, else the shortest. */
export function fitTrain(options, span) {
  if (!options.length) return 0;
  const fitting = options.filter((n) => trainLength(n) <= span + 6);
  return fitting.length ? fitting[fitting.length - 1] : options[0];
}
export { RAMP_LENGTH };

/** Building piece key shared by a left/right pair: "London_low_01_left" -> "low_01". */
export const buildingPieceKey = (name) => name.match(/_((?:low|med|medium|high)_\d+)_(?:left|right)$/i)?.[1]?.toLowerCase() ?? null;

/** Building pieces of a theme, grouped by height, for the "map sections" picker. */
export function buildingPieces(manifest, themeName) {
  const slots = Object.assign({}, ...Object.values(manifest.themes[themeName]));
  const out = {};
  for (const height of ['low', 'medium', 'high']) {
    for (const side of ['left', 'right']) {
      for (const name of slots[`boundary_${height}_${side}`] ?? []) {
        const key = buildingPieceKey(name);
        if (!key) continue;
        (out[key] ??= { key, height, prefabs: [] }).prefabs.push(name);
      }
    }
  }
  return Object.values(out);
}

const hashString = (str) => [...str].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7) >>> 0;

/** Slots of a theme (optionally with another theme's trains). */
function themeSlots(manifest, themeName, trainTheme) {
  const slots = Object.assign({}, ...Object.values(manifest.themes[themeName]));
  if (trainTheme && trainTheme !== themeName && manifest.themes[trainTheme]) {
    Object.assign(slots, manifest.themes[trainTheme].train);
  }
  return slots;
}

// Train skins share a slot: <Theme>_Train_Static_3_Cargo / _Standard / _Subway
export const TRAIN_VARIANTS = { cargo: /_Cargo$/i, passenger: /_Standard$/i, subway: /_Subway$/i };

/** What the studio can place for this theme: obstacle tools and train kinds with their wagon counts. */
export function studioCatalog(manifest, themeName, trainTheme = null) {
  const slots = themeSlots(manifest, themeName, trainTheme);
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
    // Pillars come with pillar halls: not a free-placement tool
    obstacles: Object.fromEntries(Object.entries(OBSTACLE_SLOTS).filter(([k, slot]) => k !== 'pillar' && has(slot))),
    signal: has('obstacle_lightSignal'),
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
  // Trains (and ramps) can come from another theme
  const slots = themeSlots(manifest, themeName, trainTheme);
  const has = (slot) => slots[slot]?.length > 0;
  const rng = mulberry32(seed);
  const items = [];
  const noTrackRanges = []; // [z0, z1) where the regular rails are replaced
  const platformRanges = []; // [z0, z1) where platforms cover the two outer tracks
  const pillarRanges = []; // [z0, z1) where pillars stand in the middle lane
  const laneBlocks = []; // { x, z0, z1 }: single-lane stretches already taken (start train)
  let z = 0;

  let placeRng = rng; // studio items use their own stable generator
  const place = (slot, pos, layer = 'environment', extra = {}, nameFilter = null) => {
    if (!has(slot)) return null;
    const named = nameFilter ? slots[slot].filter((n) => nameFilter.test(n)) : [];
    const prefab = pick(placeRng, named.length ? named : slots[slot]);
    // Per-instance seed for the prefab's random variant groups
    items.push({ prefab, slot, layer, pos, variantSeed: Math.floor(placeRng() * 2 ** 31), ...extra });
    return prefab;
  };
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
  ].filter((s) => s.ok() && gen.sections[s.name] !== false);
  // Nothing enabled (or available): plain buildings
  if (!sectionTypes.length) sectionTypes.push({ name: 'buildings', weight: 1, build: buildings });
  const buildingsType = sectionTypes.find((t) => t.name === 'buildings');

  function buildings() {
    const n = randInt(rng, 2, 5);
    // Heights that still have an allowed piece on both sides ("map sections" picker)
    const allowed = (slot) => (slots[slot] ?? []).filter((nm) => gen.pieces[buildingPieceKey(nm)] !== false);
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
  /** Places a building slot using only the pieces left on in the picker. */
  function placeAllowed(slot, restrict) {
    if (!restrict) return place(slot, [0, 0, z]);
    const names = slots[slot].filter((nm) => gen.pieces[buildingPieceKey(nm)] !== false);
    const prefab = pick(placeRng, names);
    items.push({ prefab, slot, layer: 'environment', pos: [0, 0, z], variantSeed: Math.floor(placeRng() * 2 ** 31) });
    return prefab;
  }

  function station() {
    const start = z;
    placeRun('boundary_station_start');
    for (let i = randInt(rng, 1, 3); i > 0; i--) placeRun('boundary_station_mid');
    placeRun('boundary_station_end');
    // Raised platforms along both outer tracks, the length of the station (90 + n·180 + 90
    // tiles exactly with the 180-long platform piece)
    for (let pz = start; pz + SEGMENT <= z; pz += SEGMENT) place('special_station_platform', [0, 0, pz]);
    if (has('special_station_platform')) platformRanges.push([start, z]);
  }
  function tube() {
    const start = z;
    for (let i = randInt(rng, 2, 4); i > 0; i--) placeRun('boundary_tube');
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
  // Segment-long side blocks (Buenos Aires event streets) are building variants the
  // boundary pieces already pick from: scattered, they would sit on top of the buildings
  const isSideBlock = (s) => {
    const bb = manifest.prefabs[slots[s][0]]?.bbox;
    const fullWidth = bb && bb[0][0] < -60 && bb[1][0] > 60;
    return !!bb && !fullWidth && bb[1][2] - bb[0][2] >= SEGMENT - 10;
  };
  const decoSlots = eventSlots.filter((s) => !/tube_(start|end)/i.test(slots[s][0]) && !isSideBlock(s));
  function decorate(segZ) {
    if (!gen.decorations || !decoSlots.length || rng() > 0.35) return;
    const slot = pick(rng, decoSlots);
    const prefab = manifest.prefabs[pick(rng, slots[slot])];
    const bb = prefab?.bbox;
    if (!bb) return;
    const name = slots[slot][0];
    const fullWidth = bb[0][0] < -60 && bb[1][0] > 60; // frames the tracks (terracotta army)
    if (fullWidth) {
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
    for (let i = randInt(rng, 1, 3); i > 0; i--) placeRun('boundary_pillars_mid');
    placeRun('boundary_pillars_end');
    // Like the game's Pillars chunk: a pillar in the middle lane every 180, mid-segment
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
    if (walls.length) place(pick(rng, walls), [0, 0, z], 'wall');
    placeRun('boundary_gate');
    z = Math.max(z, start + slotLength(manifest, 'track_gates', manifest.prefabs[slots.track_gates[0]]));
    noTrackRanges.push([start, z]);
  }
  // Landmark (Tower Bridge, …): start/mid/end are 360 each. Some themes model the
  // whole landmark in epic_start and keep mid/end as empty placeholders, which still
  // reserve their length.
  function epic() {
    for (const slot of ['boundary_epic_start', 'boundary_epic_mid', 'boundary_epic_end']) placeRun(slot);
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
  for (const section of finalPlan) section.build();
  const length = z;
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
        if (it.key === 'powerBox') powerBoxCluster(it.lane, it.z);
        else place(OBSTACLE_SLOTS[it.key], [it.lane, 0, it.z], 'obstacle');
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
        if (pl.mirror && mirrored.get(pl.mirror)) x = 2 * pl.mirrorX - x;
        const key = `${pl.slot}@${x},${pz + cz}`;
        if (seen.has(key)) continue; // a chase entity and its themed child share a spot
        seen.add(key);
        const layer = pl.slot.startsWith('train_') ? 'train' : 'obstacle';
        // Trains in one lane of a chunk hide together in the cutaway
        const extra = layer === 'train' ? { group: `chunk${cz}x${x}` } : {};
        if (pl.scale) extra.scale = pl.scale;
        place(pl.slot, [x, y, pz + cz], layer, extra);
      }
      cz += chunk.length;
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

  return { items, length };
}

/** Converts generated obstacle items into an editable studio list ("start from this run"). */
export function itemsToStudio(items) {
  const out = [];
  const ramps = new Map(items.filter((i) => i.slot === 'train_ramp').map((i) => [i.group, i]));
  for (const it of items) {
    const [x, , z] = it.pos;
    const m = it.slot.match(/^train_(static|moving|falling)_(\d)$/);
    if (m) {
      const ramp = ramps.get(it.group);
      const z0 = ramp ? ramp.pos[2] - 36 : z;
      const variant = Object.keys(TRAIN_VARIANTS).find((v) => TRAIN_VARIANTS[v].test(it.prefab)) ?? 'auto';
      out.push({ type: 'train', lane: x, z0, z1: z + trainLength(Number(m[2])), kind: m[1], variant, ramp: !!ramp });
    } else if (it.slot === 'prop_train_start') {
      out.push({ type: 'startTrain', lane: x, z });
    } else if (it.slot === 'obstacle_lightSignal') {
      out.push({ type: 'signal', x, z, color: mulberry32(it.signalSeed)() < 0.5 ? 'green' : 'red' });
    } else if (it.layer === 'obstacle' && !it.scale) {
      const key = Object.entries(OBSTACLE_SLOTS).find(([, slot]) => slot === it.slot)?.[0];
      if (key) out.push({ type: 'obstacle', key, lane: x, z });
    }
  }
  return out;
}
