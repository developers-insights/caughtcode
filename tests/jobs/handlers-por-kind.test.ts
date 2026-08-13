/**
 * Cargar los seis módulos de handlers cuesta 62 MB → 226 MB medidos: tree-sitter
 * (WASM), playwright-core y ffmpeg-static. En Vercel con Fluid Compute varias
 * invocaciones comparten los 2 GB de UNA instancia, así que ese costo se
 * multiplica hasta que Vercel mata la instancia entera —y con ella el trabajo
 * que estaba corriendo.
 *
 * Una tanda que solo va a atender `run_checks` no tiene por qué pagar el ffmpeg.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

let importados: string[] = []

/**
 * `vi.doMock` y no `vi.mock`: el mock izado corre su factory UNA sola vez en
 * todo el archivo y `vi.resetModules()` no la vuelve a disparar, así que el
 * segundo test ya no vería el import. `doMock` se registra de nuevo en cada
 * test y la factory corre en el import siguiente, que es justo lo que hay que
 * observar acá.
 */
interface OpcionesEspia {
  rompe?: string
  vecesQueRompe?: number
  /** El mensaje con el que revienta el import. Por defecto, uno pasajero. */
  mensaje?: string
  codigo?: string
}

function espiarModulos(opciones: OpcionesEspia = {}): void {
  let rotas = 0
  const registrar = (nombre: string): Record<string, never> => {
    if (opciones.rompe === nombre && rotas < (opciones.vecesQueRompe ?? Infinity)) {
      rotas += 1
      const error = new Error(
        opciones.mensaje ?? 'socket hang up al bajar el módulo: puede ser pasajero',
      )
      if (opciones.codigo) (error as NodeJS.ErrnoException).code = opciones.codigo
      throw error
    }
    importados.push(nombre)
    return {}
  }

  vi.doMock('@/server/ingest/handlers', () => registrar('ingest'))
  vi.doMock('@/server/analysis/handlers', () => registrar('analysis'))
  vi.doMock('@/server/checks/handlers', () => registrar('checks'))
  vi.doMock('@/server/agent/handlers', () => registrar('agent'))
  vi.doMock('@/server/video/handlers', () => registrar('video'))
  vi.doMock('@/server/comments/handlers', () => registrar('comments'))
}

beforeEach(() => {
  importados = []
  vi.restoreAllMocks()
  // Vuelve a foja cero el `Set` de módulos ya intentados que vive en handlers.ts.
  vi.resetModules()
})

describe('registerHandlersFor', () => {
  it('para run_checks no importa ni el módulo de video ni el de agente', async () => {
    espiarModulos()
    const { registerHandlersFor } = await import('@/server/jobs/handlers')

    await registerHandlersFor(['run_checks'])

    expect(importados).toEqual(['checks'])
    expect(importados).not.toContain('video')
    expect(importados).not.toContain('agent')
  })

  it('carga un módulo por cada tipo pedido, sin repetir', async () => {
    espiarModulos()
    const { registerHandlersFor } = await import('@/server/jobs/handlers')

    // `generate_video` y `build_tutorials` viven los dos en el módulo de video.
    await registerHandlersFor(['ingest_repo', 'generate_video', 'build_tutorials'])

    expect([...importados].sort()).toEqual(['ingest', 'video'])
  })

  it('llamarla de nuevo no vuelve a importar lo que ya está', async () => {
    espiarModulos()
    const { registerHandlersFor } = await import('@/server/jobs/handlers')

    await registerHandlersFor(['run_checks'])
    await registerHandlersFor(['run_checks', 'index_code'])

    expect(importados).toEqual(['checks', 'analysis'])
  })

  it('un módulo que no carga no tumba al resto de la cola', async () => {
    espiarModulos({ rompe: 'agent' })
    const { registerHandlersFor } = await import('@/server/jobs/handlers')

    await expect(registerHandlersFor(['run_browser_agent', 'run_checks'])).resolves.toBeUndefined()
    expect(importados).toEqual(['checks'])
  })

  it('un fallo pasajero se reintenta en la tanda siguiente', async () => {
    // En el tick serverless (proceso de segundos) daba igual. En el worker de
    // Render, que vive días, marcar el módulo como intentado ANTES de importar
    // dejaba ese frente muerto para siempre por un solo tropezón.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    espiarModulos({ rompe: 'video', vecesQueRompe: 1 })
    const { registerHandlersFor } = await import('@/server/jobs/handlers')

    await registerHandlersFor(['generate_video'])
    expect(importados).toEqual([])

    await registerHandlersFor(['generate_video'])
    expect(importados).toEqual(['video'])
  })

  it('un módulo que no está en este paquete no se reintenta nunca más', async () => {
    // El caso real de Playwright en Vercel: `browsers.json` no viaja y no va a
    // viajar. Reintentarlo es pagar el mismo error una vez por minuto.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    espiarModulos({
      rompe: 'agent',
      // Textual de producción, un minuto sí y otro también durante días.
      mensaje: "Cannot find module '/var/task/node_modules/playwright-core/browsers.json'",
      codigo: 'MODULE_NOT_FOUND',
    })
    const { registerHandlersFor } = await import('@/server/jobs/handlers')

    await registerHandlersFor(['run_browser_agent'])
    await registerHandlersFor(['run_browser_agent'])

    expect(importados).toEqual([])
    expect(console.error).toHaveBeenCalledTimes(1)
  })
})

describe('registerAllHandlers', () => {
  it('sigue cargando todo: lo usa el worker largo, que atiende todos los tipos', async () => {
    espiarModulos()
    const { registerAllHandlers } = await import('@/server/jobs/handlers')

    await registerAllHandlers()

    expect([...importados].sort()).toEqual([
      'agent',
      'analysis',
      'checks',
      'comments',
      'ingest',
      'video',
    ])
  })
})
