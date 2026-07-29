import * as THREE from 'three';

/**
 * Sombras em cascata (CSM) próprias.
 *
 * ── Por que não usar `three/addons/csm` ──────────────────────────────────────
 * O addon assume um mundo pequeno e usa o pipeline de sombras do three (uma
 * DirectionalLight por cascata, cada uma com o seu shadow map e o seu
 * `shadowCameraFar`). Isso quebra em três pontos no AETHER:
 *
 *   1. ORIGEM FLUTUANTE — a cena inteira salta alguns quilômetros a cada
 *      rebase. O addon reposiciona as luzes a partir da câmera do three, o que
 *      funciona, mas ele NÃO arredonda a origem da cascata para o texel: a
 *      sombra "ferve" a cada passo do jogador. É o artefato que mais denuncia
 *      protótipo, então a estabilização é obrigatória aqui.
 *   2. LOGARITHMIC DEPTH BUFFER — o renderer liga log depth globalmente. As
 *      câmeras de sombra são ortográficas, e o chunk de log depth do three cai
 *      no caminho `gl_FragCoord.z` quando a projeção não é perspectiva. Nós
 *      dependemos disso e comparamos contra NDC.z linear; misturar com o
 *      pipeline padrão de sombras do three seria frágil.
 *   3. ORÇAMENTO DE SAMPLERS — 4 DirectionalLightShadow custam 4 samplers e 4
 *      render targets. Usamos UM atlas 2x2 e UM sampler, o que também permite
 *      indexar a cascata dinamicamente sem violar a regra de "constant index"
 *      dos samplers em GLSL ES 1.00.
 *
 * ── Como funciona ────────────────────────────────────────────────────────────
 * Todas as matemáticas acontecem em ESPAÇO DE VISTA da câmera principal. A
 * matriz publicada por cascata é `proj_luz * view_luz * camera.matrixWorld`,
 * ou seja: view → clip da luz. Isso evita reconstruir posição de mundo no
 * fragment shader (não temos `inverse()` em GLSL ES 1.00) e é imune ao rebase,
 * porque o espaço de vista é sempre relativo à câmera.
 *
 * A esfera envolvente de cada fatia do frustum tem raio CONSTANTE para um dado
 * fov/aspect (só o centro se move). Isso permite congelar o tamanho do texel e
 * arredondar o centro para múltiplos dele — a estabilização.
 */

/** Camada usada para marcar quem projeta sombra. Não colide com a 0 (padrão). */
export const SHADOW_LAYER = 7;

/**
 * Disco de Poisson de 16 pontos em [-1,1]². Rotacionamos por pixel para trocar
 * banding por ruído de alta frequência, que o TAA/pós some depois.
 */
const POISSON16 = [
  [-0.942016, -0.399062], [0.945586, -0.768907], [-0.094184, -0.929389], [0.344959, 0.293878],
  [-0.915886, 0.457714], [-0.815442, -0.879125], [-0.382775, 0.276768], [0.974844, 0.756484],
  [0.443233, -0.975116], [0.537430, -0.473734], [-0.264969, -0.418930], [0.791975, 0.190902],
  [-0.241888, 0.997065], [-0.814100, 0.914376], [0.199841, 0.786414], [0.143832, -0.141008],
];

const COMP = ['x', 'y', 'z', 'w'];

/** Chunk `lights_fragment_begin` remendado — calculado uma única vez. */
let PATCHED_CHUNK = null;
let PATCH_MODE = 'none';   // 'direct' (preciso) | 'post' (aproximado)

function buildPatchedChunk() {
  if (PATCHED_CHUNK !== null) return;
  const base = THREE.ShaderChunk.lights_fragment_begin;
  const anchorDecl = 'IncidentLight directLight;';
  const anchorDir = 'getDirectionalLightInfo( directionalLight, directLight );';

  // O termo de sombra é calculado UMA vez, antes do laço de luzes.
  const declare =
    anchorDecl +
    '\n#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )\n' +
    '\tfloat aetherShadow = aetherCsmShadow( geometryPosition, geometryNormal );\n' +
    '#endif\n';

  // ...e só é aplicado à luz cuja direção bate com a do nosso sol. Comparar a
  // direção (em vez de assumir o índice 0) mantém o remendo correto mesmo que
  // outro módulo insira uma DirectionalLight antes da nossa — e deixa
  // lanternas/point lights intocadas dentro da sombra.
  const apply =
    anchorDir +
    '\n\t\tdirectLight.color *= mix( 1.0, aetherShadow, step( 0.999, dot( directLight.direction, uCsmLightDirView ) ) );\n';

  if (base && base.indexOf(anchorDecl) >= 0 && base.indexOf(anchorDir) >= 0) {
    PATCHED_CHUNK = base.replace(anchorDecl, declare).replace(anchorDir, apply);
    PATCH_MODE = 'direct';
  } else {
    // Fallback: se o three mudar o chunk, ainda escurecemos a contribuição
    // direta depois do fim da iluminação. Menos correto (afeta todas as luzes
    // diretas), mas o jogo continua com sombras em vez de quebrar.
    PATCHED_CHUNK = '';
    PATCH_MODE = 'post';
  }
}

export class CascadedShadows {
  /**
   * @param {object} ctx contexto compartilhado
   * @param {object} [opts]
   */
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.renderer = ctx.engine.renderer;

    this.enabled = true;
    this.cascades = 0;
    this.tile = 0;
    this.taps = 0;
    this.lambda = opts.lambda ?? 0.85;
    /** Fatia final coberta por sombra (m). Além disso a névoa aérea assume. */
    this.shadowFar = opts.shadowFar ?? 8000;
    /** Largura da transição entre cascatas, como fração do split. */
    this.fade = 0.14;

    this.target = null;
    this.atlasW = 0;
    this.atlasH = 0;

    /** Splits em metros: distância FINAL de cada cascata. */
    this.splits = [];
    /** Raio da esfera envolvente de cada cascata (m). */
    this.radii = [];
    this.cameras = [];
    this.viewports = [];

    // Uniforms COMPARTILHADOS entre todos os materiais registrados: atualizar
    // um objeto atualiza a cena inteira, sem varrer lista de shaders por frame.
    this.uniforms = {
      uCsmAtlas: { value: null },
      uCsmMatrix: { value: [] },
      uCsmTileRect: { value: [] },
      uCsmSplitFar: { value: new THREE.Vector4(1, 1, 1, 1) },
      uCsmTexelWorld: { value: new THREE.Vector4(1, 1, 1, 1) },
      uCsmDepthBias: { value: new THREE.Vector4() },
      // Multiplicador do normal offset, em texels. Precisa cobrir o raio do
      // disco de PCF, senão as amostras externas voltam a se auto-ocluir.
      uCsmNormalBias: { value: new THREE.Vector4(2.2, 2.2, 2.2, 2.2) },
      uCsmLightDirView: { value: new THREE.Vector3(0, 1, 0) },
      uCsmIntensity: { value: 1 },
      // Raio do disco de Poisson em UV do tile. Em texels (ver `pcfTexels`):
      // 1 texel dá borda dura de engine; ~1,8 já lê como penumbra.
      uCsmPcfUv: { value: 1 / 1024 },
      uCsmFade: { value: this.fade },
    };

    this.glsl = '';
    this.cacheKey = '0';

    /** Materiais remendados. Guardamos o estado anterior para poder desfazer. */
    this.materials = new Set();

    this.depthMaterial = new THREE.MeshDepthMaterial({
      // Só a profundidade importa; desligar a escrita de cor economiza banda.
      colorWrite: false,
      // DoubleSide porque folhagem e cartões de vegetação são planos únicos;
      // o normal-offset bias já compensa o acne que isso poderia trazer.
      side: THREE.DoubleSide,
    });
    this.depthMaterial.name = 'aetherCsmDepth';

    // Temporários de escopo de módulo — zero alocação por frame.
    this._v0 = new THREE.Vector3();
    this._center = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._lightBasis = new THREE.Object3D();
    this._lightBasisInv = new THREE.Matrix4();
    this._m0 = new THREE.Matrix4();
    this._upFlipped = false;
    this._prevSize = new THREE.Vector2();

    this._syncBudget = 0;
    this._onNode = (o) => this._visitNode(o);
    /** Callback opcional para auto-registro de materiais (injetado por lighting). */
    this.onMaterialSeen = null;

    this.setQuality({
      cascades: opts.cascades ?? 3,
      tile: opts.tile ?? 1024,
      taps: opts.taps ?? 16,
      pcfTexels: opts.pcfTexels,
    });
  }

  // ── Configuração ───────────────────────────────────────────────────────────

  /**
   * Reconfigura resolução/número de cascatas. Recompila os shaders registrados
   * apenas quando algo que entra no código GLSL muda.
   */
  setQuality({ cascades, tile, taps, shadowFar, splits, pcfTexels } = {}) {
    if (pcfTexels) this.pcfTexels = pcfTexels;
    else if (!this.pcfTexels) this.pcfTexels = 1.8;
    const nextCascades = Math.max(1, Math.min(4, Math.round(cascades ?? this.cascades ?? 3)));
    const maxTex = this.renderer.capabilities.maxTextureSize || 2048;
    let nextTile = Math.max(256, Math.round(tile ?? this.tile ?? 1024));
    const nextTaps = Math.max(4, Math.min(16, Math.round(taps ?? this.taps ?? 16)));

    // Layout do atlas: uma tira 1xN não desperdiça tile nenhum (com 3 cascatas
    // um 2x2 jogaria fora 25% da memória). Se a tira não couber no limite do
    // driver, caímos para 2 colunas e, em último caso, reduzimos o tile —
    // WebGL2 só garante 2048 de textura máxima.
    let cols = nextCascades;
    let rows = 1;
    if (cols * nextTile > maxTex) { cols = Math.min(2, nextCascades); rows = Math.ceil(nextCascades / cols); }
    while (Math.max(cols * nextTile, rows * nextTile) > maxTex && nextTile > 256) nextTile = Math.floor(nextTile / 2);

    if (shadowFar) this.shadowFar = shadowFar;
    this.splitOverride = splits || this.splitOverride || null;

    const geometryChanged = nextCascades !== this.cascades || nextTile !== this.tile;
    const codeChanged = nextCascades !== this.cascades || nextTaps !== this.taps;

    this.cascades = nextCascades;
    this.tile = nextTile;
    this.taps = nextTaps;
    this.cols = cols;
    this.rows = rows;

    if (geometryChanged || !this.target) this._buildTargets();
    this.uniforms.uCsmPcfUv.value = this.pcfTexels / this.tile;
    if (codeChanged || !this.glsl) {
      this._buildGlsl();
      this.cacheKey = `${this.cascades}x${this.taps}`;
      // Os shaders já compilados precisam ser refeitos: o número de cascatas
      // está embutido no código gerado.
      for (const m of this.materials) m.needsUpdate = true;
    }
  }

  _buildTargets() {
    this._disposeTargets();
    const w = this.cols * this.tile;
    const h = this.rows * this.tile;
    this.atlasW = w;
    this.atlasH = h;

    const depth = new THREE.DepthTexture(w, h);
    depth.type = THREE.UnsignedIntType;      // 24 bits: precisão de sobra para ortho
    depth.format = THREE.DepthFormat;
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;
    depth.generateMipmaps = false;
    depth.compareFunction = null;            // amostramos o valor cru, PCF é nosso

    this.target = new THREE.WebGLRenderTarget(w, h, {
      // O anexo de cor existe só porque o WebGL exige um; nada escreve nele.
      format: THREE.RedFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
      colorSpace: THREE.NoColorSpace,
    });
    this.target.depthTexture = depth;
    this.target.texture.name = 'csmAtlasColor';

    this.uniforms.uCsmAtlas.value = depth;
    this.uniforms.uCsmPcfUv.value = this.pcfTexels / this.tile;

    // Câmeras, viewports e retângulos de atlas por cascata.
    this.cameras.length = 0;
    this.viewports.length = 0;
    this.uniforms.uCsmMatrix.value.length = 0;
    this.uniforms.uCsmTileRect.value.length = 0;
    for (let i = 0; i < this.cascades; i++) {
      const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
      cam.name = `csmCascade${i}`;
      // Só desenha quem foi marcado como projetor de sombra.
      cam.layers.disableAll();
      cam.layers.enable(SHADOW_LAYER);
      this.cameras.push(cam);

      const col = i % this.cols;
      const row = Math.floor(i / this.cols);
      this.viewports.push(new THREE.Vector4(col * this.tile, row * this.tile, this.tile, this.tile));
      this.uniforms.uCsmMatrix.value.push(new THREE.Matrix4());
      this.uniforms.uCsmTileRect.value.push(
        new THREE.Vector4((col * this.tile) / w, (row * this.tile) / h, this.tile / w, this.tile / h),
      );
    }
    this.splits.length = 0;
    this.radii.length = 0;
    this._fovKey = -1;
    this._splitNear = -1;
  }

  _disposeTargets() {
    if (!this.target) return;
    if (this.target.depthTexture) this.target.depthTexture.dispose();
    this.target.dispose();
    this.target = null;
  }

  // ── Geração do GLSL ────────────────────────────────────────────────────────

  _buildGlsl() {
    const n = this.cascades;
    const taps = this.taps;
    const step = POISSON16.length / taps;
    let s = '';

    s += 'uniform sampler2D uCsmAtlas;\n';
    s += `uniform mat4 uCsmMatrix[${n}];\n`;
    s += `uniform vec4 uCsmTileRect[${n}];\n`;
    s += 'uniform vec4 uCsmSplitFar;\n';
    s += 'uniform vec4 uCsmTexelWorld;\n';
    s += 'uniform vec4 uCsmDepthBias;\n';
    s += 'uniform vec4 uCsmNormalBias;\n';
    s += 'uniform vec3 uCsmLightDirView;\n';
    s += 'uniform float uCsmIntensity;\n';
    s += 'uniform float uCsmPcfUv;\n';
    s += 'uniform float uCsmFade;\n';

    // O clamp mantém a amostra dentro do tile: sem ele o PCF da borda leria a
    // cascata vizinha do atlas e desenharia uma faixa preta no chão.
    s += 'float aetherCsmTap( vec2 uv, vec4 rect, float z ) {\n';
    s += '\tvec2 t = rect.xy + clamp( uv, vec2( 0.0 ), vec2( 1.0 ) ) * rect.zw;\n';
    s += '\treturn step( z, texture2D( uCsmAtlas, t ).r );\n';
    s += '}\n';

    const inv = (1 / taps).toFixed(6);
    for (let k = 0; k < n; k++) {
      const c = COMP[k];
      s += `float aetherCsmCascade${k}( vec3 vp, vec3 vn, float slope, vec2 rot ) {\n`;
      // Normal offset bias: desloca o ponto ao longo da normal por ~1 texel do
      // mapa. É o que remove o acne sem o "peter-panning" do depth bias puro.
      s += `\tvec3 p = vp + vn * ( uCsmTexelWorld.${c} * uCsmNormalBias.${c} * slope );\n`;
      s += `\tvec4 sc = uCsmMatrix[${k}] * vec4( p, 1.0 );\n`;
      s += '\tvec3 c = sc.xyz * 0.5 + 0.5;\n';   // projeção ortográfica: w == 1
      s += '\tif ( c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z < 0.0 || c.z > 1.0 ) return 1.0;\n';
      // O bias de profundidade também escala com a inclinação: um erro lateral
      // de um texel vira um erro de profundidade proporcional a tan(θ), e é
      // isso que produz acne nas faces quase paralelas à luz.
      s += `\tfloat z = c.z - uCsmDepthBias.${c} * slope;\n`;
      s += '\tfloat r = uCsmPcfUv;\n';
      s += '\tvec2 o;\n\tfloat sum = 0.0;\n';
      for (let t = 0; t < taps; t++) {
        const p = POISSON16[Math.floor(t * step) % POISSON16.length];
        s += `\to = vec2( ${p[0].toFixed(6)}, ${p[1].toFixed(6)} );\n`;
        s += '\tsum += aetherCsmTap( c.xy + vec2( o.x * rot.x - o.y * rot.y, o.x * rot.y + o.y * rot.x ) * r, ';
        s += `uCsmTileRect[${k}], z );\n`;
      }
      s += `\treturn sum * ${inv};\n}\n`;
    }

    s += 'float aetherCsmShadow( vec3 vp, vec3 vn ) {\n';
    s += '\tif ( uCsmIntensity <= 0.0 ) return 1.0;\n';
    s += '\tfloat ndl = dot( vn, uCsmLightDirView );\n';
    // Costas para o sol: N·L já zera a luz direta, não vale gastar 16 taps.
    s += '\tif ( ndl <= 0.0 ) return 1.0;\n';
    // 1/cos(θ): cresce como a projeção do texel sobre a superfície. O teto de
    // 6,7 (θ ≈ 81°) é seguro porque a essa altura N·L já quase zerou a luz.
    s += '\tfloat slope = clamp( 1.0 / max( ndl, 0.15 ), 1.0, 6.7 );\n';
    s += '\tfloat d = -vp.z;\n';
    // Rotação do disco por pixel: converte o padrão fixo do PCF (que aparece
    // como bandas) em ruído, muito mais fácil de esconder.
    s += '\tfloat a = fract( sin( dot( gl_FragCoord.xy, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) * 6.2831853;\n';
    s += '\tvec2 rot = vec2( cos( a ), sin( a ) );\n';
    s += '\tfloat s = 1.0;\n';
    for (let k = 0; k < n; k++) {
      const c = COMP[k];
      s += `\t${k === 0 ? 'if' : 'else if'} ( d < uCsmSplitFar.${c} ) {\n`;
      s += `\t\ts = aetherCsmCascade${k}( vp, vn, slope, rot );\n`;
      if (k < n - 1) {
        s += `\t\tfloat t${k} = smoothstep( uCsmSplitFar.${c} * ( 1.0 - uCsmFade ), uCsmSplitFar.${c}, d );\n`;
        s += `\t\tif ( t${k} > 0.0 ) s = mix( s, aetherCsmCascade${k + 1}( vp, vn, slope, rot ), t${k} );\n`;
      }
      s += '\t}\n';
    }
    s += '\telse { return 1.0; }\n';
    const last = COMP[n - 1];
    // Desvanece a última cascata para 1.0: a borda dura do alcance de sombra
    // seria uma linha reta visível cruzando o terreno.
    s += `\ts = mix( s, 1.0, smoothstep( uCsmSplitFar.${last} * 0.82, uCsmSplitFar.${last}, d ) );\n`;
    s += '\treturn mix( 1.0, s, uCsmIntensity );\n';
    s += '}\n';

    this.glsl = s;
  }

  // ── Registro de materiais ──────────────────────────────────────────────────

  /** Injeta a amostragem de sombra num material padrão do three. */
  registerMaterial(mat) {
    if (!mat || this.materials.has(mat)) return mat;
    buildPatchedChunk();
    this.materials.add(mat);

    const ud = mat.userData || (mat.userData = {});
    ud.__csmPrevOnBeforeCompile = mat.onBeforeCompile;
    ud.__csmPrevCacheKey = mat.customProgramCacheKey;

    const prevOBC = ud.__csmPrevOnBeforeCompile;
    mat.onBeforeCompile = (shader, renderer) => {
      // Preserva o remendo que o dono do material já tinha (terreno, água…).
      if (typeof prevOBC === 'function') prevOBC.call(mat, shader, renderer);
      this.patchShader(shader);
    };

    // A chave de cache de programa PRECISA continuar distinguindo materiais que
    // injetam GLSL diferente. O padrão do three é `onBeforeCompile.toString()`
    // — que agora devolve o NOSSO wrapper, idêntico para todo material
    // registrado. Isso faria dois materiais diferentes compartilharem o mesmo
    // programa. Trocamos por: chave própria do dono, se houver; senão a fonte
    // do onBeforeCompile ORIGINAL.
    const prevKey = ud.__csmPrevCacheKey;
    const prevOBCStr = typeof prevOBC === 'function' ? prevOBC.toString() : '';
    const wrapperStr = mat.onBeforeCompile.toString();
    mat.customProgramCacheKey = () => {
      let base = '';
      if (typeof prevKey === 'function') {
        const k = prevKey.call(mat);
        base = k === wrapperStr ? prevOBCStr : k;
      }
      return `${base}|csm${this.cacheKey}`;
    };

    mat.needsUpdate = true;
    return mat;
  }

  /** Desfaz o registro e devolve o material ao estado original. */
  unregister(mat) {
    if (!mat || !this.materials.has(mat)) return;
    this.materials.delete(mat);
    const ud = mat.userData || {};
    mat.onBeforeCompile = ud.__csmPrevOnBeforeCompile || function () {};
    mat.customProgramCacheKey = ud.__csmPrevCacheKey || function () { return ''; };
    delete ud.__csmPrevOnBeforeCompile;
    delete ud.__csmPrevCacheKey;
    mat.needsUpdate = true;
  }

  /** Aplica as declarações e o remendo do chunk de iluminação num shader. */
  patchShader(shader) {
    for (const k in this.uniforms) shader.uniforms[k] = this.uniforms[k];
    // O bloco vai antes de tudo do material: o prefixo do three (precision,
    // defines, viewMatrix) já foi emitido, e não dependemos de nenhum chunk.
    shader.fragmentShader = this.glsl + shader.fragmentShader;

    if (PATCH_MODE === 'direct') {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_fragment_begin>',
        PATCHED_CHUNK,
      );
    } else {
      // Caminho degradado: multiplica a contribuição direta no fim.
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <lights_fragment_begin>',
          '#include <lights_fragment_begin>\n\tfloat aetherShadow = aetherCsmShadow( geometryPosition, geometryNormal );',
        )
        .replace(
          '#include <lights_fragment_end>',
          '#include <lights_fragment_end>\n\treflectedLight.directDiffuse *= aetherShadow;\n\treflectedLight.directSpecular *= aetherShadow;',
        );
    }
  }

  // ── Divisão em cascatas ────────────────────────────────────────────────────

  /**
   * Splits práticos (PSSM). A mistura clássica `λ·log + (1−λ)·uniforme` com
   * λ = 0,85 coloca o primeiro corte a ~300 m em escala planetária, o que
   * destrói a sombra de contato. Por isso o preset padrão usa a tabela
   * canônica (40/250/1500/8000 m); a fórmula continua disponível para quem
   * quiser ajustar λ em runtime via `splits: 'auto'`.
   */
  _updateSplits(near) {
    const n = this.cascades;
    if (this.splits.length === n && this._splitNear === near && this._splitFar === this.shadowFar) return;
    this._splitNear = near;
    this._splitFar = this.shadowFar;
    this.splits.length = 0;

    if (Array.isArray(this.splitOverride) && this.splitOverride.length >= n) {
      for (let i = 0; i < n; i++) this.splits.push(this.splitOverride[i]);
    } else if (this.splitOverride === 'auto') {
      // Ancoramos o log em 6 m (a escala de um corpo humano) em vez de em
      // camera.near: com near = 0,05 m a progressão logarítmica desperdiça
      // duas cascatas inteiras dentro do primeiro metro.
      const a = 6, b = this.shadowFar;
      for (let i = 1; i <= n; i++) {
        const p = i / n;
        const lg = a * Math.pow(b / a, p);
        const un = a + (b - a) * p;
        this.splits.push(this.lambda * lg + (1 - this.lambda) * un);
      }
    } else {
      const table = n === 4
        ? [40, 250, 1500, this.shadowFar]
        : n === 3
          ? [50, 500, this.shadowFar]
          : n === 2
            ? [80, this.shadowFar]
            : [this.shadowFar];
      for (let i = 0; i < n; i++) this.splits.push(table[i]);
    }
    this.splits[n - 1] = this.shadowFar;
    this._splitsLabel = this.splits.map((v) => (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v.toFixed(0))).join('|');
    // Os raios das esferas envolventes dependem dos splits: invalida o cache.
    this._fovKey = -1;
  }

  /**
   * Raio da esfera envolvente de cada fatia. Depende só de fov/aspect, então é
   * CONSTANTE enquanto a câmera não muda de lente — e é exatamente essa
   * constância que permite congelar o tamanho do texel e estabilizar a sombra.
   */
  _updateRadii(camera, near) {
    const fovKey = camera.fov * 1000 + camera.aspect;
    if (this._fovKey === fovKey && this.radii.length === this.cascades) return;
    this._fovKey = fovKey;
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
    const tanH = tanV * camera.aspect;
    const k2 = tanV * tanV + tanH * tanH;
    this.radii.length = 0;
    this.centersZ = this.centersZ || [];
    this.centersZ.length = 0;
    let zn = near;
    for (let i = 0; i < this.cascades; i++) {
      const zf = this.splits[i];
      let zc = ((zn + zf) * (1 + k2)) * 0.5;
      let r;
      if (zc >= zf) {
        // A esfera do plano distante já contém os cantos próximos.
        zc = zf;
        r = Math.sqrt(k2) * zf;
      } else {
        const dz = zc - zn;
        r = Math.sqrt(k2 * zn * zn + dz * dz);
      }
      this.centersZ.push(zc);
      this.radii.push(r);
      zn = zf;
    }
  }

  // ── Atualização por frame ──────────────────────────────────────────────────

  /**
   * Recalcula as câmeras de cascata e as matrizes publicadas nos shaders.
   * @param {THREE.PerspectiveCamera} camera câmera principal (espaço de render)
   * @param {THREE.Vector3} sunDir direção normalizada APONTANDO PARA o sol
   */
  update(camera, sunDir) {
    if (!this.target) return;
    const near = Math.max(0.1, camera.near);
    this._updateSplits(near);
    this._updateRadii(camera, near);

    camera.updateMatrixWorld();

    // Eixo "up" estável para a base da luz. Trocar de eixo faz a sombra girar
    // de uma vez, então usamos histerese larga em torno do zênite.
    if (!this._upFlipped && Math.abs(sunDir.y) > 0.985) this._upFlipped = true;
    else if (this._upFlipped && Math.abs(sunDir.y) < 0.94) this._upFlipped = false;
    if (this._upFlipped) this._up.set(0, 0, 1); else this._up.set(0, 1, 0);

    // Base de rotação da luz (sem translação): serve para levar o centro da
    // cascata ao espaço da luz, arredondar e voltar.
    this._lightBasis.position.set(0, 0, 0);
    this._lightBasis.up.copy(this._up);
    this._lightBasis.lookAt(-sunDir.x, -sunDir.y, -sunDir.z);
    this._lightBasis.updateMatrixWorld(true);
    this._lightBasisInv.copy(this._lightBasis.matrixWorld).invert();

    const sf = this.uniforms.uCsmSplitFar.value;
    const tw = this.uniforms.uCsmTexelWorld.value;
    const db = this.uniforms.uCsmDepthBias.value;

    for (let i = 0; i < this.cascades; i++) {
      const r = this.radii[i];
      const texel = (2 * r) / this.tile;

      // Centro da fatia em espaço de vista → espaço de render.
      this._center.set(0, 0, -this.centersZ[i]).applyMatrix4(camera.matrixWorld);

      // ESTABILIZAÇÃO: arredonda o centro para múltiplos do texel no plano da
      // luz. Sem isto a projeção anda em sub-texels a cada passo e as bordas
      // de sombra "fervem" — o artefato que mais denuncia protótipo.
      this._v0.copy(this._center).applyMatrix4(this._lightBasisInv);
      this._v0.x = Math.round(this._v0.x / texel) * texel;
      this._v0.y = Math.round(this._v0.y / texel) * texel;
      this._center.copy(this._v0).applyMatrix4(this._lightBasis.matrixWorld);

      // Recuo ao longo da luz para capturar quem projeta de cima (falésias,
      // arcos). Cresce com a cascata porque as fatias distantes veem relevo.
      const backoff = Math.min(12000, Math.max(400, r * 4));
      const depth = 2 * r + 2 * backoff;

      const cam = this.cameras[i];
      cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
      cam.near = 0.1; cam.far = depth;
      cam.up.copy(this._up);
      cam.position.copy(this._center).addScaledVector(sunDir, r + backoff);
      cam.lookAt(this._center);
      cam.updateMatrixWorld(true);
      cam.updateProjectionMatrix();

      // view (da câmera principal) → clip da luz, tudo numa matriz só.
      this._m0.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      this.uniforms.uCsmMatrix.value[i].multiplyMatrices(this._m0, camera.matrixWorld);

      sf.setComponent(i, this.splits[i]);
      tw.setComponent(i, texel);
      // Bias constante em METROS convertido para a escala de profundidade da
      // cascata; assim ele não explode nas cascatas grandes.
      db.setComponent(i, (texel * 1.2 + 0.02) / depth);
    }
    // Componentes não usadas repetem a última: evita ler lixo se n < 4.
    for (let i = this.cascades; i < 4; i++) {
      sf.setComponent(i, this.splits[this.cascades - 1]);
      tw.setComponent(i, tw.getComponent(this.cascades - 1));
      db.setComponent(i, db.getComponent(this.cascades - 1));
    }

    this.uniforms.uCsmLightDirView.value.copy(sunDir).transformDirection(camera.matrixWorldInverse).normalize();
    this.uniforms.uCsmFade.value = this.fade;
  }

  /** Intensidade global (0 desliga a amostragem já no primeiro `if`). */
  setIntensity(v) { this.uniforms.uCsmIntensity.value = v; }

  // ── Render do atlas ────────────────────────────────────────────────────────

  _visitNode(o) {
    if (o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || o.isBatchedMesh) {
      // A camada é a lista de projetores: a câmera de sombra só enxerga ela,
      // então domo de céu, atmosfera e água nunca entram no depth pass.
      if (o.castShadow) o.layers.enable(SHADOW_LAYER);
      else o.layers.disable(SHADOW_LAYER);

      if (this.onMaterialSeen && this._syncBudget > 0) {
        const m = o.material;
        if (Array.isArray(m)) {
          for (let i = 0; i < m.length; i++) if (this.onMaterialSeen(m[i])) this._syncBudget--;
        } else if (m && this.onMaterialSeen(m)) {
          this._syncBudget--;
        }
      }
    }
  }

  /** Varredura amortizada que mantém a camada de projetores em dia. */
  syncScene(scene, budget = 8) {
    this._syncBudget = budget;
    scene.traverse(this._onNode);
  }

  /**
   * Desenha as cascatas no atlas. Deve rodar depois que todos os módulos
   * escreveram suas posições relativas e antes do render principal.
   */
  render(scene, camera) {
    if (!this.enabled || !this.target) return;
    const r = this.renderer;

    const prevTarget = r.getRenderTarget();
    const prevOverride = scene.overrideMaterial;
    const prevBackground = scene.background;
    const prevAutoClear = r.autoClear;

    scene.overrideMaterial = this.depthMaterial;
    scene.background = null;   // o background do three ignoraria o scissor
    r.autoClear = false;

    // Uma varredura de matrizes serve para as N cascatas. Deixar o auto-update
    // ligado faria o three percorrer o grafo inteiro uma vez por cascata — em
    // escala planetária isso são milhares de nós desperdiçados por frame.
    const prevAuto = scene.matrixWorldAutoUpdate;
    if (prevAuto) scene.updateMatrixWorld();
    scene.matrixWorldAutoUpdate = false;

    r.setRenderTarget(this.target);
    r.setScissorTest(false);
    r.clear(false, true, false);     // um clear só para o atlas inteiro

    for (let i = 0; i < this.cascades; i++) {
      const vp = this.viewports[i];
      r.setViewport(vp.x, vp.y, vp.z, vp.w);
      r.setScissor(vp.x, vp.y, vp.z, vp.w);
      r.setScissorTest(true);
      r.render(scene, this.cameras[i]);
    }

    r.setScissorTest(false);
    r.autoClear = prevAutoClear;
    scene.matrixWorldAutoUpdate = prevAuto;
    scene.overrideMaterial = prevOverride;
    scene.background = prevBackground;
    // setRenderTarget devolve o viewport ao tamanho do alvo anterior.
    r.setRenderTarget(prevTarget);
    if (prevTarget === null) {
      r.getSize(this._prevSize);
      r.setViewport(0, 0, this._prevSize.x, this._prevSize.y);
    }
  }

  get splitsLabel() { return this._splitsLabel || ''; }

  dispose() {
    for (const m of Array.from(this.materials)) this.unregister(m);
    this._disposeTargets();
    this.depthMaterial.dispose();
  }
}
