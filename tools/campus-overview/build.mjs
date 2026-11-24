// Build a small, static campus landscape from the existing Cycles bake.
import {createHash} from 'node:crypto';
import {mkdtemp, open, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {Document, Logger, NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS, EXTTextureWebP} from '@gltf-transform/extensions';
import {
  compactPrimitive, dedup, join, listTextureInfoByMaterial, mergeDocuments,
  meshopt, prune, unpartition,
} from '@gltf-transform/functions';
import {MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier} from 'meshoptimizer';
import sharp from 'sharp';

const ATLAS_UV = '_STRATUM_DAYLIGHT';
const DENSE_TRIANGLES = 1800;
const logger = new Logger(Logger.Verbosity.ERROR);
const io = new NodeIO().setLogger(logger).registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
sharp.cache(false);
sharp.concurrency(2);

function assetPath(base, relative) {
  const file = path.resolve(base, relative);
  if (!file.startsWith(base + path.sep)) throw new Error('Asset outside the bake folder: ' + relative);
  return file;
}

async function readGeometry(base, spec) {
  if (spec.files.length === 1) {
    const bytes = await readFile(assetPath(base, spec.files[0]));
    if (bytes.length !== spec.bytes) throw new Error('Wrong byte count: ' + spec.files[0]);
    return bytes;
  }
  // A single scenery page can have hundreds of MB of textures. Read its parts
  // into the final allocation rather than retaining a second copy of every part.
  const bytes = Buffer.allocUnsafe(spec.bytes);
  let offset = 0;
  for (const name of spec.files) {
    const input = await open(assetPath(base, name));
    try {
      const end = offset + (await input.stat()).size;
      if (end > bytes.length) throw new Error('Wrong part size: ' + name);
      while (offset < end) {
        const {bytesRead} = await input.read(bytes, offset, end - offset);
        if (!bytesRead) throw new Error('Incomplete part: ' + name);
        offset += bytesRead;
      }
    } finally { await input.close(); }
  }
  if (offset !== bytes.length) throw new Error('Incomplete geometry: ' + spec.files[0]);
  return bytes;
}

class LightAtlas {
  constructor(count) {
    this.cols = Math.ceil(Math.sqrt(count));
    this.cell = Math.min(128, Math.floor(4096 / this.cols));
    if (this.cell < 8) throw new Error('Too many pages for the overview lightmap.');
    this.width = this.cols * this.cell;
    this.height = Math.ceil(count / this.cols) * this.cell;
    this.rgb = Buffer.alloc(this.width * this.height * 3);
  }

  async add(file, index) {
    const x = index % this.cols * this.cell;
    const y = Math.floor(index / this.cols) * this.cell;
    const inside = this.cell - 4;
    const tile = await sharp(file).resize(inside, inside, {fit: 'fill'})
      .extend({top: 2, left: 2, bottom: 2, right: 2, extendWith: 'copy'})
      .removeAlpha().toColourspace('srgb').raw().toBuffer();
    const stride = 3 * this.cell;
    for (let row = 0; row < this.cell; row++) {
      tile.copy(this.rgb, 3 * ((y + row) * this.width + x), row * stride, (row + 1) * stride);
    }
    return [x + 2.5, y + 2.5, inside - 1];
  }

  remap(doc, prim, sourceUV, rect, samples) {
    // The baker uses a custom VEC3 if all eight Blender UV layers were taken.
    const source = prim.getAttribute(sourceUV);
    if (!source) throw new Error('Missing baked lighting coordinates ' + sourceUV);
    const uv = new Uint16Array(source.getCount() * 2);
    const v = [];
    for (let i = 0; i < source.getCount(); i++) {
      source.getElement(i, v);
      const x = rect[0] + Math.min(1, Math.max(0, v[0])) * rect[2];
      const y = rect[1] + Math.min(1, Math.max(0, v[1])) * rect[2];
      uv[i * 2] = Math.round(x / this.width * 65535);
      uv[i * 2 + 1] = Math.round(y / this.height * 65535);
      const pixel = (Math.floor(y) * this.width + Math.floor(x)) * 3;
      if (Math.max(this.rgb[pixel], this.rgb[pixel + 1], this.rgb[pixel + 2]) >= 20) samples.lit++;
    }
    prim.setAttribute(ATLAS_UV, doc.createAccessor().setType('VEC2').setArray(uv).setNormalized(true));
    samples.total += source.getCount();
  }

  png() {
    return sharp(this.rgb, {raw: {width: this.width, height: this.height, channels: 3}}).png().toBuffer();
  }
}

function simplifyPrimitive(doc, prim, detail) {
  const pos = prim.getAttribute('POSITION');
  const count = prim.getIndices()?.getCount() ?? pos.getCount();
  if (prim.getMode() !== 4) return [0, 0];
  const triangles = count / 3;
  if (triangles <= DENSE_TRIANGLES) return [triangles, triangles];
  const indices = prim.getIndices()
    ? Uint32Array.from(prim.getIndices().getArray())
    : Uint32Array.from({length: count}, (_, i) => i);
  const positions = pos.getArray();
  if (!(positions instanceof Float32Array)) throw new Error('Expected positions from an uncompressed Stratum bake.');
  // Spend more triangles on geometrically complex patches, while capping the
  // cost of thousands of tiny branches in a campus-scale view.
  const material = prim.getMaterial();
  const alphaCards = Boolean(material && material.getAlphaMode() !== 'OPAQUE');
  const target = Math.max(32, Math.min(triangles, Math.round(Math.sqrt(triangles) * detail * (alphaCards ? 1.5 : 1))));
  const uvInfo = material?.getBaseColorTextureInfo();
  const uv = uvInfo && prim.getAttribute('TEXCOORD_' + uvInfo.getTexCoord());
  // A disconnected cutout can represent an entire spray of leaves. Protect
  // its silhouette more closely and keep disconnected components eligible.
  const flags = alphaCards ? ['Permissive'] : ['Permissive', 'Prune'];
  const error = alphaCards ? 0.04 : 0.12;
  let reduced;
  if (uv?.getArray() instanceof Float32Array) {
    [reduced] = MeshoptSimplifier.simplifyWithAttributes(indices, positions, 3,
      uv.getArray(), 2, [0.15, 0.15], null, target * 3, error, flags);
  } else {
    [reduced] = MeshoptSimplifier.simplify(indices, positions, 3, target * 3, error, flags);
  }
  // Preserve a nonempty representative even for disconnected leaf cards.
  if (reduced.length >= 3 && reduced.length < count) {
    prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(reduced));
    compactPrimitive(prim);
    return [triangles, reduced.length / 3];
  }
  return [triangles, triangles];
}

async function optimizeTextures(doc, images) {
  for (const texture of doc.getRoot().listTextures()) {
    const original = texture.getImage();
    const key = digest(original);
    let image = images.get(key);
    if (!image) {
      image = await sharp(original).resize(1024, 1024, {fit: 'inside', withoutEnlargement: true})
        .webp({quality: 82, alphaQuality: 100}).toBuffer();
      images.set(key, image);
    }
    texture.setImage(image).setMimeType('image/webp').setURI('');
  }
  if (images.size) doc.createExtension(EXTTextureWebP).setRequired(true);
}

async function build(root, detail) {
  await Promise.all([MeshoptSimplifier.ready, MeshoptEncoder.ready, MeshoptDecoder.ready]);
  const indexFile = path.join(root, 'models', 'lighting.json');
  const initial = await readFile(indexFile);
  const index = JSON.parse(initial);
  if (index.version !== 1) throw new Error('Unsupported Stratum lighting index.');
  if (!index.surroundings?.length) { console.log('There is no baked landscape to optimize.'); return; }
  const base = assetPath(root, index.base);
  const output = new Document().setLogger(logger);
  const scene = output.createScene('Campus landscape');
  output.getRoot().setDefaultScene(scene);
  const images = new Map(), cells = new Map();
  const atlas = new LightAtlas(index.surroundings.length);
  let before = 0, after = 0, bakedPages = 0;
  for (const [i, page] of index.surroundings.entries()) {
    const doc = await io.readBinary(await readGeometry(base, page));
    doc.setLogger(logger);
    const rect = await atlas.add(assetPath(base, page.maps.campus), i);
    const sourceUV = page.uv === 8 ? ATLAS_UV : 'TEXCOORD_' + page.uv;
    const samples = {total: 0, lit: 0};
    for (const mesh of doc.getRoot().listMeshes()) {
      for (const prim of mesh.listPrimitives()) {
        const [full, compact] = simplifyPrimitive(doc, prim, detail);
        before += full; after += compact;
        atlas.remap(doc, prim, sourceUV, rect, samples);
        // Keep the UV sets used by an authored material, including extensions.
        const material = prim.getMaterial();
        const keep = new Set();
        for (const info of material ? listTextureInfoByMaterial(material) : []) {
          keep.add('TEXCOORD_' + info.getTexCoord());
          const transform = info.getExtension('KHR_texture_transform');
          if (transform?.getTexCoord() != null) keep.add('TEXCOORD_' + transform.getTexCoord());
        }
        for (const key of prim.listSemantics()) {
          if (key.startsWith('TEXCOORD_') && !keep.has(key)) prim.setAttribute(key, null);
        }
      }
    }
    // Some existing outdoor bakes are effectively black even at the UVs
    // actually used by the surface. Keep the original PBR response on those
    // pages. Other pages still use their own baked shadows.
    if (samples.lit > samples.total * 0.05) {
      bakedPages++;
    } else {
      for (const mesh of doc.getRoot().listMeshes()) {
        for (const prim of mesh.listPrimitives()) {
          prim.setAttribute(ATLAS_UV, null);
          const material = prim.getMaterial();
          if (material) material.setExtras({...material.getExtras(), stratumSceneLight: true});
        }
      }
    }
    await doc.transform(prune({keepAttributes: true, keepSolidTextures: true}));
    await optimizeTextures(doc, images);
    const originalScene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
    const copy = mergeDocuments(output, doc);
    const copiedScene = copy.get(originalScene);
    for (const node of copiedScene.listChildren()) {
      const [x, , z] = node.getTranslation();
      const key = Math.floor(x / 32) + ',' + Math.floor(z / 32);
      if (!cells.has(key)) {
        const cell = output.createNode('Grounds ' + key);
        scene.addChild(cell); cells.set(key, cell);
      }
      cells.get(key).addChild(node);
    }
    copiedScene.dispose();
    if ((i + 1) % 50 === 0 || i + 1 === index.surroundings.length) {
      console.log(`Landscape pages ${i + 1}/${index.surroundings.length}`);
    }
  }
  await output.transform(unpartition(), dedup(), join({cleanup: false}),
    prune({keepAttributes: true, keepSolidTextures: true}),
    meshopt({encoder: MeshoptEncoder, level: 'high', quantizePosition: 14, quantizeTexcoord: 14}));
  const geometry = await io.writeBinary(output);
  const packed = gzipSync(geometry, {level: 9});
  const lighting = bakedPages ? await atlas.png() : null;
  const glb = 'overview-' + digest(packed).slice(0, 16) + '.glb.gz';
  const map = lighting && 'overview-' + digest(lighting).slice(0, 16) + '.png';
  const campusMaps = {};
  const spec = {version: 1, bytes: geometry.length, transferBytes: packed.length, transport: 'gzip', files: [glb], uv: 8,
    maps: map ? {campus: map} : {}, lighting: bakedPages ? 'baked' : 'scene', bakedPages,
    compression: 'meshopt', sourceBase: index.base,
    sourceTriangles: before, triangles: after, campusMaps};
  // Assets get immutable names. Publish the pointer last, including on a retry.
  const staging = await mkdtemp(path.join(base, '.overview-'));
  try {
    const assets = [[glb, packed]];
    if (map) assets.push([map, lighting]);
    const floorAssets = Object.values(index.floors).map(floor => floor.asset);
    for (const part of floorAssets.concat(Object.values(index.exteriors || {}))) {
      const original = part.maps.campus;
      if (!original || campusMaps[original]) continue;
      const full = await readFile(assetPath(base, original));
      const bytes = await sharp(full).webp({quality: 88, alphaQuality: 100}).toBuffer();
      if (bytes.length >= full.length) continue;
      const name = 'overview-light-' + digest(bytes).slice(0, 16) + '.webp';
      campusMaps[original] = name;
      assets.push([name, bytes]);
    }
    for (const [name, bytes] of assets) {
      await writeFile(path.join(staging, name), bytes);
      await rename(path.join(staging, name), path.join(base, name));
    }
    if (!(await readFile(indexFile)).equals(initial)) throw new Error('The active bake changed. Run the optimizer again.');
    await writeFile(path.join(staging, 'overview.json'), JSON.stringify(spec, null, 2) + '\n');
    await rename(path.join(staging, 'overview.json'), path.join(base, 'overview.json'));
  } finally { await rm(staging, {recursive: true, force: true}); }
  const size = packed.length + (lighting?.length || 0);
  console.log(`${before.toLocaleString()} -> ${after.toLocaleString()} triangles, ${(size / 1e6).toFixed(2)} MB of landscape assets.\nReady in ${base}`);
}

const args = process.argv.slice(2);
const afterBake = args[0] === '--after-bake';
// The existing bake launcher accepts --root in either argparse spelling.
const rootOption = args.find(arg => arg.startsWith('--root='));
const rootArg = afterBake
  ? (rootOption?.slice(7) ?? (args.includes('--root') ? args[args.indexOf('--root') + 1] : undefined))
  : args[0];
const root = path.resolve(rootArg ?? fileURLToPath(new URL('../../', import.meta.url)));
const detail = Number(afterBake ? 2.5 : (args[1] ?? 2.5));
try {
  if (!(Number.isFinite(detail) && detail > 0)) throw new Error('Detail must be a positive number.');
  await stat(path.join(root, 'models', 'lighting.json'));
  await build(root, detail);
} catch (error) { console.error(error); process.exitCode = 1; }
