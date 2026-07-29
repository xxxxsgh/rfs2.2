/**
 * Ruído procedural — biblioteca compartilhada.
 *
 * IMPORTANTE: este arquivo é importado TAMBÉM dentro de Web Workers.
 * Não importe `three`, não toque em `window`, `document` ou `performance`.
 *
 * Tudo é determinístico a partir de uma tabela de permutação derivada da seed.
 * A mesma seed produz exatamente o mesmo relevo em qualquer máquina.
 */

import { hashInt, mix } from '../core/rng.js';

const G3 = 1 / 6;
const F3 = 1 / 3;

const GRAD3 = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

/**
 * Gerador de ruído com tabela de permutação própria.
 * Instancie um por "domínio" (relevo, umidade, cavernas…) derivando a seed.
 */
export class Noise {
  constructor(seed = 0) {
    this.seed = seed >>> 0;
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    // Embaralhamento determinístico com um LCG alimentado pela seed.
    let s = hashInt(this.seed || 1) || 1;
    for (let i = 255; i > 0; i--) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const j = s % (i + 1);
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    this.perm = new Uint8Array(512);
    this.permMod12 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod12[i] = this.perm[i] % 12;
    }
  }

  /** Simplex 3D em [-1,1]. */
  noise3(xin, yin, zin) {
    const perm = this.perm, permMod12 = this.permMod12;
    let n0 = 0, n1 = 0, n2 = 0, n3 = 0;

    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s), j = Math.floor(yin + s), k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t), y0 = yin - (j - t), z0 = zin - (k - t);

    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }

    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;

    const ii = i & 255, jj = j & 255, kk = k & 255;

    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 > 0) {
      const gi0 = permMod12[ii + perm[jj + perm[kk]]] * 3;
      t0 *= t0;
      n0 = t0 * t0 * (GRAD3[gi0] * x0 + GRAD3[gi0 + 1] * y0 + GRAD3[gi0 + 2] * z0);
    }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 > 0) {
      const gi1 = permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3;
      t1 *= t1;
      n1 = t1 * t1 * (GRAD3[gi1] * x1 + GRAD3[gi1 + 1] * y1 + GRAD3[gi1 + 2] * z1);
    }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 > 0) {
      const gi2 = permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3;
      t2 *= t2;
      n2 = t2 * t2 * (GRAD3[gi2] * x2 + GRAD3[gi2 + 1] * y2 + GRAD3[gi2 + 2] * z2);
    }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 > 0) {
      const gi3 = permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3;
      t3 *= t3;
      n3 = t3 * t3 * (GRAD3[gi3] * x3 + GRAD3[gi3 + 1] * y3 + GRAD3[gi3 + 2] * z3);
    }
    return 32 * (n0 + n1 + n2 + n3);
  }

  /** fBm clássico. Retorna aproximadamente [-1,1]. */
  fbm(x, y, z, octaves = 6, lacunarity = 2.0, gain = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.noise3(x * freq, y * freq, z * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /**
   * fBm ridged — a base de cordilheiras afiadas.
   * Retorna [0,1] com cristas em 1.
   */
  ridged(x, y, z, octaves = 6, lacunarity = 2.0, gain = 0.5, sharpness = 1.0) {
    let amp = 1, freq = 1, sum = 0, norm = 0, prev = 1;
    for (let i = 0; i < octaves; i++) {
      let n = 1 - Math.abs(this.noise3(x * freq, y * freq, z * freq));
      n = Math.pow(n, sharpness);
      // Modulação pelo oitavo anterior: cria vales largos e cristas finas.
      sum += amp * n * prev;
      prev = n;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /**
   * fBm com "billow" — domos arredondados, bom para dunas e nuvens densas.
   */
  billow(x, y, z, octaves = 5, lacunarity = 2.0, gain = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * (Math.abs(this.noise3(x * freq, y * freq, z * freq)) * 2 - 1);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /**
   * Domain warping: desloca as coordenadas por outro campo de ruído antes de
   * amostrar. É o que transforma fBm genérico em formas orgânicas — meandros,
   * fluxos de lava, estratos dobrados.
   * @param {number} strength deslocamento em unidades do domínio
   */
  warpedFbm(x, y, z, octaves = 6, strength = 0.6, warpFreq = 0.5) {
    const wx = this.noise3(x * warpFreq + 13.7, y * warpFreq + 5.1, z * warpFreq + 9.3);
    const wy = this.noise3(x * warpFreq - 7.3, y * warpFreq + 11.9, z * warpFreq - 2.7);
    const wz = this.noise3(x * warpFreq + 3.3, y * warpFreq - 8.5, z * warpFreq + 17.1);
    return this.fbm(x + wx * strength, y + wy * strength, z + wz * strength, octaves);
  }

  /**
   * Warping de segunda ordem (Quilez): warp do warp. Caro, mas produz as
   * estruturas em fita e os deltas que denunciam terreno "bem-feito".
   */
  warped2(x, y, z, octaves = 5, strength = 0.8) {
    const q1 = this.fbm(x, y, z, 4);
    const q2 = this.fbm(x + 5.2, y + 1.3, z + 2.8, 4);
    const q3 = this.fbm(x + 1.7, y + 9.2, z + 3.4, 4);
    const r1 = this.fbm(x + strength * q1 + 1.7, y + strength * q2 + 9.2, z + strength * q3 + 4.4, 4);
    const r2 = this.fbm(x + strength * q2 + 8.3, y + strength * q3 + 2.8, z + strength * q1 + 1.1, 4);
    const r3 = this.fbm(x + strength * q3 + 3.9, y + strength * q1 + 6.6, z + strength * q2 + 7.2, 4);
    return this.fbm(x + strength * r1, y + strength * r2, z + strength * r3, octaves);
  }

  /**
   * Worley / celular F1 e F2 em 3D. Devolve {f1, f2, id}.
   * Base para cristais, placas tectônicas, manchas de bioma e escamas.
   */
  worley(x, y, z, jitter = 1.0) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    let f1 = 1e9, f2 = 1e9, id = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const cx = xi + dx, cy = yi + dy, cz = zi + dz;
          const h = mix(mix(mix(hashInt(cx), hashInt(cy)), hashInt(cz)), this.seed);
          const px = cx + ((h & 1023) / 1023) * jitter;
          const py = cy + (((h >>> 10) & 1023) / 1023) * jitter;
          const pz = cz + (((h >>> 20) & 1023) / 1023) * jitter;
          const ddx = px - x, ddy = py - y, ddz = pz - z;
          const d = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
          if (d < f1) { f2 = f1; f1 = d; id = h; }
          else if (d < f2) { f2 = d; }
        }
      }
    }
    return { f1, f2, id: id >>> 0 };
  }

  /**
   * Gradiente analítico aproximado por diferenças centrais.
   * Usado pela erosão e pelo cálculo de inclinação (slope) do bioma.
   */
  gradient(x, y, z, fn, eps = 0.01) {
    const f = fn || ((a, b, c) => this.fbm(a, b, c, 6));
    const dx = (f(x + eps, y, z) - f(x - eps, y, z)) / (2 * eps);
    const dy = (f(x, y + eps, z) - f(x, y - eps, z)) / (2 * eps);
    const dz = (f(x, y, z + eps) - f(x, y, z - eps)) / (2 * eps);
    return { x: dx, y: dy, z: dz };
  }
}

// ── Funções livres úteis em qualquer lugar ──────────────────────────────────

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function saturate(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function smoothstep(e0, e1, x) {
  const t = saturate((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
export function smootherstep(e0, e1, x) {
  const t = saturate((x - e0) / (e1 - e0));
  return t * t * t * (t * (t * 6 - 15) + 10);
}
/** Mistura suave entre dois valores — evita as costuras duras entre biomas. */
export function smin(a, b, k) {
  const h = saturate(0.5 + 0.5 * (b - a) / k);
  return lerp(b, a, h) - k * h * (1 - h);
}
export function smax(a, b, k) { return -smin(-a, -b, k); }

/**
 * Erosão hidráulica aproximada, avaliada por amostra (sem simulação iterativa).
 *
 * A ideia: onde o gradiente do relevo é forte, a água escoou e cortou; onde é
 * fraco, sedimento se acumulou. Multiplicamos a altura por um fator derivado da
 * magnitude do gradiente e adicionamos canais finos alinhados ao escoamento.
 * É barato o bastante para rodar por vértice e captura a assinatura visual da
 * erosão real: vales em V, cristas suavizadas, leques aluviais.
 *
 * @param {Noise} noise
 * @param {number} h altura base normalizada [0,1]
 * @param {number} gx,gy,gz gradiente do campo de altura
 * @param {number} strength
 */
export function erode(noise, h, gx, gy, gz, x, y, z, strength = 1) {
  const slope = Math.sqrt(gx * gx + gy * gy + gz * gz);
  // Fluxo acumulado: aproximado por ruído de baixa frequência alinhado ao vale.
  const flow = saturate(1 - slope * 1.5);
  // Canais: ridged invertido, estreito, só aparece em regiões de fluxo alto.
  const channel = 1 - noise.ridged(x * 3.1 + 21.7, y * 3.1 - 4.3, z * 3.1 + 8.9, 4, 2.1, 0.5, 2.0);
  const cut = channel * flow * flow * 0.06 * strength;
  // Suavização das cristas proporcional à inclinação (desgaste).
  const smoothing = 1 - saturate(slope * 0.35) * 0.18 * strength;
  return h * smoothing - cut;
}

/**
 * Terraceamento — degraus sedimentares. Assinatura visual de mesas e badlands.
 */
export function terrace(h, steps, blend = 0.35) {
  const s = h * steps;
  const f = Math.floor(s);
  const frac = s - f;
  return (f + smoothstep(0, blend, frac) * blend + frac * (1 - blend)) / steps;
}

/** Curva de "platô": achata o topo mantendo encostas íngremes. */
export function plateau(h, level, hardness = 6) {
  const d = h - level;
  return level + d / Math.pow(1 + Math.pow(Math.abs(d) * hardness, 2), 0.5);
}
