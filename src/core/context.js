import * as THREE from 'three';
import { Engine } from './engine.js';
import { EventBus } from './events.js';
import { Input } from './input.js';
import { FloatingOrigin, Vec3d } from './frame.js';
import { makeRng } from './rng.js';

/**
 * O contexto compartilhado (`ctx`) é o ÚNICO canal por onde os módulos se
 * enxergam. Nenhum módulo de sistema importa outro módulo de sistema.
 *
 * ── Contrato de um módulo ────────────────────────────────────────────────────
 * Cada arquivo em src/<área>/<nome>.js listado no manifesto exporta:
 *
 *   export const id    = 'planet';        // único
 *   export const order = 30;              // ordem de update (menor = antes)
 *   export const needs = ['universe'];    // ids que devem existir antes do init
 *   export async function init(ctx) {}    // pode ser lento; reporta progresso
 *   export function update(dt, ctx) {}    // por frame, dt em segundos
 *   export function lateUpdate(dt, ctx){} // opcional, depois de todos os update
 *   export function resize(w, h, ctx) {}  // opcional
 *   export function dispose(ctx) {}       // opcional
 *
 * O módulo publica sua API pública em `ctx.<id>`:
 *   ctx.registry.set(id, api)  →  ctx[id] = api
 *
 * REGRAS INVIOLÁVEIS
 *  1. Determinismo: conteúdo persistente vem de ctx.rng.derive(...), nunca de
 *     Math.random().
 *  2. Precisão: posições de mundo em Vec3d (float64). Object3D recebe apenas
 *     coordenadas relativas via ctx.frame.toLocal().
 *  3. Sem bloqueio: geração pesada vai para Web Worker ou é fatiada por frame
 *     usando ctx.budget.canWork().
 *  4. Sem CDN: tudo é servido do repositório. Nenhuma requisição externa.
 */

export const UNITS = {
  /** 1 unidade = 1 metro. */
  METER: 1,
  KM: 1000,
  /** Unidade astronômica comprimida usada dentro de um sistema estelar. */
  AU: 1.2e9,
};

export function createContext({ container, seed = 'AETHER', quality = 'high' } = {}) {
  const engine = new Engine({ container, pixelRatioCap: quality === 'low' ? 1 : 1.5 });
  const events = new EventBus();
  const input = new Input(window, engine.canvas);
  const frame = new FloatingOrigin({ threshold: 2000 });
  const rng = makeRng(seed, 'universe');

  const ctx = {
    THREE,
    UNITS,
    engine,
    events,
    input,
    frame,
    rng,
    seed,

    /** Registro de módulos vivos. */
    registry: new Map(),

    /** Relógio do jogo. */
    time: {
      elapsed: 0,      // segundos desde o início da sessão
      dt: 0,           // delta do frame (segundos, já clampado)
      raw: 0,          // delta bruto
      scale: 1,        // câmera lenta / pausa
      frames: 0,
      /** Hora do dia normalizada [0,1) no planeta atual — preenchido por sky. */
      dayFraction: 0.28,
    },

    /** Estado do jogador. Fonte da verdade em float64. */
    player: {
      /** 'ship' | 'foot' */
      mode: 'ship',
      position: new Vec3d(0, 0, 0),
      velocity: new Vec3d(0, 0, 0),
      /** Orientação do corpo/nave (a câmera pode divergir com look livre). */
      quaternion: new THREE.Quaternion(),
      /** Referências preenchidas por outros módulos. */
      up: new THREE.Vector3(0, 1, 0),
      altitude: Infinity,        // metros acima do terreno (Infinity no espaço)
      groundNormal: new THREE.Vector3(0, 1, 0),
      health: 100, shield: 100, energy: 100, life: 100,
      onGround: false,
      inAtmosphere: false,
    },

    /** Estado do universo. Preenchido pelo módulo `universe`. */
    universe: null,
    /** Sistema estelar atual. */
    system: null,
    /** Planeta sob o jogador (ou null no espaço profundo). */
    planet: null,

    /** Configuração de qualidade, ajustável em tempo real pelo módulo perf. */
    quality: {
      preset: quality,                 // 'low' | 'medium' | 'high' | 'ultra'
      renderScale: 1,
      shadows: quality !== 'low',
      shadowCascades: quality === 'ultra' ? 4 : 3,
      volumetricClouds: quality !== 'low',
      cloudSteps: quality === 'ultra' ? 96 : quality === 'high' ? 64 : 32,
      godrays: quality !== 'low',
      ssao: quality !== 'low',
      motionBlur: quality === 'high' || quality === 'ultra',
      floraDensity: quality === 'low' ? 0.35 : quality === 'medium' ? 0.6 : 1,
      terrainLodBias: quality === 'low' ? 1.5 : 1,
      maxCreatures: quality === 'low' ? 8 : 24,
    },

    /** Orçamento de trabalho por frame — respeitado por todo gerador incremental. */
    budget: {
      frameStart: 0,
      budgetMs: 6,
      canWork() { return performance.now() - this.frameStart < this.budgetMs; },
      remainingMs() { return this.budgetMs - (performance.now() - this.frameStart); },
    },

    /** Telemetria agregada exibida pelo overlay de debug e auditada pelo crítico. */
    debug: {
      enabled: false,
      lines: new Map(),
      set(key, value) { this.lines.set(key, value); },
    },

    /** Utilidades de progresso do boot. */
    progress(frac, label) { events.emit('boot:progress', { frac, label }); },
  };

  // Ajuda: registrar API de módulo.
  ctx.provide = (id, api) => { ctx.registry.set(id, api); ctx[id] = api; return api; };
  ctx.get = (id) => ctx.registry.get(id) || null;

  engine.onResize = (w, h, dpr) => {
    for (const m of ctx.registry.values()) { try { m.resize?.(w, h, dpr, ctx); } catch (e) { console.error(e); } }
  };

  frame.onRebase((shift, origin) => events.emit('frame:rebase', { shift, origin }));

  return ctx;
}

export { Vec3d };
