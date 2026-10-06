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
 * Floating transport bar (top right), opened from the toolbar's Time button or T.
 * Stays up over the work bars and the studio, so a shot can be framed while frozen.
 * @returns {{ button, toggle(show?) }}
 */
export function createTimeDeck(root, time) {
  const play = el('button', { class: 'time-play', onclick: () => time.toggle() });
  const step = el('button', { title: 'Next frame (.) — Shift: 10 frames', onclick: (e) => time.step(e.shiftKey ? 10 : 1) }, '⏭');
  const speeds = SPEEDS.map((s) => el('button', { class: 'tool', onclick: () => time.setSpeed(s) }, label(s)));
  const clock = el('span', { class: 'time-clock' });
  const deck = el(
    'div',
    { class: 'time-deck hidden' },
    play,
    step,
    el('span', { class: 'time-sep' }),
    el('button', { title: 'Slower ([)', onclick: () => time.shift(-1) }, '−'),
    el('div', { class: 'time-speeds' }, speeds),
    el('button', { title: 'Faster (])', onclick: () => time.shift(1) }, '+'),
    el('span', { class: 'time-sep' }),
    clock,
    el('button', { class: 'icon', title: 'Close (T)', onclick: () => toggle(false) }, '✕'),
  );
  // Toolbar button: shows the clock's state while the deck is closed
  const button = el('button', { title: 'Freeze, slow down, speed up or step time (T)', onclick: () => toggle() });
  root.append(deck);

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
    if (!deck.classList.contains('hidden')) clock.textContent = `${time.now.toFixed(3)} s · f${Math.floor(time.now / FRAME + 1e-6)}`;
    requestAnimationFrame(renderClock);
  }
  function toggle(show = deck.classList.contains('hidden')) {
    deck.classList.toggle('hidden', !show);
  }
  time.onChange(render);
  render();
  renderClock();

  addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'KeyT') toggle();
    else if (e.code === 'KeyF') time.toggle();
    else if (e.code === 'Period') time.step(e.shiftKey ? 10 : 1);
    else if (e.code === 'BracketLeft') time.shift(-1);
    else if (e.code === 'BracketRight') time.shift(1);
  });

  return { button, toggle };
}
