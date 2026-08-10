# caughtcode — Instrucciones de trabajo

> Auditor de apps hechas con IA. Encuentra lo que está roto o es peligroso, **lo demuestra en video**, y entrega el prompt exacto para arreglarlo.

---

## 🚦 ANTES DE HACER NADA

Leé en este orden, siempre, al arrancar sesión:

1. **`docs/PROGRESS.md`** — dónde quedó todo, qué sigue exactamente
2. **`docs/DECISIONS.md`** — qué ya se decidió y por qué. **No re-litigar lo que está acá.**
3. **`docs/MASTER_PLAN.md`** — el plan de construcción completo
4. **`docs/MEMORY.md`** — gotchas y aprendizajes de sesiones anteriores

Si una decisión de `DECISIONS.md` te parece incorrecta, decilo explícitamente y esperá respuesta. No la cambies por tu cuenta: cada una está respaldada por investigación con fuentes.

---

## 🎯 QUÉ ESTAMOS CONSTRUYENDO (y qué no)

**El valor principal:** un agente navega la app del usuario, intenta romperla, y la grabación de lo que hizo se convierte en la explicación narrada. No es un reporte que hay que interpretar — es la evidencia de lo que pasó.

**La diferenciación NO es la cobertura de chequeos.** Vibe App Scanner ya tiene 8 pilares a $19/mes. Nuestro wedge es **comunicación y prueba**: seguridad demostrada de forma que un no técnico entienda y pueda actuar. Cada vez que estés por agregar un chequeo más en vez de mejorar cómo se comunica un hallazgo, estás yendo en la dirección equivocada.

**El usuario es NO TÉCNICO.** Construyó su app con Claude Code, Cursor, Lovable o Bolt, y no puede evaluar si está bien. No sabe qué es RLS, CWE, ni un CVE. Todo lo que ve tiene que estar en su idioma.

---

## ⛔ REGLAS DURAS DEL PRODUCTO (no negociables)

Estas salen de la investigación documentada en `DECISIONS.md`. Violarlas rompe el producto:

1. **Ninguna afirmación sin evidencia.** Todo hallazgo apunta a `archivo:línea` verificable o a la grabación del agente. Si el sistema no está seguro, lo dice. Nuestro usuario **no puede detectar una alucinación** — por eso DeepWiki puede darse el lujo de equivocarse y nosotros no.

2. **Máximo 3 hallazgos como "hacé esto ya".** El 67% de las alertas de seguridad se ignoran por saturación. Un reporte con 50 filas muere en una planilla. El resto va colapsado, en segundo plano.

3. **Nada de "créditos" ambiguos.** Mostrar el costo en dólares y en unidades concretas **antes** de gastar. Es la queja universal de la categoría.

4. **Nunca dictaminar sobre legalidad.** Se dice *"esto es lo que un revisor de App Store o un regulador podría marcar"*. Jamás *"viola el GDPR artículo X"*. Disclaimer visible.

5. **Nunca tocar producción del usuario sin permiso explícito.** Para verificar RLS se usa simulación de claims JWT dentro de transacción con `ROLLBACK` — no se escribe nada. Crear usuarios de prueba requiere confirmación previa y son borrables de un click.

6. **Nada de crítica estética generada por IA.** Está prohibido emitir hallazgos tipo "mejorá la jerarquía visual". La evidencia académica dice que ese juicio de un LLM correlaciona 0.194 con la calidad real (los humanos, 0.556). Un hallazgo blando contamina la credibilidad de los duros.

---

## 🏗 ESCALABILIDAD — decisiones que no se revierten barato

- **Multi-tenant desde la primera línea.** El modelo de datos soporta "un usuario gestiona N proyectos, potencialmente de N clientes distintos" desde el día 1. Las agencias son un canal real (Lovable tiene Partner Program; hay agencias facturando $100k/mes). Si el esquema no lo contempla, hay que rehacerlo entero después.
- **Todo trabajo pesado va a una cola, nunca a un request.** Análisis de repo, corrida del agente, render de video: son minutos, no milisegundos. Jobs con estado persistido, reanudables, con progreso visible para el usuario.
- **Pipeline por etapas, resumible.** Los repos grandes rompen el procesamiento monolítico (le pasa a Greptile cerca del 99% del AST). Cada etapa guarda su resultado y se puede reintentar sola.
- **Costo por operación medido y registrado siempre.** Cada job guarda cuánto costó en LLM, TTS, agente y render. Sin esto no se puede fijar precio ni detectar una regresión de costos.
- **RLS en todas las tablas, sin excepción.** Sería vergonzoso que el auditor de RLS filtre datos entre clientes. Correr `get_advisors` (security + performance) después de **cada** migración.
- **Proveedores detrás de una interfaz.** TTS, motor de video y LLM se cambian por configuración, no por refactor. Ya sabemos que ElevenLabs no es el default y que Remotion tiene un problema de licencia sin resolver.

---

## 🎨 DISEÑO — es el producto, no la decoración

Nuestra única ventaja defendible es que se entiende. Un diseño genérico mata esa ventaja.

**Obligatorio en toda UI nueva o retocada:** invocar las skills `ui-ux-pro-max` y `high-end-visual-design`. Animaciones: `ui-animation`. **Prohibido el look genérico de IA** — gradiente violeta-azul, tres cards iguales en fila, bordes grises de 1px, Inter por default, dark mode que nadie pidió. Esos patrones ya tienen nombre en la comunidad ("AI slop") y nuestro usuario objetivo los reconoce.

**Reglas concretas:**
- Jerarquía real: en cada pantalla hay **una** cosa más importante y se nota sin leer.
- El hallazgo crítico y el hallazgo menor **no** pueden verse igual.
- El video es el protagonista de la pantalla de hallazgo, no un adjunto.
- Sistema de color semántico y consistente entre videos y UI (ej. rojo = expuesto, ámbar = incompleto, verde = verificado OK). Se define una vez, se respeta siempre.
- Cero jerga en texto visible al usuario. "RLS" se dice *"las reglas que definen quién puede ver qué"*.

**Copy orientado al usuario:** usar las skills `ux-writing` / `copywriting` / `copy-editing`. Nunca transcribir literalmente instrucciones informales — entender la intención y reescribir con criterio. Tono: claro, directo, sin condescender. El usuario no es tonto, es no técnico.

---

## 🧭 PRACTICIDAD Y UX — cómo se siente usarlo

- **Time-to-first-value corto.** El usuario tiene que ver algo útil antes de terminar de configurar. Si la primera auditoría tarda 8 minutos, hay que mostrar hallazgos a medida que aparecen, no una barra girando.
- **Cada hallazgo termina en una acción, no en un diagnóstico.** Siempre hay un botón: copiar el prompt de arreglo, ver la demostración, marcar como resuelto.
- **Todo estado tiene diseño**: carga, vacío, error, sin permisos, job fallado, repo demasiado grande. No existe la pantalla en blanco.
- **Nada irreversible sin confirmar.** Y si algo cuesta dinero, se muestra cuánto antes de ejecutarlo.
- **Onboarding para alguien que quizá no tiene GitHub.** Upload de zip es ciudadano de primera, no un fallback escondido.

### 🪞 Dogfooding: caughtcode tiene que pasar su propia auditoría

Auditamos apps por flujos faltantes, estados sin diseñar, acciones destructivas sin confirmar, placeholders olvidados y falta de borrado de cuenta. **Nuestra propia app no puede fallar en eso.** Es criterio de aceptación, no aspiración.

---

## 🛠 STACK

| Capa | Elección |
|---|---|
| Web | **Next.js** (App Router) |
| Datos, auth, storage, realtime | **Supabase** |
| Deploy | **Vercel** |
| Análisis de código | tree-sitter + grafo de símbolos + PageRank (enfoque de Aider) |
| Agente de navegación | Vercel Agent Browser / Browser Use / Playwright + LLM |
| Video | Motion Canvas (MIT) vs Remotion — **decisión pendiente**, ver `DECISIONS.md` |
| TTS | Azure Neural HD (voces es-AR) o Google Chirp3. **ElevenLabs no es el default** |

No proponer alternativas al stack salvo pedido explícito.

**Antes de escribir código que use una librería o framework: traer docs actuales con `context7`.** No codear de memoria.
**Antes de tocar schema, RLS, auth o datos: `list_tables`. Después de cada migración: `get_advisors`.**

---

## 🤖 CÓMO TRABAJAR

- **Bug** → skill `superpowers:systematic-debugging`. Nunca parchear a ciegas.
- **Feature nueva** → `superpowers:brainstorming` antes de codear. TDD.
- **Al cerrar** → `superpowers:verification-before-completion`.
- **Antes de cualquier release** → `/security-review` + `supabase-audit-rls` + `secret-leak-detector`.
- **Tarea mecánica** (leer, resumir, auditar, boilerplate, fixtures, docs internas) → delegar al MCP `delegate`. **Excepción: copy orientado al usuario y decisiones de arquitectura no se delegan.**
- Grep/Glob exacto no se delega — ya es gratis.

**Reportar con honestidad.** Si los tests fallan, se dice con el output. Si algo se salteó, se dice. Nada de "listo" sobre algo no verificado.

---

## 🔄 ANTES DE CERRAR SESIÓN

1. Actualizar **`docs/PROGRESS.md`**: qué se hizo y se verificó, qué sigue exactamente, qué quedó a medias.
2. Sumar a **`docs/MEMORY.md`** cualquier gotcha, decisión táctica o cosa que costó descubrir.
3. Si se tomó una decisión de producto o arquitectura, registrarla en **`docs/DECISIONS.md`** con su porqué.
4. Árbol verde: `typecheck`, `lint`, `build`.
5. Commit.

**Regla de oro:** la sesión siguiente reconstruye todo desde estos archivos. Si algo vive solo en el chat, se perdió.

### Handoff — incluir siempre

```
🤖 MODELO: [Sonnet | Opus] · RAZONAMIENTO: [Bajo | Medio | Alto | Máx]
```

Opus para arquitectura, debug no obvio y decisiones irreversibles. Sonnet para implementación conocida, contenido y mantenimiento. En la duda, Opus.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
