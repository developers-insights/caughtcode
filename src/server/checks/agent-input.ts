/**
 * ══════════════════════════════════════════════════════════════════════════
 *  CONTRATO CON EL FRENTE DEL AGENTE DE NAVEGACIÓN
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Los chequeos que necesitan la app desplegada **no navegan**. El agente ya
 * hizo el trabajo; acá solo se traduce lo que observó a hallazgos.
 *
 * El agente arma un `AgentEvidence` y se lo pasa al motor en
 * `CheckRunContext.agent`. Si no viene, esos chequeos se saltean y el motor lo
 * registra para que el usuario sepa **qué no se revisó** — un chequeo que no
 * corrió nunca se muestra como "todo bien".
 *
 * `sessions` usa `AgentSessionResult` de `@/lib/types/domain` tal cual. Lo demás
 * son observaciones que no entran en ese tipo (pedidos de red, cookies, medidas
 * de pantalla, problemas de accesibilidad) y se definen acá porque las consume
 * este frente.
 *
 * ── Regla de oro para el que llena esto ──────────────────────────────────
 * Cada observación tiene que poder señalarse en la grabación. `sessionId` y
 * `atMs` no son opcionales por capricho: son lo que convierte "encontramos X"
 * en "mirá el segundo 14". Sin eso, el hallazgo no se puede emitir (D14).
 */

import type { AgentSessionResult, AgentTaskId } from '@/lib/types/domain'

/* ── Bolsa completa ───────────────────────────────────────────────────── */

export interface AgentEvidence {
  /** Una entrada por tarea intentada. Incluye las que salieron `not_found`. */
  sessions: AgentSessionResult[]
  /** Pantallas que el agente llegó a abrir. */
  pages?: PaginaObservada[]
  /** Pedidos de red del navegador, en orden. */
  network?: PedidoObservado[]
  /** Cookies presentes en cada momento de la visita. */
  cookies?: CookieObservada[]
  /** Problemas de accesibilidad medidos automáticamente. */
  a11y?: ProblemaAccesibilidad[]
  /** Mediciones de desborde horizontal por pantalla. */
  overflow?: DesbordeObservado[]
}

/* ── Piezas ───────────────────────────────────────────────────────────── */

export interface PaginaObservada {
  sessionId: string
  url: string
  /** Ruta relativa, ej. "/cuenta". */
  path: string
  status: number
  /** HTML servido, recortado. Sirve para buscar banner, pie, enlaces. */
  html?: string
  atMs: number
  screenshotPath?: string
}

export interface PedidoObservado {
  sessionId: string
  /** URL completa del pedido. */
  url: string
  /** Host, ya normalizado en minúsculas y sin `www.`. */
  host: string
  method: string
  /** Milisegundos desde que arrancó la sesión. */
  atMs: number
  /**
   * `true` si el pedido salió **antes** de que el usuario aceptara nada.
   * El agente lo determina: es la diferencia entre un hallazgo y una suposición.
   */
  beforeConsent: boolean
  /** Pantalla desde la que se disparó. */
  fromPath: string
  /** true si es un recurso de terceros (host distinto al de la app). */
  thirdParty: boolean
}

export interface CookieObservada {
  sessionId: string
  name: string
  domain: string
  atMs: number
  beforeConsent: boolean
  fromPath: string
}

export interface ProblemaAccesibilidad {
  sessionId: string
  /** Identificador de la regla que falló. Interno: nunca se muestra crudo. */
  ruleId: string
  /** Qué pasa, ya en lenguaje llano. Lo escribe el agente. */
  descripcionPlain: string
  impacto: 'critical' | 'serious' | 'moderate' | 'minor'
  path: string
  /** Cuántos elementos de la pantalla tienen este problema. */
  cantidadElementos: number
  atMs: number
  screenshotPath?: string
}

export interface DesbordeObservado {
  sessionId: string
  path: string
  url: string
  /** Ancho de la ventana simulada, en píxeles. 375 = celular. */
  viewportWidth: number
  scrollWidth: number
  clientWidth: number
  atMs: number
  screenshotPath?: string
  /** Selector del elemento que se sale, si el agente lo pudo aislar. */
  culpable?: string
}

/* ── Consultas que usan los chequeos ──────────────────────────────────── */

export function sesion(
  agente: AgentEvidence | undefined,
  taskId: AgentTaskId,
): AgentSessionResult | undefined {
  return agente?.sessions.find((s) => s.taskId === taskId)
}

/**
 * `true` si el agente buscó el flujo y **no lo encontró**.
 *
 * `blocked` y `error` no cuentan: significan que el flujo puede existir y el
 * agente se trabó antes de llegar. Afirmar "no tenés borrado de cuenta" porque
 * el agente se perdió es exactamente el falso positivo que hunde la confianza.
 */
export function flujoNoEncontrado(
  agente: AgentEvidence | undefined,
  taskId: AgentTaskId,
): AgentSessionResult | undefined {
  const s = sesion(agente, taskId)
  return s?.outcome === 'not_found' ? s : undefined
}

/** Rango de la grabación que corresponde a una sesión. */
export function rangoDeSesion(s: AgentSessionResult): { startMs: number; endMs: number } {
  const pasos = s.steps
  if (pasos.length === 0) return { startMs: 0, endMs: s.durationMs }
  const startMs = Math.max(0, (pasos[0]?.atMs ?? 0) - 500)
  const endMs = Math.min(s.durationMs, (pasos[pasos.length - 1]?.atMs ?? s.durationMs) + 1500)
  return { startMs, endMs: Math.max(endMs, startMs + 1000) }
}

/** Id estable de una sesión para citarla como evidencia. */
export function idDeSesion(s: AgentSessionResult): string {
  return s.taskId
}
