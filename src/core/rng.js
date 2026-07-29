/**
 * RNG hierárquico determinístico.
 *
 * Regra do universo: a mesma seed produz sempre o mesmo cosmos. Nenhum módulo
 * pode usar Math.random() para conteúdo persistente — só para efeitos puramente
 * cosméticos e efêmeros (partículas de um frame).
 *
 * Uso:
 *   const galaxy = makeRng('AETHER');
 *   const system = galaxy.derive('sys', 42);
 *   const planet = system.derive('planet', 3);
 *   planet.float(), planet.range(a,b), planet.int(n), planet.pick(arr)
 *
 * A derivação é pura: derive(tag, i) depende apenas do hash do pai, da tag e de i.
 * Isso significa que você pode reconstruir qualquer nó da árvore sem percorrer
 * a árvore inteira — essencial para streaming de chunks fora de ordem.
 *
 * Sem dependências: seguro para importar dentro de Web Workers.
 */

/** FNV-1a de 32 bits sobre uma string. */
export function hashString(str, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Mistura de inteiros (variante do murmur3 finalizer). */
export function hashInt(x) {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Combina dois hashes de forma não comutativa. */
export function mix(a, b) {
  let h = (a >>> 0) ^ Math.imul(b >>> 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}

/** Hash de 2 inteiros para float [0,1) — sem estado, para grids/chunks. */
export function hash2f(x, y, salt = 0) {
  return hashInt(mix(mix(hashInt(x | 0), hashInt(y | 0)), salt)) / 4294967296;
}

/** Hash de 3 inteiros para float [0,1). */
export function hash3f(x, y, z, salt = 0) {
  return hashInt(mix(mix(mix(hashInt(x | 0), hashInt(y | 0)), hashInt(z | 0)), salt)) / 4294967296;
}

/** sfc32 — rápido, bom o suficiente, período largo. */
function sfc32(a, b, c, d) {
  return function () {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export class Rng {
  /** @param {number} seedHash hash de 32 bits que identifica este nó da árvore */
  constructor(seedHash, label = '') {
    this.seed = seedHash >>> 0;
    this.label = label;
    const a = hashInt(this.seed ^ 0x9e3779b9);
    const b = hashInt(a ^ 0x243f6a88);
    const c = hashInt(b ^ 0xb7e15162);
    const d = hashInt(c ^ 0x2545f491);
    this._next = sfc32(a, b, c, d);
    // Descarta os primeiros valores: sfc32 precisa aquecer.
    for (let i = 0; i < 12; i++) this._next();
  }

  /** Novo nó filho, determinístico e independente da ordem de criação. */
  derive(tag, index = 0) {
    const h = mix(mix(this.seed, hashString(String(tag))), hashInt(index | 0));
    return new Rng(h, this.label ? `${this.label}/${tag}:${index}` : `${tag}:${index}`);
  }

  /** Reinicia o fluxo para o estado inicial deste nó. */
  reset() {
    const r = new Rng(this.seed, this.label);
    this._next = r._next;
    return this;
  }

  /** float em [0,1) */
  float() { return this._next(); }

  /** float em [min,max) */
  range(min, max) { return min + this._next() * (max - min); }

  /** inteiro em [0,n) */
  int(n) { return Math.floor(this._next() * n); }

  /** inteiro em [min,max] inclusivo */
  intRange(min, max) { return min + Math.floor(this._next() * (max - min + 1)); }

  /** true com probabilidade p */
  chance(p) { return this._next() < p; }

  /** elemento aleatório */
  pick(arr) { return arr[Math.floor(this._next() * arr.length)]; }

  /** elemento aleatório com pesos paralelos */
  pickWeighted(arr, weights) {
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += weights[i];
    let r = this._next() * total;
    for (let i = 0; i < arr.length; i++) {
      r -= weights[i];
      if (r <= 0) return arr[i];
    }
    return arr[arr.length - 1];
  }

  /** Embaralhamento Fisher-Yates in-place. */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this._next() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /** Normal(0,1) por Box-Muller. */
  normal(mean = 0, stddev = 1) {
    let u = 0, v = 0;
    while (u === 0) u = this._next();
    while (v === 0) v = this._next();
    return mean + stddev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Ponto uniforme na superfície de uma esfera unitária → {x,y,z} */
  onSphere() {
    const z = this._next() * 2 - 1;
    const t = this._next() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    return { x: r * Math.cos(t), y: r * Math.sin(t), z };
  }
}

/** Cria a raiz da árvore a partir de uma seed textual ou numérica. */
export function makeRng(seed, label = 'root') {
  const h = typeof seed === 'number' ? hashInt(seed) : hashString(String(seed));
  return new Rng(h, label);
}

/**
 * Nome pronunciável determinístico (planetas, espécies, sistemas).
 * Estilo alienígena: sílabas consoante+vogal com sufixos ocasionais.
 */
const ONSET = ['b', 'br', 'd', 'dr', 'g', 'gr', 'h', 'j', 'k', 'kr', 'l', 'm', 'n', 'p', 'pr', 'q', 'r', 's', 'sh', 'sk', 't', 'th', 'tr', 'v', 'x', 'z', 'zh'];
const NUCLEUS = ['a', 'e', 'i', 'o', 'u', 'ae', 'ei', 'ia', 'oo', 'ua', 'y'];
const CODA = ['', '', '', 'n', 'r', 's', 'l', 'th', 'x', 'k', 'm'];

export function makeName(rng, { minSyl = 2, maxSyl = 3, suffix = false } = {}) {
  const n = rng.intRange(minSyl, maxSyl);
  let out = '';
  for (let i = 0; i < n; i++) {
    out += rng.pick(ONSET) + rng.pick(NUCLEUS) + (i === n - 1 ? rng.pick(CODA) : '');
  }
  out = out.charAt(0).toUpperCase() + out.slice(1);
  if (suffix) {
    const greek = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Iota', 'Kappa', 'Lambda', 'Sigma', 'Omega', 'Prime', 'Major', 'Minor'];
    if (rng.chance(0.45)) out += ' ' + rng.pick(greek);
    else out += ' ' + rng.intRange(2, 99);
  }
  return out;
}
