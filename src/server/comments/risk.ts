/**
 * Clasificación de riesgo de un comentario y enmascarado de secretos.
 *
 * Regla dura: el valor completo de un secreto no sale nunca de esta capa. Lo que
 * viaja a la base, a la UI y al video es siempre la versión enmascarada
 * (`sk_live_••••VwXy`), porque el hallazgo se guarda y se muestra, y no tiene
 * sentido resolver una filtración copiándola a otro lado.
 */
import type { CommentRisk } from '@/lib/types/domain'

import { tokenizeJs } from './tokenize'

export interface RiskResult {
  risk: CommentRisk
  /** Explicación en castellano llano, lista para mostrar. */
  reason?: string
}

/**
 * Patrones de secreto. `keep` es cuántos caracteres del prefijo se conservan al
 * enmascarar (para que el usuario reconozca de qué proveedor era la clave).
 * `group` indica qué grupo de captura contiene el valor sensible.
 */
interface SecretPattern {
  re: RegExp
  keep: number
  group: number
  label: string
}

const SECRETS: SecretPattern[] = [
  { re: /\b((?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,})\b/g, keep: 8, group: 1, label: 'Stripe' },
  { re: /\b(whsec_[A-Za-z0-9_-]{10,})\b/g, keep: 6, group: 1, label: 'Stripe' },
  {
    re: /\b(sb_(?:secret|publishable)_[A-Za-z0-9_-]{10,})\b/g,
    keep: 12,
    group: 1,
    label: 'Supabase',
  },
  { re: /\b((?:AKIA|ASIA|AIDA|AROA)[0-9A-Z]{16})\b/g, keep: 4, group: 1, label: 'AWS' },
  { re: /\b(AIza[0-9A-Za-z_-]{20,})\b/g, keep: 4, group: 1, label: 'Google' },
  { re: /\b(sk-ant-[A-Za-z0-9_-]{20,})\b/g, keep: 7, group: 1, label: 'Anthropic' },
  { re: /\b(sk-(?:proj-)?[A-Za-z0-9_-]{20,})\b/g, keep: 3, group: 1, label: 'OpenAI' },
  {
    re: /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    keep: 4,
    group: 1,
    label: 'GitHub',
  },
  { re: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g, keep: 5, group: 1, label: 'Slack' },
  {
    re: /\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,})\b/g,
    keep: 3,
    group: 1,
    label: 'token de sesión',
  },
  {
    re: /(-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----)/g,
    keep: 11,
    group: 1,
    label: 'clave privada',
  },
  {
    re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:([^\s@/]{3,})@/g,
    keep: 0,
    group: 1,
    label: 'cadena de conexión',
  },
  {
    re: /\b(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|auth[_-]?token|bearer)\b\s*[:=]\s*["']?([^\s"',;)]{6,})["']?/gi,
    keep: 0,
    group: 1,
    label: 'credencial',
  },
]

const INTERNAL_NOTE: RegExp[] = [
  /\bno\s+(tocar|borrar|cambiar|modificar|subir)\b/i,
  /\b(do\s+not|don'?t)\s+(touch|remove|delete|change)\b/i,
  /\bel\s+cliente\s+no\s+(sabe|se\s+entera|puede)\b/i,
  /\bclient\s+(does\s?n[o']?t|doesn't)\s+know\b/i,
  /\b(chapuza|parche|provisorio|provisional|por\s+ahora|temporal(?:mente)?)\b/i,
  /\bworkaround\b/i,
  /\b(staging|preproducci[óo]n|pre-?prod)\b/i,
  /\b(credenciales|credentials|usuario\s+de\s+prueba|contrase[ñn]a\s+de\s+prueba)\b/i,
  /\b(10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
  /\b192\.168\.\d{1,3}\.\d{1,3}\b/,
  /\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/,
  /\blocalhost(?::\d+)?\b/i,
  /\b[\w-]+\.(?:local|internal|interno|lan|corp)\b/i,
  /\b(?:preguntar(?:le)?(?:\s+a)?|hablar\s+con|consultar(?:\s+a)?|avisar(?:le)?(?:\s+a)?|ask|cc)\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,}\b/,
]

// Sin flag /i a propósito: "todo" en minúscula es una palabra española común
// ("todo esto llega armado"), no un marcador de pendiente. El convenio real de
// estos marcadores es mayúscula sostenida (TODO, FIXME...); exigirla evita el
// falso positivo sin perder ningún caso real.
const TODO_RE = /\b(TODO|FIXME|XXX|HACK|WIP)\b/

const CODE_KEYWORD =
  /\b(const|let|var|function|return|if|else|for|while|switch|case|import|export|class|await|async|new|throw|try|catch|interface|type|enum)\b/

const STRUCTURAL = /[;{(=]/

/** Enmascara un valor conservando `keep` caracteres de prefijo y los últimos 4. */
function mask(value: string, keep: number): string {
  if (value.length <= 8) return '••••'
  const head = value.slice(0, Math.min(keep, value.length - 4))
  return `${head}••••${value.slice(-4)}`
}

/**
 * Reemplaza cualquier secreto reconocible por su versión enmascarada.
 * Se aplica a todo texto de comentario antes de guardarlo o mostrarlo.
 */
export function maskSecrets(text: string): string {
  let out = text
  for (const p of SECRETS) {
    out = out.replace(new RegExp(p.re.source, p.re.flags), (full, ...args) => {
      const value = args[p.group - 1] as string | undefined
      if (!value) return full
      return full.replace(value, mask(value, p.keep))
    })
  }
  return out
}

/** Devuelve las etiquetas de proveedor de los secretos encontrados. */
export function detectSecretLabels(text: string): string[] {
  const found = new Set<string>()
  for (const p of SECRETS) {
    if (new RegExp(p.re.source, p.re.flags.replace('g', '')).test(text)) found.add(p.label)
  }
  return [...found]
}

function bracketsBalanced(text: string): boolean {
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
  const stack: string[] = []
  for (const ch of text) {
    if (ch === '(' || ch === '[' || ch === '{') stack.push(ch)
    else if (ch in pairs) {
      if (stack.pop() !== pairs[ch]) return false
    }
  }
  return stack.length === 0
}

/**
 * Heurística de "esto es código comentado, no una explicación": tiene más de una
 * línea, se puede tokenizar sin basura, los paréntesis cierran, y aparecen tanto
 * una palabra clave del lenguaje como un signo estructural. Pedir las dos cosas
 * evita marcar prosa que casualmente diga "function" o "return".
 */
export function looksLikeCode(inner: string): boolean {
  const lines = inner.split('\n').filter((l) => l.trim() !== '')
  if (lines.length < 2) return false
  if (!STRUCTURAL.test(inner)) return false
  if (!CODE_KEYWORD.test(inner)) return false
  if (!bracketsBalanced(inner)) return false
  return tokenizeJs(inner, { jsx: false }).ok
}

/**
 * Clasifica el riesgo del contenido de un comentario (sin sus delimitadores).
 * Precedencia: secreto > nota interna > código comentado > pendiente.
 * El secreto va primero porque es el único con consecuencias inmediatas.
 */
export function classifyRisk(inner: string): RiskResult {
  const labels = detectSecretLabels(inner)
  if (labels.length > 0) {
    return {
      risk: 'secret',
      reason: `Parece incluir una clave de ${labels.join(' y ')}. Cualquiera que lea el código la ve.`,
    }
  }

  if (INTERNAL_NOTE.some((r) => r.test(inner))) {
    return {
      risk: 'internal_note',
      reason: 'Es una nota interna del equipo. No conviene que quede a la vista.',
    }
  }

  if (looksLikeCode(inner)) {
    return {
      risk: 'disabled_code',
      reason: 'Es código viejo que quedó apagado. Ocupa lugar y confunde a quien lea después.',
    }
  }

  if (TODO_RE.test(inner)) {
    return { risk: 'todo', reason: 'Marca algo pendiente de hacer.' }
  }

  return { risk: 'none' }
}
