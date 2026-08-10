/**
 * El hallazgo más fuerte que produce el producto: ver datos de otra cuenta.
 *
 * Cómo funciona: se entra con la primera cuenta de prueba, se toma una dirección que
 * lleva un número o un identificador (una factura, un pedido, un proyecto), se le
 * cambia ese número por el de la otra cuenta, y se mira si la app lo muestra igual.
 *
 * Si carga, no hay nada que interpretar: está en video, con la dirección visible.
 * Ese es exactamente el fallo que dejó expuestos a más de 170 proyectos de Lovable
 * (DECISIONS.md D1), y el que un usuario no técnico jamás detectaría por su cuenta.
 *
 * Honestidad sobre lo que se afirma: cuando el usuario nos dio dos cuentas de prueba
 * y sabemos qué recurso es de cuál, se dice que el contenido es de la otra cuenta.
 * Cuando solo cambiamos un número a mano, se dice exactamente eso y nada más.
 *
 * Lo usan: `src/server/agent/tasks/index.ts`.
 */

import 'server-only'

import { normalize, parseAriaSnapshot, type AriaTree } from '../aria'
import { redactUrl } from '../redact'
import { conclusions } from './conclusions'
import { loginWith, PLACES, type TaskContext, type TaskOutcomeDraft } from './shared'

/** Direcciones con un número o un identificador al final: los candidatos a cambiar. */
const NUMERIC_ID = /\/([a-z0-9-]+)\/(\d+)(?:$|[/?#])/i
const UUID_ID = /\/([a-z0-9-]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:$|[/?#])/i

const BLOCKED_PHRASES = [
  'no autorizado',
  'sin permiso',
  'no tenes permiso',
  'no tienes permiso',
  'acceso denegado',
  'no encontrado',
  'no existe',
  'iniciar sesion',
  'ingresar',
  'unauthorized',
  'forbidden',
  'not found',
  'access denied',
  'sign in',
  'log in',
]

export async function runCrossTenantRead(context: TaskContext): Promise<TaskOutcomeDraft> {
  const [accountA, accountB] = context.testAccounts

  const login = await loginWith(context, accountA)
  if (!login.ok) {
    return { outcome: 'blocked', conclusionPlain: conclusions.appPideEntrar() }
  }

  const attempt = await pickAttempt(context, accountB)
  if (!attempt) {
    await context.browser.record({
      action: 'not_found',
      note: 'No encontré ninguna dirección con número que pudiera probar.',
    })
    return { outcome: 'blocked', conclusionPlain: conclusions.crossTenantSinDatos() }
  }

  await context.browser.record({
    action: 'plan',
    target: attempt.targetUrl,
    note: `Voy a abrir ${attempt.targetUrl}, que no es mía, con la sesión de la primera cuenta.`,
  })

  let status = 0
  try {
    const response = await context.browser.page.goto(attempt.targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 12_000,
    })
    status = response?.status() ?? 0
    await context.browser.page.waitForTimeout(300)
  } catch {
    await context.browser.record({
      action: 'error',
      note: 'La app no respondió al abrir esa dirección.',
    })
    return { outcome: 'error', conclusionPlain: conclusions.errorInesperado() }
  }

  const tree = parseAriaSnapshot(await context.browser.page.ariaSnapshot({ mode: 'ai' }))
  const shownUrl = redactUrl(context.browser.page.url())
  const blocked = await isBlocked(context, status, tree)

  if (blocked) {
    await context.browser.record({
      action: 'protected',
      target: shownUrl,
      note: 'Tu app me frenó: no me dejó ver ese contenido.',
    })
    return {
      outcome: 'completed',
      conclusionPlain: conclusions.crossTenantProtegido(attempt.displayTarget),
    }
  }

  const what = describeContent(tree)
  await context.browser.record({
    action: 'exposed',
    target: shownUrl,
    note: `Se abrió igual y me mostró ${what}.`,
  })

  return {
    outcome: 'completed',
    conclusionPlain: attempt.ownedByOtherAccount
      ? conclusions.crossTenantExpuesto(attempt.displayTarget, what)
      : conclusions.crossTenantIdMutado(attempt.displaySource, attempt.displayTarget, what),
  }
}

/* ── Elegir qué intentar ─────────────────────────────────────────────── */

interface Attempt {
  targetUrl: string
  displayTarget: string
  displaySource: string
  /** `true` solo cuando el usuario nos dijo que ese recurso es de la otra cuenta. */
  ownedByOtherAccount: boolean
}

async function pickAttempt(
  context: TaskContext,
  accountB: { resourceUrls?: string[] } | undefined,
): Promise<Attempt | null> {
  // Caso fuerte: el usuario nos dio una dirección que sabemos que es de la otra cuenta.
  const declared = accountB?.resourceUrls?.[0]
  if (declared) {
    const absolute = new URL(declared, context.deployedUrl).toString()
    return {
      targetUrl: absolute,
      displayTarget: shortPath(absolute),
      displaySource: shortPath(absolute),
      ownedByOtherAccount: true,
    }
  }

  // Caso general: buscar en la app una dirección con número y cambiárselo.
  const source = await findAddressableUrl(context)
  if (!source) return null

  const mutated = mutateId(source)
  if (!mutated) return null

  return {
    targetUrl: mutated,
    displayTarget: shortPath(mutated),
    displaySource: shortPath(source),
    ownedByOtherAccount: false,
  }
}

/** Recorre las pantallas privadas buscando un enlace con número o identificador. */
async function findAddressableUrl(context: TaskContext): Promise<string | null> {
  const places = [PLACES.home, ...PLACES.account]

  for (const place of places) {
    const url = new URL(place.path, context.deployedUrl).toString()
    try {
      const response = await context.browser.page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 10_000,
      })
      if ((response?.status() ?? 0) >= 400) continue
    } catch {
      continue
    }

    const hrefs = await context.browser.page
      .locator('a[href]')
      .evaluateAll((anchors) => anchors.map((anchor) => (anchor as HTMLAnchorElement).href))
      .catch(() => [] as string[])

    const candidate = hrefs.find((href) => {
      if (!context.allowedOrigins.some((origin) => href.startsWith(origin))) return false
      return NUMERIC_ID.test(new URL(href).pathname) || UUID_ID.test(new URL(href).pathname)
    })

    if (candidate) {
      await context.browser.record({
        action: 'found',
        target: shortPath(candidate),
        note: `Encontré una dirección con número: ${shortPath(candidate)}.`,
      })
      return candidate
    }
  }
  return null
}

/** Cambia el número de la dirección. Prueba primero el siguiente, después el anterior. */
export function mutateId(rawUrl: string): string | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }

  const numeric = url.pathname.match(NUMERIC_ID)
  if (numeric) {
    const current = Number(numeric[2])
    const next = current === 1 ? 2 : current - 1
    url.pathname = url.pathname.replace(`/${numeric[2]}`, `/${next}`)
    return url.toString()
  }

  const uuid = url.pathname.match(UUID_ID)
  if (uuid) {
    // Se cambia el último dígito: sigue siendo un identificador válido con otro valor.
    const original = uuid[2]
    const last = original.slice(-1)
    const replacement = last === '0' ? '1' : '0'
    url.pathname = url.pathname.replace(original, original.slice(0, -1) + replacement)
    return url.toString()
  }

  return null
}

/* ── Leer el resultado ───────────────────────────────────────────────── */

async function isBlocked(context: TaskContext, status: number, tree: AriaTree): Promise<boolean> {
  if (status >= 400) return true
  if ((await context.browser.page.locator('input[type="password"]').count()) > 0) return true

  const haystack = normalize(tree.nodes.map((node) => node.name).join(' '))
  if (haystack.trim().length === 0) return true
  return BLOCKED_PHRASES.some((phrase) => haystack.includes(phrase))
}

/** Qué muestra la pantalla, en una frase que se entienda sin ver el código. */
export function describeContent(tree: AriaTree): string {
  const heading = tree.nodes.find((node) => node.role === 'heading' && node.name.trim().length > 0)
  const texts = tree.nodes
    .filter((node) => node.role === 'text' || node.role === 'paragraph')
    .map((node) => node.name.trim())
    .filter((text) => text.length > 3)

  if (heading && texts.length > 0) {
    return `una pantalla titulada "${heading.name}" con datos como "${texts[0].slice(0, 60)}"`
  }
  if (heading) return `una pantalla titulada "${heading.name}"`
  if (texts.length > 0) return `contenido con datos como "${texts[0].slice(0, 60)}"`
  return 'contenido de la aplicación'
}

function shortPath(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    return `${url.pathname}${url.search}` || '/'
  } catch {
    return rawUrl
  }
}
