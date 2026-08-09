# Auditor de apps hechas con IA — Diseño

**Fecha:** 2026-08-09
**Estado:** Diseño aprobado, pendiente de plan de implementación
**Nombre de trabajo:** vibecoder-copilot

---

## 1. Qué es

Una herramienta que audita apps construidas con IA ("vibe coding") por gente sin formación técnica, encuentra lo que está roto o es peligroso, **lo demuestra en video** y entrega el prompt exacto para arreglarlo.

La diferencia con todo lo que existe no es la cobertura de chequeos: es que **un agente navega la app de verdad, intenta romperla, y esa grabación se convierte en la explicación**. No es un reporte que el usuario tiene que interpretar — es la evidencia de lo que pasó, narrada en lenguaje llano.

Además ofrece dos capas secundarias — no el valor principal, pero incluidas desde el diseño: una sección "Cómo funciona mi proyecto" con videos tutoriales por módulo generados a pedido, y un **chat Q&A** sobre el propio proyecto ("¿dónde se define el rol de admin?"), que reutiliza el mismo motor de análisis sin costo extra de infraestructura.

---

## 2. El problema

El público objetivo son founders, solopreneurs y no técnicos que construyeron su app con Claude Code, Cursor, Lovable, Bolt, v0 o Replit Agent, y no pueden evaluar si lo que tienen es seguro, está completo, o es publicable.

### Evidencia del dolor

- **CVE-2025-48757**: más de 170 proyectos de Lovable expuestos por RLS mal configurado.
- **Incidente BOLA de Lovable (abril 2026)**: código fuente expuesto durante 48 días.
- **Wiz Research en Base44** (julio 2025): endpoints expuestos permitían crear una cuenta verificada en apps privadas ajenas usando solo el `app_id`.
- **Moltbook**: vulnerado en menos de 3 minutos tras lanzar; 35.000 emails y 1,5M de tokens de auth expuestos. Su fundador: *"no escribí ni una línea de código"*.
- **Escape.tech** escaneó 5.600 apps vibe-coded: +2.000 vulnerabilidades, 400+ secrets expuestos, 175 casos de datos personales a la vista.
- Cita textual de un founder no técnico afectado: *"me están atacando… las API keys al tope, gente saltándose la suscripción, creando cosas random en la base de datos"*.
- **WorkOS** sobre apps vibe-coded: *"el reset de contraseña es el flujo más shippeado y menos testeado"* y *"no existe flujo de borrado de cuenta"*.

### Lo que la evidencia NO respalda

No se encontró **ningún** usuario pidiendo explícitamente "explicame mi propio código" o "quiero un video tutorial de mi app". El pedido real es *"arreglame esto"*, *"no sé por qué se rompió"*, *"¿esto es seguro?"*.

**Conclusión que define el producto:** la comprensión del código es un medio, no un fin. La gente la necesita para poder *actuar*. Por eso el producto entra por el problema (auditoría) y no por la explicación.

---

## 3. Panorama competitivo

| Producto | Qué hace | Por qué no nos tapa |
|---|---|---|
| **Vibe App Scanner** ($19-39/mes) | 8 pilares: seguridad 150+ checks, RLS Supabase, secrets, config, infra, SEO, accesibilidad, performance | Output para **agentes de IA** (SARIF, MCP, copy-paste fixes). Asume lector técnico. Sin video, sin lenguaje llano |
| **Aikido / Backslash / Escape.tech / Snyk** | Seguridad seria | Hablan a devs. Un no técnico no puede accionar un "CWE-89 en línea 45" |
| **Cursor Bugbot / CodeRabbit** | Code review con IA | Para developers, dentro del PR |
| **Vibe Code Audit** (humano, $500-3.000) | Auditoría manual, fractional CTO, 3-10 días | Caro, lento, no escala |
| **RepoClip / Midrender (YC)** | Repo → video | Video **promocional/marketing**, no diagnóstico |
| **repo-explainer, code2tutorial, ExplainGithub, NotebookLM** | Repo → tutorial/video, gratis | Explicación genérica, sin hallazgos accionables |
| **Lovable Chat Mode Agent** | Q&A sobre el código, nativo y gratis | Ya ocupa el nicho de "preguntale a tu proyecto" |
| **Cookiebot / Termly / Osano / CookieYes** | Escaneo de cookies y consentimiento | Todos crawlean el **sitio publicado**, ninguno lee el repo |

### La diferenciación defendible

De las ~20 herramientas del sector relevadas, **ninguna usa video ni lenguaje llano**. Todas asumen un lector técnico del otro lado.

El wedge no es "seguridad" — es **"seguridad demostrada de manera que un no técnico entienda y pueda actuar"**. Es un problema de comunicación y de prueba, no de cobertura de chequeos.

---

## 4. El núcleo: el agente como detector, prueba y video

Un agente de IA con control de browser navega la app desplegada e intenta tareas concretas: registrarse, recuperar la contraseña, borrar la cuenta, entrar como usuario común e intentar leer datos de otro.

Ese agente cumple tres funciones simultáneas:

| Función | Cómo |
|---|---|
| **Detector** | Encuentra el problema intentando ejecutarlo |
| **Prueba** | Si el agente lo hizo, no es un falso positivo ni una alucinación |
| **Video** | La grabación de lo que hizo **es** el material del video |

Esto resuelve el riesgo más grave del producto —que el sistema alucine y el usuario no pueda detectarlo— y elimina el costo de componer escenas: no hay que ilustrar nada, hay que narrar lo que ocurrió.

Ejemplo del output:

> *"Me registré en tu app como usuario común. Con esa cuenta pude entrar a la facturación de todos tus otros clientes. Mirá."* — y se ve en pantalla.

Costo estimado: $0.01–$0.30 por tarea del agente. Una auditoría de 5-10 tareas cuesta centavos.

---

## 5. Los tres pilares

### Pilar 1 — Seguridad

| Chequeo | Método | Fiabilidad |
|---|---|---|
| Tablas con datos de usuario sin RLS | Lectura de `pg_policies` vía SQL | Alta |
| RLS que permite leer filas de otro usuario | Simulación de claims JWT dentro de transacción con `ROLLBACK` | Alta |
| Secrets en el repo (`.env` commiteado, claves en cliente) | Escaneo estático tipo gitleaks | Alta |
| Service role key expuesta en el frontend | Análisis estático del bundle | Alta |
| Endpoints sin autenticación | Grafo de rutas + prueba del agente | Alta |
| Storage buckets públicos con datos privados | API de Supabase | Alta |
| PII en logs | Heurística sobre llamadas a logger | Media — presentar como "candidatos a revisar" |

### Pilar 2 — Completitud funcional

| Chequeo | Método | Fiabilidad |
|---|---|---|
| Falta recuperación de contraseña | Rutas + config de Supabase Auth + agente | Media-alta |
| Falta verificación de email | Config de auth + agente | Media-alta |
| Falta logout con invalidación server-side | Rutas + agente | Media-alta |
| Falta borrado de cuenta | Rutas/RPC + agente | Media-alta |
| Falta edición de perfil | Rutas | Media |
| Acciones destructivas sin confirmación | DOM + agente | Media |
| Formularios sin labels | axe-core | Alta |
| Formularios sin validación ni mensajes de error | Agente (submit inválido) | Media |
| Estados de carga / vacío / error faltantes | Runtime forzado (throttle, mock 500, data vacía) | Media |
| Links rotos y páginas huérfanas | Crawler + grafo de rutas | Alta |
| Placeholders olvidados (`Lorem ipsum`, `TODO`, `Your Company Name`) | grep | Muy alta |
| Overflow horizontal en mobile | `scrollWidth > clientWidth` en varios viewports | Alta |
| Contraste, tap targets, foco visible | axe-core | Alta |

### Pilar 3 — Higiene de tienda y consentimiento

| Chequeo | Método | Fiabilidad |
|---|---|---|
| Falta borrado de cuenta (App Store 5.1.1(v) desde jun-2022, Google Play desde dic-2023) | Rutas/RPC + agente | Alta |
| Cookies o trackers que se disparan antes del consentimiento | Crawl dinámico, captura de `Set-Cookie`/`document.cookie` pre-interacción | Alta |
| Presencia de trackers (GA4, Meta Pixel, TikTok Pixel) | Detección de scripts y dominios | Alta |
| `/privacy` y `/terms` ausentes o 404 | Crawler | Alta |
| Banner de consentimiento ausente | DOM | Alta |

**Nota:** el borrado de cuenta aparece en los tres pilares — es agujero de seguridad, flujo faltante y causal de rechazo en las tiendas. Es el hallazgo estrella del producto.

### Capas secundarias (no el valor principal, pero en el diseño desde el inicio)

- **"Cómo funciona mi proyecto"**: videos tutoriales por módulo, generados a pedido, reusando el motor de análisis del núcleo.
- **Chat Q&A sobre el proyecto** ("¿dónde se define el rol de admin?"): reusa el mismo índice/grafo estructural, sin costo extra de infraestructura. Lovable ya lo regala nativo dentro de su propio editor — pero un usuario que construyó con Claude Code, Cursor, Bolt o v0 no tiene ese sustituto, así que sigue sumando valor fuera del ecosistema Lovable. Se construye igual, sin depender de qué plataforma generó el proyecto.

---

## 6. Arquitectura

### Motor de análisis

Enfoque de Aider: **tree-sitter** parsea el repo → grafo de símbolos y referencias → **PageRank** calcula qué archivos son centrales. Determinístico, barato, auditable. El LLM entra **solo al final**, sobre el subgrafo ya filtrado.

Sourcegraph abandonó los embeddings por costo y escalabilidad; la evidencia 2026 favorece **retrieval estructural primero, razonamiento con contexto largo después**.

Detalles:
- **Features = rutas**: en Next.js App Router cada `page.tsx` es una feature; en Flutter, el config de `go_router`. No hay que "descubrirlas".
- **Schema y roles**: leer la base de datos real (`pg_policies`, `information_schema`) en vez de parsear archivos SQL. Refleja el estado aplicado, no la intención.
- **Prisma/Drizzle**: usar DMMF o `drizzle-kit pull` en vez de regex sobre el schema.

### Agente de navegación

Vercel Agent Browser, Browser Use o Playwright + LLM multimodal. Ejecuta un set curado de tareas por tipo de app y graba video de cada intento.

### Generación de video

- **Motor**: evaluar **Motion Canvas** (MIT, componente de cámara nativo para zoom/dim, diseñado para sincronizar con voiceover) frente a **Remotion**. Remotion exige licencia comercial desde 4 empleados: tier "Automators" a $0.01/render con **mínimo $100/mes**, y hay zona gris legal para SaaS que renderiza en nombre de terceros que conviene confirmar por escrito antes de escalar.
- **TTS**: capa intercambiable. Por defecto **Azure Neural HD** (tiene voces es-AR específicas, ~$0.022/1k caracteres) o Google Chirp3. **ElevenLabs no como default** — es 5-10x más caro y a volumen define si el margen cierra. Queda como opción de plan alto.
- **Duración**: clips de **60-90 segundos por hallazgo**. El engagement cae más del 50% pasados los 6 minutos (estudio MIT/edX sobre 6,9M de sesiones), y el engagement mediano es ~4,5 min sin importar la duración total.
- **Prosodia**: SSML con pausas explícitas, ritmo 10-15% más lento que el default. El riesgo no es que la voz sea sintética (ya es aceptado) sino que suene barata.

### Ingesta

GitHub App (solo lectura) **y** upload manual de zip. El target puede no tener GitHub ni saber qué es.

### Datos de prueba

- **Para verificar RLS**: simulación de claims JWT dentro de una transacción con `ROLLBACK`. No crea usuarios, no escribe nada, no toca datos reales, **funciona en plan Free de Supabase**.
- **Para que el usuario pruebe su propio admin panel**: crear usuarios reales con `auth.admin.createUser()` en su proyecto, marcados como de prueba y borrables de un click, con permiso explícito previo.
- **Descartado**: Supabase branching. Exige plan **Pro del usuario** ($25/mes) y factura contra su cuenta sin cubrirse por su límite de gasto.

### Multi-proyecto desde el día 1

El modelo de datos debe soportar "un usuario gestiona N proyectos de clientes" desde el inicio, aunque el plan de agencia no se venda todavía. Lovable ya tiene un Solutions Partner Program y hay agencias facturando $100k/mes construyendo con estas herramientas para clientes; necesitan mostrarle al cliente que revisaron la app. Si el esquema no lo soporta, hay que rehacerlo después.

---

## 7. Flujo del usuario

1. Conecta el repo (GitHub o zip) y opcionalmente la URL de la app desplegada.
2. Análisis estructural del código (barato, sin LLM).
3. El agente navega la app e intenta el set de tareas del pilar correspondiente.
4. Se consolidan los hallazgos, **priorizados por impacto**, no por volumen.
5. Por cada hallazgo: video de 60-90s con la grabación narrada + explicación en lenguaje llano + prompt de arreglo listo para pegar.
6. La sección "Cómo funciona mi proyecto" queda disponible con videos tutoriales por módulo, generados a pedido.
7. Ante un push nuevo: se detecta qué cambió, se marca qué quedó desactualizado, y el usuario decide si vuelve a auditar.

### Reglas de presentación

- **Máximo 3 hallazgos como "hacé esto ya"**. El 67% de las alertas de seguridad se ignoran por saturación; en auditorías SEO el patrón es idéntico: un reporte con 200 filas muere en una planilla.
- **Todo hallazgo anclado a `archivo:línea`** verificable, o a la grabación del agente. Nada de afirmaciones sin evidencia.
- Cuando la confianza es baja, decirlo. Nunca inventar para completar.

---

## 8. Modelo de negocio

**Híbrido**: pago único por la auditoría inicial completa (momento de máxima ansiedad, antes de lanzar) + suscripción opcional de monitoreo que vuelve a revisar cada vez que la IA toca el código.

**Nada de "créditos" ambiguos.** Es la queja universal de la categoría — Lovable, HeyGen y todo el sector. Cita textual de un usuario de Lovable: *"cuando hago una operación no sé cuántos créditos va a usar. ¿Resultado? Mis créditos mueren más rápido de lo que espero."* En su lugar: cuota fija visible en unidades concretas, y **mostrar el costo en dólares antes de generar**.

### Economía unitaria de referencia

| Componente | Realista | Pesimista |
|---|---|---|
| LLM (análisis + guion) | $0.40 | $1.50 |
| TTS | $0.15 | $1.10 (ElevenLabs) |
| Agente de navegación | $0.10 | $0.50 |
| Render | $0.15 | $0.30 |
| **Total por auditoría** | **~$0.80** | **~$3.40** |

Precio de referencia del mercado: RepoClip cobra $2-6 por video; Vibe App Scanner $19-39/mes; auditorías humanas $500-3.000.

⚠️ El costo de render para contenido con código animado no tiene benchmark público — los ejemplos oficiales de Remotion son composiciones simples. **Medirlo con la composición real antes de fijar precio público.**

---

## 9. Riesgos

| Riesgo | Gravedad | Mitigación |
|---|---|---|
| **Absorción de plataforma.** Lovable ya lanzó chat Q&A de código y escaneo de seguridad nativos. No es amenaza futura, ya ocurrió | Alta | No competir en features que la plataforma madre regala. La demostración en video y el lenguaje llano son lo que no van a construir |
| **Vibe App Scanner** ya cubre 8 pilares a $19/mes | Alta | No competir por cobertura. El wedge es comunicación y prueba |
| **Alucinación indetectable por el usuario.** DeepWiki tiene casos documentados de errar con total confianza; Greptile: 82% de detección con 11 falsos positivos por corrida | Alta | El agente demuestra el hallazgo. Grounding `archivo:línea` obligatorio |
| **Saturación de hallazgos** mata la confianza | Media | Máximo 3 acciones prioritarias visibles |
| **Riesgo legal por dar consejo jurídico** | Media | Framing de "señales a revisar" y "esto es lo que un revisor de App Store o un regulador podría marcar". Nunca "viola el GDPR artículo X". Disclaimer prominente |
| **Licencia de Remotion** | Media | Evaluar Motion Canvas (MIT). Si se usa Remotion, confirmar el encaje por escrito antes de escalar |
| **COGS de render sin medir** | Media | Benchmark de 5-10 renders reales antes de publicar precios |
| **Construir el alcance completo de una** (decisión tomada conscientemente: se construye con un agente orquestador coordinando agentes especializados por subsistema, no en etapas manuales) | Media | Cada subsistema (motor de análisis, agente de navegación, generación de video, pilares de chequeos, multi-tenant/billing) se especifica y verifica de forma independiente antes de integrar, para no descubrir tarde que el formato video no funciona |
| **La gente no compra prevención.** Solo 49-63% aumenta el gasto en seguridad incluso *después* de una brecha | Media | Aprovechar el miedo ambiental fresco (CVE de Lovable, incidentes recientes). Es una ventana que se cierra |

---

## 10. Fuera de alcance

| Descartado | Por qué |
|---|---|
| **Crítica estética con LLM** ("mejorá la jerarquía visual") | Correlación con la calidad real de 0.194 (LLM) vs 0.556 (humanos); similitud semántica humano-LLM de 0.046. Es ruido con apariencia de insight, y contamina la credibilidad de los hallazgos duros |
| **Auditoría GDPR completa** | Cero casos documentados de multa a un solo-founder. Las cosas interesantes (validez del consentimiento, completitud del borrado) no son detectables desde el código |
| **Puntaje de cumplimiento WCAG** | Solo 30-40% de los criterios son automatizables. Un "97% accesible" genera falsa confianza |
| **COPPA / verificación de edad** | No tiene firma técnica detectable |
| **Doble opt-in como violación** | Ni siquiera es requisito legal en EE.UU. Marcarlo sería factualmente incorrecto |
| **Consistencia de design system** | Medible pero no interpretable: una paleta rica puede ser intencional |
| **Claims de residencia de datos / Schrems II** | Se puede reportar la región como hecho, no dictaminar cumplimiento |
| **Firebase y otros backends** | Fase 2. El MVP se enfoca en Supabase |
| **Supabase branching** | Exige plan Pro del usuario y le factura a él |
| **Narración multi-idioma** | Solo español en el MVP |

---

## 11. Preguntas abiertas

1. **Nombre del producto** — sin definir.
2. **Motor de video** — Motion Canvas vs Remotion: decidir tras un prototipo de una escena real con código animado.
3. **Precio concreto** — definir tras medir el COGS real.
4. **Frameworks del MVP** — el motor LLM es multi-lenguaje por naturaleza; hay que decidir para cuáles se curan prompts específicos (Next.js/React y Supabase son prioritarios por ser el stack propio; Python y Flutter, candidatos).
5. **Política de datos** — retención, no-entrenamiento y borrado deben definirse explícitamente. El target no técnico necesita confianza para subir el código de su negocio. Oportunidad relacionada: los proyectos vibe-coded suelen tener `.env` commiteados; detectarlo es a la vez un hallazgo de seguridad y una demostración de valor inmediata.
