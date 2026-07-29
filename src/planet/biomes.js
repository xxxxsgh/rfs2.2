/**
 * Biomas — o contrato de identidade visual do jogo.
 *
 * Sem dependência de `three`: é importado pelo worker de terreno também.
 * Cores em hex 0xRRGGBB, espaço sRGB (converta para linear ao usar em material).
 *
 * ── A linguagem cromática ────────────────────────────────────────────────────
 * O que faz um planeta "parecer No Man's Sky" não é realismo, é a relação entre
 * três camadas:
 *   1. CHÃO fortemente saturado e de matiz inesperado (violeta, ocre queimado,
 *      turquesa) — nunca cinza fotográfico.
 *   2. CÉU em matiz COMPLEMENTAR ou fortemente deslocado em relação ao chão.
 *      O contraste de matiz é o que dá o choque de "outro mundo".
 *   3. NÉVOA AÉREA densa e COLORIDA (não branca) que lava as montanhas
 *      distantes na cor do céu, criando camadas de profundidade legíveis.
 * A saturação cai com a distância, mas o MATIZ persiste. Por isso o horizonte
 * fica colorido em vez de cinza.
 *
 * Cada bioma abaixo respeita essa regra: `palette` e `sky.tint` são escolhidos
 * como par, não isoladamente.
 */

export const BIOME_CLASSES = ['lush', 'toxic', 'radioactive', 'frozen', 'scorched', 'barren', 'exotic', 'ocean'];

/**
 * @typedef {Object} Biome
 * @property {string} id
 * @property {string} name           nome exibido (pt-BR)
 * @property {string} class          classe do arquétipo
 * @property {Object} terrain        parâmetros do gerador de relevo
 * @property {Object} palette        cores da superfície
 * @property {Object} sky            atmosfera e céu
 * @property {Object} flora
 * @property {Object} fauna
 * @property {Object} hazard
 * @property {string[]} weather
 * @property {Object} audio
 */

/** Parâmetros de relevo padrão; cada bioma sobrescreve o que importa. */
const TERRAIN_DEFAULT = {
  /** Altura máxima do relevo em metros (pico a vale). */
  amplitude: 2400,
  /** Frequência base do continente, em ciclos por raio planetário. */
  continentFreq: 1.6,
  /** Peso do fBm ridged (cordilheiras) vs. fBm suave (colinas). */
  ridgeWeight: 0.55,
  /** Nitidez das cristas. >1 afia. */
  ridgeSharpness: 1.35,
  /** Força do domain warping. Alto = formas mais orgânicas e retorcidas. */
  warp: 0.7,
  /** Número de degraus de terraceamento. 0 desativa. */
  terraces: 0,
  /** Nível do mar como fração da amplitude, medido do datum. 0 = sem oceano. */
  seaLevel: 0.32,
  /** Densidade de cavernas (SDF subtrativo). */
  caves: 0.5,
  /** Densidade de arcos e ilhas flutuantes — a assinatura sci-fi. */
  arches: 0.35,
  /** Achatamento de platôs. */
  plateau: 0.0,
  /** Rugosidade de detalhe próximo (metros). */
  detailAmp: 14,
  /** Inclinação (0-1) acima da qual a rocha exposta substitui o solo. */
  cliffSlope: 0.62,
};

function biome(def) {
  return { ...def, terrain: { ...TERRAIN_DEFAULT, ...(def.terrain || {}) } };
}

export const BIOMES = [

  // ── EXUBERANTE ────────────────────────────────────────────────────────────
  // Chão verde-limão/turquesa contra céu lavanda-rosado. O par mais icônico.
  biome({
    id: 'lush_verdant',
    name: 'Exuberante Viridiano',
    class: 'lush',
    terrain: { amplitude: 1900, ridgeWeight: 0.42, warp: 0.95, arches: 0.55, seaLevel: 0.36, caves: 0.62, detailAmp: 18 },
    palette: {
      lowland: 0x4fd44a, midland: 0x2fa86b, highland: 0x7fe3a0,
      cliff: 0x6b5540, cliffAlt: 0x8a6a44,
      sand: 0xe8d9a0, beach: 0xf2e6b8,
      peak: 0xdff5cf, deep: 0x1c5c3a,
      water: 0x18b6c9, waterDeep: 0x0a4a63, foam: 0xd8fbff,
      accent: 0xffe94f,
    },
    sky: {
      tint: 0xd9a8ff, horizon: 0xffc8a8, zenith: 0x6f5fd8,
      rayleigh: [0.32, 0.55, 1.0], mie: 0.0045, mieG: 0.78,
      density: 1.0, fogDensity: 0.000045, fogColor: 0xc9a6f0,
      cloudCover: 0.52, cloudColor: 0xfff2e8, cloudAltitude: 2600,
      ambientTint: 0x8fb8ff, sunTint: 0xfff0d0,
    },
    flora: { density: 1.0, types: ['tree_broad', 'tree_palm', 'bush', 'fern', 'grass', 'mushroom_tall'], hueRange: [0.22, 0.42], saturation: 0.85, maxHeight: 22 },
    fauna: { density: 1.0, temperament: 0.15, sizeRange: [0.6, 4.5], count: 7 },
    hazard: { type: 'none', intensity: 0 },
    weather: ['clear', 'rain', 'fog', 'storm'],
    audio: { ambience: 'jungle', musicMood: 'wonder' },
  }),

  biome({
    id: 'lush_paradise',
    name: 'Paraíso Temperado',
    class: 'lush',
    terrain: { amplitude: 1500, ridgeWeight: 0.3, warp: 1.1, arches: 0.7, seaLevel: 0.44, terraces: 0, caves: 0.5 },
    palette: {
      lowland: 0x8fe04a, midland: 0x53b83c, highland: 0xbdf07a,
      cliff: 0xa8825c, cliffAlt: 0xc09a6a,
      sand: 0xfff0c0, beach: 0xfff7dc,
      peak: 0xffffff, deep: 0x2f6b2a,
      water: 0x2ce0d0, waterDeep: 0x0b6f8a, foam: 0xffffff,
      accent: 0xff7ad9,
    },
    sky: {
      tint: 0x8fd8ff, horizon: 0xffd9b0, zenith: 0x2f7fd8,
      rayleigh: [0.24, 0.48, 1.0], mie: 0.0038, mieG: 0.8,
      density: 1.05, fogDensity: 0.00003, fogColor: 0xa8dcff,
      cloudCover: 0.44, cloudColor: 0xffffff, cloudAltitude: 3000,
      ambientTint: 0xa8d0ff, sunTint: 0xfff4de,
    },
    flora: { density: 1.15, types: ['tree_broad', 'tree_palm', 'flower', 'bush', 'grass'], hueRange: [0.18, 0.35], saturation: 0.8, maxHeight: 26 },
    fauna: { density: 1.2, temperament: 0.08, sizeRange: [0.4, 5.0], count: 8 },
    hazard: { type: 'none', intensity: 0 },
    weather: ['clear', 'rain', 'fog'],
    audio: { ambience: 'meadow', musicMood: 'serene' },
  }),

  // ── TÓXICO ────────────────────────────────────────────────────────────────
  // Verde-ácido luminescente contra céu magenta-sujo. Névoa densa e baixa.
  biome({
    id: 'toxic_mire',
    name: 'Pântano Tóxico',
    class: 'toxic',
    terrain: { amplitude: 1300, ridgeWeight: 0.25, warp: 1.25, seaLevel: 0.5, caves: 0.75, arches: 0.5, detailAmp: 10 },
    palette: {
      lowland: 0x9ed432, midland: 0x5e8f18, highland: 0xc8f04a,
      cliff: 0x4a4630, cliffAlt: 0x63603c,
      sand: 0x8a8a3a, beach: 0xa8a848,
      peak: 0xdaff6a, deep: 0x2c3a10,
      water: 0x7fd400, waterDeep: 0x2f5c00, foam: 0xdaff8a,
      accent: 0xd0ff2e,
    },
    sky: {
      tint: 0xc85ab0, horizon: 0xe08a5a, zenith: 0x5a2a6a,
      rayleigh: [0.85, 0.35, 0.72], mie: 0.011, mieG: 0.7,
      density: 1.6, fogDensity: 0.00016, fogColor: 0xa8c04a,
      cloudCover: 0.72, cloudColor: 0xd8e0a0, cloudAltitude: 1800,
      ambientTint: 0xbfd86a, sunTint: 0xffd8a0,
    },
    flora: { density: 0.9, types: ['mushroom_tall', 'mushroom_cap', 'tendril', 'spore_pod', 'grass'], hueRange: [0.18, 0.28], saturation: 1.0, emissive: 0.35, maxHeight: 16 },
    fauna: { density: 0.6, temperament: 0.45, sizeRange: [0.5, 3.0], count: 5 },
    hazard: { type: 'toxic', intensity: 0.6, damagePerSec: 2.5 },
    weather: ['clear', 'toxicRain', 'fog', 'storm'],
    audio: { ambience: 'swamp', musicMood: 'unease' },
  }),

  // ── RADIOATIVO ────────────────────────────────────────────────────────────
  // Ocre-urânio e amarelo Geiger contra céu verde-doentio.
  biome({
    id: 'irradiated_waste',
    name: 'Ermo Irradiado',
    class: 'radioactive',
    terrain: { amplitude: 2100, ridgeWeight: 0.6, terraces: 7, warp: 0.5, seaLevel: 0.18, caves: 0.55, plateau: 0.4 },
    palette: {
      lowland: 0xd8b13a, midland: 0xa07820, highland: 0xf0da5a,
      cliff: 0x6e5424, cliffAlt: 0x8a6c30,
      sand: 0xe0c060, beach: 0xead27a,
      peak: 0xfff0a0, deep: 0x4a3810,
      water: 0x9ad82e, waterDeep: 0x3e6a10, foam: 0xd8ff7a,
      accent: 0x8aff2e,
    },
    sky: {
      tint: 0x7ad86a, horizon: 0xd8e05a, zenith: 0x1f5a3a,
      rayleigh: [0.42, 1.0, 0.38], mie: 0.008, mieG: 0.76,
      density: 1.25, fogDensity: 0.00009, fogColor: 0xa8d060,
      cloudCover: 0.35, cloudColor: 0xe8f0b0, cloudAltitude: 3400,
      ambientTint: 0xa0d878, sunTint: 0xfff0b0,
    },
    flora: { density: 0.45, types: ['crystal_shard', 'tendril', 'spore_pod', 'dead_tree'], hueRange: [0.12, 0.22], saturation: 0.9, emissive: 0.5, maxHeight: 12 },
    fauna: { density: 0.35, temperament: 0.6, sizeRange: [0.8, 4.0], count: 4 },
    hazard: { type: 'radiation', intensity: 0.7, damagePerSec: 3.0 },
    weather: ['clear', 'dust', 'storm', 'ionStorm'],
    audio: { ambience: 'geiger', musicMood: 'tension' },
  }),

  // ── CONGELADO ─────────────────────────────────────────────────────────────
  // Azul-gelo com sombras violeta e céu ciano pálido. Contraste por VALOR.
  biome({
    id: 'frozen_tundra',
    name: 'Tundra Glacial',
    class: 'frozen',
    terrain: { amplitude: 2800, ridgeWeight: 0.7, ridgeSharpness: 1.6, warp: 0.55, seaLevel: 0.28, caves: 0.65, arches: 0.3, detailAmp: 8 },
    palette: {
      lowland: 0xdcf0ff, midland: 0xa8d4f0, highland: 0xffffff,
      cliff: 0x5a7a96, cliffAlt: 0x7492aa,
      sand: 0xc8dcec, beach: 0xe4f0fa,
      peak: 0xffffff, deep: 0x2a4a6a,
      water: 0x2a86c0, waterDeep: 0x0a3050, foam: 0xffffff,
      accent: 0x6ae0ff,
    },
    sky: {
      tint: 0xa8e8ff, horizon: 0xffd0e0, zenith: 0x2a5aa8,
      rayleigh: [0.28, 0.52, 1.0], mie: 0.003, mieG: 0.82,
      density: 0.85, fogDensity: 0.00007, fogColor: 0xcfe8ff,
      cloudCover: 0.6, cloudColor: 0xffffff, cloudAltitude: 2200,
      ambientTint: 0x9ec4ff, sunTint: 0xfff8f0,
    },
    flora: { density: 0.35, types: ['pine', 'dead_tree', 'crystal_shard', 'grass'], hueRange: [0.42, 0.58], saturation: 0.5, maxHeight: 18 },
    fauna: { density: 0.4, temperament: 0.3, sizeRange: [0.8, 6.0], count: 4 },
    hazard: { type: 'cold', intensity: 0.65, damagePerSec: 2.0 },
    weather: ['clear', 'snow', 'blizzard', 'fog', 'aurora'],
    audio: { ambience: 'wind_cold', musicMood: 'desolate' },
  }),

  // ── ESCALDANTE ────────────────────────────────────────────────────────────
  // Basalto negro + lava incandescente contra céu ocre carregado de fuligem.
  biome({
    id: 'scorched_basalt',
    name: 'Basalto Escaldante',
    class: 'scorched',
    terrain: { amplitude: 2600, ridgeWeight: 0.75, ridgeSharpness: 1.8, warp: 0.85, seaLevel: 0.12, caves: 0.7, arches: 0.45 },
    palette: {
      lowland: 0x3a2822, midland: 0x241a18, highland: 0x5a3a2a,
      cliff: 0x1a1210, cliffAlt: 0x2e2220,
      sand: 0x6a4a34, beach: 0x8a6244,
      peak: 0x8a5a3a, deep: 0x120c0a,
      water: 0xff5a10, waterDeep: 0xb02800, foam: 0xffd070,
      accent: 0xff8a1e,
    },
    sky: {
      tint: 0xff9a4a, horizon: 0xffcf6a, zenith: 0x6a2410,
      rayleigh: [1.0, 0.42, 0.2], mie: 0.014, mieG: 0.72,
      density: 1.35, fogDensity: 0.00013, fogColor: 0xd07a3a,
      cloudCover: 0.5, cloudColor: 0x7a5a4a, cloudAltitude: 3200,
      ambientTint: 0xff9a60, sunTint: 0xffd0a0,
    },
    flora: { density: 0.2, types: ['crystal_shard', 'dead_tree', 'tendril'], hueRange: [0.02, 0.09], saturation: 0.85, emissive: 0.6, maxHeight: 10 },
    fauna: { density: 0.25, temperament: 0.7, sizeRange: [1.0, 5.0], count: 3 },
    hazard: { type: 'heat', intensity: 0.8, damagePerSec: 3.5 },
    weather: ['clear', 'dust', 'firestorm'],
    audio: { ambience: 'volcanic', musicMood: 'menace' },
  }),

  // ── MORTO / ÁRIDO ─────────────────────────────────────────────────────────
  // Cinza-lunar com poeira ferrosa. Céu quase preto: a lua é o ponto de calma.
  biome({
    id: 'barren_regolith',
    name: 'Regolito Morto',
    class: 'barren',
    terrain: { amplitude: 3200, ridgeWeight: 0.5, warp: 0.35, seaLevel: 0, caves: 0.45, arches: 0.25, detailAmp: 6, cliffSlope: 0.55 },
    palette: {
      lowland: 0x9a8f82, midland: 0x6e665c, highland: 0xbfb4a6,
      cliff: 0x4a443e, cliffAlt: 0x5e564e,
      sand: 0xa89880, beach: 0xbaa88e,
      peak: 0xd8cfc0, deep: 0x2e2a26,
      water: 0x000000, waterDeep: 0x000000, foam: 0x000000,
      accent: 0xc06a3a,
    },
    sky: {
      tint: 0x1a1a2a, horizon: 0x3a3244, zenith: 0x06060e,
      rayleigh: [0.1, 0.12, 0.2], mie: 0.0009, mieG: 0.6,
      density: 0.12, fogDensity: 0.000008, fogColor: 0x2a2a3a,
      cloudCover: 0.0, cloudColor: 0x606070, cloudAltitude: 0,
      ambientTint: 0x40506a, sunTint: 0xffffff,
    },
    flora: { density: 0.02, types: ['crystal_shard'], hueRange: [0.55, 0.7], saturation: 0.6, emissive: 0.3, maxHeight: 6 },
    fauna: { density: 0.0, temperament: 0, sizeRange: [0.5, 2], count: 0 },
    hazard: { type: 'vacuum', intensity: 0.5, damagePerSec: 1.2 },
    weather: ['clear', 'dust'],
    audio: { ambience: 'vacuum', musicMood: 'void' },
  }),

  // ── EXÓTICO ───────────────────────────────────────────────────────────────
  // O bioma "impossível": violeta cromado, arcos flutuantes, cristais gigantes.
  biome({
    id: 'exotic_prismatic',
    name: 'Prismático Exótico',
    class: 'exotic',
    terrain: { amplitude: 2200, ridgeWeight: 0.35, warp: 1.6, arches: 1.0, seaLevel: 0.3, caves: 0.8, terraces: 4, detailAmp: 20 },
    palette: {
      lowland: 0x9a4ae0, midland: 0x5e2aa8, highland: 0xd07aff,
      cliff: 0x3a2a5a, cliffAlt: 0x503a78,
      sand: 0xd0a8f0, beach: 0xe8ccff,
      peak: 0xfae0ff, deep: 0x1e1030,
      water: 0x00e0c0, waterDeep: 0x006a70, foam: 0xc0fff0,
      accent: 0x2effd8,
    },
    sky: {
      tint: 0x2ee0c8, horizon: 0xffb8f0, zenith: 0x1a2a6a,
      rayleigh: [0.5, 1.0, 0.85], mie: 0.006, mieG: 0.8,
      density: 1.1, fogDensity: 0.00006, fogColor: 0x6ae0d0,
      cloudCover: 0.4, cloudColor: 0xffd8f8, cloudAltitude: 4200,
      ambientTint: 0x9a7aff, sunTint: 0xfff0ff,
    },
    flora: { density: 0.7, types: ['crystal_shard', 'tendril', 'orb_tree', 'mushroom_tall'], hueRange: [0.72, 0.95], saturation: 1.0, emissive: 0.55, maxHeight: 30 },
    fauna: { density: 0.7, temperament: 0.35, sizeRange: [0.4, 8.0], count: 6 },
    hazard: { type: 'none', intensity: 0 },
    weather: ['clear', 'aurora', 'ionStorm', 'fog'],
    audio: { ambience: 'crystal', musicMood: 'awe' },
  }),

  // ── OCEÂNICO ──────────────────────────────────────────────────────────────
  biome({
    id: 'ocean_archipelago',
    name: 'Arquipélago Oceânico',
    class: 'ocean',
    terrain: { amplitude: 1600, ridgeWeight: 0.4, warp: 1.2, seaLevel: 0.68, caves: 0.4, arches: 0.6 },
    palette: {
      lowland: 0x3ec46a, midland: 0x2a8a5a, highland: 0x8ae0a0,
      cliff: 0x7a6a54, cliffAlt: 0x96866a,
      sand: 0xffeec0, beach: 0xfff8e0,
      peak: 0xe0ffd0, deep: 0x1a5a44,
      water: 0x00c8e8, waterDeep: 0x00405e, foam: 0xffffff,
      accent: 0xffd23a,
    },
    sky: {
      tint: 0x5ac8ff, horizon: 0xffd8b0, zenith: 0x1a5ac0,
      rayleigh: [0.22, 0.46, 1.0], mie: 0.005, mieG: 0.8,
      density: 1.15, fogDensity: 0.00005, fogColor: 0x8ad4ff,
      cloudCover: 0.55, cloudColor: 0xffffff, cloudAltitude: 2400,
      ambientTint: 0x9ad0ff, sunTint: 0xfff2d8,
    },
    flora: { density: 0.85, types: ['tree_palm', 'bush', 'grass', 'coral'], hueRange: [0.2, 0.4], saturation: 0.85, maxHeight: 20 },
    fauna: { density: 0.9, temperament: 0.12, sizeRange: [0.4, 6.0], count: 6 },
    hazard: { type: 'none', intensity: 0 },
    weather: ['clear', 'rain', 'storm', 'fog'],
    audio: { ambience: 'shore', musicMood: 'serene' },
  }),
];

export const BIOME_BY_ID = new Map(BIOMES.map((b) => [b.id, b]));

/** Escolhe o arquétipo de bioma de um planeta a partir do seu Rng. */
export function pickBiome(rng, { starClass = 'G', orbitZone = 'habitable' } = {}) {
  // A zona orbital enviesa fortemente o resultado — o universo tem lógica.
  const weights = BIOMES.map((b) => {
    let w = 1;
    if (orbitZone === 'hot') w *= b.class === 'scorched' ? 6 : b.class === 'barren' ? 3 : b.class === 'radioactive' ? 2 : 0.2;
    else if (orbitZone === 'cold') w *= b.class === 'frozen' ? 6 : b.class === 'barren' ? 3 : b.class === 'exotic' ? 1.5 : 0.2;
    else w *= b.class === 'lush' ? 4 : b.class === 'ocean' ? 2.5 : b.class === 'toxic' ? 2 : b.class === 'exotic' ? 1.2 : 1;
    if (starClass === 'M' && b.class === 'lush') w *= 0.4;
    if (starClass === 'O' || starClass === 'B') w *= b.class === 'scorched' || b.class === 'radioactive' ? 2 : 0.6;
    return w;
  });
  return rng.pickWeighted(BIOMES, weights);
}

/**
 * Aplica variação por planeta: dois planetas do mesmo arquétipo nunca são
 * idênticos. Desloca matiz, amplitude, cobertura de nuvem e nível do mar
 * dentro de faixas que preservam a leitura do bioma.
 */
export function variateBiome(base, rng) {
  const hueShift = rng.range(-0.06, 0.06);
  const satMul = rng.range(0.85, 1.15);
  const b = JSON.parse(JSON.stringify(base));

  for (const key of Object.keys(b.palette)) {
    b.palette[key] = shiftHex(b.palette[key], hueShift, satMul, rng.range(0.94, 1.08));
  }
  for (const key of ['tint', 'horizon', 'zenith', 'fogColor', 'cloudColor', 'ambientTint']) {
    b.sky[key] = shiftHex(b.sky[key], hueShift * 0.7, satMul, rng.range(0.95, 1.06));
  }

  b.terrain.amplitude *= rng.range(0.7, 1.45);
  b.terrain.ridgeWeight = clamp01(b.terrain.ridgeWeight * rng.range(0.75, 1.3));
  b.terrain.warp *= rng.range(0.8, 1.3);
  b.terrain.seaLevel = Math.max(0, Math.min(0.85, b.terrain.seaLevel + rng.range(-0.1, 0.12)));
  b.terrain.arches = clamp01(b.terrain.arches * rng.range(0.5, 1.6));
  if (rng.chance(0.25) && b.terrain.terraces === 0) b.terrain.terraces = rng.intRange(3, 9);

  b.sky.cloudCover = clamp01(b.sky.cloudCover + rng.range(-0.18, 0.22));
  b.sky.density *= rng.range(0.8, 1.25);
  b.sky.fogDensity *= rng.range(0.7, 1.4);
  b.flora.density *= rng.range(0.6, 1.4);
  b.fauna.density *= rng.range(0.5, 1.5);
  b.fauna.count = Math.max(0, Math.round(b.fauna.count * rng.range(0.6, 1.4)));

  b.variantId = base.id + '-' + (rng.int(0xffff)).toString(16);
  return b;
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

/** Desloca matiz/saturação/valor de uma cor hex. */
export function shiftHex(hex, dHue, mSat, mVal) {
  const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
  const [h, s, v] = rgbToHsv(r, g, b);
  const [nr, ng, nb] = hsvToRgb((h + dHue + 1) % 1, clamp01(s * mSat), clamp01(v * mVal));
  return (Math.round(nr * 255) << 16) | (Math.round(ng * 255) << 8) | Math.round(nb * 255);
}

export function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6; if (h < 0) h += 1;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

export function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

/** hex → [r,g,b] linear (para uniforms de shader). */
export function hexToLinear(hex) {
  const s = [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
  return s.map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
}
