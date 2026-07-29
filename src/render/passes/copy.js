import * as THREE from 'three';
import { makeMaterial, GLSL_ACES, GLSL_SRGB } from './common.js';

/**
 * Cópia direta e "tone map mínimo".
 *
 * Existe por dois motivos:
 *  1. É a rede de segurança. Se QUALQUER passe da cadeia falhar, caímos aqui e
 *     o jogador vê a cena — feia, mas visível. Tela preta é bug fatal; imagem
 *     sem bloom é só uma noite ruim.
 *  2. É o blit usado por `requestSceneCopy()` (refração da água).
 */

const PLAIN_FRAG = /* glsl */`
varying vec2 vUv;
uniform sampler2D tDiffuse;
void main() {
  gl_FragColor = vec4(texture2D(tDiffuse, vUv).rgb, 1.0);
}
`;

const TONEMAP_FRAG = /* glsl */`
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform float uExposure;
${GLSL_ACES}
${GLSL_SRGB}
void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb * uExposure;
  gl_FragColor = vec4(linearToSRGB(acesFitted(c)), 1.0);
}
`;

export class CopyPass {
  constructor() {
    this.plain = makeMaterial(PLAIN_FRAG, { tDiffuse: { value: null } }, { name: 'postfx/copy' });
    this.tonemap = makeMaterial(TONEMAP_FRAG, {
      tDiffuse: { value: null },
      uExposure: { value: 1 },
    }, { name: 'postfx/copyTonemap' });
    this.ok = { plain: true, tonemap: true };
  }

  /** Blit cru — usado para a cópia de cena (mantém HDR linear). */
  blit(renderer, quad, texture, target) {
    this.plain.uniforms.tDiffuse.value = texture;
    quad.render(renderer, this.plain, target);
  }

  /** Fallback para a tela: exposição + ACES + sRGB, nada mais. */
  present(renderer, quad, texture, exposure) {
    if (this.ok.tonemap) {
      this.tonemap.uniforms.tDiffuse.value = texture;
      this.tonemap.uniforms.uExposure.value = exposure;
      quad.render(renderer, this.tonemap, null);
    } else {
      this.blit(renderer, quad, texture, null);
    }
  }

  materials() {
    return [{ key: 'plain', material: this.plain }, { key: 'tonemap', material: this.tonemap }];
  }

  dispose() {
    this.plain.dispose();
    this.tonemap.dispose();
  }
}
