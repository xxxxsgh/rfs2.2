import * as THREE from 'three';
import {
  createTarget, resizeTarget, makeMaterial, setDefine,
  GLSL_DEPTH, GLSL_NOISE,
} from './common.js';

/**
 * Motion blur de CÂMERA por vetores de velocidade reconstruídos.
 *
 * Não existe buffer de velocidade na cena (isso exigiria um pass extra e MRT em
 * todos os materiais). Em vez disso, reconstruímos a posição de cada pixel a
 * partir do depth, projetamos essa posição com a view-projection do frame
 * ANTERIOR e a diferença em UV é a velocidade. Cobre rotação e translação da
 * câmera — que é 95% do borrão que o jogador percebe numa nave.
 *
 * A armadilha desta cena: a origem flutuante rebaseia a cada 2 km. Depois de um
 * rebase, as coordenadas locais mudaram de referencial e a matriz antiga
 * apontaria para o outro lado do planeta. Compensamos multiplicando a matriz
 * anterior por uma translação do deslocamento (ver postfx.js) — e, se o salto
 * for grande demais para float32 (teleporte, warp), simplesmente pulamos o
 * frame. Um frame sem borrão ninguém vê; um frame com borrão de 1e9 metros sim.
 */

const FRAG = /* glsl */`
varying vec2 vUv;
${GLSL_DEPTH}
${GLSL_NOISE}
uniform sampler2D tScene;
uniform mat4  uInvView;        // camera.matrixWorld (olho → espaço de render)
uniform mat4  uPrevViewProj;   // view-projection do frame anterior
uniform vec2  uResolution;
uniform float uShutter;
uniform float uMaxPixels;

void main() {
  vec2 uv = vUv;
  float eyeD = eyeDepthAt(uv);
  vec3 vp = viewPosAt(uv, eyeD);
  vec4 wp = uInvView * vec4(vp, 1.0);
  vec4 pc = uPrevViewProj * wp;

  vec4 base = texture2D(tScene, uv);
  if (pc.w <= 1e-6) { gl_FragColor = base; return; }

  vec2 prevUv = (pc.xy / pc.w) * 0.5 + 0.5;
  vec2 vel = (uv - prevUv) * uShutter;

  float lenPx = length(vel * uResolution);
  if (lenPx < 0.75) { gl_FragColor = base; return; }
  // Teto: sem ele um giro brusco varre a tela inteira e o custo de cache
  // explode junto com o artefato.
  if (lenPx > uMaxPixels) vel *= uMaxPixels / lenPx;

  // Jitter quebra o "fantasma" de amostras discretas em rastros longos.
  float j = ign(gl_FragCoord.xy) - 0.5;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < MB_TAPS; i++) {
    float t = (float(i) + 0.5 + j) / float(MB_TAPS) - 0.5;
    acc += texture2D(tScene, clamp(uv + vel * t, vec2(0.0), vec2(1.0)));
  }
  gl_FragColor = acc / float(MB_TAPS);
}
`;

export class MotionBlurPass {
  constructor(sharedDepthUniforms, hdrType) {
    this.target = createTarget(1, 1, { type: hdrType, name: 'postfx/motionBlur' });
    const D = sharedDepthUniforms;
    this.mat = makeMaterial(FRAG, {
      tDepth: D.tDepth, uLogFC: D.uLogFC, uNearFar: D.uNearFar, uProjRay: D.uProjRay,
      tScene: { value: null },
      uInvView: { value: new THREE.Matrix4() },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uShutter: { value: 0.5 },
      uMaxPixels: { value: 28 },
    }, { name: 'postfx/motionBlur', defines: { MB_TAPS: 9 } });
  }

  setSize(w, h) {
    resizeTarget(this.target, w, h);
    this.mat.uniforms.uResolution.value.set(w, h);
  }

  render(renderer, quad, sceneTexture, invView, prevViewProj, p) {
    setDefine(this.mat, 'MB_TAPS', Math.max(3, p.taps | 0));
    const u = this.mat.uniforms;
    u.tScene.value = sceneTexture;
    u.uInvView.value.copy(invView);
    u.uPrevViewProj.value.copy(prevViewProj);
    u.uShutter.value = p.shutter;
    u.uMaxPixels.value = p.maxPixels;
    quad.render(renderer, this.mat, this.target);
    return this.target.texture;
  }

  materials() { return [{ key: 'blur', material: this.mat }]; }

  dispose() {
    this.target.dispose();
    this.mat.dispose();
  }
}
