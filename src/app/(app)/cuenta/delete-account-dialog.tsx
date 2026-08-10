'use client'

import { useState, useTransition } from 'react'
import { Trash2 } from 'lucide-react'
import { Button, ConfirmDialog, notify } from '@/components/ui'
import { deleteAccountAction } from './actions'

export interface DeleteAccountDialogProps {
  /** Se pide escribir el correo: es lo único que identifica la cuenta a los ojos de quien la borra. */
  email: string
}

/**
 * Se contiene el disparador acá adentro (no via render-prop) a propósito:
 * este componente lo renderiza directo `cuenta/page.tsx`, que es un Server
 * Component, y un Server Component no puede pasarle una función común a un
 * Client Component — solo datos serializables o Server Actions.
 */
export function DeleteAccountDialog({ email }: DeleteAccountDialogProps) {
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()

  function confirmar() {
    startTransition(async () => {
      const result = await deleteAccountAction()
      // Si salió bien, deleteAccountAction ya redirigió y esto no se ejecuta.
      if (result && !result.ok) {
        notify.problema(result.error ?? 'No pudimos borrar tu cuenta.')
      }
    })
  }

  return (
    <>
      <Button variant="danger" icon={<Trash2 strokeWidth={1.9} />} onClick={() => setOpen(true)}>
        Borrar mi cuenta
      </Button>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="¿Borrar tu cuenta?"
        destructive
        consequences={[
          'Borramos todos tus proyectos: su código, hallazgos, videos y grabaciones.',
          'Perdés el acceso a caughtcode con este correo.',
          'Esto no se puede deshacer.',
        ]}
        requireTyping={email}
        confirmLabel="Borrar mi cuenta"
        loading={pending}
        onConfirm={confirmar}
      />
    </>
  )
}
