/**
 * AETHER — trilha generativa em camadas.
 *
 * Referência estética: 65daysofstatic (a trilha de No Man's Sky). A regra de
 * ouro do post-rock eletrônico é que a intensidade cresce em CAMADAS e em
 * DENSIDADE RÍTMICA, quase nunca em volume. Um planeta hostil não fica mais
 * alto: ganha um bumbo em colcheias, um baixo sujo e granulação por cima.
 *
 * Arquitetura:
 *  - Um agendador com lookahead de ~200 ms (nunca setInterval tocando direto:
 *    o timer do navegador treme, o relógio do AudioContext não).
 *  - Seis camadas independentes (pad, arpejo, baixo, percussão, textura,
 *    glitch), cada uma com o seu GainNode. Mudança de contexto vira crossfade
 *    de ~8 s aplicado SEMPRE no início de um compasso.
 *  - Escala, tônica, BPM e progressão vêm de um Rng derivado do sistema: o
 *    mesmo sistema estelar tem sempre a mesma música.
 */

import { hashInt, mix } from '../core/rng.js';
import { midiToFreq, clamp } from './synth.js';

/** Modos disponíveis. Cada sistema estelar sorteia um e vive com ele. */
export const SCALES = {
  dorian: [0, 2, 3, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  pentaMinor: [0, 3, 5, 7, 10],
};
const SCALE_NAMES = ['dorian', 'lydian', 'phrygian', 'aeolian', 'pentaMinor'];

/**
 * Mesa de contextos. `density` é a densidade rítmica base (0..1) e `bright` o
 * brilho dos filtros. Intensidade recebida no evento soma por cima.
 */
export const MOODS = {
  space: { pad: 0.95, arp: 0.20, bass: 0.45, perc: 0.00, gtr: 0.30, glitch: 0.00, density: 0.12, bright: 0.35, space: 'vast', wet: 1.05 },
  void: { pad: 0.80, arp: 0.06, bass: 0.28, perc: 0.00, gtr: 0.16, glitch: 0.02, density: 0.05, bright: 0.22, space: 'vast', wet: 1.15 },
  serene: { pad: 0.85, arp: 0.45, bass: 0.45, perc: 0.24, gtr: 0.45, glitch: 0.00, density: 0.34, bright: 0.62, space: 'valley', wet: 0.85 },
  wonder: { pad: 0.90, arp: 0.60, bass: 0.55, perc: 0.34, gtr: 0.55, glitch: 0.00, density: 0.45, bright: 0.74, space: 'valley', wet: 0.90 },
  awe: { pad: 1.00, arp: 0.55, bass: 0.50, perc: 0.20, gtr: 0.60, glitch: 0.05, density: 0.28, bright: 0.82, space: 'hall', wet: 1.10 },
  desolate: { pad: 0.78, arp: 0.15, bass: 0.40, perc: 0.10, gtr: 0.35, glitch: 0.00, density: 0.14, bright: 0.30, space: 'valley', wet: 1.00 },
  unease: { pad: 0.70, arp: 0.35, bass: 0.55, perc: 0.34, gtr: 0.30, glitch: 0.12, density: 0.42, bright: 0.40, space: 'cave', wet: 0.95 },
  tension: { pad: 0.60, arp: 0.50, bass: 0.66, perc: 0.55, gtr: 0.35, glitch: 0.20, density: 0.60, bright: 0.50, space: 'cave', wet: 0.80 },
  menace: { pad: 0.65, arp: 0.30, bass: 0.76, perc: 0.60, gtr: 0.40, glitch: 0.25, density: 0.66, bright: 0.34, space: 'cave', wet: 0.85 },
  night: { pad: 0.90, arp: 0.30, bass: 0.40, perc: 0.12, gtr: 0.40, glitch: 0.00, density: 0.20, bright: 0.32, space: 'valley', wet: 1.00 },
  surface: { pad: 0.85, arp: 0.45, bass: 0.50, perc: 0.30, gtr: 0.45, glitch: 0.00, density: 0.40, bright: 0.60, space: 'valley', wet: 0.90 },
  discovery: { pad: 1.00, arp: 0.70, bass: 0.50, perc: 0.30, gtr: 0.70, glitch: 0.00, density: 0.42, bright: 0.95, space: 'hall', wet: 1.10 },
  danger: { pad: 0.55, arp: 0.40, bass: 0.82, perc: 0.70, gtr: 0.35, glitch: 0.35, density: 0.76, bright: 0.45, space: 'cave', wet: 0.70 },
  combat: { pad: 0.45, arp: 0.75, bass: 0.92, perc: 1.00, gtr: 0.60, glitch: 0.60, density: 1.00, bright: 0.70, space: 'cockpit', wet: 0.55 },
  cockpit: { pad: 0.80, arp: 0.35, bass: 0.50, perc: 0.22, gtr: 0.40, glitch: 0.02, density: 0.30, bright: 0.55, space: 'cockpit', wet: 0.60 },
};

const LAYERS = ['pad', 'arp', 'bass', 'perc', 'gtr', 'glitch'];

const LOOKAHEAD = 0.2;      // s de antecedência do agendador
const STEPS_PER_BAR = 16;   // semicolcheias em 4/4
const CROSSFADE = 8.0;      // s — a respiração lenta que o pós-rock pede

/** Ruído determinístico por passo: padrões esparsos que não mudam a cada volta. */
function stepHash(seed, step, salt) {
  return hashInt(mix(mix(seed >>> 0, hashInt(step | 0)), salt | 0)) / 4294967296;
}

export function createMusic(synth, opts = {}) {
  const ac = synth && synth.ac ? synth.ac : null;
  if (!ac || !synth.ok) return createNullMusic();

  // ── Barramentos por camada ────────────────────────────────────────────────
  const bus = synth.gain(opts.volume ?? 0.55);
  bus.connect(synth.busIn);

  const L = {};
  for (const k of LAYERS) {
    const g = synth.gain(0.0001);
    g.connect(bus);
    L[k] = { gain: g, target: 0, applied: 0 };
  }

  // O pad tem o seu próprio filtro lento: é ele que "abre" e "fecha" a peça.
  const padFilter = synth.biquad('lowpass', 900, 0.9);
  padFilter.connect(L.pad.gain);
  const padLfo = synth.lfo(0.037, 380, 'sine');
  try { padLfo.depth.connect(padFilter.frequency); } catch (e) { /* ignora */ }

  const S = {
    enabled: true,
    playing: false,
    seed: 1,
    scaleName: 'dorian',
    scale: SCALES.dorian,
    root: 45,
    bpm: 104,
    stepDur: 0.15,
    step: 0,
    nextStepTime: 0,
    anchored: false,
    progression: [0, 5, 3, 4],
    chordIndex: 0,
    barsPerChord: 2,
    arpPattern: new Array(16).fill(false),
    bassPattern: new Array(16).fill(false),
    mood: 'space',
    intensity: 0.3,
    density: 0.15,
    bright: 0.4,
    pendingMood: null,
    pendingSystem: null,
    discoveryPending: 0,
    discoveryUntil: 0,
    bars: 0,
    lastChordTones: [45, 52, 57],
  };

  // ── Derivação determinística por sistema ──────────────────────────────────
  function configureFrom(rng, seedNum) {
    S.seed = (seedNum >>> 0) || 1;
    S.scaleName = rng ? rng.pick(SCALE_NAMES) : 'dorian';
    S.scale = SCALES[S.scaleName] || SCALES.dorian;
    // Tônica grave: a trilha vive entre C1 e B2, o resto sobe por oitavas.
    S.root = 33 + (rng ? rng.int(12) : 0);
    S.bpm = rng ? Math.round(rng.range(84, 132)) : 104;
    S.stepDur = 60 / S.bpm / 4;
    S.barsPerChord = rng ? (rng.chance(0.4) ? 1 : 2) : 2;

    // Progressão por caminhada em graus: nada de ii-V-I, isso não é jazz.
    const n = rng ? rng.intRange(4, 7) : 4;
    const prog = [0];
    let deg = 0;
    for (let i = 1; i < n; i++) {
      const jump = rng ? rng.pickWeighted([-3, -2, -1, 1, 2, 3, 4], [2, 3, 4, 4, 3, 2, 1]) : 2;
      deg = (deg + jump + 700) % S.scale.length;
      // Voltar à tônica de vez em quando dá âncora — sem isso vira deriva.
      if (rng && i === n - 1 && rng.chance(0.45)) deg = 0;
      prog.push(deg);
    }
    S.progression = prog;
    S.chordIndex = 0;

    // Padrões fixos do sistema (o groove é uma assinatura do lugar).
    for (let i = 0; i < STEPS_PER_BAR; i++) {
      const a = rng ? rng.float() : stepHash(S.seed, i, 11);
      S.arpPattern[i] = i % 2 === 0 ? a < 0.85 : a < 0.34;
      const b = rng ? rng.float() : stepHash(S.seed, i, 23);
      S.bassPattern[i] = i === 0 || i === 6 || i === 10 ? true : b < 0.14;
    }

    // Delay pontuado (colcheia pontuada) — o eco que define o gênero.
    synth.setDelay({ time: (60 / S.bpm) * 0.75, feedback: 0.44, tone: 3200, mix: 0.55 }, 0.6);
  }

  configureFrom(opts.rng || null, opts.seedNum || 1);

  // ── Utilidades harmônicas ─────────────────────────────────────────────────
  function noteOf(degree, octave = 0) {
    const len = S.scale.length;
    const d = ((degree % len) + len) % len;
    const oct = Math.floor(degree / len) + octave;
    return S.root + S.scale[d] + oct * 12;
  }

  function chordTones(degree, count = 4) {
    const out = [];
    for (let i = 0; i < count; i++) out.push(noteOf(degree + i * 2));
    return out;
  }

  function currentDegree() { return S.progression[S.chordIndex % S.progression.length]; }

  // ── Vozes ─────────────────────────────────────────────────────────────────

  /** Pad: osciladores detunados, filtro lento e reverb enorme. A cama de tudo. */
  function pad(t, tones, dur) {
    if (!synth.canVoice()) return;
    const bright = 380 + S.bright * 2600;
    const g = synth.gain(0.0001);
    g.connect(padFilter);
    synth.send(g, { reverb: 0.85 });
    const peak = 0.16 / Math.max(1, tones.length * 0.6);
    const a = Math.min(3.6, dur * 0.45);
    const rel = Math.min(6.5, dur * 0.9);
    synth.adsr(g.gain, t, { a, d: dur * 0.2, s: 0.85, r: rel, peak, hold: Math.max(0.2, dur - a - dur * 0.2) });
    const end = t + a + dur * 0.2 + Math.max(0.2, dur - a - dur * 0.2) + rel + 0.1;
    synth.ramp(padFilter.frequency, bright, t, dur * 0.6);

    for (let i = 0; i < tones.length; i++) {
      const f = midiToFreq(tones[i] + (i === 0 ? 0 : 12));
      // Três osciladores por nota com desafinações opostas: o batimento lento
      // entre eles é o que faz o pad "respirar" sem nenhum LFO explícito.
      const dets = [-7 - i * 1.7, 0, 8 + i * 1.3];
      for (let k = 0; k < dets.length; k++) {
        if (!synth.canVoice()) break;
        const o = synth.osc(k === 1 ? 'triangle' : 'sawtooth', f, dets[k]);
        const vg = synth.gain(k === 1 ? 0.6 : 0.32);
        o.connect(vg); vg.connect(g);
        try { o.start(t); } catch (e) { /* ignora */ }
        synth.track(o, vg, end);
      }
    }
  }

  /** Baixo: sub senoidal + serra filtrada. O sub carrega, a serra dá o corpo. */
  function bass(t, midi, dur, drive) {
    if (!synth.canVoice()) return;
    const f = midiToFreq(midi);
    const out = L.bass.gain;
    const sub = synth.osc('sine', f);
    const subG = synth.envGain(t, { a: 0.008, d: 0.12, s: 0.75, r: dur * 0.7, peak: 0.4, hold: dur * 0.6 }, out);
    sub.connect(subG);

    const saw = synth.osc('sawtooth', f * 2, 5);
    const lp = synth.biquad('lowpass', 220 + S.bright * 900 + drive * 900, 6 + drive * 6);
    const sawG = synth.envGain(t, { a: 0.006, d: 0.16, s: 0.35, r: dur * 0.5, peak: 0.16 + drive * 0.12, hold: dur * 0.4 }, out);
    saw.connect(lp); lp.connect(sawG);
    // O corte cai junto com a nota: baixo que "fecha" em vez de sumir.
    synth.expRamp(lp.frequency, 160 + S.bright * 320, t + 0.02, dur * 0.9);
    synth.send(sawG, { reverb: 0.06 });

    const end = Math.max(subG._end, sawG._end) + 0.05;
    try { sub.start(t); saw.start(t); } catch (e) { /* ignora */ }
    synth.track(sub, subG, end);
    synth.track(saw, sawG, end);
  }

  /** Arpejo: pluck curto e brilhante, com muito envio para o delay pontuado. */
  function arp(t, midi, vel) {
    if (!synth.canVoice()) return;
    const f = midiToFreq(midi);
    const o = synth.osc('triangle', f);
    const o2 = synth.osc('sawtooth', f, 9);
    const bp = synth.biquad('bandpass', f * 2.2, 2.4);
    const g = synth.envGain(t, { a: 0.003, d: 0.09, s: 0.12, r: 0.25, peak: 0.2 * vel, hold: 0.02 }, L.arp.gain);
    o.connect(bp); o2.connect(bp); bp.connect(g);
    synth.expRamp(bp.frequency, f * (1.2 + S.bright * 2.5), t, 0.22);
    synth.send(g, { reverb: 0.28, delay: 0.5 });
    const end = g._end + 0.05;
    try { o.start(t); o2.start(t); } catch (e) { /* ignora */ }
    synth.track(o, g, end);
    synth.track(o2, bp, end);
  }

  /** Textura/guitarra: waveshaper, delay longo, reverb — notas esparsas. */
  function texture(t, midi, dur) {
    if (!synth.canVoice()) return;
    const f = midiToFreq(midi);
    const o = synth.osc('sawtooth', f, -4);
    const o2 = synth.osc('square', f * 0.5, 6);
    const drv = synth.shaper(0.35 + S.bright * 0.3);
    const lp = synth.biquad('lowpass', 900 + S.bright * 3200, 1.6);
    const g = synth.envGain(t, { a: dur * 0.35, d: dur * 0.2, s: 0.5, r: dur * 0.9, peak: 0.1, hold: dur * 0.25 }, L.gtr.gain);
    o.connect(drv); o2.connect(drv); drv.connect(lp); lp.connect(g);
    synth.send(g, { reverb: 0.7, delay: 0.65 });
    const end = g._end + 0.1;
    try { o.start(t); o2.start(t); } catch (e) { /* ignora */ }
    synth.track(o, g, end);
    synth.track(o2, drv, end);
  }

  // ── Percussão sintetizada ─────────────────────────────────────────────────
  function kick(t, vel = 1) {
    if (!synth.canVoice()) return;
    const o = synth.osc('sine', 120);
    const g = synth.envGain(t, { a: 0.002, d: 0.09, s: 0.0001, r: 0.12, peak: 0.55 * vel, hold: 0 }, L.perc.gain);
    o.connect(g);
    synth.expRamp(o.frequency, 42, t, 0.075);   // o sweep é o bumbo
    const end = g._end + 0.02;
    try { o.start(t); } catch (e) { /* ignora */ }
    synth.track(o, g, end);
    // Estalo de ataque: sem isso o bumbo some numa mixagem com pad grande.
    const n = synth.noise('white');
    const hp = synth.biquad('highpass', 1800, 0.9);
    const ng = synth.envGain(t, { a: 0.0005, d: 0.02, s: 0.0001, r: 0.02, peak: 0.12 * vel, hold: 0 }, L.perc.gain);
    n.connect(hp); hp.connect(ng);
    try { n.start(t); } catch (e) { /* ignora */ }
    synth.track(n, hp, t + 0.08);
  }

  function snare(t, vel = 1) {
    if (!synth.canVoice()) return;
    const n = synth.noise('white');
    const bp = synth.biquad('bandpass', 1900, 0.9);
    const g = synth.envGain(t, { a: 0.001, d: 0.09, s: 0.05, r: 0.12, peak: 0.26 * vel, hold: 0.01 }, L.perc.gain);
    n.connect(bp); bp.connect(g);
    synth.send(g, { reverb: 0.3 });
    try { n.start(t); } catch (e) { /* ignora */ }
    synth.track(n, bp, t + 0.3);
    const o = synth.osc('triangle', 196);
    const og = synth.envGain(t, { a: 0.001, d: 0.06, s: 0.0001, r: 0.05, peak: 0.14 * vel, hold: 0 }, L.perc.gain);
    o.connect(og);
    synth.expRamp(o.frequency, 132, t, 0.08);
    try { o.start(t); } catch (e) { /* ignora */ }
    synth.track(o, og, t + 0.2);
  }

  function hat(t, vel = 1, open = false) {
    if (!synth.canVoice()) return;
    const n = synth.noise('white');
    const hp = synth.biquad('highpass', 7200, 0.8);
    const dur = open ? 0.22 : 0.045;
    const g = synth.envGain(t, { a: 0.0008, d: dur * 0.5, s: 0.05, r: dur * 0.6, peak: 0.1 * vel, hold: 0 }, L.perc.gain);
    n.connect(hp); hp.connect(g);
    if (open) synth.send(g, { reverb: 0.18, delay: 0.12 });
    try { n.start(t); } catch (e) { /* ignora */ }
    synth.track(n, hp, t + dur + 0.1);
  }

  /** Glitch: granulação do próprio ruído do sintetizador. Só perigo/combate. */
  function glitch(t, amount) {
    synth.granular({
      t, dur: 0.12 + amount * 0.25, grainMs: 18 + amount * 30, density: 60,
      pitch: 0.5 + amount * 2.5, jitter: 0.9, spread: 0.8,
      out: L.glitch.gain, gain: 0.3, reverb: 0.25,
      filter: 400 + amount * 5200,
    });
  }

  // ── Momento de descoberta ─────────────────────────────────────────────────
  /**
   * A recompensa emocional do jogo. Uma cadência curta e luminosa: subdominante
   * brilhante resolvendo na tônica, arpejo ascendente de sinos em duas oitavas,
   * pad abrindo o filtro e um sub que sustenta a resolução.
   */
  function discoveryGesture(t) {
    const beat = 60 / S.bpm;
    const lift = [3, 4, 6].indexOf(currentDegree()) >= 0 ? 4 : 3;   // IV ou V
    const pre = chordTones(lift, 4);
    const res = chordTones(0, 4);

    pad(t, pre.slice(0, 3), beat * 2.2);
    pad(t + beat * 2, [res[0], res[1], res[2], res[2] + 12], beat * 6);

    // Sinos FM subindo — o gesto que o jogador vai lembrar.
    const ladder = [];
    for (let i = 0; i < 10; i++) {
      const src = i < 5 ? pre : res;
      ladder.push(src[i % src.length] + 24 + Math.floor(i / src.length) * 12);
    }
    for (let i = 0; i < ladder.length; i++) {
      const tt = t + i * beat * 0.25;
      synth.fmVoice({
        t: tt, freq: midiToFreq(ladder[i]), ratio: 2.01, index: 2.4 + i * 0.12,
        dur: 1.6, gain: 0.17, out: L.gtr.gain, carrier: 'sine',
        env: { a: 0.004, d: 0.6, s: 0.18, r: 1.2, peak: 0.17, hold: 0.05 },
        reverb: 0.75, delay: 0.4,
      });
    }
    // Cluster cintilante bem agudo: o "brilho" da revelação.
    for (let i = 0; i < 4; i++) {
      synth.fmVoice({
        t: t + beat * 1.8 + i * 0.06, freq: midiToFreq(res[i % res.length] + 36),
        ratio: 3.5, index: 1.2, dur: 3.2, gain: 0.06, out: L.gtr.gain,
        env: { a: 0.5, d: 1.0, s: 0.3, r: 1.8, peak: 0.06, hold: 0.4 },
        reverb: 0.9, delay: 0.2,
      });
    }
    bass(t + beat * 2, noteOf(0, -1), beat * 4, 0.2);
    S.discoveryUntil = t + beat * 8;
  }

  // ── Agendamento ───────────────────────────────────────────────────────────
  function applyTargets(t) {
    for (const k of LAYERS) {
      const l = L[k];
      if (Math.abs(l.target - l.applied) < 0.005) continue;
      // Crossfade longo, sempre iniciado no compasso: a peça nunca "corta".
      synth.ramp(l.gain.gain, Math.max(0.0001, l.target), t, CROSSFADE);
      l.applied = l.target;
    }
  }

  function computeTargets() {
    const m = MOODS[S.mood] || MOODS.space;
    const it = clamp(S.intensity, 0, 1);
    S.density = clamp(m.density + it * 0.42, 0, 1);
    S.bright = clamp(m.bright + it * 0.15, 0, 1);
    L.pad.target = m.pad * (1 - it * 0.18);
    L.arp.target = m.arp * (0.7 + it * 0.5);
    L.bass.target = m.bass * (0.8 + it * 0.3);
    L.perc.target = m.perc * (0.55 + it * 0.6);
    L.gtr.target = m.gtr * (0.85 + it * 0.2);
    L.glitch.target = m.glitch * (0.4 + it * 0.9);
    synth.setSpace(m.space, m.wet);
  }

  function onBar(barIndex, t) {
    if (S.pendingSystem) {
      configureFrom(S.pendingSystem.rng, S.pendingSystem.seedNum);
      S.pendingSystem = null;
    }
    if (S.pendingMood) {
      S.mood = S.pendingMood.mood;
      S.intensity = S.pendingMood.intensity;
      S.pendingMood = null;
      computeTargets();
    }
    applyTargets(t);

    if (barIndex % S.barsPerChord === 0) {
      S.chordIndex++;
      const deg = currentDegree();
      const tones = chordTones(deg, 3 + (stepHash(S.seed, barIndex, 71) < 0.4 ? 1 : 0));
      S.lastChordTones = tones;
      if (L.pad.target > 0.03) pad(t, tones, (60 / S.bpm) * 4 * S.barsPerChord);
    }

    // Textura esparsa: raramente, e de preferência quando o resto está calmo.
    if (L.gtr.target > 0.05 && stepHash(S.seed, barIndex, 131) < 0.32 + S.density * 0.2) {
      const tones = S.lastChordTones;
      const n = tones[Math.floor(stepHash(S.seed, barIndex, 137) * tones.length) % tones.length] + 12;
      texture(t + (60 / S.bpm) * (stepHash(S.seed, barIndex, 139) < 0.5 ? 0 : 2), n, (60 / S.bpm) * 3.5);
    }
  }

  function scheduleStep(step, t) {
    const s = step % STEPS_PER_BAR;
    const bar = Math.floor(step / STEPS_PER_BAR);
    if (s === 0) { S.bars = bar; onBar(bar, t); }

    // A descoberta entra no próximo tempo forte — resposta rápida, mas no ritmo.
    if (S.discoveryPending && s % 4 === 0) {
      S.discoveryPending = 0;
      discoveryGesture(t);
    }

    const d = S.density;
    const tones = S.lastChordTones;
    const beat = 60 / S.bpm;

    // ── Baixo ───────────────────────────────────────────────────────────────
    if (L.bass.target > 0.03) {
      const hit = s === 0 || (S.bassPattern[s] && d > 0.25) || (s === 8 && d > 0.4);
      if (hit) {
        const oct = s === 0 ? -1 : (stepHash(S.seed, step, 3) < 0.25 ? 0 : -1);
        bass(t, noteOf(currentDegree(), oct), beat * (s === 0 ? 1.6 : 0.7), d);
      }
    }

    // ── Arpejo ──────────────────────────────────────────────────────────────
    if (L.arp.target > 0.03 && S.arpPattern[s] && d > 0.12) {
      const idx = (step * 3 + Math.floor(stepHash(S.seed, step, 5) * 3)) % (tones.length * 2);
      const n = tones[idx % tones.length] + 12 + (idx >= tones.length ? 12 : 0);
      arp(t, n, 0.6 + stepHash(S.seed, step, 7) * 0.4);
    }

    // ── Percussão: cresce em CAMADAS, não em volume ─────────────────────────
    if (L.perc.target > 0.02 && d > 0.14) {
      // Camada 1 — bumbo no 1 (e no 3 assim que houver alguma energia).
      if (s === 0) kick(t, 1);
      else if (s === 8 && d > 0.3) kick(t, 0.9);
      // Camada 2 — chimbal em colcheias.
      if (d > 0.34 && s % 4 === 0) hat(t, 0.7 + (s === 0 ? 0.3 : 0));
      // Camada 3 — caixa no contratempo.
      if (d > 0.45 && (s === 4 || s === 12)) snare(t, 0.9);
      // Camada 4 — chimbal em semicolcheias com acento variável.
      if (d > 0.6 && s % 2 === 0) hat(t, 0.35 + stepHash(S.seed, step, 13) * 0.3);
      // Camada 5 — bumbos fantasmas e chimbal aberto.
      if (d > 0.72 && stepHash(S.seed, step, 17) < 0.18) kick(t, 0.5);
      if (d > 0.7 && s === 14) hat(t, 0.6, true);
      // Camada 6 — semicolcheias completas e viradas no fim do compasso.
      if (d > 0.85 && s % 2 === 1 && stepHash(S.seed, step, 19) < 0.55) hat(t, 0.28);
      if (d > 0.9 && s >= 12 && stepHash(S.seed, step, 23) < 0.4) snare(t, 0.4);
    }

    // ── Glitch ──────────────────────────────────────────────────────────────
    if (L.glitch.target > 0.03 && stepHash(S.seed, step, 29) < 0.10 + L.glitch.target * 0.25) {
      glitch(t, L.glitch.target);
    }
  }

  function tick() {
    if (!S.enabled || !S.playing) return;
    // Contexto suspenso (aba em segundo plano, headless sem dispositivo):
    // não agenda nada e reancora quando voltar, senão tudo dispara de uma vez.
    if (!synth.running) { S.anchored = false; return; }
    const now = ac.currentTime;
    if (!S.anchored || S.nextStepTime < now - 0.5 || S.nextStepTime > now + 4) {
      S.nextStepTime = now + 0.06;
      S.step = 0;
      S.anchored = true;
      computeTargets();
    }
    let guard = 0;
    while (S.nextStepTime < now + LOOKAHEAD && guard++ < 64) {
      try { scheduleStep(S.step, S.nextStepTime); } catch (e) { /* uma nota perdida não derruba a trilha */ }
      S.step++;
      S.nextStepTime += S.stepDur;
    }
  }

  // ── API ───────────────────────────────────────────────────────────────────
  return {
    get playing() { return S.playing; },
    get bpm() { return S.bpm; },
    get mood() { return S.mood; },
    get intensity() { return S.intensity; },
    get scale() { return S.scaleName; },
    bus,

    start() {
      if (S.playing) return;
      S.playing = true;
      S.anchored = false;
      computeTargets();
    },
    stop() {
      S.playing = false;
      for (const k of LAYERS) synth.ramp(L[k].gain.gain, 0.0001, synth.now(), 1.2);
      for (const k of LAYERS) L[k].applied = -1;
    },

    /** Troca de sistema estelar: aplicada no próximo compasso, sem corte. */
    setSystem(rng, seedNum) { S.pendingSystem = { rng, seedNum }; },

    /** Contexto → camadas. A troca sempre espera o compasso virar. */
    setMood(mood, intensity = 0.4) {
      const m = MOODS[mood] ? mood : 'space';
      const it = clamp(Number(intensity), 0, 1) || 0;
      if (S.mood === m && Math.abs(S.intensity - it) < 0.06 && !S.pendingMood) return;
      S.pendingMood = { mood: m, intensity: it };
      // Compasso longo demais? A intensidade ainda assim entra logo, para o
      // combate não chegar atrasado — só as CAMADAS esperam o compasso.
      if (m === 'combat' || m === 'danger') S.intensity = Math.max(S.intensity, it);
    },

    /** Disparado por 'discovery:new'. */
    discovery() { S.discoveryPending = 1; },

    setVolume(v) { synth.ramp(bus.gain, clamp(v, 0, 1.2), synth.now(), 0.3); },
    setEnabled(b) {
      S.enabled = !!b;
      synth.ramp(bus.gain, b ? (opts.volume ?? 0.55) : 0.0001, synth.now(), 0.5);
    },

    update: tick,

    debugText() {
      return `${S.mood} i${S.intensity.toFixed(2)} ${S.bpm}bpm ${S.scaleName} d${S.density.toFixed(2)} c${S.chordIndex % S.progression.length}`;
    },

    dispose() {
      S.playing = false;
      try { padLfo.stop(); padFilter.disconnect(); bus.disconnect(); } catch (e) { /* ignora */ }
      for (const k of LAYERS) { try { L[k].gain.disconnect(); } catch (e) { /* ignora */ } }
    },
  };
}

/** Trilha inerte: mantém a API viva quando não há áudio nenhum. */
function createNullMusic() {
  return {
    playing: false, bpm: 0, mood: 'none', intensity: 0, scale: 'none', bus: null,
    start() {}, stop() {}, setSystem() {}, setMood() {}, discovery() {},
    setVolume() {}, setEnabled() {}, update() {}, debugText() { return 'off'; }, dispose() {},
  };
}
