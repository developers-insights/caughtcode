/**
 * La garantía de que limpiar comentarios no rompe nada.
 *
 * Ningún archivo entra al plan sin pasar por acá. Si algo no cierra, el archivo
 * se descarta —no se "arregla", no se sigue igual— y se anota el motivo.
 *
 * ## Por qué se comparan tokens y no se vuelve a parsear
 *
 * TypeScript 7 movió el parser a un binario nativo: el paquete npm sólo expone
 * el scanner en JavaScript, así que `ts.createSourceFile` ya no existe.
 * Comparar la secuencia de tokens no es un reemplazo peor, es equivalente o
 * mejor: el resultado de parsear es una función pura de los tokens, así que dos
 * archivos con la misma secuencia de tokens producen exactamente el mismo árbol.
 * Y además detecta el caso que un parser dejaría pasar: que el archivo siga
 * siendo válido pero distinto.
 *
 * Se ignoran a propósito dos cosas: los comentarios (es lo que estamos sacando)
 * y las llaves `{}` de un contenedor JSX que sólo tenía comentarios (sacarlas es
 * parte del trabajo, si no queda un `{}` colgando).
 */
import { cssSignature, isCssLike } from './css'
import { isHtmlLike, scanHtml } from './html'
import { JSX_TEXT, allowsJsx, isJsLike, tokenizeJs, type TokenizeResult } from './tokenize'

export interface VerifyResult {
  ok: boolean
  /** Motivo en castellano llano. Se guarda y se puede mostrar. */
  reason?: string
}

const OK: VerifyResult = { ok: true }

/**
 * Texto de JSX listo para comparar: los espacios se colapsan porque JSX los
 * colapsa igual, pero cualquier diferencia de contenido queda a la vista.
 */
function comparableJsxText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Secuencia de tokens significativos, con el texto JSX unificado. */
function comparableTokens(res: TokenizeResult): string[] {
  const drop = new Set(res.containerTokens)
  const out: string[] = []
  let pending: string | null = null

  const flush = (): void => {
    if (pending === null) return
    const t = comparableJsxText(pending)
    if (t !== '') out.push(`jsx:${t}`)
    pending = null
  }

  for (let i = 0; i < res.tokens.length; i++) {
    if (drop.has(i)) continue
    const t = res.tokens[i]!
    if (t.kind === JSX_TEXT) {
      pending = (pending ?? '') + t.text
      continue
    }
    flush()
    out.push(`${t.kind}:${t.text}`)
  }
  flush()
  return out
}

function verifyJs(file: string, before: string, after: string): VerifyResult {
  const jsx = allowsJsx(file)
  const a = tokenizeJs(before, { jsx })
  const b = tokenizeJs(after, { jsx })

  if (!b.ok) {
    return { ok: false, reason: `El resultado no se pudo leer: ${b.problem ?? 'archivo inválido'}.` }
  }
  if (!a.ok) {
    return { ok: false, reason: 'El archivo original no se pudo leer con certeza, así que no se toca.' }
  }
  if (a.shebangEnd !== b.shebangEnd || before.slice(0, a.shebangEnd) !== after.slice(0, b.shebangEnd)) {
    return { ok: false, reason: 'Cambió la primera línea especial del archivo.' }
  }

  const ta = comparableTokens(a)
  const tb = comparableTokens(b)
  if (ta.length !== tb.length) {
    return { ok: false, reason: 'El resultado no tiene el mismo código que el original.' }
  }
  for (let i = 0; i < ta.length; i++) {
    if (ta[i] !== tb[i]) {
      return { ok: false, reason: 'El resultado no tiene el mismo código que el original.' }
    }
  }
  return OK
}

function verifyCss(file: string, before: string, after: string): VerifyResult {
  const sb = cssSignature(after, file)
  if (sb === null) return { ok: false, reason: 'El estilo resultante no se pudo leer.' }
  const sa = cssSignature(before, file)
  if (sa === null) {
    return { ok: false, reason: 'El estilo original no se pudo leer con certeza, así que no se toca.' }
  }
  if (sa !== sb) return { ok: false, reason: 'El resultado no tiene las mismas reglas de estilo.' }
  return OK
}

/** El HTML sin ningún comentario y con los espacios colapsados. */
function htmlSignature(text: string): string | null {
  const scan = scanHtml(text)
  const cuts: Array<{ pos: number; end: number }> = [...scan.comments]
  /** Bloques `<style>` que se recortan enteros y se reemplazan por su firma. */
  const cssBodies = new Map<number, string>()

  for (const block of scan.embedded) {
    const body = text.slice(block.start, block.end)
    if (block.lang === 'css') {
      const firma = cssSignature(body, 'embedded.css')
      if (firma === null) return null
      cssBodies.set(block.start, firma)
      cuts.push({ pos: block.start, end: block.end })
    } else {
      const t = tokenizeJs(body, { jsx: false })
      if (!t.ok) return null
      for (const c of t.comments) cuts.push({ pos: block.start + c.pos, end: block.start + c.end })
    }
  }

  cuts.sort((a, b) => a.pos - b.pos)
  let out = ''
  let at = 0
  for (const c of cuts) {
    if (c.pos < at) continue
    out += text.slice(at, c.pos)
    const injected = cssBodies.get(c.pos)
    if (injected !== undefined) out += injected
    at = c.end
  }
  out += text.slice(at)
  return out.replace(/\s+/g, ' ').trim()
}

function verifyHtml(before: string, after: string): VerifyResult {
  const ta = scanHtml(before).tags
  const tb = scanHtml(after).tags
  if (ta.length !== tb.length || ta.some((t, i) => t !== tb[i])) {
    return { ok: false, reason: 'El resultado no tiene las mismas etiquetas que el original.' }
  }
  const sa = htmlSignature(before)
  const sb = htmlSignature(after)
  if (sa === null || sb === null) {
    return { ok: false, reason: 'No se pudo leer el HTML con certeza, así que no se toca.' }
  }
  if (sa !== sb) return { ok: false, reason: 'El resultado no tiene el mismo contenido que el original.' }
  return OK
}

/**
 * Comprueba que pasar de `before` a `after` sólo sacó comentarios.
 * Cualquier duda se resuelve rechazando.
 */
export function verifyChange(file: string, before: string, after: string): VerifyResult {
  if (before === after) return OK
  if (isHtmlLike(file)) return verifyHtml(before, after)
  if (isCssLike(file)) return verifyCss(file, before, after)
  if (isJsLike(file)) return verifyJs(file, before, after)
  return { ok: false, reason: 'No sabemos leer este tipo de archivo, así que no se toca.' }
}
