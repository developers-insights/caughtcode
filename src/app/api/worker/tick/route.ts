/**
 * Disparo de la cola desde Vercel Cron (o desde cualquier cosa que tenga el secreto).
 *
 * Vercel manda un GET cada minuto con `Authorization: Bearer $CRON_SECRET`.
 * También acepta POST, para poder empujar la cola a mano después de encolar algo
 * y no esperar hasta el próximo minuto.
 *
 * Este endpoint **no** reemplaza al worker largo (`pnpm worker`): una función
 * serverless tiene minutos, no horas. Sirve para tandas cortas y para que nada
 * quede colgado si el worker se cayó.
 */

import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'

import type { JobKind } from '@/lib/types/domain'
import { env } from '@/lib/env'
import { registerAllHandlers } from '@/server/jobs/handlers'
import { describeError } from '@/server/jobs/errors'
import { requeueExpired } from '@/server/jobs/queue'
import { JOB_KINDS, isJobKind } from '@/server/jobs/registry'
import { processBatch } from '@/server/jobs/runner'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
/** Vercel Pro permite hasta 300 s. En Hobby el techo es 60 y este valor se recorta solo. */
export const maxDuration = 300

/** Margen para responder antes de que la función se muera por timeout. */
const SAFETY_MARGIN_MS = 20_000
const DEFAULT_MAX_JOBS = 3

/** Compara sin filtrar información por el tiempo que tarda. */
function secretMatches(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false
  let diff = 0
  for (let index = 0; index < provided.length; index += 1) {
    diff |= provided.charCodeAt(index) ^ expected.charCodeAt(index)
  }
  return diff === 0
}

function isAuthorized(request: Request): boolean {
  const header = request.headers.get('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!token) return false

  const secrets = [env.cronSecret(), env.workerSecret()].filter(
    (value): value is string => Boolean(value),
  )
  // Sin secreto configurado, el endpoint queda cerrado. Nunca abierto por omisión.
  if (secrets.length === 0) return false

  return secrets.some((secret) => secretMatches(token, secret))
}

function parseKinds(raw: string | null | undefined): JobKind[] {
  if (!raw) return JOB_KINDS
  const parsed = raw
    .split(',')
    .map((value) => value.trim())
    .filter(isJobKind)
  return parsed.length > 0 ? parsed : JOB_KINDS
}

async function handle(request: Request): Promise<Response> {
  if (!isAuthorized(request)) {
    return NextResponse.json(
      { ok: false, error: 'No autorizado.' },
      { status: 401, headers: { 'cache-control': 'no-store' } },
    )
  }

  const startedAt = Date.now()
  const url = new URL(request.url)

  let body: { max?: number; kinds?: string } = {}
  if (request.method === 'POST') {
    try {
      body = (await request.json()) as typeof body
    } catch {
      body = {}
    }
  }

  const requestedMax = Number(body.max ?? url.searchParams.get('max') ?? DEFAULT_MAX_JOBS)
  const max = Number.isFinite(requestedMax) ? Math.min(Math.max(1, requestedMax), 20) : DEFAULT_MAX_JOBS
  const kinds = parseKinds(body.kinds ?? url.searchParams.get('kinds'))
  const tickId = randomUUID().slice(0, 8)

  try {
    await registerAllHandlers()

    let recuperados = 0
    try {
      recuperados = await requeueExpired()
    } catch (error) {
      // Que falle la recuperación no debería impedir procesar la cola.
      console.warn(`[tick ${tickId}] no se pudieron recuperar vencidos: ${describeError(error)}`)
    }

    const summary = await processBatch({
      kinds,
      max,
      deadlineAt: startedAt + maxDuration * 1000 - SAFETY_MARGIN_MS,
      log: (message) => console.log(`[tick ${tickId}] ${message}`),
    })

    return NextResponse.json(
      {
        ok: true,
        tickId,
        recuperados,
        ...summary,
        duracionMs: Date.now() - startedAt,
      },
      { headers: { 'cache-control': 'no-store' } },
    )
  } catch (error) {
    console.error(`[tick ${tickId}] falló: ${describeError(error)}`)
    return NextResponse.json(
      { ok: false, tickId, error: describeError(error), duracionMs: Date.now() - startedAt },
      { status: 500, headers: { 'cache-control': 'no-store' } },
    )
  }
}

export async function GET(request: Request): Promise<Response> {
  return handle(request)
}

export async function POST(request: Request): Promise<Response> {
  return handle(request)
}
