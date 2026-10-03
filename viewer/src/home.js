// Home page: upload an APK (extraction job with progress) and list the extracted
// environments (one per map) with open / delete.

const $ = (id) => document.getElementById(id);
const prettyTheme = (t) => t.replace(/([a-z])([A-Z0-9])/g, '$1 $2');

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

/** Routes a dropped/chosen file: .subwaymap installs, anything else extracts. */
const handleFile = (file) => (/\.subwaymap$/i.test(file.name) ? installPackage(file) : upload(file));

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

async function upload(file) {
  $('drop').classList.add('busy');
  try {
    // Upload with progress (fetch has no upload progress events)
    const { jobId } = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/extract?name=${encodeURIComponent(file.name)}`);
      xhr.upload.onprogress = (e) => e.lengthComputable && showJob(`Uploading ${file.name}`, (e.loaded / e.total) * 0.1);
      xhr.onload = () => (xhr.status < 300 ? resolve(JSON.parse(xhr.responseText)) : reject(new Error(xhr.responseText)));
      xhr.onerror = () => reject(new Error('Upload failed'));
      xhr.send(file);
    });
    await followJob(jobId);
  } catch (e) {
    showJob(`Upload failed: ${e.message}`, null);
    $('job').classList.add('failed');
  } finally {
    $('drop').classList.remove('busy');
    loadEnvs();
  }
}

/** Polls an extraction job until it ends, updating the progress card. */
async function followJob(jobId) {
  $('drop').classList.add('busy');
  $('job').classList.remove('failed');
  try {
    for (;;) {
      const res = await fetch(`/api/jobs/${jobId}`);
      if (!res.ok) break; // server restarted: the job is gone
      const job = await res.json();
      if (job.status === 'conflict') {
        showJob('Some maps already exist', null);
        const { choices, notes } = await askConflicts(job.conflicts);
        await fetch(`/api/jobs/${jobId}/resolve`, { method: 'POST', body: JSON.stringify({ choices, notes }) });
        continue;
      }
      const step = Math.max(0, STAGE_ORDER.indexOf(job.stage));
      showJob(job.label ?? job.stage, 0.1 + (0.9 * step) / (STAGE_ORDER.length - 1), job.log.join('\n'));
      if (job.status === 'done') {
        const skipped = job.skipped ? `, ${job.skipped} kept as they were` : '';
        showJob(`Done: ${job.envs.length} environment${job.envs.length === 1 ? '' : 's'} installed${skipped}`, 1, job.warning ? `Note: ${job.warning}` : '');
        break;
      }
      if (job.status === 'error') {
        showJob(`Extraction failed: ${job.error}`, null, job.log.join('\n'));
        $('job').classList.add('failed');
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    $('drop').classList.remove('busy');
    loadEnvs();
  }
}

const drop = $('drop');
drop.addEventListener('click', () => !drop.classList.contains('busy') && $('file').click());
$('file').addEventListener('change', (e) => e.target.files[0] && handleFile(e.target.files[0]));
drop.addEventListener('dragover', (e) => (e.preventDefault(), drop.classList.add('over')));
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const file = e.dataTransfer.files[0];
  if (file && !drop.classList.contains('busy')) handleFile(file);
});

loadEnvs();
// Resume showing an extraction that is still running (page reloaded or reopened)
fetch('/api/jobs')
  .then((r) => r.json())
  .then((running) => running[0] && followJob(running[0].id))
  .catch(() => {});
