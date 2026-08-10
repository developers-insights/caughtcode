/**
 * Detección de comentarios en un archivo, con alcance y riesgo.
 *
 * Devuelve dos cosas alineadas 1:1: los `hits` del contrato de dominio (lo que
 * ve el usuario) y los `ranges` con las posiciones exactas (lo que usa el
 * limpiador). Nunca se borra por texto ni por línea: siempre por rango.
 */
import { computeLineStarts } from 'typescript/unstable/ast/scanner'

import type { CommentHit, CommentReach, CommentRisk } from '@/lib/types/domain'

import { cssSignature, isCssLike, parseCssComments } from './css'
import { classifyFunctional, functionalReason, type FunctionalClass } from './functional'
import { isHtmlLike, scanHtml } from './html'
import { computeReach, type ReachContext } from './reach'
import { classifyRisk, maskSecrets } from './risk'
import { allowsJsx, isJsLike, tokenizeJs, type RawComment } from './tokenize'

/** Cuánto texto de comentario se guarda. Suficiente para entender, acotado para la UI. */
const MAX_TEXT = 500

export interface CommentRangeInfo {
  /** Inicio del comentario en el archivo. */
  pos: number
  /** Fin del comentario (exclusivo). */
  end: number
  /** Rango del contenedor JSX `{...}` a borrar en lugar del comentario. */
  containerPos?: number
  containerEnd?: number
  functionalClass: FunctionalClass | null
  /** Por qué este comentario llega —o no— al navegador. */
  reachReason: string
}

export interface ScannedFile {
  file: string
  text: string
  hits: CommentHit[]
  ranges: CommentRangeInfo[]
  /** false si el archivo no se pudo leer con confianza; entonces no se toca. */
  ok: boolean
  problem?: string
}

export interface ScanFileInput {
  file: string
  text: string
}

interface Piece {
  pos: number
  end: number
  syntax: CommentHit['syntax']
  /** Texto crudo, con delimitadores. */
  raw: string
  /** Texto interno, sin delimitadores ni asteriscos de JSDoc. */
  inner: string
  containerPos?: number
  containerEnd?: number
}

function lineOf(lineStarts: number[], offset: number): number {
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lineStarts[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/** Quita `//`, `/* *\/` o `<!-- -->` y los asteriscos de continuación del JSDoc. */
function innerText(raw: string): string {
  let body = raw
  if (body.startsWith('<!--')) {
    body = body.slice(4)
    if (body.endsWith('-->')) body = body.slice(0, -3)
    return body
  }
  if (body.startsWith('/*')) {
    body = body.slice(body.startsWith('/**') ? 3 : 2)
    if (body.endsWith('*/')) body = body.slice(0, -2)
    return body
      .split('\n')
      .map((l) => l.replace(/^\s*\*\s?/, ''))
      .join('\n')
  }
  return body.replace(/^\/\/+/, '')
}

function trimText(inner: string): string {
  const t = maskSecrets(inner).trim()
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}…` : t
}

/** True si desde el principio de la línea hasta `pos` sólo hay espacios. */
function ownsItsLine(text: string, lineStarts: number[], pos: number): boolean {
  const start = lineStarts[lineOf(lineStarts, pos) - 1]!
  return /^[\t ]*$/.test(text.slice(start, pos))
}

/**
 * Junta comentarios de línea consecutivos que ocupan su propia línea en un solo
 * hallazgo. Un bloque de código comentado son cinco `//` seguidos, y mostrarlo
 * como cinco hallazgos distintos satura al usuario sin aportar nada.
 *
 * Los funcionales nunca se agrupan: si se mezclaran con uno común, borrar el
 * grupo se llevaría puesta una directiva.
 */
function groupLineComments(
  text: string,
  lineStarts: number[],
  pieces: Piece[],
  file: string,
): Piece[] {
  const out: Piece[] = []
  let i = 0
  while (i < pieces.length) {
    const p = pieces[i]!
    const groupable =
      p.syntax === 'line' &&
      p.containerPos === undefined &&
      classifyFunctional(p.raw, { file }) === null &&
      ownsItsLine(text, lineStarts, p.pos)

    if (!groupable) {
      out.push(p)
      i++
      continue
    }

    let j = i
    let lastLine = lineOf(lineStarts, p.end)
    while (j + 1 < pieces.length) {
      const n = pieces[j + 1]!
      if (
        n.syntax !== 'line' ||
        n.containerPos !== undefined ||
        classifyFunctional(n.raw, { file }) !== null ||
        !ownsItsLine(text, lineStarts, n.pos) ||
        lineOf(lineStarts, n.pos) !== lastLine + 1
      ) {
        break
      }
      lastLine = lineOf(lineStarts, n.end)
      j++
    }

    if (j === i) {
      out.push(p)
    } else {
      const first = pieces[i]!
      const last = pieces[j]!
      out.push({
        pos: first.pos,
        end: last.end,
        syntax: 'line',
        raw: text.slice(first.pos, last.end),
        inner: pieces
          .slice(i, j + 1)
          .map((x) => x.inner)
          .join('\n'),
      })
    }
    i = j + 1
  }
  return out
}

function jsPieces(text: string, file: string, offset = 0): { pieces: Piece[]; ok: boolean; problem?: string } {
  const res = tokenizeJs(text, { jsx: allowsJsx(file) })
  if (!res.ok) return { pieces: [], ok: false, problem: res.problem }
  const pieces = res.comments.map((c: RawComment): Piece => {
    const raw = text.slice(c.pos, c.end)
    const isContainer = c.containerPos !== undefined
    return {
      pos: c.pos + offset,
      end: c.end + offset,
      syntax: isContainer ? 'jsx' : c.kind,
      raw,
      inner: innerText(raw),
      containerPos: c.containerPos === undefined ? undefined : c.containerPos + offset,
      containerEnd: c.containerEnd === undefined ? undefined : c.containerEnd + offset,
    }
  })
  return { pieces, ok: true }
}

function cssPieces(text: string, file: string, offset = 0): { pieces: Piece[]; ok: boolean; problem?: string } {
  const parsed = parseCssComments(text, file)
  if (!parsed.ok) return { pieces: [], ok: false, problem: parsed.problem }
  const pieces = parsed.comments.map((c): Piece => {
    const raw = text.slice(c.pos, c.end)
    return { pos: c.pos + offset, end: c.end + offset, syntax: 'css', raw, inner: innerText(raw) }
  })
  return { pieces, ok: true }
}

function collectPieces(file: string, text: string): { pieces: Piece[]; ok: boolean; problem?: string } {
  if (isHtmlLike(file)) {
    const html = scanHtml(text)
    const pieces: Piece[] = html.comments.map((c): Piece => {
      const raw = text.slice(c.pos, c.end)
      return { pos: c.pos, end: c.end, syntax: 'html', raw, inner: innerText(raw) }
    })
    for (const block of html.embedded) {
      const body = text.slice(block.start, block.end)
      const sub =
        block.lang === 'css'
          ? cssPieces(body, `${file}.css`, block.start)
          : jsPieces(body, `${file}.js`, block.start)
      if (sub.ok) pieces.push(...sub.pieces)
    }
    pieces.sort((a, b) => a.pos - b.pos)
    return { pieces, ok: true }
  }

  if (isCssLike(file)) return cssPieces(text, file)
  if (isJsLike(file)) return jsPieces(text, file)
  return { pieces: [], ok: true }
}

export function scanFile(input: ScanFileInput, ctx: ReachContext = {}): ScannedFile {
  const { file, text } = input
  const lineStarts = computeLineStarts(text)
  const collected = collectPieces(file, text)

  if (!collected.ok) {
    return { file, text, hits: [], ranges: [], ok: false, problem: collected.problem }
  }

  const pieces = isJsLike(file)
    ? groupLineComments(text, lineStarts, collected.pieces, file)
    : collected.pieces

  const reach = computeReach(file, text, ctx)
  const hits: CommentHit[] = []
  const ranges: CommentRangeInfo[] = []

  for (const p of pieces) {
    const fnClass = classifyFunctional(p.raw, { file })
    const risk = classifyRisk(p.inner)
    const effectiveReach: CommentReach = p.syntax === 'html' ? 'ships_to_browser' : reach.reach
    const effectiveReason = p.syntax === 'html' ? htmlReason() : reach.reason

    hits.push({
      file,
      line: lineOf(lineStarts, p.pos),
      endLine: lineOf(lineStarts, Math.max(p.pos, p.end - 1)),
      text: trimText(p.inner),
      syntax: p.syntax,
      reach: effectiveReach,
      risk: risk.risk as CommentRisk,
      functional: fnClass !== null,
      reason: fnClass !== null ? functionalReason(fnClass) : (risk.reason ?? effectiveReason),
    })

    ranges.push({
      pos: p.pos,
      end: p.end,
      containerPos: p.containerPos,
      containerEnd: p.containerEnd,
      functionalClass: fnClass,
      reachReason: effectiveReason,
    })
  }

  return { file, text, hits, ranges, ok: true }
}

function htmlReason(): string {
  return 'Los comentarios del HTML se ven con "ver código fuente" en cualquier navegador.'
}

/** Reexportado para que verify no tenga que volver a importar postcss. */
export { cssSignature }
