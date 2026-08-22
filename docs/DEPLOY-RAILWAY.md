# Desplegar el worker en Railway

> Guía operativa para `pnpm worker` (`scripts/worker.ts`) como servicio
> dedicado en Railway. Reemplaza a [`docs/DEPLOY-WORKER.md`](./DEPLOY-WORKER.md)
> (guía para Render, quedó obsoleta — el razonamiento que sigue vigente se
> trasladó acá). Lo que describe esta guía sobre Railway está verificado contra
> `docs.railway.com` al escribir esto (2026-08-22) vía el MCP de Railway; donde
> no pude confirmar un paso, lo digo explícitamente en vez de inventarlo.

---

## 🚨 Esto es lo único que bloquea que el worker arranque

El deploy de hoy está **CRASHED**. El propio worker lo explica al arrancar
(`checkEnvironment()` en `scripts/worker.ts`, ver sección 5): sin
`NEXT_PUBLIC_SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` no llega ni a entrar
al loop principal. `NEXT_PUBLIC_SUPABASE_URL` ya está cargada — falta
`SUPABASE_SERVICE_ROLE_KEY`.

Son secretos que solo tiene el dueño del producto — no viven en el repo a
propósito. Hay que pegarlos a mano en el dashboard de Railway:

| Variable | Bloquea | Por qué falta acá |
|---|---|---|
| **`SUPABASE_SERVICE_ROLE_KEY`** | El arranque del worker (loop no empieza) | `checkEnvironment()` la exige junto con `NEXT_PUBLIC_SUPABASE_URL` antes de registrar handlers — es el motivo exacto del CRASHED de hoy |
| **`ANTHROPIC_API_KEY`** | Cualquier trabajo que use el agente o los chequeos con LLM | El worker arranca igual (no está en `checkEnvironment()`), pero `env.anthropicKey()` (`src/lib/env.ts`) tira excepción en cuanto un handler la pide |
| **`ENCRYPTION_KEY`** | Descifrar credenciales guardadas (ej. tokens de GitHub) | Mismo mecanismo: `env.encryptionKey()` es `required()`, revienta al primer uso, no al arrancar. Tiene que ser **idéntica** a la que usa Vercel — si difiere, el worker no puede descifrar lo que cifró la app y viceversa |
| `AZURE_SPEECH_KEY` + `AZURE_SPEECH_REGION` (opcional) | Narración de los videos | Sin ellas, `TTS_PROVIDER=azure` no tiene con qué autenticarse — el video sale igual, pero mudo, solo con subtítulos |
| Bloque `GITHUB_APP_*` (opcional) | Clonar repos **privados** | Repos públicos no lo necesitan |

**Cómo cargarlas** (verificado en `docs.railway.com/variables`):

1. Dashboard de Railway → proyecto `caughtcode` → servicio `caughtcode-worker`
   → pestaña **Variables**.
2. `New Variable` para cargarlas una por una, o **RAW Editor** para pegar
   varias en formato `.env` de una sola vez.
3. Cargar variables las deja en un set de **staged changes** (banner arriba,
   en violeta) — no se aplican solas. Click en **Deploy** en ese banner para
   confirmarlas; eso dispara un redeploy del servicio con las variables ya
   puestas.

No hace falta tocar `railway.json` ni el `Dockerfile` para esto — es
puramente carga de variables.

---

## 1. Por qué existe esto (heredado de la migración fuera de Vercel)

El worker corría en Vercel, disparado por un cron cada 60s contra
`/api/worker/tick`. Dos problemas de fondo, verificados en producción:

1. **OOM**: `Vercel Runtime Error: instance was killed because it ran out of
   available memory`. Bajar un repo, indexarlo con tree-sitter, correr
   Playwright y renderizar video con ffmpeg son minutos de trabajo pesado —
   no entra en el presupuesto de memoria de una función serverless.
2. **Playwright no se empaqueta**: estaba en `devDependencies`, así que
   Vercel nunca lo subía al bundle de producción, y aunque estuviera en
   `dependencies` los navegadores (Chromium) no vienen instalados en el
   runtime serverless. Cada tick logueaba:
   ```
   [jobs] no se pudo cargar "agent": Cannot find module '/var/task/node_modules/playwright-core/browsers.json'
   [jobs] no se pudo cargar "video": Cannot find module '/var/task/node_modules/playwright-core/browsers.json'
   ```

La solución sigue siendo la misma: un proceso largo, sin HTTP, sin límite de
duración por request, con Chromium preinstalado vía la imagen oficial de
Playwright (`Dockerfile` en la raíz — sin cambios respecto a cuando el plan
era Render). Lo único que cambió es **dónde** corre ese proceso: el plan
original era Render (`render.yaml`, ahora obsoleto), pero el dueño del
producto pagó Railway y el servicio ya se creó ahí. El cron de Vercel
**no se apaga** — sigue como red de seguridad parcial (ver sección 8).

---

## 2. Estado real del servicio hoy

Ya creado y configurado vía API — esto no hay que repetirlo:

| Campo | Valor |
|---|---|
| Proyecto | `caughtcode` — `06a7f9c6-9e8e-4eab-afd5-d32703e9f497` |
| Entorno | `production` — `0cc83e06-23a9-4443-9920-3b7ab1939ab1` |
| Servicio | `caughtcode-worker` — `acf08c23-dd4e-421a-9658-c34dfc521931` |
| Fuente | GitHub `developers-insights/caughtcode`, rama `main`, autodeploy en cada push |
| Build | `Dockerfile` de la raíz. Ya construyó bien: imagen 1.13 GB sobre `mcr.microsoft.com/playwright:v1.62.1-noble`, `pnpm install --frozen-lockfile` limpio, `/data/caughtcode-storage` creado con dueño `pwuser` |
| Restart policy | `ON_FAILURE`, máximo 10 reintentos |
| Sleep | `sleepApplication=false` (no aplica dormir un worker sin HTTP) |
| Dominio | Ninguno — es un worker, no sirve HTTP |
| Región | `us-east4` (1 réplica) — la que Railway asignó por defecto |

Esta tabla es la fuente de verdad de lo ya aplicado. `railway.json`
(sección siguiente) está escrito para **coincidir** con esto, no para
pisarlo.

**Nota sobre la región, por si algún día aparece lentitud:** el worker corre en
`us-east4` y la base de Supabase (`ktmbtpuhqqofdkisqseq`) está en `us-west-2`.
Cada consulta cruza el país. Para este worker no debería importar —los trabajos
duran minutos y el cuello de botella es bajar el repo, indexarlo y correr
Chromium, no la latencia por consulta— así que **no se movió nada**: cambiar de
región sin una medición que lo justifique sería tocar por tocar. Pero si alguna
vez el worker se ve lento y los tiempos no cierran, este es el primer lugar
donde mirar antes de buscar el problema en el código.

---

## 3. `railway.json` — qué declara y por qué

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "Dockerfile"
  },
  "deploy": {
    "startCommand": "pnpm worker",
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
```

Verificado contra `docs.railway.com/config-as-code/reference`:

- `build.builder: "DOCKERFILE"` + `build.dockerfilePath: "Dockerfile"`:
  coincide con que el servicio ya construye desde el `Dockerfile` de la raíz.
- `deploy.startCommand: "pnpm worker"`: mismo comando que ya usa el `CMD` del
  `Dockerfile` (`CMD ["pnpm", "worker"]`, que a su vez es el script `worker`
  de `package.json`: `tsx --conditions=react-server
  --env-file-if-exists=.env.local scripts/worker.ts`). Declararlo acá no
  cambia el comportamiento — lo deja visible y versionado en el repo en vez
  de vivir solo en el `Dockerfile`.
- `deploy.restartPolicyType` / `restartPolicyMaxRetries`: coincide con lo ya
  aplicado por API (`ON_FAILURE`, 10 reintentos).

**No declara `sleepApplication`**: no encontré ese campo en la referencia de
Config as Code (`docs.railway.com/config-as-code/reference`) — es un ajuste
que vive en el dashboard/API, no en `railway.json`. Ya está en `false` por
API; no hace falta ni se puede repetir acá.

**Nota importante, verificada, no en el pedido original pero relevante para
quien toque este archivo más adelante:** la documentación de Railway marca
**Config as Code (`railway.json`/`railway.toml`) como deprecado** a favor de
Infrastructure as Code (`.railway/railway.ts`). Los archivos existentes
siguen funcionando para servicios que ya los usan hasta un corte duro el
**2026-12-01**; servicios nuevos ya no pueden optar por Config as Code. No es
urgente — hoy funciona igual que siempre y el propio dashboard de Railway
sigue mostrando qué valores vienen del archivo vs. de la configuración
manual — pero antes de esa fecha alguien va a tener que migrar esto a
Infrastructure as Code. Fuente: `docs.railway.com/config-as-code` y
`docs.railway.com/infrastructure-as-code#migrating-from-config-as-code`.

---

## 4. Variables de entorno — de dónde sale cada una

| Variable | Estado en Railway | De dónde sale |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ ya cargada | Dashboard de Supabase → Project Settings → API. Mismo valor que usa Vercel hoy |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ ya cargada | Dashboard de Supabase → Project Settings → API → `anon` `public` |
| `SUPABASE_PROJECT_REF` | ✅ ya cargada | El ref del proyecto de Supabase (`ktmbtpuhqqofdkisqseq` en `.env.example`) |
| `SUPABASE_SERVICE_ROLE_KEY` | 🚨 **falta** | Dashboard de Supabase → Project Settings → API → `service_role`. **Secreto de máximo privilegio** — nunca en el repo, nunca en logs |
| `ENCRYPTION_KEY` | 🚨 **falta** | La misma clave que ya usa el proyecto en Vercel para cifrar credenciales guardadas. Tiene que ser **idéntica** a la de Vercel |
| `ANTHROPIC_API_KEY` | 🚨 **falta** | Console de Anthropic (console.anthropic.com) → API Keys. Puede ser la misma que usa Vercel, o una key separada para medir costo del worker por separado |
| `ANTHROPIC_MODEL` | ✅ ya cargada | Mismo valor que usa la app |
| `CAUGHTCODE_STORAGE_DIR` | ✅ ya cargada (`/data/caughtcode-storage`) | Ver sección 5 — filesystem efímero del contenedor, no almacenamiento persistente |
| `WORKER_CONCURRENCY` | ✅ ya cargada (`1`) | Decisión propia de este entorno — ver sección 6 |
| `WORKER_SECRET` | ✅ ya cargada | Secreto propio de este entorno. Lo usa `/api/worker/tick` como uno de los dos secretos aceptados (junto a `CRON_SECRET`) — si el worker de Railway alguna vez necesita pegarle a ese endpoint, comparten este valor |
| `NODE_ENV` | ✅ ya cargada (`production`) | Fijo — también lo fija el `Dockerfile` (`ENV NODE_ENV=production`), así que es redundante pero inofensivo tenerlo en las dos partes |
| `TTS_PROVIDER` | ✅ ya cargada (`azure`) | Valor actual del proyecto |
| `AZURE_SPEECH_KEY` | ⚠️ falta (opcional) | Portal de Azure → recurso de Speech → Keys. Sin esto, narración muda |
| `AZURE_SPEECH_REGION` | ⚠️ falta (opcional) | Idem, la región del recurso |
| `AZURE_SPEECH_VOICE` | ✅ ya cargada (`es-AR-TomasNeural`) | Mismo valor que la app |
| `VIDEO_RENDERER` | ✅ ya cargada (`web`) | Valor actual — HTML + Playwright + ffmpeg, no Remotion |
| `NEXT_PUBLIC_APP_URL` | ✅ ya cargada | La URL pública de la app en Vercel. El worker no sirve HTTP con esto, solo arma links en videos/reportes |
| `GITHUB_APP_ID` / `_SLUG` / `_CLIENT_ID` / `_CLIENT_SECRET` / `_PRIVATE_KEY` | ⚠️ falta (opcional) | Configuración de la GitHub App del proyecto. Solo hace falta para clonar repos **privados** — `src/lib/env.ts` hace `.replace(/\\n/g, '\n')` sobre la private key, así que pegarla con `\n` escapados o con saltos de línea reales funciona igual |

---

## 5. `CAUGHTCODE_STORAGE_DIR` — disco efímero, no persistente

Verificado en `docs.railway.com/deployments/reference#ephemeral-storage`:
cada deployment de Railway tiene acceso a almacenamiento efímero en el
filesystem del contenedor (100 GB en plan pago) que **sobrevive mientras el
proceso vive** — se pierde recién en un redeploy o restart. Eso es
exactamente lo que hace falta para encadenar los jobs de una misma corrida
(`ingest → index → checks → agent → video`, todos leyendo/escribiendo bajo
`<storageDir>/<projectId>/<runId>/`).

No hace falta un [**volumen**](https://docs.railway.com/volumes) de Railway
(almacenamiento persistente entre redeploys, con costo por GB) porque nada de
esto necesita sobrevivir un redeploy — pagar por eso sería costo sin
beneficio. Por eso `CAUGHTCODE_STORAGE_DIR=/data/caughtcode-storage`: el
`Dockerfile` ya crea ese directorio y le da dueño a `pwuser` (el usuario no
root con el que corre el proceso) antes de arrancar, así que no hace falta
crear nada a mano ni preocuparse por permisos.

**Importante — esto NO borra el código de cada corrida solo** (esto no
cambió al mudarse de Render a Railway, sigue siendo cierto porque es una
cuestión de código, no de plataforma): verificado por lectura de código que
`deleteRunCode`/`purgeExpired` (`src/server/ingest/retention.ts`) existen
pero **no los llama nadie** desde el camino de trabajos
(`src/server/jobs/**`), y `withWorkspace`/`removeWorkspace`
(`src/server/ingest/workspace.ts`) solo se usan hoy desde el onboarding
(`src/app/(app)/proyectos/nuevo/actions.ts`), no al terminar una revisión. En
Vercel esto no se notaba porque `/tmp` moría solo con cada invocación; acá el
proceso vive días, así que **el código de todas las corridas se va
acumulando en `CAUGHTCODE_STORAGE_DIR` hasta el próximo redeploy o restart
del servicio** — hoy no hay tope de tamaño ni limpieza automática ligada al
fin de una corrida.

Mientras eso no esté resuelto (es tarea de otro frente, no de este
documento):

- **Vigilar el tamaño real del disco.** Con `railway ssh` (ver sección 9):
  `du -sh /data/caughtcode-storage`. No hay una métrica nativa de "uso del
  filesystem efímero" en el dashboard de Railway para este tipo de servicio —
  hay que entrar y mirar a mano, o programar un chequeo propio.
- **Mitigación de corto plazo**: un redeploy manual (o el que dispara el
  autodeploy en cada push a `main`) limpia todo el filesystem efímero de una.
  No es una solución, es un remiendo.
- Cuando el borrado automático quede enganchado (candidato natural:
  `reconcileRunStatus()` en `src/server/jobs/reconcile.ts`, que ya es el
  lugar donde se decide que una corrida terminó), esta sección hay que
  reescribirla para describir el mecanismo real en vez de este apartado de
  vigilancia manual.

---

## 6. Por qué `WORKER_CONCURRENCY=1` (decisión ya tomada, distinta a Render)

En el análisis para Render, la alternativa a `WORKER_CONCURRENCY=1` +
plan Standard era pagar el plan **Pro** (4 GB / 2 CPU) para poder sostener la
concurrencia por defecto de `scripts/worker.ts` (`2`), porque Render cobra
por **plan fijo**, no por uso.

Railway cobra por **uso real** (CPU/RAM consumidos), no por un plan fijo
mensual — así que esa disyuntiva "pagar más para tener margen" no aplica
igual acá. Con `WORKER_CONCURRENCY=1` el peor caso de memoria es:

| Componente | Memoria estimada |
|---|---|
| Worker en reposo (Node + módulos cargados) | ~250 MB (medido) |
| Un contexto de Chromium (`run_browser_agent` o `generate_video`) | ~300–500 MB |
| Índice del repo en memoria (tree-sitter/AST) | variable, no acotado |

Total ≈ 750 MB en el peor caso realista, más el índice — entra cómodo, y no
se paga CPU ocioso esperando un segundo trabajo que no siempre va a existir.
El trade-off es el mismo que en el análisis de Render: con concurrencia 1 los
trabajos se procesan de a uno, así que si se encolan varios seguidos hacen
cola en vez de superponerse. Con facturación por uso, ese trade-off pesa
menos que en Render — no hay plan más caro esperando sin usarse.

---

## 7. Verificar que el worker levantó

### En los logs

Al arrancar, `scripts/worker.ts` loguea (ver `main()` en ese archivo):

```
caughtcode worker worker-xxxxxxxx arriba.
  tipos: ingest_repo, index_code, run_checks, run_browser_agent, generate_video, scan_comments, build_tutorials
  concurrencia: 1 · lease: 90s
  sin handler todavía: build_tutorials
```

Si falta alguna de las líneas `[jobs] no se pudo cargar "..."` que aparecían
en Vercel (`agent`, `video`), es la confirmación de que Playwright y Chromium
están disponibles en este entorno.

Cuando toma un trabajo:

```
Tomado: run_browser_agent a1b2c3d4 (intento 1/3)
run_browser_agent a1b2c3d4 → succeeded en 42.3s (US$ 0.0180)
```

Verificado en `docs.railway.com/cli/logs`: se ven con
`railway logs` (stream en vivo), `railway logs --build` (logs de build) o
`railway logs -n 100` (últimas 100 líneas); también hay una pestaña de logs
en el dashboard del servicio.

### En la base (tabla `jobs_caughtcode`)

Con el SQL Editor de Supabase o el MCP de Supabase:

```sql
select id, kind, status, attempts, lease_until, updated_at
from public.jobs_caughtcode
order by updated_at desc
limit 20;
```

- `status = 'running'` con `lease_until` en el futuro → un worker (Railway o
  el cron de Vercel) lo tiene tomado ahora mismo.
- `status = 'queued'` con `run_after` en el pasado y que no cambia de estado
  en varios minutos → nadie lo está tomando. Revisar que el worker de Railway
  esté arriba (`railway logs`, o la pestaña **Deployments** del servicio para
  ver si se reinició).
- Contar trabajos por `status` para un pulso rápido:
  ```sql
  select status, count(*) from public.jobs_caughtcode group by status;
  ```

---

## 8. Rollback

Verificado en `docs.railway.com/deployments/reference`: Railway guarda cada
deployment del servicio (sujeto a la política de retención del plan). Si un
deploy nuevo rompe algo:

1. Dashboard de Railway → servicio `caughtcode-worker` → pestaña
   **Deployments**.
2. En el deployment anterior que estaba sano, abrir el menú y elegir
   **Rollback** (o **Redeploy** — ambas acciones vuelven a desplegar el
   código y las variables de ese deployment puntual; la diferencia entre una
   y otra es de encuadre en la UI, no de mecanismo). Deployments más viejos
   que la retención del plan no muestran la opción de rollback.
3. Mientras el rollback no está listo, el cron de Vercel sigue vivo y sigue
   procesando lo que entra en su ventana de 300s por tick — el sistema no se
   detiene del todo, solo pierde el throughput del worker largo (ver
   sección 10).
4. Si el problema es de código (no de infraestructura), revertir el commit
   en git y dejar que el autodeploy en `main` dispare un build sano, en vez
   de depender del botón de rollback del dashboard.

---

## 9. Shell dentro del contenedor (para mirar el disco, por ejemplo)

Verificado en `docs.railway.com/cli/ssh`: `railway ssh` abre una sesión
interactiva dentro del contenedor del servicio (usa el cliente `ssh` del
sistema contra `ssh.railway.com`; pide registrar una clave SSH la primera
vez). Usos típicos, según la propia doc: debugging en producción, inspeccionar
archivos de log, correr un comando puntual.

```bash
railway ssh -s caughtcode-worker -- du -sh /data/caughtcode-storage
```

o, para una sesión interactiva:

```bash
railway ssh -s caughtcode-worker
```

**No verificado**: no encontré en la documentación una métrica nativa en el
dashboard que muestre el uso de disco del filesystem efímero de un servicio —
si existe, no la ubiqué buscando en `docs.railway.com`; asumí que no hay y por
eso esta sección recomienda `railway ssh` a mano, igual que la guía de Render
recomendaba su Shell del dashboard.

---

## 10. Convivencia: ¿el cron de Vercel y el worker de Railway pueden pelearse por el mismo trabajo?

**No.** Esto no depende de la plataforma del worker — es un mecanismo a nivel
de base de datos, así que sigue valiendo igual que con Render. El reparto de
trabajos pasa siempre por el RPC `claim_job_caughtcode`
(`supabase/migrations/0013_claim_job_setof_caughtcode.sql`), que hace:

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

`for update skip locked` es exactamente el mecanismo pensado para esto:
cuando dos consumidores (el tick de Vercel y el loop de `scripts/worker.ts`
en Railway) llaman al RPC casi al mismo tiempo, Postgres deja que el primero
bloquee la fila que va a tomar, y el segundo **la salta** en vez de esperar o
de leer un dato viejo — se va derecho a la siguiente fila `queued`
disponible. Ningún trabajo puede terminar tomado por los dos a la vez, y
ninguno de los dos consumidores se queda colgado esperando al otro.

Es seguro tener ambos prendidos en simultáneo de forma indefinida. Si en
algún momento se decide apagar el cron de Vercel del todo (una vez que el
worker de Railway demuestre ser confiable), es un cambio en `vercel.json`
(sacar la entrada de `crons`) — fuera de las fronteras de esta tarea, queda
para quien lo decida.

---

## 11. Qué NO cubre el cron de Vercel

⚠️ **El cron de Vercel NO es red de seguridad para todo.** `KINDS_EN_SERVERLESS`
en `src/app/api/worker/tick/route.ts` excluye del default del tick
`run_browser_agent`, `generate_video` y `build_tutorials` — a propósito,
porque en Vercel no hay navegador y esos trabajos solo pueden terminar en
"handler no registrado". Con el worker de Railway caído o reiniciando:

- **Sigue funcionando** vía el cron de Vercel: `ingest_repo`, `index_code`,
  `run_checks` y `scan_comments` — tandas cortas, hasta `maxDuration = 300`s
  por tick, con margen de 20s antes del corte.
- **Se degrada, pero la auditoría igual sale**: `run_browser_agent` y
  `generate_video` quedan `queued` sin que nadie los tome. Dos cosas evitan
  que eso se lleve puesta la corrida entera:
  - `index_code` no espera al agente para encolar la revisión: la deja
    agendada a 20 minutos (`DIFERIMIENTO_RED_MS`, en
    `src/server/analysis/handlers.ts`). Si el agente corre, la adelanta con
    la evidencia adentro; si no corre, la revisión del código arranca igual,
    y los chequeos que dependen del navegador quedan marcados como no
    revisados en la cobertura.
  - A los 30 minutos, `vencerEncoladosDesatendidos()`
    (`src/server/jobs/encolados.ts`) da por perdido lo que nadie atendió,
    con un motivo legible, y la corrida cierra en `partial` en vez de
    quedar girando.

  O sea: sin worker de Railway el usuario recibe la revisión de su código y
  el informe le dice qué parte no se pudo hacer. Lo que no recibe son los
  videos ni la prueba en vivo de su app.
- Se puede pedir cualquier tipo a mano contra `/api/worker/tick?kinds=...`,
  pero en el entorno de Vercel esos dos tipos van a fallar con "handler no
  registrado" igual (no hay Chromium ahí) — no es una vía de escape real.

No hay downtime de producto en tener el worker de Railway caído: la cola
(`jobs_caughtcode`) es la misma tabla para los dos consumidores.

---

## Decisiones y notas — qué se heredó de Render y qué cambió

1. **`WORKER_CONCURRENCY=1`**: decisión ya tomada (no es abierta, a
   diferencia de la nota equivalente en `docs/DEPLOY-WORKER.md`) — ver
   sección 6. Con Railway cobrando por uso, la disyuntiva "plan más caro para
   tener margen de concurrencia 2" ya no aplica como en Render.
2. **`WORKER_SECRET`**: se cargó igual que en el análisis de Render, mismo
   motivo — `src/lib/env.ts` lo expone y `/api/worker/tick` lo acepta como
   secreto válido, pero sigue sin estar confirmado si el worker de Railway
   efectivamente necesita pegarle a ese endpoint en algún flujo.
3. **Apagar el cron de Vercel en algún momento**: sigue siendo una decisión
   de negocio pendiente, no técnica — ver sección 11.
4. **Borrado automático del código al terminar una corrida**: sigue sin
   existir (sección 5). Es tarea de otro frente.
5. **Config as Code deprecado**: ver la nota al final de la sección 3 — no
   es urgente, pero hay un corte duro el 2026-12-01 para migrar `railway.json`
   a Infrastructure as Code.
