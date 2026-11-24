# Stratum campus overview

Extract the update into the existing `hitze-ding` project beside `index.html`, merge the folders, and publish the changed files. The package includes the finished outdoor model for lighting revision `f1b60301dac80fb0`. It works immediately with that bake. Visitors only need their browser.

## Rebuild after changing the landscape

On Windows, double-click **Optimize-Campus.cmd** in the project folder. The builder uses the current `models/lighting.json` and its existing baked tiles. It needs Node.js 22 LTS or newer and installs its pinned build dependencies on its first run. The regular **Bake-Campus.cmd** launcher also runs the optimizer when a bake finishes. If you bake inside the Blender exporter, run **Optimize-Campus.cmd** after Blender reports that lighting is ready.

On macOS or Linux, run these commands from the project directory with Node.js installed.

```sh
npm --prefix tools/campus-overview ci
node tools/campus-overview/build.mjs
```

The builder writes the compact model, campus-view lighting files, and `overview.json` inside the current lighting revision. Publish those new files together. The original tiles remain available for rebuilding. The browser selects the compact asset for its matching revision and reuses it when you return from a building.

The optimizer simplifies dense scenery by material and gives transparent leaves a higher triangle allowance. Geometry with up to 1,800 triangles per primitive keeps its triangles. Repeated textures share one copy. Usable landscape lightmaps share an atlas. For an outdoor tile whose sampled lighting is almost entirely black, its materials use Stratum’s existing scene lights. The optimizer also writes smaller copies of the building lightmaps for the campus view.

## Check loading time

Open the 3D campus in Chrome or Edge with the Network panel’s **Disable cache** option enabled, reload, and wait for the scenery. In DevTools Console, the following expression reports seconds from navigation to the first completed campus render submission.

```js
performance.getEntriesByName('stratum-campus-ready')[0]?.startTime / 1000
```

The Network panel should show one `overview-*.glb.gz` request and zero `surroundings-*/model.glb` requests for this bake. The detailed floor and building views continue to use their own geometry.
