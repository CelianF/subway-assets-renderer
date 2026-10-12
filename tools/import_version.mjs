// The importer's version, stamped into every map it builds (manifest.importVersion). Raise it
// whenever an importer change needs maps re-imported to show (new data, fixed parsing): the
// viewer then tells maps imported before to re-import their APK. Viewer-only fixes don't
// need it. Maps without a stamp were imported before it existed.
//
// 1 (2026-10-12): first stamp (skyline mesh decoding, classic skylines, sky color triggers,
//   trail widths, trigger groups)
export const IMPORT_VERSION = 1;
