/**
 * Rastreadores que se disparan antes de que el visitante acepte.
 *
 * Es la infracción de consentimiento más multada de Europa y, a diferencia de casi
 * todo lo demás del tema, se detecta de forma objetiva: se abre la portada, no se
 * toca nada, y se mira qué pedidos de red salieron. Si ya salió un rastreador antes
 * de que hubiera un click, el cartel llega tarde. No hay opinión posible.
 *
 * Encuadre obligatorio (DECISIONS.md D7): se reporta como algo que un revisor o un
 * regulador podría marcar. Nunca se dictamina sobre legalidad.
 *
 * Lo usan: `src/server/agent/tasks/index.ts`.
 */

import 'server-only'

import { parseAriaSnapshot } from '../aria'
import { conclusions } from './conclusions'
import { PHRASES, findOnScreen, identifyTracker, type TaskContext, type TaskOutcomeDraft } from './shared'

/** Cuánto se espera sin tocar nada. Suficiente para que corran los scripts diferidos. */
const OBSERVATION_MS = 2_500

export async function runCookieBanner(context: TaskContext): Promise<TaskOutcomeDraft> {
  const { browser, deployedUrl } = context

  try {
    await browser.page.goto(deployedUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 })
  } catch {
    return { outcome: 'blocked', conclusionPlain: conclusions.appNoResponde(deployedUrl) }
  }

  await browser.record({
    action: 'observe',
    note: 'Abrí tu página y me quedé quieto, sin tocar el cartel de cookies.',
  })

  // Esperar sin interactuar es la parte importante: cualquier click invalidaría la prueba.
  await browser.page.waitForTimeout(OBSERVATION_MS)

  const trackers = new Map<string, number>()
  for (const request of browser.requests) {
    const name = identifyTracker(request)
    if (!name) continue
    trackers.set(name, (trackers.get(name) ?? 0) + 1)
  }

  const tree = parseAriaSnapshot(await browser.page.ariaSnapshot({ mode: 'ai' }))
  const bannerNodes = findOnScreen(tree, [...PHRASES.cookieBanner])
  const hasBanner = bannerNodes.length > 0

  const names = [...trackers.keys()]

  if (names.length > 0) {
    await browser.record({
      action: 'found',
      target: names.join(', '),
      note: hasBanner
        ? `Antes de que tocara el cartel ya se habían cargado: ${names.join(', ')}.`
        : `Se cargaron rastreadores y no hay cartel de cookies: ${names.join(', ')}.`,
    })
    return {
      outcome: 'completed',
      conclusionPlain: hasBanner
        ? conclusions.cookiesAntesDeAceptar(names.length, names)
        : conclusions.cookiesSinCartel(names.length, names),
    }
  }

  await browser.record({
    action: 'observe',
    note: hasBanner
      ? 'Esperé sin tocar el cartel y no se cargó ningún rastreador.'
      : 'No hay rastreadores ni cartel de cookies.',
  })

  return {
    outcome: 'completed',
    conclusionPlain: hasBanner ? conclusions.cookiesOk() : conclusions.cookiesSinRastreadores(),
  }
}
