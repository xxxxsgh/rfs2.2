# AETHER — Arquitetura e Contrato de Módulos

Jogo de exploração espacial procedural em Three.js puro (ESM, sem bundler,
sem CDN). Objetivo de qualidade: No Man's Sky pós-*Worlds Part II*.

> **Este documento é normativo.** Se o seu código conflita com ele, o seu código
> está errado. Se o documento está errado, corrija-o na mesma entrega.

---

## 1. Como rodar

```bash
node tools/serve.mjs 8123      # http://localhost:8123/
node tools/shoot.mjs           # captura os screenshots canônicos
```

Sem etapa de build. `index.html` usa um *importmap* que aponta `three` para
`vendor/three/build/three.module.js` e `three/addons/` para `vendor/three/addons/`.
**Nunca** adicione uma dependência de rede externa.

---

## 2. Regras invioláveis

1. **Determinismo.** Todo conteúdo persistente vem de `ctx.rng.derive(tag, i)`.
   `Math.random()` só é permitido para efeitos de um único frame (faíscas,
   ruído de partícula). A mesma seed tem de produzir o mesmo universo.
2. **Precisão.** Posições de mundo vivem em `Vec3d` (float64, `src/core/frame.js`).
   Um `Object3D` só recebe coordenadas **relativas** via `ctx.frame.toLocal()`.
   Nunca escreva `mesh.position.set(planetCenterX, …)` com números grandes.
3. **Sem travar o frame.** Geração pesada vai para Web Worker (`type: 'module'`)
   ou é fatiada com `ctx.budget.canWork()`. Nenhum laço pode exceder ~4 ms.
4. **Propriedade de arquivos.** Você edita **apenas** os arquivos listados como
   seus. Precisa de algo de outro sistema? Consuma via `ctx.<id>` ou
   `ctx.events`. Nunca edite o arquivo alheio, nunca importe outro módulo de
   sistema diretamente.
5. **Sem asset binário.** Texturas, ruídos e sons são gerados em runtime
   (canvas, `DataTexture`, WebAudio). O repositório não carrega imagens.
6. **Degradação graciosa.** Se o seu módulo falhar no `init`, o jogo continua
   sem ele. Envolva integrações opcionais em `if (ctx.sky) { … }`.

---

## 3. Ciclo de vida de um módulo

Arquivo em `src/<área>/<nome>.js`, listado em `MODULES` de `src/main.js`:

```js
export const id = 'planet';
export const order = 30;

export async function init(ctx) {
  // Construa recursos. Pode ser assíncrono. Reporte com ctx.progress(f, label).
  ctx.provide(id, api);          // publica a API pública em ctx.planet
}
export function update(dt, ctx) {}       // dt em segundos, já clampado
export function lateUpdate(dt, ctx) {}   // opcional — roda após todos os update
export function resize(w, h, dpr, ctx) {}// opcional
export function dispose(ctx) {}          // opcional
```

`ctx.frame.update()` roda **entre** `update` e `lateUpdate`. Se você posiciona
objetos relativos à origem, faça isso em `lateUpdate` ou escute `frame:rebase`.

---

## 4. O contexto compartilhado (`ctx`)

Definido em `src/core/context.js`. Campos estáveis:

| Campo | Descrição |
|---|---|
| `ctx.engine` | `renderer`, `scene` (perto), `farScene` (céu/planetas distantes), `overlayScene` (cockpit), `camera`, `farCamera`, `overlayCamera`, `sceneTarget` (HDR), `stats` |
| `ctx.events` | barramento — lista de eventos canônicos em `src/core/events.js` |
| `ctx.input` | `axis('throttle'\|'strafe'\|'lift'\|'roll'\|'yaw'\|'pitch')`, `down(a)`, `pressed(a)` |
| `ctx.frame` | origem flutuante: `toLocal`, `toWorld`, `toLocalCompressed`, `origin`, `onRebase` |
| `ctx.rng` | raiz determinística; use `.derive(tag, i)` |
| `ctx.time` | `dt`, `elapsed`, `scale`, `frames`, `dayFraction` |
| `ctx.player` | `mode`, `position` (Vec3d), `velocity` (Vec3d), `quaternion`, `up`, `altitude`, `onGround`, `inAtmosphere`, `health/shield/energy/life` |
| `ctx.universe` | galáxia + sistemas (módulo `universe`) |
| `ctx.system` | sistema estelar atual |
| `ctx.planet` | **módulo** de planeta; `ctx.planet.current` é o corpo sob o jogador |
| `ctx.quality` | preset e chaves individuais; o módulo `perf` altera em runtime |
| `ctx.budget` | `canWork()`, `remainingMs()` |
| `ctx.debug.set(k,v)` | linha no overlay de debug |

### Cenas: qual usar

- `engine.farScene` — estrelas, sol, outros planetas, luas. Câmera na origem,
  distâncias **comprimidas** com `frame.toLocalCompressed`. `far = 1e7`.
- `engine.scene` — planeta atual, atmosfera, água, flora, fauna, nave, tiros.
  Coordenadas relativas à origem flutuante. `far = 8e6`, log depth ligado.
- `engine.overlayScene` — cockpit, braços, multi-ferramenta. Depth limpo antes.

---

## 5. Mapa de propriedade de arquivos

Compartilhados (**somente leitura** para todos; alterações apenas via revisão):
`src/core/*`, `src/noise/noise.js`, `src/planet/biomes.js`, `src/main.js`,
`index.html`, `tools/*`.

| Módulo | `id` | Arquivos que ele possui |
|---|---|---|
| Universo procedural | `universe` | `src/universe/universe.js`, `src/universe/starclass.js` |
| Mapa galáctico | `galaxymap` | `src/ui/galaxymap.js` |
| Terreno planetário | `planet` | `src/planet/planet.js`, `src/planet/quadsphere.js`, `src/planet/terrain-worker.js`, `src/planet/terrain-shader.js` |
| Iluminação/PBR/sombras | `lighting` | `src/render/lighting.js`, `src/render/csm.js` |
| Céu e espalhamento | `sky` | `src/atmo/sky.js`, `src/atmo/scattering.js` |
| Campo estelar | `starfield` | `src/atmo/starfield.js` |
| Nuvens volumétricas | `clouds` | `src/atmo/clouds.js` |
| Clima e ciclo diário | `weather` | `src/atmo/weather.js` |
| Água | `water` | `src/render/water.js` |
| Flora | `flora` | `src/life/flora.js` |
| Fauna | `fauna` | `src/life/fauna.js`, `src/life/creature-gen.js` |
| Voo | `flight` | `src/ship/flight.js`, `src/ship/shipmodel.js` |
| Cockpit | `cockpit` | `src/ship/cockpit.js` |
| Combate | `combat` | `src/ship/combat.js` |
| Multi-ferramenta | `multitool` | `src/gameplay/multitool.js` |
| Inventário/craft | `inventory` | `src/gameplay/inventory.js` |
| Descobertas | `discovery` | `src/gameplay/discovery.js` |
| Sentinelas | `sentinels` | `src/gameplay/sentinels.js` |
| Construção de base | `building` | `src/gameplay/building.js` |
| Pós-processamento | `postfx` | `src/render/postfx.js`, `src/render/passes/*` |
| HUD | `hud` | `src/ui/hud.js`, `src/ui/hud.css` |
| Áudio | `audio` | `src/audio/audio.js`, `src/audio/synth.js`, `src/audio/music.js` |
| Performance | `perf` | `src/perf/perf.js` |

---

## 6. APIs entre sistemas (contrato duro)

Estes métodos são consumidos por outros módulos e pelo arnês de screenshots.
**Implementá-los é obrigatório.**

### `ctx.universe`
```js
ctx.universe.galaxy                 // { stars: [...], radius }
ctx.universe.getSystem(index)       // constrói/retorna um sistema determinístico
ctx.universe.current                // sistema atual
ctx.universe.warpTo(index)          // Promise<void>
```
Um **sistema**: `{ id, name, star: {class,color,radius,temp,luminosity,position:Vec3d},
bodies: [Planet], asteroidBelts: [...] }`.
Um **corpo**: `{ id, name, type:'planet'|'moon'|'gas', radius, center:Vec3d,
orbit:{parent,a,e,period,phase,inclination}, biome, seed, hasRings, moons:[] }`.
`center` é atualizado por `universe.update()` — planetas orbitam de verdade.

### `ctx.planet`
```js
ctx.planet.current                       // corpo ativo ou null
ctx.planet.setActive(body)               // troca o planeta streamado
ctx.planet.sampleHeight(dirUnitVec3)     // altura do terreno acima do datum (m)
ctx.planet.sampleSurface(dirUnitVec3)    // { height, normal, biomeWeights, slope }
ctx.planet.altitudeAt(worldPosVec3d)     // metros acima do terreno
ctx.planet.waitReady(worldPosVec3d, ms)  // Promise — chunks carregados ali
ctx.planet.edit(worldPosVec3d, radius, delta)  // terrain manipulator
ctx.planet.seaLevelRadius                // raio absoluto do nível do mar
```

### `ctx.flight`
```js
ctx.flight.teleport(worldPosVec3d, quaternion)   // reposiciona jogador/nave
ctx.flight.setMode('ship'|'foot')
ctx.flight.ship                                   // Object3D da nave
```

### `ctx.sky`
```js
ctx.sky.setTimeOfDay(frac01)
ctx.sky.sunDirection        // THREE.Vector3 normalizado (mundo)
ctx.sky.sunColor            // THREE.Color
ctx.sky.sunIntensity        // número
```

### `ctx.postfx`
```js
ctx.postfx.render(ctx)      // consome engine.sceneTarget e escreve na tela
ctx.postfx.setEnabled(name, bool)
```

---

## 7. Escalas canônicas

| Grandeza | Valor |
|---|---|
| Unidade | 1 unidade = 1 metro |
| Raio planetário | 80 km – 220 km (`body.radius`) |
| Relevo | até ±3,2 km do datum |
| Altura do olho a pé | 1,7 m |
| Topo da atmosfera | `radius * 0.06` acima do datum |
| Órbita baixa | `radius + 25 km` a `radius + 120 km` |
| Distância entre planetas | 1e8 – 4e9 m |
| Rebase da origem | a cada 2 km de deslocamento da câmera |
| Velocidade a pé / nave atmo / impulso / warp | 6 / 300 / 20 000 / 1e8 m/s |

---

## 8. Critério visual (o que o crítico procura)

O revisor compara capturas do build com capturas reais de No Man's Sky, às
cegas. Os sinais que historicamente **denunciam** um protótipo:

1. **Silhueta do horizonte reta.** Um planeta de verdade curva. Da órbita
   baixa a curvatura tem de ser óbvia; do solo, sutil mas presente.
2. **Perspectiva aérea fraca.** Montanhas distantes precisam ser lavadas na
   cor do céu, com saturação caindo e matiz preservado.
3. **Paleta lavada ou fotorrealista-cinza.** NMS é cor saturada e
   complementar. Chão e céu em matizes que brigam.
4. **Vegetação esparsa e uniforme.** Precisa haver aglomeração (clusters),
   variação de escala e cobertura de solo densa perto da câmera.
5. **Céu chapado.** Precisa ter gradiente de espalhamento, nuvens com
   volume real e o disco solar com sangramento.
6. **Escala não legível.** Sem elementos de referência (rochas, plantas,
   arcos) o jogador não sente o tamanho. Distribua marcos.
7. **Iluminação plana.** Sombras longas, oclusão de contato, luz de rebote
   colorida vinda do chão.

---

## 9. Estilo de código

- ESM, sem transpilação. `const`/`let`, sem `var`.
- Comentários em pt-BR, explicando **por quê**, não o quê.
- Nada de `console.log` deixado em produção; use `ctx.debug.set()`.
- Reutilize vetores temporários no escopo do módulo — zero alocação por frame
  em caminhos quentes.
- Shaders: `onBeforeCompile` sobre materiais padrão do three quando der;
  `ShaderMaterial` completo apenas quando necessário.
