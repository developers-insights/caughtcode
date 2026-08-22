# Estado del proyecto — caughtcode

> Se actualiza **al cerrar cada sesión** y al terminar cada subsistema.
> Formato de fecha: `YYYY-MM-DD`.

---

## 📍 Dónde estamos ahora

**Fase:** Construcción cerrada. Motores, base, diseño, pantallas y cola terminados. 6 de 7 tipos de trabajo tienen handler real (`build_tutorials` es una capacidad **declarada y no construida** a propósito — ver más abajo).
**Falta una sola cosa para que el sistema funcione de punta a punta en producción:** cargar **tres secretos** en Railway. Nada más. Ver la sección de acá abajo.
**Última sesión:** 2026-08-22.

---

## ⚡ 2026-08-22 — El worker vive en Railway y el pipeline quedó probado contra repos reales

### Lo único que falta: tres secretos

El worker está creado, construido y esperando. Está **CRASHED** y va a seguir así hasta que se carguen
estas variables en **Railway → proyecto `caughtcode` → servicio `caughtcode-worker` → Variables**
(pegar en el RAW Editor y hacer click en **Deploy** en el banner violeta):

| Variable | Bloquea | De dónde sale |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | **El arranque.** Es la causa exacta del CRASHED | Panel de Supabase → proyecto `ktmbtpuhqqofdkisqseq` → Settings → API → `service_role` |
| `ANTHROPIC_API_KEY` | Agente navegador, guion de video, resumen del análisis | console.anthropic.com → API Keys. Puede ser la misma de Vercel |
| `ENCRYPTION_KEY` | Descifrar credenciales guardadas | **Tiene que ser idéntica a la de Vercel.** Sacarla de ahí, no generar una nueva: con otra clave el worker no puede descifrar lo que cifró la app |
| `AZURE_SPEECH_KEY` + `AZURE_SPEECH_REGION` *(opcional)* | Narración de los videos | Sin ellas el video sale mudo, solo con subtítulos |
| `GITHUB_APP_*` *(opcional)* | Repos **privados** | Los públicos ya andan pegando la dirección |

Las otras **12 ya están cargadas**. Guía completa: `docs/DEPLOY-RAILWAY.md`.

### Railway: creado y verificado

| Qué | Valor |
|---|---|
| Proyecto | `caughtcode` · `06a7f9c6-9e8e-4eab-afd5-d32703e9f497` |
| Servicio | `caughtcode-worker` · `acf08c23-dd4e-421a-9658-c34dfc521931` |
| Entorno | `production` · `0cc83e06-23a9-4443-9920-3b7ab1939ab1` |
| Fuente | `developers-insights/caughtcode`, rama `main`, autodeploy en cada push |
| Config | `ON_FAILURE` con 10 reintentos · sin sleep · sin dominio (no sirve HTTP) · `WORKER_CONCURRENCY=1` |

**El `Dockerfile` construye.** Era el riesgo abierto más grande —nunca se había corrido, no hay Docker
en la máquina de desarrollo— y salió sin un solo ajuste: imagen de 1.13 GB sobre
`mcr.microsoft.com/playwright:v1.62.1-noble`, `pnpm install --frozen-lockfile` sin tocar el lockfile,
`/data/caughtcode-storage` con dueño `pwuser`. **El punto 2 de "Lo que sigue" del 2026-08-12 queda cerrado.**

Decisión registrada en `DECISIONS.md` como **D20**.

### El pipeline produce hallazgos reales sobre repos reales

Nuevo: `pnpm auditar [url]` (`scripts/auditar-repo-real.ts`). Encadena ingesta → índice → chequeos
sobre un repo público, sin base de datos, sin cola y **sin `ANTHROPIC_API_KEY`** (`usarModelo: false`,
determinístico). Verifica además las tres reglas duras en cada corrida.

Probado contra cuatro repos, con hallazgos verificables en todos:

| Repo | Resultado |
|---|---|
| `vercel/nextjs-postgres-nextauth-tailwindcss-template` | 41 archivos · **`/api/seed` sin autenticación** (`app/api/seed/route.ts:5`), estado vacío sin contemplar, campos sin nombre |
| `supabase/supabase-js` | **tabla `users` sin RLS** en 17 lugares · dos `.env.local.ci` versionados |
| `steven-tey/precedent` | pantalla vacía sin estado, carga en blanco, sin pantalla de 404 |
| `calcom/cal.com` | **6509 archivos · índice en 5,3 s · chequeos en 4,9 s** — el riesgo de "los repos grandes rompen el procesamiento" no se materializó |

### Seguridad: las 10 RPC expuestas están bien, y ahora hay red que lo prueba

`get_advisors` marca 10 funciones `SECURITY DEFINER` invocables por `authenticated`. Se auditaron las
diez **con explotación real** (JWT de un tercero contra datos de otra organización, todo dentro de
`begin; … rollback;`): las diez validan al llamante. `delete_account` exige ser el dueño,
`delete_project_cascade` exige admin —no alcanza con ser miembro—, los cuatro `org_of_*` devuelven
`NULL` a un ajeno. **Cero migraciones necesarias.**

Lo que hace que esto no sea un falso verde: controles negativos (el dueño legítimo sí puede) y una
**prueba de mutación** —se reemplazó `org_of_project` por la versión sin chequeo y el test lo detectó—.
Red nueva: `supabase/tests/rpc_autorizacion.sql`. `anon` sigue en 0 funciones.

Verificado aparte: los llamantes de las dos funciones de borrado **sí** eliminan los objetos de Storage
que la función devuelve. El rollback de onboarding los ignoraba y quedaba basura en el bucket — corregido.

### `pnpm lint` volvió a correr después de meses, y costó caro haberlo perdido

No era cuestión de actualizar: **ninguna versión publicada de `typescript-eslint` soporta TypeScript 7**,
y el side-by-side con TS 6 que recomienda el equipo de TypeScript tampoco aplica acá (`node-linker=hoisted`
impide dos versiones de `typescript` en el árbol). Se migró a **oxlint** (D21) y ESLint salió del proyecto.

Al volver a correr aparecieron **27 errores** que llevaban meses invisibles, en un producto cuyo trabajo
es encontrarle esos mismos problemas a las apps ajenas. Uno era un bug real: `source-drop-zone.tsx` tenía
un `<input type="file">` **dentro** de un `<div role="button">` (HTML inválido). Ahora es un `<button>`
de verdad con el input como hermano.

### Deuda del 2026-08-12, cerrada

| Pendiente | Estado |
|---|---|
| Falta el cartel de precio antes de re-analizar (regla dura #3) | **Cerrado.** El precio se calcula en el servidor (`estimarRevisionAction`) y baja resuelto; `pricing.ts` nunca viaja al cliente. Si la estimación falla, **no se encola igual**: se bloquea y se pide reintentar |
| "Volver a revisar" era un botón muerto | **Cerrado.** Ahora dispara la revisión con su cartel de precio, y aparece solo cuando tiene sentido |
| `TRABAJOS_DE_REVISION` duplicado en dos archivos | **Cerrado.** Fuente única en `@/lib/types/domain` |
| `last_error` mostraba jerga cruda de Postgres | **Cerrado.** `EstadoDeRevision.fallada.motivo` pasó de `string` a `ErrorLegible { mensaje, detalle }` — el cambio de tipo hace que mostrar el crudo sea un acto deliberado. 8 familias de error traducidas; lo que no se reconoce se admite y el crudo queda plegado |
| El código de las corridas se acumulaba sin borrarse | **Cerrado, y el agujero era más grande de lo que decía este documento.** El borrado por corrida ya existía en `reconcileRunStatus()`, pero **corre en el proceso que cierra la corrida, que no siempre es el que bajó el código**: el worker de Railway baja a `/data` y el tick de Vercel puede cerrar la corrida desde otra máquina — ese `rm` iba al disco equivocado. Nuevo `barrerCodigoHuerfano()` (`src/server/jobs/limpieza.ts`), enganchado en el `finally` de `runClaimedJob()`: cada proceso barre su propio disco. Solo borra si pasa las tres: nadie la tocó hace 6 h, la corrida no está `running`, y ningún trabajo suyo está pendiente. **Si la base no contesta, no borra nada** |
| Corridas colgadas `7713e31f` y `4f81ed96` | **Ya no existen.** Verificado en la base: 0 trabajos `queued`/`running` |
| Deployar a Vercel | **Hecho.** El merge a `main` lo disparó; la app responde y redirige a `/entrar` |

### `build_tutorials`: capacidad declarada, no construida — a propósito

No se inventó la feature (no hay especificación, y el repo exige `brainstorming` antes). Lo que se hizo
es que **degrade de forma honesta**: `CAPACIDADES_SIN_MOTOR` en `src/server/jobs/registry.ts` lo declara
explícitamente, y `HandlerNotRegisteredError` ahora distingue dos casos que antes se confundían —
capacidad sin motor vs. módulo que no cargó en este proceso (el caso real de Playwright en Vercel).
Decirle "todavía no lo construimos" a alguien cuyo video sí existe pero no cargó sería mentirle.
Hay un test que **escanea `src/` entero** y falla el día que alguien lo encole sin registrar handler.

### Accesibilidad: los 27 errores, y lo que había abajo

Cerrados los 27. Pero lo valioso no fueron los errores sino lo que destaparon:

- **Un tooltip que nunca aparecía en celular.** `severity-indicator.tsx` usaba `<span tabIndex={0}>`
  y `<Tooltip>` abre con `onFocusCapture`: en iOS un span con `tabindex` no se enfoca al tocarlo, así
  que la aclaración de confianza del hallazgo **no se veía nunca**. Ahora es un `<button>` real.
- **React había dejado de optimizar el reproductor entero.** Tres `useCallback` en `video-player.tsx`
  cuya dependencia era `videoRef ?? propio` — el compilador no lo reconoce como ref, infiere
  `ref.current`, y ante la discrepancia abandona la optimización del componente completo.
- **Un diálogo que se cerraba mostrando el texto de confirmación** durante un pintado
  (`confirm-dialog.tsx`), y el tablero de hallazgos pintando una vez con la lista vieja después de
  `router.refresh()`. Los dos por ajustar estado en un efecto en vez de durante el render.
- **`<input type="file">` dentro de un `<div role="button">`** en `source-drop-zone.tsx` — HTML
  inválido. Ahora es un `<button>` real con el input como hermano.

**Subtítulos del video — resuelto a medias, y conviene saber por qué.** El `<video>` no tenía
`<track>`: los subtítulos se pintaban como un `<p>` propio encima. Quien mira la pantalla los veía,
pero para el navegador, el lector de pantalla y el reproductor nativo de iPhone **ese video no tenía
subtítulos**. Ahora emite un `<track kind="captions">` real construido de `video.script`.

Lo incómodo que apareció mirando: **el servidor ya genera un `.vtt` mejor y lo tira**.
`src/server/video/subtitles.ts` corta por frase con tiempos medidos del audio real de TTS, e
`index.ts:363` lo escribe como `subtitulos.vtt` — pero `vttPath` no se usa en ningún otro lado: se
queda en el directorio de trabajo del render y nunca se sube a Storage. Los cues que emite el cliente
son por escena y con tiempos estimados: es lo mismo que ya se mostraba en pantalla, no una regresión,
pero tampoco es lo mejor que el sistema sabe producir.

**No se conectó, a propósito.** Requiere subir el artefacto a Storage y agregar una columna a
`videos_caughtcode` (migración en la base compartida con el otro producto), y hoy **el beneficio es
cero: no existe ningún video renderizado**. Es el próximo paso natural del frente de video, con el
camino ya identificado.

**Dos bugs del reproductor arreglados en el paso siguiente:** el botón de pantalla completa no hacía
nada en iPhone (`requestFullscreen` no existe sobre un `<div>` en iOS Safari; ahora cae a
`webkitEnterFullscreen()` sobre el `<video>`), y los atajos de teclado morían apenas tocabas un botón
—el foco se quedaba ahí y el guard cortaba todo—, así que justo después de darle play el teclado
quedaba mudo. Ahora solo se le ceden al botón Espacio y Enter, que son las teclas que le pertenecen.

**Queda anotado, no resuelto:** el contenedor del reproductor sigue con `tabIndex={-1}`, así que quien
navegue solo con teclado llega a los botones pero no a los atajos. Hacerlo tabulable agrega una parada
al recorrido y no se puede evaluar bien sin un video a la vista.

### Estado verificado (2026-08-22)

| Qué | Estado |
|---|---|
| `pnpm typecheck` | limpio |
| `pnpm test` | **1007 tests, 70 archivos** (eran 942) |
| `pnpm build` | compila |
| `pnpm lint` | **0 errores** — corre por primera vez en meses |
| `docker build` | **construye** (primera vez, en Railway) |
| Base de datos | 1 org · 4 proyectos · 204 hallazgos · 6 corridas · **0 trabajos pendientes** · 0 videos |

---

## 🔥 2026-08-12 — Ninguna auditoría se completó nunca en Vercel

Las tres corridas con hallazgos (180 y 12) las produjo el worker local (`pnpm worker`). En producción, **cero**. Diagnóstico con evidencia, no con hipótesis.

### La causa raíz

`/api/worker/tick` corre en **Fluid Compute con concurrencia elástica**: varias invocaciones comparten los 2 GB de UNA instancia. Cada una carga ~250 MB solo en `registerAllHandlers()` (medido: 62 → 226 MB). El cron dispara cada 60 s sin coordinación, los trabajos tardan minutos, se apilan, y Vercel mata la instancia entera:

```
Vercel Runtime Error: instance was killed because it ran out of available memory
```

Reproducido dos veces el mismo día. **No era lentitud**: `buildCodeIndex` sobre el repo real de hiddenwire-app (394 archivos) tarda **1,2 s**.

### Los cinco bugs y cómo quedaron

| # | Qué pasaba | Arreglo |
|---|---|---|
| 1 | La instancia moría y el trabajo quedaba `running` con lease vivo. A los 3 intentos, `failed` — pero en SQL, sin pasar por `reconcileRunStatus()`. La corrida quedaba `running` **para siempre** | El RPC devuelve filas y el servidor reconcilia. Candado con vencimiento en la base (no advisory lock: con el pool de PostgREST puede quedar tomado para siempre). Handlers por `kind`. Un trabajo por tick. Lease 300 → 90 s |
| 2 | `ingest_repo` dejaba el código en `/tmp`, que no sobrevive entre invocaciones. `walkFiles()` no falla: devuelve 0 archivos → **informe en blanco marcado como exitoso** | Rehidratación desde la copia de Storage; un índice de 0 archivos falla en vez de escribirse |
| 3 | `run_browser_agent` y `generate_video` nunca se registraban (`playwright-core/browsers.json` no existe en serverless). Todo proyecto con app publicada se quedaba sin auditoría | Worker dedicado en Render (`Dockerfile` + `render.yaml`). `index_code` encola la revisión como red: el agente la adelanta con su evidencia en vez de encolar otra |
| 4 | La pantalla giraba para siempre, sin un log | Detección de corrida abandonada, agregada sobre todos los trabajos, con el reloj del servidor |
| 5 | Los 11 chequeos que dependen del navegador se reportaban como **"revisado, todo bien"** cuando el agente nunca corrió | Insumo `browser_run` separado de `deployed_app` |

### Seguridad (auditoría dedicada, todo aplicado)

- `jobs_caughtcode.payload` guardaba el `databaseUrl` **en claro** y cualquier miembro de la organización lo leía con un `GET`. Había **11 filas expuestas**. Migraciones `0017` (revoke columna por columna — `revoke select (payload)` sobre un grant de tabla no hace nada) y `0018` (limpieza). El secreto ya no se escribe: `src/server/ingest/conexion.ts`.
- `storage_path` lo escribe cualquier miembro y el worker lo obedecía con `service_role`, que ignora las políticas de Storage → se podía traer el código de otra organización. Validación de prefijo `<org_id>/<project_id>/` + trigger guarda (`0019`).
- Los mensajes de error arrastraban el texto crudo de Storage, con la ruta del bucket, hasta la pantalla.

### Estado verificado (2026-08-12)

| Qué | Estado |
|---|---|
| `pnpm typecheck` · `pnpm test` · `pnpm build` | limpio · **942 tests, 65 archivos** · compila |
| Migraciones `0016`–`0019` | **aplicadas y verificadas** contra `ktmbtpuhqqofdkisqseq` |
| Advisors de seguridad | ninguna función nueva del worker expuesta a `anon`/`authenticated` |
| Rama | `arreglo/pipeline-auditorias`, 4 commits, **sin deployar** |

### Lo que sigue

1. `RENDER_API_KEY` en `.env.deploy.local` → crear el Background Worker.
2. **`docker build` nunca se corrió** (no hay Docker en la máquina). Primera prueba real en Render.
3. Deployar el código a Vercel (las migraciones ya están y son compatibles hacia atrás).
4. Destrabar las dos corridas colgadas: `7713e31f` y `4f81ed96`.
5. `purgeExpired()` sigue sin llamador: cubre la carpeta huérfana de una corrida que nunca cerró, y el proyecto borrado.
6. Faltan en Vercel: `GITHUB_APP_CLIENT_SECRET`, `AZURE_SPEECH_KEY`/`REGION`, `STRIPE_*`.

### Verificado con comando corrido (repo completo, ahora mismo)

| Qué | Estado |
|---|---|
| `npx tsc --noEmit` | **0 errores** |
| `npx vitest run` | **755 tests, 53 archivos, todos en verde** |
| `pnpm build` | **verde por primera vez.** Requirió arreglar dos cosas que ni `tsc` ni los tests ven — quedaron en `MEMORY.md` |
| `pnpm lint` | **CAÍDO para todo el repo** — `typescript-eslint@8.66` no soporta `typescript@7.0.2` |
| Aislamiento entre organizaciones | Probado en los dos sentidos con PGlite (Postgres 17 real) |
| **Migraciones contra la base real** (`ktmbtpuhqqofdkisqseq`) | **Aplicadas y verificadas.** 16 tablas `_caughtcode`, RLS *enabled + forced* en las 16, 64 policies, 15 funciones con `search_path` fijado, 3 buckets privados con límite. 0 filas |
| Advisors (corridos a mano por SQL, el conector MCP no llega a esa base) | Sin llaves foráneas sin índice. **4 policies con `auth.uid()` sin envolver en subconsulta** → pendiente menor de performance |
| **Bajar un repo público de GitHub sin token** | **Probado de verdad** con `scripts/probar-repo-publico.ts`: bajó `vercel/nextjs-postgres-nextauth-tailwindcss-template` (0,08 MB en 1,1 s), extrajo 41 archivos y reconoció Next.js + App Router + TypeScript + Tailwind + Drizzle. Repo inexistente devuelve `code = no_existe` |
| Handlers registrados en la cola | **6 de 7**: `ingest_repo`, `index_code`, `run_checks`, `run_browser_agent`, `generate_video`, `scan_comments`. Falta solo `build_tutorials` (no tiene motor todavía) |

### Subsistemas

| # | Frente | Estado |
|---|---|---|
| Datos / RLS | ✅ cerrado — 16 tablas `_caughtcode`, 64 policies, RLS forced en todas, `ensure_org_caughtcode()` en vez de trigger sobre `auth.users` (compartida con otro producto) |
| Diseño | ✅ cerrado — 27 primitivas, shell, `docs/DESIGN.md`, tokens semánticos |
| Cola de trabajos | ✅ motor cerrado — lease + backoff + etapas reanudables. **Solo `run_checks` está enchufado** (ver gap abajo) |
| Ingesta + análisis | ✅ motor cerrado — tree-sitter confirmado corriendo, 91 tests. **Sin handler de cola** |
| Chequeos | ✅ cerrado — 44 chequeos, 113 tests, handler de `run_checks` enchufado y probado con idempotencia |
| Agente navegador | ✅ motor cerrado — Playwright + grabación, 69 tests. **Sin handler de cola**. Nunca corrió con modelo real (falta `ANTHROPIC_API_KEY`) |
| Video | ✅ motor cerrado — D11 resuelta (HTML+Playwright+ffmpeg, no Remotion), 121 tests, video real verificado con `ffprobe` y a ojo. **Sin handler de cola** |
| Comentarios (feature pedida por Manuel) | ✅ motor cerrado — dogfooding sobre este mismo repo: 1.951 comentarios clasificados, 0 directivas rotas en los dos modos. **Sin handler de cola** |
| Pantalla de hallazgos | ✅ cerrada — verificada en navegador, 375 y 1280, los dos temas |
| Pantalla de comentarios | 🔄 corriendo al cerrar la sesión |
| Auth + onboarding + proyectos | ✅ cerrado — verificado en navegador. Encontró y arregló un cruce inválido de función servidor→cliente en `/cuenta` |
| Chat + tutoriales | ⬜ sin empezar |
| Monetización | ⬜ sin empezar (motor de costos y estimación previa ya existen en `src/server/cost/`) |
| Landing + legales | ⬜ sin empezar (copy ya escrito en `src/content/copy.ts` → `LANDING`) |

### Escrito por el orquestador (no delegable — criterio de marca)

- `src/content/catalogo.ts` — 40 hallazgos con título, explicación, impacto y prompt de arreglo
- `src/content/lenguaje.ts` — diccionario jerga→llano + `detectarJerga()`
- `src/content/copy.ts` — landing, onboarding, estados, sección de comentarios
- `docs/CONTRACTS.md` — contrato normativo, incluida la regla del sufijo `_caughtcode`

---

## 🔌 La cola, ya enchufada

`src/server/jobs/handlers.ts` importa los seis módulos que existen. El único tipo de trabajo sin
handler es `build_tutorials`, y es porque **su motor no está escrito**: son los videos de "cómo
funciona mi proyecto", distintos de los videos de hallazgo (esos sí funcionan).

**Cabos sueltos conocidos** (ninguno rompe el pipeline):

- El botón de la pantalla de comentarios sigue escaneando **dentro del request**, no por la cola.
  Anda, pero contradice la regla de que todo trabajo pesado va a una cola: con un repo grande el
  usuario mira una pantalla trabada. La acción que encola ya existe
  (`encolarEscaneoDeComentarios` en `comentarios/actions.ts`); falta sumarle un prop a
  `CommentsScreenProps` y diseñar el estado de espera.
- 4 policies con `auth.uid()` sin envolver en subconsulta (performance, no seguridad).

**Orden de encadenado — corregido en esta sesión.** Antes `index_code` encolaba `run_checks` y
`run_browser_agent` **en paralelo**, y eso era un bug de diseño: la revisión podía correr antes de
que el agente dejara su evidencia, y entonces los chequeos de cookies, sesión y experiencia de uso
se salteaban por falta de datos — justo lo que el producto promete encontrar. Ahora:

```
ingest_repo → index_code → ┬ (con dirección publicada) run_browser_agent → run_checks → generate_video ×3
                           └ (sin dirección)                                run_checks → generate_video ×3
```

`generate_video` se encola solo para los **3 hallazgos de mayor rango con evidencia demostrable**
(regla dura: máximo 3 "hacé esto ya"). `scan_comments` se encola aparte, desde su pantalla.

---

## 🔗 GitHub App conectada (2026-08-09, sesión de la tarde)

`caughtcode-dev` creada en la cuenta `@developers-insights` (App ID `4541372`), solo lectura
(Contents + Metadata), webhook desactivado (no hay endpoint todavía que lo escuche), instalada con
"All repositories". Verificado con `listInstallations()` directo, sin pasar por sesión: la ve.
Repos privados ya se pueden auditar desde el wizard.

**Pendiente real, no bloqueante hoy:** `listInstallations()` (`src/server/ingest/github.ts:90`) trae
**todas** las instalaciones de la App sin filtrar por quién la instaló — con un solo usuario no
importa, pero es un hueco multi-tenant real (viola la regla de `CLAUDE.md`). Falta una tabla que ate
cada instalación a la organización que la generó, más una ruta que la capture al volver de instalar.

## 🕳️ Tres destinos del menú que daban 404, arreglados (2026-08-09)

`nav-items.ts` y el botón "Ver todo lo que revisamos" apuntaban a rutas que nunca se crearon:
`/como-funciona`, `/chat` y `/facturacion`. Se dividió en dos arreglos distintos:

1. **Cobertura, construida de verdad** (no un placeholder): `analysis_runs_caughtcode.coverage`
   (migración 0012) guarda qué pasó con cada chequeo del catálogo — encontró algo, corrió limpio, se
   salteó y por qué, o no se pudo completar. Lo arma `run_checks` al terminar
   (`calcularCobertura()` en `src/server/checks/handlers.ts`) y lo muestra
   `/proyectos/[id]/hallazgos/cobertura`, agrupado por las tres áreas (`PILLAR_LABEL`). El botón de
   `findings-board.tsx` ya apunta ahí. 2 tests nuevos en `tests/checks/handlers.test.ts`.
   **Corridas viejas no tienen este dato** (la columna es nueva): para verlo hay que volver a revisar.
2. **Cómo funciona, Preguntar y Plan y pagos**: son features reales sin construir todavía (tutoriales
   en video, chat sobre el código, cobro). En vez de 404, ahora muestran un estado diseñado que dice
   la verdad — qué va a ser, que no está listo, y un camino de vuelta. Nada de UI de cobro fantasma:
   `facturacion` explícitamente dice que no se cobra nada todavía.

## ✅ Primera auditoría real de punta a punta (2026-08-10)

`alianzas-sabias` (repo privado de GitHub, 406 archivos) auditado completo en **52 segundos**:
`ingest_repo → index_code → run_checks`, los tres `succeeded`, corrida `succeeded`, **12 hallazgos
con 180 piezas de evidencia**. Costo medido: US$ 0,000055.

### Los seis bugs que lo impedían, todos encontrados corriendo el pipeline de verdad

Ninguno era detectable con `tsc` ni con los tests: todos aparecieron con un repo real.

1. **El RPC de la cola devolvía trabajos fantasma.** `claim_job_caughtcode` estaba declarado
   `RETURNS jobs_caughtcode` (tipo compuesto) y hacía `return null`, que PostgREST materializa como
   *una fila con todo en NULL*. El worker la tomaba como trabajo real → bucle infinito, ~2 fallas por
   segundo. Migración `0013`: `RETURNS SETOF`. Más guarda por `id` en `claim()` y un freno en el
   worker (`src/server/jobs/circuit.ts`).
2. **Los repos privados se bajaban por la vía anónima.** `sourceType.startsWith('github')` metía
   `'github'` (App) y `'github_public'` en el mismo camino sin token. Ahora decide por fuente
   (`src/server/ingest/fuente.ts`). **Decisión revisada:** el repositorio va **primero** y la copia de
   Storage queda de respaldo — al revés, la segunda auditoría analizaría el código viejo.
3. **Nadie cerraba nunca una corrida exitosa.** El único `markRunFinished` del repo estaba en el
   camino de falla de ingest. Una auditoría que terminaba bien conservaba el estado del último error,
   y la pantalla tapaba 180 hallazgos válidos con un cartel de error. Ahora
   `src/server/jobs/reconcile.ts` deduce el estado de la cadena de trabajos, y `reopenRun()` limpia el
   error al reintentar.
4. **El mapa del proyecto no entraba en la etapa.** `index_code` devolvía el `CodeIndex` completo
   (323 KB) contra un tope de 32 KB. Ahora escribe en `code_index_caughtcode` y la etapa devuelve un
   recibo de 122 bytes. **Vigilar:** `revisar_y_guardar` de `checks` está en 6,5 KB y crece con el
   catálogo de chequeos (llegaría al tope cerca de los 200 chequeos).
5. **180 hallazgos era un volcado, no un informe** (violaba la regla dura #2). `src/server/checks/agrupar.ts`
   agrupa por `checkId + severidad + confianza`; **180 → 12** conservando las 180 piezas de evidencia.
   No se agrupan nunca las credenciales expuestas (cada una necesita su propia rotación) ni lo que
   tiene grabación (el video se produce por hallazgo).
6. **La pantalla decía "no encontramos nada serio" sin haber revisado.** Ver más abajo.

### Seguridad — 11 funciones abiertas al mundo (migración 0014)

Los advisors destaparon que `revoke ... from public` **no alcanza**: los default privileges de
Supabase le dan `EXECUTE` a `anon` y `authenticated` a cada función nueva del schema `public`. Estaban
invocables desde `/rest/v1/rpc/` con la clave del navegador, incluidas `delete_account_caughtcode` y
`delete_project_cascade_caughtcode`. Verificado antes/después con explotación real: `org_of_project`
**le entregaba la organización a un llamante sin sesión**. Ahora `anon` = 0 funciones.

Además, los cuatro `org_of_*` traducían cualquier id a su organización **sin validar nada**, salteando
RLS. Ahora validan membresía.

**Causa raíz NO cerrada a propósito:** el `alter default privileges` del schema es del proyecto
compartido; cambiarlo afecta al otro producto. La red de contención es `supabase/tests/grants_rpc.sql`
— sumarlo al checklist de pre-release.

### Pendientes conocidos

- **Falta el cartel de precio antes de re-analizar** desde la pantalla de hallazgos (regla dura #3).
  El botón encola sin mostrar cuánto sale. Falta el copy y de dónde sacar la estimación.
- **"Volver a revisar" del encabezado apunta a `/proyectos/[id]`**, que redirige a hallazgos: es un
  botón que no hace nada.
- `TRABAJOS_DE_REVISION` está duplicado en `src/server/jobs/reconcile.ts` y `src/components/findings/view.ts`.
- `last_error` se muestra a la vista y puede traer jerga de errores de Postgres sin traducir.
- El agente de navegación **nunca corrió contra la base real** (el proyecto de prueba no tiene URL
  publicada), así que la rama `deployedUrl → run_browser_agent` está probada solo con tests.
- **Ningún video se generó todavía.**

## 🧪 Qué falta para la prueba real (2026-08-09)

1. **Registrarse en la app** (`/registro`) y crear el proyecto desde ahí. No se puede sembrar un
   usuario a mano: `auth.users` es **compartida con otro producto en producción** y crear filas ahí
   dispararía sus triggers. Es el único paso que no se puede automatizar sin permiso explícito.
2. **Una app publicada con dirección web.** Sin eso solo se lee el código: no hay agente navegando,
   no hay hallazgos de cookies ni de experiencia de uso, y no hay video.
3. **Clave de voz** (`AZURE_SPEECH_KEY` + `AZURE_SPEECH_REGION`). Sin ella el video sale sin
   narración, solo con subtítulos.
4. **GitHub App** — solo hace falta para repos privados. Los públicos ya funcionan pegando la
   dirección (probado, ver tabla de arriba).

---

## 🔐 Conexión a la base real — dónde quedó

caughtcode **no tiene proyecto propio**: vive en `ktmbtpuhqqofdkisqseq` ("Comunidad latina", org
"INSIGHTS manu"), compartido con otro producto en producción. Por eso todo objeto propio lleva
sufijo `_caughtcode` (ver `src/lib/db/tablas.ts`, que es la fuente de verdad — nunca escribir un
nombre de tabla a mano).

**El conector de Supabase de esta sesión no llega a esa base** (solo alcanza el org "Proyectos").
Se resolvió con el CLI de Supabase (`supabase link --project-ref ktmbtpuhqqofdkisqseq`, ya linkeado)
más conexión directa por `pg` (paquete ya instalado):

- El pooler (`aws-0-us-west-2.pooler.supabase.com`) da `tenant/user not found` — la región no
  coincide con el shard real. **Usar la conexión directa**: `db.ktmbtpuhqqofdkisqseq.supabase.co:5432`,
  usuario `postgres` (no `postgres.<ref>`).
- TLS: el pooler y la conexión directa usan una CA propia de Supabase (`Supabase Root 2021 CA`,
  autofirmada), no pública. **No desactivar `rejectUnauthorized`** — eso abre a un MITM real. La CA
  se extrae en caliente con `openssl s_client -connect db.<ref>.supabase.co:5432 -starttls postgres
  -showcerts` (queda en el `scratchpad` de la sesión, nunca en el repo) y se pasa como `ssl: { ca }`
  al cliente de `pg`.
- **Bloqueante actual:** `SUPABASE_DB_PASSWORD` en `.env.local` da `password authentication failed`.
  No es un problema de formato (sin caracteres que necesiten codificar). Es la confusión clásica de
  Supabase: la contraseña de la cuenta **no** es la contraseña de la base. Se resetea en
  *Settings → Database → Database password*.
- Con la contraseña correcta: correr `supabase/tests/preflight.sql` contra la base real (de solo
  lectura, termina en `ROLLBACK`, falla ruidoso si algo choca con lo que ya existe) **antes** de
  `supabase db push`. Después del push, `get_advisors` — obligatorio, y hay que leerlo filtrando por
  `_caughtcode`: los hallazgos del otro producto no son nuestros para arreglar.

---

## ❓ Decisiones cerradas en esta sesión

| Tema | Resolución |
|---|---|
| Base de datos compartida | Sin proyecto propio: todo con sufijo `_caughtcode` en `ktmbtpuhqqofdkisqseq` |
| Trigger sobre `auth.users` | **Eliminado**, no filtrado. Es tabla compartida con otro producto en producción; un bug nuestro ahí les rompía el registro a ellos. La organización se crea con `ensure_org_caughtcode()` desde el código, en el primer ingreso |
| `web-tree-sitter` | `0.20.8` — los `.wasm` de `tree-sitter-wasms` no son compatibles con `0.26` |
| D11 (motor de video) | **Cerrada**: HTML + Playwright + ffmpeg, no Remotion. La escena lee los tokens de diseño reales, cero licencia de terceros |
| Costo de render medido | `RENDER_COMPUTE_MINUTES_PER_VIDEO_SECOND = 0.019` (medido sobre 3 renders reales, reemplaza la estimación de `0.08`) |
| `usage_events.analysis_run_id` | `on delete set null`, no `cascade`: borrar un proyecto no borra la historia de lo que se cobró |
| Aristas `calls` en el grafo | No se emiten — sin resolución de tipos son una afirmación sin evidencia |
| Jerga en `fixPrompt` | Permitida cuando el destinatario es otro modelo (el texto se pega en Claude Code/Cursor). `titlePlain`/`explanationPlain`/`impactPlain` siguen sin excepción |
| `typescript` en `package.json` | Movido a `dependencies` — el motor de comentarios lo importa en runtime (TS7 no tiene parser separado del compilador) |

---

## 🚧 Bloqueantes reales

1. **`pnpm lint` no corre en todo el repo.** `typescript-eslint@8.66` no soporta `typescript@7.0.2`. Bajar TS a 6.x o esperar soporte.
2. **Falta `SUPABASE_DB_PASSWORD` correcta** — ver sección de conexión arriba.
3. **`get_advisors` nunca corrió** — depende del punto 2.
4. **Ningún motor probó con `ANTHROPIC_API_KEY` real** (agente navegador, guion de video, resumen de análisis) — todo probado con modelos falsos determinísticos.

---

## 📓 Bitácora

### 2026-08-09 — Construcción con agentes en paralelo, migración a base compartida

Sesión larga: Ola 1 y Ola 2 despachadas juntas, corte por límite de cuota a mitad (retomado sin
pérdida — todo estaba en disco), y a mitad de camino Manuel pidió mudar todo a una base de Supabase
compartida con sufijo `_caughtcode` en vez de un proyecto propio.

Hallazgos que costó encontrar:
- tree-sitter estaba **muerto** con las versiones instaladas; encenderlo reveló que además, con un
  archivo roto, perdía información que el lector simple sí recuperaba — se combinan los dos.
- El motor de comentarios colgaba hasta agotar memoria al escanear este mismo repo (bug cuadrático
  con `<` en JSX). Solo apareció haciendo dogfooding real, no en fixtures de laboratorio.
- Después del renombrado a `_caughtcode`, `queue.ts` y `ledger.ts` — el corazón de la cola y el
  costo — seguían escribiendo en los nombres de tabla viejos. Los tests no lo detectaban porque su
  base falsa usaba los mismos nombres viejos. Es exactamente el riesgo que el sufijo existía para
  evitar, y pasó desapercibido hasta un chequeo manual cruzando `src/` completo.

🤖 MODELO: Opus · RAZONAMIENTO: Alto
