'use client'

import { useState, useTransition, type ReactNode } from 'react'
import { ConfirmDialog, notify } from '@/components/ui'
import { deleteProjectAction } from './actions'

export interface DeleteProjectDialogProps {
  projectId: string
  projectName: string
  /** Recibe la función para abrir el diálogo; devolvé el disparador. */
  trigger: (open: () => void) => ReactNode
  onDeleted?: () => void
}

/**
 * Borrado real de un proyecto, con confirmación fuerte: hay que escribir el
 * nombre exacto. La promesa del producto es que el código desaparece —
 * tiene que ser cierto, así que esto llama al mismo RPC que hace el borrado
 * de verdad, no una baja lógica.
 */
export function DeleteProjectDialog({
  projectId,
  projectName,
  trigger,
  onDeleted,
}: DeleteProjectDialogProps) {
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()

  function confirmar() {
    startTransition(async () => {
      const result = await deleteProjectAction(projectId)
      if (!result.ok) {
        notify.problema(result.error ?? 'No pudimos borrar el proyecto.')
        return
      }
      setOpen(false)
      notify.ok(`Borramos "${projectName}". El código ya no está.`)
      onDeleted?.()
    })
  }

  return (
    <>
      {trigger(() => setOpen(true))}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`¿Borrar "${projectName}"?`}
        destructive
        consequences={[
          'Borramos el proyecto, sus hallazgos, videos y grabaciones.',
          'El código que subiste o conectamos desaparece de verdad.',
          'Esto no se puede deshacer.',
        ]}
        requireTyping={projectName}
        confirmLabel="Borrar proyecto"
        loading={pending}
        onConfirm={confirmar}
      />
    </>
  )
}
