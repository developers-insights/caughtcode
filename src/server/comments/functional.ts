/**
 * Comentarios funcionales: los que hacen algo. Borrarlos no es cosmético,
 * cambia la compilación, el bundle, la cobertura o la licencia del proyecto.
 *
 * Esta lista es la que evita que "limpiar comentarios" rompa el proyecto del
 * usuario, así que es deliberadamente amplia: ante la duda, se conserva.
 */

export type FunctionalClass =
  /** `@ts-ignore`, `/// <reference>`, pragmas de JSX. Nunca se borran. */
  | 'compiler_directive'
  /** `eslint-disable`, `prettier-ignore`, `istanbul ignore`. */
  | 'linter'
  /** `webpackChunkName`, `@vite-ignore`, `#__PURE__`. */
  | 'bundler'
  /** `/*!`, `@license`, `@preserve`, SPDX. Nunca se borran. */
  | 'license'
  /** `//# sourceMappingURL`. Nunca se borra. */
  | 'sourcemap'
  /** JSDoc con anotaciones de tipo en un archivo `.js`: es el tipado del archivo. */
  | 'jsdoc_types'
  /** JSDoc de documentación. Se conserva en modo seguro. */
  | 'jsdoc_doc'

/** Clases que se conservan incluso en modo agresivo. */
export const NEVER_REMOVED: ReadonlySet<FunctionalClass> = new Set<FunctionalClass>([
  'compiler_directive',
  'license',
  'sourcemap',
])

const COMPILER_DIRECTIVE = [
  /^\/\/\/\s*<(reference|amd-module|amd-dependency)\b/,
  /@ts-(ignore|expect-error|nocheck|check)\b/,
  /@jsx\b/,
  /@jsxImportSource\b/,
  /@jsxRuntime\b/,
  /@jsxFrag\b/,
]

const LINTER = [
  /\beslint-(disable|enable|env)\b/,
  /^\/\*\s*globals?\s+[A-Za-z_$]/,
  /^\/\*\s*exported\s+[A-Za-z_$]/,
  /\bprettier-ignore\b/,
  /\bbiome-ignore\b/,
  /\boxlint-(disable|enable)\b/,
  /\bdprint-ignore\b/,
  /\bstylelint-(disable|enable)\b/,
  /\bdeno-lint-ignore\b/,
  /\b(c8|istanbul|v8|node:coverage)\s+ignore\b/,
  /\bts-prune-ignore-next\b/,
  /\bknip-ignore\b/,
  /\bjscpd:ignore\b/,
  /@vue\/component\b/,
]

const BUNDLER = [
  /\bwebpack[A-Z][A-Za-z]*\s*:/,
  /\bturbopackIgnore\s*:/,
  /@vite-ignore\b/,
  /[#@]__PURE__/,
  /[#@]__NO_SIDE_EFFECTS__/,
  /[#@]__INLINE__/,
]

const LICENSE = [
  /@license\b/,
  /@preserve\b/,
  /@cc_on\b/,
  /\bSPDX-License-Identifier\b/,
  /@copyright\b/,
]

const SOURCEMAP = [/^\/\/[#@]\s*source(Mapping)?URL=/]

/** Etiquetas de JSDoc que participan del chequeo de tipos en archivos `.js`. */
const JSDOC_TYPE_TAGS =
  /@(type|param|arg|argument|returns?|typedef|satisfies|template|callback|augments|extends|implements|enum|this|overload|import|property|prop|module|namespace|readonly|abstract|public|private|protected|constructor|class)\b/

function anyMatch(res: RegExp[], text: string): boolean {
  return res.some((r) => r.test(text))
}

export interface FunctionalContext {
  /** Ruta del archivo: define si el JSDoc de tipos es funcional. */
  file: string
}

/** True si el archivo usa JSDoc para tipar (no tiene tipos propios de TypeScript). */
export function usesJsdocTypes(file: string): boolean {
  return /\.(m|c)?jsx?$/i.test(file)
}

/**
 * Clasifica un comentario crudo (con sus delimitadores). Devuelve null si es un
 * comentario común, que se puede borrar sin consecuencias.
 */
export function classifyFunctional(raw: string, ctx: FunctionalContext): FunctionalClass | null {
  const text = raw.trim()

  if (SOURCEMAP.some((r) => r.test(text))) return 'sourcemap'
  if (anyMatch(COMPILER_DIRECTIVE, text)) return 'compiler_directive'
  if (text.startsWith('/*!') || anyMatch(LICENSE, text)) return 'license'
  if (anyMatch(LINTER, text)) return 'linter'
  if (anyMatch(BUNDLER, text)) return 'bundler'

  if (text.startsWith('/**')) {
    if (usesJsdocTypes(ctx.file) && JSDOC_TYPE_TAGS.test(text)) return 'jsdoc_types'
    return 'jsdoc_doc'
  }

  return null
}

/** Explicación en castellano llano de por qué se conserva. */
export function functionalReason(cls: FunctionalClass): string {
  switch (cls) {
    case 'compiler_directive':
      return 'Es una instrucción para el compilador. Si se borra, el proyecto puede dejar de compilar.'
    case 'linter':
      return 'Silencia una advertencia del revisor de código. Si se borra, vuelven a aparecer errores al revisar.'
    case 'bundler':
      return 'Le da instrucciones al empaquetador. Si se borra, cambia cómo se arma la app.'
    case 'license':
      return 'Es un aviso de licencia o de derechos de autor. Se conserva siempre.'
    case 'sourcemap':
      return 'Conecta el código publicado con el original para poder depurarlo. Se conserva siempre.'
    case 'jsdoc_types':
      return 'Define los tipos de este archivo. Si se borra, se pierde el chequeo de tipos.'
    case 'jsdoc_doc':
      return 'Documenta cómo se usa este código. En modo cuidadoso se conserva.'
  }
}
