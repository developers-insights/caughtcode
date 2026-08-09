# Fuente de la verdad — Decisiones y su evidencia

> Cada decisión de acá salió de investigación con fuentes. **No re-litigar sin datos nuevos.**
> Si algo parece mal, plantearlo explícitamente y esperar respuesta.

Última actualización: 2026-08-09

---

## D1 — El producto entra por auditoría, no por explicación

**Decisión:** el gancho es *"¿tu app es segura y está completa?"*, no *"te explico tu código"*.

**Por qué:** se buscaron citas reales de vibe coders describiendo su problema. **No se encontró ni una** persona pidiendo "explicame mi propio código" o "quiero un video tutorial de mi app". El pedido real es *"arreglame esto"*, *"no sé por qué se rompió"*, *"¿esto es seguro?"*.

**Evidencia del dolor real:**
- CVE-2025-48757: +170 proyectos de Lovable expuestos por RLS mal configurado
- Incidente BOLA de Lovable (abril 2026): código fuente expuesto 48 días
- Wiz Research en Base44 (jul-2025): se podía crear cuenta verificada en apps privadas ajenas con solo el `app_id`
- Moltbook: vulnerado en <3 min; 35.000 emails y 1,5M tokens expuestos. Su fundador: *"no escribí ni una línea de código"*
- Escape.tech sobre 5.600 apps vibe-coded: +2.000 vulnerabilidades, 400+ secrets, 175 casos de PII expuesta
- Founder no técnico, textual: *"me están atacando… las API keys al tope, gente saltándose la suscripción, creando cosas random en la base de datos"*

**Conclusión:** la comprensión del código es un medio, no un fin. Se necesita para poder *actuar*.

---

## D2 — El agente de navegación es detector, prueba y video a la vez

**Decisión:** el núcleo del producto es un agente que navega la app desplegada e intenta tareas reales. Su grabación es el material del video.

**Por qué:** resuelve simultáneamente los tres problemas más caros:
| Problema | Cómo lo resuelve |
|---|---|
| Alucinación indetectable por el usuario | Si el agente **lo hizo**, no es un falso positivo |
| Costo de producir video | No hay que componer escenas; hay que narrar lo que pasó |
| Credibilidad del hallazgo | La demostración es autoevidente |

**Costo:** $0.01–$0.30 por tarea. Una auditoría de 5-10 tareas cuesta centavos.
**Precedente:** una fintech desplegó un agente autónomo (ene-2026) que generó 700+ casos de test y detectó 43 bugs reales en 3 meses.

---

## D3 — La diferenciación es comunicación, no cobertura

**Decisión:** no competir por cantidad de chequeos.

**Por qué:** **Vibe App Scanner** (vibeappscanner.com) ya existe en producción con **8 pilares** — seguridad 150+ checks, RLS de Supabase, secrets, config, infra, SEO, accesibilidad/compliance, performance — a **$19-39/mes**, apuntando explícitamente a vibe coders y agencias.

**Pero:** su output está formateado para **agentes de IA** (SARIF, MCP, copy-paste fixes). De ~20 herramientas del sector relevadas, **ninguna usa video ni lenguaje llano**. Todas asumen lector técnico.

**Implicación operativa:** si estás por agregar un chequeo más en vez de mejorar cómo se comunica un hallazgo, vas en la dirección equivocada.

---

## D4 — Tres pilares: seguridad, completitud funcional, higiene de tienda y consentimiento

**Decisión:** ese alcance, en ese orden de prioridad. Construcción completa de una (decidido por el usuario), con subsistemas verificables por separado.

**Riesgo asumido conscientemente:** la evidencia histórica dice que nadie expandió pilares en el año 1 — Snyk tardó 5 años (y compró la empresa), Vanta 3, Datadog 7, Sentry 12. Se decidió igual construir completo con un agente orquestador coordinando especialistas.

**Mitigación:** cada subsistema se especifica y verifica independientemente antes de integrar, para no descubrir tarde que el formato video no convence.

---

## D5 — El borrado de cuenta es el hallazgo estrella

**Decisión:** priorizarlo en la UI y en el marketing.

**Por qué:** aparece en los tres pilares a la vez:
- **Seguridad/privacidad**: derecho de borrado
- **Completitud**: flujo faltante — *"no existe flujo de borrado de cuenta"* (WorkOS sobre apps vibe-coded)
- **Tienda**: obligatorio en **Apple App Store desde jun-2022** (Guideline 5.1.1 v) y **Google Play desde dic-2023**

Es binario, detectable, aplica sin importar el tamaño de la empresa, y la consecuencia es concreta y entendible: **te rechazan la app**. Cero interpretación legal.

---

## D6 — Fuera: crítica estética generada por IA

**Decisión:** prohibido emitir hallazgos de diseño subjetivos ("mejorá la jerarquía visual", "usá más whitespace").

**Por qué:** estudio comparando críticas de diseño humanas vs LLM sobre UI móvil:
- Correlación con la calidad real (Spearman): **humanos 0.556, LLM 0.194**
- Similitud semántica humano-LLM: **0.046** — no dicen lo mismo con otras palabras, **miran cosas distintas**

Además "MLLM as a UI Judge" (arXiv 2510.08783) confirma sensibilidad a position bias y baja fiabilidad prediciendo preferencias reales.

**Riesgo concreto:** si el usuario percibe un hallazgo como opinión genérica, empieza a dudar también de los de seguridad, que sí son sólidos.

**Lo que SÍ se hace de "UX":** flujos incompletos, estados faltantes, accesibilidad medible con axe-core, placeholders olvidados, links rotos, overflow horizontal. Todo objetivo y verificable. Por eso el pilar se llama **"Completitud funcional"**, no "UX/Diseño".

---

## D7 — Fuera: auditoría GDPR completa. Dentro: higiene de tienda y consentimiento

**Decisión:** módulo delgado, no auditor legal.

**Por qué:**
- **Cero casos documentados** de multa GDPR a un solo-founder. Todas son LinkedIn (€310M), Uber (€290M), Shein, Amazon. Decirle a un vibe coder "te pueden multar €20M" es técnicamente cierto y prácticamente engañoso.
- **CCPA**: umbral de $26.625M de facturación anual — el target está exento por definición.
- **European Accessibility Act**: microempresas (<10 empleados, <€2M) exentas para servicios.
- Lo interesante (validez del consentimiento, completitud del borrado, exposición Schrems II) **no es detectable desde el código**.

**Lo que sí entra:** borrado de cuenta (regla de plataforma, no ley), cookies/trackers que se disparan antes del consentimiento (la infracción más multada de la UE, y detectable dinámicamente), trackers presentes, `/privacy` y `/terms` ausentes, banner ausente.

**Hueco de mercado detectado:** ninguna herramienta de consentimiento (Cookiebot, Termly, Osano, CookieYes) escanea el **repo** — todas crawlean el sitio ya publicado. Detectarlo antes de deployar no lo hace nadie.

**Framing obligatorio:** *"esto es lo que un revisor de App Store o un regulador podría marcar"*. Nunca *"viola el GDPR artículo X"*. Es como se protege toda la categoría (Osano, Vanta, Termly).

---

## D8 — Fuera: puntaje de cumplimiento WCAG

**Decisión:** reportar cantidad de problemas encontrados, nunca un porcentaje de cumplimiento.

**Por qué:** axe-core detecta ~57% de los problemas **por volumen**, pero solo **30-40% de los criterios de éxito** de WCAG. Un "97% accesible" genera falsa confianza — exactamente el fallo que el producto existe para evitar.

---

## D9 — Datos de prueba sin tocar producción y sin exigir plan Pro

**Decisión:**
- **Verificar RLS**: simulación de claims JWT dentro de transacción con `ROLLBACK`. No crea usuarios, no escribe nada, **funciona en plan Free**.
- **Cuentas de prueba reales** (para que el usuario entre a su admin panel): `auth.admin.createUser()` en su propio proyecto, marcadas como de prueba, borrables de un click, con permiso explícito previo.

**Descartado — Supabase branching:** exige plan **Pro del usuario** ($25/mes, no del nuestro: las branches se crean sobre *su* proyecto), factura contra su cuenta, y **no está cubierto por su Spend Cap**. El target típico está en Free.

---

## D10 — TTS: Azure/Google por default, ElevenLabs no

**Decisión:** capa de TTS intercambiable. Default **Azure Neural HD** o **Google Chirp3**.

**Por qué:**
| Proveedor | Costo por 1k caracteres |
|---|---|
| ElevenLabs | ~$0.20 |
| Azure Neural HD | ~$0.022 |
| Google Chirp3 | ~$0.03 |
| OpenAI TTS-1 | ~$0.015 |

ElevenLabs es **5-10x más caro**. Además **Azure tiene voces es-AR específicas**, no solo "español neutro". A volumen, esa sola decisión define si el margen cierra. ElevenLabs queda como opción de plan alto.

**Sobre la calidad percibida:** el riesgo no es que la voz sea sintética (>70% de creadores ya usan voz IA en 2026), es que **suene barata**. Una creadora subió el watch time de 9s a 24s solo bajando el ritmo e insertando pausas — cambio de prosodia, no de motor. Usar SSML con pausas explícitas y ritmo 10-15% más lento que el default.

---

## D11 — Motor de video: pendiente, con sesgo hacia Motion Canvas

**Estado: DECISIÓN ABIERTA.** Resolver con un prototipo de una escena real con código animado.

**Remotion:**
- Gratis solo hasta 3 empleados. Tier "Automators": $0.01/render con **mínimo $100/mes**
- **Zona gris legal**: la licencia permite "un servicio que genera código Remotion con IA y lo renderiza", pero exige aprobación escrita para que terceros rendericen sus propios proyectos. Nuestro caso está del lado bueno, pero conviene confirmarlo por escrito antes de escalar
- Render Lambda: ~$0.0105/min en composiciones simples. **Sin benchmark público para código animado** — presupuestar 2-4x hasta medirlo

**Motion Canvas:** MIT, sin problema de licencia, **componente de cámara nativo** para zoom/dim, diseñado explícitamente para sincronizar con voiceover. Contra: no hay ecosistema de componentes React equivalente, más ingeniería.

**Revideo:** MIT, fork de Motion Canvas pensado para pipelines automatizados/headless.

---

## D12 — Duración: clips de 60-90 segundos

**Decisión:** un clip corto por hallazgo, no un video largo por proyecto.

**Por qué:** estudio MIT/edX sobre 6,9M de sesiones — el engagement cae **más del 50% pasados los 6 minutos**, y el engagement mediano es **~4,5 min sin importar la duración total** del video. Un video de 60 min tiene el mismo engagement mediano que uno de 10.

También aplica el **segmenting principle** de Mayer: se aprende más con segmentos a ritmo del usuario que con una unidad continua.

---

## D13 — Motor de análisis: estructural primero, LLM al final

**Decisión:** tree-sitter → grafo de símbolos y referencias → PageRank (enfoque de Aider). El LLM entra **solo al final**, sobre el subgrafo ya filtrado.

**Por qué:**
- Es determinístico, barato y auditable: calcula matemáticamente qué archivos son centrales en vez de que el LLM adivine
- **Sourcegraph abandonó los embeddings** por costo, escalabilidad y privacidad; se pasó a grafo + búsqueda
- La evidencia 2026 favorece retrieval estructural primero, razonamiento con contexto largo después. El contexto largo degrada de forma no obvia mucho antes del límite nominal

**Atajos que ya sabemos:**
- **Las rutas son las features**: cada `page.tsx` de Next.js App Router es una feature. No hay que "descubrirlas". Lo mismo con `go_router` en Flutter
- **Leer la base de datos real** (`pg_policies`, `information_schema`) en vez de parsear archivos SQL — refleja el estado aplicado, no la intención
- **Prisma/Drizzle**: usar DMMF o `drizzle-kit pull`, no regex sobre el schema

---

## D14 — Grounding obligatorio: nada sin evidencia

**Decisión:** todo hallazgo apunta a `archivo:línea` verificable o a la grabación del agente. Cuando la confianza es baja, se dice.

**Por qué:** casos documentados de sistemas similares alucinando con total confianza:
- **DeepWiki** asignó el build system equivocado a LibreOffice; inconsistencias en la wiki de LLVM. Un maintainer lo describió como publicar *"una realidad alternativa que no existe"*
- **Greptile**: 82% de detección pero **11 falsos positivos por corrida** (vs 2 de CodeRabbit)

**La diferencia crítica con ellos:** su público es técnico y puede contrastar. **El nuestro no puede.** El riesgo reputacional es mayor.

---

## D15 — Máximo 3 hallazgos prioritarios

**Decisión:** solo 3 hallazgos visibles como "hacé esto ya". El resto colapsado.

**Por qué:** **67% de las alertas de seguridad se ignoran** por saturación; 63% quedan sin atender, 42% ni se investigan. Un scan puede tirar 10.000 hallazgos de los cuales ~50 son explotables — el resto entrena al usuario a ignorar la herramienta.

En auditorías SEO el patrón es idéntico: *"cuando el cliente ve cientos de filas sin un veredicto claro, el reporte muere en una planilla"*.

---

## D16 — Precio híbrido, sin créditos ambiguos

**Decisión:** pago único por la auditoría inicial + suscripción opcional de monitoreo. **Nunca "créditos".** Mostrar el costo en dólares antes de gastar.

**Por qué:** es la queja universal de la categoría. Usuario de Lovable, textual: *"cuando hago una operación no sé cuántos créditos va a usar. ¿Resultado? Mis créditos mueren más rápido de lo que espero."* HeyGen: *"excedí mi límite en apenas 2 días"*.

**Contraejemplos que funcionan:** Synthesia vende minutos (predecible). Cursor Bugbot pasó de per-seat a $1-1.50 por review — pago por unidad de trabajo real, legible para el usuario.

**Economía unitaria de referencia (por auditoría):** realista ~$0.80, pesimista ~$3.40.
**Mercado:** RepoClip $2-6/video · Vibe App Scanner $19-39/mes · auditorías humanas $500-3.000.

⚠️ **Medir el COGS real de render antes de publicar precios.** No hay benchmark público para contenido con código animado.

---

## D17 — Multi-proyecto desde el día 1 (canal de agencias)

**Decisión:** el modelo de datos soporta "un usuario gestiona N proyectos de clientes" desde el inicio, aunque el plan de agencia no se venda todavía.

**Por qué:** Lovable ya institucionalizó el canal con su **Solutions Partner Program**; hay agencias facturando **$100k/mes** construyendo con estas herramientas para clientes. Necesitan evidencia mostrable de que revisaron la app antes de entregarla. Si el esquema no lo soporta, hay que re-arquitecturar después.

---

## D18 — El chat Q&A entra, como capa secundaria

**Decisión:** incluir chat Q&A sobre el proyecto, reusando el mismo índice/grafo estructural. No es el valor principal.

**Por qué se dudó:** Lovable ya lanzó "Chat Mode Agent" nativo y gratis; Claude Code y `@workspace` de Copilot también.

**Por qué entra igual:** cuesta casi nada (reusa el motor ya construido) y quien armó su app con **Claude Code, Cursor, Bolt o v0 no tiene ese sustituto** dentro de nuestro producto. Decisión del usuario, tomada con la evidencia sobre la mesa.

---

## D19 — Ingesta doble: GitHub y zip

**Decisión:** GitHub App (solo lectura) **y** upload manual de zip, ambos ciudadanos de primera.

**Por qué:** el target puede no tener GitHub ni saber qué es. Y hay una barrera de confianza real en pedirle a alguien que conecte el código de su negocio.

**Nota:** GitHub no ofrece scope OAuth de solo-lectura para repos privados específicos; se resuelve con GitHub App o PAT fine-grained.

---

## Riesgos vivos (revisar periódicamente)

| Riesgo | Estado |
|---|---|
| **Absorción de plataforma.** Lovable ya shippeó chat Q&A y escaneo de seguridad nativos. No es amenaza futura, ya ocurrió | Activo |
| **Vibe App Scanner** con 8 pilares a $19/mes | Activo |
| **Midrender (YC)** hace "codebase → walkthrough animado" con MCP a Claude Code/Cursor. Hoy lo posicionan para marketing, el pivot les cuesta nada | Activo |
| **La gente no compra prevención.** Solo 49-63% aumenta el gasto en seguridad incluso *después* de una brecha | Activo — aprovechar el miedo ambiental fresco, es una ventana que se cierra |
| Licencia de Remotion sin confirmar por escrito | Abierto (ver D11) |
| COGS de render sin medir | Abierto (ver D16) |

---

## Descartado explícitamente

| Qué | Por qué | Ref |
|---|---|---|
| Crítica estética con LLM | Correlación 0.194 vs 0.556 humana | D6 |
| Auditoría GDPR completa | Sin casos de multa a solo-founders; no detectable | D7 |
| Puntaje WCAG | Solo 30-40% de criterios automatizables | D8 |
| COPPA / verificación de edad | Sin firma técnica detectable | D7 |
| Doble opt-in como violación | No es requisito legal en EE.UU. | D7 |
| Consistencia de design system | Medible pero no interpretable | D6 |
| Claims de residencia de datos / Schrems II | Se reporta la región como hecho, no se dictamina | D7 |
| Supabase branching | Exige plan Pro **del usuario** | D9 |
| Firebase y otros backends | Fase 2 | — |
| Narración multi-idioma | Solo español en el MVP | — |
