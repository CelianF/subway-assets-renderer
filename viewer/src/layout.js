// Procedural run layout from a theme's slot table.
// Not the game's RouteGenerationSystem (its logic is stripped from the export) —
// just a plausible sequence of the same pieces on the game's grid.

const SEGMENT = 180; // 16 cells * 11.25
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

/** Length a piece occupies along Z, snapped to half segments. */
function pieceLength(prefab) {
  const maxZ = prefab?.bbox?.[1][2] ?? SEGMENT;
  return Math.max(SEGMENT / 2, Math.round(maxZ / (SEGMENT / 2)) * (SEGMENT / 2));
}

/**
 * @returns {{items: Array<{prefab, slot, layer, pos:[x,y,z], trackType?}>, length: number}}
 */
export function generateLayout(
  manifest,
  themeName,
  { seed = 1, sections = 12, obstacles = true, trains = true, signals = true, trainTheme = null } = {},
) {
  const theme = manifest.themes[themeName];
  const slots = Object.assign({}, ...Object.values(theme));
  // Trains (and ramps) can come from another theme
  if (trainTheme && trainTheme !== themeName && manifest.themes[trainTheme]) {
    Object.assign(slots, manifest.themes[trainTheme].train);
  }
  const has = (slot) => slots[slot]?.length > 0;
  const rng = mulberry32(seed);
  const items = [];
  const noTrackRanges = []; // [z0, z1) where the regular rails are replaced
  let z = 0;

  const place = (slot, pos, layer = 'environment', extra = {}) => {
    if (!has(slot)) return null;
    const prefab = pick(rng, slots[slot]);
    // Per-instance seed for the prefab's random variant groups
    items.push({ prefab, slot, layer, pos, variantSeed: Math.floor(rng() * 2 ** 31), ...extra });
    return prefab;
  };
  // Boundary runs per side of the track, for the theme's transition pieces
  const runs = { left: [], right: [] };
  const addRun = (side, slot, z0, z1) => runs[side].push({ slot, z0, z1 });
  const placeRun = (slot) => {
    const prefab = place(slot, [0, 0, z]);
    if (!prefab) return;
    const z0 = z;
    z += pieceLength(manifest.prefabs[prefab]);
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
  ].filter((s) => s.ok());

  function buildings() {
    const n = randInt(rng, 2, 5);
    for (let i = 0; i < n; i++) {
      const height = pick(rng, ['low', 'medium', 'high']);
      place(`boundary_${height}_left`, [0, 0, z]);
      place(`boundary_${height}_right`, [0, 0, z]);
      addRun('left', `boundary_${height}_left`, z, z + SEGMENT);
      addRun('right', `boundary_${height}_right`, z, z + SEGMENT);
      z += SEGMENT;
    }
  }
  function station() {
    placeRun('boundary_station_start');
    for (let i = randInt(rng, 1, 3); i > 0; i--) placeRun('boundary_station_mid');
    placeRun('boundary_station_end');
  }
  function tube() {
    for (let i = randInt(rng, 2, 4); i > 0; i--) placeRun('boundary_tube');
  }
  function pillars() {
    placeRun('boundary_pillars_start');
    for (let i = randInt(rng, 1, 3); i > 0; i--) placeRun('boundary_pillars_mid');
    placeRun('boundary_pillars_end');
  }
  function gate() {
    const start = z;
    place('track_gates', [0, 0, z]);
    // The wall across the lanes, open on one lane (left/mid/right) or both sides
    const walls = ['special_gate_left', 'special_gate_mid', 'special_gate_right', 'special_gate_sides'].filter(has);
    if (walls.length) place(pick(rng, walls), [0, 0, z], 'obstacle');
    placeRun('boundary_gate');
    z = Math.max(z, start + pieceLength(manifest.prefabs[slots.track_gates[0]]));
    noTrackRanges.push([start, z]);
  }
  // Landmark (Tower Bridge, …). Some themes model it entirely in epic_start and
  // leave mid/end as disabled placeholders, so only place pieces that have geometry.
  function epic() {
    for (const slot of ['boundary_epic_start', 'boundary_epic_mid', 'boundary_epic_end']) {
      if (slots[slot]?.some((n) => manifest.prefabs[n]?.bbox)) placeRun(slot);
    }
  }

  // Random sections, but every run of 4+ sections shows the theme's landmark and a gate
  const total = sectionTypes.reduce((s, t) => s + t.weight, 0);
  const plan = Array.from({ length: sections }, () => {
    let r = rng() * total;
    return sectionTypes.find((t) => (r -= t.weight) < 0) ?? sectionTypes[0];
  });
  plan[0] = sectionTypes[0]; // open with plain buildings so the camera starts somewhere readable
  const force = (name, at) => {
    const type = sectionTypes.find((t) => t.name === name);
    if (type && sections >= 4 && !plan.includes(type)) plan[at] = type;
  };
  force('epic', Math.floor(sections / 2));
  force('gate', Math.max(1, Math.floor(sections / 4)));
  // Covered/special sections never touch: the game always puts open-air buildings between them
  const finalPlan = [];
  for (const section of plan) {
    const prev = finalPlan[finalPlan.length - 1];
    if (prev && prev !== sectionTypes[0] && section !== sectionTypes[0]) finalPlan.push(sectionTypes[0]);
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

  // Rails: one piece per lane per segment, skipping gate stretches. Under boundaries
  // whose TrackInfos say ShowShadows (stations, tubes, pillars) the shadowed variants
  // are used, with start/end pieces where the shadowed stretch begins and ends.
  const trackInfos = manifest.boundaries?.[themeName]?.trackInfos ?? {};
  const shadowedAt = (tz) => {
    const run = runs.left.find((r) => tz >= r.z0 && tz < r.z1);
    return !!(run && trackInfos[run.slot]?.ShowShadows);
  };
  for (let tz = 0; tz < length; tz += SEGMENT) {
    if (noTrackRanges.some(([a, b]) => tz >= a && tz < b)) continue;
    let trackType = 'TrackNormal';
    if (shadowedAt(tz)) {
      const starts = !shadowedAt(tz - SEGMENT);
      const ends = !shadowedAt(tz + SEGMENT);
      trackType = starts && ends ? 'TrackShadowStartEnd' : starts ? 'TrackShadowStart' : ends ? 'TrackShadowEnd' : 'TrackShadow';
    }
    for (const x of LANES) place('track_track', [x, 0, tz], 'track', { trackType });
  }

  if (obstacles || trains || signals) placeObstacles();

  function placeObstacles() {
    const trainSlots = ['train_static_1', 'train_static_2', 'train_static_3', 'train_static_5', 'train_moving_3', 'train_moving_5'].filter(has);
    const blockerSlots = ['obstacle_barrier_jump', 'obstacle_barrier_roll', 'obstacle_barrier_standard'].filter(has);
    for (const x of LANES) {
      let oz = SEGMENT + randInt(rng, 0, 8) * 11.25;
      while (oz < length - SEGMENT) {
        // Keep gate stretches clear: nothing may start in or run into the wall
        const blocked = (from, to) => noTrackRanges.some(([a, b]) => from < b && to > a - 30);
        if (blocked(oz, oz + 30)) {
          oz += 90;
          continue;
        }
        if (trains && trainSlots.length && rng() < 0.55) {
          const slot = pick(rng, trainSlots);
          const cars = Number(slot.split('_').pop());
          // Some static trains get a ramp wagon in front (spans -36..40 around its origin)
          const ramp = slot.startsWith('train_static') && has('train_ramp') && rng() < 0.35 ? 76 : 0;
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
          if (signals && has('obstacle_lightSignal') && rng() < 0.5) {
            const sx = x === 0 ? (rng() < 0.5 ? -10 : 10) : Math.sign(x) * 10;
            place('obstacle_lightSignal', [sx, 0, oz - 15], 'signal', { signalSeed: Math.floor(rng() * 2 ** 31) });
          }
          oz += ramp + trainLength;
        } else if (obstacles && blockerSlots.length) {
          place(pick(rng, blockerSlots), [x, 0, oz], 'obstacle');
          oz += 22.5;
        }
        oz += randInt(rng, 6, 20) * 11.25;
      }
    }
  }

  return { items, length };
}
