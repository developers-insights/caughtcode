import type { CommentRisk } from '@/lib/types/domain'
import { Badge, type Tone } from '@/components/ui'
import { nombreDeRiesgo, tonoDeRiesgo } from './model'

export interface RiskBadgeProps {
  risk: CommentRisk
  size?: 'sm' | 'md'
  /**
   * Mostrar también los comentarios comunes. Por defecto no se muestran:
   * si cada fila lleva una insignia, la que importa deja de destacarse.
   */
  showNone?: boolean
  /**
   * Pisa el color. Se usa para los comentarios que no salen del servidor:
   * se dice qué son, pero en gris, porque ahí no le hacen daño a nadie.
   */
  tone?: Tone
  className?: string
}

/**
 * Qué dice este comentario, en las palabras de producto.
 *
 * El comentario común no lleva insignia. Es la misma regla que rige los
 * hallazgos: lo menor no lleva color, para que lo grave se vea sin leer.
 */
export function RiskBadge({
  risk,
  size = 'sm',
  showNone = false,
  tone: toneProp,
  className,
}: RiskBadgeProps) {
  if (risk === 'none' && !showNone) return null

  const tone = toneProp ?? tonoDeRiesgo(risk)

  return (
    <Badge
      tone={tone}
      variant={risk === 'secret' && tone === 'expuesto' ? 'solid' : 'soft'}
      size={size}
      dot={risk !== 'none' && !(risk === 'secret' && tone === 'expuesto')}
      className={className}
    >
      {nombreDeRiesgo(risk)}
    </Badge>
  )
}
