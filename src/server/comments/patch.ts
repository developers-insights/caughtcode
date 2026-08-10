/**
 * Diff unificado, escrito a mano (sin dependencias nuevas).
 *
 * El entregable de la limpieza es un parche, no una escritura sobre el repo del
 * usuario: así puede leer qué cambia, aplicarlo con `git apply` cuando quiera, y
 * deshacerlo con `git checkout`. Nunca tocamos su código sin permiso.
 *
 * El algoritmo es el greedy de Myers, que es O((N+M)·D) con D = tamaño de la
 * diferencia. Como acá D es chico por definición (sólo salen comentarios), es
 * prácticamente lineal. Si aun así se dispara, se corta y se emite el archivo
 * entero como un solo bloque: preferimos un parche feo antes que colgarnos.
 */
import type { CommentCleanPlan } from '@/lib/types/domain'

const CONTEXT = 3
const MAX_D = 4000

type Op = { kind: 'eq' | 'del' | 'add'; line: string }

function splitLines(text: string): { lines: string[]; endsWithNewline: boolean } {
  if (text === '') return { lines: [], endsWithNewline: true }
  const endsWithNewline = text.endsWith('\n')
  const lines = text.split('\n')
  if (endsWithNewline) lines.pop()
  return { lines, endsWithNewline }
}

/** Myers greedy: devuelve la secuencia de operaciones, o null si se pasa de `MAX_D`. */
function diffOps(a: string[], b: string[]): Op[] | null {
  const n = a.length
  const m = b.length
  const max = Math.min(n + m, MAX_D)
  const v = new Map<number, number>([[1, 0]])
  const trace: Array<Map<number, number>> = []

  for (let d = 0; d <= max; d++) {
    trace.push(new Map(v))
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0))
      let x = down ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v.set(k, x)
      if (x >= n && y >= m) return backtrack(a, b, trace, d)
    }
  }
  return null
}

function backtrack(a: string[], b: string[], trace: Array<Map<number, number>>, d: number): Op[] {
  const ops: Op[] = []
  let x = a.length
  let y = b.length

  for (let step = d; step > 0; step--) {
    const v = trace[step]!
    const k = x - y
    const down = k === -step || (k !== step && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0))
    const prevK = down ? k + 1 : k - 1
    const prevX = v.get(prevK) ?? 0
    const prevY = prevX - prevK

    while (x > prevX && y > prevY) {
      ops.push({ kind: 'eq', line: a[x - 1]! })
      x--
      y--
    }
    if (down) {
      ops.push({ kind: 'add', line: b[y - 1]! })
      y--
    } else {
      ops.push({ kind: 'del', line: a[x - 1]! })
      x--
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: 'eq', line: a[x - 1]! })
    x--
    y--
  }
  while (x > 0) {
    ops.push({ kind: 'del', line: a[--x]! })
  }
  while (y > 0) {
    ops.push({ kind: 'add', line: b[--y]! })
  }
  return ops.reverse()
}

function wholeFileOps(a: string[], b: string[]): Op[] {
  return [
    ...a.map((line): Op => ({ kind: 'del', line })),
    ...b.map((line): Op => ({ kind: 'add', line })),
  ]
}

const NO_NEWLINE = '\\ No newline at end of file'

/** Diff unificado de un archivo, con cabeceras que `git apply` entiende. */
export function unifiedDiff(file: string, before: string, after: string, context = CONTEXT): string {
  if (before === after) return ''

  const A = splitLines(before)
  const B = splitLines(after)
  const ops = diffOps(A.lines, B.lines) ?? wholeFileOps(A.lines, B.lines)

  // Línea de cada lado justo antes de aplicar cada operación (base 0).
  const aAt: number[] = new Array(ops.length + 1)
  const bAt: number[] = new Array(ops.length + 1)
  let a = 0
  let b = 0
  for (let i = 0; i < ops.length; i++) {
    aAt[i] = a
    bAt[i] = b
    if (ops[i]!.kind !== 'add') a++
    if (ops[i]!.kind !== 'del') b++
  }
  aAt[ops.length] = a
  bAt[ops.length] = b

  const changed = ops.map((o, i) => (o.kind === 'eq' ? -1 : i)).filter((i) => i >= 0)
  if (changed.length === 0) return ''

  // Cambios separados por más de 2·context líneas iguales van en bloques distintos.
  const groups: Array<[number, number]> = []
  let gStart = changed[0]!
  let gEnd = changed[0]!
  for (const i of changed.slice(1)) {
    if (i - gEnd > context * 2) {
      groups.push([gStart, gEnd])
      gStart = i
    }
    gEnd = i
  }
  groups.push([gStart, gEnd])

  const render = (op: Op, i: number): string => {
    const prefix = op.kind === 'eq' ? ' ' : op.kind === 'del' ? '-' : '+'
    const line = `${prefix}${op.line}`
    const ultimaDeA = op.kind !== 'add' && aAt[i] === A.lines.length - 1 && !A.endsWithNewline
    const ultimaDeB = op.kind !== 'del' && bAt[i] === B.lines.length - 1 && !B.endsWithNewline
    return ultimaDeA || ultimaDeB ? `${line}\n${NO_NEWLINE}` : line
  }

  const hunks = groups.map(([first, last]) => {
    const from = Math.max(0, first - context)
    const to = Math.min(ops.length - 1, last + context)
    const lines: string[] = []
    let aCount = 0
    let bCount = 0
    for (let i = from; i <= to; i++) {
      const op = ops[i]!
      lines.push(render(op, i))
      if (op.kind !== 'add') aCount++
      if (op.kind !== 'del') bCount++
    }
    const aStart = aCount === 0 ? aAt[from]! : aAt[from]! + 1
    const bStart = bCount === 0 ? bAt[from]! : bAt[from]! + 1
    return [`@@ -${aStart},${aCount} +${bStart},${bCount} @@`, ...lines].join('\n')
  })

  const head = [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`]
  return `${[...head, ...hunks].join('\n')}\n`
}

/** Un solo parche con todos los archivos del plan, en orden estable. */
export function buildPatch(plan: Pick<CommentCleanPlan, 'files'>): string {
  return [...plan.files]
    .sort((a, b) => a.file.localeCompare(b.file))
    .map((f) => unifiedDiff(f.file, f.before, f.after))
    .filter((d) => d !== '')
    .join('')
}
