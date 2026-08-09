# Estado del proyecto — caughtcode

> Se actualiza **al cerrar cada sesión** y al terminar cada subsistema.
> Formato de fecha: `YYYY-MM-DD`.

---

## 📍 Dónde estamos ahora

**Fase:** Diseño cerrado. **Cero código escrito.**
**Última sesión:** 2026-08-09

### Hecho y verificado

- [x] Investigación de mercado, competencia, viabilidad técnica, economía unitaria, formato del output y estrategia de pilares — 7 frentes, con fuentes
- [x] Producto definido y reencuadrado: de "video tutor" a **auditor que demuestra en video**
- [x] Alcance cerrado: 3 pilares + capas secundarias (chat Q&A + "cómo funciona mi proyecto")
- [x] Modelo de negocio definido: híbrido, sin créditos
- [x] Nombre elegido: **caughtcode**
- [x] Spec de diseño escrito → `docs/superpowers/specs/2026-08-09-auditor-apps-ia-design.md`
- [x] Decisiones con evidencia registradas → `docs/DECISIONS.md`
- [x] Plan de construcción escrito → `docs/MASTER_PLAN.md`
- [x] Entorno de trabajo armado (`CLAUDE.md` + docs)
- [x] Repo conectado a `github.com/manu-180/caughtcode`

### Lo que sigue, exactamente

**Próxima sesión = empezar a construir.** Arrancar por la **Ola 1** de `docs/MASTER_PLAN.md`:

1. **S1 Fundación** — Next.js + Supabase + Vercel, modelo de datos con RLS, cola de jobs, tokens de diseño
2. **S2 Ingesta** — GitHub App + upload de zip, detección de stack
3. **Prototipo de video** — resolver Motion Canvas vs Remotion con una escena real de código animado (⚠️ es el riesgo técnico más grande sin resolver)

El usuario pidió construir con un **agente orquestador** coordinando especialistas.

---

## 🚧 A medias / bloqueado

Nada a medias. No hay bloqueantes.

---

## ❓ Decisiones abiertas

| Tema | Cómo se resuelve | Ref |
|---|---|---|
| Motion Canvas vs Remotion | Prototipo de una escena con código animado | `DECISIONS.md` D11 |
| Precio concreto | Después de medir el COGS real de render | D16 |
| Frameworks con prompts curados | Next.js/React + Supabase primero | — |
| Política de datos (retención, borrado, no-entrenamiento) | Definir antes de aceptar el primer repo ajeno | S10 |

---

## 📓 Bitácora

### 2026-08-09 — Diseño y entorno

Sesión larga de brainstorming con 7 investigaciones en paralelo. Hallazgos que cambiaron el rumbo:

- **La idea original (video tutor explicando tu código) estaba commoditizada.** Existen gratis: `repo-explainer`, code2tutorial, ExplainGithub, NotebookLM Video Overview. Y con financiamiento YC: Midrender.
- **El dolor elegido no era el dolor real.** Cero evidencia de gente pidiendo "explicame mi código"; mucha evidencia de gente pidiendo "¿esto es seguro?" y "se rompió y no sé por qué".
- **Lovable ya regala el chat Q&A** (Chat Mode Agent) y el escaneo de seguridad nativos.
- **Vibe App Scanner ya cubre 8 pilares a $19/mes** — pero hablándole a agentes de IA, no a personas.
- **El reencuadre ganador:** el agente que navega la app es detector, prueba y video al mismo tiempo. Resuelve la alucinación, el costo del video y la credibilidad de un saque.

Salida de la sesión: spec + decisiones + plan maestro + entorno de trabajo, todo en disco.

🤖 MODELO: Opus · RAZONAMIENTO: Alto
