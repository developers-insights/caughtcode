/**
 * ¿Existen la política de privacidad y los términos?
 *
 * Binario y barato: se miran los enlaces del pie de página y, si no están, se prueban
 * las direcciones habituales. Es requisito de las tiendas de aplicaciones y de casi
 * cualquier pasarela de pago, así que la consecuencia es concreta: te rechazan la app.
 *
 * Lo usan: `src/server/agent/tasks/index.ts`.
 */

import 'server-only'

import { normalize, parseAriaSnapshot, type AriaTree } from '../aria'
import { conclusions } from './conclusions'
import { PLACES, openAndRead, type Place, type TaskContext, type TaskOutcomeDraft } from './shared'

const PRIVACY_WORDS = ['privacidad', 'privacy', 'proteccion de datos', 'data protection']
const TERMS_WORDS = ['terminos', 'terms', 'condiciones', 'legales', 'aviso legal']

export async function runPrivacyTerms(context: TaskContext): Promise<TaskOutcomeDraft> {
  const { browser, deployedUrl } = context
  const searched: string[] = []

  const home = await openAndRead(browser, deployedUrl, 'Abrí la portada y miré el pie de página.')
  if (!home) {
    return { outcome: 'blocked', conclusionPlain: conclusions.appNoResponde(deployedUrl) }
  }
  searched.push('el pie de la portada')

  let privacy = hasLinkTo(home, PRIVACY_WORDS)
  let terms = hasLinkTo(home, TERMS_WORDS)

  if (!privacy) {
    const found = await probe(context, PLACES.privacy, PRIVACY_WORDS)
    privacy = found
    if (!searched.includes('las direcciones habituales')) searched.push('las direcciones habituales')
  }
  if (!terms) {
    const found = await probe(context, PLACES.terms, TERMS_WORDS)
    terms = found
    if (!searched.includes('las direcciones habituales')) searched.push('las direcciones habituales')
  }

  await browser.record({
    action: privacy && terms ? 'found' : 'not_found',
    note: `Privacidad: ${privacy ? 'existe' : 'no existe'}. Términos: ${terms ? 'existen' : 'no existen'}.`,
  })

  if (privacy && terms) {
    return { outcome: 'completed', conclusionPlain: conclusions.legalesCompletos() }
  }
  if (privacy && !terms) {
    return { outcome: 'not_found', conclusionPlain: conclusions.legalesFaltaUno('términos', 'privacidad') }
  }
  if (!privacy && terms) {
    return { outcome: 'not_found', conclusionPlain: conclusions.legalesFaltaUno('privacidad', 'términos') }
  }
  return { outcome: 'not_found', conclusionPlain: conclusions.legalesFaltanAmbas(searched) }
}

/** ¿La pantalla tiene un enlace que lleva a esa página legal? */
function hasLinkTo(tree: AriaTree, words: string[]): boolean {
  return tree.nodes.some((node) => {
    if (node.role !== 'link') return false
    const haystack = normalize(`${node.name} ${node.url ?? ''}`)
    return words.some((word) => haystack.includes(normalize(word)))
  })
}

/** Abre las direcciones habituales y confirma que la página existe de verdad. */
async function probe(context: TaskContext, places: Place[], words: string[]): Promise<boolean> {
  for (const place of places) {
    const url = new URL(place.path, context.deployedUrl).toString()
    let status = 0
    try {
      const response = await context.browser.page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 10_000,
      })
      status = response?.status() ?? 0
    } catch {
      continue
    }
    if (status >= 400) continue

    const tree = parseAriaSnapshot(await context.browser.page.ariaSnapshot({ mode: 'ai' }))
    const haystack = normalize(tree.nodes.map((node) => node.name).join(' '))
    // Una página vacía o un "no encontrado" con estado 200 no cuenta como que existe.
    if (haystack.length < 40) continue
    if (words.some((word) => haystack.includes(normalize(word)))) {
      await context.browser.record({
        action: 'found',
        target: place.path,
        note: `Encontré la página de ${place.label} en ${place.path}.`,
      })
      return true
    }
  }
  return false
}
