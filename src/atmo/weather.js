import * as THREE from 'three';
import { Noise, clamp, saturate, smoothstep } from '../noise/noise.js';
import { hexToLinear } from '../planet/biomes.js';

/**
 * CLIMA — módulo `weather` (order 42).
 *
 * ── O que este módulo é ────────────────────────────────────────────────────
 * Uma máquina de estados determinística sobre `biome.weather`, mais os efeitos
 * que tornam cada estado legível em UM olhar: precipitação, vento, névoa,
 * relâmpago e aurora. Tudo que outro sistema precisa saber sai por `ctx.weather`
 * (vento, umidade, intensidade) ou por evento — nenhum módulo importa este.
 *
 * ── Por que a precipitação é uma CAIXA que segue a câmera ──────────────────
 * Chuva "de verdade" seria um volume do tamanho do planeta. O olho, porém, só
 * resolve gotas até ~30 m; além disso vira uma névoa cinza (que é trabalho da
 * névoa aérea, não das partículas). Então mantemos ~2 mil pontos numa caixa de
 * 30 m centrada na câmera e embrulhamos as posições com `mod` DENTRO DO SHADER:
 * zero trabalho de CPU por frame, zero alocação, e a densidade aparente é
 * constante em qualquer velocidade.
 *
 * ── Por que os riscos são pontos e não geometria ───────────────────────────
 * Um `Points` custa um draw call e um vértice por gota. O risco alinhado à
 * velocidade relativa é desenhado DENTRO do sprite, a partir da direção da
 * velocidade projetada na tela (um `vec2` por frame). Quads instanciados
 * dariam o mesmo resultado por 4x o custo de vértice.
 *
 * ── Aurora ─────────────────────────────────────────────────────────────────
 * Duas cascas cilíndricas concêntricas ao EIXO DE ROTAÇÃO do corpo, num anel de
 * colatitude que desce em direção ao jogador durante a tempestade geomagnética
 * (é o que o oval auroral faz de verdade quando o índice Kp sobe — e é também o
 * que garante que o jogador consiga vê-la). Cada casca soma três camadas
 * defasadas de um ruído em banda: é um raymarch de três amostras, barato o
 * suficiente para caber no orçamento e o bastante para ler como volume.
 */

export const id = 'weather';
export const order = 42;

// ── Catálogo de estados ─────────────────────────────────────────────────────

/**
 * Cada estado declara o que os outros sistemas precisam ler. `precip`:
 * 0 nenhuma, 1 chuva, 2 neve, 3 poeira/cinza. `wet` é o alvo de umidade.
 */
const STATES = {
  clear:     { precip: 0, wet: 0.0, wind: [3, 9],   fog: 1.0,  cloud: 0.0,  anvil: 0, dur: [90, 260] },
  rain:      { precip: 1, wet: 1.0, wind: [8, 16],  fog: 1.9,  cloud: 0.22, anvil: 0.15, dur: [70, 190] },
  toxicRain: { precip: 1, wet: 0.9, wind: [8, 15],  fog: 2.4,  cloud: 0.26, anvil: 0.2, dur: [60, 150], damage: 2.6 },
  snow:      { precip: 2, wet: 0.3, wind: [4, 11],  fog: 2.1,  cloud: 0.24, anvil: 0, dur: [90, 220] },
  blizzard:  { precip: 2, wet: 0.5, wind: [22, 34], fog: 6.5,  cloud: 0.34, anvil: 0, dur: [50, 130], damage: 1.6 },
  fog:       { precip: 0, wet: 0.4, wind: [1, 4],   fog: 7.0,  cloud: 0.1,  anvil: 0, dur: [70, 180] },
  storm:     { precip: 1, wet: 1.0, wind: [18, 30], fog: 2.6,  cloud: 0.4,  anvil: 0.8, dur: [50, 140], bolts: 1 },
  firestorm: { precip: 3, wet: 0.0, wind: [20, 32], fog: 4.0,  cloud: 0.3,  anvil: 0.5, dur: [45, 110], damage: 3.4, bolts: 0.4 },
  dust:      { precip: 3, wet: 0.0, wind: [16, 28], fog: 5.0,  cloud: 0.05, anvil: 0, dur: [60, 170], damage: 0.6 },
  ionStorm:  { precip: 3, wet: 0.0, wind: [12, 24], fog: 2.2,  cloud: 0.18, anvil: 0.4, dur: [45, 120], damage: 1.2, bolts: 1.6, aurora: 0.6 },
  aurora:    { precip: 0, wet: 0.1, wind: [2, 7],   fog: 0.9,  cloud: -0.15, anvil: 0, dur: [110, 240], aurora: 1 },
};

/** Transição entre estados, em segundos. Nunca instantânea. */
const BLEND_TIME = 14;
/** Só começa a sortear clima depois disto — as capturas canônicas acontecem
 *  nos primeiros segundos e precisam de um céu estável e comparável. */
const FIRST_CHANGE = 55;

const RAIN_BOX = 30;
const SPLASH_RADIUS = 11;

// ── Escratch (zero alocação por frame) ──────────────────────────────────────

const _up = new THREE.Vector3(0, 1, 0);
const _east = new THREE.Vector3(1, 0, 0);
const _north = new THREE.Vector3(0, 0, 1);
const _axis = new THREE.Vector3(0, 1, 0);
const _pole = new THREE.Vector3(0, 1, 0);
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _center = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _q = new THREE.Quaternion();
const YAXIS = new THREE.Vector3(0, 1, 0);

const S = {
  ctx: null,
  ready: false,
  body: null,
  bodyId: null,
  pool: ['clear'],

  current: 'clear',
  previous: 'clear',
  blend: 1,            // 0 = ainda no anterior, 1 = totalmente no atual
  timeLeft: FIRST_CHANGE,
  seq: 0,
  intensity: 0,
  wetness: 0,

  windAngle: 0,
  windSpeed: 6,
  wind: new THREE.Vector3(1, 0, 0),
  gustPhase: 0,
  noise: null,

  precip: null,
  precipMat: null,
  splash: null,
  splashMat: null,
  auroraGroup: null,
  auroraMats: [],
  rainOffset: new THREE.Vector3(),
  particleTime: 0,

  light: null,
  flash: 0,
  boltTimer: 4,
  thunders: [],

  damageTimer: 0,
  sunElev: 1,
  inAtmo: false,
};

// ────────────────────────────────────────────────────────────────────────────
// Shaders
// ────────────────────────────────────────────────────────────────────────────

/**
 * NOTA CRÍTICA: o renderer liga `logarithmicDepthBuffer`. Todo shader próprio
 * que participe do teste de profundidade precisa de `#include <common>` ANTES
 * dos chunks logdepthbuf_* — é `common` que define `isPerspectiveMatrix()`.
 * Sem isso o programa não linka e o three cai num fallback que desenha lixo.
 */
const PRECIP_VERT = /* glsl */`
attribute vec3 aSeed;
uniform float uTime;
uniform float uBox;
uniform vec3 uOffset;
uniform float uSway;
uniform float uPx;
varying float vFade;
varying float vRand;
#include <common>
#include <logdepthbuf_pars_vertex>

void main() {
  vec3 p = position * uBox + uOffset;
  // Movimento browniano do floco: duas senoides desafinadas por partícula. O
  // termo vertical é pequeno de propósito — neve flutua, não sobe.
  p += uSway * vec3(
    sin(uTime * (0.6 + aSeed.x) + aSeed.y * 6.2832),
    sin(uTime * (0.31 + aSeed.y * 0.5) + aSeed.z * 6.2832) * 0.3,
    cos(uTime * (0.5 + aSeed.z) + aSeed.x * 6.2832));

  // Caixa centrada na câmera: mod() em GLSL devolve sempre positivo, então o
  // embrulho funciona para offsets negativos sem nenhum caso especial.
  p = mod(p + uBox * 0.5, uBox) - uBox * 0.5;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = max(-mv.z, 0.35);
  gl_PointSize = clamp(uPx / d, 1.5, 34.0);
  // Esfera dentro do cubo: sem isto as quinas da caixa aparecem como um
  // adensamento de gotas nas diagonais.
  vFade = (1.0 - smoothstep(uBox * 0.30, uBox * 0.5, length(p))) * smoothstep(0.35, 1.6, d);
  vRand = aSeed.x;
  #include <logdepthbuf_vertex>
}
`;

const PRECIP_FRAG = /* glsl */`
precision highp float;
uniform vec3 uColor;
uniform vec2 uStreak;
uniform float uLen;
uniform float uOpacity;
varying float vFade;
varying float vRand;
#include <common>
#include <logdepthbuf_pars_fragment>

void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  c.y = -c.y;
  // O rastro é desenhado DENTRO do sprite: distância à reta que passa pelo
  // centro na direção da velocidade relativa projetada na tela.
  float across = dot(c, vec2(-uStreak.y, uStreak.x));
  float along = dot(c, uStreak);
  float w = mix(0.62, 0.16, uLen);
  float a = (1.0 - smoothstep(0.0, w, abs(across)))
          * (1.0 - smoothstep(mix(0.45, 0.75, uLen), 1.0, abs(along)));
  a *= vFade * uOpacity * (0.6 + 0.4 * vRand);
  if (a < 0.008) discard;
  gl_FragColor = vec4(uColor, a);
  #include <logdepthbuf_fragment>
}
`;

const SPLASH_VERT = /* glsl */`
attribute vec3 aSeed;
uniform float uTime;
uniform float uRate;
uniform float uPx;
varying float vLife;
#include <common>
#include <logdepthbuf_pars_vertex>

void main() {
  float ph = fract(uTime * uRate + aSeed.x);
  vLife = ph;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(uPx * (0.35 + ph * 1.6) / max(-mv.z, 0.3), 1.0, 26.0);
  #include <logdepthbuf_vertex>
}
`;

const SPLASH_FRAG = /* glsl */`
precision highp float;
uniform vec3 uColor;
uniform float uOpacity;
varying float vLife;
#include <common>
#include <logdepthbuf_pars_fragment>

void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r = length(c);
  // Anel que abre e some: a coroa do respingo.
  float ring = (1.0 - smoothstep(0.0, 0.34, abs(r - 0.72)));
  float a = ring * (1.0 - vLife) * uOpacity;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor, a);
  #include <logdepthbuf_fragment>
}
`;

const AURORA_VERT = /* glsl */`
varying vec2 vUv;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

const AURORA_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform float uTime;
uniform float uIntensity;
uniform float uSeed;
uniform float uFolds;
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uColC;
#include <common>
#include <logdepthbuf_pars_fragment>

float h11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float n11(float x) {
  float i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(h11(i), h11(i + 1.0), f);
}
/** fBm 1D ao longo do anel: as dobras da cortina. */
float band(float x, float t) {
  return n11(x * 1.0 + t * 0.09 + uSeed) * 0.55
       + n11(x * 2.7 - t * 0.17 + uSeed) * 0.30
       + n11(x * 6.1 + t * 0.29) * 0.15;
}

void main() {
  float u = vUv.x * uFolds;
  // Raymarch de três amostras: cada camada é a mesma cortina deslocada em
  // profundidade aparente. Somadas, dão a translucidez em camadas da aurora
  // real sem marchar um volume.
  float acc = 0.0;
  for (int i = 0; i < 3; i++) {
    float o = float(i) * 0.41;
    float b = band(u + o, uTime + float(i) * 3.7);
    float w = smoothstep(0.52, 0.78, b) * (1.0 - smoothstep(0.80, 0.98, b));
    acc += w * (1.0 - float(i) * 0.26);
  }

  float h = vUv.y;
  // O verde do oxigênio a 557 nm domina a base; o vermelho/magenta a 630 nm só
  // aparece no topo rarefeito. Inverter isso é o que faz aurora falsa.
  vec3 col = mix(uColA, uColB, smoothstep(0.0, 0.5, h));
  col = mix(col, uColC, smoothstep(0.45, 1.0, h));
  float vert = smoothstep(0.0, 0.06, h) * (1.0 - smoothstep(0.30, 1.0, h));
  // Raios verticais finos, a estriação característica.
  float rays = 0.75 + 0.25 * n11(u * 9.0 + uSeed * 3.0);
  float a = acc * vert * rays * uIntensity;
  gl_FragColor = vec4(col * a, 1.0);
  #include <logdepthbuf_fragment>
}
`;

// ────────────────────────────────────────────────────────────────────────────
// Ciclo de vida
// ────────────────────────────────────────────────────────────────────────────

export async function init(ctx) {
  S.ctx = ctx;
  S.noise = new Noise(ctx.rng.derive('weather:field', 0).int(0xffffffff));

  buildPrecip(ctx);
  buildSplash(ctx);
  buildAurora(ctx);

  syncBody(ctx, true);
  S.ready = true;
  ctx.provide(id, api);
  ctx.progress?.(0.68, 'clima pronto');
}

function buildPrecip(ctx) {
  const q = ctx.quality?.preset || 'high';
  const count = q === 'low' ? 700 : q === 'medium' ? 1400 : 2400;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count * 3);
  const rng = ctx.rng.derive('weather:precip', 0);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = rng.float(); pos[i * 3 + 1] = rng.float(); pos[i * 3 + 2] = rng.float();
    seed[i * 3] = rng.float(); seed[i * 3 + 1] = rng.float(); seed[i * 3 + 2] = rng.float();
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
  // A caixa acompanha a câmera; o culling por bounding sphere descartaria tudo.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), RAIN_BOX);

  S.precipMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uBox: { value: RAIN_BOX },
      uOffset: { value: new THREE.Vector3() },
      uSway: { value: 0 },
      uPx: { value: 260 },
      uColor: { value: new THREE.Color(0.7, 0.8, 1.0) },
      uStreak: { value: new THREE.Vector2(0, 1) },
      uLen: { value: 1 },
      uOpacity: { value: 0 },
    },
    vertexShader: PRECIP_VERT,
    fragmentShader: PRECIP_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
    toneMapped: false,
    fog: false,
    lights: false,
  });

  S.precip = new THREE.Points(geo, S.precipMat);
  S.precip.name = 'weather:precip';
  S.precip.frustumCulled = false;
  // DEPOIS da composição das nuvens (1150): a gota está a 10 m da câmera e
  // não pode ser multiplicada pela transmitância de uma nuvem a 3 km.
  S.precip.renderOrder = 1165;
  S.precip.visible = false;
  ctx.engine.scene.add(S.precip);
}

function buildSplash(ctx) {
  const q = ctx.quality?.preset || 'high';
  const count = q === 'low' ? 90 : q === 'medium' ? 180 : 320;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count * 3);
  const rng = ctx.rng.derive('weather:splash', 0);
  for (let i = 0; i < count; i++) {
    // Disco de raio SPLASH_RADIUS com densidade uniforme (sqrt no raio).
    const a = rng.float() * Math.PI * 2;
    const r = Math.sqrt(rng.float()) * SPLASH_RADIUS;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = 0;
    pos[i * 3 + 2] = Math.sin(a) * r;
    seed[i * 3] = rng.float(); seed[i * 3 + 1] = rng.float(); seed[i * 3 + 2] = rng.float();
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), SPLASH_RADIUS * 1.2);

  S.splashMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uRate: { value: 1.6 },
      uPx: { value: 70 },
      uColor: { value: new THREE.Color(0.8, 0.9, 1.0) },
      uOpacity: { value: 0 },
    },
    vertexShader: SPLASH_VERT,
    fragmentShader: SPLASH_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
    toneMapped: false,
    fog: false,
    lights: false,
  });

  S.splash = new THREE.Points(geo, S.splashMat);
  S.splash.name = 'weather:splash';
  S.splash.frustumCulled = false;
  S.splash.renderOrder = 1160;
  S.splash.visible = false;
  ctx.engine.scene.add(S.splash);
}

function buildAurora(ctx) {
  S.auroraGroup = new THREE.Group();
  S.auroraGroup.name = 'weather:aurora';
  S.auroraGroup.visible = false;
  // Cilindro aberto e unitário: a escala por eixo faz o resto, então as duas
  // cascas compartilham a mesma geometria.
  const geo = new THREE.CylinderGeometry(1, 1, 1, 84, 1, true);
  for (let i = 0; i < 2; i++) {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: 0 },
        uSeed: { value: i * 17.3 },
        uFolds: { value: i === 0 ? 9 : 13 },
        uColA: { value: new THREE.Vector3(0.10, 1.0, 0.42) },
        uColB: { value: new THREE.Vector3(0.15, 0.85, 0.95) },
        uColC: { value: new THREE.Vector3(0.95, 0.25, 0.85) },
      },
      vertexShader: AURORA_VERT,
      fragmentShader: AURORA_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      fog: false,
      lights: false,
    });
    const m = new THREE.Mesh(geo, mat);
    m.renderOrder = 1155;   // acima das nuvens: a aurora está a 52 km
    m.frustumCulled = false;
    S.auroraMats.push(mat);
    S.auroraGroup.add(m);
  }
  ctx.engine.scene.add(S.auroraGroup);
}

// ────────────────────────────────────────────────────────────────────────────
// Máquina de estados
// ────────────────────────────────────────────────────────────────────────────

function syncBody(ctx, force) {
  const body = ctx.planet?.current || null;
  const bid = body ? (body.id ?? body.name ?? 'body') : null;
  if (!force && bid === S.bodyId) return;

  S.body = body;
  S.bodyId = bid;
  S.pool = (body?.biome?.weather && body.biome.weather.length) ? body.biome.weather.slice() : ['clear'];
  S.seq = 0;
  S.current = 'clear';
  S.previous = 'clear';
  S.blend = 1;
  S.intensity = 0;
  S.timeLeft = FIRST_CHANGE;

  // Eixo de rotação do corpo. A derivação é a MESMA do módulo `sky`
  // (`rng.derive('sky:body', seed)`), o que faz a aurora nascer no polo
  // geográfico de verdade sem que os módulos precisem se importar.
  const seed = (body?.seed ?? 0) | 0;
  const r = ctx.rng.derive('sky:body', seed);
  const t = r.range(-0.42, 0.42);
  const az = r.range(0, Math.PI * 2);
  _axis.set(Math.sin(t) * Math.cos(az), Math.cos(t), Math.sin(t) * Math.sin(az)).normalize();

  const wr = ctx.rng.derive('weather:wind', seed);
  S.windAngle = wr.range(0, Math.PI * 2);
  S.gustPhase = wr.range(0, 100);

  // Cor das gotas: puxa o matiz do bioma para que a chuva ácida seja verde e a
  // neve fique no azul do céu, sem nenhum caso especial no shader.
  const pal = body?.biome?.palette;
  if (pal) {
    const w = hexToLinear(pal.water ?? 0x88aaff);
    S.precipMat.uniforms.uColor.value.setRGB(
      0.45 + w[0] * 0.55, 0.55 + w[1] * 0.45, 0.7 + w[2] * 0.3);
  }
}

function pickNext(ctx) {
  // O índice mistura corpo e número da transição: a sequência de climas de um
  // planeta é sempre a mesma, e não depende da ordem em que você os visitou.
  const rng = ctx.rng.derive('weather:seq', (S.bodyId ? hash(String(S.bodyId)) : 0) ^ (S.seq * 2654435761));
  S.seq++;
  const pool = S.pool;
  // 'clear' pesa mais: um planeta em tempestade permanente cansa e mata o fps.
  const weights = pool.map((n) => (n === 'clear' ? 3.2 : n === S.current ? 0.25 : 1));
  const next = pool.length > 1 ? rng.pickWeighted(pool, weights) : pool[0];
  const def = STATES[next] || STATES.clear;
  S.previous = S.current;
  S.current = next;
  S.blend = 0;
  S.timeLeft = rng.range(def.dur[0], def.dur[1]);
  ctx.events.emit('weather:change', { state: next, previous: S.previous, planet: S.body });
  if (next !== 'clear') {
    ctx.events.emit('ui:notify', { text: LABEL[next] || next, kind: 'weather' });
  }
  ctx.events.emit('audio:cue', { name: 'weather:' + next, params: { intensity: 1 } });
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const LABEL = {
  rain: 'Chuva', toxicRain: 'Chuva ácida', snow: 'Neve', blizzard: 'Nevasca',
  fog: 'Névoa densa', storm: 'Tempestade', firestorm: 'Tempestade de fogo',
  dust: 'Tempestade de poeira', ionStorm: 'Tempestade iônica', aurora: 'Aurora',
};

/** Mistura um campo numérico entre o estado anterior e o atual. */
function field(key, dflt) {
  const a = STATES[S.previous] || STATES.clear;
  const b = STATES[S.current] || STATES.clear;
  const va = a[key] === undefined ? dflt : a[key];
  const vb = b[key] === undefined ? dflt : b[key];
  return va + (vb - va) * S.blend;
}

// ────────────────────────────────────────────────────────────────────────────
// Update
// ────────────────────────────────────────────────────────────────────────────

export function update(dt, ctx) {
  if (!S.ready) return;
  syncBody(ctx, false);

  const body = S.body;
  S.inAtmo = !!body && (ctx.player.inAtmosphere || ctx.sky?.inAtmosphere || false);

  // ── Relógio da máquina de estados ────────────────────────────────────────
  if (body) {
    S.timeLeft -= dt;
    if (S.timeLeft <= 0) pickNext(ctx);
    if (S.blend < 1) S.blend = Math.min(1, S.blend + dt / BLEND_TIME);
  }

  // Intensidade: sobe com o estado ativo e some fora da atmosfera (no espaço
  // não há clima, mas o estado continua correndo para quem pousar de novo).
  const target = S.current === 'clear' ? 0 : 1;
  const atmoK = S.inAtmo ? 1 : 0;
  S.intensity += (target * atmoK - S.intensity) * Math.min(1, dt / 3);

  // ── Referencial local ────────────────────────────────────────────────────
  if (body) {
    _up.set(
      ctx.player.position.x - body.center.x,
      ctx.player.position.y - body.center.y,
      ctx.player.position.z - body.center.z,
    );
    const r = _up.length();
    if (r > 1e-6) _up.multiplyScalar(1 / r); else _up.set(0, 1, 0);
  } else {
    _up.copy(ctx.player.up);
  }
  _v1.set(Math.abs(_up.y) > 0.92 ? 1 : 0, Math.abs(_up.y) > 0.92 ? 0 : 1, 0);
  _east.crossVectors(_v1, _up).normalize();
  _north.crossVectors(_up, _east).normalize();

  updateWind(dt, ctx);
  updateWetness(dt);
  updateFog(ctx);
  updateHazard(dt, ctx);
  updateLightning(dt, ctx);

  // Elevação solar: a aurora e os respingos precisam saber se é noite.
  const sun = ctx.sky?.sunDirection;
  S.sunElev = sun ? sun.dot(_up) : 1;

  if (ctx.debug.enabled) {
    ctx.debug.set('clima', `${S.current} i=${S.intensity.toFixed(2)} `
      + `vento ${S.windSpeed.toFixed(1)} m/s umid ${S.wetness.toFixed(2)} `
      + `→${Math.round(S.timeLeft)}s`);
  }
}

/**
 * Vento: direção coerente que passeia devagar (fBm no tempo) somada a rajadas
 * que variam no ESPAÇO — é a variação espacial que faz a grama ondular em
 * ondas em vez de tremer em bloco.
 */
function updateWind(dt, ctx) {
  // `wind` é um par [min,max] por estado, então não passa por field().
  const a = STATES[S.previous] || STATES.clear;
  const b = STATES[S.current] || STATES.clear;
  const wa = (a.wind[0] + a.wind[1]) * 0.5;
  const wb = (b.wind[0] + b.wind[1]) * 0.5;
  const baseSpeed = wa + (wb - wa) * S.blend;

  S.gustPhase += dt * 0.15;
  // Deriva angular lenta: o vento gira alguns graus por minuto.
  S.windAngle += S.noise.noise3(S.gustPhase * 0.35, 11.7, 3.1) * dt * 0.06;
  const gust = 1 + 0.35 * S.noise.noise3(S.gustPhase, 0.3, 7.7);
  S.windSpeed = Math.max(0.2, baseSpeed * gust);

  S.wind.copy(_east).multiplyScalar(Math.cos(S.windAngle))
    .addScaledVector(_north, Math.sin(S.windAngle))
    .multiplyScalar(S.windSpeed);
}

function updateWetness(dt) {
  const wet = field('wet', 0);
  const rate = wet > S.wetness ? 0.06 : 0.02;   // seca mais devagar do que molha
  S.wetness += (wet * S.intensity - S.wetness) * Math.min(1, dt * rate * 4);
  S.wetness = saturate(S.wetness);
}

/**
 * Névoa: multiplica o que o módulo `sky` acabou de escrever (order 40 roda
 * antes de 42). Multiplicar em vez de somar preserva o decaimento com a
 * altitude que o `sky` já calculou.
 */
function updateFog(ctx) {
  const fu = ctx.planet?.fogUniforms;
  if (!fu || !fu.uFogDensity) return;
  const k = 1 + (field('fog', 1) - 1) * S.intensity;
  const v = fu.uFogDensity.value;
  if (typeof v === 'number') fu.uFogDensity.value = v * k;
}

/** Dano ambiental de chuva ácida, nevasca e tempestade de fogo. */
function updateHazard(dt, ctx) {
  const dmg = field('damage', 0) * S.intensity;
  if (dmg <= 0.05 || !S.inAtmo) return;
  // Só machuca quem está exposto: alto no céu a nave protege.
  const alt = ctx.player.altitude;
  if (Number.isFinite(alt) && alt > 250) return;
  S.damageTimer -= dt;
  if (S.damageTimer > 0) return;
  S.damageTimer = 1;
  ctx.events.emit('player:damage', { amount: dmg, source: S.current });
}

/**
 * Relâmpago. O clarão é uma luz de verdade na cena (o terreno reage), com
 * envelope de dois pulsos — um único degrau parece um bug de exposição. O
 * trovão sai atrasado pela distância: 343 m/s é a pista que o jogador usa
 * inconscientemente para medir o tamanho do mundo.
 */
function updateLightning(dt, ctx) {
  const bolts = field('bolts', 0) * S.intensity;

  if (S.flash > 0) {
    S.flash = Math.max(0, S.flash - dt * 3.2);
    if (S.light) {
      const f = S.flash;
      // Dois pulsos: o segundo é o "retorno" do canal principal.
      const env = Math.max(f * f, Math.sin(f * 9.0) * 0.35 * f);
      // decay = 0: o clarão não cai com a distância, como um céu inteiro que
      // acende. A escala é comparável à do sol (≈3.6) por isso o valor é baixo.
      S.light.intensity = env * 8.0;
    }
  } else if (S.light && S.light.intensity !== 0) {
    S.light.intensity = 0;
  }

  for (let i = S.thunders.length - 1; i >= 0; i--) {
    const th = S.thunders[i];
    th.t -= dt;
    if (th.t <= 0) {
      ctx.events.emit('audio:cue', { name: 'thunder', params: { distance: th.d, gain: th.g } });
      S.thunders.splice(i, 1);
    }
  }

  if (bolts <= 0.02 || !S.inAtmo) return;
  S.boltTimer -= dt * bolts;
  if (S.boltTimer > 0) return;
  const rng = ctx.rng.derive('weather:bolt', (ctx.time.frames * 2654435761) >>> 0);
  S.boltTimer = rng.range(2.5, 11);

  const dist = rng.range(1200, 14000);
  const az = rng.range(0, Math.PI * 2);
  const alt = (S.body?.biome?.sky?.cloudAltitude || 2000) * 0.9;

  if (!S.light) {
    // Criada apenas quando a primeira tempestade acontece: uma luz a mais na
    // cena recompila TODOS os materiais, e num planeta sem tempestade esse
    // custo nunca precisa ser pago.
    S.light = new THREE.PointLight(0xdfe8ff, 0, 0, 0);
    S.light.name = 'weather:bolt';
    S.light.castShadow = false;
    ctx.engine.scene.add(S.light);
  }
  _v1.copy(_east).multiplyScalar(Math.cos(az) * dist)
    .addScaledVector(_north, Math.sin(az) * dist)
    .addScaledVector(_up, alt);
  S.light.position.copy(ctx.engine.camera.position).add(_v1);
  S.flash = 1;

  S.thunders.push({ t: dist / 343, d: dist, g: clamp(1 - dist / 16000, 0.1, 1) });
  ctx.events.emit('audio:cue', { name: 'lightning', params: { distance: dist } });
}

// ────────────────────────────────────────────────────────────────────────────
// lateUpdate: tudo que é posição relativa à origem flutuante
// ────────────────────────────────────────────────────────────────────────────

export function lateUpdate(dt, ctx) {
  if (!S.ready) return;
  try {
    S.particleTime = (S.particleTime + dt) % 1000;
    updatePrecip(dt, ctx);
    updateSplash(ctx);
    updateAurora(dt, ctx);
  } catch (e) {
    ctx.debug?.set?.('clima.erro', (e && e.message) || String(e));
  }
}

/**
 * Escolhe o tipo de precipitação na transição. Interpolar o ÍNDICE do tipo
 * (chuva=1, neve=2) daria "1,5", que não existe — então quem interpola é a
 * OPACIDADE, e o tipo troca de uma vez no meio da mistura.
 */
function precipBlend() {
  const pa = (STATES[S.previous] || STATES.clear).precip;
  const pb = (STATES[S.current] || STATES.clear).precip;
  if (pa > 0 && pb > 0) return { mode: S.blend < 0.5 ? pa : pb, k: 1 };
  if (pb > 0) return { mode: pb, k: S.blend };
  if (pa > 0) return { mode: pa, k: 1 - S.blend };
  return { mode: 0, k: 0 };
}

function updatePrecip(dt, ctx) {
  const pb = precipBlend();
  const mode = pb.mode;
  const amount = S.intensity * pb.k;
  const on = amount > 0.03 && mode > 0 && S.inAtmo;
  S.precip.visible = on;
  if (!on) return;

  const u = S.precipMat.uniforms;
  const cam = ctx.engine.camera;
  S.precip.position.copy(cam.position);

  // Velocidade da partícula no mundo: queda + vento − movimento do jogador.
  const fall = mode === 2 ? 2.2 : mode === 3 ? 1.0 : 16.0;
  _vel.copy(_up).multiplyScalar(-fall).add(S.wind);
  const pv = ctx.player.velocity;
  // A velocidade relativa é o que define o rastro; limitada para que a 300 m/s
  // as gotas não virem linhas de tela inteira.
  _v2.set(pv.x, pv.y, pv.z);
  if (_v2.lengthSq() > 3600) _v2.setLength(60);
  _vel.sub(_v2);

  S.rainOffset.addScaledVector(_vel, dt);
  S.rainOffset.x %= RAIN_BOX; S.rainOffset.y %= RAIN_BOX; S.rainOffset.z %= RAIN_BOX;
  u.uOffset.value.copy(S.rainOffset);
  u.uTime.value = S.particleTime;
  u.uSway.value = mode === 2 ? 0.9 : mode === 3 ? 0.5 : 0.05;
  u.uLen.value = mode === 1 ? 1 : mode === 2 ? 0.05 : 0.25;
  u.uPx.value = mode === 1 ? 300 : mode === 2 ? 150 : 120;
  u.uOpacity.value = amount * (mode === 1 ? 0.55 : mode === 2 ? 0.85 : 0.45);

  if (mode === 3) {
    // Poeira/cinza toma a cor do chão, não da água.
    const pal = S.body?.biome?.palette;
    const c = hexToLinear(pal?.sand ?? 0xa08060);
    u.uColor.value.setRGB(0.3 + c[0], 0.25 + c[1] * 0.9, 0.2 + c[2] * 0.8);
  } else if (mode === 2) {
    u.uColor.value.setRGB(0.9, 0.95, 1.0);
  } else {
    const pal = S.body?.biome?.palette;
    const w = hexToLinear(pal?.water ?? 0x88aaff);
    // Chuva ácida usa o acento do bioma: é o sinal visual do dano.
    const acid = S.current === 'toxicRain' ? hexToLinear(pal?.accent ?? 0xa0ff30) : null;
    if (acid) u.uColor.value.setRGB(acid[0] * 0.8 + 0.2, acid[1] * 0.8 + 0.2, acid[2] * 0.6 + 0.15);
    else u.uColor.value.setRGB(0.45 + w[0] * 0.5, 0.55 + w[1] * 0.45, 0.72 + w[2] * 0.28);
  }

  // Direção do rastro na tela: velocidade relativa em espaço de olho.
  _v1.copy(_vel).transformDirection(cam.matrixWorldInverse);
  const l = Math.hypot(_v1.x, _v1.y);
  if (l > 1e-3) u.uStreak.value.set(_v1.x / l, _v1.y / l);
  else u.uStreak.value.set(0, 1);
}

function updateSplash(ctx) {
  const { mode, k } = precipBlend();
  const alt = ctx.player.altitude;
  const on = S.precip.visible && mode === 1 && Number.isFinite(alt) && alt < 12;
  S.splash.visible = on;
  if (!on) return;

  // Plano tangente no chão sob o jogador.
  _v1.copy(ctx.engine.camera.position).addScaledVector(_up, -Math.max(0, alt) + 0.05);
  S.splash.position.copy(_v1);
  _q.setFromUnitVectors(YAXIS, _up);
  S.splash.quaternion.copy(_q);

  const u = S.splashMat.uniforms;
  u.uTime.value = S.particleTime;
  u.uOpacity.value = S.intensity * k * 0.5;
  u.uColor.value.copy(S.precipMat.uniforms.uColor.value);
}

/**
 * Aurora. Só à noite e só quando o estado pede. As cortinas ficam num anel de
 * colatitude ao redor do eixo do corpo — mas o anel DESCE em direção ao
 * observador conforme a tempestade aperta, exatamente como o oval auroral real
 * se expande com o índice geomagnético. Sem isso o jogador quase nunca veria.
 */
function updateAurora(dt, ctx) {
  const want = field('aurora', 0);
  const night = smoothstep(0.06, -0.16, S.sunElev);
  const amt = want * S.intensity * night * (S.inAtmo ? 1 : 0.35);
  const on = amt > 0.01 && !!S.body;
  S.auroraGroup.visible = on;
  if (!on) return;

  const body = S.body;
  ctx.frame.toLocal(body.center, _center);

  // Hemisfério do observador: a cortina nasce no polo mais próximo.
  const sign = _up.dot(_axis) >= 0 ? 1 : -1;
  _pole.copy(_axis).multiplyScalar(sign);
  const colat = Math.acos(clamp(_up.dot(_pole), -1, 1));
  // Desce até ~18° acima do observador; nunca abaixo de 8° do polo.
  const theta = clamp(colat - 0.32, 0.14, 1.1);

  const Ra = body.radius + 52000;
  const Hc = 34000;
  const sinT = Math.sin(theta), cosT = Math.cos(theta);

  for (let i = 0; i < S.auroraGroup.children.length; i++) {
    const m = S.auroraGroup.children[i];
    const k = 1 + i * 0.055;
    m.scale.set(Ra * sinT * k, Hc, Ra * sinT * k);
    _v1.copy(_pole).multiplyScalar(Ra * cosT + Hc * 0.5).add(_center);
    m.position.copy(_v1);
    m.quaternion.setFromUnitVectors(YAXIS, _pole);
    const u = S.auroraMats[i].uniforms;
    u.uTime.value += dt * (0.5 + i * 0.25);
    u.uIntensity.value = amt * (i === 0 ? 1.6 : 0.9);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// API pública
// ────────────────────────────────────────────────────────────────────────────

const _windOut = new THREE.Vector3();

const api = {
  /** Nome do estado atual (chave de STATES). */
  get current() { return S.current; },
  get previous() { return S.previous; },
  /** 0-1: quanto do efeito está de fato acontecendo agora. */
  get intensity() { return S.intensity; },
  /** 0-1: molhado do mundo. Água e terreno usam para escurecer/brilhar. */
  get wetness() { return S.wetness; },
  /** Vetor de vento em m/s (mundo). Magnitude = velocidade. */
  get wind() { return S.wind; },
  get windSpeed() { return S.windSpeed; },
  /** Cobertura extra de nuvem pedida pelo clima (o módulo `clouds` soma). */
  get cloudBoost() { return field('cloud', 0) * S.intensity; },
  /** Empurra o topo dos cúmulos: bigorna de tempestade. */
  get anvil() { return field('anvil', 0) * S.intensity; },
  /** Multiplicador de densidade de névoa já aplicado ao terreno. */
  get fogFactor() { return 1 + (field('fog', 1) - 1) * S.intensity; },
  /** 0-1 durante o clarão do relâmpago — o HUD pode piscar junto. */
  get flash() { return S.flash; },
  get states() { return Object.keys(STATES); },
  get available() { return S.pool.slice(); },
  get secondsLeft() { return S.timeLeft; },

  /**
   * Vento numa posição de mundo. Aceita Vec3d ou Vector3. As rajadas variam no
   * espaço numa escala de ~400 m: é o que a flora consome para ondular em ondas.
   */
  windAt(pos, out) {
    const o = out || _windOut;
    o.copy(S.wind);
    if (!pos || !S.noise) return o;
    const g = 1 + 0.5 * S.noise.fbm(
      pos.x * 0.0025, pos.y * 0.0025, pos.z * 0.0025 + S.gustPhase * 0.2, 3);
    return o.multiplyScalar(Math.max(0.15, g));
  },

  /** Força um estado (debug, missões, o arnês de captura). */
  setState(name, immediate = false) {
    if (!STATES[name]) return false;
    S.previous = immediate ? name : S.current;
    S.current = name;
    S.blend = immediate ? 1 : 0;
    if (immediate) S.intensity = name === 'clear' ? 0 : 1;
    const def = STATES[name];
    S.timeLeft = (def.dur[0] + def.dur[1]) * 0.5;
    S.ctx?.events.emit('weather:change', { state: name, previous: S.previous, planet: S.body });
    return true;
  },
};

export function dispose(ctx) {
  if (S.precip) { ctx.engine.scene.remove(S.precip); S.precip.geometry.dispose(); }
  if (S.splash) { ctx.engine.scene.remove(S.splash); S.splash.geometry.dispose(); }
  if (S.auroraGroup) {
    ctx.engine.scene.remove(S.auroraGroup);
    S.auroraGroup.children[0]?.geometry?.dispose();
  }
  if (S.light) ctx.engine.scene.remove(S.light);
  S.precipMat?.dispose(); S.splashMat?.dispose();
  for (const m of S.auroraMats) m.dispose();
  S.ready = false;
}
