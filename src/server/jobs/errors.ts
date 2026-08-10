/**
 * Errores de la cola. Todos los mensajes van en español y son para que los lea
 * una persona: aparecen en `jobs.last_error` y terminan mostrándose en la UI.
 */

export interface JobErrorOptions {
  /** `false` = no tiene sentido reintentar (falta código, payload inválido, etc.). */
  retryable?: boolean
  /** Código corto para poder filtrar en logs. */
  code?: string
  cause?: unknown
}

export class JobError extends Error {
  readonly retryable: boolean
  readonly code: string

  constructor(message: string, options: JobErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'JobError'
    this.retryable = options.retryable ?? true
    this.code = options.code ?? 'job_error'
  }
}

/** El frente dueño de este tipo de trabajo todavía no publicó su handler. */
export class HandlerNotRegisteredError extends JobError {
  constructor(kind: string) {
    super(
      `El trabajo "${kind}" todavía no tiene quién lo ejecute (handler no registrado todavía).`,
      { retryable: false, code: 'handler_no_registrado' },
    )
    this.name = 'HandlerNotRegisteredError'
  }
}

/** El worker se está apagando y soltó el trabajo a mitad de camino. */
export class JobAbortedError extends JobError {
  constructor(message = 'El trabajo se interrumpió porque el worker se estaba apagando.') {
    super(message, { retryable: true, code: 'job_abortado' })
    this.name = 'JobAbortedError'
  }
}

/** Texto corto y legible de cualquier cosa que se haya tirado. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? ` (causa: ${error.cause.message})` : ''
    return `${error.message}${cause}`.slice(0, 2000)
  }
  if (typeof error === 'string') return error.slice(0, 2000)
  try {
    return JSON.stringify(error).slice(0, 2000)
  } catch {
    return 'Error desconocido'
  }
}

/** Por defecto reintentamos: la mayoría de las fallas son de red o de cuota. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof JobError) return error.retryable
  return true
}
