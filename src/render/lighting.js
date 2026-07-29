import * as THREE from 'three';
import { CascadedShadows, SHADOW_LAYER } from './csm.js';

/**
 * Iluminação, PBR e sombras.
 *
 * ── O problema que este módulo resolve ───────────────────────────────────────
 * O item 7 do critério visual ("iluminação plana") é o que separa um render de
 * engine de um frame de No Man's Sky. Três coisas o resolvem, e as três estão
 * aqui:
 *
 *   1. SOMBRAS LONGAS E ESTÁVEIS  → `csm.js` (cascatas com snap de texel).
 *   2. LUZ DE REBOTE COLORIDA     → IBL gerado em runtime + HemisphereLight
 *      com a cor do CHÃO por baixo. Sombra nunca é preta: é a cor do solo
 *      lavada pela cor do céu. Sem isso o terreno vira recorte de papel.
 *   3. INTENSIDADES EM HDR        → o sol vale 8–20, não 1. O `postfx` faz o
 *      tone mapping; se o sol valer 1 aqui, o ACES devolve uma imagem cinza e
 *      o realce de nuvem/água some.
 *
 * ── Contrato com os outros módulos ───────────────────────────────────────────
 * Consome (tudo opcional, com optional chaining):
 *   ctx.sky.sunDirection / sunColor / sunIntensity
 *   ctx.planet.current.biome           (paleta e céu do bioma)
 *   ctx.player.up / inAtmosphere
 *   ctx.quality.shadows / shadowCascades
 * Publica `ctx.lighting`.
 *
 * Materiais: o dono do material chama `ctx.lighting.registerMaterial(mat)`.
 * Como vários módulos iniciam ANTES deste (order 35), também varremos a cena
 * periodicamente e registramos sozinhos qualquer material iluminado novo —
 * marque `mat.userData.noCsm = true` para ficar de fora.
 */

export const id = 'lighting';
export const order = 35;

// Escala HDR do sol ao meio-dia. Referência: o postfx aplica ACES, que mapeia
// ~11 para branco. Abaixo de ~8 o planeta perde o contraste de NMS.
const SUN_HDR = 14;

/** Bioma neutro usado no espaço profundo / antes do primeiro planeta. */
const FALLBACK_BIOME = {
  palette: { midland: 0x6e665c, lowland: 0x9a8f82 },
  sky: { zenith: 0x0a0c18, horizon: 0x1a2030, tint: 0x30405a, ambientTint: 0x40506a, sunTint: 0xffffff, density: 0.2 },
};

// ── Estado do módulo ─────────────────────────────────────────────────────────
let ctxRef = null;
let csm = null;
let sun = null;
let hemi = null;
let ambient = null;

let pmrem = null;
let cubeRT = null;
let cubeCam = null;
let envScene = null;
let envMat = null;
let envTarget = null;
let envFailed = false;

let currentBiome = null;
let envLastTime = -1e9;
let envLastSunX = 0, envLastSunY = 0, envLastSunZ = 0;
let materialsAuto = 0;
let syncTimer = 0;
let debugTimer = 0;
let qualityTimer = 0;
let qualityKey = '';

// Temporários — zero alocação nos caminhos quentes.
const sunDirWorld = new THREE.Vector3(0.3, 0.85, 0.42).normalize();
const tmpColorA = new THREE.Color();
const tmpColorB = new THREE.Color();
const tmpUp = new THREE.Vector3(0, 1, 0);

const registered = new Set();

// ── Utilidades ───────────────────────────────────────────────────────────────

function hexToColor(target, hex, fallback) {
  const v = Number.isFinite(hex) ? hex : fallback;
  // setHex converte de sRGB para o espaço linear de trabalho — obrigatório,
  // senão as cores do bioma saem lavadas depois do tone mapping.
  return target.setHex(v >>> 0, THREE.SRGBColorSpace);
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function smoothstep(a, b, x) { const t = clamp01((x - a) / (b - a || 1e-6)); return t * t * (3 - 2 * t); }

function activeBiome() {
  return ctxRef?.planet?.current?.biome || FALLBACK_BIOME;
}

function isLitMaterial(m) {
  if (!m) return false;
  return !!(m.isMeshStandardMaterial || m.isMeshPhysicalMaterial || m.isMeshPhongMaterial
    || m.isMeshLambertMaterial || m.isMeshToonMaterial || (m.isShaderMaterial && m.lights));
}

// ── Domo de ambiente (fonte do IBL) ──────────────────────────────────────────

/**
 * Um domo próprio, e não a `farScene`, porque o contrato §6 não diz em qual
 * cena o módulo `sky` põe o domo dele. Capturar a cena errada devolveria um
 * cubemap preto e o PBR ficaria morto — degradação silenciosa é pior que
 * aproximação. Aqui a fonte é sempre conhecida: gradiente do bioma + o sol e a
 * cor do céu que o `sky` publicar. É o mesmo resultado visual para IBL, que só
 * precisa das frequências baixas.
 */
function buildEnvScene() {
  envScene = new THREE.Scene();
  envMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    toneMapped: false,
    uniforms: {
      uZenith: { value: new THREE.Color(0.1, 0.2, 0.5) },
      uHorizon: { value: new THREE.Color(0.6, 0.5, 0.4) },
      uTint: { value: new THREE.Color(0.7, 0.6, 0.9) },
      uGround: { value: new THREE.Color(0.3, 0.3, 0.3) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uUp: { value: new THREE.Vector3(0, 1, 0) },
      uSunIntensity: { value: 1 },
      uSkyLevel: { value: 1 },
      uGroundBounce: { value: 0.35 },
    },
    vertexShader: [
      'varying vec3 vDir;',
      'void main() {',
      '  vDir = normalize( position );',
      '  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );',
      '}',
    ].join('\n'),
    fragmentShader: [
      'uniform vec3 uZenith, uHorizon, uTint, uGround, uSunColor, uSunDir, uUp;',
      'uniform float uSunIntensity, uSkyLevel, uGroundBounce;',
      'varying vec3 vDir;',
      'void main() {',
      '  vec3 d = normalize( vDir );',
      '  float h = dot( d, uUp );',
      '  vec3 sky = mix( uHorizon, uZenith, pow( clamp( h, 0.0, 1.0 ), 0.55 ) ) * uSkyLevel;',
      '  float sd = max( dot( d, uSunDir ), 0.0 );',
      // O halo tinge o céu ao redor do sol: é o que dá o "ar" colorido do NMS
      // e o que faz o specular do terreno herdar a cor da atmosfera.
      '  sky = mix( sky, uTint * uSkyLevel, pow( sd, 4.0 ) * 0.45 );',
      '  sky += uSunColor * ( pow( sd, 300.0 ) * uSunIntensity * 2.0 + pow( sd, 20.0 ) * uSunIntensity * 0.06 );',
      // Hemisfério inferior = albedo do solo devolvendo a luz do céu. É daqui
      // que sai o rebote colorido que impede sombras pretas e mortas.
      '  float below = clamp( -h * 3.0, 0.0, 1.0 );',
      '  vec3 ground = uGround * uGroundBounce * uSkyLevel;',
      '  gl_FragColor = vec4( mix( sky, ground, below ), 1.0 );',
      '}',
    ].join('\n'),
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), envMat);
  dome.frustumCulled = false;
  envScene.add(dome);
}

/**
 * Reamostra o IBL. Caro demais para rodar todo frame e barato demais para
 * merecer worker: 6 faces de 64 px de um único domo + PMREM.
 */
function updateEnvironment(force) {
  if (envFailed || !ctxRef) return;
  const t = ctxRef.time.elapsed;
  const dot = sunDirWorld.x * envLastSunX + sunDirWorld.y * envLastSunY + sunDirWorld.z * envLastSunZ;
  // cos(2°) ≈ 0,99939 — abaixo disso a sombra e o rebote já mudaram o bastante.
  const moved = dot < 0.99939;
  if (!force && !moved && t - envLastTime < 2.0) return;

  const biome = activeBiome();
  const sky = biome.sky || FALLBACK_BIOME.sky;
  const pal = biome.palette || FALLBACK_BIOME.palette;
  const u = envMat.uniforms;

  hexToColor(u.uZenith.value, sky.zenith, 0x0a0c18);
  hexToColor(u.uHorizon.value, sky.horizon, 0x1a2030);
  hexToColor(u.uTint.value, sky.tint, 0x30405a);
  hexToColor(u.uGround.value, pal.midland, 0x6e665c);
  u.uSunColor.value.copy(sun.color);
  u.uSunDir.value.copy(sunDirWorld);
  u.uUp.value.copy(tmpUp);
  u.uSunIntensity.value = sun.intensity;

  const elev = clamp01(sunDirWorld.dot(tmpUp));
  const density = Number.isFinite(sky.density) ? sky.density : 1;
  // O céu é fonte de luz proporcional ao sol: à noite o IBL some junto.
  u.uSkyLevel.value = (0.02 + 1.6 * Math.pow(elev, 0.55)) * clamp01(density * 0.9 + 0.2);
  u.uGroundBounce.value = 0.28 + 0.5 * elev;

  const r = ctxRef.engine.renderer;
  const prevAutoClear = r.autoClear;
  const prevTarget = r.getRenderTarget();
  try {
    // CubeCamera.update não limpa as faces sozinho e o engine roda com
    // autoClear = false; sem isto o cubemap acumula lixo do frame anterior.
    r.autoClear = true;
    cubeCam.update(r, envScene);
    envTarget = pmrem.fromCubemap(cubeRT.texture, envTarget);
    ctxRef.engine.scene.environment = envTarget.texture;
    ctxRef.engine.scene.environmentIntensity = 1.0;
  } catch (e) {
    // Sem IBL o jogo continua: hemi + ambient seguram a luz indireta.
    envFailed = true;
    ctxRef.debug.set('lighting.env', 'falhou');
  } finally {
    r.autoClear = prevAutoClear;
    r.setRenderTarget(prevTarget);
  }

  envLastTime = t;
  envLastSunX = sunDirWorld.x; envLastSunY = sunDirWorld.y; envLastSunZ = sunDirWorld.z;
}

// ── Registro de materiais ────────────────────────────────────────────────────

function registerMaterial(mat) {
  if (!mat || registered.has(mat)) return mat;
  if (mat.userData) mat.userData.noCsm = false;
  registered.add(mat);
  csm?.registerMaterial(mat);
  return mat;
}

function unregister(mat) {
  if (!mat || !registered.has(mat)) return;
  registered.delete(mat);
  csm?.unregister(mat);
  // Marca definitiva: sem isto a varredura de auto-registro devolveria o
  // material remendado na passada seguinte, ignorando a decisão do dono.
  if (mat.userData) mat.userData.noCsm = true;
}

/** Chamado pela varredura do CSM. Devolve true quando registrou algo novo. */
function autoRegister(mat) {
  if (!mat || registered.has(mat)) return false;
  if (mat.userData && mat.userData.noCsm) return false;
  if (!isLitMaterial(mat)) return false;
  registerMaterial(mat);
  materialsAuto++;
  return true;
}

// ── Qualidade ────────────────────────────────────────────────────────────────

function qualityConfig(q) {
  const preset = q?.preset || 'high';
  // 2048 por cascata acima de "medium": a 1024 um poste de 1 m a 200 m de
  // distância cai dentro de um texel e a sombra dele vira ruído.
  const tile = preset === 'low' ? 512 : preset === 'medium' ? 1024 : 2048;
  const taps = preset === 'low' ? 4 : preset === 'medium' ? 8 : 16;
  return {
    cascades: Math.max(1, Math.min(4, q?.shadowCascades || 3)),
    tile: q?.shadowMapSize || tile,
    taps,
    // Penumbra: 1 texel dá borda serrilhada de engine, ~1,8 lê como sombra
    // real. No preset baixo apertamos para compensar os 4 taps.
    pcf: preset === 'low' ? 1.0 : 1.8,
    enabled: q?.shadows !== false,
  };
}

function setQuality(override) {
  const cfg = qualityConfig({ ...(ctxRef?.quality || {}), ...(override || {}) });
  csm.enabled = cfg.enabled;
  csm.setQuality({ cascades: cfg.cascades, tile: cfg.tile, taps: cfg.taps, pcfTexels: cfg.pcf });
  if (!cfg.enabled) csm.setIntensity(0);
  qualityKey = `${cfg.enabled}|${cfg.cascades}|${cfg.tile}|${cfg.taps}`;
  return cfg;
}

// ── Ciclo de vida ────────────────────────────────────────────────────────────

export async function init(ctx) {
  ctxRef = ctx;
  const scene = ctx.engine.scene;

  // ── Sol ────────────────────────────────────────────────────────────────────
  // castShadow fica FALSO de propósito: as sombras são nossas (csm.js), não do
  // pipeline do three. Deixar ligado alocaria um shadow map inútil.
  sun = new THREE.DirectionalLight(0xfff0d8, SUN_HDR);
  sun.name = 'aetherSun';
  sun.castShadow = false;
  sun.position.copy(sunDirWorld).multiplyScalar(5000);
  sun.target.position.set(0, 0, 0);
  scene.add(sun);
  scene.add(sun.target);

  // ── Rebote do chão ─────────────────────────────────────────────────────────
  // Céu em cima, ALBEDO DO SOLO embaixo. Sem isto tudo que está na sombra vira
  // silhueta preta e o planeta parece recorte de papel.
  hemi = new THREE.HemisphereLight(0x8fb8ff, 0x6e665c, 0.6);
  hemi.name = 'aetherBounce';
  scene.add(hemi);

  // Piso mínimo: garante que o IBL falhando não deixe nada 100% preto.
  ambient = new THREE.AmbientLight(0x40506a, 0.06);
  ambient.name = 'aetherFloor';
  scene.add(ambient);

  // ── Sombras em cascata ─────────────────────────────────────────────────────
  // Passa a config já resolvida no construtor: assim o atlas é alocado uma vez
  // só, em vez de nascer no padrão e ser recriado no primeiro setQuality.
  const cfg0 = qualityConfig(ctx.quality);
  csm = new CascadedShadows(ctx, {
    shadowFar: 8000,
    cascades: cfg0.cascades, tile: cfg0.tile, taps: cfg0.taps, pcfTexels: cfg0.pcf,
  });
  csm.onMaterialSeen = autoRegister;
  setQuality();

  // ── IBL ────────────────────────────────────────────────────────────────────
  try {
    buildEnvScene();
    pmrem = new THREE.PMREMGenerator(ctx.engine.renderer);
    pmrem.compileCubemapShader();
    cubeRT = new THREE.WebGLCubeRenderTarget(64, {
      type: ctx.engine.hdrType || THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: false,
    });
    cubeRT.texture.name = 'aetherEnvCube';
    cubeCam = new THREE.CubeCamera(1, 1e5, cubeRT);
  } catch (e) {
    envFailed = true;
  }

  // Troca de planeta invalida o bioma: reamostra o IBL na hora.
  ctx.events.on('planet:approach', () => { currentBiome = null; });
  ctx.events.on('planet:land', () => { currentBiome = null; });
  ctx.events.on('system:enter', () => { currentBiome = null; });

  // Módulos com `order` maior ainda não existem no boot. Quando todos estiverem
  // de pé, remendamos TUDO de uma vez e recompilamos — assim o custo de
  // compilação cai no boot e não vira engasgo no primeiro frame jogado.
  ctx.events.on('boot:ready', () => {
    try {
      csm.syncScene(ctx.engine.scene, Number.MAX_SAFE_INTEGER);
      ctx.engine.syncCameras();
      ctx.engine.renderer.compile(ctx.engine.scene, ctx.engine.camera);
    } catch (e) { /* pré-compilação é otimização: falhar aqui não quebra nada */ }
  });

  // Primeira passada: quem já criou material antes de nós entra agora.
  refreshSun();
  csm.syncScene(scene, 64);
  updateEnvironment(true);

  ctx.provide(id, {
    sun, hemi, ambient,
    csm,
    shadowLayer: SHADOW_LAYER,
    /** Direção do mundo APONTANDO PARA o sol (unitária). */
    sunDirection: sunDirWorld,
    registerMaterial,
    unregister,
    setQuality,
    updateEnvironment,
    get environment() { return envTarget ? envTarget.texture : null; },
    get materialCount() { return registered.size; },
    get splits() { return csm.splits; },
  });

  ctx.progress(0.4, 'iluminação e sombras…');
}

/** Recalcula direção, cor e intensidade do sol a partir do `sky` ou do bioma. */
function refreshSun() {
  const ctx = ctxRef;
  const biome = activeBiome();
  const sky = biome.sky || FALLBACK_BIOME.sky;

  // Direção: preferimos o `sky`; senão, um sol fixo alto o bastante para o
  // planeta nunca ficar em breu total.
  const sd = ctx.sky?.sunDirection;
  if (sd && Number.isFinite(sd.x) && (sd.x || sd.y || sd.z)) {
    sunDirWorld.set(sd.x, sd.y, sd.z).normalize();
  }

  // "Up" local do jogador define o que é horizonte para a luz de rebote.
  if (ctx.player?.up && Number.isFinite(ctx.player.up.y)) tmpUp.copy(ctx.player.up).normalize();
  const elev = sunDirWorld.dot(tmpUp);
  const day = clamp01(elev);

  // Cor: do `sky` quando existir (ele já sabe do espalhamento), senão o tom
  // solar do bioma esquentado perto do horizonte.
  const sc = ctx.sky?.sunColor;
  if (sc && Number.isFinite(sc.r)) {
    sun.color.copy(sc);
  } else {
    hexToColor(sun.color, sky.sunTint, 0xfff0d8);
    // Avermelha no nascer/pôr: perda de azul por espalhamento Rayleigh.
    const warm = 1 - smoothstep(0.02, 0.35, elev);
    sun.color.r *= 1 + 0.10 * warm;
    sun.color.g *= 1 - 0.18 * warm;
    sun.color.b *= 1 - 0.45 * warm;
  }

  // Intensidade em HDR. O contrato não fixa a escala de `sky.sunIntensity`:
  // valores >= 4 são tratados como absolutos (o sky já trabalha em HDR),
  // valores menores como multiplicador do nosso valor base.
  const si = ctx.sky?.sunIntensity;
  let inten;
  if (Number.isFinite(si) && si > 0) inten = si >= 4 ? Math.min(si, 40) : SUN_HDR * si;
  else inten = SUN_HDR * smoothstep(-0.10, 0.12, elev);
  sun.intensity = inten;

  // Posição relativa à origem flutuante: a luz é direcional, só a direção
  // conta, então 5 km à frente é longe o bastante e nunca perde precisão.
  sun.position.copy(sunDirWorld).multiplyScalar(5000);

  // ── Rebote ─────────────────────────────────────────────────────────────────
  const pal = biome.palette || FALLBACK_BIOME.palette;
  hexToColor(tmpColorA, sky.zenith, 0x0a0c18);
  hexToColor(tmpColorB, pal.midland, 0x6e665c);
  hemi.color.copy(tmpColorA);
  hemi.groundColor.copy(tmpColorB);

  const density = Number.isFinite(sky.density) ? sky.density : 1;
  const inAtmo = ctx.player?.inAtmosphere !== false;
  // Proporcional ao cosseno do sol: o rebote é luz solar reciclada pelo chão.
  const bounce = (0.10 + 1.35 * Math.pow(day, 0.55)) * clamp01(0.25 + density * 0.85);
  hemi.intensity = bounce * (inAtmo ? 1 : 0.18);

  hexToColor(ambient.color, sky.ambientTint, 0x40506a);
  ambient.intensity = (0.02 + 0.09 * day) * (inAtmo ? 1 : 0.25);

  // Sombra só faz sentido com o sol acima do horizonte; abaixo dele o termo
  // vai a zero e o shader sai no primeiro `if` sem tocar em textura.
  const shadowStrength = smoothstep(0.0, 0.09, elev);
  csm.setIntensity(csm.enabled ? shadowStrength : 0);
}

export function update(dt, ctx) {
  if (!csm) return;
  refreshSun();

  // Bioma novo → IBL na hora (a cor do rebote muda por completo).
  const biome = activeBiome();
  if (biome !== currentBiome) {
    currentBiome = biome;
    updateEnvironment(true);
  } else {
    updateEnvironment(false);
  }

  // O `perf` mexe em ctx.quality direto; detectamos sem precisar de evento.
  qualityTimer += dt;
  if (qualityTimer > 0.5) {
    qualityTimer = 0;
    const cfg = qualityConfig(ctx.quality);
    const key = `${cfg.enabled}|${cfg.cascades}|${cfg.tile}|${cfg.taps}`;
    if (key !== qualityKey) setQuality();
  }
}

export function lateUpdate(dt, ctx) {
  if (!csm) return;
  const scene = ctx.engine.scene;
  const camera = ctx.engine.camera;

  // Varredura amortizada: mantém a camada de projetores em dia e recolhe
  // materiais novos. O teto de 2 por passada existe porque cada registro força
  // uma recompilação de shader (~10 ms) — 2 a cada 0,25 s cabe no orçamento.
  syncTimer += dt;
  if (syncTimer > 0.25) {
    syncTimer = 0;
    csm.syncScene(scene, 2);
  }

  if (csm.enabled && csm.uniforms.uCsmIntensity.value > 0.001) {
    csm.update(camera, sunDirWorld);
    csm.render(scene, camera);
  }

  debugTimer += dt;
  if (debugTimer > 0.25) {
    debugTimer = 0;
    ctx.debug.set('lighting.materials', `${registered.size} (auto ${materialsAuto})`);
    ctx.debug.set('lighting.cascades', `${csm.cascades} @ ${csm.tile}px  ${csm.taps} taps`);
    ctx.debug.set('lighting.splits', `${camera.near.toFixed(2)}|${csm.splitsLabel} m`);
    ctx.debug.set('lighting.sun', `${sun.intensity.toFixed(1)} HDR  elev ${(Math.asin(clamp01(sunDirWorld.dot(tmpUp)) ) * 57.29578).toFixed(0)}°`);
    ctx.debug.set('lighting.bounce', `hemi ${hemi.intensity.toFixed(2)}  amb ${ambient.intensity.toFixed(2)}`);
    if (!envFailed) ctx.debug.set('lighting.env', `${(ctx.time.elapsed - envLastTime).toFixed(1)}s atrás`);
  }
}

export function resize() {
  // Os raios das cascatas dependem de fov/aspect; o CSM detecta sozinho na
  // próxima chamada de update(). Nada a fazer aqui.
}

export function dispose(ctx) {
  csm?.dispose();
  if (envTarget) envTarget.dispose();
  cubeRT?.dispose();
  pmrem?.dispose();
  envMat?.dispose();
  if (envScene) {
    envScene.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    envScene.clear();
  }
  const scene = ctx?.engine?.scene;
  if (scene) {
    if (sun) { scene.remove(sun); scene.remove(sun.target); }
    if (hemi) scene.remove(hemi);
    if (ambient) scene.remove(ambient);
    scene.environment = null;
  }
  registered.clear();
  csm = null;
}
