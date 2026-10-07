import * as THREE from 'three';
import { fitTrain, trainLength, RAMP_LENGTH, FIX_LABELS, coinPositions, arcPositions, COIN_SPACING } from './layout.js';

// Studio mode: a slightly tilted top view of the run with placement spots. Trains are
// drawn from a start cell to an end cell on one track and snap to the longest train
// that fits; obstacles take one cell; signal lights sit between two tracks; "no tracks"
// zones remove the rails of a stretch of track; coins are drawn in lines along a track,
// other pickups take one cell (both float over the roof of a parked train). Everything above the trains is clipped
// away so stations and tunnels don't hide the tracks.

const CELL = 11.25;
const ZONE_WIDTH = 62; // full-width zones: across the three tracks
// Full-width zones the map offers (ctx.zoneKinds): an event challenge (Green Jam,
// Christmas) or the No Floor mode's activated floor (spiked vines, hot lava)
const FULL_ZONES = ['challenge', 'surge'];
// Two-state pieces (No Floor's moving blockers): as they wait, as the runner meets them, or both in turn
const PIECE_STATES = [['idle', '⬆ Raised'], ['revealed', '⬇ Dropped'], ['animated', '▶ Animated']];
// A challenge zone's runner: the game's left is +X
const RUNNER_LANES = [[20, '⬅ Left'], [0, 'Center'], [-20, 'Right ➡']];
const LANES = [20, 0, -20]; // left, middle, right (glTF X; the game's left is +X)
const SIGNAL_X = [30, 10, -10, -30]; // outer left edge, between tracks, outer right edge
const CLIP_HEIGHT = 34;
const TILT = THREE.MathUtils.degToRad(28); // from straight down

const COLORS = {
  train: 0x4aa3ff,
  obstacle: 0xffb020,
  signal: { green: 0x3ddc84, red: 0xff4d4d, off: 0x9aa5b5 },
  noTracks: 0xff4d4d,
  challenge: 0x4cd964,
  surge: 0xff7a1a,
  coins: 0xffd23f,
  pickup: 0xc77dff,
  hover: 0xffffff,
  remove: 0xff3030,
  selected: 0xffffff,
};

const LABELS = {
  jump: 'Jump barrier',
  roll: 'Roll barrier',
  standard: 'Barrier',
  bush: 'Bush',
  dumpster: 'Dumpster',
  powerBox: 'Power box',
  pillar: 'Pillar',
  platform: 'Station platform',
  full: 'Full barrier',
  trainPlatform: 'Train platform',
};
const FIX_TITLES = {
  pillar: 'Removes every pillar, then puts each pillar hall\'s back in place (whatever stands in their spots is cleared)',
  platform: 'Removes every platform, then puts each station\'s back in place (whatever stands on the outer tracks there is cleared)',
};
const KIND_LABELS = { static: 'Parked', moving: 'Moving', falling: 'Lava' };
// The game's pickups by prefab name, in the palette's groups
const PICKUP_GROUPS = [
  ['Power-ups', { Magnet: '🧲 Magnet', Jetpack: '🚀 Jetpack', SuperSneakers: '👟 Super Sneakers', '2xScore': '✖️ 2x Multiplier', Pogostick: '🦘 Pogo Stick', MysteryPowerup: '❓ Mystery power-up', Hourglass: '⏳ Hourglass' }],
  ['Boxes & tokens', { MysteryBox: '🎁 Mystery Box', SuperMysteryBox: '🎁 Super Mystery Box', Key: '🔑 Key', SeasonToken: '🏅 Season token', LetterToken: '🔤 Letter token', CharacterLetterToken: '🔤 Character token' }],
  // Trick or Treat's candies and stinky fish (they shrink the gap to the chased one, or grow it), the race's own
  ['Events', { ChaseTargetNormalPickup: '🍬 Candy', ChaseTargetBigPickup: '🍭 Lollipop', ChaseTargetNegativePickup: '🐟 Stinky fish', Race_Board_Charge: '⚡ Board charge', Race_Mystery_Box: '🎁 Race Mystery Box' }],
];
const PICKUP_LABELS = Object.assign({}, ...PICKUP_GROUPS.map(([, labels]) => labels));
const pickupLabel = (key) => (PICKUP_LABELS[key] ?? key).replace(/^\S+ /, '');
// Coins the lines and arcs can be made of (the team event's green and red, Pride's)
const COIN_SKINS = { Coin: 'Gold coins', GreenCoin: 'Green coins', RedCoin: 'Red coins', PrideCoin: 'Pride coins' };
const LETTERS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
const isPickup = (it) => ['coins', 'coinArc', 'pickup'].includes(it.type);
const tokenLabel = (name) => (name === 'point' ? 'Season point' : name.replace(/^Hunttoken_/, '').replace(/_/g, ' '));
/** Name of an obstacle tool: regular ones, else the game mode's piece names. */
const labelOf = (key, cat) => LABELS[key] ?? cat?.modePieces?.[key] ?? key;
const VARIANT_LABELS = { auto: 'Any', cargo: 'Cargo', passenger: 'Passenger', subway: 'Subway' };

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'selected') node[k] = !!v;
    else if (v != null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children.flat().filter((c) => c != null));
  return node;
}

const cellOf = (z) => Math.floor(z / CELL);
const overlaps = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;

/**
 * @param ctx { scene, renderer, canvas, root (DOM), getCatalog(), getLength(), getList(), setList(list), onExit(), fromRun() }
 */
export function createStudio(ctx) {
  const { scene, renderer, canvas } = ctx;
  let active = false;
  let tool = { type: 'train', kind: 'static', variant: 'auto', ramp: false };
  let pending = null; // first click of a two-click tool (train / no-tracks zone): { lane, cellZ }
  let selected = -1; // edit mode: index of the selected item
  let placeTool = tool; // last asset chosen in Place mode
  let category = 'trains'; // Place mode: which asset family the content bar shows
  let viewZ = 300;
  let zoom = 2;

  // ------------------------------------------------------------ camera (tilted top view)
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 3000);
  cam.up.set(0, 0, 1); // run goes up the screen; +X (the game's left) shows on the left
  function updateCamera() {
    const aspect = canvas.clientWidth / canvas.clientHeight;
    const halfH = Math.max(180, 90 / aspect) / zoom;
    Object.assign(cam, { left: -halfH * aspect, right: halfH * aspect, top: halfH, bottom: -halfH });
    viewZ = THREE.MathUtils.clamp(viewZ, 0, Math.max(0, ctx.getLength()));
    cam.position.set(0, 800 * Math.cos(TILT), viewZ - 800 * Math.sin(TILT));
    cam.lookAt(0, 0, viewZ);
    cam.updateProjectionMatrix();
  }

  // ------------------------------------------------------------ overlay meshes
  const overlay = new THREE.Group();
  overlay.visible = false;
  scene.add(overlay);
  const overlayMat = (color, opacity) =>
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false });
  const flat = (w, d, color, opacity) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), overlayMat(color, opacity));
    m.renderOrder = 5000;
    m.frustumCulled = false;
    return m;
  };
  let laneSpots = null;
  let signalSpots = null;
  const footprints = new THREE.Group();
  const coinDot = new THREE.CircleGeometry(2.4, 16).rotateX(-Math.PI / 2);
  const hover = flat(18, CELL - 1, COLORS.hover, 0.45); // single cell / signal spot
  const span = flat(17, 1, COLORS.train, 0.45); // train or zone preview, scaled along Z
  hover.visible = span.visible = false;
  overlay.add(footprints, hover, span);

  function buildSpots() {
    overlay.remove(...[laneSpots, signalSpots].filter(Boolean));
    const cells = Math.ceil(ctx.getLength() / CELL);
    const m = new THREE.Matrix4();
    const instanced = (geo, color, opacity, xs, y) => {
      const mesh = new THREE.InstancedMesh(geo, overlayMat(color, opacity), cells * xs.length);
      let i = 0;
      for (let c = 0; c < cells; c++) for (const x of xs) mesh.setMatrixAt(i++, m.makeTranslation(x, y, c * CELL + CELL / 2));
      mesh.renderOrder = 5000;
      mesh.frustumCulled = false;
      return mesh;
    };
    signalSpots = instanced(new THREE.CircleGeometry(1.8, 12).rotateX(-Math.PI / 2), COLORS.signal.green, 0.5, SIGNAL_X, 0.6);
    overlay.add(signalSpots);
    spotsFor = (shape) => {
      const geo = new THREE.PlaneGeometry(shape.w, shape.d).rotateX(-Math.PI / 2).translate(shape.dx, 0, shape.dz - CELL / 2);
      return instanced(geo, 0xffffff, 0.14, shape.xs, 0.5);
    };
    spotKey = null;
    updateSpotVisibility();
  }
  let spotsFor = null;
  let spotKey = null;

  /**
   * Where the current tool can go, in its own shape: a barrier's box, a pillar's square, a
   * track's lane for "no tracks"; none for trains and pieces across the run (platforms) or
   * zones, which show their own preview.
   */
  function spotShape() {
    if (tool.type === 'noTracks') return { w: 16, d: CELL - 3, dx: 0, dz: CELL / 2, xs: LANES };
    if (isPickup(tool)) return { w: 7, d: 7, dx: 0, dz: CELL / 2, xs: LANES };
    if (tool.type !== 'obstacle') return null;
    const cat = ctx.getCatalog();
    if (isTrainPiece(tool.key, cat)) return null;
    const r = rectOf({ key: tool.key, lane: 0, z: CELL / 2 }, cat);
    if (r.x1 - r.x0 > 40) return null;
    return { w: Math.max(r.x1 - r.x0, 4), d: Math.max(Math.min(r.z1 - r.z0, CELL - 3), 4), dx: (r.x0 + r.x1) / 2, dz: (r.z0 + r.z1) / 2, xs: cat.sizes?.[tool.key]?.wide ? [0] : LANES };
  }

  /** Only the spots the current tool can use. */
  function updateSpotVisibility() {
    if (!signalSpots) return;
    signalSpots.visible = tool.type === 'signal';
    const shape = spotShape();
    const key = shape && JSON.stringify(shape);
    if (key === spotKey) return;
    spotKey = key;
    if (laneSpots) overlay.remove(laneSpots), laneSpots.geometry.dispose();
    laneSpots = shape ? spotsFor(shape) : null;
    if (laneSpots) overlay.add(laneSpots);
  }

  /** Real footprint length of a train (ramp + wagons) drawn over [z0, z1]. */
  function trainSpan(it) {
    const cat = ctx.getCatalog();
    const ramp = it.ramp && cat.ramp ? RAMP_LENGTH : 0;
    const cars = fitTrain(cat.trains[it.kind] ?? [], it.z1 - it.z0 - ramp);
    return ramp + trainLength(cars || 1);
  }

  function describeTrain(it) {
    const cat = ctx.getCatalog();
    const ramp = it.ramp && cat.ramp;
    const cars = fitTrain(cat.trains[it.kind] ?? [], it.z1 - it.z0 - (ramp ? RAMP_LENGTH : 0));
    const variant = it.variant && it.variant !== 'auto' ? ` ${VARIANT_LABELS[it.variant].toLowerCase()}` : '';
    return `${KIND_LABELS[it.kind]}${variant} train, ${cars} car${cars > 1 ? 's' : ''}${ramp ? ' + ramp' : ''}`;
  }

  /**
   * Ground rectangle an obstacle covers: its model's footprint around its spot (one cell
   * when unknown). Pieces across the track (platforms, race arches) sit on the middle one.
   */
  function rectOf(it, cat = ctx.getCatalog()) {
    const size = cat.sizes?.[it.key];
    if (!size) return { x0: it.lane - 8.5, x1: it.lane + 8.5, z0: it.z - (CELL - 2) / 2, z1: it.z + (CELL - 2) / 2 };
    return { x0: it.lane + size.x0, x1: it.lane + size.x1, z0: it.z + size.z0, z1: it.z + size.z1 };
  }
  const isTrainPiece = (key, cat) => cat.trainPieces?.includes(key);

  function footprintOf(it, color = null, opacity = null, cat = ctx.getCatalog()) {
    let m;
    if (it.type === 'train') {
      m = flat(17, it.z1 - it.z0, color ?? COLORS.train, opacity ?? 0.35);
      m.position.set(it.lane, 1, (it.z0 + it.z1) / 2);
    } else if (it.type === 'noTracks') {
      m = flat(19, it.z1 - it.z0, color ?? COLORS.noTracks, opacity ?? 0.25);
      m.position.set(it.lane, 0.8, (it.z0 + it.z1) / 2);
    } else if (FULL_ZONES.includes(it.type)) {
      m = flat(ZONE_WIDTH, it.z1 - it.z0, color ?? COLORS[it.type], opacity ?? 0.16);
      m.position.set(0, 0.6, (it.z0 + it.z1) / 2);
      if (it.type === 'challenge') {
        // The lane its runner loops along
        const lane = flat(4, it.z1 - it.z0, color ?? COLORS[it.type], 0.5);
        lane.position.set(it.lane ?? 0, 0.1, 0);
        m.add(lane);
      }
    } else if (it.type === 'signal') {
      m = flat(5, 5, color ?? COLORS.signal[it.color ?? 'green'], opacity ?? 0.85);
      m.position.set(it.x, 1, it.z);
    } else if (it.type === 'coins') {
      // A strip along the track with a dot per coin
      m = flat(3, it.z1 - it.z0, color ?? COLORS.coins, opacity ?? 0.3);
      m.position.set(it.lane, 1.2, (it.z0 + it.z1) / 2);
      for (const z of coinPositions(it)) {
        const dot = new THREE.Mesh(coinDot, overlayMat(color ?? COLORS.coins, opacity ?? 0.9));
        dot.renderOrder = 5001;
        dot.frustumCulled = false;
        dot.position.set(0, 0.1, z - m.position.z);
        m.add(dot);
      }
    } else if (it.type === 'coinArc') {
      // Its stretch of track, a dot per coin, the middle one (the spot) bigger
      const coins = arcPositions(it, cat.coinPatterns?.arcs?.[0]);
      m = flat(3, coins.at(-1).z - coins[0].z, color ?? COLORS.coins, opacity ?? 0.3);
      m.position.set(it.lane, 1.2, it.z);
      coins.forEach((c, i) => {
        const dot = new THREE.Mesh(coinDot, overlayMat(color ?? COLORS.coins, opacity ?? 0.9));
        dot.renderOrder = 5001;
        dot.frustumCulled = false;
        dot.position.set(0, 0.1, c.z - it.z);
        if (i === (coins.length - 1) / 2) dot.scale.setScalar(1.6);
        m.add(dot);
      });
    } else if (it.type === 'pickup') {
      m = flat(7, 7, color ?? COLORS.pickup, opacity ?? 0.85);
      m.position.set(it.lane, 1.2, it.z);
    } else if (it.type === 'startTrain') {
      m = flat(17, 130, color ?? COLORS.train, opacity ?? 0.35);
      m.position.set(it.lane, 1, it.z + 35);
    } else {
      const r = rectOf(it, cat);
      m = flat(Math.max(r.x1 - r.x0, 4), Math.max(r.z1 - r.z0, 4), color ?? (isTrainPiece(it.key, cat) ? COLORS.train : COLORS.obstacle), opacity ?? 0.45);
      m.position.set((r.x0 + r.x1) / 2, 1, (r.z0 + r.z1) / 2);
    }
    return m;
  }

  function drawFootprints() {
    footprints.clear();
    const cat = ctx.getCatalog();
    ctx.getList().forEach((it, i) => {
      const m = i === selected && tool.type === 'edit' ? footprintOf(it, COLORS.selected, 0.55, cat) : footprintOf(it, null, null, cat);
      footprints.add(m);
    });
  }

  /** Wagon counts available for a kind (sorted). */
  const carOptions = (kind) => ctx.getCatalog().trains[kind] ?? [];
  const carsOf = (it) => fitTrain(carOptions(it.kind), it.z1 - it.z0 - (it.ramp && ctx.getCatalog().ramp ? RAMP_LENGTH : 0));

  /** Rebuilds a train with new settings; refuses if it would run into another train. */
  function editTrain(changes) {
    const list = [...ctx.getList()];
    const it = list[selected];
    if (!it || it.type !== 'train') return;
    const next = { ...it, ...changes };
    const options = carOptions(next.kind);
    let cars = changes.cars ?? carsOf(it);
    if (!options.includes(cars)) cars = options.reduce((a, b) => (Math.abs(b - cars) < Math.abs(a - cars) ? b : a), options[0]);
    delete next.cars;
    next.ramp = !!(next.ramp && next.kind === 'static' && ctx.getCatalog().ramp);
    next.z1 = next.z0 + (next.ramp ? RAMP_LENGTH : 0) + trainLength(cars);
    const blocker = list.some((o, i) => i !== selected && (o.type === 'train' || o.type === 'startTrain') && o.lane === next.lane && overlaps(next.z0, next.z1, o.z0 ?? o.z - 30, o.z1 ?? o.z + 100));
    if (blocker) return setInfo('Not enough room: another train is in the way');
    list[selected] = next;
    commit(list, 'Updated');
    renderPalette();
  }

  function describeItem(it) {
    if (it.type === 'train') return describeTrain(it);
    if (it.type === 'obstacle') return labelOf(it.key, ctx.getCatalog());
    if (it.type === 'signal') return `Signal light (${it.color ?? 'green'})`;
    if (it.type === 'coins') return `Coin line, ${coinPositions(it).length} coins`;
    if (it.type === 'coinArc') return `Jump arc, ${arcPositions(it, ctx.getCatalog().coinPatterns?.arcs?.[0]).length} coins`;
    if (it.type === 'pickup') return `${pickupLabel(it.key)}${it.letter ? ` ${it.letter}` : ''}${it.key === 'SeasonToken' && it.token ? ` (${tokenLabel(it.token)})` : ''}`;
    if (it.type === 'noTracks') return `No tracks zone, ${Math.round((it.z1 - it.z0) / CELL)} tiles`;
    if (FULL_ZONES.includes(it.type)) return `${zoneLabel(it.type)} zone, ${Math.round((it.z1 - it.z0) / CELL)} tiles`;
    return it.type;
  }

  /** Replaces the selected item (edit mode). */
  function replaceSelected(next, verb = 'Updated') {
    const list = [...ctx.getList()];
    list[selected] = next;
    commit(list, verb);
    renderPalette();
  }

  /** Turns the selected obstacle into another one (max one of each kind per tile). */
  function editObstacle(key) {
    const list = ctx.getList();
    const it = list[selected];
    const clash = list.some((o, i) => i !== selected && o.type === 'obstacle' && o.key === key && o.lane === it.lane && cellOf(o.z) === cellOf(it.z));
    if (clash) return setInfo(`There is already a ${labelOf(key, ctx.getCatalog()).toLowerCase()} on this tile`);
    replaceSelected({ ...it, key });
  }

  function deleteSelected() {
    const list = [...ctx.getList()];
    list.splice(selected, 1);
    selected = -1;
    commit(list, 'Removed');
    renderPalette();
  }

  // ------------------------------------------------------------ picking
  const raycaster = new THREE.Raycaster();
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  function pick(e) {
    const r = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, cam);
    const p = raycaster.ray.intersectPlane(ground, new THREE.Vector3());
    if (!p || p.z < 0 || p.z > ctx.getLength()) return null;
    const cell = cellOf(p.z);
    const nearest = (xs) => xs.reduce((a, b) => (Math.abs(p.x - b) < Math.abs(p.x - a) ? b : a));
    const lane = nearest(LANES);
    return { x: p.x, z: p.z, cell, cellZ: cell * CELL, lane, laneOk: Math.abs(p.x - lane) <= 10, signalX: nearest(SIGNAL_X) };
  }

  /**
   * Index of the item under a spot, or -1. Trains, obstacles and lights win over the
   * "no tracks" zone underneath them (zones are only picked where nothing sits on top).
   */
  function itemAt(s, { zones = true } = {}) {
    const hit = itemAtPass(s, false);
    return hit >= 0 || !zones ? hit : itemAtPass(s, true);
  }

  function itemAtPass(s, zonesOnly) {
    const list = ctx.getList();
    const cat = ctx.getCatalog();
    for (let i = list.length - 1; i >= 0; i--) {
      const it = list[i];
      if (isZone(it) !== zonesOnly) continue;
      if (FULL_ZONES.includes(it.type)) {
        if (s.z >= it.z0 && s.z < it.z1) return i; // across the whole width
      } else if (it.type === 'signal') {
        if (Math.abs(s.x - it.x) < 4 && cellOf(it.z) === s.cell) return i;
      } else if (it.type === 'pickup') {
        if (s.laneOk && it.lane === s.lane && cellOf(it.z) === s.cell) return i;
      } else if (it.type === 'coinArc') {
        const coins = arcPositions(it, cat.coinPatterns?.arcs?.[0]);
        if (s.laneOk && it.lane === s.lane && s.z >= coins[0].z - CELL / 2 && s.z <= coins.at(-1).z + CELL / 2) return i;
      } else if (it.type === 'obstacle') {
        // Anywhere on its footprint (at least its tile on its track)
        const r = rectOf(it, cat);
        const onTile = s.laneOk && it.lane === s.lane && cellOf(it.z) === s.cell;
        if (onTile || (s.x >= r.x0 && s.x <= r.x1 && s.z >= r.z0 && s.z <= r.z1)) return i;
      } else if (s.laneOk && it.lane === s.lane) {
        if ((it.type === 'train' || it.type === 'noTracks' || it.type === 'coins') && s.z >= it.z0 && s.z < it.z1) return i;
        if (it.type === 'startTrain' && s.z >= it.z - 30 && s.z < it.z + 100) return i;
      }
    }
    return -1;
  }

  const isZone = (it) => it.type === 'noTracks' || FULL_ZONES.includes(it.type);
  const zoneLabel = (type) => ctx.zoneKinds?.().find((k) => k.type === type)?.label ?? type;

  /** [z0, z1] a two-click tool covers between the first click and this spot. */
  function spanTo(s) {
    const z0 = Math.min(pending.cellZ, s.cellZ);
    const z1 = Math.max(pending.cellZ, s.cellZ) + CELL;
    if (tool.type !== 'train') return { z0, z1 };
    // Trains snap up: as soon as the cursor passes the end of a train, the next size shows
    const cat = ctx.getCatalog();
    const ramp = tool.ramp && cat.ramp ? RAMP_LENGTH : 0;
    const options = cat.trains[tool.kind] ?? [1];
    const cars = options.find((n) => ramp + trainLength(n) >= z1 - z0 - 0.5) ?? options[options.length - 1];
    return { z0, z1: z0 + ramp + trainLength(cars) };
  }

  let removeHighlight = null;
  function onMove(e) {
    if (!active) return;
    const s = pick(e);
    hover.visible = false;
    span.visible = false;
    if (removeHighlight) {
      overlay.remove(removeHighlight);
      removeHighlight = null;
    }
    if (!s) return;

    if (tool.type === 'edit') {
      const i = itemAt(s);
      if (i >= 0 && i !== selected) {
        removeHighlight = footprintOf(ctx.getList()[i], COLORS.selected, 0.35);
        removeHighlight.position.y = 2;
        overlay.add(removeHighlight);
      }
      return;
    }
    if (tool.type === 'remove') {
      // Red only when something is actually under the cursor
      const i = itemAt(s);
      if (i >= 0) {
        removeHighlight = footprintOf(ctx.getList()[i], COLORS.remove, 0.6);
        removeHighlight.position.y = 2;
        overlay.add(removeHighlight);
      }
      return;
    }
    if (tool.type === 'signal') {
      hover.visible = true;
      hover.material.color.set(COLORS.signal[tool.color]);
      hover.scale.set(0.3, 1, 0.5);
      hover.position.set(s.signalX, 1.5, s.cellZ + CELL / 2);
      return;
    }
    if (FULL_ZONES.includes(tool.type)) {
      const range = pending ? spanTo(s) : { z0: s.cellZ, z1: s.cellZ + CELL };
      span.visible = true;
      span.material.color.set(COLORS[tool.type]);
      span.scale.set(ZONE_WIDTH / 17, 1, range.z1 - range.z0);
      span.position.set(0, 1.4, (range.z0 + range.z1) / 2);
      const tiles = Math.round((range.z1 - range.z0) / CELL);
      setInfo(pending ? `${zoneLabel(tool.type)} over ${tiles} tiles · click the end (Esc cancels)` : `Click where the ${zoneLabel(tool.type)} zone starts`);
      return;
    }
    if (tool.type === 'coins') {
      // One track: the start's (before the first click, a single coin)
      const lane = pending?.lane ?? s.lane;
      const range = pending ? spanTo(s) : { z0: s.cellZ, z1: s.cellZ + CELL };
      span.visible = true;
      span.material.color.set(COLORS.coins);
      span.scale.set(6 / 17, 1, range.z1 - range.z0);
      span.position.set(lane, 1.4, (range.z0 + range.z1) / 2);
      const n = coinPositions({ ...range, spacing: tool.spacing }).length;
      setInfo(pending ? `${n} coin${n > 1 ? 's' : ''} · release, or click the end (Esc cancels)` : 'Drag along a track for a line of coins, or click its start then its end');
      return;
    }
    if (tool.type === 'coinArc') {
      // The arc's stretch, centered on the tile
      const coins = arcPositions({ z: s.cellZ + CELL / 2 }, ctx.getCatalog().coinPatterns?.arcs?.[0]);
      span.visible = true;
      span.material.color.set(COLORS.coins);
      span.scale.set(6 / 17, 1, coins.at(-1).z - coins[0].z);
      span.position.set(s.lane, 1.4, s.cellZ + CELL / 2);
      setInfo('Click the tile the arc centers on (the game puts it about 3 tiles past a jump barrier)');
      return;
    }
    if (tool.type === 'noTracks' && pending) {
      // Every track between the start's and this one
      const range = spanTo(s);
      const [x0, x1] = [Math.min(pending.lane, s.lane), Math.max(pending.lane, s.lane)];
      span.visible = true;
      span.material.color.set(COLORS.noTracks);
      span.scale.set((x1 - x0 + 19) / 17, 1, range.z1 - range.z0);
      span.position.set((x0 + x1) / 2, 1.4, (range.z0 + range.z1) / 2);
      const tracks = LANES.filter((x) => x >= x0 && x <= x1).length;
      setInfo(`No tracks over ${Math.round((range.z1 - range.z0) / CELL)} tiles × ${tracks} track${tracks > 1 ? 's' : ''} · release, or click the end (Esc cancels)`);
      return;
    }
    if (!s.laneOk) return;
    if (tool.type === 'train') {
      // Before the first click a train shows its shortest size; afterwards its snapped size
      let range;
      if (!pending) range = { z0: s.cellZ, z1: s.cellZ + trainSpan({ ...tool, z0: 0, z1: 0 }) };
      else if (s.lane === pending.lane) range = spanTo(s);
      else return;
      span.visible = true;
      span.material.color.set(COLORS.train);
      span.scale.set(1, 1, range.z1 - range.z0);
      span.position.set(s.lane, 1.4, (range.z0 + range.z1) / 2);
      const tiles = Math.ceil((range.z1 - range.z0) / CELL - 0.01);
      if (pending) {
        setInfo(`${describeTrain({ ...tool, ...range })} · ${tiles} tiles · click the end (Esc cancels)`);
      } else {
        setInfo(`${describeTrain({ ...tool, ...range })} takes ${tiles} tiles · click the start tile`);
      }
      return;
    }
    hover.visible = true;
    hover.material.color.set(COLORS.hover);
    if (tool.type === 'pickup') {
      hover.material.color.set(COLORS.pickup);
      hover.scale.set(7 / 18, 1, 7 / (CELL - 1));
      hover.position.set(s.lane, 1.5, s.cellZ + CELL / 2);
      return;
    }
    if (tool.type === 'obstacle') {
      // The piece's real footprint where it would go
      const cat = ctx.getCatalog();
      const r = rectOf({ key: tool.key, lane: cat.sizes?.[tool.key]?.wide ? 0 : s.lane, z: s.cellZ + CELL / 2 }, cat);
      hover.scale.set(Math.max(r.x1 - r.x0, 4) / 18, 1, Math.max(r.z1 - r.z0, 4) / (CELL - 1));
      hover.position.set((r.x0 + r.x1) / 2, 1.5, (r.z0 + r.z1) / 2);
      return;
    }
    hover.scale.set(1, 1, 1);
    hover.position.set(s.lane, 1.5, s.cellZ + CELL / 2);
  }

  // ------------------------------------------------------------ editing
  function apply(s) {
    const list = [...ctx.getList()];
    if (tool.type === 'edit') {
      selected = itemAt(s); // pieces first, then the zone under them
      drawFootprints();
      renderPalette();
      setInfo(selected >= 0 ? describeItem(list[selected]) : 'Click something to edit it');
      return;
    }
    if (tool.type === 'remove') {
      const i = itemAt(s);
      if (i >= 0) {
        list.splice(i, 1);
        commit(list, 'Removed');
      }
      return;
    }
    if (tool.type === 'signal') {
      // One light per spot: clicking an occupied spot recolors it
      const i = list.findIndex((it) => it.type === 'signal' && it.x === s.signalX && cellOf(it.z) === s.cell);
      if (i >= 0) list[i] = { ...list[i], color: tool.color };
      else list.push({ type: 'signal', x: s.signalX, z: s.cellZ + CELL / 2, color: tool.color });
      return commit(list);
    }
    if (FULL_ZONES.includes(tool.type)) {
      if (!pending) {
        pending = { lane: 0, cellZ: s.cellZ };
        return setInfo('Zone start set: click its end');
      }
      const { z0, z1 } = spanTo(s);
      pending = null;
      span.visible = false;
      // Overlapping zones merge into one
      let zone = { type: tool.type, z0, z1, ...(tool.type === 'challenge' ? { lane: tool.lane ?? 0 } : {}) };
      const rest = list.filter((it) => {
        if (it.type !== zone.type || !overlaps(zone.z0, zone.z1, it.z0 - 0.1, it.z1 + 0.1)) return true;
        zone = { ...zone, z0: Math.min(zone.z0, it.z0), z1: Math.max(zone.z1, it.z1) };
        return false;
      });
      return commit([...rest, zone]);
    }
    if (tool.type === 'noTracks') return removeTracks(s);
    if (tool.type === 'coins') return addCoins(s);
    if (!s.laneOk) return;
    if (tool.type === 'pickup' || tool.type === 'coinArc') {
      // One per tile: clicking a taken one swaps it
      const next = { type: tool.type, lane: s.lane, z: s.cellZ + CELL / 2, ...pickupOptions(tool) };
      const i = list.findIndex((it) => it.type === tool.type && it.lane === s.lane && cellOf(it.z) === s.cell);
      if (i >= 0) list[i] = next;
      else list.push(next);
      return commit(list);
    }
    if (tool.type === 'train') {
      if (!pending) {
        pending = { lane: s.lane, cellZ: s.cellZ };
        setInfo('Start set: click the end tile on the same track');
        return;
      }
      if (s.lane !== pending.lane) return setInfo('The end must be on the same track as the start');
      const { z0, z1 } = spanTo(s);
      pending = null;
      span.visible = false;
      {
        const blocker = list.find((it) => (it.type === 'train' || it.type === 'startTrain') && it.lane === s.lane && overlaps(z0, z1, it.z0 ?? it.z - 30, it.z1 ?? it.z + 100));
        if (blocker) return setInfo('Another train already uses these tiles');
        // "Any" picks a skin now, so the train keeps it from then on
        const variants = ctx.getCatalog().variants[tool.kind] ?? [];
        const variant = tool.variant !== 'auto' || !variants.length ? tool.variant : variants[Math.floor(Math.random() * variants.length)];
        list.push({ type: 'train', lane: s.lane, z0, z1, kind: tool.kind, variant, ramp: !!(tool.ramp && ctx.getCatalog().ramp) });
        return commit(list);
      }
    }
    // Obstacles: max one of each kind per tile; pieces across the track sit on the middle one
    const lane = ctx.getCatalog().sizes?.[tool.key]?.wide ? 0 : s.lane;
    const taken = list.some((it) => it.type === 'obstacle' && it.key === tool.key && it.lane === lane && cellOf(it.z) === s.cell);
    if (taken) return setInfo(`There is already a ${labelOf(tool.key, ctx.getCatalog()).toLowerCase()} on this tile`);
    const state = ctx.getCatalog().statePieces?.includes(tool.key) ? { state: tool.state ?? 'revealed' } : {};
    list.push({ type: 'obstacle', key: tool.key, lane, z: s.cellZ + CELL / 2, ...state });
    commit(list);
  }

  /** "No tracks" from the start (pending) to s: every track in between, over the tiles between. */
  function removeTracks(s) {
    const { z0, z1 } = spanTo(s);
    const [x0, x1] = [Math.min(pending.lane, s.lane), Math.max(pending.lane, s.lane)];
    pending = null;
    span.visible = false;
    let list = [...ctx.getList()];
    for (const lane of LANES.filter((x) => x >= x0 && x <= x1)) {
      // Overlapping zones on a track merge into one
      let zone = { type: 'noTracks', lane, z0, z1 };
      list = list.filter((it) => {
        if (it.type !== 'noTracks' || it.lane !== lane || !overlaps(zone.z0, zone.z1, it.z0 - 0.1, it.z1 + 0.1)) return true;
        zone = { ...zone, z0: Math.min(zone.z0, it.z0), z1: Math.max(zone.z1, it.z1) };
        return false;
      });
      list.push(zone);
    }
    commit(list);
  }

  /** What a pickup tool puts on its items: the pickup, its letter or hunt token, the coins' skin and spacing. */
  function pickupOptions(t) {
    const cat = ctx.getCatalog();
    return {
      ...(t.key ? { key: t.key } : {}),
      ...(t.coin && t.coin !== 'Coin' ? { coin: t.coin } : {}),
      ...(t.spacing && t.spacing !== COIN_SPACING ? { spacing: t.spacing } : {}),
      ...(cat.letterPickups.includes(t.key) ? { letter: t.letter ?? 'A' } : {}),
      ...(t.key === 'SeasonToken' && cat.huntTokens.length ? { token: t.token ?? cat.huntTokens[0] } : {}),
    };
  }

  /** A line of coins from the start (pending) to s, on the start's track; lines that meet (alike) merge. */
  function addCoins(s) {
    const { z0, z1 } = spanTo(s);
    const lane = pending.lane;
    pending = null;
    span.visible = false;
    let line = { type: 'coins', lane, z0, z1, ...pickupOptions(tool) };
    const alike = (it) => (it.coin ?? 'Coin') === (line.coin ?? 'Coin') && (it.spacing ?? COIN_SPACING) === (line.spacing ?? COIN_SPACING);
    const list = ctx.getList().filter((it) => {
      if (it.type !== 'coins' || it.lane !== lane || !alike(it) || !overlaps(line.z0, line.z1, it.z0 - 0.1, it.z1 + 0.1)) return true;
      line = { ...line, z0: Math.min(line.z0, it.z0), z1: Math.max(line.z1, it.z1) };
      return false;
    });
    commit([...list, line]);
  }

  function commit(list, verb = 'Placed') {
    if (selected >= list.length) selected = -1;
    ctx.setList(list);
    drawFootprints();
    setInfo(`${verb} · ${list.length} item${list.length === 1 ? '' : 's'}`);
  }

  // ------------------------------------------------------------ input
  let dragFrom = null;
  const DRAG_TOOLS = ['noTracks', 'coins'];
  canvas.addEventListener('pointerdown', (e) => {
    if (!active || e.button !== 0) return;
    dragFrom = { x: e.clientX, y: e.clientY, viewZ, moved: false };
    // "No tracks" and coins: a drag selects tiles (no tracks: across tracks too); a click
    // then a click works as well
    const s = DRAG_TOOLS.includes(tool.type) && pick(e);
    if (s) {
      dragFrom.select = true;
      dragFrom.second = !!pending;
      pending ??= { lane: s.lane, cellZ: s.cellZ };
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!active) return;
    if (dragFrom) {
      const dy = e.clientY - dragFrom.y;
      if (Math.abs(dy) > 4 || Math.abs(e.clientX - dragFrom.x) > 4) dragFrom.moved = true;
      if (dragFrom.moved && !dragFrom.select) {
        viewZ = dragFrom.viewZ + ((dy / canvas.clientHeight) * (cam.top - cam.bottom)) / Math.cos(TILT);
        updateCamera();
      }
    }
    onMove(e);
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!active || !dragFrom) return;
    const wasDrag = dragFrom.moved;
    const from = dragFrom;
    dragFrom = null;
    if (from.select) {
      const s = pick(e);
      if (pending && s && (wasDrag || from.second)) {
        if (tool.type === 'coins') addCoins(s);
        else removeTracks(s);
      } else if (pending) setInfo(tool.type === 'coins' ? 'Start set: click the end on the same track' : 'Start set: drag, or click the end (across tracks too)');
      onMove(e);
      return;
    }
    const s = !wasDrag && pick(e);
    if (s) {
      apply(s);
      onMove(e);
    }
  });
  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!active) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) zoom = THREE.MathUtils.clamp(zoom * (e.deltaY > 0 ? 0.9 : 1.1), 0.3, 5);
      else viewZ -= (e.deltaY * 0.6) / zoom;
      updateCamera();
    },
    { passive: false },
  );
  addEventListener('keydown', (e) => {
    if (!active || e.code !== 'Escape' || !pending) return;
    pending = null;
    span.visible = false;
    setInfo('Cancelled');
    e.stopPropagation();
  });
  addEventListener('resize', () => active && updateCamera());

  // ------------------------------------------------------------ palette (DOM)
  const info = el('span', { class: 'studio-info' });
  const setInfo = (t) => (info.textContent = t);
  // Bottom main bar (modes) with a context bar above it that only appears when needed:
  // the asset categories and the chosen category's assets, together
  const contextBar = el('div', { class: 'studio-bar studio-context hidden' });
  const mainBar = el('div', { class: 'studio-bar studio-main' });
  const palette = el('div', { class: 'studio-palette hidden' }, contextBar, mainBar);
  ctx.root.append(palette);

  function setTool(t) {
    if (TRACK_TOOLS.includes(t.type)) trackTool = t;
    else if (!['edit', 'remove'].includes(t.type)) placeTool = t;
    tool = t;
    pending = null;
    selected = -1;
    drawFootprints();
    span.visible = false;
    updateSpotVisibility();
    renderPalette();
  }

  // Main bar modes; each shows its own tools in the bar above
  const MODES = [
    ['place', '✏️ Place'],
    ['edit', '✋ Edit'],
    ['track', '🛤 Track'],
    ['remove', '🗑 Remove'],
  ];
  // Track: the run's zones (no tracks, challenge, activated floor) and its auto-run actions
  const TRACK_TOOLS = ['noTracks', ...FULL_ZONES];
  const modeOf = (t) => (TRACK_TOOLS.includes(t.type) ? 'track' : ['edit', 'remove'].includes(t.type) ? t.type : 'place');
  let trackTool = { type: 'noTracks' }; // the Track mode's last zone tool

  let fixKeys = null; // "Fix …" buttons for the run on screen (worked out again when it changes)
  function renderPalette() {
    const cat = ctx.getCatalog();
    fixKeys ??= ctx.fixables();
    const mode = modeOf(tool);
    const btn = (label, on, onclick, cls = '') => el('button', { class: `tool ${cls} ${on ? 'active' : ''}`, onclick }, label);
    const select = (value, options, onchange) =>
      el('select', { onchange: (e) => onchange(e.target.value) }, ...options.map(([v, label]) => el('option', { value: v, selected: v === value }, label)));
    const row = (label, ...children) => el('div', { class: 'studio-row' }, el('span', { class: 'studio-label' }, label), ...children);

    // Context bar (above): only what the current mode needs
    const rows = [];

    let categoryRow = null;
    if (mode === 'place') {
      const isTool = (type, extra = {}) => tool.type === type && Object.entries(extra).every(([k, v]) => tool[k] === v);
      const variants = tool.type === 'train' ? cat.variants[tool.kind] ?? [] : [];
      const modeKeys = Object.keys(cat.modePieces).filter((k) => !cat.trainPieces.includes(k));
      const categories = [
        ['trains', '🚆 Trains', () => setTool({ type: 'train', kind: Object.keys(cat.trains)[0] ?? 'static', variant: 'auto', ramp: false })],
        ['obstacles', '🚧 Obstacles', () => setTool({ type: 'obstacle', key: Object.keys(cat.obstacles)[0] })],
        ...(Object.keys(cat.walls).length ? [['walls', '🧱 Walls', () => setTool({ type: 'obstacle', key: Object.keys(cat.walls)[0] })]] : []),
        ...(cat.signal ? [['lights', '🚦 Lights', () => setTool({ type: 'signal', color: 'green' })]] : []),
        // Coins, power-ups, boxes and tokens
        ...(cat.pickups.length ? [['pickups', '🪙 Pickups', () => setTool(cat.pickups.includes('Coin') ? { type: 'coins' } : { type: 'pickup', key: cat.pickups[0] })]] : []),
        // The game mode's own pieces (moving/vanishing obstacles, hurdles, speed pads…)
        ...(modeKeys.length ? [['mode', cat.modeLabel, () => setTool({ type: 'obstacle', key: modeKeys[0] })]] : []),
      ];
      categoryRow = el(
        'div',
        { class: 'studio-row studio-categories' },
        el('span', { class: 'studio-label' }, 'Place'),
        ...categories.map(([key, label, first]) =>
          btn(label, category === key, () => {
            category = key;
            // Keep the asset already chosen in that family, else its first one
            const family = familyOf(cat)[key];
            const keep =
              key === 'trains' ? placeTool.type === 'train' || isTrainPiece(placeTool.key, cat)
              : key === 'lights' ? placeTool.type === 'signal'
              : key === 'pickups' ? isPickup(placeTool)
              : placeTool.type === 'obstacle' && family?.includes(placeTool.key);
            if (keep) setTool(placeTool);
            else first();
          }),
        ),
      );
      if (category === 'trains') rows.push(
        row(
          'Trains',
          ...Object.entries(cat.trains).map(([kind, cars]) =>
            btn(`${KIND_LABELS[kind]} (${cars.join('/')} cars)`, isTool('train', { kind }), () =>
              setTool({ type: 'train', kind, variant: cat.variants[kind]?.includes(tool.variant) ? tool.variant : 'auto', ramp: kind === 'static' && !!tool.ramp }),
            ),
          ),
          variants.length > 1
            ? select(tool.variant, [['auto', VARIANT_LABELS.auto], ...variants.map((v) => [v, VARIANT_LABELS[v]])], (v) => (tool = placeTool = { ...tool, variant: v }))
            : null,
          tool.type === 'train' && cat.ramp && tool.kind === 'static'
            ? el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: tool.ramp, onchange: (e) => (tool = placeTool = { ...tool, ramp: e.target.checked }) }), 'ramp')
            : null,
        ),
      );
      if (category === 'trains' && cat.trainPieces.length) rows.push(row('Platforms', ...cat.trainPieces.map((key) => btn(labelOf(key, cat), isTool('obstacle', { key }), () => setTool({ type: 'obstacle', key })))));
      if (category === 'walls') rows.push(row('Walls', ...Object.keys(cat.walls).map((key) => btn(LABELS[key] ?? key, isTool('obstacle', { key }), () => setTool({ type: 'obstacle', key })))));
      if (category === 'obstacles') rows.push(row('Obstacles', ...Object.keys(cat.obstacles).map((key) => btn(LABELS[key] ?? key, isTool('obstacle', { key }), () => setTool({ type: 'obstacle', key })))));
      if (category === 'mode') {
        rows.push(row(cat.modeLabel, ...modeKeys.map((key) => btn(cat.modePieces[key], isTool('obstacle', { key }), () => setTool({ type: 'obstacle', key, state: tool.state ?? 'revealed' })))));
        // Two-state pieces (No Floor's blockers): raised, dropped or dropping over and over
        if (tool.type === 'obstacle' && cat.statePieces?.includes(tool.key)) {
          rows.push(row('State', ...PIECE_STATES.map(([state, label]) => btn(label, (tool.state ?? 'revealed') === state, () => setTool({ ...tool, state })))));
        }
      }
      if (category === 'lights') rows.push(row('Lights', ...SIGNAL_TOOLS.map(([color, label]) => btn(label, isTool('signal', { color }), () => setTool({ type: 'signal', color })))));
      if (category === 'pickups') {
        // Coins: lines (regular or close) and jump arcs, of any coin the map has
        if (cat.pickups.includes('Coin')) {
          const coinTool = (type) => ({ type, coin: tool.coin ?? 'Coin', spacing: tool.spacing ?? COIN_SPACING });
          rows.push(
            row(
              'Coins',
              btn('🪙 Coin line', tool.type === 'coins', () => setTool(coinTool('coins'))),
              btn('⤴️ Jump arc', tool.type === 'coinArc', () => setTool(coinTool('coinArc'))),
              ...coinOptions(cat, tool, select, (changes) => setTool({ ...tool, ...changes })),
            ),
          );
        }
        const pickupButtons = (labels) =>
          Object.entries(labels)
            .filter(([key]) => cat.pickups.includes(key))
            .map(([key, label]) => btn(label, isTool('pickup', { key }), () => setTool({ type: 'pickup', key, letter: tool.letter, token: tool.token })));
        for (const [group, labels] of PICKUP_GROUPS) {
          const buttons = pickupButtons(labels);
          // The chosen pickup's own settings next to it: a hunt letter, the season's token
          const own = tool.type === 'pickup' && tool.key in labels ? pickupSettings(cat, tool, select, (changes) => setTool({ ...tool, ...changes })) : [];
          if (buttons.length) rows.push(row(group, ...buttons, ...own));
        }
      }
    } else if (mode === 'edit' && selected >= 0) {
      rows.push(editRow(cat, btn, select));
    } else if (mode === 'track') {
      const zoneTools = [
        ...(cat.tracks !== false ? [['noTracks', '🚧 Remove track']] : []),
        ...(ctx.zoneKinds?.() ?? []).map((k) => [k.type, `${k.label} zone`]),
      ];
      const plural = (n, what) => `${n} ${what}${n === 1 ? '' : 's'}`;
      // What Fix did: put back, taken out (old ones, wherever they were), cleared out of the way
      const done = ({ placed, removed, cleared }, what) =>
        setInfo(
          placed
            ? [`Placed ${plural(placed, what)}`, removed ? `removed ${removed} old` : null, cleared ? `cleared ${plural(cleared, 'piece')} in the way` : null].filter(Boolean).join(' · ')
            : `No ${what}s to place in this run${removed ? ` · removed ${removed} old` : ''}`,
        );
      rows.push(
        row(
          'Track',
          ...zoneTools.map(([type, label]) => btn(label, tool.type === type, () => setTool({ type, lane: trackTool.lane ?? 0 }))),
          // The lane the zone's runner loops along (the snow's trench, the grass and colors follow it)
          ...(tool.type === 'challenge'
            ? [
                el('span', { class: 'studio-label' }, 'Runner'),
                ...RUNNER_LANES.map(([x, label]) => btn(label, (tool.lane ?? 0) === x, () => setTool({ ...tool, lane: x }))),
              ]
            : []),
          el('span', { class: 'studio-sep' }),
          // Obstacles the auto run has and the studio list may lack (pillars, platforms…)
          ...fixKeys.map((key) =>
            el('button', { title: FIX_TITLES[key], onclick: () => (done(ctx.fixMissing(key), LABELS[key].toLowerCase()), drawFootprints()) }, FIX_LABELS[key]),
          ),
          el('button', { title: 'Replace everything with the auto-generated run', onclick: async () => commit(await ctx.fromRun(), 'Copied the auto-generated run') }, '⟳ Copy auto run'),
        ),
      );
    } else if (mode === 'remove') {
      rows.push(
        row(
          'Remove',
          el('span', { class: 'studio-info' }, 'Click something to remove it'),
          el('span', { class: 'studio-sep' }),
          btn('💥 Wipe', false, () => confirm('Remove everything placed, including zones?') && commit([], 'Wiped'), 'danger'),
        ),
      );
    }
    if (categoryRow) rows.push(categoryRow); // under the chosen category's assets, by the main bar
    contextBar.replaceChildren(...rows);
    contextBar.classList.toggle('hidden', !rows.length);

    // Main bar (bottom): modes, status, game mode, done
    const hints = {
      place: 'Pick an asset above, then click the tiles',
      edit: 'Click a train, obstacle, light, pickup or zone to change it',
      remove: 'Click something to remove it',
      challenge: "Pick the runner's lane, then click the start then the end of the stretch where the challenge loops",
      noTracks: 'Drag over the tiles (across tracks too), or click the start then the end',
      surge: 'Click the start then the end of the stretch where the floor is activated',
    };
    const hintKey = mode === 'track' ? tool.type : mode;
    if (!info.textContent || info.dataset.mode !== hintKey) {
      info.textContent = hints[hintKey];
      info.dataset.mode = hintKey;
    }
    const pickMode = (m) => setTool(m === 'place' ? placeTool : m === 'track' ? trackTool : { type: m });
    mainBar.replaceChildren(
      el(
        'div',
        { class: 'studio-row studio-modes' },
        ...MODES.map(([m, label]) => btn(label, mode === m, () => pickMode(m), m === 'remove' ? 'danger' : '')),
        info,
        el('span', { class: 'studio-sep' }),
        // Game mode (and skin): which pieces the run uses and the palette offers
        ...modeSelects(select),
        el('button', { class: 'primary', onclick: () => ctx.onExit() }, 'Done'),
      ),
      el('div', { class: 'studio-row studio-status' }, el('span', { class: 'studio-hint' }, 'Drag or wheel: scroll · Ctrl+wheel: zoom · Esc: cancel')),
    );
  }

  function modeSelects(select) {
    const cat = ctx.getCatalog();
    if (cat.modes.length < 2) return [];
    const { mode, skin, skins } = ctx.getMode();
    const busy = (e) => (e.target.disabled = true);
    const modeSelect = select(mode, cat.modes.map((m) => [m.key, m.label]), (key) => ctx.setMode(key));
    modeSelect.title = 'Game mode';
    modeSelect.addEventListener('change', busy);
    if (skins.length < 2) return [modeSelect];
    const skinSelect = select(skin, skins, (s) => ctx.setMode(mode, s));
    skinSelect.title = 'Skin';
    skinSelect.addEventListener('change', busy);
    return [modeSelect, skinSelect];
  }

  /** Palette families of obstacle-like pieces, by category. */
  function familyOf(cat) {
    return {
      trains: cat.trainPieces,
      obstacles: Object.keys(cat.obstacles),
      walls: Object.keys(cat.walls),
      mode: Object.keys(cat.modePieces).filter((k) => !cat.trainPieces.includes(k)),
    };
  }

  const SIGNAL_TOOLS = [
    ['green', '🟢 Green'],
    ['red', '🔴 Red'],
    ['off', '⚫ Off'],
  ];

  /**
   * The game's coin line spacings: the usual one and the closest (CoinLineSpawner: 3 over 60,
   * 30 apart; 5 over 100, 25 apart).
   */
  function coinSpacings(cat) {
    const gaps = (cat.coinPatterns?.lines ?? []).filter((l) => l.items > 1).map((l) => Math.round((l.length / (l.items - 1)) * 10) / 10);
    if (!gaps.length) return [[COIN_SPACING, 'Regular'], [25, 'Close']];
    const count = (g) => gaps.filter((x) => x === g).length;
    const regular = gaps.reduce((a, b) => (count(b) > count(a) ? b : a));
    const close = Math.min(...gaps);
    return close < regular ? [[regular, 'Regular'], [close, 'Close']] : [[regular, 'Regular']];
  }

  /** A coin tool's or item's settings: spacing (lines), which coins (when the map has several). */
  function coinOptions(cat, it, select, change) {
    const out = [];
    if (it.type === 'coins') {
      const spacings = coinSpacings(cat);
      const current = it.spacing ?? COIN_SPACING;
      if (spacings.length > 1) {
        const s = select(String(current), spacings.map(([v, label]) => [String(v), `${label} · ${v} apart`]), (v) => change({ spacing: Number(v) }));
        s.title = 'Spacing';
        out.push(s);
      }
    }
    const skins = Object.keys(COIN_SKINS).filter((k) => cat.pickups.includes(k));
    if (skins.length > 1) {
      const s = select(it.coin ?? 'Coin', skins.map((k) => [k, COIN_SKINS[k]]), (coin) => change({ coin }));
      s.title = 'Coins';
      out.push(s);
    }
    return out;
  }

  /** A pickup's own settings: a hunt letter's letter, the season token's hunt token. */
  function pickupSettings(cat, it, select, change) {
    if (cat.letterPickups.includes(it.key)) {
      const s = select(it.letter ?? 'A', LETTERS.map((l) => [l, `Letter ${l}`]), (letter) => change({ letter }));
      s.title = 'Letter';
      return [s];
    }
    if (it.key === 'SeasonToken' && cat.huntTokens.length) {
      const s = select(it.token ?? cat.huntTokens[0], [...cat.huntTokens, 'point'].map((n) => [n, tokenLabel(n)]), (token) => change({ token }));
      s.title = 'Hunt token';
      return [s];
    }
    return [];
  }

  /** Settings of the selected item (edit mode). */
  function editRow(cat, btn, select) {
    const it = ctx.getList()[selected];
    const row = (...children) => el('div', { class: 'studio-row edit-row' }, el('span', { class: 'studio-label' }, 'Edit'), ...children);
    const del = el('button', { class: 'danger', onclick: deleteSelected }, 'Delete');
    if (!it) return row(el('span', { class: 'studio-info' }, 'Click a train, obstacle, light, pickup or zone to change it'));

    if (it.type === 'obstacle') {
      // A piece turns into the others of its family (obstacles, walls, platforms, mode pieces)
      const family = Object.values(familyOf(cat)).find((keys) => keys.includes(it.key)) ?? Object.keys(cat.obstacles);
      const states = cat.statePieces?.includes(it.key)
        ? [el('span', { class: 'studio-label' }, 'State'), ...PIECE_STATES.map(([state, label]) => btn(label, (it.state ?? 'revealed') === state, () => replaceSelected({ ...it, state })))]
        : [];
      return row(...family.map((key) => btn(labelOf(key, cat), it.key === key, () => editObstacle(key))), ...states, del);
    }
    if (it.type === 'pickup') {
      // A pickup turns into any other (with a letter or hunt token where it takes one)
      const turn = (key) => replaceSelected({ type: 'pickup', lane: it.lane, z: it.z, ...pickupOptions({ ...it, key }) });
      return row(
        ...cat.pickups.filter((key) => !(key in COIN_SKINS)).map((key) => btn(PICKUP_LABELS[key] ?? key, it.key === key, () => turn(key))),
        ...pickupSettings(cat, it, select, (changes) => replaceSelected({ ...it, ...changes })),
        del,
      );
    }
    if (it.type === 'coins' || it.type === 'coinArc') {
      const edit = (changes) => {
        const next = { ...it, ...changes };
        if (next.coin === 'Coin') delete next.coin;
        if (next.spacing === COIN_SPACING) delete next.spacing;
        replaceSelected(next);
      };
      return row(el('span', { class: 'studio-info' }, describeItem(it)), ...coinOptions(cat, it, select, edit), del);
    }
    if (it.type === 'signal') {
      return row(...SIGNAL_TOOLS.map(([color, label]) => btn(label, (it.color ?? 'green') === color, () => replaceSelected({ ...it, color }))), del);
    }
    if (it.type === 'challenge') {
      // The lane its runner loops along
      return row(
        el('span', { class: 'studio-info' }, describeItem(it)),
        el('span', { class: 'studio-label' }, 'Runner'),
        ...RUNNER_LANES.map(([x, label]) => btn(label, (it.lane ?? 0) === x, () => replaceSelected({ ...it, lane: x }))),
        del,
      );
    }
    if (it.type !== 'train') return row(el('span', { class: 'studio-info' }, describeItem(it)), del);

    const options = carOptions(it.kind);
    const cars = carsOf(it);
    const at = options.indexOf(cars);
    const variants = cat.variants[it.kind] ?? [];
    // A placed train has a definite skin (older "Any" placements: the one on screen)
    const current = variants.includes(it.variant) ? it.variant : ctx.actualVariant?.(it) ?? variants[0];
    const variantFor = (kind) => (cat.variants[kind]?.includes(current) ? current : cat.variants[kind]?.[0] ?? 'auto');
    return row(
      ...Object.keys(cat.trains).map((kind) => btn(KIND_LABELS[kind], it.kind === kind, () => editTrain({ kind, variant: variantFor(kind) }))),
      variants.length > 1 ? select(current, variants.map((v) => [v, VARIANT_LABELS[v]]), (v) => editTrain({ variant: v })) : null,
      el('button', { disabled: at <= 0, title: 'Shorter', onclick: () => editTrain({ cars: options[at - 1] }) }, '−'),
      el('span', { class: 'cars' }, `${cars} car${cars > 1 ? 's' : ''}`),
      el('button', { disabled: at >= options.length - 1, title: 'Longer', onclick: () => editTrain({ cars: options[at + 1] }) }, '+'),
      cat.ramp && it.kind === 'static'
        ? el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: it.ramp, onchange: (e) => editTrain({ ramp: e.target.checked }) }), 'ramp')
        : null,
      del,
    );
  }

  const clip = [new THREE.Plane(new THREE.Vector3(0, -1, 0), CLIP_HEIGHT)];
  return {
    get active() {
      return active;
    },
    camera: cam,
    /** The bottom palette: other bars (time) stack on top of it while the studio is open. */
    palette,
    enter() {
      active = true;
      fixKeys = null; // (the run may have changed since the studio was last open)
      overlay.visible = true;
      renderer.clippingPlanes = clip; // stations and tunnels would hide the tracks
      buildSpots();
      drawFootprints();
      renderPalette();
      palette.classList.remove('hidden');
      // Open over the stretch the 3D camera was looking at
      viewZ = ctx.getFocusZ?.() ?? viewZ;
      updateCamera();
      setInfo(`${ctx.getList().length} items · pick a tool, then click the tiles`);
    },
    exit() {
      active = false;
      overlay.visible = false;
      renderer.clippingPlanes = [];
      pending = null;
      palette.classList.add('hidden');
    },
    /** Call after the game mode changed: its pieces and "Fix …" buttons. */
    refresh() {
      if (!active) return;
      const cat = ctx.getCatalog();
      const modeKeys = familyOf(cat).mode;
      const valid = tool.type !== 'obstacle' || Object.values(familyOf(cat)).some((keys) => keys.includes(tool.key));
      fixKeys = null;
      // A zone tool the new mode doesn't offer (the activated floor outside No Floor)
      if (FULL_ZONES.includes(tool.type) && !ctx.zoneKinds?.().some((k) => k.type === tool.type)) tool = trackTool = { type: 'noTracks' };
      if (category === 'mode' && modeKeys.length && !(placeTool.key in cat.modePieces)) setTool({ type: 'obstacle', key: modeKeys[0] });
      else if (!valid || (category === 'mode' && !modeKeys.length)) {
        category = 'trains';
        setTool({ type: 'train', kind: Object.keys(cat.trains)[0] ?? 'static', variant: 'auto', ramp: false });
      } else renderPalette();
      drawFootprints();
    },
    /** Call after the run is regenerated (length may change). */
    relayout() {
      if (!active) return;
      buildSpots();
      drawFootprints();
      updateCamera();
      // The run changed (seed, sections…): its pillar halls and stations may have too
      const keys = ctx.fixables();
      if (keys.join() !== fixKeys?.join()) {
        fixKeys = keys;
        renderPalette();
      }
    },
  };
}
