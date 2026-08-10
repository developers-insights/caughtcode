/**
 * ¿Hasta dónde llega este comentario?
 *
 * Es la pregunta que importa y la que casi nadie contesta bien:
 *
 * - Los comentarios de **HTML** se ven siempre en "ver código fuente".
 * - Los de **JS/TS de cliente** los suele borrar el minificador en producción,
 *   pero sobreviven en desarrollo, en builds sin minificar y —lo más olvidado—
 *   dentro de los *source maps* si quedaron publicados.
 * - Los de **CSS** viajan con la hoja de estilos.
 * - Los de **código de servidor** no salen nunca del servidor.
 *
 * Por eso `ships_to_browser` no significa "se ve seguro", significa "puede
 * verse". Es la diferencia entre una nota interna molesta y una clave filtrada.
 *
 * ## Heurística, en orden
 *
 * 1. Rutas que siempre llegan al navegador: `public/**`, `.html`, `.css`/`.scss`.
 * 2. Rutas que nunca se publican: configs, scripts, tests, `.d.ts`.
 * 3. Señales explícitas de servidor: `import 'server-only'`, `'use server'`,
 *    `route.ts`, `middleware`/`proxy`, `pages/api/**`, `supabase/functions/**`.
 * 4. Señales explícitas de cliente: `'use client'` propio.
 * 5. Herencia: si un `layout` que cubre esa carpeta es cliente, lo que está
 *    debajo también lo es. Sale de las rutas ya calculadas (`RouteInfo[]`).
 * 6. Señales indirectas de cliente: usa hooks de React, `window`, `document` o
 *    `localStorage`. Sin directiva propia, ese módulo termina en el navegador
 *    igual, porque lo importa un componente de cliente.
 * 7. Default según el framework: en App Router, servidor; en una SPA o en Pages
 *    Router, navegador.
 */
import type { CommentReach, RouteInfo } from '@/lib/types/domain'

export type FrameworkKind = 'nextjs-app' | 'nextjs-pages' | 'spa' | 'unknown'

export interface ReachContext {
  framework?: FrameworkKind
  /** Rutas ya calculadas por el índice de código. Afinan la herencia de `'use client'`. */
  routes?: RouteInfo[]
}

export interface ReachResult {
  reach: CommentReach
  /** Por qué, en castellano llano. Se muestra tal cual al usuario. */
  reason: string
}

const ALWAYS_BROWSER = /\.(html?|css|scss|sass|less|styl)$/i
const BUILD_ONLY_EXT = /\.d\.ts$/i
const CONFIG_FILE = /(^|\/)[^/]*\.config\.(m|c)?[jt]s$/i
const TEST_FILE = /(^|\/)(__tests__|__mocks__|tests?|e2e|cypress|playwright)\//i
const TEST_NAME = /\.(test|spec|stories|bench)\.(m|c)?[jt]sx?$/i
const BUILD_DIR = /^(scripts?|tools?|bin|config|\.github|\.husky|supabase\/migrations|prisma|drizzle)\//i
const ROOT_CONFIG = /^[^/]*\.(config|rc)\.(m|c)?[jt]s$/i

const SERVER_FILE = /(^|\/)(route|middleware|proxy|instrumentation)\.(m|c)?[jt]sx?$/i
const SERVER_DIR = /^(supabase\/functions|server)\//i

const CLIENT_DIR_HINT = /(^|\/)(hooks|context|contexts|providers|store|stores)\//i

const USE_CLIENT = /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*|['"]use strict['"];?\s*|\s)*['"]use client['"]/
const USE_SERVER = /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*|\s)*['"]use server['"]/
const SERVER_ONLY_IMPORT = /(^|\n)\s*import\s+['"]server-only['"]/
const CLIENT_ONLY_SIGNALS =
  /\b(useState|useEffect|useLayoutEffect|useRef|useReducer|useContext|useCallback|useMemo|useTransition|useOptimistic|useFormStatus|useRouter|usePathname|useSearchParams|createContext)\b|\bwindow\.|\bdocument\.|\blocalStorage\b|\bsessionStorage\b|\bnavigator\.|\bonClick=/

const R = {
  html: 'Los comentarios del HTML se ven con "ver código fuente" en cualquier navegador.',
  css: 'La hoja de estilos se descarga entera en el navegador, comentarios incluidos.',
  publicDir: 'Todo lo que está en la carpeta pública se sirve tal cual al visitante.',
  build: 'Este archivo se usa sólo para armar la app. No se publica.',
  test: 'Es un archivo de pruebas. No se publica.',
  types: 'Es un archivo de tipos. Desaparece al compilar.',
  serverOnly: 'Este archivo está marcado para correr sólo en el servidor.',
  useServer: 'Tiene la marca de código de servidor.',
  route: 'Es un endpoint. Corre en el servidor y no se manda al navegador.',
  serverDir: 'Está en una carpeta de servidor. No se manda al navegador.',
  useClient: 'Tiene la marca de código de cliente, así que se descarga en el navegador.',
  inherited:
    'Está dentro de una pantalla marcada como de cliente, así que también se descarga en el navegador.',
  signals:
    'Usa cosas que sólo existen en el navegador, así que este archivo termina descargándose ahí.',
  clientDir: 'Está en una carpeta de código de interfaz, que se descarga en el navegador.',
  appDefault: 'En esta app, lo que no está marcado como de cliente se queda en el servidor.',
  spa: 'Toda la app corre en el navegador, así que este archivo se descarga entero.',
  pages: 'Esta pantalla se descarga en el navegador.',
  pagesApi: 'Es un endpoint. Corre en el servidor y no se manda al navegador.',
  unknown: 'No pudimos determinar si se publica, así que lo tratamos como si se publicara.',
}

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '')
}

/** Quita el prefijo `src/` para razonar sobre la estructura del framework. */
function withoutSrc(p: string): string {
  return p.replace(/^src\//, '')
}

/**
 * Carpetas que un `layout` de cliente vuelve cliente. Devuelve prefijos como
 * `src/app/panel/`.
 */
function clientDirsFromRoutes(routes: RouteInfo[] | undefined): string[] {
  if (!routes) return []
  const out: string[] = []
  for (const r of routes) {
    if (!r.isClient) continue
    const f = norm(r.file)
    if (r.kind === 'layout') out.push(f.slice(0, f.lastIndexOf('/') + 1))
  }
  return out
}

export function computeReach(file: string, text: string, ctx: ReachContext = {}): ReachResult {
  const p = norm(file)
  const rel = withoutSrc(p)
  const framework = ctx.framework ?? 'unknown'

  if (/\.html?$/i.test(p)) return { reach: 'ships_to_browser', reason: R.html }
  if (ALWAYS_BROWSER.test(p)) return { reach: 'ships_to_browser', reason: R.css }
  if (p.startsWith('public/')) return { reach: 'ships_to_browser', reason: R.publicDir }

  if (BUILD_ONLY_EXT.test(p)) return { reach: 'build_only', reason: R.types }
  if (TEST_FILE.test(`/${p}`) || TEST_NAME.test(p)) return { reach: 'build_only', reason: R.test }
  if (CONFIG_FILE.test(p) || ROOT_CONFIG.test(p)) return { reach: 'build_only', reason: R.build }
  if (BUILD_DIR.test(p)) return { reach: 'build_only', reason: R.build }

  if (SERVER_ONLY_IMPORT.test(text)) return { reach: 'server_only', reason: R.serverOnly }
  if (USE_SERVER.test(text)) return { reach: 'server_only', reason: R.useServer }
  if (SERVER_FILE.test(p)) return { reach: 'server_only', reason: R.route }
  if (SERVER_DIR.test(rel) || SERVER_DIR.test(p)) return { reach: 'server_only', reason: R.serverDir }
  if (/^pages\/api\//.test(rel)) return { reach: 'server_only', reason: R.pagesApi }
  if (/^app\/api\//.test(rel)) return { reach: 'server_only', reason: R.route }

  if (USE_CLIENT.test(text)) return { reach: 'ships_to_browser', reason: R.useClient }

  for (const dir of clientDirsFromRoutes(ctx.routes)) {
    if (p.startsWith(dir)) return { reach: 'ships_to_browser', reason: R.inherited }
  }

  if (CLIENT_ONLY_SIGNALS.test(text)) return { reach: 'ships_to_browser', reason: R.signals }
  if (CLIENT_DIR_HINT.test(`/${rel}`)) return { reach: 'ships_to_browser', reason: R.clientDir }

  if (framework === 'nextjs-pages' || /^pages\//.test(rel)) {
    return { reach: 'ships_to_browser', reason: R.pages }
  }
  if (framework === 'spa') return { reach: 'ships_to_browser', reason: R.spa }
  if (framework === 'nextjs-app' || /^app\//.test(rel)) {
    return { reach: 'server_only', reason: R.appDefault }
  }

  return { reach: 'ships_to_browser', reason: R.unknown }
}
