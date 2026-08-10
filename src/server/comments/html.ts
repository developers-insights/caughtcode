/**
 * Comentarios de HTML.
 *
 * Son los que más importan: `<!-- ... -->` se ve siempre en "ver código fuente",
 * sin minificador que lo saque ni build que lo esconda.
 *
 * El contenido de `<script>` y `<style>` no se toca acá: se deriva al motor de
 * JavaScript y al de CSS, porque dentro de un script un `<!-- -->` escrito en un
 * string es texto común, y un `//` es un comentario de verdad.
 */
export interface HtmlRange {
  pos: number
  end: number
}

export interface EmbeddedBlock {
  start: number
  end: number
  lang: 'js' | 'css'
}

export interface HtmlScan {
  comments: HtmlRange[]
  embedded: EmbeddedBlock[]
  /** Nombres de etiqueta en orden de aparición. Sirve para verificar el después. */
  tags: string[]
}

const RAW_TEXT = /^<(script|style)\b/i
const TAG_NAME = /^<\/?([a-zA-Z][\w:-]*)/

/** Un `<script>` sólo se analiza como JavaScript si su `type` lo es. */
function scriptIsJs(openTag: string): boolean {
  const m = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(openTag)
  if (!m) return true
  const t = m[1]!.toLowerCase()
  return (
    t === 'module' ||
    t === 'text/javascript' ||
    t === 'application/javascript' ||
    t === 'text/babel' ||
    t === 'text/jsx'
  )
}

export function scanHtml(text: string): HtmlScan {
  const comments: HtmlRange[] = []
  const embedded: EmbeddedBlock[] = []
  const tags: string[] = []
  const len = text.length
  let i = 0

  while (i < len) {
    const lt = text.indexOf('<', i)
    if (lt < 0) break

    if (text.startsWith('<!--', lt)) {
      const close = text.indexOf('-->', lt + 4)
      const end = close < 0 ? len : close + 3
      comments.push({ pos: lt, end })
      i = end
      continue
    }

    const tagEnd = text.indexOf('>', lt)
    if (tagEnd < 0) break

    const nameMatch = TAG_NAME.exec(text.slice(lt, Math.min(lt + 40, len)))
    if (nameMatch) tags.push(nameMatch[1]!.toLowerCase())

    const raw = RAW_TEXT.exec(text.slice(lt, Math.min(lt + 8, len)))
    if (raw) {
      const tag = raw[1]!.toLowerCase()
      const openTag = text.slice(lt, tagEnd + 1)
      const contentStart = tagEnd + 1
      const closeRe = new RegExp(`</${tag}\\s*>`, 'i')
      const rest = text.slice(contentStart)
      const cm = closeRe.exec(rest)
      const contentEnd = cm ? contentStart + cm.index : len

      if (!openTag.endsWith('/>')) {
        if (tag === 'style') embedded.push({ start: contentStart, end: contentEnd, lang: 'css' })
        else if (scriptIsJs(openTag)) embedded.push({ start: contentStart, end: contentEnd, lang: 'js' })
      }

      i = cm ? contentEnd + cm[0].length : len
      continue
    }

    i = tagEnd + 1
  }

  return { comments, embedded, tags }
}

export function isHtmlLike(file: string): boolean {
  return /\.(html?|vue|svelte|hbs|handlebars)$/i.test(file)
}
