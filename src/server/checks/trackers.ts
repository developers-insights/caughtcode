/**
 * Dominios de seguimiento conocidos.
 *
 * Un solo archivo, a propósito: el nombre de cada servicio aparece tal cual en
 * la pantalla del usuario y en la narración del video. Si esta lista dice
 * "google-analytics.com", el hallazgo va a decir "google-analytics.com", y el
 * usuario no tiene por qué saber que eso es Google Analytics. Por eso cada
 * entrada trae el nombre **legible por humanos**, que es el que se muestra.
 *
 * `categoria` sirve para explicar en una frase qué hace cada uno, sin obligar
 * al usuario a googlear.
 */

export type CategoriaTracker =
  | 'analitica'
  | 'publicidad'
  | 'grabacion_de_sesion'
  | 'chat_soporte'
  | 'errores'
  | 'testing'

/** Cómo se le explica cada categoría al usuario. Sin jerga. */
export const CATEGORIA_TEXTO: Record<CategoriaTracker, string> = {
  analitica: 'mide cómo se usa tu app',
  publicidad: 'sirve para publicidad y para seguir a la persona en otros sitios',
  grabacion_de_sesion: 'graba lo que la persona hace en pantalla',
  chat_soporte: 'muestra el chat de soporte y registra quién escribe',
  errores: 'registra los errores que ocurren',
  testing: 'prueba versiones distintas de la app con distinta gente',
}

export interface Tracker {
  /** Nombre como lo conoce una persona. Es el que se muestra. */
  nombre: string
  categoria: CategoriaTracker
  /** Hosts que delatan al servicio. Coincide por sufijo. */
  hosts: string[]
}

export const TRACKERS: Tracker[] = [
  { nombre: 'Google Analytics', categoria: 'analitica', hosts: ['google-analytics.com', 'analytics.google.com', 'ssl.google-analytics.com'] },
  { nombre: 'Google Tag Manager', categoria: 'analitica', hosts: ['googletagmanager.com'] },
  { nombre: 'Google Ads', categoria: 'publicidad', hosts: ['googleadservices.com', 'googlesyndication.com', 'doubleclick.net', 'adservice.google.com'] },
  { nombre: 'Meta Pixel (Facebook)', categoria: 'publicidad', hosts: ['connect.facebook.net', 'facebook.com/tr', 'facebook.net'] },
  { nombre: 'TikTok Pixel', categoria: 'publicidad', hosts: ['analytics.tiktok.com', 'tiktokcdn.com'] },
  { nombre: 'LinkedIn Insight', categoria: 'publicidad', hosts: ['snap.licdn.com', 'px.ads.linkedin.com'] },
  { nombre: 'X (Twitter) Ads', categoria: 'publicidad', hosts: ['static.ads-twitter.com', 'analytics.twitter.com', 't.co'] },
  { nombre: 'Pinterest Tag', categoria: 'publicidad', hosts: ['ct.pinterest.com', 's.pinimg.com'] },
  { nombre: 'Snapchat Pixel', categoria: 'publicidad', hosts: ['sc-static.net', 'tr.snapchat.com'] },
  { nombre: 'Reddit Pixel', categoria: 'publicidad', hosts: ['redditstatic.com/ads', 'alb.reddit.com'] },
  { nombre: 'Microsoft Advertising', categoria: 'publicidad', hosts: ['bat.bing.com', 'clarity.ms'] },
  { nombre: 'Criteo', categoria: 'publicidad', hosts: ['criteo.com', 'criteo.net'] },
  { nombre: 'Taboola', categoria: 'publicidad', hosts: ['taboola.com'] },
  { nombre: 'Outbrain', categoria: 'publicidad', hosts: ['outbrain.com'] },

  { nombre: 'Hotjar', categoria: 'grabacion_de_sesion', hosts: ['hotjar.com', 'hotjar.io'] },
  { nombre: 'FullStory', categoria: 'grabacion_de_sesion', hosts: ['fullstory.com', 'fs.js'] },
  { nombre: 'Microsoft Clarity', categoria: 'grabacion_de_sesion', hosts: ['clarity.ms'] },
  { nombre: 'LogRocket', categoria: 'grabacion_de_sesion', hosts: ['logrocket.com', 'lr-ingest.io', 'lr-in.com'] },
  { nombre: 'Smartlook', categoria: 'grabacion_de_sesion', hosts: ['smartlook.com'] },
  { nombre: 'Mouseflow', categoria: 'grabacion_de_sesion', hosts: ['mouseflow.com'] },
  { nombre: 'Contentsquare', categoria: 'grabacion_de_sesion', hosts: ['contentsquare.net', 'content-square.net'] },

  { nombre: 'Mixpanel', categoria: 'analitica', hosts: ['mixpanel.com', 'mxpnl.com'] },
  { nombre: 'Amplitude', categoria: 'analitica', hosts: ['amplitude.com', 'api.amplitude.com', 'api2.amplitude.com'] },
  { nombre: 'Segment', categoria: 'analitica', hosts: ['segment.com', 'segment.io', 'cdn.segment.com'] },
  { nombre: 'PostHog', categoria: 'analitica', hosts: ['posthog.com', 'i.posthog.com', 'app.posthog.com'] },
  { nombre: 'Heap', categoria: 'analitica', hosts: ['heap.io', 'heapanalytics.com'] },
  { nombre: 'Matomo', categoria: 'analitica', hosts: ['matomo.cloud', 'matomo.org'] },
  { nombre: 'Plausible', categoria: 'analitica', hosts: ['plausible.io'] },
  { nombre: 'Fathom', categoria: 'analitica', hosts: ['usefathom.com', 'cdn.usefathom.com'] },
  { nombre: 'Vercel Analytics', categoria: 'analitica', hosts: ['vitals.vercel-insights.com', 'va.vercel-scripts.com'] },
  { nombre: 'Cloudflare Web Analytics', categoria: 'analitica', hosts: ['static.cloudflareinsights.com'] },
  { nombre: 'Umami', categoria: 'analitica', hosts: ['umami.is'] },

  { nombre: 'Sentry', categoria: 'errores', hosts: ['sentry.io', 'ingest.sentry.io'] },
  { nombre: 'Bugsnag', categoria: 'errores', hosts: ['bugsnag.com'] },
  { nombre: 'Datadog', categoria: 'errores', hosts: ['datadoghq.com', 'datadoghq.eu', 'browser-intake-datadoghq.com'] },
  { nombre: 'New Relic', categoria: 'errores', hosts: ['newrelic.com', 'nr-data.net'] },
  { nombre: 'Rollbar', categoria: 'errores', hosts: ['rollbar.com'] },

  { nombre: 'Intercom', categoria: 'chat_soporte', hosts: ['intercom.io', 'intercomcdn.com'] },
  { nombre: 'Crisp', categoria: 'chat_soporte', hosts: ['crisp.chat'] },
  { nombre: 'Drift', categoria: 'chat_soporte', hosts: ['drift.com', 'driftt.com'] },
  { nombre: 'Zendesk', categoria: 'chat_soporte', hosts: ['zdassets.com', 'zendesk.com'] },
  { nombre: 'Tawk.to', categoria: 'chat_soporte', hosts: ['tawk.to'] },
  { nombre: 'HubSpot', categoria: 'chat_soporte', hosts: ['hs-scripts.com', 'hubspot.com', 'hs-analytics.net', 'hsforms.net'] },

  { nombre: 'Optimizely', categoria: 'testing', hosts: ['optimizely.com'] },
  { nombre: 'VWO', categoria: 'testing', hosts: ['visualwebsiteoptimizer.com'] },
  { nombre: 'Google Optimize', categoria: 'testing', hosts: ['optimize.google.com'] },
  { nombre: 'LaunchDarkly', categoria: 'testing', hosts: ['launchdarkly.com'] },
]

/** Normaliza un host: minúsculas, sin `www.`, sin puerto. */
export function normalizarHost(valor: string): string {
  let host = valor.trim().toLowerCase()
  if (host.includes('://')) {
    try {
      host = new URL(host).hostname
    } catch {
      /* se sigue con el texto crudo */
    }
  }
  host = host.split('/')[0] ?? host
  host = host.split(':')[0] ?? host
  return host.startsWith('www.') ? host.slice(4) : host
}

/** Devuelve el servicio de seguimiento al que pertenece un host, si es alguno. */
export function trackerDeHost(hostOUrl: string): Tracker | null {
  const host = normalizarHost(hostOUrl)
  const completo = hostOUrl.toLowerCase()
  for (const tracker of TRACKERS) {
    for (const candidato of tracker.hosts) {
      if (candidato.includes('/')) {
        if (completo.includes(candidato)) return tracker
        continue
      }
      if (host === candidato || host.endsWith(`.${candidato}`)) return tracker
    }
  }
  return null
}

/** Nombres legibles, sin repetidos y en orden estable. */
export function nombresDeTrackers(hosts: Iterable<string>): string[] {
  const nombres = new Set<string>()
  for (const host of hosts) {
    const tracker = trackerDeHost(host)
    if (tracker) nombres.add(tracker.nombre)
  }
  return [...nombres].sort((a, b) => a.localeCompare(b, 'es'))
}

/** "Google Analytics, Hotjar y Meta Pixel (Facebook)" — para meter en una frase. */
export function enumerar(nombres: string[]): string {
  if (nombres.length === 0) return ''
  if (nombres.length === 1) return nombres[0]!
  return `${nombres.slice(0, -1).join(', ')} y ${nombres[nombres.length - 1]}`
}

/** Scripts de terceros que se reconocen leyendo el código, sin desplegar nada. */
export function trackersEnTexto(texto: string): Tracker[] {
  const encontrados = new Map<string, Tracker>()
  for (const tracker of TRACKERS) {
    for (const host of tracker.hosts) {
      if (texto.toLowerCase().includes(host)) {
        encontrados.set(tracker.nombre, tracker)
        break
      }
    }
  }
  return [...encontrados.values()]
}
