/**
 * Classes espectrais — física estelar de verdade, comprimida para caber no jogo.
 *
 * Por que este arquivo não importa `three`: ele é matemática pura e precisa
 * poder ser exercitado fora do navegador (node --check, testes, workers).
 *
 * ── A cor de uma estrela ─────────────────────────────────────────────────────
 * Não usamos uma tabela de cores chutada. A cor sai do caminho físico completo:
 *
 *   1. Lei de Planck B(λ,T) → radiância espectral do corpo negro.
 *   2. Integração contra as funções de correspondência de cor CIE 1931
 *      (x̄,ȳ,z̄), aproximadas pelo ajuste multi-lóbulo de Wyman, Sloan &
 *      Shirley (2013) — erro < 1% e sem tabela de 471 linhas no bundle.
 *   3. XYZ → sRGB linear (matriz Rec.709/D65).
 *   4. Dessaturação mínima para tirar componentes negativos (cores fora do
 *      gamut sRGB, comuns abaixo de 2500 K) e normalização pelo pico.
 *
 * O resultado importa visualmente: uma K de 4200 K sai âmbar-alaranjada, uma A
 * de 9000 K sai branco-azulada com um leve viés lilás. Isso é o que separa um
 * céu que "parece certo" de um céu com sóis coloridos a dedo.
 *
 * ── Escala do jogo ───────────────────────────────────────────────────────────
 * Raios e massas são devolvidos em unidades SOLARES. Quem converte para metros
 * é o módulo `universe`, porque a conversão depende da compressão do sistema
 * (ver comentário sobre `auToM` lá). Aqui só existe física.
 */

// ── Constantes físicas (SI) ─────────────────────────────────────────────────
const H_PLANCK = 6.62607015e-34;   // J·s
const C_LIGHT = 2.99792458e8;      // m/s
const K_BOLTZ = 1.380649e-23;      // J/K

/** Gaussiana de largura assimétrica — o bloco básico do ajuste de Wyman et al. */
function gLobe(x, mu, sigmaLow, sigmaHigh) {
  const t = (x - mu) / (x < mu ? sigmaLow : sigmaHigh);
  return Math.exp(-0.5 * t * t);
}

/** x̄(λ) CIE 1931, ajuste multi-lóbulo. λ em nanômetros. */
export function cieX(l) {
  return 1.056 * gLobe(l, 599.8, 37.9, 31.0)
       + 0.362 * gLobe(l, 442.0, 16.0, 26.7)
       - 0.065 * gLobe(l, 501.1, 20.4, 26.2);
}
/** ȳ(λ) CIE 1931 — também é a curva de luminância. */
export function cieY(l) {
  return 0.821 * gLobe(l, 568.8, 46.9, 40.5)
       + 0.286 * gLobe(l, 530.9, 16.3, 31.1);
}
/** z̄(λ) CIE 1931. */
export function cieZ(l) {
  return 1.217 * gLobe(l, 437.0, 11.8, 36.0)
       + 0.681 * gLobe(l, 459.0, 26.0, 13.8);
}

/**
 * Radiância espectral de um corpo negro (lei de Planck), em W·m⁻³·sr⁻¹.
 * O fator constante 2hc² é irrelevante para a cor (normalizamos depois), mas
 * mantê-lo custa nada e deixa a função utilizável para fotometria.
 */
export function planckRadiance(lambdaNm, tempK) {
  const l = lambdaNm * 1e-9;
  const l2 = l * l;
  const l5 = l2 * l2 * l;
  const x = (H_PLANCK * C_LIGHT) / (l * K_BOLTZ * tempK);
  // expm1 evita perda catastrófica de precisão para x pequeno (estrelas quentes
  // no vermelho longínquo), onde exp(x)-1 ≈ x.
  return (2 * H_PLANCK * C_LIGHT * C_LIGHT) / (l5 * Math.expm1(x));
}

// Matriz XYZ (D65) → sRGB linear, Rec.709.
const M_XYZ_RGB = [
   3.2404542, -1.5371385, -0.4985314,
  -0.9692660,  1.8760108,  0.0415560,
   0.0556434, -0.2040259,  1.0572252,
];

const LAMBDA_MIN = 380, LAMBDA_MAX = 780, LAMBDA_STEP = 4;

/**
 * Cor de um corpo negro à temperatura T, em sRGB LINEAR normalizado pelo pico.
 * Devolve `out` (ou um objeto novo) com {r,g,b} em [0,1].
 *
 * Normalizamos pelo componente máximo em vez da luminância porque a estrela é
 * renderizada em HDR: o brilho vem da intensidade do material, a cromaticidade
 * vem daqui. Assim uma M vermelha não fica escura, fica vermelha.
 */
export function blackbodyRGB(tempK, out) {
  const T = Math.max(500, tempK);
  let X = 0, Y = 0, Z = 0;
  for (let l = LAMBDA_MIN; l <= LAMBDA_MAX; l += LAMBDA_STEP) {
    const p = planckRadiance(l, T);
    X += p * cieX(l);
    Y += p * cieY(l);
    Z += p * cieZ(l);
  }
  // O passo de integração é constante: some-o de uma vez (não muda a cor).
  X *= LAMBDA_STEP; Y *= LAMBDA_STEP; Z *= LAMBDA_STEP;

  const s = X + Y + Z;
  if (s > 0) { X /= s; Y /= s; Z /= s; }

  let r = M_XYZ_RGB[0] * X + M_XYZ_RGB[1] * Y + M_XYZ_RGB[2] * Z;
  let g = M_XYZ_RGB[3] * X + M_XYZ_RGB[4] * Y + M_XYZ_RGB[5] * Z;
  let b = M_XYZ_RGB[6] * X + M_XYZ_RGB[7] * Y + M_XYZ_RGB[8] * Z;

  // Fora do gamut sRGB (típico abaixo de ~2500 K e acima de ~25000 K):
  // dessatura somando branco até o mínimo chegar a zero. É o mesmo que projetar
  // a cromaticidade para a borda do gamut mantendo o matiz.
  const mn = Math.min(r, g, b);
  if (mn < 0) { r -= mn; g -= mn; b -= mn; }
  const mx = Math.max(r, g, b);
  if (mx > 0) { r /= mx; g /= mx; b /= mx; }

  const o = out || { r: 0, g: 0, b: 0 };
  o.r = r; o.g = g; o.b = b;
  return o;
}

// ── LUT: a integração acima custa ~100 avaliações de exp por chamada ─────────
// Gerar 2000 estrelas chamando-a direto queimaria o orçamento do frame. A LUT é
// construída uma vez, log-espaçada (a cor varia devagar em log T), e interpolada.
const LUT_N = 160, LUT_TMIN = 1200, LUT_TMAX = 60000;
const _lutLogMin = Math.log(LUT_TMIN);
const _lutLogSpan = Math.log(LUT_TMAX) - _lutLogMin;
let _lut = null;

function buildLut() {
  const a = new Float32Array(LUT_N * 3);
  const tmp = { r: 0, g: 0, b: 0 };
  for (let i = 0; i < LUT_N; i++) {
    const T = Math.exp(_lutLogMin + (i / (LUT_N - 1)) * _lutLogSpan);
    blackbodyRGB(T, tmp);
    a[i * 3] = tmp.r; a[i * 3 + 1] = tmp.g; a[i * 3 + 2] = tmp.b;
  }
  _lut = a;
}

/** Versão barata de blackbodyRGB, interpolada na LUT. Mesma física, custo O(1). */
export function blackbodyRGBFast(tempK, out) {
  if (!_lut) buildLut();
  const T = tempK < LUT_TMIN ? LUT_TMIN : tempK > LUT_TMAX ? LUT_TMAX : tempK;
  const f = ((Math.log(T) - _lutLogMin) / _lutLogSpan) * (LUT_N - 1);
  const i0 = Math.min(LUT_N - 1, Math.max(0, Math.floor(f)));
  const i1 = Math.min(LUT_N - 1, i0 + 1);
  const t = f - i0;
  const o = out || { r: 0, g: 0, b: 0 };
  o.r = _lut[i0 * 3] + (_lut[i1 * 3] - _lut[i0 * 3]) * t;
  o.g = _lut[i0 * 3 + 1] + (_lut[i1 * 3 + 1] - _lut[i0 * 3 + 1]) * t;
  o.b = _lut[i0 * 3 + 2] + (_lut[i1 * 3 + 2] - _lut[i0 * 3 + 2]) * t;
  return o;
}

/** Conveniência: hex 0xRRGGBB em sRGB (com gama), útil para UI e canvas. */
export function blackbodyHex(tempK) {
  const c = blackbodyRGBFast(tempK);
  const enc = (v) => {
    const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(s * 255)));
  };
  return (enc(c.r) << 16) | (enc(c.g) << 8) | enc(c.b);
}

// ── Tabela de classes ───────────────────────────────────────────────────────
/**
 * Distribuição: a real é esmagadoramente M (~76%) e praticamente nunca O
 * (1 em 3 milhões). Isso daria um jogo em que todo sistema é uma anã vermelha
 * apagada. Comprimimos a distribuição para que o jogador encontre variedade em
 * dezenas de saltos, não em milhares — M ainda domina, mas com 28%, não 76%.
 *
 * `spectral` é a letra que o gerador de biomas entende (biomes.js só conhece
 * O/B/M como casos especiais); anãs brancas se comportam como A quente e
 * gigantes vermelhas como M fria para efeito de viés de bioma.
 */
export const STAR_CLASSES = {
  O: {
    id: 'O', spectral: 'O', name: 'Azul Hipergigante', weight: 1.2, giant: true,
    temp: [30000, 47000], lum: [3.0e4, 1.4e5], radius: [6.6, 12.0], mass: [18, 55],
  },
  B: {
    id: 'B', spectral: 'B', name: 'Azul-Branca', weight: 3.5,
    temp: [10500, 29000], lum: [80, 2.4e4], radius: [3.0, 6.4], mass: [3.0, 17],
  },
  A: {
    id: 'A', spectral: 'A', name: 'Branca', weight: 7.0,
    temp: [7600, 10200], lum: [6, 70], radius: [1.6, 2.9], mass: [1.7, 2.9],
  },
  F: {
    id: 'F', spectral: 'F', name: 'Branco-Amarela', weight: 11.0,
    temp: [6100, 7500], lum: [1.4, 5.5], radius: [1.15, 1.55], mass: [1.05, 1.6],
  },
  G: {
    id: 'G', spectral: 'G', name: 'Amarela', weight: 16.0,
    temp: [5300, 6000], lum: [0.55, 1.35], radius: [0.9, 1.12], mass: [0.85, 1.05],
  },
  K: {
    id: 'K', spectral: 'K', name: 'Laranja', weight: 20.0,
    temp: [3900, 5250], lum: [0.10, 0.50], radius: [0.65, 0.88], mass: [0.55, 0.84],
  },
  M: {
    id: 'M', spectral: 'M', name: 'Anã Vermelha', weight: 28.0,
    temp: [2500, 3850], lum: [0.004, 0.075], radius: [0.16, 0.60], mass: [0.10, 0.50],
  },
  WD: {
    id: 'WD', spectral: 'A', name: 'Anã Branca', weight: 6.0, degenerate: true,
    temp: [7000, 26000], lum: [4e-4, 1.2e-2], radius: [0.009, 0.021], mass: [0.5, 1.1],
  },
  RG: {
    id: 'RG', spectral: 'M', name: 'Gigante Vermelha', weight: 7.3, giant: true,
    temp: [3000, 4600], lum: [120, 1400], radius: [22, 90], mass: [1.0, 2.4],
  },
};

export const SPECTRAL_ORDER = ['O', 'B', 'A', 'F', 'G', 'K', 'M', 'WD', 'RG'];

const _classList = SPECTRAL_ORDER.map((k) => STAR_CLASSES[k]);
const _classWeights = _classList.map((c) => c.weight);

/** Probabilidade de o sistema ser binário. Raro o bastante para ser um evento. */
export const BINARY_CHANCE = 0.09;

/** Escolhe uma classe espectral com a distribuição comprimida do jogo. */
export function pickStarClass(rng) {
  return rng.pickWeighted(_classList, _classWeights);
}

/**
 * Zonas orbitais em UA, escaladas pela raiz da luminosidade — a lei do inverso
 * do quadrado: a mesma irradiância acontece a `sqrt(L)` vezes a distância.
 * Os coeficientes 0,95 e 1,68 são os limites de Kopparapu et al. (2013) para a
 * zona habitável conservadora do Sol.
 */
export function orbitZonesAU(luminosity) {
  const sq = Math.sqrt(Math.max(1e-6, luminosity));
  return {
    /** Abaixo disto o planeta ferve. */
    hotOuter: 0.95 * sq,
    /** Acima disto a água congela permanentemente. */
    coldInner: 1.68 * sq,
    /** Referência para posicionar o sistema inteiro. */
    scale: sq,
  };
}

/** Classifica um semi-eixo maior (em UA) em 'hot' | 'habitable' | 'cold'. */
export function zoneOfAU(au, zones) {
  if (au < zones.hotOuter) return 'hot';
  if (au > zones.coldInner) return 'cold';
  return 'habitable';
}

/** Interpola dentro de uma faixa [min,max] de forma determinística. */
function inRange(rng, r, bias) {
  const t = bias === undefined ? rng.float() : Math.pow(rng.float(), bias);
  return r[0] + t * (r[1] - r[0]);
}

/**
 * Constrói uma estrela física concreta a partir de um Rng.
 * @param {import('../core/rng.js').Rng} rng
 * @param {{forceClass?:string, allowBinary?:boolean}} opts
 * @returns {{cls:string, spectral:string, className:string, temp:number,
 *            luminosity:number, radiusSolar:number, massSolar:number,
 *            rgb:{r,g,b}, hex:number, zonesAU:object, binary:object|null}}
 */
export function makeStar(rng, opts = {}) {
  const def = opts.forceClass ? STAR_CLASSES[opts.forceClass] : pickStarClass(rng);
  // Viés 1.6: dentro de cada classe as estrelas menores/mais frias são mais
  // comuns que as maiores — a função de massa inicial em miniatura.
  const t = Math.pow(rng.float(), 1.6);
  const temp = def.temp[0] + t * (def.temp[1] - def.temp[0]);
  const frac = (temp - def.temp[0]) / Math.max(1, def.temp[1] - def.temp[0]);

  // Luminosidade e raio correlacionam com a temperatura dentro da classe
  // (é a sequência principal); a gigante vermelha inverte o raio.
  const lumT = def.id === 'RG' ? 1 - frac : frac;
  const luminosity = def.lum[0] * Math.pow(def.lum[1] / def.lum[0], Math.max(0, Math.min(1, lumT * 0.75 + rng.float() * 0.25)));
  const radiusSolar = inRange(rng, def.radius) * (def.id === 'RG' ? (1.15 - 0.3 * frac) : 1);
  const massSolar = inRange(rng, def.mass) * (0.85 + 0.3 * frac);

  const rgb = blackbodyRGBFast(temp);

  let binary = null;
  if (opts.allowBinary !== false && rng.chance(BINARY_CHANCE)) {
    // A companheira é quase sempre menos massiva — pares desiguais dominam.
    const compDef = rng.pickWeighted(
      [STAR_CLASSES.M, STAR_CLASSES.K, STAR_CLASSES.G, STAR_CLASSES.WD],
      [42, 26, 14, 18],
    );
    const cTemp = inRange(rng, compDef.temp, 1.5);
    binary = {
      cls: compDef.id,
      className: compDef.name,
      temp: cTemp,
      luminosity: inRange(rng, compDef.lum),
      radiusSolar: inRange(rng, compDef.radius),
      massSolar: inRange(rng, compDef.mass),
      rgb: blackbodyRGBFast(cTemp, { r: 0, g: 0, b: 0 }),
      /** Separação em UA — larga o bastante para não desestabilizar os planetas. */
      separationAU: rng.range(0.06, 0.30) * Math.max(1, Math.sqrt(luminosity)),
      phase: rng.range(0, Math.PI * 2),
      inclination: rng.normal(0, 0.09),
    };
  }

  return {
    cls: def.id,
    spectral: def.spectral,
    className: def.name,
    temp,
    luminosity,
    radiusSolar,
    massSolar,
    rgb: { r: rgb.r, g: rgb.g, b: rgb.b },
    hex: blackbodyHex(temp),
    zonesAU: orbitZonesAU(luminosity),
    binary,
  };
}

/** Rótulo legível: "G2 Amarela", "M5 Anã Vermelha". */
export function starLabel(star) {
  const def = STAR_CLASSES[star.cls];
  const frac = (star.temp - def.temp[0]) / Math.max(1, def.temp[1] - def.temp[0]);
  // Subclasse 0–9, invertida: 0 é o extremo quente da classe.
  const sub = Math.max(0, Math.min(9, Math.round((1 - frac) * 9)));
  const prefix = def.degenerate ? 'D' : def.id === 'RG' ? 'M' : def.id;
  return `${prefix}${sub} ${def.name}`;
}
