/**
 * Tokenizador de JS/TS/JSX construido sobre el scanner del compilador de
 * TypeScript.
 *
 * Por qué no alcanza una expresión regular: `// ` puede aparecer dentro de un
 * string (`"https://x.com"`), dentro de un template literal, dentro de una
 * expresión regular (`/https?:\/\//`) o dentro del texto de un JSX. Un borrado
 * hecho con regex rompe cualquiera de esos cuatro casos.
 *
 * Por qué no usamos el parser: TypeScript 7 movió el parser a un binario nativo
 * y el paquete npm sólo expone el scanner en JavaScript
 * (`typescript/unstable/ast/scanner`). El scanner resuelve solo lo difícil
 * —strings, templates, números, comentarios— pero necesita ayuda en tres puntos
 * donde el parser normalmente le dice qué esperar:
 *
 * 1. `/` puede abrir una expresión regular o ser una división. Se decide por el
 *    token anterior y se re-escanea con `reScanSlashToken`.
 * 2. `}` puede cerrar un bloque o continuar un template (`` `a${x}b` ``). Se
 *    lleva una pila y se re-escanea con `reScanTemplateToken`.
 * 3. JSX tiene tres contextos propios (hijos, etiqueta, expresión) y el texto de
 *    los hijos no es código. Se recorren a mano, cayendo al scanner sólo dentro
 *    de las expresiones `{...}`.
 *
 * Si algo no encaja, el tokenizador aborta (`ok: false`) en lugar de adivinar.
 */
import { LanguageVariant, SyntaxKind, isTriviaKind } from 'typescript/unstable/ast'
import type { Scanner } from 'typescript/unstable/ast/scanner'
import { createScanner, getShebang } from 'typescript/unstable/ast/scanner'

/** Piezas de JSX que no son tokens del scanner. Fuera del rango de SyntaxKind. */
export const JSX_TEXT = -1
export const JSX_PUNCT = -2
export const JSX_NAME = -3

export interface RawComment {
  pos: number
  end: number
  kind: 'line' | 'block'
  /**
   * Si el comentario es lo único que hay dentro de un contenedor JSX
   * (`{/* ... *\/}`), acá va el rango de las llaves: al borrar hay que sacar el
   * contenedor entero, si no queda un `{}` suelto.
   */
  containerPos?: number
  containerEnd?: number
}

export interface RawToken {
  kind: number
  text: string
}

export interface TokenizeResult {
  comments: RawComment[]
  tokens: RawToken[]
  /**
   * Índices de los tokens `{` y `}` que sólo envolvían comentarios. Al comparar
   * el antes y el después hay que ignorarlos: borrarlos es parte del trabajo.
   */
  containerTokens: number[]
  /** Fin del shebang (`#!...`). Cero si no hay. Nunca se toca. */
  shebangEnd: number
  ok: boolean
  problem?: string
}

class Bail extends Error {}

const MAX_DEPTH = 250

/**
 * Devuelve true si en esa posición puede empezar una expresión, o sea si un `/`
 * abre una regex y un `<` abre un JSX. Es la heurística estándar de "token
 * anterior" que usan todos los tokenizadores de JavaScript.
 */
function exprCanStart(prev: number): boolean {
  switch (prev) {
    case SyntaxKind.Identifier:
    case SyntaxKind.PrivateIdentifier:
    case SyntaxKind.NumericLiteral:
    case SyntaxKind.BigIntLiteral:
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
    case SyntaxKind.TemplateTail:
    case SyntaxKind.RegularExpressionLiteral:
    case SyntaxKind.CloseParenToken:
    case SyntaxKind.CloseBracketToken:
    case SyntaxKind.CloseBraceToken:
    case SyntaxKind.PlusPlusToken:
    case SyntaxKind.MinusMinusToken:
    case SyntaxKind.ThisKeyword:
    case SyntaxKind.SuperKeyword:
    case SyntaxKind.TrueKeyword:
    case SyntaxKind.FalseKeyword:
    case SyntaxKind.NullKeyword:
    case JSX_PUNCT:
    case JSX_NAME:
      return false
    default:
      return true
  }
}

const JSX_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$.\-:]*/

/** Literales donde "sin terminar" significa que el archivo está roto. */
const LITERAL_KINDS: ReadonlySet<number> = new Set<number>([
  SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateHead,
  SyntaxKind.TemplateMiddle,
  SyntaxKind.TemplateTail,
  SyntaxKind.RegularExpressionLiteral,
])

class Tokenizer {
  private readonly sc: Scanner
  private pos = 0
  private prev: number = SyntaxKind.Unknown
  private depth = 0
  private steps = 0
  private readonly maxSteps: number
  readonly comments: RawComment[] = []
  readonly tokens: RawToken[] = []
  readonly containerTokens: number[] = []
  shebangEnd = 0
  ok = true
  problem: string | undefined

  constructor(
    private readonly text: string,
    private readonly jsx: boolean,
  ) {
    this.sc = createScanner(false, jsx ? LanguageVariant.JSX : LanguageVariant.Standard, text)
    // Cada paso consume al menos un carácter salvo el JSX, que además emite
    // tokens sintéticos. Con cuatro por carácter sobra para cualquier archivo real.
    this.maxSteps = text.length * 4 + 1000
    const sb = getShebang(text)
    if (sb) {
      this.shebangEnd = sb.length
      this.pos = sb.length
    }
  }

  run(): void {
    try {
      this.js('eof')
    } catch (err) {
      this.ok = false
      this.problem = err instanceof Bail ? err.message : `error inesperado al leer el archivo`
    }
  }

  private bail(why: string): never {
    throw new Bail(why)
  }

  private push(kind: number, text: string): void {
    this.tokens.push({ kind, text })
  }

  /**
   * Recorre código JavaScript hasta el final del archivo, hasta la llave que
   * cierra el bloque actual, o hasta el cierre del template actual.
   */
  private js(stop: 'eof' | 'brace' | 'tmpl'): void {
    if (++this.depth > MAX_DEPTH) this.bail('el archivo tiene demasiados niveles anidados')
    try {
      for (;;) {
        // Presupuesto global de pasos. Es monótono a propósito: un intento de
        // JSX que se descarta retrocede `pos`, así que "no avanzó" no sirve como
        // señal, pero el trabajo hecho ya se gastó y tiene que contar.
        if (++this.steps > this.maxSteps) {
          this.bail(`el archivo necesitó demasiados pasos (posición ${this.pos})`)
        }
        if (this.pos >= this.text.length) {
          if (stop !== 'eof') this.bail('el archivo se termina sin cerrar un bloque')
          return
        }
        this.sc.resetTokenState(this.pos)
        let k: number = this.sc.scan()
        if (k === SyntaxKind.EndOfFile) {
          if (stop !== 'eof') this.bail('el archivo se termina sin cerrar un bloque')
          return
        }
        const start = this.sc.getTokenStart()
        let end = this.sc.getTokenEnd()

        if (k === SyntaxKind.SingleLineCommentTrivia || k === SyntaxKind.MultiLineCommentTrivia) {
          this.comments.push({
            pos: start,
            end,
            kind: k === SyntaxKind.SingleLineCommentTrivia ? 'line' : 'block',
          })
          this.pos = end
          continue
        }
        if (isTriviaKind(k)) {
          this.pos = end
          continue
        }
        if (k === SyntaxKind.Unknown) this.bail('hay un carácter que no se pudo interpretar')
        if (LITERAL_KINDS.has(k) && this.sc.isUnterminated()) {
          this.bail('hay un texto entre comillas que nunca se cierra')
        }

        // `/` ¿división o expresión regular?
        if (
          (k === SyntaxKind.SlashToken || k === SyntaxKind.SlashEqualsToken) &&
          exprCanStart(this.prev)
        ) {
          const rk = this.sc.reScanSlashToken()
          if (rk === SyntaxKind.RegularExpressionLiteral) {
            k = rk
            end = this.sc.getTokenEnd()
          }
        }

        // `<` ¿comparación o JSX?
        if (this.jsx && k === SyntaxKind.LessThanToken && exprCanStart(this.prev)) {
          const jsxEnd = this.tryJsxElement(start)
          if (jsxEnd !== null) {
            this.pos = jsxEnd
            this.prev = JSX_PUNCT
            continue
          }
        }

        if (k === SyntaxKind.OpenBraceToken) {
          this.push(k, this.text.slice(start, end))
          this.pos = end
          this.prev = k
          this.js('brace')
          this.prev = SyntaxKind.CloseBraceToken
          continue
        }

        if (k === SyntaxKind.CloseBraceToken) {
          if (stop === 'tmpl') {
            const tk: number = this.sc.reScanTemplateToken(false)
            if (tk !== SyntaxKind.TemplateMiddle && tk !== SyntaxKind.TemplateTail) {
              this.bail('hay un template literal sin cerrar')
            }
            end = this.sc.getTokenEnd()
            this.push(tk, this.text.slice(start, end))
            this.pos = end
            this.prev = tk
            if (tk === SyntaxKind.TemplateTail) return
            continue
          }
          this.push(k, this.text.slice(start, end))
          this.pos = end
          this.prev = k
          if (stop === 'brace') return
          continue
        }

        if (k === SyntaxKind.TemplateHead) {
          this.push(k, this.text.slice(start, end))
          this.pos = end
          this.prev = k
          this.js('tmpl')
          this.prev = SyntaxKind.TemplateTail
          continue
        }

        this.push(k, this.text.slice(start, end))
        this.pos = end
        this.prev = k
      }
    } finally {
      this.depth--
    }
  }

  /**
   * Intenta leer un elemento JSX. Si el `<` no abría un JSX de verdad (por
   * ejemplo `const f = <T,>(x: T) => x`), deshace todo lo anotado y devuelve
   * null para que el `<` se trate como un token común.
   */
  private tryJsxElement(at: number): number | null {
    const nComments = this.comments.length
    const nTokens = this.tokens.length
    const prev = this.prev
    const pos = this.pos
    try {
      return this.jsxElement(at)
    } catch (err) {
      if (!(err instanceof Bail)) throw err
      this.comments.length = nComments
      this.tokens.length = nTokens
      this.prev = prev
      this.pos = pos
      return null
    }
  }

  /** Lee un elemento JSX completo. `at` apunta al `<`. Devuelve la posición siguiente. */
  private jsxElement(at: number): number {
    if (++this.depth > MAX_DEPTH) this.bail('el JSX tiene demasiados niveles anidados')
    try {
      let p = at + 1
      this.push(JSX_PUNCT, '<')

      p = this.skipTagTrivia(p)
      if (this.text[p] === '>') {
        this.push(JSX_PUNCT, '>')
        return this.jsxChildren(p + 1)
      }

      const name = JSX_NAME_RE.exec(this.text.slice(p))?.[0]
      if (!name) this.bail('no es un elemento JSX')
      this.push(JSX_NAME, name)
      p += name.length

      for (;;) {
        p = this.skipTagTrivia(p)
        const c = this.text[p]
        if (c === undefined) this.bail('hay una etiqueta JSX sin cerrar')
        if (c === '>') {
          this.push(JSX_PUNCT, '>')
          return this.jsxChildren(p + 1)
        }
        if (c === '/' && this.text[p + 1] === '>') {
          this.push(JSX_PUNCT, '/>')
          return p + 2
        }
        if (c === '{') {
          this.push(JSX_PUNCT, '{')
          p = this.jsInBraces(p, p + 1).end
          continue
        }
        const attr = JSX_NAME_RE.exec(this.text.slice(p))?.[0]
        if (!attr) this.bail('no es un atributo JSX válido')
        this.push(JSX_NAME, attr)
        p += attr.length

        const afterName = this.skipTagTrivia(p)
        if (this.text[afterName] !== '=') {
          p = afterName
          continue
        }
        this.push(JSX_PUNCT, '=')
        p = this.skipTagTrivia(afterName + 1)
        const v = this.text[p]
        if (v === '"' || v === "'") {
          // En JSX la barra invertida no escapa dentro del valor de un atributo.
          const close = this.text.indexOf(v, p + 1)
          if (close < 0) this.bail('hay un atributo JSX sin cerrar')
          this.push(SyntaxKind.StringLiteral, this.text.slice(p, close + 1))
          p = close + 1
        } else if (v === '{') {
          this.push(JSX_PUNCT, '{')
          p = this.jsInBraces(p, p + 1).end
        } else {
          this.bail('el atributo JSX no tiene un valor válido')
        }
      }
    } finally {
      this.depth--
    }
  }

  /** Lee los hijos de un elemento hasta su etiqueta de cierre. */
  private jsxChildren(from: number): number {
    let p = from
    for (;;) {
      let i = p
      while (i < this.text.length && this.text[i] !== '<' && this.text[i] !== '{') i++
      if (i > p) this.push(JSX_TEXT, this.text.slice(p, i))
      p = i
      if (p >= this.text.length) this.bail('hay un elemento JSX sin cerrar')

      if (this.text[p] === '{') {
        const bracePos = p
        this.push(JSX_PUNCT, '{')
        const r = this.jsInBraces(bracePos, p + 1)
        p = r.end
        if (r.innerTokens === 0 && this.comments.length > r.commentsBefore) {
          for (let ci = r.commentsBefore; ci < this.comments.length; ci++) {
            this.comments[ci]!.containerPos = bracePos
            this.comments[ci]!.containerEnd = p
          }
          // El `{` es el token anterior al primero que anotó jsInBraces, y el
          // `}` es el último. Se marcan para poder ignorarlos al comparar.
          this.containerTokens.push(r.tokensBefore - 1, this.tokens.length - 1)
        }
        continue
      }

      if (this.text[p + 1] === '/') {
        const gt = this.text.indexOf('>', p)
        if (gt < 0) this.bail('hay una etiqueta de cierre JSX sin terminar')
        this.push(JSX_PUNCT, this.text.slice(p, gt + 1).replace(/\s+/g, ''))
        return gt + 1
      }

      p = this.jsxElement(p)
    }
  }

  /**
   * Lee una expresión JavaScript entre llaves dentro de JSX. `afterBrace` es la
   * posición justo después del `{`, que el llamador ya anotó.
   */
  private jsInBraces(
    _bracePos: number,
    afterBrace: number,
  ): { end: number; innerTokens: number; commentsBefore: number; tokensBefore: number } {
    const commentsBefore = this.comments.length
    const tokensBefore = this.tokens.length
    const prev = this.prev
    this.pos = afterBrace
    this.prev = SyntaxKind.OpenBraceToken
    this.js('brace')
    this.prev = prev
    // js('brace') deja anotado el `}` de cierre como último token.
    return {
      end: this.pos,
      innerTokens: this.tokens.length - tokensBefore - 1,
      commentsBefore,
      tokensBefore,
    }
  }

  /** Salta espacios y comentarios dentro de una etiqueta JSX, anotándolos. */
  private skipTagTrivia(from: number): number {
    let p = from
    for (;;) {
      while (p < this.text.length && /\s/.test(this.text[p]!)) p++
      if (this.text[p] === '/' && this.text[p + 1] === '/') {
        const nl = this.text.indexOf('\n', p)
        const end = nl < 0 ? this.text.length : nl
        this.comments.push({ pos: p, end, kind: 'line' })
        p = end
        continue
      }
      if (this.text[p] === '/' && this.text[p + 1] === '*') {
        const close = this.text.indexOf('*/', p + 2)
        if (close < 0) this.bail('hay un comentario de bloque sin cerrar')
        this.comments.push({ pos: p, end: close + 2, kind: 'block' })
        p = close + 2
        continue
      }
      return p
    }
  }
}

/** Extensiones que se leen con el motor de JavaScript/TypeScript. */
export function isJsLike(file: string): boolean {
  return /\.(m|c)?(j|t)sx?$/i.test(file)
}

/** True si el archivo puede contener JSX. */
export function allowsJsx(file: string): boolean {
  return /\.(jsx|tsx|js|mjs|cjs)$/i.test(file)
}

export function tokenizeJs(text: string, opts: { jsx: boolean }): TokenizeResult {
  const t = new Tokenizer(text, opts.jsx)
  t.run()
  return {
    comments: t.comments,
    tokens: t.tokens,
    containerTokens: t.containerTokens,
    shebangEnd: t.shebangEnd,
    ok: t.ok,
    problem: t.problem,
  }
}
