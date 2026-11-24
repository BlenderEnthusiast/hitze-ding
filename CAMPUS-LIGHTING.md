# Campus lighting and surroundings

Extract the update into your local copy of **hitze-ding**, alongside `index.html`. Allow Windows to merge the folders and replace `js/viewer.js`. The included bake covers the 12 floors in the current repository. Your own new landscape appears after you bake it with the buildings.

## Add your Blender exports

Use glTF 2.0. A binary `.glb` is one file. For a text `.gltf`, copy its `.bin` and texture files too, keeping their relative paths. Export every scene using the same origin, units and axis settings as your existing floors. Keep objects at their campus positions when exporting selections.

| What you exported | Where to put it on your PC | Where it appears |
| --- | --- | --- |
| Terrain, paths, bushes and trees together | `campus-source/surroundings/` | **All buildings** |
| A detailed building exterior or roof, for example building A | `campus-source/exteriors/A/` | Campus and building A. Selecting a floor, room sensor or hiding a floor opens the cutaway. |
| A detailed replacement for a floor, for example A's 200 Ebene | `campus-source/floors/A/200 Ebene/` | Every view that includes that floor |

Use **one** surroundings scene. Each exterior or floor folder accepts one or more scene files. Keep floor and building folder names exactly as they appear in `models/manifest.json`. Exterior files work best for facade and roof geometry. Include interior walls and room geometry in the floor exports. A single undivided building mesh can serve as the exterior, with the existing floor models providing the room views. Avoid overlapping copies of the same exterior surface.

The existing models under `models/all/` provide a floor layout, coordinates and fallback geometry. Detail exports can add visual detail while using that layout. If you moved walls, floors or sensors, update the matching layout assets in `models/all/` and positions in `data/sensors.json`. From the repository root run `py tools/prepare_models.py` followed by `node tools/precompute_maps.mjs`, then bake daylight. Publish the changed manifest, layout assets, sensor registry and `data/maps/` along with that update. A landscape-only or aligned visual-detail update needs just the daylight bake.

## Bake and upload

1. On Windows, double-click **Bake-Campus.cmd** from the extracted repo. It finds Blender on PATH or under `Program Files\Blender Foundation`. If you use a portable Blender, set `$env:STRATUM_BLENDER` in PowerShell to the full path of `blender.exe`, then run `.\Bake-Campus.cmd` in the same window.
2. Wait for **Ready**. The last line gives a `models/lighting/<revision>/` folder and `models/lighting.json`. The index is replaced after the complete bake succeeds.
3. For the first install, upload `js/viewer.js`, `js/daylight.js`, the complete generated revision folder, and `models/lighting.json` to the Pages branch, preserving their paths. Put them in the same commit. If uploading in separate steps, upload the index last. The launcher, Python script and this guide can also live in the repo for later use. Keep your large working exports on your PC.
4. Open **All buildings** to see the landscape. Select a building to see its exterior and indoor lighting. Select a floor or sensor to remove the shell and see its rooms. Return to **All buildings** to reload the surroundings.

For later visual updates, upload the new revision folder and new `models/lighting.json`. The Pi keeps serving sensor readings independently. Sensor updates, camera moves and the timeline reuse the baked lighting. If a browser shows **2D floor plan**, its 3D renderer is unavailable and the app shows the floor layout there.

## What is baked

Blender Cycles calculates the warm sun, soft cast shadows, cool skylight and diffuse light bouncing between surfaces. The campus bake includes trees, buildings and the ground together. The building bake includes that building and its shell. A floor bake isolates the selected floor, so a hidden roof or tree does not leave its shadow in a room. The viewer samples the matching lightmap per surface. A small prefiltered sky texture gives glass and metal a view-dependent reflection. Base textures, vertex colours, leaf cutouts and emission use the model's material at display time. Daylight stays fixed across the sensor timeline. Ad hoc eye-button combinations reuse the closest baked layouts. Shadows on the outdoor ground are baked for the complete campus.

The baker makes a separate UV set for lighting. Static exports can keep up to three authored UV sets. Landscape faces are grouped into spatial sections, including when the source is a single large mesh. Nearby props are batched. Sections appear progressively after the buildings load and are released when entering a building. Large generated geometry files are transported in 16 MiB pieces. The browser still has to draw the visible triangles and store their textures.

## Quality and speed

The default bake uses 1,024 pixels per floor or exterior atlas, 2,048 per landscape atlas and 32 samples. The supplied 12-floor bake uses 48 samples. An example for a final outdoor bake with an NVIDIA GPU is

```powershell
.\Bake-Campus.cmd --gpu --landscape-size 4096 --samples 64
```

For a quicker test on a dense landscape, run

```powershell
.\Bake-Campus.cmd --gpu --floor-size 512 --landscape-size 1024 --samples 8 --landscape-ratio 0.5
```

The ratio simplifies the working landscape for this bake. The default of 1 preserves the source triangle count. Higher atlas resolution sharpens shadow edges. Increasing samples reduces noise in shade. The launcher uses CPU by default, and `--gpu` falls back to CPU if Blender finds no supported device.

To keep the landscape anywhere on disk, pass `--surroundings "D:\Campus\School grounds.glb"`. On macOS or Linux the corresponding command from the repository root is

```bash
blender --background --factory-startup --python-exit-code 1 --python tools/bake_daylight.py -- --samples 32
```
