/**
 * Limpieza de comentarios — API pública.
 *
 * El pedido original era "un botón que borre todos los comentarios, sobre todo
 * del frontend, por seguridad". La intuición es correcta pero hay que ser
 * preciso, porque no todos los comentarios corren el mismo riesgo:
 *
 * - Los de **HTML** se ven siempre con "ver código fuente".
 * - Los de **JS/TS de cliente** los suele sacar el minificador en producción,
 *   pero sobreviven en desarrollo, en builds sin minificar y en los source maps.
 * - Los de **código de servidor** no salen nunca del servidor.
 *
 * Por eso cada hallazgo trae su `reach`, y por eso el botón no borra todo a
 * ciegas: propone un parche verificado, que el usuario aplica si quiere.
 *
 * Nada de esto escribe en el repo del usuario.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import pLimit from 'p-limit'

import type { CommentScanResult, RouteInfo } from '@/lib/types/domain'

import { buildCleanPlan, type CleanMode, type CleanPlanResult } from './cleaner'
import { buildPatch } from './patch'
import type { FrameworkKind, ReachContext } from './reach'
import { scanFile, type ScannedFile } from './scanner'
import { walkRepo } from './walk'

export type { CleanMode, CleanPlanResult } from './cleaner'
export type { CommentRangeInfo, ScannedFile } from './scanner'
export { scanFile } from './scanner'
export { buildCleanPlan } from './cleaner'
export { verifyChange, type VerifyResult } from './verify'
export { buildPatch, unifiedDiff } from './patch'
export { computeReach, type FrameworkKind, type ReachContext } from './reach'
export { maskSecrets } from './risk'

/** Cuántos archivos se analizan a la vez. Es trabajo de CPU, no de red. */
const CONCURRENCY = 8

export interface ScanProjectOptions {
  /** Rutas ya calculadas por el índice de código: afinan la herencia de `'use client'`. */
  routes?: RouteInfo[]
  /** Si no se pasa, se detecta mirando el repo. */
  framework?: FrameworkKind
  /**
   * Cómo se le devuelve el turno al event loop entre archivo y archivo. Existe
   * para poder verificar en un test que el escaneo de verdad lo suelta: que lo
   * haga no es un detalle interno, es lo que permite que el latido del trabajo y
   * el tope de tiempo del handler puedan dispararse (ver `cederElTurno()`).
   */
  ceder?: () => Promise<void>
}

export interface CleanProjectOptions extends ScanProjectOptions {
  mode?: CleanMode
  /** Limita la limpieza a estas rutas relativas. Si falta, se limpia todo. */
  files?: string[]
}

/** Detecta cómo está armado el proyecto para poder decidir el alcance. */
export function detectFramework(repoPath: string): FrameworkKind {
  const hay = (p: string): boolean => existsSync(join(repoPath, p))
  const esNext =
    hay('next.config.js') || hay('next.config.ts') || hay('next.config.mjs') || hay('next.config.cjs')

  if (hay('app') || hay('src/app')) return 'nextjs-app'
  if (hay('pages') || hay('src/pages')) return 'nextjs-pages'
  if (esNext) return 'nextjs-app'
  if (hay('index.html') || hay('vite.config.ts') || hay('vite.config.js')) return 'spa'
  return 'unknown'
}

/**
 * Le devuelve el turno al event loop.
 *
 * `scanFile` es **sincrónico** y `pLimit` encadena con promesas, o sea con
 * microtareas: sin esto, analizar N archivos es un solo bloque de CPU que no
 * suelta el hilo ni una vez. Los temporizadores viven en otra fase del loop y no
 * llegan a dispararse — ni el latido de fondo que renueva el permiso del trabajo
 * (`runClaimedJob`, cada 15 s), ni el tope de tiempo que el propio handler le
 * pone a este escaneo. Los dos controles existían y ninguno de los dos podía
 * actuar. Un `setImmediate` por archivo cuesta nada al lado de tokenizar el
 * archivo entero, y hace que los dos vuelvan a funcionar.
 */
function cederElTurno(): Promise<void> {
  return new Promise((resolver) => setImmediate(resolver))
}

async function scanAll(repoPath: string, opts: ScanProjectOptions): Promise<ScannedFile[]> {
  const files = await walkRepo(repoPath)
  const ctx: ReachContext = {
    framework: opts.framework ?? detectFramework(repoPath),
    routes: opts.routes,
  }
  const limit = pLimit(CONCURRENCY)
  const ceder = opts.ceder ?? cederElTurno
  return Promise.all(
    files.map((f) =>
      limit(async () => {
        await ceder()
        return scanFile({ file: f.rel, text: f.text }, ctx)
      }),
    ),
  )
}

/** Analiza el repo entero y devuelve los comentarios con su alcance y su riesgo. */
export async function scanProject(
  repoPath: string,
  opts: ScanProjectOptions = {},
): Promise<CommentScanResult> {
  const scanned = await scanAll(repoPath, opts)
  const hits = scanned.flatMap((s) => s.hits)

  return {
    scannedFiles: scanned.length,
    hits,
    exposedCount: hits.filter((h) => h.reach === 'ships_to_browser').length,
    riskyCount: hits.filter((h) => h.risk !== 'none').length,
    removableCount: hits.filter((h) => !h.functional).length,
  }
}

/**
 * Arma el plan de limpieza y su parche. No escribe nada: el usuario decide si lo
 * aplica, y siempre puede revisarlo antes.
 */
export async function cleanProject(
  repoPath: string,
  opts: CleanProjectOptions = {},
): Promise<{ plan: CleanPlanResult; patch: string }> {
  const scanned = await scanAll(repoPath, opts)
  const elegidos = opts.files ? new Set(opts.files) : null
  const target = elegidos ? scanned.filter((s) => elegidos.has(s.file)) : scanned

  const plan = buildCleanPlan(target, { mode: opts.mode ?? 'safe' })
  return { plan, patch: buildPatch(plan) }
}
