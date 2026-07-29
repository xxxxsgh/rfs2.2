import * as THREE from 'three';
import { Vec3d } from './frame.js';

/**
 * Poses canônicas para a auditoria visual.
 *
 * O sub-agente crítico compara estas capturas com screenshots reais de No Man's
 * Sky nos mesmos enquadramentos. Os nomes e os enquadramentos são FIXOS — não
 * mude sem atualizar o arnês em tools/shoot.mjs.
 *
 * Este arquivo é infraestrutura compartilhada: módulos de gameplay não o editam.
 */

const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();

export const SHOTS = {

  /** Horizonte planetário visto do solo, olho a 1,7 m, sol baixo à frente. */
  surface_horizon: {
    label: 'horizonte planetário do solo',
    time: 0.30,
    async pose(ctx) {
      const body = await ensurePlanet(ctx);
      const dir = pickSurfacePoint(ctx, body, 0.31, 0.62);
      await standOn(ctx, body, dir, 1.7);
      aimAlongHorizon(ctx, dir, 0.06, 0.0);
    },
  },

  /** Bioma exuberante ao pôr do sol, olhando contra a luz. */
  biome_sunset: {
    label: 'bioma ao pôr do sol',
    time: 0.755,
    biomePreference: 'lush',
    async pose(ctx) {
      const body = await ensurePlanet(ctx, 'lush');
      const dir = pickSurfacePoint(ctx, body, 0.18, 0.44);
      await standOn(ctx, body, dir, 2.2);
      aimAtSun(ctx, dir, 0.04);
    },
  },

  /** Órbita baixa: o limbo do planeta atravessando o quadro. */
  low_orbit: {
    label: 'órbita baixa',
    time: 0.42,
    async pose(ctx) {
      const body = await ensurePlanet(ctx);
      const dir = pickSurfacePoint(ctx, body, 0.5, 0.5);
      const alt = body.radius * 0.42;
      const pos = new Vec3d(
        body.center.x + dir.x * (body.radius + alt),
        body.center.y + dir.y * (body.radius + alt),
        body.center.z + dir.z * (body.radius + alt),
      );
      teleport(ctx, pos);
      // Olha tangencialmente, com o planeta ocupando o terço inferior.
      const up = new THREE.Vector3(dir.x, dir.y, dir.z);
      const tangent = arbitraryTangent(up);
      lookDir(ctx, tangent.clone().addScaledVector(up, -0.34).normalize(), up);
      await ctx.planet?.waitReady?.(pos, 9000);
    },
  },

  /** Interior do cockpit em voo atmosférico rasante. */
  cockpit: {
    label: 'interior do cockpit',
    time: 0.36,
    async pose(ctx) {
      const body = await ensurePlanet(ctx);
      const dir = pickSurfacePoint(ctx, body, 0.66, 0.21);
      const h = ctx.planet?.sampleHeight?.(new THREE.Vector3(dir.x, dir.y, dir.z)) || 0;
      const r = body.radius + h + 520;
      const pos = new Vec3d(body.center.x + dir.x * r, body.center.y + dir.y * r, body.center.z + dir.z * r);
      ctx.flight?.setMode?.('ship');
      teleport(ctx, pos);
      const up = new THREE.Vector3(dir.x, dir.y, dir.z);
      const tangent = arbitraryTangent(up);
      lookDir(ctx, tangent.clone().addScaledVector(up, -0.16).normalize(), up);
      ctx.cockpit?.setVisible?.(true);
      // Dá alguma velocidade para o HUD e o motion blur mostrarem vida.
      ctx.player.velocity.set(tangent.x * 180, tangent.y * 180, tangent.z * 180);
      await ctx.planet?.waitReady?.(pos, 9000);
    },
  },

  /** Espaço profundo: planeta + estrela no mesmo quadro. */
  space: {
    label: 'espaço, planeta enquadrado',
    time: 0.5,
    async pose(ctx) {
      const body = await ensurePlanet(ctx);
      const dir = pickSurfacePoint(ctx, body, 0.77, 0.33);
      const d = body.radius * 4.2;
      const pos = new Vec3d(body.center.x + dir.x * d, body.center.y + dir.y * d, body.center.z + dir.z * d);
      ctx.flight?.setMode?.('ship');
      teleport(ctx, pos);
      lookDir(ctx, new THREE.Vector3(-dir.x, -dir.y, -dir.z), new THREE.Vector3(0, 1, 0));
      await settle(ctx, 40);
    },
  },

  /** Vale profundo — testa erosão, oclusão e escala vertical. */
  canyon: {
    label: 'cânion / escala vertical',
    time: 0.24,
    async pose(ctx) {
      const body = await ensurePlanet(ctx);
      const dir = pickSurfacePoint(ctx, body, 0.83, 0.11);
      await standOn(ctx, body, dir, 6);
      aimAlongHorizon(ctx, dir, 0.14, 1.1);
    },
  },
};

// ── Auxiliares ──────────────────────────────────────────────────────────────

async function ensurePlanet(ctx, preferredClass) {
  if (ctx.universe?.getSystem && ctx.planet?.setActive) {
    const sys = ctx.universe.current || ctx.universe.getSystem(0);
    let target = null;
    const candidates = (sys.bodies || []).filter((b) => b.type !== 'gas');
    if (preferredClass) target = candidates.find((b) => b.biome?.class === preferredClass);
    target = target || candidates.find((b) => b.biome?.class === 'lush') || candidates[0];
    if (target && ctx.planet.current !== target) {
      ctx.planet.setActive(target);
      await settle(ctx, 8);
    }
  }
  const body = ctx.planet?.current;
  if (!body) throw new Error('shots: nenhum planeta ativo');
  return body;
}

/** Direção unitária estável na superfície a partir de dois parâmetros [0,1). */
function pickSurfacePoint(ctx, body, u, v) {
  const theta = u * Math.PI * 2;
  const phi = Math.acos(2 * v - 1);
  return new THREE.Vector3(
    Math.sin(phi) * Math.cos(theta),
    Math.cos(phi),
    Math.sin(phi) * Math.sin(theta),
  ).normalize();
}

async function standOn(ctx, body, dir, eyeHeight) {
  const probe = new Vec3d(
    body.center.x + dir.x * (body.radius + 4000),
    body.center.y + dir.y * (body.radius + 4000),
    body.center.z + dir.z * (body.radius + 4000),
  );
  teleport(ctx, probe);
  await ctx.planet?.waitReady?.(probe, 12000);

  const h = ctx.planet?.sampleHeight?.(dir) ?? 0;
  const sea = ctx.planet?.seaLevelRadius ?? 0;
  const r = Math.max(body.radius + h, sea + 2) + eyeHeight;
  const pos = new Vec3d(body.center.x + dir.x * r, body.center.y + dir.y * r, body.center.z + dir.z * r);
  ctx.flight?.setMode?.('foot');
  teleport(ctx, pos);
  ctx.player.velocity.set(0, 0, 0);
  await ctx.planet?.waitReady?.(pos, 12000);
  await settle(ctx, 30);
}

function teleport(ctx, pos) {
  if (ctx.flight?.teleport) ctx.flight.teleport(pos, null);
  else ctx.player.position.copy(pos);
  ctx.frame.rebaseTo(pos);
}

/** Aponta a câmera tangente à superfície, com leve inclinação. */
function aimAlongHorizon(ctx, dir, pitchUp = 0, yawOffset = 0) {
  const up = new THREE.Vector3(dir.x, dir.y, dir.z);
  let t = arbitraryTangent(up);
  if (yawOffset) t.applyAxisAngle(up, yawOffset);
  const fwd = t.clone().addScaledVector(up, pitchUp).normalize();
  lookDir(ctx, fwd, up);
}

/** Aponta para o sol (contra-luz) — o enquadramento mais cruel de todos. */
function aimAtSun(ctx, dir, pitchUp = 0) {
  const up = new THREE.Vector3(dir.x, dir.y, dir.z);
  const sun = ctx.sky?.sunDirection ? ctx.sky.sunDirection.clone() : arbitraryTangent(up);
  // Projeta o sol no plano tangente para não olhar direto para cima/baixo.
  const fwd = sun.clone().addScaledVector(up, -sun.dot(up)).normalize();
  if (!Number.isFinite(fwd.x) || fwd.lengthSq() < 1e-6) fwd.copy(arbitraryTangent(up));
  fwd.addScaledVector(up, pitchUp).normalize();
  lookDir(ctx, fwd, up);
}

function arbitraryTangent(up) {
  const ref = Math.abs(up.y) > 0.92 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  return new THREE.Vector3().crossVectors(ref, up).normalize();
}

function lookDir(ctx, forward, up) {
  _fwd.copy(forward).normalize();
  _up.copy(up).normalize();
  _right.crossVectors(_fwd, _up).normalize();
  _up.crossVectors(_right, _fwd).normalize();
  // three olha para -Z
  _m.makeBasis(_right, _up, _fwd.clone().negate());
  _q.setFromRotationMatrix(_m);
  ctx.engine.camera.quaternion.copy(_q);
  ctx.player.quaternion.copy(_q);
  ctx.player.up.copy(_up);
  if (ctx.flight?.setOrientation) ctx.flight.setOrientation(_q);
}

/** Deixa o loop rodar N frames para o streaming/LOD estabilizar. */
export function settle(ctx, frames = 30) {
  return new Promise((resolve) => {
    let n = frames;
    const step = () => { if (--n <= 0) resolve(); else requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });
}

/**
 * Instala `ctx.shot(name)` — chamado pelo Playwright.
 * Devolve metadados úteis para o relatório do crítico.
 */
export function installShots(ctx) {
  ctx.shots = SHOTS;
  ctx.shot = async (name) => {
    const s = SHOTS[name];
    if (!s) throw new Error('pose desconhecida: ' + name);
    // Congela o tempo para a captura ser reprodutível.
    const prevScale = ctx.time.scale;
    ctx.time.scale = 1;
    if (s.time !== undefined && ctx.sky?.setTimeOfDay) ctx.sky.setTimeOfDay(s.time);
    ctx.time.dayFraction = s.time ?? ctx.time.dayFraction;

    await s.pose(ctx);
    await settle(ctx, 45);           // LOD, imposters e nuvens convergirem

    ctx.time.scale = prevScale;
    return {
      shot: name,
      label: s.label,
      planet: ctx.planet?.current?.name || null,
      biome: ctx.planet?.current?.biome?.name || null,
      biomeClass: ctx.planet?.current?.biome?.class || null,
      radiusKm: ctx.planet?.current ? Math.round(ctx.planet.current.radius / 1000) : null,
      altitude: Number.isFinite(ctx.player.altitude) ? Math.round(ctx.player.altitude) : null,
      fps: Math.round(ctx.engine.stats.fps),
      drawCalls: ctx.engine.stats.drawCalls,
      triangles: ctx.engine.stats.triangles,
      seed: ctx.seed,
    };
  };
}
