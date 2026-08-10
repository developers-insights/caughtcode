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

export async function registerAllHandlers(): Promise<void> {
  if (loaded) return
  loaded = true

  // ── Agregá acá el import de tu módulo de handlers ──────────────────────
  await import('@/server/ingest/handlers')
  await import('@/server/analysis/handlers')
  await import('@/server/checks/handlers')
  await import('@/server/agent/handlers')
  await import('@/server/video/handlers')
  await import('@/server/comments/handlers')
}
