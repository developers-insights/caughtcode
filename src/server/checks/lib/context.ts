/**
 * Contexto y contrato de un chequeo.
 *
 * `CheckDefinition` y `CheckContext` viven en `@/lib/types/domain` y no se tocan.
 * Acá se **extienden**, no se redefinen:
 *
 *  - `CheckRunContext` agrega insumos que el motor puede tener o no (resultado
 *    del agente de navegación, sonda HTTP, conexión a la base, función de LLM).
 *    Todos son **opcionales**, y eso importa: hace que
 *    `(ctx: CheckRunContext) => …` siga siendo asignable a
 *    `(ctx: CheckContext) => …`, así que un `Check` es un `CheckDefinition`
 *    válido sin ningún cast.
 *
 *  - `draftFrom()` es la única forma de fabricar un `FindingDraft`. Toma el
 *    texto del catálogo y lo completa. No se redacta texto acá: si falta una
 *    frase, se agrega al catálogo, que es de otro frente.
 *
 * Invariantes que se hacen cumplir en construcción, no en revisión posterior
 * (D14 — nada sin evidencia):
 *   1. `evidence.length > 0`, siempre.
 *   2. Ningún marcador `{{...}}` sin completar en texto visible al usuario.
 */

import type {
  CheckContext,
  CheckDefinition,
  CostEntry,
  Evidence,
  FindingDraft,
} from '@/lib/types/domain'
import { completar, entrada } from '@/content/catalogo'
import type { AgentEvidence } from '../agent-input'
import type { HttpProbe } from './http'
import type { SqlConnect } from './pg-readonly'

/* ── Función de LLM inyectada ─────────────────────────────────────────── */

/**
 * El cliente del modelo **no se importa acá**. Llega por parámetro para que el
 * motor decida si hay presupuesto, qué modelo usar y cómo contar el costo.
 * Un chequeo que no la recibe tiene que seguir funcionando: el LLM afina, no
 * detecta (D13 — estructural primero, modelo al final).
 */
export type CompleteFn = (input: {
  system: string
  prompt: string
  maxTokens?: number
}) => Promise<CompleteResult>

export interface CompleteResult {
  text: string
  costUsd: number
  inputTokens: number
  outputTokens: number
}

/* ── Contexto extendido ───────────────────────────────────────────────── */

export interface CheckRunContext extends CheckContext {
  /** Lo que observó el agente navegando la app. Ausente si no había app desplegada. */
  agent?: AgentEvidence
  /** Pedidos HTTP contra la app desplegada. Ausente en corridas solo-código. */
  http?: HttpProbe
  /** Abre una conexión a la base del usuario. Solo lectura, siempre con ROLLBACK. */
  connect?: SqlConnect
  /** Modelo de lenguaje, si el motor lo habilitó para esta corrida. */
  complete?: CompleteFn
  /** Registra cuánto costó una operación cara. */
  reportCost?: (entry: CostEntry) => void
}

/**
 * Un chequeo. Es un `CheckDefinition` con el contexto más rico.
 * La extensión es legal porque todo lo que agrega `CheckRunContext` es opcional.
 */
export interface Check extends CheckDefinition {
  run: (ctx: CheckRunContext) => Promise<FindingDraft[]>
  /** true si puede consumir presupuesto de modelo. El motor lo usa para saltearlo. */
  usesLlm?: boolean
}

export function defineCheck(check: Check): Check {
  return check
}

/* ── Fábrica de hallazgos ─────────────────────────────────────────────── */

export class EvidenciaVaciaError extends Error {
  constructor(readonly checkId: string) {
    super(`El chequeo "${checkId}" intentó emitir un hallazgo sin evidencia`)
    this.name = 'EvidenciaVaciaError'
  }
}

export class MarcadorSinCompletarError extends Error {
  constructor(
    readonly checkId: string,
    readonly marcadores: string[],
  ) {
    super(
      `El chequeo "${checkId}" dejó marcadores sin completar: ${marcadores.join(', ')}`,
    )
    this.name = 'MarcadorSinCompletarError'
  }
}

export interface DraftOptions {
  /** Pisa la confianza por defecto del catálogo. Solo para bajarla. */
  confidence?: FindingDraft['confidence']
}

const MARCADOR = /\{\{(\w+)\}\}/g

function marcadoresPendientes(...textos: string[]): string[] {
  const pendientes = new Set<string>()
  for (const texto of textos) {
    for (const match of texto.matchAll(MARCADOR)) pendientes.add(match[1]!)
  }
  return [...pendientes]
}

/**
 * Arma un `FindingDraft` a partir de una entrada del catálogo.
 *
 * Tira excepción si falta evidencia o si queda un marcador sin completar: es
 * preferible que un chequeo falle ruidosamente y quede registrado a que salga
 * un hallazgo con "{{tabla}}" a la vista del usuario.
 */
export function draftFrom(
  catalogId: string,
  valores: Record<string, string | number>,
  evidence: Evidence[],
  options: DraftOptions = {},
): FindingDraft {
  const cat = entrada(catalogId)

  if (evidence.length === 0) throw new EvidenciaVaciaError(catalogId)

  const titlePlain = completar(cat.titlePlain, valores)
  const explanationPlain = completar(cat.explanationPlain, valores)
  const impactPlain = completar(cat.impactPlain, valores)
  const fixPrompt = completar(cat.fixPrompt, valores)

  const pendientes = marcadoresPendientes(
    titlePlain,
    explanationPlain,
    impactPlain,
    fixPrompt,
  )
  if (pendientes.length > 0) throw new MarcadorSinCompletarError(catalogId, pendientes)

  return {
    checkId: cat.id,
    pillar: cat.pillar,
    severity: cat.severity,
    confidence: options.confidence ?? cat.defaultConfidence,
    titlePlain,
    explanationPlain,
    impactPlain,
    fixPrompt,
    evidence,
    demoTaskId: cat.demoTaskId,
  }
}

/* ── Atajos de evidencia ──────────────────────────────────────────────── */

export function evidenciaCodigo(
  file: string,
  line: number,
  snippet?: string,
  endLine?: number,
): Evidence {
  return {
    kind: 'code',
    file,
    line,
    ...(endLine !== undefined ? { endLine } : {}),
    ...(snippet !== undefined ? { snippet: recortar(snippet) } : {}),
  }
}

export function evidenciaBase(object: string, detail: string): Evidence {
  return { kind: 'database', object, detail }
}

export function evidenciaHttp(url: string, status: number, detail: string): Evidence {
  return { kind: 'http', url, status, detail }
}

export function evidenciaNavegador(
  url: string,
  detail: string,
  screenshotPath?: string,
): Evidence {
  return {
    kind: 'browser',
    url,
    detail,
    ...(screenshotPath !== undefined ? { screenshotPath } : {}),
  }
}

export function evidenciaGrabacion(
  agentSessionId: string,
  startMs: number,
  endMs: number,
  caption: string,
): Evidence {
  return { kind: 'recording', agentSessionId, startMs, endMs, caption }
}

/** Los snippets van a la base y a la pantalla: se recortan siempre. */
export function recortar(texto: string, max = 240): string {
  const limpio = texto.replace(/\r/g, '')
  if (limpio.length <= max) return limpio
  return `${limpio.slice(0, max - 1)}…`
}
