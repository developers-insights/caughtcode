/**
 * Comentarios de CSS/SCSS.
 *
 * Se usa postcss en lugar de una expresión regular porque `content: "/* no soy
 * comentario *\/"` es una cadena, no un comentario, y una regex la borraría
 * rompiendo el estilo.
 */
import postcss, { type ChildNode, type Container, type Root } from 'postcss'

export interface CssComment {
  pos: number
  end: number
}

export interface CssParse {
  ok: boolean
  comments: CssComment[]
  problem?: string
}

function walkComments(node: Container | Root, out: CssComment[]): void {
  node.each?.((child: ChildNode) => {
    if (child.type === 'comment') {
      const start = child.source?.start?.offset
      // En postcss 8.5 `end.offset` ya es exclusivo (en versiones viejas apuntaba
      // al último carácter). Verificado contra la versión instalada.
      const end = child.source?.end?.offset
      if (typeof start === 'number' && typeof end === 'number') out.push({ pos: start, end })
    } else if ('nodes' in child && child.nodes) {
      walkComments(child as unknown as Container, out)
    }
  })
}

export function parseCssComments(text: string, file: string): CssParse {
  try {
    const root = postcss.parse(text, { from: file })
    const comments: CssComment[] = []
    walkComments(root, comments)
    comments.sort((a, b) => a.pos - b.pos)
    return { ok: true, comments }
  } catch (err) {
    return {
      ok: false,
      comments: [],
      problem: err instanceof Error ? err.message : 'no se pudo leer el CSS',
    }
  }
}

/** Firma del CSS sin comentarios: sirve para comprobar que no cambió nada real. */
export function cssSignature(text: string, file: string): string | null {
  try {
    const root = postcss.parse(text, { from: file })
    root.walkComments((c) => {
      c.remove()
    })
    return root.toString().replace(/\s+/g, ' ').trim()
  } catch {
    return null
  }
}

export function isCssLike(file: string): boolean {
  return /\.(css|scss|sass|less|styl)$/i.test(file)
}
