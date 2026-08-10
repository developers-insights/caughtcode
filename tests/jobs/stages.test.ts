import { describe, expect, it, vi } from 'vitest'

import type { JobContext } from '@/server/jobs/registry'
import {
  STAGE_RESULTS_KEY,
  clearStageResults,
  completedStages,
  runStages,
  type StageStore,
} from '@/server/jobs/stages'

/** Store en memoria: hace de `jobs.payload` sin base de datos. */
function memoryStore(initial: Record<string, unknown> = {}): StageStore & {
  readonly current: Record<string, unknown>
} {
  let payload: Record<string, unknown> = { ...initial }
  return {
    get current() {
      return payload
    },
    async load() {
      return payload
    },
    async save(_jobId, next) {
      payload = next
    },
  }
}

function fakeContext(overrides: Partial<JobContext> = {}): JobContext {
  return {
    jobId: 'job-1',
    orgId: 'org-1',
    projectId: 'proj-1',
    analysisRunId: 'run-1',
    attempt: 1,
    maxAttempts: 3,
    signal: new AbortController().signal,
    heartbeat: vi.fn(async () => {}),
    log: vi.fn(),
    reportCost: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('runStages', () => {
  it('corre las etapas en orden y devuelve los resultados por nombre', async () => {
    const store = memoryStore()
    const ctx = fakeContext()

    const resultados = await runStages(
      ctx,
      [
        { name: 'descargar', label: 'Trayendo tu código', run: async () => ({ archivos: 12 }) },
        {
          name: 'indexar',
          label: 'Entendiendo tu proyecto',
          run: async ({ get }) => ({ leidos: get<{ archivos: number }>('descargar')!.archivos }),
        },
      ],
      { store },
    )

    expect(resultados).toEqual({ descargar: { archivos: 12 }, indexar: { leidos: 12 } })
    expect(completedStages(store.current)).toEqual(['descargar', 'indexar'])
  })

  it('al reintentar saltea las etapas ya terminadas', async () => {
    const store = memoryStore()
    const primera = vi.fn(async () => ({ archivos: 3 }))
    const segunda = vi.fn(async () => {
      throw new Error('se cayó bajando el repo')
    })

    await expect(
      runStages(
        fakeContext(),
        [
          { name: 'descargar', run: primera },
          { name: 'indexar', run: segunda },
        ],
        { store },
      ),
    ).rejects.toThrow('se cayó bajando el repo')

    expect(primera).toHaveBeenCalledTimes(1)
    expect(completedStages(store.current)).toEqual(['descargar'])

    // Segundo intento: la etapa 1 no se vuelve a correr.
    const segundaOk = vi.fn(async () => ({ ok: true }))
    const resultados = await runStages(
      fakeContext({ attempt: 2 }),
      [
        { name: 'descargar', run: primera },
        { name: 'indexar', run: segundaOk },
      ],
      { store },
    )

    expect(primera).toHaveBeenCalledTimes(1)
    expect(segundaOk).toHaveBeenCalledTimes(1)
    expect(resultados).toEqual({ descargar: { archivos: 3 }, indexar: { ok: true } })
  })

  it('publica avance con la etiqueta que ve el usuario', async () => {
    const ctx = fakeContext()
    await runStages(
      ctx,
      [
        { name: 'a', label: 'Trayendo tu código', progress: 50, run: async () => null },
        { name: 'b', label: 'Revisando tu proyecto', progress: 100, run: async () => null },
      ],
      { store: memoryStore() },
    )

    const llamadas = (ctx.heartbeat as any).mock.calls
    expect(llamadas).toContainEqual(['Trayendo tu código', 0])
    expect(llamadas).toContainEqual(['Trayendo tu código', 50])
    expect(llamadas).toContainEqual(['Revisando tu proyecto', 100])
  })

  it('corta si una etapa devuelve un blob gigante', async () => {
    const store = memoryStore()
    await expect(
      runStages(
        fakeContext(),
        [{ name: 'indexar', run: async () => ({ blob: 'x'.repeat(40_000) }) }],
        { store },
      ),
    ).rejects.toThrow(/Guardá el resultado en su tabla y devolvé el identificador/)
  })

  it('con persist:false marca la etapa hecha pero no guarda el resultado', async () => {
    const store = memoryStore()
    const efecto = vi.fn(async () => ({ enorme: true }))

    const resultados = await runStages(
      fakeContext(),
      [{ name: 'subir', persist: false, run: efecto }],
      { store },
    )

    expect(resultados).toEqual({})
    expect(completedStages(store.current)).toEqual(['subir'])

    await runStages(fakeContext(), [{ name: 'subir', persist: false, run: efecto }], { store })
    expect(efecto).toHaveBeenCalledTimes(1)
  })

  it('no deja definir dos etapas con el mismo nombre', async () => {
    await expect(
      runStages(
        fakeContext(),
        [
          { name: 'x', run: async () => null },
          { name: 'x', run: async () => null },
        ],
        { store: memoryStore() },
      ),
    ).rejects.toThrow(/dos etapas con el mismo nombre/)
  })

  it('corta cuando el worker se está apagando', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      runStages(fakeContext({ signal: controller.signal }), [{ name: 'x', run: async () => null }], {
        store: memoryStore(),
      }),
    ).rejects.toThrow(/se estaba apagando/)
  })

  it('clearStageResults borra el avance', async () => {
    const store = memoryStore()
    await runStages(fakeContext(), [{ name: 'x', run: async () => 1 }], { store })
    expect(completedStages(store.current)).toEqual(['x'])

    await clearStageResults('job-1', { store })
    expect(store.current[STAGE_RESULTS_KEY]).toBeUndefined()
  })
})
