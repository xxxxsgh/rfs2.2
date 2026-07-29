import * as THREE from 'three';
import { Noise, clamp, saturate, smoothstep, lerp } from '../noise/noise.js';

/**
 * CAMPO ESTELAR E FUNDO GALÁCTICO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * POR QUÊ este módulo existe da forma como existe:
 *
 * 1. O céu não é decoração — é informação de navegação. As estrelas visíveis
 *    SÃO as estrelas de `ctx.universe.galaxy`, projetadas a partir da posição
 *    do sistema atual. Ao dar warp, a paralaxe muda as constelações de
 *    verdade: o que era um par duplo se separa, a estrela vizinha vira a mais
 *    brilhante do céu. É o sinal mais barato e mais forte de que o universo é
 *    um lugar contínuo e não um pano de fundo.
 *
 * 2. O que denuncia um protótipo é o "preto puro". Espaço real tem a banda da
 *    Via Láctea, e — mais importante que a banda — tem as FAIXAS DE POEIRA que
 *    a cortam. A poeira é o que dá profundidade: sem ela a banda parece um
 *    borrão de gaussiana. Por isso a textura equiretangular é gerada com um
 *    campo de extinção próprio que multiplica (não soma) o brilho.
 *
 * 3. Estrela não é um quadrado de 1 px. Cada ponto é um núcleo gaussiano
 *    apertado (que satura para branco quando é brilhante) somado a um halo
 *    largo e fraco — é assim que uma fonte pontual se comporta depois da
 *    óptica e do bloom. A cintilação é por-estrela (fase derivada do índice) e
 *    aumenta com a densidade atmosférica, porque cintilação é turbulência de
 *    ar: no vácuo as estrelas não piscam.
 *
 * ── Orçamento ───────────────────────────────────────────────────────────────
 * Exatamente 3 draw calls: esfera do fundo galáctico + 40k estrelas de fundo +
 * catálogo real projetado. Zero alocação por frame (só escrita em uniforms).
 * As nebulosas coloridas são assadas na MESMA textura equiretangular; ter
 * malhas separadas para elas custaria draw calls sem ganho visual.
 *
 * ── Alinhamento ─────────────────────────────────────────────────────────────
 * A textura é assada num referencial CANÔNICO (polo galáctico = +Y, centro
 * galáctico = +X) e a malha é girada para o referencial real da galáxia. Assim
 * a banda cai exatamente onde as estrelas reais projetadas se acumulam, e o
 * bojo aponta para o centro da galáxia visto DAQUI — que muda a cada warp.
 */

export const id = 'starfield';
export const order = 12;

// ── Constantes de escala ────────────────────────────────────────────────────
/**
 * Raio da casca do céu. Fica logo abaixo de farCamera.far (1e7) por dois
 * motivos: não ser cortada pelo frustum, e ficar ATRÁS de qualquer planeta
 * distante que o módulo `universe` posicione com toLocalCompressed — se a
 * casca ficasse na frente, o blending aditivo lavaria o planeta.
 */
const SKY_RADIUS = 9.2e6;
const STAR_RADIUS = 9.0e6;

/** Faixa de magnitudes que mapeamos para brilho visível (≈ olho nu + óptica). */
const MAG_SPAN_MAX = 9.0;
/** Histograma usado para achar a magnitude-limite sem ordenar o catálogo. */
const HIST_BINS = 256;
const HIST_RANGE = 26.0;

// ── Estado do módulo (singleton — um import por sessão) ─────────────────────
const S = {
  ctx: null,
  group: null,
  bandGroup: null,
  sphere: null,
  bgPoints: null,
  realPoints: null,
  tex: null,
  texData: null,
  texW: 0,
  texH: 0,

  // Uniforms compartilhados entre os três materiais: uma escrita atinge todos.
  uTime: { value: 0 },
  uFade: { value: 1 },
  uTwinkle: { value: 0.05 },
  uPixelRatio: { value: 1 },
  // Compensa o GAIN de gravação da textura (ver bakeGalaxyTexture). O valor é
  // deliberadamente baixo: a Via Láctea real é um brilho tênue que o olho só
  // pega adaptado ao escuro. Se ela competir com as estrelas, o céu vira uma
  // pintura — e é a estrela pontual que carrega a leitura de escala.
  uBandIntensity: { value: 0.055 },

  // Catálogo real
  realCap: 0,
  realPos: null,
  realCol: null,
  realMag: null,
  realPhase: null,
  realCount: 0,
  flux: null,          // magnitude aparente por estrela da galáxia
  hist: null,
  // Transcrição do catálogo em arrays tipados (posições e luminosidades).
  catPos: null,
  catLum: null,
  catalogFor: null,

  // Referencial galáctico
  pole: new THREE.Vector3(0, 1, 0),
  centroid: new THREE.Vector3(),
  /** false enquanto o polo vier do RNG de emergência, não do catálogo real. */
  frameFromCatalog: false,
  observerIndex: -1,
  observerPos: new THREE.Vector3(),
  /** Referência ao objeto de sistema já projetado — detecta troca sem evento. */
  observerSystem: undefined,

  // Temporários reutilizados (zero alocação em caminho quente)
  _v: new THREE.Vector3(),
  _x: new THREE.Vector3(),
  _y: new THREE.Vector3(),
  _z: new THREE.Vector3(),
  _m: new THREE.Matrix4(),

  fade: 1,
  density: 0,
  night: 1,
  usingCatalog: false,
};

// ═══════════════════════════════════════════════════════════════════════════
// Cor estelar
// ═══════════════════════════════════════════════════════════════════════════

/** sRGB → linear. Os materiais escrevem direto no alvo HDR linear. */
function s2l(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }

/** Cores sRGB canônicas por classe espectral (Harvard). */
const CLASS_RGB = {
  O: [0.61, 0.69, 1.00], B: [0.67, 0.75, 1.00], A: [0.79, 0.84, 1.00],
  F: [0.97, 0.97, 1.00], G: [1.00, 0.96, 0.92], K: [1.00, 0.82, 0.63],
  M: [1.00, 0.72, 0.44],
};
/** Luminosidade média (solar) por classe — usada quando o catálogo não traz. */
const CLASS_LUM = { O: 3.0e4, B: 2.0e2, A: 2.0e1, F: 3.5, G: 1.0, K: 0.35, M: 0.03 };
const CLASS_KEYS = ['O', 'B', 'A', 'F', 'G', 'K', 'M'];
/** Frequência aparente no céu: dominada por anãs frias, salpicada de azuis. */
const CLASS_W = [0.012, 0.05, 0.10, 0.14, 0.20, 0.25, 0.246];
/** Índices pré-alocados: `pickWeighted` recebe um array — não criamos 40k. */
const CLASS_IDX = [0, 1, 2, 3, 4, 5, 6];

/**
 * Corpo negro aproximado (Helland) → sRGB. Só usado quando o catálogo dá
 * temperatura mas não cor: é mais fiel que arredondar para a classe.
 */
function blackbody(tempK, out) {
  const t = clamp(tempK, 1000, 40000) / 100;
  let r, g, b;
  if (t <= 66) { r = 255; } else { r = 329.7 * Math.pow(t - 60, -0.1332); }
  if (t <= 66) { g = 99.47 * Math.log(t) - 161.1; } else { g = 288.1 * Math.pow(t - 60, -0.0755); }
  if (t >= 66) { b = 255; } else if (t <= 19) { b = 0; } else { b = 138.5 * Math.log(t - 10) - 305; }
  out[0] = clamp(r, 0, 255) / 255;
  out[1] = clamp(g, 0, 255) / 255;
  out[2] = clamp(b, 0, 255) / 255;
  return out;
}

const _rgb = [1, 1, 1];

/** Primeira letra da classe espectral, tolerante a 'G2V', 'g', {class:'K'}. */
function classLetter(v) {
  if (typeof v !== 'string' || !v.length) return null;
  const c = v.charAt(0).toUpperCase();
  return CLASS_RGB[c] ? c : null;
}

/**
 * Lê a cor de uma estrela do catálogo em espaço LINEAR.
 * O contrato não fixa o tipo de `star.color`, então aceitamos THREE.Color
 * (já linear por causa do color management), hex sRGB, string ou {r,g,b}.
 */
function readColorLinear(star, out) {
  const c = star && star.color;
  if (c) {
    if (c.isColor) { out[0] = c.r; out[1] = c.g; out[2] = c.b; return out; }
    if (typeof c === 'number') {
      out[0] = s2l(((c >> 16) & 255) / 255);
      out[1] = s2l(((c >> 8) & 255) / 255);
      out[2] = s2l((c & 255) / 255);
      return out;
    }
    if (typeof c === 'string') {
      // Só o formato #rrggbb — evita depender do parser de CSS do three aqui.
      const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
      if (m) {
        const n = parseInt(m[1], 16);
        out[0] = s2l(((n >> 16) & 255) / 255);
        out[1] = s2l(((n >> 8) & 255) / 255);
        out[2] = s2l((n & 255) / 255);
        return out;
      }
    }
    if (typeof c.r === 'number') { out[0] = c.r; out[1] = c.g; out[2] = c.b; return out; }
  }
  const k = classLetter(star && (star.class || star.spectral || star.spectralClass || star.type));
  if (k) {
    const t = CLASS_RGB[k];
    out[0] = s2l(t[0]); out[1] = s2l(t[1]); out[2] = s2l(t[2]);
    return out;
  }
  const temp = star && (star.temp || star.temperature);
  if (Number.isFinite(temp) && temp > 500) {
    blackbody(temp, out);
    out[0] = s2l(out[0]); out[1] = s2l(out[1]); out[2] = s2l(out[2]);
    return out;
  }
  out[0] = 1; out[1] = 0.97; out[2] = 0.93;
  return out;
}

/** Luminosidade em unidades solares, com fallbacks pela classe. */
function readLuminosity(star) {
  const l = star && (star.luminosity ?? star.lum ?? star.L);
  if (Number.isFinite(l) && l > 0) return l;
  const k = classLetter(star && (star.class || star.spectral || star.spectralClass || star.type));
  if (k) return CLASS_LUM[k];
  return 1;
}

/** Posição do nó de catálogo — o contrato varia entre `position`/`pos`/inline. */
function readPos(star, out) {
  const p = (star && (star.position || star.pos || star.center)) || star;
  if (p && typeof p.x === 'number' && typeof p.y === 'number' && typeof p.z === 'number') {
    out.set(p.x, p.y, p.z);
    return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// Shaders
// ═══════════════════════════════════════════════════════════════════════════

/*
 * NOTA sobre profundidade: o renderer liga `logarithmicDepthBuffer`, então os
 * materiais padrão escrevem gl_FragDepth em escala LOGARÍTMICA. Um
 * ShaderMaterial que não faça o mesmo grava profundidade numa escala
 * incompatível e o teste de oclusão vira ruído. Por isso incluímos os chunks
 * `logdepthbuf_*`: precisamos que planetas e o disco solar OCULTEM as estrelas
 * (depthTest ligado), mesmo escrevendo com depthWrite desligado.
 */
const STAR_VERT = /* glsl */`
uniform float uTime;
uniform float uFade;
uniform float uTwinkle;
uniform float uPixelRatio;
uniform float uSizeBase;
uniform float uSizeScale;
uniform float uBright;

attribute vec3  aColor;
attribute float aMag;    // brilho normalizado [0,1] derivado da magnitude
attribute float aPhase;  // fase própria da cintilação

varying vec3  vColor;
varying float vBright;

#include <logdepthbuf_pars_vertex>

void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>

  // Duas senoides de períodos incomensuráveis e fase própria: nenhuma estrela
  // pisca em sincronia com a vizinha, que é o artefato que entrega o truque.
  float ph = aPhase * 6.2831853;
  float tw = sin(uTime * (1.63 + aPhase * 2.11) + ph) * 0.62
           + sin(uTime * (0.87 + aPhase * 1.37) + ph * 2.7) * 0.38;

  // Estrela fraca cintila proporcionalmente mais — é o que o olho vê.
  float amp = uTwinkle * (0.30 + 0.70 * (1.0 - aMag));
  float f = 1.0 + tw * amp;

  vBright = aMag * uBright * uFade * max(f, 0.0);
  vColor  = aColor;

  // Tamanho fixo em pixels: uma fonte pontual não tem tamanho angular, o que
  // vemos é a resposta da óptica ao fluxo. Nunca deixamos cair abaixo de ~2 px
  // para o disco radial ter onde existir.
  gl_PointSize = (uSizeBase + uSizeScale * pow(aMag, 0.62)) * uPixelRatio
               * (1.0 + tw * amp * 0.30);
}
`;

const STAR_FRAG = /* glsl */`
varying vec3  vColor;
varying float vBright;

#include <logdepthbuf_pars_fragment>

void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d) * 4.0;          // 0 no centro, 1 na borda do sprite
  if (r2 > 1.0) discard;
  #include <logdepthbuf_fragment>

  // Núcleo apertado + halo largo e fraco = perfil de fonte pontual real.
  float core = exp(-r2 * 17.0);
  float halo = exp(-r2 * 3.1) * 0.30;
  float edge = 1.0 - r2 * r2;          // corta o quadrado sem borda dura
  float a = (core + halo) * edge * vBright;
  if (a < 0.0016) discard;

  // Só a estrela brilhante estoura o núcleo para branco; a fraca guarda a cor
  // da sua classe espectral.
  vec3 col = mix(vColor, vec3(1.0), clamp(core * vBright * 0.9, 0.0, 1.0));
  gl_FragColor = vec4(col * a, a);
}
`;

const BAND_VERT = /* glsl */`
varying vec2 vUv;
#include <logdepthbuf_pars_vertex>
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const BAND_FRAG = /* glsl */`
uniform sampler2D uMap;
uniform float uBandIntensity;
uniform float uFade;
varying vec2 vUv;
#include <logdepthbuf_pars_fragment>

void main() {
  #include <logdepthbuf_fragment>
  vec3 t = texture2D(uMap, vUv).rgb;
  // A textura é gravada com codificação gamma 2 (sqrt): elevar ao quadrado
  // devolve o valor linear e ainda gasta os 8 bits onde importa — nas sombras
  // das faixas de poeira.
  vec3 c = t * t;

  // Dither de 1/700 LSB: mata o banding das gaussianas muito suaves sem
  // introduzir grão perceptível.
  float dth = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  c += dth * 0.0014;

  gl_FragColor = vec4(max(c, 0.0) * uBandIntensity * uFade, 1.0);
}
`;

// ═══════════════════════════════════════════════════════════════════════════
// init
// ═══════════════════════════════════════════════════════════════════════════

export async function init(ctx) {
  S.ctx = ctx;

  const low = ctx.quality?.preset === 'low';
  const bgCount = low ? 16000 : 40000;
  S.realCap = low ? 1600 : 4000;

  const rootRng = ctx.rng.derive('starfield', 0);

  S.group = new THREE.Group();
  S.group.name = 'starfield';
  // O céu não translada com a origem flutuante: está no infinito e a farCamera
  // já vive na origem. Só a orientação importa.
  S.group.matrixAutoUpdate = true;

  S.bandGroup = new THREE.Group();
  S.bandGroup.name = 'starfield.galactic';
  S.group.add(S.bandGroup);

  // ── 1. Referencial galáctico ─────────────────────────────────────────────
  computeGalacticFrame(ctx, rootRng);

  // ── 2. Textura equiretangular (Via Láctea + poeira + nebulosas) ──────────
  ctx.progress?.(0.0, 'assando a Via Láctea…');
  const W = low ? 384 : 640;
  const H = W >> 1;
  S.texW = W; S.texH = H;
  S.texData = new Uint8Array(W * H * 4);
  await bakeGalaxyTexture(ctx, rootRng.derive('band', 0), low);

  S.tex = new THREE.DataTexture(S.texData, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  S.tex.name = 'starfield.milkyway';
  S.tex.wrapS = THREE.RepeatWrapping;             // longitude fecha o círculo
  S.tex.wrapT = THREE.ClampToEdgeWrapping;
  S.tex.minFilter = THREE.LinearMipmapLinearFilter;
  S.tex.magFilter = THREE.LinearFilter;
  S.tex.generateMipmaps = true;
  S.tex.colorSpace = THREE.NoColorSpace;          // decodificação é nossa
  S.tex.anisotropy = Math.min(4, ctx.engine?.renderer?.capabilities?.getMaxAnisotropy?.() || 1);
  S.tex.needsUpdate = true;

  const bandGeo = new THREE.SphereGeometry(SKY_RADIUS, 64, 32);
  const bandMat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: S.tex },
      uBandIntensity: S.uBandIntensity,
      uFade: S.uFade,
    },
    vertexShader: BAND_VERT,
    fragmentShader: BAND_FRAG,
    side: THREE.BackSide,
    depthWrite: false,     // é o fundo de tudo: não ocupa o buffer de ninguém
    depthTest: true,       // …mas é ocultado por planetas e pelo disco solar
    blending: THREE.AdditiveBlending,
    transparent: true,
    fog: false,
    toneMapped: false,
  });
  S.sphere = new THREE.Mesh(bandGeo, bandMat);
  S.sphere.name = 'starfield.band';
  S.sphere.frustumCulled = false;
  S.sphere.renderOrder = -10000;
  S.bandGroup.add(S.sphere);

  // ── 3. Campo de fundo (não navegável) ────────────────────────────────────
  S.bgPoints = buildBackgroundField(ctx, rootRng.derive('bg', 0), bgCount);
  S.bandGroup.add(S.bgPoints);   // vive no referencial canônico, junto da banda

  // ── 4. Catálogo real projetado ───────────────────────────────────────────
  S.realPos = new Float32Array(S.realCap * 3);
  S.realCol = new Float32Array(S.realCap * 3);
  S.realMag = new Float32Array(S.realCap);
  S.realPhase = new Float32Array(S.realCap);
  S.hist = new Int32Array(HIST_BINS);
  S.realPoints = buildPointsObject('starfield.catalog', S.realPos, S.realCol, S.realMag, S.realPhase, {
    sizeBase: 2.0, sizeScale: 6.2, bright: 1.0,
  });
  S.realPoints.renderOrder = -9998;
  // Sem rotação: as direções já estão no espaço real da galáxia.
  S.group.add(S.realPoints);

  ctx.engine.farScene.add(S.group);

  reproject();

  // Reprojetar é a razão de o céu ser navegação e não papel de parede.
  ctx.events.on('warp:end', reproject);
  ctx.events.on('system:enter', reproject);
  ctx.events.on('universe:seed', reproject);

  ctx.provide(id, {
    group: S.group,
    reproject,
    /** Visibilidade atual [0,1] — outros módulos podem casar o seu próprio fade. */
    get visibility() { return S.fade; },
    get starCount() { return S.realCount; },
    get usingCatalog() { return S.usingCatalog; },
    /** Ganho geral da nebulosidade galáctica (o `perf` pode baixar). */
    setBandIntensity(v) { S.uBandIntensity.value = Math.max(0, v); },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Construção de malhas de pontos
// ═══════════════════════════════════════════════════════════════════════════

function buildPointsObject(name, pos, col, mag, phase, opts) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  // Bounding sphere fixa: nunca recalculamos (os slots não usados são zero).
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), STAR_RADIUS * 1.1);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: S.uTime,
      uFade: S.uFade,
      uTwinkle: S.uTwinkle,
      uPixelRatio: S.uPixelRatio,
      uSizeBase: { value: opts.sizeBase },
      uSizeScale: { value: opts.sizeScale },
      uBright: { value: opts.bright },
    },
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    transparent: true,
    fog: false,
    toneMapped: false,
  });

  const pts = new THREE.Points(geo, mat);
  pts.name = name;
  pts.frustumCulled = false;
  return pts;
}

/**
 * ~40k estrelas de fundo. Não são navegáveis: representam a população que o
 * catálogo do universo não modela. Ficam no referencial canônico e por isso
 * acompanham a banda quando a orientação galáctica é recalculada.
 */
function buildBackgroundField(ctx, rng, count) {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const mag = new Float32Array(count);
  const phase = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    // 60% seguem o disco (gaussiana em latitude galáctica), 40% são halo
    // isotrópico. Sem essa mistura o campo fica com "cara de ruído branco".
    let x, y, z;
    if (rng.float() < 0.60) {
      const lat = rng.normal(0, 0.20);
      const sy = clamp(Math.sin(lat), -1, 1);
      const r = Math.sqrt(Math.max(0, 1 - sy * sy));
      // Concentra em longitude na direção do centro canônico (+X).
      const lon = rng.normal(0, 1.5);
      x = r * Math.cos(lon); z = r * Math.sin(lon); y = sy;
    } else {
      const u = rng.float() * 2 - 1;
      const t = rng.float() * Math.PI * 2;
      const r = Math.sqrt(Math.max(0, 1 - u * u));
      x = r * Math.cos(t); z = r * Math.sin(t); y = u;
    }
    pos[i * 3] = x * STAR_RADIUS;
    pos[i * 3 + 1] = y * STAR_RADIUS;
    pos[i * 3 + 2] = z * STAR_RADIUS;

    // Lei de potência: muitas fracas, pouquíssimas fortes. Uma distribuição
    // uniforme aqui produz aquele céu "de papel de parede" chapado.
    const u1 = rng.float();
    const b = Math.pow(u1, 3.1);
    mag[i] = 0.035 + 0.965 * b;

    const k = CLASS_KEYS[rng.pickWeighted(CLASS_IDX, CLASS_W)];
    const c = CLASS_RGB[k];
    // Jitter de cor: catálogos reais têm dispersão dentro da mesma classe.
    const j = rng.range(-0.05, 0.05);
    col[i * 3] = s2l(clamp(c[0] + j, 0, 1));
    col[i * 3 + 1] = s2l(clamp(c[1], 0, 1));
    col[i * 3 + 2] = s2l(clamp(c[2] - j, 0, 1));

    phase[i] = rng.float();
  }

  const obj = buildPointsObject('starfield.background', pos, col, mag, phase, {
    sizeBase: 1.7, sizeScale: 3.0, bright: 0.62,
  });
  obj.renderOrder = -9999;
  return obj;
}

// ═══════════════════════════════════════════════════════════════════════════
// Referencial galáctico
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Descobre o polo e o centroide da galáxia.
 *
 * POR QUÊ por variância: o contrato não diz qual eixo é a espessura do disco.
 * O eixo de MENOR variância das posições é, por construção, a normal do disco —
 * funciona para qualquer convenção que o módulo `universe` escolher, e degrada
 * para +Y se o catálogo não existir.
 */
function computeGalacticFrame(ctx, rng) {
  const stars = ctx.universe?.galaxy?.stars;
  if (!stars || !stars.length) {
    // Sem catálogo: polo determinístico, mas não alinhado aos eixos (um plano
    // galáctico exatamente horizontal denuncia geração preguiçosa).
    const o = rng.derive('pole', 0).onSphere();
    S.pole.set(o.x, o.y, o.z).normalize();
    S.centroid.set(0, 0, 0);
    return;
  }

  const stride = Math.max(1, Math.floor(stars.length / 4000));
  let n = 0, mx = 0, my = 0, mz = 0;
  for (let i = 0; i < stars.length; i += stride) {
    if (!readPos(stars[i], S._v)) continue;
    mx += S._v.x; my += S._v.y; mz += S._v.z; n++;
  }
  if (n === 0) { S.pole.set(0, 1, 0); S.centroid.set(0, 0, 0); return; }
  mx /= n; my /= n; mz /= n;
  S.centroid.set(mx, my, mz);
  S.frameFromCatalog = true;

  let vx = 0, vy = 0, vz = 0;
  for (let i = 0; i < stars.length; i += stride) {
    if (!readPos(stars[i], S._v)) continue;
    const dx = S._v.x - mx, dy = S._v.y - my, dz = S._v.z - mz;
    vx += dx * dx; vy += dy * dy; vz += dz * dz;
  }
  if (vy <= vx && vy <= vz) S.pole.set(0, 1, 0);
  else if (vx <= vy && vx <= vz) S.pole.set(1, 0, 0);
  else S.pole.set(0, 0, 1);
}

/** Índice do sistema atual dentro de `galaxy.stars`, com vários fallbacks. */
function findObserverIndex(ctx) {
  const u = ctx.universe;
  const stars = u?.galaxy?.stars;
  if (!stars || !stars.length) return -1;

  const cur = u.current || ctx.system || null;
  const cands = [u.currentIndex, u.index, cur?.index, cur?.starIndex, cur?.systemIndex];
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    if (Number.isInteger(c) && c >= 0 && c < stars.length) return c;
  }
  const cid = cur?.id;
  if (Number.isInteger(cid) && cid >= 0 && cid < stars.length) return cid;
  if (cur && (cid != null || cur.name)) {
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      if (cid != null && (s.id === cid || s.systemId === cid || s.index === cid)) return i;
      if (cur.name && (s.name === cur.name || s.system === cur.name)) return i;
    }
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// Projeção do catálogo real
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Reprojeta o céu a partir do sistema atual.
 *
 * Duas passadas + histograma em vez de ordenar: com dezenas de milhares de
 * estrelas um sort com comparador custa dezenas de ms num único frame de warp.
 * O histograma acha a magnitude-limite em O(n) — que é exatamente o que um
 * catálogo real é: tudo mais brilhante que um corte.
 */
export function reproject() {
  const ctx = S.ctx;
  if (!ctx || !S.realPos) return;

  // Marca já aqui: os dois caminhos (catálogo e fallback) contam como
  // "projetado para este sistema" e não devem reentrar no frame seguinte.
  S.observerSystem = ctx.universe?.current || ctx.system || null;

  const stars = ctx.universe?.galaxy?.stars;
  if (!stars || !stars.length) { fillFallbackField(ctx); return; }

  // O catálogo pode ter ficado pronto depois do nosso init: nesse caso o polo
  // ainda é o de emergência e precisa ser medido de verdade agora.
  if (!S.frameFromCatalog) computeGalacticFrame(ctx, ctx.rng.derive('starfield', 0));

  const obs = findObserverIndex(ctx);
  S.observerIndex = obs;
  if (obs < 0 || !readPos(stars[obs], S.observerPos)) {
    // Sem posição de observador confiável, o centroide serve: o céu ainda é
    // consistente, só não tem a paralaxe correta.
    S.observerPos.copy(S.centroid);
  }

  const n = stars.length;
  if (!S.flux || S.flux.length !== n) S.flux = new Float32Array(n);
  const mags = S.flux;

  // ── Cache do catálogo ────────────────────────────────────────────────────
  // Estrelas de galáxia não se movem nem mudam de luminosidade: ler os objetos
  // JS de novo a cada warp é o custo dominante desta função. Transcrevemos uma
  // única vez para arrays tipados e todo warp seguinte vira aritmética pura.
  if (S.catalogFor !== stars) {
    S.catPos = new Float32Array(n * 3);
    S.catLum = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const st = stars[i];
      if (readPos(st, S._v)) {
        S.catPos[i * 3] = S._v.x; S.catPos[i * 3 + 1] = S._v.y; S.catPos[i * 3 + 2] = S._v.z;
        S.catLum[i] = readLuminosity(st);
      } else {
        S.catLum[i] = 0;          // 0 marca "sem posição utilizável"
      }
    }
    S.catalogFor = stars;
  }
  const cp = S.catPos, cl = S.catLum;

  // ── Passada 1: magnitude aparente ────────────────────────────────────────
  let mMin = Infinity;
  const ox = S.observerPos.x, oy = S.observerPos.y, oz = S.observerPos.z;
  for (let i = 0; i < n; i++) {
    const L = cl[i];
    if (i === obs || !(L > 0)) { mags[i] = Infinity; continue; }
    const dx = cp[i * 3] - ox, dy = cp[i * 3 + 1] - oy, dz = cp[i * 3 + 2] - oz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (!(d2 > 1e-9)) { mags[i] = Infinity; continue; }
    // m = -2.5·log10(F) → o -1.0857 é -2.5/ln(10).
    const m = -1.0857362 * Math.log(L / d2);
    mags[i] = m;
    if (m < mMin) mMin = m;
  }
  if (!Number.isFinite(mMin)) { fillFallbackField(ctx); return; }

  // ── Passada 2: histograma → magnitude-limite ─────────────────────────────
  const hist = S.hist;
  hist.fill(0);
  const invBin = HIST_BINS / HIST_RANGE;
  for (let i = 0; i < n; i++) {
    const m = mags[i];
    if (!Number.isFinite(m)) continue;
    let b = ((m - mMin) * invBin) | 0;
    if (b < 0) b = 0;
    if (b >= HIST_BINS) continue;
    hist[b]++;
  }
  const binMag = HIST_RANGE / HIST_BINS;
  // `topBin` é o topo ROBUSTO da distribuição (2% mais brilhantes) e não o
  // mínimo absoluto: uma companheira a meio ano-luz produziria um outlier de
  // dezenas de magnitudes e achataria todo o resto do céu no piso.
  const topTarget = Math.max(1, (S.realCap * 0.02) | 0);
  let acc = 0, cutBin = HIST_BINS - 1, topBin = 0, topFound = false;
  for (let b = 0; b < HIST_BINS; b++) {
    acc += hist[b];
    if (!topFound && acc >= topTarget) { topBin = b; topFound = true; }
    if (acc >= S.realCap) { cutBin = b; break; }
  }
  const mCut = mMin + (cutBin + 1) * binMag;        // corte do "catálogo"
  const mTop = mMin + topBin * binMag;              // referência de saturação
  // Faixa dinâmica adaptativa: num sistema com poucas vizinhas o céu não pode
  // ficar todo no mesmo brilho.
  const span = clamp(mCut - mTop, 2.5, MAG_SPAN_MAX);
  const mRef = mTop + span;
  const invSpan = 1 / span;

  // ── Passada 3: preenchimento dos buffers ─────────────────────────────────
  const pos = S.realPos, col = S.realCol, mag = S.realMag, phase = S.realPhase;
  let k = 0;
  for (let i = 0; i < n && k < S.realCap; i++) {
    const m = mags[i];
    if (!(m <= mCut)) continue;
    const vx = cp[i * 3] - ox, vy = cp[i * 3 + 1] - oy, vz = cp[i * 3 + 2] - oz;
    const len = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (!(len > 0)) continue;
    const inv = STAR_RADIUS / len;
    pos[k * 3] = vx * inv;
    pos[k * 3 + 1] = vy * inv;
    pos[k * 3 + 2] = vz * inv;

    readColorLinear(stars[i], _rgb);
    col[k * 3] = _rgb[0]; col[k * 3 + 1] = _rgb[1]; col[k * 3 + 2] = _rgb[2];

    const t = saturate((mRef - m) * invSpan);
    mag[k] = 0.05 + 0.95 * Math.pow(t, 1.35);
    // Fase pela razão áurea: espalhamento máximo sem consultar RNG por estrela.
    phase[k] = (i * 0.6180339887) % 1;
    k++;
  }
  // Zera o rabo não usado para o caso de a draw range mudar por outro caminho.
  for (let j = k; j < S.realCap; j++) mag[j] = 0;

  S.realCount = k;
  S.usingCatalog = true;
  commitRealBuffers();
  updateGalacticOrientation();

  ctx.debug?.set?.('starfield', `${k} estrelas reais · mlim ${mCut.toFixed(1)}`);
}

/** Campo determinístico quando não há `ctx.universe` — o jogo não fica sem céu. */
function fillFallbackField(ctx) {
  const rng = ctx.rng.derive('starfield.fallback', 0);
  const pos = S.realPos, col = S.realCol, mag = S.realMag, phase = S.realPhase;
  const count = Math.min(S.realCap, 2200);
  for (let i = 0; i < count; i++) {
    const o = rng.onSphere();
    // Mesmo sem catálogo, mantemos o viés de disco em torno do polo escolhido.
    S._v.set(o.x, o.y, o.z);
    const lat = S._v.dot(S.pole);
    if (Math.abs(lat) > 0.35 && rng.float() < 0.45) {
      S._v.addScaledVector(S.pole, -lat * 0.8).normalize();
    }
    pos[i * 3] = S._v.x * STAR_RADIUS;
    pos[i * 3 + 1] = S._v.y * STAR_RADIUS;
    pos[i * 3 + 2] = S._v.z * STAR_RADIUS;

    const k = CLASS_KEYS[rng.pickWeighted(CLASS_IDX, CLASS_W)];
    const c = CLASS_RGB[k];
    col[i * 3] = s2l(c[0]); col[i * 3 + 1] = s2l(c[1]); col[i * 3 + 2] = s2l(c[2]);
    mag[i] = 0.08 + 0.92 * Math.pow(rng.float(), 2.4);
    phase[i] = rng.float();
  }
  for (let j = count; j < S.realCap; j++) mag[j] = 0;
  S.realCount = count;
  S.usingCatalog = false;
  commitRealBuffers();
  updateGalacticOrientation();
  ctx.debug?.set?.('starfield', `${count} estrelas (sem catálogo)`);
}

function commitRealBuffers() {
  const g = S.realPoints.geometry;
  g.attributes.position.needsUpdate = true;
  g.attributes.aColor.needsUpdate = true;
  g.attributes.aMag.needsUpdate = true;
  g.attributes.aPhase.needsUpdate = true;
  g.setDrawRange(0, S.realCount);
}

/**
 * Gira a casca canônica (polo +Y, centro +X) para o referencial real.
 * O bojo tem de apontar para o centro da galáxia visto DAQUI — por isso é
 * recalculado a cada warp, e não uma vez no boot.
 */
function updateGalacticOrientation() {
  S._y.copy(S.pole).normalize();
  S._x.subVectors(S.centroid, S.observerPos);
  // Projeta a direção do centro no plano galáctico e trata o caso degenerado
  // (observador exatamente no centro).
  S._x.addScaledVector(S._y, -S._x.dot(S._y));
  if (S._x.lengthSq() < 1e-12) {
    S._x.set(Math.abs(S._y.y) > 0.9 ? 1 : 0, Math.abs(S._y.y) > 0.9 ? 0 : 1, 0);
    S._x.addScaledVector(S._y, -S._x.dot(S._y));
  }
  S._x.normalize();
  S._z.crossVectors(S._x, S._y).normalize();
  S._m.makeBasis(S._x, S._y, S._z);
  S.bandGroup.quaternion.setFromRotationMatrix(S._m);
}

// ═══════════════════════════════════════════════════════════════════════════
// Assar a textura equiretangular
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Gera a Via Láctea numa DataTexture equiretangular, em fatias limitadas por
 * tempo (nenhum bloco passa de ~6 ms — regra 3 da arquitetura).
 *
 * Convenção de UV: idêntica à da SphereGeometry do three, para podermos
 * amostrar `uv` direto no fragment sem atan2 (que produz uma costura visível
 * por causa das derivadas no mipmapping).
 */
async function bakeGalaxyTexture(ctx, rng, low) {
  const W = S.texW, H = S.texH, data = S.texData;
  const oct = low ? 3 : 4;

  const nBand = new Noise(rng.derive('band', 0).int(0x7fffffff));
  const nDust = new Noise(rng.derive('dust', 0).int(0x7fffffff));
  const nGrain = new Noise(rng.derive('grain', 0).int(0x7fffffff));
  const nNeb = new Noise(rng.derive('neb', 0).int(0x7fffffff));

  // ── Nebulosas: 2 a 4 manchas grandes, presas perto do plano galáctico ────
  const nebRng = rng.derive('nebulae', 0);
  const NEB_TINTS = [
    [0.95, 0.28, 0.42],   // hidrogênio ionizado — o vermelho-magenta clássico
    [0.30, 0.55, 1.00],   // reflexão azul
    [0.35, 0.95, 0.72],   // verde-turquesa de OIII
    [1.00, 0.55, 0.22],   // poeira quente reemitindo
    [0.72, 0.38, 1.00],   // violeta
  ];
  const nebCount = nebRng.intRange(2, 4);
  const nebs = [];
  for (let i = 0; i < nebCount; i++) {
    const lat = nebRng.normal(0, 0.22);
    const sy = clamp(Math.sin(lat), -0.7, 0.7);
    const r = Math.sqrt(Math.max(0, 1 - sy * sy));
    const lon = nebRng.range(0, Math.PI * 2);
    const ang = nebRng.range(0.24, 0.52);          // raio angular (rad)
    const tint = NEB_TINTS[nebRng.int(NEB_TINTS.length)];
    const centerLat = Math.asin(sy);
    nebs.push({
      x: r * Math.cos(lon), y: sy, z: r * Math.sin(lon),
      cosCut: Math.cos(ang),
      amp: nebRng.range(0.20, 0.44),
      freq: nebRng.range(2.2, 4.6),
      ox: nebRng.range(-40, 40), oy: nebRng.range(-40, 40), oz: nebRng.range(-40, 40),
      r: tint[0], g: tint[1], b: tint[2],
      minY: Math.sin(clamp(centerLat - ang, -1.5707963, 1.5707963)),
      maxY: Math.sin(clamp(centerLat + ang, -1.5707963, 1.5707963)),
    });
  }

  // Tabelas por coluna: seno/cosseno de longitude não mudam entre as linhas.
  const cosP = new Float32Array(W), sinP = new Float32Array(W);
  const warpP = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    const phi = ((x + 0.5) / W) * Math.PI * 2;
    cosP[x] = Math.cos(phi); sinP[x] = Math.sin(phi);
  }

  // Cores da banda (linear). Quente no bojo, fria nos braços externos.
  const WARM_R = 1.00, WARM_G = 0.83, WARM_B = 0.63;
  const COOL_R = 0.70, COOL_G = 0.80, COOL_B = 1.00;

  const SIG_BAND = 0.150;        // espessura base em seno de latitude
  const SIG_DUST = 0.085;        // a poeira é MAIS fina que a luz que ela corta
  // Brilho difuso de fundo. Baixo de propósito: um piso alto vira "chuvisco de
  // TV" no céu inteiro, que é pior que preto puro.
  const FLOOR = 0.0035;
  /**
   * Ganho de gravação. Sem ele o bojo satura em 255 e perde exatamente o que
   * mais importa ali: o desenho das faixas de poeira. Guardamos o campo com
   * folga e devolvemos o brilho no shader (uBandIntensity), que trabalha em
   * HDR e não tem teto.
   */
  const GAIN = 0.42;

  // Empenamento do plano: discos galácticos reais são torcidos, e é essa leve
  // curva em "S" que impede a banda de parecer uma régua horizontal. Só depende
  // da longitude, então cabe numa tabela por coluna.
  for (let x = 0; x < W; x++) {
    warpP[x] = nBand.noise3(cosP[x] * 1.35 + 21.3, sinP[x] * 1.35 - 8.7, 4.9) * 0.055;
  }

  let last = performance.now();

  for (let y = 0; y < H; y++) {
    const tv = (y + 0.5) / H;
    const theta = (1 - tv) * Math.PI;               // ângulo polar a partir de +Y
    const st = Math.sin(theta);
    const dy = Math.cos(theta);                     // = seno da latitude galáctica

    // Nenhuma nebulosa alcança esta latitude? Então nem precisamos testá-las
    // texel a texel.
    let nebRow = false;
    for (let i = 0; i < nebs.length; i++) {
      if (dy >= nebs[i].minY - 0.02 && dy <= nebs[i].maxY + 0.02) { nebRow = true; break; }
    }

    const rowOff = y * W * 4;
    for (let x = 0; x < W; x++) {
      const dx = -cosP[x] * st;
      const dz = sinP[x] * st;
      // Latitude corrigida pelo empenamento do disco.
      const dyw = dy - warpP[x];

      // Halo difuso: UMA amostra de baixa frequência. Fazer isto com ruído de
      // alta frequência produziria chuvisco em todo o céu.
      const halo = FLOOR * (0.45 + 0.9 * (nGrain.noise3(dx * 1.6, dy * 1.6, dz * 1.6) * 0.5 + 0.5));
      let R, G, B;

      // Distância angular ao centro canônico (+X), em cosseno.
      const dc = dx;
      const bulge = Math.exp(-(1 - dc) * 4.4);
      // Braço: densidade cai com a longitude, mas nunca some (o anticentro
      // ainda tem Via Láctea, só que fraca).
      const arm = 0.30 + 0.70 * Math.exp(-(1 - dc) * 0.9);

      // Corte barato POR TEXEL (e não por linha): a banda só é larga perto do
      // bojo, então testar com a largura máxima global desperdiçaria o corte.
      const wMax = SIG_BAND * (1 + 1.1 * bulge) * 1.25;
      const tMax = dyw / wMax;
      let skip = Math.exp(-tMax * tMax) < 0.004;
      if (skip && nebRow) {
        for (let i = 0; i < nebs.length; i++) {
          const nb = nebs[i];
          if (dx * nb.x + dy * nb.y + dz * nb.z > nb.cosCut - 0.05) { skip = false; break; }
        }
      }

      if (skip) {
        R = halo * 0.66; G = halo * 0.78; B = halo;
      } else {
        // Estrutura em duas escalas: fBm esticado no plano dá as nuvens
        // grandes; um ridged de frequência maior dá os FILAMENTOS. Só o fBm
        // produz bolhas isotrópicas — o olho lê isso como "fumaça", não galáxia.
        const f1 = nBand.fbm(dx * 2.4, dyw * 6.2, dz * 2.4, oct, 2.15, 0.52);
        const f2 = nBand.ridged(dx * 7.8 + 3.1, dyw * 15.0, dz * 7.8 - 2.4, 3, 2.3, 0.55, 1.5);
        const width = SIG_BAND * (1 + 1.1 * bulge) * (0.72 + 0.52 * (f1 * 0.5 + 0.5));
        const t = dyw / width;
        let band = Math.exp(-t * t) * arm;
        band *= 0.40 + 0.85 * (f1 * 0.5 + 0.5);
        band *= 0.55 + 0.95 * f2;
        band *= 1 + 2.2 * bulge;

        // ── POEIRA ────────────────────────────────────────────────────────
        // É isto que faz o fundo parecer uma galáxia e não um borrão: um campo
        // de extinção MULTIPLICATIVO, mais fino que a banda e mais denso perto
        // do centro, cortando a luz em faixas escuras irregulares. Duas escalas
        // de novo: a faixa larga e os glóbulos pequenos.
        const dn = nDust.fbm(dx * 2.9 + 11.7, dyw * 9.5 - 4.1, dz * 2.9 + 6.9, oct, 2.3, 0.55);
        const dn2 = nDust.noise3(dx * 8.5 - 2.2, dyw * 20.0 + 5.5, dz * 8.5 + 1.3);
        const td = dyw / SIG_DUST;
        const dustBand = Math.exp(-td * td);
        // O peso quase constante em longitude é intencional: a Grande Fenda
        // corre ao longo de TODA a banda, não só no bojo. Poeira só no centro
        // vira uma mancha, e mancha não lê como galáxia.
        const dustAmt = dustBand * saturate(dn * 1.35 + dn2 * 0.5 + 0.42) * (0.62 + 0.62 * bulge);
        const extinction = Math.exp(-dustAmt * 4.6);
        band *= extinction;

        // Cor: quente onde há bojo e densidade, fria nos braços tênues.
        const mixw = saturate(bulge * 1.15 + f1 * 0.30 + 0.05);
        let cr = lerp(COOL_R, WARM_R, mixw);
        let cg = lerp(COOL_G, WARM_G, mixw);
        let cb = lerp(COOL_B, WARM_B, mixw);
        // A poeira que sobrou avermelha o que passa por ela (avermelhamento
        // interestelar) — detalhe barato, muito legível.
        const red = saturate(dustAmt * 0.9);
        cr *= 1 + red * 0.40; cb *= 1 - red * 0.50;

        const inten = band + halo;
        R = cr * inten; G = cg * inten; B = cb * inten;

        // ── Nebulosas coloridas ───────────────────────────────────────────
        for (let i = 0; nebRow && i < nebs.length; i++) {
          const nb = nebs[i];
          // A borda é DISTORCIDA por ruído antes do corte: um disco radial
          // limpo entrega a mancha como "gradiente de Photoshop".
          const nn = nNeb.fbm(dx * nb.freq + nb.ox, dy * nb.freq + nb.oy, dz * nb.freq + nb.oz, oct, 2.2, 0.55);
          const ca = dx * nb.x + dy * nb.y + dz * nb.z + nn * (1 - nb.cosCut) * 0.55;
          if (ca <= nb.cosCut) continue;
          const u = saturate((ca - nb.cosCut) / (1 - nb.cosCut));
          let a = smoothstep(0, 1, u);
          a *= a;                                   // borda longa e suave
          a *= 0.25 + 1.15 * (nn * 0.5 + 0.5);
          // A mesma poeira também come a nebulosa: mantém tudo coerente.
          a *= extinction * 0.55 + 0.45;
          const g2 = a * nb.amp;
          R += nb.r * g2; G += nb.g * g2; B += nb.b * g2;
        }
      }

      // Codificação gamma 2 (sqrt): os 8 bits vão quase todos para as sombras,
      // onde as faixas de poeira precisam de resolução.
      const o = rowOff + x * 4;
      data[o] = Math.min(255, Math.sqrt(saturate(R * GAIN)) * 255 + 0.5) | 0;
      data[o + 1] = Math.min(255, Math.sqrt(saturate(G * GAIN)) * 255 + 0.5) | 0;
      data[o + 2] = Math.min(255, Math.sqrt(saturate(B * GAIN)) * 255 + 0.5) | 0;
      data[o + 3] = 255;
    }

    // Cede o frame por tempo, não por número de linhas: as linhas do plano
    // galáctico custam 10× mais que as dos polos.
    const now = performance.now();
    if (now - last > 6) {
      // Avanço mínimo na barra: o manifesto de main.js já reservou a fatia
      // deste módulo — não podemos sequestrar a barra inteira do boot.
      ctx.progress?.(0.04 + 0.03 * (y / H), 'assando a Via Láctea…');
      await new Promise((r) => requestAnimationFrame(r));
      last = performance.now();
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Visibilidade: atmosfera + noite
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Densidade atmosférica [0,1] — quanto ar existe entre o olho e o vácuo.
 *
 * Preferimos sempre o que o módulo `sky` publicar; nada aqui pode assumir que
 * ele existe. A ordem é: densidade explícita → espessura real da atmosfera
 * daquele planeta → a escala canônica de §7 (radius × 0,06).
 */
function atmosphereDensity(ctx) {
  const sky = ctx.sky;
  if (sky) {
    const d = sky.density ?? sky.atmosphereDensity ?? sky.airDensity;
    if (Number.isFinite(d)) return saturate(d);
    if (typeof sky.getDensity === 'function') {
      const v = sky.getDensity();
      if (Number.isFinite(v)) return saturate(v);
    }
    // Fora da atmosfera o `sky` já sabe a resposta e ela é exata.
    if (sky.inAtmosphere === false) return 0;
  }
  const body = ctx.planet?.current;
  if (!body || body.hasAtmosphere === false) return 0;
  const alt = ctx.player?.altitude;
  if (!Number.isFinite(alt)) return 0;

  let top = sky?.atmosphereThickness;
  // Escala canônica (§7) como último recurso.
  if (!Number.isFinite(top) || top <= 0) top = (body.radius || 1e5) * 0.06;

  // Perfil exponencial: a extinção real cresce muito mais rápido perto do chão
  // do que uma rampa linear, e é isso que dá a transição sem "corte". O termo
  // (1-h²) força o zero exato no topo, senão sobraria um degrau ao sair.
  const h = saturate(alt / Math.max(1, top));
  return saturate(Math.exp(-h * 3.2) * (1 - h * h));
}

/** Fator de noite [0,1] — 1 no lado escuro. */
function nightFactor(ctx) {
  const sun = ctx.sky?.sunDirection;
  let elev;
  if (sun && ctx.player?.up) {
    elev = sun.x * ctx.player.up.x + sun.y * ctx.player.up.y + sun.z * ctx.player.up.z;
  } else {
    const f = ctx.time?.dayFraction ?? 0.5;
    elev = Math.sin((f - 0.25) * Math.PI * 2);
  }
  // Crepúsculo largo (~9° acima até ~11° abaixo): o céu leva tempo real para
  // largar as estrelas, e é justamente aí que um corte seco entrega o truque.
  return smoothstep(0.16, -0.19, elev);
}

// ═══════════════════════════════════════════════════════════════════════════
// Loop
// ═══════════════════════════════════════════════════════════════════════════

export function update(dt, ctx) {
  if (!S.group) return;

  S.uTime.value = ctx.time.elapsed;

  const density = atmosphereDensity(ctx);
  const night = nightFactor(ctx);
  S.density = density;
  S.night = night;

  // O céu diurno APAGA as estrelas: o brilho do espalhamento Rayleigh sobe
  // muito mais rápido que linearmente com a densidade × luz do sol, por isso o
  // expoente. À noite a atmosfera só as atenua um pouco (extinção). Em vácuo,
  // nada muda. A curva é contínua nos dois extremos — nada de corte.
  const dayWash = density * (1 - night);
  const target = saturate(Math.pow(1 - dayWash, 1.9) * (1 - density * 0.20));

  // Suavização temporal: garante continuidade mesmo quando outro módulo dá um
  // salto (teleporte do arnês de screenshots, troca de planeta ativo).
  const k = 1 - Math.exp(-dt * 5.0);
  S.fade += (target - S.fade) * (k > 0 ? k : 1);
  if (Math.abs(S.fade - target) < 1e-4) S.fade = target;
  S.uFade.value = S.fade;

  // Cintilação é turbulência de ar: no vácuo praticamente não existe.
  S.uTwinkle.value = 0.045 + density * 0.42;

  // Rede de segurança para quando o universo chega depois do nosso init ou
  // troca de sistema sem emitir evento. Comparação por IDENTIDADE do objeto:
  // varrer o catálogo atrás do observador todo frame custaria caro.
  const cur = ctx.universe?.current || ctx.system || null;
  if (cur !== S.observerSystem) reproject();

  if (ctx.debug?.enabled) {
    ctx.debug.set('starfield.fade', S.fade.toFixed(2));
    ctx.debug.set('starfield.atmo', density.toFixed(2) + ' noite ' + night.toFixed(2));
  }
}

export function resize(w, h, dpr) {
  // O tamanho do sprite é dado em pixels de tela; sem isto as estrelas mudam
  // de brilho aparente ao trocar de monitor ou de render scale.
  S.uPixelRatio.value = dpr || 1;
}

export function dispose(ctx) {
  if (!S.group) return;
  ctx.engine.farScene.remove(S.group);
  S.group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
  S.tex?.dispose();
  S.group = null;
  S.sphere = null;
  S.bgPoints = null;
  S.realPoints = null;
  S.tex = null;
  S.texData = null;
  S.flux = null;
  S.catPos = null;
  S.catLum = null;
  S.catalogFor = null;
}
