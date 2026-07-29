import * as THREE from 'three';
import { Vec3d } from '../core/frame.js';
import { Noise } from '../noise/noise.js';
import { hash3f } from '../core/rng.js';

/**
 * COMBATE ESPACIAL — cinturões navegáveis, piratas e armas.
 *
 * Três subsistemas que compartilham o mesmo pool de efeitos:
 *
 *  1. CAMPO DE ASTEROIDES. Rochas procedurais (4 variantes × 3 LODs) semeadas
 *     por uma grade espacial determinística dentro dos cinturões do sistema.
 *     POR QUÊ grade e não lista: o cinturão tem bilhões de metros de raio; só
 *     existe o que está a ~3,5 km do jogador, e isso tem de ser reconstruível
 *     a partir do índice da célula, sem estado persistente e sem alocação.
 *
 *  2. NAVES HOSTIS. Modelo próprio (fuselagem angular, vermelho/preto) e IA de
 *     dogfight com perseguição por antecipação, quebra de ataque, esquiva sob
 *     mira e formação de esquadrão.
 *
 *  3. ARMAS E EFEITOS. Canhão de fótons e mísseis rastreadores, tudo em pools
 *     pré-alocados. Escudo com onda hexagonal (ShaderMaterial próprio, com os
 *     chunks de log depth) e explosão em camadas: clarão HDR, casca de choque,
 *     detritos instanciados e fumaça persistente.
 *
 * ── Precisão ───────────────────────────────────────────────────────────────
 * TUDO que tem posição de mundo guarda `Vec3d` (float64). Os Object3D recebem
 * apenas coordenadas relativas, escritas em `lateUpdate` (depois do rebase) e
 * de novo no evento 'frame:rebase'.
 *
 * ── Custo ──────────────────────────────────────────────────────────────────
 * A lógica pesada só roda no espaço. Na atmosfera/superfície o módulo
 * desmonta o campo, esconde os grupos e devolve o frame — o combate de
 * superfície é dos sentinelas, não daqui.
 */

export const id = 'combat';
export const order = 55;

// ── Constantes de projeto (metros, segundos) ────────────────────────────────
const AST_CELL = 1400;             // aresta da célula de semeadura
const AST_CELL_R = 2;              // raio em células → ~3,5 km de campo vivo
const AST_KEEP = AST_CELL * (AST_CELL_R + 1.15);
const MAX_AST = 192;

const MAX_PROJ = 224;
const MAX_MISSILE = 14;
const MAX_DEBRIS = 224;
const MAX_GLOW = 288;              // clarões, faíscas e fumaça (billboards)
const MAX_RING = 24;               // cascas de choque
const MAX_SHIPS = 10;

const PHOTON_SPEED = 940, PHOTON_LIFE = 3.1, PHOTON_DMG = 13, PHOTON_CD = 0.115;
const EPHOTON_SPEED = 700, EPHOTON_LIFE = 3.4, EPHOTON_DMG = 8.5;
const MISSILE_SPEED = 430, MISSILE_LIFE = 9, MISSILE_DMG = 78, MISSILE_CD = 2.6;

const LOCK_RANGE = 3400, LOCK_CONE = 0.90, LOCK_TIME = 0.65;
const PLAYER_HULL_R = 12;

const SPACE_MIN_ALT = 8000;        // abaixo disso considera-se atmosfera/solo
const WAVE_INTERVAL = 78;          // segundos de espaço entre esquadrões

// Recursos que uma rocha pode conter. O peso favorece o comum.
const ORES = ['Ferrite', 'Silicato', 'Cobre', 'Cádmio', 'Emeril', 'Platina'];
const ORE_W = [0.42, 0.24, 0.14, 0.10, 0.06, 0.04];

// Quatro arquétipos de rocha: batata, lasca, bloco craterado e cristal.
const AST_VARIANTS = [
  { oct: 4, amp: 0.30, ridge: 0.00, crater: 0.55, sx: 1.00, sy: 0.92, sz: 1.06, tint: [0.30, 0.27, 0.24] },
  { oct: 5, amp: 0.46, ridge: 0.55, crater: 0.10, sx: 0.72, sy: 0.70, sz: 1.75, tint: [0.26, 0.24, 0.26] },
  { oct: 3, amp: 0.20, ridge: 0.18, crater: 0.85, sx: 1.10, sy: 1.02, sz: 0.94, tint: [0.34, 0.31, 0.27] },
  { oct: 5, amp: 0.44, ridge: 0.86, crater: 0.05, sx: 0.94, sy: 1.28, sz: 0.92, tint: [0.24, 0.26, 0.32] },
];
const AST_LOD = [3, 2, 1];

// ── Estado do módulo ────────────────────────────────────────────────────────
const S = {
  ctx: null,
  ready: false,
  enabled: true,
  inSpace: false,
  spaceTime: 0,
  waveTimer: WAVE_INTERVAL * 0.45,
  waveIndex: 0,

  root: null,          // grupo de tudo que é combate (fica na origem local)
  astMeshes: null,     // [variante][lod] InstancedMesh
  astCount: null,      // contadores por frame
  asteroids: [],
  cells: new Map(),    // chave da célula → nº de rochas vivas nela
  scanKey: -1, scanIdx: 0,

  projMesh: null, projectiles: [],
  debrisMesh: null, debris: [],
  glowMesh: null, glows: [],
  ringMesh: null, rings: [],
  missiles: [],
  ships: [],
  squads: [],
  lights: [],

  playerShield: null,
  playerImpacts: null,
  playerShieldT: 0,

  target: null,
  lockT: 0,
  locked: false,
  fireCd: 0,
  missileCd: 0,

  noise: null,
  hostileGeo: null,    // [{hull, glow, len, r}]
  shieldProto: null,
  boltGeo: null,
  debrisGeo: null,
  quadGeo: null,
  texGlow: null,
  texRing: null,
  matHull: null,
  matGlowShip: null,
  matAst: null,
};

// ── Temporários (zero alocação por frame) ───────────────────────────────────
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _scl = new THREE.Vector3(1, 1, 1);
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m4 = new THREE.Matrix4();
const _col = new THREE.Color();
const _d1 = new Vec3d();
const _d2 = new Vec3d();
const _d3 = new Vec3d();
const UNIT_Z = new THREE.Vector3(0, 0, 1);

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (dt, k) => 1 - Math.exp(-k * dt);

/* ==========================================================================
   1. GEOMETRIA PROCEDURAL
   ========================================================================== */

/** Acumulador de triângulos com cor por vértice — usado só na inicialização. */
class GeoBuilder {
  constructor() { this.p = []; this.c = []; }
  vert(v, col) { this.p.push(v[0], v[1], v[2]); this.c.push(col[0], col[1], col[2]); }
  tri(a, b, c, col) { this.vert(a, col); this.vert(b, col); this.vert(c, col); }
  quad(a, b, c, d, col) { this.tri(a, b, c, col); this.tri(a, c, d, col); }
  /** Tampa em leque a partir do centroide do anel. */
  cap(ring, col, flip) {
    const n = ring.length;
    const cx = [0, 0, 0];
    for (let i = 0; i < n; i++) { cx[0] += ring[i][0] / n; cx[1] += ring[i][1] / n; cx[2] += ring[i][2] / n; }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (flip) this.tri(cx, ring[j], ring[i], col);
      else this.tri(cx, ring[i], ring[j], col);
    }
  }
  get isEmpty() { return this.p.length === 0; }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

/** Anel poligonal em Z, com raio modulado para dar aresta dura à fuselagem. */
function ringPts(z, w, h, n, yOff, bulge) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + Math.PI / n;
    const k = 1 + bulge * Math.cos(3 * a);
    out[i] = [Math.cos(a) * w * k, Math.sin(a) * h * k + yOff, z];
  }
  return out;
}

function loft(gb, r0, r1, col) {
  const n = r0.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    gb.quad(r0[i], r1[i], r1[j], r0[j], col);
  }
}

/**
 * Rocha: icosaedro deslocado por fBm + crateras subtrativas.
 * A geometria é NÃO indexada, então `computeVertexNormals` deixa as faces
 * chapadas — é o visual de rocha low-poly que lê bem contra o preto do espaço.
 */
function makeAsteroidGeometry(v, detail, noise) {
  const geo = new THREE.IcosahedronGeometry(1, detail);
  const pos = geo.attributes.position;
  const n = pos.count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    _v1.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();
    let d = noise.fbm(_v1.x * 1.7, _v1.y * 1.7, _v1.z * 1.7, v.oct, 2.05, 0.5);
    if (v.ridge > 0) {
      const r = noise.ridged(_v1.x * 2.4 + 11, _v1.y * 2.4, _v1.z * 2.4, 4, 2.1, 0.5, 1.6);
      d = d * (1 - v.ridge) + (r * 2 - 1) * v.ridge;
    }
    // Crateras: um segundo campo em frequência baixa cava calotas onde passa
    // do limiar. É o que separa "batata de ruído" de "rocha de cinturão".
    if (v.crater > 0) {
      const c = noise.fbm(_v1.x * 3.3 - 7, _v1.y * 3.3 + 4, _v1.z * 3.3, 2, 2.2, 0.5);
      if (c > 0.34) d -= (c - 0.34) * 1.9 * v.crater;
    }
    const rr = Math.max(0.42, 1 + d * v.amp);
    pos.setXYZ(i, _v1.x * rr * v.sx, _v1.y * rr * v.sy, _v1.z * rr * v.sz);
    // Cor: fendas escurecem, cristas clareiam e veios minerais tingem de azul.
    const shade = clamp(0.62 + d * 0.75, 0.28, 1.35);
    const vein = clamp((noise.noise3(_v1.x * 6.1, _v1.y * 6.1, _v1.z * 6.1) - 0.45) * 2.6, 0, 1);
    colors[i * 3] = v.tint[0] * shade * (1 - vein * 0.5) + vein * 0.10;
    colors[i * 3 + 1] = v.tint[1] * shade * (1 - vein * 0.3) + vein * 0.22;
    colors[i * 3 + 2] = v.tint[2] * shade * (1 - vein * 0.1) + vein * 0.36;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Nave hostil: fuselagem angular em lofting, asas em cunha invertida e bocais
 * de motor incandescentes. Vermelho/preto — a leitura de "isso vai atirar em
 * mim" precisa acontecer antes do primeiro tiro.
 */
function makeHostileShip(rng, tier) {
  const gb = new GeoBuilder();
  const gl = new GeoBuilder();
  const dark = [0.055, 0.045, 0.045];
  const panel = [0.10, 0.085, 0.082];
  const trim = [0.34, 0.035, 0.035];
  const glass = [0.02, 0.015, 0.03];
  const hot = [3.6, 0.42, 0.22];
  const hot2 = [2.2, 0.16, 0.10];

  const len = rng.range(13, 19) * (tier === 2 ? 1.35 : 1);
  const w = len * rng.range(0.17, 0.24);
  const h = w * rng.range(0.62, 0.82);
  const n = 6;

  // Seções da fuselagem: bico afilado, ombro largo, cauda estreita.
  const zs = [-0.50, -0.28, -0.05, 0.18, 0.42, 0.50];
  const ws = [0.10, 0.62, 1.00, 0.88, 0.52, 0.44];
  const hs = [0.08, 0.55, 0.95, 0.86, 0.60, 0.52];
  const rings = [];
  for (let i = 0; i < zs.length; i++) {
    rings.push(ringPts(zs[i] * len, ws[i] * w, hs[i] * h, n, 0, 0.22));
  }
  const nose = [[0, 0, -0.60 * len]];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    gb.tri(nose[0], rings[0][i], rings[0][j], dark);
  }
  for (let i = 0; i < rings.length - 1; i++) {
    loft(gb, rings[i], rings[i + 1], i === 1 ? panel : dark);
  }
  gb.cap(rings[rings.length - 1], panel, true);

  // Faixa de guerra: duas listras vermelhas ao longo do dorso.
  for (let s = -1; s <= 1; s += 2) {
    const x0 = s * w * 0.26, x1 = s * w * 0.44;
    const y = h * 0.72;
    gb.quad(
      [x0, y, -0.30 * len], [x1, y * 0.82, -0.30 * len],
      [x1, y * 0.82, 0.18 * len], [x0, y, 0.18 * len], trim,
    );
  }

  // Canopy escuro e afundado — o "olho" da nave.
  gb.quad(
    [-w * 0.30, h * 0.70, -0.30 * len], [w * 0.30, h * 0.70, -0.30 * len],
    [w * 0.22, h * 0.86, -0.06 * len], [-w * 0.22, h * 0.86, -0.06 * len], glass,
  );

  // Asas em cunha, inclinadas para trás e para baixo (silhueta de predador).
  const span = len * rng.range(0.42, 0.58);
  const sweep = len * rng.range(0.16, 0.30);
  const thick = h * 0.30;
  for (let s = -1; s <= 1; s += 2) {
    const root0 = [s * w * 0.75, -h * 0.05, -0.10 * len];
    const root1 = [s * w * 0.75, -h * 0.05, 0.34 * len];
    const tipF = [s * (w * 0.75 + span), -h * 0.55, -0.10 * len + sweep];
    const tipB = [s * (w * 0.75 + span * 0.86), -h * 0.55, 0.36 * len];
    const up = thick * 0.5, dn = -thick * 0.5;
    const A = [root0[0], root0[1] + up, root0[2]];
    const B = [root1[0], root1[1] + up, root1[2]];
    const C = [tipB[0], tipB[1] + up * 0.4, tipB[2]];
    const D = [tipF[0], tipF[1] + up * 0.4, tipF[2]];
    const A2 = [root0[0], root0[1] + dn, root0[2]];
    const B2 = [root1[0], root1[1] + dn, root1[2]];
    const C2 = [tipB[0], tipB[1] + dn * 0.4, tipB[2]];
    const D2 = [tipF[0], tipF[1] + dn * 0.4, tipF[2]];
    gb.quad(A, B, C, D, panel);
    gb.quad(D2, C2, B2, A2, panel);
    gb.quad(A2, B2, B, A, dark);
    gb.quad(D, C, C2, D2, trim);
    gb.quad(A, D, D2, A2, dark);
    gb.quad(C, B, B2, C2, dark);
    // Bocal de arma na ponta da asa: onde os fótons nascem.
    gl.quad(
      [D[0] - s * 0.6, D[1] - 0.3, D[2] - 0.9], [D[0] + s * 0.6, D[1] - 0.3, D[2] - 0.9],
      [D[0] + s * 0.6, D[1] + 0.3, D[2] - 0.9], [D[0] - s * 0.6, D[1] + 0.3, D[2] - 0.9], hot2,
    );
  }

  // Bocais de motor: discos quentes na traseira.
  const eng = rng.chance(0.5) ? 2 : 3;
  for (let e = 0; e < eng; e++) {
    const ex = eng === 2 ? (e === 0 ? -w * 0.45 : w * 0.45) : (e - 1) * w * 0.52;
    const r0 = ringPts(0.52 * len, w * 0.22, h * 0.22, 6, 0, 0);
    const r1 = ringPts(0.58 * len, w * 0.15, h * 0.15, 6, 0, 0);
    for (const p of r0) p[0] += ex;
    for (const p of r1) p[0] += ex;
    loft(gb, r0, r1, dark);
    gl.cap(r1, hot, true);
  }

  const hull = gb.build();
  const glow = gl.isEmpty ? null : gl.build();
  return { hull, glow, length: len, radius: Math.max(w, h) + span * 0.5 };
}

/** Projétil: prisma afilado com a cor caindo para a cauda — o rastro é a malha. */
function makeBoltGeometry() {
  const gb = new GeoBuilder();
  const n = 4;
  const tail = ringPts(0, 0.22, 0.22, n, 0, 0);
  const mid = ringPts(0.74, 0.85, 0.85, n, 0, 0);
  const head = ringPts(0.94, 0.55, 0.55, n, 0, 0);
  const apex = [0, 0, 1.06];
  const cTail = [0.02, 0.02, 0.02];
  const cMid = [0.55, 0.55, 0.55];
  const cHead = [1.6, 1.6, 1.6];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    // Interpola a cor manualmente: cada anel entra com a sua.
    gb.vert(tail[i], cTail); gb.vert(mid[i], cMid); gb.vert(mid[j], cMid);
    gb.vert(tail[i], cTail); gb.vert(mid[j], cMid); gb.vert(tail[j], cTail);
    gb.vert(mid[i], cMid); gb.vert(head[i], cHead); gb.vert(head[j], cHead);
    gb.vert(mid[i], cMid); gb.vert(head[j], cHead); gb.vert(mid[j], cMid);
    gb.vert(head[i], cHead); gb.vert(apex, cHead); gb.vert(head[j], cHead);
  }
  return gb.build();
}

/** Estilhaço: tetraedro irregular, escuro, com uma face ainda incandescente. */
function makeDebrisGeometry(noise) {
  const geo = new THREE.IcosahedronGeometry(1, 0);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    _v1.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    const d = 0.6 + 0.8 * Math.abs(noise.noise3(_v1.x * 2.1, _v1.y * 2.1, _v1.z * 2.1));
    pos.setXYZ(i, _v1.x * d, _v1.y * d, _v1.z * d);
    const hot = clamp((_v1.y + 0.6) * 0.5, 0, 1);
    colors[i * 3] = 0.06 + hot * 0.9;
    colors[i * 3 + 1] = 0.05 + hot * 0.18;
    colors[i * 3 + 2] = 0.05 + hot * 0.06;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Texturas de partícula geradas em runtime (nenhum asset binário no repo).
 * `ring>0` produz um anel; caso contrário um disco com queda suave.
 */
function makeSpriteTexture(size, ring) {
  const data = new Uint8Array(size * size * 4);
  const c = (size - 1) * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - c) / c, dy = (y - c) / c;
      const r = Math.sqrt(dx * dx + dy * dy);
      let a;
      if (ring > 0) {
        const d = Math.abs(r - 0.78);
        a = Math.exp(-(d * d) / (ring * ring)) * clamp(1 - r, 0, 1) * 1.6;
      } else {
        a = Math.pow(clamp(1 - r, 0, 1), 2.1);
      }
      const i = (y * size + x) * 4;
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
      data[i + 3] = Math.round(clamp(a, 0, 1) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/* ==========================================================================
   2. ESCUDO — onda hexagonal a partir do ponto de impacto
   ========================================================================== */

// O renderer usa logarithmicDepthBuffer: sem <common> + os chunks de logdepth
// este shader simplesmente não compila.
const SHIELD_VS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}`;

const SHIELD_FS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
uniform float uHex;
uniform vec4 uImpacts[4];   // xyz = direção local do impacto, w = idade (s); w<0 = livre
varying vec3 vDir;

/* Distância à aresta da célula hexagonal mais próxima. */
float hexDist(vec2 p) {
  vec2 s = vec2(1.0, 1.7320508);
  vec2 a = mod(p, s) - s * 0.5;
  vec2 b = mod(p + s * 0.5, s) - s * 0.5;
  vec2 g = dot(a, a) < dot(b, b) ? a : b;
  return 0.5 - max(abs(g.x) * 0.8660254 + g.y * 0.5, abs(g.y));
}

void main() {
  #include <logdepthbuf_fragment>
  vec3 d = normalize(vDir);
  vec2 sph = vec2(atan(d.z, d.x), acos(clamp(d.y, -1.0, 1.0)));
  float grid = smoothstep(0.30, 0.03, hexDist(sph * uHex));

  float energy = 0.0;
  for (int i = 0; i < 4; i++) {
    vec4 im = uImpacts[i];
    if (im.w < 0.0) continue;
    float ang = acos(clamp(dot(d, normalize(im.xyz)), -1.0, 1.0));
    float front = im.w * 3.2;                       // frente da onda, em radianos
    float band = exp(-pow((ang - front) * 5.0, 2.0));
    float fade = exp(-im.w * 1.7);
    energy += band * fade + exp(-ang * 7.0) * fade * 0.7;
  }
  energy = min(energy, 3.0);
  float a = energy * (0.22 + 0.78 * grid);
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor * (0.5 + energy * 2.4), a);
}`;

function makeShieldMaterial(color) {
  return new THREE.ShaderMaterial({
    vertexShader: SHIELD_VS,
    fragmentShader: SHIELD_FS,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uHex: { value: 22 },
      uImpacts: {
        value: [
          new THREE.Vector4(0, 1, 0, -1), new THREE.Vector4(0, 1, 0, -1),
          new THREE.Vector4(0, 1, 0, -1), new THREE.Vector4(0, 1, 0, -1),
        ],
      },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

/** Registra um impacto na casca: reaproveita o slot mais velho quando cheio. */
function pushImpact(impacts, localDir, ctxTime) {
  let slot = -1, oldest = -1, oldestAge = -1;
  for (let i = 0; i < 4; i++) {
    const w = impacts[i].w;
    if (w < 0) { slot = i; break; }
    if (w > oldestAge) { oldestAge = w; oldest = i; }
  }
  if (slot < 0) slot = oldest < 0 ? 0 : oldest;
  impacts[slot].set(localDir.x, localDir.y, localDir.z, 0);
}

function ageImpacts(impacts, dt) {
  let alive = false;
  for (let i = 0; i < 4; i++) {
    if (impacts[i].w < 0) continue;
    impacts[i].w += dt;
    if (impacts[i].w > 1.7) impacts[i].w = -1;
    else alive = true;
  }
  return alive;
}

/* ==========================================================================
   3. POOLS
   ========================================================================== */

function makePools(ctx) {
  const scene = ctx.engine.scene;
  S.root = new THREE.Group();
  S.root.name = 'combat';
  S.root.frustumCulled = false;
  scene.add(S.root);

  // ── Asteroides: 4 variantes × 3 LODs ──────────────────────────────────────
  S.matAst = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.94, metalness: 0.06,
  });
  S.astMeshes = [];
  S.astCount = [];
  for (let v = 0; v < AST_VARIANTS.length; v++) {
    const row = [];
    for (let l = 0; l < AST_LOD.length; l++) {
      const geo = makeAsteroidGeometry(AST_VARIANTS[v], AST_LOD[l], S.noise);
      const im = new THREE.InstancedMesh(geo, S.matAst, MAX_AST);
      im.count = 0;
      im.frustumCulled = false;      // as instâncias vivem longe da origem do grupo
      im.castShadow = false;
      im.receiveShadow = false;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      S.root.add(im);
      row.push(im);
    }
    S.astMeshes.push(row);
    S.astCount.push([0, 0, 0]);
  }
  for (let i = 0; i < MAX_AST; i++) {
    S.asteroids.push({
      active: false, cell: -1, frag: false, ttl: 0,
      pos: new Vec3d(), vel: new Vec3d(),
      quat: new THREE.Quaternion(), spin: new THREE.Vector3(), spinRate: 0,
      radius: 20, variant: 0, hp: 1, maxHp: 1, ore: 'Ferrite', oreAmt: 20,
      sx: 1, sy: 1, sz: 1, flash: 0,
    });
  }

  // ── Projéteis ─────────────────────────────────────────────────────────────
  S.boltGeo = makeBoltGeometry();
  const boltMat = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  S.projMesh = new THREE.InstancedMesh(S.boltGeo, boltMat, MAX_PROJ);
  S.projMesh.count = 0;
  S.projMesh.frustumCulled = false;
  S.projMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  S.root.add(S.projMesh);
  // Inicializa a cor de instância uma vez para o atributo existir.
  _col.setRGB(1, 1, 1);
  for (let i = 0; i < MAX_PROJ; i++) S.projMesh.setColorAt(i, _col);
  for (let i = 0; i < MAX_PROJ; i++) {
    S.projectiles.push({
      active: false, owner: 0, pos: new Vec3d(), vel: new Vec3d(),
      life: 0, dmg: 0, width: 1, r: 1, g: 1, b: 1,
    });
  }

  // ── Detritos ──────────────────────────────────────────────────────────────
  S.debrisGeo = makeDebrisGeometry(S.noise);
  const debMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.8, metalness: 0.3,
    emissive: new THREE.Color(0.5, 0.12, 0.03), emissiveIntensity: 0.6,
  });
  S.debrisMesh = new THREE.InstancedMesh(S.debrisGeo, debMat, MAX_DEBRIS);
  S.debrisMesh.count = 0;
  S.debrisMesh.frustumCulled = false;
  S.debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  S.root.add(S.debrisMesh);
  for (let i = 0; i < MAX_DEBRIS; i++) {
    S.debris.push({
      active: false, pos: new Vec3d(), vel: new Vec3d(),
      quat: new THREE.Quaternion(), spin: new THREE.Vector3(), spinRate: 0,
      size: 1, life: 0, maxLife: 1,
    });
  }

  // ── Billboards: clarão, faísca e fumaça ───────────────────────────────────
  S.quadGeo = new THREE.PlaneGeometry(1, 1);
  S.texGlow = makeSpriteTexture(64, 0);
  S.texRing = makeSpriteTexture(96, 0.10);
  const glowMat = new THREE.MeshBasicMaterial({
    map: S.texGlow, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, color: 0xffffff,
  });
  S.glowMesh = new THREE.InstancedMesh(S.quadGeo, glowMat, MAX_GLOW);
  S.glowMesh.count = 0;
  S.glowMesh.frustumCulled = false;
  S.glowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  S.root.add(S.glowMesh);
  for (let i = 0; i < MAX_GLOW; i++) S.glowMesh.setColorAt(i, _col);
  for (let i = 0; i < MAX_GLOW; i++) {
    S.glows.push({
      active: false, pos: new Vec3d(), vel: new Vec3d(),
      size: 1, grow: 0, life: 0, maxLife: 1,
      r: 1, g: 1, b: 1, power: 1,
    });
  }

  const ringMat = new THREE.MeshBasicMaterial({
    map: S.texRing, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, color: 0xffffff, side: THREE.DoubleSide,
  });
  S.ringMesh = new THREE.InstancedMesh(S.quadGeo, ringMat, MAX_RING);
  S.ringMesh.count = 0;
  S.ringMesh.frustumCulled = false;
  S.ringMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  S.root.add(S.ringMesh);
  for (let i = 0; i < MAX_RING; i++) S.ringMesh.setColorAt(i, _col);
  for (let i = 0; i < MAX_RING; i++) {
    S.rings.push({
      active: false, pos: new Vec3d(), size: 1, grow: 1,
      life: 0, maxLife: 1, r: 1, g: 1, b: 1,
    });
  }

  // ── Luzes de disparo ──────────────────────────────────────────────────────
  // Criadas UMA vez e nunca removidas: mudar a contagem de luzes recompila
  // todos os materiais da cena e produziria um engasgo a cada tiro.
  for (let i = 0; i < 2; i++) {
    const L = new THREE.PointLight(0x66e0ff, 0, 320, 2);
    L.castShadow = false;
    S.root.add(L);
    S.lights.push(L);
  }

  // ── Escudo do jogador ─────────────────────────────────────────────────────
  S.shieldProto = new THREE.SphereGeometry(1, 24, 16);
  const pm = makeShieldMaterial(0x59d8ff);
  S.playerShield = new THREE.Mesh(S.shieldProto, pm);
  S.playerShield.scale.setScalar(PLAYER_HULL_R * 1.5);
  S.playerShield.visible = false;
  S.playerShield.frustumCulled = false;
  S.playerImpacts = pm.uniforms.uImpacts.value;
  S.root.add(S.playerShield);
}

/* ==========================================================================
   4. NAVES HOSTIS — construção e IA
   ========================================================================== */

function makeShipPool(ctx) {
  const rng = ctx.rng.derive('hostile', 0);
  S.hostileGeo = [];
  for (let i = 0; i < 3; i++) {
    S.hostileGeo.push(makeHostileShip(rng.derive('cls', i), i === 2 ? 2 : 1));
  }
  S.matHull = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.52, metalness: 0.78,
    emissive: new THREE.Color(0.05, 0.006, 0.006), emissiveIntensity: 1,
    side: THREE.DoubleSide,
  });
  S.matGlowShip = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });

  for (let i = 0; i < MAX_SHIPS; i++) {
    const proto = S.hostileGeo[i % S.hostileGeo.length];
    const g = new THREE.Group();
    g.visible = false;
    g.frustumCulled = false;
    const hull = new THREE.Mesh(proto.hull, S.matHull);
    hull.frustumCulled = false;
    g.add(hull);
    if (proto.glow) {
      const gl = new THREE.Mesh(proto.glow, S.matGlowShip);
      gl.frustumCulled = false;
      g.add(gl);
    }
    const smat = makeShieldMaterial(0xff5a3a);
    const sh = new THREE.Mesh(S.shieldProto, smat);
    sh.scale.setScalar(proto.radius * 2.6 + proto.length * 0.34);
    sh.visible = false;
    sh.frustumCulled = false;
    g.add(sh);
    S.root.add(g);

    S.ships.push({
      active: false, obj: g, proto, kind: i % S.hostileGeo.length,
      pos: new Vec3d(), vel: new Vec3d(), quat: new THREE.Quaternion(),
      hp: 1, maxHp: 1, shield: 0, maxShield: 0, shieldT: 0,
      shieldMesh: sh, impacts: smat.uniforms.uImpacts.value,
      state: 'form', stateT: 0, fireCd: 0, missileCd: 0, jink: 0,
      squad: null, slot: 0, breakDir: new THREE.Vector3(0, 0, 1),
      hitR: proto.radius + proto.length * 0.4,
    });
  }
}

/** Reserva um slot livre no pool de naves. */
function freeShip() {
  for (let i = 0; i < S.ships.length; i++) if (!S.ships[i].active) return S.ships[i];
  return null;
}

/**
 * Solta um esquadrão à frente/ao lado do jogador. O ponto de entrada vem do RNG
 * derivado da onda — a mesma seed produz o mesmo encontro na mesma ordem.
 */
function spawnSquadron(ctx, count) {
  const rng = ctx.rng.derive('wave', S.waveIndex++);
  const n = count || rng.intRange(2, 4);
  const dirS = rng.onSphere();
  _dir.set(dirS.x, dirS.y, dirS.z);
  // Vem de frente na maior parte das vezes: um esquadrão que nasce atrás do
  // jogador é injusto e, pior, invisível.
  _fwd.set(0, 0, -1).applyQuaternion(ctx.player.quaternion);
  if (_dir.dot(_fwd) < 0.2) _dir.lerp(_fwd, 0.75).normalize();
  const dist = rng.range(2200, 3600);
  _d1.copy(ctx.player.position).addScaled(_dir, dist);

  const squad = { members: [], leader: null, alive: 0 };
  for (let i = 0; i < n; i++) {
    const sh = freeShip();
    if (!sh) break;
    sh.active = true;
    sh.obj.visible = true;
    sh.squad = squad;
    sh.slot = i;
    sh.state = i === 0 ? 'pursue' : 'form';
    sh.stateT = 0;
    sh.maxHp = 120 + sh.kind * 60;
    sh.hp = sh.maxHp;
    sh.maxShield = 55 + sh.kind * 25;
    sh.shield = sh.maxShield;
    sh.shieldT = 0;
    sh.fireCd = rng.range(0.4, 1.8);
    sh.missileCd = rng.range(4, 12);
    sh.jink = rng.range(0, 6.28);
    sh.pos.copy(_d1).addScaled(
      { x: rng.range(-1, 1), y: rng.range(-1, 1), z: rng.range(-1, 1) }, 120,
    );
    // Entra já com a velocidade do jogador somada: senão o encontro começa
    // com o esquadrão sendo deixado para trás a 1 km/s.
    sh.vel.copy(ctx.player.velocity).multiplyScalar(0.85);
    _v1.set(-_dir.x, -_dir.y, -_dir.z);
    buildLook(sh.quat, _v1, upFor(sh.pos));
    squad.members.push(sh);
    squad.alive++;
  }
  if (squad.members.length) {
    squad.leader = squad.members[0];
    S.squads.push(squad);
    ctx.events.emit('audio:cue', { name: 'combat_alarm', params: { count: squad.members.length } });
    ctx.events.emit('ui:notify', { text: 'ASSINATURAS HOSTIS DETECTADAS', kind: 'warn' });
    ctx.events.emit('music:mood', { mood: 'combat', intensity: 0.8 });
  }
  return squad;
}

/** "Cima" estável para construir orientações longe de qualquer planeta. */
function upFor(pos) {
  const body = S.ctx?.planet?.current;
  if (body?.center) {
    _up.set(pos.x - body.center.x, pos.y - body.center.y, pos.z - body.center.z);
    if (_up.lengthSq() > 1) return _up.normalize();
  }
  return _up.set(0, 1, 0);
}

/** Quaternion "olhando para fwd" (three olha para -Z). */
function buildLook(qOut, fwd, up) {
  _v1.copy(fwd).normalize();
  _v2.copy(up).normalize();
  _right.crossVectors(_v1, _v2);
  if (_right.lengthSq() < 1e-8) {
    _v2.set(Math.abs(_v1.y) > 0.9 ? 1 : 0, Math.abs(_v1.y) > 0.9 ? 0 : 1, 0);
    _right.crossVectors(_v1, _v2);
  }
  _right.normalize();
  _v2.crossVectors(_right, _v1).normalize();
  _v3.copy(_v1).multiplyScalar(-1);
  _m4.makeBasis(_right, _v2, _v3);
  qOut.setFromRotationMatrix(_m4);
  return qOut;
}

/**
 * IA de dogfight. Um único quaternion desejado por estado, seguido de slerp e
 * empuxo no nariz — é o que dá o movimento "de caça" sem simulação de voo.
 */
function updateHostile(sh, dt, ctx) {
  const p = ctx.player;
  _d1.subVectors(p.position, sh.pos);
  const dist = Math.max(1e-3, _d1.length());
  _dir.set(_d1.x / dist, _d1.y / dist, _d1.z / dist);
  _fwd.set(0, 0, -1).applyQuaternion(sh.quat);
  const facing = _fwd.dot(_dir);

  // O jogador está com o nariz em cima dele? Então é hora de sair da linha.
  _v1.set(0, 0, -1).applyQuaternion(p.quaternion);
  const underFire = dist < 1900 && _v1.dot(_dir) < -0.975;

  sh.stateT += dt;
  const speedRef = Math.max(340, p.velocity.length() * 1.06);

  // ── Transições ────────────────────────────────────────────────────────────
  if (sh.state === 'form') {
    // Ala: só entra em combate depois que o líder engaja ou se levar tiro.
    const lead = sh.squad?.leader;
    if (!lead || !lead.active || lead.state === 'pursue') {
      if (sh.stateT > 1.2 + sh.slot * 0.7) setState(sh, 'pursue');
    }
  } else if (sh.state === 'pursue') {
    if (dist < 240) setState(sh, 'break');
    else if (underFire && sh.stateT > 1.4) setState(sh, 'evade');
  } else if (sh.state === 'break') {
    // Quebra de ataque: cruza, afasta e volta a virar quando ganhou distância.
    if (sh.stateT > 2.4 || dist > 900) setState(sh, 'pursue');
  } else if (sh.state === 'evade') {
    if (sh.stateT > 2.2 && !underFire) setState(sh, 'pursue');
  }

  // ── Direção desejada ──────────────────────────────────────────────────────
  let accel = 190;
  if (sh.state === 'pursue') {
    // Perseguição com antecipação: mira onde o alvo ESTARÁ quando o fóton
    // chegar, não onde ele está agora.
    const tof = clamp(dist / EPHOTON_SPEED, 0, 2.2);
    _d2.copy(p.position).addScaled(p.velocity, tof).sub(sh.pos);
    _v2.set(_d2.x, _d2.y, _d2.z).normalize();
    accel = dist > 900 ? 260 : 170;
  } else if (sh.state === 'break') {
    _v2.copy(sh.breakDir);
    accel = 300;
  } else if (sh.state === 'evade') {
    // Jinking: componente lateral senoidal somada ao afastamento.
    sh.jink += dt * 3.4;
    _right.crossVectors(_dir, upFor(sh.pos)).normalize();
    _up.crossVectors(_right, _dir).normalize();
    _v2.copy(_dir).multiplyScalar(-0.35)
      .addScaledVector(_right, Math.cos(sh.jink) * 1.0)
      .addScaledVector(_up, Math.sin(sh.jink * 0.7) * 0.8)
      .normalize();
    accel = 280;
  } else {
    // Formação: escalão atrás e ao lado do líder.
    const lead = sh.squad?.leader;
    if (lead && lead.active && lead !== sh) {
      _v1.set((sh.slot % 2 === 0 ? -1 : 1) * (40 + sh.slot * 12), (sh.slot & 2) * 9, 55 + sh.slot * 22);
      _v1.applyQuaternion(lead.quat);
      _d2.copy(lead.pos).add(_v1).sub(sh.pos);
      const dl = _d2.length();
      _v2.set(_d2.x, _d2.y, _d2.z).normalize();
      accel = dl > 90 ? 300 : 120;
    } else {
      _v2.copy(_dir);
    }
  }

  // ── Integra atitude e velocidade ──────────────────────────────────────────
  buildLook(_q1, _v2, upFor(sh.pos));
  sh.quat.slerp(_q1, smooth(dt, sh.state === 'evade' ? 3.4 : 2.3));
  _fwd.set(0, 0, -1).applyQuaternion(sh.quat);
  sh.vel.addScaled(_fwd, accel * dt);
  // Arrasto artificial: mantém o combate legível em vez de virar balística pura.
  const sp = sh.vel.length();
  const cap = speedRef * (sh.state === 'break' ? 1.35 : 1.1);
  if (sp > cap) sh.vel.multiplyScalar(cap / sp);
  sh.vel.multiplyScalar(Math.exp(-0.55 * dt));
  sh.pos.addScaled(sh.vel, dt);

  // Escudo regenera depois de um tempo sem levar dano.
  sh.shieldT += dt;
  if (sh.shieldT > 6 && sh.shield < sh.maxShield) {
    sh.shield = Math.min(sh.maxShield, sh.shield + 9 * dt);
  }

  // ── Armamento ─────────────────────────────────────────────────────────────
  sh.fireCd -= dt;
  sh.missileCd -= dt;
  if (sh.state === 'pursue' && dist < 1700 && facing > 0.985 && sh.fireCd <= 0) {
    sh.fireCd = 0.30 + (sh.kind === 2 ? 0 : 0.12);
    const tof = clamp(dist / EPHOTON_SPEED, 0, 2.2);
    _d2.copy(p.position).addScaled(p.velocity, tof).sub(sh.pos);
    _v3.set(_d2.x, _d2.y, _d2.z).normalize();
    _v1.set(sh.proto.radius * 0.8, 0, 0).applyQuaternion(sh.quat);
    _d3.copy(sh.pos).add(_v1);
    spawnBolt(ctx, _d3, _v3, EPHOTON_SPEED, EPHOTON_LIFE, EPHOTON_DMG, 1, sh.vel);
    _d3.copy(sh.pos).sub(_v1);
    spawnBolt(ctx, _d3, _v3, EPHOTON_SPEED, EPHOTON_LIFE, EPHOTON_DMG, 1, sh.vel);
    ctx.events.emit('audio:cue', { name: 'weapon_photon_enemy', params: { dist } });
  }
  if (sh.kind === 2 && sh.missileCd <= 0 && dist > 400 && dist < 2400 && facing > 0.93) {
    sh.missileCd = 9 + sh.slot * 2;
    spawnMissile(ctx, sh.pos, sh.vel, sh.quat, 1, null);
    ctx.events.emit('audio:cue', { name: 'missile_launch', params: { hostile: true } });
    ctx.events.emit('ui:notify', { text: 'MÍSSIL RECEBIDO', kind: 'danger' });
  }

  // Muito longe: desiste e some (evita esquadrões órfãos consumindo frame).
  if (dist > 9000) killShip(ctx, sh, false);
}

function setState(sh, st) {
  sh.state = st;
  sh.stateT = 0;
  if (st === 'break') {
    // Escolhe um vetor de fuga que cruza o alvo em vez de dar meia-volta.
    _v1.set(0, 0, -1).applyQuaternion(sh.quat);
    _right.crossVectors(_v1, upFor(sh.pos)).normalize();
    sh.breakDir.copy(_v1).addScaledVector(_right, sh.slot % 2 === 0 ? 1.1 : -1.1).normalize();
  }
}

/** Remove a nave do jogo, com ou sem explosão. */
function killShip(ctx, sh, exploded) {
  sh.active = false;
  sh.obj.visible = false;
  sh.shieldMesh.visible = false;
  for (let i = 0; i < 4; i++) sh.impacts[i].w = -1;
  if (sh.squad) {
    sh.squad.alive--;
    if (sh.squad.leader === sh) {
      sh.squad.leader = sh.squad.members.find((m) => m.active) || null;
    }
    if (sh.squad.alive <= 0) {
      const i = S.squads.indexOf(sh.squad);
      if (i >= 0) S.squads.splice(i, 1);
      if (S.squads.length === 0) ctx.events.emit('music:mood', { mood: 'explore', intensity: 0.4 });
    }
    sh.squad = null;
  }
  if (S.target === sh) { S.target = null; S.locked = false; S.lockT = 0; }
  if (exploded) explode(ctx, sh.pos, sh.vel, sh.proto.length * 0.62, true);
}

/* ==========================================================================
   5. CAMPO DE ASTEROIDES
   ========================================================================== */

/** Cinturão ativo: aquele que contém (ou está mais perto de) o jogador. */
function pickBelt(ctx) {
  let belts = null;
  try { belts = ctx.universe?.belts || ctx.universe?.current?.asteroidBelts || null; } catch (e) { belts = null; }
  if (!belts || belts.length === 0) return null;
  const p = ctx.player.position;
  let best = null, bestD = Infinity;
  for (let i = 0; i < belts.length; i++) {
    const b = belts[i];
    if (!b || !(b.outer > 0)) continue;
    // Desfaz a inclinação do plano do cinturão para medir no espaço dele.
    const ct = Math.cos(b.tilt || 0), st = Math.sin(b.tilt || 0);
    const y = p.y * ct + p.z * st;
    const z = -p.y * st + p.z * ct;
    const rho = Math.sqrt(p.x * p.x + z * z);
    const dR = rho < b.inner ? b.inner - rho : rho > b.outer ? rho - b.outer : 0;
    const dY = Math.max(0, Math.abs(y) - b.thickness * 2.5);
    const d = Math.sqrt(dR * dR + dY * dY);
    if (d < bestD) { bestD = d; best = b; }
  }
  // Fora do cinturão por mais de 6 km não há campo nenhum.
  return bestD < 6000 ? best : null;
}

function cellHash(ix, iy, iz) {
  return ((ix & 1023) | ((iy & 1023) << 10) | ((iz & 1023) << 20)) >>> 0;
}

function freeAsteroid() {
  for (let i = 0; i < S.asteroids.length; i++) if (!S.asteroids[i].active) return S.asteroids[i];
  return null;
}

/**
 * Semeia uma célula. Tudo vem de `hash3f(ix,iy,iz,salt)` — sem estado, sem
 * alocação, reconstruível fora de ordem, exatamente como o streaming exige.
 */
function seedCell(ctx, belt, ix, iy, iz, salt) {
  const key = cellHash(ix, iy, iz);
  if (S.cells.has(key)) return;
  const r0 = hash3f(ix, iy, iz, salt);
  const density = clamp(belt.density ?? 0.6, 0.1, 1);
  let n = r0 < density * 0.55 ? 1 : 0;
  if (r0 > 1 - density * 0.16) n = 2;
  S.cells.set(key, 0);
  if (n === 0) return;

  for (let k = 0; k < n; k++) {
    const a = freeAsteroid();
    if (!a) return;
    const s = salt + k * 7919;
    const fx = hash3f(ix, iy, iz, s + 1);
    const fy = hash3f(ix, iy, iz, s + 2);
    const fz = hash3f(ix, iy, iz, s + 3);
    const px = (ix + fx) * AST_CELL;
    const py = (iy + fy) * AST_CELL;
    const pz = (iz + fz) * AST_CELL;

    // Confere se o ponto cai mesmo dentro do toro do cinturão.
    const ct = Math.cos(belt.tilt || 0), st = Math.sin(belt.tilt || 0);
    const yy = py * ct + pz * st;
    const zz = -py * st + pz * ct;
    const rho = Math.sqrt(px * px + zz * zz);
    if (rho < belt.inner || rho > belt.outer) continue;
    if (Math.abs(yy) > belt.thickness * 1.6) continue;

    const sz = hash3f(ix, iy, iz, s + 4);
    a.radius = 11 + Math.pow(sz, 2.6) * 128;
    a.variant = Math.floor(hash3f(ix, iy, iz, s + 5) * AST_VARIANTS.length) % AST_VARIANTS.length;
    a.pos.set(px, py, pz);
    a.vel.set(0, 0, 0);
    a.spin.set(
      hash3f(ix, iy, iz, s + 6) * 2 - 1,
      hash3f(ix, iy, iz, s + 7) * 2 - 1,
      hash3f(ix, iy, iz, s + 8) * 2 - 1,
    );
    if (a.spin.lengthSq() < 1e-6) a.spin.set(0, 1, 0);
    a.spin.normalize();
    a.spinRate = (hash3f(ix, iy, iz, s + 9) * 2 - 1) * 0.34;
    a.quat.setFromAxisAngle(a.spin, hash3f(ix, iy, iz, s + 10) * 6.283);
    a.sx = 0.85 + hash3f(ix, iy, iz, s + 11) * 0.4;
    a.sy = 0.85 + hash3f(ix, iy, iz, s + 12) * 0.4;
    a.sz = 0.85 + hash3f(ix, iy, iz, s + 13) * 0.4;
    a.maxHp = 22 + a.radius * 1.9;
    a.hp = a.maxHp;
    a.ore = pickOre(hash3f(ix, iy, iz, s + 14));
    a.oreAmt = Math.round(18 + a.radius * 1.4);
    a.cell = key;
    a.frag = false;
    a.ttl = 0;
    a.flash = 0;
    a.active = true;
    S.cells.set(key, (S.cells.get(key) || 0) + 1);
  }
}

function pickOre(r) {
  let acc = 0;
  for (let i = 0; i < ORES.length; i++) {
    acc += ORE_W[i];
    if (r <= acc) return ORES[i];
  }
  return ORES[0];
}

/** Varre incrementalmente a vizinhança de células, respeitando o orçamento. */
function updateField(dt, ctx) {
  const belt = pickBelt(ctx);
  S.belt = belt;
  if (!belt) { despawnField(); return; }

  const p = ctx.player.position;
  const cx = Math.floor(p.x / AST_CELL);
  const cy = Math.floor(p.y / AST_CELL);
  const cz = Math.floor(p.z / AST_CELL);
  const key = cellHash(cx, cy, cz);
  if (key !== S.scanKey) { S.scanKey = key; S.scanIdx = 0; }

  const side = AST_CELL_R * 2 + 1;
  const total = side * side * side;
  const salt = (belt.seed | 0) ^ 0x5bf03635;
  while (S.scanIdx < total && ctx.budget.canWork()) {
    const i = S.scanIdx++;
    const ox = (i % side) - AST_CELL_R;
    const oy = (Math.floor(i / side) % side) - AST_CELL_R;
    const oz = Math.floor(i / (side * side)) - AST_CELL_R;
    seedCell(ctx, belt, cx + ox, cy + oy, cz + oz, salt);
  }

  // Descarte: o que saiu do raio de manutenção volta para o pool.
  for (let i = 0; i < S.asteroids.length; i++) {
    const a = S.asteroids[i];
    if (!a.active) continue;
    if (a.frag) {
      a.ttl -= dt;
      a.pos.addScaled(a.vel, dt);
      if (a.ttl <= 0) { releaseAsteroid(a); continue; }
    }
    if (a.pos.distanceToSq(p) > AST_KEEP * AST_KEEP) { releaseAsteroid(a); continue; }
    if (a.spinRate !== 0) {
      _q1.setFromAxisAngle(a.spin, a.spinRate * dt);
      a.quat.multiply(_q1).normalize();
    }
    if (a.flash > 0) a.flash = Math.max(0, a.flash - dt * 3);
  }
}

function releaseAsteroid(a) {
  a.active = false;
  if (a.cell >= 0) {
    const n = (S.cells.get(a.cell) || 1) - 1;
    if (n <= 0) S.cells.delete(a.cell);
    else S.cells.set(a.cell, n);
  }
  a.cell = -1;
}

function despawnField() {
  for (let i = 0; i < S.asteroids.length; i++) {
    if (S.asteroids[i].active) releaseAsteroid(S.asteroids[i]);
  }
  S.cells.clear();
  S.scanKey = -1;
  S.scanIdx = 0;
}

/**
 * Dano numa rocha. Ao morrer solta recurso ('mining:hit'), estilhaça em pedaços
 * menores (que continuam mineráveis) e deixa detritos + poeira.
 */
function damageAsteroid(ctx, a, dmg, from) {
  a.hp -= dmg;
  a.flash = 1;
  ctx.events.emit('combat:hit', {
    attacker: from, victim: 'asteroid', damage: dmg, kind: 'asteroid',
  });
  if (a.hp > 0) {
    ctx.events.emit('audio:cue', { name: 'asteroid_chip', params: { r: a.radius } });
    // Lasca solta um pouco de minério mesmo sem destruir.
    if (Math.random() < 0.34) {
      ctx.events.emit('mining:hit', {
        resource: a.ore, amount: 1, position: a.pos.clone(),
      });
    }
    spawnSparks(ctx, a.pos, 5, 1.6, 0.9, 0.35);
    return false;
  }

  ctx.events.emit('mining:hit', {
    resource: a.ore, amount: a.oreAmt, position: a.pos.clone(),
  });
  ctx.events.emit('audio:cue', { name: 'asteroid_break', params: { r: a.radius } });
  explode(ctx, a.pos, a.vel, a.radius * 0.55, false);

  // Fragmentação: rochas grandes viram rochas pequenas de verdade.
  if (a.radius > 24) {
    const parts = a.radius > 70 ? 4 : 3;
    for (let i = 0; i < parts; i++) {
      const f = freeAsteroid();
      if (!f) break;
      f.active = true;
      f.frag = true;
      f.cell = -1;
      f.ttl = 150;
      f.radius = a.radius * (0.30 + Math.random() * 0.16);
      f.variant = (a.variant + i) % AST_VARIANTS.length;
      randomUnit(_v1);
      f.pos.copy(a.pos).addScaled(_v1, a.radius * 0.55);
      f.vel.copy(a.vel).addScaled(_v1, 6 + Math.random() * 16);
      f.spin.copy(_v1);
      f.spinRate = (Math.random() * 2 - 1) * 0.9;
      f.quat.setFromAxisAngle(_v1, Math.random() * 6.283);
      f.sx = 0.8 + Math.random() * 0.5;
      f.sy = 0.8 + Math.random() * 0.5;
      f.sz = 0.8 + Math.random() * 0.5;
      f.maxHp = 18 + f.radius * 1.5;
      f.hp = f.maxHp;
      f.ore = a.ore;
      f.oreAmt = Math.max(6, Math.round(a.oreAmt * 0.22));
      f.flash = 0.6;
    }
  }
  releaseAsteroid(a);
  return true;
}

/** Vetor unitário efêmero — cosmético, pode usar Math.random (regra 2). */
function randomUnit(out) {
  const z = Math.random() * 2 - 1;
  const t = Math.random() * 6.283185;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return out.set(r * Math.cos(t), r * Math.sin(t), z);
}

/* ==========================================================================
   6. ARMAS E EFEITOS
   ========================================================================== */

function spawnBolt(ctx, pos, dir, speed, life, dmg, owner, baseVel) {
  for (let i = 0; i < S.projectiles.length; i++) {
    const b = S.projectiles[i];
    if (b.active) continue;
    b.active = true;
    b.owner = owner;
    b.pos.copy(pos);
    b.vel.set(dir.x * speed, dir.y * speed, dir.z * speed);
    if (baseVel) b.vel.add(baseVel);
    b.life = life;
    b.dmg = dmg;
    b.width = owner === 0 ? 1.0 : 0.85;
    if (owner === 0) { b.r = 0.35; b.g = 2.30; b.b = 3.10; }
    else { b.r = 3.40; b.g = 0.52; b.b = 0.22; }
    return b;
  }
  return null;
}

function spawnMissile(ctx, pos, vel, quat, owner, target) {
  for (let i = 0; i < S.missiles.length; i++) {
    const m = S.missiles[i];
    if (m.active) continue;
    m.active = true;
    m.obj.visible = true;
    m.owner = owner;
    m.target = target;
    m.pos.copy(pos);
    _v1.set(0, 0, -1).applyQuaternion(quat);
    m.vel.copy(vel).addScaled(_v1, 90);
    m.quat.copy(quat);
    m.life = MISSILE_LIFE;
    m.puffT = 0;
    return m;
  }
  return null;
}

function makeMissilePool(ctx) {
  const gb = new GeoBuilder();
  const dark = [0.09, 0.085, 0.09];
  const trim = [0.5, 0.06, 0.06];
  const body0 = ringPts(-1.6, 0.06, 0.06, 6, 0, 0);
  const body1 = ringPts(-0.9, 0.22, 0.22, 6, 0, 0);
  const body2 = ringPts(0.9, 0.22, 0.22, 6, 0, 0);
  const body3 = ringPts(1.1, 0.16, 0.16, 6, 0, 0);
  loft(gb, body0, body1, dark);
  loft(gb, body1, body2, dark);
  loft(gb, body2, body3, trim);
  gb.cap(body3, trim, true);
  for (let s = -1; s <= 1; s += 2) {
    gb.quad(
      [s * 0.18, 0, 0.55], [s * 0.7, 0, 1.05], [s * 0.7, 0, 1.15], [s * 0.18, 0, 0.95], trim,
    );
    gb.quad(
      [0, s * 0.18, 0.55], [0, s * 0.7, 1.05], [0, s * 0.7, 1.15], [0, s * 0.18, 0.95], trim,
    );
  }
  const geo = gb.build();
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.55, metalness: 0.6, side: THREE.DoubleSide,
    emissive: new THREE.Color(0.35, 0.03, 0.02), emissiveIntensity: 1,
  });
  for (let i = 0; i < MAX_MISSILE; i++) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.scale.setScalar(1.6);
    S.root.add(mesh);
    S.missiles.push({
      active: false, obj: mesh, owner: 0, target: null,
      pos: new Vec3d(), vel: new Vec3d(), quat: new THREE.Quaternion(),
      life: 0, puffT: 0,
    });
  }
}

function spawnGlow(pos, vel, size, grow, life, r, g, b) {
  for (let i = 0; i < S.glows.length; i++) {
    const p = S.glows[i];
    if (p.active) continue;
    p.active = true;
    p.pos.copy(pos);
    if (vel) p.vel.copy(vel); else p.vel.set(0, 0, 0);
    p.size = size; p.grow = grow;
    p.life = life; p.maxLife = life;
    p.r = r; p.g = g; p.b = b;
    return p;
  }
  return null;
}

function spawnRing(pos, size, grow, life, r, g, b) {
  for (let i = 0; i < S.rings.length; i++) {
    const p = S.rings[i];
    if (p.active) continue;
    p.active = true;
    p.pos.copy(pos);
    p.size = size; p.grow = grow;
    p.life = life; p.maxLife = life;
    p.r = r; p.g = g; p.b = b;
    return p;
  }
  return null;
}

function spawnSparks(ctx, pos, n, size, r, g) {
  for (let i = 0; i < n; i++) {
    randomUnit(_v1);
    _d2.copy(pos).addScaled(_v1, size * 0.6);
    _d3.set(_v1.x * 22, _v1.y * 22, _v1.z * 22);
    spawnGlow(_d2, _d3, size * (0.6 + Math.random()), -0.5, 0.28 + Math.random() * 0.2,
      3.2 * r, 2.0 * g, 0.7);
  }
}

/**
 * Explosão em camadas — a razão de existir do pool de billboards:
 *   1. clarão HDR brutal e curtíssimo (é ele que estoura o bloom);
 *   2. casca de choque em anel, expandindo e sumindo;
 *   3. estilhaços físicos girando;
 *   4. fumaça/poeira persistente, que sobrevive vários segundos.
 */
function explode(ctx, pos, vel, scale, isShip) {
  const s = Math.max(2, scale);
  spawnGlow(pos, vel, s * 3.0, 6 * s, 0.14, 26, 16, 8);
  spawnGlow(pos, vel, s * 1.6, 3 * s, 0.36, 12, 4.2, 1.2);
  spawnRing(pos, s * 1.2, s * 16, 0.55, 6.5, 2.6, 1.1);
  if (isShip) spawnRing(pos, s * 0.6, s * 30, 0.9, 2.2, 3.4, 6.0);

  const nDeb = isShip ? 16 : 9;
  for (let i = 0; i < nDeb; i++) {
    for (let k = 0; k < S.debris.length; k++) {
      const d = S.debris[k];
      if (d.active) continue;
      d.active = true;
      randomUnit(_v1);
      d.pos.copy(pos).addScaled(_v1, s * 0.4);
      d.vel.copy(vel || _d3.set(0, 0, 0));
      d.vel.addScaled(_v1, (isShip ? 26 : 16) * (0.4 + Math.random()));
      d.spin.copy(_v1);
      d.spinRate = (Math.random() * 2 - 1) * 5;
      d.quat.setFromAxisAngle(_v1, Math.random() * 6.283);
      d.size = s * (0.07 + Math.random() * 0.16);
      d.maxLife = 5 + Math.random() * 5;
      d.life = d.maxLife;
      break;
    }
  }

  const nSmoke = isShip ? 10 : 5;
  for (let i = 0; i < nSmoke; i++) {
    randomUnit(_v1);
    _d2.copy(pos).addScaled(_v1, s * 0.7);
    _d3.set(_v1.x * 5, _v1.y * 5, _v1.z * 5);
    if (vel) _d3.add(vel);
    // Fumaça: aditiva e escura, porque no espaço o fundo é preto e uma nuvem
    // "por alfa" simplesmente desapareceria.
    spawnGlow(_d2, _d3, s * (1.0 + Math.random()), s * 1.4, 4 + Math.random() * 3,
      0.42, 0.30, 0.24);
  }
  spawnSparks(ctx, pos, isShip ? 14 : 8, s * 0.3, 1, 0.7);
  ctx.events.emit('audio:cue', {
    name: isShip ? 'explosion_ship' : 'explosion_rock', params: { scale: s },
  });
}

/* ==========================================================================
   7. MIRA, TRAVAMENTO E DISPARO DO JOGADOR
   ========================================================================== */

function updateTargeting(dt, ctx) {
  _fwd.set(0, 0, -1).applyQuaternion(ctx.engine.camera.quaternion);
  const p = ctx.player.position;
  let best = null, bestScore = -1;

  for (let i = 0; i < S.ships.length; i++) {
    const sh = S.ships[i];
    if (!sh.active) continue;
    _d1.subVectors(sh.pos, p);
    const d = _d1.length();
    if (d > LOCK_RANGE || d < 1) continue;
    const dot = (_d1.x * _fwd.x + _d1.y * _fwd.y + _d1.z * _fwd.z) / d;
    if (dot < LOCK_CONE) continue;
    const score = dot * 2 - d / LOCK_RANGE;
    if (score > bestScore) { bestScore = score; best = sh; }
  }

  if (best !== S.target) {
    S.target = best;
    S.lockT = 0;
    S.locked = false;
  }
  if (S.target) {
    S.lockT = Math.min(LOCK_TIME, S.lockT + dt);
    if (!S.locked && S.lockT >= LOCK_TIME) {
      S.locked = true;
      ctx.events.emit('audio:cue', { name: 'lock_on', params: {} });
    }
  } else {
    S.lockT = Math.max(0, S.lockT - dt * 2);
    S.locked = false;
  }
}

function updatePlayerWeapons(dt, ctx) {
  S.fireCd -= dt;
  S.missileCd -= dt;
  if (ctx.flight?.mode === 'foot') return;   // a pé quem atira é a multi-ferramenta

  const inp = ctx.input;
  _fwd.set(0, 0, -1).applyQuaternion(ctx.engine.camera.quaternion);

  if (inp.down('fire') && S.fireCd <= 0) {
    S.fireCd = PHOTON_CD;
    // Convergência: os dois canhões miram no ponto sob a mira, não paralelos.
    _d1.copy(ctx.player.position).addScaled(_fwd, S.target ? ctx.player.position.distanceTo(S.target.pos) : 1200);
    _right.set(1, 0, 0).applyQuaternion(ctx.player.quaternion);
    _up.set(0, 1, 0).applyQuaternion(ctx.player.quaternion);
    for (let s = -1; s <= 1; s += 2) {
      _d2.copy(ctx.player.position).addScaled(_right, s * 7.5).addScaled(_up, -1.4);
      _d3.subVectors(_d1, _d2);
      _v1.set(_d3.x, _d3.y, _d3.z).normalize();
      spawnBolt(ctx, _d2, _v1, PHOTON_SPEED, PHOTON_LIFE, PHOTON_DMG, 0, ctx.player.velocity);
      // Fogacho no bocal.
      spawnGlow(_d2, ctx.player.velocity, 3.2, -6, 0.09, 1.2, 5.0, 7.0);
    }
    ctx.events.emit('audio:cue', { name: 'weapon_photon', params: {} });
  }

  if (inp.down('altFire') && S.missileCd <= 0 && S.locked && S.target) {
    S.missileCd = MISSILE_CD;
    spawnMissile(ctx, ctx.player.position, ctx.player.velocity, ctx.player.quaternion, 0, S.target);
    ctx.events.emit('audio:cue', { name: 'missile_launch', params: { hostile: false } });
  }
}

/* ==========================================================================
   8. SIMULAÇÃO DE PROJÉTEIS, MÍSSEIS E COLISÕES
   ========================================================================== */

function updateProjectiles(dt, ctx) {
  const p = ctx.player.position;
  for (let i = 0; i < S.projectiles.length; i++) {
    const b = S.projectiles[i];
    if (!b.active) continue;
    b.life -= dt;
    if (b.life <= 0) { b.active = false; continue; }
    // Passo do frame inteiro; para a escala e a velocidade aqui, testar apenas
    // o ponto final é suficiente porque os alvos têm dezenas de metros.
    b.pos.addScaled(b.vel, dt);

    let hit = false;
    if (b.owner === 0) {
      for (let k = 0; k < S.ships.length && !hit; k++) {
        const sh = S.ships[k];
        if (!sh.active) continue;
        if (b.pos.distanceToSq(sh.pos) < sh.hitR * sh.hitR) {
          hitShip(ctx, sh, b.dmg, b.pos, 'player');
          hit = true;
        }
      }
    } else if (b.pos.distanceToSq(p) < PLAYER_HULL_R * PLAYER_HULL_R) {
      hitPlayer(ctx, b.dmg, b.pos);
      hit = true;
    }
    if (!hit) {
      for (let k = 0; k < S.asteroids.length; k++) {
        const a = S.asteroids[k];
        if (!a.active) continue;
        const rr = a.radius * 1.02;
        if (b.pos.distanceToSq(a.pos) < rr * rr) {
          damageAsteroid(ctx, a, b.dmg, b.owner === 0 ? 'player' : 'hostile');
          spawnGlow(b.pos, null, 4, 10, 0.2, b.r, b.g, b.b);
          hit = true;
          break;
        }
      }
    }
    if (hit) b.active = false;
  }
}

function updateMissiles(dt, ctx) {
  for (let i = 0; i < S.missiles.length; i++) {
    const m = S.missiles[i];
    if (!m.active) continue;
    m.life -= dt;
    if (m.life <= 0) { m.active = false; m.obj.visible = false; continue; }

    // Alvo: nave travada (jogador) ou o próprio jogador (hostil).
    let tp = null, tv = null;
    if (m.owner === 0) {
      if (m.target && m.target.active) { tp = m.target.pos; tv = m.target.vel; }
    } else { tp = ctx.player.position; tv = ctx.player.velocity; }

    if (tp) {
      _d1.subVectors(tp, m.pos);
      const d = Math.max(1, _d1.length());
      const tof = clamp(d / MISSILE_SPEED, 0, 3);
      _d2.copy(tp).addScaled(tv, tof).sub(m.pos);
      _v1.set(_d2.x, _d2.y, _d2.z).normalize();
      buildLook(_q1, _v1, upFor(m.pos));
      m.quat.slerp(_q1, smooth(dt, 3.6));
      if (d < 18) {
        explode(ctx, m.pos, m.vel, 9, false);
        if (m.owner === 0 && m.target) hitShip(ctx, m.target, MISSILE_DMG, m.pos, 'player');
        else hitPlayer(ctx, MISSILE_DMG * 0.55, m.pos);
        m.active = false; m.obj.visible = false;
        continue;
      }
    }
    _v1.set(0, 0, -1).applyQuaternion(m.quat);
    m.vel.addScaled(_v1, 520 * dt);
    const sp = m.vel.length();
    if (sp > MISSILE_SPEED * 2.2) m.vel.multiplyScalar((MISSILE_SPEED * 2.2) / sp);
    m.pos.addScaled(m.vel, dt);

    // Rastro de fumaça: um sopro a cada 40 ms mantém a linha contínua.
    m.puffT -= dt;
    if (m.puffT <= 0) {
      m.puffT = 0.04;
      _v2.set(0, 0, 1).applyQuaternion(m.quat);
      _d3.copy(m.pos).addScaled(_v2, 3);
      spawnGlow(_d3, null, 2.4, 5.5, 1.5, 0.9, 0.55, 0.4);
      spawnGlow(_d3, null, 1.4, 2.0, 0.22, 4.5, 1.8, 0.7);
    }
  }
}

/** Dano numa nave hostil: escudo primeiro, com a onda hexagonal visível. */
function hitShip(ctx, sh, dmg, atPos, source) {
  sh.shieldT = 0;
  let left = dmg;
  if (sh.shield > 0) {
    const absorbed = Math.min(sh.shield, left);
    sh.shield -= absorbed;
    left -= absorbed;
    _d1.subVectors(atPos, sh.pos);
    _v1.set(_d1.x, _d1.y, _d1.z).normalize();
    _q2.copy(sh.quat).invert();
    _v1.applyQuaternion(_q2);
    pushImpact(sh.impacts, _v1, 0);
    sh.shieldMesh.visible = true;
    ctx.events.emit('audio:cue', { name: 'shield_hit', params: { hostile: true } });
  }
  if (left > 0) {
    sh.hp -= left;
    spawnSparks(ctx, atPos, 6, 2.4, 1, 0.6);
  }
  ctx.events.emit('combat:hit', {
    attacker: source, victim: 'hostile', damage: dmg, kind: 'ship',
  });
  if (sh.hp <= 0) {
    killShip(ctx, sh, true);
    ctx.events.emit('ui:notify', { text: 'HOSTIL ABATIDO', kind: 'good' });
  }
}

/** Dano no jogador: escudo do casco com onda hexagonal, depois estrutura. */
function hitPlayer(ctx, dmg, atPos) {
  const p = ctx.player;
  _d1.subVectors(atPos, p.position);
  _v1.set(_d1.x, _d1.y, _d1.z).normalize();
  _q2.copy(p.quaternion).invert();
  _v1.applyQuaternion(_q2);
  pushImpact(S.playerImpacts, _v1, 0);
  S.playerShield.visible = true;
  ctx.events.emit('combat:hit', {
    attacker: 'hostile', victim: 'player', damage: dmg, kind: 'ship',
  });
  ctx.events.emit('player:damage', { amount: dmg, source: 'hostile' });
  ctx.events.emit('audio:cue', { name: 'shield_hit', params: { hostile: false } });
}

/** Colisão do casco do jogador com rocha: empurrão e dano proporcional. */
function checkPlayerCollisions(ctx, dt) {
  const p = ctx.player;
  for (let i = 0; i < S.asteroids.length; i++) {
    const a = S.asteroids[i];
    if (!a.active) continue;
    const rr = a.radius + PLAYER_HULL_R;
    if (p.position.distanceToSq(a.pos) > rr * rr) continue;
    _d1.subVectors(p.position, a.pos);
    const d = Math.max(0.001, _d1.length());
    _d1.multiplyScalar(1 / d);
    // Nunca deixa o casco dentro da rocha e devolve a componente de aproximação.
    p.position.copy(a.pos).addScaled(_d1, rr + 0.5);
    const closing = -p.velocity.dot(_d1);
    if (closing > 0) {
      p.velocity.addScaled(_d1, closing * 1.4);
      const dmg = clamp(closing * 0.32, 0, 55);
      if (dmg > 2) {
        ctx.events.emit('player:damage', { amount: dmg, source: 'collision' });
        hitPlayer(ctx, 0.001, a.pos);      // só para acender o escudo
        damageAsteroid(ctx, a, closing * 1.4, 'player');
      }
    }
    break;
  }
}

/* ==========================================================================
   9. ESCRITA NO GRAFO DE CENA (coordenadas relativas)
   ========================================================================== */

function syncTransforms(ctx) {
  if (!S.ready) return;
  const f = ctx.frame;
  const cam = ctx.engine.camera;

  // ── Asteroides: um InstancedMesh por (variante, LOD) ──────────────────────
  for (let v = 0; v < S.astCount.length; v++) {
    S.astCount[v][0] = 0; S.astCount[v][1] = 0; S.astCount[v][2] = 0;
  }
  const camW = f.camera;
  for (let i = 0; i < S.asteroids.length; i++) {
    const a = S.asteroids[i];
    if (!a.active) continue;
    const d = Math.sqrt(a.pos.distanceToSq(camW));
    // LOD por tamanho angular, não por distância bruta: uma rocha de 140 m
    // ainda precisa de silhueta a 3 km.
    const ratio = d / Math.max(4, a.radius);
    const lod = ratio < 14 ? 0 : ratio < 46 ? 1 : 2;
    const row = S.astCount[a.variant];
    const idx = row[lod];
    if (idx >= MAX_AST) continue;
    f.toLocal(a.pos, _v1);
    _scl.set(a.radius * a.sx, a.radius * a.sy, a.radius * a.sz);
    _m4.compose(_v1, a.quat, _scl);
    S.astMeshes[a.variant][lod].setMatrixAt(idx, _m4);
    row[lod] = idx + 1;
  }
  for (let v = 0; v < S.astMeshes.length; v++) {
    for (let l = 0; l < 3; l++) {
      const m = S.astMeshes[v][l];
      const n = S.astCount[v][l];
      if (m.count !== 0 || n !== 0) m.instanceMatrix.needsUpdate = true;
      m.count = n;
    }
  }

  // ── Naves hostis ──────────────────────────────────────────────────────────
  for (let i = 0; i < S.ships.length; i++) {
    const sh = S.ships[i];
    if (!sh.active) continue;
    sh.obj.position.copy(f.toLocal(sh.pos, _v1));
    sh.obj.quaternion.copy(sh.quat);
  }

  // ── Mísseis ───────────────────────────────────────────────────────────────
  for (let i = 0; i < S.missiles.length; i++) {
    const m = S.missiles[i];
    if (!m.active) continue;
    m.obj.position.copy(f.toLocal(m.pos, _v1));
    m.obj.quaternion.copy(m.quat);
  }

  // ── Projéteis ─────────────────────────────────────────────────────────────
  let np = 0;
  let colorDirty = false;
  for (let i = 0; i < S.projectiles.length && np < MAX_PROJ; i++) {
    const b = S.projectiles[i];
    if (!b.active) continue;
    const sp = b.vel.length();
    if (sp < 1e-3) continue;
    _v2.set(b.vel.x / sp, b.vel.y / sp, b.vel.z / sp);
    _q1.setFromUnitVectors(UNIT_Z, _v2);
    f.toLocal(b.pos, _v1);
    // O comprimento do rastro cresce com a velocidade relativa à câmera.
    const len = clamp(sp * 0.055, 6, 90);
    _scl.set(b.width * 0.9, b.width * 0.9, len);
    _m4.compose(_v1, _q1, _scl);
    S.projMesh.setMatrixAt(np, _m4);
    _col.setRGB(b.r, b.g, b.b);
    S.projMesh.setColorAt(np, _col);
    colorDirty = true;
    np++;
  }
  S.projMesh.count = np;
  S.projMesh.instanceMatrix.needsUpdate = true;
  if (colorDirty && S.projMesh.instanceColor) S.projMesh.instanceColor.needsUpdate = true;

  // ── Detritos ──────────────────────────────────────────────────────────────
  let nd = 0;
  for (let i = 0; i < S.debris.length && nd < MAX_DEBRIS; i++) {
    const d = S.debris[i];
    if (!d.active) continue;
    f.toLocal(d.pos, _v1);
    const k = clamp(d.life / d.maxLife, 0, 1);
    _scl.setScalar(d.size * (0.4 + 0.6 * k));
    _m4.compose(_v1, d.quat, _scl);
    S.debrisMesh.setMatrixAt(nd, _m4);
    nd++;
  }
  S.debrisMesh.count = nd;
  S.debrisMesh.instanceMatrix.needsUpdate = true;

  // ── Billboards (clarão, faísca, fumaça) ───────────────────────────────────
  _q2.copy(cam.quaternion);
  let ng = 0;
  for (let i = 0; i < S.glows.length && ng < MAX_GLOW; i++) {
    const g = S.glows[i];
    if (!g.active) continue;
    f.toLocal(g.pos, _v1);
    _scl.setScalar(Math.max(0.01, g.size));
    _m4.compose(_v1, _q2, _scl);
    S.glowMesh.setMatrixAt(ng, _m4);
    const k = clamp(g.life / g.maxLife, 0, 1);
    const fade = k * k;
    _col.setRGB(g.r * fade, g.g * fade, g.b * fade);
    S.glowMesh.setColorAt(ng, _col);
    ng++;
  }
  S.glowMesh.count = ng;
  S.glowMesh.instanceMatrix.needsUpdate = true;
  if (S.glowMesh.instanceColor) S.glowMesh.instanceColor.needsUpdate = true;

  let nr = 0;
  for (let i = 0; i < S.rings.length && nr < MAX_RING; i++) {
    const r = S.rings[i];
    if (!r.active) continue;
    f.toLocal(r.pos, _v1);
    _scl.setScalar(Math.max(0.01, r.size));
    _m4.compose(_v1, _q2, _scl);
    S.ringMesh.setMatrixAt(nr, _m4);
    const k = clamp(r.life / r.maxLife, 0, 1);
    _col.setRGB(r.r * k, r.g * k, r.b * k);
    S.ringMesh.setColorAt(nr, _col);
    nr++;
  }
  S.ringMesh.count = nr;
  S.ringMesh.instanceMatrix.needsUpdate = true;
  if (S.ringMesh.instanceColor) S.ringMesh.instanceColor.needsUpdate = true;

  // ── Escudos ───────────────────────────────────────────────────────────────
  if (S.playerShield.visible) {
    S.playerShield.position.copy(f.toLocal(ctx.player.position, _v1));
    S.playerShield.quaternion.copy(ctx.player.quaternion);
  }

  // ── Luzes dinâmicas: seguem os dois projéteis mais recentes ───────────────
  let li = 0;
  for (let i = S.projectiles.length - 1; i >= 0 && li < S.lights.length; i--) {
    const b = S.projectiles[i];
    if (!b.active) continue;
    const L = S.lights[li++];
    L.position.copy(f.toLocal(b.pos, _v1));
    L.color.setRGB(clamp(b.r, 0, 1), clamp(b.g, 0, 1), clamp(b.b, 0, 1));
    L.intensity = 900;
  }
  for (; li < S.lights.length; li++) S.lights[li].intensity = 0;
}

/* ==========================================================================
   10. CICLO DE VIDA
   ========================================================================== */

function updateEffects(dt, ctx) {
  for (let i = 0; i < S.glows.length; i++) {
    const g = S.glows[i];
    if (!g.active) continue;
    g.life -= dt;
    if (g.life <= 0) { g.active = false; continue; }
    g.pos.addScaled(g.vel, dt);
    g.vel.multiplyScalar(Math.exp(-1.6 * dt));
    g.size = Math.max(0.05, g.size + g.grow * dt);
  }
  for (let i = 0; i < S.rings.length; i++) {
    const r = S.rings[i];
    if (!r.active) continue;
    r.life -= dt;
    if (r.life <= 0) { r.active = false; continue; }
    r.size += r.grow * dt;
  }
  for (let i = 0; i < S.debris.length; i++) {
    const d = S.debris[i];
    if (!d.active) continue;
    d.life -= dt;
    if (d.life <= 0) { d.active = false; continue; }
    d.pos.addScaled(d.vel, dt);
    _q1.setFromAxisAngle(d.spin, d.spinRate * dt);
    d.quat.multiply(_q1).normalize();
  }
  // Envelhecimento das ondas de escudo.
  if (S.playerShield.visible && !ageImpacts(S.playerImpacts, dt)) S.playerShield.visible = false;
  for (let i = 0; i < S.ships.length; i++) {
    const sh = S.ships[i];
    if (sh.shieldMesh.visible && !ageImpacts(sh.impacts, dt)) sh.shieldMesh.visible = false;
  }
}

function setGroupsVisible(v) {
  for (let i = 0; i < S.astMeshes.length; i++) {
    for (let l = 0; l < 3; l++) S.astMeshes[i][l].visible = v;
  }
  S.projMesh.visible = v;
  S.debrisMesh.visible = v;
  S.glowMesh.visible = v;
  S.ringMesh.visible = v;
}

export async function init(ctx) {
  S.ctx = ctx;
  S.noise = new Noise(ctx.rng.derive('combat-rock', 0).seed);

  makePools(ctx);
  makeShipPool(ctx);
  makeMissilePool(ctx);

  // Depois do rebase as coordenadas relativas viram outras: reescreve na hora.
  ctx.events.on('frame:rebase', () => {
    try { syncTransforms(ctx); } catch (e) { /* degradação graciosa */ }
  });

  S.ready = true;

  ctx.provide(id, {
    /** Nave hostil sob a mira (ou null). */
    get target() { return S.target; },
    get lockProgress() { return S.lockT / LOCK_TIME; },
    get locked() { return S.locked; },
    get hostiles() { return S.ships; },
    get asteroids() { return S.asteroids; },
    get inSpace() { return S.inSpace; },
    get threatCount() { let n = 0; for (const s of S.ships) if (s.active) n++; return n; },
    /** Distância até o alvo travado, para o HUD. */
    targetDistance() { return S.target ? ctx.player.position.distanceTo(S.target.pos) : Infinity; },
    /** Spawn manual (usado por missões e pelo arnês de captura). */
    spawnSquadron: (n) => spawnSquadron(ctx, n),
    /** Ponto de rocha mais próximo ao longo de um raio — para a multi-ferramenta. */
    raycastAsteroid(originWorld, dirVec3, maxDist = 400) {
      let best = null, bestT = maxDist;
      for (let i = 0; i < S.asteroids.length; i++) {
        const a = S.asteroids[i];
        if (!a.active) continue;
        _d1.subVectors(a.pos, originWorld);
        const t = _d1.x * dirVec3.x + _d1.y * dirVec3.y + _d1.z * dirVec3.z;
        if (t < 0 || t > bestT) continue;
        const perp = _d1.lengthSq() - t * t;
        if (perp > a.radius * a.radius) continue;
        bestT = t; best = a;
      }
      return best ? { asteroid: best, distance: bestT, resource: best.ore } : null;
    },
    /** Dano externo (multi-ferramenta, sentinelas). */
    damageAsteroid: (a, dmg, src) => (a && a.active ? damageAsteroid(ctx, a, dmg, src || 'tool') : false),
    damageHostile: (sh, dmg, src) => { if (sh && sh.active) hitShip(ctx, sh, dmg, sh.pos, src || 'tool'); },
    /** Explosão genérica reaproveitável por outros sistemas. */
    burst: (worldPos, scale) => explode(ctx, worldPos, null, scale || 6, false),
    setEnabled(v) { S.enabled = !!v; if (!v) despawnField(); },
  });
}

export function update(dt, ctx) {
  if (!S.ready || !S.enabled) return;

  // ── Porta de espaço ───────────────────────────────────────────────────────
  const alt = ctx.player.altitude;
  const highUp = !Number.isFinite(alt) || alt > SPACE_MIN_ALT;
  const wasSpace = S.inSpace;
  S.inSpace = !ctx.player.inAtmosphere && highUp;

  if (!S.inSpace) {
    // Na superfície o módulo fica quase inerte: só deixa os efeitos morrerem.
    if (wasSpace) {
      despawnField();
      for (let i = 0; i < S.ships.length; i++) if (S.ships[i].active) killShip(ctx, S.ships[i], false);
    }
    updateEffects(dt, ctx);
    S.spaceTime = 0;
    S.waveTimer = WAVE_INTERVAL * 0.45;
    if (ctx.debug.enabled) ctx.debug.set('combate', 'inativo (atmosfera)');
    return;
  }

  S.spaceTime += dt;
  updateField(dt, ctx);

  // ── Encontros ─────────────────────────────────────────────────────────────
  S.waveTimer -= dt * (S.belt ? 1.6 : 1);   // dentro do cinturão há mais pirata
  let live = 0;
  for (let i = 0; i < S.ships.length; i++) if (S.ships[i].active) live++;
  if (S.waveTimer <= 0) {
    S.waveTimer = WAVE_INTERVAL;
    if (live === 0 && S.spaceTime > 12) spawnSquadron(ctx, 0);
  }

  for (let i = 0; i < S.ships.length; i++) {
    const sh = S.ships[i];
    if (sh.active) updateHostile(sh, dt, ctx);
  }

  updateTargeting(dt, ctx);
  updatePlayerWeapons(dt, ctx);
  updateProjectiles(dt, ctx);
  updateMissiles(dt, ctx);
  updateEffects(dt, ctx);
  checkPlayerCollisions(ctx, dt);

  if (ctx.debug.enabled) {
    let na = 0; for (let i = 0; i < S.asteroids.length; i++) if (S.asteroids[i].active) na++;
    ctx.debug.set('combate', `${na} rochas · ${live} hostis · ${S.belt ? 'cinturão' : 'vazio'}`);
    ctx.debug.set('alvo', S.target ? (S.locked ? 'TRAVADO' : 'mirando') : '—');
  }
}

export function lateUpdate(dt, ctx) {
  if (!S.ready || !S.enabled) return;
  setGroupsVisible(true);
  syncTransforms(ctx);
}

export function dispose(ctx) {
  if (!S.root) return;
  S.root.traverse((o) => {
    if (o.geometry) o.geometry.dispose?.();
    if (o.material) {
      if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose?.());
      else o.material.dispose?.();
    }
  });
  S.texGlow?.dispose();
  S.texRing?.dispose();
  ctx.engine.scene.remove(S.root);
  S.ready = false;
}
