// Central settings menu: one modal in the middle of the screen with tabs, built from a
// declarative schema. Controls read/write plain objects and call onChange.
//
// Schema: [{ tab, groups: [{ title?, controls: [control] }] }]
// control: { type: 'toggle'|'slider'|'select'|'button'|'number'|'note', label, obj, key,
//            min, max, step, options, onChange, action, hint, visible?: () => bool }

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children.flat().filter((c) => c != null));
  return node;
}

const fmt = (v, step) => (step && step < 1 ? Number(v).toFixed(String(step).split('.')[1]?.length ?? 2) : String(Math.round(v)));

function buildControl(c, refreshers) {
  const row = el('div', { class: `ctl ctl-${c.type}` });
  const label = el('span', { class: 'ctl-label' }, c.label, c.hint ? el('small', {}, c.hint) : null);
  const changed = (v) => {
    if (c.obj) c.obj[c.key] = v;
    c.onChange?.(v);
  };
  let refresh = () => {};
  if (c.type === 'toggle') {
    const input = el('input', { type: 'checkbox', onchange: (e) => changed(e.target.checked) });
    row.append(el('label', { class: 'switch' }, input, el('i')), label);
    // Optional side button (e.g. 👁 preview)
    if (c.extra) row.append(el('button', { class: 'icon ctl-extra', title: c.extra.title ?? '', onclick: (e) => (e.stopPropagation(), c.extra.action()) }, c.extra.label));
    refresh = () => (input.checked = !!c.obj[c.key]);
    row.classList.add('clickable');
    row.addEventListener('click', (e) => {
      if (e.target === row || e.target === label) input.click();
    });
  } else if (c.type === 'slider' || c.type === 'number') {
    // Slider plus a number box for typing an exact value (both stay in sync)
    const clamp = (v) => Math.min(c.max, Math.max(c.min, v));
    const number = el('input', {
      type: 'number',
      class: 'ctl-value',
      min: c.min,
      max: c.max,
      step: c.step ?? 1,
      onchange: (e) => {
        const v = clamp(Number(e.target.value));
        if (Number.isNaN(v)) return refresh();
        range.value = v;
        number.value = fmt(v, c.step);
        changed(v);
      },
      onkeydown: (e) => e.key === 'Enter' && e.target.blur(),
    });
    const range = el('input', {
      type: 'range',
      min: c.min,
      max: c.max,
      step: c.step ?? 1,
      oninput: (e) => {
        number.value = fmt(e.target.value, c.step);
        if (!c.lazy) changed(Number(e.target.value));
      },
      onchange: (e) => c.lazy && changed(Number(e.target.value)),
    });
    row.append(label, range, number);
    refresh = () => {
      range.value = c.obj[c.key];
      number.value = fmt(c.obj[c.key], c.step);
    };
  } else if (c.type === 'select') {
    const select = el('select', { onchange: (e) => changed(e.target.value) });
    const fill = () => {
      const options = typeof c.options === 'function' ? c.options() : c.options;
      select.replaceChildren(...Object.entries(options).map(([text, val]) => el('option', { value: val }, text)));
    };
    fill();
    row.append(label, select);
    refresh = () => {
      if (typeof c.options === 'function') fill();
      select.value = c.obj[c.key];
    };
  } else if (c.type === 'button') {
    row.append(el('button', { class: c.primary ? 'primary' : '', onclick: () => c.action() }, c.label));
  } else if (c.type === 'note') {
    row.append(el('p', { class: 'note' }, c.label));
  }
  refreshers.push(() => {
    refresh();
    if (c.visible) row.classList.toggle('hidden', !c.visible());
  });
  return row;
}

/** @returns {{ open(tab?), close(), toggle(), refresh(), isOpen() }} */
export function createSettings(root, schema, { title = 'Settings' } = {}) {
  const refreshers = [];
  const tabs = el('nav', { class: 'menu-tabs' });
  const body = el('div', { class: 'menu-body' });
  const pages = new Map();
  let current = schema[0].tab;

  for (const page of schema) {
    const pageEl = el('div', { class: 'menu-page' });
    for (const group of page.groups) {
      const g = el('section', { class: 'menu-group' }, group.title ? el('h3', {}, group.title) : null);
      for (const c of group.controls) g.append(buildControl(c, refreshers));
      if (group.visible) refreshers.push(() => g.classList.toggle('hidden', !group.visible()));
      pageEl.append(g);
    }
    pages.set(page.tab, pageEl);
    tabs.append(el('button', { 'data-tab': page.tab, onclick: () => show(page.tab) }, page.tab));
    body.append(pageEl);
  }

  const panel = el(
    'div',
    { class: 'menu-panel', role: 'dialog', 'aria-label': title },
    el('header', {}, el('strong', {}, title), el('button', { class: 'icon', title: 'Close (Esc)', onclick: () => close() }, '✕')),
    tabs,
    body,
  );
  if (schema.length === 1) tabs.classList.add('hidden'); // single page: no tab strip
  const overlay = el('div', { class: 'menu-overlay hidden', onclick: (e) => e.target === overlay && close() }, panel);
  root.append(overlay);

  function show(tab) {
    current = tab;
    for (const [name, pageEl] of pages) pageEl.classList.toggle('hidden', name !== tab);
    for (const b of tabs.children) b.classList.toggle('active', b.dataset.tab === tab);
  }
  function refresh() {
    refreshers.forEach((r) => r());
  }
  function open(tab = current) {
    refresh();
    show(tab);
    overlay.classList.remove('hidden');
  }
  function close() {
    overlay.classList.add('hidden');
  }
  show(current);
  return {
    open,
    close,
    toggle: () => (overlay.classList.contains('hidden') ? open() : close()),
    refresh,
    isOpen: () => !overlay.classList.contains('hidden'),
  };
}

/**
 * Bottom work bar (studio-style) for settings you tune while looking at the scene:
 * a main bar with one button per group, and the chosen group's controls above it.
 * Same schema groups as createSettings: [{ title, controls }].
 * @returns {{ open(), close(), toggle(), refresh(), isOpen() }}
 */
export function createWorkbar(root, groups, { title = 'Settings', onClose = null } = {}) {
  const refreshers = [];
  let current = 0;
  // A group is either a flat control list or side-by-side titled columns
  const pages = groups.map((g) => {
    const columns = g.columns ?? [{ controls: g.controls }];
    const page = el('div', { class: 'workbar-controls', style: `grid-template-columns: repeat(${columns.length}, 1fr)` });
    for (const col of columns) {
      const colEl = el('div', { class: 'workbar-column' }, col.title ? el('h4', {}, col.title) : null);
      for (const c of col.controls) colEl.append(buildControl(c, refreshers));
      page.append(colEl);
    }
    return page;
  });
  const contextBar = el('div', { class: 'studio-bar workbar-context' });
  const groupButtons = groups.map((g, i) => el('button', { class: 'tool', onclick: () => show(i) }, g.title));
  const mainBar = el(
    'div',
    { class: 'studio-bar' },
    el('div', { class: 'studio-row' }, el('strong', {}, title), ...groupButtons, el('span', { class: 'studio-sep' }), el('button', { class: 'primary', onclick: () => close() }, 'Done')),
  );
  const bar = el('div', { class: 'studio-palette workbar hidden' }, contextBar, mainBar);
  root.append(bar);

  function show(i) {
    current = i;
    contextBar.replaceChildren(pages[i]);
    groupButtons.forEach((b, k) => b.classList.toggle('active', k === i));
  }
  const refresh = () => refreshers.forEach((r) => r());
  function open() {
    refresh();
    show(current);
    bar.classList.remove('hidden');
    document.body.classList.add('workbar-open');
  }
  function close() {
    bar.classList.add('hidden');
    document.body.classList.remove('workbar-open');
    onClose?.();
  }
  return { open, close, toggle: () => (bar.classList.contains('hidden') ? open() : close()), refresh, isOpen: () => !bar.classList.contains('hidden') };
}
