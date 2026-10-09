// Shared by the importer (tools/build_manifest.mjs) and the server (server/remote.js).

/** A game version in a download's file name: dotted ("_1.44.0-70_", "_3.69.2_"), or dashed
 * right before the extension ("subway-surfers-1-31-0.apk"). */
export function versionFromName(name = '') {
  return (name ?? '').match(/(?:^|[_+\s-])(\d+\.\d+(?:\.\d+)?)(?=[-_+\s(]|\.(?:apk|xapk|zip|ipa)$|$)/i)?.[1]
    ?? (name ?? '').match(/(?:^|[_+\s-])(\d+)-(\d+)(?:-(\d+))?\.(?:apk|xapk|zip|ipa)$/i)?.slice(1).filter(Boolean).join('.')
    ?? null;
}
