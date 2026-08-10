# Base de datos — caughtcode

> ⚠️ **caughtcode no tiene un proyecto de Supabase propio.** Vive dentro de
> `ktmbtpuhqqofdkisqseq` ("Comunidad latina", org "INSIGHTS manu"), **junto a
> otro producto que ya está en producción**. El esquema `public`, `auth.users`,
> `storage.buckets` y la publicación `supabase_realtime` son compartidos.
>
> De ahí sale la única regla que no se negocia: **todo objeto nuestro termina en
> `_caughtcode`**. Tablas, funciones, índices, triggers, policies y buckets.

En el código no se escriben esos nombres a mano: se importan de
**`src/lib/db/tablas.ts`** (`T.findings`, `F.claimJob`, `B.videos`). Si el
sufijo cambia, se toca un archivo y el typechecker marca el resto.

## Antes de pushear: preflight

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/preflight.sql
```

De solo lectura, termina en `ROLLBACK`. Lista cualquier objeto que ya exista con
sufijo `_caughtcode` y verifica que estén los requisitos (`supabase_realtime`,
esquemas `auth` y `storage`). **Si falla, no pushear**: o el nombre ya lo usa
otro, o quedó basura de un push anterior a medias.

## Aplicar las migraciones

```bash
supabase link --project-ref ktmbtpuhqqofdkisqseq
supabase db push
```

| Variable | Para qué |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | Token personal del CLI |
| `SUPABASE_DB_PASSWORD` | Contraseña del rol `postgres` |
| `NEXT_PUBLIC_SUPABASE_URL` | URL del proyecto |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Clave pública, va al navegador |
| `SUPABASE_SERVICE_ROLE_KEY` | Clave del worker. **Nunca** al navegador |
| `SUPABASE_DB_URL` | Conexión directa. La usan preflight y el test de RLS |

**Después de cada `db push`, correr `get_advisors` (security y performance).**
No es opcional: somos el producto que audita RLS ajena.

Las migraciones **no** usan `if not exists` en los `create`. Falla ruidosa a
propósito: en una base compartida, tapar una colisión es peor que detenerse.

| Archivo | Qué trae |
|---|---|
| `0001_core_tenancy` | organizations, org_members, projects, project_connections |
| `0002_analysis` | analysis_runs, code_index, findings, agent_sessions, videos, comment_scans, comment_cleanups |
| `0003_chat_billing_jobs` | chat_threads, chat_messages, usage_events, subscriptions, jobs |
| `0004_tenancy_helpers` | `is_org_member_caughtcode` y compañía |
| `0005_rls_policies` | grants + 64 policies (una por comando y tabla) |
| `0006_job_queue` | `claim_job_caughtcode`, `requeue_expired_jobs_caughtcode` |
| `0007_auth_bootstrap` | `ensure_org_caughtcode` — **sin trigger sobre `auth.users`** |
| `0008_deletion_and_actions` | borrado real y `set_finding_status_caughtcode` |
| `0009_storage_buckets` | buckets `repos_caughtcode`, `recordings_caughtcode`, `videos_caughtcode` |
| `0010_jobs_and_cost_fixes` | costo por corrida, índice de leases, Realtime |

Cada tabla nace con RLS **habilitada y forzada** en su propia migración: nunca
existe una ventana con una tabla suelta.

## 📣 El alta del espacio de trabajo la hace el código, no la base

`auth.users` es **una sola tabla para los dos productos**. Un trigger nuestro ahí
crearía una organización de caughtcode por cada persona que se registre en el
otro producto y, peor, si fallara, **rompería el registro de usuarios ajeno**.
Por eso no instalamos nada sobre `auth.users`: solo leemos.

**El frente de autenticación tiene que llamar, en el primer ingreso:**

```ts
import { F } from '@/lib/db/tablas'
await supabase.rpc(F.ensureOrg, {})   // ensure_org_caughtcode
```

Es idempotente, toma un lock por usuario para que dos pedidos simultáneos no
dupliquen, y devuelve el id de la organización. **Sin esa llamada el usuario
entra y no tiene dónde crear proyectos.**

## Probar el aislamiento

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls.sql
```

Simula los claims de JWT de dos personas de organizaciones distintas y verifica,
tabla por tabla, que ninguna ve una sola fila de la otra. También comprueba que
no haya triggers nuestros sobre `auth.users`, que la cola sobreviva a que se
caiga el worker, y que el borrado sea real. Todo en una transacción que termina
en `ROLLBACK`.

> Correrlo contra una base de prueba. **Nunca contra producción.**

## Cómo escribe cada frente

| Tabla | Quién escribe |
|---|---|
| `organizations_caughtcode`, `org_members_caughtcode`, `projects_caughtcode`, `project_connections_caughtcode`, `chat_threads_caughtcode` | La persona, desde el cliente, con RLS |
| `chat_messages_caughtcode` | La persona solo `role = 'user'`; las respuestas las escribe el servidor |
| El resto | Solo `service_role` (worker y webhooks) |

Dos excepciones para que el cliente no necesite el service role:

- **`set_finding_status_caughtcode(finding_id, status)`** — única forma de marcar
  un hallazgo como resuelto o descartado desde la UI. Toca `status` y
  `resolved_at`, nada más.
- **`delete_project_cascade_caughtcode(project_id)`** — borrado real, owner o admin.

## Vocabularios que hay que acordar

| Columna | Valores aceptados | Frente que manda |
|---|---|---|
| `videos_caughtcode.status` | `queued`, `rendering`, `ready`, `failed` | Video |
| `comment_cleanups_caughtcode.status` | `pending`, `ready`, `applied`, `failed` | Comentarios |
| `chat_messages_caughtcode.role` | `user`, `assistant`, `system` | Chat |
| `subscriptions_caughtcode.status` | los 8 de Stripe | Monetización |
| `plan` (org y suscripción) | **sin CHECK** | Monetización |

## Progreso en vivo (Realtime)

`analysis_runs_caughtcode` y `findings_caughtcode` están agregadas a la
publicación `supabase_realtime`. Realtime **respeta RLS**: cada quien recibe solo
las filas que su policy de select le deja ver.

⚠️ La publicación es compartida y ya tenía tablas del otro producto. Solo se usa
`alter publication ... add table`. **Nunca `create publication` ni `drop`.**

## Storage

Tres buckets privados. Todo se sirve con URLs firmadas generadas en el servidor.

```
repos_caughtcode/<org_id>/<project_id>/<sha-o-timestamp>.zip
repos_caughtcode/<org_id>/<project_id>/cleanups/<cleanup_id>.patch
recordings_caughtcode/<org_id>/<project_id>/<agent_session_id>.webm
videos_caughtcode/<org_id>/<project_id>/<video_id>.mp4
```

**Postgres no borra archivos.** `delete_project_cascade_caughtcode` y
`delete_account_caughtcode` devuelven `storage_objects`: las rutas que quedaron
huérfanas. Quien llama tiene que borrarlas con `storage.from(bucket).remove([...])`
usando el service role, y reintentar si falla. `delete_account_caughtcode` además
requiere un `auth.admin.deleteUser(userId)` después — esa fila la administra
GoTrue, y es de la tabla compartida.

## Tipos TypeScript

`src/lib/types/database.ts` está **escrito a mano**.

- **No corras `pnpm db:types`.** Sobrescribe el archivo con la salida de
  `supabase gen types`, que además de traer las tablas del otro producto tipa
  toda columna `jsonb` como `Json` y pierde `Evidence[]`, `CostBreakdown`,
  `AgentStep[]`, `VideoScript` y compañía.
- **Las filas van como `type`, no como `interface`.** `@supabase/supabase-js`
  pide que cada fila sea asignable a `Record<string, unknown>` y solo los alias
  de tipo tienen index signature implícita. Con `interface`, el cliente cae en
  silencio a `never`: compila igual y todo queda sin tipar.

## Desvíos y criterios propios

- **`videos_caughtcode.project_id`** (aditiva respecto de `docs/CONTRACTS.md` §3).
  Sin ella, un video de tutorial no pertenece a nadie y RLS no puede decidir
  quién lo ve. Va con un CHECK que exige `finding_id` o `project_id`.
- **`usage_events_caughtcode.analysis_run_id` con `on delete set null`**, no
  `cascade`: es el registro de facturación y borrar un proyecto no puede
  llevarse la historia de lo que se cobró. El SQL para cambiarlo está comentado
  en `0010`.
- **Constraints con nombre automático.** Los índices, FK explícitas, uniques y
  CHECK con nombre terminan en `_caughtcode`. Los CHECK de columna quedan con el
  nombre que genera Postgres (`projects_caughtcode_retention_days_check`): el
  sufijo va embebido vía el nombre de la tabla, siguen siendo rastreables con un
  `grep _caughtcode` y no pueden colisionar, porque derivan de un nombre que ya
  es único.

## Invariantes que hace cumplir la base

- `findings_caughtcode.evidence` nunca puede ser un arreglo vacío.
- Como mucho **tres** hallazgos destacados por corrida (índice único parcial).
- Un video siempre cuelga de un hallazgo o de un proyecto.
- Un solo `code_index_caughtcode` por corrida (permite UPSERT en reintentos).
- Nadie puede cambiarse el plan ni transferirse una organización desde el cliente.
