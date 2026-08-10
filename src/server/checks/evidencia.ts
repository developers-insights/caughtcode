/**
 * Qué tan fuerte es una prueba, y a qué cosa concreta apunta.
 *
 * Vivía dentro de `runner.ts`. Se separó cuando apareció la agrupación: tanto
 * la deduplicación como la agrupación necesitan saber "de qué habla" un
 * hallazgo, y con las dos importando del motor quedaba un ciclo. Acá no hay
 * lógica de producto: solo se lee la evidencia y se la ordena.
 */

import type { Evidence, FindingDraft } from '@/lib/types/domain'

/**
 * Fuerza de cada clase de evidencia.
 *
 * El orden pedido es grabación > base de datos > código > http. `browser` no
 * estaba en esa lista: se ubica entre código y http porque es una observación
 * de la app andando (más fuerte que leer el código) pero sin la narración que
 * hace fuerte a una grabación. El orden pedido queda intacto como subsecuencia.
 */
export const FUERZA_EVIDENCIA: Record<Evidence['kind'], number> = {
  recording: 4,
  database: 3,
  code: 2,
  browser: 1,
  http: 0,
}

export function fuerzaDe(evidence: Evidence[]): number {
  return evidence.reduce((max, e) => Math.max(max, FUERZA_EVIDENCIA[e.kind] ?? 0), -1)
}

/**
 * Qué cosa concreta señala el hallazgo. Dos candidatos con el mismo sujeto y el
 * mismo problema son el mismo hallazgo.
 *
 * También es el "lugar" que se lista cuando varias repeticiones se agrupan: por
 * eso apunta siempre a algo verificable (`archivo:línea`, el nombre del objeto
 * en la base, la ruta que se probó) y nunca a un texto redactado.
 */
export function sujetoDe(draft: Pick<FindingDraft, 'evidence'>): string {
  const principal = [...draft.evidence].sort(
    (a, b) => FUERZA_EVIDENCIA[b.kind] - FUERZA_EVIDENCIA[a.kind],
  )[0]
  if (!principal) return ''

  switch (principal.kind) {
    case 'code':
      return `${principal.file}:${principal.line}`
    case 'database':
      return principal.object
    case 'recording':
      return principal.agentSessionId
    case 'browser':
      return rutaDe(principal.url)
    case 'http':
      return rutaDe(principal.url)
  }
}

export function rutaDe(url: string): string {
  try {
    return new URL(url).pathname.replace(/\/$/, '') || '/'
  } catch {
    return url
  }
}
