/**
 * Piezas comunes a las tareas del agente.
 *
 * Acá vive lo que no conviene que decida el modelo: recorrer las direcciones
 * habituales de una app, reconocer un formulario de ingreso, y decidir si un pedido
 * de red es un rastreador. Todo eso es determinístico a propósito — es más barato,
 * no alucina, y funciona igual sin conexión al modelo.
 *
 * Lo usan: `src/server/agent/tasks/**`.
 */

import 'server-only'

import type { AgentOutcome, AgentTask } from '@/lib/types/domain'
import type { AgentBrowser, RecordedRequest } from '../browser'
import type { CostMeter } from '../cost'
import type { LlmComplete, LlmCompleteJson, TestAccount } from '../types'
import { findByPhrases, normalize, parseAriaSnapshot, type AriaNode, type AriaTree } from '../aria'

export interface TaskContext {
  task: AgentTask
  browser: AgentBrowser
  deployedUrl: string
  allowedOrigins: string[]
  allowDestructive: boolean
  /** Cuentas autorizadas por el usuario. Vacío si no confirmó su creación. */
  testAccounts: TestAccount[]
  complete: LlmComplete
  completeJson?: LlmCompleteJson
  cost: CostMeter
  signal?: AbortSignal
  /** Resultado de la pasada a 375 px, si ya se corrió. */
  mobileOverflow?: { overflow: boolean; offenders: string[] } | null
}

export interface TaskOutcomeDraft {
  outcome: AgentOutcome
  conclusionPlain: string
}

/* ── Direcciones habituales ──────────────────────────────────────────── */

/** Cada entrada es una dirección candidata con el nombre que usa una persona. */
export interface Place {
  path: string
  label: string
}

export const PLACES = {
  home: { path: '/', label: 'la portada' },
  login: [
    { path: '/login', label: 'la pantalla de ingreso' },
    { path: '/ingresar', label: 'la pantalla de ingreso' },
    { path: '/iniciar-sesion', label: 'la pantalla de ingreso' },
    { path: '/signin', label: 'la pantalla de ingreso' },
    { path: '/auth/login', label: 'la pantalla de ingreso' },
    { path: '/entrar', label: 'la pantalla de ingreso' },
  ] as Place[],
  signup: [
    { path: '/registro', label: 'la pantalla de registro' },
    { path: '/signup', label: 'la pantalla de registro' },
    { path: '/register', label: 'la pantalla de registro' },
    { path: '/crear-cuenta', label: 'la pantalla de registro' },
    { path: '/auth/signup', label: 'la pantalla de registro' },
  ] as Place[],
  account: [
    { path: '/cuenta', label: 'la pantalla de cuenta' },
    { path: '/ajustes', label: 'los ajustes' },
    { path: '/configuracion', label: 'la configuración' },
    { path: '/settings', label: 'los ajustes' },
    { path: '/perfil', label: 'el perfil' },
    { path: '/profile', label: 'el perfil' },
    { path: '/account', label: 'la pantalla de cuenta' },
    { path: '/mi-cuenta', label: 'la pantalla de cuenta' },
    { path: '/settings/account', label: 'los ajustes de la cuenta' },
    { path: '/ajustes/cuenta', label: 'los ajustes de la cuenta' },
    { path: '/privacidad-de-mi-cuenta', label: 'la privacidad de la cuenta' },
  ] as Place[],
  passwordReset: [
    { path: '/recuperar', label: 'la recuperación de contraseña' },
    { path: '/recuperar-contrasena', label: 'la recuperación de contraseña' },
    { path: '/olvide-mi-contrasena', label: 'la recuperación de contraseña' },
    { path: '/forgot-password', label: 'la recuperación de contraseña' },
    { path: '/reset-password', label: 'la recuperación de contraseña' },
    { path: '/auth/forgot-password', label: 'la recuperación de contraseña' },
  ] as Place[],
  privacy: [
    { path: '/privacidad', label: 'privacidad' },
    { path: '/politica-de-privacidad', label: 'privacidad' },
    { path: '/privacy', label: 'privacidad' },
    { path: '/privacy-policy', label: 'privacidad' },
    { path: '/legal/privacidad', label: 'privacidad' },
  ] as Place[],
  terms: [
    { path: '/terminos', label: 'términos' },
    { path: '/terminos-y-condiciones', label: 'términos' },
    { path: '/terms', label: 'términos' },
    { path: '/terms-of-service', label: 'términos' },
    { path: '/legal/terminos', label: 'términos' },
  ] as Place[],
} as const

/* ── Frases que buscamos en la pantalla ──────────────────────────────── */

export const PHRASES = {
  passwordReset: [
    'olvide mi contrasena',
    'olvidaste tu contrasena',
    'olvide la contrasena',
    'recuperar contrasena',
    'restablecer contrasena',
    'recuperar acceso',
    'forgot password',
    'reset password',
    'recuperar clave',
    'olvide mi clave',
  ],
  // Sin tildes: el texto de la pantalla se normaliza antes de comparar.
  deleteAccount: [
    'borrar cuenta',
    'borrar mi cuenta',
    'borrar la cuenta',
    'borra tu cuenta',
    'eliminar cuenta',
    'eliminar mi cuenta',
    'eliminar la cuenta',
    'elimina tu cuenta',
    'elimina mi cuenta',
    'suprimir cuenta',
    'cerrar cuenta',
    'cerrar mi cuenta',
    'cerra tu cuenta',
    'cierra tu cuenta',
    'desactivar cuenta',
    'desactiva tu cuenta',
    'dar de baja',
    'darme de baja',
    'da de baja tu cuenta',
    'delete account',
    'delete my account',
    'delete your account',
    'close account',
    'deactivate account',
  ],
  logout: [
    'cerrar sesion',
    'salir',
    'desconectar',
    'log out',
    'logout',
    'sign out',
  ],
  login: ['iniciar sesion', 'ingresar', 'entrar', 'acceder', 'log in', 'login', 'sign in'],
  signup: ['crear cuenta', 'registrarme', 'registrate', 'registrarse', 'sign up', 'registro'],
  editProfile: ['editar perfil', 'editar mi perfil', 'mis datos', 'edit profile', 'cambiar nombre'],
  cookieBanner: [
    'cookies',
    'aceptar todo',
    'aceptar todas',
    'acepto',
    'consentimiento',
    'accept all',
    'usamos cookies',
    'preferencias de privacidad',
  ],
  paywall: [
    'suscribite',
    'suscribirse',
    'elegir plan',
    'ver planes',
    'actualizar plan',
    'pagar para continuar',
    'upgrade',
    'subscribe',
    'choose a plan',
    'start free trial',
  ],
} as const

/* ── Recorrer direcciones ────────────────────────────────────────────── */

export interface SweepHit {
  url: string
  label: string
  node: AriaNode
}

export interface SweepResult {
  /** Nombres de los lugares donde efectivamente se buscó. Va en la conclusión. */
  visitedLabels: string[]
  hits: SweepHit[]
  /** Direcciones que devolvieron error o no existen. */
  missing: string[]
}

/** Abre una dirección y devuelve el árbol, o `null` si no se pudo abrir. */
export async function openAndRead(
  browser: AgentBrowser,
  url: string,
  note: string,
): Promise<AriaTree | null> {
  try {
    const response = await browser.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12_000 })
    await browser.page.waitForTimeout(200)
    const status = response?.status() ?? 0
    if (status >= 400) {
      await browser.record({ action: 'goto', target: url, note: `${note} — esa dirección no existe.` })
      return null
    }
    const tree = parseAriaSnapshot(await browser.page.ariaSnapshot({ mode: 'ai' }))
    await browser.record({ action: 'goto', target: url, note })
    return tree
  } catch {
    await browser.record({
      action: 'goto',
      target: url,
      note: `${note} — no pude abrirla.`,
      screenshot: false,
    })
    return null
  }
}

/**
 * Recorre las direcciones candidatas buscando frases.
 * Se corta apenas encuentra algo: no hace falta seguir revisando si ya está la respuesta.
 */
export async function sweep(
  browser: AgentBrowser,
  baseUrl: string,
  places: Place[],
  phrases: string[],
  options: { stopOnFirstHit?: boolean } = {},
): Promise<SweepResult> {
  const visitedLabels: string[] = []
  const hits: SweepHit[] = []
  const missing: string[] = []

  for (const place of places) {
    const url = new URL(place.path, baseUrl).toString()
    const tree = await openAndRead(browser, url, `Fui a ${place.label} a buscar.`)
    if (!tree) {
      missing.push(place.path)
      continue
    }
    if (!visitedLabels.includes(place.label)) visitedLabels.push(place.label)

    for (const node of findByPhrases(tree, phrases)) {
      hits.push({ url, label: place.label, node })
    }
    if (hits.length > 0 && options.stopOnFirstHit !== false) break
  }

  return { visitedLabels, hits, missing }
}

/** Busca frases en la pantalla que ya está abierta. */
export function findOnScreen(tree: AriaTree, phrases: string[]): AriaNode[] {
  return findByPhrases(tree, phrases)
}

/* ── Ingreso ─────────────────────────────────────────────────────────── */

export interface LoginResult {
  ok: boolean
  /** Dónde se encontró el formulario. */
  atUrl?: string
  /** Lugares donde se buscó, para poder decirlo en la conclusión. */
  searchedLabels: string[]
  reason?: 'sin_formulario' | 'rechazado' | 'sin_cuenta'
}

/**
 * Entra con una cuenta de prueba. Determinístico: busca un campo de correo y uno de
 * contraseña, los completa y envía. No usa el modelo porque un formulario de ingreso
 * es siempre el mismo formulario, y pagarle a un modelo por reconocerlo es tirar plata.
 */
export async function loginWith(
  context: TaskContext,
  account: TestAccount | undefined,
): Promise<LoginResult> {
  const searchedLabels: string[] = []
  if (!account) return { ok: false, searchedLabels, reason: 'sin_cuenta' }

  const candidates: Place[] = [PLACES.home, ...PLACES.login]

  for (const place of candidates) {
    const url = new URL(place.path, context.deployedUrl).toString()
    const tree = await openAndRead(context.browser, url, `Busqué el formulario para entrar en ${place.label}.`)
    if (!tree) continue
    if (!searchedLabels.includes(place.label)) searchedLabels.push(place.label)

    const password = context.browser.page.locator('input[type="password"]').first()
    if ((await password.count()) === 0) continue

    const email = context.browser.page
      .locator('input[type="email"], input[name*="mail" i], input[name*="usuario" i], input[name="user"]')
      .first()

    try {
      if ((await email.count()) > 0) await email.fill(account.email, { timeout: 5_000 })
      await password.fill(account.password, { timeout: 5_000 })
      await context.browser.record({
        action: 'fill',
        target: 'formulario de ingreso',
        note: `Completé el formulario con la cuenta de prueba ${account.email}.`,
      })

      const submit = context.browser.page
        .locator('button[type="submit"], input[type="submit"], form button')
        .first()
      if ((await submit.count()) > 0) {
        await submit.click({ timeout: 8_000 })
      } else {
        await password.press('Enter')
      }
      await context.browser.page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => {})
      await context.browser.page.waitForTimeout(400)
    } catch {
      await context.browser.record({
        action: 'error',
        note: 'El formulario de ingreso no me dejó completarlo.',
      })
      return { ok: false, atUrl: url, searchedLabels, reason: 'rechazado' }
    }

    const after = parseAriaSnapshot(await context.browser.page.ariaSnapshot({ mode: 'ai' }))
    const stillHasPassword = (await context.browser.page.locator('input[type="password"]').count()) > 0
    const hasLogout = findByPhrases(after, [...PHRASES.logout]).length > 0
    const ok = hasLogout || !stillHasPassword

    await context.browser.record({
      action: ok ? 'login_ok' : 'login_fallido',
      note: ok
        ? 'Entré con la cuenta de prueba.'
        : 'Envié el formulario y seguí viendo la pantalla de ingreso.',
    })

    return { ok, atUrl: url, searchedLabels, reason: ok ? undefined : 'rechazado' }
  }

  return { ok: false, searchedLabels, reason: 'sin_formulario' }
}

/* ── Rastreadores ────────────────────────────────────────────────────── */

/** Dominios de rastreo conocidos. La lista es corta a propósito: solo lo indiscutible. */
export const TRACKER_HOSTS: Array<{ host: string; name: string }> = [
  { host: 'google-analytics.com', name: 'Google Analytics' },
  { host: 'analytics.google.com', name: 'Google Analytics' },
  { host: 'googletagmanager.com', name: 'Google Tag Manager' },
  { host: 'doubleclick.net', name: 'Google Ads' },
  { host: 'googlesyndication.com', name: 'Google Ads' },
  { host: 'connect.facebook.net', name: 'Meta Pixel' },
  { host: 'facebook.com/tr', name: 'Meta Pixel' },
  { host: 'analytics.tiktok.com', name: 'TikTok Pixel' },
  { host: 'hotjar.com', name: 'Hotjar' },
  { host: 'clarity.ms', name: 'Microsoft Clarity' },
  { host: 'segment.com', name: 'Segment' },
  { host: 'segment.io', name: 'Segment' },
  { host: 'mixpanel.com', name: 'Mixpanel' },
  { host: 'amplitude.com', name: 'Amplitude' },
  { host: 'posthog.com', name: 'PostHog' },
  { host: 'intercom.io', name: 'Intercom' },
  { host: 'fullstory.com', name: 'FullStory' },
  { host: 'linkedin.com/px', name: 'LinkedIn Insight' },
  { host: 'snap.licdn.com', name: 'LinkedIn Insight' },
  { host: 'bat.bing.com', name: 'Microsoft Ads' },
]

export function identifyTracker(request: RecordedRequest): string | null {
  const haystack = `${request.hostname}${safePath(request.url)}`.toLowerCase()
  const match = TRACKER_HOSTS.find((tracker) => haystack.includes(tracker.host))
  return match ? match.name : null
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return ''
  }
}

/** ¿Esta pantalla parece un muro de pago? */
export function looksLikePaywall(tree: AriaTree): boolean {
  const haystack = normalize(tree.nodes.map((node) => node.name).join(' '))
  const hits = PHRASES.paywall.filter((phrase) => haystack.includes(normalize(phrase)))
  return hits.length >= 2
}
