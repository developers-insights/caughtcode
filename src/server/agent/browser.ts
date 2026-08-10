/**
 * El navegador del agente.
 *
 * Un contexto de Playwright limpio y descartable por tarea: sin cookies previas,
 * sin sesión heredada, sin caché compartida. Cada tarea graba su propio video, así
 * que el clip de un hallazgo no arrastra lo que pasó en otra prueba.
 *
 * Los tiempos son el punto delicado: `atMs` de cada paso es lo que después permite
 * recortar el segundo exacto del video. El cero se toma apenas existe la página y todo
 * se mide con reloj monótono contra ese cero. La correspondencia con el video no es
 * exacta al milisegundo: ver `CLOCK_TOLERANCE_MS`, que es el margen medido con el que
 * hay que recortar.
 *
 * Lo usan: `driver.ts`, `src/server/agent/tasks/**` e `index.ts`.
 */

import 'server-only'

import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { chromium, type Browser, type BrowserContext, type Page, type Request } from 'playwright'

import type { AgentStep, AgentTaskId } from '@/lib/types/domain'
import type { RecordingManifest } from './types'
import { maskLocators, installRedaction, redactUrl, redactText } from './redact'

export const DESKTOP_VIEWPORT = { width: 1280, height: 800 } as const

/**
 * Espera opcional antes de arrancar el reloj de los pasos.
 *
 * Va en 0 y está medido, no adivinado. Se probó con 600 ms creyendo que el screencast
 * tardaba en arrancar: los tiempos empeoraron (el desfase pasó de unos -100 ms a
 * +600 ms). Con 0, el cuadro que corresponde a cada paso cae dentro de la tolerancia
 * declarada en `CLOCK_TOLERANCE_MS`. El parámetro queda para poder recalibrarlo si en
 * otra infraestructura el screencast arranca distinto.
 */
export const DEFAULT_VIDEO_WARMUP_MS = 0

/**
 * Margen con el que hay que recortar los clips.
 *
 * El reloj de los pasos y la posición del video no coinciden exactamente: entre que
 * el navegador dibuja la pantalla, el screencast la codifica y nosotros anotamos el
 * paso, hay unos cientos de milisegundos de juego. Medido contra la app de prueba, el
 * desvío se mantiene por debajo de medio segundo. Se publica en el resumen de tiempos
 * para que el frente de video corte con este margen en vez de suponer precisión al
 * milisegundo.
 */
export const CLOCK_TOLERANCE_MS = 1000
export const MOBILE_VIEWPORT = { width: 375, height: 812 } as const

export interface RecordedRequest {
  /** Milisegundos desde que arrancó la grabación. */
  atMs: number
  url: string
  method: string
  resourceType: string
  hostname: string
  isNavigation: boolean
  blocked: boolean
}

/**
 * Una pantalla que el navegador llegó a abrir de verdad.
 *
 * Se registra desde la respuesta, no desde el pedido, porque el dato que hace
 * falta es el que solo existe del otro lado: el código de estado. Sin él no se
 * puede distinguir "la pantalla existe" de "la app devolvió un error".
 *
 * `html` es el marcado servido, ya sin scripts ni estilos y recortado. Se limpia
 * antes de guardarlo por dos razones: un script en línea puede llevar una llave
 * adentro, y sin ellos el texto visible entra en una fracción del tamaño.
 */
export interface RecordedPage {
  atMs: number
  url: string
  status: number
  html?: string
}

/** Tope de pantallas guardadas por tarea. Alcanza para el recorrido de una prueba. */
export const MAX_RECORDED_PAGES = 8

/** Tope del marcado guardado por pantalla, ya limpio. */
export const MAX_PAGE_HTML_CHARS = 20_000

/** Saca scripts y estilos, junta los espacios y recorta. */
export function limpiarHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PAGE_HTML_CHARS)
}

export interface OpenBrowserOptions {
  taskId: AgentTaskId
  /** Carpeta de la corrida. Se crea `<workspaceDir>/agent/<taskId>/`. */
  workspaceDir: string
  /** Orígenes donde el agente puede navegar. */
  allowedOrigins: string[]
  headless?: boolean
  viewport?: { width: number; height: number }
  recordHar?: boolean
  /** Tiempo máximo por operación del navegador. */
  actionTimeoutMs?: number
  /** Tiempo máximo total de la tarea. */
  taskTimeoutMs?: number
  /**
   * Corta los pedidos a dominios de afuera después de registrarlos.
   * Se usa en las pruebas para no depender de internet. En producción va en `false`:
   * queremos que la app se comporte igual que para un visitante real.
   */
  offlineExternal?: boolean
  /** Dominios extra a bloquear siempre. */
  blockedHosts?: string[]
  /** Reutiliza un navegador ya abierto en vez de lanzar otro. */
  browser?: Browser
  /**
   * Espera antes de poner el cero del reloj. Por defecto 0; ver `DEFAULT_VIDEO_WARMUP_MS`.
   * Existe para recalibrar si en otra infraestructura el screencast arranca distinto.
   */
  videoWarmupMs?: number
}

export interface AgentBrowser {
  context: BrowserContext
  page: Page
  taskId: AgentTaskId
  /** Carpeta donde va todo lo de esta tarea. */
  taskDir: string
  /** Reloj de pared del inicio de la grabación. */
  videoStartedAtEpochMs: number
  /** Milisegundos transcurridos desde el inicio de la grabación. */
  atMs: () => number
  /** Pedidos de red observados, con su momento relativo a la grabación. */
  requests: RecordedRequest[]
  /** Pantallas que se abrieron, con su código de estado y su marcado limpio. */
  pages: RecordedPage[]
  /** Registra un paso y saca la captura correspondiente. */
  record: (input: RecordStepInput) => Promise<AgentStep>
  steps: AgentStep[]
  /** Cierra todo y deja el video en disco. Idempotente. */
  close: () => Promise<RecordingManifest>
}

export interface RecordStepInput {
  action: string
  note: string
  target?: string
  /** Por defecto saca captura. Se apaga para pasos que no cambian la pantalla. */
  screenshot?: boolean
}

const PRIVATE_HOST = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1\]?$)/i
const METADATA_HOSTS = ['metadata.google.internal', 'metadata.goog', '169.254.169.254']

function isPrivateHost(hostname: string): boolean {
  return PRIVATE_HOST.test(hostname) || METADATA_HOSTS.includes(hostname.toLowerCase())
}

/** Lanza Chromium sin interfaz. Se reutiliza entre tareas de una misma corrida. */
export async function launchBrowser(headless = true): Promise<Browser> {
  return chromium.launch({
    headless,
    args: ['--disable-dev-shm-usage', '--no-sandbox'],
  })
}

export async function openAgentBrowser(options: OpenBrowserOptions): Promise<AgentBrowser> {
  const {
    taskId,
    workspaceDir,
    allowedOrigins,
    headless = true,
    viewport = DESKTOP_VIEWPORT,
    recordHar = false,
    actionTimeoutMs = 15_000,
    offlineExternal = false,
    blockedHosts = [],
    videoWarmupMs = DEFAULT_VIDEO_WARMUP_MS,
  } = options

  const taskDir = path.join(workspaceDir, 'agent', taskId)
  const videoDir = path.join(taskDir, 'video')
  await mkdir(videoDir, { recursive: true })

  const ownsBrowser = !options.browser
  const browser = options.browser ?? (await launchBrowser(headless))

  // Si la propia app vive en una dirección privada (desarrollo o pruebas), no tiene
  // sentido bloquear direcciones privadas: bloquearíamos la app que vinimos a auditar.
  const targetIsPrivate = allowedOrigins.some((origin) => {
    try {
      return isPrivateHost(new URL(origin).hostname)
    } catch {
      return false
    }
  })

  const context = await browser.newContext({
    viewport,
    recordVideo: { dir: videoDir, size: viewport },
    ...(recordHar ? { recordHar: { path: path.join(taskDir, 'network.har'), content: 'omit' as const } } : {}),
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires',
    ignoreHTTPSErrors: true,
    serviceWorkers: 'block',
    // Perfil limpio: sin permisos concedidos, sin almacenamiento previo.
    permissions: [],
  })

  context.setDefaultTimeout(actionTimeoutMs)
  context.setDefaultNavigationTimeout(actionTimeoutMs)

  await installRedaction(context)

  const requests: RecordedRequest[] = []
  const pages: RecordedPage[] = []
  const steps: AgentStep[] = []

  let start = performance.now()
  let videoStartedAtEpochMs = Date.now()
  const atMs = () => Math.max(0, Math.round(performance.now() - start))

  await context.route('**/*', async (route) => {
    const request: Request = route.request()
    let hostname = ''
    let origin = ''
    try {
      const url = new URL(request.url())
      hostname = url.hostname
      origin = url.origin
    } catch {
      // Direcciones raras (data:, blob:) no tienen host; se dejan pasar.
    }

    const isNavigation = request.isNavigationRequest() && request.resourceType() === 'document'
    const insideApp = origin.length === 0 || allowedOrigins.includes(origin)
    const blockedByList = blockedHosts.some((host) => hostname.endsWith(host))
    const blockedPrivate = !targetIsPrivate && hostname.length > 0 && isPrivateHost(hostname)
    // Solo se corta la navegación hacia afuera: los recursos de terceros tienen que
    // poder cargar, porque son justamente lo que hay que detectar (rastreadores).
    const blockedNavigation = isNavigation && !insideApp
    const blockedOffline = offlineExternal && !insideApp && !isNavigation

    const blocked = blockedByList || blockedPrivate || blockedNavigation || blockedOffline

    requests.push({
      atMs: atMs(),
      url: redactUrl(request.url()),
      method: request.method(),
      resourceType: request.resourceType(),
      hostname,
      isNavigation,
      blocked,
    })

    if (blocked) {
      await route.abort('blockedbyclient').catch(() => {})
      return
    }
    await route.continue().catch(() => {})
  })

  // Cada pantalla que se abre queda anotada con su código de estado. El cuerpo se
  // pide aparte porque `response.text()` es asincrónico: si llega, se completa la
  // entrada; si no llega (redirección, respuesta sin cuerpo, contexto ya cerrado),
  // la pantalla igual queda registrada con su estado, que es el dato principal.
  context.on('response', (response) => {
    const request = response.request()
    if (request.resourceType() !== 'document' || !request.isNavigationRequest()) return
    if (pages.length >= MAX_RECORDED_PAGES) return

    const entry: RecordedPage = {
      atMs: atMs(),
      url: redactUrl(response.url()),
      status: response.status(),
    }
    pages.push(entry)

    void response.text().then(
      (html) => {
        entry.html = limpiarHtml(html)
      },
      () => {
        // Sin cuerpo disponible. La pantalla queda con estado y sin marcado: los
        // chequeos que necesitan el marcado se saltean solos y lo dejan dicho.
      },
    )
  })

  const page = await context.newPage()

  // El cero de la grabación. Se pone acá, apenas la página existe.
  // La espera de calentamiento va en 0 por defecto: ver `DEFAULT_VIDEO_WARMUP_MS`,
  // donde está anotado por qué subirla empeora los tiempos en vez de mejorarlos.
  if (videoWarmupMs > 0) await page.waitForTimeout(videoWarmupMs)
  start = performance.now()
  videoStartedAtEpochMs = Date.now()

  let stepIndex = 0
  const record = async (input: RecordStepInput): Promise<AgentStep> => {
    const index = stepIndex++
    // El instante que interesa es cuando el navegador captura la pantalla, y eso pasa
    // en algún punto de la llamada a `screenshot()`. Tomando el punto medio, el error
    // máximo es la mitad de lo que tarda la captura, en vez de su duración entera.
    const before = atMs()
    let screenshotPath: string | undefined

    if (input.screenshot !== false) {
      const file = path.join(taskDir, `paso-${String(index).padStart(2, '0')}.png`)
      try {
        await page.screenshot({
          path: file,
          mask: maskLocators(page),
          maskColor: '#111827',
          scale: 'css',
          timeout: 5_000,
        })
        screenshotPath = file
      } catch {
        // Una captura fallida no puede voltear la corrida: el paso vale igual.
      }
    }
    const at = Math.round((before + atMs()) / 2)

    const step: AgentStep = {
      index,
      atMs: at,
      action: input.action,
      target: input.target ? redactText(input.target).slice(0, 200) : undefined,
      url: redactUrl(page.url()),
      note: redactText(input.note).slice(0, 400),
      screenshotPath,
    }
    steps.push(step)
    return step
  }

  let closed = false
  let manifest: RecordingManifest | null = null

  const close = async (): Promise<RecordingManifest> => {
    if (closed && manifest) return manifest
    closed = true

    const finishedAtEpochMs = Date.now()
    const wallDurationMs = atMs()
    const video = page.video()

    // El video recién se termina de escribir cuando se cierra el contexto.
    await context.close().catch(() => {})

    let videoPath: string | null = null
    if (video) {
      const target = path.join(taskDir, 'recording.webm')
      try {
        await video.saveAs(target)
        videoPath = target
      } catch {
        videoPath = await video.path().catch(() => null)
      }
    }
    await rm(videoDir, { recursive: true, force: true }).catch(() => {})

    if (ownsBrowser) await browser.close().catch(() => {})

    manifest = {
      taskId,
      videoPath,
      harPath: recordHar ? path.join(taskDir, 'network.har') : null,
      videoStartedAtEpochMs,
      finishedAtEpochMs,
      wallDurationMs,
      clockToleranceMs: CLOCK_TOLERANCE_MS,
      viewport: { width: viewport.width, height: viewport.height },
      steps: steps.map((step) => ({
        index: step.index,
        atMs: step.atMs,
        action: step.action,
        url: step.url,
        note: step.note,
        screenshotPath: step.screenshotPath,
      })),
    }
    return manifest
  }

  return {
    context,
    page,
    taskId,
    taskDir,
    videoStartedAtEpochMs,
    atMs,
    requests,
    pages,
    record,
    steps,
    close,
  }
}

/**
 * Corre `fn` con un navegador y garantiza el cierre, haya fallado o no.
 * Sin esto, un error a mitad de camino deja un Chromium colgado y el video sin escribir.
 */
export async function withAgentBrowser<T>(
  options: OpenBrowserOptions,
  fn: (browser: AgentBrowser) => Promise<T>,
): Promise<{ value: T; manifest: RecordingManifest }> {
  const agentBrowser = await openAgentBrowser(options)
  try {
    const value = await fn(agentBrowser)
    const manifest = await agentBrowser.close()
    return { value, manifest }
  } catch (error) {
    await agentBrowser.close().catch(() => {})
    throw error
  }
}

/* ── Segunda pasada a 375 px ─────────────────────────────────────────── */

export interface HorizontalOverflowResult {
  overflow: boolean
  scrollWidth: number
  clientWidth: number
  /** Qué se sale de la pantalla, descrito para que lo entienda una persona. */
  offenders: string[]
  screenshotPath?: string
}

/** Mide si la pantalla se va para el costado en un teléfono. Objetivo y verificable. */
export async function detectHorizontalOverflow(page: Page): Promise<Omit<HorizontalOverflowResult, 'screenshotPath'>> {
  return page.evaluate(() => {
    const doc = document.documentElement
    const clientWidth = doc.clientWidth
    const scrollWidth = Math.max(doc.scrollWidth, document.body?.scrollWidth ?? 0)
    const tolerance = 1
    const overflow = scrollWidth > clientWidth + tolerance

    const offenders: string[] = []
    if (overflow) {
      const seen = new Set<string>()
      const elements = Array.from(document.body?.querySelectorAll('*') ?? [])
      const wide = elements
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width > 0 && rect.height > 0 && rect.right > clientWidth + tolerance)
        .sort((a, b) => b.rect.right - a.rect.right)

      for (const { element, rect } of wide) {
        const tag = element.tagName.toLowerCase()
        const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
        const label =
          tag === 'table'
            ? `una tabla${text ? ` que empieza con "${text}"` : ''}`
            : tag === 'img'
              ? `una imagen${element.getAttribute('alt') ? ` ("${element.getAttribute('alt')}")` : ''}`
              : text
                ? `un bloque con el texto "${text}"`
                : `un bloque <${tag}>`
        const entry = `${label} — se extiende hasta ${Math.round(rect.right)} px de ancho`
        if (seen.has(label)) continue
        seen.add(label)
        offenders.push(entry)
        if (offenders.length >= 4) break
      }
    }

    return { overflow, scrollWidth, clientWidth, offenders }
  })
}

/**
 * Abre la dirección en un teléfono y mide el desborde horizontal.
 * Contexto aparte y descartable: no toca la grabación de la tarea principal.
 */
export async function runMobilePass(
  url: string,
  options: {
    workspaceDir: string
    allowedOrigins: string[]
    headless?: boolean
    browser?: Browser
    offlineExternal?: boolean
    timeoutMs?: number
  },
): Promise<HorizontalOverflowResult | null> {
  const ownsBrowser = !options.browser
  const browser = options.browser ?? (await launchBrowser(options.headless ?? true))
  const dir = path.join(options.workspaceDir, 'agent', 'telefono')
  await mkdir(dir, { recursive: true })

  const context = await browser.newContext({
    viewport: MOBILE_VIEWPORT,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'es-AR',
    ignoreHTTPSErrors: true,
    serviceWorkers: 'block',
  })
  context.setDefaultTimeout(options.timeoutMs ?? 15_000)
  context.setDefaultNavigationTimeout(options.timeoutMs ?? 15_000)

  try {
    if (options.offlineExternal) {
      await context.route('**/*', async (route) => {
        let origin = ''
        try {
          origin = new URL(route.request().url()).origin
        } catch {
          /* sin origen: se deja pasar */
        }
        if (origin && !options.allowedOrigins.includes(origin)) {
          await route.abort('blockedbyclient').catch(() => {})
          return
        }
        await route.continue().catch(() => {})
      })
    }

    const page = await context.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(400)

    const measurement = await detectHorizontalOverflow(page)
    let screenshotPath: string | undefined
    if (measurement.overflow) {
      screenshotPath = path.join(dir, 'desborde-375px.png')
      await page
        .screenshot({ path: screenshotPath, mask: maskLocators(page), maskColor: '#111827', timeout: 5_000 })
        .catch(() => {
          screenshotPath = undefined
        })
    }

    return { ...measurement, screenshotPath }
  } catch {
    return null
  } finally {
    await context.close().catch(() => {})
    if (ownsBrowser) await browser.close().catch(() => {})
  }
}
