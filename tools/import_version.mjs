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
// 9 (2026-10-20): classic skylines' layer offset read from EnvironmentBackground (1.56+ at
//   camera + 900: 1.56 Las Vegas' silhouettes were drawn at half their distance)
// 10 (2026-10-20): extra material passes (renderers with more materials than submeshes:
//   2.12 Journey to the East's train glass reflection layer was dropped)
// 11 (2026-10-21): the theme's own run-wide snow (1.x `_effects` FallingSnowThemeEffect, the
//   runner EFX's showSnow): 1.32 and 1.96 London had no snow while running
// 12 (2026-10-21): Unity <= 5.4 particle bursts (cnt0-3/time0-3: 1.46 Transylvania's
//   pillar-hall lightning never flashed); 1.x decorations no placeholder spawns are
//   "unplaced" (1.46's extra_3 glow in the cemetery); Mesh shapes keep their mesh (3.70
//   Transylvania's frost rose on the middle track instead of beside it)
// 13 (2026-10-22): ≤ 1.43 classic levels split the modern way: road looks as sections, chunks
//   with their own scenery laid whole, the plain chunks' trains and obstacles as gameplay
//   chunks (`manifest.classic`): the chunk editor and the studio work on them like any map
export const IMPORT_VERSION = 13;
// Maps built before this one don't open: the viewer has dropped what reading them needed (13:
// classic levels as whole chunks) and asks for a re-import
export const MIN_IMPORT_VERSION = 13;
