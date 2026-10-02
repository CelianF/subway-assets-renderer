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
          el('p', {}, `v${env.gameVersion} · ${env.source}`),
          el(
            'div',
            { class: 'env-actions' },
            el('button', { class: 'primary', onclick: open }, 'Open'),
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
    for (;;) {
      const job = await (await fetch(`/api/jobs/${jobId}`)).json();
      const step = Math.max(0, STAGE_ORDER.indexOf(job.stage));
      showJob(job.label ?? job.stage, 0.1 + (0.9 * step) / (STAGE_ORDER.length - 1), job.log.join('\n'));
      if (job.status === 'done') {
        showJob(`Done: ${job.envs.length} environment${job.envs.length === 1 ? '' : 's'} extracted`, 1, '');
        break;
      }
      if (job.status === 'error') {
        showJob(`Extraction failed: ${job.error}`, null, job.log.join('\n'));
        $('job').classList.add('failed');
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch (e) {
    showJob(`Upload failed: ${e.message}`, null);
    $('job').classList.add('failed');
  } finally {
    $('drop').classList.remove('busy');
    loadEnvs();
  }
}

const drop = $('drop');
drop.addEventListener('click', () => !drop.classList.contains('busy') && $('file').click());
$('file').addEventListener('change', (e) => e.target.files[0] && upload(e.target.files[0]));
drop.addEventListener('dragover', (e) => (e.preventDefault(), drop.classList.add('over')));
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const file = e.dataTransfer.files[0];
  if (file && !drop.classList.contains('busy')) upload(file);
});

loadEnvs();
