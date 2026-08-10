/**
 * Pantalla de comentarios.
 *
 * Regla que ordena todo lo de esta carpeta:
 * **el alcance decide la posición y el peso; el riesgo decide el color.**
 */

export { CommentsScreen, type CommentsScreenProps } from './comments-screen'
export { CommentScanSummary, ICONO_ALCANCE, type CommentScanSummaryProps } from './comment-scan-summary'
export { ReachSection, type ReachSectionProps } from './reach-section'
export { CommentRow, type CommentRowProps } from './comment-row'
export { RiskBadge, type RiskBadgeProps } from './risk-badge'
export { CleanModeSelector, type CleanModeSelectorProps } from './clean-mode-selector'
export { CleanPreview, type CleanPreviewProps } from './clean-preview'
export { FunctionalCommentsPanel, type FunctionalCommentsPanelProps } from './functional-comments-panel'
export { ApplyPanel, type ApplyPanelProps } from './apply-panel'

export {
  construirModelo,
  esRiesgoso,
  filaDesdeHit,
  nombreDeAlcance,
  nombreDeRiesgo,
  repartoPorAlcance,
  tonoDeRiesgo,
  tonoDelGrupo,
  veredicto,
  type CommentRowModel,
  type CommentsViewModel,
  type FileSummary,
  type FuncionalesResumen,
  type ReachGroup,
  type Veredicto,
} from './model'

export {
  MODOS,
  nombreDelParche,
  type CleanFileDiff,
  type CleanMode,
  type CleanPlanView,
  type Resultado,
} from './model-clean'

export { redactar } from './redact'

export {
  alinear,
  ventanaDeCambio,
  type EstadoLinea,
  type Ventana,
  type VentanaDeCambio,
} from './diff-window'
