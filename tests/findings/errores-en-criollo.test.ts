import { describe, expect, it } from 'vitest'
import { esTextoTecnico, traducirErrorTecnico, detectarJerga } from '@/content/lenguaje'
import { estadoDeRevision, type JobView, type RunView } from '@/components/findings/view'

/**
 * Regla dura: **cero jerga en texto visible al usuario.**
 *
 * El mensaje de una corrida fallada se mostraba tal cual lo devolvía el motor,
 * así que a alguien que no escribe código le podía llegar un error crudo de
 * Postgres en inglés. Estos tests son la red de eso.
 */

/** Cosas que un motor real escupe y que nunca pueden llegar así a la pantalla. */
const CRUDOS = [
  'error: permission denied for table findings_caughtcode',
  'ERROR:  relation "public.projects_caughtcode" does not exist\nLINE 1: select * from public.projects_caughtcode',
  'duplicate key value violates unique constraint "analysis_runs_pkey"',
  'null value in column "project_id" violates not-null constraint',
  'FATAL: password authentication failed for user "postgres"',
  'connect ECONNREFUSED 127.0.0.1:5432',
  'Error: getaddrinfo ENOTFOUND db.abcdefg.supabase.co',
  'TypeError: Cannot read properties of undefined (reading \'rows\')\n    at leerIndice (/app/.next/server/chunks/1234.js:8:21)',
  'canceling statement due to statement timeout',
  'FetchError: request to https://api.example.com failed, reason: socket hang up\n    at ClientRequest.emit (node:events:518:28)',
  'PGRST116: JSON object requested, multiple (or no) rows returned',
]

describe('ningún error crudo llega tal cual a la pantalla', () => {
  it('los reconoce a todos como texto de máquina', () => {
    for (const crudo of CRUDOS) {
      expect(esTextoTecnico(crudo), `no lo detectó: "${crudo.slice(0, 60)}"`).toBe(true)
    }
  })

  it('el mensaje visible nunca es el texto original, y el original no se pierde', () => {
    for (const crudo of CRUDOS) {
      const legible = traducirErrorTecnico(crudo)!

      expect(legible.mensaje, `se mostró crudo: "${crudo.slice(0, 60)}"`).not.toBe(crudo)
      // No se borra información de diagnóstico: se reubica detrás del plegable.
      expect(legible.detalle).toBe(crudo)
    }
  })

  it('el mensaje visible está en castellano y sin jerga', () => {
    for (const crudo of CRUDOS) {
      const { mensaje } = traducirErrorTecnico(crudo)!

      expect(detectarJerga(mensaje), `jerga en: "${mensaje}"`).toEqual([])
      // Los rastros más obvios de un error de base de datos, fuera.
      expect(mensaje).not.toMatch(/\b(ERROR|FATAL|LINE \d|select |constraint|relation)\b/)
      expect(mensaje).not.toMatch(/_caughtcode\b/)
    }
  })

  it('cada mensaje visible termina en algo que el usuario puede hacer', () => {
    for (const crudo of CRUDOS) {
      const { mensaje } = traducirErrorTecnico(crudo)!
      // O le decimos qué tocar, o le decimos honestamente que lo miramos
      // nosotros. Lo que no existe es el diagnóstico sin salida.
      expect(mensaje, `sin salida: "${mensaje}"`).toMatch(
        /prob[áa] de nuevo|revisala|escribinos|volv[ée]|fijate|ped[íi]le|esper[áa]|subí|mirar?mos|miramos/i,
      )
    }
  })
})

describe('traducciones que sí sabemos hacer', () => {
  it('no llegar a la app se explica como no llegar a la app', () => {
    const { mensaje } = traducirErrorTecnico('connect ECONNREFUSED 127.0.0.1:5432')!
    expect(mensaje).toMatch(/no pudimos conectarnos/i)
  })

  it('sin permiso de lectura se explica como falta de permiso', () => {
    const { mensaje } = traducirErrorTecnico('permission denied for table projects_caughtcode')!
    expect(mensaje).toMatch(/permiso/i)
  })

  it('las credenciales rechazadas mandan a revisarlas donde se cargan', () => {
    const { mensaje } = traducirErrorTecnico('FATAL: password authentication failed')!
    expect(mensaje).toMatch(/ajustes del proyecto/i)
  })
})

describe('lo que no entendemos se admite, no se inventa', () => {
  it('un error técnico desconocido no recibe una causa fabricada', () => {
    const raro = 'ERROR: XX000 internal wal writer state corrupted at lsn 0/AF3B2C1'
    const { mensaje, detalle } = traducirErrorTecnico(raro)!

    expect(mensaje).toMatch(/no sabemos explicar/i)
    // Nada de atribuirle la causa al usuario ni a su app cuando no la sabemos.
    expect(mensaje).not.toMatch(/tu (base|app|c[óo]digo|repositorio)/i)
    expect(detalle).toBe(raro)
  })
})

describe('lo que ya está en criollo pasa intacto', () => {
  it('un mensaje nuestro no se traduce ni se pliega', () => {
    const nuestro = 'Ese repositorio es privado y no nos diste acceso.'
    expect(traducirErrorTecnico(nuestro)).toEqual({ mensaje: nuestro, detalle: null })
  })

  it('sin motivo no inventamos uno', () => {
    expect(traducirErrorTecnico(null)).toBeNull()
    expect(traducirErrorTecnico('   ')).toBeNull()
  })
})

/* ── El camino completo, desde la corrida hasta la pantalla ────────────── */

describe('estadoDeRevision entrega el motivo ya traducido', () => {
  const run = (over: Partial<RunView> = {}): RunView => ({
    id: 'r1',
    status: 'failed',
    stage: null,
    progress: 0,
    finishedAt: '2026-08-09T10:05:00.000Z',
    error: null,
    ...over,
  })

  const job = (over: Partial<JobView> = {}): JobView => ({
    id: 'j1',
    kind: 'ingest_repo',
    status: 'failed',
    lastError: null,
    createdAt: '2026-08-09T10:00:00.000Z',
    updatedAt: '2026-08-09T10:00:00.000Z',
    ...over,
  })

  it('un error crudo de Postgres en la corrida no sale crudo del modelo de vista', () => {
    const crudo = 'ERROR: permission denied for table findings_caughtcode'
    const estado = estadoDeRevision(run({ error: crudo }), [])

    expect(estado.fase).toBe('fallada')
    if (estado.fase !== 'fallada') return
    expect(estado.motivo?.mensaje).not.toBe(crudo)
    expect(estado.motivo?.mensaje).toMatch(/permiso/i)
    expect(estado.motivo?.detalle).toBe(crudo)
  })

  it('lo mismo cuando el crudo viene del trabajo y no de la corrida', () => {
    const crudo = 'Error: getaddrinfo ENOTFOUND db.abcdefg.supabase.co'
    const estado = estadoDeRevision(null, [job({ lastError: crudo })])

    expect(estado.fase).toBe('fallada')
    if (estado.fase !== 'fallada') return
    expect(estado.motivo?.mensaje).not.toBe(crudo)
    expect(estado.motivo?.detalle).toBe(crudo)
  })
})
