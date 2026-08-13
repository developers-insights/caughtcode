/**
 * Punto de entrada de la cola de trabajos.
 *
 * Para el resto de los frentes, lo importante es corto:
 *
 * ```ts
 * import { enqueue, registerHandler, runStages } from '@/server/jobs'
 *
 * registerHandler('run_checks', async (payload, ctx) => {
 *   await runStages(ctx, [
 *     { name: 'preparar', label: 'Preparando la revisión', run: async () => ({ ok: true }) },
 *     { name: 'revisar',  label: 'Revisando tu proyecto',  run: async ({ get }) => { ... } },
 *   ])
 * })
 *
 * const jobId = await enqueue({ orgId, projectId, analysisRunId, kind: 'run_checks', payload })
 * ```
 */

export {
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  computeBackoffMs,
  isLastAttempt,
  nextRunAfter,
  type BackoffOptions,
} from './backoff'

export {
  HandlerNotRegisteredError,
  JobAbortedError,
  JobError,
  describeError,
  isRetryable,
} from './errors'

export { setJobsDb, type JobsDb } from './db'

export {
  DEFAULT_LEASE_SECONDS,
  DEFAULT_MAX_ATTEMPTS,
  adelantarOEncolar,
  cancel,
  claim,
  encolarUnaVezPorCorrida,
  enqueue,
  enqueueMany,
  fail,
  getJob,
  heartbeat,
  listJobs,
  releaseLease,
  requeueExpired,
  savePayload,
  succeed,
  toJobRecord,
  type EnqueueDeCorridaInput,
  type EnqueueInput,
  type FailOptions,
  type FailOutcome,
  type ListJobsFilter,
  type ResultadoAdelanto,
} from './queue'

export {
  JOB_KINDS,
  JOB_KIND_LABEL,
  defineHandler,
  getHandler,
  hasRealHandler,
  isJobKind,
  pendingKinds,
  registerHandler,
  registeredKinds,
  resetHandlers,
  type JobContext,
  type JobHandler,
} from './registry'

export {
  MAX_STAGE_RESULT_BYTES,
  STAGE_RESULTS_KEY,
  clearStageResults,
  completedStages,
  jobPayloadStore,
  runStages,
  type RunStagesOptions,
  type StageDefinition,
  type StageRunContext,
  type StageStore,
} from './stages'

export {
  ESTADOS_CERRADOS,
  markRunFinished,
  markRunStarted,
  publishRunProgress,
  readRunProgress,
  readRunProgressAsAdmin,
  reopenRun,
  runProgressChannel,
  type RunProgressUpdate,
} from './progress'

export {
  ETAPA_TERMINADA,
  TRABAJOS_DE_REVISION,
  barrerCorridasHuerfanas,
  esTrabajoDeRevision,
  reconcileRunStatus,
  type ResultadoBarrida,
  type ResultadoReconciliacion,
} from './reconcile'

export {
  ESPERA_MAXIMA_EN_COLA_MS,
  motivoDesatendido,
  vencerEncoladosDesatendidos,
  type OpcionesVencimiento,
  type ResultadoVencimiento,
} from './encolados'

export {
  HEARTBEAT_MS,
  processBatch,
  processNextJob,
  runClaimedJob,
  type BatchOptions,
  type BatchSummary,
  type JobOutcome,
  type RunnerOptions,
} from './runner'
