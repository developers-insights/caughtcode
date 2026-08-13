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
import { registerHandlersFor } from '@/server/jobs/handlers'
import { describeError } from '@/server/jobs/errors'
import { vencerEncoladosDesatendidos } from '@/server/jobs/encolados'
import { CANDADO_TICK, requeueExpired, soltarCandado, tomarCandado } from '@/server/jobs/queue'
import { barrerCorridasHuerfanas } from '@/server/jobs/reconcile'
import { JOB_KINDS, isJobKind } from '@/server/jobs/registry'
import { processBatch } from '@/server/jobs/runner'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
/** Vercel Pro permite hasta 300 s. En Hobby el techo es 60 y este valor se recorta solo. */
export const maxDuration = 300

/** Margen para responder antes de que la función se muera por timeout. */
const SAFETY_MARGIN_MS = 20_000

/**
 * Uno. No tres.
 *
 * Esta función se muere por memoria (medido: "instance was killed because it ran
 * out of available memory", dos veces el mismo día). Una función que puede morir
 * a mitad de camino no debería tener tres trabajos en la mano: cada uno que
 * agarra es uno más que queda inmovilizado hasta que le vence el lease. Con el
 * cron cada 60 s y el candado de abajo, tomar de a uno no baja el rendimiento —
 * lo hace previsible.
 */
const DEFAULT_MAX_JOBS = 1

/**
 * Cuánto dura el candado del tick.
 *
 * Tiene que cubrir la vida entera de la invocación, porque el caso que importa
 * es justamente el que NO llega a soltarlo: si Vercel mata la instancia por OOM,
 * el `finally` no corre y lo único que libera el candado es el vencimiento.
 *
 * `maxDuration` es el techo duro de una función en Vercel, así que 30 s más que
 * eso no puede dejar afuera a un titular todavía vivo. En el peor caso —muerte
 * súbita al segundo 5— el cron se saltea unos cinco disparos y sigue solo. Que
 * es exactamente lo que queremos que pase cuando la instancia se está muriendo:
 * dejar de apilarle invocaciones encima.
 */
const LOCK_TTL_SECONDS = maxDuration + 30

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

/**
 * Lo que esta función puede atender de verdad. No es lo mismo que `JOB_KINDS`.
 *
 * `run_browser_agent` y `generate_video` **no funcionan en Vercel** y no es una
 * cuestión de configuración: el paquete de la función serverless no trae los
 * navegadores de Playwright. Cada tick lo dejaba dicho en el registro, uno por
 * minuto, durante días:
 *
 *     [jobs] no se pudo cargar "agent": Cannot find module
 *     '/var/task/node_modules/playwright-core/browsers.json'
 *
 * Pedirlos igual sale caro dos veces: se importan módulos pesados (playwright,
 * ffmpeg) para nada, que es justo lo que llena la memoria de la instancia
 * compartida, y se toma un trabajo que solo puede terminar en "handler no
 * registrado" — quemándole intentos a una corrida que iba bien.
 *
 * Esos dos tipos son del worker dedicado (ver `docs/DEPLOY-WORKER.md`), que sí
 * tiene navegador. `build_tutorials` viaja con ellos porque vive en el mismo
 * módulo de video.
 *
 * Se puede pedir cualquier tipo a mano con `?kinds=`: esto es el default, no
 * una prohibición.
 */
const KINDS_EN_SERVERLESS: JobKind[] = JOB_KINDS.filter(
  (kind) => !['run_browser_agent', 'generate_video', 'build_tutorials'].includes(kind),
)

function parseKinds(raw: string | null | undefined): JobKind[] {
  if (!raw) return KINDS_EN_SERVERLESS
  const parsed = raw
    .split(',')
    .map((value) => value.trim())
    .filter(isJobKind)
  return parsed.length > 0 ? parsed : KINDS_EN_SERVERLESS
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

  const titular = `tick-${tickId}`

  try {
    // Primero el candado, antes de importar un solo módulo de handlers: si ya
    // hay un tick corriendo, esta invocación tiene que costar lo mínimo posible.
    // Cargar tree-sitter y ffmpeg para después no hacer nada es justo lo que
    // llenaba la memoria de la instancia compartida.
    const candado = await tomarCandado(CANDADO_TICK, titular, LOCK_TTL_SECONDS)
    if (candado === 'ocupado') {
      return NextResponse.json(
        { ok: true, saltado: true, motivo: 'ya hay un tick corriendo', tickId },
        { headers: { 'cache-control': 'no-store' } },
      )
    }

    try {
      // Solo los módulos de los tipos que esta tanda va a atender.
      await registerHandlersFor(kinds)

      let recuperados = 0
      try {
        recuperados = await requeueExpired()
      } catch (error) {
        // Que falle la recuperación no debería impedir procesar la cola.
        console.warn(`[tick ${tickId}] no se pudieron recuperar vencidos: ${describeError(error)}`)
      }

      // Esta lista deja tipos afuera (ver `KINDS_EN_SERVERLESS`), así que la
      // cola puede tener encolados que este proceso nunca va a tomar. Si además
      // nadie más los toma, hay que darlos por perdidos: si no, su corrida no
      // cierra nunca y la pantalla gira para siempre. Va ANTES de la barrida,
      // que es la que después encuentra la corrida ya destrabada.
      let encoladosVencidos = 0
      try {
        encoladosVencidos = (await vencerEncoladosDesatendidos()).vencidos
        if (encoladosVencidos > 0) {
          console.log(
            `[tick ${tickId}] di por perdidos ${encoladosVencidos} trabajo(s) que nadie tomó.`,
          )
        }
      } catch (error) {
        console.warn(
          `[tick ${tickId}] no se pudo revisar la cola en espera: ${describeError(error)}`,
        )
      }

      // Red de seguridad: una corrida abierta sin trabajos pendientes se cierra
      // igual, sin depender de que a alguien le toque terminar último.
      let corridasCerradas = 0
      try {
        corridasCerradas = (await barrerCorridasHuerfanas()).cerradas
        if (corridasCerradas > 0) {
          console.log(`[tick ${tickId}] cerré ${corridasCerradas} auditoría(s) que quedaron abiertas.`)
        }
      } catch (error) {
        console.warn(`[tick ${tickId}] no se pudo barrer auditorías abiertas: ${describeError(error)}`)
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
          encoladosVencidos,
          corridasCerradas,
          ...summary,
          duracionMs: Date.now() - startedAt,
        },
        { headers: { 'cache-control': 'no-store' } },
      )
    } finally {
      // Se suelta pase lo que pase, incluso si la tanda explotó: el `finally`
      // corre antes de que el error suba al catch de afuera. Lo único que puede
      // saltearlo es que la instancia muera, y para eso está el vencimiento.
      if (candado === 'tomado') await soltarCandado(CANDADO_TICK, titular)
    }
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
