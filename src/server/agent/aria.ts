/**
 * Lectura del árbol de accesibilidad de una página.
 *
 * Por qué esto y no el HTML: el árbol de accesibilidad es lo que "ve" una persona
 * usando la app (roles y nombres visibles), pesa entre 10 y 100 veces menos que el
 * HTML crudo, y no cambia cuando el framework reordena clases. Menos tokens y menos
 * frágil. Playwright 1.60+ lo devuelve en modo "ai" con una referencia estable por
 * elemento (`[ref=e12]`) que se puede volver a resolver con el selector `aria-ref=e12`.
 *
 * Lo usan: `driver.ts`, `guards.ts` y las tareas de `src/server/agent/tasks/**`.
 */

import 'server-only'

/** Un nodo del árbol, ya parseado. */
export interface AriaNode {
  /** Referencia para volver a encontrar el elemento. Ausente en nodos sin ref. */
  ref?: string
  /** Rol de accesibilidad: button, link, textbox, heading, text… */
  role: string
  /** Nombre accesible (lo que la persona lee). */
  name: string
  /** Destino, si el nodo es un enlace. */
  url?: string
  /** Nivel de anidado, para reconstruir jerarquía. */
  depth: number
  /** Atributos crudos entre corchetes, ej. ["level=1", "checked"]. */
  attrs: string[]
  /** Línea original, útil para mostrar evidencia sin reconstruirla. */
  raw: string
}

export interface AriaTree {
  nodes: AriaNode[]
  byRef: Map<string, AriaNode>
  /** El texto tal cual lo devolvió Playwright. */
  text: string
}

const NODE_LINE = /^(\s*)-\s+([a-zA-Z][\w-]*)(?::)?\s*(?:"((?:[^"\\]|\\.)*)")?\s*(.*)$/
const URL_LINE = /^\s*-\s*\/url:\s*(.+)$/
const REF_ATTR = /\[ref=([a-zA-Z0-9_]+)\]/
const BRACKET_ATTR = /\[([^\]]+)\]/g

/** Desescapa las comillas y barras que Playwright escapa dentro del nombre. */
function unescapeName(value: string): string {
  return value.replace(/\\(["\\])/g, '$1')
}

/**
 * Convierte el volcado en YAML de `page.ariaSnapshot({ mode: 'ai' })` en nodos.
 * Es tolerante: cualquier línea que no entienda la ignora en vez de romper la corrida.
 */
export function parseAriaSnapshot(text: string): AriaTree {
  const nodes: AriaNode[] = []
  const byRef = new Map<string, AriaNode>()
  let previous: AriaNode | null = null

  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue

    const urlMatch = line.match(URL_LINE)
    if (urlMatch && previous) {
      previous.url = urlMatch[1].trim()
      continue
    }

    const match = line.match(NODE_LINE)
    if (!match) continue

    const [, indent, role, quotedName, rest] = match
    const attrs: string[] = []
    let bracket: RegExpExecArray | null
    BRACKET_ATTR.lastIndex = 0
    while ((bracket = BRACKET_ATTR.exec(rest)) !== null) attrs.push(bracket[1])

    // `- text: Hola` no lleva comillas: el nombre queda en el resto de la línea.
    const trailing = rest.replace(BRACKET_ATTR, '').replace(/:$/, '').trim()
    const name = quotedName !== undefined ? unescapeName(quotedName) : trailing

    const refMatch = rest.match(REF_ATTR)
    const node: AriaNode = {
      ref: refMatch ? refMatch[1] : undefined,
      role,
      name,
      depth: Math.floor(indent.length / 2),
      attrs,
      raw: line.trim(),
    }

    nodes.push(node)
    if (node.ref) byRef.set(node.ref, node)
    previous = node
  }

  return { nodes, byRef, text }
}

/** Roles con los que se puede interactuar. El resto es decorado o texto. */
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'tab',
])

export function isInteractive(node: AriaNode): boolean {
  return INTERACTIVE_ROLES.has(node.role)
}

/**
 * Versión compacta del árbol para mandarle al modelo.
 * Se quedan los elementos con los que se puede interactuar más los encabezados y
 * el texto suelto (que es el que explica de qué va la pantalla), y se recorta el
 * total para no gastar tokens en menús interminables.
 */
export function summarizeForModel(tree: AriaTree, maxLines = 140): string {
  const keep: string[] = []
  for (const node of tree.nodes) {
    const useful =
      isInteractive(node) ||
      node.role === 'heading' ||
      node.role === 'text' ||
      node.role === 'paragraph' ||
      node.role === 'alert' ||
      node.role === 'status' ||
      node.role === 'dialog' ||
      node.role === 'img'
    if (!useful) continue
    if (node.role === 'text' && node.name.trim().length < 2) continue

    const indent = '  '.repeat(Math.min(node.depth, 6))
    const refPart = node.ref ? ` [ref=${node.ref}]` : ''
    const namePart = node.name ? ` "${node.name.slice(0, 120)}"` : ''
    const urlPart = node.url ? ` -> ${node.url}` : ''
    keep.push(`${indent}- ${node.role}${namePart}${refPart}${urlPart}`)
    if (keep.length >= maxLines) {
      keep.push('  … (hay más elementos en la página; se recortó la lista)')
      break
    }
  }
  return keep.join('\n')
}

/** Texto plano de la pantalla, para buscar frases sin depender del HTML. */
export function visibleText(tree: AriaTree): string {
  return tree.nodes
    .map((node) => `${node.name} ${node.url ?? ''}`)
    .join('\n')
    .toLowerCase()
}

/** Busca los nodos cuyo nombre o destino contiene alguna de las frases dadas. */
export function findByPhrases(tree: AriaTree, phrases: string[]): AriaNode[] {
  const wanted = phrases.map((phrase) => normalize(phrase))
  return tree.nodes.filter((node) => {
    const haystack = normalize(`${node.name} ${node.url ?? ''}`)
    return wanted.some((phrase) => phrase.length > 0 && haystack.includes(phrase))
  })
}

/** Minúsculas y sin tildes: "Eliminá tu cuenta" y "eliminar cuenta" tienen que matchear. */
export function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
