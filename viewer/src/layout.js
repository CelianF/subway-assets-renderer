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
export function generateLayout(manifest, themeName, { seed = 1, sections = 12, obstacles = true, trains = true } = {}) {
  const theme = manifest.themes[themeName];
  const slots = Object.assign({}, ...Object.values(theme));
  const has = (slot) => slots[slot]?.length > 0;
  const rng = mulberry32(seed);
  const items = [];
  const noTrackRanges = []; // [z0, z1) where the regular rails are replaced
  let z = 0;

  const place = (slot, pos, layer = 'environment', extra = {}) => {
    if (!has(slot)) return null;
    const prefab = pick(rng, slots[slot]);
    items.push({ prefab, slot, layer, pos, ...extra });
    return prefab;
  };
  const placeRun = (slot) => {
    const prefab = place(slot, [0, 0, z]);
    if (prefab) z += pieceLength(manifest.prefabs[prefab]);
  };

  const sectionTypes = [
    { weight: 5, ok: () => true, build: buildings },
    { weight: 1, ok: () => has('boundary_station_mid'), build: station },
    { weight: 1, ok: () => has('boundary_tube'), build: tube },
    { weight: 1, ok: () => has('boundary_pillars_mid'), build: pillars },
    { weight: 0.5, ok: () => has('boundary_gate') && has('track_gates'), build: gate },
    { weight: 0.4, ok: () => has('boundary_epic_start') && has('boundary_epic_end'), build: epic },
  ].filter((s) => s.ok());

  function buildings() {
    const n = randInt(rng, 2, 5);
    for (let i = 0; i < n; i++) {
      const height = pick(rng, ['low', 'medium', 'high']);
      place(`boundary_${height}_left`, [0, 0, z]);
      place(`boundary_${height}_right`, [0, 0, z]);
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
    placeRun('boundary_gate');
    z = Math.max(z, start + pieceLength(manifest.prefabs[slots.track_gates[0]]));
    noTrackRanges.push([start, z]);
  }
  function epic() {
    placeRun('boundary_epic_start');
    if (has('boundary_epic_mid')) placeRun('boundary_epic_mid');
    placeRun('boundary_epic_end');
  }

  // Always open with plain buildings so the camera starts somewhere readable
  buildings();
  const total = sectionTypes.reduce((s, t) => s + t.weight, 0);
  for (let i = 1; i < sections; i++) {
    let r = rng() * total;
    const section = sectionTypes.find((t) => (r -= t.weight) < 0) ?? sectionTypes[0];
    section.build();
  }
  const length = z;

  // Rails: one TrackNormal piece per lane per segment, skipping gate stretches
  for (let tz = 0; tz < length; tz += SEGMENT) {
    if (noTrackRanges.some(([a, b]) => tz >= a && tz < b)) continue;
    for (const x of LANES) place('track_track', [x, 0, tz], 'track', { trackType: 'TrackNormal' });
  }

  if (obstacles || trains) placeObstacles();

  function placeObstacles() {
    const trainSlots = ['train_static_1', 'train_static_2', 'train_static_3', 'train_static_5'].filter(has);
    const blockerSlots = ['obstacle_barrier_jump', 'obstacle_barrier_roll', 'obstacle_barrier_standard'].filter(has);
    for (const x of LANES) {
      let oz = SEGMENT + randInt(rng, 0, 8) * 11.25;
      while (oz < length - SEGMENT) {
        const inGate = noTrackRanges.some(([a, b]) => oz >= a - 60 && oz < b);
        if (inGate) {
          oz += 90;
          continue;
        }
        if (trains && trainSlots.length && rng() < 0.55) {
          const slot = pick(rng, trainSlots);
          const cars = Number(slot.split('_').pop());
          place(slot, [x, 0, oz], 'train');
          oz += 70 + 60 * (cars - 1);
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
