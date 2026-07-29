import * as THREE from 'three';
import { Vec3d } from '../core/frame.js';
import { Noise, clamp, saturate, smoothstep } from '../noise/noise.js';
import { hashInt, mix } from '../core/rng.js';
import {
  generateSpecies, makeFloraAtlas, TYPE_INFO, LOD_COUNT,
} from './plant-gen.js';

/**
 * flora.js — espalhamento, streaming e renderização da vegetação.
 *
 * ── O QUE ESTE MÓDULO PRECISA ACERTAR (ARCHITECTURE.md §8.4) ─────────────────
 * "Vegetação esparsa e uniforme" é o sinal nº1 de protótipo. Três coisas
 * derrubam esse sinal e todas estão implementadas aqui:
 *
 *   1. AGLOMERAÇÃO. A densidade é modulada por um campo fBm de baixa frequência
 *      (bosques) cruzado com um segundo campo (clareiras). Nunca uma grade.
 *   2. COBERTURA DE SOLO. Três anéis concêntricos com passos diferentes: tapete
 *      de grama fina até ~56 m, cobertura média até ~300 m, copa até ~1250 m.
 *   3. TRANSIÇÃO SEM POP. O LOD não troca por objeto: cada material tem uma
 *      janela de distância e o fragmento é descartado por dither ordenado
 *      (Bayer 4×4). Dois LODs coexistem na faixa de transição e o olho lê como
 *      dissolução, não como salto.
 *
 * ── PRECISÃO ────────────────────────────────────────────────────────────────
 * Cada célula é um THREE.Group cuja posição vem de ctx.frame.toLocal() todo
 * frame (em lateUpdate, portanto já depois do rebase). As matrizes de instância
 * são RELATIVAS ao centro da célula — nunca passam de algumas centenas de
 * metros, então float32 sobra. Nenhuma coordenada planetária entra num Object3D.
 *
 * ── ORÇAMENTO ───────────────────────────────────────────────────────────────
 * Geração de espécie, bake de imposters e povoamento de célula são máquinas de
 * estado fatiadas por ctx.budget.canWork(). Nada roda até o fim num único frame.
 */

export const id = 'flora';
export const order = 50;

// ═════════════════════════════════════════════════════════════════════════════
// CONSTANTES DE SINTONIA
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Janelas de distância (metros) por nível. `in` = dissolve para dentro,
 * `out` = dissolve para fora. As janelas SE SOBREPÕEM de propósito: é a
 * sobreposição que elimina o pop.
 */
const BANDS = [
  { in: [-1, 0], out: [42, 60] },        // LOD 0 — malha cheia
  { in: [40, 60], out: [190, 245] },     // LOD 1 — malha média
  { in: [188, 245], out: [520, 625] },   // LOD 2 — malha mínima
  { in: [515, 625], out: [1050, 1250] }, // imposter — cartão único
];

const IMP_COLS = 8;      // ângulos de vista no atlas de imposter
const IMP_TILE = 128;    // lado do tile, em pixels

/**
 * Anéis de povoamento. Cada anel é uma grade própria sobre a esfera, com
 * passo e alcance diferentes — é isso que dá cobertura densa perto e silhueta
 * legível longe sem pagar por células minúsculas a um quilômetro.
 */
/**
 * INVARIANTE: o raio de cada anel tem de ser MAIOR que o fim da janela de
 * dissolução do LOD mais distante que ele usa. Se a célula sumisse antes de a
 * dissolução terminar, o jogador veria a vegetação nascer opaca na borda do
 * anel — exatamente o pop que o dither existe para evitar.
 */
const RINGS = [
  // Tapete de detalhe: cobertura rasteira densíssima, some no fim do LOD0 (60 m).
  { name: 'carpet', cell: 32, radius: 66, spacing: 1.0, maxSlots: 32, scope: 'carpet', lods: [0], imposter: false, densityMul: 3.0, scaleMul: 0.70 },
  // Cobertura média: arbusto, samambaia, flor, tufo grande. Vai até o fim do LOD1.
  { name: 'ground', cell: 96, radius: 258, spacing: 3.7, maxSlots: 26, scope: 'small', lods: [0, 1], imposter: false, densityMul: 1.1, scaleMul: 1.0 },
  // Copa: tudo que tem silhueta a distância, até o fim do imposter.
  { name: 'canopy', cell: 384, radius: 1290, spacing: 13.5, maxSlots: 28, scope: 'tall', lods: [0, 1, 2], imposter: true, densityMul: 1.0, scaleMul: 1.0 },
];

// Faces do cubo → esfera. Mapeamento com warp tangente para células de área
// aproximadamente constante (sem ele as células do centro da face ficam 1,6×
// maiores que as da borda e a densidade denuncia a projeção).
const FACES = [
  { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
];
const KQ = Math.PI / 4;

// ── Temporários de módulo: zero alocação nos caminhos quentes ────────────────
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _tA = new THREE.Vector3();
const _tB = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _up = new THREE.Vector3();
const _ax = new THREE.Vector3();
const _az = new THREE.Vector3();
const _wind = new THREE.Vector3(1, 0, 0);
const _col = new THREE.Color();
const _dirty = [];

/**
 * Gerador estateless por slot.
 *
 * POR QUÊ não usar ctx.rng aqui: o povoamento de uma célula é INTERROMPÍVEL
 * pelo orçamento de frame. Um Rng com estado exigiria salvar/restaurar o fluxo
 * entre frames — e qualquer variação no número de sorteios por slot quebraria o
 * determinismo. Um hash puro de (semente da célula, índice do slot) é
 * reprodutível a partir de qualquer ponto, então retomar é trivial.
 */
let _hs = 0;
function seedSlot(cellSeed, slot) { _hs = mix(hashInt(cellSeed), hashInt(slot | 0)) >>> 0; }
function hf() { _hs = hashInt(_hs + 0x9e3779b9); return _hs / 4294967296; }

// ═════════════════════════════════════════════════════════════════════════════
// ESTADO DO MÓDULO
// ═════════════════════════════════════════════════════════════════════════════

const S = {
  ctx: null,
  root: null,
  atlas: null,
  matPlant: [],       // material por LOD
  matDepth: [],       // material de profundidade por LOD (vento nas sombras)
  matImp: null,
  impTarget: null,
  impQuad: null,
  enabled: true,

  body: null,         // corpo planetário ativo
  biome: null,
  radius: 1,
  seaR: 0,
  amplitude: 2000,

  species: [],        // [{type, info, lods, height, radius, windFactor, impRow}]
  speciesByScope: { carpet: [], small: [], tall: [] },
  buildQueue: null,   // máquina de estado da geração de espécies
  baked: false,

  noise: null,        // campo de clustering
  noiseAux: null,     // clareiras + umidade de reserva

  rings: [],
  queue: [],
  removed: new Map(), // "ring:key" → Set(indíce de instância) — persiste colheita

  stats: { cells: 0, instances: 0, queued: 0, species: 0, draws: 0 },
  lastScan: new Vec3d(1e18, 0, 0),
  scanAcc: 0,
  time: 0,
};

// ═════════════════════════════════════════════════════════════════════════════
// CICLO DE VIDA
// ═════════════════════════════════════════════════════════════════════════════

export async function init(ctx) {
  S.ctx = ctx;

  S.root = new THREE.Group();
  S.root.name = 'flora';
  S.root.matrixAutoUpdate = false;   // o grupo raiz nunca se move; as células sim
  ctx.engine.scene.add(S.root);

  // O atlas é a única textura do sistema: uma para casca, talo, folha e lâmina.
  const arng = ctx.rng.derive('flora-atlas', 0);
  S.atlas = makeFloraAtlas(arng, 512);

  buildMaterials(ctx);

  for (let i = 0; i < RINGS.length; i++) {
    S.rings.push({
      def: RINGS[i], index: i,
      cells: new Map(),
      pool: [],
      meshPool: new Map(),
      N: 1,
      wanted: new Set(),
      lastCenter: new Vec3d(1e18, 0, 0),
    });
  }

  ctx.events.on('terrain:chunkReady', onTerrainChanged);
  ctx.events.on('terrain:edit', onTerrainChanged);
  ctx.events.on('frame:rebase', placeCells);

  ctx.provide(id, {
    root: S.root,
    /** Colhe (remove) plantas num raio. Consumido pela multi-ferramenta. */
    harvest,
    /** Instâncias próximas — a fauna usa para pastar. */
    instancesNear,
    /** Espécies ativas do bioma corrente (nome/tipo/altura). */
    speciesInfo,
    setEnabled(v) { S.enabled = !!v; S.root.visible = !!v; },
    get stats() { return S.stats; },
  });
}

export function update(dt, ctx) {
  if (!S.enabled) return;
  S.time += dt;

  const body = ctx.planet?.current || null;
  if (body !== S.body) adoptBody(ctx, body);
  if (!S.body) return;

  // 1) Warm-up de espécies e bake de imposters — fatiado.
  if (S.buildQueue) { stepSpeciesBuild(ctx); return; }
  if (!S.baked) { bakeImposters(ctx); return; }

  // O nível do mar pode ser publicado pelo módulo de planeta depois do nosso
  // init — relemos todo frame em vez de confiar no instante da adoção.
  const sea = ctx.planet?.seaLevelRadius;
  if (Number.isFinite(sea)) S.seaR = sea;

  // 2) Streaming de células.
  scanRings(ctx);
  processQueue(ctx);

  // 3) Uniformes (vento, tempo, sol).
  updateUniforms(dt, ctx);

  ctx.debug.set('flora', `${S.stats.cells} cel / ${S.stats.instances} inst / fila ${S.queue.length}`);
}

export function lateUpdate() {
  // Depois do rebase: reposiciona os grupos de célula e decide os LODs
  // residentes. Só aqui as coordenadas relativas ficam válidas.
  if (!S.enabled || !S.body) return;
  placeCells();
}

export function dispose(ctx) {
  if (S.root && S.root.parent) S.root.parent.remove(S.root);
  for (const ring of S.rings) {
    for (const cell of ring.cells.values()) freeCell(ring, cell, true);
    ring.cells.clear();
  }
  disposeSpecies();
  for (const m of S.matPlant) m?.dispose?.();
  for (const m of S.matDepth) m?.dispose?.();
  S.matImp?.dispose?.();
  S.impTarget?.dispose?.();
  S.atlas?.dispose?.();
  void ctx;
}

// ═════════════════════════════════════════════════════════════════════════════
// MATERIAIS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Um material por LOD, todos compartilhando o mesmo programa (mesma
 * customProgramCacheKey) — três compilações viram uma.
 *
 * O vento vive no vertex shader porque é a única forma de mover 20 000 plantas
 * sem tocar na CPU. A conta é feita em ESPAÇO DE VISÃO: como a matriz de vista é
 * rígida, deslocar por `viewMatrix · ventoMundo` é idêntico a deslocar por
 * `ventoMundo` no mundo, e evita inverter a matriz de modelo por vértice.
 */
function buildMaterials(ctx) {
  const commonVert = /* glsl */`
    #ifdef USE_INSTANCING
      attribute vec4 aFlora;     // xyz = posição relativa ao centro do planeta (km); w = fase
    #endif
    attribute float aWindW;      // peso do vento: 0 na base rígida, →1 nas pontas
    attribute float aEmis;
    uniform vec3 uWindView;      // vetor de vento já em espaço de visão (m)
    uniform vec3 uWindDirW;      // direção do vento em espaço de mundo (unitária)
    uniform vec2 uWindGust;      // x = frequência da rajada (1/km), y = velocidade
    uniform float uTime;
    varying float vEmis;
    varying float vFloraDist;
  `;

  const windBlock = /* glsl */`
    #include <project_vertex>
    {
      #ifdef USE_INSTANCING
        float instScale = length(instanceMatrix[0].xyz);
        // Rajada: onda de baixa frequência VIAJANDO pelo terreno. A fase vem da
        // posição planetária da instância projetada na direção do vento, então a
        // onda atravessa a paisagem em vez de pulsar no lugar.
        float gust = sin(dot(aFlora.xyz, uWindDirW) * uWindGust.x - uTime * uWindGust.y);
        float phase = aFlora.w;
      #else
        float instScale = 1.0;
        float gust = sin(-uTime * uWindGust.y);
        float phase = 0.0;
      #endif
      float sway = sin(uTime * 1.85 + phase + gust * 1.1);
      float flutter = sin(uTime * 6.1 + phase * 3.7 + transformed.y * 2.9);
      float amp = aWindW * instScale * (0.55 + 0.45 * gust);
      mvPosition.xyz += uWindView * (amp * (0.62 + 0.38 * sway));
      // Componente perpendicular: a folha treme fora do eixo do vento.
      mvPosition.xyz += vec3(uWindView.z, 0.0, -uWindView.x) * (amp * flutter * 0.2);
      gl_Position = projectionMatrix * mvPosition;
      vFloraDist = -mvPosition.z;
    }
    vEmis = aEmis;
  `;

  const commonFrag = /* glsl */`
    varying float vEmis;
    varying float vFloraDist;
    uniform vec2 uFadeIn;
    uniform vec2 uFadeOut;
    uniform float uEmisK;
    // Bayer 4×4 aritmético: dissolve estocástico ordenado sem tabela nem
    // textura. Alpha-test + dither substitui blending e evita ordenação.
    float floraB2(vec2 a){ a = floor(a); return fract(a.x * 0.5 + a.y * a.y * 0.75); }
    float floraB4(vec2 a){ return floraB2(a * 0.5) * 0.25 + floraB2(a); }
  `;

  const fadeBlock = /* glsl */`
    {
      float fa = smoothstep(uFadeIn.x, uFadeIn.y, vFloraDist)
               * (1.0 - smoothstep(uFadeOut.x, uFadeOut.y, vFloraDist));
      if (fa < floraB4(gl_FragCoord.xy)) discard;
    }
  `;

  for (let l = 0; l < LOD_COUNT; l++) {
    const band = BANDS[l];
    const uniforms = makeBandUniforms(band);

    const mat = new THREE.MeshStandardMaterial({
      map: S.atlas,
      vertexColors: true,
      alphaTest: 0.36,
      side: THREE.DoubleSide,
      roughness: 0.88,
      metalness: 0.0,
      envMapIntensity: 0.6,
    });
    mat.name = `flora-lod${l}`;
    mat.userData.floraUniforms = uniforms;
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\n' + commonVert)
        .replace('#include <project_vertex>', windBlock);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\n' + commonFrag)
        .replace('#include <alphatest_fragment>', '#include <alphatest_fragment>\n' + fadeBlock)
        .replace('#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n  totalEmissiveRadiance += diffuseColor.rgb * (vEmis * uEmisK);');
    };
    mat.customProgramCacheKey = () => 'aether-flora-plant';
    S.matPlant.push(mat);

    // Profundidade: a sombra tem de balançar junto, senão a planta desliza
    // debaixo da própria sombra e o truque aparece.
    const dep = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      map: S.atlas,
      alphaTest: 0.36,
      side: THREE.DoubleSide,
    });
    dep.userData.floraUniforms = uniforms;
    dep.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\n' + commonVert)
        .replace('#include <project_vertex>', windBlock);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\n' + commonFrag);
    };
    dep.customProgramCacheKey = () => 'aether-flora-depth';
    S.matDepth.push(dep);

    ctx.lighting?.registerMaterial?.(mat, { kind: 'flora', lod: l });
  }

  buildImpostorMaterial(ctx);
}

function makeBandUniforms(band) {
  return {
    uWindView: { value: new THREE.Vector3() },
    uWindDirW: { value: new THREE.Vector3(1, 0, 0) },
    uWindGust: { value: new THREE.Vector2(1.6, 0.55) },
    uTime: { value: 0 },
    uFadeIn: { value: new THREE.Vector2(band.in[0], band.in[1]) },
    uFadeOut: { value: new THREE.Vector2(band.out[0], band.out[1]) },
    uEmisK: { value: 1 },
  };
}

/**
 * Imposter: um quad por planta, com a textura da planta pré-renderizada em 8
 * azimutes. O tile é escolhido no vertex shader pelo ângulo entre a câmera e o
 * eixo local da instância — billboard cilíndrico, que é o correto quando o
 * observador está quase sempre no plano do horizonte.
 *
 * Todas as espécies dividem o MESMO atlas (uma linha cada), então uma célula
 * distante inteira é UMA chamada de desenho.
 */
function buildImpostorMaterial(ctx) {
  const band = BANDS[3];
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uAtlas: { value: null },
      uCols: { value: IMP_COLS },
      uRows: { value: 1 },
      uSunView: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uAmbient: { value: new THREE.Color(0.25, 0.28, 0.34) },
      uFadeIn: { value: new THREE.Vector2(band.in[0], band.in[1]) },
      uFadeOut: { value: new THREE.Vector2(band.out[0], band.out[1]) },
    },
  ]);

  S.matImp = new THREE.ShaderMaterial({
    uniforms,
    fog: true,
    transparent: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      #include <common>
      #include <fog_pars_vertex>
      #include <logdepthbuf_pars_vertex>
      attribute vec4 aImp;      // x = largura, y = altura, z = linha do atlas, w = reserva
      uniform float uCols;
      uniform float uRows;
      uniform vec3 uSunView;
      varying vec2 vUvA;
      varying float vDist;
      varying float vLight;
      void main() {
        #ifdef USE_INSTANCING
          mat4 im = instanceMatrix;
        #else
          mat4 im = mat4(1.0);
        #endif
        float s = max(length(im[0].xyz), 1e-5);
        vec3 originObj = im[3].xyz;
        vec3 upObj = im[1].xyz / s;
        vec3 refObj = im[0].xyz / s;
        vec3 originView = (modelViewMatrix * vec4(originObj, 1.0)).xyz;
        mat3 nv = mat3(modelViewMatrix);
        vec3 upView = normalize(nv * upObj);
        vec3 refView = normalize(nv * refObj);
        vec3 vdir = normalize(-originView);
        vec3 right = normalize(cross(upView, vdir));
        // Azimuto do observador no frame local da instância → índice do tile.
        vec3 f = normalize(vdir - upView * dot(vdir, upView));
        float ang = atan(dot(f, cross(upView, refView)), dot(f, refView));
        float tile = floor(fract(ang / 6.2831853 + 0.5 / uCols + 1.0) * uCols);
        vUvA = vec2((tile + uv.x) / uCols, (aImp.z + uv.y) / uRows);
        vec3 p = originView
               + right * (position.x * aImp.x * s)
               + upView * (position.y * aImp.y * s);
        vec4 mvPosition = vec4(p, 1.0);
        vDist = -mvPosition.z;
        // Iluminação aproximada: mistura entre a face voltada à câmera e o topo.
        float ndl = dot(normalize(vdir * 0.5 + upView * 0.5), uSunView);
        vLight = mix(0.30, 1.20, ndl * 0.5 + 0.5);
        gl_Position = projectionMatrix * mvPosition;
        #include <logdepthbuf_vertex>
        #ifdef USE_FOG
          vFogDepth = -mvPosition.z;
        #endif
      }
    `,
    fragmentShader: /* glsl */`
      #include <common>
      #include <fog_pars_fragment>
      #include <logdepthbuf_pars_fragment>
      uniform sampler2D uAtlas;
      uniform vec3 uSunColor;
      uniform vec3 uAmbient;
      uniform vec2 uFadeIn;
      uniform vec2 uFadeOut;
      varying vec2 vUvA;
      varying float vDist;
      varying float vLight;
      float floraB2(vec2 a){ a = floor(a); return fract(a.x * 0.5 + a.y * a.y * 0.75); }
      float floraB4(vec2 a){ return floraB2(a * 0.5) * 0.25 + floraB2(a); }
      void main() {
        #include <logdepthbuf_fragment>
        vec4 t = texture2D(uAtlas, vUvA);
        if (t.a < 0.4) discard;
        float fa = smoothstep(uFadeIn.x, uFadeIn.y, vDist)
                 * (1.0 - smoothstep(uFadeOut.x, uFadeOut.y, vDist));
        if (fa < floraB4(gl_FragCoord.xy)) discard;
        vec3 c = t.rgb * (uAmbient + uSunColor * vLight);
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }
    `,
  });
  S.matImp.name = 'flora-imposter';

  // Quad canônico: x ∈ [-0.5, 0.5], y ∈ [0, 1] (origem no pé da planta).
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0,
  ]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  g.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
  g.computeBoundingSphere();
  S.impQuad = g;

  ctx.lighting?.registerMaterial?.(S.matImp, { kind: 'flora', lod: 3 });
}

// ═════════════════════════════════════════════════════════════════════════════
// ESPÉCIES
// ═════════════════════════════════════════════════════════════════════════════

function adoptBody(ctx, body) {
  // Troca de planeta: derruba tudo. Repovoar é barato perto do custo de manter
  // células de um mundo que o jogador deixou para trás.
  for (const ring of S.rings) {
    for (const cell of ring.cells.values()) freeCell(ring, cell, false);
    ring.cells.clear();
    ring.lastCenter.set(1e18, 0, 0);
  }
  S.queue.length = 0;
  disposeSpecies();
  S.removed.clear();
  S.baked = false;
  S.body = body;
  S.biome = body?.biome || null;

  if (!body || !S.biome) { S.buildQueue = null; return; }

  S.radius = body.radius || 100000;
  S.seaR = ctx.planet?.seaLevelRadius ?? 0;
  S.amplitude = S.biome.terrain?.amplitude || 2000;

  const seedTag = String(body.id || body.name || 'planet');
  S.noise = new Noise(ctx.rng.derive('flora-cluster', hash32(seedTag)).seed);
  S.noiseAux = new Noise(ctx.rng.derive('flora-aux', hash32(seedTag)).seed);

  for (const ring of S.rings) {
    ring.N = Math.max(4, Math.round((Math.PI / 2) * S.radius / ring.def.cell));
    ring.seed = ctx.rng.derive('flora-ring/' + ring.index, hash32(seedTag)).seed;
  }

  // Fila de geração: 2 variantes por tipo. Mais que isso custa warm-up sem
  // ganho visível; menos que isso e o olho reconhece o clone.
  const types = (S.biome.flora?.types || []).filter((t) => TYPE_INFO[t]);
  const jobs = [];
  for (let i = 0; i < types.length; i++) {
    for (let v = 0; v < 2; v++) jobs.push({ type: types[i], variant: v });
  }
  S.buildQueue = { jobs, at: 0 };
  S.species = [];
  S.speciesByScope = { carpet: [], small: [], tall: [] };
}

function stepSpeciesBuild(ctx) {
  const q = S.buildQueue;
  const P = {
    hueRange: S.biome.flora?.hueRange || [0.25, 0.4],
    saturation: S.biome.flora?.saturation ?? 0.85,
    emissive: S.biome.flora?.emissive || 0,
    maxHeight: S.biome.flora?.maxHeight || 12,
  };
  while (q.at < q.jobs.length && ctx.budget.canWork()) {
    const job = q.jobs[q.at++];
    const rng = ctx.rng.derive('flora-species/' + job.type, job.variant);
    let sp = null;
    try { sp = generateSpecies(job.type, rng, P); }
    catch (e) { sp = null; }
    if (!sp) continue;

    // O peso de vento por vértice já carrega a "rigidez" do tipo e a altura:
    // um pinheiro de 18 m não pode balançar como uma folha de grama.
    sp.windFactor = sp.info.wind * Math.pow(Math.max(0.2, sp.height), 0.6) * 0.25;
    for (let l = 0; l < sp.lods.length; l++) {
      const a = sp.lods[l].getAttribute('aWindW');
      if (!a) continue;
      const arr = a.array;
      for (let k = 0; k < arr.length; k++) arr[k] *= sp.windFactor;
      a.needsUpdate = true;
    }
    sp.index = S.species.length;
    sp.impRow = -1;
    S.species.push(sp);

    const scope = sp.info.tall ? 'tall' : 'small';
    S.speciesByScope[scope].push(sp);
    // O tapete só aceita cobertura muito baixa.
    if (!sp.info.tall && sp.height <= 1.6) S.speciesByScope.carpet.push(sp);
  }

  if (q.at >= q.jobs.length) {
    S.buildQueue = null;
    S.stats.species = S.species.length;
    // Sem tapete próprio? Reaproveita a cobertura pequena para não deixar o
    // chão pelado nos primeiros metros — o pior enquadramento possível.
    if (S.speciesByScope.carpet.length === 0) {
      S.speciesByScope.carpet = S.speciesByScope.small.slice(0, 2);
    }
  }
  ctx.debug.set('flora.build', `${S.species.length}/${q.jobs.length} espécies`);
}

function disposeSpecies() {
  for (const sp of S.species) {
    for (const g of sp.lods) g.dispose();
  }
  S.species = [];
  S.speciesByScope = { carpet: [], small: [], tall: [] };
  S.buildQueue = null;
}

function speciesInfo() {
  return S.species.map((sp) => ({ type: sp.type, height: sp.height, tall: !!sp.info.tall, resource: sp.info.resource }));
}

// ═════════════════════════════════════════════════════════════════════════════
// BAKE DOS IMPOSTERS (render-to-texture)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Renderiza cada espécie alta em 8 azimutes para dentro de um atlas.
 * É a única forma de manter 25 000 árvores a um quilômetro de distância dentro
 * do orçamento — e é o que o NMS faz. A margem de 20% em cada tile impede o
 * sangramento entre vizinhos quando o mip é gerado.
 */
function bakeImposters(ctx) {
  S.baked = true;   // mesmo em falha: nunca tentar de novo e travar o boot
  const tall = S.speciesByScope.tall;
  if (!tall.length || !S.matImp) return;

  const renderer = ctx.engine.renderer;
  if (!renderer) return;

  const rows = tall.length;
  const w = IMP_COLS * IMP_TILE, h = rows * IMP_TILE;

  if (S.impTarget && (S.impTarget.width !== w || S.impTarget.height !== h)) {
    S.impTarget.dispose(); S.impTarget = null;
  }
  if (!S.impTarget) {
    S.impTarget = new THREE.WebGLRenderTarget(w, h, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: true,
      depthBuffer: true,
      stencilBuffer: false,
    });
    S.impTarget.texture.colorSpace = THREE.SRGBColorSpace;
    S.impTarget.texture.name = 'floraImposterAtlas';
  }

  const scene = new THREE.Scene();
  const key = new THREE.DirectionalLight(0xffffff, 2.1);
  const fill = new THREE.HemisphereLight(0xbfd4ff, 0x2b2418, 1.5);
  scene.add(fill);
  const rig = new THREE.Group();
  rig.add(key);
  key.position.set(-0.6, 1.0, 0.75);
  scene.add(rig);

  const bakeMat = new THREE.MeshStandardMaterial({
    map: S.atlas, vertexColors: true, alphaTest: 0.36,
    side: THREE.DoubleSide, roughness: 0.9, metalness: 0,
  });
  // O emissivo baked mantém a bioluminescência legível à distância.
  bakeMat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aEmis;\nattribute float aWindW;\nvarying float vEmisB;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n vEmisB = aEmis;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vEmisB;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += diffuseColor.rgb * vEmisB;');
  };
  bakeMat.customProgramCacheKey = () => 'aether-flora-bake';

  const mesh = new THREE.Mesh(S.impQuad, bakeMat);
  scene.add(mesh);

  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);

  const prevRT = renderer.getRenderTarget();
  const prevAuto = renderer.autoClear;
  const prevShadow = renderer.shadowMap.enabled;
  const prevClear = new THREE.Color();
  renderer.getClearColor(prevClear);
  const prevAlpha = renderer.getClearAlpha();
  const prevScissorTest = renderer.getScissorTest();

  try {
    renderer.shadowMap.enabled = false;
    renderer.autoClear = false;
    renderer.setRenderTarget(S.impTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.setScissorTest(false);
    renderer.clear(true, true, false);
    renderer.setScissorTest(true);

    for (let r = 0; r < rows; r++) {
      const sp = tall[r];
      sp.impRow = r;
      mesh.geometry = sp.lods[0];
      const bb = sp.lods[0].boundingBox;
      const cy = bb ? (bb.min.y + bb.max.y) * 0.5 : sp.height * 0.5;
      const halfY = bb ? Math.max(0.05, (bb.max.y - bb.min.y) * 0.5) : sp.height * 0.5;
      const halfX = bb ? Math.max(0.05, Math.max(
        Math.abs(bb.min.x), Math.abs(bb.max.x), Math.abs(bb.min.z), Math.abs(bb.max.z))) : sp.radius;
      // Margem: a planta ocupa ~80% do tile.
      const ex = halfX * 1.25, ey = halfY * 1.25;
      sp.impWidth = ex * 2;
      sp.impHeight = ey * 2;
      sp.impBaseOffset = cy - ey;    // deslocamento do pé até o centro do quad

      cam.left = -ex; cam.right = ex; cam.top = ey; cam.bottom = -ey;
      cam.near = 0.01; cam.far = Math.max(50, halfX * 40 + 50);
      cam.updateProjectionMatrix();

      for (let c = 0; c < IMP_COLS; c++) {
        const a = (c / IMP_COLS) * Math.PI * 2;
        const d = Math.max(10, halfX * 8 + 10);
        // Leve elevação: o jogador quase nunca vê a árvore distante de frente.
        cam.position.set(Math.cos(a) * d, cy + d * 0.13, Math.sin(a) * d);
        cam.lookAt(0, cy, 0);
        cam.updateMatrixWorld(true);
        rig.quaternion.copy(cam.quaternion);   // luz solidária à câmera
        rig.updateMatrixWorld(true);

        const px = c * IMP_TILE, py = r * IMP_TILE;
        renderer.setViewport(px, py, IMP_TILE, IMP_TILE);
        renderer.setScissor(px, py, IMP_TILE, IMP_TILE);
        renderer.render(scene, cam);
      }
    }
    S.matImp.uniforms.uAtlas.value = S.impTarget.texture;
    S.matImp.uniforms.uRows.value = rows;
    S.matImp.needsUpdate = true;
  } catch (e) {
    S.matImp.uniforms.uAtlas.value = null;
  } finally {
    renderer.setScissorTest(prevScissorTest);
    renderer.setViewport(0, 0, ctx.engine.size.x, ctx.engine.size.y);
    renderer.setScissor(0, 0, ctx.engine.size.x, ctx.engine.size.y);
    renderer.setRenderTarget(prevRT);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.autoClear = prevAuto;
    renderer.shadowMap.enabled = prevShadow;
    // A geometria do quad volta a ser dona do mesh temporário.
    mesh.geometry = S.impQuad;
    bakeMat.dispose();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// GRADE ESFÉRICA
// ═════════════════════════════════════════════════════════════════════════════

function faceUVToDir(f, u, v, out) {
  const F = FACES[f];
  const tu = Math.tan(u * KQ), tv = Math.tan(v * KQ);
  out.set(
    F.n[0] + F.u[0] * tu + F.v[0] * tv,
    F.n[1] + F.u[1] * tu + F.v[1] * tv,
    F.n[2] + F.u[2] * tu + F.v[2] * tv,
  );
  return out.normalize();
}

const _fuv = { f: 0, u: 0, v: 0 };
function dirToFaceUV(d) {
  const ax = Math.abs(d.x), ay = Math.abs(d.y), az = Math.abs(d.z);
  let f;
  if (ax >= ay && ax >= az) f = d.x > 0 ? 0 : 1;
  else if (ay >= az) f = d.y > 0 ? 2 : 3;
  else f = d.z > 0 ? 4 : 5;
  const F = FACES[f];
  const dn = d.x * F.n[0] + d.y * F.n[1] + d.z * F.n[2];
  const du = d.x * F.u[0] + d.y * F.u[1] + d.z * F.u[2];
  const dv = d.x * F.v[0] + d.y * F.v[1] + d.z * F.v[2];
  const inv = 1 / Math.max(1e-9, dn);
  _fuv.f = f;
  _fuv.u = Math.atan(du * inv) / KQ;
  _fuv.v = Math.atan(dv * inv) / KQ;
  return _fuv;
}

/** Base tangente ortonormal em torno de uma direção radial. */
function tangentBasis(dir, outA, outB) {
  _v3.set(0, 1, 0);
  if (Math.abs(dir.dot(_v3)) > 0.92) _v3.set(1, 0, 0);
  outA.crossVectors(_v3, dir).normalize();
  outB.crossVectors(dir, outA).normalize();
}

function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

// ═════════════════════════════════════════════════════════════════════════════
// STREAMING DE CÉLULAS
// ═════════════════════════════════════════════════════════════════════════════

function playerDir(ctx, out) {
  const p = ctx.player.position, c = S.body.center;
  out.set(p.x - c.x, p.y - c.y, p.z - c.z);
  if (out.lengthSq() < 1e-9) out.set(0, 1, 0);
  return out.normalize();
}

/** Redescobre quais células cada anel precisa e enfileira as que faltam. */
function scanRings(ctx) {
  const pos = ctx.player.position;
  // O alcance NÃO é reduzido por qualidade: encolher o raio quebraria o
  // casamento com as janelas de dissolução. Qualidade mexe só na densidade.
  playerDir(ctx, _dir);

  for (const ring of S.rings) {
    const def = ring.def;
    // Revarrer a grade toda todo frame é desperdício: só quando o jogador
    // andou uma fração da célula é que o conjunto desejado pode ter mudado.
    const moved = ring.lastCenter.distanceToSq(pos);
    const trig = (def.cell * 0.28) * (def.cell * 0.28);
    if (moved < trig && ring.cells.size > 0) continue;
    ring.lastCenter.copy(pos);

    const radius = def.radius;
    ring.wanted.clear();
    tangentBasis(_dir, _tA, _tB);

    // Amostragem em passo de meia-célula: garante que nenhuma célula do disco
    // escape por aliasing da varredura.
    const step = def.cell * 0.5;
    const nR = Math.ceil(radius / step);
    const lim = (radius + def.cell * 0.75) * (radius + def.cell * 0.75);
    for (let a = -nR; a <= nR; a++) {
      for (let b = -nR; b <= nR; b++) {
        const ox = a * step, oz = b * step;
        if (ox * ox + oz * oz > lim) continue;
        _v1.copy(_dir).multiplyScalar(S.radius)
          .addScaledVector(_tA, ox).addScaledVector(_tB, oz).normalize();
        const fuv = dirToFaceUV(_v1);
        const i = clamp(Math.floor((fuv.u * 0.5 + 0.5) * ring.N), 0, ring.N - 1);
        const j = clamp(Math.floor((fuv.v * 0.5 + 0.5) * ring.N), 0, ring.N - 1);
        const key = (fuv.f * ring.N + i) * ring.N + j;
        if (ring.wanted.has(key)) continue;
        ring.wanted.add(key);
        if (!ring.cells.has(key)) enqueueCell(ctx, ring, key, fuv.f, i, j);
      }
    }

    // Libera o que saiu do alcance.
    for (const [key, cell] of ring.cells) {
      if (!ring.wanted.has(key)) { freeCell(ring, cell, false); ring.cells.delete(key); }
    }
  }

  // Prioriza o que está debaixo do nariz do jogador.
  if (S.queue.length > 1) {
    for (const c of S.queue) c._d = distSqToPlayer(ctx, c);
    S.queue.sort((x, y) => x._d - y._d);
  }
  S.stats.queued = S.queue.length;
}

function distSqToPlayer(ctx, cell) {
  const p = ctx.player.position;
  const dx = cell.centerWorld.x - p.x, dy = cell.centerWorld.y - p.y, dz = cell.centerWorld.z - p.z;
  return dx * dx + dy * dy + dz * dz;
}

function enqueueCell(ctx, ring, key, f, i, j) {
  const cell = ring.pool.pop() || newCell();
  cell.key = key; cell.face = f; cell.i = i; cell.j = j; cell.ring = ring;
  cell.ready = false; cell.slot = 0; cell.n = 0;

  const u = ((i + 0.5) / ring.N) * 2 - 1;
  const v = ((j + 0.5) / ring.N) * 2 - 1;
  faceUVToDir(f, u, v, cell.dir);

  const h = sampleHeightSafe(ctx, cell.dir);
  const r = S.radius + h;
  cell.centerWorld.set(
    S.body.center.x + cell.dir.x * r,
    S.body.center.y + cell.dir.y * r,
    S.body.center.z + cell.dir.z * r,
  );
  cell.radiusW = ring.def.cell * 0.75 + 40;

  cell.acc.length = 0;
  ring.cells.set(key, cell);
  S.queue.push(cell);
}

function newCell() {
  return {
    key: 0, face: 0, i: 0, j: 0, ring: null,
    dir: new THREE.Vector3(0, 1, 0),
    centerWorld: new Vec3d(),
    radiusW: 100,
    ready: false, slot: 0, n: 0, _d: 0,
    group: null,
    acc: [],                 // acumulador de instâncias durante o povoamento
    pos: null,               // Float64Array(3n) — posições de mundo
    typ: null,               // Uint8Array(n) — índice de espécie
    scl: null,               // Float32Array(n)
    alive: null,             // Uint8Array(n)
    sIdx: null,              // Uint32Array(n) — posição dentro do array da espécie
    impIdx: null,            // Int32Array(n)  — posição no array de imposter (-1)
    bySpecies: new Map(),    // spIdx → {count, mat, flo, meshes[]}
    imp: null,               // {count, mat, attr, mesh}
  };
}

function freeCell(ring, cell, hard) {
  if (cell.group) {
    for (const s of cell.bySpecies.values()) {
      for (let l = 0; l < s.meshes.length; l++) {
        const m = s.meshes[l];
        if (!m) continue;
        cell.group.remove(m);
        releaseMesh(ring, s.spIdx, l, m);
        s.meshes[l] = null;
      }
    }
    if (cell.imp && cell.imp.mesh) {
      cell.group.remove(cell.imp.mesh);
      releaseMesh(ring, -1, 3, cell.imp.mesh);
      cell.imp.mesh = null;
    }
    S.root.remove(cell.group);
  }
  const qi = S.queue.indexOf(cell);
  if (qi >= 0) S.queue.splice(qi, 1);
  cell.acc.length = 0;
  cell.n = 0;
  // Os blocos por espécie NÃO são descartados: é justamente o que a próxima
  // célula do mesmo anel vai reaproveitar (pooling agressivo).
  for (const slot of cell.bySpecies.values()) { slot.count = 0; slot.need = 0; }
  if (cell.imp) cell.imp.count = 0;
  if (hard) cell.bySpecies.clear();
  else if (ring.pool.length < 48) ring.pool.push(cell);
}

// ═════════════════════════════════════════════════════════════════════════════
// POVOAMENTO
// ═════════════════════════════════════════════════════════════════════════════

function processQueue(ctx) {
  let guard = 0;
  while (S.queue.length && ctx.budget.canWork() && guard++ < 64) {
    const cell = S.queue[0];
    if (populateStep(ctx, cell)) {
      S.queue.shift();
      finalizeCell(ctx, cell);
    } else break;
  }
}

/**
 * Uma fatia do povoamento de uma célula. Devolve true quando terminou.
 *
 * A ordem das operações importa por custo: o campo de clustering (barato, é
 * nosso) rejeita a maioria dos slots ANTES de chamar sampleSurface (caro, é do
 * módulo de planeta). Sem essa inversão, o povoamento come o frame inteiro.
 */
function populateStep(ctx, cell) {
  const ring = cell.ring;
  const def = ring.def;
  const pool = S.speciesByScope[def.scope];
  if (!pool || pool.length === 0) { cell.slot = 1e9; return true; }

  const side = clamp(Math.round(def.cell / def.spacing), 1, def.maxSlots);
  const total = side * side;
  const cellSeed = mix(hashInt(cell.key), ring.seed >>> 0) >>> 0;

  const density = (S.biome.flora?.density ?? 1)
    * clamp(ctx.quality?.floraDensity ?? 1, 0.05, 2)
    * def.densityMul;

  tangentBasis(cell.dir, _tA, _tB);
  const half = def.cell * 0.5;
  const cf = S.radius / 260;     // bosques ~260 m
  const cg = S.radius / 950;     // clareiras ~950 m
  const mf = S.radius / 1800;    // umidade de reserva

  const seaR = S.seaR || 0;
  let processed = 0;

  while (cell.slot < total) {
    if ((processed & 31) === 31 && !ctx.budget.canWork()) return false;
    processed++;

    const s = cell.slot++;
    seedSlot(cellSeed, s);
    const a = s % side, b = (s / side) | 0;
    // Jitter em grade = Poisson-disk aproximado: mantém o espaçamento mínimo
    // sem o custo do dart throwing, e destrói a leitura de fileira.
    const jx = (hf() - 0.5) * 0.92;
    const jz = (hf() - 0.5) * 0.92;
    const ox = (-half + (a + 0.5 + jx) * (def.cell / side));
    const oz = (-half + (b + 0.5 + jz) * (def.cell / side));

    _v1.copy(cell.dir).multiplyScalar(S.radius)
      .addScaledVector(_tA, ox).addScaledVector(_tB, oz).normalize();

    // ── Campo de aglomeração ────────────────────────────────────────────────
    const nx = _v1.x, ny = _v1.y, nz = _v1.z;
    // Curvas calibradas para uma distribuição BIMODAL: ~33% do terreno vira
    // clareira quase limpa e ~15% vira bosque cheio. Um campo de contraste
    // baixo devolve densidade média em todo lugar — que é a definição visual de
    // "vegetação uniforme".
    const forest = S.noise.fbm(nx * cf, ny * cf, nz * cf, 4, 2.1, 0.55);
    const clearing = S.noiseAux.noise3(nx * cg + 11.3, ny * cg - 4.7, nz * cg + 2.9);
    let cluster = smoothstep(-0.25, 0.22, forest) * (1 - smoothstep(0.32, 0.78, clearing));
    cluster = saturate(cluster);
    if (cluster <= 0.002) continue;

    const p = density * (0.06 + 0.94 * Math.pow(cluster, 1.4));
    if (hf() > p) continue;

    // ── Terreno ─────────────────────────────────────────────────────────────
    const surf = sampleSurfaceSafe(ctx, _v1);
    const h = surf.height;
    const rad = S.radius + h;
    if (seaR > 0 && rad < seaR + 0.35) continue;   // nada de grama dentro d'água

    const slope = surf.slope;
    const altN = saturate((rad - Math.max(seaR, S.radius)) / Math.max(1, S.amplitude));
    const moisture = surf.moisture >= 0 ? surf.moisture
      : saturate(S.noiseAux.fbm(nx * mf + 31.7, ny * mf + 5.1, nz * mf - 9.4, 3) * 0.5 + 0.5);
    const temp = surf.temperature >= 0 ? surf.temperature
      : saturate(1 - Math.abs(ny) * 0.85 - altN * 0.35);

    // ── Escolha da espécie por aptidão ──────────────────────────────────────
    let best = -1, totalW = 0;
    for (let k = 0; k < pool.length; k++) {
      const inf = pool[k].info;
      let w = band(slope, inf.slope) * band(moisture, inf.moisture)
        * band(temp, inf.temp) * band(altN, inf.alt);
      if (w <= 0) { _wbuf[k] = 0; continue; }
      w *= 0.25 + 0.75 * Math.pow(cluster, 1 + inf.clumping * 2);
      _wbuf[k] = w; totalW += w;
    }
    if (totalW <= 1e-5) continue;
    let pick = hf() * totalW;
    for (let k = 0; k < pool.length; k++) {
      pick -= _wbuf[k];
      if (pick <= 0) { best = k; break; }
    }
    if (best < 0) best = pool.length - 1;
    const sp = pool[best];

    // ── Pose ────────────────────────────────────────────────────────────────
    // A normal do terreno é misturada com a radial: uma árvore em encosta se
    // inclina, mas nunca deita — planta que segue a normal 100% lê como decalque.
    _up.copy(surf.normal).lerp(_v1, 0.55).normalize();
    if (!Number.isFinite(_up.x)) _up.copy(_v1);

    // Variação de escala forte: plantas do mesmo tipo com o mesmo tamanho é o
    // segundo sinal mais denunciador depois da uniformidade de posição.
    const scale = def.scaleMul * (0.62 + 1.05 * Math.pow(hf(), 1.7))
      * (0.85 + 0.3 * cluster);

    cell.acc.push(sp.index, _v1.x, _v1.y, _v1.z, rad, _up.x, _up.y, _up.z,
      scale, hf() * Math.PI * 2, hf() * 6.2831853);
  }
  return true;
}

const _wbuf = new Float32Array(64);

/** Aptidão trapezoidal: 1 no miolo da faixa, 0 fora, com borda suave. */
function band(x, range) {
  const lo = range[0], hi = range[1];
  if (x <= lo || x >= hi) return 0;
  const m = (hi - lo) * 0.22;
  return smoothstep(lo, lo + m, x) * (1 - smoothstep(hi - m, hi, x));
}

/** Converte o acumulador em arrays tipados + matrizes de instância. */
function finalizeCell(ctx, cell) {
  const acc = cell.acc;
  const n = acc.length / 11;
  cell.n = n;
  cell.ready = true;
  if (n === 0) { acc.length = 0; return; }

  if (!cell.pos || cell.pos.length < n * 3) {
    cell.pos = new Float64Array(n * 3);
    cell.typ = new Uint8Array(n);
    cell.scl = new Float32Array(n);
    cell.alive = new Uint8Array(n);
    cell.sIdx = new Uint32Array(n);
    cell.impIdx = new Int32Array(n);
  }

  // Dimensionamento por espécie REAPROVEITANDO os blocos que a célula já tinha:
  // depois do aquecimento nenhuma célula nova aloca buffer de instância.
  for (const slot of cell.bySpecies.values()) { slot.count = 0; slot.need = 0; }
  let impCount = 0;
  for (let k = 0; k < n; k++) {
    const spIdx = acc[k * 11];
    let slot = cell.bySpecies.get(spIdx);
    if (!slot) {
      slot = { spIdx, count: 0, need: 0, cap: 0, mat: null, flo: null, meshes: new Array(LOD_COUNT).fill(null) };
      cell.bySpecies.set(spIdx, slot);
    }
    slot.need++;
    if (cell.ring.def.imposter && S.species[spIdx].impRow >= 0) impCount++;
  }
  for (const slot of cell.bySpecies.values()) {
    if (slot.need === 0 || (slot.mat && slot.cap >= slot.need)) continue;
    slot.cap = Math.ceil(slot.need * 1.3);
    slot.mat = new Float32Array(slot.cap * 16);
    slot.flo = new Float32Array(slot.cap * 4);
  }
  if (impCount > 0) {
    cell.imp = cell.imp || { count: 0, cap: 0, mat: null, attr: null, mesh: null };
    if (!cell.imp.mat || cell.imp.cap < impCount) {
      cell.imp.cap = Math.ceil(impCount * 1.3);
      cell.imp.mat = new Float32Array(cell.imp.cap * 16);
      cell.imp.attr = new Float32Array(cell.imp.cap * 4);
    }
    cell.imp.count = 0;
  } else if (cell.imp) {
    cell.imp.count = 0;
  }

  const removedSet = S.removed.get(cell.ring.index + ':' + cell.key);
  const cx = cell.centerWorld.x, cy = cell.centerWorld.y, cz = cell.centerWorld.z;
  const bc = S.body.center;
  let impW = 0;

  for (let k = 0; k < n; k++) {
    const o = k * 11;
    const spIdx = acc[o];
    const sp = S.species[spIdx];
    const dx = acc[o + 1], dy = acc[o + 2], dz = acc[o + 3];
    const rad = acc[o + 4];
    _up.set(acc[o + 5], acc[o + 6], acc[o + 7]);
    const scale = acc[o + 8];
    const yaw = acc[o + 9];
    const phase = acc[o + 10];

    const wx = bc.x + dx * rad, wy = bc.y + dy * rad, wz = bc.z + dz * rad;
    cell.pos[k * 3] = wx; cell.pos[k * 3 + 1] = wy; cell.pos[k * 3 + 2] = wz;
    cell.typ[k] = spIdx;
    cell.scl[k] = scale;
    const dead = removedSet ? removedSet.has(k) : false;
    cell.alive[k] = dead ? 0 : 1;

    // Base ortonormal com yaw aleatório em torno da normal.
    tangentBasis(_up, _ax, _az);
    const ca = Math.cos(yaw), sa = Math.sin(yaw);
    _v2.set(_ax.x * ca + _az.x * sa, _ax.y * ca + _az.y * sa, _ax.z * ca + _az.z * sa);
    _v3.crossVectors(_up, _v2).normalize();

    const es = dead ? 0 : scale;
    const slot = cell.bySpecies.get(spIdx);
    const si = slot.count++;
    cell.sIdx[k] = si;
    const m = slot.mat, mo = si * 16;
    m[mo + 0] = _v2.x * es; m[mo + 1] = _v2.y * es; m[mo + 2] = _v2.z * es; m[mo + 3] = 0;
    m[mo + 4] = _up.x * es; m[mo + 5] = _up.y * es; m[mo + 6] = _up.z * es; m[mo + 7] = 0;
    m[mo + 8] = _v3.x * es; m[mo + 9] = _v3.y * es; m[mo + 10] = _v3.z * es; m[mo + 11] = 0;
    m[mo + 12] = wx - cx; m[mo + 13] = wy - cy; m[mo + 14] = wz - cz; m[mo + 15] = 1;

    const f = slot.flo, fo = si * 4;
    // Posição planetária em km: precisão de centímetro em float32 e magnitude
    // pequena o bastante para a fase da rajada não estourar.
    f[fo + 0] = (wx - bc.x) * 0.001;
    f[fo + 1] = (wy - bc.y) * 0.001;
    f[fo + 2] = (wz - bc.z) * 0.001;
    f[fo + 3] = phase;

    if (cell.imp && cell.ring.def.imposter && sp.impRow >= 0) {
      const ii = cell.imp.count++;
      cell.impIdx[k] = ii;
      const im = cell.imp.mat, io = ii * 16;
      for (let q = 0; q < 16; q++) im[io + q] = m[mo + q];
      const ia = cell.imp.attr, ao = ii * 4;
      ia[ao + 0] = sp.impWidth || sp.radius * 2;
      ia[ao + 1] = sp.impHeight || sp.height;
      ia[ao + 2] = sp.impRow;
      ia[ao + 3] = 0;
      impW = Math.max(impW, ia[ao + 1] * scale);
    } else {
      cell.impIdx[k] = -1;
    }
  }

  acc.length = 0;
  cell.radiusW = cell.ring.def.cell * 0.75 + Math.max(20, impW);

  if (!cell.group) {
    cell.group = new THREE.Group();
    cell.group.matrixAutoUpdate = true;
  }
  ctx.frame.toLocal(cell.centerWorld, cell.group.position);
  S.root.add(cell.group);
}

// ═════════════════════════════════════════════════════════════════════════════
// AMOSTRAGEM DO TERRENO (tolerante ao contrato)
// ═════════════════════════════════════════════════════════════════════════════

const _surf = { height: 0, slope: 0, moisture: -1, temperature: -1, normal: new THREE.Vector3(0, 1, 0) };

function sampleHeightSafe(ctx, dir) {
  const h = ctx.planet?.sampleHeight?.(dir);
  return Number.isFinite(h) ? h : 0;
}

function sampleSurfaceSafe(ctx, dir) {
  _surf.height = 0; _surf.slope = 0; _surf.moisture = -1; _surf.temperature = -1;
  _surf.normal.copy(dir);
  const s = ctx.planet?.sampleSurface?.(dir);
  if (s && Number.isFinite(s.height)) {
    _surf.height = s.height;
    if (s.normal && Number.isFinite(s.normal.x)) {
      // A inclinação derivada da normal é a única em que confiamos: o campo
      // `slope` do planeta pode vir em grau, radiano ou [0,1].
      _surf.normal.set(s.normal.x, s.normal.y, s.normal.z).normalize();
      const c = clamp(_surf.normal.dot(dir), -1, 1);
      _surf.slope = saturate(Math.acos(c) / (Math.PI * 0.5));
    } else {
      _surf.slope = normalizeSlope(s.slope);
    }
    if (Number.isFinite(s.moisture)) _surf.moisture = saturate(s.moisture);
    else if (Number.isFinite(s.humidity)) _surf.moisture = saturate(s.humidity);
    if (Number.isFinite(s.temperature)) _surf.temperature = saturate(s.temperature);
    else if (Number.isFinite(s.temp)) _surf.temperature = saturate(s.temp);
  } else {
    _surf.height = sampleHeightSafe(ctx, dir);
  }
  return _surf;
}

function normalizeSlope(v) {
  if (!Number.isFinite(v)) return 0;
  if (v > 1.6) return saturate(v / 90);        // graus
  if (v > 1.0) return saturate(v / (Math.PI * 0.5)); // radianos
  return saturate(v);
}

// ═════════════════════════════════════════════════════════════════════════════
// MALHAS INSTANCIADAS (pooling)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Clone raso: novo BufferGeometry compartilhando os MESMOS BufferAttribute da
 * espécie. O three indexa o buffer de GPU pelo objeto de atributo, então isso
 * reaproveita a malha na placa e só o atributo instanciado é próprio da célula.
 */
function shallowGeo(src) {
  const g = new THREE.BufferGeometry();
  for (const k in src.attributes) g.setAttribute(k, src.attributes[k]);
  if (src.index) g.setIndex(src.index);
  g.boundingSphere = src.boundingSphere;
  g.boundingBox = src.boundingBox;
  return g;
}

function poolKey(spIdx, lod) { return spIdx * 8 + lod; }

function acquireMesh(ring, spIdx, lod, capacity) {
  const key = poolKey(spIdx, lod);
  let arr = ring.meshPool.get(key);
  if (!arr) { arr = []; ring.meshPool.set(key, arr); }
  let mesh = arr.pop();
  if (!mesh) {
    if (lod === 3) {
      const g = shallowGeo(S.impQuad);
      mesh = new THREE.InstancedMesh(g, S.matImp, Math.max(1, capacity));
      g.setAttribute('aImp', new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, capacity) * 4), 4));
      mesh.castShadow = false;
      mesh.receiveShadow = false;
    } else {
      const sp = S.species[spIdx];
      const g = shallowGeo(sp.lods[lod]);
      mesh = new THREE.InstancedMesh(g, S.matPlant[lod], Math.max(1, capacity));
      g.setAttribute('aFlora', new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, capacity) * 4), 4));
      // Só os dois primeiros níveis lançam sombra: o custo do mapa de sombra
      // não paga por um cartão de 6 px a 800 m.
      mesh.castShadow = lod <= 1;
      mesh.receiveShadow = true;
      if (mesh.castShadow) mesh.customDepthMaterial = S.matDepth[lod];
    }
    mesh.frustumCulled = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 100);
  }
  ensureCapacity(mesh, capacity, lod);
  return mesh;
}

function releaseMesh(ring, spIdx, lod, mesh) {
  const key = poolKey(spIdx, lod);
  let arr = ring.meshPool.get(key);
  if (!arr) { arr = []; ring.meshPool.set(key, arr); }
  // ATENÇÃO: nunca chamar geometry.dispose() aqui. A geometria é um clone RASO
  // que compartilha os BufferAttribute da espécie — descartá-la removeria os
  // buffers de GPU de todas as outras células que usam a mesma malha.
  if (arr.length < 32) arr.push(mesh);
  else mesh.dispose?.();
}

function ensureCapacity(mesh, n, lod) {
  const need = Math.max(1, n);
  if (mesh.instanceMatrix.count >= need) return;
  const cap = Math.ceil(need * 1.3);
  mesh.instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const name = lod === 3 ? 'aImp' : 'aFlora';
  mesh.geometry.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4));
}

function uploadMesh(mesh, mat, extra, count, radius) {
  mesh.count = count;
  mesh.instanceMatrix.array.set(mat.subarray(0, count * 16));
  mesh.instanceMatrix.needsUpdate = true;
  const at = mesh.geometry.getAttribute(mesh.material === S.matImp ? 'aImp' : 'aFlora');
  at.array.set(extra.subarray(0, count * 4));
  at.needsUpdate = true;
  mesh.boundingSphere.center.set(0, 0, 0);
  mesh.boundingSphere.radius = radius;
}

// ═════════════════════════════════════════════════════════════════════════════
// POSICIONAMENTO E RESIDÊNCIA DE LOD
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Roda em lateUpdate (e em 'frame:rebase'): converte a posição de mundo da
 * célula para o espaço de renderização e decide quais níveis ficam residentes.
 *
 * A decisão é por INTERVALO: se a faixa [d-raio, d+raio] da célula intersecta a
 * janela do nível, o nível fica montado. Como as janelas se sobrepõem, duas
 * malhas coexistem na transição e o dither faz a dissolução — sem pop.
 */
function placeCells() {
  const ctx = S.ctx;
  if (!ctx || !S.body) return;
  const p = ctx.player.position;
  let cells = 0, inst = 0, draws = 0;

  for (const ring of S.rings) {
    const def = ring.def;
    for (const cell of ring.cells.values()) {
      if (!cell.ready || !cell.group) continue;
      ctx.frame.toLocal(cell.centerWorld, cell.group.position);
      cells++;
      inst += cell.n;

      const dx = cell.centerWorld.x - p.x, dy = cell.centerWorld.y - p.y, dz = cell.centerWorld.z - p.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const near = Math.max(0, d - cell.radiusW);
      const far = d + cell.radiusW;

      for (const slot of cell.bySpecies.values()) {
        for (let li = 0; li < def.lods.length; li++) {
          const lod = def.lods[li];
          const b = BANDS[lod];
          const want = far >= b.in[0] && near <= b.out[1] && slot.count > 0;
          let m = slot.meshes[lod];
          if (want && !m) {
            m = acquireMesh(ring, slot.spIdx, lod, slot.count);
            uploadMesh(m, slot.mat, slot.flo, slot.count, cell.radiusW);
            cell.group.add(m);
            slot.meshes[lod] = m;
          } else if (!want && m) {
            cell.group.remove(m);
            releaseMesh(ring, slot.spIdx, lod, m);
            slot.meshes[lod] = null;
          }
          if (slot.meshes[lod]) draws++;
        }
      }

      if (def.imposter && cell.imp && cell.imp.count > 0 && S.matImp.uniforms.uAtlas.value) {
        const b = BANDS[3];
        const want = far >= b.in[0] && near <= b.out[1];
        if (want && !cell.imp.mesh) {
          const m = acquireMesh(ring, -1, 3, cell.imp.count);
          uploadMesh(m, cell.imp.mat, cell.imp.attr, cell.imp.count, cell.radiusW);
          cell.group.add(m);
          cell.imp.mesh = m;
        } else if (!want && cell.imp.mesh) {
          cell.group.remove(cell.imp.mesh);
          releaseMesh(ring, -1, 3, cell.imp.mesh);
          cell.imp.mesh = null;
        }
        if (cell.imp.mesh) draws++;
      }
    }
  }

  S.stats.cells = cells;
  S.stats.instances = inst;
  S.stats.draws = draws;
}

// ═════════════════════════════════════════════════════════════════════════════
// UNIFORMES POR FRAME
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Vento, tempo e sol. O vetor de vento é convertido para espaço de VISÃO aqui,
 * uma vez por frame, em vez de por vértice — é a razão de o shader ser barato.
 */
function updateUniforms(dt, ctx) {
  void dt;
  const cam = ctx.engine.camera;

  // ── Direção e força do vento ──────────────────────────────────────────────
  playerDir(ctx, _dir);
  tangentBasis(_dir, _tA, _tB);

  let strength = 0.5;
  const w = ctx.weather?.wind;
  let gotDir = false;
  if (w) {
    const wd = w.direction || w.dir || (Number.isFinite(w.x) ? w : null);
    if (wd && Number.isFinite(wd.x)) {
      _wind.set(wd.x, wd.y, wd.z);
      if (_wind.lengthSq() > 1e-8) { _wind.normalize(); gotDir = true; }
    }
    const sp = w.speed ?? w.strength ?? w.force ?? ctx.weather?.windSpeed;
    if (Number.isFinite(sp)) strength = clamp(sp / 22, 0.06, 1.6);
  }
  if (!gotDir) {
    // Sem módulo de clima: um vento lento que gira, derivado do tempo do jogo.
    const a = S.time * 0.013 + (S.body.seed ? (S.body.seed % 100) * 0.06 : 0);
    _wind.copy(_tA).multiplyScalar(Math.cos(a)).addScaledVector(_tB, Math.sin(a)).normalize();
  }
  // Projeta no plano tangente: vento que empurra a planta para dentro do chão
  // produz o pior artefato possível.
  _wind.addScaledVector(_dir, -_wind.dot(_dir));
  if (_wind.lengthSq() < 1e-6) _wind.copy(_tA);
  _wind.normalize();

  // Amplitude base em metros por unidade de peso de vento.
  const amp = 0.16 + 0.34 * strength;
  _v1.copy(_wind).transformDirection(cam.matrixWorldInverse).multiplyScalar(amp);
  // Leve componente vertical: a planta sobe um pouco na rajada.
  _v1.addScaledVector(_v2.copy(_dir).transformDirection(cam.matrixWorldInverse), amp * 0.12);

  const gustFreq = 1.6;                       // ciclos por km
  const gustSpeed = 0.35 + strength * 0.75;
  const emisK = emissiveGain(ctx);

  for (let l = 0; l < S.matPlant.length; l++) {
    const u = S.matPlant[l].userData.floraUniforms;
    u.uTime.value = S.time;
    u.uWindView.value.copy(_v1);
    u.uWindDirW.value.copy(_wind);
    u.uWindGust.value.set(gustFreq, gustSpeed);
    u.uEmisK.value = emisK;
  }
  // Recalcula a direção radial: emissiveGain reaproveita os temporários.
  playerDir(ctx, _dir);

  // ── Imposter: sol e ambiente ──────────────────────────────────────────────
  if (S.matImp) {
    const u = S.matImp.uniforms;
    const sd = ctx.sky?.sunDirection;
    if (sd && Number.isFinite(sd.x)) _v3.set(sd.x, sd.y, sd.z).normalize();
    else _v3.copy(_dir);
    u.uSunView.value.copy(_v3).transformDirection(cam.matrixWorldInverse);
    const sc = ctx.sky?.sunColor;
    const si = clamp(ctx.sky?.sunIntensity ?? 1, 0, 4);
    if (sc && Number.isFinite(sc.r)) u.uSunColor.value.copy(sc).multiplyScalar(clamp(si, 0.05, 3) * 0.55);
    else u.uSunColor.value.setRGB(0.55, 0.53, 0.48);
    const at = S.biome?.sky?.ambientTint;
    if (Number.isFinite(at)) {
      _col.setHex(at, THREE.SRGBColorSpace);
      u.uAmbient.value.copy(_col).multiplyScalar(0.35);
    }
  }
}

/** Bioluminescência: sobe à noite, quase some ao meio-dia. */
function emissiveGain(ctx) {
  const sd = ctx.sky?.sunDirection;
  if (!sd || !Number.isFinite(sd.x)) return 1;
  playerDir(ctx, _dir);
  const up = _dir.dot(_v2.set(sd.x, sd.y, sd.z).normalize());
  return clamp(1.9 - 1.5 * saturate(up * 1.4 + 0.2), 0.35, 2.2);
}

// ═════════════════════════════════════════════════════════════════════════════
// EVENTOS DO TERRENO
// ═════════════════════════════════════════════════════════════════════════════

/**
 * O terreno mudou (chunk novo ou escavação). As alturas amostradas podem estar
 * defasadas, então as células atingidas voltam para a fila. Sem isso a flora
 * fica flutuando sobre a cratera que o jogador acabou de abrir.
 */
function onTerrainChanged(payload) {
  if (!S.body || !payload) return;
  const c = payload.center || payload.worldCenter || payload.position || payload.node?.center;
  const r = payload.radius ?? payload.size ?? payload.node?.radius ?? 0;
  if (!c || !Number.isFinite(c.x)) { return; }
  const rr = (Number.isFinite(r) && r > 0 ? r : 200);

  for (const ring of S.rings) {
    // Coleta ANTES de mexer: reinserir a mesma chave durante a iteração faria o
    // iterador de Map revisitar a entrada e girar para sempre.
    _dirty.length = 0;
    for (const [key, cell] of ring.cells) {
      const dx = cell.centerWorld.x - c.x, dy = cell.centerWorld.y - c.y, dz = cell.centerWorld.z - c.z;
      const lim = rr + cell.radiusW;
      if (dx * dx + dy * dy + dz * dz > lim * lim) continue;
      _dirty.push(key, cell.face, cell.i, cell.j);
    }
    for (let k = 0; k < _dirty.length; k += 4) {
      const key = _dirty[k];
      const cell = ring.cells.get(key);
      if (!cell) continue;
      freeCell(ring, cell, false);
      ring.cells.delete(key);
      enqueueCell(S.ctx, ring, key, _dirty[k + 1], _dirty[k + 2], _dirty[k + 3]);
    }
    _dirty.length = 0;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// API PÚBLICA
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Remove as plantas dentro de um raio e devolve o que foi colhido.
 * A remoção é PERSISTENTE: fica registrada por célula, então repovoar depois de
 * um rebase ou de uma edição de terreno não ressuscita a árvore cortada.
 *
 * @param {{x:number,y:number,z:number}} worldPos
 * @param {number} radius metros
 * @returns {Array<{type,resource,amount,position:Vec3d}>}
 */
function harvest(worldPos, radius = 3) {
  // Array novo de propósito: colheita é rara e o consumidor guarda o resultado.
  const out = [];
  if (!S.body || !worldPos || !Number.isFinite(worldPos.x)) return out;
  const r2 = radius * radius;

  for (const ring of S.rings) {
    for (const cell of ring.cells.values()) {
      if (!cell.ready || cell.n === 0) continue;
      const cd = (radius + cell.radiusW);
      const ddx = cell.centerWorld.x - worldPos.x;
      const ddy = cell.centerWorld.y - worldPos.y;
      const ddz = cell.centerWorld.z - worldPos.z;
      if (ddx * ddx + ddy * ddy + ddz * ddz > cd * cd) continue;

      const setKey = ring.index + ':' + cell.key;
      let removed = S.removed.get(setKey);
      let touched = false;

      for (let k = 0; k < cell.n; k++) {
        if (!cell.alive[k]) continue;
        const dx = cell.pos[k * 3] - worldPos.x;
        const dy = cell.pos[k * 3 + 1] - worldPos.y;
        const dz = cell.pos[k * 3 + 2] - worldPos.z;
        if (dx * dx + dy * dy + dz * dz > r2) continue;

        cell.alive[k] = 0;
        if (!removed) { removed = new Set(); S.removed.set(setKey, removed); }
        removed.add(k);
        touched = true;

        // Colapsa a matriz para escala zero: o vértice degenera e some sem
        // reordenar o buffer (reordenar invalidaria os índices persistidos).
        const spIdx = cell.typ[k];
        const slot = cell.bySpecies.get(spIdx);
        if (slot) {
          const mo = cell.sIdx[k] * 16;
          for (let q = 0; q < 12; q++) slot.mat[mo + q] = 0;
        }
        if (cell.imp && cell.impIdx[k] >= 0) {
          const io = cell.impIdx[k] * 16;
          for (let q = 0; q < 12; q++) cell.imp.mat[io + q] = 0;
        }

        const sp = S.species[spIdx];
        out.push({
          type: sp.type,
          resource: sp.info.resource,
          amount: Math.max(1, Math.round(sp.height * cell.scl[k] * 4)),
          position: new Vec3d(cell.pos[k * 3], cell.pos[k * 3 + 1], cell.pos[k * 3 + 2]),
        });
      }

      if (touched) reuploadCell(cell);
    }
  }
  // O registro de colheita não pode crescer para sempre numa sessão longa.
  if (S.removed.size > 4096) {
    let drop = S.removed.size - 3072;
    for (const k of S.removed.keys()) { if (drop-- <= 0) break; S.removed.delete(k); }
  }
  return out;
}

function reuploadCell(cell) {
  for (const slot of cell.bySpecies.values()) {
    for (let l = 0; l < slot.meshes.length; l++) {
      const m = slot.meshes[l];
      if (!m) continue;
      m.instanceMatrix.array.set(slot.mat.subarray(0, slot.count * 16));
      m.instanceMatrix.needsUpdate = true;
    }
  }
  if (cell.imp && cell.imp.mesh) {
    cell.imp.mesh.instanceMatrix.array.set(cell.imp.mat.subarray(0, cell.imp.count * 16));
    cell.imp.mesh.instanceMatrix.needsUpdate = true;
  }
}

const _nearOut = [];
const _nearPool = [];

/**
 * Instâncias vivas dentro de um raio. A fauna usa para pastar e para decidir
 * onde se abrigar. Reutiliza um pool de registros — chamar todo frame não aloca.
 *
 * @param {{x:number,y:number,z:number}} pos
 * @param {number} radius metros
 * @param {number} [max] limite de resultados
 */
function instancesNear(pos, radius = 20, max = 64) {
  _nearOut.length = 0;
  if (!S.body || !pos || !Number.isFinite(pos.x)) return _nearOut;
  const r2 = radius * radius;

  for (const ring of S.rings) {
    for (const cell of ring.cells.values()) {
      if (!cell.ready || cell.n === 0) continue;
      const cd = radius + cell.radiusW;
      const ddx = cell.centerWorld.x - pos.x;
      const ddy = cell.centerWorld.y - pos.y;
      const ddz = cell.centerWorld.z - pos.z;
      if (ddx * ddx + ddy * ddy + ddz * ddz > cd * cd) continue;

      for (let k = 0; k < cell.n && _nearOut.length < max; k++) {
        if (!cell.alive[k]) continue;
        const dx = cell.pos[k * 3] - pos.x;
        const dy = cell.pos[k * 3 + 1] - pos.y;
        const dz = cell.pos[k * 3 + 2] - pos.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2) continue;
        const sp = S.species[cell.typ[k]];
        let rec = _nearPool[_nearOut.length];
        if (!rec) { rec = { position: new Vec3d(), type: '', height: 0, scale: 1, distance: 0, edible: false }; _nearPool.push(rec); }
        rec.position.set(cell.pos[k * 3], cell.pos[k * 3 + 1], cell.pos[k * 3 + 2]);
        rec.type = sp.type;
        rec.height = sp.height * cell.scl[k];
        rec.scale = cell.scl[k];
        rec.distance = Math.sqrt(d2);
        rec.edible = !sp.info.tall || sp.type === 'mushroom_tall';
        _nearOut.push(rec);
      }
      if (_nearOut.length >= max) return _nearOut;
    }
  }
  return _nearOut;
}
