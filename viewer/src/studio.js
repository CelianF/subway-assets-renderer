import * as THREE from 'three';
import { fitTrain, trainLength, RAMP_LENGTH, FIX_LABELS } from './layout.js';

// Studio mode: a slightly tilted top view of the run with placement spots. Trains are
// drawn from a start cell to an end cell on one track and snap to the longest train
// that fits; obstacles take one cell; signal lights sit between two tracks; "no tracks"
// zones remove the rails of a stretch of track. Everything above the trains is clipped
// away so stations and tunnels don't hide the tracks.

const CELL = 11.25;
const ZONE_WIDTH = 62; // full-width zones: across the three tracks
// Full-width zones the map offers (ctx.zoneKinds): an event challenge (Green Jam,
// Christmas) or the No Floor mode's activated floor (spiked vines, hot lava)
const FULL_ZONES = ['challenge', 'surge'];
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
  pillar: 'Every pillar hall gets its pillars back (whatever stands in their spots is cleared)',
  platform: 'Every station gets its platforms back (whatever stands on the outer tracks there is cleared)',
};
const KIND_LABELS = { static: 'Parked', moving: 'Moving', falling: 'Lava' };
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
    laneSpots = instanced(new THREE.PlaneGeometry(16, CELL - 3).rotateX(-Math.PI / 2), 0xffffff, 0.14, LANES, 0.5);
    signalSpots = instanced(new THREE.CircleGeometry(1.8, 12).rotateX(-Math.PI / 2), COLORS.signal.green, 0.5, SIGNAL_X, 0.6);
    overlay.add(laneSpots, signalSpots);
    updateSpotVisibility();
  }

  /** Only the spots the current tool can use. */
  function updateSpotVisibility() {
    if (!laneSpots) return;
    laneSpots.visible = ['train', 'obstacle', 'noTracks', ...FULL_ZONES].includes(tool.type);
    signalSpots.visible = tool.type === 'signal';
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
    } else if (it.type === 'signal') {
      m = flat(5, 5, color ?? COLORS.signal[it.color ?? 'green'], opacity ?? 0.85);
      m.position.set(it.x, 1, it.z);
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
      } else if (it.type === 'obstacle') {
        // Anywhere on its footprint (at least its tile on its track)
        const r = rectOf(it, cat);
        const onTile = s.laneOk && it.lane === s.lane && cellOf(it.z) === s.cell;
        if (onTile || (s.x >= r.x0 && s.x <= r.x1 && s.z >= r.z0 && s.z <= r.z1)) return i;
      } else if (s.laneOk && it.lane === s.lane) {
        if ((it.type === 'train' || it.type === 'noTracks') && s.z >= it.z0 && s.z < it.z1) return i;
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
      const i = itemAt(s, { zones: false });
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
    if (!s.laneOk) return;
    if (tool.type === 'train' || (tool.type === 'noTracks' && pending)) {
      // Before the first click a train shows its shortest size; afterwards its snapped size
      let range;
      if (!pending) range = { z0: s.cellZ, z1: s.cellZ + trainSpan({ ...tool, z0: 0, z1: 0 }) };
      else if (s.lane === pending.lane) range = spanTo(s);
      else return;
      span.visible = true;
      span.material.color.set(tool.type === 'train' ? COLORS.train : COLORS.noTracks);
      span.scale.set(1, 1, range.z1 - range.z0);
      span.position.set(s.lane, 1.4, (range.z0 + range.z1) / 2);
      const tiles = Math.ceil((range.z1 - range.z0) / CELL - 0.01);
      if (pending) {
        setInfo(
          tool.type === 'train'
            ? `${describeTrain({ ...tool, ...range })} · ${tiles} tiles · click the end (Esc cancels)`
            : `No tracks over ${tiles} tiles · click the end (Esc cancels)`,
        );
      } else {
        setInfo(`${describeTrain({ ...tool, ...range })} takes ${tiles} tiles · click the start tile`);
      }
      return;
    }
    hover.visible = true;
    hover.material.color.set(COLORS.hover);
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
      selected = itemAt(s, { zones: false }); // zones aren't editable: remove and redraw them
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
      let zone = { type: tool.type, z0, z1 };
      const rest = list.filter((it) => {
        if (it.type !== zone.type || !overlaps(zone.z0, zone.z1, it.z0 - 0.1, it.z1 + 0.1)) return true;
        zone = { ...zone, z0: Math.min(zone.z0, it.z0), z1: Math.max(zone.z1, it.z1) };
        return false;
      });
      return commit([...rest, zone]);
    }
    if (!s.laneOk) return;
    if (tool.type === 'train' || tool.type === 'noTracks') {
      if (!pending) {
        pending = { lane: s.lane, cellZ: s.cellZ };
        setInfo(tool.type === 'train' ? 'Start set: click the end tile on the same track' : 'Zone start set: click its end on the same track');
        return;
      }
      if (s.lane !== pending.lane) return setInfo('The end must be on the same track as the start');
      const { z0, z1 } = spanTo(s);
      pending = null;
      span.visible = false;
      if (tool.type === 'train') {
        const blocker = list.find((it) => (it.type === 'train' || it.type === 'startTrain') && it.lane === s.lane && overlaps(z0, z1, it.z0 ?? it.z - 30, it.z1 ?? it.z + 100));
        if (blocker) return setInfo('Another train already uses these tiles');
        // "Any" picks a skin now, so the train keeps it from then on
        const variants = ctx.getCatalog().variants[tool.kind] ?? [];
        const variant = tool.variant !== 'auto' || !variants.length ? tool.variant : variants[Math.floor(Math.random() * variants.length)];
        list.push({ type: 'train', lane: s.lane, z0, z1, kind: tool.kind, variant, ramp: !!(tool.ramp && ctx.getCatalog().ramp) });
        return commit(list);
      }
      // Overlapping zones on a track merge into one
      let zone = { type: 'noTracks', lane: s.lane, z0, z1 };
      const rest = list.filter((it) => {
        if (it.type !== 'noTracks' || it.lane !== s.lane || !overlaps(zone.z0, zone.z1, it.z0 - 0.1, it.z1 + 0.1)) return true;
        zone = { ...zone, z0: Math.min(zone.z0, it.z0), z1: Math.max(zone.z1, it.z1) };
        return false;
      });
      return commit([...rest, zone]);
    }
    // Obstacles: max one of each kind per tile; pieces across the track sit on the middle one
    const lane = ctx.getCatalog().sizes?.[tool.key]?.wide ? 0 : s.lane;
    const taken = list.some((it) => it.type === 'obstacle' && it.key === tool.key && it.lane === lane && cellOf(it.z) === s.cell);
    if (taken) return setInfo(`There is already a ${labelOf(tool.key, ctx.getCatalog()).toLowerCase()} on this tile`);
    list.push({ type: 'obstacle', key: tool.key, lane, z: s.cellZ + CELL / 2 });
    commit(list);
  }

  function commit(list, verb = 'Placed') {
    if (selected >= list.length) selected = -1;
    ctx.setList(list);
    drawFootprints();
    setInfo(`${verb} · ${list.length} item${list.length === 1 ? '' : 's'}`);
  }

  // ------------------------------------------------------------ input
  let dragFrom = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (active && e.button === 0) dragFrom = { y: e.clientY, viewZ, moved: false };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!active) return;
    if (dragFrom) {
      const dy = e.clientY - dragFrom.y;
      if (Math.abs(dy) > 4) dragFrom.moved = true;
      if (dragFrom.moved) {
        viewZ = dragFrom.viewZ + ((dy / canvas.clientHeight) * (cam.top - cam.bottom)) / Math.cos(TILT);
        updateCamera();
      }
    }
    onMove(e);
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!active || !dragFrom) return;
    const wasDrag = dragFrom.moved;
    dragFrom = null;
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
    if (!['edit', 'remove', 'noTracks', ...FULL_ZONES].includes(t.type)) placeTool = t;
    tool = t;
    pending = null;
    selected = -1;
    drawFootprints();
    span.visible = false;
    updateSpotVisibility();
    renderPalette();
  }

  const MODES = [
    ['place', '✏️ Place'],
    ['edit', '✋ Edit'],
    ['remove', '🗑 Remove'],
    ['noTracks', '🚧 Remove track'],
  ];
  const modeOf = (t) => (['edit', 'remove', 'noTracks', ...FULL_ZONES].includes(t.type) ? t.type : 'place');
  const modesOf = (cat) => [...MODES.filter(([m]) => m !== 'noTracks' || cat.tracks !== false), ...(ctx.zoneKinds?.() ?? []).map((k) => [k.type, `${k.label} zone`])];

  let fixKeys = null; // "Fix …" buttons for this map (the auto run's layout, worked out once)
  let toolsOpen = false; // the tools menu of the main bar
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
            const keep = key === 'trains' ? placeTool.type === 'train' || isTrainPiece(placeTool.key, cat) : key === 'lights' ? placeTool.type === 'signal' : placeTool.type === 'obstacle' && family?.includes(placeTool.key);
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
      if (category === 'mode') rows.push(row(cat.modeLabel, ...modeKeys.map((key) => btn(cat.modePieces[key], isTool('obstacle', { key }), () => setTool({ type: 'obstacle', key })))));
      if (category === 'lights') rows.push(row('Lights', ...SIGNAL_TOOLS.map(([color, label]) => btn(label, isTool('signal', { color }), () => setTool({ type: 'signal', color })))));
    } else if (mode === 'edit' && selected >= 0) {
      rows.push(editRow(cat, btn, select));
    }
    if (categoryRow) rows.push(categoryRow); // under the chosen category's assets, by the main bar
    contextBar.replaceChildren(...rows);
    contextBar.classList.toggle('hidden', !rows.length);

    // Main bar (bottom): modes, status, done
    const hints = {
      place: 'Pick an asset above, then click the tiles',
      edit: 'Click a train, obstacle or light to change it',
      remove: 'Click something to remove it',
      noTracks: 'Click the start then the end of a stretch of track',
      challenge: 'Click the start then the end of the stretch where the challenge runs',
      surge: 'Click the start then the end of the stretch where the floor is activated',
    };
    if (!info.textContent || info.dataset.mode !== mode) {
      info.textContent = hints[mode];
      info.dataset.mode = mode;
    }
    // Tools (modes) and run-wide actions behind one button: it shows the current tool
    const current = modesOf(cat).find(([m]) => m === mode);
    const pickTool = (m) => {
      toolsOpen = false;
      setTool(m === 'place' ? placeTool : { type: m });
    };
    const action = (fn) => () => {
      toolsOpen = false;
      fn();
      renderPalette();
    };
    const toolsMenu = el(
      'div',
      { class: `studio-menu ${toolsOpen ? '' : 'hidden'}` },
      ...modesOf(cat).map(([m, label]) => btn(label, mode === m, () => pickTool(m), m === 'remove' ? 'danger' : '')),
      el('hr'),
      // Obstacles the auto run has and the studio list may lack (pillars, platforms…)
      ...fixKeys.map((key) =>
        el('button', { title: FIX_TITLES[key], onclick: action(() => { const n = ctx.fixMissing(key); drawFootprints(); setInfo(n ? `Placed ${n} ${LABELS[key].toLowerCase()}${n > 1 ? 's' : ''}` : `No ${key === 'pillar' ? 'pillar hall' : 'station'} in this run`); }) }, FIX_LABELS[key]),
      ),
      el('button', { title: 'Replace everything with the auto-generated run', onclick: action(async () => commit(await ctx.fromRun(), 'Copied the auto-generated run')) }, '⟳ Copy auto run'),
      el('button', { class: 'danger', onclick: action(() => confirm('Remove everything placed, including no-track zones?') && (setTool(tool), commit([], 'Wiped'))) }, '💥 Wipe'),
    );
    mainBar.replaceChildren(
      el(
        'div',
        { class: 'studio-row studio-modes' },
        el('div', { class: 'studio-tools' }, toolsMenu, el('button', { class: 'tool active', title: 'Tools and actions', onclick: () => ((toolsOpen = !toolsOpen), renderPalette()) }, `${current?.[1] ?? 'Tools'} ▾`)),
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

  /** Settings of the selected item (edit mode). */
  function editRow(cat, btn, select) {
    const it = ctx.getList()[selected];
    const row = (...children) => el('div', { class: 'studio-row edit-row' }, el('span', { class: 'studio-label' }, 'Edit'), ...children);
    const del = el('button', { class: 'danger', onclick: deleteSelected }, 'Delete');
    if (!it) return row(el('span', { class: 'studio-info' }, 'Click a train, obstacle or light to change it'));

    if (it.type === 'obstacle') {
      // A piece turns into the others of its family (obstacles, walls, platforms, mode pieces)
      const family = Object.values(familyOf(cat)).find((keys) => keys.includes(it.key)) ?? Object.keys(cat.obstacles);
      return row(...family.map((key) => btn(labelOf(key, cat), it.key === key, () => editObstacle(key))), del);
    }
    if (it.type === 'signal') {
      return row(...SIGNAL_TOOLS.map(([color, label]) => btn(label, (it.color ?? 'green') === color, () => replaceSelected({ ...it, color }))), del);
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
    enter() {
      active = true;
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
      if (FULL_ZONES.includes(tool.type) && !ctx.zoneKinds?.().some((k) => k.type === tool.type)) tool = placeTool;
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
    },
  };
}
