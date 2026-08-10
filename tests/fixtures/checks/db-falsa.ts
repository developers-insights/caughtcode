/**
 * Base de mentira con la forma del cliente de Supabase.
 *
 * Implementa solo lo que usa el handler: `select/eq/in/order/limit/maybeSingle`
 * e `insert`/`delete` encadenables y esperables. Es un `JobsDb` estructural, así
 * que encaja donde va el cliente real sin ningún cast raro.
 *
 * Guarda las filas en memoria para poder contarlas después: es lo que hace
 * verificable la idempotencia.
 */

import type { JobsDb } from '@/server/jobs/db'

export type Fila = Record<string, unknown>

interface Filtro {
  columna: string
  valores: unknown[]
}

export class DbFalsa implements JobsDb {
  readonly tablas = new Map<string, Fila[]>()
  /** Toda operación que pasó, para poder revisar el orden. */
  readonly operaciones: string[] = []
  /** Si se fija, la próxima operación de esa tabla devuelve error. */
  fallaEn: { tabla: string; operacion: 'insert' | 'delete' | 'select' | 'update' } | null = null

  sembrar(tabla: string, filas: Fila[]): void {
    this.tablas.set(tabla, [...filas])
  }

  filasDe(tabla: string): Fila[] {
    return this.tablas.get(tabla) ?? []
  }

  from(tabla: string): Consulta {
    return new Consulta(this, tabla)
  }

  rpc(): never {
    throw new Error('la base de mentira no implementa rpc')
  }
}

type Resultado = { data: unknown; error: { message: string } | null }

class Consulta implements PromiseLike<Resultado> {
  private filtros: Filtro[] = []
  private operacion: 'select' | 'insert' | 'delete' | 'update' = 'select'
  private aInsertar: Fila[] = []
  private cambios: Fila = {}
  private limite: number | null = null
  private unico = false

  constructor(
    private readonly db: DbFalsa,
    private readonly tabla: string,
  ) {}

  select(_columnas?: string): this {
    // `insert(...).select('id').single()` es una sola operación: el `select`
    // acá solo pide que la escritura devuelva la fila. Si pisara la operación,
    // el insert nunca ocurriría — y el fallo aparece lejos, en `data.id`.
    if (this.operacion === 'select') this.operacion = 'select'
    return this
  }

  insert(filas: Fila | Fila[]): this {
    this.operacion = 'insert'
    this.aInsertar = Array.isArray(filas) ? filas : [filas]
    return this
  }

  delete(): this {
    this.operacion = 'delete'
    return this
  }

  update(cambios: Fila): this {
    this.operacion = 'update'
    this.cambios = cambios
    return this
  }

  eq(columna: string, valor: unknown): this {
    this.filtros.push({ columna, valores: [valor] })
    return this
  }

  in(columna: string, valores: unknown[]): this {
    this.filtros.push({ columna, valores })
    return this
  }

  order(_columna: string, _opciones?: Record<string, unknown>): this {
    return this
  }

  limit(n: number): this {
    this.limite = n
    return this
  }

  maybeSingle(): this {
    this.unico = true
    return this
  }

  single(): this {
    this.unico = true
    return this
  }

  private coincide(fila: Fila): boolean {
    return this.filtros.every((f) => f.valores.some((v) => v === fila[f.columna]))
  }

  private ejecutar(): Resultado {
    const falla = this.db.fallaEn
    if (falla && falla.tabla === this.tabla && falla.operacion === this.operacion) {
      this.db.fallaEn = null
      return { data: null, error: { message: `la base rechazó el ${this.operacion}` } }
    }

    const filas = this.db.tablas.get(this.tabla) ?? []
    this.db.operaciones.push(`${this.operacion} ${this.tabla}`)

    switch (this.operacion) {
      case 'insert': {
        const conId = this.aInsertar.map((f, i) => ({
          id: `fila-${this.tabla}-${filas.length + i}`,
          ...f,
        }))
        this.db.tablas.set(this.tabla, [...filas, ...conId])
        // `insert().select().single()` (lo que usa `enqueue`) espera UNA fila,
        // no el arreglo. Sin esto, `data.id` revienta con null.
        return { data: this.unico ? (conId[0] ?? null) : conId, error: null }
      }
      case 'delete': {
        const quedan = filas.filter((f) => !this.coincide(f))
        this.db.tablas.set(this.tabla, quedan)
        return { data: null, error: null }
      }
      case 'update': {
        const actualizadas = filas.map((f) =>
          this.coincide(f) ? { ...f, ...this.cambios } : f,
        )
        this.db.tablas.set(this.tabla, actualizadas)
        return { data: null, error: null }
      }
      case 'select': {
        let salida = filas.filter((f) => this.coincide(f))
        if (this.limite !== null) salida = salida.slice(0, this.limite)
        return { data: this.unico ? (salida[0] ?? null) : salida, error: null }
      }
    }
  }

  then<TResultado1 = Resultado, TResultado2 = never>(
    alCumplir?: ((valor: Resultado) => TResultado1 | PromiseLike<TResultado1>) | null,
    alFallar?: ((razon: unknown) => TResultado2 | PromiseLike<TResultado2>) | null,
  ): PromiseLike<TResultado1 | TResultado2> {
    return Promise.resolve(this.ejecutar()).then(alCumplir, alFallar)
  }
}

/* ── Almacén de etapas en memoria ─────────────────────────────────────── */

/**
 * Reemplaza el almacén de etapas que normalmente vive en `jobs.payload`.
 * Con un almacén por trabajo, dos trabajos distintos no se ven el avance —que
 * es justo lo que hace falta para probar la idempotencia de verdad.
 */
export function almacenEnMemoria(): {
  store: { load: (jobId: string) => Promise<Record<string, unknown>>; save: (jobId: string, payload: Record<string, unknown>) => Promise<void> }
  payloads: Map<string, Record<string, unknown>>
} {
  const payloads = new Map<string, Record<string, unknown>>()
  return {
    payloads,
    store: {
      async load(jobId) {
        return payloads.get(jobId) ?? {}
      },
      async save(jobId, payload) {
        payloads.set(jobId, payload)
      },
    },
  }
}

/* ── Contexto de trabajo de mentira ───────────────────────────────────── */

import type { CostEntry } from '@/lib/types/domain'
import type { JobContext } from '@/server/jobs'

export interface ContextoFalso extends JobContext {
  costos: CostEntry[]
  registro: string[]
  etapas: Array<{ stage?: string; progress?: number }>
}

export function contextoDeTrabajo(opciones: {
  jobId?: string
  analysisRunId?: string | null
  projectId?: string | null
} = {}): ContextoFalso {
  const costos: CostEntry[] = []
  const registro: string[] = []
  const etapas: Array<{ stage?: string; progress?: number }> = []

  return {
    jobId: opciones.jobId ?? 'trabajo-1',
    orgId: 'org-1',
    projectId: opciones.projectId === undefined ? 'proyecto-1' : opciones.projectId,
    analysisRunId: opciones.analysisRunId === undefined ? 'corrida-1' : opciones.analysisRunId,
    attempt: 1,
    maxAttempts: 3,
    signal: new AbortController().signal,
    async heartbeat(stage, progress) {
      etapas.push({ stage, progress })
    },
    log(mensaje) {
      registro.push(mensaje)
    },
    async reportCost(entrada) {
      costos.push(entrada)
    },
    costos,
    registro,
    etapas,
  }
}
