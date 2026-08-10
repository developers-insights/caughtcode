/**
 * Cliente de Supabase falso, con la superficie mínima que usa la cola.
 *
 * No hay base de datos en esta etapa del proyecto, así que los tests de la cola
 * verifican **qué escribe** cada función (estados, backoff, campos), no que
 * Postgres se comporte. Eso se prueba cuando exista el esquema.
 */

import type { JobsDb } from '@/server/jobs/db'

export interface FakeRow {
  [column: string]: any
}

interface Operation {
  table: string
  type: 'insert' | 'update' | 'select'
  payload?: any
  filters: Array<{ column: string; value: any; op: 'eq' | 'in' }>
  single?: boolean
  maybeSingle?: boolean
  limit?: number
}

export interface RpcCall {
  fn: string
  args?: Record<string, unknown>
}

class FakeQuery implements PromiseLike<any> {
  constructor(
    private readonly db: FakeDb,
    private readonly op: Operation,
  ) {}

  select(): this {
    return this
  }
  order(): this {
    return this
  }
  eq(column: string, value: any): this {
    this.op.filters.push({ column, value, op: 'eq' })
    return this
  }
  in(column: string, value: any[]): this {
    this.op.filters.push({ column, value, op: 'in' })
    return this
  }
  limit(count: number): this {
    this.op.limit = count
    return this
  }
  single(): this {
    this.op.single = true
    return this
  }
  maybeSingle(): this {
    this.op.maybeSingle = true
    return this
  }

  then<TResult1 = any, TResult2 = never>(
    onfulfilled?: ((value: any) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.db.execute(this.op)).then(onfulfilled, onrejected)
  }
}

export class FakeDb implements JobsDb {
  readonly tables = new Map<string, FakeRow[]>()
  readonly operations: Operation[] = []
  readonly rpcCalls: RpcCall[] = []
  /** Respuestas por RPC. Devolvé `{ data }` o `{ error }`. */
  rpcHandlers: Record<string, (args?: Record<string, unknown>) => { data?: any; error?: any }> = {}
  /** Errores forzados por tabla+operación, para probar el camino de falla. */
  errors: Record<string, any> = {}

  private nextId = 1

  seed(table: string, rows: FakeRow[]): void {
    this.tables.set(table, rows.map((row) => ({ ...row })))
  }

  rows(table: string): FakeRow[] {
    return this.tables.get(table) ?? []
  }

  row(table: string, id: string): FakeRow | undefined {
    return this.rows(table).find((row) => row.id === id)
  }

  from(table: string): any {
    const db = this
    return {
      insert(payload: any) {
        return new FakeQuery(db, { table, type: 'insert', payload, filters: [] })
      },
      update(payload: any) {
        return new FakeQuery(db, { table, type: 'update', payload, filters: [] })
      },
      select() {
        return new FakeQuery(db, { table, type: 'select', filters: [] })
      },
    }
  }

  rpc(fn: string, args?: Record<string, unknown>): any {
    this.rpcCalls.push({ fn, args })
    const handler = this.rpcHandlers[fn]
    const result = handler ? handler(args) : { data: null }
    return Promise.resolve({ data: result.data ?? null, error: result.error ?? null })
  }

  execute(op: Operation): { data: any; error: any } {
    this.operations.push(op)

    const forced = this.errors[`${op.table}.${op.type}`]
    if (forced) return { data: null, error: forced }

    if (!this.tables.has(op.table)) this.tables.set(op.table, [])
    const rows = this.tables.get(op.table)!

    const matches = (row: FakeRow) =>
      op.filters.every(({ column, value, op: kind }) =>
        kind === 'in' ? (value as any[]).includes(row[column]) : row[column] === value,
      )

    if (op.type === 'insert') {
      const incoming = Array.isArray(op.payload) ? op.payload : [op.payload]
      const created = incoming.map((entry) => {
        const row: FakeRow = { id: `fake-${this.nextId++}`, ...entry }
        rows.push(row)
        return row
      })
      return { data: op.single ? created[0] : created, error: null }
    }

    if (op.type === 'update') {
      const affected = rows.filter(matches)
      for (const row of affected) Object.assign(row, op.payload)
      if (op.single || op.maybeSingle) return { data: affected[0] ?? null, error: null }
      return { data: affected, error: null }
    }

    let found = rows.filter(matches)
    if (op.limit !== undefined) found = found.slice(0, op.limit)
    if (op.single) return { data: found[0] ?? null, error: found[0] ? null : { message: 'sin filas' } }
    if (op.maybeSingle) return { data: found[0] ?? null, error: null }
    return { data: found, error: null }
  }
}

/**
 * La fila que devuelve un RPC `returns <tipo compuesto>` cuando hace `return null`:
 * no son cero filas, es UNA fila con todas las columnas en null. Reproduce el bug
 * del bucle infinito.
 */
export function filaFantasma(): FakeRow {
  const fila: FakeRow = {}
  for (const columna of Object.keys(jobRow())) fila[columna] = null
  return fila
}

/** Fila de `jobs` con valores por defecto razonables. */
export function jobRow(overrides: FakeRow = {}): FakeRow {
  return {
    id: 'job-1',
    org_id: 'org-1',
    project_id: 'proj-1',
    analysis_run_id: 'run-1',
    kind: 'run_checks',
    status: 'queued',
    payload: {},
    attempts: 0,
    max_attempts: 3,
    last_error: null,
    stage: null,
    progress: 0,
    lease_until: null,
    run_after: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}
