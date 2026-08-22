/**
 * Punto único donde se enganchan los handlers reales de la cola.
 *
 * ## Si sos el frente dueño de un tipo de trabajo, esto es lo que tenés que hacer
 *
 * 1. En tu carpeta, creá `handlers.ts` y registrá tu tipo al importarse:
 *
 *    ```ts
 *    // src/server/checks/handlers.ts
 *    import { registerHandler, runStages } from '@/server/jobs'
 *
 *    registerHandler('run_checks', async (payload, ctx) => { ... })
 *    ```
 *
 * 2. Agregá tu módulo a `CARGADORES` y apuntá tu `JobKind` a él en
 *    `MODULO_POR_KIND`, acá abajo. Son las dos únicas ediciones que necesitás en
 *    esta carpeta, y el `Record<JobKind, …>` no te deja olvidarte de la segunda.
 *
 * Hasta que lo hagas, ese tipo de trabajo falla con un mensaje que se entiende
 * («<la etapa>» no estuvo disponible…) en vez de romper el worker. Ver
 * `HandlerNotRegisteredError`.
 *
 * ## Por qué se carga por tipo y no todo junto
 *
 * Importar los seis módulos cuesta memoria real y medida: 62 MB → 226 MB, casi
 * todo tree-sitter (WASM), playwright-core y ffmpeg-static. En Vercel con Fluid
 * Compute varias invocaciones comparten los 2 GB de UNA instancia, así que ese
 * costo se multiplica por invocación concurrente hasta que Vercel mata la
 * instancia entera —y con ella el trabajo que estaba corriendo:
 *
 *     Vercel Runtime Error: instance was killed because it ran out of
 *     available memory
 *
 * Una tanda que solo va a atender `run_checks` no tiene por qué pagar el ffmpeg.
 *
 * Los imports son **estáticos a propósito**: un `import()` con la ruta en una
 * variable rompe el bundler de Next, y uno literal a un archivo que todavía no
 * existe rompe el build. Por eso la lista se agrega a mano, de a una línea. El
 * mapa de abajo elige CUÁL de esos literales se ejecuta, nunca cómo se escribe.
 */

import type { JobKind } from '@/lib/types/domain'
import { JOB_KINDS } from './registry'

/** Cada carpeta de frente que registra handlers. */
type ModuloDeHandlers = 'ingest' | 'analysis' | 'checks' | 'agent' | 'video' | 'comments'

/**
 * Qué módulo hay que importar para poder atender cada tipo de trabajo.
 *
 * El `Record<JobKind, …>` obliga al compilador a avisar si alguien agrega un
 * `JobKind` nuevo en `domain.ts`: sin esto, el tipo nuevo simplemente no
 * cargaría su módulo y fallaría con "handler no registrado" sin que nadie
 * entienda por qué.
 *
 * `build_tutorials` es una **capacidad declarada y todavía no construida**: no
 * está rota, nunca se escribió (ver `CAPACIDADES_SIN_MOTOR` en `registry.ts`,
 * que es donde está el detalle y lo que hay que tocar para construirla). Apunta
 * a `video` porque es su dueño natural —escribiría en `videos_caughtcode`, ver
 * el comentario de idempotencia de `registry.ts`—, pero ese módulo solo registra
 * `generate_video`, así que mientras tanto sigue siendo un stub que falla al
 * instante y no tiñe la revisión.
 */
const MODULO_POR_KIND: Record<JobKind, ModuloDeHandlers> = {
  ingest_repo: 'ingest',
  index_code: 'analysis',
  run_checks: 'checks',
  run_browser_agent: 'agent',
  generate_video: 'video',
  scan_comments: 'comments',
  build_tutorials: 'video',
}

/** ── Agregá acá el import de tu módulo de handlers ──────────────────────── */
const CARGADORES: Record<ModuloDeHandlers, () => Promise<unknown>> = {
  ingest: () => import('@/server/ingest/handlers'),
  analysis: () => import('@/server/analysis/handlers'),
  checks: () => import('@/server/checks/handlers'),
  agent: () => import('@/server/agent/handlers'),
  video: () => import('@/server/video/handlers'),
  comments: () => import('@/server/comments/handlers'),
}

/**
 * Módulos que ya no hay que volver a intentar en este proceso: o cargaron bien,
 * o fallaron de una forma que reintentar no puede arreglar.
 *
 * Un fallo **definitivo** —el módulo, o algo que él importa, no existe en este
 * paquete— se anota para no pagar el mismo error una vez por minuto. Es el caso
 * real de Playwright en Vercel: `browsers.json` no viaja en la función
 * serverless y nunca va a viajar.
 *
 * Un fallo **transitorio** (un `import()` que se cayó por presión de memoria, un
 * archivo todavía a medio escribir en un deploy) NO se anota. Antes sí: se
 * marcaba antes de importar, y en el tick serverless eso cerraba —el proceso
 * vive segundos— pero en el worker de Render, que vive días, un tropezón de una
 * vez dejaba ese módulo deshabilitado para siempre en ese proceso.
 */
const resueltos = new Set<ModuloDeHandlers>()

/** Códigos de Node que significan "esto no está y no va a aparecer". */
const CODIGOS_DEFINITIVOS = new Set(['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'])

/** Último recurso: el bundler o el runner pueden envolver el error y comerse el `code`. */
const MENSAJE_DEFINITIVO = /cannot find (module|package)|module not found/i

/**
 * Se recorre la cadena de `cause`: el error real casi nunca llega pelado. El
 * caso de producción es un `require()` de adentro de playwright-core que
 * revienta con `MODULE_NOT_FOUND` y sube envuelto por el import dinámico.
 */
function esFalloDefinitivo(error: unknown, profundidad = 0): boolean {
  if (!error || typeof error !== 'object' || profundidad > 5) return false

  const codigo = (error as { code?: unknown }).code
  if (typeof codigo === 'string' && CODIGOS_DEFINITIVOS.has(codigo)) return true

  const mensaje = (error as { message?: unknown }).message
  if (typeof mensaje === 'string' && MENSAJE_DEFINITIVO.test(mensaje)) return true

  return esFalloDefinitivo((error as { cause?: unknown }).cause, profundidad + 1)
}

type ResultadoCarga = 'cargado' | 'definitivo' | 'reintentable'

/**
 * Cada import va envuelto: si el módulo de un frente no carga en este entorno
 * —pasó de verdad, con Playwright en Vercel: `browsers.json` no viaja en el
 * paquete de la función serverless— eso no puede tirar abajo **todo** el tick.
 * Sin este try/catch, un solo `import()` que revienta corta la cola entera:
 * ni siquiera los trabajos de los demás frentes llegan a correr, un minuto sí
 * y otro también, hasta que alguien lo note.
 */
async function importarSinRomperElResto(
  ruta: string,
  cargar: () => Promise<unknown>,
): Promise<ResultadoCarga> {
  try {
    await cargar()
    return 'cargado'
  } catch (error) {
    const definitivo = esFalloDefinitivo(error)
    const mensaje = error instanceof Error ? error.message : String(error)
    console.error(
      `[jobs] no se pudo cargar "${ruta}": sus trabajos van a fallar con "handler no registrado", pero el resto de la cola sigue andando. ${
        definitivo
          ? 'No se vuelve a intentar en este proceso: el módulo no está en este paquete.'
          : 'Se vuelve a intentar en la próxima tanda: el fallo puede ser pasajero.'
      } ${mensaje}`,
    )
    return definitivo ? 'definitivo' : 'reintentable'
  }
}

/**
 * Carga solo los módulos que hacen falta para atender esos tipos de trabajo.
 * Llamarla de más no cuesta nada: lo ya cargado se saltea.
 */
export async function registerHandlersFor(kinds: JobKind[]): Promise<void> {
  const modulos = new Set<ModuloDeHandlers>()
  for (const kind of kinds) {
    const modulo = MODULO_POR_KIND[kind]
    // Un `kind` que llegó de afuera y no está en el mapa no tiene módulo que
    // cargar. `getHandler()` ya lo resuelve con un error claro.
    if (modulo) modulos.add(modulo)
  }

  for (const modulo of modulos) {
    if (resueltos.has(modulo)) continue
    const resultado = await importarSinRomperElResto(modulo, CARGADORES[modulo])
    if (resultado !== 'reintentable') resueltos.add(modulo)
  }
}

/**
 * Carga todo. Lo usa el worker largo (`scripts/worker.ts`), que atiende todos
 * los tipos y vive en una máquina con memoria propia, así que ahí no hay nada
 * que ahorrar.
 */
export async function registerAllHandlers(): Promise<void> {
  await registerHandlersFor(JOB_KINDS)
}

/** Solo para tests: olvida qué módulos se cargaron. */
export function resetHandlerModules(): void {
  resueltos.clear()
}
