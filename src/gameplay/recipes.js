/**
 * AETHER — Tabela de dados de recursos, refino, craft e upgrades.
 *
 * POR QUÊ um arquivo só de dados, sem `three` e sem estado:
 *  - o inventário, a multi-ferramenta, o registro de descobertas e (no futuro)
 *    a base compartilham exatamente a mesma verdade sobre "o que existe";
 *  - sem import de `three` este módulo é seguro dentro de um Web Worker;
 *  - sendo puro, é trivialmente determinístico: nenhuma tabela é sorteada em
 *    runtime, apenas *consultada* com um índice derivado de `ctx.rng`.
 *
 * ── Coerência planetária (o ponto que separa um protótipo de um jogo) ────────
 * Um mundo tóxico não pode dar os mesmos minerais de um congelado. As tabelas
 * abaixo são indexadas pela CLASSE de bioma de `src/planet/biomes.js`
 * (`BIOME_CLASSES`), de modo que a paleta química de um planeta combina com a
 * sua paleta visual: crionita azul-gelo em tundra, magmita laranja em basalto,
 * prismita violeta no bioma exótico. As cores dos recursos foram escolhidas
 * dentro da faixa cromática do bioma correspondente — o ícone do HUD "pertence"
 * ao lugar onde o jogador o extraiu.
 */

import { BIOME_CLASSES } from '../planet/biomes.js';

// ────────────────────────────────────────────────────────────────────────────
// Raridade
// ────────────────────────────────────────────────────────────────────────────

/** Escala de raridade: dirige cor de moldura no HUD e multiplicador de valor. */
export const RARITY = {
  common: { id: 'common', name: 'Comum', color: 0xbfc8d4, valueMul: 1.0, order: 0 },
  uncommon: { id: 'uncommon', name: 'Incomum', color: 0x6ae0ff, valueMul: 1.0, order: 1 },
  rare: { id: 'rare', name: 'Raro', color: 0xffd23a, valueMul: 1.0, order: 2 },
  exotic: { id: 'exotic', name: 'Exótico', color: 0xd07aff, valueMul: 1.0, order: 3 },
};

/** Categorias de slot — o inventário separa a grade por elas. */
export const CATEGORIES = ['resource', 'product', 'technology'];

// ────────────────────────────────────────────────────────────────────────────
// Catálogo de recursos
// ────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ResourceDef
 * @property {string} id
 * @property {string} name        nome exibido (pt-BR)
 * @property {string} symbol      símbolo curto, 1-3 caracteres (ícone do HUD)
 * @property {number} color       0xRRGGBB sRGB
 * @property {string} rarity      chave de RARITY
 * @property {number} value       unidades por item
 * @property {number} stack       tamanho máximo da pilha
 * @property {string} category    'resource' | 'product' | 'technology'
 * @property {string[]} where     onde ocorre: 'ground','rock','crystal','flora','fauna','refine','craft'
 * @property {string[]} [biomes]  classes de bioma onde ocorre naturalmente
 */

function res(def) {
  return {
    stack: 250,
    category: 'resource',
    rarity: 'common',
    where: ['ground'],
    biomes: null,
    ...def,
  };
}

const LIST = [
  // ── Elementos universais ──────────────────────────────────────────────────
  // Presentes em todo planeta: são a base da economia e o "chão" do craft.
  res({ id: 'ferrite', name: 'Ferrita', symbol: 'Fe', color: 0x9aa3ad, value: 12, where: ['rock', 'ground'], stack: 500 }),
  res({ id: 'carbon', name: 'Carbono', symbol: 'C', color: 0x46d07a, value: 10, where: ['flora'], stack: 500 }),
  res({ id: 'sodium', name: 'Sódio', symbol: 'Na', color: 0xffd23a, value: 14, where: ['crystal'], rarity: 'uncommon' }),
  res({ id: 'oxygen', name: 'Oxigênio', symbol: 'O', color: 0xff4d5a, value: 16, where: ['flora'], rarity: 'uncommon' }),
  res({ id: 'dihydrogen', name: 'Di-hidrogênio', symbol: 'H', color: 0x3ea8ff, value: 18, where: ['crystal'], rarity: 'uncommon' }),

  // ── EXUBERANTE — verdes e âmbar quente ────────────────────────────────────
  res({ id: 'chlorite', name: 'Clorita', symbol: 'Cl', color: 0x7fe3a0, value: 34, rarity: 'uncommon', where: ['ground', 'rock'], biomes: ['lush'] }),
  res({ id: 'resin', name: 'Resina Viva', symbol: 'Rs', color: 0xffc45a, value: 22, where: ['flora'], biomes: ['lush'] }),
  res({ id: 'emerite', name: 'Emerita', symbol: 'Em', color: 0x2fffb0, value: 220, rarity: 'rare', where: ['crystal'], biomes: ['lush'] }),

  // ── TÓXICO — verde-ácido e magenta sujo ───────────────────────────────────
  res({ id: 'ammonia', name: 'Amônia Cristalizada', symbol: 'Am', color: 0xd0ff2e, value: 38, rarity: 'uncommon', where: ['ground', 'rock'], biomes: ['toxic'] }),
  res({ id: 'fungal_spore', name: 'Esporo Fúngico', symbol: 'Sp', color: 0x9ed432, value: 24, where: ['flora'], biomes: ['toxic'] }),
  res({ id: 'vitriol', name: 'Vitríolo', symbol: 'Vt', color: 0xc85ab0, value: 260, rarity: 'rare', where: ['crystal'], biomes: ['toxic'] }),

  // ── RADIOATIVO — ocre-urânio e amarelo Geiger ─────────────────────────────
  res({ id: 'uranite', name: 'Uranita', symbol: 'Ur', color: 0x8aff2e, value: 46, rarity: 'uncommon', where: ['ground', 'rock'], biomes: ['radioactive'] }),
  res({ id: 'gamma_root', name: 'Raiz Gama', symbol: 'Gr', color: 0xf0da5a, value: 26, where: ['flora'], biomes: ['radioactive'] }),
  res({ id: 'plutonite', name: 'Plutonita', symbol: 'Pu', color: 0x7ad86a, value: 320, rarity: 'rare', where: ['crystal'], biomes: ['radioactive'] }),

  // ── CONGELADO — azul-gelo e violeta de sombra ─────────────────────────────
  res({ id: 'cryonite', name: 'Crionita', symbol: 'Cy', color: 0x6ae0ff, value: 36, rarity: 'uncommon', where: ['ground', 'rock'], biomes: ['frozen'] }),
  res({ id: 'frost_sap', name: 'Seiva Gélida', symbol: 'Fs', color: 0xdcf0ff, value: 22, where: ['flora'], biomes: ['frozen'] }),
  res({ id: 'azurite', name: 'Azurita', symbol: 'Az', color: 0x2a86c0, value: 240, rarity: 'rare', where: ['crystal'], biomes: ['frozen'] }),

  // ── ESCALDANTE — basalto negro e lava ─────────────────────────────────────
  res({ id: 'magmite', name: 'Magmita', symbol: 'Mg', color: 0xff8a1e, value: 42, rarity: 'uncommon', where: ['ground', 'rock'], biomes: ['scorched'] }),
  res({ id: 'sulfur', name: 'Enxofre Vulcânico', symbol: 'S', color: 0xffd070, value: 24, where: ['ground'], biomes: ['scorched'] }),
  res({ id: 'obsidian', name: 'Obsidiana', symbol: 'Ob', color: 0x3a2a28, value: 280, rarity: 'rare', where: ['crystal'], biomes: ['scorched'] }),

  // ── MORTO / ÁRIDO — cinza-lunar e poeira ferrosa ──────────────────────────
  res({ id: 'regolite', name: 'Regolito Denso', symbol: 'Rg', color: 0xbfb4a6, value: 28, rarity: 'uncommon', where: ['ground'], biomes: ['barren'] }),
  res({ id: 'iridium', name: 'Irídio', symbol: 'Ir', color: 0xd8cfc0, value: 55, rarity: 'uncommon', where: ['rock'], biomes: ['barren'] }),
  res({ id: 'platinite', name: 'Platinita', symbol: 'Pt', color: 0xe8eef2, value: 300, rarity: 'rare', where: ['crystal'], biomes: ['barren'] }),

  // ── EXÓTICO — violeta cromado e turquesa ──────────────────────────────────
  res({ id: 'prismite', name: 'Prismita', symbol: 'Pr', color: 0xd07aff, value: 60, rarity: 'uncommon', where: ['crystal', 'rock'], biomes: ['exotic'] }),
  res({ id: 'nullite', name: 'Nulita', symbol: 'Nu', color: 0x2effd8, value: 58, rarity: 'uncommon', where: ['ground'], biomes: ['exotic'] }),
  res({ id: 'aetherite', name: 'Aetherita', symbol: 'Ae', color: 0xfae0ff, value: 640, rarity: 'exotic', where: ['crystal'], biomes: ['exotic'] }),

  // ── OCEÂNICO — turquesa e areia clara ─────────────────────────────────────
  res({ id: 'halite', name: 'Halita', symbol: 'Ha', color: 0xfff8e0, value: 20, where: ['ground'], biomes: ['ocean'] }),
  res({ id: 'coralite', name: 'Coralita', symbol: 'Co', color: 0x00c8e8, value: 32, rarity: 'uncommon', where: ['flora', 'rock'], biomes: ['ocean'] }),
  res({ id: 'aquamarite', name: 'Aquamarita', symbol: 'Aq', color: 0x00e0c0, value: 250, rarity: 'rare', where: ['crystal'], biomes: ['ocean'] }),

  // ── Biológicos (fauna) ────────────────────────────────────────────────────
  res({ id: 'protein', name: 'Proteína Bruta', symbol: 'Pb', color: 0xff8a9a, value: 30, where: ['fauna'] }),
  res({ id: 'chitin', name: 'Quitina', symbol: 'Qt', color: 0xb08a4a, value: 34, rarity: 'uncommon', where: ['fauna'] }),
  res({ id: 'pigment', name: 'Pigmento Floral', symbol: 'Pg', color: 0xff7ad9, value: 26, where: ['flora'] }),
  res({ id: 'silicate', name: 'Silicato Puro', symbol: 'Si', color: 0xc0d8ff, value: 30, rarity: 'uncommon', where: ['flora', 'crystal'] }),
  res({ id: 'calcite', name: 'Calcita', symbol: 'Ca', color: 0xf0e8d0, value: 24, where: ['flora'] }),
  res({ id: 'exotic_bloom', name: 'Flor Exótica', symbol: 'Xb', color: 0xb0ffe0, value: 180, rarity: 'rare', where: ['flora'] }),

  // ── Produtos refinados ────────────────────────────────────────────────────
  res({ id: 'pure_ferrite', name: 'Ferrita Pura', symbol: 'Fe+', color: 0xd6dde5, value: 26, category: 'product', where: ['refine'], stack: 500 }),
  res({ id: 'magnetic_ferrite', name: 'Ferrita Magnetizada', symbol: 'Fe*', color: 0xff9a4a, value: 68, rarity: 'uncommon', category: 'product', where: ['refine'], stack: 500 }),
  res({ id: 'condensed_carbon', name: 'Carbono Condensado', symbol: 'C+', color: 0x7effa0, value: 26, category: 'product', where: ['refine'], stack: 500 }),
  res({ id: 'chromatic_metal', name: 'Metal Cromático', symbol: 'Cm', color: 0xff9a4a, value: 90, rarity: 'uncommon', category: 'product', where: ['refine'] }),
  res({ id: 'living_glass', name: 'Vidro Vivo', symbol: 'Vv', color: 0xc8fff0, value: 210, rarity: 'rare', category: 'product', where: ['refine'] }),
  res({ id: 'carbon_nanotube', name: 'Nanotubo de Carbono', symbol: 'Nt', color: 0x2fa86b, value: 120, rarity: 'uncommon', category: 'product', where: ['craft'] }),
  res({ id: 'circuit_board', name: 'Placa de Circuito', symbol: 'Pc', color: 0x8aff2e, value: 250, rarity: 'rare', category: 'product', where: ['craft'] }),
  res({ id: 'power_cell', name: 'Célula de Energia', symbol: 'Ce', color: 0xffd23a, value: 160, rarity: 'uncommon', category: 'product', where: ['craft'] }),
  res({ id: 'antimatter', name: 'Antimatéria', symbol: 'Ω', color: 0xd07aff, value: 800, rarity: 'exotic', category: 'product', where: ['craft'], stack: 25 }),
  res({ id: 'antimatter_housing', name: 'Cápsula de Contenção', symbol: 'Ωc', color: 0x6ae0ff, value: 320, rarity: 'rare', category: 'product', where: ['craft'], stack: 25 }),
  res({ id: 'warp_cell', name: 'Célula de Warp', symbol: 'Wc', color: 0x2effd8, value: 1200, rarity: 'exotic', category: 'product', where: ['craft'], stack: 10 }),
  res({ id: 'nanites', name: 'Nanites', symbol: 'Nn', color: 0xe8eef2, value: 1, category: 'product', where: ['craft'], stack: 9999 }),
];

/** Índice principal: id → definição. */
export const RESOURCES = Object.freeze(
  LIST.reduce((acc, r) => { acc[r.id] = Object.freeze(r); return acc; }, Object.create(null)),
);

export const RESOURCE_IDS = Object.freeze(LIST.map((r) => r.id));

// ────────────────────────────────────────────────────────────────────────────
// Tabelas por classe de bioma
// ────────────────────────────────────────────────────────────────────────────

/**
 * O que a multi-ferramenta encontra em cada substrato, por classe de bioma.
 * `weights` são paralelos a `ids` — quanto maior, mais frequente.
 *
 * POR QUÊ pesos e não sorteio uniforme: o mineral raro precisa ser *raro* para
 * que reencontrá-lo tenha significado; o comum precisa jorrar para que o feixe
 * de mineração pareça produtivo já nos primeiros segundos.
 */
function tables(primary, secondary, rareId, floraId) {
  return {
    ground: { ids: ['ferrite', primary, secondary], weights: [5, 3, 1.4] },
    rock: { ids: ['ferrite', primary, 'sodium'], weights: [6, 2.2, 0.8] },
    crystal: { ids: ['sodium', 'dihydrogen', rareId], weights: [4, 3, 0.7] },
    flora: { ids: ['carbon', floraId, 'oxygen'], weights: [6, 2.4, 1.2] },
    fauna: { ids: ['protein', 'chitin', 'carbon'], weights: [4, 2, 2] },
    rare: rareId,
    primary,
    secondary,
    floraId,
  };
}

export const BIOME_RESOURCES = Object.freeze({
  lush: tables('chlorite', 'oxygen', 'emerite', 'resin'),
  toxic: tables('ammonia', 'fungal_spore', 'vitriol', 'fungal_spore'),
  radioactive: tables('uranite', 'gamma_root', 'plutonite', 'gamma_root'),
  frozen: tables('cryonite', 'dihydrogen', 'azurite', 'frost_sap'),
  scorched: tables('magmite', 'sulfur', 'obsidian', 'sulfur'),
  barren: tables('regolite', 'iridium', 'platinite', 'silicate'),
  exotic: tables('nullite', 'prismite', 'aetherite', 'exotic_bloom'),
  ocean: tables('halite', 'coralite', 'aquamarite', 'coralite'),
});

// Segurança: se algum dia BIOME_CLASSES ganhar uma classe nova, o fallback
// abaixo evita `undefined` no meio do laço de mineração.
const FALLBACK_TABLE = BIOME_RESOURCES.barren;

/** Tabelas do bioma (aceita a classe, o objeto de bioma ou o corpo celeste). */
export function resourcesForBiome(biomeOrClass) {
  const cls = biomeClassOf(biomeOrClass);
  return BIOME_RESOURCES[cls] || FALLBACK_TABLE;
}

/** Normaliza qualquer coisa (corpo, bioma, string) para a classe de bioma. */
export function biomeClassOf(x) {
  if (!x) return 'barren';
  if (typeof x === 'string') return BIOME_CLASSES.indexOf(x) >= 0 ? x : 'barren';
  if (typeof x.class === 'string') return biomeClassOf(x.class);
  if (x.biome) return biomeClassOf(x.biome);
  return 'barren';
}

/**
 * Escolhe um recurso de um substrato de forma DETERMINÍSTICA a partir de um
 * float [0,1) — normalmente `hash3f` da posição quantizada. A mesma pedra
 * devolve sempre o mesmo minério, mesmo depois de recarregar a página.
 *
 * @param {string|object} biomeOrClass
 * @param {string} substrate 'ground'|'rock'|'crystal'|'flora'|'fauna'
 * @param {number} u float determinístico em [0,1)
 */
export function pickResource(biomeOrClass, substrate, u) {
  const t = resourcesForBiome(biomeOrClass);
  const tab = t[substrate] || t.ground;
  let total = 0;
  for (let i = 0; i < tab.weights.length; i++) total += tab.weights[i];
  let r = (u - Math.floor(u)) * total;
  for (let i = 0; i < tab.ids.length; i++) {
    r -= tab.weights[i];
    if (r <= 0) return tab.ids[i];
  }
  return tab.ids[tab.ids.length - 1];
}

/**
 * Traduz o token de recurso da flora (`plant-gen.js` usa 'carbono', 'fungal',
 * 'esporos', 'silicato', 'pigmento', 'calcio', 'exotico') para um id do
 * catálogo, respeitando o bioma: um "fungal" tóxico rende esporo, um "fungal"
 * exuberante rende resina.
 */
const FLORA_TOKEN = {
  carbono: 'carbon',
  fungal: null,          // depende do bioma
  esporos: 'fungal_spore',
  silicato: 'silicate',
  pigmento: 'pigment',
  calcio: 'calcite',
  exotico: 'exotic_bloom',
};

export function floraResource(token, biomeOrClass) {
  const mapped = FLORA_TOKEN[token];
  if (mapped) return mapped;
  if (mapped === null) return resourcesForBiome(biomeOrClass).floraId;
  // Token desconhecido (outro agente pode ter acrescentado tipos): se já for um
  // id válido usamos direto, senão caímos em carbono.
  return RESOURCES[token] ? token : 'carbon';
}

// ────────────────────────────────────────────────────────────────────────────
// Refino (leva tempo) e craft (instantâneo)
// ────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} Recipe
 * @property {string} id
 * @property {string} name
 * @property {Array<{id:string,n:number}>} inputs
 * @property {Array<{id:string,n:number}>} outputs
 * @property {number} [seconds]  duração de UM ciclo no refinador
 */

function refineOne(id, name, inputs, outputs, seconds) {
  return { id, name, inputs, outputs, seconds, kind: 'refine' };
}

/** Todo isótopo primário de bioma vira Metal Cromático — o elo da economia. */
const CHROMATIC_SOURCES = ['chlorite', 'ammonia', 'uranite', 'cryonite', 'magmite', 'regolite', 'nullite', 'halite'];

export const REFINE_RECIPES = Object.freeze([
  refineOne('rf_pure_ferrite', 'Purificar Ferrita', [{ id: 'ferrite', n: 2 }], [{ id: 'pure_ferrite', n: 1 }], 4),
  refineOne('rf_magnetic_ferrite', 'Magnetizar Ferrita', [{ id: 'pure_ferrite', n: 2 }, { id: 'chromatic_metal', n: 1 }], [{ id: 'magnetic_ferrite', n: 1 }], 9),
  refineOne('rf_condensed_carbon', 'Condensar Carbono', [{ id: 'carbon', n: 2 }], [{ id: 'condensed_carbon', n: 1 }], 4),
  refineOne('rf_carbon_from_flora', 'Reduzir Biomassa', [{ id: 'pigment', n: 1 }, { id: 'calcite', n: 1 }], [{ id: 'carbon', n: 4 }], 5),
  ...CHROMATIC_SOURCES.map((src, i) => refineOne(
    `rf_chromatic_${src}`,
    `Metal Cromático — ${RESOURCES[src].name}`,
    [{ id: src, n: 2 }],
    [{ id: 'chromatic_metal', n: 1 }],
    6 + (i % 3),
  )),
  refineOne('rf_living_glass', 'Vidro Vivo', [{ id: 'silicate', n: 2 }, { id: 'condensed_carbon', n: 2 }], [{ id: 'living_glass', n: 1 }], 14),
  refineOne('rf_oxygen', 'Extrair Oxigênio', [{ id: 'carbon', n: 1 }, { id: 'sodium', n: 1 }], [{ id: 'oxygen', n: 2 }], 5),
  refineOne('rf_nanites', 'Decompor em Nanites', [{ id: 'chitin', n: 2 }, { id: 'protein', n: 2 }], [{ id: 'nanites', n: 12 }], 10),
]);

function craftOne(id, name, inputs, outputs, category) {
  return { id, name, inputs, outputs, kind: 'craft', category: category || 'product' };
}

export const CRAFT_RECIPES = Object.freeze([
  craftOne('cr_nanotube', 'Nanotubo de Carbono', [{ id: 'condensed_carbon', n: 10 }], [{ id: 'carbon_nanotube', n: 1 }]),
  craftOne('cr_circuit', 'Placa de Circuito', [{ id: 'chromatic_metal', n: 5 }, { id: 'carbon_nanotube', n: 1 }], [{ id: 'circuit_board', n: 1 }]),
  craftOne('cr_power_cell', 'Célula de Energia', [{ id: 'sodium', n: 20 }, { id: 'pure_ferrite', n: 10 }], [{ id: 'power_cell', n: 1 }]),
  craftOne('cr_antimatter', 'Antimatéria', [{ id: 'chromatic_metal', n: 25 }, { id: 'condensed_carbon', n: 20 }], [{ id: 'antimatter', n: 1 }]),
  craftOne('cr_housing', 'Cápsula de Contenção', [{ id: 'magnetic_ferrite', n: 4 }, { id: 'living_glass', n: 1 }], [{ id: 'antimatter_housing', n: 1 }]),
  craftOne('cr_warp_cell', 'Célula de Warp', [{ id: 'antimatter', n: 1 }, { id: 'antimatter_housing', n: 1 }], [{ id: 'warp_cell', n: 1 }]),
]);

// ────────────────────────────────────────────────────────────────────────────
// Upgrades (tecnologias instaláveis)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Grupos de tecnologia. O bônus de adjacência só soma entre módulos do MESMO
 * grupo — é o que transforma a grade do inventário num quebra-cabeça espacial,
 * como no No Man's Sky.
 */
export const TECH_GROUPS = Object.freeze({
  mining: { id: 'mining', name: 'Feixe de Mineração', color: 0xff8a1e },
  scanner: { id: 'scanner', name: 'Scanner de Análise', color: 0x2effd8 },
  terrain: { id: 'terrain', name: 'Manipulador de Terreno', color: 0xd07aff },
  suit: { id: 'suit', name: 'Traje de Exossuporte', color: 0x6ae0ff },
  refiner: { id: 'refiner', name: 'Refinador Portátil', color: 0xffd23a },
});

/** Classe do módulo → multiplicador aplicado ao efeito base. */
export const TECH_CLASS = Object.freeze({
  C: { id: 'C', name: 'Classe C', mul: 1.0, color: 0xbfc8d4 },
  B: { id: 'B', name: 'Classe B', mul: 1.35, color: 0x6ae0ff },
  A: { id: 'A', name: 'Classe A', mul: 1.75, color: 0xffd23a },
  S: { id: 'S', name: 'Classe S', mul: 2.3, color: 0xd07aff },
});

/**
 * Bônus de adjacência: cada vizinho ortogonal do mesmo grupo soma
 * `perNeighbor` ao multiplicador do módulo, limitado a `maxNeighbors`.
 * 4 vizinhos ⇒ +72 % — recompensa alta o bastante para o jogador reorganizar
 * a mochila inteira, que é exatamente a intenção.
 */
export const ADJACENCY = Object.freeze({ perNeighbor: 0.18, maxNeighbors: 4 });

/**
 * @typedef {Object} UpgradeDef
 * @property {string} id
 * @property {string} name
 * @property {string} tech    chave de TECH_GROUPS
 * @property {string} cls     chave de TECH_CLASS
 * @property {Array<{id:string,n:number}>} cost
 * @property {Object} effect  campos numéricos SOMADOS pelo inventário
 * @property {string} blurb
 */

function up(id, name, tech, cls, cost, effect, blurb) {
  return { id, name, tech, cls, cost, effect, blurb, category: 'technology' };
}

/**
 * Os campos de `effect` são o CONTRATO com a multi-ferramenta e o traje.
 * Multiplicadores são frações somadas a 1 (mineRate 0.35 ⇒ ×1,35); valores
 * aditivos estão em unidades do mundo (metros, segundos).
 */
export const UPGRADES = Object.freeze([
  up('up_mine_power_c', 'Acelerador de Feixe', 'mining', 'C', [{ id: 'ferrite', n: 30 }, { id: 'chromatic_metal', n: 1 }], { mineRate: 0.30 }, 'Aumenta a taxa de extração do feixe.'),
  up('up_mine_power_b', 'Acelerador de Feixe Σ', 'mining', 'B', [{ id: 'pure_ferrite', n: 40 }, { id: 'chromatic_metal', n: 3 }], { mineRate: 0.30 }, 'Aumenta a taxa de extração do feixe.'),
  up('up_mine_cooling_c', 'Dissipador Térmico', 'mining', 'C', [{ id: 'ferrite', n: 25 }, { id: 'sodium', n: 20 }], { heatRate: -0.25, coolRate: 0.35 }, 'Reduz o aquecimento e acelera o resfriamento.'),
  up('up_mine_cooling_a', 'Dissipador Criogênico', 'mining', 'A', [{ id: 'cryonite', n: 20 }, { id: 'circuit_board', n: 1 }], { heatRate: -0.35, coolRate: 0.6 }, 'Dissipação ativa com fluido criogênico.'),
  up('up_mine_range_b', 'Colimador Focal', 'mining', 'B', [{ id: 'living_glass', n: 1 }, { id: 'chromatic_metal', n: 4 }], { range: 12 }, 'Estende o alcance útil do feixe.'),
  up('up_mine_yield_s', 'Extrator Ressonante', 'mining', 'S', [{ id: 'circuit_board', n: 2 }, { id: 'aetherite', n: 1 }], { mineYield: 0.5, mineRate: 0.2 }, 'Fratura o retículo mineral: mais matéria por segundo.'),

  up('up_scan_range_c', 'Amplificador de Pulso', 'scanner', 'C', [{ id: 'ferrite', n: 20 }, { id: 'carbon', n: 30 }], { scanRadius: 90 }, 'Aumenta o raio do pulso de análise.'),
  up('up_scan_range_a', 'Amplificador de Pulso Σ', 'scanner', 'A', [{ id: 'chromatic_metal', n: 6 }, { id: 'carbon_nanotube', n: 1 }], { scanRadius: 140 }, 'Aumenta o raio do pulso de análise.'),
  up('up_scan_recharge_b', 'Capacitor de Recarga', 'scanner', 'B', [{ id: 'sodium', n: 40 }, { id: 'power_cell', n: 1 }], { scanCooldown: -0.3 }, 'Reduz o tempo de recarga do scanner.'),
  up('up_scan_value_a', 'Analisador Taxonômico', 'scanner', 'A', [{ id: 'circuit_board', n: 1 }, { id: 'living_glass', n: 1 }], { scanValue: 0.45 }, 'Aumenta as unidades por descoberta registrada.'),
  up('up_scan_duration_s', 'Memória Holográfica', 'scanner', 'S', [{ id: 'aetherite', n: 1 }, { id: 'circuit_board', n: 2 }], { scanDuration: 6, scanRadius: 60 }, 'Os marcadores permanecem visíveis por muito mais tempo.'),

  up('up_terrain_radius_c', 'Bocal Largo', 'terrain', 'C', [{ id: 'ferrite', n: 40 }], { terrainRadius: 2.5 }, 'Amplia o volume afetado por disparo.'),
  up('up_terrain_rate_b', 'Compressor de Matéria', 'terrain', 'B', [{ id: 'pure_ferrite', n: 30 }, { id: 'chromatic_metal', n: 2 }], { terrainRate: 0.5 }, 'Escava e preenche mais rápido.'),
  up('up_terrain_restore_a', 'Memória Topológica', 'terrain', 'A', [{ id: 'circuit_board', n: 1 }, { id: 'magnetic_ferrite', n: 2 }], { terrainRadius: 3.5, terrainRate: 0.35 }, 'Modelagem ampla e precisa do relevo.'),

  up('up_suit_hazard_c', 'Blindagem de Risco', 'suit', 'C', [{ id: 'ferrite', n: 30 }, { id: 'oxygen', n: 20 }], { hazardResist: 0.22 }, 'Reduz o dano ambiental do bioma.'),
  up('up_suit_hazard_a', 'Blindagem de Risco Σ', 'suit', 'A', [{ id: 'magnetic_ferrite', n: 3 }, { id: 'living_glass', n: 1 }], { hazardResist: 0.3 }, 'Reduz o dano ambiental do bioma.'),
  up('up_suit_jet_b', 'Injetor de Propulsão', 'suit', 'B', [{ id: 'power_cell', n: 1 }, { id: 'pure_ferrite', n: 20 }], { jetpack: 0.25 }, 'Mais autonomia de mochila propulsora.'),

  up('up_refiner_speed_b', 'Catalisador de Refino', 'refiner', 'B', [{ id: 'chromatic_metal', n: 4 }, { id: 'sodium', n: 30 }], { refineRate: 0.4 }, 'O refinador processa lotes mais rápido.'),
  up('up_refiner_yield_a', 'Peneira Molecular', 'refiner', 'A', [{ id: 'living_glass', n: 1 }, { id: 'carbon_nanotube', n: 1 }], { refineYield: 0.3 }, 'Chance de lote extra a cada ciclo.'),
]);

export const UPGRADE_BY_ID = Object.freeze(
  UPGRADES.reduce((acc, u) => { acc[u.id] = u; return acc; }, Object.create(null)),
);

/** Toda receita indexada — inclui o craft de cada módulo de tecnologia. */
export const TECH_RECIPES = Object.freeze(UPGRADES.map((u) => ({
  id: 'cr_' + u.id,
  name: u.name,
  inputs: u.cost,
  outputs: [{ id: u.id, n: 1 }],
  kind: 'craft',
  category: 'technology',
})));

export const ALL_RECIPES = Object.freeze([...REFINE_RECIPES, ...CRAFT_RECIPES, ...TECH_RECIPES]);

const RECIPE_INDEX = ALL_RECIPES.reduce((acc, r) => { acc[r.id] = r; return acc; }, Object.create(null));

export function getRecipe(id) { return RECIPE_INDEX[id] || null; }

/**
 * Definição de um item por id — resolve tanto recursos quanto módulos de
 * tecnologia, para que o inventário trate os dois com o mesmo código.
 */
export function getItem(id) {
  const r = RESOURCES[id];
  if (r) return r;
  const u = UPGRADE_BY_ID[id];
  if (!u) return null;
  const cls = TECH_CLASS[u.cls] || TECH_CLASS.C;
  const grp = TECH_GROUPS[u.tech] || TECH_GROUPS.mining;
  // Um módulo de tecnologia é um item de pilha 1 — ele ocupa lugar na grade,
  // e é justamente essa escassez de espaço que cria a decisão de layout.
  return {
    id: u.id,
    name: u.name,
    symbol: (grp.name[0] + u.cls),
    color: grp.color,
    rarity: u.cls === 'S' ? 'exotic' : u.cls === 'A' ? 'rare' : u.cls === 'B' ? 'uncommon' : 'common',
    value: Math.round(180 * cls.mul),
    stack: 1,
    category: 'technology',
    where: ['craft'],
    tech: u.tech,
    cls: u.cls,
    effect: u.effect,
    blurb: u.blurb,
  };
}

export function isUpgrade(id) { return !!UPGRADE_BY_ID[id]; }

/** Valor de mercado de uma pilha (usado pelo HUD e pelas descobertas). */
export function stackValue(id, n) {
  const it = getItem(id);
  if (!it) return 0;
  const rar = RARITY[it.rarity] || RARITY.common;
  return Math.round(it.value * rar.valueMul * n);
}

/** Cor de um item, com fallback neutro — o HUD nunca deve receber undefined. */
export function itemColor(id) {
  const it = getItem(id);
  return it ? it.color : 0x9aa3ad;
}

/**
 * Efeitos "zerados": a multi-ferramenta parte daqui e o inventário soma por
 * cima. Manter a lista aqui garante que um upgrade novo nunca vire `NaN`.
 */
export function emptyBonuses() {
  return {
    mineRate: 0, mineYield: 0, heatRate: 0, coolRate: 0, range: 0,
    scanRadius: 0, scanCooldown: 0, scanValue: 0, scanDuration: 0,
    terrainRadius: 0, terrainRate: 0,
    hazardResist: 0, jetpack: 0,
    refineRate: 0, refineYield: 0,
  };
}
