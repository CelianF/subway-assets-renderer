// Local backend: APK upload -> headless AssetRipper -> manifest builder -> one
// environment per map under workspace/envs/<id>/. No dependencies (node:* only),
// mounted by the Vite dev server and by server/index.js in production.
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE = process.env.SUBWAY_WORKSPACE ? path.resolve(process.env.SUBWAY_WORKSPACE) : path.join(ROOT, 'workspace');
const ENVS = path.join(WORKSPACE, 'envs');
const JOBS = path.join(WORKSPACE, 'jobs');
const IS_WIN = process.platform === 'win32';

const MIME = {
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

const jobs = new Map(); // id -> { id, status, stage, log: [], envs: [], error }

// AssetRipper picks how to unpack an archive from its extension (APK, split APKs, …)
const PACKAGE_EXTENSIONS = new Set(['.apk', '.xapk', '.zip']);

// ---------------------------------------------------------------- tools

/** .NET runtime + ripper: self-contained build if present, else `dotnet ripper.dll`. */
function ripperCommand() {
  const selfContained = path.join(ROOT, 'dist', 'ripper-native', IS_WIN ? 'ripper.exe' : 'ripper');
  if (existsSync(selfContained)) return [selfContained, []];
  const dll = path.join(ROOT, 'dist', 'ripper', 'ripper.dll');
  const localDotnet = path.join(ROOT, '.tools', 'dotnet', IS_WIN ? 'dotnet.exe' : 'dotnet');
  return [existsSync(localDotnet) ? localDotnet : 'dotnet', [dll]];
}

function pythonCommand() {
  return process.env.PYTHON ?? (IS_WIN ? 'python' : 'python3');
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

// ---------------------------------------------------------------- extraction job

const STAGES = {
  upload: 'Receiving game package',
  load: 'Reading game files',
  'export-project': 'Exporting Unity project',
  'export-content': 'Exporting models and textures',
  build: 'Building environments',
  install: 'Installing environments',
  done: 'Done',
};

async function runJob(job, apkPath, sourceName) {
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
  try {
    const [cmd, pre] = ripperCommand();
    await run(cmd, [...pre, exportDir, apkPath], (line) => {
      const m = line.match(/^@@stage (\S+)/);
      if (m) setStage(m[1]);
      else if (line.startsWith('@@error')) job.error = line.slice(8);
      else log(line);
    });
    await rm(apkPath, { force: true });

    setStage('build');
    await run(pythonCommand(), ['tools/build_manifest.py', exportDir, '--split', '--out', splitDir, '--source-name', sourceName], log);
    await rm(exportDir, { recursive: true, force: true }); // ~2 GB of intermediate files

    setStage('install');
    await mkdir(ENVS, { recursive: true });
    for (const theme of await readdir(splitDir)) {
      const manifest = JSON.parse(await readFile(path.join(splitDir, theme, 'manifest.json'), 'utf8'));
      const version = manifest.source?.gameVersion ?? 'unknown';
      const id = slug(`${theme}_${version}`);
      const dest = path.join(ENVS, id);
      await rm(dest, { recursive: true, force: true }); // re-extracting the same version replaces it
      await rename(path.join(splitDir, theme), dest);
      const env = { id, theme, gameVersion: version, source: sourceName, createdAt: new Date().toISOString(), thumbnail: false };
      await writeFile(path.join(dest, 'env.json'), JSON.stringify(env, null, 1));
      job.envs.push(id);
    }
    await rm(dir, { recursive: true, force: true });
    if (!job.envs.length) throw new Error('No map found in this package: this game version is not supported.');
    setStage('done');
    job.status = 'done';
  } catch (e) {
    job.status = 'error';
    job.error = job.error ?? e.message;
    log(String(e.stack ?? e));
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
      const job = { id: randomUUID(), source: sourceName, status: 'running', stage: 'upload', label: STAGES.upload, log: [], envs: [], error: null };
      jobs.set(job.id, job);
      const dir = path.join(JOBS, job.id);
      await mkdir(dir, { recursive: true });
      const apkPath = path.join(dir, `input${ext}`);
      await new Promise((resolve, reject) => {
        const out = createWriteStream(apkPath);
        req.pipe(out);
        out.on('finish', resolve);
        out.on('error', reject);
        req.on('error', reject);
      });
      runJob(job, apkPath, sourceName); // runs in the background; poll /api/jobs/:id
      sendJson(res, 202, { jobId: job.id });
      return true;
    }
    // GET /api/jobs  (running jobs, so a reloaded home page can resume showing progress)
    if (parts[1] === 'jobs' && parts.length === 2 && req.method === 'GET') {
      sendJson(res, 200, [...jobs.values()].filter((j) => j.status === 'running').map((j) => ({ id: j.id, source: j.source, stage: j.stage })));
      return true;
    }
    // GET /api/jobs/:id
    if (parts[1] === 'jobs' && parts.length === 3 && req.method === 'GET') {
      const job = jobs.get(parts[2]);
      if (!job) return sendJson(res, 404, { error: 'Unknown job' }), true;
      sendJson(res, 200, { ...job, log: job.log.slice(-12) });
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
