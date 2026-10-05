// Unity Addressables content catalog (catalog.json, 1.x format): which bundles a map needs.
// A city's "themes-<remote|builtin>_assets_<city>_config" bundle holds its ThemeConfig; its
// prefabs, meshes and textures sit in the bundles the catalog lists as its dependencies.

/** Parses a catalog.json into internal ids and, per entry, the entry indices it depends on. */
export function parseCatalog(json) {
  const ids = json.m_InternalIds;
  const buckets = readBuckets(Buffer.from(json.m_BucketDataString, 'base64'));
  const entryData = Buffer.from(json.m_EntryDataString, 'base64');
  const count = entryData.readInt32LE(0);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const o = 4 + i * 28; // 7 int32: internalId, provider, dependencyKey, depHash, data, primaryKey, resourceType
    entries.push({ id: entryData.readInt32LE(o), provider: entryData.readInt32LE(o + 4), dependencyKey: entryData.readInt32LE(o + 8) });
  }
  return { ids, buckets, entries, providers: json.m_ProviderIds };
}

function readBuckets(buf) {
  const count = buf.readInt32LE(0);
  const out = [];
  let o = 4;
  for (let i = 0; i < count; i++) {
    o += 4; // offset into the key data
    const n = buf.readInt32LE(o);
    o += 4;
    const list = [];
    for (let k = 0; k < n; k++, o += 4) list.push(buf.readInt32LE(o));
    out.push(list);
  }
  return out;
}

const BUNDLE = /\.bundle$/;
const CONFIG = /themes-(remote|builtin)_assets_([a-z0-9]+)_config_[0-9a-f]+\.bundle$/;

/** Cities the catalog knows: [{ id: 'brawlstars', remote, config: internal id }]. */
export function catalogThemes(catalog) {
  const out = [];
  for (const id of catalog.ids) {
    const m = id.match(CONFIG);
    if (m && m[2] !== '' && !m[2].startsWith('_')) out.push({ id: m[2], remote: m[1] === 'remote', config: id });
  }
  return out;
}

/**
 * Every bundle (internal id) a city needs: the bundles listed by each asset that lists the
 * city's config bundle among its own (Addressables dependency lists are already complete).
 */
export function themeBundles(catalog, configId) {
  const { ids, buckets, entries } = catalog;
  const configIndex = ids.indexOf(configId);
  const start = entries.findIndex((e) => e.id === configIndex);
  if (start < 0) return [];
  const need = new Set([start]);
  for (const e of entries) {
    const deps = e.dependencyKey >= 0 ? buckets[e.dependencyKey] ?? [] : [];
    if (deps.includes(start)) for (const d of deps) need.add(d);
  }
  return [...need].map((i) => ids[entries[i].id]).filter((id) => BUNDLE.test(id));
}
