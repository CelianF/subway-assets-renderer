// Scene clock: what animations, particles and shader effects run on. Frozen, slowed, sped up
// or stepped a frame at a time for a shot; the camera keeps real time (flyControls' own clock).

export const SPEEDS = [0.05, 0.1, 0.25, 0.5, 1, 2, 4];
export const FRAME = 1 / 60; // one step, in scene seconds at 1×

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v != null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) node.append(c.nodeType ? c : document.createTextNode(c));
  return node;
}

const label = (s) => `${s < 1 ? String(s).replace(/^0/, '') : s}×`;

export function createTime() {
  const listeners = new Set();
  const time = {
    now: 0, // scene seconds
    speed: 1,
    paused: false,
    pending: 0, // frame steps waiting for the next tick
    /** Real seconds since the last frame -> scene seconds to run this frame. */
    tick(real) {
      const dt = time.paused ? time.pending : real * time.speed;
      time.pending = 0;
      time.now += dt;
      return dt;
    },
    setPaused(paused) {
      time.paused = paused;
      changed();
    },
    toggle: () => time.setPaused(!time.paused),
    setSpeed(speed) {
      time.speed = speed;
      changed();
    },
    /** One step slower / faster through SPEEDS. */
    shift(by) {
      const i = SPEEDS.findIndex((s) => s >= time.speed);
      time.setSpeed(SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? SPEEDS.length - 1 : i) + by))]);
    },
    /** Freezes and runs n frames (at the current speed: smaller steps in slow motion). */
    step(n = 1) {
      time.paused = true;
      time.pending += n * FRAME * time.speed;
      changed();
    },
    onChange: (fn) => listeners.add(fn),
  };
  const changed = () => listeners.forEach((fn) => fn(time));
  return time;
}

/**
 * Bottom work bar like Generation, View and Studio, opened from the toolbar's Time button
 * (T / 4). In the studio it stacks on top of the studio's palette, so a shot can be framed
 * there while frozen.
 * @param host () => element the bar joins instead of standing alone (the studio palette), or null
 * @param onOpen called before it opens (closes the other bars)
 * @returns {{ button, open(), close(), toggle(), place() }}
 */
export function createTimeDeck(root, time, { host = () => null, onOpen = null } = {}) {
  const play = el('button', { class: 'time-play', onclick: () => time.toggle() });
  const step = el('button', { title: 'Next frame (.) — Shift: 10 frames', onclick: (e) => time.step(e.shiftKey ? 10 : 1) }, '⏭ Frame');
  const speeds = SPEEDS.map((s) => el('button', { class: 'tool', onclick: () => time.setSpeed(s) }, label(s)));
  const clock = el('span', { class: 'time-clock' });
  const bar = el(
    'div',
    { class: 'studio-bar time-bar' },
    el(
      'div',
      { class: 'studio-row' },
      el('strong', { class: 'workbar-title' }, 'Time'),
      play,
      step,
      el('span', { class: 'studio-label' }, 'Speed'),
      el('button', { title: 'Slower ([)', onclick: () => time.shift(-1) }, '−'),
      speeds,
      el('button', { title: 'Faster (])', onclick: () => time.shift(1) }, '+'),
      el('span', { class: 'studio-sep' }),
      clock,
      el('button', { class: 'primary', title: 'Close (T)', onclick: () => close() }, 'Done'),
    ),
  );
  // Standing alone: its own bottom palette, like the other work bars
  const palette = el('div', { class: 'studio-palette hidden' });
  root.append(palette);
  let shown = false;
  let alone = false; // shown on its own (not in the studio)
  // Toolbar button: shows the clock's state while the bar is closed
  const button = el('button', { title: 'Freeze, slow down, speed up or step time (4)', onclick: () => toggle() });

  function render() {
    play.textContent = time.paused ? '▶ Play' : '❄ Freeze';
    play.title = time.paused ? 'Play (F)' : 'Freeze (F)';
    play.classList.toggle('primary', time.paused);
    speeds.forEach((b, i) => b.classList.toggle('active', SPEEDS[i] === time.speed));
    button.textContent = time.paused ? '❄ Frozen' : time.speed !== 1 ? `⏱ ${label(time.speed)}` : '⏱ Time';
    button.classList.toggle('time-on', time.paused || time.speed !== 1);
  }
  // The scene clock, to the frame (60 a second at 1×)
  function renderClock() {
    if (shown) clock.textContent = `${time.now.toFixed(3)} s · f${Math.floor(time.now / FRAME + 1e-6)}`;
    requestAnimationFrame(renderClock);
  }
  /** Puts the bar where it belongs now: on top of the studio palette, or alone. */
  function place() {
    const into = shown ? host() : null;
    if (into) into.prepend(bar);
    else palette.append(bar);
    palette.classList.toggle('hidden', !shown || !!into);
    // Alone it's a work bar: the toolbar steps aside as for the others
    const now = shown && !into;
    if (now !== alone) document.body.classList.toggle('workbar-open', (alone = now));
  }
  function open() {
    if (shown) return;
    onOpen?.();
    shown = true;
    place();
  }
  function close() {
    if (!shown) return;
    shown = false;
    bar.remove();
    place();
  }
  const toggle = () => (shown ? close() : open());
  time.onChange(render);
  render();
  renderClock();

  addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'KeyT' || e.code === 'Digit4') toggle();
    else if (e.code === 'KeyF') time.toggle();
    else if (e.code === 'Period') time.step(e.shiftKey ? 10 : 1);
    else if (e.code === 'BracketLeft') time.shift(-1);
    else if (e.code === 'BracketRight') time.shift(1);
  });

  return { button, open, close, toggle, place, isOpen: () => shown };
}
