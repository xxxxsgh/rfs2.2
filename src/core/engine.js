import * as THREE from 'three';

/**
 * Engine: renderer, câmeras, alvos HDR e a estratégia de profundidade.
 *
 * ── Estratégia de profundidade (o ponto crítico da escala planetária) ────────
 * Renderizamos em DOIS passes com câmeras que compartilham a mesma orientação:
 *
 *   1. `farScene` / `farCamera`  — céu estrelado, sol, outros planetas e luas.
 *      A câmera fica na origem; o conteúdo é posicionado com distâncias
 *      COMPRIMIDAS (ver FloatingOrigin.toLocalCompressed). near=1, far=1e7.
 *      Sem depth write contra o pass principal: é o fundo do mundo.
 *
 *   2. `scene` / `camera` — planeta, atmosfera, nave, criaturas, tudo que o
 *      jogador pode tocar. Coordenadas relativas à origem flutuante, então
 *      nunca passam de ~1e6. near=0.05, far=8e6, com logarithmicDepthBuffer.
 *
 * Isso elimina tanto o z-fighting quanto o colapso de float32, sem precisar de
 * um frustum reverso manual.
 */
export class Engine {
  constructor({ container, pixelRatioCap = 1.5 } = {}) {
    this.container = container || document.body;

    const canvas = document.createElement('canvas');
    canvas.id = 'gl';
    this.container.appendChild(canvas);
    this.canvas = canvas;

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,            // usamos SMAA/FXAA no pós-processamento
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      logarithmicDepthBuffer: true,
      preserveDrawingBuffer: true, // necessário para o modo foto / screenshots
    });

    if (!renderer.capabilities.isWebGL2) {
      console.warn('[engine] WebGL2 indisponível — qualidade reduzida.');
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioCap));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.autoClear = false;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;   // o postfx faz ACES em HDR
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = true;
    this.renderer = renderer;
    this.pixelRatioCap = pixelRatioCap;

    // ── Cenas ────────────────────────────────────────────────────────────────
    this.scene = new THREE.Scene();
    this.scene.name = 'near';
    this.farScene = new THREE.Scene();
    this.farScene.name = 'far';
    /** Cena de overlay: cockpit, mãos, HUD 3D. Renderizada por último, depth limpo. */
    this.overlayScene = new THREE.Scene();
    this.overlayScene.name = 'overlay';

    // ── Câmeras ──────────────────────────────────────────────────────────────
    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    this.camera = new THREE.PerspectiveCamera(70, aspect, 0.05, 8e6);
    this.camera.name = 'main';
    this.farCamera = new THREE.PerspectiveCamera(70, aspect, 1, 1e7);
    this.farCamera.name = 'far';
    this.overlayCamera = new THREE.PerspectiveCamera(70, aspect, 0.01, 100);
    this.overlayCamera.name = 'overlay';

    // A câmera principal é a fonte da verdade de orientação; as outras copiam.
    this.camera.rotation.order = 'YXZ';

    // ── Alvos HDR ────────────────────────────────────────────────────────────
    this.hdrType = this._pickHdrType();
    this.sceneTarget = this._makeTarget(window.innerWidth, window.innerHeight, true);
    this.sceneTarget.texture.name = 'hdrScene';

    /** Buffer de profundidade+velocidade exposto ao pós-processamento. */
    this.depthTexture = this.sceneTarget.depthTexture;

    this.size = new THREE.Vector2(window.innerWidth, window.innerHeight);
    this.clock = new THREE.Clock();

    /** Estatísticas por frame para o auditor de performance. */
    this.stats = { drawCalls: 0, triangles: 0, programs: 0, fps: 60, frameMs: 16.7, gpuMs: 0 };
    this._fpsAccum = 0; this._fpsFrames = 0;

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);

    // Contexto perdido: falha visível, não silenciosa.
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); console.error('[engine] contexto WebGL perdido'); });
  }

  _pickHdrType() {
    const gl = this.renderer.getContext();
    const ext = this.renderer.extensions;
    if (ext.has('EXT_color_buffer_float')) return THREE.HalfFloatType;
    if (ext.has('EXT_color_buffer_half_float')) return THREE.HalfFloatType;
    return THREE.UnsignedByteType;
  }

  _makeTarget(w, h, withDepth) {
    const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
      type: this.hdrType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      samples: 0,
    });
    if (withDepth) {
      const dt = new THREE.DepthTexture(Math.max(1, w), Math.max(1, h));
      dt.type = THREE.FloatType;
      dt.minFilter = THREE.NearestFilter;
      dt.magFilter = THREE.NearestFilter;
      rt.depthTexture = dt;
    }
    return rt;
  }

  resize(width, height) {
    const w = width || window.innerWidth;
    const h = height || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, this.pixelRatioCap);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    const aspect = w / Math.max(1, h);
    for (const cam of [this.camera, this.farCamera, this.overlayCamera]) {
      cam.aspect = aspect;
      cam.updateProjectionMatrix();
    }
    const bw = Math.floor(w * dpr), bh = Math.floor(h * dpr);
    this.sceneTarget.setSize(bw, bh);
    this.size.set(w, h);
    this.onResize?.(w, h, dpr);
  }

  /** Ajusta a resolução interna (0.5–1.0) sem mexer no tamanho do canvas. */
  setRenderScale(scale) {
    const dpr = Math.min(window.devicePixelRatio || 1, this.pixelRatioCap) * scale;
    this.renderer.setPixelRatio(dpr);
    const bw = Math.floor(this.size.x * dpr), bh = Math.floor(this.size.y * dpr);
    this.sceneTarget.setSize(bw, bh);
  }

  /** Sincroniza as câmeras auxiliares com a principal. */
  syncCameras() {
    this.farCamera.quaternion.copy(this.camera.quaternion);
    this.farCamera.fov = this.camera.fov;
    this.farCamera.position.set(0, 0, 0);
    this.farCamera.updateProjectionMatrix();
    this.farCamera.updateMatrixWorld(true);

    this.overlayCamera.quaternion.copy(this.camera.quaternion);
    this.overlayCamera.fov = this.camera.fov;
    this.overlayCamera.position.set(0, 0, 0);
    this.overlayCamera.updateProjectionMatrix();
    this.overlayCamera.updateMatrixWorld(true);
  }

  /**
   * Desenha far + near dentro de `sceneTarget` (HDR linear).
   * O pós-processamento consome esse alvo e escreve na tela.
   */
  renderToTarget(target = this.sceneTarget) {
    const r = this.renderer;
    this.syncCameras();
    r.setRenderTarget(target);
    r.clear(true, true, true);
    r.render(this.farScene, this.farCamera);
    r.clearDepth();
    r.render(this.scene, this.camera);
    r.setRenderTarget(null);
    const info = r.info.render;
    this.stats.drawCalls = info.calls;
    this.stats.triangles = info.triangles;
    this.stats.programs = r.info.programs ? r.info.programs.length : 0;
  }

  /** Overlay (cockpit / braços) por cima do resultado final, já no framebuffer. */
  renderOverlay() {
    if (this.overlayScene.children.length === 0) return;
    const r = this.renderer;
    r.setRenderTarget(null);
    r.clearDepth();
    r.render(this.overlayScene, this.overlayCamera);
  }

  tickStats(dtMs) {
    this._fpsAccum += dtMs; this._fpsFrames++;
    if (this._fpsAccum >= 500) {
      this.stats.frameMs = this._fpsAccum / this._fpsFrames;
      this.stats.fps = 1000 / this.stats.frameMs;
      this._fpsAccum = 0; this._fpsFrames = 0;
    }
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.sceneTarget.dispose();
    this.renderer.dispose();
  }
}
