/**
 * El agente de verdad, corriendo contra la app rota de `tests/fixtures/app-rota`.
 *
 * Sin ANTHROPIC_API_KEY no se llama a ningún modelo: se inyecta una función `complete`
 * falsa y determinística que devuelve acciones fijas. El resto del circuito —navegador,
 * grabación, barreras, pasos, conclusiones— es exactamente el de producción.
 *
 * Lo que se verifica acá es lo que el producto promete:
 *  - detecta que falta el flujo de recuperar contraseña
 *  - detecta que no existe el borrado de cuenta
 *  - detecta el acceso indebido a /factura/2
 *  - deja un video que se puede abrir
 *  - los `atMs` de los pasos coinciden con lo que se ve en la grabación
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runAgentSession } from '@/server/agent'
import type { AgentSessionResult } from '@/lib/types/domain'
import type { LlmComplete, RecordingManifest } from '@/server/agent/types'
import { startBrokenApp, type BrokenApp } from '../fixtures/app-rota/server'
import { frameAt, hasFfmpeg, imageFingerprint, isBlank, pixelDistance, videoDurationMs } from './video-frames'
import { CLOCK_TOLERANCE_MS } from '@/server/agent'

const TIMEOUT = 240_000

/**
 * Modelo falso. Lee la lista de elementos que le manda el agente, busca por nombre
 * el elemento del guion y devuelve la acción con su referencia real. Es
 * determinístico: el mismo árbol produce siempre la misma acción.
 */
function fakeModel(): { complete: LlmComplete; calls: number } {
  const script = [
    // 1) Debe rebotar contra la barrera de acciones destructivas.
    { find: 'Vaciar historial de facturas', action: 'click', why: 'quiero ver qué hace este botón' },
    // 2) Navegación normal.
    { find: 'Ver reportes', action: 'click', why: 'entro a la sección principal' },
    // 3) Fin.
    { find: null, action: 'done', why: 'llegué a los reportes y vi el resumen del mes' },
  ]
  let index = 0
  const state = { calls: 0 }

  const complete: LlmComplete = async (prompt: string) => {
    state.calls += 1
    const step = script[Math.min(index, script.length - 1)]
    index += 1

    if (!step.find) {
      return JSON.stringify({ action: step.action, why: step.why })
    }

    const escaped = step.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = prompt.match(new RegExp(`- (?:button|link) "${escaped}[^"]*" \\[ref=(e\\d+)\\]`))
    if (!match) {
      return JSON.stringify({ action: 'done', why: 'no encontré por dónde seguir' })
    }
    return JSON.stringify({
      action: step.action,
      selector: `ref=${match[1]}`,
      why: step.why,
    })
  }

  return { complete, get calls() { return state.calls } }
}

describe('el agente contra una app rota', () => {
  let app: BrokenApp
  let workspaceDir: string
  let results: AgentSessionResult[]
  let model: ReturnType<typeof fakeModel>

  beforeAll(async () => {
    app = await startBrokenApp()
    workspaceDir = await mkdtemp(path.join(tmpdir(), 'caughtcode-agente-'))
    model = fakeModel()

    results = await runAgentSession({
      deployedUrl: app.url,
      workspaceDir,
      tasks: [
        'cookie_banner',
        'privacy_terms',
        'primary_flow',
        'password_reset',
        'logout',
        'delete_account',
        'cross_tenant_read',
      ],
      testCredentials: {
        createdWithPermission: true,
        accounts: [
          { label: 'a', email: app.users[0].email, password: app.users[0].password },
          { label: 'b', email: app.users[1].email, password: app.users[1].password },
        ],
      },
      allowDestructive: false,
      complete: model.complete,
      offlineExternal: true,
      headless: true,
      costCapUsd: 5,
    })
  }, TIMEOUT)

  afterAll(async () => {
    await app?.close()
    if (workspaceDir) await rm(workspaceDir, { recursive: true, force: true }).catch(() => {})
  })

  const find = (taskId: string) => results.find((result) => result.taskId === taskId)!

  it('corre las siete tareas pedidas', () => {
    expect(results.map((result) => result.taskId)).toEqual([
      'cookie_banner',
      'privacy_terms',
      'primary_flow',
      'password_reset',
      'logout',
      'delete_account',
      'cross_tenant_read',
    ])
  })

  it('detecta que no hay forma de recuperar la contraseña', () => {
    const result = find('password_reset')
    expect(result.outcome).toBe('not_found')
    expect(result.conclusionPlain).toContain('recuperar')
    expect(result.conclusionPlain).toContain('la pantalla de ingreso')
    expect(result.steps.length).toBeGreaterThan(2)
  })

  it('detecta que no existe el borrado de cuenta y dice dónde buscó', () => {
    const result = find('delete_account')
    expect(result.outcome).toBe('not_found')
    expect(result.conclusionPlain).toContain('No existe la opción')
    expect(result.conclusionPlain).toMatch(/ajustes|cuenta|perfil/)
  })

  it('detecta el acceso indebido a la factura de otra persona', () => {
    const result = find('cross_tenant_read')
    expect(result.outcome).toBe('completed')
    expect(result.conclusionPlain).toContain('/factura/2')
    expect(result.conclusionPlain).toContain('Factura 2')
    const expuesto = result.steps.find((step) => step.action === 'exposed')
    expect(expuesto).toBeDefined()
    expect(expuesto?.url).toContain('/factura/2')
  })

  it('detecta rastreadores disparados antes de aceptar el cartel', () => {
    const result = find('cookie_banner')
    expect(result.outcome).toBe('completed')
    expect(result.conclusionPlain).toContain('antes de tocar el cartel')
    expect(result.conclusionPlain).toMatch(/Google/)
  })

  it('detecta que faltan los términos pero encuentra la privacidad', () => {
    const result = find('privacy_terms')
    expect(result.outcome).toBe('not_found')
    expect(result.conclusionPlain).toContain('privacidad')
    expect(result.conclusionPlain).toContain('términos')
  })

  it('confirma lo que sí funciona: se puede cerrar sesión', () => {
    const result = find('logout')
    expect(result.outcome).toBe('completed')
    expect(result.conclusionPlain).toContain('cerré la sesión')
  })

  it('frena el botón destructivo aunque el modelo lo pida', () => {
    const result = find('primary_flow')
    const bloqueado = result.steps.find((step) => step.action === 'blocked')
    expect(bloqueado).toBeDefined()
    expect(bloqueado?.note).toContain('borrar')
    expect(model.calls).toBeGreaterThan(1)
  })

  it('mira la app en un teléfono y ve que se va para el costado', () => {
    const result = find('primary_flow')
    expect(result.conclusionPlain).toContain('teléfono')
  })

  it('no gasta de más', () => {
    const total = results.reduce((sum, result) => sum + result.costUsd, 0)
    expect(total).toBeLessThan(0.5)
  })

  it('deja una grabación que se puede abrir en cada tarea que corrió', async () => {
    const conVideo = results.filter((result) => result.recordingPath)
    expect(conVideo.length).toBeGreaterThanOrEqual(6)

    for (const result of conVideo) {
      const info = await stat(result.recordingPath!)
      expect(info.size).toBeGreaterThan(1000)
      const header = await readFile(result.recordingPath!)
      // Firma de un contenedor Matroska/WebM.
      expect([...header.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3])
    }
  })

  it('deja el resumen de tiempos junto al video', async () => {
    const raw = await readFile(path.join(workspaceDir, 'agent', 'cross_tenant_read', 'recording.json'), 'utf8')
    const manifest = JSON.parse(raw) as RecordingManifest

    expect(manifest.taskId).toBe('cross_tenant_read')
    expect(manifest.videoPath).toBeTruthy()
    expect(manifest.viewport).toEqual({ width: 1280, height: 800 })
    // El margen con el que el frente de video tiene que recortar los clips.
    expect(manifest.clockToleranceMs).toBeGreaterThan(0)
    expect(manifest.steps.length).toBeGreaterThan(3)

    const times = manifest.steps.map((step) => step.atMs)
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(times[0]).toBeGreaterThanOrEqual(0)
    expect(times[times.length - 1]).toBeLessThanOrEqual(manifest.wallDurationMs)
  })

  it.runIf(hasFfmpeg)(
    'los tiempos de los pasos apuntan al momento correcto de la grabación',
    async () => {
      const result = find('cross_tenant_read')
      const video = result.recordingPath!

      const duration = await videoDurationMs(video)
      expect(duration).toBeGreaterThan(0)

      // El paso que muestra la factura ajena: es la pantalla que aparece una sola vez
      // en toda la grabación, así que su mejor coincidencia no puede ser ambigua.
      const expuesto = result.steps.find((step) => step.action === 'exposed' && step.screenshotPath)!
      expect(expuesto).toBeDefined()

      // La línea de tiempo de los pasos tiene que caber dentro del video.
      expect(duration + CLOCK_TOLERANCE_MS).toBeGreaterThanOrEqual(expuesto.atMs)

      const cuadro = await frameAt(video, expuesto.atMs)
      expect(isBlank(cuadro)).toBe(false)

      // Se busca en TODA la grabación en qué momento se ve esa pantalla y se compara
      // con el `atMs` anotado. Si los tiempos estuvieran mal, el mejor cuadro caería
      // en cualquier otro lado del video.
      const captura = await imageFingerprint(expuesto.screenshotPath!)
      let mejor = { posicion: -1, distancia: Number.POSITIVE_INFINITY }
      for (let posicion = 0; posicion <= duration; posicion += 80) {
        const distancia = pixelDistance(await frameAt(video, posicion), captura)
        if (distancia < mejor.distancia) mejor = { posicion, distancia }
      }

      // La pantalla existe de verdad en el video (no es un cuadro cualquiera).
      expect(mejor.distancia).toBeLessThan(1)
      // Y aparece dentro del margen declarado en el resumen de tiempos.
      expect(Math.abs(mejor.posicion - expuesto.atMs)).toBeLessThanOrEqual(CLOCK_TOLERANCE_MS)
    },
    TIMEOUT,
  )
})

describe('la app no responde', () => {
  it('lo reporta como resultado, no como error', async () => {
    const workspaceDir = await mkdtemp(path.join(tmpdir(), 'caughtcode-caida-'))
    try {
      const results = await runAgentSession({
        deployedUrl: 'http://127.0.0.1:1',
        workspaceDir,
        tasks: ['cookie_banner', 'privacy_terms'],
        complete: async () => JSON.stringify({ action: 'give_up', why: 'nada' }),
        offlineExternal: true,
        headless: true,
      })

      expect(results).toHaveLength(2)
      for (const result of results) {
        expect(result.outcome).toBe('blocked')
        expect(result.conclusionPlain).toContain('No pude abrir tu app')
      }
    } finally {
      await rm(workspaceDir, { recursive: true, force: true }).catch(() => {})
    }
  }, 60_000)
})

describe('sin cuentas de prueba autorizadas', () => {
  it('no entra a ningún lado y lo dice claro', async () => {
    const app = await startBrokenApp()
    const workspaceDir = await mkdtemp(path.join(tmpdir(), 'caughtcode-sincuenta-'))
    try {
      const results = await runAgentSession({
        deployedUrl: app.url,
        workspaceDir,
        tasks: ['logout', 'delete_account', 'signup'],
        // Las cuentas existen pero el usuario NO confirmó su creación.
        testCredentials: {
          createdWithPermission: false,
          accounts: [{ label: 'a', email: app.users[0].email, password: app.users[0].password }],
        },
        allowDestructive: false,
        complete: async () => JSON.stringify({ action: 'give_up', why: 'nada' }),
        offlineExternal: true,
        headless: true,
      })

      expect(results.find((result) => result.taskId === 'logout')?.outcome).toBe('blocked')
      expect(results.find((result) => result.taskId === 'delete_account')?.outcome).toBe('blocked')

      const signup = results.find((result) => result.taskId === 'signup')!
      expect(signup.outcome).toBe('skipped')
      expect(signup.conclusionPlain).toContain('visto bueno')
    } finally {
      await app.close()
      await rm(workspaceDir, { recursive: true, force: true }).catch(() => {})
    }
  }, 90_000)
})
