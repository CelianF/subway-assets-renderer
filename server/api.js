// Local backend: APK upload -> headless AssetRipper -> manifest builder -> one
// environment per map under workspace/envs/<id>/. No dependencies (node:* only),
// mounted by the Vite dev server, by server/index.js and by the desktop app.
//   SUBWAY_WORKSPACE  data folder (default: workspace/ in the repo)
//   SUBWAY_RIPPER     ripper executable (default: dist/ripper-<arch>/ or dist/ripper/ripper.dll)
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { latestKit, prepareRemoteMap, saveRemoteKit } from './remote.js';
import { readZip, writeZip } from './zip.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE = process.env.SUBWAY_WORKSPACE ? path.resolve(process.env.SUBWAY_WORKSPACE) : path.join(ROOT, 'workspace');
const ENVS = path.join(WORKSPACE, 'envs');
const JOBS = path.join(WORKSPACE, 'jobs');
const REMOTE = path.join(WORKSPACE, 'remote'); // per game version: remote maps + shared bundles (server/remote.js)
const IS_WIN = process.platform === 'win32';

const MIME = {
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

const jobs = new Map(); // id -> { id, status, stage, log: [], envs: [], error }; insertion order = queue order

// Jobs live in memory: folders left by a previous run (a queued APK copy, a half export
// after a crash) can never finish, so they go at startup
const staleJobsCleared = rm(JOBS, { recursive: true, force: true }).catch(() => {});

// AssetRipper picks how to unpack an archive from its extension (APK, split APKs, …)
const PACKAGE_EXTENSIONS = new Set(['.apk', '.xapk', '.zip']);

// ---------------------------------------------------------------- tools

/** .NET runtime + ripper: self-contained build if present, else `dotnet ripper.dll`. */
function ripperCommand() {
  if (process.env.SUBWAY_RIPPER) return [process.env.SUBWAY_RIPPER, []];
  const selfContained = path.join(ROOT, 'dist', `ripper-${process.arch}`, IS_WIN ? 'ripper.exe' : 'ripper');
  if (existsSync(selfContained)) return [selfContained, []];
  const dll = path.join(ROOT, 'dist', 'ripper', 'ripper.dll');
  const localDotnet = path.join(ROOT, '.tools', 'dotnet', IS_WIN ? 'dotnet.exe' : 'dotnet');
  return [existsSync(localDotnet) ? localDotnet : 'dotnet', [dll]];
}

/** tools/build_manifest.mjs in a worker thread, so the server keeps answering meanwhile. */
function buildManifest(options, onLine) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../tools/build_manifest.mjs', import.meta.url), { workerData: options });
    worker.on('message', onLine);
    worker.on('error', reject);
    worker.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`manifest builder exited with ${code}`))));
  });
}

function run(cmd, args, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, windowsHide: true });
    let buffer = '';
    const feed = (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      lines.forEach(onLine);
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', reject);
    child.on('close', (code) => (buffer && onLine(buffer), code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exited with ${code}`))));
  });
}

// ---------------------------------------------------------------- environments

const slug = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '_');

async function listEnvs() {
  if (!existsSync(ENVS)) return [];
  const out = [];
  for (const id of await readdir(ENVS)) {
    try {
      out.push(JSON.parse(await readFile(path.join(ENVS, id, 'env.json'), 'utf8')));
    } catch {
      // half-written or foreign folder
    }
  }
  return out.sort((a, b) => a.theme.localeCompare(b.theme) || String(b.gameVersion).localeCompare(String(a.gameVersion)));
}

// ---------------------------------------------------------------- installing environments

const CONFLICT_POLICIES = new Set(['replace', 'keep', 'skip']);

async function readEnv(id) {
  try {
    return JSON.parse(await readFile(path.join(ENVS, id, 'env.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Moves a built environment folder into ENVS. When the map + version already exists:
 * 'replace' overwrites it, 'keep' installs a numbered copy next to it, 'skip' drops it.
 * @returns the installed env, or null when skipped
 */
async function placeEnv(srcDir, baseId, policy, fields, note = '') {
  await mkdir(ENVS, { recursive: true });
  let id = baseId;
  let copy;
  if (existsSync(path.join(ENVS, baseId))) {
    if (policy === 'skip') {
      await rm(srcDir, { recursive: true, force: true });
      return null;
    }
    if (policy === 'keep') {
      for (copy = 2; existsSync(path.join(ENVS, `${baseId}_${copy}`)); copy++);
      id = `${baseId}_${copy}`;
    } else {
      await rm(path.join(ENVS, baseId), { recursive: true, force: true });
    }
  }
  const env = { ...fields, id, ...(copy ? { copy } : {}) };
  if (!copy) delete env.copy;
  // A short note tells copies apart on the home page ("pride", "before patch"…)
  const cleanNote = String(note ?? '').trim().slice(0, 60);
  if (copy && cleanNote) env.note = cleanNote;
  else if (copy) delete env.note;
  await writeFile(path.join(srcDir, 'env.json'), JSON.stringify(env, null, 1));
  await rename(srcDir, path.join(ENVS, id));
  return env;
}

/** Existing environments a list of new map ids would collide with. */
async function findConflicts(maps) {
  const out = [];
  for (const m of maps) {
    const existing = await readEnv(m.id);
    if (existing) out.push({ id: m.id, theme: m.theme, gameVersion: m.gameVersion, existingSource: existing.source, existingDate: existing.createdAt });
  }
  return out;
}

// ---------------------------------------------------------------- .subwaymap packages
// A .subwaymap is a zip of one environment folder plus a subwaymap.json header:
//   subwaymap.json  { format, id, theme, gameVersion, createdAt }
//   env.json, manifest.json, thumbnail.jpg?, glb/…, mesh/…, tex/…

const SUBWAYMAP_FORMAT = 1;
const MAX_PACKAGE = 512 * 1024 * 1024;

async function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full, base)));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

async function exportEnv(id) {
  const dir = path.join(ENVS, slug(id));
  const env = JSON.parse(await readFile(path.join(dir, 'env.json'), 'utf8'));
  const header = { format: SUBWAYMAP_FORMAT, id: env.id, theme: env.theme, gameVersion: env.gameVersion, createdAt: env.createdAt };
  const entries = [{ name: 'subwaymap.json', data: Buffer.from(JSON.stringify(header, null, 1)) }];
  for (const rel of await listFiles(dir)) entries.push({ name: rel, data: await readFile(path.join(dir, rel)) });
  return { env, zip: writeZip(entries) };
}

async function importEnv(buf, sourceName, policy = null, note = '') {
  const entries = readZip(buf);
  const headerEntry = entries.find((e) => e.name === 'subwaymap.json');
  if (!headerEntry) throw new Error('Not a .subwaymap package (subwaymap.json missing)');
  const header = JSON.parse(headerEntry.data.toString('utf8'));
  if (header.format > SUBWAYMAP_FORMAT) throw new Error('This .subwaymap was made by a newer version of the viewer');
  if (!entries.some((e) => e.name === 'manifest.json')) throw new Error('Package has no manifest.json');
  const id = slug(`${header.theme}_${header.gameVersion}`);
  if (!policy) {
    const conflicts = await findConflicts([{ id, theme: header.theme, gameVersion: header.gameVersion }]);
    if (conflicts.length) return { conflicts };
  }
  const staging = path.join(JOBS, `import-${randomUUID()}`);
  try {
    return await installPackage(entries, header, id, staging, sourceName, policy ?? 'replace', note);
  } catch (e) {
    await rm(staging, { recursive: true, force: true });
    throw e;
  }
}

async function installPackage(entries, header, id, staging, sourceName, policy, note) {
  for (const { name, data } of entries) {
    if (name === 'subwaymap.json') continue;
    const target = path.resolve(staging, name);
    if (!target.startsWith(staging + path.sep)) throw new Error(`Unsafe path in package: ${name}`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  }
  const fields = {
    thumbnail: entries.some((e) => e.name === 'thumbnail.jpg'),
    ...JSON.parse(entries.find((e) => e.name === 'env.json')?.data.toString('utf8') ?? '{}'),
    theme: header.theme,
    gameVersion: header.gameVersion,
    importedFrom: sourceName,
  };
  fields.source ??= sourceName;
  fields.createdAt ??= new Date().toISOString();
  const env = await placeEnv(staging, id, policy, fields, note);
  return env ?? { skipped: true, theme: header.theme, gameVersion: header.gameVersion };
}

// ---------------------------------------------------------------- extraction job

const STAGES = {
  queued: 'Waiting in queue',
  upload: 'Receiving game package',
  download: 'Downloading from SYBO',
  load: 'Reading game files',
  'export-project': 'Exporting Unity project',
  'export-content': 'Exporting models and textures',
  build: 'Building environments',
  install: 'Installing environments',
  done: 'Done',
};

/**
 * A .zip that only wraps one APK (macOS "Compress", some download sites) is unwrapped:
 * AssetRipper reads zips as split-APK bundles (APKPure: manifest.json + APKs) and would
 * find nothing in it. Returns the path to hand to the ripper.
 */
async function unwrapSinglePackage(apkPath) {
  if (path.extname(apkPath).toLowerCase() !== '.zip') return apkPath;
  let entries;
  try {
    entries = readZip(await readFile(apkPath)).filter((e) => !e.name.startsWith('__MACOSX/') && !path.basename(e.name).startsWith('.'));
  } catch {
    return apkPath; // let the ripper report it
  }
  const [only] = entries;
  if (entries.length !== 1 || !PACKAGE_EXTENSIONS.has(path.extname(only.name).toLowerCase())) return apkPath;
  const inner = path.join(path.dirname(apkPath), `inner${path.extname(only.name).toLowerCase()}`);
  await writeFile(inner, only.data);
  await rm(apkPath, { force: true });
  return unwrapSinglePackage(inner); // a zip in a zip
}

/** Starts the oldest queued job unless one is already running (one extraction at a time). */
function startNextJob() {
  const all = [...jobs.values()];
  if (all.some((j) => j.status === 'running' || j.status === 'conflict')) return;
  const next = all.find((j) => j.status === 'queued');
  if (next) runJob(next, next.apkPath, next.source).finally(startNextJob);
}

async function runJob(job, apkPath, sourceName) {
  job.status = 'running';
  const dir = path.join(JOBS, job.id);
  const exportDir = path.join(dir, 'export');
  const splitDir = path.join(dir, 'envs');
  const log = (line) => {
    job.log.push(line);
    if (job.log.length > 400) job.log.shift();
  };
  const setStage = (s) => {
    job.stage = s;
    job.label = STAGES[s] ?? s;
  };
  setStage(job.remote ? 'download' : 'load');
  try {
    if (job.remote) {
      // A map the game downloads: its bundle from SYBO + the shared bundles kept from its APK
      const { version, id } = job.remote;
      apkPath = await prepareRemoteMap(REMOTE, version, id, dir, (f, bytes) => (job.label = `${STAGES.download} (${f != null ? `${Math.round(f * 100)}%` : `${(bytes / 1048576).toFixed(1)} MB`})`));
      sourceName = `SYBO download ${version}`; // the builder reads the game version from the name
      setStage('load');
    } else {
      // An APK/XAPK is a zip: catch HTML/XML error pages saved as .apk (expired download links)
      const head = Buffer.alloc(4);
      const fh = await open(apkPath, 'r');
      await fh.read(head, 0, 4, 0);
      await fh.close();
      if (head.toString('latin1', 0, 2) !== 'PK') {
        throw new Error('This file is not an APK (it looks like a web page or an error message). Download the APK again.');
      }
      apkPath = await unwrapSinglePackage(apkPath);
      // The maps this game version downloads at runtime, for "Import map"
      try {
        const kit = await saveRemoteKit(apkPath, REMOTE, sourceName);
        if (kit) log(`Downloadable maps: ${kit.maps} (game version ${kit.version})`);
      } catch (e) {
        log(`Downloadable maps not saved: ${e.message}`);
      }
    }
    const [cmd, pre] = ripperCommand();
    await run(cmd, [...pre, exportDir, apkPath], (line) => {
      const m = line.match(/^@@stage (\S+)/);
      if (m) setStage(m[1] === 'done' ? 'build' : m[1]); // the job is done only after the build
      else if (line.startsWith('@@error')) job.error = line.slice(8);
      else if (line.startsWith('@@warning')) job.warning = line.slice(10);
      else log(line);
    });
    await rm(apkPath, { recursive: true, force: true });

    setStage('build');
    await buildManifest({ exportDir, out: splitDir, split: true, sourceName }, log);
    await rm(exportDir, { recursive: true, force: true }); // ~2 GB of intermediate files

    const maps = [];
    for (const theme of await readdir(splitDir)) {
      const manifest = JSON.parse(await readFile(path.join(splitDir, theme, 'manifest.json'), 'utf8'));
      const gameVersion = manifest.source?.gameVersion ?? 'unknown';
      maps.push({ theme, gameVersion, id: slug(`${theme}_${gameVersion}`) });
    }
    if (!maps.length) throw new Error('No map found in this package: this game version is not supported.');

    // Maps already installed (same map, same version): ask what to do, per map
    const conflicts = await findConflicts(maps);
    let choices = {};
    let notes = {};
    if (conflicts.length) {
      job.status = 'conflict';
      job.conflicts = conflicts;
      job.label = 'Waiting for your choice';
      ({ choices, notes } = await new Promise((resolve) => (job.resolve = resolve)));
      job.status = 'running';
      delete job.conflicts;
    }

    setStage('install');
    for (const m of maps) {
      const policy = CONFLICT_POLICIES.has(choices[m.id]) ? choices[m.id] : 'replace';
      const env = await placeEnv(path.join(splitDir, m.theme), m.id, policy, {
        theme: m.theme,
        gameVersion: m.gameVersion,
        source: sourceName,
        createdAt: new Date().toISOString(),
        thumbnail: false,
      }, notes?.[m.id]);
      if (env) job.envs.push(env.id);
      else job.skipped = (job.skipped ?? 0) + 1;
    }
    await rm(dir, { recursive: true, force: true });
    setStage('done');
    job.status = 'done';
  } catch (e) {
    job.status = 'error';
    job.error = job.error ?? e.message;
    log(String(e.stack ?? e));
    await rm(dir, { recursive: true, force: true }); // don't leave a ~2 GB half export behind
  }
}

// ---------------------------------------------------------------- http

function sendJson(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('Body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

/** Express/Connect-style middleware. Returns true when it handled the request. */
export async function handle(req, res) {
  const url = new URL(req.url, 'http://local');
  const parts = url.pathname.split('/').filter(Boolean);

  // Static environment files: /envs/<id>/<file...>
  if (parts[0] === 'envs' && req.method === 'GET') {
    const file = path.join(ENVS, ...parts.slice(1).map(decodeURIComponent));
    if (!file.startsWith(ENVS + path.sep) || !existsSync(file) || !(await stat(file)).isFile()) {
      res.writeHead(404).end();
      return true;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    createReadStream(file).pipe(res);
    return true;
  }
  if (parts[0] !== 'api') return false;

  try {
    // GET /api/envs
    if (parts[1] === 'envs' && parts.length === 2 && req.method === 'GET') {
      sendJson(res, 200, await listEnvs());
      return true;
    }
    // DELETE /api/envs/:id
    if (parts[1] === 'envs' && parts.length === 3 && req.method === 'DELETE') {
      const dir = path.join(ENVS, slug(parts[2]));
      if (!existsSync(dir)) return sendJson(res, 404, { error: 'Not found' }), true;
      await rm(dir, { recursive: true, force: true });
      sendJson(res, 200, { ok: true });
      return true;
    }
    // GET /api/envs/:id/export  -> <Theme>_<version>.subwaymap
    if (parts[1] === 'envs' && parts[3] === 'export' && req.method === 'GET') {
      if (!existsSync(path.join(ENVS, slug(parts[2]), 'env.json'))) return sendJson(res, 404, { error: 'Not found' }), true;
      const { env, zip } = await exportEnv(parts[2]);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${slug(`${env.theme}_${env.gameVersion}`)}.subwaymap"`,
        'Content-Length': zip.length,
      });
      res.end(zip);
      return true;
    }
    // POST /api/import?name=<file>   (.subwaymap body)
    if (parts[1] === 'import' && req.method === 'POST') {
      const name = path.basename(url.searchParams.get('name') ?? 'map.subwaymap');
      await mkdir(JOBS, { recursive: true });
      const policy = CONFLICT_POLICIES.has(url.searchParams.get('onConflict')) ? url.searchParams.get('onConflict') : null;
      const result = await importEnv(await readBody(req, MAX_PACKAGE), name, policy, url.searchParams.get('note') ?? '');
      sendJson(res, result.conflicts ? 409 : 200, result);
      return true;
    }
    // PUT /api/envs/:id/thumbnail  (image/jpeg body)
    if (parts[1] === 'envs' && parts[3] === 'thumbnail' && req.method === 'PUT') {
      const dir = path.join(ENVS, slug(parts[2]));
      if (!existsSync(dir)) return sendJson(res, 404, { error: 'Not found' }), true;
      await writeFile(path.join(dir, 'thumbnail.jpg'), await readBody(req));
      const envFile = path.join(dir, 'env.json');
      const env = JSON.parse(await readFile(envFile, 'utf8'));
      await writeFile(envFile, JSON.stringify({ ...env, thumbnail: true }, null, 1));
      sendJson(res, 200, { ok: true });
      return true;
    }
    // POST /api/extract?name=<file name>   (raw .apk / .xapk body)
    if (parts[1] === 'extract' && req.method === 'POST') {
      const sourceName = path.basename(url.searchParams.get('name') ?? 'game.apk');
      const ext = path.extname(sourceName).toLowerCase();
      if (!PACKAGE_EXTENSIONS.has(ext)) {
        req.resume();
        return sendJson(res, 400, { error: `Unsupported file type "${ext}". Use an .apk, .xapk or .zip.` }), true;
      }
      await staleJobsCleared;
      const id = randomUUID();
      const dir = path.join(JOBS, id);
      await mkdir(dir, { recursive: true });
      const apkPath = path.join(dir, `input${ext}`);
      try {
        await new Promise((resolve, reject) => {
          const out = createWriteStream(apkPath);
          req.pipe(out);
          out.on('finish', resolve);
          out.on('error', reject);
          req.on('error', reject);
        });
      } catch (e) {
        await rm(dir, { recursive: true, force: true }); // upload interrupted
        throw e;
      }
      // Queued once fully received, so a half upload never starts
      const job = { id, source: sourceName, apkPath, status: 'queued', stage: 'queued', label: STAGES.queued, log: [], envs: [], error: null };
      jobs.set(id, job);
      startNextJob(); // runs in the background; poll /api/jobs/:id
      sendJson(res, 202, { jobId: id });
      return true;
    }
    // GET /api/remote  -> maps of the newest game version that SYBO serves for download
    if (parts[1] === 'remote' && parts.length === 2 && req.method === 'GET') {
      const kit = await latestKit(REMOTE);
      if (!kit) return sendJson(res, 200, { version: null, maps: [] }), true;
      const installed = new Set((await listEnvs()).map((e) => e.theme.toLowerCase().replace(/^\d+\.\d+_/, '')));
      const pending = new Set([...jobs.values()].filter((j) => j.remote && ['queued', 'running', 'conflict'].includes(j.status)).map((j) => j.remote.id));
      const maps = kit.maps.map((m) => ({ id: m.id, installed: installed.has(m.id), pending: pending.has(m.id) }));
      sendJson(res, 200, { version: kit.version, maps });
      return true;
    }
    // POST /api/remote/:version/:id  -> download + extract one map (a job like an APK's)
    if (parts[1] === 'remote' && parts.length === 4 && req.method === 'POST') {
      await staleJobsCleared;
      const [version, mapId] = parts.slice(2).map(decodeURIComponent);
      if (!existsSync(path.join(REMOTE, slug(version), 'index.json'))) return sendJson(res, 404, { error: 'Unknown game version' }), true;
      const id = randomUUID();
      await mkdir(path.join(JOBS, id), { recursive: true });
      const job = { id, source: `${mapId} (SYBO)`, remote: { version: slug(version), id: mapId }, status: 'queued', stage: 'queued', label: STAGES.queued, log: [], envs: [], error: null };
      jobs.set(id, job);
      startNextJob();
      sendJson(res, 202, { jobId: id });
      return true;
    }
    // GET /api/jobs  (running job first, then the queue in order)
    if (parts[1] === 'jobs' && parts.length === 2 && req.method === 'GET') {
      const active = [...jobs.values()].filter((j) => j.status === 'running' || j.status === 'conflict' || j.status === 'queued');
      sendJson(res, 200, active.map((j) => ({ id: j.id, source: j.source, status: j.status, stage: j.stage })));
      return true;
    }
    // DELETE /api/jobs/:id  (queued jobs only: a running extraction can't be stopped cleanly)
    if (parts[1] === 'jobs' && parts.length === 3 && req.method === 'DELETE') {
      const job = jobs.get(parts[2]);
      if (!job) return sendJson(res, 404, { error: 'Unknown job' }), true;
      if (job.status !== 'queued') return sendJson(res, 409, { error: 'Only waiting jobs can be removed' }), true;
      jobs.delete(job.id);
      await rm(path.join(JOBS, job.id), { recursive: true, force: true });
      sendJson(res, 200, { ok: true });
      return true;
    }
    // POST /api/jobs/:id/resolve  { choices: { <envId>: 'replace' | 'keep' | 'skip' } }
    if (parts[1] === 'jobs' && parts[3] === 'resolve' && req.method === 'POST') {
      const job = jobs.get(parts[2]);
      if (!job?.resolve) return sendJson(res, 409, { error: 'Nothing to resolve' }), true;
      const { choices = {}, notes = {} } = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const resolve = job.resolve;
      delete job.resolve;
      resolve({ choices, notes });
      sendJson(res, 200, { ok: true });
      return true;
    }
    // GET /api/jobs/:id
    if (parts[1] === 'jobs' && parts.length === 3 && req.method === 'GET') {
      const job = jobs.get(parts[2]);
      if (!job) return sendJson(res, 404, { error: 'Unknown job' }), true;
      const { resolve, apkPath, ...visible } = job;
      sendJson(res, 200, { ...visible, log: job.log.slice(-12) });
      return true;
    }
    sendJson(res, 404, { error: 'Unknown endpoint' });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
  return true;
}

/** Vite plugin mounting the API on the dev server. */
export function apiPlugin() {
  return {
    name: 'subway-env-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        handle(req, res).then((done) => done || next(), next);
      });
    },
  };
}
