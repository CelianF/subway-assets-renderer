// The importer's version, stamped into every map it builds (manifest.importVersion). Raise it
// whenever an importer change needs maps re-imported to show (new data, fixed parsing): the
// viewer then tells maps imported before to re-import their APK. Viewer-only fixes don't
// need it. Maps without a stamp were imported before it existed.
//
// 1 (2026-10-12): first stamp (skyline mesh decoding, classic skylines, sky color triggers,
//   trail widths, trigger groups)
// 2 (2026-10-13): CoppaObjectSwitcher's kids' object hidden (2.37 Subway City's Burger King
//   store was under a plain building)
export const IMPORT_VERSION = 2;
