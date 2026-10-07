// Chunk mode: lay your own map, piece by piece. The bottom bar holds every piece the city
// can lay (a 3D card each); the strip at the top is the run, start to end. Drag cards onto
// the strip (or click them to add at the end), drag in the strip to reorder, click a chunk
// to fly there. The map rebuilds as the strip changes; what the game would never lay (two
// interiors back to back, a station without its start) is flagged.

const PX_PER_UNIT = 72 / 180; // a 180-long segment is 72px wide in the strip

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c.nodeType ? c : document.createTextNode(c));
  return node;
}

/**
 * @param ctx {
 *   groups() -> [{ group, cards }] (layout.js chunkCards), plan() -> chunks (or null: generated),
 *   setPlan(chunks), fromRun() -> chunks of the generated run, useGenerated(),
 *   check(chunks) -> [{ index, message }], lengthOf(chunk), thumbnail(card) -> Promise<url>,
 *   goTo(z), onOpen(), toast(message)
 * }
 * @returns {{ button, open(), close(), toggle(), isOpen(), refresh() }}
 */
export function createChunkDeck(root, ctx) {
  let shown = false;
  let group = null; // the bottom bar's open group
  let drag = null; // { card } from the bar, or { index } from the strip

  const cardsById = () => new Map(ctx.groups().flatMap((g) => g.cards).map((c) => [c.id, c]));
  const cardIds = (e) => (e.type === 'buildings' ? ['left', 'right'].map((side) => e[side] && `${e[side].slot}|${e[side].prefab}`) : [e.type === 'gate' ? `gate|${e.wall}` : `${e.slot}|${e.prefab}`]);

  /** A thumbnail <img>, filled in when its card is rendered. */
  function thumb(card) {
    const img = el('img', { class: 'chunk-thumb', alt: '', draggable: 'false' });
    if (card) ctx.thumbnail(card).then((url) => url && (img.src = url));
    return img;
  }

  /** A building side's tag in the strip, where half a segment is narrow: H2, M1, Ad… */
  function shortName(card, side) {
    if (!card) return side ? '?' : '—';
    if (/sponsored/.test(card.slot)) return 'Ad';
    return `${card.slot.match(/_(low|medium|high)_/)?.[1]?.[0].toUpperCase() ?? ''}${card.label.match(/\d+$/)?.[0] ?? ''}`;
  }

  /** The chunk a card lays on its own: a building side gets a segment, its other side the same height's first. */
  function chunkOf(card) {
    if (card.type === 'gate') return { type: 'gate', wall: card.wall };
    if (card.type === 'piece') return { type: 'piece', slot: card.slot, prefab: card.prefab };
    const other = card.side === 'left' ? 'right' : 'left';
    const height = card.slot.match(/_(low|medium|high)_/)?.[1] ?? 'low';
    const partner = [...cardsById().values()].find((c) => c.slot === `boundary_${height}_${other}`);
    return { type: 'buildings', [card.side]: { slot: card.slot, prefab: card.prefab }, ...(partner ? { [other]: { slot: partner.slot, prefab: partner.prefab } } : {}) };
  }

  // ------------------------------------------------------------ the strip (top)
  const items = el('div', { class: 'chunk-items' });
  const marker = el('div', { class: 'chunk-marker hidden' });
  const scroller = el('div', { class: 'chunk-scroller' }, items, marker);
  const summary = el('span', { class: 'chunk-summary' });
  const warnings = el('div', { class: 'chunk-warnings' });
  const strip = el(
    'div',
    { class: 'chunk-strip hidden' },
    el(
      'div',
      { class: 'chunk-strip-head' },
      el('strong', { class: 'workbar-title' }, 'Your map'),
      summary,
      el('span', { class: 'studio-sep' }),
      el('span', { class: 'studio-hint' }, 'Drag to reorder · click to fly there · × removes'),
    ),
    scroller,
    warnings,
  );

  function renderStrip() {
    const plan = ctx.plan() ?? [];
    const cards = cardsById();
    const issues = ctx.check(plan);
    const issuesAt = (i) => issues.filter((w) => w.index === i).map((w) => w.message);
    let z = 0;
    items.replaceChildren(
      ...plan.map((e, i) => {
        const length = ctx.lengthOf(e);
        const at = z;
        z += length;
        const own = issuesAt(i);
        const remove = el('button', { class: 'chunk-remove', title: 'Remove', onclick: (ev) => (ev.stopPropagation(), ctx.setPlan(plan.filter((_, k) => k !== i))) }, '×');
        const body =
          e.type === 'buildings'
            ? ['left', 'right'].map((side) => {
                const card = e[side] && cards.get(`${e[side].slot}|${e[side].prefab}`);
                return el('div', { class: `chunk-half chunk-${side}`, 'data-side': side, title: card?.label ?? '' }, thumb(card), el('span', { class: 'chunk-name' }, shortName(card, e[side])));
              })
            : [thumb(cards.get(cardIds(e)[0])), el('span', { class: 'chunk-name' }, cards.get(cardIds(e)[0])?.label ?? e.slot ?? 'Gate')];
        const item = el(
          'div',
          {
            class: `chunk-item ${e.type === 'buildings' ? 'chunk-buildings' : ''} ${own.length ? 'warn' : ''}`,
            draggable: 'true',
            style: `width: ${Math.max(56, Math.round(length * PX_PER_UNIT))}px`,
            title: [...own.map((m) => `⚠ ${m}`), `At ${Math.round(at)} · ${Math.round(length)} long`].join('\n'),
            onclick: () => ctx.goTo(at),
            ondragstart: (ev) => {
              drag = { index: i };
              ev.dataTransfer.effectAllowed = 'move';
              ev.dataTransfer.setData('text/plain', 'chunk');
            },
            ondragend: () => endDrag(),
          },
          ...body,
          own.length ? el('span', { class: 'chunk-badge' }, '⚠') : null,
          remove,
        );
        return item;
      }),
      ...(plan.length ? [] : [el('div', { class: 'chunk-empty' }, 'Drag chunks here from the bar below')]),
    );
    summary.textContent = `${plan.length} chunk${plan.length === 1 ? '' : 's'} · ${Math.round(z)} units${issues.length ? ` · ⚠ ${issues.length}` : ''}`;
    warnings.replaceChildren(
      ...issues.slice(0, 3).map((w) => el('div', { class: 'chunk-warning' }, `⚠ Chunk ${w.index + 1}: ${w.message}`)),
      ...(issues.length > 3 ? [el('div', { class: 'chunk-warning' }, `… and ${issues.length - 3} more (hover the chunks)`)] : []),
    );
  }

  /** Where a drop at clientX lands: { insert: index } or { replace: index, side } (a building side onto a segment). */
  function dropTarget(ev) {
    const list = [...items.querySelectorAll('.chunk-item')];
    for (const [i, node] of list.entries()) {
      const r = node.getBoundingClientRect();
      if (ev.clientX < r.left || ev.clientX > r.right) continue;
      const card = drag?.card;
      const side = card?.side;
      const inner = ev.clientX > r.left + r.width * 0.2 && ev.clientX < r.right - r.width * 0.2;
      if (side && inner && node.classList.contains('chunk-buildings')) return { replace: i, side };
      return { insert: ev.clientX < r.left + r.width / 2 ? i : i + 1 };
    }
    const last = list[list.length - 1];
    return { insert: !last || ev.clientX > last.getBoundingClientRect().right ? list.length : 0 };
  }

  function showTarget(target) {
    items.querySelectorAll('.chunk-half.target').forEach((n) => n.classList.remove('target'));
    marker.classList.toggle('hidden', !target || target.replace != null);
    if (!target) return;
    const list = [...items.querySelectorAll('.chunk-item')];
    if (target.replace != null) {
      list[target.replace]?.querySelector(`.chunk-${target.side}`)?.classList.add('target');
      return;
    }
    const box = scroller.getBoundingClientRect();
    const ref = list[target.insert] ?? list[list.length - 1];
    const x = !ref ? 8 : list[target.insert] ? ref.getBoundingClientRect().left - 3 : ref.getBoundingClientRect().right + 1;
    marker.style.left = `${x - box.left + scroller.scrollLeft}px`;
  }

  function endDrag() {
    drag = null;
    showTarget(null);
  }

  scroller.addEventListener('dragover', (ev) => {
    if (!drag) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = drag.card ? 'copy' : 'move';
    showTarget(dropTarget(ev));
    // Near the ends: scroll the strip along
    const box = scroller.getBoundingClientRect();
    if (ev.clientX < box.left + 40) scroller.scrollLeft -= 12;
    else if (ev.clientX > box.right - 40) scroller.scrollLeft += 12;
  });
  scroller.addEventListener('dragleave', (ev) => !scroller.contains(ev.relatedTarget) && showTarget(null));
  scroller.addEventListener('drop', (ev) => {
    if (!drag) return;
    ev.preventDefault();
    const target = dropTarget(ev);
    const plan = [...(ctx.plan() ?? [])];
    if (drag.card && target.replace != null) {
      // A building side onto a segment: that side changes
      plan[target.replace] = { ...plan[target.replace], [target.side]: { slot: drag.card.slot, prefab: drag.card.prefab } };
    } else if (drag.card) {
      plan.splice(target.insert, 0, chunkOf(drag.card));
    } else {
      const [moved] = plan.splice(drag.index, 1);
      plan.splice(target.insert > drag.index ? target.insert - 1 : target.insert, 0, moved);
    }
    endDrag();
    ctx.setPlan(plan);
  });

  // ------------------------------------------------------------ the bar (bottom)
  const tabs = el('div', { class: 'studio-row chunk-tabs' });
  const cardsRow = el('div', { class: 'chunk-cards' });
  const bar = el(
    'div',
    { class: 'studio-bar chunk-bar' },
    tabs,
    cardsRow,
    el(
      'div',
      { class: 'studio-row' },
      el('span', { class: 'studio-hint' }, 'Drag onto your map, or click to add at the end'),
      el('span', { class: 'studio-sep' }),
      el('button', { title: 'Replace your map with the generated run (seed, sections)', onclick: () => ctx.setPlan(ctx.fromRun()) }, '⟳ From generated run'),
      el('button', { class: 'danger', title: 'Remove every chunk', onclick: () => confirm('Remove every chunk of your map?') && ctx.setPlan([]) }, '🗑 Clear'),
      el('button', { title: 'Back to the generated run (your map is kept for later)', onclick: () => (ctx.useGenerated(), close()) }, 'Use generated run'),
      el('button', { class: 'primary', title: 'Close (6)', onclick: () => close() }, 'Done'),
    ),
  );
  const palette = el('div', { class: 'studio-palette chunk-palette hidden' }, bar);
  root.append(strip, palette);

  function renderBar() {
    const groups = ctx.groups();
    if (!groups.some((g) => g.group === group)) group = groups[0]?.group ?? null;
    tabs.replaceChildren(
      el('strong', { class: 'workbar-title' }, 'Chunks'),
      ...groups.map((g) => el('button', { class: `tool ${g.group === group ? 'active' : ''}`, onclick: () => ((group = g.group), renderBar()) }, g.group)),
    );
    const cards = groups.find((g) => g.group === group)?.cards ?? [];
    cardsRow.replaceChildren(
      ...cards.map((card) =>
        el(
          'button',
          {
            class: 'chunk-card',
            draggable: 'true',
            title: `${card.label} (${card.prefab})`,
            onclick: () => {
              ctx.setPlan([...(ctx.plan() ?? []), chunkOf(card)]);
              requestAnimationFrame(() => (scroller.scrollLeft = scroller.scrollWidth));
            },
            ondragstart: (ev) => {
              drag = { card };
              ev.dataTransfer.effectAllowed = 'copy';
              ev.dataTransfer.setData('text/plain', card.id);
            },
            ondragend: () => endDrag(),
          },
          thumb(card),
          el('span', { class: 'chunk-name' }, card.label),
        ),
      ),
    );
  }

  const button = el('button', { title: 'Lay your own map, chunk by chunk (6)', onclick: () => toggle() }, '🧩 Chunks');

  function open() {
    if (shown) return;
    ctx.onOpen?.();
    shown = true;
    if (!ctx.plan()) ctx.setPlan(ctx.fromRun()); // start from the run on screen
    renderBar();
    renderStrip();
    strip.classList.remove('hidden');
    palette.classList.remove('hidden');
    document.body.classList.add('workbar-open', 'chunk-mode');
  }
  function close() {
    if (!shown) return;
    shown = false;
    strip.classList.add('hidden');
    palette.classList.add('hidden');
    document.body.classList.remove('workbar-open', 'chunk-mode');
  }
  const toggle = () => (shown ? close() : open());

  addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'Digit6') toggle();
    else if (e.code === 'Escape') close();
  });

  return {
    button,
    open,
    close,
    toggle,
    isOpen: () => shown,
    /** Call after the plan or the map's pieces changed. */
    refresh() {
      if (!shown) return;
      renderBar();
      renderStrip();
    },
  };
}
