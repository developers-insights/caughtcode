/**
 * Consulta armada pegando texto.
 *
 * La distinción que hace o rompe este chequeo: en las librerías modernas la
 * plantilla etiquetada **es** la forma segura. `sql\`… ${id}\`` y
 * `prisma.$queryRaw\`… ${id}\`` parametrizan solos. Reportarlos sería un falso
 * positivo constante en proyectos que hicieron las cosas bien.
 *
 * Lo que sí es peligroso:
 *   - `$queryRawUnsafe` / `$executeRawUnsafe` (el nombre lo dice)
 *   - `client.query(\`… ${x}\`)` — la plantilla se resuelve **antes** de llegar
 *     al driver, así que ahí no hay parámetro que valga
 *   - concatenación con `+` dentro de cualquier llamada de consulta
 */

import type { FindingDraft } from '@/lib/types/domain'
import { defineCheck, draftFrom, evidenciaCodigo, recortar } from '../lib/context'
import { archivos, coincidencias, esCodigo, esDePrueba } from '../lib/files'

/** Llamadas que ejecutan SQL crudo recibiendo el texto como argumento. */
const LLAMADA_CRUDA =
  /\b(?:\w+\s*\.\s*)?(?:query|execute|unsafe|raw|\$queryRawUnsafe|\$executeRawUnsafe|exec)\s*\(\s*([`'"][\s\S]{0,400}?[`'"])\s*[,)]/g

/** Las que son seguras por construcción: plantilla etiquetada. */
const ETIQUETADA_SEGURA = /\b(?:sql|sqlite|postgres|prisma\.\$queryRaw|prisma\.\$executeRaw|db\.sql)\s*`/

const PARECE_SQL =
  /\b(?:select|insert\s+into|update\s+\w+\s+set|delete\s+from|where|join|order\s+by|group\s+by)\b/i

const INTERPOLA = /\$\{[^}]+\}/
const CONCATENA = /['"`]\s*\+\s*[A-Za-z_$]|[A-Za-z_$]\w*\s*\+\s*['"`]/

export const sqlStringConcat = defineCheck({
  id: 'sec.sql_string_concat',
  pillar: 'security',
  name: 'sql-string-concat',
  requires: ['code'],
  async run(ctx): Promise<FindingDraft[]> {
    const fuentes = await archivos(ctx)
    const drafts: FindingDraft[] = []

    for (const archivo of fuentes) {
      if (esDePrueba(archivo.path)) continue
      if (!esCodigo(archivo.path)) continue

      const vistas = new Set<number>()

      // ── Caso explícito: la API se llama "unsafe" ──────────────────────
      for (const { linea, lineaTexto } of coincidencias(
        archivo.text,
        /\$(?:queryRawUnsafe|executeRawUnsafe)\s*\(/g,
      )) {
        if (vistas.has(linea)) continue
        vistas.add(linea)
        drafts.push(emitir(archivo.path, linea, lineaTexto, 'likely'))
        ctx.log(`sec.sql_string_concat: consulta sin protección en ${archivo.path}:${linea}`)
      }

      // ── Caso general ──────────────────────────────────────────────────
      for (const { match, linea, lineaTexto, index } of coincidencias(archivo.text, LLAMADA_CRUDA)) {
        if (vistas.has(linea)) continue

        const argumento = match[1] ?? ''
        if (!PARECE_SQL.test(argumento)) continue

        // Una plantilla etiquetada justo antes es la forma segura.
        const antes = archivo.text.slice(Math.max(0, index - 60), index + match[0].length)
        if (ETIQUETADA_SEGURA.test(antes)) continue

        const peligroso = INTERPOLA.test(argumento) || CONCATENA.test(argumento)
        if (!peligroso) continue

        vistas.add(linea)
        drafts.push(emitir(archivo.path, linea, lineaTexto, 'likely'))
        ctx.log(`sec.sql_string_concat: ${archivo.path}:${linea}`)
      }
    }

    return drafts
  },
})

function emitir(
  file: string,
  linea: number,
  lineaTexto: string,
  confidence: 'likely' | 'to_review',
): FindingDraft {
  return draftFrom(
    'sec.sql_string_concat',
    { archivo: file, linea },
    [evidenciaCodigo(file, linea, recortar(lineaTexto.trim()))],
    { confidence },
  )
}
