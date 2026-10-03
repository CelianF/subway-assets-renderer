// Home page: upload an APK (extraction job with progress) and list the extracted
// environments (one per map) with open / delete.

import { addCredit } from './credit.js';

const $ = (id) => document.getElementById(id);
const prettyTheme = (t) => t.replace(/([a-z])([A-Z0-9])/g, '$1 $2');

addCredit();

const STAGE_ORDER = ['upload', 'load', 'export-project', 'export-content', 'build', 'install', 'done'];

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v != null) node.setAttribute(k, v);
  }
  node.append(...children.flat().filter((c) => c != null));
  return node;
}

// ---------------------------------------------------------------- environments

async function loadEnvs() {
  const envs = await (await fetch('/api/envs')).json();
  $('count').textContent = envs.length ? `(${envs.length})` : '';
  $('empty').classList.toggle('hidden', envs.length > 0);
  $('envs').replaceChildren(
    ...envs.map((env) => {
      const thumb = el('div', { class: 'thumb' });
      if (env.thumbnail) thumb.style.backgroundImage = `url(/envs/${env.id}/thumbnail.jpg?${Date.parse(env.createdAt)})`;
      else thumb.append(el('span', {}, 'Open once to generate a preview'));
      const open = () => (location.href = `/viewer.html?env=${encodeURIComponent(env.id)}`);
      return el(
        'article',
        { class: 'env' },
        el('button', { class: 'thumb-btn', onclick: open, title: `Open ${env.theme}` }, thumb),
        el(
          'div',
          { class: 'env-info' },
          el('h3', {}, prettyTheme(env.theme)),
          el('p', {}, `v${env.gameVersion}`, env.copy ? el('span', { class: 'env-note' }, ` · ${env.note ?? `copy ${env.copy}`}`) : null),
          el(
            'div',
            { class: 'env-actions' },
            el('button', { class: 'primary', onclick: open }, 'Open'),
            el('a', { class: 'button', href: `/api/envs/${encodeURIComponent(env.id)}/export`, download: '', title: 'Download a .subwaymap file to share this map' }, 'Share'),
            el(
              'button',
              {
                class: 'danger',
                onclick: async () => {
                  if (!confirm(`Delete ${prettyTheme(env.theme)} (v${env.gameVersion})? This removes its files.`)) return;
                  await fetch(`/api/envs/${encodeURIComponent(env.id)}`, { method: 'DELETE' });
                  loadEnvs();
                },
              },
              'Delete',
            ),
          ),
        ),
      );
    }),
  );
}

// ---------------------------------------------------------------- upload + job

function showJob(label, fraction, log = '') {
  $('job').classList.remove('hidden');
  $('job-label').textContent = label;
  $('job-pct').textContent = fraction == null ? '' : `${Math.round(fraction * 100)}%`;
  $('job-bar').style.width = `${Math.round((fraction ?? 0) * 100)}%`;
  $('job-log').textContent = log;
}

/** Installs a shared .subwaymap package. */
async function installPackage(file) {
  $('drop').classList.add('busy');
  $('job').classList.remove('failed');
  const send = (onConflict, note = '') =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/import?name=${encodeURIComponent(file.name)}${onConflict ? `&onConflict=${onConflict}&note=${encodeURIComponent(note)}` : ''}`);
      xhr.upload.onprogress = (e) => e.lengthComputable && showJob(`Installing ${file.name}`, e.loaded / e.total);
      xhr.onload = () => {
        const body = JSON.parse(xhr.responseText || '{}');
        xhr.status < 300 || xhr.status === 409 ? resolve(body) : reject(new Error(body.error ?? xhr.statusText));
      };
      xhr.onerror = () => reject(new Error('Upload failed'));
      xhr.send(file);
    });
  try {
    let env = await send(null);
    if (env.conflicts) {
      const { choices, notes } = await askConflicts(env.conflicts);
      const id = env.conflicts[0].id;
      env = await send(choices[id], notes[id]);
    }
    if (env.skipped) showJob(`Kept the existing ${prettyTheme(env.theme)} (v${env.gameVersion})`, 1);
    else showJob(`Installed ${prettyTheme(env.theme)} (v${env.gameVersion})${env.copy ? ` as "${env.note ?? `copy ${env.copy}`}"` : ''}`, 1);
  } catch (e) {
    showJob(`Install failed: ${e.message}`, null);
    $('job').classList.add('failed');
  } finally {
    $('drop').classList.remove('busy');
    loadEnvs();
  }
}

/**
 * Routes dropped/chosen files in order: a .subwaymap installs, anything else is uploaded
 * and queued for extraction on the server (one at a time there). Uploads go one after the
 * other too, so the queue keeps the selection order.
 */
let sendChain = Promise.resolve();
const uploads = []; // files still being sent: { name, fraction }
function handleFiles(files) {
  for (const file of files) {
    if (/\.subwaymap$/i.test(file.name)) {
      sendChain = sendChain.then(() => installPackage(file));
      continue;
    }
    const entry = { name: file.name, fraction: 0 };
    uploads.push(entry);
    sendChain = sendChain.then(() => upload(file, entry));
  }
  watchJobs();
}

/**
 * "This map already exists" dialog: one choice per map (ignore / keep both / replace),
 * with buttons to apply a choice to all; "Keep both" asks for a note to tell the copies
 * apart. Resolves to { choices: { envId: policy }, notes: { envId: text } }.
 */
let conflictOpen = false;
function askConflicts(conflicts) {
  if (conflictOpen) return new Promise(() => {}); // a poll tick while the dialog is up
  conflictOpen = true;
  return new Promise((resolve) => {
    const choices = Object.fromEntries(conflicts.map((c) => [c.id, 'keep']));
    const notes = {};
    const POLICIES = [
      ['skip', 'Ignore', 'Keep the existing map, drop the new one'],
      ['keep', 'Keep both', 'Save the new one as a copy next to it'],
      ['replace', 'Replace', 'Overwrite the existing map'],
    ];
    const rows = conflicts.map((c) => {
      const buttons = POLICIES.map(([policy, label, title]) =>
        el('button', { class: `choice ${policy === 'replace' ? 'danger' : ''}`, 'data-policy': policy, title, onclick: () => set(c.id, policy) }, label),
      );
      const date = c.existingDate ? new Date(c.existingDate).toLocaleDateString() : '';
      const noteInput = el('input', {
        class: 'note-input',
        type: 'text',
        maxlength: 60,
        placeholder: 'Note for the new copy (e.g. pride event, older build)',
        oninput: (e) => (notes[c.id] = e.target.value),
      });
      return {
        id: c.id,
        buttons,
        noteInput,
        node: el(
          'div',
          { class: 'conflict-row' },
          el(
            'div',
            { class: 'conflict-main' },
            el('div', {}, el('strong', {}, `${prettyTheme(c.theme)} v${c.gameVersion}`), el('small', {}, `Already installed${date ? ` on ${date}` : ''}${c.existingSource ? ` from ${c.existingSource}` : ''}`)),
            el('div', { class: 'choices' }, ...buttons),
          ),
          noteInput,
        ),
      };
    });
    function set(id, policy) {
      choices[id] = policy;
      for (const r of rows) {
        if (r.id !== id) continue;
        r.buttons.forEach((b) => b.classList.toggle('active', b.dataset.policy === policy));
        r.noteInput.classList.toggle('hidden', policy !== 'keep'); // only copies need a note
      }
    }
    const overlay = el(
      'div',
      { class: 'modal-overlay' },
      el(
        'div',
        { class: 'modal' },
        el('h3', {}, conflicts.length === 1 ? 'This map already exists' : `${conflicts.length} maps already exist`),
        el('p', { class: 'muted' }, 'Same map and same game version. Small variants of a city (e.g. an event skin) are separate maps and never collide.'),
        ...rows.map((r) => r.node),
        conflicts.length > 1
          ? el('div', { class: 'conflict-all' }, el('span', { class: 'muted' }, 'All:'), ...POLICIES.map(([policy, label]) => el('button', { onclick: () => conflicts.forEach((c) => set(c.id, policy)) }, label)))
          : null,
        el(
          'div',
          { class: 'modal-actions' },
          el(
            'button',
            {
              class: 'primary',
              onclick: () => {
                overlay.remove();
                conflictOpen = false;
                resolve({ choices, notes });
              },
            },
            'Continue',
          ),
        ),
      ),
    );
    conflicts.forEach((c) => set(c.id, 'keep'));
    document.body.append(overlay);
  });
}

/** Sends one package to the server queue. */
async function upload(file, entry) {
  try {
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/extract?name=${encodeURIComponent(file.name)}`);
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        entry.fraction = e.loaded / e.total;
        renderQueue();
      };
      xhr.onload = () => (xhr.status < 300 ? resolve(JSON.parse(xhr.responseText)) : reject(new Error(JSON.parse(xhr.responseText || '{}').error ?? xhr.statusText)));
      xhr.onerror = () => reject(new Error('Upload failed'));
      xhr.send(file);
    });
  } catch (e) {
    showJob(`Upload of ${file.name} failed: ${e.message}`, null);
    $('job').classList.add('failed');
  } finally {
    uploads.splice(uploads.indexOf(entry), 1);
    renderQueue();
    watchJobs();
  }
}

// ---------------------------------------------------------------- queue

let queued = []; // server jobs waiting their turn: { id, source }

/** "Up next": files still uploading, then the server's waiting jobs (removable). */
function renderQueue() {
  const rows = [
    ...queued.map((job) => ({ name: job.source, state: 'Waiting', remove: () => removeJob(job.id) })),
    ...uploads.map((u) => ({ name: u.name, state: `Uploading ${Math.round(u.fraction * 100)}%` })),
  ];
  $('queue').classList.toggle('hidden', rows.length === 0);
  $('queue-count').textContent = rows.length ? `(${rows.length})` : '';
  $('queue-list').replaceChildren(
    ...rows.map((r, i) =>
      el(
        'li',
        {},
        el('span', { class: 'q-pos' }, `${i + 1}.`),
        el('span', { class: 'q-name', title: r.name }, r.name),
        el('span', { class: 'q-state' }, r.state),
        r.remove ? el('button', { class: 'danger', title: 'Remove from the queue', onclick: r.remove }, 'Remove') : null,
      ),
    ),
  );
}

async function removeJob(id) {
  const res = await fetch(`/api/jobs/${id}`, { method: 'DELETE' });
  if (!res.ok) alert((await res.json().catch(() => ({}))).error ?? 'Could not remove it');
  queued = queued.filter((j) => j.id !== id);
  renderQueue();
}

/**
 * Follows the server queue until it is empty: progress card for the running job, conflict
 * dialog when it asks, final result when it ends, and the waiting list. One loop at a time.
 */
let watching = false;
async function watchJobs() {
  if (watching) return;
  watching = true;
  $('job').classList.remove('failed');
  let current = null; // id of the job shown in the progress card
  try {
    for (;;) {
      const list = await (await fetch('/api/jobs')).json().catch(() => []);
      const active = list.find((j) => j.status === 'running' || j.status === 'conflict');
      queued = list.filter((j) => j.status === 'queued');
      renderQueue();
      // The job shown so far left the active list: show how it ended
      if (current && current !== active?.id) {
        await showResult(current);
        current = null;
      }
      if (active) {
        if (current !== active.id) $('job').classList.remove('failed');
        current = active.id;
        await showProgress(active.id);
      }
      if (!active && !queued.length && !uploads.length) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    watching = false;
    loadEnvs();
  }
}

async function showProgress(jobId) {
  const res = await fetch(`/api/jobs/${jobId}`);
  if (!res.ok) return; // server restarted: the job is gone
  const job = await res.json();
  if (job.status === 'conflict') {
    showJob(`${job.source}: some maps already exist`, null);
    const { choices, notes } = await askConflicts(job.conflicts);
    await fetch(`/api/jobs/${jobId}/resolve`, { method: 'POST', body: JSON.stringify({ choices, notes }) });
    return;
  }
  const step = Math.max(0, STAGE_ORDER.indexOf(job.stage));
  showJob(`${job.source}: ${job.label ?? job.stage}`, 0.1 + (0.9 * step) / (STAGE_ORDER.length - 1), job.log.join('\n'));
}

async function showResult(jobId) {
  const res = await fetch(`/api/jobs/${jobId}`);
  if (!res.ok) return;
  const job = await res.json();
  if (job.status === 'done') {
    const skipped = job.skipped ? `, ${job.skipped} kept as they were` : '';
    showJob(`${job.source}: ${job.envs.length} environment${job.envs.length === 1 ? '' : 's'} installed${skipped}`, 1, job.warning ? `Note: ${job.warning}` : '');
  } else if (job.status === 'error') {
    showJob(`${job.source}: extraction failed: ${job.error}`, null, job.log.join('\n'));
    $('job').classList.add('failed');
  }
  loadEnvs(); // new maps show up while the rest of the queue runs
}

const drop = $('drop');
drop.addEventListener('click', () => $('file').click());
$('file').addEventListener('change', (e) => {
  handleFiles([...e.target.files]);
  e.target.value = ''; // picking the same files again still fires "change"
});
drop.addEventListener('dragover', (e) => (e.preventDefault(), drop.classList.add('over')));
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  handleFiles([...e.dataTransfer.files]);
});

loadEnvs();
// Resume following the queue (page reloaded, or back from a map)
watchJobs();
