# caughtcode

**Auditor de apps hechas con IA.** Encuentra lo que está roto o es peligroso en tu proyecto, **te lo demuestra en video**, y te da el prompt exacto para arreglarlo.

---

## El problema

Construiste tu app con Claude Code, Cursor, Lovable o Bolt. Funciona. Pero no sabés si es segura, si le falta algo importante, ni si te la van a rechazar en la App Store.

No es paranoia:

- Más de 170 proyectos de Lovable quedaron expuestos por un solo error de configuración de permisos (CVE-2025-48757)
- Un escaneo de 5.600 apps hechas con IA encontró más de 2.000 vulnerabilidades y 400 claves secretas a la vista
- Moltbook fue vulnerado en menos de 3 minutos. Su fundador: *"no escribí ni una línea de código"*

Las herramientas que existen te tiran `CWE-89 en línea 45`. Si no sos programador, no podés hacer nada con eso.

## Qué hace caughtcode

Un agente entra a tu app como lo haría un usuario cualquiera — o como lo haría alguien con malas intenciones — e intenta cosas: registrarse, recuperar la contraseña, borrar la cuenta, ver datos que no debería poder ver.

Todo lo que hace queda grabado. Y esa grabación se convierte en la explicación:

> *"Me registré en tu app como usuario común. Con esa cuenta pude entrar a la facturación de todos tus otros clientes. Mirá."*

Sin jerga. Sin reportes de 200 líneas. Tres cosas para arreglar, en orden, con el prompt listo para pegar.

## Qué revisa

| | |
|---|---|
| **Seguridad** | Quién puede ver qué, claves expuestas, puertas sin llave |
| **Completitud** | Flujos que faltan: recuperar contraseña, cerrar sesión, borrar la cuenta |
| **Listo para publicar** | Lo que te haría rechazar en App Store o Google Play, cookies y consentimiento |

Y una sección aparte, **"Cómo funciona mi proyecto"**, con videos que te explican cada parte, más un chat para preguntar lo que quieras sobre tu propio código.

---

## Estado

🚧 **En diseño.** Todavía no hay código.

| Documento | Para qué |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | Cómo se trabaja en este repo |
| [`docs/MASTER_PLAN.md`](docs/MASTER_PLAN.md) | Plan de construcción completo |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Qué se decidió y con qué evidencia |
| [`docs/PROGRESS.md`](docs/PROGRESS.md) | Dónde quedó todo |
| [`docs/MEMORY.md`](docs/MEMORY.md) | Gotchas acumulados |
| [`docs/superpowers/specs/`](docs/superpowers/specs/) | Spec de diseño |

## Stack

Next.js · Supabase · Vercel · tree-sitter · agente de navegación · generación de video con voz
