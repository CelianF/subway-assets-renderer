// Maps the game downloads at runtime instead of shipping them in the APK (London, Brawl
// Stars, … most cities). The APK's Addressables catalog lists each one as a single remote
// bundle (themes-remote_assets_<city>_config) whose dependencies all ship in the APK. An
// APK import keeps a "kit" per game version: the list of remote cities and those shared
// bundles (~20 MB), so a remote map is one download plus the kit.
//   <workspace>/remote/<version>/index.json   { version, savedAt, maps: [{ id, address (sybo://…), bundle }] }
//   <workspace>/remote/<version>/bundles/…    shared bundles from the APK
//   <workspace>/remote/<version>/downloads/…  remote bundles already downloaded
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { catalogThemes, parseCatalog, themeBundles } from './catalog.js';
import { readZip } from './zip.js';

const CATALOG = 'assets/aa/catalog.json';
// Shared bundles the kit keeps besides the remote cities' own dependencies: game modes,
// common props (signal lights, pickups), the season hunt tokens (3.70's bat) and the
// scripts/shaders every bundle refers to
const KIT_EXTRA = /^(gamemodes|common|hunttokens)-builtin_assets_|_monoscripts_|_unitybuiltinshaders_/;

/**
 * Where a catalog's sybo://<game>/<project>/<version>/<file> address is served: SYBO's asset
 * CDN ("Tower"), with the game's CDN.URLForBundle template "{0}/{1}/{2}/bundle/{3}/{4}"
 * (base, game, project, version, file).
 */
const CDN_BASE = 'https://assets.tower.sybo.net/v1.0';
export function remoteUrl(internalId) {
  const [game, project, version, ...file] = internalId.replace(/^sybo:\/\//, '').split('/');
  return `${CDN_BASE}/${game}/${project}/bundle/${version}/${file.join('/')}`;
}

/** The APK files under assets/aa/ (an APKPure .zip/.xapk wraps the base APK). */
function aaEntries(buf) {
  const wanted = (name) => name.startsWith('assets/aa/');
  const entries = readZip(buf, (n) => wanted(n) || /\.apk$/i.test(n));
  if (entries.some((e) => e.name === CATALOG)) return entries.filter((e) => wanted(e.name));
  for (const e of entries) {
    if (!/\.apk$/i.test(e.name)) continue;
    const inner = readZip(e.data, wanted);
    if (inner.some((x) => x.name === CATALOG)) return inner;
  }
  return null;
}

const isVersion = (v) => /^\d+(\.\d+)+$/.test(v ?? '');

/**
 * Saves the remote-map kit of an APK. Returns { version, maps } or null when the APK has
 * no Addressables catalog (games before remote cities) or no known game version.
 * `sourceName`: the APK's file name, for the version when the bundles don't give it.
 */
export async function saveRemoteKit(apkPath, root, sourceName = '') {
  const entries = aaEntries(await readFile(apkPath));
  const catalogEntry = entries?.find((e) => e.name === CATALOG);
  if (!catalogEntry) return null;
  const files = new Map(entries.map((e) => [path.basename(e.name), e]));
  // 3.70 keeps its bundles under assets/aa/Android/<version>/; 3.19 keeps them in Android/
  // itself, next to a countryflags-builtin_assets_assets/ folder: then the APK's name tells
  const folder = entries.map((e) => e.name.match(/^assets\/aa\/Android\/([^/]+)\//)?.[1]).find(isVersion);
  const version = folder ?? sourceName.match(/(?:^|[_+\s-])(\d+\.\d+(?:\.\d+)?)(?=[-_+\s(]|\.(?:apk|xapk|zip)$|$)/i)?.[1];
  if (!version) return null;
  const catalog = parseCatalog(JSON.parse(catalogEntry.data.toString('utf8')));
  const maps = [];
  const shared = new Set([...files.keys()].filter((n) => KIT_EXTRA.test(n)));
  for (const theme of catalogThemes(catalog).filter((t) => t.remote)) {
    const bundles = themeBundles(catalog, theme.config);
    const remote = bundles.filter((b) => b.startsWith('sybo://'));
    // Only cities whose other bundles all ship in the APK can be rebuilt from one download
    if (remote.length !== 1 || bundles.some((b) => !b.startsWith('sybo://') && !files.has(path.basename(b)))) continue;
    for (const b of bundles) if (!b.startsWith('sybo://')) shared.add(path.basename(b));
    maps.push({ id: theme.id, address: remote[0], bundle: path.basename(remote[0]) });
  }
  const dir = path.join(root, version);
  await mkdir(path.join(dir, 'bundles'), { recursive: true });
  for (const name of shared) await writeFile(path.join(dir, 'bundles', name), files.get(name).data);
  await writeFile(path.join(dir, 'index.json'), JSON.stringify({ version, savedAt: new Date().toISOString(), maps }, null, 1));
  return { version, maps: maps.length };
}

const versionKey = (v) => v.split('.').map((n) => n.padStart(6, '0')).join('.');

/** The newest kit's remote maps: { version, maps: [{ id, address, bundle }] } or null. */
export async function latestKit(root) {
  if (!existsSync(root)) return null;
  // (a folder that isn't a version: a kit saved under a bundle folder's name before 0.2.3)
  const versions = (await readdir(root)).filter((v) => isVersion(v) && existsSync(path.join(root, v, 'index.json')));
  if (!versions.length) return null;
  const version = versions.sort((a, b) => versionKey(b).localeCompare(versionKey(a)))[0];
  return JSON.parse(await readFile(path.join(root, version, 'index.json'), 'utf8'));
}

/**
 * Downloads one remote map's bundle next to a copy of its kit, ready for the ripper.
 * @returns the input folder
 */
export async function prepareRemoteMap(root, version, id, dir, onProgress = () => {}) {
  const index = JSON.parse(await readFile(path.join(root, version, 'index.json'), 'utf8'));
  const map = index.maps.find((m) => m.id === id);
  if (!map) throw new Error(`Unknown map "${id}" for game version ${version}`);
  const input = path.join(dir, 'bundles');
  await mkdir(input, { recursive: true });
  // Downloads are kept: the file name carries its content hash, so a re-import (after an
  // app update) needs no new download
  const cached = path.join(root, version, 'downloads', map.bundle);
  if (existsSync(cached)) {
    await copyFile(cached, path.join(input, map.bundle));
    await copyKit(root, version, input);
    return input;
  }
  let res;
  // (kits saved before the address template was known kept a full url)
  const url = map.address ? remoteUrl(map.address) : map.url.includes('/bundle/') ? map.url : remoteUrl(map.url.replace(`${CDN_BASE}/`, 'sybo://'));
  map.url = url;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`Could not reach SYBO's server (${e.cause?.code ?? e.message}). Check your connection.`);
  }
  if (!res.ok) {
    const code = (await res.text().catch(() => '')).match(/<Code>(\w+)<\/Code>/)?.[1];
    throw new Error(`SYBO's server didn't send the map (HTTP ${res.status}${code ? ` ${code}` : ''}) from ${map.url}`);
  }
  const total = Number(res.headers.get('content-length')) || 0;
  const chunks = [];
  let got = 0;
  for await (const chunk of res.body) {
    chunks.push(chunk);
    got += chunk.length;
    onProgress(total ? got / total : null, got);
  }
  const data = Buffer.concat(chunks);
  if (data.toString('latin1', 0, 7) !== 'UnityFS') throw new Error(`SYBO's server sent something that isn't a Unity bundle (${map.url})`);
  await writeFile(path.join(input, map.bundle), data);
  await mkdir(path.dirname(cached), { recursive: true });
  await writeFile(cached, data);
  await copyKit(root, version, input);
  return input;
}

async function copyKit(root, version, input) {
  for (const name of await readdir(path.join(root, version, 'bundles'))) {
    await copyFile(path.join(root, version, 'bundles', name), path.join(input, name));
  }
}
