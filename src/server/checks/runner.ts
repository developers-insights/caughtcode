/**
 * Motor de chequeos.
 *
 * Corre lo que se puede correr, junta los candidatos y les aplica tres reglas
 * que no son negociables:
 *
 *  1. **Nada sin evidencia** (D14). Un candidato con `evidence` vacío no se
 *     emite: se descarta y se registra el error contra el chequeo que lo
 *     produjo. Es un invariante, no una validación opcional — el usuario no
 *     puede detectar una alucinación, así que el sistema no puede permitirse
 *     una.
 *
 *  2. **Un problema, un hallazgo.** El mismo hecho detectado por dos vías
 *     (borrado de cuenta lo ven el pilar de completitud y el de tienda) sale
 *     una sola vez, con la evidencia más fuerte de las dos. Y el mismo problema
 *     repetido en N lugares —36 tablas sin forzar son un problema, no 36— sale
 *     como un hallazgo con N ocurrencias, sin perder la prueba de ninguno
 *     (ver `agrupar.ts`).
 *
 *  3. **Máximo 3 destacados** (D15). El 67% de las alertas de seguridad se
 *     ignoran por saturación. `rank` 1, 2 y 3 son "hacé esto ya"; el resto va
 *     colapsado. Como el rank se calcula después de agrupar, los tres son tres
 *     problemas **distintos** y no el mismo repetido tres veces.
 *
 * Y una constancia: **qué no se revisó**. Un chequeo que no corrió por falta de
 * insumo se informa. Mostrarlo como "todo bien" sería mentir por omisión.
 */

import pLimit from 'p-limit'
import type { CostEntry, FindingDraft, Pillar, Severity } from '@/lib/types/domain'
import { SEVERITY_ORDER } from '@/lib/types/domain'
import { agrupar } from './agrupar'
import type { HallazgoAgrupado, HallazgoUnificado } from './agrupar'
import { fuerzaDe, sujetoDe } from './evidencia'
import type { Check, CheckRunContext } from './lib/context'
import { CHEQUEOS, faltantes, INSUMO_BENEFICIO, INSUMO_FALTANTE } from './registry'
import type { Insumo, InsumosDisponibles } from './registry'
import { triarConModelo } from './triage'

// Se re-exportan desde acá porque este es el módulo que el resto del sistema
// conoce. Mover la implementación a otro archivo no puede obligar a nadie a
// cambiar sus imports.
export { fuerzaDe, sujetoDe } from './evidencia'
export { agrupar, claveDeAgrupacion, SIEMPRE_INDIVIDUAL } from './agrupar'
export type { HallazgoAgrupado, HallazgoUnificado } from './agrupar'

/* ── Resultado ────────────────────────────────────────────────────────── */

export interface HallazgoRankeado extends HallazgoAgrupado {
  /** 1..3 = destacados. El resto va colapsado. */
  rank: number
}

export interface ChequeoSalteado {
  checkId: string
  faltan: Insumo[]
  /** Por qué no se revisó, en lenguaje llano. */
  porqueePlain: string
  /** Qué se ganaría habilitándolo. */
  siLoConectasPlain: string
}

export interface ChequeoFallado {
  checkId: string
  error: string
}

export interface HallazgoDescartado {
  checkId: string
  motivo: 'sin_evidencia' | 'texto_incompleto'
  detalle: string
}

export interface ResultadoCorrida {
  /** Todos los hallazgos, ya ordenados y con `rank` asignado. */
  findings: HallazgoRankeado[]
  /** Los tres primeros. Atajo para la pantalla principal. */
  destacados: HallazgoRankeado[]
  salteados: ChequeoSalteado[]
  fallados: ChequeoFallado[]
  descartados: HallazgoDescartado[]
  costos: CostEntry[]
  costoTotalUsd: number
  duracionMs: number
  chequeosCorridos: number
}

export interface OpcionesCorrida {
  /** Por defecto, todos los del registro. */
  checks?: Check[]
  /** Cuántos chequeos en paralelo. */
  concurrencia?: number
  /** Si es `false`, no se llama al modelo aunque `ctx.complete` esté. */
  usarModelo?: boolean
}

/* ── Motor ────────────────────────────────────────────────────────────── */

export async function correrChequeos(
  ctx: CheckRunContext,
  opciones: OpcionesCorrida = {},
): Promise<ResultadoCorrida> {
  const arranque = Date.now()
  const checks = opciones.checks ?? CHEQUEOS
  const disponibles = detectarInsumos(ctx)

  const salteados: ChequeoSalteado[] = []
  const fallados: ChequeoFallado[] = []
  const descartados: HallazgoDescartado[] = []
  const costos: CostEntry[] = []

  const aplicables: Check[] = []
  for (const check of checks) {
    const faltan = faltantes(check, disponibles)
    if (faltan.length > 0) {
      salteados.push({
        checkId: check.id,
        faltan,
        porqueePlain: faltan.map((i) => INSUMO_FALTANTE[i]).join(' '),
        siLoConectasPlain: faltan.map((i) => INSUMO_BENEFICIO[i]).join(' '),
      })
      continue
    }
    aplicables.push(check)
  }

  const limite = pLimit(opciones.concurrencia ?? 4)
  const contexto: CheckRunContext = {
    ...ctx,
    reportCost: (entry) => {
      costos.push(entry)
      ctx.reportCost?.(entry)
    },
  }

  const crudos: FindingDraft[] = []

  await Promise.all(
    aplicables.map((check) =>
      limite(async () => {
        try {
          const resultado = await check.run(contexto)
          for (const draft of resultado) {
            // Invariante 1. Un chequeo puede tener un bug; el motor no lo deja pasar.
            if (!draft.evidence || draft.evidence.length === 0) {
              descartados.push({
                checkId: check.id,
                motivo: 'sin_evidencia',
                detalle: `"${draft.titlePlain}" salió sin ninguna evidencia y no se emitió.`,
              })
              continue
            }
            if (tieneMarcadorSinCompletar(draft)) {
              descartados.push({
                checkId: check.id,
                motivo: 'texto_incompleto',
                detalle: `"${draft.titlePlain}" quedó con un hueco sin completar en el texto.`,
              })
              continue
            }
            crudos.push(draft)
          }
        } catch (error) {
          fallados.push({
            checkId: check.id,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }),
    ),
  )

  // El modelo entra al final, sobre evidencia ya recolectada (D13), y solo
  // puede bajar confianza o descartar. Nunca inventa ni sube nada.
  const triados =
    opciones.usarModelo !== false && contexto.complete
      ? await triarConModelo(crudos, contexto, (entry) => costos.push(entry))
      : crudos

  // Tres pasos, en este orden y no en otro: primero se unifica el mismo hecho
  // visto por dos chequeos, después se juntan las repeticiones del mismo
  // problema, y recién ahí se rankea — sobre problemas distintos.
  const unificados = deduplicar(triados)
  const agrupados = agrupar(unificados)
  const findings = rankear(agrupados)

  return {
    findings,
    destacados: findings.filter((f) => f.rank <= 3),
    salteados,
    fallados,
    descartados,
    costos,
    costoTotalUsd: costos.reduce((suma, c) => suma + c.costUsd, 0),
    duracionMs: Date.now() - arranque,
    chequeosCorridos: aplicables.length,
  }
}

/* ── Insumos ──────────────────────────────────────────────────────────── */

export function detectarInsumos(ctx: CheckRunContext): InsumosDisponibles {
  return {
    code: Boolean(ctx.repoPath) && ctx.index.fileCount > 0,
    database: ctx.index.dbSchema.source !== 'none',
    deployed_app: Boolean(ctx.deployedUrl) && Boolean(ctx.agent ?? ctx.http),
  }
}

/* ── Invariante 1 ─────────────────────────────────────────────────────── */

const MARCADOR = /\{\{\w+\}\}/

function tieneMarcadorSinCompletar(draft: FindingDraft): boolean {
  return (
    MARCADOR.test(draft.titlePlain) ||
    MARCADOR.test(draft.explanationPlain) ||
    MARCADOR.test(draft.impactPlain) ||
    MARCADOR.test(draft.fixPrompt)
  )
}

/* ── Invariante 2: deduplicación ──────────────────────────────────────── */

/**
 * Chequeos que describen **el mismo hecho** desde pilares distintos.
 *
 * El primero de cada grupo es el que se conserva. Para el borrado de cuenta
 * gana la versión de tienda: dice la misma verdad pero con la consecuencia
 * concreta y comprobable ("te rechazan la app", con las fechas de cada tienda)
 * en lugar de una general. Es lo que hace que el usuario actúe (D5).
 */
const GRUPOS_EQUIVALENTES: string[][] = [
  ['sto.no_account_deletion', 'cmp.no_account_deletion'],
]

const GRUPO_DE = new Map<string, { grupo: string; orden: number }>()
for (const grupo of GRUPOS_EQUIVALENTES) {
  grupo.forEach((checkId, orden) => GRUPO_DE.set(checkId, { grupo: grupo[0]!, orden }))
}

export function claveDeDedup(draft: FindingDraft): string {
  const grupo = GRUPO_DE.get(draft.checkId)?.grupo ?? draft.checkId
  return `${grupo}|${sujetoDe(draft)}`
}

/**
 * Se queda con uno por clave. El ganador se decide, en orden:
 *   1. evidencia más fuerte
 *   2. más piezas de evidencia
 *   3. más confianza
 *   4. mayor severidad
 *   5. orden declarado en el grupo (desempate estable, nunca al azar)
 */
export function deduplicar(drafts: FindingDraft[]): HallazgoUnificado[] {
  const porClave = new Map<string, { ganador: FindingDraft; detectadoPor: string[] }>()

  for (const draft of drafts) {
    const clave = claveDeDedup(draft)
    const existente = porClave.get(clave)

    if (!existente) {
      porClave.set(clave, { ganador: draft, detectadoPor: [draft.checkId] })
      continue
    }

    if (!existente.detectadoPor.includes(draft.checkId)) {
      existente.detectadoPor.push(draft.checkId)
    }
    if (ganaAlOtro(draft, existente.ganador)) existente.ganador = draft
  }

  return [...porClave.values()].map(({ ganador, detectadoPor }) => ({
    ...ganador,
    detectadoPor: detectadoPor.sort(),
  }))
}

function ganaAlOtro(candidato: FindingDraft, actual: FindingDraft): boolean {
  const fuerzaCandidato = fuerzaDe(candidato.evidence)
  const fuerzaActual = fuerzaDe(actual.evidence)
  if (fuerzaCandidato !== fuerzaActual) return fuerzaCandidato > fuerzaActual

  if (candidato.evidence.length !== actual.evidence.length) {
    return candidato.evidence.length > actual.evidence.length
  }

  const confianzaCandidato = ORDEN_CONFIANZA[candidato.confidence]
  const confianzaActual = ORDEN_CONFIANZA[actual.confidence]
  if (confianzaCandidato !== confianzaActual) return confianzaCandidato < confianzaActual

  const sevCandidato = SEVERITY_ORDER[candidato.severity]
  const sevActual = SEVERITY_ORDER[actual.severity]
  if (sevCandidato !== sevActual) return sevCandidato < sevActual

  const ordenCandidato = GRUPO_DE.get(candidato.checkId)?.orden ?? 99
  const ordenActual = GRUPO_DE.get(actual.checkId)?.orden ?? 99
  return ordenCandidato < ordenActual
}

/* ── Invariante 3: ranking ────────────────────────────────────────────── */

const ORDEN_CONFIANZA: Record<FindingDraft['confidence'], number> = {
  confirmed: 0,
  likely: 1,
  to_review: 2,
}

const ORDEN_PILAR: Record<Pillar, number> = {
  security: 0,
  completeness: 1,
  store_hygiene: 2,
}

/** `true` si el hallazgo se puede mostrar en video. */
export function tieneDemostracion(draft: FindingDraft): boolean {
  if (draft.demoTaskId) return true
  return draft.evidence.some((e) => e.kind === 'recording')
}

/**
 * Orden de los hallazgos, en este orden exacto de criterios:
 *
 *   1. **Severidad.** Lo grave primero. No hay discusión.
 *   2. **Confianza.** Entre dos cosas igual de graves, primero la que probamos.
 *      Encabezar el reporte con un "a revisar" entrena al usuario a desconfiar
 *      de los tres destacados, que es justo lo que no puede pasar (D14).
 *   3. **Se puede demostrar en video.** El video es la ventaja del producto: si
 *      dos hallazgos empatan, va arriba el que se puede *mostrar* pasando, no
 *      el que hay que explicar.
 *   4. **Pilar**, y recién ahí **en cuántos lugares aparece**. La magnitud
 *      desempata dentro del mismo pilar y la misma gravedad: entre dos cosas
 *      igual de graves, la que está en 36 lugares es más urgente que la que
 *      está en uno. No sube antes que el pilar a propósito: "seguridad
 *      primero" es una decisión de producto y no la gana el volumen.
 *
 * Después de eso, desempates estables (id, sujeto) para que dos corridas sobre
 * el mismo proyecto den el mismo orden. Un reporte que se reordena solo entre
 * corridas parece roto.
 *
 * Entra ya agrupado: el `rank` se calcula sobre problemas distintos, así que
 * los tres destacados son tres problemas y no el mismo repetido tres veces.
 */
export function rankear(drafts: HallazgoAgrupado[]): HallazgoRankeado[] {
  const ordenados = [...drafts].sort((a, b) => {
    const severidad = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    if (severidad !== 0) return severidad

    const confianza = ORDEN_CONFIANZA[a.confidence] - ORDEN_CONFIANZA[b.confidence]
    if (confianza !== 0) return confianza

    const demo = Number(tieneDemostracion(b)) - Number(tieneDemostracion(a))
    if (demo !== 0) return demo

    const pilar = ORDEN_PILAR[a.pillar] - ORDEN_PILAR[b.pillar]
    if (pilar !== 0) return pilar

    const magnitud = b.ocurrencias - a.ocurrencias
    if (magnitud !== 0) return magnitud

    const porId = a.checkId.localeCompare(b.checkId)
    if (porId !== 0) return porId

    return sujetoDe(a).localeCompare(sujetoDe(b))
  })

  return ordenados.map((draft, indice) => ({ ...draft, rank: indice + 1 }))
}

/* ── Resumen para el usuario ──────────────────────────────────────────── */

/**
 * Qué se revisó y qué no, en una frase. Lo consume la UI: acá no se decide
 * cómo se ve, solo se dice la verdad completa en lenguaje llano.
 */
export function resumenDeCobertura(resultado: ResultadoCorrida): {
  revisados: number
  sinRevisar: number
  faltantesPlain: string[]
} {
  const porInsumo = new Map<Insumo, number>()
  for (const salteado of resultado.salteados) {
    for (const insumo of salteado.faltan) {
      porInsumo.set(insumo, (porInsumo.get(insumo) ?? 0) + 1)
    }
  }

  const faltantesPlain = [...porInsumo].map(
    ([insumo, cantidad]) =>
      `${INSUMO_FALTANTE[insumo]} ${INSUMO_BENEFICIO[insumo]} (${cantidad} ${cantidad === 1 ? 'revisión pendiente' : 'revisiones pendientes'})`,
  )

  return {
    revisados: resultado.chequeosCorridos,
    sinRevisar: resultado.salteados.length,
    faltantesPlain,
  }
}

export type { Severity }
