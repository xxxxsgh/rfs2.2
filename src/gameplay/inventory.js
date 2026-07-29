/**
 * AETHER — Inventário, refino e fabricação.
 *
 * POR QUÊ uma grade e não uma lista: o inventário do No Man's Sky é um
 * quebra-cabeça espacial. O espaço é escasso, as tecnologias ocupam células e
 * ganham bônus quando ficam *encostadas* umas nas outras. Isso transforma
 * "guardar minério" numa decisão de design do jogador, e é a razão de os slots
 * serem indexados por (linha, coluna) em vez de por nome.
 *
 * Este módulo é a FONTE DA VERDADE dos dados; a UI 2D pertence ao módulo `hud`,
 * que lê `ctx.inventory.slots` e escuta `inventory:change` / `craft:done`.
 *
 * Determinismo: nada aqui é sorteado. A persistência é por seed, então recarregar
 * a página com a mesma seed devolve exatamente a mesma mochila.
 */

import {
  RESOURCES, CATEGORIES, ADJACENCY, TECH_CLASS,
  REFINE_RECIPES, CRAFT_RECIPES, TECH_RECIPES, ALL_RECIPES,
  getRecipe, getItem, isUpgrade, stackValue, emptyBonuses,
} from './recipes.js';

export const id = 'inventory';
export const order = 57;

// ── Geometria da grade ──────────────────────────────────────────────────────
// 8×6 = 48 células. Largo o bastante para caber a fileira de tecnologias sem
// que o jogador tenha de escolher entre minério e upgrade nas primeiras horas.
const COLS = 8;
const ROWS = 6;
const SLOT_COUNT = COLS * ROWS;

const SAVE_DEBOUNCE = 1.5;      // segundos entre gravações no localStorage
const MAX_CHANGE_EVENTS = 12;   // teto de eventos por operação (evita spam)

const S = {
  ctx: null,
  slots: new Array(SLOT_COUNT).fill(null),
  /** Refinador: uma única bancada portátil, como a do jogo. */
  refiner: {
    recipeId: null,
    running: false,
    progress: 0,        // 0..1 do ciclo atual
    cycles: 0,          // ciclos restantes solicitados
    doneCycles: 0,
    lastOutput: null,
  },
  bonuses: emptyBonuses(),
  bonusDirty: true,
  saveTimer: 0,
  dirty: false,
  storageKey: '',
  /** Contador só para telemetria — evita recalcular o total todo frame. */
  usedSlots: 0,
};

// ────────────────────────────────────────────────────────────────────────────
// Ciclo de vida
// ────────────────────────────────────────────────────────────────────────────

export async function init(ctx) {
  S.ctx = ctx;
  S.storageKey = `aether:inventory:${ctx.seed}`;

  if (!load()) seedStartingKit(ctx);
  recount();

  // A multi-ferramenta é a principal fonte de matéria: ela emite 'mining:hit'
  // sem saber se existe inventário. Aqui fechamos o circuito.
  ctx.events.on('mining:hit', onMiningHit);

  // Sair de um sistema é o momento natural de gravar: é a única transição em
  // que o jogador percebe perda de progresso.
  ctx.events.on('system:enter', () => save(true));
  ctx.events.on('planet:land', () => save(true));

  ctx.provide(id, api);
  ctx.progress?.(0.57, 'inventário pronto');
}

export function update(dt, ctx) {
  tickRefiner(dt, ctx);

  if (S.dirty) {
    S.saveTimer -= dt;
    if (S.saveTimer <= 0) save(true);
  }

  if (ctx.debug.enabled) {
    ctx.debug.set('inv', `${S.usedSlots}/${SLOT_COUNT} slots · ref ${S.refiner.running ? Math.round(S.refiner.progress * 100) + '%' : 'off'}`);
  }
}

export function dispose() {
  save(true);
  S.ctx = null;
}

// ────────────────────────────────────────────────────────────────────────────
// Operações de pilha
// ────────────────────────────────────────────────────────────────────────────

function stackLimit(itemId) {
  const def = getItem(itemId);
  return def ? Math.max(1, def.stack) : 1;
}

function recount() {
  let n = 0;
  for (let i = 0; i < SLOT_COUNT; i++) if (S.slots[i]) n++;
  S.usedSlots = n;
}

function emitChange(slotIndex) {
  const st = S.slots[slotIndex];
  S.ctx?.events.emit('inventory:change', {
    slot: slotIndex,
    item: st ? st.id : null,
    count: st ? st.count : 0,
  });
}

function markDirty() {
  S.dirty = true;
  S.saveTimer = SAVE_DEBOUNCE;
  S.bonusDirty = true;
}

/**
 * Adiciona `n` unidades. Preenche primeiro pilhas parciais existentes (é o que
 * o jogador espera), depois slots vazios.
 * @returns {number} quantidade efetivamente adicionada (pode ser < n se lotou)
 */
function add(itemId, n = 1) {
  if (!itemId || !(n > 0)) return 0;
  const def = getItem(itemId);
  if (!def) return 0;
  const limit = stackLimit(itemId);

  let left = Math.floor(n);
  let events = 0;

  // 1) pilhas parciais
  if (limit > 1) {
    for (let i = 0; i < SLOT_COUNT && left > 0; i++) {
      const st = S.slots[i];
      if (!st || st.id !== itemId || st.count >= limit) continue;
      const take = Math.min(limit - st.count, left);
      st.count += take;
      left -= take;
      if (events++ < MAX_CHANGE_EVENTS) emitChange(i);
    }
  }

  // 2) slots vazios
  for (let i = 0; i < SLOT_COUNT && left > 0; i++) {
    if (S.slots[i]) continue;
    const take = Math.min(limit, left);
    S.slots[i] = { id: itemId, count: take };
    left -= take;
    S.usedSlots++;
    if (events++ < MAX_CHANGE_EVENTS) emitChange(i);
  }

  const added = Math.floor(n) - left;
  if (added > 0) markDirty();
  if (left > 0) {
    S.ctx?.events.emit('ui:notify', { text: `Inventário cheio — ${def.name} perdido (${left})`, kind: 'warn' });
  }
  return added;
}

function count(itemId) {
  let total = 0;
  for (let i = 0; i < SLOT_COUNT; i++) {
    const st = S.slots[i];
    if (st && st.id === itemId) total += st.count;
  }
  return total;
}

function has(itemId, n = 1) { return count(itemId) >= n; }

/** Remove `n` unidades a partir das pilhas menores (mantém a grade compacta). */
function remove(itemId, n = 1) {
  if (!itemId || !(n > 0)) return 0;
  let left = Math.floor(n);
  let events = 0;

  // Do fim para o começo: consumir as sobras primeiro deixa a grade mais limpa.
  for (let i = SLOT_COUNT - 1; i >= 0 && left > 0; i--) {
    const st = S.slots[i];
    if (!st || st.id !== itemId) continue;
    const take = Math.min(st.count, left);
    st.count -= take;
    left -= take;
    if (st.count <= 0) { S.slots[i] = null; S.usedSlots--; }
    if (events++ < MAX_CHANGE_EVENTS) emitChange(i);
  }

  const removed = Math.floor(n) - left;
  if (removed > 0) markDirty();
  return removed;
}

/** Troca/funde dois slots — a operação de arrastar-e-soltar do HUD. */
function moveSlot(from, to) {
  if (from === to) return false;
  if (from < 0 || to < 0 || from >= SLOT_COUNT || to >= SLOT_COUNT) return false;
  const a = S.slots[from], b = S.slots[to];
  if (!a) return false;

  if (b && b.id === a.id) {
    // Fusão de pilhas do mesmo item.
    const limit = stackLimit(a.id);
    const take = Math.min(limit - b.count, a.count);
    if (take <= 0) return false;
    b.count += take;
    a.count -= take;
    if (a.count <= 0) { S.slots[from] = null; S.usedSlots--; }
  } else {
    S.slots[to] = a;
    S.slots[from] = b || null;
  }
  emitChange(from);
  emitChange(to);
  markDirty();
  return true;
}

/** Descarta uma pilha inteira (o HUD chama no botão de lixo). */
function dropSlot(index) {
  const st = S.slots[index];
  if (!st) return false;
  S.slots[index] = null;
  S.usedSlots--;
  emitChange(index);
  markDirty();
  return true;
}

// ────────────────────────────────────────────────────────────────────────────
// Tecnologias instaladas e bônus de adjacência
// ────────────────────────────────────────────────────────────────────────────

/**
 * Instala um módulo de tecnologia num slot livre (ou no slot pedido).
 * "Instalar" aqui é literalmente ocupar a célula: a posição na grade É o
 * estado da instalação, e é dela que sai o bônus de adjacência.
 */
function install(upgradeId, slotIndex = -1) {
  if (!isUpgrade(upgradeId)) return false;
  let target = slotIndex;
  if (target < 0 || target >= SLOT_COUNT || S.slots[target]) {
    target = -1;
    // Procura a célula livre com MAIS vizinhos do mesmo grupo — instalar já
    // otimizado é a diferença entre "funciona" e "parece feito por gente".
    const grp = getItem(upgradeId).tech;
    let bestScore = -1;
    for (let i = 0; i < SLOT_COUNT; i++) {
      if (S.slots[i]) continue;
      const sc = neighborCount(i, grp);
      if (sc > bestScore) { bestScore = sc; target = i; }
    }
  }
  if (target < 0) {
    S.ctx?.events.emit('ui:notify', { text: 'Sem espaço para instalar a tecnologia', kind: 'warn' });
    return false;
  }
  S.slots[target] = { id: upgradeId, count: 1 };
  S.usedSlots++;
  emitChange(target);
  markDirty();
  return true;
}

/** Vizinhos ortogonais do mesmo grupo tecnológico. */
function neighborCount(index, group) {
  const c = index % COLS, r = (index / COLS) | 0;
  let n = 0;
  if (c > 0 && groupAt(index - 1) === group) n++;
  if (c < COLS - 1 && groupAt(index + 1) === group) n++;
  if (r > 0 && groupAt(index - COLS) === group) n++;
  if (r < ROWS - 1 && groupAt(index + COLS) === group) n++;
  return n;
}

function groupAt(index) {
  const st = S.slots[index];
  if (!st) return null;
  const def = getItem(st.id);
  return def && def.category === 'technology' ? def.tech : null;
}

/**
 * Soma dos efeitos de todas as tecnologias instaladas, com classe e adjacência.
 * Recalculado apenas quando a grade muda — a multi-ferramenta consulta isto
 * todo frame e não pode pagar uma varredura de 48 células por quadro.
 */
function getBonuses() {
  if (!S.bonusDirty) return S.bonuses;
  const b = S.bonuses;
  for (const k in b) b[k] = 0;

  for (let i = 0; i < SLOT_COUNT; i++) {
    const st = S.slots[i];
    if (!st) continue;
    const def = getItem(st.id);
    if (!def || def.category !== 'technology' || !def.effect) continue;

    const cls = TECH_CLASS[def.cls] || TECH_CLASS.C;
    const adj = Math.min(neighborCount(i, def.tech), ADJACENCY.maxNeighbors);
    const mul = cls.mul * (1 + ADJACENCY.perNeighbor * adj);

    for (const k in def.effect) {
      if (b[k] === undefined) b[k] = 0;
      b[k] += def.effect[k] * mul;
    }
  }
  S.bonusDirty = false;
  return b;
}

/** Detalhamento por slot — o HUD desenha as ligações entre módulos vizinhos. */
function techLayout() {
  const out = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    const st = S.slots[i];
    if (!st) continue;
    const def = getItem(st.id);
    if (!def || def.category !== 'technology') continue;
    const adj = Math.min(neighborCount(i, def.tech), ADJACENCY.maxNeighbors);
    out.push({
      slot: i, col: i % COLS, row: (i / COLS) | 0,
      id: def.id, name: def.name, tech: def.tech, cls: def.cls,
      neighbors: adj,
      multiplier: (TECH_CLASS[def.cls] || TECH_CLASS.C).mul * (1 + ADJACENCY.perNeighbor * adj),
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Fabricação e refino
// ────────────────────────────────────────────────────────────────────────────

function canAfford(recipe) {
  if (!recipe) return false;
  for (let i = 0; i < recipe.inputs.length; i++) {
    if (count(recipe.inputs[i].id) < recipe.inputs[i].n) return false;
  }
  return true;
}

/** Craft instantâneo (bancada de mão). */
function craft(recipeId) {
  const r = getRecipe(recipeId);
  if (!r || r.kind !== 'craft') return false;
  if (!canAfford(r)) {
    S.ctx?.events.emit('ui:notify', { text: `Faltam materiais: ${r.name}`, kind: 'warn' });
    return false;
  }
  for (let i = 0; i < r.inputs.length; i++) remove(r.inputs[i].id, r.inputs[i].n);
  for (let i = 0; i < r.outputs.length; i++) add(r.outputs[i].id, r.outputs[i].n);

  S.ctx?.events.emit('craft:done', { recipe: r.id, name: r.name, outputs: r.outputs });
  S.ctx?.events.emit('ui:notify', { text: `Fabricado: ${r.name}`, kind: 'good' });
  S.ctx?.events.emit('audio:cue', { name: 'craft', params: null });
  return true;
}

/**
 * Enfileira ciclos no refinador. Os insumos do PRIMEIRO ciclo são consumidos
 * imediatamente — o jogador vê a matéria sair da mochila e entrar na máquina,
 * que é o feedback que torna a barra de progresso legível.
 */
function startRefine(recipeId, cycles = 1) {
  const r = getRecipe(recipeId);
  if (!r || r.kind !== 'refine') return false;
  if (!canAfford(r)) {
    S.ctx?.events.emit('ui:notify', { text: `Faltam insumos: ${r.name}`, kind: 'warn' });
    return false;
  }
  const rf = S.refiner;
  rf.recipeId = r.id;
  rf.cycles = Math.max(1, Math.floor(cycles));
  rf.doneCycles = 0;
  rf.progress = 0;
  rf.running = true;
  rf.lastOutput = null;
  consumeCycle(r);
  markDirty();
  return true;
}

function consumeCycle(r) {
  for (let i = 0; i < r.inputs.length; i++) remove(r.inputs[i].id, r.inputs[i].n);
}

function stopRefine(refund = true) {
  const rf = S.refiner;
  if (!rf.running) return false;
  const r = getRecipe(rf.recipeId);
  // Devolve o lote em andamento: perder material por cancelar é frustração
  // gratuita, não profundidade.
  if (refund && r) for (let i = 0; i < r.inputs.length; i++) add(r.inputs[i].id, r.inputs[i].n);
  rf.running = false;
  rf.progress = 0;
  rf.cycles = 0;
  markDirty();
  return true;
}

function tickRefiner(dt, ctx) {
  const rf = S.refiner;
  if (!rf.running) return;
  const r = getRecipe(rf.recipeId);
  if (!r) { rf.running = false; return; }

  const rate = 1 + (getBonuses().refineRate || 0);
  rf.progress += (dt * rate) / Math.max(0.5, r.seconds || 5);
  if (rf.progress < 1) return;

  rf.progress = 0;
  rf.doneCycles++;

  const yieldBonus = getBonuses().refineYield || 0;
  for (let i = 0; i < r.outputs.length; i++) {
    const o = r.outputs[i];
    // O bônus de rendimento vira lote extra *determinístico por contagem*:
    // a cada 1/yieldBonus ciclos sai um lote a mais. Sem Math.random(), o
    // resultado é reproduzível numa mesma sessão de refino.
    let n = o.n;
    if (yieldBonus > 0 && Math.floor(rf.doneCycles * yieldBonus) > Math.floor((rf.doneCycles - 1) * yieldBonus)) n += o.n;
    add(o.id, n);
  }
  rf.lastOutput = r.outputs[0] ? r.outputs[0].id : null;

  ctx.events.emit('craft:done', { recipe: r.id, name: r.name, outputs: r.outputs, refined: true });

  rf.cycles--;
  if (rf.cycles > 0 && canAfford(r)) consumeCycle(r);
  else {
    rf.running = false;
    rf.cycles = 0;
    ctx.events.emit('ui:notify', { text: `Refino concluído: ${r.name}`, kind: 'good' });
  }
  markDirty();
}

// ────────────────────────────────────────────────────────────────────────────
// Integrações
// ────────────────────────────────────────────────────────────────────────────

function onMiningHit(p) {
  if (!p || !p.resource) return;
  const n = Math.max(1, Math.round(p.amount || 1));
  add(p.resource, n);
}

// ────────────────────────────────────────────────────────────────────────────
// Persistência
// ────────────────────────────────────────────────────────────────────────────

/**
 * O kit inicial não é sorteado: começar sempre com o mesmo material mantém o
 * primeiro minuto de jogo estável para o arnês de screenshots e para o
 * jogador que recomeça a mesma seed.
 */
function seedStartingKit(ctx) {
  add('ferrite', 60);
  add('carbon', 40);
  add('sodium', 25);
  install('up_mine_power_c');
  install('up_mine_cooling_c');
  install('up_scan_range_c');
  S.dirty = false;
}

function save(force = false) {
  if (!force && !S.dirty) return;
  S.dirty = false;
  S.saveTimer = SAVE_DEBOUNCE;
  try {
    const payload = {
      v: 1,
      slots: S.slots.map((s) => (s ? [s.id, s.count] : 0)),
      refiner: S.refiner.running
        ? { recipeId: S.refiner.recipeId, progress: S.refiner.progress, cycles: S.refiner.cycles }
        : null,
    };
    localStorage.setItem(S.storageKey, JSON.stringify(payload));
  } catch (e) {
    // Modo privativo / cota estourada: o jogo continua, só não persiste.
    S.ctx?.debug.set('inv:save', 'indisponível');
  }
}

function load() {
  try {
    const raw = localStorage.getItem(S.storageKey);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.slots)) return false;
    for (let i = 0; i < SLOT_COUNT; i++) {
      const e = data.slots[i];
      if (Array.isArray(e) && getItem(e[0]) && e[1] > 0) {
        S.slots[i] = { id: e[0], count: Math.min(e[1], stackLimit(e[0])) };
      } else S.slots[i] = null;
    }
    if (data.refiner && getRecipe(data.refiner.recipeId)) {
      S.refiner.recipeId = data.refiner.recipeId;
      S.refiner.progress = Math.min(0.99, data.refiner.progress || 0);
      S.refiner.cycles = Math.max(1, data.refiner.cycles || 1);
      S.refiner.running = true;
    }
    S.bonusDirty = true;
    return true;
  } catch (e) {
    return false;
  }
}

function reset() {
  for (let i = 0; i < SLOT_COUNT; i++) S.slots[i] = null;
  S.refiner.running = false;
  S.usedSlots = 0;
  seedStartingKit(S.ctx);
  recount();
  markDirty();
  S.ctx?.events.emit('inventory:change', { slot: -1, item: null, count: 0 });
}

// ────────────────────────────────────────────────────────────────────────────
// API pública (ctx.inventory)
// ────────────────────────────────────────────────────────────────────────────

const api = {
  cols: COLS,
  rows: ROWS,
  size: SLOT_COUNT,
  categories: CATEGORIES,

  /** Array cru de slots: `null` ou `{ id, count }`. Somente leitura para o HUD. */
  get slots() { return S.slots; },
  get used() { return S.usedSlots; },
  get free() { return SLOT_COUNT - S.usedSlots; },

  add, remove, has, count,
  moveSlot, dropSlot, install,

  /** Definição completa de um item (nome, cor, símbolo, raridade, valor). */
  itemDef: getItem,
  /** Valor de mercado de uma quantidade. */
  value: stackValue,

  /** Valor total da mochila — o HUD mostra no cabeçalho. */
  totalValue() {
    let v = 0;
    for (let i = 0; i < SLOT_COUNT; i++) {
      const st = S.slots[i];
      if (st) v += stackValue(st.id, st.count);
    }
    return v;
  },

  // ── Craft / refino ──
  craft,
  canCraft(recipeId) { return canAfford(getRecipe(recipeId)); },
  startRefine, stopRefine,
  get refiner() { return S.refiner; },
  /** Receita ativa do refinador, já resolvida (para a barra de progresso). */
  get refinerRecipe() { return S.refiner.running ? getRecipe(S.refiner.recipeId) : null; },
  recipes: ALL_RECIPES,
  refineRecipes: REFINE_RECIPES,
  craftRecipes: CRAFT_RECIPES,
  techRecipes: TECH_RECIPES,
  getRecipe,

  // ── Tecnologias ──
  getBonuses,
  techLayout,
  adjacency: ADJACENCY,

  // ── Manutenção ──
  save: () => save(true),
  reset,
  /** Catálogo completo — o HUD usa para o índice de recursos. */
  resources: RESOURCES,
};
