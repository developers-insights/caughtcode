import 'server-only'

/**
 * Estado de la base de datos del usuario.
 *
 * Regla dura: **nunca escribimos nada**. La lectura entra en una transacción
 * declarada de solo lectura, así el propio Postgres rechaza cualquier escritura,
 * y se cierra con ROLLBACK.
 *
 * Se lee el estado **aplicado** (`pg_policies`, `pg_class.relrowsecurity`), no
 * los archivos de migración: el SQL del repo cuenta la intención, que puede
 * diferir de lo que realmente está corriendo (MEMORY.md).
 *
 * Sin conexión caemos al modo "declarado" (Prisma / Drizzle / .sql) y lo decimos
 * en `notes`: es la intención del código, no el estado real.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'

import type { DbSchemaSnapshot, StackInfo } from '@/lib/types/domain'
import { readTextFile, type WalkedFile } from './files'

export interface SchemaResult {
  snapshot: DbSchemaSnapshot
  notes: string[]
}

const EMPTY: DbSchemaSnapshot = {
  source: 'none',
  tables: [],
  buckets: [],
  functions: [],
}

const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema', 'pg_toast']

/* ── Modo 1: base viva ────────────────────────────────────────────────────── */

export interface LiveSchemaOptions {
  /** Corte por consulta. Corto a propósito: no queremos molestar a la base del usuario. */
  statementTimeoutMs?: number
  connectionTimeoutMs?: number
  /** Esquemas a inspeccionar. Por defecto los que importan para auditar permisos. */
  schemas?: string[]
  /**
   * Acepta un certificado que no se puede verificar.
   *
   * Viene apagado y tiene que quedar apagado: sin verificar el certificado
   * cualquiera que esté en el medio de la conexión puede hacerse pasar por la
   * base del usuario y quedarse con sus datos. Somos el producto que audita
   * justamente esto. Solo se enciende contra una base local de desarrollo, y
   * siempre por decisión explícita de quien llama.
   */
  allowUnverifiedCertificate?: boolean
}

export async function readLiveSchema(
  databaseUrl: string,
  options: LiveSchemaOptions = {},
): Promise<SchemaResult> {
  const statementTimeoutMs = options.statementTimeoutMs ?? 8000
  const connectionTimeoutMs = options.connectionTimeoutMs ?? 10_000
  const schemas = options.schemas ?? ['public', 'storage', 'auth']
  const notes: string[] = []

  const { Client } = await import('pg')
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])/.test(databaseUrl)
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: connectionTimeoutMs,
    statement_timeout: statementTimeoutMs,
    query_timeout: statementTimeoutMs,
    application_name: 'caughtcode-auditoria-solo-lectura',
    // Conexión cifrada y con certificado verificado contra bases remotas.
    ssl: isLocal ? undefined : { rejectUnauthorized: !options.allowUnverifiedCertificate },
  })

  try {
    await client.connect()
  } catch (error) {
    const message = describe(error)
    const certificateProblem = /certificate|self[- ]signed|SSL|TLS/i.test(message)
    return {
      snapshot: EMPTY,
      notes: [
        certificateProblem
          ? `No pudimos conectarnos de forma segura a la base de datos: su certificado no se puede verificar (${message}). No seguimos adelante porque, sin esa verificación, alguien podría interceptar la conexión.`
          : `No pudimos conectarnos a la base de datos: ${message}`,
      ],
    }
  }

  try {
    // Solo lectura declarada: Postgres rechaza cualquier escritura por su cuenta.
    await client.query('BEGIN TRANSACTION READ ONLY')
    await client.query(`SET LOCAL statement_timeout = ${statementTimeoutMs}`)
    await client.query('SET LOCAL idle_in_transaction_session_timeout = 15000')

    const schemaList = schemas.map((_, i) => `$${i + 1}`).join(', ')

    const tablesResult = await client.query<{
      schema: string
      name: string
      rls_enabled: boolean
      rls_forced: boolean
    }>(
      `select n.nspname as schema, c.relname as name,
              c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p')
          and n.nspname in (${schemaList})
        order by n.nspname, c.relname`,
      schemas,
    )

    const columnsResult = await client.query<{
      table_schema: string
      table_name: string
      column_name: string
      data_type: string
      is_nullable: string
    }>(
      `select table_schema, table_name, column_name, data_type, is_nullable
         from information_schema.columns
        where table_schema in (${schemaList})
        order by table_schema, table_name, ordinal_position`,
      schemas,
    )

    const policiesResult = await client.query<{
      schemaname: string
      tablename: string
      policyname: string
      cmd: string
      roles: string[] | string | null
      qual: string | null
      with_check: string | null
    }>(
      `select schemaname, tablename, policyname, cmd, roles, qual, with_check
         from pg_policies
        where schemaname in (${schemaList})
        order by schemaname, tablename, policyname`,
      schemas,
    )

    const functionsResult = await client.query<{
      schema: string
      name: string
      security_definer: boolean
      config: string[] | null
    }>(
      `select n.nspname as schema, p.proname as name,
              p.prosecdef as security_definer, p.proconfig as config
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname not in (${SYSTEM_SCHEMAS.map((s) => `'${s}'`).join(', ')})
        order by n.nspname, p.proname`,
    )

    let buckets: DbSchemaSnapshot['buckets'] = []
    try {
      const bucketsResult = await client.query<{ name: string; public: boolean }>(
        'select name, public from storage.buckets order by name',
      )
      buckets = bucketsResult.rows.map((row) => ({ name: row.name, public: Boolean(row.public) }))
    } catch {
      notes.push('El proyecto no tiene almacenamiento de archivos de Supabase, o no pudimos leerlo.')
    }

    await client.query('ROLLBACK')

    const columnsByTable = new Map<string, DbSchemaSnapshot['tables'][number]['columns']>()
    for (const row of columnsResult.rows) {
      const key = `${row.table_schema}.${row.table_name}`
      const list = columnsByTable.get(key) ?? []
      list.push({ name: row.column_name, type: row.data_type, nullable: row.is_nullable === 'YES' })
      columnsByTable.set(key, list)
    }

    const policiesByTable = new Map<string, DbSchemaSnapshot['tables'][number]['policies']>()
    for (const row of policiesResult.rows) {
      const key = `${row.schemaname}.${row.tablename}`
      const list = policiesByTable.get(key) ?? []
      list.push({
        name: row.policyname,
        command: row.cmd,
        roles: normalizeRoles(row.roles),
        using: row.qual ?? undefined,
        check: row.with_check ?? undefined,
      })
      policiesByTable.set(key, list)
    }

    const tables = tablesResult.rows.map((row) => {
      const key = `${row.schema}.${row.name}`
      return {
        schema: row.schema,
        name: row.name,
        rlsEnabled: Boolean(row.rls_enabled),
        rlsForced: Boolean(row.rls_forced),
        columns: columnsByTable.get(key) ?? [],
        policies: policiesByTable.get(key) ?? [],
      }
    })

    const functions = functionsResult.rows.map((row) => ({
      schema: row.schema,
      name: row.name,
      securityDefiner: Boolean(row.security_definer),
      searchPath: findSearchPath(row.config),
    }))

    notes.push(`Leímos el estado real de la base: ${tables.length} tablas. No se escribió nada.`)

    return { snapshot: { source: 'live', tables, buckets, functions }, notes }
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // La transacción ya podía estar cerrada.
    }
    return { snapshot: EMPTY, notes: [`No pudimos leer la base de datos: ${describe(error)}`] }
  } finally {
    await client.end().catch(() => {})
  }
}

function normalizeRoles(roles: string[] | string | null): string[] {
  if (Array.isArray(roles)) return roles
  if (typeof roles === 'string') {
    return roles.replace(/^\{|\}$/g, '').split(',').map((role) => role.trim()).filter(Boolean)
  }
  return []
}

function findSearchPath(config: string[] | null): string | undefined {
  if (!config) return undefined
  for (const entry of config) {
    if (entry.startsWith('search_path=')) return entry.slice('search_path='.length)
  }
  return undefined
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/* ── Modo 2: lo declarado en el código ────────────────────────────────────── */

export interface DeclaredSchemaOptions {
  files?: WalkedFile[]
  stack?: StackInfo
}

const DECLARED_WARNING =
  'Esto es lo que dice el código del proyecto, no lo que está aplicado en la base. Conectá la base para confirmarlo.'

export async function readDeclaredSchema(
  root: string,
  options: DeclaredSchemaOptions = {},
): Promise<SchemaResult> {
  const files = options.files ?? []
  const notes: string[] = []

  const prismaFile = files.find((file) => file.relative.endsWith('prisma/schema.prisma'))
  if (prismaFile) {
    const source = await readTextFile(prismaFile.absolute)
    if (source) {
      const tables = parsePrismaModels(source)
      notes.push(`Leímos ${prismaFile.relative}: ${tables.length} tablas declaradas. ${DECLARED_WARNING}`)
      return { snapshot: { source: 'declared', tables, buckets: [], functions: [] }, notes }
    }
  }

  const sqlFiles = files.filter(
    (file) => file.relative.endsWith('.sql') && !file.relative.includes('/seed'),
  )
  if (sqlFiles.length > 0) {
    const statements: string[] = []
    for (const file of sqlFiles.slice(0, 200)) {
      const source = await readTextFile(file.absolute)
      if (source) statements.push(...splitSqlStatements(source))
    }
    const snapshot = parseSqlSchema(statements)
    if (snapshot.tables.length > 0 || snapshot.functions.length > 0) {
      notes.push(
        `Leímos ${sqlFiles.length} archivo${sqlFiles.length === 1 ? '' : 's'} .sql del proyecto: ${snapshot.tables.length} tablas declaradas. ${DECLARED_WARNING}`,
      )
      return { snapshot: { ...snapshot, source: 'declared' }, notes }
    }
  }

  const drizzleFiles = files.filter((file) => /schema\.(ts|js)$/.test(file.relative))
  for (const file of drizzleFiles) {
    const source = await readTextFile(file.absolute)
    if (!source || !source.includes('drizzle-orm')) continue
    const tables = parseDrizzleTables(source)
    if (tables.length > 0) {
      notes.push(
        `Leímos ${file.relative}: ${tables.length} tablas declaradas con Drizzle. Los permisos de acceso no se pueden deducir del código. ${DECLARED_WARNING}`,
      )
      return { snapshot: { source: 'declared', tables, buckets: [], functions: [] }, notes }
    }
  }

  const packageJson = await readTextFile(path.join(root, 'package.json'))
  if (packageJson?.includes('prisma')) {
    notes.push('El proyecto usa Prisma pero no encontramos su archivo de esquema.')
  }

  return { snapshot: EMPTY, notes: ['No encontramos definición de base de datos en el proyecto.'] }
}

/** `model Nombre { campo Tipo }` → tabla con columnas. Formato de bloques, no regex sobre todo. */
export function parsePrismaModels(source: string): DbSchemaSnapshot['tables'] {
  const tables: DbSchemaSnapshot['tables'] = []
  const lines = source.split('\n')
  let current: DbSchemaSnapshot['tables'][number] | null = null

  for (const rawLine of lines) {
    const line = rawLine.replace(/\/\/.*$/, '').trim()
    if (line === '') continue

    const modelStart = line.match(/^model\s+([A-Za-z_][\w]*)\s*\{/)
    if (modelStart) {
      current = { schema: 'public', name: modelStart[1], rlsEnabled: false, rlsForced: false, columns: [], policies: [] }
      continue
    }
    if (line === '}') {
      if (current) tables.push(current)
      current = null
      continue
    }
    if (!current) continue
    if (line.startsWith('@@')) continue

    const field = line.match(/^([A-Za-z_][\w]*)\s+([A-Za-z_][\w]*)(\[\])?(\?)?/)
    if (field) {
      current.columns.push({
        name: field[1],
        type: field[2] + (field[3] ?? ''),
        nullable: field[4] === '?',
      })
    }
  }
  return tables
}

/** `export const users = pgTable('users', {...})` → nombre de tabla. */
export function parseDrizzleTables(source: string): DbSchemaSnapshot['tables'] {
  const tables: DbSchemaSnapshot['tables'] = []
  const regex = /\b(?:pgTable|mysqlTable|sqliteTable)\s*\(\s*['"`]([^'"`]+)['"`]/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(source)) !== null) {
    tables.push({
      schema: 'public',
      name: match[1],
      rlsEnabled: false,
      rlsForced: false,
      columns: [],
      policies: [],
    })
  }
  return tables
}

/**
 * Separa un archivo .sql en sentencias respetando comillas, comentarios y
 * cuerpos `$$ ... $$` (donde un `;` no termina nada).
 */
export function splitSqlStatements(source: string): string[] {
  const statements: string[] = []
  let current = ''
  let index = 0
  let dollarTag: string | null = null

  while (index < source.length) {
    const char = source[index]

    if (dollarTag) {
      if (source.startsWith(dollarTag, index)) {
        current += dollarTag
        index += dollarTag.length
        dollarTag = null
        continue
      }
      current += char
      index++
      continue
    }

    if (char === '-' && source[index + 1] === '-') {
      const end = source.indexOf('\n', index)
      index = end === -1 ? source.length : end
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      index = end === -1 ? source.length : end + 2
      continue
    }
    if (char === "'" || char === '"') {
      let i = index + 1
      while (i < source.length) {
        if (source[i] === char && source[i + 1] === char) {
          i += 2
          continue
        }
        if (source[i] === char) break
        i++
      }
      current += source.slice(index, Math.min(i + 1, source.length))
      index = i + 1
      continue
    }
    const dollar = source.slice(index).match(/^\$[A-Za-z_]*\$/)
    if (dollar) {
      dollarTag = dollar[0]
      current += dollarTag
      index += dollarTag.length
      continue
    }
    if (char === ';') {
      if (current.trim()) statements.push(current.trim())
      current = ''
      index++
      continue
    }
    current += char
    index++
  }
  if (current.trim()) statements.push(current.trim())
  return statements
}

function unquoteIdent(value: string): string {
  return value.replace(/^"|"$/g, '')
}

function splitQualified(name: string): { schema: string; table: string } {
  const parts = name.split('.').map(unquoteIdent)
  if (parts.length >= 2) return { schema: parts[0], table: parts[1] }
  return { schema: 'public', table: parts[0] }
}

/** Último recurso: reconstruir el esquema desde las migraciones .sql. */
export function parseSqlSchema(statements: string[]): DbSchemaSnapshot {
  const tables = new Map<string, DbSchemaSnapshot['tables'][number]>()
  const functions: DbSchemaSnapshot['functions'] = []
  const buckets: DbSchemaSnapshot['buckets'] = []

  const ensure = (qualified: string) => {
    const { schema, table } = splitQualified(qualified)
    const key = `${schema}.${table}`
    const existing = tables.get(key)
    if (existing) return existing
    const created = { schema, name: table, rlsEnabled: false, rlsForced: false, columns: [], policies: [] }
    tables.set(key, created)
    return created
  }

  for (const statement of statements) {
    const normalized = statement.replace(/\s+/g, ' ').trim()
    const lower = normalized.toLowerCase()

    const createTable = normalized.match(
      /^create\s+table\s+(?:if\s+not\s+exists\s+)?([\w".]+)\s*\(([\s\S]*)\)$/i,
    )
    if (createTable) {
      const table = ensure(createTable[1])
      for (const piece of splitTopLevel(createTable[2])) {
        const column = piece.trim().match(/^("?[\w]+"?)\s+([\w"]+(?:\s*\([^)]*\))?(?:\s*\[\])?)/)
        if (!column) continue
        const name = unquoteIdent(column[1])
        if (['constraint', 'primary', 'unique', 'foreign', 'check', 'exclude'].includes(name.toLowerCase())) {
          continue
        }
        table.columns.push({
          name,
          type: column[2].trim(),
          nullable: !/not\s+null/i.test(piece) && !/primary\s+key/i.test(piece),
        })
      }
      continue
    }

    const alterRls = normalized.match(/^alter\s+table\s+(?:if\s+exists\s+)?([\w".]+)\s+(.*)$/i)
    if (alterRls) {
      const table = ensure(alterRls[1])
      if (/enable\s+row\s+level\s+security/i.test(alterRls[2])) table.rlsEnabled = true
      if (/force\s+row\s+level\s+security/i.test(alterRls[2])) table.rlsForced = true
      if (/disable\s+row\s+level\s+security/i.test(alterRls[2])) table.rlsEnabled = false
      continue
    }

    const createPolicy = normalized.match(
      /^create\s+policy\s+("?[^"\s]+"?)\s+on\s+([\w".]+)([\s\S]*)$/i,
    )
    if (createPolicy) {
      const table = ensure(createPolicy[2])
      const rest = createPolicy[3]
      const command = rest.match(/\bfor\s+(all|select|insert|update|delete)\b/i)?.[1]?.toUpperCase() ?? 'ALL'
      const roles = rest.match(/\bto\s+([\w",\s]+?)(?:\busing\b|\bwith\s+check\b|$)/i)?.[1]
      table.policies.push({
        name: unquoteIdent(createPolicy[1]),
        command,
        roles: roles ? roles.split(',').map((role) => unquoteIdent(role.trim())).filter(Boolean) : [],
        using: rest.match(/\busing\s*\(([\s\S]*?)\)\s*(?:with\s+check|$)/i)?.[1]?.trim(),
        check: rest.match(/\bwith\s+check\s*\(([\s\S]*?)\)\s*$/i)?.[1]?.trim(),
      })
      continue
    }

    const createFunction = normalized.match(
      /^create\s+(?:or\s+replace\s+)?function\s+([\w".]+)\s*\(/i,
    )
    if (createFunction) {
      const { schema, table: name } = splitQualified(createFunction[1])
      functions.push({
        schema,
        name,
        securityDefiner: /security\s+definer/i.test(normalized),
        searchPath: normalized.match(/set\s+search_path\s*(?:=|to)\s*'?([^'\s;]*)'?/i)?.[1],
      })
      continue
    }

    if (lower.includes('storage.buckets')) {
      const bucket = normalized.match(/values\s*\(\s*'([^']+)'\s*,\s*'[^']*'\s*,\s*(true|false)/i)
      if (bucket) buckets.push({ name: bucket[1], public: bucket[2].toLowerCase() === 'true' })
    }
  }

  return {
    source: 'declared',
    tables: [...tables.values()].sort((a, b) => (`${a.schema}.${a.name}` < `${b.schema}.${b.name}` ? -1 : 1)),
    buckets,
    functions,
  }
}

/** Separa por comas de primer nivel, ignorando las que están dentro de paréntesis. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of body) {
    if (char === '(') depth++
    if (char === ')') depth--
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current.trim()) parts.push(current)
  return parts
}

/* ── Entrada pública ──────────────────────────────────────────────────────── */

export interface ReadSchemaOptions extends DeclaredSchemaOptions, LiveSchemaOptions {
  databaseUrl?: string | null
}

/**
 * Intenta leer la base viva; si no hay conexión, cae a lo declarado.
 * El campo `source` del resultado dice siempre de dónde salió el dato.
 */
export async function readSchema(root: string, options: ReadSchemaOptions = {}): Promise<SchemaResult> {
  if (options.databaseUrl) {
    const live = await readLiveSchema(options.databaseUrl, options)
    if (live.snapshot.source === 'live') return live

    const declared = await readDeclaredSchema(root, options)
    return { snapshot: declared.snapshot, notes: [...live.notes, ...declared.notes] }
  }

  const declared = await readDeclaredSchema(root, options)
  return {
    snapshot: declared.snapshot,
    notes: [
      'No conectaste la base de datos, así que no pudimos verificar quién puede ver qué en la práctica.',
      ...declared.notes,
    ],
  }
}
