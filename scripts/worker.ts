/**
 * Worker standalone de caughtcode. Se corre con `pnpm worker`.
 *
 * Es el proceso que hace el trabajo pesado: traer el repo, indexarlo, correr los
 * chequeos, manejar el agente de navegación, renderizar videos. Todo eso son
 * minutos, así que nunca va adentro de un request.
 *
 * ## El respawn del arranque (no es magia negra)
 *
 * `src/lib/supabase/admin.ts` arranca con `import 'server-only'`, que es un
 * paquete que **tira una excepción a propósito** cuando se lo importa fuera del
 * runtime de React Server Components. Node resuelve ese paquete a su versión
 * vacía solo si la condición de exports `react-server` está activa. Next la
 * activa sola; `tsx` no.
 *
 * Por eso este script, en el primer arranque, se vuelve a lanzar a sí mismo con
 * `--conditions=react-server` (y de paso carga `.env.local`). Una sola vez, con
 * una marca en el entorno para no entrar en loop.
 *
 * Si algún día `package.json` puede cambiarse, el script pasa a ser
 * `tsx --conditions=react-server --env-file-if-exists=.env.local scripts/worker.ts`
 * y este bloque se borra.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import pLimit from 'p-limit'

import type { JobKind, JobRecord } from '@/lib/types/domain'
import { FrenoDeFallas } from '@/server/jobs/circuit'
import { describeError } from '@/server/jobs/errors'
import { registerAllHandlers } from '@/server/jobs/handlers'
import { claim, releaseLease, requeueExpired, DEFAULT_LEASE_SECONDS } from '@/server/jobs/queue'
import { JOB_KINDS, isJobKind, pendingKinds } from '@/server/jobs/registry'
import { runClaimedJob } from '@/server/jobs/runner'

const BOOTSTRAP_FLAG = 'CAUGHTCODE_WORKER_BOOTSTRAPPED'

interface WorkerConfig {
  kinds: JobKind[]
  concurrency: number
  leaseSeconds: number
  pollMs: number
  requeueMs: number
  shutdownGraceMs: number
  workerId: string
}

function readConfig(): WorkerConfig {
  const rawKinds = (process.env.WORKER_KINDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  const kinds = rawKinds.length > 0 ? rawKinds.filter(isJobKind) : JOB_KINDS
  const invalid = rawKinds.filter((value) => !isJobKind(value))
  if (invalid.length > 0) {
    log(`Aviso: WORKER_KINDS tiene tipos que no existen y se ignoran: ${invalid.join(', ')}`)
  }

  return {
    kinds,
    concurrency: positiveInt(process.env.WORKER_CONCURRENCY, 2),
    leaseSeconds: positiveInt(process.env.WORKER_LEASE_SECONDS, DEFAULT_LEASE_SECONDS),
    pollMs: positiveInt(process.env.WORKER_POLL_MS, 2000),
    requeueMs: positiveInt(process.env.WORKER_REQUEUE_MS, 60_000),
    shutdownGraceMs: positiveInt(process.env.WORKER_SHUTDOWN_GRACE_MS, 60_000),
    workerId: process.env.WORKER_ID ?? `worker-${randomUUID().slice(0, 8)}`,
  }
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function log(message: string): void {
  const now = new Date().toISOString().slice(11, 23)
  console.log(`${now}  ${message}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/* ── Arranque ────────────────────────────────────────────────────────── */

async function hasReactServerCondition(): Promise<boolean> {
  try {
    await import('server-only')
    return true
  } catch {
    return false
  }
}

function respawn(): void {
  const args = [
    '--conditions=react-server',
    '--env-file-if-exists=.env.local',
    ...process.execArgv,
    ...process.argv.slice(1),
  ]
  const child = spawn(process.argv[0], args, {
    stdio: 'inherit',
    env: { ...process.env, [BOOTSTRAP_FLAG]: '1' },
  })
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exit(code ?? 0)
  })
}

function checkEnvironment(): string[] {
  const required = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']
  return required.filter((key) => !process.env[key])
}

/* ── Loop principal ──────────────────────────────────────────────────── */

async function main(): Promise<void> {
  if (!process.env[BOOTSTRAP_FLAG] && !(await hasReactServerCondition())) {
    respawn()
    return
  }

  const config = readConfig()
  const missing = checkEnvironment()
  if (missing.length > 0) {
    console.error(
      `\nNo puedo arrancar: falta configurar ${missing.join(' y ')}.\n` +
        'Completá esas variables en .env.local (mirá .env.example) y volvé a correr `pnpm worker`.\n',
    )
    process.exit(1)
  }

  await registerAllHandlers()

  const faltantes = pendingKinds()
  log(`caughtcode worker ${config.workerId} arriba.`)
  log(`  tipos: ${config.kinds.join(', ')}`)
  log(`  concurrencia: ${config.concurrency} · lease: ${config.leaseSeconds}s`)
  if (faltantes.length > 0) {
    log(`  sin handler todavía: ${faltantes.join(', ')}`)
  }

  const limit = pLimit(config.concurrency)
  const inFlight = new Map<string, { kind: JobKind; startedAt: number }>()
  // Si el runner ni siquiera puede registrar que un trabajo falló, reintentar
  // enseguida no arregla nada: solo martilla la base. Ver `circuit.ts`.
  const freno = new FrenoDeFallas()
  const shutdownController = new AbortController()
  let running = true
  let shuttingDown = false

  const requeueTimer = setInterval(() => {
    void requeueExpired()
      .then((count) => {
        if (count > 0) log(`Recuperados ${count} trabajo(s) de un worker caído.`)
      })
      .catch((error) => log(`No se pudieron recuperar trabajos vencidos: ${describeError(error)}`))
  }, config.requeueMs)

  const startJob = (job: JobRecord) => {
    inFlight.set(job.id, { kind: job.kind, startedAt: Date.now() })
    void limit(async () => {
      try {
        const outcome = await runClaimedJob(job, {
          leaseSeconds: config.leaseSeconds,
          log,
          signal: shutdownController.signal,
        })
        const seconds = (outcome.durationMs / 1000).toFixed(1)
        log(
          `${outcome.kind} ${outcome.jobId.slice(0, 8)} → ${outcome.outcome} en ${seconds}s ` +
            `(US$ ${outcome.costUsd.toFixed(4)})`,
        )
        // El trabajo pudo cerrarse (aunque haya fallado): el sistema funciona.
        freno.exito()
      } catch (error) {
        freno.falla()
        log(`Error inesperado ejecutando ${job.kind}: ${describeError(error)}`)
      } finally {
        inFlight.delete(job.id)
      }
    })
  }

  const shutdown = async (signalName: string) => {
    if (shuttingDown) return
    shuttingDown = true
    running = false
    log(`Recibí ${signalName}. No tomo trabajos nuevos; termino lo que tengo en mano.`)

    const deadline = Date.now() + config.shutdownGraceMs
    while (inFlight.size > 0 && Date.now() < deadline) {
      await sleep(250)
    }

    if (inFlight.size > 0) {
      log(`Se acabó el tiempo de gracia con ${inFlight.size} trabajo(s) a medio hacer.`)
      shutdownController.abort()
      await sleep(1500)
      for (const [jobId, info] of inFlight) {
        try {
          await releaseLease(jobId, 'El worker se apagó a mitad del trabajo. Se reintenta solo.')
          log(`Devuelto a la cola: ${info.kind} ${jobId.slice(0, 8)}`)
        } catch (error) {
          log(`No pude devolver ${jobId.slice(0, 8)} a la cola: ${describeError(error)}`)
        }
      }
    }

    clearInterval(requeueTimer)
    log('Listo. Chau.')
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  try {
    await requeueExpired()
  } catch (error) {
    log(`No se pudieron recuperar trabajos vencidos al arrancar: ${describeError(error)}`)
  }

  while (running) {
    if (limit.activeCount + limit.pendingCount >= config.concurrency) {
      await sleep(150)
      continue
    }

    // Freno: varias fallas inesperadas seguidas quieren decir que algo de fondo
    // está roto y golpear más rápido no lo arregla.
    const espera = freno.esperaMs()
    if (espera > 0) {
      if (freno.debeAvisar()) {
        log(
          `${freno.seguidas} fallas inesperadas seguidas. Bajo el ritmo ` +
            `(hasta ${Math.round(espera / 1000)}s entre intentos) hasta que algo salga bien.`,
        )
      }
      await sleep(espera)
      if (!running) break
    }

    let job: JobRecord | null = null
    try {
      job = await claim(config.kinds, config.leaseSeconds)
    } catch (error) {
      log(`No pude consultar la cola: ${describeError(error)}`)
      await sleep(Math.max(config.pollMs, 5000))
      continue
    }

    if (!job) {
      await sleep(config.pollMs)
      continue
    }

    log(`Tomado: ${job.kind} ${job.id.slice(0, 8)} (intento ${job.attempts}/${job.maxAttempts})`)
    startJob(job)
  }
}

main().catch((error) => {
  console.error(`El worker se cayó: ${describeError(error)}`)
  process.exit(1)
})
