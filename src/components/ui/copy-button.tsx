'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button, type ButtonSize, type ButtonVariant } from './button'

async function writeToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* cae al plan B */
  }

  // Plan B para navegadores viejos o contextos sin https.
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}

export interface CopyButtonProps {
  /** Texto que se copia. Para el prompt de arreglo, el prompt entero. */
  value: string
  label?: string
  copiedLabel?: string
  failedLabel?: string
  variant?: ButtonVariant
  size?: ButtonSize
  iconOnly?: boolean
  className?: string
  onCopied?: () => void
}

/**
 * Copia y lo confirma en el mismo botón.
 * La confirmación se anuncia también por aria-live: si copiaste con el
 * teclado, el lector de pantalla te lo dice.
 */
export function CopyButton({
  value,
  label = 'Copiar',
  copiedLabel = 'Copiado',
  failedLabel = 'No se pudo copiar',
  variant = 'secondary',
  size = 'sm',
  iconOnly = false,
  className,
  onCopied,
}: CopyButtonProps) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(timer.current), [])

  const copy = useCallback(async () => {
    const ok = await writeToClipboard(value)
    setState(ok ? 'copied' : 'failed')
    if (ok) onCopied?.()
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setState('idle'), 2200)
  }, [value, onCopied])

  const text = state === 'copied' ? copiedLabel : state === 'failed' ? failedLabel : label

  return (
    <>
      <Button
        variant={variant}
        size={size}
        iconOnly={iconOnly}
        onClick={copy}
        aria-label={iconOnly ? text : undefined}
        className={cn(state === 'copied' && 'text-verificado-text', className)}
        icon={
          state === 'copied' ? (
            <Check strokeWidth={2.4} />
          ) : (
            <Copy strokeWidth={1.9} />
          )
        }
      >
        {!iconOnly && text}
      </Button>
      <span aria-live="polite" className="sr-only">
        {state === 'copied' ? copiedLabel : state === 'failed' ? failedLabel : ''}
      </span>
    </>
  )
}
