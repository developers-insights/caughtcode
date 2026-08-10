'use client'

import { useActionState } from 'react'
import { MailCheck, Send } from 'lucide-react'
import { Button, Callout, Input } from '@/components/ui'
import { requestPasswordResetAction, type RecoverFormState } from '../actions'

const INITIAL: RecoverFormState = { error: null, sent: false }

export function RecoverForm() {
  const [state, formAction, pending] = useActionState(requestPasswordResetAction, INITIAL)

  if (state.sent) {
    return (
      <Callout tone="verificado" title="Revisá tu correo" icon={<MailCheck strokeWidth={1.9} />}>
        Si ese correo tiene una cuenta con nosotros, te va a llegar un mail para elegir una
        contraseña nueva.
      </Callout>
    )
  }

  return (
    <form action={formAction} className="space-y-5" noValidate>
      {state.error && <Callout tone="expuesto">{state.error}</Callout>}

      <Input
        label="Correo"
        name="email"
        type="email"
        autoComplete="email"
        hint="Te mandamos un enlace para elegir una contraseña nueva."
        required
      />

      <Button
        type="submit"
        fullWidth
        loading={pending}
        loadingLabel="Enviando…"
        icon={<Send strokeWidth={1.9} />}
      >
        Mandarme el enlace
      </Button>
    </form>
  )
}
