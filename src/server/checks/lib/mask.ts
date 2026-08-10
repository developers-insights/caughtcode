/**
 * Enmascarado de secretos y medición de entropía.
 *
 * Regla dura: **un hallazgo nunca puede filtrar el secreto que denuncia.**
 * El valor entra en la evidencia solo pasado por `enmascarar()`. La evidencia
 * viaja a la base, a la pantalla y al video: si el valor crudo entra acá, lo
 * acabamos de publicar en tres lugares más.
 */

/** Prefijos que sí conviene dejar visibles: identifican al proveedor sin revelar nada. */
const PREFIJOS_CONOCIDOS = [
  'sk_live_',
  'sk_test_',
  'pk_live_',
  'pk_test_',
  'rk_live_',
  'whsec_',
  'sbp_',
  'sb_secret_',
  'sb_publishable_',
  'AKIA',
  'ASIA',
  'ghp_',
  'gho_',
  'ghu_',
  'ghs_',
  'ghr_',
  'github_pat_',
  'sk-ant-api03-',
  'sk-ant-',
  'sk-proj-',
  'sk-',
  'AIza',
  'xoxb-',
  'xoxp-',
  'SG.',
  'glpat-',
  'npm_',
  'dop_v1_',
  'shpat_',
]

/**
 * `sk_live_51H8xy…9fA2` → `sk_live_••••9fA2`.
 * Valores cortos quedan completamente tapados: mostrar 4 de 12 caracteres es
 * regalar un tercio de la clave.
 */
export function enmascarar(valor: string): string {
  const v = valor.trim()
  if (v.length === 0) return '••••'

  const prefijo = PREFIJOS_CONOCIDOS.find((p) => v.startsWith(p)) ?? ''
  const resto = v.slice(prefijo.length)

  // Sin margen suficiente, no se muestra ninguna cola.
  if (resto.length < 12) return `${prefijo}••••`

  return `${prefijo}••••${resto.slice(-4)}`
}

/** Igual que `enmascarar`, pero para una línea entera de código. */
export function enmascararEnLinea(linea: string, valor: string): string {
  if (valor.length === 0) return linea
  return linea.split(valor).join(enmascarar(valor))
}

/* ── Entropía ─────────────────────────────────────────────────────────── */

export function entropiaShannon(texto: string): number {
  if (texto.length === 0) return 0
  const frecuencias = new Map<string, number>()
  for (const char of texto) frecuencias.set(char, (frecuencias.get(char) ?? 0) + 1)
  let entropia = 0
  for (const conteo of frecuencias.values()) {
    const p = conteo / texto.length
    entropia -= p * Math.log2(p)
  }
  return entropia
}

/** Palabras que aparecen en valores de ejemplo y no son secretos. */
const RUIDO = [
  'example',
  'ejemplo',
  'placeholder',
  'changeme',
  'cambiame',
  'your',
  'tu-',
  'xxxx',
  'yyyy',
  'todo',
  'dummy',
  'sample',
  'test',
  'fake',
  'localhost',
  'password123',
  'lorem',
  'aaaa',
  '1234567890',
  'abcdef',
  'insert_',
  '<',
  '>',
  '...',
]

/**
 * Heurística de "esto parece un secreto de verdad".
 * Conservadora a propósito: un falso positivo acá cuesta credibilidad (D14),
 * y ya tenemos los patrones por proveedor para los casos seguros.
 */
export function pareceSecreto(valor: string, minEntropia = 3.6): boolean {
  const v = valor.trim()
  if (v.length < 16 || v.length > 512) return false

  const bajo = v.toLowerCase()
  if (RUIDO.some((r) => bajo.includes(r))) return false

  // Una frase con espacios no es una clave.
  if (/\s/.test(v)) return false
  // Rutas y URLs sin credencial adentro.
  if (/^(https?:\/\/|\.{0,2}\/)/.test(v) && !/:[^/@]+@/.test(v)) return false
  // Un identificador en snake_case o kebab-case es una variable, no una clave.
  if (/^[a-z][a-z0-9]*([_-][a-z0-9]+)*$/.test(v)) return false

  const variedad = new Set(v).size
  if (variedad < 10) return false

  return entropiaShannon(v) >= minEntropia
}

/* ── JWT ──────────────────────────────────────────────────────────────── */

export interface ClaimsJwt {
  role?: string
  iss?: string
  ref?: string
  [key: string]: unknown
}

/**
 * Decodifica el cuerpo de un JWT **sin validar la firma**. No hace falta:
 * lo único que se pregunta es "¿este token dice ser service_role?", y esa
 * respuesta se lee del propio cuerpo. Es la diferencia entre denunciar la
 * llave maestra y denunciar la llave pública, que es inofensiva.
 */
export function leerClaimsJwt(token: string): ClaimsJwt | null {
  const partes = token.split('.')
  if (partes.length !== 3) return null
  try {
    const json = Buffer.from(partes[1]!, 'base64url').toString('utf8')
    const claims = JSON.parse(json) as unknown
    if (typeof claims !== 'object' || claims === null) return null
    return claims as ClaimsJwt
  } catch {
    return null
  }
}

export function esJwtServiceRole(token: string): boolean {
  return leerClaimsJwt(token)?.role === 'service_role'
}

export function esJwtAnon(token: string): boolean {
  return leerClaimsJwt(token)?.role === 'anon'
}
