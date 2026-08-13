# Desplegar el worker en Render

> Guía operativa para poner en marcha `pnpm worker` (`scripts/worker.ts`) como
> Background Worker en Render. Está pensada para alguien que no tiene todo el
> contexto de esta migración en la cabeza — si algo acá no coincide con lo que
> ves en el dashboard de Render, es más probable que haya cambiado la doc de
> Render que este texto; revisá [render.com/docs/blueprint-spec](https://render.com/docs/blueprint-spec).

## Por qué existe esto

El worker corría hasta ahora en Vercel, disparado por un cron cada 60s contra
`/api/worker/tick`. Dos problemas de fondo, verificados en producción:

1. **OOM**: `Vercel Runtime Error: instance was killed because it ran out of
   available memory`. Bajar un repo, indexarlo con tree-sitter, correr Playwright
   y renderizar video con ffmpeg son minutos de trabajo pesado — no entra en el
   presupuesto de memoria de una función serverless.
2. **Playwright no se empaqueta**: estaba en `devDependencies`, así que Vercel
   nunca lo sube al bundle de producción, y aunque estuviera en `dependencies`
   los navegadores (Chromium) no vienen instalados en el runtime serverless.
   Cada tick logueaba:
   ```
   [jobs] no se pudo cargar "agent": Cannot find module '/var/task/node_modules/playwright-core/browsers.json'
   [jobs] no se pudo cargar "video": Cannot find module '/var/task/node_modules/playwright-core/browsers.json'
   ```

La solución: un **Background Worker** en Render (proceso largo, sin HTTP, sin
límite de duración por request), con Chromium preinstalado vía la imagen
oficial de Playwright. El cron de Vercel **no se apaga** — queda como red de
seguridad para tandas cortas si el worker de Render está caído (ver más abajo).

---

## 1. Crear el servicio desde el Blueprint

1. Confirmar que `render.yaml` (raíz del repo) está commiteado en la rama que
   se va a desplegar. `pnpm-lock.yaml` ya tiene `playwright` en el bloque de
   `dependencies` (verificado: `pnpm install --frozen-lockfile` pasa sin
   tocar el lockfile), así que no hace falta ningún paso extra antes de esto.
2. En el dashboard de Render: **New → Blueprint**.
3. Conectar el repo `vibecoder-copilot` (o el nombre que tenga en GitHub/GitLab
   conectado a la cuenta de Render de la empresa — Render ya está pago, según
   contexto de la tarea).
4. Render detecta `render.yaml` y muestra el servicio `caughtcode-worker`
   (`type: worker`, `runtime: docker`). Revisar que el plan mostrado sea **Pro**
   (ver justificación de memoria abajo) antes de confirmar.
5. Render va a pedir, uno por uno, el valor de cada variable declarada con
   `sync: false` en `render.yaml` (lista completa en la próxima sección). **No
   hay defaults ni placeholders en el repo** — a propósito, para no correr el
   riesgo de commitear un secreto real por accidente.
6. Confirmar → Render clona el repo, construye la imagen con el `Dockerfile` de
   la raíz y arranca `pnpm worker` como comando del contenedor.

### Plan recomendado: **Pro (4 GB RAM / 2 CPU)**

Justificación con números reales, no con el default de Render:

| Componente | Memoria estimada |
|---|---|
| Worker en reposo (Node + módulos cargados) | ~250 MB (medido) |
| Chromium por contexto de trabajo tipo `agent` | ~300–500 MB |
| `WORKER_CONCURRENCY` default (`scripts/worker.ts`) | **2** → hasta 2 trabajos a la vez |
| Peor caso: 2 trabajos `agent` en paralelo | 250 + (2 × ~500) ≈ **1.250 MB** solo en base + Chromium |
| Índice del repo en memoria (tree-sitter/AST) | variable, no acotado — repos grandes suman cientos de MB más |
| `ffmpeg-static` (subproceso del renderer de video) | suma al mismo contenedor aunque no sea heap de Node |

Sumando todo, el peor caso realista se acerca o supera los 2 GB del plan
**Standard**, con poco margen para picos de GC, un repo grande, o un trabajo de
video corriendo al mismo tiempo que uno de agente. **Pro** (4 GB / 2 CPU) da
~2× de margen sobre el peor caso estimado, y el segundo CPU importa tanto como
la memoria: con concurrencia 2 sobre 1 solo core (Standard), Chromium y ffmpeg
compiten por el mismo CPU y el trabajo se hace más lento, no solo más ajustado
de RAM.

**Alternativa más barata, si el costo de Pro no cierra**: fijar
`WORKER_CONCURRENCY=1` (variable de entorno que hoy no está declarada en
`render.yaml` — se agrega a mano si se toma esta decisión) y usar **Standard**
(2 GB / 1 CPU). Con concurrencia 1 el peor caso baja a ~250 + 500 + índice, que
entra cómodo en 2 GB. El trade-off es procesar los trabajos de a uno: si se
encolan varios seguidos, se hacen cola en vez de superponerse. **Decisión
abierta para el dueño del producto** — no se tomó una por él, ver sección de
decisiones al final.

---

## 2. Variables de entorno — de dónde sale cada valor

Todas están declaradas en `render.yaml` con `sync: false` (Render las pide al
crear el Blueprint, no viven en el repo).

| Variable | De dónde sale |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Dashboard de Supabase → Project Settings → API. Mismo valor que usa Vercel hoy (ver `.env.local` / variables de Vercel del proyecto) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Dashboard de Supabase → Project Settings → API → `anon` `public` |
| `SUPABASE_SERVICE_ROLE_KEY` | Dashboard de Supabase → Project Settings → API → `service_role`. **Secreto de máximo privilegio** — nunca en el repo, nunca en logs |
| `ENCRYPTION_KEY` | La misma clave que ya usa el proyecto en Vercel para cifrar credenciales guardadas (ej. tokens de GitHub). Tiene que ser **idéntica** a la de Vercel: si difiere, el worker no puede descifrar lo que cifró la app y viceversa |
| `ANTHROPIC_API_KEY` | Console de Anthropic (console.anthropic.com) → API Keys. Puede ser la misma que usa Vercel, o una key separada para el worker si se quiere medir costo por separado |
| `ANTHROPIC_MODEL` | Mismo valor que usa la app (hoy `claude-sonnet-5` en `.env.example`) |
| `CAUGHTCODE_STORAGE_DIR` | **Elegir un valor nuevo para el worker**, ej. `/data/caughtcode-storage`. Ver la sección siguiente — es una ruta del filesystem efímero del contenedor, no un disco persistente de Render |
| `WORKER_SECRET` | Un secreto random propio para este entorno (ej. `openssl rand -hex 32`). Hoy lo usa `/api/worker/tick` como uno de los dos secretos aceptados (junto a `CRON_SECRET`) — si el worker de Render alguna vez necesita pegarle a ese endpoint, comparten este valor. Si no lo va a usar, igual documentarlo/generarlo por consistencia con `src/lib/env.ts` |
| `GITHUB_APP_ID` | Configuración de la GitHub App del proyecto (GitHub → Settings → Developer settings → GitHub Apps) |
| `GITHUB_APP_SLUG` | Idem, el slug de la app |
| `GITHUB_APP_CLIENT_ID` | Idem |
| `GITHUB_APP_CLIENT_SECRET` | Idem — secreto |
| `GITHUB_APP_PRIVATE_KEY` | El `.pem` de la GitHub App, pegado como texto. `src/lib/env.ts` hace `.replace(/\\n/g, '\n')`, así que tanto pegarlo con saltos de línea reales como con `\n` escapados funciona |
| `TTS_PROVIDER` | `azure` (valor actual en `.env.example`) |
| `AZURE_SPEECH_KEY` | Portal de Azure → recurso de Speech → Keys |
| `AZURE_SPEECH_REGION` | Idem, la región del recurso |
| `AZURE_SPEECH_VOICE` | Mismo valor que la app, hoy `es-AR-TomasNeural` |
| `VIDEO_RENDERER` | `web` (valor actual — HTML + Playwright + ffmpeg, no Remotion; ver `docs/DECISIONS.md` si existe una entrada al respecto) |
| `NEXT_PUBLIC_APP_URL` | La URL pública de la app en Vercel (ej. `https://caughtcode.app` o el dominio que corresponda). El worker no sirve HTTP con esto, solo arma links en videos/reportes |

**Nota sobre `CAUGHTCODE_STORAGE_DIR` — disco efímero, no disco persistente:**
El filesystem de un contenedor de Render **sí sobrevive mientras el proceso
vive** (solo se pierde en un redeploy o restart) — eso es justo lo que hace
falta para encadenar los jobs de una misma corrida (`ingest → index → checks →
agent → video`, todos leyendo/escribiendo bajo el mismo `<storageDir>/<projectId>/<runId>/`).
No se declara un **Render Disk** (persistente entre redeploys, con costo por
GB) porque nada de esto necesita sobrevivir un redeploy — pagar por eso sería
costo sin beneficio. Recomendado: `CAUGHTCODE_STORAGE_DIR=/data/caughtcode-storage`
— el `Dockerfile` ya crea `/data/caughtcode-storage` y le da dueño a `pwuser`
(el usuario no root con el que corre el proceso) antes de arrancar, así que no
hace falta crear el directorio a mano ni preocuparse por permisos. Si se
cambia `CAUGHTCODE_STORAGE_DIR` a otra ruta fuera de `/data`, hay que tocar el
`Dockerfile` para que esa ruta también quede con dueño `pwuser` —
`createWorkspace()` hace `mkdir(..., { recursive: true })`, pero como proceso
no root no puede crear directorios en rutas que no le pertenecen, y **tampoco
puede escribir bajo `/app`**, que en este Dockerfile queda a propósito con
dueño root (ver el comentario del `Dockerfile` junto al `chown` de `/data`).

**Importante — esto NO borra el código de cada corrida solo:** a diferencia de
lo que decía una versión anterior de esta nota, verificado por lectura de
código que `deleteRunCode`/`purgeExpired` (`src/server/ingest/retention.ts`)
existen pero **no los llama nadie** desde el camino de trabajos
(`src/server/jobs/**`), y `withWorkspace`/`removeWorkspace`
(`src/server/ingest/workspace.ts`) solo se usan hoy desde el onboarding
(`src/app/(app)/proyectos/nuevo/actions.ts`), no al terminar una revisión. En
Vercel esto no se notaba porque `/tmp` moría solo con cada invocación; acá el
proceso vive días, así que **el código de todas las corridas se va acumulando
en `CAUGHTCODE_STORAGE_DIR` hasta el próximo redeploy o restart del servicio**
— hoy no hay tope de tamaño ni limpieza automática ligada al fin de una
corrida.

Mientras eso no esté resuelto (es tarea de otro frente, no de este documento):

- **Vigilar el tamaño real del disco.** Desde el shell de Render
  (dashboard del servicio → **Shell**): `du -sh /data/caughtcode-storage`. No
  hay una métrica nativa de "uso de disco del filesystem efímero" en el
  dashboard de Render para Background Workers — hay que entrar y mirar a mano,
  o programar un chequeo propio.
- **Mitigación de corto plazo**: un redeploy manual (o el que dispara
  `autoDeployTrigger: commit` en cada push) limpia todo el filesystem efímero
  de una. No es una solución, es un remiendo — si el volumen de corridas crece
  antes de que se resuelva el borrado automático, puede hacer falta redeployar
  solo para liberar espacio.
- Cuando el borrado automático quede enganchado (candidato natural:
  `reconcileRunStatus()` en `src/server/jobs/reconcile.ts`, que ya es el lugar
  donde se decide que una corrida terminó), esta sección hay que reescribirla
  para describir el mecanismo real en vez de este apartado de vigilancia
  manual.

---

## 3. Verificar que el worker levantó y está tomando trabajos

### En los logs de Render

Al arrancar, `scripts/worker.ts` loguea (ver `main()` en ese archivo):

```
caughtcode worker worker-xxxxxxxx arriba.
  tipos: ingest_repo, index_code, run_checks, run_browser_agent, generate_video, scan_comments, build_tutorials
  concurrencia: 2 · lease: 90s
  sin handler todavía: build_tutorials
```

Si falta alguna de las líneas `[jobs] no se pudo cargar "..."` que aparecían en
Vercel (`agent`, `video`), es la confirmación de que Playwright y Chromium
están disponibles en este entorno — que es el problema #2 de la sección
"Por qué existe esto", resuelto.

Cuando toma un trabajo:

```
Tomado: run_browser_agent a1b2c3d4 (intento 1/3)
run_browser_agent a1b2c3d4 → succeeded en 42.3s (US$ 0.0180)
```

### En la base (tabla `jobs_caughtcode`)

Con el SQL Editor de Supabase o el MCP de Supabase:

```sql
select id, kind, status, attempts, lease_until, updated_at
from public.jobs_caughtcode
order by updated_at desc
limit 20;
```

- `status = 'running'` con `lease_until` en el futuro → un worker (Render o el
  cron de Vercel) lo tiene tomado ahora mismo.
- `status = 'queued'` con `run_after` en el pasado y que no cambia de estado
  en varios minutos → nadie lo está tomando. Revisar que el worker de Render
  esté arriba (Render dashboard → el servicio → Logs, o **Events** para ver si
  se reinició).
- Contar trabajos por `status` para un pulso rápido:
  ```sql
  select status, count(*) from public.jobs_caughtcode group by status;
  ```

---

## 4. Rollback

Render guarda cada deploy del servicio. Si el nuevo deploy rompe algo:

1. Dashboard de Render → servicio `caughtcode-worker` → pestaña **Events** (o
   **Deploys**, según la versión del dashboard).
2. Elegir el deploy anterior que estaba sano → **Rollback to this deploy** (o
   **Redeploy**, según la UI vigente — confirmar en el dashboard, esto puede
   cambiar de nombre).
3. Mientras el rollback no está listo, el cron de Vercel sigue vivo y sigue
   procesando lo que entra en su ventana de 300s por tick — el sistema no se
   detiene del todo, solo pierde el throughput del worker largo.
4. Si el problema es de código (no de infraestructura), revertir el commit en
   git y dejar que el `autoDeployTrigger: commit` de `render.yaml` dispare un
   nuevo build sano, en vez de depender del botón de rollback del dashboard.

---

## 5. Qué queda en Vercel y qué se mueve al worker — y por qué

| Pieza | Dónde vive | Por qué |
|---|---|---|
| App Next.js (UI, API de la app, checkout, etc.) | **Vercel** | Es lo que Vercel hace bien: requests cortos, HTTP, autoscaling por request |
| `/api/worker/tick` (cron cada 60s) | **Vercel — se queda** | Red de seguridad **parcial** — ver la advertencia abajo, no cubre todos los tipos de trabajo |
| `pnpm worker` (proceso largo: ingesta, índice, chequeos, agente, video) | **Render (nuevo)** | Es el trabajo que rompía en Vercel: minutos de duración, Chromium con dependencias de sistema, picos de memoria que superan el presupuesto de una función serverless |

⚠️ **El cron de Vercel NO es red de seguridad para todo.** `KINDS_EN_SERVERLESS`
en `src/app/api/worker/tick/route.ts` excluye del default del tick
`run_browser_agent`, `generate_video` y `build_tutorials` — a propósito, porque
en Vercel no hay navegador y esos trabajos solo pueden terminar en "handler no
registrado" (ver el comentario de esa constante en el código). Con el worker de
Render caído o reiniciando:

- **Sigue funcionando** vía el cron de Vercel: `ingest_repo`, `index_code`,
  `run_checks` y `scan_comments` — tandas cortas, hasta `maxDuration = 300`s
  por tick, con margen de 20s antes del corte.
- **Se degrada, pero la auditoría igual sale**: `run_browser_agent` y
  `generate_video` quedan `queued` sin que nadie los tome. Dos cosas evitan que
  eso se lleve puesta la corrida entera:
  - `index_code` no espera al agente para encolar la revisión: la deja agendada
    a 20 minutos (`DIFERIMIENTO_RED_MS`, en `src/server/analysis/handlers.ts`).
    Si el agente corre, la adelanta con la evidencia adentro; si no corre, la
    revisión del código arranca igual, y los chequeos que dependen del navegador
    quedan marcados como no revisados en la cobertura.
  - A los 30 minutos, `vencerEncoladosDesatendidos()`
    (`src/server/jobs/encolados.ts`) da por perdido lo que nadie atendió, con un
    motivo legible, y la corrida cierra en `partial` en vez de quedar girando.

  O sea: sin worker de Render el usuario recibe la revisión de su código y el
  informe le dice qué parte no se pudo hacer. Lo que no recibe son los videos ni
  la prueba en vivo de su app.
- Se puede pedir cualquier tipo a mano contra `/api/worker/tick?kinds=...`,
  pero en el entorno de Vercel esos dos tipos van a fallar con "handler no
  registrado" igual (no hay Chromium ahí) — no es una vía de escape real.

No hay downtime de producto en el cambio: la cola (`jobs_caughtcode`) es la
misma tabla para los dos consumidores, así que se puede prender el worker de
Render y dejar el cron de Vercel andando en paralelo sin coordinar un
"apagado" de nada — ver la próxima sección, es justamente seguro.

---

## 6. Convivencia: ¿el cron de Vercel y el worker de Render pueden pelearse por el mismo trabajo?

**No.** El reparto de trabajos pasa siempre por el RPC
`claim_job_caughtcode` (`supabase/migrations/0013_claim_job_setof_caughtcode.sql`),
que hace:

```sql
select j.* into v_job
from public.jobs_caughtcode j
where j.status = 'queued'
  and j.run_after <= now()
  and (...)
order by j.run_after, j.created_at
for update skip locked
limit 1;
```

`for update skip locked` es exactamente el mecanismo pensado para esto: cuando
dos consumidores (el tick de Vercel y el loop de `scripts/worker.ts` en Render)
llaman al RPC casi al mismo tiempo, Postgres deja que el primero bloquee la fila
que va a tomar, y el segundo **la salta** en vez de esperar o de leer un dato
viejo — se va derecho a la siguiente fila `queued` disponible. Ningún trabajo
puede terminar tomado por los dos a la vez, y ninguno de los dos consumidores
se queda colgado esperando al otro.

Es seguro tener ambos prendidos en simultáneo de forma indefinida, no solo
durante la migración. Si en algún momento se decide apagar el cron de Vercel
del todo (una vez que el worker de Render demuestre ser confiable), es un
cambio en `vercel.json` (sacar la entrada de `crons`) — fuera de las fronteras
de esta tarea, queda para quien lo decida.

---

## Decisiones abiertas (para el dueño del producto)

1. **Plan de Render**: `render.yaml` deja `plan: pro` puesto, con la
   justificación de memoria de la sección 1. Si el costo no cierra, la
   alternativa es `WORKER_CONCURRENCY=1` + plan `standard` — ver esa sección.
2. **`WORKER_SECRET`**: se declaró en `render.yaml` porque `src/lib/env.ts` lo
   expone y `/api/worker/tick` lo acepta como secreto válido, pero no está
   claro si el worker de Render efectivamente necesita pegarle a ese endpoint
   en algún flujo. Confirmar si hace falta o si alcanza con generarlo por
   consistencia y no usarlo.
3. **Apagar el cron de Vercel en algún momento**: hoy queda prendido a
   propósito como red de seguridad parcial (ver sección 5 — no cubre
   `run_browser_agent` ni `generate_video`). Es una decisión de negocio, no
   técnica, cuándo (o si) se apaga.
4. **Borrado automático del código al terminar una corrida**: hoy no existe
   (ver la nota "Importante" de la sección 2). El disco del worker crece sin
   tope hasta el próximo redeploy o restart. Es tarea de otro frente engancharlo
   en `reconcileRunStatus()` (`src/server/jobs/reconcile.ts`) o donde el dueño
   del código decida; mientras tanto, vigilar a mano (ver sección 2).
