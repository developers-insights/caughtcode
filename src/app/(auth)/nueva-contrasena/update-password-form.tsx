'use client'

import { useActionState } from 'react'
import { KeyRound } from 'lucide-react'
import { Button, Callout, Input } from '@/components/ui'
import { updatePasswordAction, type AuthFormState } from '../actions'

const INITIAL: AuthFormState = { error: null }

export function UpdatePasswordForm() {
  const [state, formAction, pending] = useActionState(updatePasswordAction, INITIAL)

  return (
    <form action={formAction} className="space-y-5" noValidate>
      {state.error && <Callout tone="expuesto">{state.error}</Callout>}

      <Input
        label="Contraseña nueva"
        name="password"
        type="password"
        autoComplete="new-password"
        hint="Al menos 8 caracteres."
        required
      />

      <Input
        label="Repetila"
        name="passwordConfirm"
        type="password"
        autoComplete="new-password"
        required
      />

      <Button
        type="submit"
        fullWidth
        loading={pending}
        loadingLabel="Guardando…"
        icon={<KeyRound strokeWidth={1.9} />}
      >
        Guardar contraseña
      </Button>
    </form>
  )
}
