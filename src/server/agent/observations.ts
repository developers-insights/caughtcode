/**
 * Lo que el agente observó y NO entra en `agent_sessions`.
 *
 * La tabla guarda una fila por tarea: qué intentó, cómo salió y su conclusión.
 * Pero los chequeos de cookies, rastreadores y pantalla en el celular no miran
 * eso: miran los pedidos de red, las cookies que quedaron y la medición a 375 px.
 * Todo eso vive en `AgentEvidence` y viaja en el payload del trabajo siguiente.
 *
 * Este archivo es la traducción entre las dos cosas, y es a propósito **puro**:
 * entra lo que registró el navegador, sale la forma que consumen los chequeos.
 * Sin Playwright, sin base, sin red — así se puede probar sin abrir nada.
 *
 * ## La regla que manda acá: `beforeConsent` no se adivina
 *
 * `sto.trackers_before_consent` es el chequeo con más consecuencias del pilar y
 * descansa entero en este campo. El contrato dice "lo determina el agente", así
 * que acá se decide con el criterio más conservador posible: un pedido es previo
 * al consentimiento **solo si salió antes de que el agente tocara nada**. En
 * cuanto hubo un click, un tecleo o una tecla, todo lo que sigue deja de contar,
 * porque ese click pudo haber sido "Aceptar".
 *
 * La tarea `cookie_banner` existe justamente para esto: abre la portada, espera
 * y no toca nada. Ahí todo lo observado es previo al consentimiento sin discusión.
 *
 * ## Lo que este archivo NO llena, y por qué
 *
 * `AgentEvidence.a11y` queda vacío. Medir accesibilidad de verdad necesita un
 * motor de reglas (axe) que hoy no está entre las dependencias del proyecto, y
 * un problema de accesibilidad inventado por un modelo es exactamente el tipo de
 * hallazgo blando que tiene prohibido el producto. Mejor vacío que inventado: el
 * chequeo que lo consume se saltea solo y queda dicho que no se revisó.
 */

import 'server-only'

import type { AgentStep, AgentTaskId } from '@/lib/types/domain'
import type {
  AgentEvidence,
  CookieObservada,
  DesbordeObservado,
  PaginaObservada,
  PedidoObservado,
} from '@/server/checks/agent-input'
import { MOBILE_VIEWPORT, type HorizontalOverflowResult, type RecordedPage, type RecordedRequest } from './browser'

/** Todo lo que el agente observó menos las sesiones (esas van a su tabla). */
export type AgentObservations = Omit<AgentEvidence, 'sessions'>

/**
 * Identificador de la pasada a 375 px.
 *
 * No es una tarea: es una visita aparte, sin modelo y sin grabación. Se le pone
 * un nombre propio en vez de colgarla de una sesión real porque decir que hay un
 * video donde no lo hay es la clase de afirmación sin respaldo que el producto no
 * se puede permitir. El frente de video no encuentra grabación para este id y
 * usa la captura, que sí existe.
 */
export const SESION_TELEFONO = 'telefono'

/**
 * Topes de tamaño. Todo esto termina en `jobs.payload`, que es una columna jsonb:
 * entra mucho, pero no es un lugar para volcar cien pedidos iguales a la misma
 * fuente. Se recorta acá, con criterio, y no en la base a los golpes.
 */
export const LIMITES = {
  pedidosPorSesion: 120,
  pedidosTotales: 400,
  cookiesTotales: 80,
  paginasTotales: 12,
} as const

/** Acciones que cuentan como "el agente tocó algo". */
const INTERACCIONES = new Set(['click', 'fill', 'press', 'type', 'select', 'check'])

/* ── Lo que entra ─────────────────────────────────────────────────────── */

/** Cookie tal como la devuelve el navegador. El valor no se copia nunca. */
export interface CookieCruda {
  name: string
  domain: string
}

export interface SesionObservada {
  taskId: AgentTaskId
  requests: RecordedRequest[]
  pages: RecordedPage[]
  steps: AgentStep[]
  cookies: CookieCruda[]
  /** Reloj de la sesión cuando se sacó la foto de cookies. */
  cookiesAtMs: number
}

/* ── El recolector ────────────────────────────────────────────────────── */

/**
 * Junta lo observado tarea por tarea y arma la bolsa final.
 *
 * Es un objeto con estado a propósito: `runAgentSession` cierra el navegador de
 * cada tarea apenas termina, así que la única ventana para leer las cookies es
 * antes de ese cierre. El recolector es el lugar donde se deposita eso mientras
 * la corrida sigue.
 */
export class ObservationCollector {
  private readonly sesiones: SesionObservada[] = []
  private readonly desbordes: DesbordeObservado[] = []

  constructor(private readonly allowedOrigins: string[] = []) {}

  agregarSesion(sesion: SesionObservada): void {
    this.sesiones.push(sesion)
  }

  /** Guarda la medición de la pasada a 375 px. Solo si de verdad hay desborde. */
  agregarDesborde(url: string, medicion: HorizontalOverflowResult): void {
    if (!medicion.overflow) return
    this.desbordes.push(desbordeDe(url, medicion))
  }

  get cantidadDeSesiones(): number {
    return this.sesiones.length
  }

  build(): AgentObservations {
    const network: PedidoObservado[] = []
    const cookies: CookieObservada[] = []
    const pages: PaginaObservada[] = []

    for (const sesion of this.sesiones) {
      network.push(...pedidosDe(sesion, this.allowedOrigins))
      cookies.push(...cookiesDe(sesion))
      pages.push(...paginasDe(sesion))
    }

    const observaciones: AgentObservations = {}
    if (pages.length > 0) observaciones.pages = pages.slice(0, LIMITES.paginasTotales)
    if (network.length > 0) observaciones.network = priorizarPedidos(network)
    if (cookies.length > 0) observaciones.cookies = cookies.slice(0, LIMITES.cookiesTotales)
    if (this.desbordes.length > 0) observaciones.overflow = this.desbordes
    return observaciones
  }
}

/* ── Traducciones puras ───────────────────────────────────────────────── */

/**
 * Momento del primer toque del agente. Todo lo anterior es previo al
 * consentimiento; todo lo posterior queda fuera de esa afirmación.
 */
export function primerToqueMs(steps: AgentStep[]): number {
  let primero = Number.POSITIVE_INFINITY
  for (const step of steps) {
    if (!INTERACCIONES.has(step.action)) continue
    if (step.atMs < primero) primero = step.atMs
  }
  return primero
}

export function pedidosDe(sesion: SesionObservada, allowedOrigins: string[]): PedidoObservado[] {
  const toqueMs = primerToqueMs(sesion.steps)
  const hosts = hostsPropios(allowedOrigins)
  const navegaciones = sesion.requests
    .filter((pedido) => pedido.isNavigation)
    .sort((a, b) => a.atMs - b.atMs)

  const salida: PedidoObservado[] = []
  const vistos = new Set<string>()

  for (const pedido of sesion.requests) {
    // Un pedido bloqueado no llegó a salir: reportarlo sería contar algo que no pasó.
    if (pedido.blocked) continue
    if (pedido.hostname.length === 0) continue

    const host = normalizarHost(pedido.hostname)
    // Una sola entrada por servicio, método y pantalla: cien pings al mismo
    // rastreador prueban lo mismo que uno y ocupan cien veces más.
    const clave = `${host}|${pedido.method}|${rutaDe(pedido.url)}`
    if (vistos.has(clave)) continue
    vistos.add(clave)

    salida.push({
      sessionId: sesion.taskId,
      url: pedido.url,
      host,
      method: pedido.method,
      atMs: pedido.atMs,
      beforeConsent: pedido.atMs <= toqueMs,
      fromPath: pantallaEn(navegaciones, pedido.atMs),
      thirdParty: !hosts.has(host),
    })

    if (salida.length >= LIMITES.pedidosPorSesion) break
  }

  return salida
}

export function cookiesDe(sesion: SesionObservada): CookieObservada[] {
  const sinTocar = primerToqueMs(sesion.steps) === Number.POSITIVE_INFINITY
  const navegaciones = sesion.requests
    .filter((pedido) => pedido.isNavigation)
    .sort((a, b) => a.atMs - b.atMs)
  const fromPath = pantallaEn(navegaciones, sesion.cookiesAtMs)

  return sesion.cookies.map((cookie) => ({
    sessionId: sesion.taskId,
    name: cookie.name,
    domain: normalizarHost(cookie.domain.replace(/^\./, '')),
    atMs: sesion.cookiesAtMs,
    // Solo se afirma "antes de aceptar" si en toda la sesión no se tocó nada.
    beforeConsent: sinTocar,
    fromPath,
  }))
}

export function paginasDe(sesion: SesionObservada): PaginaObservada[] {
  return sesion.pages.map((pagina) => {
    const paso = sesion.steps.find(
      (step) => step.screenshotPath && step.atMs >= pagina.atMs && rutaDe(step.url) === rutaDe(pagina.url),
    )
    const observada: PaginaObservada = {
      sessionId: sesion.taskId,
      url: pagina.url,
      path: rutaDe(pagina.url),
      status: pagina.status,
      atMs: pagina.atMs,
    }
    if (pagina.html) observada.html = pagina.html
    if (paso?.screenshotPath) observada.screenshotPath = paso.screenshotPath
    return observada
  })
}

export function desbordeDe(url: string, medicion: HorizontalOverflowResult): DesbordeObservado {
  const observado: DesbordeObservado = {
    sessionId: SESION_TELEFONO,
    path: rutaDe(url),
    url,
    viewportWidth: MOBILE_VIEWPORT.width,
    scrollWidth: medicion.scrollWidth,
    clientWidth: medicion.clientWidth,
    atMs: 0,
  }
  if (medicion.screenshotPath) observado.screenshotPath = medicion.screenshotPath
  if (medicion.offenders[0]) observado.culpable = medicion.offenders[0]
  return observado
}

/* ── Ayudas ───────────────────────────────────────────────────────────── */

/**
 * Deja primero lo que prueba algo —lo previo al consentimiento, y después lo de
 * terceros— para que el recorte por tamaño nunca se lleve la evidencia buena.
 */
function priorizarPedidos(pedidos: PedidoObservado[]): PedidoObservado[] {
  const peso = (pedido: PedidoObservado): number => {
    if (pedido.beforeConsent && pedido.thirdParty) return 0
    if (pedido.beforeConsent) return 1
    if (pedido.thirdParty) return 2
    return 3
  }
  return [...pedidos]
    .sort((a, b) => peso(a) - peso(b) || a.atMs - b.atMs)
    .slice(0, LIMITES.pedidosTotales)
}

/** Hosts que son la app del usuario. Todo lo demás es un tercero. */
function hostsPropios(allowedOrigins: string[]): Set<string> {
  const hosts = new Set<string>()
  for (const origin of allowedOrigins) {
    try {
      hosts.add(normalizarHost(new URL(origin).hostname))
    } catch {
      // Origen inválido: no aporta ningún host. El pedido queda como de tercero,
      // que es el lado seguro (se revisa de más, no de menos).
    }
  }
  return hosts
}

export function normalizarHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '')
}

export function rutaDe(url: string): string {
  try {
    return new URL(url).pathname || '/'
  } catch {
    return url.startsWith('/') ? url : '/'
  }
}

/** Qué pantalla estaba abierta en ese momento, según la última navegación. */
function pantallaEn(navegaciones: RecordedRequest[], atMs: number): string {
  let ruta = '/'
  for (const navegacion of navegaciones) {
    if (navegacion.atMs > atMs) break
    ruta = rutaDe(navegacion.url)
  }
  return ruta
}
