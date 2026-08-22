import { describe, expect, it } from 'vitest'
import {
  GRACIA_CIERRE_MS,
  MAX_DESTACADOS,
  UMBRAL_SIN_LATIDO_MS,
  agruparPorPilar,
  corridaAbandonada,
  cueActivo,
  cuesDelGuion,
  estaCorriendo,
  estadoDeRevision,
  filtrarCues,
  ordenarHallazgos,
  partirHallazgos,
  peorGravedad,
  reloj,
  seCorto,
  terminoAMedias,
  tieneEvidencia,
  trabajoSinLatido,
  type JobView,
  type RunView,
} from '@/components/findings/view'
import { TEXTOS_VISIBLES } from '@/components/findings/copy'
import { HALLAZGOS_DEMO, VIDEOS_DEMO, datosDemo } from '@/components/findings/fixtures'
import { ESTADOS } from '@/content/copy'
import { detectarJerga } from '@/content/lenguaje'
import type { Confidence, Finding, FindingStatus, Pillar, Severity } from '@/lib/types/domain'

function hallazgo(over: Partial<Finding> & { id: string }): Finding {
  return {
    analysisRunId: 'run',
    pillar: 'security' as Pillar,
    checkId: 'x',
    severity: 'medium' as Severity,
    confidence: 'confirmed' as Confidence,
    status: 'open' as FindingStatus,
    titlePlain: 'Título',
    explanationPlain: 'Explicación',
    impactPlain: 'Consecuencia',
    fixPrompt: 'Arreglo',
    evidence: [{ kind: 'code', file: 'a.ts', line: 1 }],
    rank: 99,
    createdAt: '2026-08-09T00:00:00.000Z',
    ...over,
  }
}

/* ── Regla de los tres destacados (D15) ────────────────────────────────── */

describe('partirHallazgos — máximo tres destacados', () => {
  it('nunca destaca más de tres, aunque lleguen más marcados', () => {
    // La base tiene un tope, pero la pantalla no confía en eso: si el tope
    // fallara, el usuario igual tiene que ver tres cosas y no seis.
    const findings = [1, 2, 3, 1, 2, 3].map((rank, i) =>
      hallazgo({ id: `f${i}`, rank, severity: 'critical' }),
    )

    const { destacados, resto } = partirHallazgos(findings)

    expect(destacados).toHaveLength(MAX_DESTACADOS)
    expect(destacados.length + resto.length).toBe(findings.length)
  })

  it('destaca solo los de posición 1..3 y manda el resto a segundo plano', () => {
    const findings = [
      hallazgo({ id: 'a', rank: 2 }),
      hallazgo({ id: 'b', rank: 7 }),
      hallazgo({ id: 'c', rank: 1 }),
      hallazgo({ id: 'd', rank: 4 }),
      hallazgo({ id: 'e', rank: 3 }),
    ]

    const { destacados, resto } = partirHallazgos(findings)

    expect(destacados.map((f) => f.id)).toEqual(['c', 'a', 'e'])
    expect(resto.map((f) => f.id)).toEqual(['d', 'b'])
  })

  it('un hallazgo cerrado no ocupa un lugar entre los destacados', () => {
    const findings = [
      hallazgo({ id: 'resuelto', rank: 1, status: 'fixed' }),
      hallazgo({ id: 'descartado', rank: 2, status: 'dismissed' }),
      hallazgo({ id: 'abierto', rank: 3 }),
    ]

    const { destacados, cerrados } = partirHallazgos(findings)

    expect(destacados.map((f) => f.id)).toEqual(['abierto'])
    expect(cerrados.map((f) => f.id)).toEqual(['resuelto', 'descartado'])
  })

  it('sin hallazgos no destaca nada y no rompe', () => {
    expect(partirHallazgos([])).toEqual({ destacados: [], resto: [], cerrados: [] })
  })

  it('los ejemplos de la demostración respetan el tope', () => {
    for (const estado of ['listo', 'corriendo', 'vacio'] as const) {
      const { findings } = datosDemo(estado)
      expect(partirHallazgos(findings).destacados.length).toBeLessThanOrEqual(MAX_DESTACADOS)
    }
  })
})

describe('estado de la corrida', () => {
  const run = (status: RunView['status']): RunView => ({
    id: 'r',
    status,
    stage: null,
    progress: 0,
    finishedAt: null,
    error: null,
  })

  it('sabe cuándo sigue trabajando', () => {
    expect(estaCorriendo(run('queued'))).toBe(true)
    expect(estaCorriendo(run('running'))).toBe(true)
    expect(estaCorriendo(run('succeeded'))).toBe(false)
    expect(estaCorriendo(null)).toBe(false)
  })

  it('distingue “se cortó” de “no encontró nada”', () => {
    // Si la revisión se cortó, la pantalla no puede decir "no hay nada serio":
    // sería afirmar algo que no comprobamos.
    expect(seCorto(run('failed'))).toBe(true)
    expect(seCorto(run('cancelled'))).toBe(true)
    expect(seCorto(run('succeeded'))).toBe(false)
    expect(terminoAMedias(run('partial'))).toBe(true)
  })
})

/* ── En qué punto está la revisión (regla dura: nada sin evidencia) ─────── */

describe('estadoDeRevision', () => {
  const run = (over: Partial<RunView> = {}): RunView => ({
    id: 'r',
    status: 'succeeded',
    stage: null,
    progress: 100,
    finishedAt: null,
    error: null,
    ...over,
  })

  const job = (over: Partial<JobView> = {}): JobView => ({
    id: 'j',
    kind: 'ingest_repo',
    status: 'queued',
    lastError: null,
    createdAt: '2026-08-09T10:00:00.000Z',
    updatedAt: '2026-08-09T10:00:00.000Z',
    ...over,
  })

  it('sin corrida y sin trabajos: nunca se revisó, y así hay que decirlo', () => {
    // Este es el bug que motivó todo esto. Antes acá la pantalla decía "no
    // encontramos nada serio" sobre una app que nadie había mirado.
    expect(estadoDeRevision(null, [])).toEqual({ fase: 'sin-revisar' })
    expect(estadoDeRevision(null)).toEqual({ fase: 'sin-revisar' })
  })

  it('con trabajo esperando y sin corrida: está en la fila', () => {
    expect(estadoDeRevision(null, [job({ status: 'queued' })])).toEqual({ fase: 'en-cola' })
    expect(estadoDeRevision(null, [job({ status: 'running' })])).toEqual({ fase: 'en-cola' })
  })

  it('con el trabajo fallado y sin corrida: falló, y el motivo es el del trabajo', () => {
    const trabajos = [job({ status: 'failed', lastError: 'Ese repositorio es privado.' })]
    // Ya está en criollo: pasa tal cual y no hay detalle técnico que plegar.
    expect(estadoDeRevision(null, trabajos)).toEqual({
      fase: 'fallada',
      motivo: { mensaje: 'Ese repositorio es privado.', detalle: null },
    })
  })

  it('un reintento pisa al fallo anterior: vuelve a estar en la fila', () => {
    const trabajos = [
      job({ id: 'viejo', status: 'failed', lastError: 'Algo pasó.', createdAt: '2026-08-09T10:00:00.000Z' }),
      job({ id: 'nuevo', status: 'queued', createdAt: '2026-08-09T11:00:00.000Z' }),
    ]
    expect(estadoDeRevision(null, trabajos)).toEqual({ fase: 'en-cola' })
  })

  it('la corrida en marcha manda sobre la cola', () => {
    const enMarcha = run({ status: 'running' })
    expect(estadoDeRevision(enMarcha, [job({ status: 'queued' })])).toEqual({
      fase: 'corriendo',
      run: enMarcha,
    })
    expect(estadoDeRevision(run({ status: 'queued' }), []).fase).toBe('corriendo')
  })

  it('corrida cortada: falla, y prefiere el motivo de la corrida al del trabajo', () => {
    const cortada = run({ status: 'failed', error: 'No pudimos entrar a tu app.' })
    const trabajos = [job({ status: 'failed', lastError: 'Otro motivo.' })]
    expect(estadoDeRevision(cortada, trabajos)).toEqual({
      fase: 'fallada',
      motivo: { mensaje: 'No pudimos entrar a tu app.', detalle: null },
    })
  })

  it('corrida cortada sin motivo propio: usa el del trabajo que falló', () => {
    const cortada = run({ status: 'cancelled', error: null })
    const trabajos = [job({ status: 'failed', lastError: 'Se acabó el tiempo.' })]
    expect(estadoDeRevision(cortada, trabajos)).toEqual({
      fase: 'fallada',
      motivo: { mensaje: 'Se acabó el tiempo.', detalle: null },
    })
  })

  it('corrida terminada: recién acá se puede hablar de lo que se encontró', () => {
    const terminada = run({ status: 'succeeded' })
    expect(estadoDeRevision(terminada, [])).toEqual({ fase: 'lista', run: terminada })
    expect(estadoDeRevision(run({ status: 'partial' }), []).fase).toBe('lista')
  })

  it('un video que no se pudo armar no convierte una revisión buena en fallada', () => {
    // El video es un refuerzo. Si la revisión terminó, los hallazgos valen y no
    // se pueden tapar con un cartel de error.
    const trabajos = [job({ kind: 'generate_video', status: 'failed', lastError: 'No salió.' })]
    expect(estadoDeRevision(run({ status: 'succeeded' }), trabajos).fase).toBe('lista')
  })

  it('un escaneo de comentarios fallado es de otra pantalla y no cuenta acá', () => {
    const trabajos = [job({ kind: 'scan_comments', status: 'failed', lastError: 'No salió.' })]
    expect(estadoDeRevision(null, trabajos)).toEqual({ fase: 'sin-revisar' })
  })

  it('los tres estados previos de la demostración salen distintos', () => {
    const fases = (['sin-revisar', 'en-cola', 'revision-fallada'] as const).map((estado) => {
      const { run: r, trabajos } = datosDemo(estado)
      return estadoDeRevision(r, trabajos).fase
    })
    expect(fases).toEqual(['sin-revisar', 'en-cola', 'fallada'])
  })

  it('el estado vacío de la demostración sí tiene una corrida terminada detrás', () => {
    // "No encontramos nada serio" solo se puede decir con una revisión completa.
    const { run: r, trabajos } = datosDemo('vacio')
    expect(estadoDeRevision(r, trabajos)).toEqual({ fase: 'lista', run: r })
    expect(r?.status).toBe('succeeded')
  })
})

/* ── Corrida abandonada: la base dice "corriendo" pero dejó de latir ────── */

describe('trabajoSinLatido / corridaAbandonada', () => {
  const AHORA = Date.parse('2026-08-12T12:00:00.000Z')

  const run = (over: Partial<RunView> = {}): RunView => ({
    id: 'r',
    status: 'running',
    stage: 'Probando algo',
    progress: 40,
    finishedAt: null,
    error: null,
    ...over,
  })

  const job = (over: Partial<JobView> = {}): JobView => ({
    id: 'j',
    kind: 'run_checks',
    status: 'running',
    lastError: null,
    createdAt: '2026-08-12T11:50:00.000Z',
    updatedAt: '2026-08-12T11:50:00.000Z',
    ...over,
  })

  /** `AHORA` menos `ms`, como ISO — para construir el último latido. */
  const latidoHaceMs = (ms: number) => new Date(AHORA - ms).toISOString()

  describe('trabajoSinLatido', () => {
    it('un trabajo que no está "corriendo" nunca está sin latido', () => {
      expect(trabajoSinLatido(job({ status: 'queued' }), AHORA)).toBe(false)
      expect(trabajoSinLatido(job({ status: 'succeeded' }), AHORA)).toBe(false)
      expect(trabajoSinLatido(job({ status: 'failed' }), AHORA)).toBe(false)
    })

    it('justo en el borde del umbral todavía no cuenta como sin latido', () => {
      const trabajo = job({ status: 'running', updatedAt: latidoHaceMs(UMBRAL_SIN_LATIDO_MS) })
      expect(trabajoSinLatido(trabajo, AHORA)).toBe(false)
    })

    it('un milisegundo pasado el umbral, ya no hay duda', () => {
      const trabajo = job({
        status: 'running',
        updatedAt: latidoHaceMs(UMBRAL_SIN_LATIDO_MS + 1),
      })
      expect(trabajoSinLatido(trabajo, AHORA)).toBe(true)
    })

    it('un latido reciente no cuenta como muerto', () => {
      const trabajo = job({ status: 'running', updatedAt: latidoHaceMs(15_000) })
      expect(trabajoSinLatido(trabajo, AHORA)).toBe(false)
    })
  })

  describe('corridaAbandonada', () => {
    it('una corrida que no está "corriendo" nunca está abandonada', () => {
      expect(corridaAbandonada(run({ status: 'succeeded' }), [], AHORA)).toBe(false)
      expect(corridaAbandonada(null, [job()], AHORA)).toBe(false)
    })

    it('sin ningún trabajo propio no afirma nada: sin datos, no hay abandono', () => {
      expect(corridaAbandonada(run(), [], AHORA)).toBe(false)
      // Un trabajo de otra pantalla (scan_comments) tampoco cuenta como propio.
      const ajeno = job({ kind: 'scan_comments', status: 'running', updatedAt: latidoHaceMs(999_999) })
      expect(corridaAbandonada(run(), [ajeno], AHORA)).toBe(false)
    })

    it('el trabajo sigue latiendo: no está abandonada', () => {
      const trabajo = job({ status: 'running', updatedAt: latidoHaceMs(15_000) })
      expect(corridaAbandonada(run(), [trabajo], AHORA)).toBe(false)
    })

    it('el trabajo dejó de latir hace más del umbral: abandonada', () => {
      const trabajo = job({
        status: 'running',
        updatedAt: latidoHaceMs(UMBRAL_SIN_LATIDO_MS + 60_000),
      })
      expect(corridaAbandonada(run(), [trabajo], AHORA)).toBe(true)
    })

    it('esperando que lo tome un trabajador: todavía no es abandono', () => {
      // Encolado hace rato, sí, pero encolado no es lo mismo que muerto: puede
      // seguir esperando lugar, igual que en `estadoDeRevision`.
      const trabajo = job({ status: 'queued', updatedAt: latidoHaceMs(999_999) })
      expect(corridaAbandonada(run(), [trabajo], AHORA)).toBe(false)
    })

    it('todos terminaron recién y la corrida sigue abierta: se le da tiempo al servidor', () => {
      // `barrerCorridasHuerfanas()` la cierra sola en el próximo tick. Acusarla
      // en el instante cero es correr una carrera contra el propio servidor: el
      // cartel de error se convertiría en un informe exitoso a los segundos.
      const terminado = job({ status: 'succeeded', updatedAt: latidoHaceMs(15_000) })
      expect(corridaAbandonada(run(), [terminado], AHORA)).toBe(false)
    })

    it('todos terminaron hace rato y nadie cerró la corrida: abandonada', () => {
      // Pasada la gracia ya no hay barrida que valga: nadie la va a cerrar.
      const terminado = job({
        status: 'succeeded',
        updatedAt: latidoHaceMs(GRACIA_CIERRE_MS + 1_000),
      })
      expect(corridaAbandonada(run(), [terminado], AHORA)).toBe(true)
    })

    it('la gracia se mide contra el trabajo que terminó último, no contra el más viejo', () => {
      const viejo = job({
        id: 'viejo',
        status: 'succeeded',
        createdAt: '2026-08-12T10:00:00.000Z',
        updatedAt: latidoHaceMs(GRACIA_CIERRE_MS + 60_000),
      })
      const recien = job({ id: 'recien', status: 'succeeded', updatedAt: latidoHaceMs(5_000) })
      expect(corridaAbandonada(run(), [viejo, recien], AHORA)).toBe(false)
    })

    /* ── Varios trabajos en vuelo: el abanico de videos ─────────────────── */

    it('alcanza con que uno siga latiendo, aunque sea el más viejo', () => {
      const muerto = job({
        id: 'muerto',
        createdAt: '2026-08-12T11:59:00.000Z',
        updatedAt: latidoHaceMs(UMBRAL_SIN_LATIDO_MS + 60_000),
      })
      const vivo = job({
        id: 'vivo',
        createdAt: '2026-08-12T11:50:00.000Z',
        updatedAt: latidoHaceMs(15_000),
      })
      expect(corridaAbandonada(run(), [muerto, vivo], AHORA)).toBe(false)
    })

    it('los tres videos muertos sí la dan por abandonada', () => {
      const muerto = (id: string) =>
        job({ id, kind: 'generate_video', updatedAt: latidoHaceMs(UMBRAL_SIN_LATIDO_MS + 1_000) })
      expect(corridaAbandonada(run(), [muerto('v1'), muerto('v2'), muerto('v3')], AHORA)).toBe(true)
    })

    it('un video que terminó tarde no puede tapar a otro que sigue en curso', () => {
      // El caso real: `run_checks` encola tres videos, el worker toma de a dos y
      // el tercero termina antes que el segundo. Ordenando por `createdAt`, el
      // trabajo más nuevo está `succeeded` mientras el segundo sigue vivo.
      const trabajos = [
        job({ id: 'checks', kind: 'run_checks', status: 'succeeded', createdAt: '2026-08-12T11:50:00.000Z', updatedAt: latidoHaceMs(300_000) }),
        job({ id: 'v1', kind: 'generate_video', status: 'succeeded', createdAt: '2026-08-12T11:53:00.000Z', updatedAt: latidoHaceMs(120_000) }),
        job({ id: 'v2', kind: 'generate_video', status: 'running', createdAt: '2026-08-12T11:53:01.000Z', updatedAt: latidoHaceMs(10_000) }),
        job({ id: 'v3', kind: 'generate_video', status: 'succeeded', createdAt: '2026-08-12T11:53:02.000Z', updatedAt: latidoHaceMs(30_000) }),
      ]

      expect(corridaAbandonada(run(), trabajos, AHORA)).toBe(false)
      expect(estadoDeRevision(run(), trabajos, AHORA).fase).toBe('corriendo')
    })

    it('un solo trabajo esperando turno alcanza para que no sea abandono', () => {
      // El rescate por arriendo vencido devuelve trabajos a `queued`: mientras
      // haya uno ahí, el sistema se está curando solo y no hay nada que anunciar.
      const muerto = job({ id: 'muerto', updatedAt: latidoHaceMs(UMBRAL_SIN_LATIDO_MS + 60_000) })
      const rescatado = job({ id: 'rescatado', status: 'queued', updatedAt: latidoHaceMs(5_000) })
      expect(corridaAbandonada(run(), [muerto, rescatado], AHORA)).toBe(false)
    })
  })

  it('estadoDeRevision refleja el abandono como su propia fase, sin motivo', () => {
    const enMarcha = run()
    const trabajo = job({
      status: 'running',
      updatedAt: latidoHaceMs(UMBRAL_SIN_LATIDO_MS + 60_000),
    })
    expect(estadoDeRevision(enMarcha, [trabajo], AHORA)).toEqual({
      fase: 'abandonada',
      run: enMarcha,
    })
  })

  it('con latido fresco, estadoDeRevision sigue diciendo "corriendo"', () => {
    const enMarcha = run()
    const trabajo = job({ status: 'running', updatedAt: latidoHaceMs(15_000) })
    expect(estadoDeRevision(enMarcha, [trabajo], AHORA)).toEqual({
      fase: 'corriendo',
      run: enMarcha,
    })
  })

  it('los dos estados de corte silencioso de la demostración se ven distintos entre sí', () => {
    const sinHallazgos = datosDemo('corte-silencioso')
    const conHallazgos = datosDemo('corte-silencioso-parcial')

    // Los dos están "abandonados" con el mismo reloj: 2026-08-12 es bastante
    // después del último latido fijo de la demostración (2026-08-10).
    expect(estadoDeRevision(sinHallazgos.run, sinHallazgos.trabajos, AHORA).fase).toBe('abandonada')
    expect(estadoDeRevision(conHallazgos.run, conHallazgos.trabajos, AHORA).fase).toBe('abandonada')
    expect(sinHallazgos.findings).toHaveLength(0)
    expect(conHallazgos.findings.length).toBeGreaterThan(0)
  })

  it('la demostración del abanico de videos se ve "en curso", no cortada', () => {
    const { run: r, trabajos } = datosDemo('videos-fuera-de-orden', AHORA)

    // El trabajo más nuevo terminó, pero hay otro corriendo y latiendo.
    const masNuevo = [...trabajos].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!
    expect(masNuevo.status).toBe('succeeded')
    expect(trabajos.some((t) => t.status === 'running')).toBe(true)

    expect(estadoDeRevision(r, trabajos, AHORA)).toEqual({ fase: 'corriendo', run: r })
  })
})

describe('ordenarHallazgos', () => {
  it('pone lo sin resolver antes que lo cerrado', () => {
    const orden = ordenarHallazgos([
      hallazgo({ id: 'cerrado', rank: 1, status: 'fixed' }),
      hallazgo({ id: 'abierto', rank: 9 }),
    ])
    expect(orden.map((f) => f.id)).toEqual(['abierto', 'cerrado'])
  })

  it('a igual posición, desempata por gravedad', () => {
    const orden = ordenarHallazgos([
      hallazgo({ id: 'menor', rank: 0, severity: 'low' }),
      hallazgo({ id: 'grave', rank: 0, severity: 'critical' }),
    ])
    expect(orden.map((f) => f.id)).toEqual(['grave', 'menor'])
  })

  it('no muta la lista que recibe', () => {
    const original = [hallazgo({ id: 'b', rank: 2 }), hallazgo({ id: 'a', rank: 1 })]
    ordenarHallazgos(original)
    expect(original.map((f) => f.id)).toEqual(['b', 'a'])
  })
})

describe('agruparPorPilar', () => {
  it('agrupa y deja seguridad primero, sin grupos vacíos', () => {
    const grupos = agruparPorPilar([
      hallazgo({ id: 'a', pillar: 'store_hygiene' }),
      hallazgo({ id: 'b', pillar: 'security' }),
    ])
    expect(grupos.map((g) => g.pilar)).toEqual(['security', 'store_hygiene'])
  })
})

describe('peorGravedad', () => {
  it('ignora lo ya cerrado', () => {
    const peor = peorGravedad([
      hallazgo({ id: 'a', severity: 'critical', status: 'fixed' }),
      hallazgo({ id: 'b', severity: 'low' }),
    ])
    expect(peor).toBe('low')
  })
})

/* ── Evidencia (D14) ───────────────────────────────────────────────────── */

describe('tieneEvidencia', () => {
  it('detecta un hallazgo sin prueba, que no se puede mostrar', () => {
    expect(tieneEvidencia({ evidence: [] })).toBe(false)
    expect(tieneEvidencia(hallazgo({ id: 'a' }))).toBe(true)
  })

  it('todos los ejemplos de la demostración traen su prueba', () => {
    for (const f of HALLAZGOS_DEMO) {
      expect(tieneEvidencia(f), `"${f.titlePlain}" llegó sin evidencia`).toBe(true)
    }
  })
})

/* ── Subtítulos y transcripción ────────────────────────────────────────── */

describe('cuesDelGuion', () => {
  it('acumula las duraciones para saber cuándo entra cada línea', () => {
    const cues = cuesDelGuion(VIDEOS_DEMO['f-cross-tenant']!.script)
    expect(cues[0]!.startSeconds).toBe(0)
    expect(cues[1]!.startSeconds).toBe(cues[0]!.endSeconds)
    expect(cues.at(-1)!.endSeconds).toBeGreaterThan(0)
  })

  it('sin guion no inventa subtítulos', () => {
    expect(cuesDelGuion(null)).toEqual([])
  })

  it('encuentra la línea que suena en un momento dado', () => {
    const cues = cuesDelGuion(VIDEOS_DEMO['f-cross-tenant']!.script)
    expect(cueActivo(cues, 0)?.id).toBe(cues[0]!.id)
    expect(cueActivo(cues, cues[1]!.startSeconds + 0.5)?.id).toBe(cues[1]!.id)
    expect(cueActivo(cues, 99_999)).toBeNull()
  })

  it('busca sin importar acentos ni mayúsculas', () => {
    const cues = cuesDelGuion(VIDEOS_DEMO['f-cross-tenant']!.script)
    expect(filtrarCues(cues, 'DIRECCION').length).toBeGreaterThan(0)
    expect(filtrarCues(cues, '').length).toBe(cues.length)
  })
})

describe('reloj', () => {
  it('formatea en minutos y segundos', () => {
    expect(reloj(0)).toBe('0:00')
    expect(reloj(9)).toBe('0:09')
    expect(reloj(75)).toBe('1:15')
  })

  it('aguanta valores que todavía no existen', () => {
    expect(reloj(Number.NaN)).toBe('0:00')
    expect(reloj(-3)).toBe('0:00')
  })
})

/* ── Cero jerga en pantalla ────────────────────────────────────────────── */

describe('cero jerga en texto visible', () => {
  it('los rótulos y botones de la pantalla no tienen jerga', () => {
    for (const texto of TEXTOS_VISIBLES) {
      expect(detectarJerga(texto), `jerga en: "${texto}"`).toEqual([])
    }
  })

  it('los estados que muestra la pantalla no tienen jerga', () => {
    const usados = [
      ESTADOS.cargando,
      ESTADOS.vacioHallazgos,
      ESTADOS.error,
      ESTADOS.sinPermisos,
      ESTADOS.repoDemasiadoGrande,
      ESTADOS.jobFallado,
    ]
    for (const estado of usados) {
      for (const texto of Object.values(estado)) {
        expect(detectarJerga(texto), `jerga en: "${texto}"`).toEqual([])
      }
    }
  })

  it('el contenido de los hallazgos que se muestra no tiene jerga', () => {
    // El prompt de arreglo queda afuera a propósito: va dirigido al asistente
    // del usuario, no al usuario, y ahí los términos técnicos son necesarios.
    for (const f of HALLAZGOS_DEMO) {
      for (const texto of [f.titlePlain, f.explanationPlain, f.impactPlain]) {
        expect(detectarJerga(texto), `jerga en "${f.checkId}": "${texto}"`).toEqual([])
      }
    }
  })

  it('la prueba que se muestra tampoco tiene jerga', () => {
    for (const f of HALLAZGOS_DEMO) {
      for (const prueba of f.evidence) {
        const textos =
          prueba.kind === 'recording'
            ? [prueba.caption]
            : prueba.kind === 'code'
              ? []
              : [prueba.detail]
        for (const texto of textos) {
          expect(detectarJerga(texto), `jerga en la prueba de "${f.checkId}"`).toEqual([])
        }
      }
    }
  })

  it('lo que narra el video no tiene jerga', () => {
    const script = VIDEOS_DEMO['f-cross-tenant']!.script!
    for (const escena of script.scenes) {
      expect(detectarJerga(escena.narration), `jerga en "${escena.narration}"`).toEqual([])
      if (escena.caption) expect(detectarJerga(escena.caption)).toEqual([])
    }
  })
})
