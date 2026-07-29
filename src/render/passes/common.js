import * as THREE from 'three';

/**
 * Infraestrutura compartilhada da cadeia de pós-processamento.
 *
 * POR QUE NÃO O EffectComposer: o composer aloca dois alvos do tamanho da tela
 * e força todo passe a rodar em resolução cheia, na ordem em que foi empilhado.
 * Aqui metade dos passes (AO, godrays, bloom) roda em meia resolução ou menos,
 * e a ordem/orçamento muda em runtime conforme o módulo `perf` mexe em
 * ctx.quality. Escrever a cadeia à mão custa ~200 linhas e devolve o controle.
 */

// ── Quad de tela cheia ───────────────────────────────────────────────────────

/**
 * Um ÚNICO triângulo que cobre a tela, não dois triângulos.
 * A diagonal de um quad faz a GPU processar duas vezes os quads de 2x2
 * fragmentos que caem sobre a costura. Com ~10 passes por frame em 4 MPx isso
 * é medível; o triângulo grande elimina a costura de graça.
 */
export class FullScreenQuad {
  constructor() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(
      new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    // Sem bounding sphere o three tentaria calcular uma e o frustum culling
    // descartaria o desenho (as posições já estão em espaço de clip).
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);

    this.geometry = geo;
    this.mesh = new THREE.Mesh(geo, null);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  /** Desenha `material` cobrindo `target` (null = tela). */
  render(renderer, material, target) {
    this.mesh.material = material;
    renderer.setRenderTarget(target || null);
    renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.geometry.dispose();
    this.scene.remove(this.mesh);
    this.mesh.material = null;
  }
}

// ── Alvos ────────────────────────────────────────────────────────────────────

/**
 * Cria um alvo intermediário. Sempre sem depth e sem mipmaps: nenhum passe de
 * pós precisa deles e cada um custaria memória que some rápido em 4K.
 */
export function createTarget(w, h, opts = {}) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), {
    type: opts.type || THREE.HalfFloatType,
    format: opts.format || THREE.RGBAFormat,
    colorSpace: THREE.LinearSRGBColorSpace,
    minFilter: opts.filter || THREE.LinearFilter,
    magFilter: opts.filter || THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    samples: 0,
  });
  rt.texture.name = opts.name || 'postfx';
  return rt;
}

/**
 * Redimensiona sem vazar. `WebGLRenderTarget.setSize` já chama `dispose()`
 * internamente quando o tamanho muda — é ESTE o caminho seguro. Recriar o alvo
 * a cada resize (e esquecer de descartar o antigo) é o vazamento clássico que
 * mata o jogo em poucos minutos de janela sendo arrastada.
 */
export function resizeTarget(rt, w, h) {
  if (!rt) return;
  const nw = Math.max(1, w | 0), nh = Math.max(1, h | 0);
  if (rt.width !== nw || rt.height !== nh) rt.setSize(nw, nh);
}

// ── Materiais ────────────────────────────────────────────────────────────────

export const FS_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  // As posições já vêm em espaço de clip; não há matriz de projeção envolvida.
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export function makeMaterial(fragmentShader, uniforms, opts = {}) {
  const m = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: FS_VERT,
    fragmentShader,
    defines: opts.defines || {},
    depthTest: false,
    depthWrite: false,
    blending: opts.blending === undefined ? THREE.NoBlending : opts.blending,
    transparent: opts.blending !== undefined && opts.blending !== THREE.NoBlending,
    toneMapped: false,
    fog: false,
    lights: false,
  });
  m.name = opts.name || 'postfx';
  return m;
}

/** Troca um #define só quando o valor muda de verdade — recompilar custa ms. */
export function setDefine(material, key, value) {
  const cur = material.defines[key];
  if (cur === value) return false;
  material.defines[key] = value;
  material.needsUpdate = true;
  return true;
}

// ── Blocos GLSL reutilizados ─────────────────────────────────────────────────

/**
 * Reconstrução de profundidade.
 *
 * O engine liga `logarithmicDepthBuffer`, então o valor gravado não é o z de
 * NDC e sim  d = log2(1+w) / log2(far+1)  (ver logdepthbuf_fragment do three).
 * Invertendo:  w = exp2(d * log2(far+1)) - 1,  onde w é a distância em espaço
 * de olho ao longo do eixo de visão. Ignorar isso é o erro que faz SSAO e
 * motion blur "quase funcionarem" e nunca baterem com a cena.
 *
 * uLogFC = log2(far+1)  (0 desliga o caminho logarítmico).
 */
export const GLSL_DEPTH = /* glsl */`
uniform sampler2D tDepth;
uniform float uLogFC;
uniform vec2 uNearFar;
uniform vec2 uProjRay;   // (tan(fov/2)*aspect, tan(fov/2))

float rawDepthAt(vec2 uv) { return texture2D(tDepth, uv).x; }

float eyeDepthAt(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  if (uLogFC > 0.0) return exp2(d * uLogFC) - 1.0;
  float z = d * 2.0 - 1.0;
  return (2.0 * uNearFar.x * uNearFar.y) /
         (uNearFar.y + uNearFar.x - z * (uNearFar.y - uNearFar.x));
}

/** Posição em espaço de olho (câmera olha para -Z). */
vec3 viewPosAt(vec2 uv, float eyeD) {
  vec2 ndc = uv * 2.0 - 1.0;
  return vec3(ndc * uProjRay, -1.0) * eyeD;
}
`;

/**
 * Normal reconstruída do depth com 4 vizinhos.
 * Escolhemos, em cada eixo, o vizinho MAIS PRÓXIMO em profundidade: sobre uma
 * silhueta o vizinho do outro lado pertence a outro objeto e produziria uma
 * normal apontando para o nada — que é exatamente onde a AO cria halos.
 */
export const GLSL_NORMAL = /* glsl */`
vec3 viewNormalAt(vec2 uv, vec3 P, vec2 texel) {
  vec2 ul = uv - vec2(texel.x, 0.0);
  vec2 ur = uv + vec2(texel.x, 0.0);
  vec2 ud = uv - vec2(0.0, texel.y);
  vec2 uu = uv + vec2(0.0, texel.y);
  vec3 pl = viewPosAt(ul, eyeDepthAt(ul));
  vec3 pr = viewPosAt(ur, eyeDepthAt(ur));
  vec3 pd = viewPosAt(ud, eyeDepthAt(ud));
  vec3 pu = viewPosAt(uu, eyeDepthAt(uu));
  vec3 dx = mix(pr - P, P - pl, step(abs(pl.z - P.z), abs(pr.z - P.z)));
  vec3 dy = mix(pu - P, P - pd, step(abs(pd.z - P.z), abs(pu.z - P.z)));
  vec3 n = cross(dx, dy);
  float l = length(n);
  return l > 1e-12 ? n / l : vec3(0.0, 0.0, 1.0);
}
`;

/**
 * ACES filmic — o ajuste de Stephen Hill (RRT+ODT sobre as matrizes AP0/AP1).
 * NÃO é a aproximação de Narkowicz: aquela satura o vermelho e estoura os
 * realces acima de ~2.5, e num céu com sol no quadro isso vira um borrão
 * branco chapado. As matrizes vão transpostas porque a referência é HLSL
 * (linhas) e o GLSL constrói mat3 por colunas.
 */
export const GLSL_ACES = /* glsl */`
const mat3 ACES_IN = mat3(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777);
const mat3 ACES_OUT = mat3(
   1.60475, -0.10208, -0.00327,
  -0.53108,  1.10813, -0.07276,
  -0.07367, -0.00605,  1.07602);

vec3 acesRRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

vec3 acesFitted(vec3 color) {
  color = ACES_IN * max(color, vec3(0.0));
  color = acesRRTAndODTFit(color);
  color = ACES_OUT * color;
  return clamp(color, 0.0, 1.0);
}
`;

export const GLSL_SRGB = /* glsl */`
vec3 linearToSRGB(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(0.41666667)) - 0.055, step(0.0031308, c));
}
`;

export const GLSL_LUMA = /* glsl */`
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

/**
 * Ruído. `ign` (interleaved gradient noise, Jimenez) é estável no espaço da
 * tela e é o que dá o padrão de dithering que some no blur bilateral.
 * `hash12`/`triNoise` servem ao grão: a diferença de duas uniformes tem PDF
 * triangular, que é o que faz o grão parecer filme e não sal-e-pimenta.
 */
export const GLSL_NOISE = /* glsl */`
float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float triNoise(vec2 fc, float t) {
  float a = hash12(fc + vec2(t * 1.713, t * 0.771));
  float b = hash12(fc + vec2(t * 0.337 + 71.7, t * 1.311 + 19.3));
  return a - b;
}
`;

// ── Texturas neutras ─────────────────────────────────────────────────────────

/**
 * 1x1 constantes. Servem para manter UM único programa compilado no
 * composite: em vez de permutar #defines (e pagar recompilação toda vez que o
 * `perf` liga/desliga bloom), o passe desligado apenas aponta para a textura
 * neutra e sua intensidade vai a zero.
 */
export function makeConstTexture(r, g, b, a = 1) {
  const data = new Uint8Array([r * 255, g * 255, b * 255, a * 255]);
  const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Textura HDR 1x1 usada só no auto-teste (precisa passar do threshold do bloom). */
export function makeProbeTexture(value = 4) {
  const tex = new THREE.DataTexture(
    new Float32Array([value, value, value, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
