/**
 * Acceso a la base para la cola.
 *
 * Dos detalles que parecen caprichos y no lo son:
 *
 * 1. **El import de `@/lib/supabase/admin` es dinámico.** Ese módulo arranca con
 *    `import 'server-only'`, que tira una excepción fuera del runtime de Next
 *    (o sea: en `vitest` y en `pnpm worker`). Importándolo tarde, el worker lo
 *    carga recién cuando de verdad va a hablar con la base, y los tests nunca
 *    lo cargan porque inyectan un cliente falso con `setJobsDb`.
 *
 * 2. **`JobsDb` es una interfaz estructural mínima, no el tipo de Supabase.**
 *    `Database` todavía es `any` (lo genera el frente de datos), así que tipar
 *    contra `SupabaseClient<Database>` no aporta seguridad y sí mucha fricción.
 *    Con esta interfaz el cliente real encaja solo y el falso de los tests
 *    ocupa veinte líneas.
 */

export interface JobsDb {
  from(table: string): any
  rpc(fn: string, args?: Record<string, unknown>): any
}

let injected: JobsDb | null = null

/** Solo para tests: reemplaza el cliente real por uno falso. `null` lo restaura. */
export function setJobsDb(client: JobsDb | null): void {
  injected = client
}

export async function jobsDb(): Promise<JobsDb> {
  if (injected) return injected
  const { createAdminClient } = await import('@/lib/supabase/admin')
  return createAdminClient() as unknown as JobsDb
}

export interface PostgrestLikeError {
  message?: string
  code?: string
  details?: string
  hint?: string
}

/** Convierte el error de PostgREST en algo que se pueda leer. */
export function describeDbError(error: PostgrestLikeError | null | undefined): string {
  if (!error) return 'Error desconocido de la base de datos'
  const parts = [error.message, error.details, error.hint].filter(Boolean)
  const text = parts.join(' — ') || 'Error desconocido de la base de datos'
  return error.code ? `${text} [${error.code}]` : text
}

/** `true` si el error es "esa columna no existe" (esquema viejo o sin migrar). */
export function isMissingColumnError(error: PostgrestLikeError | null | undefined): boolean {
  if (!error) return false
  // 42703 = undefined_column (Postgres). PGRST204 = columna fuera del schema cache.
  if (error.code === '42703' || error.code === 'PGRST204') return true
  return /column .* does not exist|could not find the .* column/i.test(error.message ?? '')
}

/** `true` si el error es "esa función no existe" (el RPC todavía no se creó). */
export function isMissingFunctionError(error: PostgrestLikeError | null | undefined): boolean {
  if (!error) return false
  if (error.code === '42883' || error.code === 'PGRST202') return true
  return /could not find the function|function .* does not exist/i.test(error.message ?? '')
}
