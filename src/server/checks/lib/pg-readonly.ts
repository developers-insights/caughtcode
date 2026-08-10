/**
 * Sonda de solo lectura contra la base del usuario.
 *
 * Regla dura del producto (D9 / CONTRACTS §4.5): **nunca escribimos nada en la
 * base de nadie.** Verificar las reglas de acceso implica hacerse pasar por un
 * usuario, y eso obliga a abrir una transacción. Que esa transacción no pueda
 * terminar en `commit` no es una convención de estilo: es lo único que separa
 * "auditamos tu base" de "tocamos tu base".
 *
 * Por eso hay **cuatro** barreras, no una. Cada una alcanzaría sola; están las
 * cuatro porque el costo de que fallen es que le rompamos la producción a un
 * cliente.
 *
 *   1. `commit` no existe en este archivo. No hay rama, bandera ni parámetro
 *      que lo emita. Grepear `commit` acá devuelve solo comentarios.
 *   2. Toda sentencia que pase por `q()` cruza `assertSoloLectura()`, que
 *      rechaza por lista negra (insert, update, delete, commit, drop…). Falla
 *      cerrado: ante la duda, aborta.
 *   3. La transacción arranca con `set transaction read only`. Si algo se
 *      escapara de la barrera 2, PostgreSQL lo rechaza del otro lado.
 *   4. El `rollback` va en `finally`, y la conexión se cierra después pase lo
 *      que pase. Una excepción a mitad de camino no deja transacción abierta.
 *
 * La secuencia exacta de una verificación de reglas de acceso:
 *
 *   begin
 *   set transaction read only
 *   set local statement_timeout = …
 *   set local role authenticated
 *   select set_config('request.jwt.claims', $1, true)   ← parametrizado
 *   … los select de la sonda …
 *   rollback                                            ← siempre
 */

/* ── Cliente mínimo ───────────────────────────────────────────────────── */

/**
 * Lo mínimo que necesitamos de `pg`. Es una interfaz estructural para que el
 * cliente real encaje solo y el falso de los tests ocupe veinte líneas.
 */
export interface SqlClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
  end(): Promise<void>
}

export type SqlConnect = (databaseUrl: string) => Promise<SqlClient>

export type SqlQuery = (
  text: string,
  values?: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>

/* ── Barrera 2: lista negra ───────────────────────────────────────────── */

export class EscrituraBloqueadaError extends Error {
  constructor(readonly sentencia: string) {
    super(
      `Se bloqueó una sentencia que no es de solo lectura contra la base del usuario: ${sentencia.slice(0, 120)}`,
    )
    this.name = 'EscrituraBloqueadaError'
  }
}

/**
 * Verbos que no pueden aparecer nunca. `commit` está en la lista aunque este
 * módulo no lo emita: la lista protege también de lo que pase un chequeo.
 */
const VERBOS_PROHIBIDOS =
  /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|commit|savepoint|vacuum|analyze|reindex|cluster|refresh|call|do|copy|merge|lock|listen|notify|unlisten|checkpoint|discard|reset|import|security\s+label)\b/i

/** `--` hasta fin de línea y bloques `/* … *\/`, para que no escondan un verbo. */
function sinComentarios(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')
}

export function assertSoloLectura(sql: string): void {
  const limpio = sinComentarios(sql)
  if (VERBOS_PROHIBIDOS.test(limpio)) throw new EscrituraBloqueadaError(sql)
  // `;` habilita encadenar una segunda sentencia que la lista negra ya no mira.
  if (/;\s*\S/.test(limpio.trim())) throw new EscrituraBloqueadaError(sql)
}

/* ── Marco de la transacción ──────────────────────────────────────────── */

const MARCO = {
  begin: 'begin',
  soloLectura: 'set transaction read only',
  timeout: 'set local statement_timeout = 8000',
  rollback: 'rollback',
} as const

/** Un nombre de rol no se puede parametrizar: se valida por forma. */
const ROL_VALIDO = /^[a-z_][a-z0-9_]{0,62}$/

export class RolInvalidoError extends Error {
  constructor(rol: string) {
    super(`Nombre de rol inválido: ${rol}`)
    this.name = 'RolInvalidoError'
  }
}

export interface ClaimsSimulados {
  /** Id del usuario que simulamos. Va tal cual a `request.jwt.claims`. */
  sub: string
  role?: string
  [clave: string]: unknown
}

export interface OpcionesLectura {
  /** Rol de base que se asume. `authenticated` salvo que se pida otro. */
  rol?: string
  /** Milisegundos antes de cortar una consulta lenta. */
  timeoutMs?: number
}

/**
 * Corre `fn` haciéndose pasar por el usuario de `claims`, dentro de una
 * transacción que **siempre** termina en `rollback`.
 *
 * `fn` recibe una función de consulta ya blindada: cualquier cosa que no sea
 * lectura tira `EscrituraBloqueadaError` antes de tocar la red.
 */
export async function leerComoUsuario<T>(
  client: SqlClient,
  claims: ClaimsSimulados,
  fn: (q: SqlQuery) => Promise<T>,
  options: OpcionesLectura = {},
): Promise<T> {
  const rol = options.rol ?? claims.role ?? 'authenticated'
  if (!ROL_VALIDO.test(rol)) throw new RolInvalidoError(rol)

  const q: SqlQuery = async (text, values) => {
    assertSoloLectura(text)
    return client.query(text, values)
  }

  let abierta = false
  try {
    await client.query(MARCO.begin)
    abierta = true
    await client.query(MARCO.soloLectura)
    await client.query(
      options.timeoutMs === undefined
        ? MARCO.timeout
        : `set local statement_timeout = ${Math.max(1, Math.floor(options.timeoutMs))}`,
    )
    // El rol no admite parámetro; ya está validado contra ROL_VALIDO.
    await client.query(`set local role ${rol}`)
    await client.query('select set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify({ role: rol, ...claims }),
    ])

    return await fn(q)
  } finally {
    if (abierta) {
      // Si el rollback falla, la conexión se cierra igual: nada queda abierto.
      try {
        await client.query(MARCO.rollback)
      } catch {
        /* la conexión ya estaba rota; cerrarla alcanza */
      }
    }
  }
}

/**
 * Abre la conexión, corre la sonda y la cierra. Es la puerta que usan los
 * chequeos: nadie maneja el ciclo de vida de la conexión a mano.
 */
export async function conSondaDeLectura<T>(
  databaseUrl: string,
  connect: SqlConnect,
  claims: ClaimsSimulados,
  fn: (q: SqlQuery) => Promise<T>,
  options: OpcionesLectura = {},
): Promise<T> {
  const client = await connect(databaseUrl)
  try {
    return await leerComoUsuario(client, claims, fn, options)
  } finally {
    try {
      await client.end()
    } catch {
      /* cerrar es best-effort */
    }
  }
}

/**
 * Lectura sin simular usuario (para inventario del esquema): misma transacción
 * de solo lectura, mismo `rollback` garantizado, sin cambiar de rol.
 */
export async function conLecturaSimple<T>(
  databaseUrl: string,
  connect: SqlConnect,
  fn: (q: SqlQuery) => Promise<T>,
  options: OpcionesLectura = {},
): Promise<T> {
  const client = await connect(databaseUrl)
  const q: SqlQuery = async (text, values) => {
    assertSoloLectura(text)
    return client.query(text, values)
  }
  let abierta = false
  try {
    await client.query(MARCO.begin)
    abierta = true
    await client.query(MARCO.soloLectura)
    await client.query(
      options.timeoutMs === undefined
        ? MARCO.timeout
        : `set local statement_timeout = ${Math.max(1, Math.floor(options.timeoutMs))}`,
    )
    return await fn(q)
  } finally {
    if (abierta) {
      try {
        await client.query(MARCO.rollback)
      } catch {
        /* idem */
      }
    }
    try {
      await client.end()
    } catch {
      /* idem */
    }
  }
}

/* ── Conexión real ────────────────────────────────────────────────────── */

/**
 * `pg` se carga por import dinámico para que los tests (que inyectan un cliente
 * falso) nunca lo levanten, igual que hace `@/server/jobs/db`.
 */
export const conectarPg: SqlConnect = async (databaseUrl: string) => {
  const { Client } = await import('pg')
  const client = new Client({
    connectionString: databaseUrl,
    application_name: 'caughtcode-auditoria',
    connectionTimeoutMillis: 10_000,
    query_timeout: 15_000,
    statement_timeout: 15_000,
  })
  await client.connect()
  return {
    query: async (text, values) => {
      const result = await client.query(text, values as unknown[])
      return { rows: result.rows as Record<string, unknown>[] }
    },
    end: () => client.end(),
  }
}
