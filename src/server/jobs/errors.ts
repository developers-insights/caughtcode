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

export interface HandlerNotRegisteredOptions {
  /** Cómo se llama esa etapa en castellano (`JOB_KIND_LABEL`). */
  etapa?: string
  /**
   * `true` cuando la capacidad está **declarada y todavía no construida** (no
   * existe el motor), y no cuando simplemente no se pudo cargar su módulo en
   * este proceso. Son dos cosas distintas y no se pueden contar igual: decirle
   * "todavía no lo construimos" a alguien cuyo video sí existe pero no cargó
   * sería mentirle.
   */
  sinMotor?: boolean
}

/**
 * Nadie puede ejecutar este tipo de trabajo en este proceso.
 *
 * Pasa por dos motivos muy distintos:
 *
 *   - la capacidad está declarada pero **no construida** (`sinMotor`), o
 *   - el módulo que la trae **no cargó acá** (el caso real: Playwright no viaja
 *     en la función serverless de Vercel).
 *
 * El mensaje termina en `jobs.last_error` y de ahí puede llegar a la pantalla,
 * así que va sin jerga: nada de "handler", "stub" ni el nombre interno del tipo
 * de trabajo. Para los logs y para filtrar está `kind`, que no se muestra.
 */
export class HandlerNotRegisteredError extends JobError {
  /** El `JobKind` que no se pudo ejecutar. Para logs, no para pantalla. */
  readonly kind: string

  constructor(kind: string, options: HandlerNotRegisteredOptions = {}) {
    const etapa = options.etapa?.trim() || 'Una parte de la revisión'
    super(
      options.sinMotor
        ? `«${etapa}» es algo que todavía no sabemos hacer: la función está anunciada pero ` +
            'no construida, así que no la hicimos. El resto de tu revisión no se ve afectado.'
        : `«${etapa}» no estuvo disponible y no llegamos a hacerla. Lo que sí alcanzamos a ` +
            'revisar sigue valiendo, y podés volver a pedir la revisión para intentarlo de nuevo.',
      {
        retryable: false,
        code: options.sinMotor ? 'capacidad_no_construida' : 'handler_no_registrado',
      },
    )
    this.name = 'HandlerNotRegisteredError'
    this.kind = kind
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
