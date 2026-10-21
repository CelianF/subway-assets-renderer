# Changelog

## 1.2.1: security update (2026-10-21)

Electron 44.9.3: the bundled trust store now rejects the eight compromised eMudhra intermediate CAs (fixed in Electron 44.9.1). No other change.

## 1.2.0: the classic cities update (2026-10-20)

51 commits since 1.1.0. The viewer used to be built around recent maps (3.x). This release makes the **whole history of the game** work: 1.x and 2.x cities are laid out, animated and lit the way the game does, and the home page and importer got the tools to handle a library of dozens of maps.

> **Re-import your APKs.** Many fixes below change what the importer extracts. Maps imported by an older version now show a one-time notice (*"Imported with an older version"*) with the APK to re-import. Maps still open without it, but some parts may look wrong or be missing.

> **New license.** The project is now under the **GNU AGPL-3.0** (see [License](#license-change)).

### Classic cities (1.x and 2.x)

- **Layout**: transitions for every 1.x environment kind (Chicago's pillar hall entry and exit, gates, stations, landmarks) with their excluded neighbors; filler stretches' entry and exit arches; one building height per stretch; single-prefab placeholders (Dubai's balloon flame); the showcase spawns every placeholder option, and classic intros are placed by their front edge (no gap on old Beijing).
- **Skylines**: classic skylines laid as the game lays them (1.43, 1.44 to 1.54 in EnvironmentBackground's slots, 1.55+ with each layer's speed and each object's drift), moving objects take turns, layer offset read from EnvironmentBackground (1.56+ at camera + 900: Las Vegas silhouettes were drawn at half their distance), skyline layer color modes, and the skyline *Distance* slider scales classic layers' depth.
- **Sky**: gradient offset for 1.54 and older (Hawaii's pink horizon was off screen), 3.x sky color triggers (Haunted Hood's landmark), Las Vegas 1.56 starry sky.
- **Season skin toggle** for classic 1.4 / 1.5 (plain textures, meshes and colors kept at import).
- **Ad billboards** (1.107): off like in play, with an *Ad billboards* toggle to show them.
- **Version names**: dashed file names (`subway-surfers-1-31-0.apk`) and versions after words (1.29) are understood, so old APKs get the right version.

### City by city

- **Copenhagen**: wall graffiti, fireworks with trails and braking, foam, water and waves as compiled, old particle ranges and per-frame forces, looping legacy clips, built-in sprite particles, distant scenery (1.71).
- **Dubai** (1.104): sea gradient mirrored like the mesh, aquarium glass tint as compiled, still fish, bubbles unscaled in Shape mode, ripples rolling to the shore, the studio keeps the run's scenery and billboards.
- **Hawaii**: 1.49 skyline slots that move and take turns, 1.70 lava scrolls, the showcase shows every variant.
- **Hong Kong and Houston**: landmark lasers sweep, layered skyline, water colors, water track, decorations, particle colors, no rails through water (1.111), Houston's water white patches (EffectPlayer flipbooks found in every copy).
- **Iceland**: landmark snow stays on the landmark, 1.x and 2.x seas swell, 1.60 lava glow visible.
- **Las Vegas**: 1.56 starry sky, cyan fountain spray, fish sway (2.x+).
- **Kenya**: waterfall scrolls in seconds (it was 20x too slow), spray colors.
- **Havana** (1.90, 1.61): waterfall and fountain on the seconds clock, flags, low-end train hidden.
- **Istanbul and Hollywood**: combined reflections as compiled on windscreens, Hollywood's pillar lasers face the camera, tunnel fires matched by their parents (3.57), moving trains' lights blink in a loop.
- **Journey to the East** (2.12): fireworks as compiled (additive, no tint, no fog) with trails emitting by distance, train glass reflection layer back.
- **Edinburgh** (2.3.1): white stones and the hole by the start fixed.
- **Subway City** (2.37): Burger King store's kids' building hidden, campaign ad pieces open the run.
- **Sydney** (3.65): the tube's shark is back. **Ireland**: tube puffin and big rocks.
- **Cosmic Crossroads**: Subway City opening through the portal with its own trains.
- **Fantasy Fest** (3.x): runner-triggered groups fire together.
- **Amsterdam**: tulip colors, swaying tulip heads, flying birds, distant scenery. **Arabia**: camels graze, sand glitter, event glow. **Atlanta**: whole stadium, fountain jet, smoke plumes. **Bali and Bangkok**: seamless water waves, leaves by the start train. **Berlin**: steam rises in its cone at any scale. **Buenos Aires**: smoother shore foam. **Cairo**: sun layer in its own materials, place and scale. **Chicago**: clouds in their gradient. **Changan**: landmark fog lies flat under the bridge.

### Rendering and particles

- Particles: 3D start rotation kept (also for velocity-aligned meshes), stretched particles along their 3D velocity, opaque particle materials solid, dead particles freed before emitting, trail width by particle size, Unity 5 packed particle colors decoded (they all came out opaque white).
- Materials: *Bend/UV Scroll* and *Bend/Particle Additive* as compiled, *Bend/Flag* rule, 2.x ScreenMask rails highlight, UVWave and Wave seas, extra material passes (renderers with more materials than submeshes draw the last submesh again with each: Istanbul, Iceland 1.60, Las Vegas 1.56 glass), combined reflections sample `_RefCube` as the cubemap strip it is.
- Random groups: children matched to their weights by exact name, a node named like a group holds one of its options, same-named groups merged, self-only groups choose nothing, `QualityToggle` low-end alternates and `CoppaObjectSwitcher` hidden. Fixes missing or doubled props across many cities.
- Moving trains' lights blink in a loop; mesh flipbooks timed at 120 Hz.
- The importer warns about shaders without a viewer rule and about unmatched Bend shaders.

### Home and import

- **Maps grouped by city** with search. *Share city* packs all of a city's maps in one file, *Delete city* removes them.
- The import queue runs past "map already exists" choices, with *Replace* recommended, and the progress bar follows the extraction.
- Known cities match whatever their spacing and case (`Lasvegas` and `LasVegas` are one Las Vegas).
- Import version stamp: every map records the importer version that built it, and older ones are told once to re-import.
- Remote cities (3.70) also download the season hunt tokens.

### Chunks, studio and camera

- Chunk studio: fixed-width strip items, *Remove all* on the strip, start and variant cards, section types fold behind a › tab, a ▾ edit bar per chunk (each piece's type, building sides, gate wall).
- Pickups and hunt tokens for imported cities, with hunt token outlines.
- Fly camera: sprint is twice as fast (x8).

### License change

Starting with this version the code is licensed under the **GNU Affero General Public License v3.0**: anyone who distributes a modified version, or lets people use one over a network, must publish their source under the same license. Versions up to 1.1.0 were published without a license. The game's assets stay SYBO's property and are never part of this repo.

## 1.1.0 (2026-10-07)

See the [release](https://github.com/CelianF/subway-assets-renderer/releases/tag/v1.1.0).
