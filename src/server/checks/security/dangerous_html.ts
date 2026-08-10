/**
 * Contenido de usuario insertado como HTML crudo.
 *
 * Se reporta solo cuando el valor **no** es un literal escrito a mano. Un
 * `dangerouslySetInnerHTML={{ __html: '<br/>' }}` con texto fijo no es un
 * agujero: es feo, y lo feo no se reporta (D6).
 *
 * Confianza `likely`: sin seguir el origen del dato con un análisis de flujo
 * completo no se puede afirmar que venga del usuario. Si el valor viene
 * claramente de la base o de props, sube a comprobado.
 */

import type { FindingDraft } from '@/lib/types/domain'
import { defineCheck, draftFrom, evidenciaCodigo, recortar } from '../lib/context'
import { archivos, coincidencias, esCodigo, esDePrueba } from '../lib/files'

/** `dangerouslySetInnerHTML={{ __html: X }}` y `algo.innerHTML = X`. */
const INSERCION_CRUDA =
  /dangerouslySetInnerHTML\s*=\s*\{\{\s*__html\s*:\s*([^}]+)\}\}|\.\s*(?:inner|outer)HTML\s*=\s*([^;\n]+)|\.\s*insertAdjacentHTML\s*\(\s*[^,]+,\s*([^)]+)\)/g

/** Un literal completo, sin interpolación: no hay dato de nadie adentro. */
const ES_LITERAL = /^\s*(?:'[^']*'|"[^"]*"|`[^`$]*`)\s*$/

/** Señales de que el valor sí viene de afuera. */
const ORIGEN_EXTERNO =
  /\b(?:props|params|searchParams|query|body|data|row|item|post|article|content|message|comment|description|input|value|user|profile|req|request|formData)\b/

/** Señales de que ya pasó por un sanitizador. */
const SANITIZADO = /\b(?:DOMPurify|sanitizeHtml|sanitize-html|xss|purify|sanitize)\b/i

export const dangerousHtml = defineCheck({
  id: 'sec.dangerous_html',
  pillar: 'security',
  name: 'dangerous-html',
  requires: ['code'],
  async run(ctx): Promise<FindingDraft[]> {
    const fuentes = await archivos(ctx)
    const drafts: FindingDraft[] = []

    for (const archivo of fuentes) {
      if (esDePrueba(archivo.path)) continue
      if (!esCodigo(archivo.path)) continue
      if (SANITIZADO.test(archivo.text)) continue

      for (const { match, linea, lineaTexto } of coincidencias(archivo.text, INSERCION_CRUDA)) {
        const valor = (match[1] ?? match[2] ?? match[3] ?? '').trim()
        if (valor === '') continue
        if (ES_LITERAL.test(valor)) continue
        if (SANITIZADO.test(valor)) continue

        const externo = ORIGEN_EXTERNO.test(valor)

        drafts.push(
          draftFrom(
            'sec.dangerous_html',
            { archivo: archivo.path, linea },
            [evidenciaCodigo(archivo.path, linea, recortar(lineaTexto.trim()))],
            { confidence: externo ? 'likely' : 'to_review' },
          ),
        )
        ctx.log(`sec.dangerous_html: ${archivo.path}:${linea}`)
      }
    }

    return drafts
  },
})
