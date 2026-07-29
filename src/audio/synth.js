/**
 * AETHER — caixa de ferramentas de síntese (WebAudio puro).
 *
 * Por quê este arquivo existe: o repositório não carrega um único byte de som.
 * Vento, bicho, motor e trilha nascem de osciladores e ruído gerados em runtime.
 * Este módulo é a "bancada": osciladores, envelopes, filtros, FM, granulação,
 * reverb por convolução com IR PROCEDURAL, delay, distorção e limitador.
 *
 * Regras de sobrevivência (o jogo roda em auditoria headless, sem placa de som):
 *  - Nada aqui é construído antes de existir um AudioContext válido.
 *  - Toda escrita em AudioParam passa por guardas contra NaN/Infinity, porque um
 *    único NaN envenena o grafo inteiro e mata o áudio até o fim da sessão.
 *  - Nenhuma exceção escapa: o pior caso é silêncio, nunca um frame perdido.
 *
 * Roteamento:
 *   fontes ──┬─────────────────────────────► busIn ─► color(LP global) ─► master ─► limiter ─► destination
 *            ├─► reverbSend ─► convolver ─► reverbReturn ─┘
 *            └─► delaySend  ─► delay ⟲ fb ─► delayReturn  ─┘
 */

/** PRNG local: o ruído das IRs precisa ser reprodutível sem tocar em ctx.rng. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }
export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function ok(v) { return Number.isFinite(v); }

/**
 * Espaços acústicos. `seconds` é o tamanho da cauda, `decay` a velocidade do
 * decaimento, `damp` o corte do passa-baixa de um polo que escurece a cauda
 * (paredes absorventes), `width` a descorrelação entre os canais.
 */
export const SPACES = {
  cockpit: { seconds: 0.5, decay: 3.4, damp: 2400, predelay: 0.003, width: 0.3, taps: 5 },
  cave: { seconds: 3.4, decay: 1.5, damp: 900, predelay: 0.018, width: 0.85, taps: 9 },
  valley: { seconds: 2.6, decay: 1.9, damp: 4200, predelay: 0.045, width: 1.0, taps: 6 },
  hall: { seconds: 6.0, decay: 1.1, damp: 2000, predelay: 0.05, width: 1.0, taps: 8 },
  vast: { seconds: 8.0, decay: 0.85, damp: 1100, predelay: 0.08, width: 1.0, taps: 10 },
  dry: { seconds: 0.35, decay: 6.0, damp: 6000, predelay: 0.001, width: 0.2, taps: 3 },
};

/** Curvas de waveshaper em cache — recriar Float32Array por nota é desperdício. */
const _curves = new Map();
export function shaperCurve(amount, n = 1024) {
  const key = Math.round(clamp(amount, 0, 1) * 40);
  let c = _curves.get(key);
  if (c) return c;
  c = new Float32Array(n);
  const k = (key / 40) * 45 + 0.35;
  const norm = Math.tanh(k) || 1;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / norm;
  }
  _curves.set(key, c);
  return c;
}

export class Synth {
  /**
   * @param {AudioContext} ac contexto já criado (nunca criado aqui de propósito:
   *        a política de autoplay exige que quem cria seja o gesto do usuário)
   */
  constructor(ac, { random = null, maxVoices = 72 } = {}) {
    this.ac = ac;
    this.random = typeof random === 'function' ? random : mulberry32(0xa3f17b21);
    this.maxVoices = maxVoices;
    this.voices = 0;
    this.peakVoices = 0;
    this._irCache = new Map();
    this._space = 'valley';
    this.ok = false;

    try {
      const g = (v) => { const n = ac.createGain(); n.gain.value = v; return n; };

      this.limiter = ac.createDynamicsCompressor();
      this.limiter.threshold.value = -7;
      this.limiter.knee.value = 0;
      this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.003;
      this.limiter.release.value = 0.25;

      this.master = g(0.85);
      // Passa-baixa global: submerso, pausado, dentro do capacete.
      this.color = ac.createBiquadFilter();
      this.color.type = 'lowpass';
      this.color.frequency.value = 20000;
      this.color.Q.value = 0.55;

      this.busIn = g(1);
      this.busIn.connect(this.color);
      this.color.connect(this.master);
      this.master.connect(this.limiter);
      this.limiter.connect(ac.destination);

      // ── Reverb ───────────────────────────────────────────────────────────
      this.convolver = ac.createConvolver();
      this.convolver.normalize = false;
      this.reverbSend = g(1);
      this.reverbReturn = g(0.9);
      // Um passa-alta no envio evita que graves entupam a cauda de convolução.
      this.reverbTilt = ac.createBiquadFilter();
      this.reverbTilt.type = 'highpass';
      this.reverbTilt.frequency.value = 130;
      this.reverbSend.connect(this.reverbTilt);
      this.reverbTilt.connect(this.convolver);
      this.convolver.connect(this.reverbReturn);
      this.reverbReturn.connect(this.color);

      // ── Delay com realimentação ──────────────────────────────────────────
      this.delaySend = g(1);
      this.delay = ac.createDelay(4.0);
      this.delay.delayTime.value = 0.375;
      this.delayFb = g(0.42);
      this.delayTone = ac.createBiquadFilter();
      this.delayTone.type = 'lowpass';
      this.delayTone.frequency.value = 2600;
      this.delayReturn = g(0.7);
      this.delaySend.connect(this.delay);
      this.delay.connect(this.delayTone);
      this.delayTone.connect(this.delayFb);
      this.delayFb.connect(this.delay);            // realimentação
      this.delayTone.connect(this.delayReturn);
      this.delayReturn.connect(this.color);
      // Ecos também respiram no reverb — cola as duas caudas.
      this.delayReturn.connect(this.reverbSend);

      this.setSpace('valley');
      this.ok = true;
    } catch (e) {
      this.ok = false;
    }
  }

  // ── Tempo e parâmetros ─────────────────────────────────────────────────────
  now() { return this.ac ? this.ac.currentTime : 0; }
  get running() { return !!this.ac && this.ac.state === 'running'; }

  /** Escrita segura em AudioParam. */
  set(param, v, t) {
    if (!param || !ok(v)) return;
    try { param.setValueAtTime(v, ok(t) ? Math.max(t, this.now()) : this.now()); } catch (e) { /* param fora de faixa */ }
  }
  ramp(param, v, t, dur = 0.05) {
    if (!param || !ok(v) || !ok(dur)) return;
    const t0 = ok(t) ? Math.max(t, this.now()) : this.now();
    try {
      param.cancelScheduledValues(t0);
      param.setValueAtTime(param.value, t0);
      param.linearRampToValueAtTime(v, t0 + Math.max(dur, 0.002));
    } catch (e) { /* ignora */ }
  }
  /** Rampa exponencial — obrigatória para frequência soar linear ao ouvido. */
  expRamp(param, v, t, dur = 0.2) {
    if (!param || !ok(v)) return;
    const t0 = ok(t) ? Math.max(t, this.now()) : this.now();
    const target = Math.max(1e-4, v);
    try {
      param.cancelScheduledValues(t0);
      param.setValueAtTime(Math.max(1e-4, param.value), t0);
      param.exponentialRampToValueAtTime(target, t0 + Math.max(dur, 0.002));
    } catch (e) { /* ignora */ }
  }
  /** Aproximação suave contínua (usada por parâmetros que seguem o gameplay). */
  glide(param, v, tau = 0.25) {
    if (!param || !ok(v)) return;
    try { param.setTargetAtTime(v, this.now(), Math.max(0.01, tau)); } catch (e) { /* ignora */ }
  }

  // ── Nós básicos ────────────────────────────────────────────────────────────
  gain(v = 1) { const n = this.ac.createGain(); n.gain.value = ok(v) ? v : 0; return n; }

  osc(type = 'sine', freq = 440, detuneCents = 0) {
    const o = this.ac.createOscillator();
    o.type = type === 'noise' ? 'sawtooth' : type;
    o.frequency.value = clamp(ok(freq) ? freq : 440, 0.01, 20000);
    if (detuneCents) o.detune.value = clamp(detuneCents, -4800, 4800);
    return o;
  }

  biquad(type = 'lowpass', freq = 1000, q = 0.7, gainDb = 0) {
    const f = this.ac.createBiquadFilter();
    f.type = type;
    f.frequency.value = clamp(ok(freq) ? freq : 1000, 10, 22000);
    f.Q.value = clamp(ok(q) ? q : 0.7, 0.0001, 40);
    if (gainDb) f.gain.value = clamp(gainDb, -40, 40);
    return f;
  }

  shaper(amount = 0.3, oversample = '2x') {
    const w = this.ac.createWaveShaper();
    w.curve = shaperCurve(amount);
    try { w.oversample = oversample; } catch (e) { /* ignora */ }
    return w;
  }

  /** LFO pronto: devolve {osc, depth} já rodando; conecte `depth` num AudioParam. */
  lfo(rate = 0.2, depth = 1, type = 'sine', phaseOffsetSec = 0) {
    const o = this.osc(type, rate);
    const d = this.gain(depth);
    o.connect(d);
    try { o.start(this.now() + Math.max(0, phaseOffsetSec)); } catch (e) { /* ignora */ }
    return { osc: o, depth: d, stop: (t) => { try { o.stop(t || this.now()); } catch (e) { /* ignora */ } } };
  }

  // ── Buffers de ruído (gerados uma vez, reaproveitados sempre) ───────────────
  noiseBuffer(kind = 'white', seconds = 2) {
    const key = kind + ':' + seconds;
    if (this._irCache.has(key)) return this._irCache.get(key);
    const rate = this.ac.sampleRate;
    const len = Math.max(1, Math.floor(rate * seconds));
    const buf = this.ac.createBuffer(2, len, rate);
    const rnd = this.random;
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      if (kind === 'brown') {
        let last = 0;
        for (let i = 0; i < len; i++) {
          const w = rnd() * 2 - 1;
          last = (last + 0.02 * w) / 1.02;
          d[i] = last * 3.5;
        }
      } else if (kind === 'pink') {
        // Filtro de Paul Kellet — barato e convincente.
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        for (let i = 0; i < len; i++) {
          const w = rnd() * 2 - 1;
          b0 = 0.99886 * b0 + w * 0.0555179;
          b1 = 0.99332 * b1 + w * 0.0750759;
          b2 = 0.96900 * b2 + w * 0.1538520;
          b3 = 0.86650 * b3 + w * 0.3104856;
          b4 = 0.55000 * b4 + w * 0.5329522;
          b5 = -0.7616 * b5 - w * 0.0168980;
          d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
          b6 = w * 0.115926;
        }
      } else {
        for (let i = 0; i < len; i++) d[i] = rnd() * 2 - 1;
      }
    }
    this._irCache.set(key, buf);
    return buf;
  }

  /** Fonte de ruído em loop (vento, chuva, estática). Lembre de start(). */
  noise(kind = 'white', loop = true) {
    const s = this.ac.createBufferSource();
    s.buffer = this.noiseBuffer(kind, kind === 'brown' ? 4 : 2);
    s.loop = loop;
    return s;
  }

  // ── Envelopes ──────────────────────────────────────────────────────────────
  /**
   * ADSR num AudioParam de ganho. `hold` é o tempo entre o fim do decay e o
   * início do release. Devolve o instante em que o som termina de fato.
   */
  adsr(param, t0, { a = 0.01, d = 0.1, s = 0.6, r = 0.3, peak = 1, hold = 0.1 } = {}) {
    if (!param) return t0;
    const t = Math.max(t0, this.now());
    const pk = clamp(ok(peak) ? peak : 1, 0, 4);
    const sus = clamp(pk * s, 0, 4);
    try {
      param.cancelScheduledValues(t);
      param.setValueAtTime(0.0001, t);
      param.linearRampToValueAtTime(pk, t + Math.max(a, 0.001));
      param.exponentialRampToValueAtTime(Math.max(sus, 0.0001), t + a + Math.max(d, 0.001));
      const rel = t + a + d + Math.max(hold, 0);
      param.setValueAtTime(Math.max(sus, 0.0001), rel);
      param.exponentialRampToValueAtTime(0.0001, rel + Math.max(r, 0.01));
      return rel + Math.max(r, 0.01);
    } catch (e) { return t + 1; }
  }

  /** Cria um ganho já envelopado e conectado — o caminho mais curto para uma nota. */
  envGain(t0, opts = {}, out = null) {
    const g = this.gain(0.0001);
    const end = this.adsr(g.gain, t0, opts);
    g.connect(out || this.busIn);
    g._end = end;
    return g;
  }

  /** Envio para reverb/delay a partir de qualquer nó. */
  send(node, { reverb = 0, delay = 0 } = {}) {
    if (!node) return;
    if (reverb > 0) { const g = this.gain(reverb); node.connect(g); g.connect(this.reverbSend); }
    if (delay > 0) { const g = this.gain(delay); node.connect(g); g.connect(this.delaySend); }
  }

  // ── Vozes ──────────────────────────────────────────────────────────────────
  canVoice() { return this.voices < this.maxVoices; }

  /** Registra uma fonte para contabilidade e limpeza automática do grafo. */
  track(source, chainHead, stopAt) {
    if (!source) return;
    this.voices++;
    if (this.voices > this.peakVoices) this.peakVoices = this.voices;
    const cleanup = () => {
      this.voices = Math.max(0, this.voices - 1);
      try { source.disconnect(); } catch (e) { /* ignora */ }
      if (chainHead && chainHead !== source) { try { chainHead.disconnect(); } catch (e) { /* ignora */ } }
    };
    source.onended = cleanup;
    if (ok(stopAt)) { try { source.stop(stopAt); } catch (e) { /* ignora */ } }
  }

  /**
   * Voz FM de dois operadores — a base de sino, inseto, bip e voz de bicho.
   * `index` é o índice de modulação em múltiplos da frequência da portadora.
   */
  fmVoice({
    t = 0, freq = 220, ratio = 2, index = 3, dur = 0.4, out = null,
    carrier = 'sine', modType = 'sine', env = null, gain = 0.3,
    reverb = 0.12, delay = 0, detune = 0, glideTo = 0,
  } = {}) {
    if (!this.ok || !this.canVoice()) return null;
    const t0 = Math.max(t || this.now(), this.now());
    const f = clamp(ok(freq) ? freq : 220, 8, 12000);
    const car = this.osc(carrier, f, detune);
    const mod = this.osc(modType, f * clamp(ratio, 0.05, 24));
    const modGain = this.gain(f * clamp(index, 0, 30));
    // O índice cai com o tempo: timbres acústicos perdem parciais ao decair.
    this.ramp(modGain.gain, f * clamp(index, 0, 30) * 0.12, t0 + dur * 0.55, dur * 0.55);
    mod.connect(modGain);
    modGain.connect(car.frequency);

    const g = this.envGain(t0, env || { a: 0.006, d: dur * 0.35, s: 0.35, r: dur * 0.5, peak: gain, hold: dur * 0.2 }, out || this.busIn);
    car.connect(g);
    this.send(g, { reverb, delay });
    if (glideTo > 0) this.expRamp(car.frequency, glideTo, t0, dur);

    const end = (g._end || t0 + dur) + 0.05;
    try { car.start(t0); mod.start(t0); mod.stop(end); } catch (e) { /* ignora */ }
    this.track(car, g, end);
    return { osc: car, gain: g, end };
  }

  /**
   * Granulação a partir de um buffer (por padrão o próprio ruído interno).
   * Usada pela camada de glitch e pelos texturizadores de perigo.
   */
  granular({
    t = 0, dur = 0.6, buffer = null, grainMs = 60, density = 40, pitch = 1,
    jitter = 0.4, spread = 0.5, out = null, gain = 0.25, reverb = 0.2, filter = 0,
  } = {}) {
    if (!this.ok) return;
    const buf = buffer || this.noiseBuffer('pink', 2);
    if (!buf) return;
    const t0 = Math.max(t || this.now(), this.now());
    const bus = this.gain(gain);
    let head = bus;
    if (filter > 0) {
      const f = this.biquad('bandpass', filter, 3.5);
      bus.connect(f); head = f;
    }
    head.connect(out || this.busIn);
    this.send(head, { reverb, delay: 0.1 });
    const n = clamp(Math.floor(density * dur), 1, 48);
    const step = dur / n;
    for (let i = 0; i < n; i++) {
      if (!this.canVoice()) break;
      const gt = t0 + i * step + (this.random() - 0.5) * step * jitter;
      const src = this.ac.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.loopStart = this.random() * Math.max(0.01, buf.duration - 0.2);
      src.loopEnd = Math.min(buf.duration, src.loopStart + 0.18);
      src.playbackRate.value = clamp(pitch * (1 + (this.random() - 0.5) * spread), 0.05, 8);
      const gg = this.gain(0.0001);
      const gl = Math.max(0.008, grainMs / 1000);
      this.adsr(gg.gain, gt, { a: gl * 0.3, d: gl * 0.3, s: 0.5, r: gl * 0.5, peak: 1, hold: 0 });
      src.connect(gg);
      gg.connect(bus);
      try { src.start(Math.max(gt, this.now()), src.loopStart); } catch (e) { /* ignora */ }
      this.track(src, gg, gt + gl * 1.4);
    }
  }

  // ── Reverb procedural ──────────────────────────────────────────────────────
  impulse(name = 'valley') {
    const key = 'ir:' + name;
    if (this._irCache.has(key)) return this._irCache.get(key);
    const spec = SPACES[name] || SPACES.valley;
    const buf = this._buildImpulse(spec);
    if (buf) this._irCache.set(key, buf);
    return buf;
  }

  _buildImpulse({ seconds, decay, damp, predelay, width, taps }) {
    try {
      const ac = this.ac;
      const rate = ac.sampleRate;
      const pre = Math.floor(predelay * rate);
      const len = Math.max(2, Math.floor(rate * seconds) + pre);
      const buf = ac.createBuffer(2, len, rate);
      const rnd = this.random;
      const k = Math.exp(-2 * Math.PI * clamp(damp, 80, 16000) / rate);
      const a = buf.getChannelData(0);
      const b = buf.getChannelData(1);
      const tail = len - pre;
      let lpA = 0, lpB = 0;
      let peak = 1e-6;
      for (let i = 0; i < tail; i++) {
        const u = i / tail;
        // Decaimento exponencial + janela: cauda que morre sem corte audível.
        const env = Math.exp(-decay * 4.2 * u) * (1 - u) * (1 - u);
        const nA = rnd() * 2 - 1;
        const nB = rnd() * 2 - 1;
        lpA = nA * (1 - k) + lpA * k;
        lpB = nB * (1 - k) + lpB * k;
        const sA = (nA * 0.25 + lpA * 1.8) * env;
        const sBraw = (nB * 0.25 + lpB * 1.8) * env;
        // width=0 → mono (cockpit); width=1 → canais independentes (vale).
        const sB = sA * (1 - width) + sBraw * width;
        a[pre + i] = sA;
        b[pre + i] = sB;
        const m = Math.max(Math.abs(sA), Math.abs(sB));
        if (m > peak) peak = m;
      }
      // Reflexões iniciais: é o que o ouvido usa para julgar o TAMANHO do lugar.
      for (let j = 0; j < taps; j++) {
        const p = pre + Math.floor((0.01 + rnd() * 0.55) * tail);
        if (p < len - 1) {
          const amp = (rnd() * 2 - 1) * 0.55 * Math.exp(-j * 0.42);
          a[p] += amp;
          b[Math.min(len - 1, p + Math.floor(rnd() * 90))] += amp * (0.6 + 0.4 * width);
          peak = Math.max(peak, Math.abs(amp) * 1.5);
        }
      }
      const norm = 0.62 / peak;
      for (let i = 0; i < len; i++) { a[i] *= norm; b[i] *= norm; }
      return buf;
    } catch (e) { return null; }
  }

  setSpace(name, wet = null) {
    if (!this.ok && !this.convolver) return;
    if (name && name !== this._space) {
      const ir = this.impulse(name);
      if (ir) { try { this.convolver.buffer = ir; this._space = name; } catch (e) { /* ignora */ } }
    } else if (!this.convolver.buffer) {
      const ir = this.impulse(this._space);
      if (ir) { try { this.convolver.buffer = ir; } catch (e) { /* ignora */ } }
    }
    if (wet !== null) this.ramp(this.reverbReturn.gain, clamp(wet, 0, 2), this.now(), 1.5);
  }

  /** Sincroniza o delay com o andamento — eco pontuado, nunca "borrado". */
  setDelay({ time = null, feedback = null, tone = null, mix = null }, ramp = 0.4) {
    if (!this.ok) return;
    const t = this.now();
    if (time !== null) this.ramp(this.delay.delayTime, clamp(time, 0.01, 3.9), t, ramp);
    if (feedback !== null) this.ramp(this.delayFb.gain, clamp(feedback, 0, 0.88), t, ramp);
    if (tone !== null) this.ramp(this.delayTone.frequency, clamp(tone, 200, 16000), t, ramp);
    if (mix !== null) this.ramp(this.delayReturn.gain, clamp(mix, 0, 1.5), t, ramp);
  }

  // ── Saída ──────────────────────────────────────────────────────────────────
  setMasterVolume(v, dur = 0.12) { this.ramp(this.master.gain, clamp(ok(v) ? v : 0, 0, 1.4), this.now(), dur); }
  /** Passa-baixa global: submerso, pausado, dentro do capacete. */
  setColor(cutoff, dur = 0.35, q = 0.55) {
    if (!this.ok) return;
    this.expRamp(this.color.frequency, clamp(cutoff, 60, 21000), this.now(), dur);
    this.ramp(this.color.Q, clamp(q, 0.1, 12), this.now(), dur);
  }

  /** Painel de emergência: mata tudo o que estiver soando. */
  panic() {
    try {
      this.set(this.busIn.gain, 0, this.now());
      this.ramp(this.busIn.gain, 1, this.now() + 0.25, 0.2);
    } catch (e) { /* ignora */ }
  }

  dispose() {
    try {
      this.busIn.disconnect();
      this.color.disconnect();
      this.master.disconnect();
      this.limiter.disconnect();
      this.reverbSend.disconnect();
      this.reverbReturn.disconnect();
      this.delaySend.disconnect();
      this.delayReturn.disconnect();
      this.delayFb.disconnect();
    } catch (e) { /* ignora */ }
    this._irCache.clear();
    this.ok = false;
  }
}

/**
 * Panner HRTF pronto para uso espacial, com rolloff e cone.
 * Mantido fora da classe para poder ser usado sem instanciar nada.
 */
export function makePanner(ac, {
  refDistance = 12, maxDistance = 8000, rolloff = 1.1,
  innerAngle = 360, outerAngle = 360, outerGain = 0.4, model = 'inverse',
} = {}) {
  try {
    const p = ac.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = model;
    p.refDistance = refDistance;
    p.maxDistance = maxDistance;
    p.rolloffFactor = rolloff;
    p.coneInnerAngle = innerAngle;
    p.coneOuterAngle = outerAngle;
    p.coneOuterGain = outerGain;
    return p;
  } catch (e) {
    // Navegador sem PannerNode utilizável: um ganho neutro mantém o grafo válido.
    try { return ac.createGain(); } catch (e2) { return null; }
  }
}

/** Escreve posição num panner aceitando as duas gerações da API. */
export function setPannerPosition(p, x, y, z) {
  if (!p) return;
  if (!ok(x) || !ok(y) || !ok(z)) return;
  try {
    if (p.positionX) {
      p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z;
    } else if (p.setPosition) {
      p.setPosition(x, y, z);
    }
  } catch (e) { /* ignora */ }
}

export function setPannerOrientation(p, x, y, z) {
  if (!p) return;
  if (!ok(x) || !ok(y) || !ok(z)) return;
  try {
    if (p.orientationX) { p.orientationX.value = x; p.orientationY.value = y; p.orientationZ.value = z; }
    else if (p.setOrientation) p.setOrientation(x, y, z);
  } catch (e) { /* ignora */ }
}

/** Atualiza o ouvinte a partir da câmera (coordenadas locais da origem flutuante). */
export function setListener(ac, pos, forward, up) {
  if (!ac || !ac.listener) return;
  const l = ac.listener;
  try {
    if (l.positionX) {
      l.positionX.value = pos.x; l.positionY.value = pos.y; l.positionZ.value = pos.z;
      l.forwardX.value = forward.x; l.forwardY.value = forward.y; l.forwardZ.value = forward.z;
      l.upX.value = up.x; l.upY.value = up.y; l.upZ.value = up.z;
    } else {
      if (l.setPosition) l.setPosition(pos.x, pos.y, pos.z);
      if (l.setOrientation) l.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  } catch (e) { /* ignora */ }
}

/**
 * Doppler manual. A WebAudio abandonou o Doppler nativo, então calculamos o
 * fator de escala de frequência a partir da velocidade radial relativa.
 * `c` é a "velocidade do som" do jogo — exagerada de propósito, senão o efeito
 * some nas velocidades absurdas de uma nave.
 */
export function dopplerFactor(relVel, relPos, c = 340) {
  const d = Math.hypot(relPos.x, relPos.y, relPos.z);
  if (!(d > 1e-3)) return 1;
  const vr = (relVel.x * relPos.x + relVel.y * relPos.y + relVel.z * relPos.z) / d;
  // vr > 0 = afastando → som mais grave.
  return clamp(c / (c + vr), 0.35, 3.0);
}
