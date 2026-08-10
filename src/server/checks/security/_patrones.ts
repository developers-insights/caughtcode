/**
 * Patrones de claves por proveedor.
 *
 * Dos criterios al agregar uno:
 *
 *  1. **El prefijo tiene que ser inequívoco.** `AKIA…` solo puede ser una clave
 *     de AWS. En cambio la clave secreta de AWS son 40 caracteres base64 sin
 *     prefijo: eso coincide con medio mundo y no entra acá. Un falso positivo
 *     en seguridad le cuesta credibilidad a todo lo demás (D14).
 *
 *  2. **`nombre` es lo que ve el usuario.** Va derecho al texto del hallazgo en
 *     lugar de `{{proveedor}}`: "una clave de Stripe", no "una clave sk_live".
 *
 * Caso aparte: los JWT. La llave pública de Supabase (`anon`) también es un JWT
 * y es **pública a propósito** — denunciarla sería un falso positivo de manual.
 * Por eso el JWT no se juzga por su forma sino por lo que dice adentro, que se
 * lee sin validar firma en `leerClaimsJwt`.
 */

export interface PatronSecreto {
  /** Nombre del proveedor tal como se le muestra al usuario. */
  nombre: string
  patron: RegExp
  /** true si hay que mirar el contenido antes de decidir (JWT). */
  requiereInspeccion?: boolean
}

export const PATRONES_SECRETO: PatronSecreto[] = [
  { nombre: 'Stripe', patron: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g },
  { nombre: 'Stripe (modo prueba)', patron: /\bsk_test_[A-Za-z0-9]{20,}\b/g },
  { nombre: 'Stripe', patron: /\bwhsec_[A-Za-z0-9]{24,}\b/g },
  { nombre: 'Supabase', patron: /\bsbp_[a-f0-9]{40}\b/g },
  { nombre: 'Supabase', patron: /\bsb_secret_[A-Za-z0-9_-]{20,}\b/g },
  { nombre: 'AWS', patron: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { nombre: 'OpenAI', patron: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g },
  { nombre: 'OpenAI', patron: /\bsk-[A-Za-z0-9]{40,}\b/g },
  { nombre: 'Anthropic', patron: /\bsk-ant-(?:api\d{2}-)?[A-Za-z0-9_-]{40,}\b/g },
  { nombre: 'Google', patron: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { nombre: 'GitHub', patron: /\bgh[pousr]_[A-Za-z0-9]{36}\b/g },
  { nombre: 'GitHub', patron: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g },
  { nombre: 'Slack', patron: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { nombre: 'SendGrid', patron: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
  { nombre: 'Twilio', patron: /\bSK[a-f0-9]{32}\b/g },
  { nombre: 'Resend', patron: /\bre_[A-Za-z0-9]{24,}\b/g },
  { nombre: 'npm', patron: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { nombre: 'GitLab', patron: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { nombre: 'DigitalOcean', patron: /\bdop_v1_[a-f0-9]{64}\b/g },
  { nombre: 'Shopify', patron: /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/g },
  { nombre: 'Mapbox', patron: /\bsk\.eyJ[A-Za-z0-9_-]{20,}\b/g },
  {
    nombre: 'tu proveedor de base de datos',
    // Cadena de conexión con contraseña adentro.
    patron: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:'"@/]+:[^\s'"@/]{4,}@[^\s'"]+/g,
  },
  {
    nombre: 'una clave privada',
    patron: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  {
    nombre: 'Supabase',
    patron: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    requiereInspeccion: true,
  },
]

/**
 * Nombres de variable que anuncian un secreto. Se usan para el caso en que el
 * valor no coincide con ningún patrón conocido y hay que decidir por entropía.
 */
export const NOMBRES_SENSIBLES =
  /(secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|password|passwd|pwd|credential|client[_-]?secret|auth[_-]?token|service[_-]?role|webhook[_-]?secret|encryption[_-]?key|signing[_-]?key)/i

/** Variables públicas por diseño: denunciarlas sería un falso positivo. */
export const PUBLICAS_POR_DISENO = [
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
  'NEXT_PUBLIC_STRIPE_PUBLIC_KEY',
  'NEXT_PUBLIC_POSTHOG_KEY',
  'NEXT_PUBLIC_SENTRY_DSN',
  'NEXT_PUBLIC_GA_ID',
  'NEXT_PUBLIC_GTM_ID',
  'NEXT_PUBLIC_MAPBOX_TOKEN',
  'NEXT_PUBLIC_ALGOLIA_SEARCH_KEY',
  'NEXT_PUBLIC_FIREBASE_API_KEY',
  'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
  'NEXT_PUBLIC_VAPID_PUBLIC_KEY',
]

export function esPublicaPorDiseno(nombreVariable: string): boolean {
  const n = nombreVariable.toUpperCase()
  if (PUBLICAS_POR_DISENO.includes(n)) return true
  // Cualquier variable que se llame a sí misma pública o publicable.
  return /(PUBLISHABLE|_PUBLIC_KEY|PUBLIC_KEY$|ANON_KEY$|_DSN$|_URL$|_ID$)/.test(n)
}

/** Archivos que existen para mostrar la forma de una clave, no la clave. */
export function esArchivoDeEjemplo(ruta: string): boolean {
  return /(\.example|\.sample|\.template|\.dist)(\.|$)|\.env\.example|\.env\.sample|\.env\.template/i.test(
    ruta,
  )
}

export interface CoincidenciaSecreto {
  proveedor: string
  valor: string
  index: number
}

/**
 * Busca claves conocidas en un texto. Los JWT se filtran por su contenido:
 * el `anon` de Supabase no se reporta nunca.
 */
export function buscarSecretos(
  texto: string,
  inspeccionarJwt: (token: string) => 'secreto' | 'publico' | 'desconocido',
): CoincidenciaSecreto[] {
  const encontrados: CoincidenciaSecreto[] = []
  const vistos = new Set<number>()

  for (const { nombre, patron, requiereInspeccion } of PATRONES_SECRETO) {
    const re = new RegExp(patron.source, patron.flags.includes('g') ? patron.flags : `${patron.flags}g`)
    for (const match of texto.matchAll(re)) {
      const valor = match[0]
      const index = match.index ?? 0
      if (vistos.has(index)) continue

      if (requiereInspeccion) {
        const veredicto = inspeccionarJwt(valor)
        if (veredicto === 'publico') continue
        vistos.add(index)
        encontrados.push({
          proveedor: veredicto === 'secreto' ? nombre : 'un servicio de tu app',
          valor,
          index,
        })
        continue
      }

      vistos.add(index)
      encontrados.push({ proveedor: nombre, valor, index })
    }
  }

  return encontrados.sort((a, b) => a.index - b.index)
}

/** Lee asignaciones `CLAVE=valor` de un archivo de entorno. */
export function leerAsignacionesEnv(
  texto: string,
): Array<{ clave: string; valor: string; linea: number }> {
  const salida: Array<{ clave: string; valor: string; linea: number }> = []
  const lineas = texto.split('\n')

  for (let i = 0; i < lineas.length; i++) {
    const cruda = lineas[i]!.trim()
    if (cruda === '' || cruda.startsWith('#')) continue

    const sinExport = cruda.startsWith('export ') ? cruda.slice(7).trim() : cruda
    const igual = sinExport.indexOf('=')
    if (igual <= 0) continue

    const clave = sinExport.slice(0, igual).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(clave)) continue

    let valor = sinExport.slice(igual + 1).trim()
    // Comentario al final de línea, solo si el valor no está entre comillas.
    if (!/^['"]/.test(valor)) valor = valor.split(/\s+#/)[0]!.trim()
    valor = valor.replace(/^['"]|['"]$/g, '')

    salida.push({ clave, valor, linea: i + 1 })
  }

  return salida
}

/** Valores que están para mostrar la forma, no para usarse. */
export function esValorDeRelleno(valor: string): boolean {
  const v = valor.trim()
  if (v.length === 0) return true
  return /^(x{3,}|y{3,}|<.*>|\{\{.*\}\}|tu[_-]|your[_-]|change[_-]?me|replace|todo|placeholder|ejemplo|example|sample|dummy|fake|test|\.\.\.|\*{3,}|•+)/i.test(
    v,
  )
}
