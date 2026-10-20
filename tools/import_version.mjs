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
// 5 (2026-10-20): ≤ 1.54 sky gradient offset (1.35/1.49 Hawaii's pink horizon was off screen);
//   1.44-1.54 skylines laid in EnvironmentBackground's slots, with each mover's speed (1.49
//   Hawaii's mountains and town never took turns)
// 6 (2026-10-20): 1.x Rotate scripts (1.93 Hong Kong's landmark lasers sweep); 1.55+ skyline
//   layers keep their speed and objects their drift (laid and moved as the game does)
// 7 (2026-10-20): 1.x _baseIgnoredEnvironmentKinds lay no track (1.111 Houston's rails
//   through water); 2.x+ decorations no chunk or config spawns are "unplaced" (2.16 Houston's
//   truck in the trees)
// 8 (2026-10-20): Unity 5.x packed particle colors ({ rgba: int }) decoded: they all came out
//   opaque white (1.56 Las Vegas' cyan fountain spray fading out at the top, 1.45 Kenya's
//   waterfall spray, 1.60 Iceland's lava glow, geysers, snow and splashes)
export const IMPORT_VERSION = 8;
