import * as THREE from 'three';
import { createContext } from './core/context.js';
import { installShots } from './core/shots.js';

/**
 * Manifesto de módulos — TAMBÉM É O MAPA DE PROPRIEDADE DE ARQUIVOS.
 * Cada linha é um sistema independente; um módulo nunca edita o arquivo de
 * outro. `order` define a ordem de update por frame.
 *
 * `required: true` → falha no init derruba o boot.
 * `required: false` → falha vira aviso e o jogo continua degradado.
 */
export const MODULES = [
  { path: './universe/universe.js', id: 'universe', order: 10, required: true },
  { path: './atmo/starfield.js', id: 'starfield', order: 12, required: false },
  { path: './ship/flight.js', id: 'flight', order: 20, required: true },
  { path: './planet/planet.js', id: 'planet', order: 30, required: true },
  { path: './render/lighting.js', id: 'lighting', order: 35, required: false },
  { path: './atmo/sky.js', id: 'sky', order: 40, required: false },
  { path: './atmo/clouds.js', id: 'clouds', order: 41, required: false },
  { path: './atmo/weather.js', id: 'weather', order: 42, required: false },
  { path: './render/water.js', id: 'water', order: 45, required: false },
  { path: './life/flora.js', id: 'flora', order: 50, required: false },
  { path: './life/fauna.js', id: 'fauna', order: 51, required: false },
  { path: './ship/combat.js', id: 'combat', order: 55, required: false },
  { path: './gameplay/multitool.js', id: 'multitool', order: 56, required: false },
  { path: './gameplay/inventory.js', id: 'inventory', order: 57, required: false },
  { path: './gameplay/discovery.js', id: 'discovery', order: 58, required: false },
  { path: './gameplay/sentinels.js', id: 'sentinels', order: 59, required: false },
  { path: './gameplay/building.js', id: 'building', order: 60, required: false },
  { path: './ship/cockpit.js', id: 'cockpit', order: 65, required: false },
  { path: './audio/audio.js', id: 'audio', order: 80, required: false },
  { path: './render/postfx.js', id: 'postfx', order: 90, required: false },
  { path: './ui/hud.js', id: 'hud', order: 95, required: false },
  { path: './ui/galaxymap.js', id: 'galaxymap', order: 96, required: false },
  { path: './perf/perf.js', id: 'perf', order: 99, required: false },
];

const MAX_DT = 1 / 15;   // nunca simula passos maiores que isso

export async function boot(options = {}) {
  const container = document.getElementById('glwrap') || document.body;
  const params = new URLSearchParams(location.search);
  const seed = options.seed || params.get('seed') || 'AETHER-PRIME';
  const quality = options.quality || params.get('q') || 'high';

  const ctx = createContext({ container, seed, quality });
  window.__AETHER__ = ctx;   // ponte para testes automatizados e o modo foto

  const bootEl = document.getElementById('boot');
  const fillEl = document.getElementById('bootFill');
  const txtEl = document.getElementById('bootTxt');
  const btnEl = document.getElementById('bootBtn');
  const seedEl = document.getElementById('bootSeed');
  if (seedEl) seedEl.textContent = seed;

  ctx.events.on('boot:progress', ({ frac, label }) => {
    if (fillEl) fillEl.style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
    if (txtEl && label) txtEl.textContent = label;
  });

  // ── Carrega os módulos ─────────────────────────────────────────────────────
  const loaded = [];
  const failures = [];
  const list = MODULES.slice().sort((a, b) => a.order - b.order);

  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    ctx.progress(i / list.length * 0.9, `carregando ${entry.id}…`);
    try {
      const mod = await import(/* @vite-ignore */ entry.path);
      if (typeof mod.init === 'function') {
        await mod.init(ctx);
      }
      loaded.push({ ...entry, mod });
    } catch (err) {
      failures.push({ id: entry.id, err });
      console.error(`[main] módulo "${entry.id}" falhou:`, err);
      if (entry.required) {
        throw new Error(`módulo obrigatório "${entry.id}" falhou: ${err.message}`);
      }
    }
    // Cede o frame para a barra de progresso realmente pintar.
    await new Promise((r) => requestAnimationFrame(r));
  }

  ctx.modules = loaded;
  ctx.moduleFailures = failures;
  ctx.progress(0.95, 'aquecendo shaders…');

  // Pré-compila para evitar hitching no primeiro frame de cada material.
  try {
    ctx.engine.syncCameras();
    ctx.engine.renderer.compile(ctx.engine.scene, ctx.engine.camera);
    ctx.engine.renderer.compile(ctx.engine.farScene, ctx.engine.farCamera);
  } catch (e) { console.warn('[main] pré-compilação parcial:', e); }

  installShots(ctx);

  ctx.progress(1, failures.length ? `pronto (${failures.length} sistema(s) degradado(s))` : 'pronto');
  ctx.events.emit('boot:ready', { failures });
  ctx.ready = true;

  // ── Loop ───────────────────────────────────────────────────────────────────
  const updaters = loaded.filter((m) => typeof m.mod.update === 'function');
  const lateUpdaters = loaded.filter((m) => typeof m.mod.lateUpdate === 'function');
  const postfx = ctx.get('postfx');

  let running = false;
  let last = performance.now();

  function frame(now) {
    requestAnimationFrame(frame);
    if (!running) return;

    const rawDt = (now - last) / 1000;
    last = now;
    const dt = Math.min(rawDt, MAX_DT) * ctx.time.scale;

    ctx.time.raw = rawDt;
    ctx.time.dt = dt;
    ctx.time.elapsed += dt;
    ctx.time.frames++;
    ctx.budget.frameStart = performance.now();

    ctx.engine.renderer.info.reset();

    for (let i = 0; i < updaters.length; i++) {
      const m = updaters[i];
      try { m.mod.update(dt, ctx); }
      catch (e) { reportModuleError(m, e); }
    }

    // A origem flutuante só se move DEPOIS que todos escreveram suas posições.
    ctx.frame.update(ctx.player.position);

    for (let i = 0; i < lateUpdaters.length; i++) {
      const m = lateUpdaters[i];
      try { m.mod.lateUpdate(dt, ctx); }
      catch (e) { reportModuleError(m, e); }
    }

    // ── Render ───────────────────────────────────────────────────────────────
    if (postfx && postfx.render) {
      postfx.render(ctx);
    } else {
      ctx.engine.renderToTarget(null);       // direto na tela como fallback
      ctx.engine.renderOverlay();
    }

    ctx.input.endFrame();
    ctx.engine.tickStats(performance.now() - now);
  }

  const errCounts = new Map();
  function reportModuleError(m, e) {
    const n = (errCounts.get(m.id) || 0) + 1;
    errCounts.set(m.id, n);
    if (n <= 3) console.error(`[${m.id}] erro no update:`, e);
    if (n === 20) {
      console.error(`[${m.id}] silenciado após 20 erros — desativando módulo.`);
      const i = updaters.indexOf(m);
      if (i >= 0) updaters.splice(i, 1);
    }
  }

  requestAnimationFrame(frame);

  // ── Início controlado pelo usuário (necessário para áudio e pointer lock) ──
  const start = () => {
    if (running) return;
    running = true;
    last = performance.now();
    if (bootEl) bootEl.classList.add('gone');
    ctx.input.requestPointerLock();
    ctx.events.emit('game:start', {});
  };

  if (btnEl) {
    btnEl.hidden = false;
    btnEl.addEventListener('click', start, { once: false });
  }
  // Modo automatizado: ?auto=1 pula o clique (usado pelos testes de screenshot).
  if (params.get('auto') === '1' || options.autoStart) {
    setTimeout(start, 50);
  }

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') {
      ctx.time.scale = ctx.time.scale === 0 ? 1 : 0;
      ctx.events.emit('game:pause', { paused: ctx.time.scale === 0 });
    }
    if (e.code === 'Backquote') {
      ctx.debug.enabled = !ctx.debug.enabled;
    }
  });

  ctx.start = start;
  return ctx;
}
