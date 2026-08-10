/**
 * Repaso con modelo de lenguaje, al final y solo para podar.
 *
 * Tres reglas que definen todo el diseño de este archivo:
 *
 *  1. **El modelo no detecta nada.** Llega cuando la evidencia ya está
 *     recolectada por medios estructurales (D13). Si este archivo desaparece,
 *     el producto sigue funcionando igual, con más falsos positivos.
 *
 *  2. **Solo puede bajar o descartar.** No puede subir una confianza, no puede
 *     crear un hallazgo, no puede editar un texto. La superficie por la que una
 *     alucinación podría llegar al usuario es exactamente cero (D14).
 *
 *  3. **Si algo sale mal, se queda todo como estaba.** Un error de red o un
 *     JSON mal formado no puede borrar hallazgos reales. Falla hacia conservar.
 *
 * Solo se revisan los candidatos que ya venían dudosos (`likely` / `to_review`)
 * y que se apoyan en código. Los comprobados no se tocan: si la base devolvió
 * filas ajenas, no hay nada que opinar.
 */

import type { CostEntry, FindingDraft } from '@/lib/types/domain'
import type { CheckRunContext } from './lib/context'

/** Tope de candidatos por corrida. Es una poda, no un análisis. */
const MAX_CANDIDATOS = 20

const SISTEMA = `Sos un revisor de seguridad. Te paso hallazgos detectados por reglas
estructurales sobre el código de una app, con el fragmento exacto que los disparó.

Tu único trabajo es decir si cada uno es un falso positivo evidente.

Reglas:
- Solo podés responder "mantener" o "descartar".
- "descartar" es únicamente para falsos positivos evidentes a partir del fragmento
  (por ejemplo: código de ejemplo, un valor fijo escrito a mano, una función
  desactivada, una detección que claramente leyó mal el código).
- Si tenés dudas, respondé "mantener". Mantener de más es barato; descartar algo
  real no lo es.
- No inventes hallazgos nuevos ni reescribas los textos.

Respondé SOLO un arreglo JSON, sin texto alrededor, con esta forma:
[{"i":0,"v":"mantener"},{"i":1,"v":"descartar","porque":"motivo breve"}]`

export async function triarConModelo(
  drafts: FindingDraft[],
  ctx: CheckRunContext,
  registrarCosto: (entry: CostEntry) => void,
): Promise<FindingDraft[]> {
  const complete = ctx.complete
  if (!complete) return drafts

  const candidatos = drafts
    .map((draft, indice) => ({ draft, indice }))
    .filter(
      ({ draft }) =>
        draft.confidence !== 'confirmed' &&
        draft.evidence.some((e) => e.kind === 'code' && e.snippet),
    )
    .slice(0, MAX_CANDIDATOS)

  if (candidatos.length === 0) return drafts

  const prompt = candidatos
    .map(({ draft }, i) => {
      const codigo = draft.evidence.find((e) => e.kind === 'code' && e.snippet)
      const ubicacion =
        codigo && codigo.kind === 'code' ? `${codigo.file}:${codigo.line}` : 'sin ubicación'
      const fragmento = codigo && codigo.kind === 'code' ? codigo.snippet : ''
      return `[${i}] regla: ${draft.checkId}\nqué afirma: ${draft.titlePlain}\ndónde: ${ubicacion}\nfragmento: ${fragmento}`
    })
    .join('\n\n')

  let respuesta
  try {
    respuesta = await complete({ system: SISTEMA, prompt, maxTokens: 1024 })
  } catch (error) {
    ctx.log(
      `triage: el modelo falló, se conservan todos los hallazgos: ${error instanceof Error ? error.message : String(error)}`,
    )
    return drafts
  }

  registrarCosto({
    category: 'llm',
    units: candidatos.length,
    unitLabel: 'hallazgos repasados',
    costUsd: respuesta.costUsd,
    detail: 'Repaso final para descartar falsos positivos',
  })

  const veredictos = parsearVeredictos(respuesta.text)
  if (veredictos === null) {
    ctx.log('triage: no se pudo leer la respuesta del modelo; se conservan todos los hallazgos.')
    return drafts
  }

  const aDescartar = new Set<number>()
  for (const veredicto of veredictos) {
    if (veredicto.v !== 'descartar') continue
    const candidato = candidatos[veredicto.i]
    if (!candidato) continue
    aDescartar.add(candidato.indice)
    ctx.log(
      `triage: se descarta ${candidato.draft.checkId} (${veredicto.porque ?? 'sin motivo dado'}).`,
    )
  }

  return drafts.filter((_, indice) => !aDescartar.has(indice))
}

interface Veredicto {
  i: number
  v: string
  porque?: string
}

/** Lee el arreglo JSON. Cualquier cosa rara devuelve `null` = no tocar nada. */
function parsearVeredictos(texto: string): Veredicto[] | null {
  const inicio = texto.indexOf('[')
  const fin = texto.lastIndexOf(']')
  if (inicio === -1 || fin <= inicio) return null

  try {
    const crudo = JSON.parse(texto.slice(inicio, fin + 1)) as unknown
    if (!Array.isArray(crudo)) return null

    const veredictos: Veredicto[] = []
    for (const item of crudo) {
      if (typeof item !== 'object' || item === null) continue
      const registro = item as Record<string, unknown>
      if (typeof registro.i !== 'number' || typeof registro.v !== 'string') continue
      veredictos.push({
        i: registro.i,
        v: registro.v,
        porque: typeof registro.porque === 'string' ? registro.porque : undefined,
      })
    }
    return veredictos
  } catch {
    return null
  }
}
