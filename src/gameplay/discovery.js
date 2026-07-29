/**
 * AETHER — Registro de descobertas.
 *
 * POR QUÊ este módulo existe separado do inventário: descobrir não é adquirir.
 * O que o jogador leva de um planeta que já esgotou é o *registro* — o nome que
 * ele deu a um bicho, a porcentagem de um mundo concluído, a placa com o seu
 * nome no sistema. Esse é o laço de recompensa central do No Man's Sky e ele
 * precisa de uma contabilidade própria, persistente e determinística.
 *
 * Determinismo: o nome sugerido de qualquer coisa vem de
 * `ctx.rng.derive('discovery', hash(chave))` + `makeName`. Duas sessões com a
 * mesma seed sugerem exatamente os mesmos nomes, na mesma ordem ou fora dela.
 *
 * A UI 2D (catálogo, caixa de renomear) pertence ao módulo `hud`; aqui ficam os
 * dados e os eventos `discovery:new` / `ui:notify`.
 */

import { makeName, hashString } from '../core/rng.js';
import { resourcesForBiome, getItem, biomeClassOf } from './recipes.js';

export const id = 'discovery';
export const order = 58;

/** Recompensa base em unidades por tipo de descoberta. */
const REWARD = {
  planet: 4200,
  species: 900,
  flora: 380,
  mineral: 260,
  system: 6000,
};

/** Rótulo exibido — o HUD usa direto, sem tabela própria. */
const KIND_LABEL = {
  planet: 'Planeta',
  species: 'Espécie',
  flora: 'Flora',
  mineral: 'Mineral',
  system: 'Sistema',
};

const SAVE_DEBOUNCE = 2.0;

const S = {
  ctx: null,
  /** chave "kind:refId" → registro. */
  records: new Map(),
  /** Totais por planeta, calculados a partir do bioma: id → {fauna,flora,mineral}. */
  totals: new Map(),
  units: 0,
  storageKey: '',
  dirty: false,
  saveTimer: 0,
  lastPlanetId: null,
};

// ────────────────────────────────────────────────────────────────────────────
// Ciclo de vida
// ────────────────────────────────────────────────────────────────────────────

export async function init(ctx) {
  S.ctx = ctx;
  S.storageKey = `aether:discovery:${ctx.seed}`;
  load();

  // O jogador chega a um mundo pousando ou atravessando a atmosfera; qualquer
  // um dos dois conta como "esteve aqui".
  ctx.events.on('planet:land', (p) => registerPlanet(p?.planet || ctx.planet?.current));
  ctx.events.on('planet:enterAtmo', (p) => registerPlanet(p?.planet || ctx.planet?.current));
  // O mineral é registrado no primeiro grão extraído — feedback imediato.
  ctx.events.on('mining:hit', onMiningHit);

  // Unidades vivem no jogador para que HUD e comércio leiam de um lugar só.
  if (typeof ctx.player.units !== 'number') ctx.player.units = S.units;
  else S.units = ctx.player.units;

  ctx.provide(id, api);
  ctx.progress?.(0.58, 'registro de descobertas pronto');
}

export function update(dt, ctx) {
  // Trocar de planeta reseta o cache de progresso exibido.
  const body = ctx.planet?.current || null;
  const bid = body ? body.id : null;
  if (bid !== S.lastPlanetId) {
    S.lastPlanetId = bid;
    if (body) ensureTotals(body);
  }

  if (S.dirty) {
    S.saveTimer -= dt;
    if (S.saveTimer <= 0) save();
  }

  if (ctx.debug.enabled) {
    const pr = getPlanetProgress();
    ctx.debug.set('desc', `${S.records.size} reg · planeta ${Math.round(pr.percent * 100)}% · ${S.units | 0} U`);
  }
}

export function dispose() { save(); S.ctx = null; }

// ────────────────────────────────────────────────────────────────────────────
// Nomes
// ────────────────────────────────────────────────────────────────────────────

/**
 * Nome sugerido determinístico. A chave inteira entra no hash, então o mesmo
 * bicho no mesmo planeta recebe sempre a mesma sugestão — inclusive depois de
 * o jogador limpar o localStorage.
 */
function suggestName(key, kind) {
  const rng = S.ctx.rng.derive('discovery', hashString(key));
  if (kind === 'planet') return makeName(rng, { minSyl: 2, maxSyl: 3, suffix: true });
  if (kind === 'system') return makeName(rng, { minSyl: 2, maxSyl: 3, suffix: true });
  if (kind === 'mineral') return makeName(rng, { minSyl: 2, maxSyl: 2 });
  // Fauna e flora ganham binômio: gênero + espécie. É o detalhe que faz o
  // catálogo parecer um caderno de campo em vez de uma lista de IDs.
  return makeName(rng, { minSyl: 2, maxSyl: 3 }) + ' ' + makeName(rng, { minSyl: 1, maxSyl: 2 }).toLowerCase();
}

// ────────────────────────────────────────────────────────────────────────────
// Totais por planeta (denominador do percentual)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Quantas coisas há para achar num mundo. Vem do bioma, não de uma constante:
 * um regolito morto não tem fauna, e o percentual precisa refletir isso ou o
 * jogador nunca fecharia 100 % ali.
 */
function ensureTotals(body) {
  if (!body || !body.id) return null;
  let t = S.totals.get(body.id);
  if (t) return t;

  const biome = body.biome;
  const cls = biomeClassOf(biome);
  const tab = resourcesForBiome(cls);
  const minerals = new Set();
  for (const sub of ['ground', 'rock', 'crystal']) {
    const g = tab[sub];
    if (g) for (let i = 0; i < g.ids.length; i++) minerals.add(g.ids[i]);
  }

  t = {
    fauna: Math.max(0, biome?.fauna?.count || 0),
    flora: Math.max(0, biome?.flora?.types?.length || 0),
    mineral: minerals.size,
    minerals: Array.from(minerals),
  };
  S.totals.set(body.id, t);
  return t;
}

// ────────────────────────────────────────────────────────────────────────────
// Registro
// ────────────────────────────────────────────────────────────────────────────

function keyOf(kind, refId) { return kind + ':' + refId; }

function planetIdNow() {
  const b = S.ctx?.planet?.current;
  return b ? b.id : null;
}
function systemIdNow() {
  const sys = S.ctx?.system || S.ctx?.universe?.current;
  return sys ? sys.id : null;
}

/**
 * Núcleo do registro. Devolve o registro (novo ou já existente) e nunca lança:
 * um módulo que descobre algo não pode quebrar por causa de um campo faltando.
 */
function record(kind, refId, info) {
  if (!S.ctx || !refId) return null;
  const key = keyOf(kind, String(refId));
  const existing = S.records.get(key);
  if (existing) return existing;

  const suggested = suggestName(key, kind);
  const rec = {
    key,
    kind,
    refId: String(refId),
    /** Nome de fábrica do gerador (ex.: o nome do planeta no universo). */
    sourceName: (info && info.name) || null,
    /** Sugestão determinística do registro — é o que aparece antes de renomear. */
    suggested,
    name: (info && info.name) || suggested,
    renamed: false,
    planetId: (info && info.planetId) || planetIdNow(),
    systemId: (info && info.systemId) || systemIdNow(),
    value: rewardFor(kind, info),
    meta: (info && info.meta) || null,
    at: S.ctx.time.elapsed,
  };
  S.records.set(key, rec);
  addUnits(rec.value);
  markDirty();

  S.ctx.events.emit('discovery:new', {
    kind, id: rec.refId, name: rec.name, key,
    value: rec.value, planet: rec.planetId, system: rec.systemId,
  });
  S.ctx.events.emit('ui:notify', {
    text: `${KIND_LABEL[kind] || 'Descoberta'}: ${rec.name}  +${rec.value} U`,
    kind: 'discovery',
  });
  S.ctx.events.emit('audio:cue', { name: 'discovery', params: { kind } });
  return rec;
}

function rewardFor(kind, info) {
  const base = REWARD[kind] || 200;
  // O analisador taxonômico (upgrade de scanner) aumenta o valor do registro.
  const bonus = S.ctx?.inventory?.getBonuses?.().scanValue || 0;
  let scale = 1 + bonus;
  // Bichos grandes e minerais raros valem mais — variação sem aleatoriedade.
  if (kind === 'species' && info?.traits?.sizeM) scale *= 1 + Math.min(1.5, info.traits.sizeM / 6);
  if (kind === 'mineral') {
    const def = getItem(info?.id || info?.refId);
    if (def) scale *= 1 + Math.min(3, def.value / 120);
  }
  return Math.round(base * scale);
}

/** Registra o planeta atual (ou o corpo dado). */
function registerPlanet(body) {
  const b = body || S.ctx?.planet?.current;
  if (!b || !b.id) return null;
  ensureTotals(b);
  return record('planet', b.id, {
    name: b.name,
    planetId: b.id,
    meta: { type: b.type, radius: b.radius, biome: b.biome?.name || null, biomeClass: biomeClassOf(b.biome) },
  });
}

/** Registra o sistema estelar atual (ou o dado). */
function registerSystem(sys) {
  const s = sys || S.ctx?.system || S.ctx?.universe?.current;
  if (!s || !s.id) return null;
  return record('system', s.id, { name: s.name, systemId: s.id });
}

/**
 * Registra uma espécie de fauna. Aceita tanto o objeto rico que o módulo
 * `fauna` envia (`{kind,id,name,traits,planet}`) quanto (id, opts).
 */
function registerSpecies(infoOrId, opts) {
  const info = typeof infoOrId === 'string' ? { id: infoOrId, ...(opts || {}) } : (infoOrId || {});
  if (!info.id) return null;
  return record('species', info.id, {
    name: info.name || null,
    planetId: info.planetId || planetIdNow(),
    meta: { traits: info.traits || null, planet: info.planet || null },
  });
}

/** Registra uma espécie de flora (tipo de planta do bioma atual). */
function registerFlora(infoOrId, opts) {
  const info = typeof infoOrId === 'string' ? { id: infoOrId, ...(opts || {}) } : (infoOrId || {});
  if (!info.id) return null;
  const pid = info.planetId || planetIdNow();
  // A mesma "grama" em dois planetas são duas espécies distintas — a chave
  // precisa do planeta, senão o percentual de um mundo nasce parcialmente cheio.
  return record('flora', `${pid || 'void'}/${info.id}`, {
    name: info.name || null,
    planetId: pid,
    meta: { type: info.type || info.id, height: info.height || 0, resource: info.resource || null },
  });
}

/** Registra um mineral (id do catálogo de recipes.js). */
function registerMineral(infoOrId, opts) {
  const info = typeof infoOrId === 'string' ? { id: infoOrId, ...(opts || {}) } : (infoOrId || {});
  if (!info.id) return null;
  const def = getItem(info.id);
  if (!def) return null;
  const pid = info.planetId || planetIdNow();
  return record('mineral', `${pid || 'void'}/${info.id}`, {
    name: def.name,
    planetId: pid,
    meta: { resource: info.id, symbol: def.symbol, color: def.color, rarity: def.rarity },
    id: info.id,
  });
}

function onMiningHit(p) {
  if (!p || !p.resource) return;
  // Só minérios entram no catálogo: carbono colhido de arbusto é flora.
  if (p.substrate === 'flora' || p.substrate === 'fauna') return;
  registerMineral(p.resource);
}

/**
 * Renomeia. Formas aceitas:
 *   rename('species:abc', 'Novo Nome')
 *   rename('species', 'abc', 'Novo Nome')
 */
function rename(a, b, c) {
  let key, name;
  if (c === undefined) { key = a; name = b; }
  else { key = keyOf(a, String(b)); name = c; }

  const rec = S.records.get(key) || S.records.get(keyOf('species', key)) || null;
  if (!rec) return false;
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) return false;
  rec.name = clean;
  rec.renamed = true;
  markDirty();
  S.ctx?.events.emit('discovery:new', { kind: rec.kind, id: rec.refId, name: rec.name, key: rec.key, renamed: true });
  S.ctx?.events.emit('ui:notify', { text: `Renomeado: ${clean}`, kind: 'info' });
  return true;
}

// ────────────────────────────────────────────────────────────────────────────
// Progresso
// ────────────────────────────────────────────────────────────────────────────

const _progress = {
  planetId: null, name: '', percent: 0, complete: false,
  found: { planet: 0, fauna: 0, flora: 0, mineral: 0 },
  total: { planet: 1, fauna: 0, flora: 0, mineral: 0 },
};

/**
 * Percentual de conclusão de um planeta. Reutiliza um objeto de módulo: o HUD
 * chama isto todo frame e alocar aqui poluiria o GC do caminho quente.
 */
function getPlanetProgress(planetId) {
  const pid = planetId || planetIdNow();
  const body = pid && S.ctx?.planet?.current?.id === pid ? S.ctx.planet.current : null;
  const t = body ? ensureTotals(body) : S.totals.get(pid);

  const out = _progress;
  out.planetId = pid;
  out.name = body ? body.name : (S.records.get(keyOf('planet', pid))?.name || '—');
  out.found.planet = 0; out.found.fauna = 0; out.found.flora = 0; out.found.mineral = 0;
  out.total.planet = 1;
  out.total.fauna = t ? t.fauna : 0;
  out.total.flora = t ? t.flora : 0;
  out.total.mineral = t ? t.mineral : 0;

  if (!pid) { out.percent = 0; out.complete = false; return out; }

  for (const rec of S.records.values()) {
    if (rec.kind === 'planet') { if (rec.refId === pid) out.found.planet = 1; continue; }
    if (rec.planetId !== pid) continue;
    if (rec.kind === 'species') out.found.fauna++;
    else if (rec.kind === 'flora') out.found.flora++;
    else if (rec.kind === 'mineral') out.found.mineral++;
  }

  // Clampa: a fauna pode gerar menos espécies que o bioma anuncia, e um
  // denominador otimista travaria o planeta em 90 % para sempre.
  out.found.fauna = Math.min(out.found.fauna, out.total.fauna);
  out.found.flora = Math.min(out.found.flora, out.total.flora);
  out.found.mineral = Math.min(out.found.mineral, out.total.mineral);

  const found = out.found.planet + out.found.fauna + out.found.flora + out.found.mineral;
  const total = out.total.planet + out.total.fauna + out.total.flora + out.total.mineral;
  out.percent = total > 0 ? Math.min(1, found / total) : 0;
  out.complete = out.percent >= 0.999;
  return out;
}

const _sysProgress = { systemId: null, name: '', percent: 0, planets: 0, planetsFound: 0, bodies: [] };

/** Percentual do sistema: média dos percentuais dos corpos conhecidos. */
function getSystemProgress(systemId) {
  const sys = S.ctx?.system || S.ctx?.universe?.current;
  const sid = systemId || (sys ? sys.id : null);
  const out = _sysProgress;
  out.systemId = sid;
  out.name = sys ? sys.name : '—';
  out.bodies.length = 0;
  out.planets = 0;
  out.planetsFound = 0;

  if (!sys || !Array.isArray(sys.bodies)) { out.percent = 0; return out; }

  let sum = 0;
  for (let i = 0; i < sys.bodies.length; i++) {
    const b = sys.bodies[i];
    if (!b || !b.id) continue;
    out.planets++;
    ensureTotals(b);
    const known = S.records.has(keyOf('planet', b.id));
    if (known) out.planetsFound++;
    // Sem reentrar em getPlanetProgress (ele usa o buffer compartilhado):
    // conta direto para poder listar todos os corpos num frame só.
    const t = S.totals.get(b.id);
    let found = known ? 1 : 0;
    let fa = 0, fl = 0, mi = 0;
    for (const rec of S.records.values()) {
      if (rec.planetId !== b.id) continue;
      if (rec.kind === 'species') fa++;
      else if (rec.kind === 'flora') fl++;
      else if (rec.kind === 'mineral') mi++;
    }
    if (t) {
      fa = Math.min(fa, t.fauna); fl = Math.min(fl, t.flora); mi = Math.min(mi, t.mineral);
    }
    found += fa + fl + mi;
    const total = 1 + (t ? t.fauna + t.flora + t.mineral : 0);
    const pct = total > 0 ? Math.min(1, found / total) : 0;
    sum += pct;
    out.bodies.push({ id: b.id, name: b.name, percent: pct, known });
  }
  out.percent = out.planets > 0 ? sum / out.planets : 0;
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Unidades
// ────────────────────────────────────────────────────────────────────────────

function addUnits(n) {
  if (!n) return S.units;
  S.units = Math.max(0, S.units + n);
  if (S.ctx) S.ctx.player.units = S.units;
  markDirty();
  return S.units;
}

function spendUnits(n) {
  if (S.units < n) return false;
  addUnits(-n);
  return true;
}

// ────────────────────────────────────────────────────────────────────────────
// Persistência
// ────────────────────────────────────────────────────────────────────────────

function markDirty() { S.dirty = true; S.saveTimer = SAVE_DEBOUNCE; }

function save() {
  S.dirty = false;
  S.saveTimer = SAVE_DEBOUNCE;
  try {
    const recs = [];
    for (const r of S.records.values()) {
      // `suggested` é reconstruído no load: guardar só o que o jogador mudou
      // mantém o arquivo pequeno mesmo com milhares de registros.
      recs.push([r.key, r.kind, r.refId, r.renamed ? r.name : 0, r.planetId || 0, r.systemId || 0, r.value | 0]);
    }
    localStorage.setItem(S.storageKey, JSON.stringify({ v: 1, units: S.units | 0, recs }));
  } catch (e) {
    S.ctx?.debug.set('desc:save', 'indisponível');
  }
}

function load() {
  try {
    const raw = localStorage.getItem(S.storageKey);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.recs)) return false;
    S.units = data.units || 0;
    for (let i = 0; i < data.recs.length; i++) {
      const e = data.recs[i];
      if (!Array.isArray(e) || e.length < 3) continue;
      const [key, kind, refId, name, planetId, systemId, value] = e;
      const suggested = suggestName(key, kind);
      S.records.set(key, {
        key, kind, refId,
        sourceName: null,
        suggested,
        name: name || suggested,
        renamed: !!name,
        planetId: planetId || null,
        systemId: systemId || null,
        value: value || 0,
        meta: null,
        at: 0,
      });
    }
    return true;
  } catch (e) {
    return false;
  }
}

function reset() {
  S.records.clear();
  S.totals.clear();
  S.units = 0;
  if (S.ctx) S.ctx.player.units = 0;
  markDirty();
}

// ────────────────────────────────────────────────────────────────────────────
// API pública (ctx.discovery)
// ────────────────────────────────────────────────────────────────────────────

const _listOut = [];

const api = {
  registerPlanet,
  registerSystem,
  registerSpecies,
  registerFlora,
  registerMineral,
  rename,
  getPlanetProgress,
  getSystemProgress,

  get units() { return S.units; },
  addUnits,
  spendUnits,

  get count() { return S.records.size; },
  get records() { return S.records; },

  /** Já conhecido? Aceita (kind, refId) ou a chave inteira. */
  known(kind, refId) {
    return S.records.has(refId === undefined ? kind : keyOf(kind, String(refId)));
  },
  get(kind, refId) {
    return S.records.get(refId === undefined ? kind : keyOf(kind, String(refId))) || null;
  },

  /** Lista filtrada para o catálogo do HUD. Reutiliza o array de saída. */
  list(kind, planetId) {
    _listOut.length = 0;
    for (const r of S.records.values()) {
      if (kind && r.kind !== kind) continue;
      if (planetId && r.planetId !== planetId) continue;
      _listOut.push(r);
    }
    return _listOut;
  },

  labels: KIND_LABEL,
  rewards: REWARD,
  save,
  reset,
};
