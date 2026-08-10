/**
 * Sonda HTTP contra la app **desplegada del usuario**.
 *
 * Es una petición sin credenciales, igual a la que haría cualquier visitante:
 * no inicia sesión, no manda cookies, no escribe. Lo único que prueba es qué
 * responde el servidor a alguien de la calle — que es justamente el hallazgo.
 */

export interface RespuestaHttp {
  url: string
  status: number
  headers: Record<string, string>
  body: string
  /** true si el cuerpo se cortó por límite de tamaño. */
  truncado: boolean
}

export type HttpProbe = (
  url: string,
  init?: { method?: 'GET' | 'HEAD'; maxBytes?: number; timeoutMs?: number },
) => Promise<RespuestaHttp | null>

const MAX_BYTES = 512 * 1024
const TIMEOUT_MS = 12_000

/** Solo http(s) y nunca a la red interna: la sonda apunta a internet, no a nuestro host. */
export function urlPublicaValida(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false

  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return false
  if (host === '0.0.0.0' || host === '::1' || host === '[::1]') return false
  if (/^127\./.test(host)) return false
  if (/^10\./.test(host)) return false
  if (/^192\.168\./.test(host)) return false
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false
  if (/^169\.254\./.test(host)) return false
  return true
}

export const sondaFetch: HttpProbe = async (url, init = {}) => {
  if (!urlPublicaValida(url)) return null

  const control = new AbortController()
  const temporizador = setTimeout(() => control.abort(), init.timeoutMs ?? TIMEOUT_MS)

  try {
    const respuesta = await fetch(url, {
      method: init.method ?? 'GET',
      redirect: 'follow',
      signal: control.signal,
      headers: { 'user-agent': 'caughtcode-auditoria (+https://caughtcode.app)' },
    })

    const headers: Record<string, string> = {}
    respuesta.headers.forEach((valor, clave) => {
      headers[clave.toLowerCase()] = valor
    })

    const max = init.maxBytes ?? MAX_BYTES
    let body = ''
    let truncado = false
    if (init.method !== 'HEAD') {
      const crudo = await respuesta.text()
      truncado = crudo.length > max
      body = truncado ? crudo.slice(0, max) : crudo
    }

    return { url: respuesta.url || url, status: respuesta.status, headers, body, truncado }
  } catch {
    // Sitio caído, DNS que no resuelve, timeout: no es evidencia de nada.
    return null
  } finally {
    clearTimeout(temporizador)
  }
}

/** Une una ruta con la base desplegada, sin duplicar barras. */
export function unirUrl(base: string, ruta: string): string {
  try {
    return new URL(ruta, base.endsWith('/') ? base : `${base}/`).toString()
  } catch {
    return ruta
  }
}
