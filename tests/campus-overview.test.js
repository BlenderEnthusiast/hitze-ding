import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {loadBakedScene, readDaylight} from '../js/daylight.js';
import {Viewer} from '../js/viewer.js';
import {Group, Scene} from '../vendor/three/three.module.js';

const site = new URL('https://example.invalid/hitze-ding/');
const index = {version: 1, base: 'models/lighting/abc/', floors: {}, range: 4, surroundings: [{bytes: 44}]};
const overview = {version: 1, sourceBase: index.base, compression: 'meshopt', transport: 'gzip',
  files: ['overview.glb.gz'], uv: 8, lighting: 'scene', bytes: 4};

test('the landscape is matched to the active bake and older bakes retain their tiles', async t => {
  let descriptor = overview;
  const urls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(url.href);
    if (url.pathname.endsWith('/lighting.json')) return Response.json(index);
    return descriptor ? Response.json(descriptor) : new Response(null, {status: 404});
  });
  assert.deepEqual((await readDaylight(site)).overview, overview);
  assert.equal(urls[1], new URL(index.base + 'overview.json', site).href);
  for (descriptor of [{...overview, sourceBase: 'models/lighting/old/'}, null]) {
    const bake = await readDaylight(site);
    assert.equal(bake.overview, null);
    assert.deepEqual(bake.surroundings, index.surroundings);
  }
});

test('the GLB can be served as gzip bytes or decompressed by the host', async t => {
  const glb = new TextEncoder().encode('glTF');
  let body;
  t.mock.method(globalThis, 'fetch', async () => new Response(body));
  const loader = {
    setMeshoptDecoder(decoder) { assert.equal(typeof decoder.decodeGltfBuffer, 'function'); },
    async parseAsync(bytes) { return {scene: new TextDecoder().decode(bytes)}; },
  };
  for (body of [gzipSync(glb), glb]) {
    assert.equal(await loadBakedScene(loader, overview, site, new AbortController().signal), 'glTF');
  }
  body = gzipSync(glb.subarray(0, 2));
  await assert.rejects(loadBakedScene(loader, overview, site), /length/);
});

test('changing scope cancels pending scenery and reuses the completed compact landscape', async () => {
  const viewer = Object.create(Viewer.prototype);
  const pending = [];
  Object.assign(viewer, {scope: {}, daylight: {overview}, pending: new Set(), scene: new Scene(),
    geometryWarnings: new Map(), status() {}, idleStatus() {}, loadMore() {},
    bakedRoot(spec, signal) {
      assert.equal(spec, overview);
      return new Promise((resolve, reject) => {
        pending.push(resolve);
        signal.addEventListener('abort', () => reject(signal.reason), {once: true});
      });
    }});
  const interrupted = viewer.loadSurroundings();
  viewer.scope = {floor: '1'}; viewer.hideSurroundings();
  await interrupted;
  assert.equal(viewer.landscape, null);
  assert.equal(viewer.scene.children.length, 0);

  viewer.scope = {};
  const loaded = viewer.loadSurroundings();
  pending[1](new Group()); await loaded;
  const landscape = viewer.landscape;
  viewer.scope = {building: 'A'}; viewer.hideSurroundings();
  assert.equal(landscape.visible, false);
  viewer.scope = {}; await viewer.loadSurroundings();
  assert.equal(viewer.landscape, landscape);
  assert.equal(landscape.visible, true);
  assert.equal(pending.length, 2);
});
