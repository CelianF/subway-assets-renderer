// Viewer chrome around the canvas: header, toolbar, piece browser, screenshot gallery, help.
// Generation, View and Studio are bottom work bars (settings.js, studio.js).
import { createControls } from './settings.js';

const CATEGORY_LABELS = {
  boundary: 'Buildings & structures',
  track: 'Track',
  special: 'Gates & platforms',
  obstacle: 'Obstacles',
  train: 'Trains',
  prop: 'Props',
  transition: 'Transitions',
};


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

const DEBUG = new URLSearchParams(location.search).get('debug') === 'true';

const prettySlot = (slot) => slot.replace(/^(boundary|track|special|obstacle|train|prop)_/, '').replaceAll('_', ' ');
// Old games prefix themes with an internal number ("1.118_BuenosAires"): shown as "Buenos Aires"
export const prettyTheme = (t) => t.replace(/^\d+\.\d+_/, '').replace(/([a-z])([A-Z0-9])/g, '$1 $2');

/**
 * @param manifest viewer manifest
 * @param actions { getState, env, inspect(names), exitInspect, screenshot() -> {blob, name, width, height},
 *                   thumbnail() -> dataURL, saveThumbnail(dataURL), openGeneration, openView, openStudio,
 *                   timeButton: toolbar button of the time deck (time.js),
 *                   shotOptions: settings.js controls }
 */
export function createUI(manifest, actions) {
  const root = document.getElementById('ui');
  const { env } = actions;

  // ------------------------------------------------------------ header (maps are chosen on the home page)
  // The run's status (seed, pieces) sits by the map name; clicking it opens Generation
  const status = document.getElementById('status');
  status.title = 'Generation (1)';
  status.addEventListener('click', () => actions.openGeneration());
  const header = el(
    'div',
    { class: 'env-header' },
    el('a', { class: 'back home-link', href: '/', title: 'Back to environments' }, '← Environments'),
    // Shown instead while a bar or the studio is open: closes it (styles.css)
    el('button', { class: 'back close-link', title: 'Close (Esc)', onclick: () => actions.closePanels() }, '← Back'),
    el('div', {}, el('strong', {}, prettyTheme(env.theme)), env.gameVersion ? el('small', {}, ` v${env.gameVersion}`) : null),
    status,
  );

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
        : [el('p', { class: 'empty' }, 'No screenshots yet. Press P or 📷 Shot.')]),
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
          ['Ctrl', 'Sprint'],
          ['− / =', 'Fly speed'],
          ['Mouse wheel', 'Field of view'],
          ['1 / 2 / 3', 'Generation / View / Studio'],
          ['Esc', 'Close the open bar'],
          ['T', 'Time controls'],
          ['F', 'Freeze / play'],
          ['. (Shift)', 'Next frame (10 frames)'],
          ['[ / ]', 'Slower / faster'],
          ['Tab', 'Hide / show the interface'],
          ['P', 'Screenshot'],
          ...(DEBUG ? [['B', 'Piece browser']] : []),
          ['G', 'Screenshot gallery'],
          ['H', 'This help'],
        ].flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]),
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

  // Screenshot options (resolution, transparency): a popover above the Shot button
  const shotControls = createControls(actions.shotOptions ?? []);
  const shotMenu = el('div', { class: 'shot-menu hidden' }, el('h4', {}, 'Screenshot'), shotControls.nodes);
  const toggleShotMenu = (show = shotMenu.classList.contains('hidden')) => {
    if (show) shotControls.refresh();
    shotMenu.classList.toggle('hidden', !show);
  };
  addEventListener('pointerdown', (e) => !shotGroup.contains(e.target) && toggleShotMenu(false));

  const toggleGallery = () => {
    gallery.classList.toggle('hidden');
    renderGallery();
  };
  const shotGroup = el(
    'div',
    { class: 'tool-group split' },
    shotMenu,
    el('button', { title: 'Screenshot (P)', onclick: takeShot }, '📷 Shot'),
    el('button', { class: 'caret', title: 'Screenshot options', onclick: () => toggleShotMenu() }, '▾'),
    el('button', { title: 'Screenshot gallery (G)', onclick: toggleGallery }, '🖼', shotCount),
  );

  // Grouped by intent: change the scene · capture it · help
  const toolbar = el(
    'div',
    { class: 'toolbar' },
    el(
      'div',
      { class: 'tool-group' },
      el('button', { title: 'Seed, game mode, map sections and building pieces (1)', onclick: () => actions.openGeneration() }, '🗺 Generation'),
      el('button', { title: 'Camera, fog, skyline, bend and materials (2)', onclick: () => actions.openView() }, '🎨 View'),
      el('button', { title: 'Place trains and obstacles yourself (3)', onclick: () => actions.openStudio() }, '✏️ Studio'),
      actions.timeButton ?? null,
      // Piece browser: a debug tool, only with ?debug=true
      DEBUG ? el('button', { title: 'Piece browser (B)', onclick: () => toggleBrowser() }, '🧱 Pieces') : null,
    ),
    shotGroup,
    el('button', { title: 'Help (H)', onclick: () => help.classList.toggle('hidden') }, '?'),
  );

  addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey) return;
    if (e.code === 'KeyP') takeShot();
    if (e.code === 'KeyB' && DEBUG) toggleBrowser();
    if (e.code === 'KeyG') toggleGallery();
    if (e.code === 'KeyH') help.classList.toggle('hidden');
    if (e.code === 'Escape') {
      help.classList.add('hidden');
      toggleShotMenu(false);
      if (actions.getState().inspect) actions.exitInspect();
    }
  });

  root.append(header, inspectBanner, browser, gallery, toolbar, help, toastEl);

  return {
    themeChanged() {
      if (!browser.classList.contains('hidden')) renderBrowser();
    },
    /** Saves a preview for the home page the first time the map is shown. */
    themeLoaded() {
      if (env.thumbnail) return;
      const url = actions.thumbnail();
      if (url) actions.saveThumbnail(url).catch(() => {});
    },
    setInspecting,
    takeShot,
    toast,
  };
}
