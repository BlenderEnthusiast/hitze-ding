import * as THREE from '../vendor/three/three.module.js';

export function daylightMode(scope) {
  if (scope.floor || scope.room) return 'floor';
  return scope.building ? 'building' : 'campus';
}

export async function readDaylight(root) {
  const response = await fetch(new URL('models/lighting.json', root), {cache: 'no-cache'});
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Daylight index returned HTTP ' + response.status);
  const index = await response.json();
  if (index.version !== 1 || !index.base || !index.floors || !(index.range > 0)) {
    throw new Error('Invalid daylight index');
  }
  const base = new URL(index.base, root);
  let overview = null;
  if (index.surroundings?.length) {
    try {
      const response = await fetch(new URL('overview.json', base), {cache: 'no-cache'});
      if (response.ok) {
        const spec = await response.json();
        if (spec.version === 1 && spec.sourceBase === index.base && spec.compression === 'meshopt' &&
            spec.files?.length === 1 && (spec.lighting === 'scene' || spec.maps?.campus) &&
            spec.bytes > 0 && spec.uv === 8) overview = spec;
      }
    } catch { /* Older bakes and static hosts without an overview use the original pages. */ }
  }
  return {...index, base, overview};
}

// The baker embeds all glTF textures. Large GLBs travel in ordinary static
// files and are assembled directly in one buffer before glTF parsing.
async function readBakedBytes(spec, base, signal) {
  const read = async file => {
    const url = new URL(file, base);
    const response = await fetch(url, {signal});
    if (!response.ok) throw new Error(file + ' returned HTTP ' + response.status);
    return response.arrayBuffer();
  };
  let bytes;
  if (spec.files.length === 1) {
    bytes = await read(spec.files[0]);
    if (spec.transport === 'gzip') {
      // Hosts may serve .gz as a file or transparently decode it with Content-Encoding.
      const header = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
      if (header[0] === 0x1f && header[1] === 0x8b) {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'), {signal});
        bytes = await new Response(stream).arrayBuffer();
      }
    }
  } else {
    const joined = new Uint8Array(spec.bytes);
    let offset = 0;
    for (const file of spec.files) {
      const chunk = new Uint8Array(await read(file));
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    if (offset !== spec.bytes) throw new Error('Incomplete daylight geometry');
    bytes = joined.buffer;
  }
  if (bytes.byteLength !== spec.bytes) throw new Error('Unexpected daylight geometry length');
  return bytes;
}

export async function loadBakedScene(loader, spec, base, signal) {
  const [bytes, decoder] = await Promise.all([
    readBakedBytes(spec, base, signal),
    spec.compression === 'meshopt' ? import('../vendor/meshoptimizer/meshopt_decoder.mjs') : null,
  ]);
  if (decoder) loader.setMeshoptDecoder(decoder.MeshoptDecoder);
  signal?.throwIfAborted();
  return (await loader.parseAsync(bytes, base.href)).scene;
}

export async function loadReflectionSky(index, loader) {
  const texture = await loader.loadAsync(new URL(index.sky, index.base).href);
  texture.flipY = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

function useAtlas(shader, sky) {
  // Keep glTF albedo, vertex colours, alpha tests, emission and glass. Cycles
  // has already integrated direct and bounced diffuse light at this texel.
  let shade = 'reflectedLight.indirectDiffuse = diffuseColor.rgb * bakedDiffuse;';
  if (sky) {
    shader.uniforms.daylightSky = {value: sky};
    shader.fragmentShader = 'uniform sampler2D daylightSky;\n' + shader.fragmentShader;
    shade = `
      reflectedLight.indirectDiffuse = material.diffuseColor * bakedDiffuse;
      vec3 reflected = inverseTransformDirection(reflect(-geometryViewDir, normal), viewMatrix);
      vec2 skyUv = vec2(atan(reflected.z, reflected.x) * 0.15915494 + 0.5,
                        (acos(clamp(reflected.y, -1.0, 1.0)) * 0.31830989 * 127.0 + 0.5) / 128.0);
      float band = clamp(material.roughness, 0.0, 1.0) * 5.0;
      vec3 sharp = texture2D(daylightSky, vec2(skyUv.x, (floor(band) + skyUv.y) / 6.0)).rgb;
      vec3 soft = texture2D(daylightSky, vec2(skyUv.x, (min(5.0, floor(band) + 1.0) + skyUv.y) / 6.0)).rgb;
      vec3 fresnel = F_Schlick(material.specularColor, material.specularF90,
                              saturate(dot(normal, geometryViewDir)));
      float localLight = clamp(dot(bakedDiffuse, vec3(0.2126, 0.7152, 0.0722)), 0.035, 1.0);
      reflectedLight.indirectSpecular = mix(sharp, soft, fract(band)) * 8.0 * fresnel * localLight
                                      * (1.0 - 0.45 * material.roughness);
    `;
  }
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <lights_fragment_begin>', [
      'vec3 geometryNormal = normal;',
      'vec3 geometryViewDir = isOrthographic ? vec3(0., 0., 1.) : normalize(vViewPosition);',
      'vec3 geometryClearcoatNormal = vec3(0.);',
      '#ifdef USE_CLEARCOAT',
      '  geometryClearcoatNormal = clearcoatNormal;',
      '#endif',
      'vec3 bakedDiffuse = texture2D(lightMap, vLightMapUv).rgb * lightMapIntensity;', shade
    ].join('\n'))
    .replace('#include <lights_fragment_maps>', '')
    .replace('#include <lights_fragment_end>', '');
}

// GLTFLoader leaves TEXCOORD_4 and higher under their lowercase glTF names.
// The stock shaders only declare UV attributes 0–3. These aliases also let
// authored material textures and the daylight texture use different high UVs.
function declareExtraUvs(shader, last) {
  const declarations = [];
  for (let i = 4; i <= last; i++) {
    const name = i === 8 ? '_stratum_daylight' : 'texcoord_' + i;
    declarations.push(`attribute vec2 ${name};`, `#define uv${i} ${name}`);
  }
  shader.vertexShader = declarations.join('\n') + '\n' + shader.vertexShader;
}

export class SurfaceDaylight {
  constructor(root, spec, index, textureLoader, redraw) {
    this.materials = new Set();
    root.traverse(obj => {
      for (const m of [].concat(obj.material || [])) {
        if (spec.compression === 'meshopt' && m.userData?.stratumSceneLight) continue;
        if (m.isMeshStandardMaterial || m.isMeshBasicMaterial) this.materials.add(m);
      }
    });
    this.redraw = redraw;
    this.spec = spec;
    this.index = index;
    this.loader = textureLoader;
    this.textures = new Map();
    this.resident = new Set();
  }

  async show(mode) {
    if (this.closed || !this.materials.size) return;
    const original = this.spec.maps[mode];
    const file = (mode === 'campus' && this.index.overview?.campusMaps?.[original]) || original;
    this.wanted = file;
    if (file === this.applied) return;
    if (!this.textures.has(file)) {
      const load = name => this.loader.loadAsync(new URL(name, this.index.base).href);
      const image = file === original ? load(file) : load(file).catch(() => load(original));
      const pending = image.then(t => {
        t.flipY = false;
        t.colorSpace = THREE.SRGBColorSpace;
        t.channel = this.spec.uv;
        // Keep neighboring cells of the packed landscape atlas out of the filter footprint.
        if (this.spec.compression === 'meshopt') {
          t.generateMipmaps = false;
          t.minFilter = THREE.LinearFilter;
        }
        if (this.closed) t.dispose();
        else this.resident.add(t);
        return t;
      }).catch(error => {
        this.textures.delete(file);
        throw error;
      });
      this.textures.set(file, pending);
    }
    const texture = await this.textures.get(file);
    if (this.closed || this.wanted !== file || this.applied === file) return;
    for (const m of this.materials) {
      if (!m.lightMap) {
        const sky = this.index.skyTexture;
        const uv = this.spec.uv;
        if (m.isMeshStandardMaterial || uv > 3) {
          m.onBeforeCompile = shader => {
            if (uv > 3) declareExtraUvs(shader, uv);
            if (m.isMeshStandardMaterial) useAtlas(shader, sky);
          };
          m.customProgramCacheKey = () => `stratum-daylight-${sky ? 'sky' : 'diffuse'}-uv${uv}`;
        }
        m.needsUpdate = true;
      }
      m.lightMap = texture;
      // The stock basic shader includes a 1/pi conversion.
      m.lightMapIntensity = this.index.range * (m.isMeshBasicMaterial ? Math.PI : 1);
    }
    this.applied = file;
    this.redraw();
  }

  dispose() {
    this.closed = true;
    for (const material of this.materials) material.lightMap = null;
    // A not-yet-decoded image disposes itself in show(). Already-resolved
    // images are also owned by this handle, independent of the glTF textures.
    for (const texture of this.resident) texture.dispose();
    this.resident.clear();
    this.textures.clear();
    this.materials.clear();
  }
}
