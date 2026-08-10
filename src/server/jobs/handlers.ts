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
 * 2. Agregá una línea acá abajo. Es la única edición que necesitás en esta carpeta.
 *
 * Hasta que lo hagas, ese tipo de trabajo falla con un mensaje claro
 * ("handler no registrado todavía") en vez de romper el worker.
 *
 * Los imports son **estáticos a propósito**: un `import()` con la ruta en una
 * variable rompe el bundler de Next, y uno literal a un archivo que todavía no
 * existe rompe el build. Por eso la lista se agrega a mano, de a una línea.
 */

let loaded = false

/**
 * Cada import va envuelto: si el módulo de un frente no carga en este entorno
 * —pasó de verdad, con Playwright en Vercel: `browsers.json` no viaja en el
 * paquete de la función serverless— eso no puede tirar abajo **todo** el tick.
 * Sin este try/catch, un solo `import()` que revienta corta la cola entera:
 * ni siquiera los trabajos de los demás frentes llegan a correr, un minuto sí
 * y otro también, hasta que alguien lo note.
 */
async function importarSinRomperElResto(ruta: string, cargar: () => Promise<unknown>): Promise<void> {
  try {
    await cargar()
  } catch (error) {
    console.error(
      `[jobs] no se pudo cargar "${ruta}": sus trabajos van a fallar con "handler no registrado", pero el resto de la cola sigue andando. ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

export async function registerAllHandlers(): Promise<void> {
  if (loaded) return
  loaded = true

  // ── Agregá acá el import de tu módulo de handlers ──────────────────────
  await importarSinRomperElResto('ingest', () => import('@/server/ingest/handlers'))
  await importarSinRomperElResto('analysis', () => import('@/server/analysis/handlers'))
  await importarSinRomperElResto('checks', () => import('@/server/checks/handlers'))
  await importarSinRomperElResto('agent', () => import('@/server/agent/handlers'))
  await importarSinRomperElResto('video', () => import('@/server/video/handlers'))
  await importarSinRomperElResto('comments', () => import('@/server/comments/handlers'))
}
