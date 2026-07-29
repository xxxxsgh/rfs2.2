import * as THREE from 'three';
import { hexToLinear } from '../planet/biomes.js';

/**
 * NUVENS VOLUMÉTRICAS — módulo `clouds` (order 41).
 *
 * ── Por que uma CASCA ESFÉRICA e não um plano ───────────────────────────────
 * O critério visual §8.1 diz que a silhueta reta denuncia o protótipo. Um
 * "cloud plane" resolve o caso do jogador a pé e destrói o caso da órbita: as
 * nuvens ficam paradas num plano infinito enquanto o planeta curva embaixo.
 * Aqui a densidade só existe entre duas esferas concêntricas ao corpo
 * (raio+altitude e raio+altitude+espessura). O mesmo shader serve para os dois
 * casos porque o segmento marchado sai de uma interseção raio-esfera analítica:
 * de dentro, começa ao atravessar a base; de fora, começa no topo e termina no
 * solo. Da órbita as nuvens acompanham a curvatura porque ELAS SÃO a curvatura.
 *
 * ── Modelo de densidade (Schneider / Horizon Zero Dawn) ─────────────────────
 * densidade = remap(remap(perlin-worley, fbmWorley-1, 1), 1-cobertura, 1)
 * modulada pelo perfil vertical e erodida por um segundo ruído de alta
 * frequência. As duas texturas 3D (128³ de forma e 32³ de detalhe) são geradas
 * em runtime — o repositório não carrega asset binário (§2.5). O Worley é
 * PERIÓDICO (índice de célula tomado módulo N), senão a repetição da textura
 * costuraria uma grade visível de 12 km no céu.
 *
 * ── Onde o custo foi cortado ────────────────────────────────────────────────
 * O ambiente de referência roda sob SwiftShader a poucos fps. Três decisões:
 *   1. Meia resolução + reprojeção temporal. Com a câmera parada (que é o caso
 *      das capturas) o histórico converge em ~20 frames e a imagem final tem
 *      qualidade de muitos mais passos do que os que rodam por frame.
 *   2. Passo GEOMÉTRICO: perto ele vale ~120 m, longe cresce, de modo que 48
 *      passos cobrem 80 km em vez de 6 km. Sem isso o horizonte fica vazio.
 *   3. Degradação automática: se o frame estoura, `uSteps` cai e a escala
 *      interna encolhe, sem recompilar shader (o laço tem limite fixo e sai
 *      por `break`).
 *
 * ── Composição ─────────────────────────────────────────────────────────────
 * O postfx não expõe gancho para inserir um passe no meio da cadeia, então a
 * composição é feita por um quad transparente na própria `engine.scene`, com
 * renderOrder 1150 — depois de tudo que é sólido e ANTES da casca de atmosfera
 * do módulo `sky` (1200), para que a perspectiva aérea lave as nuvens distantes
 * junto com o resto do mundo. `ctx.clouds.composite()` faz o mesmo à mão para
 * quem preferir consumir o buffer diretamente.
 */

export const id = 'clouds';
export const order = 41;

// ── Constantes de sintonia ──────────────────────────────────────────────────

/** Lado da textura 3D de forma. 128³ RGBA = 8 MB; 64³ = 1 MB e é o que cabe
 *  no orçamento de geração em CPU sem travar o boot por segundos. */
const SHAPE_SIZE = 64;
const DETAIL_SIZE = 32;

/** Período de repetição das texturas no mundo, em metros. Os três valores são
 *  múltiplos entre si para que o deslocamento do vento possa ser embrulhado
 *  numa única constante sem descasar as camadas. */
const WEATHER_TILE = 51200;
const SHAPE_TILE = 12800;
const DETAIL_TILE = 800;

/** Extinção por metro na densidade máxima. Ajustado para que ~200 m de nuvem
 *  cheia já sejam opacos, que é o que o olho espera de um cúmulo. */
const SIGMA = 0.018;
/** Albedo de espalhamento simples. Nuvem é quase branca: quase tudo volta. */
const ALBEDO = 0.92;

/** Alcance máximo da marcha. Além disso a névoa aérea do terreno domina. */
const MAX_DIST = 90000;

/** Tamanho do mapa de sombra projetado no chão e sua extensão em metros. */
const SHADOW_SIZE = 128;
const SHADOW_EXTENT = 6000;
const SHADOW_EVERY = 8;

// ── Escratch de módulo (zero alocação por frame) ────────────────────────────

const _center = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _camFwd = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _east = new THREE.Vector3(1, 0, 0);
const _north = new THREE.Vector3(0, 0, 1);
const _tmp = new THREE.Vector3();
const _wind = new THREE.Vector3();
const _viewProj = new THREE.Matrix4();
const _shift = new THREE.Matrix4();
const _prevCam = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _lin = new THREE.Color();

const S = {
  ctx: null,
  ready: false,
  active: false,

  shapeTex: null,
  detailTex: null,

  rtA: null, rtB: null,
  shadowRT: null,
  width: 0, height: 0,
  scale: 0.5,

  quad: null,          // triângulo de tela cheia para os passes fora da cena
  quadScene: null,
  quadCam: null,
  marchMat: null,
  shadowMat: null,
  compositeMat: null,
  compositeMesh: null,

  prevViewProj: new THREE.Matrix4(),
  historyValid: false,
  externalComposite: false,

  body: null,
  bodyId: null,
  cover: 0,
  windOffset: new THREE.Vector3(),
  shadowMatrix: new THREE.Matrix4(),
  shadowTick: 0,

  steps: 48,
  stepsWanted: 48,
  degradeTimer: 0,
  lastMs: 0,
  unsubRebase: null,
};

// ────────────────────────────────────────────────────────────────────────────
// GLSL
// ────────────────────────────────────────────────────────────────────────────

/** Vértice comum dos passes de tela cheia. As posições já vêm em clip space. */
const FS_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Bloco compartilhado entre a marcha principal e o mapa de sombra. Manter uma
 * única definição da densidade é o que garante que a sombra no chão bata com a
 * nuvem que a projeta — duplicar a fórmula é o caminho mais curto para uma
 * sombra que "desliza" em relação à nuvem.
 */
const CLOUD_COMMON = /* glsl */`
precision highp float;
precision highp sampler3D;

uniform sampler3D tShape;
uniform sampler3D tDetail;

uniform vec3 uCenter;
uniform float uRi;
uniform float uThick;
uniform float uCoverage;
uniform float uSigma;
uniform float uShapeScale;
uniform float uDetailScale;
uniform float uWeatherScale;
uniform float uAnvil;
uniform vec3 uWindOffset;
uniform vec3 uSunDir;

float saturate1(float v) { return clamp(v, 0.0, 1.0); }

/** remap com clamp — o operador básico do modelo de Schneider. */
float remap01(float v, float lo, float hi) {
  return clamp((v - lo) / max(hi - lo, 1e-5), 0.0, 1.0);
}

/**
 * Segmento útil do raio dentro da casca [ri, ro], em coordenadas relativas ao
 * centro do planeta. Devolve (tIni, tFim); tFim < tIni significa "não cruza".
 *
 * Os três casos que importam: câmera ABAIXO da base (a pé — começa ao sair da
 * esfera interna), DENTRO da casca (voo — começa em 0) e ACIMA (órbita — entra
 * pelo topo e para na base ou no outro lado do topo, que é o limbo).
 */
vec2 shellSegment(vec3 oc, vec3 rd, float ri, float ro) {
  float b = dot(oc, rd);
  float cc = dot(oc, oc);
  float dO = b * b - (cc - ro * ro);
  if (dO < 0.0) return vec2(1.0, -1.0);
  float sO = sqrt(dO);
  float t0o = -b - sO, t1o = -b + sO;
  if (t1o < 0.0) return vec2(1.0, -1.0);

  float dI = b * b - (cc - ri * ri);
  float tS, tE;
  if (dI < 0.0) { tS = t0o; tE = t1o; }
  else {
    float sI = sqrt(dI);
    float t0i = -b - sI, t1i = -b + sI;
    if (t0i > 0.0) { tS = t0o; tE = t0i; }        // entra pelo topo, para na base
    else if (t1i > 0.0) { tS = t1i; tE = t1o; }   // observador abaixo da base
    else { tS = t0o; tE = t1o; }
  }
  return vec2(max(tS, 0.0), tE);
}

/**
 * Mapa de tempo: cobertura local e "tipo" (quanto o topo pode subir).
 * É um fBm 3D amostrado SOBRE A ESFERA, não uma textura 2D projetada — assim
 * não há costura nos polos nem esticamento perto deles.
 */
vec2 weatherAt(vec3 w) {
  vec3 q = (w + uWindOffset) * uWeatherScale;
  vec4 s = texture(tShape, q);
  float m = s.r * 0.7 + s.g * 0.3;
  // Janela ESTREITA e deslizante em vez de um limiar: dentro de uma mesma cena
  // a cobertura local vai de 0 a 1, que é o que separa "céu com nuvens" de
  // "céu uniformemente leitoso". `uCoverage` só move a janela.
  float cov = remap01(m, 0.88 - uCoverage * 0.75, 1.16 - uCoverage * 0.75);
  return vec2(cov, s.b);
}

/**
 * Perfil vertical: base plana (a condensação começa numa altitude bem definida)
 * e topo em couve-flor, cuja altura cresce com a cobertura — é o que diferencia
 * um estrato fino de um cúmulo de bom tempo no mesmo campo de nuvens.
 */
float heightProfile(float h, float cov, float type) {
  float top = mix(0.42, 1.0, saturate1(cov * (0.45 + 0.55 * type) * uAnvil));
  float base = smoothstep(0.0, 0.09, h);
  float apex = 1.0 - smoothstep(top * 0.55, top, h);
  return saturate1(base * apex);
}

float densityAt(vec3 w, float h, vec2 wx, bool useDetail) {
  vec4 s = texture(tShape, (w + uWindOffset) * uShapeScale);
  float fbmW = s.g * 0.625 + s.b * 0.25 + s.a * 0.125;
  // remap clássico: o fBm de Worley esculpe bolhas dentro do perlin-worley.
  float shape = remap01(s.r, fbmW - 1.0, 1.0);
  shape *= heightProfile(h, wx.x, wx.y);
  float d = remap01(shape, 1.0 - wx.x, 1.0) * wx.x;
  if (useDetail && d > 0.0) {
    vec4 dt = texture(tDetail, (w + uWindOffset * 1.3) * uDetailScale);
    float dfbm = dt.r * 0.625 + dt.g * 0.25 + dt.b * 0.125;
    // Em baixo o vento cisalha em fiapos (billow invertido); em cima a erosão
    // é arredondada. É essa inversão que dá a base esfarrapada do cúmulo.
    float m = mix(1.0 - dfbm, dfbm, saturate1(h * 3.0));
    float k = m * 0.28 * (1.0 - h * 0.5);
    d = remap01(d, k, 1.0);
  }
  return d;
}
`;

const MARCH_FRAG = /* glsl */`
varying vec2 vUv;

uniform sampler2D tDepth;
uniform sampler2D tHistory;

uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform vec2 uProjRay;
uniform float uLogFC;
uniform vec2 uNearFar;

uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uAmbientGround;
uniform vec2 uHG;
uniform float uSilver;
uniform float uPowder;
uniform float uAlbedo;
uniform float uBaseStep;
uniform float uStepGrow;
uniform float uMaxDist;
uniform float uLightStep;
uniform int uSteps;
uniform float uFrame;
uniform float uDetailOn;
uniform float uHistoryBlend;
uniform mat4 uPrevViewProj;

#define MAX_STEPS 96

/** Profundidade da cena. O engine liga logarithmicDepthBuffer: o valor gravado
 *  é log2(1+w)/log2(far+1), não o z de NDC. */
float eyeDepthAt(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  if (uLogFC > 0.0) return exp2(d * uLogFC) - 1.0;
  float z = d * 2.0 - 1.0;
  return (2.0 * uNearFar.x * uNearFar.y) /
         (uNearFar.y + uNearFar.x - z * (uNearFar.y - uNearFar.x));
}

/** Ruído de gradiente intercalado (Jimenez): estável na tela e sem textura. */
float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

float hg(float c, float g) {
  float g2 = g * g;
  float den = 1.0 + g2 - 2.0 * g * c;
  return (1.0 - g2) / (12.5663706 * den * sqrt(max(den, 1e-4)));
}

/** Transmitância acumulada até o sol, em 6 amostras de passo crescente. */
float lightMarch(vec3 w, vec2 wx) {
  float acc = 0.0;
  float t = 0.0;
  float st = uLightStep;
  for (int i = 0; i < 6; i++) {
    t += st;
    vec3 p = w + uSunDir * t;
    float h = (length(p) - uRi) / uThick;
    if (h > 0.0 && h < 1.0) acc += densityAt(p, h, wx, false) * st;
    st *= 1.9;   // cone que se abre: barato e capta a sombra distante
  }
  return acc;
}

/**
 * Energia que chega do sol a uma amostra. Três "oitavas" de espalhamento
 * múltiplo (Schneider): cada uma com metade da extinção e metade da
 * anisotropia. É o truque que devolve o interior luminoso da nuvem sem marchar
 * espalhamento múltiplo de verdade — e é ele que produz o silver lining.
 */
float sunEnergy(float dl, float c) {
  float e = 0.0;
  float a = 1.0, b = 1.0, k = 1.0;
  for (int i = 0; i < 3; i++) {
    // O pico frontal de Henyey-Greenstein com g=0.82 chega a ~57x o isotrópico;
    // sem teto, os poucos pixels ao redor do sol saturam o bloom e o quadro
    // inteiro vira leite. O teto preserva o contorno em fogo e corta o excesso.
    float ph = min(mix(hg(c, uHG.x * k), hg(c, uHG.y * k), 0.5) * 12.5663706, 8.0);
    e += a * exp(-dl * b) * ph;
    a *= 0.55; b *= 0.5; k *= 0.5;
  }
  // Powder: a borda fina voltada para a luz é ESCURA, não clara — sem isto a
  // nuvem parece algodão chapado.
  float pw = 1.0 - exp(-dl * 2.0);
  e *= mix(1.0, 0.25 + 1.5 * pw, uPowder);
  // Pico frontal estreito: o contorno em fogo quando o sol está atrás.
  e += uSilver * exp(-dl * 0.30) * pow(max(c, 0.0), 14.0);
  return e;
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 rd = normalize(uCamFwd + uCamRight * (ndc.x * uProjRay.x) + uCamUp * (ndc.y * uProjRay.y));
  vec3 oc = uCamPos - uCenter;
  float ro = uRi + uThick;

  vec2 seg = shellSegment(oc, rd, uRi, ro);
  vec4 cur = vec4(0.0, 0.0, 0.0, 1.0);

  if (seg.y > seg.x) {
    float cosF = max(dot(rd, uCamFwd), 1e-3);
    // A profundidade disponível aqui é a do frame ANTERIOR (a cena deste frame
    // ainda não foi desenhada). Um frame de atraso na oclusão contra a montanha
    // é invisível; esperar o passe da cena custaria um passe inteiro a mais.
    float sceneDist = eyeDepthAt(vUv) / cosF;
    float tEnd = min(min(seg.y, sceneDist), uMaxDist);

    float jitter = ign(gl_FragCoord.xy + vec2(uFrame * 5.588, uFrame * 3.117));
    float t = seg.x + jitter * uBaseStep;
    float T = 1.0;
    vec3 scat = vec3(0.0);
    float tRef = -1.0;
    float cosT = dot(rd, uSunDir);

    for (int i = 0; i < MAX_STEPS; i++) {
      if (i >= uSteps || t > tEnd || T < 0.015) break;
      float st = uBaseStep + t * uStepGrow;
      vec3 w = uCamPos + rd * t - uCenter;
      float h = (length(w) - uRi) / uThick;
      if (h > 0.0 && h < 1.0) {
        vec2 wx = weatherAt(w);
        if (wx.x > 0.01) {
          float d = densityAt(w, h, wx, uDetailOn > 0.5);
          if (d > 0.002) {
            if (tRef < 0.0) tRef = t;
            vec3 lum = mix(uAmbientGround, uAmbient, h);
            // A marcha de luz é o item mais caro do laço. Depois que a
            // transmitância cai abaixo de ~12% o que vem de trás contribui com
            // menos de um degrau de exposição: ali só o ambiente basta, e o
            // interior de uma nuvem densa deixa de custar 6 amostras por passo.
            if (T > 0.12) {
              float dl = lightMarch(w, wx) * uSigma;
              lum += uSunColor * sunEnergy(dl, cosT);
            }
            float tr = exp(-d * uSigma * st);
            scat += T * lum * uAlbedo * (1.0 - tr);
            T *= tr;
          }
        }
      }
      t += st;
    }

    // Desvanecimento no limite da marcha: um corte duro seria um anel visível.
    float fade = 1.0 - smoothstep(uMaxDist * 0.7, uMaxDist, max(tRef, seg.x));
    cur = vec4(scat * fade, mix(1.0, T, fade));

    // ── Reprojeção temporal ────────────────────────────────────────────────
    if (uHistoryBlend > 0.0 && tRef > 0.0) {
      vec4 cp = uPrevViewProj * vec4(uCamPos + rd * tRef, 1.0);
      if (cp.w > 1e-4) {
        vec2 puv = cp.xy / cp.w * 0.5 + 0.5;
        if (puv.x > 0.002 && puv.x < 0.998 && puv.y > 0.002 && puv.y < 0.998) {
          // Rejeição por profundidade: se naquele pixel havia geometria mais
          // perto que a nuvem, o histórico pertence a outra superfície e
          // reaproveitá-lo produz o rastro clássico ao redor das montanhas.
          float pd = eyeDepthAt(puv) / cosF;
          if (pd > tRef * 0.85) {
            cur = mix(cur, texture2D(tHistory, puv), uHistoryBlend);
          }
        }
      }
    }
  }

  gl_FragColor = cur;
}
`;

const SHADOW_FRAG = /* glsl */`
varying vec2 vUv;
uniform vec3 uShadowOrigin;
uniform vec3 uShadowX;
uniform vec3 uShadowY;

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  vec3 w = uShadowOrigin + uShadowX * p.x + uShadowY * p.y - uCenter;
  vec2 seg = shellSegment(w, uSunDir, uRi, uRi + uThick);
  float T = 1.0;
  if (seg.y > seg.x) {
    float st = (seg.y - seg.x) / 6.0;
    for (int i = 0; i < 6; i++) {
      vec3 q = w + uSunDir * (seg.x + st * (float(i) + 0.5));
      float h = (length(q) - uRi) / uThick;
      if (h > 0.0 && h < 1.0) {
        vec2 wx = weatherAt(q);
        T *= exp(-densityAt(q, h, wx, false) * uSigma * st);
      }
    }
  }
  gl_FragColor = vec4(T, T, T, 1.0);
}
`;

const COMPOSITE_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const COMPOSITE_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tClouds;
void main() {
  vec4 c = texture2D(tClouds, vUv);
  // Pré-multiplicado: dst = espalhamento + dst * transmitância.
  gl_FragColor = vec4(max(c.rgb, 0.0), clamp(c.a, 0.0, 1.0));
}
`;

// ────────────────────────────────────────────────────────────────────────────
// Geração das texturas 3D
// ────────────────────────────────────────────────────────────────────────────

/**
 * Tabela de pontos de característica para Worley PERIÓDICO. Um ponto por
 * célula; o índice é tomado módulo n na hora da busca, então a textura casa
 * consigo mesma nas seis faces e a repetição no céu fica invisível.
 */
function pointTable(rng, n) {
  const t = new Float32Array(n * n * n * 3);
  for (let i = 0; i < t.length; i++) t[i] = rng.float();
  return t;
}

/** Tabela de valores para ruído de valor periódico. */
function valueTable(rng, n) {
  const t = new Float32Array(n * n * n);
  for (let i = 0; i < t.length; i++) t[i] = rng.float();
  return t;
}

/** Worley F1 periódico. Entrada em [0,1); saída em [0,1] (0 = no ponto). */
function worley01(x, y, z, n, tbl) {
  const fx = x * n, fy = y * n, fz = z * n;
  const xi = Math.floor(fx), yi = Math.floor(fy), zi = Math.floor(fz);
  let best = 1e9;
  for (let dz = -1; dz <= 1; dz++) {
    const cz = zi + dz, wz = ((cz % n) + n) % n;
    for (let dy = -1; dy <= 1; dy++) {
      const cy = yi + dy, wy = ((cy % n) + n) % n;
      const row = (wz * n + wy) * n;
      for (let dx = -1; dx <= 1; dx++) {
        const cx = xi + dx, wx = ((cx % n) + n) % n;
        const o = (row + wx) * 3;
        const ex = cx + tbl[o] - fx;
        const ey = cy + tbl[o + 1] - fy;
        const ez = cz + tbl[o + 2] - fz;
        const d = ex * ex + ey * ey + ez * ez;
        if (d < best) best = d;
      }
    }
  }
  return Math.min(1, Math.sqrt(best));
}

function fade5(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

/** Ruído de valor periódico, interpolação quíntica. */
function value01(x, y, z, n, tbl) {
  const fx = x * n, fy = y * n, fz = z * n;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
  const tx = fade5(fx - x0), ty = fade5(fy - y0), tz = fade5(fz - z0);
  const ax = ((x0 % n) + n) % n, bx = (ax + 1) % n;
  const ay = ((y0 % n) + n) % n, by = (ay + 1) % n;
  const az = ((z0 % n) + n) % n, bz = (az + 1) % n;
  const n2 = n * n;
  const c000 = tbl[az * n2 + ay * n + ax], c100 = tbl[az * n2 + ay * n + bx];
  const c010 = tbl[az * n2 + by * n + ax], c110 = tbl[az * n2 + by * n + bx];
  const c001 = tbl[bz * n2 + ay * n + ax], c101 = tbl[bz * n2 + ay * n + bx];
  const c011 = tbl[bz * n2 + by * n + ax], c111 = tbl[bz * n2 + by * n + bx];
  const x00 = c000 + (c100 - c000) * tx, x10 = c010 + (c110 - c010) * tx;
  const x01 = c001 + (c101 - c001) * tx, x11 = c011 + (c111 - c011) * tx;
  const y0v = x00 + (x10 - x00) * ty, y1v = x01 + (x11 - x01) * ty;
  return y0v + (y1v - y0v) * tz;
}

/**
 * Gera as duas texturas 3D fatiando o trabalho por orçamento de tempo.
 * Um laço único de 262 mil voxels travaria o boot por meio segundo (§2.3).
 */
async function buildTextures(ctx) {
  const rng = ctx.rng.derive('clouds:noise', 0);
  const w4 = pointTable(rng, 4), w8 = pointTable(rng, 8), w16 = pointTable(rng, 16);
  const v4 = valueTable(rng, 4), v8 = valueTable(rng, 8), v16 = valueTable(rng, 16);

  const N = SHAPE_SIZE;
  const shape = new Uint8Array(N * N * N * 4);
  const D = DETAIL_SIZE;
  const detail = new Uint8Array(D * D * D * 4);

  let z = 0;
  while (z < N) {
    const t0 = performance.now();
    while (z < N && performance.now() - t0 < 7) {
      const zf = z / N;
      for (let y = 0; y < N; y++) {
        const yf = y / N;
        for (let x = 0; x < N; x++) {
          const xf = x / N;
          const a = 1 - worley01(xf, yf, zf, 4, w4);
          const b = 1 - worley01(xf, yf, zf, 8, w8);
          const c = 1 - worley01(xf, yf, zf, 16, w16);
          const wf = a * 0.625 + b * 0.25 + c * 0.125;
          const p = value01(xf, yf, zf, 4, v4) * 0.55
                  + value01(xf, yf, zf, 8, v8) * 0.3
                  + value01(xf, yf, zf, 16, v16) * 0.15;
          // Perlin-worley: o valor contínuo ganha os "buracos" do celular.
          const lo = wf - 1;
          const pw = Math.max(0, Math.min(1, (p - lo) / (1 - lo)));
          const o = ((z * N + y) * N + x) * 4;
          shape[o] = pw * 255;
          shape[o + 1] = a * 255;
          shape[o + 2] = b * 255;
          shape[o + 3] = c * 255;
        }
      }
      z++;
    }
    await new Promise((r) => requestAnimationFrame(r));
  }

  let dz = 0;
  while (dz < D) {
    const t0 = performance.now();
    while (dz < D && performance.now() - t0 < 7) {
      const zf = dz / D;
      for (let y = 0; y < D; y++) {
        const yf = y / D;
        for (let x = 0; x < D; x++) {
          const xf = x / D;
          const o = ((dz * D + y) * D + x) * 4;
          detail[o] = (1 - worley01(xf, yf, zf, 4, w4)) * 255;
          detail[o + 1] = (1 - worley01(xf, yf, zf, 8, w8)) * 255;
          detail[o + 2] = (1 - worley01(xf, yf, zf, 16, w16)) * 255;
          detail[o + 3] = 255;
        }
      }
      dz++;
    }
    await new Promise((r) => requestAnimationFrame(r));
  }

  S.shapeTex = make3D(shape, N);
  S.detailTex = make3D(detail, D);
}

function make3D(data, n) {
  const t = new THREE.Data3DTexture(data, n, n, n);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.wrapR = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

// ────────────────────────────────────────────────────────────────────────────
// Recursos de render
// ────────────────────────────────────────────────────────────────────────────

function fullscreenGeometry() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(
    new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(
    new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return g;
}

function makeTarget(w, h, type) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), {
    type,
    format: THREE.RGBAFormat,
    colorSpace: THREE.LinearSRGBColorSpace,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    samples: 0,
  });
  rt.texture.name = 'clouds';
  return rt;
}

/** Uniformes compartilhados entre a marcha e a sombra: um só lugar para
 *  escrever por frame. */
function sharedUniforms() {
  return {
    tShape: { value: null },
    tDetail: { value: null },
    uCenter: { value: new THREE.Vector3() },
    uRi: { value: 2600 },
    uThick: { value: 3900 },
    uCoverage: { value: 0.5 },
    uSigma: { value: SIGMA },
    uShapeScale: { value: 1 / SHAPE_TILE },
    uDetailScale: { value: 1 / DETAIL_TILE },
    uWeatherScale: { value: 1 / WEATHER_TILE },
    uAnvil: { value: 1 },
    uWindOffset: { value: new THREE.Vector3() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Ciclo de vida
// ────────────────────────────────────────────────────────────────────────────

export async function init(ctx) {
  S.ctx = ctx;

  ctx.progress?.(0.63, 'gerando ruído volumétrico…');
  await buildTextures(ctx);

  const shared = sharedUniforms();
  shared.tShape.value = S.shapeTex;
  shared.tDetail.value = S.detailTex;

  S.quad = new THREE.Mesh(fullscreenGeometry(), null);
  S.quad.frustumCulled = false;
  S.quad.matrixAutoUpdate = false;
  S.quadScene = new THREE.Scene();
  S.quadScene.add(S.quad);
  S.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  S.marchMat = new THREE.ShaderMaterial({
    uniforms: Object.assign(shared, {
      tDepth: { value: null },
      tHistory: { value: null },
      uCamPos: { value: new THREE.Vector3() },
      uCamRight: { value: new THREE.Vector3(1, 0, 0) },
      uCamUp: { value: new THREE.Vector3(0, 1, 0) },
      uCamFwd: { value: new THREE.Vector3(0, 0, -1) },
      uProjRay: { value: new THREE.Vector2(1, 1) },
      uLogFC: { value: 0 },
      uNearFar: { value: new THREE.Vector2(0.05, 8e6) },
      uSunColor: { value: new THREE.Vector3(3, 3, 3) },
      uAmbient: { value: new THREE.Vector3(0.2, 0.25, 0.4) },
      uAmbientGround: { value: new THREE.Vector3(0.05, 0.05, 0.05) },
      uHG: { value: new THREE.Vector2(0.82, -0.32) },
      uSilver: { value: 1.6 },
      uPowder: { value: 1 },
      uAlbedo: { value: ALBEDO },
      uBaseStep: { value: 120 },
      uStepGrow: { value: 0.08 },
      uMaxDist: { value: MAX_DIST },
      uLightStep: { value: 60 },
      uSteps: { value: 48 },
      uFrame: { value: 0 },
      uDetailOn: { value: 1 },
      uHistoryBlend: { value: 0 },
      uPrevViewProj: { value: new THREE.Matrix4() },
    }),
    vertexShader: FS_VERT,
    fragmentShader: CLOUD_COMMON + MARCH_FRAG,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    toneMapped: false,
    fog: false,
    lights: false,
  });

  // O passe de sombra reaproveita os MESMOS objetos de uniforme compartilhados
  // (mesma referência, não cópia): escrever no material de marcha já atualiza
  // este, o que elimina a classe de bug "sombra de outro frame".
  const shadowUniforms = {};
  for (const k in shared) shadowUniforms[k] = shared[k];
  shadowUniforms.uShadowOrigin = { value: new THREE.Vector3() };
  shadowUniforms.uShadowX = { value: new THREE.Vector3(1, 0, 0) };
  shadowUniforms.uShadowY = { value: new THREE.Vector3(0, 0, 1) };

  S.shadowMat = new THREE.ShaderMaterial({
    uniforms: shadowUniforms,
    vertexShader: FS_VERT,
    fragmentShader: CLOUD_COMMON + SHADOW_FRAG,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    toneMapped: false,
    fog: false,
    lights: false,
  });

  S.compositeMat = new THREE.ShaderMaterial({
    uniforms: { tClouds: { value: null } },
    vertexShader: COMPOSITE_VERT,
    fragmentShader: COMPOSITE_FRAG,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
    fog: false,
    lights: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.SrcAlphaFactor,     // dst *= transmitância
    blendEquation: THREE.AddEquation,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    blendEquationAlpha: THREE.AddEquation,
  });

  S.compositeMesh = new THREE.Mesh(fullscreenGeometry(), S.compositeMat);
  S.compositeMesh.name = 'clouds:composite';
  S.compositeMesh.frustumCulled = false;
  S.compositeMesh.matrixAutoUpdate = false;
  // Depois de tudo que é sólido, antes da casca de atmosfera do `sky` (1200).
  S.compositeMesh.renderOrder = 1150;
  S.compositeMesh.visible = false;
  ctx.engine.scene.add(S.compositeMesh);

  S.shadowRT = makeTarget(SHADOW_SIZE, SHADOW_SIZE, THREE.UnsignedByteType);

  const q = ctx.quality || {};
  S.stepsWanted = Math.max(16, Math.min(96, q.cloudSteps || 48));
  // Começa abaixo do alvo e SOBE se o frame aguentar. O contrário — começar
  // alto e cair — custa vários frames de meio segundo logo no boot, que é
  // exatamente quando o jogador está olhando a tela pela primeira vez.
  S.steps = Math.min(S.stepsWanted, 40);
  S.scale = 0.5;

  // O rebase move a origem do espaço de render; a matriz do frame anterior foi
  // construída no referencial antigo. Compensar é uma translação — não
  // compensar produz um rastro de quilômetros na reprojeção.
  S.unsubRebase = ctx.events.on('frame:rebase', (p) => {
    const s = p && p.shift;
    if (!s) { S.historyValid = false; return; }
    const mag = Math.abs(s.x) + Math.abs(s.y) + Math.abs(s.z);
    if (!Number.isFinite(mag) || mag > 5e4) { S.historyValid = false; return; }
    _shift.makeTranslation(s.x, s.y, s.z);
    S.prevViewProj.multiply(_shift);
  });

  S.ready = true;
  syncBody(ctx, true);
  ctx.provide(id, api);
  ctx.progress?.(0.66, 'nuvens volumétricas prontas');
}

// ────────────────────────────────────────────────────────────────────────────
// Update
// ────────────────────────────────────────────────────────────────────────────

export function update(dt, ctx) {
  if (!S.ready) return;
  syncBody(ctx, false);
  if (!S.active) return;

  // Advecção: o deslocamento acumula em METROS e é embrulhado no período do
  // mapa de tempo (múltiplo de todos os outros), senão a precisão de float32
  // do shader se perde em minutos de sessão.
  readWind(ctx, _wind);
  S.windOffset.addScaledVector(_wind, -dt);
  S.windOffset.x %= WEATHER_TILE;
  S.windOffset.y %= WEATHER_TILE;
  S.windOffset.z %= WEATHER_TILE;

  adaptQuality(dt, ctx);
}

export function lateUpdate(dt, ctx) {
  if (!S.ready) return;
  if (!S.active) {
    if (S.compositeMesh) S.compositeMesh.visible = false;
    return;
  }
  try {
    render(ctx);
  } catch (e) {
    // Uma falha de render não pode custar o frame ao jogador.
    S.active = false;
    if (S.compositeMesh) S.compositeMesh.visible = false;
    ctx.debug?.set?.('clouds.erro', (e && e.message) || String(e));
  }
}

/** Reage à troca de planeta/bioma e decide se o módulo roda neste frame. */
function syncBody(ctx, force) {
  const body = ctx.planet?.current || null;
  const bid = body ? (body.id ?? body.name ?? 'body') : null;
  const q = ctx.quality || {};

  if (force || bid !== S.bodyId) {
    S.body = body;
    S.bodyId = bid;
    S.historyValid = false;

    const sky = body?.biome?.sky;
    const alt = sky?.cloudAltitude || 0;
    const u = S.marchMat.uniforms;
    u.uRi.value = (body?.radius || 150000) + Math.max(400, alt);
    // Espessura ~1,5x a altitude da base: é o que põe o topo dos cúmulos por
    // volta de 2,5x a base, a proporção real de uma célula de convecção.
    u.uThick.value = Math.max(700, Math.min(9000, alt * 1.5));
    S.cover = sky?.cloudCover ?? 0;

    const tint = sky?.cloudColor !== undefined ? hexToLinear(sky.cloudColor) : [1, 1, 1];
    _lin.setRGB(tint[0], tint[1], tint[2]);
  }

  const wantCover = Math.min(1, S.cover + (ctx.weather?.cloudBoost || 0));
  const was = S.active;
  S.active = !!S.body
    && q.volumetricClouds !== false
    && wantCover > 0.02
    && (S.body.biome?.sky?.cloudAltitude || 0) > 0;
  // Voltar a ligar depois de desligado: o histórico e a matriz de reprojeção
  // são de um frame antigo e produziriam um rastro na primeira imagem.
  if (S.active && !was) S.historyValid = false;

  if (S.marchMat) S.marchMat.uniforms.uCoverage.value = wantCover;
}

/** Vento do módulo `weather`, com um fallback lento e determinístico. */
function readWind(ctx, out) {
  const w = ctx.weather?.wind;
  if (w && Number.isFinite(w.x) && (w.x || w.y || w.z)) return out.copy(w);
  // Sem clima: uma deriva zonal suave para que o céu nunca fique congelado.
  const t = ctx.time.elapsed * 0.01;
  return out.set(Math.cos(t) * 9, 0, Math.sin(t) * 9);
}

/**
 * Degradação automática. O orçamento é medido no frame INTEIRO (engine.stats),
 * não no módulo: o que importa para o jogador é o frame, e as nuvens são o
 * item mais caro e mais fácil de encolher.
 */
function adaptQuality(dt, ctx) {
  S.degradeTimer -= dt;
  if (S.degradeTimer > 0) return;
  S.degradeTimer = 1.5;

  const ms = ctx.engine.stats.frameMs || 16;
  if (ms > 140 && S.steps > 20) {
    S.steps = Math.max(20, Math.round(S.steps * 0.75));
  } else if (ms > 320 && S.scale > 0.4) {
    // Último recurso. A escala interna mexe na nitidez da silhueta, então só
    // cai quando cortar passos já não resolveu.
    S.scale = 0.4;
    S.historyValid = false;
  } else if (ms < 55 && S.steps < S.stepsWanted) {
    S.steps = Math.min(S.stepsWanted, S.steps + 6);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Render
// ────────────────────────────────────────────────────────────────────────────

function render(ctx) {
  const engine = ctx.engine;
  const renderer = engine.renderer;
  const cam = engine.camera;
  const u = S.marchMat.uniforms;

  syncSize(engine);

  // ── Geometria da câmera e do planeta ─────────────────────────────────────
  ctx.frame.toLocal(S.body.center, _center);
  u.uCenter.value.copy(_center);
  _camPos.copy(cam.position);
  u.uCamPos.value.copy(_camPos);
  cam.matrixWorld.extractBasis(_camRight, _camUp, _tmp);
  u.uCamRight.value.copy(_camRight);
  u.uCamUp.value.copy(_camUp);
  _camFwd.copy(_tmp).negate();             // three olha para -Z
  u.uCamFwd.value.copy(_camFwd);

  const tanHalf = Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5);
  u.uProjRay.value.set(tanHalf * cam.aspect, tanHalf);
  u.uNearFar.value.set(cam.near, cam.far);
  u.uLogFC.value = renderer.capabilities.logarithmicDepthBuffer ? Math.log2(cam.far + 1) : 0;
  u.tDepth.value = engine.sceneTarget.depthTexture || null;

  // ── Iluminação ───────────────────────────────────────────────────────────
  const sky = ctx.sky;
  const sun = sky?.sunDirection;
  if (sun) u.uSunDir.value.copy(sun);
  const inten = (sky?.sunIntensity ?? 3.0);
  const sc = sky?.sunColor;
  // Irradiância → radiância (÷π) com um ganho artístico: a borda contra o sol
  // precisa passar do limiar do bloom, é a imagem-assinatura do módulo.
  const k = (inten / Math.PI) * 2.4;
  u.uSunColor.value.set(
    (sc ? sc.r : 1) * _lin.r * k,
    (sc ? sc.g : 1) * _lin.g * k,
    (sc ? sc.b : 1) * _lin.b * k,
  );
  const at = sky?.ambientTop, ab = sky?.ambientBottom;
  u.uAmbient.value.set(
    (at ? at.r : 0.15) * 0.55, (at ? at.g : 0.2) * 0.55, (at ? at.b : 0.3) * 0.55);
  u.uAmbientGround.value.set(
    (ab ? ab.r : 0.05) * 0.7, (ab ? ab.g : 0.05) * 0.7, (ab ? ab.b : 0.05) * 0.7);

  u.uWindOffset.value.copy(S.windOffset);
  u.uSteps.value = S.steps;
  u.uFrame.value = (ctx.time.frames % 64);
  u.uDetailOn.value = S.steps >= 24 ? 1 : 0;

  // Bigorna: tempestade empurra o topo para cima.
  u.uAnvil.value = 1 + (ctx.weather?.anvil || 0);

  // Alcance: da órbita o limbo fica a ~150 km e um corte em 90 km desenharia um
  // anel de nuvens no meio do planeta. O alcance acompanha a altitude.
  const camR = _camPos.distanceTo(_center);
  const reach = Math.max(MAX_DIST, Math.min(5e5, (camR - u.uRi.value) * 2.6 + 6e4));
  u.uMaxDist.value = reach;

  // Passo geométrico: resolve para que `uSteps` passos cheguem a uMaxDist.
  const base = Math.max(40, u.uThick.value / Math.max(8, S.steps) * 2.2);
  u.uBaseStep.value = base;
  u.uStepGrow.value = solveGrow(base, S.steps, reach);
  u.uLightStep.value = Math.max(35, u.uThick.value * 0.02);

  // ── Reprojeção ───────────────────────────────────────────────────────────
  const moved = _prevCam.distanceToSquared(_camPos);
  const blend = S.historyValid ? (moved > 4 ? 0.55 : 0.88) : 0;
  u.uHistoryBlend.value = blend;
  u.uPrevViewProj.value.copy(S.prevViewProj);
  u.tHistory.value = S.rtB.texture;

  // ── Marcha ───────────────────────────────────────────────────────────────
  const t0 = performance.now();
  const prevTarget = renderer.getRenderTarget();
  S.quad.material = S.marchMat;
  renderer.setRenderTarget(S.rtA);
  renderer.render(S.quadScene, S.quadCam);

  // Ping-pong: o alvo recém-escrito vira histórico do próximo frame.
  const tmp = S.rtA; S.rtA = S.rtB; S.rtB = tmp;

  // ── Sombra no chão ───────────────────────────────────────────────────────
  if ((S.shadowTick++ % SHADOW_EVERY) === 0) renderShadow(ctx, renderer);

  renderer.setRenderTarget(prevTarget);
  S.lastMs += (performance.now() - t0 - S.lastMs) * 0.15;

  // ── Estado para o próximo frame ──────────────────────────────────────────
  _viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  S.prevViewProj.copy(_viewProj);
  _prevCam.copy(_camPos);
  S.historyValid = true;

  S.compositeMat.uniforms.tClouds.value = S.rtB.texture;
  S.compositeMesh.visible = !S.externalComposite;

  if (ctx.debug.enabled) {
    ctx.debug.set('nuvens', `${S.rtB.width}x${S.rtB.height} passos ${S.steps} `
      + `cob ${S.marchMat.uniforms.uCoverage.value.toFixed(2)} cpu ${S.lastMs.toFixed(2)}ms`);
  }
}

/**
 * Resolve o crescimento geométrico g tal que base*((1+g)^n - 1)/g ≈ alcance.
 * Bisseção em 24 passos: roda uma vez por frame sobre escalares, é irrelevante
 * no perfil e evita ter que escolher o número mágico à mão para cada preset.
 */
function solveGrow(base, n, reach) {
  let lo = 0.0, hi = 0.5;
  for (let i = 0; i < 24; i++) {
    const g = (lo + hi) * 0.5;
    const d = base * (Math.pow(1 + g, n) - 1) / g;
    if (d < reach) lo = g; else hi = g;
  }
  return (lo + hi) * 0.5;
}

function renderShadow(ctx, renderer) {
  const su = S.shadowMat.uniforms;
  // Referencial tangente centrado sob o jogador.
  _up.set(
    ctx.player.position.x - S.body.center.x,
    ctx.player.position.y - S.body.center.y,
    ctx.player.position.z - S.body.center.z,
  );
  const r = _up.length();
  if (r < 1e-3) return;
  _up.multiplyScalar(1 / r);
  _tmp.set(Math.abs(_up.y) > 0.92 ? 1 : 0, Math.abs(_up.y) > 0.92 ? 0 : 1, 0);
  _east.crossVectors(_tmp, _up).normalize();
  _north.crossVectors(_up, _east).normalize();

  // Origem: o ponto do datum sob o jogador, em coordenadas de cena.
  ctx.frame.toLocal(S.body.center, _center);
  _tmp.copy(_up).multiplyScalar(S.body.radius).add(_center);
  su.uShadowOrigin.value.copy(_tmp);
  su.uShadowX.value.copy(_east).multiplyScalar(SHADOW_EXTENT);
  su.uShadowY.value.copy(_north).multiplyScalar(SHADOW_EXTENT);

  // Matriz mundo(cena) → uv do mapa. Linhas = eixos divididos pela extensão.
  const ex = 1 / SHADOW_EXTENT;
  S.shadowMatrix.set(
    _east.x * ex * 0.5, _east.y * ex * 0.5, _east.z * ex * 0.5, 0,
    _north.x * ex * 0.5, _north.y * ex * 0.5, _north.z * ex * 0.5, 0,
    0, 0, 0, 0,
    0, 0, 0, 1,
  );
  // O termo de translação vira o offset do centro do mapa (+0.5 no uv).
  S.shadowMatrix.elements[12] = 0.5 - (_east.dot(_tmp)) * ex * 0.5;
  S.shadowMatrix.elements[13] = 0.5 - (_north.dot(_tmp)) * ex * 0.5;

  S.quad.material = S.shadowMat;
  renderer.setRenderTarget(S.shadowRT);
  renderer.render(S.quadScene, S.quadCam);
}

function syncSize(engine) {
  const st = engine.sceneTarget;
  const w = Math.max(8, Math.floor(st.width * S.scale));
  const h = Math.max(8, Math.floor(st.height * S.scale));
  if (w === S.width && h === S.height && S.rtA) return;
  S.width = w; S.height = h;
  const type = engine.hdrType || THREE.HalfFloatType;
  if (!S.rtA) { S.rtA = makeTarget(w, h, type); S.rtB = makeTarget(w, h, type); }
  else { S.rtA.setSize(w, h); S.rtB.setSize(w, h); }
  S.historyValid = false;
}

export function resize() {
  S.historyValid = false;
}

// ────────────────────────────────────────────────────────────────────────────
// API pública
// ────────────────────────────────────────────────────────────────────────────

const api = {
  get enabled() { return S.active; },
  /** Buffer de nuvens: rgb = espalhamento pré-multiplicado, a = transmitância. */
  get texture() { return S.rtB ? S.rtB.texture : null; },
  /** Mapa de cobertura projetado no chão (r = luz que passa). */
  get shadowTexture() { return S.shadowRT ? S.shadowRT.texture : null; },
  /** Matriz posição-de-cena → uv do mapa de sombra. */
  get shadowMatrix() { return S.shadowMatrix; },
  get coverage() { return S.marchMat ? S.marchMat.uniforms.uCoverage.value : 0; },
  /** Altura da base e do topo acima do centro do planeta, em metros. */
  get layer() {
    const u = S.marchMat ? S.marchMat.uniforms : null;
    return u ? { inner: u.uRi.value, thickness: u.uThick.value } : null;
  },
  get costMs() { return S.lastMs; },

  /**
   * Composição manual sobre um alvo já renderizado. Ao ser chamada uma vez o
   * quad interno se aposenta — quem compõe passa a ser o chamador, e compor
   * duas vezes dobraria o brilho das nuvens.
   */
  composite(renderer, sourceTarget) {
    if (!S.active || !S.rtB || !renderer) return false;
    S.externalComposite = true;
    if (S.compositeMesh) S.compositeMesh.visible = false;
    S.compositeMat.uniforms.tClouds.value = S.rtB.texture;
    const prev = renderer.getRenderTarget();
    S.quad.material = S.compositeMat;
    renderer.setRenderTarget(sourceTarget || prev || null);
    renderer.render(S.quadScene, S.quadCam);
    renderer.setRenderTarget(prev);
    return true;
  },

  /** Devolve a composição ao quad interno da cena. */
  releaseComposite() { S.externalComposite = false; },

  setSteps(n) {
    S.stepsWanted = Math.max(8, Math.min(96, n | 0));
    S.steps = S.stepsWanted;
  },
};

export function dispose(ctx) {
  try { S.unsubRebase?.(); } catch (e) { /* ignora */ }
  if (S.compositeMesh) ctx.engine.scene.remove(S.compositeMesh);
  S.rtA?.dispose(); S.rtB?.dispose(); S.shadowRT?.dispose();
  S.shapeTex?.dispose(); S.detailTex?.dispose();
  S.marchMat?.dispose(); S.shadowMat?.dispose(); S.compositeMat?.dispose();
  S.quad?.geometry?.dispose();
  S.compositeMesh?.geometry?.dispose();
  S.ready = false;
  S.active = false;
}
