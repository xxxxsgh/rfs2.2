/**
 * Módulo `planet` — streaming do terreno planetário.
 *
 * Responsabilidades:
 *   • manter um quadsphere por corpo ativo e escolher o LOD por frame;
 *   • despachar a geração de malha para um pool de Web Workers, com fila
 *     priorizada por distância e cancelamento de nós já descartados;
 *   • inserir/remover chunks na cena respeitando `ctx.budget`;
 *   • responder consultas de altura/superfície para física, flora e capturas;
 *   • manter `ctx.player.altitude/groundNormal/up/inAtmosphere`.
 *
 * ── Precisão ────────────────────────────────────────────────────────────────
 * Todos os chunks vivem dentro de um único THREE.Group cuja posição é o centro
 * do planeta convertido pela origem flutuante. Os meshes guardam coordenadas em
 * ESPAÇO DO PLANETA (≤ 220 km, folgado para float32) e os vértices são
 * relativos ao centro do próprio nó. Consequência: o rebase da origem e a
 * órbita do planeta custam UMA escrita de vetor, não N. É também o arranjo com
 * melhor precisão, porque a matriz modelView é composta em float64 pelo three e
 * só o resultado — já relativo à câmera — desce para float32.
 */

import * as THREE from 'three';
import { Vec3d } from '../core/frame.js';
import { QuadSphere, HALF_PI } from './quadsphere.js';
import { createField, createPalette } from './terrain-field.js';
import { createTerrainMaterial } from './terrain-shader.js';
import { buildChunk, buildSharedIndex } from './terrain-worker.js';

export const id = 'planet';
export const order = 30;

const GRID_RES = 33;
/**
 * k do critério de split. O nó divide quando `dist - lodR < k*arc`, e como
 * `lodR = 0.72*arc` o alcance efetivo é `(k+0.72)*arc`. Com k=1.55 o triângulo
 * na fronteira do LOD mede (1/32)/2.27 rad ≈ 0,8° — cerca de 11 px em 900 px de
 * altura com 65° de campo. O k anterior (2.2) dava 8 px: detalhe que ninguém vê
 * e que triplicava o número de nós, porque a árvore cresce com k².
 */
const SPLIT_FACTOR = 1.55;
/** Teto duro de nós na árvore — válvula contra explosão em biomas extremos. */
const MAX_NODES = 2600;
// Com o índice compartilhado e os atributos empacotados cada chunk custa
// ~34 KB, então o teto abaixo equivale a ~100 MB de geometria viva. Ele PRECISA
// ficar acima de MAX_NODES: se o gerente pudesse encher de chunks até bater no
// teto, `dispatch` travaria e a fila nunca mais drenaria — foi exatamente esse
// o impasse que segurava 598 chunks pendentes indefinidamente.
const MAX_LIVE_CHUNKS = MAX_NODES + 600;
const MAX_QUEUE = 1200;
/** Margem do frustum, em metros: o que está prestes a entrar no quadro. */
const FRUSTUM_MARGIN = 600;
const CHUNK_TTL_FRAMES = 420;      // ~7 s a 60 fps antes de descartar a malha
const PRUNE_EVERY = 90;

const S = {
  ctx: null,
  body: null,
  qs: null,
  field: null,
  pal: null,
  matInfo: null,
  group: null,
  chunks: new Map(),               // nodeId → {node, mesh, geom, seq, lastSeen}
  queue: new Map(),                // nodeId → {node, score}
  pool: [],
  workersBusy: 0,
  seq: 1,
  gen: 0,
  renderFrame: 0,
  brushes: [],
  /** true quando o corpo foi escolhido de fora (arnês de capturas, warp). */
  manual: false,
  syncMode: false,
  stats: { visible: 0, tris: 0, built: 0 },
  altAboveDatum: Infinity,
  lastNormalFrame: -999,
  /** Média móvel do custo de um chunk no worker (ms) — telemetria da fila. */
  buildMs: 0,
  inFlight: 0,
};

// ── Escratch (zero alocação por frame) ──────────────────────────────────────
const _camLocal = { x: 0, y: 0, z: 0 };
const _v3 = new THREE.Vector3();
const _nrm = new THREE.Vector3();
const _leaves = [];
const _t1 = { x: 0, y: 0, z: 0 };
const _t2 = { x: 0, y: 0, z: 0 };
const _planes = new Float64Array(24);
const _projView = new THREE.Matrix4();
const _shift = new THREE.Matrix4();
const _frustum = new THREE.Frustum();
const _pick = [];

// ────────────────────────────────────────────────────────────────────────────

export async function init(ctx) {
  S.ctx = ctx;

  S.group = new THREE.Group();
  S.group.name = 'planet-terrain';
  S.group.matrixAutoUpdate = true;
  ctx.engine.scene.add(S.group);

  makePool(ctx);

  // O rebase acontece entre update e lateUpdate; reposicionar aqui evita um
  // frame de terreno deslocado se algum outro módulo ler a cena no meio.
  ctx.events.on('frame:rebase', () => repositionGroup());

  const api = {
    get current() { return S.body; },
    get seaLevelRadius() { return S.body ? S.body.radius : 0; },
    get fogUniforms() { return S.matInfo ? S.matInfo.fogUniforms : null; },
    get material() { return S.matInfo ? S.matInfo.material : null; },
    get field() { return S.field; },
    get group() { return S.group; },
    /**
     * Chunks ainda por gerar: fila + jobs em voo. Lido por `src/core/shots.js`
     * (`drainTerrain`) para saber quando o LOD convergiu — se contasse só a
     * fila, a captura dispararia com os últimos chunks ainda dentro dos workers.
     */
    get pendingCount() { return S.queue.size + S.inFlight; },
    /** Telemetria para o arnês de verificação. */
    diag() {
      return {
        leaves: S.qs ? S.qs.leafCount : 0,
        offscreenLeaves: S.qs ? S.qs.offscreenLeaves : 0,
        nodes: S.qs ? S.qs.nodeCount : 0,
        chunks: S.chunks.size,
        visible: S.stats.visible,
        queue: S.queue.size,
        inFlight: S.inFlight,
        workers: S.pool.length,
        buildMs: Math.round(S.buildMs * 100) / 100,
        built: S.stats.built,
      };
    },
    setActive,
    sampleHeight,
    sampleSurface,
    altitudeAt,
    waitReady,
    edit,
    /** Direção unitária (planeta→ponto) a partir de uma posição de mundo. */
    directionTo(worldPos, out) {
      const o = out || new THREE.Vector3();
      if (!S.body) return o.set(0, 1, 0);
      o.set(worldPos.x - S.body.center.x, worldPos.y - S.body.center.y, worldPos.z - S.body.center.z);
      return o.normalize();
    },
    /** Posição de mundo (Vec3d) de um ponto do terreno. */
    surfacePoint(dirUnit, outVec3d, extra = 0) {
      const o = outVec3d || new Vec3d();
      if (!S.body) return o.set(0, 0, 0);
      const r = S.body.radius + sampleHeight(dirUnit) + extra;
      o.set(
        S.body.center.x + dirUnit.x * r,
        S.body.center.y + dirUnit.y * r,
        S.body.center.z + dirUnit.z * r,
      );
      return o;
    },
  };
  ctx.provide(id, api);
  ctx.progress(0.35, 'terreno pronto');
}

// ── Pool de workers ─────────────────────────────────────────────────────────

function makePool(ctx) {
  const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  // Deixa UM núcleo para a thread principal (render + compositor). Reservar
  // dois desperdiçava metade da máquina numa CPU de 4 núcleos — era um dos
  // motivos de a fila não drenar.
  const want = Math.max(2, Math.min(8, hc - 1));
  for (let i = 0; i < want; i++) {
    try {
      const w = new Worker(new URL('./terrain-worker.js', import.meta.url), { type: 'module' });
      const slot = { w, job: null, index: i, dead: false };
      w.onmessage = (ev) => onWorkerMessage(slot, ev.data);
      w.onerror = () => {
        // Worker que morre (módulo não carregou, MIME errado) não pode segurar
        // o slot ocupado para sempre; e se TODOS morrerem, caímos no caminho
        // síncrono em vez de deixar o planeta vazio.
        if (slot.job) { S.workersBusy = Math.max(0, S.workersBusy - 1); slot.job = null; }
        slot.dead = true;
        if (S.pool.every((s) => s.dead)) {
          S.syncMode = true;
          ctx.debug.set('terreno.modo', 'síncrono (workers falharam)');
        }
      };
      S.pool.push(slot);
    } catch (e) {
      break;
    }
  }
  // Sem workers (navegador antigo, file://) o jogo continua: geramos na thread
  // principal fatiando por ctx.budget. Fica lento, mas nada trava.
  S.syncMode = S.pool.length === 0;
  if (S.syncMode) ctx.debug.set('terreno.modo', 'síncrono (sem worker)');
}

function configureWorkers() {
  const msg = {
    type: 'config',
    seed: chunkSeed(S.body),
    terrain: S.body.biome?.terrain || {},
    palette: S.body.biome?.palette || {},
    radius: S.body.radius,
    brushes: S.brushes,
    gen: S.gen,
  };
  for (let i = 0; i < S.pool.length; i++) {
    if (S.pool[i].dead) continue;
    S.pool[i].job = null;
    S.pool[i].w.postMessage(msg);
  }
  S.workersBusy = 0;
  S.inFlight = 0;
}

function chunkSeed(body) {
  return String(body.seed !== undefined ? body.seed : (body.id || body.name || 'planet'));
}

function onWorkerMessage(slot, m) {
  if (!m) return;
  if (m.type === 'chunk' || m.type === 'fail') {
    // Só libera o slot com a resposta DO SEU job: depois de uma troca de
    // planeta ainda chegam respostas antigas, e liberar por elas faria o
    // gerente despachar em cima de um worker que ainda está ocupado.
    if (slot.job && slot.job.seq === m.seq) {
      slot.job = null;
      S.workersBusy = Math.max(0, S.workersBusy - 1);
      S.inFlight = Math.max(0, S.inFlight - 1);
    }
  }
  if (m.type === 'chunk') {
    if (m.buildMs > 0) S.buildMs = S.buildMs === 0 ? m.buildMs : S.buildMs * 0.92 + m.buildMs * 0.08;
    integrate(m);
  } else if (m.type === 'fail') {
    // Sem isto o nó fica marcado como "pedido" para sempre e nunca mais é
    // re-enfileirado: um buraco permanente no terreno.
    const e = S.chunks.get(m.nodeId);
    if (e && e.seq === m.seq && e.pending) S.chunks.delete(m.nodeId);
  }
}

// ── Ciclo de vida do corpo ativo ────────────────────────────────────────────

/**
 * Troca o corpo streamado. Chamado de fora (arnês de capturas, `flight`,
 * `universe`), o corpo passa a ser "manual" e o auto-seleção deixa de brigar
 * por ele — sem isso, `shots.js` escolheria um planeta e o módulo o trocaria
 * nos frames seguintes, porque o jogador ainda não foi teletransportado.
 */
export function setActive(body) {
  S.manual = !!body;
  activate(body);
}

function activate(body) {
  if (S.body === body) return;
  clearActive();
  S.body = body || null;
  if (!S.body) return;

  const ctx = S.ctx;
  const radius = body.radius;
  const terrain = body.biome?.terrain || {};
  const amplitude = Math.max(60, terrain.amplitude || 2400);

  // maxLevel escolhido para que o triângulo da folha tenha ~0,5 m no chão.
  const maxLevel = Math.max(6, Math.min(14, Math.ceil(Math.log2((HALF_PI * radius) / ((GRID_RES - 1) * 0.5)))));

  S.gen++;
  S.field = createField(chunkSeed(body), terrain, { radius });
  S.pal = createPalette(body.biome?.palette || {});
  S.qs = new QuadSphere({
    radius, amplitude, maxLevel, splitFactor: SPLIT_FACTOR, gridRes: GRID_RES,
    maxNodes: MAX_NODES,
  });
  // O culling de horizonte precisa de um raio GARANTIDAMENTE sólido. Usar
  // `radius - amplitude` é correto porém tão pessimista que quase nada é
  // ocultado; uma amostragem esférica barata dá um piso realista com margem.
  S.qs.solidRadius = radius + estimateFloor(S.field, amplitude);
  S.matInfo = createTerrainMaterial(ctx, body.biome, radius);
  S.brushes = [];

  configureWorkers();
  repositionGroup();

  ctx.events.emit('planet:approach', { planet: body });
}

/**
 * Piso conservador do relevo, em metros. Espiral de Fibonacci (determinística,
 * sem RNG) e margem larga: errar para cima apagaria montanhas visíveis.
 */
function estimateFloor(field, amplitude) {
  const N = 192;
  const ga = Math.PI * (3 - Math.sqrt(5));
  let min = Infinity;
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const t = ga * i;
    const h = field.height(Math.cos(t) * r, y, Math.sin(t) * r, 600);
    if (h < min) min = h;
  }
  if (!Number.isFinite(min)) min = -amplitude;
  return Math.max(-amplitude, min - amplitude * 0.28);
}

function clearActive() {
  for (const e of S.chunks.values()) disposeEntry(e);
  S.chunks.clear();
  S.queue.clear();
  if (S.qs) S.qs.dispose(() => {});
  S.qs = null;
  if (S.matInfo) { S.matInfo.dispose(); S.matInfo = null; }
  S.field = null;
  S.pal = null;
  S.body = null;
  for (let i = 0; i < S.pool.length; i++) S.pool[i].job = null;
  S.workersBusy = 0;
  S.inFlight = 0;
}

function disposeEntry(e) {
  if (e.mesh) {
    S.group.remove(e.mesh);
    // O índice é compartilhado por todos os chunks: se ele continuar preso à
    // geometria, `dispose()` apagaria o buffer de GPU que os OUTROS chunks
    // ainda usam, forçando um re-upload a cada descarte.
    e.mesh.geometry.index = null;
    e.mesh.geometry.dispose();
    e.mesh = null;
  }
  e.geom = null;
}

// ── Update ──────────────────────────────────────────────────────────────────

export function update(dt, ctx) {
  autoSelect(ctx);
  if (!S.body || !S.qs) {
    ctx.player.altitude = Infinity;
    if (ctx.player.inAtmosphere) {
      ctx.player.inAtmosphere = false;
      ctx.events.emit('planet:leaveAtmo', { planet: null });
    }
    return;
  }

  const c = S.body.center;
  const p = ctx.player.position;
  _camLocal.x = p.x - c.x; _camLocal.y = p.y - c.y; _camLocal.z = p.z - c.z;

  S.renderFrame++;
  // O grupo é reposicionado aqui (e não só no lateUpdate) porque o frustum é
  // extraído em espaço do planeta a partir de `group.position`: depois de um
  // teleporte o rebase já aconteceu e usar a posição do frame anterior
  // descartaria por um frame tudo o que está na frente da câmera.
  repositionGroup();
  const bias = ctx.quality?.terrainLodBias || 1;
  S.qs.select(_camLocal, _leaves, bias, updateFrustum(ctx));

  requestChunks();
  dispatch(ctx);
  if (S.syncMode) buildSync(ctx);
  render();

  if ((S.renderFrame % PRUNE_EVERY) === 0 || S.chunks.size > MAX_LIVE_CHUNKS) collect();

  updatePlayerGround(ctx);

  ctx.debug.set('terreno.folhas', `${_leaves.length} (${S.qs.offscreenLeaves} fora)`);
  ctx.debug.set('terreno.chunks', `${S.stats.visible}/${S.chunks.size}`);
  ctx.debug.set('terreno.fila', S.queue.size);
  ctx.debug.set('terreno.tris', S.stats.tris);
  ctx.debug.set('terreno.workers', `${S.workersBusy}/${S.pool.length || 'sync'}`);
  ctx.debug.set('terreno.ms/chunk', S.buildMs.toFixed(1));
  ctx.debug.set('terreno.nós', S.qs.nodeCount);
}

/**
 * Planos do frustum em ESPAÇO DO PLANETA.
 *
 * A câmera vive em coordenadas da origem flutuante e os nós em coordenadas do
 * planeta; as duas diferem apenas pela translação `group.position`, então basta
 * compor essa translação antes de extrair os planos — nada de converter 2600
 * centros de nó por frame.
 *
 * Cada plano é afastado por FRUSTUM_MARGIN para que o que está prestes a entrar
 * no quadro já chegue refinado; sem essa folga, girar a câmera mostraria
 * terreno grosso por meio segundo.
 */
function updateFrustum(ctx) {
  const cam = ctx.engine?.camera;
  if (!cam) return null;
  cam.updateMatrixWorld();
  _projView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  _shift.makeTranslation(S.group.position.x, S.group.position.y, S.group.position.z);
  _projView.multiply(_shift);
  _frustum.setFromProjectionMatrix(_projView);
  for (let i = 0; i < 6; i++) {
    const p = _frustum.planes[i];
    const o = i * 4;
    _planes[o] = p.normal.x;
    _planes[o + 1] = p.normal.y;
    _planes[o + 2] = p.normal.z;
    _planes[o + 3] = p.constant + FRUSTUM_MARGIN;
    if (!Number.isFinite(_planes[o] + _planes[o + 3])) return null;
  }
  return _planes;
}

export function lateUpdate(dt, ctx) {
  if (!S.body) return;
  repositionGroup();
  if (!S.matInfo) return;

  const u = S.matInfo.uniforms;
  u.uPlanetOrigin.value.copy(S.group.position);

  // O módulo `sky` é a fonte da verdade do sol quando existe; sem ele usamos a
  // direção do próprio corpo para nunca renderizar com luz indefinida.
  const sun = ctx.sky?.sunDirection;
  if (sun) u.uSunDir.value.copy(sun);
  const sunCol = ctx.sky?.sunColor;
  if (sunCol) u.uSunColor.value.copy(sunCol);
}

function repositionGroup() {
  if (!S.body || !S.group) return;
  S.ctx.frame.toLocal(S.body.center, S.group.position);
}

/** Ativa/desativa o corpo sob o jogador sem depender do módulo `flight`. */
function autoSelect(ctx) {
  const bodies = ctx.system?.bodies || ctx.universe?.current?.bodies;
  if (!bodies || bodies.length === 0) return;
  const p = ctx.player.position;

  // Um corpo escolhido manualmente só é largado muito longe: é o que garante
  // que uma captura possa fixar o planeta antes de teleportar o jogador.
  if (S.body) {
    const keep = S.body.radius * (S.manual ? 40 : 12);
    if (distTo(p, S.body.center) - S.body.radius < keep) return;
  }

  let best = null, bestScore = Infinity;
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    if (!b || !b.center || !b.radius || b.type === 'gas') continue;
    const d = distTo(p, b.center) - b.radius;
    if (d < b.radius * 6 && d < bestScore) { bestScore = d; best = b; }
  }
  if (best !== S.body) { S.manual = false; activate(best); }
}

function distTo(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ── Fila e despacho ─────────────────────────────────────────────────────────

function requestChunks() {
  const f = S.renderFrame;
  for (let i = 0; i < _leaves.length; i++) {
    // Pede a folha E os ancestrais sem malha: o ancestral é o fallback que
    // impede um buraco enquanto a folha não chega. Para no primeiro nó que já
    // tem malha — acima dele o fallback está garantido, e no caso comum (folha
    // já servida) o laço termina na primeira iteração.
    //
    // O caminho inteiro é REAFIRMADO todo frame de propósito: é isso que deixa
    // a varredura de cancelamento lá embaixo distinguir "ainda quero" de "não
    // quero mais" sem precisar de bookkeeping por nó.
    let n = _leaves[i];
    while (n) {
      const e = S.chunks.get(n.id);
      if (e) { if (e.mesh) break; n = n.parent; continue; }
      // Prioridade por NÍVEL e, dentro do nível, por distância.
      // O conjunto desenhado só desce para os filhos quando os QUATRO estão
      // prontos (é o que evita buraco e sobreposição), então servir a fila em
      // largura faz o planeta refinar por camadas inteiras. Ordenar só por
      // distância deixaria folhas profundas prontas sem os irmãos, e nada
      // delas apareceria — trabalho feito e invisível.
      // O que está fora do frustum entra atrás de tudo do mesmo nível: o
      // jogador vê o quadro convergir primeiro e só depois as costas.
      const score = n.level * 3e6 + (n._offscreen ? 1.4e6 : 0) + n._dist;
      const q = S.queue.get(n.id);
      if (q) { q.frame = f; if (score < q.score) q.score = score; }
      else if (S.queue.size < MAX_QUEUE) S.queue.set(n.id, { node: n, score, frame: f });
      n = n.parent;
    }
  }

  // ── Cancelamento ────────────────────────────────────────────────────────
  // O que não foi re-pedido neste frame saiu do conjunto desejado: a câmera
  // girou, o LOD subiu de nível ou a árvore foi podada. Deixar essas entradas
  // na fila faria os workers gastarem segundos produzindo malhas que ninguém
  // mais vai inserir na cena — e era isso que mantinha a fila cheia com a
  // câmera parada, porque o conjunto desejado muda a cada teleporte da captura.
  if (S.queue.size) {
    for (const [k, q] of S.queue) if (q.frame !== f) S.queue.delete(k);
  }
}

/**
 * Devolve até `want` nós da fila em ordem de prioridade (melhor primeiro) e os
 * remove. UMA varredura por lote em vez de uma por slot livre — com oito
 * workers e mil entradas a diferença é linear vs. quadrática.
 */
const _pickScore = [];
function takeBest(want) {
  _pick.length = 0;
  _pickScore.length = 0;
  if (S.queue.size === 0 || want <= 0) return _pick;
  for (const [, q] of S.queue) {
    let i = _pick.length;
    if (i >= want && q.score >= _pickScore[i - 1]) continue;
    if (i < want) { _pick.push(q.node); _pickScore.push(q.score); i++; }
    // Inserção por deslocamento: `want` é ≤ 8, um heap seria overhead puro.
    let j = i - 1;
    while (j > 0 && _pickScore[j - 1] > q.score) {
      _pick[j] = _pick[j - 1]; _pickScore[j] = _pickScore[j - 1]; j--;
    }
    _pick[j] = q.node; _pickScore[j] = q.score;
    if (_pick.length > want) { _pick.pop(); _pickScore.pop(); }
  }
  for (let i = 0; i < _pick.length; i++) S.queue.delete(_pick[i].id);
  return _pick;
}

function makeJob(node) {
  const seq = S.seq++;
  S.chunks.set(node.id, { node, mesh: null, geom: null, seq, lastSeen: S.renderFrame, pending: true });
  return {
    type: 'build',
    nodeId: node.id,
    seq,
    gen: S.gen,
    face: node.face,
    u0: node.u0,
    v0: node.v0,
    size: node.size,
    resolution: GRID_RES,
  };
}

function dispatch(ctx) {
  if (S.syncMode) return;
  let free = 0;
  for (let i = 0; i < S.pool.length; i++) {
    const s = S.pool[i];
    if (!s.job && !s.dead) free++;
  }
  if (free === 0) return;
  // O teto de malhas vivas nunca pode BLOQUEAR o despacho: liberar as frias é o
  // que mantém a fila drenando quando a árvore está no limite.
  if (S.chunks.size + free > MAX_LIVE_CHUNKS) collect();

  const picked = takeBest(free);
  let ki = 0;
  for (let i = 0; i < S.pool.length && ki < picked.length; i++) {
    const slot = S.pool[i];
    if (slot.job || slot.dead) continue;
    const node = picked[ki++];
    if (S.chunks.has(node.id)) { i--; continue; }
    const job = makeJob(node);
    slot.job = job;
    S.workersBusy++;
    S.inFlight++;
    slot.w.postMessage(job);
  }
}

/** Caminho de degradação: gera na thread principal enquanto houver orçamento. */
function buildSync(ctx) {
  let guard = 4;
  while (guard-- > 0 && ctx.budget.canWork() && S.chunks.size < MAX_LIVE_CHUNKS) {
    const picked = takeBest(1);
    if (picked.length === 0) break;
    const node = picked[0];
    if (S.chunks.has(node.id)) continue;
    const job = makeJob(node);
    try {
      const { payload } = buildChunk(job, S.field, S.pal, S.body.radius);
      integrate(payload);
    } catch (e) {
      S.chunks.delete(node.id);
    }
  }
}

// ── Integração do resultado ─────────────────────────────────────────────────

let _sharedIndex = null;
function sharedIndex() {
  if (!_sharedIndex) _sharedIndex = new THREE.BufferAttribute(buildSharedIndex(GRID_RES), 1);
  return _sharedIndex;
}

function integrate(m) {
  if (m.gen !== S.gen) return;                       // planeta trocou: descarta
  const entry = S.chunks.get(m.nodeId);
  if (!entry || entry.seq !== m.seq) return;         // nó descartado: descarta
  const node = entry.node;

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3, true));
  g.setAttribute('color', new THREE.BufferAttribute(m.color, 3, true));
  g.setAttribute('matmix', new THREE.BufferAttribute(m.matmix, 4, true));
  g.setIndex(sharedIndex());
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(m.bs.x, m.bs.y, m.bs.z), m.bs.r);

  const mesh = new THREE.Mesh(g, S.matInfo.material);
  mesh.position.set(m.origin.x, m.origin.y, m.origin.z);
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  mesh.receiveShadow = true;
  // Nós enormes projetando sombra só desperdiçam resolução da cascata.
  mesh.castShadow = node.arc < 4000;
  mesh.visible = false;
  mesh.frustumCulled = true;
  mesh.userData.node = node;
  S.group.add(mesh);

  entry.mesh = mesh;
  entry.pending = false;
  entry.tris = m.triangles;
  entry.lastSeen = S.renderFrame;
  S.stats.built++;

  S.qs.setHeightRange(node, m.hMin, m.hMax);
  S.ctx.events.emit('terrain:chunkReady', { node, planet: S.body, mesh });
}

// ── Seleção do conjunto desenhado (sem buracos, sem sobreposição) ───────────

function nodeReady(node) {
  if (node._readyFrame === S.renderFrame) return node._ready;
  node._readyFrame = S.renderFrame;
  const e = S.chunks.get(node.id);
  let r = !!(e && e.mesh);
  if (!r && node._split && node.children) {
    r = true;
    for (let i = 0; i < 4; i++) {
      if (!nodeReady(node.children[i])) { r = false; break; }
    }
  }
  node._ready = r;
  return r;
}

function emit(node) {
  if (node._culled) return;
  if (node._split && node.children) {
    let all = true;
    for (let i = 0; i < 4; i++) if (!nodeReady(node.children[i])) { all = false; break; }
    if (all) {
      for (let i = 0; i < 4; i++) emit(node.children[i]);
      return;
    }
  }
  const e = S.chunks.get(node.id);
  if (e && e.mesh) {
    e.mesh.visible = true;
    e.lastSeen = S.renderFrame;
    node._renderFrame = S.renderFrame;
    S.stats.visible++;
    S.stats.tris += e.tris || 0;
    return;
  }
  // Nada pronto neste ramo: desce mesmo assim, é melhor um furo temporário do
  // que apagar metade do planeta enquanto o nível grosso carrega.
  if (node._split && node.children) {
    for (let i = 0; i < 4; i++) emit(node.children[i]);
  }
}

function render() {
  for (const e of S.chunks.values()) if (e.mesh) e.mesh.visible = false;
  S.stats.visible = 0;
  S.stats.tris = 0;
  for (let f = 0; f < 6; f++) emit(S.qs.roots[f]);
}

/** Poda a árvore e libera malhas frias. */
function collect() {
  S.qs.prune(CHUNK_TTL_FRAMES, (node) => {
    const e = S.chunks.get(node.id);
    if (e) { disposeEntry(e); S.chunks.delete(node.id); }
    S.queue.delete(node.id);
  });

  const soft = MAX_LIVE_CHUNKS * 0.86;
  if (S.chunks.size <= soft) return;
  // Acima do teto: descarta as malhas mais antigas que não estão em cena. Corta
  // até FOLGADAMENTE abaixo do teto — parar exatamente nele faria `dispatch`
  // chamar `collect` a cada frame para liberar um único slot.
  const cold = [];
  for (const [k, e] of S.chunks) {
    if (e.mesh && S.renderFrame - e.lastSeen > 30) cold.push([k, e]);
  }
  cold.sort((a, b) => a[1].lastSeen - b[1].lastSeen);
  const drop = Math.min(cold.length, Math.ceil(S.chunks.size - soft));
  for (let i = 0; i < drop; i++) { disposeEntry(cold[i][1]); S.chunks.delete(cold[i][0]); }
}

// ── Consultas ───────────────────────────────────────────────────────────────

/** Altura do terreno (m) acima do datum, na direção unitária dada. */
export function sampleHeight(dirUnit, cell) {
  if (!S.field || !dirUnit) return 0;
  const l = Math.sqrt(dirUnit.x * dirUnit.x + dirUnit.y * dirUnit.y + dirUnit.z * dirUnit.z) || 1;
  return S.field.height(dirUnit.x / l, dirUnit.y / l, dirUnit.z / l, cell || 1);
}

/** { height, normal, slope, biomeWeights, … } — aloca, não use por vértice. */
export function sampleSurface(dirUnit, cell) {
  if (!S.field || !dirUnit) {
    return { height: 0, slope: 0, normal: { x: 0, y: 1, z: 0 }, biomeWeights: new Float32Array([1, 0, 0, 0]), biomeMix: new Float32Array([1, 0, 0, 0]), rockiness: 0, moisture: 0.5, temperature: 0.5 };
  }
  const l = Math.sqrt(dirUnit.x * dirUnit.x + dirUnit.y * dirUnit.y + dirUnit.z * dirUnit.z) || 1;
  return S.field.surface(dirUnit.x / l, dirUnit.y / l, dirUnit.z / l, cell || 1);
}

/** Metros acima do terreno (não do datum). */
export function altitudeAt(worldPos) {
  if (!S.body || !S.field) return Infinity;
  const c = S.body.center;
  const dx = worldPos.x - c.x, dy = worldPos.y - c.y, dz = worldPos.z - c.z;
  const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (r < 1e-6) return -S.body.radius;
  const h = S.field.height(dx / r, dy / r, dz / r, 1);
  return r - (S.body.radius + h);
}

/** Base tangente sem alocação — usada para normal e para as sondas de prontidão. */
function tangentBasis(nx, ny, nz) {
  const poleish = Math.abs(ny) > 0.9;
  const rx = poleish ? 1 : 0, ry = poleish ? 0 : 1;
  let ax = ry * nz - 0 * ny, ay = 0 * nx - rx * nz, az = rx * ny - ry * nx;
  const al = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
  ax /= al; ay /= al; az /= al;
  _t1.x = ax; _t1.y = ay; _t1.z = az;
  _t2.x = ny * az - nz * ay;
  _t2.y = nz * ax - nx * az;
  _t2.z = nx * ay - ny * ax;
}

function updatePlayerGround(ctx) {
  const c = S.body.center;
  const p = ctx.player.position;
  const dx = p.x - c.x, dy = p.y - c.y, dz = p.z - c.z;
  const r = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  const nx = dx / r, ny = dy / r, nz = dz / r;
  ctx.player.up.set(nx, ny, nz);

  S.altAboveDatum = r - S.body.radius;
  const h = S.field.height(nx, ny, nz, 1);
  ctx.player.altitude = r - (S.body.radius + h);

  // A normal do solo custa 4 amostras extras; só interessa perto do chão e
  // não precisa de taxa de frame cheia.
  if (ctx.player.altitude < 400 && S.renderFrame - S.lastNormalFrame > 2) {
    S.lastNormalFrame = S.renderFrame;
    tangentBasis(nx, ny, nz);
    const ds = 0.75;
    const d = ds / S.body.radius;
    const hA = S.field.height(nx + _t1.x * d, ny + _t1.y * d, nz + _t1.z * d, 1);
    const hB = S.field.height(nx - _t1.x * d, ny - _t1.y * d, nz - _t1.z * d, 1);
    const hC = S.field.height(nx + _t2.x * d, ny + _t2.y * d, nz + _t2.z * d, 1);
    const hD = S.field.height(nx - _t2.x * d, ny - _t2.y * d, nz - _t2.z * d, 1);
    const g1 = (hA - hB) / (2 * ds), g2 = (hC - hD) / (2 * ds);
    _nrm.set(
      nx - _t1.x * g1 - _t2.x * g2,
      ny - _t1.y * g1 - _t2.y * g2,
      nz - _t1.z * g1 - _t2.z * g2,
    ).normalize();
    ctx.player.groundNormal.copy(_nrm);
  } else if (ctx.player.altitude >= 400) {
    ctx.player.groundNormal.set(nx, ny, nz);
  }

  const atmoTop = S.body.radius * 0.06;
  const inAtmo = S.altAboveDatum < atmoTop;
  if (inAtmo !== ctx.player.inAtmosphere) {
    ctx.player.inAtmosphere = inAtmo;
    ctx.events.emit(inAtmo ? 'planet:enterAtmo' : 'planet:leaveAtmo', { planet: S.body });
  }
}

// ── waitReady ───────────────────────────────────────────────────────────────

/**
 * Resolve quando os chunks em torno do ponto já estão NA CENA no nível que o
 * LOD escolheria. O arnês de screenshots depende disso: sem essa garantia as
 * capturas saem com o terreno grosso ou vazio. NUNCA rejeita — no pior caso
 * resolve `false` no timeout, e a captura sai como estiver.
 */
export function waitReady(worldPos, ms = 8000) {
  return new Promise((resolve) => {
    if (!S.body || !S.qs) { resolve(false); return; }
    const c = S.body.center;
    const dx = worldPos.x - c.x, dy = worldPos.y - c.y, dz = worldPos.z - c.z;
    const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const dir = { x: dx / l, y: dy / l, z: dz / l };
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    const tick = () => {
      if (!S.body || !S.qs) { resolve(false); return; }
      if (areaReady(dir)) { resolve(true); return; }
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      if (now - t0 > ms) { resolve(false); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

function probeReady(nx, ny, nz) {
  const bias = S.ctx.quality?.terrainLodBias || 1;
  const dir = _v3.set(nx, ny, nz);
  const want = S.qs.wantedLevel(_camLocal, dir, bias);
  let n = S.qs.selectedLeafAt(dir);
  while (n && n._renderFrame !== S.renderFrame) n = n.parent;
  if (!n) return false;
  return n.level >= Math.min(want, S.qs.maxLevel) - 1;
}

function areaReady(dir) {
  if (!probeReady(dir.x, dir.y, dir.z)) return false;
  // Também exige o entorno: um único chunk pronto sob os pés ainda deixaria o
  // horizonte pela metade na captura.
  const leaf = S.qs.selectedLeafAt(_v3.set(dir.x, dir.y, dir.z));
  const ang = Math.min(0.02, (leaf.arc * 1.6) / S.body.radius);
  tangentBasis(dir.x, dir.y, dir.z);
  for (let k = 0; k < 4; k++) {
    const t = (k & 1) ? _t2 : _t1;
    const s = (k & 2) ? -ang : ang;
    let px = dir.x + t.x * s, py = dir.y + t.y * s, pz = dir.z + t.z * s;
    const pl = Math.sqrt(px * px + py * py + pz * pz) || 1;
    if (!probeReady(px / pl, py / pl, pz / pl)) return false;
  }
  return true;
}

// ── Terrain manipulator ─────────────────────────────────────────────────────

/**
 * Escava/deposita terreno. A edição vira um pincel no mapa esparso (chave =
 * célula de grade em coordenadas de face) que o worker soma à função de altura;
 * os chunks afetados são invalidados e regerados.
 */
export function edit(worldPos, radius, delta) {
  if (!S.body || !S.field) return null;
  const c = S.body.center;
  const dx = worldPos.x - c.x, dy = worldPos.y - c.y, dz = worldPos.z - c.z;
  const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  const nx = dx / l, ny = dy / l, nz = dz / l;

  const brush = S.field.editMap.add(nx, ny, nz, radius, delta);
  const wire = { x: brush.x, y: brush.y, z: brush.z, ang: brush.ang, r: brush.r, delta: brush.delta };
  S.brushes.push(wire);
  for (let i = 0; i < S.pool.length; i++) {
    if (!S.pool[i].dead) S.pool[i].w.postMessage({ type: 'edit', brush: wire });
  }

  // Invalida tudo que a esfera do pincel toca. Edições são raras: uma varredura
  // completa da árvore é mais simples e mais segura que um índice espacial.
  const h = S.field.height(nx, ny, nz, 1);
  const wx = nx * (S.body.radius + h), wy = ny * (S.body.radius + h), wz = nz * (S.body.radius + h);
  const reach = Math.abs(radius) + Math.abs(delta) + 8;
  const stack = S.qs.roots.slice();
  while (stack.length) {
    const n = stack.pop();
    const ddx = n.cx - wx, ddy = n.cy - wy, ddz = n.cz - wz;
    const d = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
    if (d > n.boundR + reach) continue;
    const e = S.chunks.get(n.id);
    if (e) { disposeEntry(e); S.chunks.delete(n.id); }
    if (n.children) for (let i = 0; i < 4; i++) stack.push(n.children[i]);
  }

  S.ctx.events.emit('terrain:edit', { center: worldPos, radius, delta, brush: wire });
  return wire;
}

// ── Encerramento ────────────────────────────────────────────────────────────

export function dispose(ctx) {
  clearActive();
  for (let i = 0; i < S.pool.length; i++) { try { S.pool[i].w.terminate(); } catch (e) { /* já morto */ } }
  S.pool.length = 0;
  if (S.group) { ctx.engine.scene.remove(S.group); S.group = null; }
}
