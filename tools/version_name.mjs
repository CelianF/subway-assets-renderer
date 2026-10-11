// Shared by the importer (tools/build_manifest.mjs) and the server (server/remote.js).

/** A game version in a download's file name: dotted ("_1.44.0-70_", "_3.69.2_"), or dashed
 * before the extension, maybe after a few words ("subway-surfers-1-31-0.apk",
 * "subway-surfers-1-29-0-multi-android.apk"). */
export function versionFromName(name = '') {
  return (name ?? '').match(/(?:^|[_+\s-])(\d+\.\d+(?:\.\d+)?)(?=[-_+\s(]|\.(?:apk|xapk|zip|ipa)$|$)/i)?.[1]
    ?? (name ?? '').match(/(?:^|[_+\s-])(\d+)-(\d+)(?:-(\d+))?(?:[-_+\s][a-z][a-z-]*)?\.(?:apk|xapk|zip|ipa)$/i)?.slice(1).filter(Boolean).join('.')
    ?? null;
}
