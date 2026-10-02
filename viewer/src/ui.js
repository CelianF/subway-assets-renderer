// Viewer chrome around the canvas: theme bar, piece browser, screenshot gallery, help.
// The detailed settings stay in the lil-gui panel (docked right).

const CATEGORY_LABELS = {
  boundary: 'Buildings & structures',
  track: 'Track',
  special: 'Gates & platforms',
  obstacle: 'Obstacles',
  train: 'Trains',
  prop: 'Props',
  transition: 'Transitions',
};

const THUMB_KEY = (theme) => `subway-thumb:${theme}`;

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

const rgb = (c) => (c ? `rgb(${c.slice(0, 3).map((v) => Math.round(v * 255)).join(',')})` : '#678');
const prettySlot = (slot) => slot.replace(/^(boundary|track|special|obstacle|train|prop)_/, '').replaceAll('_', ' ');
const prettyTheme = (t) => t.replace(/([a-z])([A-Z0-9])/g, '$1 $2');

function readThumb(theme) {
  try {
    return localStorage.getItem(THUMB_KEY(theme));
  } catch {
    return null;
  }
}

/**
 * @param manifest viewer manifest
 * @param actions { getState, setTheme, inspect(names), exitInspect, screenshot() -> {blob, name, width, height}, thumbnail() -> dataURL }
 */
export function createUI(manifest, actions) {
  const root = document.getElementById('ui');
  const themes = Object.keys(manifest.themes);

  // ------------------------------------------------------------ theme bar
  const themeBar = el('div', { class: 'theme-bar' });
  const themeCards = new Map();
  for (const theme of themes) {
    const sky = manifest.themeConfigs?.[theme]?.sky;
    const thumb = el('div', { class: 'thumb' });
    thumb.style.background = `linear-gradient(${rgb(sky?.top)}, ${rgb(sky?.bottom)})`;
    const saved = readThumb(theme);
    if (saved) thumb.style.backgroundImage = `url(${saved})`;
    const card = el('button', { class: 'theme-card', title: theme, onclick: () => actions.setTheme(theme) }, thumb, el('span', {}, prettyTheme(theme)));
    themeCards.set(theme, { card, thumb });
    themeBar.append(card);
  }

  // ------------------------------------------------------------ piece browser
  const browser = el('aside', { class: 'panel browser hidden' });
  const browserBody = el('div', { class: 'browser-body' });
  const inspectBanner = el('div', { class: 'inspect-banner hidden' });
  browser.append(
    el('header', {}, el('strong', {}, 'Pieces'), el('button', { class: 'icon', title: 'Close', onclick: () => toggleBrowser(false) }, '✕')),
    browserBody,
  );

  function renderBrowser() {
    const theme = actions.getState().theme;
    const t = manifest.themes[theme];
    browserBody.replaceChildren();
    const transitions = (manifest.boundaries?.[theme]?.transitions ?? []).map((tr) => tr.prefab);
    const categories = { ...t, transition: transitions.length ? { transitions: [...new Set(transitions)] } : {} };
    for (const [cat, slots] of Object.entries(categories)) {
      const entries = Object.entries(slots).filter(([, names]) => names.some((n) => manifest.prefabs[n]?.bbox));
      if (!entries.length) continue;
      const list = el('div', { class: 'slot-list' });
      for (const [slot, names] of entries) {
        const valid = names.filter((n) => manifest.prefabs[n]?.bbox);
        list.append(
          el(
            'div',
            { class: 'slot' },
            el('button', { class: 'slot-name', title: 'Inspect all variants', onclick: () => actions.inspect(valid) }, prettySlot(slot), el('small', {}, `${valid.length}`)),
            el('div', { class: 'variants' }, valid.map((n) => el('button', { class: 'variant', title: n, onclick: () => actions.inspect([n]) }, n.replace(`${theme}_`, '')))),
          ),
        );
      }
      browserBody.append(el('details', { open: cat === 'boundary' ? '' : null }, el('summary', {}, CATEGORY_LABELS[cat] ?? cat), list));
    }
  }

  function toggleBrowser(show = browser.classList.contains('hidden')) {
    browser.classList.toggle('hidden', !show);
    if (show) renderBrowser();
  }

  function setInspecting(names) {
    inspectBanner.classList.toggle('hidden', !names);
    if (names) {
      inspectBanner.replaceChildren(
        el('span', {}, `Inspecting ${names.length === 1 ? names[0] : `${names.length} pieces`}`),
        el('button', { onclick: () => actions.exitInspect() }, 'Back to run'),
      );
    }
  }

  // ------------------------------------------------------------ screenshots
  const shots = [];
  const gallery = el('aside', { class: 'panel gallery hidden' });
  const galleryBody = el('div', { class: 'gallery-body' });
  gallery.append(
    el('header', {}, el('strong', {}, 'Screenshots'), el('button', { class: 'icon', title: 'Close', onclick: () => gallery.classList.add('hidden') }, '✕')),
    galleryBody,
  );

  function download(shot) {
    const a = el('a', { href: shot.url, download: shot.name });
    a.click();
  }

  function renderGallery() {
    galleryBody.replaceChildren(
      ...(shots.length
        ? shots
            .slice()
            .reverse()
            .map((shot) =>
              el(
                'figure',
                {},
                el('img', { src: shot.url, alt: shot.name, onclick: () => download(shot) }),
                el(
                  'figcaption',
                  {},
                  el('span', {}, `${shot.width}×${shot.height}`),
                  el('button', { onclick: () => download(shot) }, 'Save'),
                  el(
                    'button',
                    {
                      onclick: () => {
                        shots.splice(shots.indexOf(shot), 1);
                        URL.revokeObjectURL(shot.url);
                        renderGallery();
                        updateShotCount();
                      },
                    },
                    'Remove',
                  ),
                ),
              ),
            )
        : [el('p', { class: 'empty' }, 'No screenshots yet. Press P or the camera button.')]),
    );
  }

  const shotCount = el('span', { class: 'count hidden' });
  const updateShotCount = () => {
    shotCount.textContent = shots.length;
    shotCount.classList.toggle('hidden', !shots.length);
  };

  async function takeShot() {
    const shot = await actions.screenshot();
    shot.url = URL.createObjectURL(shot.blob);
    shots.push(shot);
    download(shot);
    updateShotCount();
    if (!gallery.classList.contains('hidden')) renderGallery();
    toast(`Saved ${shot.name}`);
  }

  // ------------------------------------------------------------ toolbar, help, toast
  const help = el(
    'div',
    { class: 'help hidden', onclick: () => help.classList.add('hidden') },
    el(
      'div',
      { class: 'help-card' },
      el('h2', {}, 'Controls'),
      el(
        'dl',
        {},
        [
          ['Drag', 'Look around'],
          ['W A S D / arrows', 'Move (stays level)'],
          ['Space / Shift', 'Up / down'],
          ['Alt', 'Move faster'],
          ['Mouse wheel', 'Change fly speed'],
          ['P', 'Screenshot'],
          ['B', 'Piece browser'],
          ['G', 'Screenshot gallery'],
          ['H', 'This help'],
        ].map(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]),
      ),
      el('p', {}, 'Click anywhere to close.'),
    ),
  );

  const toastEl = el('div', { class: 'toast hidden' });
  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 2500);
  }

  const toolbar = el(
    'div',
    { class: 'toolbar' },
    el('button', { title: 'Piece browser (B)', onclick: () => toggleBrowser() }, '🧱 Pieces'),
    el('button', { title: 'Screenshot (P)', onclick: takeShot }, '📷 Shot'),
    el(
      'button',
      {
        title: 'Screenshot gallery (G)',
        onclick: () => {
          gallery.classList.toggle('hidden');
          renderGallery();
        },
      },
      '🖼 Gallery',
      shotCount,
    ),
    el('button', { title: 'Help (H)', onclick: () => help.classList.toggle('hidden') }, '?'),
  );

  addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey) return;
    if (e.code === 'KeyP') takeShot();
    if (e.code === 'KeyB') toggleBrowser();
    if (e.code === 'KeyG') {
      gallery.classList.toggle('hidden');
      renderGallery();
    }
    if (e.code === 'KeyH') help.classList.toggle('hidden');
    if (e.code === 'Escape') {
      help.classList.add('hidden');
      if (actions.getState().inspect) actions.exitInspect();
    }
  });

  root.append(themeBar, inspectBanner, browser, gallery, toolbar, help, toastEl);

  return {
    /** Highlights the active theme and refreshes theme-dependent panels. */
    themeChanged(theme) {
      for (const [t, { card }] of themeCards) card.classList.toggle('active', t === theme);
      if (!browser.classList.contains('hidden')) renderBrowser();
    },
    /** Stores a thumbnail for a theme the first time it is shown. */
    themeLoaded(theme) {
      const { thumb } = themeCards.get(theme) ?? {};
      if (!thumb || readThumb(theme)) return;
      const url = actions.thumbnail();
      if (!url) return;
      thumb.style.backgroundImage = `url(${url})`;
      try {
        localStorage.setItem(THUMB_KEY(theme), url);
      } catch {
        // storage full or blocked: the gradient swatch stays
      }
    },
    setInspecting,
    takeShot,
    toast,
  };
}
