# Contratos de construcción — caughtcode

> Este archivo es **normativo** para todo agente que escriba código en este repo.
> Los tipos viven en `src/lib/types/domain.ts`. No los redefinas: importalos.

## 1. Stack y convenciones

- Next.js **16** (App Router). El middleware ahora se llama **`proxy.ts`** en la raíz.
- React 19, TypeScript 7, Tailwind **v4** (config por CSS, sin `tailwind.config.js`).
- Supabase (`@supabase/ssr` 0.12) — clientes ya escritos en `src/lib/supabase/{client,server,admin}.ts`. **No crear otros.**
- Gestor de paquetes **pnpm**. **No agregues dependencias**: ya están todas instaladas. Si te falta una, decilo en tu reporte y resolvé con lo que hay.
- Alias `@/*` → `src/*`.
- Todo texto visible al usuario en **español rioplatense**, sin jerga técnica.
- Archivos server-only empiezan con `import 'server-only'`.

## 2. Mapa de propiedad de archivos

Cada frente escribe **solo** en sus rutas. Tocar la carpeta de otro rompe la integración.

| Frente | Escribe en |
|---|---|
| Datos / RLS | `supabase/migrations/**`, `src/lib/types/database.ts` |
| Diseño / shell | `src/styles/**`, `src/components/ui/**`, `src/components/shell/**`, `src/app/layout.tsx`, `docs/DESIGN.md` |
| Cola de trabajos | `src/server/jobs/**`, `src/app/api/worker/**`, `scripts/worker.ts` |
| Ingesta + análisis | `src/server/ingest/**`, `src/server/analysis/**` |
| Comentarios | `src/server/comments/**` |
| Chequeos | `src/server/checks/**` |
| Agente navegador | `src/server/agent/**` |
| Video | `src/server/video/**`, `video/**` |
| Auth + proyectos (UI) | `src/app/(auth)/**`, `src/app/(app)/proyectos/**` (salvo `[id]/hallazgos`), `src/components/projects/**` |
| Hallazgos (UI) | `src/app/(app)/proyectos/[id]/hallazgos/**`, `src/components/findings/**` |
| Chat + tutoriales | `src/server/chat/**`, `src/app/(app)/proyectos/[id]/{chat,como-funciona}/**`, `src/components/chat/**` |
| Monetización | `src/server/billing/**`, `src/app/(app)/facturacion/**`, `src/app/api/stripe/**`, `src/components/billing/**` |
| Privacidad / cuenta | `src/app/(app)/cuenta/**`, `src/app/(legal)/**`, `src/server/privacy/**` |
| Landing | `src/app/(marketing)/**`, `src/components/marketing/**` |

**Nadie toca:** `package.json`, `tsconfig.json`, `next.config.ts`, `eslint.config.mjs`, `src/lib/types/domain.ts`, `src/lib/{env,utils,crypto}.ts`, `src/lib/supabase/**`, `.env*`.
Si necesitás un cambio ahí, **pedilo en tu reporte** — no lo hagas.

## 3. Esquema de base de datos (nombres exactos)

Todo en `public`. **RLS habilitada y forzada en todas las tablas.** Aislamiento por `org_id`.

```
organizations(id uuid pk, name text, owner_user_id uuid, plan text default 'free', created_at timestamptz)
org_members(org_id uuid, user_id uuid, role text check in (owner|admin|member), created_at, pk(org_id,user_id))
projects(id uuid pk, org_id uuid, name text, client_name text null, source_type text check in (github|zip),
         repo_url text null, repo_ref text null, deployed_url text null, stack_detected jsonb null,
         storage_path text null, retention_days int default 30, created_at, deleted_at timestamptz null)
project_connections(id uuid pk, project_id uuid, provider text check in (github|supabase),
         credentials_ref text, scopes text[], created_at)
analysis_runs(id uuid pk, project_id uuid, status text, stage text null, progress int default 0,
         started_at, finished_at, cost_breakdown jsonb null, error text null, created_at)
code_index(id uuid pk, analysis_run_id uuid, symbol_graph jsonb, routes jsonb, ranked_files jsonb,
         db_schema jsonb, stats jsonb, created_at)
findings(id uuid pk, analysis_run_id uuid, project_id uuid, pillar text, check_id text, severity text,
         confidence text, status text default 'open', title_plain text, explanation_plain text,
         impact_plain text, fix_prompt text, evidence jsonb not null, rank int, video_id uuid null,
         created_at, resolved_at timestamptz null)
agent_sessions(id uuid pk, analysis_run_id uuid, task_id text, outcome text, conclusion_plain text,
         recording_url text null, steps jsonb, duration_ms int, cost_usd numeric, created_at)
videos(id uuid pk, finding_id uuid null, module_id text null, kind text, status text,
         duration_s numeric null, url text null, transcript text null, script jsonb null,
         cost_usd numeric default 0, error text null, created_at)
comment_scans(id uuid pk, project_id uuid, analysis_run_id uuid null, scanned_files int,
         exposed_count int, risky_count int, removable_count int, hits jsonb, created_at)
comment_cleanups(id uuid pk, project_id uuid, scan_id uuid, mode text, files_changed int,
         comments_removed int, patch_path text null, status text, created_at)
chat_threads(id uuid pk, project_id uuid, user_id uuid, title text, created_at)
chat_messages(id uuid pk, thread_id uuid, role text, content text, citations jsonb null, created_at)
usage_events(id uuid pk, org_id uuid, project_id uuid null, kind text, units numeric,
         unit_label text, cost_usd numeric, created_at)
subscriptions(id uuid pk, org_id uuid, stripe_customer_id text, stripe_subscription_id text null,
         plan text, status text, current_period_end timestamptz null, created_at, updated_at)
jobs(id uuid pk, org_id uuid, project_id uuid null, analysis_run_id uuid null, kind text,
     status text, payload jsonb, attempts int default 0, max_attempts int default 3,
     last_error text null, stage text null, progress int default 0, lease_until timestamptz null,
     run_after timestamptz default now(), created_at, updated_at)
```

Helper obligatorio para las policies (evita recursión):
`public.is_org_member(org uuid) returns boolean` — `security definer`, `set search_path = ''`.

### 3.1 Sufijo obligatorio `_caughtcode`

caughtcode **no tiene base propia**: convive dentro del proyecto `ktmbtpuhqqofdkisqseq`,
que ya tiene otro producto en producción. Por eso **todo objeto de base lleva sufijo
`_caughtcode`**: tablas, funciones, disparadores, índices, constraints y carpetas de archivos.

- La tabla es `findings_caughtcode`, nunca `findings`.
- Los nombres viven en **un solo lugar**: `src/lib/db/tablas.ts`. Se usa `T.findings`, nunca el literal.
- `auth.users` es **compartida con el otro producto**. Prohibido ponerle disparadores que
  creen datos de caughtcode: se dispararían con los usuarios del otro producto. La organización
  se crea desde el código, de forma idempotente, en el primer ingreso.
- Sobre la publicación `supabase_realtime`: solo `add table`. Nunca `create` ni `drop`.

### 3.2 Jerga en `fixPrompt` — excepción acordada

`titlePlain`, `explanationPlain` e `impactPlain` van en lenguaje llano **sin excepción**.
`fixPrompt` **sí puede usar el término técnico correcto**: ese texto no lo lee el usuario para
entender, lo copia y lo pega en Claude Code o Cursor. El destinatario es otro modelo, y para
ese lector "RLS" es preciso mientras que la perífrasis es ambigua. Las excepciones están
fijadas una por una en `tests/checks/lenguaje.test.ts` — no es una lista abierta.

## 4. Reglas duras de producto (rompen el producto si se violan)

1. **Nada sin evidencia.** `findings.evidence` nunca vacío. Confianza baja → se rotula "a revisar".
2. **Máximo 3 hallazgos destacados** (`rank` 1..3). El resto colapsado.
3. **Cero "créditos".** Costo en dólares y unidades concretas, mostrado *antes* de gastar.
4. **Nunca dictaminar legalidad.** Se dice "esto es lo que un revisor de App Store o un regulador podría marcar".
5. **Nunca escribir en la base del usuario.** RLS se verifica con `set_config('request.jwt.claims', ...)` dentro de una transacción con `ROLLBACK`.
6. **Prohibida la crítica estética generada por IA.** Nada de "mejorá la jerarquía visual".
7. **Nada irreversible sin confirmar.** Y si cuesta plata, se muestra cuánto antes.

## 5. Diseño

El sistema visual lo define **un solo frente** en `src/styles/tokens.css` + `src/components/ui/**`.
Todos los demás **consumen** esas primitivas y esos tokens. **Prohibido** escribir colores hex sueltos,
gradientes violeta-azul, tres cards iguales en fila, o cualquier patrón de "AI slop".

Color semántico (mismo en UI y en video):
`expuesto` = rojo · `incompleto` = ámbar · `verificado` = verde · `revisar` = azul apagado.

## 6. Verificación — qué cuenta como probado

- `pnpm typecheck` y `pnpm lint` en verde para los archivos que tocaste.
- Tests con `vitest` para lógica pura (parsers, ranking, limpieza de comentarios).
- "Lo grepeé y no aparece" **no** es verificación.
- Si no lo probaste, decilo en el reporte. No inventes resultados.

## 7. Formato del reporte de cada agente

```
ARCHIVOS: lista de rutas creadas/modificadas
DECISIONES: las que afectan a otros frentes
VERIFICADO: qué comando corriste y qué salió (pegá la salida real)
RIESGOS: lo que quedó frágil o sin probar
PIDO: cambios que necesitás en archivos que no son tuyos
```
