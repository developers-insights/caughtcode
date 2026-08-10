'use client'

import type { ReactNode } from 'react'
import { Toaster as SonnerToaster, toast } from 'sonner'
import { CircleCheck, Info, OctagonAlert, TriangleAlert } from 'lucide-react'

/**
 * Avisos efímeros. Van para confirmar algo que ya pasó ("Copiado",
 * "Proyecto renombrado"). NO van para errores que el usuario tiene que
 * resolver: eso es un ErrorState o un Callout en la pantalla, que no se
 * autodestruye a los 4 segundos.
 */

export { toast }

export function Toaster() {
  return (
    <SonnerToaster
      position="bottom-right"
      duration={4000}
      gap={10}
      offset={20}
      visibleToasts={3}
      icons={{
        success: <CircleCheck className="size-[1.15rem] text-verificado" strokeWidth={2} />,
        error: <OctagonAlert className="size-[1.15rem] text-expuesto" strokeWidth={2} />,
        warning: <TriangleAlert className="size-[1.15rem] text-incompleto" strokeWidth={2} />,
        info: <Info className="size-[1.15rem] text-revisar" strokeWidth={2} />,
      }}
      toastOptions={{
        classNames: {
          toast:
            'font-sans! text-base! rounded-md! border! border-line! bg-surface-raised! text-ink! shadow-float!',
          description: 'text-ink-muted! text-sm!',
          actionButton: 'bg-ink! text-ink-inverse! rounded-sm! text-sm! font-medium!',
          cancelButton: 'bg-transparent! text-ink-muted! rounded-sm! text-sm!',
          closeButton: 'bg-surface! border-line! text-ink-muted!',
        },
      }}
      style={
        {
          '--normal-bg': 'var(--cc-surface-raised)',
          '--normal-text': 'var(--cc-ink)',
          '--normal-border': 'var(--cc-line)',
          '--border-radius': 'var(--radius-md)',
        } as React.CSSProperties
      }
    />
  )
}

interface NotifyOptions {
  description?: ReactNode
  /** Acción de deshacer. Toda acción destructiva reversible debería tenerla. */
  action?: { label: string; onClick: () => void }
  duration?: number
}

/**
 * Atajos con los nombres del sistema de tonos, para que nadie tenga que
 * acordarse de si "warning" era ámbar o rojo.
 */
export const notify = {
  /** Salió bien. */
  ok: (message: string, options?: NotifyOptions) => toast.success(message, options),
  /** Algo se rompió y el usuario no puede hacer nada al respecto. */
  problema: (message: string, options?: NotifyOptions) => toast.error(message, options),
  /** Salió a medias, o hay algo que mirar. */
  aviso: (message: string, options?: NotifyOptions) => toast.warning(message, options),
  /** Dato neutro. */
  info: (message: string, options?: NotifyOptions) => toast.info(message, options),
  /** Trabajo en curso. Devuelve el id para cerrarlo después. */
  trabajando: (message: string) => toast.loading(message),
  cerrar: (id?: string | number) => toast.dismiss(id),
} as const

/** Ejemplo de uso con deshacer, para copiar:
 *
 *   notify.ok('Hallazgo marcado como resuelto', {
 *     action: { label: 'Deshacer', onClick: () => reabrir(id) },
 *   })
 */
