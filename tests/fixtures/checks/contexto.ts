/**
 * Contexto de chequeo armado a mano, más el esquema de base de ejemplo.
 *
 * `contextoDe()` deja todo en el mínimo (sin base, sin app desplegada, sin
 * modelo) y el test agrega solo lo que necesita. Así, si un chequeo empieza a
 * usar un insumo que no declaró en `requires`, el test se cae.
 */

import type {
  CodeIndex,
  DbSchemaSnapshot,
  AgentSessionResult,
  RouteInfo,
  StackInfo,
} from '@/lib/types/domain'
import type { CheckRunContext } from '@/server/checks/lib/context'
import type { AgentEvidence } from '@/server/checks/agent-input'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

export const STACK: StackInfo = {
  framework: 'nextjs',
  language: 'typescript',
  packageManager: 'pnpm',
  backends: ['supabase'],
  hasTypescript: true,
  hasTailwind: true,
  routerKind: 'app',
  evidence: ['next.config.ts'],
}

export const ESQUEMA_VACIO: DbSchemaSnapshot = {
  source: 'none',
  tables: [],
  buckets: [],
  functions: [],
}

/**
 * Base de ejemplo con un problema de cada tipo:
 *   - `notas`      → sin reglas de acceso
 *   - `mensajes`   → con una regla escrita como "using (true)"
 *   - `perfiles`   → reglas activadas pero no forzadas
 *   - `facturas`   → bien hecha, no tiene que disparar nada
 */
export const ESQUEMA_CON_PROBLEMAS: DbSchemaSnapshot = {
  source: 'live',
  tables: [
    {
      schema: 'public',
      name: 'notas',
      rlsEnabled: false,
      rlsForced: false,
      columns: [
        { name: 'id', type: 'uuid', nullable: false },
        { name: 'user_id', type: 'uuid', nullable: false },
        { name: 'texto', type: 'text', nullable: true },
      ],
      policies: [],
    },
    {
      schema: 'public',
      name: 'mensajes',
      rlsEnabled: true,
      rlsForced: true,
      columns: [
        { name: 'id', type: 'uuid', nullable: false },
        { name: 'user_id', type: 'uuid', nullable: false },
        { name: 'cuerpo', type: 'text', nullable: true },
      ],
      policies: [
        {
          name: 'mensajes_select_todos',
          command: 'SELECT',
          roles: ['authenticated'],
          using: '(true)',
        },
      ],
    },
    {
      schema: 'public',
      name: 'perfiles',
      rlsEnabled: true,
      rlsForced: false,
      columns: [
        { name: 'id', type: 'uuid', nullable: false },
        { name: 'user_id', type: 'uuid', nullable: false },
      ],
      policies: [
        {
          name: 'perfiles_propios',
          command: 'SELECT',
          roles: ['authenticated'],
          using: '(user_id = auth.uid())',
        },
      ],
    },
    {
      schema: 'public',
      name: 'facturas',
      rlsEnabled: true,
      rlsForced: true,
      columns: [
        { name: 'id', type: 'uuid', nullable: false },
        { name: 'user_id', type: 'uuid', nullable: false },
      ],
      policies: [
        {
          name: 'facturas_propias',
          command: 'ALL',
          roles: ['authenticated'],
          using: '(user_id = auth.uid())',
        },
      ],
    },
    // Esquema interno de Supabase: no es del usuario, no se audita.
    {
      schema: 'auth',
      name: 'users',
      rlsEnabled: false,
      rlsForced: false,
      columns: [{ name: 'id', type: 'uuid', nullable: false }],
      policies: [],
    },
  ],
  buckets: [
    { name: 'documentos', public: true },
    { name: 'privados', public: false },
  ],
  functions: [
    { schema: 'public', name: 'es_miembro', securityDefiner: true },
    { schema: 'public', name: 'total_por_mes', securityDefiner: true, searchPath: '' },
    { schema: 'public', name: 'suma', securityDefiner: false },
  ],
}

export function indiceDe(
  rutas: RouteInfo[] = [],
  dbSchema: DbSchemaSnapshot = ESQUEMA_VACIO,
  fileCount = 10,
): CodeIndex {
  return {
    fileCount,
    totalBytes: 4096,
    languages: { typescript: fileCount },
    routes: rutas,
    symbols: [],
    edges: [],
    rankedFiles: [],
    dbSchema,
    truncated: false,
    notes: [],
  }
}

export interface OpcionesContexto {
  rutas?: RouteInfo[]
  dbSchema?: DbSchemaSnapshot
  deployedUrl?: string | null
  databaseUrl?: string | null
  agent?: AgentEvidence
  http?: CheckRunContext['http']
  connect?: CheckRunContext['connect']
  complete?: CheckRunContext['complete']
  /** Los mensajes de `log` se acumulan acá para poder revisarlos. */
  registro?: string[]
}

export function contextoDe(repoPath: string, opciones: OpcionesContexto = {}): CheckRunContext {
  const registro = opciones.registro ?? []
  return {
    projectId: 'proyecto-de-prueba',
    analysisRunId: 'corrida-de-prueba',
    repoPath,
    index: indiceDe(opciones.rutas, opciones.dbSchema),
    stack: STACK,
    deployedUrl: opciones.deployedUrl ?? null,
    databaseUrl: opciones.databaseUrl ?? null,
    readFile: async (relativa) => {
      try {
        return await readFile(path.join(repoPath, relativa), 'utf8')
      } catch {
        return null
      }
    },
    log: (mensaje) => registro.push(mensaje),
    agent: opciones.agent,
    http: opciones.http,
    connect: opciones.connect,
    complete: opciones.complete,
  }
}

/* ── Rutas de ejemplo ─────────────────────────────────────────────────── */

export function ruta(
  rutaPublica: string,
  file: string,
  kind: RouteInfo['kind'] = 'page',
  extra: Partial<RouteInfo> = {},
): RouteInfo {
  return {
    path: rutaPublica,
    file,
    kind,
    isDynamic: rutaPublica.includes('['),
    isClient: false,
    looksProtected: false,
    ...extra,
  }
}

/* ── Sesiones del agente ──────────────────────────────────────────────── */

export function sesionAgente(
  taskId: AgentSessionResult['taskId'],
  outcome: AgentSessionResult['outcome'],
  extra: Partial<AgentSessionResult> = {},
): AgentSessionResult {
  return {
    taskId,
    outcome,
    conclusionPlain: 'Conclusión de prueba.',
    steps: [
      { index: 0, atMs: 500, action: 'abrir', url: 'https://miapp.com/', note: 'Entramos.' },
      {
        index: 1,
        atMs: 4200,
        action: 'buscar',
        target: 'menú de cuenta',
        url: 'https://miapp.com/cuenta',
        note: 'Revisamos todas las opciones.',
      },
    ],
    durationMs: 9000,
    costUsd: 0.02,
    ...extra,
  }
}

/**
 * Todo lo que el agente puede llegar a observar, con problemas en todo.
 * Sirve para que los chequeos de app desplegada tengan de qué agarrarse.
 */
export function agenteConProblemas(): AgentEvidence {
  return {
    sessions: [
      sesionAgente('delete_account', 'not_found'),
      sesionAgente('password_reset', 'not_found'),
      sesionAgente('logout', 'not_found'),
      sesionAgente('signup', 'completed'),
      sesionAgente('primary_flow', 'blocked', {
        conclusionPlain: 'comprar un plan',
        steps: [
          {
            index: 0,
            atMs: 800,
            action: 'abrir',
            url: 'https://miapp.com/precios',
            note: 'Entramos a la pantalla de precios.',
          },
          {
            index: 1,
            atMs: 7300,
            action: 'clic',
            target: 'Suscribirme',
            url: 'https://miapp.com/precios',
            note: 'El botón no hace nada: no pasa nada al hacer clic.',
            screenshotPath: '/grabaciones/precios-7300.png',
          },
        ],
      }),
    ],
    pages: [
      {
        sessionId: 'primary_flow',
        url: 'https://miapp.com/',
        path: '/',
        status: 200,
        html: '<html><body><h1>Mi app</h1></body></html>',
        atMs: 900,
        screenshotPath: '/grabaciones/portada.png',
      },
    ],
    network: [
      {
        sessionId: 'primary_flow',
        url: 'https://www.google-analytics.com/g/collect?v=2',
        host: 'google-analytics.com',
        method: 'POST',
        atMs: 1200,
        beforeConsent: true,
        fromPath: '/',
        thirdParty: true,
      },
      {
        sessionId: 'primary_flow',
        url: 'https://static.hotjar.com/c/hotjar-123.js',
        host: 'hotjar.com',
        method: 'GET',
        atMs: 1400,
        beforeConsent: true,
        fromPath: '/',
        thirdParty: true,
      },
    ],
    cookies: [
      {
        sessionId: 'primary_flow',
        name: '_ga',
        domain: '.miapp.com',
        atMs: 1250,
        beforeConsent: true,
        fromPath: '/',
      },
    ],
    a11y: [
      {
        sessionId: 'primary_flow',
        ruleId: 'color-contrast',
        descripcionPlain: 'Hay texto que no se distingue del fondo',
        impacto: 'serious',
        path: '/',
        cantidadElementos: 4,
        atMs: 2000,
        screenshotPath: '/grabaciones/contraste.png',
      },
      {
        sessionId: 'primary_flow',
        ruleId: 'label',
        descripcionPlain: 'Hay campos de formulario sin nombre',
        impacto: 'critical',
        path: '/registro',
        cantidadElementos: 2,
        atMs: 3000,
      },
    ],
    overflow: [
      {
        sessionId: 'primary_flow',
        path: '/precios',
        url: 'https://miapp.com/precios',
        viewportWidth: 375,
        scrollWidth: 520,
        clientWidth: 375,
        atMs: 5000,
        screenshotPath: '/grabaciones/desborde.png',
        culpable: 'table.comparacion',
      },
    ],
  }
}

/* ── Sonda HTTP de mentira ────────────────────────────────────────────── */

export interface SondaFalsa {
  probe: NonNullable<CheckRunContext['http']>
  /** Todas las URL pedidas, en orden. */
  pedidas: string[]
}

/**
 * Devuelve 404 para todo salvo lo que se declare en `respuestas`.
 * El 404 por defecto es lo que necesitan los chequeos de "esto no existe".
 */
export function sondaFalsa(
  respuestas: Record<string, { status: number; body?: string; headers?: Record<string, string> }> = {},
): SondaFalsa {
  const pedidas: string[] = []
  return {
    pedidas,
    probe: async (url) => {
      pedidas.push(url)
      const declarada = respuestas[url]
      const ruta = (() => {
        try {
          return new URL(url).pathname
        } catch {
          return url
        }
      })()
      const porRuta = respuestas[ruta]
      const elegida = declarada ?? porRuta
      if (!elegida) return { url, status: 404, headers: {}, body: '', truncado: false }
      return {
        url,
        status: elegida.status,
        headers: elegida.headers ?? {},
        body: elegida.body ?? '',
        truncado: false,
      }
    },
  }
}
