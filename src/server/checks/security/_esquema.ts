/**
 * Ayudas compartidas por los chequeos que miran la base.
 *
 * Nada de esto emite hallazgos: son lecturas del `DbSchemaSnapshot` y el
 * escapado de identificadores para armar los `select` de la sonda.
 */

import type { DbSchemaSnapshot } from '@/lib/types/domain'

type Tabla = DbSchemaSnapshot['tables'][number]
type Politica = Tabla['policies'][number]

/** Esquemas internos de Postgres y Supabase: no son del usuario, no se auditan. */
const ESQUEMAS_AJENOS = new Set([
  'pg_catalog',
  'information_schema',
  'pg_toast',
  'auth',
  'storage',
  'realtime',
  'supabase_migrations',
  'supabase_functions',
  'extensions',
  'graphql',
  'graphql_public',
  'net',
  'vault',
  'cron',
  'pgsodium',
  'pgsodium_masks',
])

export function esEsquemaDelUsuario(schema: string): boolean {
  return !ESQUEMAS_AJENOS.has(schema.toLowerCase())
}

export function tablasPublicas(esquema: DbSchemaSnapshot): Tabla[] {
  if (esquema.source === 'none') return []
  return esquema.tables.filter((t) => esEsquemaDelUsuario(t.schema))
}

/* ── Identificadores ──────────────────────────────────────────────────── */

const IDENTIFICADOR = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/

export class IdentificadorInvalidoError extends Error {
  constructor(valor: string) {
    super(`Identificador de base inválido: ${valor}`)
    this.name = 'IdentificadorInvalidoError'
  }
}

/**
 * Un nombre de tabla o columna no se puede pasar como parámetro: hay que
 * interpolarlo. Se valida por forma y se cita — falla cerrado, porque el
 * texto viene del esquema del usuario y no de nosotros.
 */
export function citarIdentificador(valor: string): string {
  if (!IDENTIFICADOR.test(valor)) throw new IdentificadorInvalidoError(valor)
  return `"${valor}"`
}

export function citarTabla(schema: string, name: string): string {
  return `${citarIdentificador(schema)}.${citarIdentificador(name)}`
}

export function identificadorValido(valor: string): boolean {
  return IDENTIFICADOR.test(valor)
}

/* ── Dueño de una fila ────────────────────────────────────────────────── */

/**
 * Columnas donde vive el id del usuario dueño, en orden de preferencia.
 *
 * A propósito **no** están `org_id`, `team_id` ni `tenant_id`: en esas tablas
 * el id del usuario no es el valor de la columna, sino algo que la app resuelve
 * con su propia lógica. Simular claims ahí daría un resultado que no significa
 * nada, y un hallazgo que no significa nada es peor que ninguno (D14).
 */
const COLUMNAS_DUENO = [
  'user_id',
  'owner_id',
  'owner_user_id',
  'created_by',
  'author_id',
  'profile_id',
  'account_id',
]

export function columnaDueno(tabla: Tabla): string | null {
  const porNombre = new Map(tabla.columns.map((c) => [c.name.toLowerCase(), c]))
  for (const candidata of COLUMNAS_DUENO) {
    const columna = porNombre.get(candidata)
    if (!columna) continue
    // Tiene que ser un identificador de usuario, no un número de secuencia.
    if (/uuid|text|varchar|char/i.test(columna.type)) return columna.name
  }
  return null
}

/* ── Reglas de acceso ─────────────────────────────────────────────────── */

/** Normaliza una expresión SQL para compararla: sin espacios ni paréntesis sobrantes. */
export function normalizarExpresion(expr: string | undefined): string {
  if (!expr) return ''
  let limpia = expr.trim().toLowerCase()
  while (limpia.startsWith('(') && limpia.endsWith(')')) {
    limpia = limpia.slice(1, -1).trim()
  }
  return limpia.replace(/\s+/g, ' ')
}

/** `true` si la regla deja pasar a cualquiera: `using (true)` y equivalentes. */
export function esReglaAbierta(politica: Politica): boolean {
  const using = normalizarExpresion(politica.using)
  return using === 'true' || using === '1=1' || using === "'t'" || using === 'true::boolean'
}

/** Reglas que aplican a lectura. Son las que pueden filtrar datos ajenos. */
export function reglasDeLectura(tabla: Tabla): Politica[] {
  return tabla.policies.filter((p) => {
    const cmd = p.command.toUpperCase()
    return cmd === 'SELECT' || cmd === 'ALL'
  })
}

/** `true` si la regla alcanza a usuarios comunes (no solo al administrador). */
export function alcanzaUsuariosComunes(politica: Politica): boolean {
  if (politica.roles.length === 0) return true
  return politica.roles.some((rol) => {
    const r = rol.toLowerCase()
    return r === 'public' || r === 'authenticated' || r === 'anon' || r === 'all'
  })
}
