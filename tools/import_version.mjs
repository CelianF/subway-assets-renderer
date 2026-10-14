// The importer's version, stamped into every map it builds (manifest.importVersion). Raise it
// whenever an importer change needs maps re-imported to show (new data, fixed parsing): the
// viewer then tells maps imported before to re-import their APK. Viewer-only fixes don't
// need it. Maps without a stamp were imported before it existed.
//
// 1 (2026-10-12): first stamp (skyline mesh decoding, classic skylines, sky color triggers,
//   trail widths, trigger groups)
// 2 (2026-10-13): CoppaObjectSwitcher's kids' object hidden (2.37 Subway City's Burger King
//   store was under a plain building)
// 3 (2026-10-14): same-named random groups merged (3.65 Sydney's tube lost its shark: the last
//   "random_fish" group's list replaced the first, which held it)
// 4 (2026-10-14): QualityToggle's low-end alternate hidden (1.61 Havana's FX_train_ani1/2 drew
//   train_standard and train_low together)
export const IMPORT_VERSION = 4;
