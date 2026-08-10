/**
 * Primitivas de caughtcode.
 *
 * Importá siempre desde acá: `import { Button, Card } from '@/components/ui'`.
 * Si algo que necesitás no está en esta lista, pedilo — no lo inventes suelto
 * en tu carpeta, porque después no se ve igual que el resto del producto.
 *
 * Guía de uso: docs/DESIGN.md
 */

export { Avatar, type AvatarProps } from './avatar'
export { Badge, SeverityBadge, type BadgeProps, type BadgeVariant } from './badge'
export { Button, buttonStyles, type ButtonProps, type ButtonSize, type ButtonVariant } from './button'
export {
  Bezel,
  Card,
  CardBody,
  CardDescription,
  CardFooter,
  CardHeader,
  CardHeadline,
  CardTitle,
  type CardEmphasis,
  type CardProps,
} from './card'
export { Callout, type CalloutProps } from './callout'
export { Checkbox, type CheckboxProps } from './checkbox'
export { CodeBlock, type CodeBlockProps } from './code-block'
export { ConfirmDialog, type ConfirmCost, type ConfirmDialogProps } from './confirm-dialog'
export { CopyButton, type CopyButtonProps } from './copy-button'
export { Dialog, DialogSection, type DialogProps } from './dialog'
export {
  DropdownItem,
  DropdownLabel,
  DropdownMenu,
  DropdownSeparator,
  type DropdownItemProps,
  type DropdownMenuProps,
} from './dropdown-menu'
export { EmptyState, type EmptyStateProps } from './empty-state'
export { ErrorState, type ErrorKind, type ErrorStateProps } from './error-state'
export { CONTROL_BASE, FieldShell, describedBy, fieldIds, type FieldShellProps } from './field'
export { Input, type InputProps } from './input'
export { MotionProvider } from './motion-provider'
export { Progress, type ProgressProps } from './progress'
export { Select, type SelectProps } from './select'
export { SeverityDot, type SeverityDotProps } from './severity-dot'
export { Skeleton, SkeletonCard, type SkeletonProps } from './skeleton'
export { Spinner, type SpinnerProps } from './spinner'
export { Switch, type SwitchProps } from './switch'
export { Tabs, TabsList, TabsPanel, TabsTrigger, type TabsProps, type TabsTriggerProps } from './tabs'
export { Textarea, type TextareaProps } from './textarea'
export { Toaster, notify, toast } from './toast'
export { Tooltip, type TooltipProps } from './tooltip'

/* Traducción dominio → lenguaje visual. */
export {
  CONFIDENCE_HINT,
  CONFIDENCE_LABEL,
  SEVERITY_LABEL,
  SEVERITY_URGENCY,
  STATUS_LABEL,
  TONE_BORDER,
  TONE_EDGE,
  TONE_LABEL,
  TONE_ON_SOLID,
  TONE_SOFT_BG,
  TONE_SOLID_BG,
  TONE_TEXT,
  visualFor,
  type Emphasis,
  type Tone,
  type VisualState,
} from './severity'

/* Presets de animación. */
export * as motionPresets from './motion'
