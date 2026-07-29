import * as THREE from 'three';
import {
  FullScreenQuad, createTarget, resizeTarget,
  makeConstTexture, makeProbeTexture,
} from './passes/common.js';
import { CopyPass } from './passes/copy.js';
import { SsaoPass } from './passes/ssao.js';
import { GodraysPass } from './passes/godrays.js';
import { BloomPass } from './passes/bloom.js';
import { MotionBlurPass } from './passes/motionblur.js';
import { CompositePass } from './passes/composite.js';
import { FxaaPass } from './passes/fxaa.js';
import { GpuProfiler } from './passes/profiler.js';

/**
 * PIPELINE HDR E PÓS-PROCESSAMENTO — módulo `postfx` (order 90).
 *
 * Cadeia escrita à mão sobre WebGLRenderTargets, sem EffectComposer, porque
 * precisamos de três coisas que o composer não dá: resolução independente por
 * passe (AO/godrays/bloom em meia resolução ou menos), reordenação e
 * ligar/desligar passes em runtime sem realocar nada, e um orçamento medido por
 * passe que o módulo `perf` possa consultar.
 *
 * Ordem por frame:
 *   0. cópia da cena (opcional, para a refração da água)
 *   1. engine.renderToTarget(sceneTarget)      HDR linear + depthTexture
 *   2. SSAO/HBAO em 1/2 resolução, raio em metros, blur bilateral
 *   3. godrays volumétricos em 1/2 resolução, mascarados pela profundidade
 *   4. bloom seletivo, pirâmide de 5 níveis (13-tap ↓ / tenda ↑)
 *   5. motion blur de câmera por reprojeção do depth
 *   6. composição: AO × cena, + bloom, + godrays, aberração cromática,
 *      vinheta, ACES (ajuste de Stephen Hill), grão, sRGB
 *   7. FXAA 3.11 de qualidade
 *   8. engine.renderOverlay()   (cockpit)
 *
 * REGRA DE SOBREVIVÊNCIA: nada aqui pode lançar para fora nem deixar a tela
 * preta. Todo caminho tem fallback, e o último fallback é desenhar o
 * sceneTarget cru na tela.
 */

export const id = 'postfx';
export const order = 90;

/** Estado do módulo. Um único objeto para o dispose ser trivial. */
let S = null;

// ── Temporários de escopo de módulo (zero alocação por frame) ────────────────
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector4();
const _sunUV = new THREE.Vector2(0.5, 0.5);
const _sunColor = new THREE.Color(1, 0.96, 0.88);
const _viewProj = new THREE.Matrix4();
const _shift = new THREE.Matrix4();
const _prevCamPos = new THREE.Vector3();
const _prevCamQuat = new THREE.Quaternion();
const _camPos = new THREE.Vector3();
const _camQuat = new THREE.Quaternion();
const _camScale = new THREE.Vector3();

function defaultParams() {
  return {
    /** Chave mestra: false devolve uma cópia tonemapeada simples. */
    enabled: true,
    exposure: 1.0,

    ssao: {
      enabled: true,
      radius: 1.2,          // METROS — oclusão de contato do tamanho de uma pedra
      intensity: 1.0,       // ganho dentro do integrador
      strength: 0.85,       // quanto disso chega à imagem final
      bias: 0.12,           // corta auto-oclusão de superfície plana
      dirs: 4,
      steps: 4,
      blur: 1,
      blurSharpness: 45,
      maxRadiusUV: 0.09,
      directCut: [0.9, 3.0],
    },

    godrays: {
      enabled: true,
      samples: 32,
      density: 0.92,
      decay: 0.955,
      weight: 0.42,
      exposure: 0.22,
      threshold: 0.9,
      diskSize: 0.035,
      diskGain: 3.0,
      intensity: 1.0,
    },

    bloom: {
      enabled: true,
      threshold: 1.1,       // em HDR, não em LDR
      knee: 0.6,
      intensity: 0.28,
      radius: 1.4,
      levels: 5,
      clamp: 24,
    },

    motionBlur: {
      enabled: true,
      shutter: 0.5,         // fração do frame com o obturador aberto
      maxPixels: 28,
      taps: 9,
    },

    chromatic: { enabled: true, maxPixels: 1.5 },
    vignette: { enabled: true, amount: 0.42, softness: 0.55 },
    // Amplitude em espaço de exibição: 0.02 ≈ 5/255, e até ~13/255 na sombra
    // profunda. Acima disso o "grão de filme" vira chuvisco de TV analógica.
    grain: { enabled: true, amount: 0.02, shadowBoost: 2.5 },
    grade: { saturation: 1.06, contrast: 1.0 },
    aa: { enabled: true, mode: 'fxaa', subpixel: 0.75, edgeThreshold: 0.125, edgeThresholdMin: 0.0312 },

    /** Custo por passe. Só age com o overlay de debug aberto (ctx.debug.enabled),
     *  porque queries de tempo sincronizam o driver em alguns fabricantes. */
    profile: true,
  };
}

export async function init(ctx) {
  const engine = ctx.engine;
  const renderer = engine.renderer;
  const hdrType = engine.hdrType || THREE.HalfFloatType;

  // Uniformes de profundidade COMPARTILHADOS entre os passes: assim eles são
  // escritos uma vez por frame em vez de uma vez por material.
  const depthU = {
    tDepth: { value: engine.sceneTarget.depthTexture || null },
    uLogFC: { value: 0 },
    uNearFar: { value: new THREE.Vector2(0.05, 8e6) },
    uProjRay: { value: new THREE.Vector2(1, 1) },
    uFarCut: { value: 7.2e6 },
  };

  S = {
    ctx,
    renderer,
    engine,
    hdrType,
    /** true quando não há float renderizável: o HDR vira 8 bits e o limiar cai. */
    hdrLimited: hdrType === THREE.UnsignedByteType,
    quad: new FullScreenQuad(),
    depthU,
    params: defaultParams(),

    neutralWhite: makeConstTexture(1, 1, 1, 1),
    neutralBlack: makeConstTexture(0, 0, 0, 1),

    copy: new CopyPass(),
    ssao: new SsaoPass(depthU),
    godrays: new GodraysPass(depthU, hdrType),
    bloom: new BloomPass(hdrType),
    motionBlur: new MotionBlurPass(depthU, hdrType),
    composite: null,
    fxaa: new FxaaPass(),
    profiler: new GpuProfiler(renderer),

    /** Alvo LDR intermediário: entrada do FXAA (que precisa de espaço de gama). */
    ldrTarget: createTarget(1, 1, { type: THREE.UnsignedByteType, name: 'postfx/ldr' }),
    sceneCopyTarget: null,
    sceneCopyWanted: false,
    sceneCopyFrame: -1,

    width: 0, height: 0,

    /** Passes reprovados no auto-teste — nunca mais são executados. */
    broken: { copy: false, ssao: false, godrays: false, bloom: false, motionBlur: false, fxaa: false, composite: false },

    prevViewProj: new THREE.Matrix4(),
    prevValid: false,
    moving: false,

    errors: 0,
    degraded: false,
    lastMs: 0,
    debugTick: 0,
    unsubRebase: null,
  };

  S.composite = new CompositePass(S.neutralWhite, S.neutralBlack);

  if (S.hdrLimited) {
    // Sem float renderizável o sceneTarget satura em 1.0; um limiar de 1.1
    // nunca seria atingido e o bloom simplesmente sumiria.
    S.params.bloom.threshold = 0.72;
    S.params.bloom.clamp = 1.0;
  }

  _syncSize(true);

  // Rebase da origem flutuante: a matriz de view-projection do frame anterior
  // foi construída num referencial que acabou de se mover. Compensar é uma
  // multiplicação por translação; não compensar produz um borrão de quilômetros.
  S.unsubRebase = ctx.events.on('frame:rebase', (payload) => {
    const s = payload && payload.shift;
    if (!s) { S.prevValid = false; return; }
    const mag = Math.abs(s.x) + Math.abs(s.y) + Math.abs(s.z);
    if (!Number.isFinite(mag) || mag > 5e4) {
      // Teleporte/warp: o salto não cabe em float32. Um frame sem borrão é
      // invisível; um frame com borrão errado é um flash na tela.
      S.prevValid = false;
      return;
    }
    _shift.makeTranslation(s.x, s.y, s.z);
    S.prevViewProj.multiply(_shift);
    _prevCamPos.x -= s.x; _prevCamPos.y -= s.y; _prevCamPos.z -= s.z;
  });

  // Auto-teste: compila tudo e verifica que cada passe produz pixel não-preto.
  // Serve de duas coisas — desarma passes quebrados ANTES do primeiro frame e
  // aquece os shaders, evitando o engasgo de compilação no frame 1.
  try { _selfTest(); } catch (e) { /* o auto-teste nunca pode derrubar o boot */ }

  const api = {
    render,
    resize,
    dispose: () => dispose(ctx),

    /** Contrato §6. */
    setEnabled,
    setParam,
    get params() { return S ? S.params : null; },

    /** Diagnóstico para o módulo `perf`. */
    get stats() { return S ? { ms: S.lastMs, degraded: S.degraded, broken: S.broken } : null; },
    /** Custo por passe em ms de GPU (vazio se o profiler estiver desligado). */
    get timings() { return S ? S.profiler.ms : null; },

    /** Mapa de oclusão em meia resolução — o módulo `lighting` pode usá-lo
     *  diretamente na luz indireta, que é onde a AO realmente pertence. */
    get aoTexture() { return S && !S.broken.ssao ? S.ssao.targetA.texture : null; },

    requestSceneCopy,
    releaseSceneCopy,
    get sceneCopyTexture() { return S && S.sceneCopyTarget ? S.sceneCopyTarget.texture : null; },
  };

  ctx.provide(id, api);
  ctx.progress?.(0.93, 'pós-processamento pronto');
}

// ── Tamanho ─────────────────────────────────────────────────────────────────

/**
 * Todos os alvos derivam do sceneTarget, e NÃO do tamanho da janela.
 * Motivo: `engine.setRenderScale()` (usado pelo `perf` para segurar o frame
 * rate) redimensiona o sceneTarget sem disparar `resize`. Ler o tamanho da
 * fonte a cada frame custa duas comparações e elimina a classe inteira de bugs
 * de alvo dessincronizado — que aqui aparece como lixo na tela.
 */
function _syncSize(force) {
  const st = S.engine.sceneTarget;
  const w = Math.max(1, st.width | 0);
  const h = Math.max(1, st.height | 0);
  if (!force && w === S.width && h === S.height) return;
  S.width = w; S.height = h;

  resizeTarget(S.ldrTarget, w, h);
  if (S.sceneCopyTarget) resizeTarget(S.sceneCopyTarget, w, h);
  S.ssao.setSize(w, h);
  S.godrays.setSize(w, h);
  S.bloom.setSize(w, h);
  S.motionBlur.setSize(w, h);
  S.composite.setSize(w, h);
  S.fxaa.setSize(w, h);

  // Reprojeção antiga vale para a resolução antiga; descarta.
  S.prevValid = false;
}

export function resize() {
  if (!S) return;
  _syncSize(false);
}

// ── API pública ─────────────────────────────────────────────────────────────

/**
 * setEnabled('bloom', false) etc.
 * Nomes: postfx (mestre), ssao, godrays, bloom, motionBlur, chromatic,
 * vignette, grain, aa, profile.
 */
export function setEnabled(name, on) {
  if (!S) return false;
  const p = S.params;
  const v = !!on;
  if (name === 'postfx' || name === 'all') { p.enabled = v; return true; }
  if (name === 'profile') { p.profile = v; return true; }
  const g = p[name];
  if (g && typeof g === 'object' && 'enabled' in g) { g.enabled = v; return true; }
  return false;
}

/**
 * setParam('bloom', 'threshold', 1.4) — ou setParam('exposure', 1.2) para os
 * escalares de topo.
 */
export function setParam(name, key, value) {
  if (!S) return false;
  const p = S.params;
  const g = p[name];
  if (g && typeof g === 'object') {
    if (!(key in g)) return false;
    g[key] = value;
    return true;
  }
  if (name in p) { p[name] = key; return true; }
  return false;
}

/**
 * Textura com a cor da cena para refração (o módulo `water` pede isto).
 *
 * ATENÇÃO ao contrato: a cópia é tirada no INÍCIO do frame, antes do
 * `renderToTarget` sobrescrever o alvo — ou seja, ela contém o frame ANTERIOR
 * já completo. Um frame de atraso é imperceptível em água, e é o único ponto do
 * pipeline em que existe uma imagem da cena sem a água do frame corrente
 * desenhada por cima da geometria que está sendo refratada. Quem consome deve
 * misturar por Fresnel (peso < 1), o que também amortece qualquer realimentação.
 */
export function requestSceneCopy() {
  if (!S) return null;
  if (!S.sceneCopyTarget) {
    S.sceneCopyTarget = createTarget(S.width, S.height, { type: S.hdrType, name: 'postfx/sceneCopy' });
    // Limpa uma vez: o primeiro frame leria lixo do driver.
    try {
      S.renderer.setRenderTarget(S.sceneCopyTarget);
      S.renderer.clear(true, false, false);
      S.renderer.setRenderTarget(null);
    } catch (e) { /* sem consequência */ }
  }
  S.sceneCopyWanted = true;
  return S.sceneCopyTarget.texture;
}

export function releaseSceneCopy() {
  if (!S) return;
  S.sceneCopyWanted = false;
}

// ── Render ──────────────────────────────────────────────────────────────────

function qualityOn(ctx, key) {
  const q = ctx.quality;
  if (!q) return true;
  const v = q[key];
  return v === undefined ? true : !!v;
}

export function render(ctx) {
  if (!S) {
    // Módulo morto: não pode custar a imagem ao jogador.
    try { ctx.engine.renderToTarget(null); ctx.engine.renderOverlay(); } catch (e) { /* nada a fazer */ }
    return;
  }

  const t0 = performance.now();
  try {
    if (S.degraded || !S.params.enabled) _renderFallback(ctx);
    else _renderChain(ctx);
  } catch (err) {
    S.errors++;
    if (S.errors >= 8 && !S.degraded) {
      S.degraded = true;
      ctx.debug?.set?.('postfx.error', 'cadeia desativada após 8 falhas: ' + (err && err.message));
    }
    // Segunda linha: cópia tonemapeada. Terceira: cena direta na tela.
    try { _renderFallback(ctx); }
    catch (e2) {
      try { ctx.engine.renderToTarget(null); } catch (e3) { /* fim da linha */ }
    }
  }

  try { ctx.engine.renderOverlay(); } catch (e) { /* overlay não derruba o frame */ }

  const ms = performance.now() - t0;
  S.lastMs += (ms - S.lastMs) * 0.1;
  try { S.profiler.poll(); _publishDebug(ctx); } catch (e) { /* telemetria é opcional */ }
}

/** Caminho de emergência: cena → ACES → sRGB → tela. Nunca fica preto. */
function _renderFallback(ctx) {
  const engine = ctx.engine;
  if (S.broken.copy && !S.copy.ok.plain) {
    // Nem o blit trivial compila (driver em frangalhos). Desenhar direto no
    // framebuffer perde o tone map, mas o jogador continua enxergando o mundo.
    engine.renderToTarget(null);
    return;
  }
  engine.renderToTarget(engine.sceneTarget);
  S.copy.present(S.renderer, S.quad, engine.sceneTarget.texture, S.params.exposure);
}

function _renderChain(ctx) {
  const engine = ctx.engine;
  const renderer = S.renderer;
  const cam = engine.camera;
  const P = S.params;
  const prof = S.profiler;

  prof.setEnabled(P.profile && !!ctx.debug?.enabled);
  _syncSize(false);

  // ── 0. Cópia da cena (frame anterior) para quem precisa de refração ───────
  if (S.sceneCopyWanted && S.sceneCopyTarget) {
    S.copy.blit(renderer, S.quad, engine.sceneTarget.texture, S.sceneCopyTarget);
    S.sceneCopyFrame = ctx.time ? ctx.time.frames : 0;
  }

  // ── 1. Cena HDR ───────────────────────────────────────────────────────────
  prof.begin('scene');
  engine.renderToTarget(engine.sceneTarget);
  prof.end();
  _syncSize(false);   // renderToTarget pode ter provocado uma realocação

  // ── Uniformes de profundidade, uma vez por frame ──────────────────────────
  const depthTex = engine.sceneTarget.depthTexture || null;
  S.depthU.tDepth.value = depthTex;
  const far = cam.far, near = cam.near;
  S.depthU.uNearFar.value.set(near, far);
  // O engine liga logarithmicDepthBuffer; se algum dia isso mudar, o caminho
  // linear continua correto.
  const useLog = !!renderer.capabilities.logarithmicDepthBuffer;
  S.depthU.uLogFC.value = useLog ? Math.log2(far + 1.0) : 0;
  S.depthU.uFarCut.value = far * 0.9;
  const tanHalf = Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5);
  S.depthU.uProjRay.value.set(tanHalf * cam.aspect, tanHalf);

  const hasDepth = !!depthTex;

  // ── 2. SSAO ───────────────────────────────────────────────────────────────
  let aoTex = S.neutralWhite;
  let aoStrength = 0;
  const useSsao = hasDepth && P.ssao.enabled && !S.broken.ssao && qualityOn(ctx, 'ssao');
  if (useSsao) {
    prof.begin('ssao');
    aoTex = S.ssao.render(renderer, S.quad, P.ssao);
    prof.end();
    aoStrength = P.ssao.strength;
  }

  // ── 3. Godrays ────────────────────────────────────────────────────────────
  let grTex = S.neutralBlack;
  let grStrength = 0;
  const useGodrays = hasDepth && P.godrays.enabled && !S.broken.godrays && qualityOn(ctx, 'godrays');
  if (useGodrays) {
    const fade = _projectSun(ctx, cam);
    if (fade > 0.002) {
      prof.begin('godrays');
      grTex = S.godrays.render(renderer, S.quad, engine.sceneTarget.texture, _sunUV, _sunColor, fade, P.godrays);
      prof.end();
      grStrength = P.godrays.intensity;
    }
  }

  // ── 4. Bloom ──────────────────────────────────────────────────────────────
  let bloomTex = S.neutralBlack;
  let bloomStrength = 0;
  if (P.bloom.enabled && !S.broken.bloom) {
    prof.begin('bloom');
    bloomTex = S.bloom.render(renderer, S.quad, engine.sceneTarget.texture, P.bloom);
    prof.end();
    bloomStrength = P.bloom.intensity;
  }

  // ── 5. Motion blur ────────────────────────────────────────────────────────
  let sceneTex = engine.sceneTarget.texture;
  const useMb = hasDepth && P.motionBlur.enabled && !S.broken.motionBlur
    && qualityOn(ctx, 'motionBlur') && S.prevValid && _cameraMoved(cam);
  if (useMb) {
    prof.begin('motionBlur');
    sceneTex = S.motionBlur.render(renderer, S.quad, sceneTex, cam.matrixWorld, S.prevViewProj, P.motionBlur);
    prof.end();
  }

  // ── 6. Composição ─────────────────────────────────────────────────────────
  const cu = S.composite.mat.uniforms;
  cu.tScene.value = sceneTex;
  cu.tBloom.value = bloomTex;
  cu.tGodrays.value = grTex;
  cu.tAO.value = aoTex;
  cu.uExposure.value = P.exposure;
  cu.uBloom.value = bloomStrength;
  cu.uGodrays.value = grStrength;
  cu.uAO.value = aoStrength;
  cu.uAOCut.value.fromArray(P.ssao.directCut);
  cu.uCA.value = P.chromatic.enabled ? P.chromatic.maxPixels : 0;
  cu.uVignette.value.set(P.vignette.enabled ? P.vignette.amount : 0, P.vignette.softness);
  cu.uGrain.value.set(P.grain.enabled ? P.grain.amount : 0, P.grain.shadowBoost);
  // Semente pequena e inteira: hashes em float32 perdem precisão com números
  // grandes e o grão "congela" depois de alguns minutos de sessão.
  cu.uTime.value = (ctx.time ? ctx.time.frames : 0) % 64;
  cu.uSaturation.value = P.grade.saturation;
  cu.uContrast.value = P.grade.contrast;

  const useAA = P.aa.enabled && !S.broken.fxaa;
  prof.begin('composite');
  S.composite.render(renderer, S.quad, useAA ? S.ldrTarget : null);
  prof.end();

  // ── 7. Antialias, por último e em espaço de gama ──────────────────────────
  if (useAA) {
    prof.begin('fxaa');
    S.fxaa.render(renderer, S.quad, S.ldrTarget.texture, null, P.aa);
    prof.end();
  }

  // ── Guarda o estado de reprojeção para o próximo frame ────────────────────
  _viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  S.prevViewProj.copy(_viewProj);
  cam.matrixWorld.decompose(_camPos, _camQuat, _camScale);
  _prevCamPos.copy(_camPos);
  _prevCamQuat.copy(_camQuat);
  S.prevValid = true;
}

/**
 * Projeta o sol (direção no infinito) para UV de tela.
 * @returns {number} 0 quando está atrás da câmera ou longe do quadro.
 */
function _projectSun(ctx, cam) {
  const dir = ctx.sky && ctx.sky.sunDirection;
  if (!dir) return 0;
  if (ctx.sky.sunColor) _sunColor.copy(ctx.sky.sunColor);

  // Direção → espaço de olho. Como é direção (w=0), a projeção continua exata
  // sem precisar inventar uma distância para o sol.
  _v3.copy(dir).transformDirection(cam.matrixWorldInverse);
  if (!(_v3.z < -1e-5)) return 0;                 // atrás da câmera
  _v4.set(_v3.x, _v3.y, _v3.z, 0).applyMatrix4(cam.projectionMatrix);
  if (!(Math.abs(_v4.w) > 1e-8)) return 0;
  const x = _v4.x / _v4.w, y = _v4.y / _v4.w;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
  _sunUV.set(x * 0.5 + 0.5, y * 0.5 + 0.5);

  // Desvanece fora do quadro: cortar de repente faz os raios piscarem quando o
  // sol atravessa a borda da tela.
  const dx = Math.max(0, Math.abs(_sunUV.x - 0.5) - 0.5);
  const dy = Math.max(0, Math.abs(_sunUV.y - 0.5) - 0.5);
  const d = Math.sqrt(dx * dx + dy * dy);
  return Math.max(0, Math.min(1, 1 - d / 0.35));
}

/**
 * O borrão só é calculado se a câmera realmente mexeu. Numa captura estática
 * (o arnês de screenshots congela o tempo) isso economiza um passe inteiro e,
 * mais importante, evita amolecer a imagem que o crítico vai avaliar.
 */
function _cameraMoved(cam) {
  cam.matrixWorld.decompose(_camPos, _camQuat, _camScale);
  const dp = _camPos.distanceToSquared(_prevCamPos);
  const dq = 1 - Math.abs(_camQuat.dot(_prevCamQuat));
  S.moving = dp > 2.5e-5 || dq > 2e-8;
  return S.moving;
}

// ── Auto-teste ──────────────────────────────────────────────────────────────

/**
 * Renderiza cada material num alvo 8x8 e confere que sai pixel não-preto.
 *
 * Um shader que não linka no three não lança exceção — ele só imprime no
 * console e desenha nada. Sem esta checagem, um erro de GLSL num único passe
 * apagaria a tela inteira e o jogo pareceria travado. Aqui o passe reprovado é
 * marcado e simplesmente não entra na cadeia.
 */
function _selfTest() {
  const renderer = S.renderer;
  const rt = createTarget(8, 8, { type: THREE.UnsignedByteType, filter: THREE.NearestFilter, name: 'postfx/probe' });
  const buf = new Uint8Array(8 * 8 * 4);
  const probeColor = makeProbeTexture(4);      // HDR: passa do limiar do bloom
  const probeNear = makeProbeTexture(0.02);    // depth "perto"
  const probeFar = makeProbeTexture(1.0);      // depth "céu"

  // Estado do renderer restaurado ao final — ele é compartilhado.
  const oldClear = new THREE.Color();
  renderer.getClearColor(oldClear);
  const oldAlpha = renderer.getClearAlpha();
  const oldTarget = renderer.getRenderTarget();

  // Valores plausíveis para os uniformes compartilhados durante o teste.
  const cam = S.engine.camera;
  S.depthU.uNearFar.value.set(cam.near, cam.far);
  S.depthU.uLogFC.value = renderer.capabilities.logarithmicDepthBuffer ? Math.log2(cam.far + 1) : 0;
  S.depthU.uFarCut.value = cam.far * 0.9;
  const tanHalf = Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5);
  S.depthU.uProjRay.value.set(tanHalf * cam.aspect, tanHalf);

  const groups = [
    ['copy', S.copy, 'near'],
    ['ssao', S.ssao, 'near'],
    ['godrays', S.godrays, 'far'],
    ['bloom', S.bloom, 'near'],
    ['motionBlur', S.motionBlur, 'near'],
    ['composite', S.composite, 'near'],
    ['fxaa', S.fxaa, 'near'],
  ];

  // Uniformes que são amostradores. Testar por `value.isTexture` não basta:
  // no boot alguns ainda estão em null e ficariam sem sonda, lendo a textura
  // padrão do driver e reprovando um passe que está perfeito.
  const SAMPLERS = ['tDepth', 'tScene', 'tDiffuse', 'tSrc', 'tAO', 'tBloom', 'tGodrays', 'tOcclusion'];

  for (const [name, pass, depthMode] of groups) {
    let groupOk = true;
    for (const entry of pass.materials()) {
      const mat = entry.material;
      const saved = [];
      for (let i = 0; i < SAMPLERS.length; i++) {
        const key = SAMPLERS[i];
        const u = mat.uniforms[key];
        if (!u) continue;
        saved.push([u, u.value]);
        u.value = key === 'tDepth'
          ? (depthMode === 'far' ? probeFar : probeNear)
          : probeColor;
      }

      renderer.setClearColor(0x000000, 1);
      renderer.setRenderTarget(rt);
      renderer.clear(true, false, false);
      S.quad.render(renderer, mat, rt);
      renderer.readRenderTargetPixels(rt, 0, 0, 8, 8, buf);

      let sum = 0;
      for (let i = 0; i < buf.length; i += 4) sum += buf[i] + buf[i + 1] + buf[i + 2];
      for (let i = 0; i < saved.length; i++) saved[i][0].value = saved[i][1];

      if (sum === 0) {
        groupOk = false;
        if (pass.ok && entry.key in pass.ok) pass.ok[entry.key] = false;
      }
    }
    if (!groupOk) {
      if (name in S.broken) S.broken[name] = true;
      if (name === 'composite') S.degraded = true;
    }
  }

  renderer.setRenderTarget(oldTarget);
  renderer.setClearColor(oldClear, oldAlpha);
  rt.dispose();
  probeColor.dispose();
  probeNear.dispose();
  probeFar.dispose();
}

// ── Telemetria ──────────────────────────────────────────────────────────────

function _publishDebug(ctx) {
  if (!ctx.debug || !ctx.debug.enabled) return;
  // Só a cada 15 frames: montar strings todo frame é lixo para o GC.
  if ((S.debugTick++ % 15) !== 0) return;

  const P = S.params;
  ctx.debug.set('postfx', `${S.width}x${S.height} ${S.hdrLimited ? 'LDR!' : 'HDR'} `
    + `cpu ${S.lastMs.toFixed(2)}ms`
    + (S.degraded ? ' [DEGRADADO]' : ''));
  ctx.debug.set('postfx.passes',
    `ssao:${P.ssao.enabled && qualityOn(ctx, 'ssao') ? 1 : 0}`
    + ` gr:${P.godrays.enabled && qualityOn(ctx, 'godrays') ? 1 : 0}`
    + ` bloom:${P.bloom.enabled ? 1 : 0}`
    + ` mb:${S.moving && P.motionBlur.enabled && qualityOn(ctx, 'motionBlur') ? 1 : 0}`
    + ` aa:${P.aa.enabled ? 1 : 0}`);

  const brokenList = [];
  for (const k in S.broken) if (S.broken[k]) brokenList.push(k);
  if (brokenList.length) ctx.debug.set('postfx.broken', brokenList.join(','));

  if (S.profiler.enabled && S.profiler.ms.size) {
    let line = '';
    let total = 0;
    S.profiler.ms.forEach((v, k) => { line += `${k} ${v.toFixed(2)} `; total += v; });
    ctx.debug.set(`postfx.${S.profiler.mode}`, `${line}| total ${total.toFixed(2)}ms`);
  }
}

// ── Ciclo de vida ───────────────────────────────────────────────────────────

export function dispose(ctx) {
  if (!S) return;
  try { S.unsubRebase?.(); } catch (e) { /* ignora */ }
  S.copy.dispose();
  S.ssao.dispose();
  S.godrays.dispose();
  S.bloom.dispose();
  S.motionBlur.dispose();
  S.composite.dispose();
  S.fxaa.dispose();
  S.profiler.dispose();
  S.ldrTarget.dispose();
  S.sceneCopyTarget?.dispose();
  S.neutralWhite.dispose();
  S.neutralBlack.dispose();
  S.quad.dispose();
  if (ctx) { ctx.registry?.delete?.(id); ctx.postfx = null; }
  S = null;
}
