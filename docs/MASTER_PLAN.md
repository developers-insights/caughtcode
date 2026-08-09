# PLAN MAESTRO DE CONSTRUCCIÓN — caughtcode

> Este archivo es el input del **agente orquestador**. Contiene los subsistemas, sus dependencias, los criterios de aceptación y el orden de ejecución.

**Antes de ejecutar nada, leer:** `docs/DECISIONS.md` (por qué de cada cosa) y `CLAUDE.md` (reglas duras).

---

## 0. Cómo usar este plan

1. Cada **subsistema (S1…S10)** es una unidad independiente con entregables y criterios de aceptación verificables.
2. Las **olas** definen qué puede correr en paralelo. No arrancar una ola sin cerrar la anterior.
3. Cada subsistema declara el **agente especialista sugerido** y las **skills obligatorias**.
4. **Ningún subsistema se da por terminado sin sus criterios de aceptación verificados.** Reportar el output real, no "listo".
5. Al cerrar cada subsistema: actualizar `docs/PROGRESS.md` y sumar gotchas a `docs/MEMORY.md`.

### Regla de oro de la construcción

> **Vertical antes que horizontal.** Un hallazgo completo de punta a punta (detectar → agente lo demuestra → video narrado → prompt de arreglo) tiene que funcionar **antes** de ensanchar a los tres pilares. Si el formato video no convence, hay que saberlo temprano, no al final.

---

## 1. Modelo de datos (Supabase)

Multi-tenant desde el día 1 (ver `DECISIONS.md` D17). **RLS en todas las tablas, sin excepción.**

```
organizations          id, name, owner_user_id, plan, created_at
org_members            org_id, user_id, role (owner|admin|member)
projects               id, org_id, name, client_name?, source_type (github|zip),
                       repo_url?, deployed_url?, stack_detected, created_at
project_connections    id, project_id, provider (github|supabase), credentials_ref, scopes
analysis_runs          id, project_id, status, started_at, finished_at,
                       cost_breakdown (jsonb), error?
code_index             id, analysis_run_id, symbol_graph (jsonb), routes (jsonb),
                       ranked_files (jsonb), db_schema (jsonb)
findings               id, analysis_run_id, pillar (security|completeness|store_hygiene),
                       check_id, severity, status (open|fixed|dismissed),
                       evidence (jsonb: file:line | recording_id), confidence,
                       title_plain, explanation_plain, fix_prompt
agent_sessions         id, analysis_run_id, task_name, outcome, recording_url,
                       steps (jsonb), cost
videos                 id, finding_id?, module_id?, kind (finding|tutorial),
                       status, duration_s, url, script (jsonb), cost
chat_threads           id, project_id, user_id, created_at
chat_messages          id, thread_id, role, content, citations (jsonb)
usage_events           id, org_id, kind, units, cost_usd, created_at
```

**Reglas:**
- Toda tabla con datos de usuario lleva RLS con aislamiento por `org_id`.
- `cost_breakdown` y `usage_events` no son opcionales: sin medición no se puede fijar precio (D16).
- `findings.evidence` **nunca** puede estar vacío (D14).

---

## 2. Subsistemas

### S1 — Fundación
**Qué:** Next.js App Router + Supabase (auth, DB, storage) + Vercel. Modelo de datos completo con RLS. Sistema de colas para jobs. Design system base.
**Agente:** `backend-architect` + `frontend-developer` · **Skills:** `supabase`, `supabase-migrations`, `ui-ux-pro-max`, `high-end-visual-design`
**Entregables:** proyecto desplegado, auth funcionando, migraciones aplicadas, layout base con tokens de diseño definidos, worker de cola operativo.
**Aceptación:**
- [ ] `get_advisors` (security + performance) sin hallazgos críticos
- [ ] Un usuario de la org A no puede leer ni un registro de la org B (probado)
- [ ] Un job encolado sobrevive a un reinicio del worker
- [ ] Tokens de color semántico definidos (rojo=expuesto, ámbar=incompleto, verde=verificado)
**Depende de:** nada

---

### S2 — Ingesta
**Qué:** GitHub App (solo lectura) + upload de zip. Detección de stack. Storage temporal del código.
**Agente:** `backend-architect` · **Skills:** `context7` para la API de GitHub
**Entregables:** flujo de conexión de repo, upload de zip, detección de stack por lockfiles (`package.json`+`next.config` → Next.js; `pubspec.yaml` → Flutter; `pyproject.toml` → Python), política de retención y borrado.
**Aceptación:**
- [ ] Se puede conectar un repo privado real y leerlo
- [ ] Se puede subir un zip sin tener cuenta de GitHub
- [ ] El stack se detecta correctamente en 5 proyectos de prueba distintos
- [ ] El código se borra según la política declarada, verificable
**Depende de:** S1

---

### S3 — Motor de análisis
**Qué:** tree-sitter → grafo de símbolos y referencias → PageRank. Mapa de rutas/features. Lectura de schema real.
**Agente:** `backend-architect` · **Ver:** `DECISIONS.md` D13
**Entregables:** índice del repo persistido en `code_index`; grafo navegable; lista de rutas = features; schema, RLS y roles leídos de la DB real (`pg_policies`, `information_schema`); pipeline por etapas resumible.
**Aceptación:**
- [ ] Indexa un repo de 50k+ líneas sin romperse
- [ ] Cada etapa se puede reintentar sola sin rehacer todo
- [ ] Las rutas detectadas coinciden con las reales en 3 proyectos Next.js
- [ ] Costo por indexado registrado en `cost_breakdown`
**Depende de:** S2

---

### S4 — Pilares de chequeos
**Qué:** los tres pilares. Detalle completo de chequeos en el spec, sección 5.
**Agente:** `security-auditor` (pilar 1) + `backend-architect` (pilares 2 y 3) · **Skills:** `supabase-audit-rls`, `secret-leak-detector`
**Entregables:**
- **Pilar 1 Seguridad:** tablas sin RLS, RLS que deja leer filas ajenas (simulación de claims JWT + `ROLLBACK`), secrets en el repo, service role key en el frontend, endpoints sin auth, buckets públicos, PII en logs
- **Pilar 2 Completitud:** falta reset de contraseña / verificación de email / logout / borrado de cuenta / edición de perfil, acciones destructivas sin confirmar, formularios sin labels ni validación, estados de carga/vacío/error faltantes, links rotos, páginas huérfanas, placeholders olvidados, overflow horizontal, axe-core
- **Pilar 3 Higiene:** borrado de cuenta ausente, cookies/trackers antes del consentimiento, trackers presentes, `/privacy` y `/terms` ausentes, banner ausente
**Aceptación:**
- [ ] Cada hallazgo trae evidencia (`archivo:línea` o grabación). **Sin evidencia no se emite** (D14)
- [ ] Cada chequeo declara su nivel de confianza; los de confianza media se rotulan como "a revisar"
- [ ] La verificación de RLS **no escribe nada** en la DB del usuario (probado con log de transacciones)
- [ ] Cero hallazgos de crítica estética (D6)
**Depende de:** S3

---

### S5 — Agente de navegación
**Qué:** agente que navega la app desplegada, intenta tareas reales y **graba todo**. Ver `DECISIONS.md` D2.
**Agente:** `test-automator` · **Skill:** `agent-browser`
**Entregables:** set curado de tareas por tipo de app (registrarse, recuperar contraseña, logout, borrar cuenta, intentar leer datos de otro usuario, completar el flujo principal); grabación de video de cada intento; reporte estructurado de dónde se trabó.
**Aceptación:**
- [ ] Ejecuta las tareas contra una app real y produce grabación utilizable
- [ ] Detecta correctamente un flujo faltante plantado a propósito
- [ ] Detecta correctamente un acceso indebido plantado a propósito
- [ ] Costo por corrida registrado y bajo $0.50
- [ ] Nunca ejecuta acciones destructivas reales sin autorización
**Depende de:** S3

---

### S6 — Generación de video
**Qué:** storyboard estructurado → TTS → render → clip de 60-90s por hallazgo.
**Agente:** `ai-engineer` · **Ver:** `DECISIONS.md` D10, D11, D12
**Entregables:** decisión Motion Canvas vs Remotion resuelta con prototipo; capa de TTS intercambiable (Azure/Google default); guion generado desde el hallazgo + la grabación; efectos de zoom, dim y highlight; subtítulos y transcripción buscable.
**Aceptación:**
- [ ] Un video de hallazgo real generado de punta a punta, mirable y entendible por alguien no técnico
- [ ] Duración entre 60 y 90 segundos
- [ ] **COGS real medido** sobre 5-10 renders (D16)
- [ ] Cambiar de proveedor de TTS es un cambio de config, no de código
- [ ] Transcripción disponible y buscable
**Depende de:** S4 + S5 (necesita hallazgos y grabaciones que narrar)

---

### S7 — Entrega y dashboard
**Qué:** la pantalla donde el usuario ve todo. **Es donde se gana o se pierde el producto.**
**Agente:** `frontend-developer` + `ui-ux-designer` · **Skills obligatorias:** `ui-ux-pro-max`, `high-end-visual-design`, `ui-animation`, `ux-writing`
**Entregables:** lista de hallazgos priorizada (máx. 3 destacados, resto colapsado); pantalla de hallazgo con el video como protagonista; botón de copiar prompt de arreglo; marcar como resuelto; progreso en vivo mientras corre la auditoría.
**Aceptación:**
- [ ] Máximo 3 hallazgos como "hacé esto ya" (D15)
- [ ] Un hallazgo crítico y uno menor se ven claramente distintos
- [ ] Cero jerga técnica en texto visible
- [ ] Todos los estados diseñados: carga, vacío, error, sin permisos, job fallado, repo demasiado grande
- [ ] Se ven hallazgos apareciendo antes de que termine la auditoría completa
- [ ] Probado con una persona no técnica que entienda qué hacer sin ayuda
**Depende de:** S6

---

### S8 — Capas secundarias
**Qué:** chat Q&A sobre el proyecto + sección "Cómo funciona mi proyecto" con videos tutoriales por módulo.
**Agente:** `ai-engineer` · **Ver:** `DECISIONS.md` D18
**Entregables:** chat con retrieval sobre el grafo estructural (no embeddings puros), **con citas a archivo:línea**; videos tutoriales por módulo generados a pedido.
**Aceptación:**
- [ ] Toda respuesta del chat cita su fuente
- [ ] Cuando no sabe, lo dice — no inventa
- [ ] Reutiliza el índice de S3 sin re-indexar
**Depende de:** S3 (chat) y S6 (tutoriales)

---

### S9 — Monetización
**Qué:** planes, pagos, límites y **costo visible antes de gastar**. Ver `DECISIONS.md` D16.
**Agente:** `payment-integration`
**Entregables:** pago único por auditoría inicial + suscripción de monitoreo; contadores de uso en unidades concretas; costo en dólares mostrado antes de cada operación cara.
**Aceptación:**
- [ ] **Cero uso de la palabra "créditos"** en la UI
- [ ] Antes de generar un video o correr una auditoría, el usuario ve qué le va a costar
- [ ] Los límites del plan se aplican correctamente y el mensaje al llegar al tope es claro y accionable
**Depende de:** S1

---

### S10 — Confianza y privacidad (transversal)
**Qué:** lo que hace que alguien se anime a subir el código de su negocio.
**Agente:** `security-auditor` + `legal-advisor`
**Entregables:** política de retención, no-entrenamiento y borrado, explícita y visible; borrado de cuenta y de proyecto reales; disclaimers de "señales a revisar, no dictamen legal" (D7); cifrado de credenciales de terceros.
**Aceptación:**
- [ ] El usuario puede borrar su proyecto y su cuenta, y el código desaparece de verdad (verificado)
- [ ] Ningún texto del producto dice "viola el GDPR artículo X"
- [ ] `/security-review` + `supabase-audit-rls` + `secret-leak-detector` en verde
- [ ] **caughtcode pasa su propia auditoría** (dogfooding, ver `CLAUDE.md`)
**Depende de:** transversal, se verifica al final de cada ola

---

## 3. Olas de ejecución

```
OLA 1 (paralelo)     S1 Fundación · S2 Ingesta · prototipo de S6 (decidir motor de video)
                     └─ objetivo: infraestructura lista + riesgo del video resuelto temprano

OLA 2                S3 Motor de análisis
                     └─ bloqueante: todo lo demás depende del índice

OLA 3 (paralelo)     S4 Chequeos · S5 Agente de navegación

OLA 4 (VERTICAL)     Un hallazgo de punta a punta: detectar → demostrar → video → prompt
                     └─ ⚠️ GATE: si acá el formato no convence, replantear antes de seguir

OLA 5 (paralelo)     S6 Video completo · S7 Dashboard

OLA 6 (paralelo)     S8 Capas secundarias · S9 Monetización

OLA 7                S10 Verificación final + dogfooding
```

---

## 4. Definition of done global

- [ ] `typecheck`, `lint` y `build` en verde
- [ ] RLS verificada en todas las tablas; `get_advisors` sin críticos
- [ ] Todos los hallazgos con evidencia; cero afirmaciones sin respaldo
- [ ] COGS real medido y documentado
- [ ] Cero jerga técnica en texto visible al usuario
- [ ] Todos los estados de UI diseñados
- [ ] caughtcode pasa su propia auditoría
- [ ] Una persona no técnica completa el flujo sin ayuda
- [ ] `PROGRESS.md`, `MEMORY.md` y `DECISIONS.md` actualizados

---

## 5. Variables de entorno necesarias

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY          # solo server-side, nunca en el bundle
GITHUB_APP_ID / GITHUB_PRIVATE_KEY / GITHUB_WEBHOOK_SECRET
ANTHROPIC_API_KEY                  # análisis y guiones
AZURE_SPEECH_KEY / AZURE_SPEECH_REGION   # TTS default
STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET
```

Gestionar con `vercel env`. **Nunca commitear un `.env`** — es literalmente uno de los hallazgos que el producto detecta.

---

## 6. Pendientes de decisión

| Tema | Cómo se resuelve | Cuándo |
|---|---|---|
| Motion Canvas vs Remotion | Prototipo de una escena con código animado | Ola 1 |
| Precio concreto | Después de medir COGS real | Ola 5 |
| Frameworks con prompts curados | Next.js/React + Supabase primero; Python y Flutter candidatos | Ola 2 |
| Licencia de Remotion (si se elige) | Confirmar por escrito con su equipo comercial | Antes de escalar |
