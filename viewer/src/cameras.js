// Saved camera spots: drop the fly camera's position, heading and field of view, come back
// to it later. Kept per environment in this browser, like the studio's placements.

export const MAX_SPOTS = 20;

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

/**
 * Bottom work bar like Generation, View and Time, opened from the toolbar's Cameras button
 * (C / 5): a Drop button and one chip per saved spot (click: go there, ×: remove).
 * @param key localStorage key the spots are kept under
 * @param get () => { pos: [x, y, z], quat: [x, y, z, w], fov } of the camera now
 * @param go (spot) => moves the camera there
 * @param onOpen called before it opens (closes the other bars)
 * @param toast optional (message) => void
 * @returns {{ button, open(), close(), toggle(), isOpen() }}
 */
export function createCameraDeck(root, { key, get, go, onOpen = null, toast = null }) {
  let spots = load();
  const drop = el('button', { class: 'primary', onclick: () => add() }, '＋ Drop camera');
  const count = el('span', { class: 'cameras-count' });
  const list = el('div', { class: 'cameras-list' });
  const bar = el(
    'div',
    { class: 'studio-bar cameras-bar' },
    el(
      'div',
      { class: 'studio-row' },
      el('strong', { class: 'workbar-title' }, 'Cameras'),
      drop,
      count,
      el('span', { class: 'studio-sep' }),
      el('span', { class: 'studio-hint' }, 'Click a camera to go there'),
      el('button', { title: 'Close (C)', onclick: () => close() }, 'Done'),
    ),
    list,
  );
  const palette = el('div', { class: 'studio-palette hidden' }, bar);
  root.append(palette);
  const button = el('button', { title: 'Save camera spots and jump back to them (5)', onclick: () => toggle() }, '🎥 Cameras');
  let shown = false;

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? '[]');
      return Array.isArray(saved) ? saved.slice(0, MAX_SPOTS) : [];
    } catch {
      return [];
    }
  }
  function save() {
    try {
      localStorage.setItem(key, JSON.stringify(spots));
    } catch {}
  }

  function add() {
    if (spots.length >= MAX_SPOTS) return toast?.(`${MAX_SPOTS} cameras at most: remove one first`);
    // Numbered after the highest so far: removing #2 doesn't rename #3
    const n = Math.max(0, ...spots.map((s) => s.n ?? 0)) + 1;
    spots.push({ n, ...get() });
    save();
    render();
  }
  function remove(spot) {
    spots = spots.filter((s) => s !== spot);
    save();
    render();
  }

  function render() {
    drop.disabled = spots.length >= MAX_SPOTS;
    drop.title = drop.disabled ? `${MAX_SPOTS} cameras at most` : 'Save where the camera is now';
    count.textContent = `${spots.length} / ${MAX_SPOTS}`;
    list.replaceChildren(
      ...(spots.length
        ? spots.map((s) =>
            el(
              'div',
              { class: 'tool-group split cameras-spot' },
              el('button', { title: `Go to camera ${s.n}`, onclick: () => go(s) }, `🎥 ${s.n}`),
              el('button', { class: 'caret', title: `Remove camera ${s.n}`, onclick: () => remove(s) }, '×'),
            ),
          )
        : [el('span', { class: 'studio-info' }, 'No cameras yet: fly somewhere and drop one.')]),
    );
  }

  function open() {
    if (shown) return;
    onOpen?.();
    shown = true;
    palette.classList.remove('hidden');
    document.body.classList.add('workbar-open');
  }
  function close() {
    if (!shown) return;
    shown = false;
    palette.classList.add('hidden');
    document.body.classList.remove('workbar-open');
  }
  const toggle = () => (shown ? close() : open());
  render();

  addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'KeyC' || e.code === 'Digit5') toggle();
    else if (e.code === 'Escape') close();
  });

  return { button, open, close, toggle, isOpen: () => shown };
}
