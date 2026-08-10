/**
 * Pantalla de hallazgos.
 *
 * Todo lo visible sale de las primitivas de `@/components/ui` y de los tokens
 * del sistema. Acá no se define ni un color ni una duración: solo la forma que
 * toma un hallazgo cuando se lo muestra.
 *
 * Guía de uso: docs/DESIGN.md
 */

export { EvidenceBlock, EvidenceList, type EvidenceBlockProps, type EvidenceListProps } from './evidence-block'
export { FindingCard, emphasisDeTarjeta, type FindingCardProps } from './finding-card'
export { FindingDetail, type FindingDetailProps } from './finding-detail'
export { FindingStatusControl, type FindingStatusControlProps } from './finding-status-control'
export { FindingsBoard, type FindingsBoardProps } from './findings-board'
export { FixPromptPanel, type FixPromptPanelProps } from './fix-prompt-panel'
export { PillarSection, type PillarSectionProps } from './pillar-section'
export {
  ReviewFailed,
  ReviewNotStarted,
  ReviewQueued,
  ReviewRetryAction,
  type ReviewFailedProps,
  type ReviewNotStartedProps,
  type ReviewQueuedProps,
  type ReviewRetryActionProps,
} from './review-state'
export {
  RunFailedNotice,
  RunPartialNotice,
  RunProgress,
  type RunFailedNoticeProps,
  type RunProgressProps,
} from './run-progress'
export { SeverityIndicator, type SeverityIndicatorProps } from './severity-indicator'
export { TranscriptPanel, type TranscriptPanelProps } from './transcript-panel'
export { VideoPlayer, type VideoPlayerProps } from './video-player'

export { aFinding, aJob, aRun, aVideo } from './mappers'

export {
  MAX_DESTACADOS,
  TRABAJOS_DE_REVISION,
  agruparPorPilar,
  contarSinResolver,
  cueActivo,
  cuesDelGuion,
  esTrabajoDeRevision,
  estaCorriendo,
  estadoDeRevision,
  filtrarCues,
  momentoEnGrabacion,
  ordenarHallazgos,
  partirHallazgos,
  peorGravedad,
  reloj,
  seCorto,
  terminoAMedias,
  tieneEvidencia,
  type Cue,
  type EstadoDeRevision,
  type FindingVideo,
  type GrupoPorPilar,
  type JobView,
  type ListaDeHallazgos,
  type RunStatus,
  type RunView,
  type VideoStatus,
} from './view'

export * as findingsCopy from './copy'
