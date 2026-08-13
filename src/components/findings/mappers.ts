/**
 * Fila de la base → objeto de dominio.
 *
 * La base habla en `snake_case` y el dominio en `camelCase`. La traducción
 * vive acá y en ningún otro lado: los componentes nunca ven una fila cruda.
 */

import type { AnalysisRunRow, FindingRow, JobRow, VideoRow } from '@/lib/types/database'
import type { Finding } from '@/lib/types/domain'
import type { FindingVideo, JobView, RunView } from './view'

export function aFinding(row: FindingRow): Finding {
  return {
    id: row.id,
    analysisRunId: row.analysis_run_id,
    pillar: row.pillar,
    checkId: row.check_id,
    severity: row.severity,
    confidence: row.confidence,
    status: row.status,
    titlePlain: row.title_plain,
    explanationPlain: row.explanation_plain,
    impactPlain: row.impact_plain,
    fixPrompt: row.fix_prompt,
    evidence: row.evidence ?? [],
    rank: row.rank,
    videoId: row.video_id,
    createdAt: row.created_at,
  }
}

export function aRun(row: AnalysisRunRow): RunView {
  return {
    id: row.id,
    status: row.status,
    stage: row.stage,
    progress: row.progress,
    finishedAt: row.finished_at,
    error: row.error,
  }
}

/**
 * De la cola solo sale lo que la pantalla necesita para saber en qué punto
 * está la revisión. El resto de la fila (payload, intentos, arriendo) es
 * asunto del motor.
 */
export function aJob(
  row: Pick<JobRow, 'id' | 'kind' | 'status' | 'last_error' | 'created_at' | 'updated_at'>,
): JobView {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function aVideo(row: VideoRow): FindingVideo {
  return {
    id: row.id,
    status: row.status,
    url: row.url,
    durationSeconds: row.duration_s,
    transcript: row.transcript,
    script: row.script,
  }
}
