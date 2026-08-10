'use client'

import { useActionState } from 'react'
import { UserPlus } from 'lucide-react'
import { Button, Callout, Input } from '@/components/ui'
import { signUpAction, type AuthFormState } from '../actions'

const INITIAL: AuthFormState = { error: null }

export function SignUpForm() {
  const [state, formAction, pending] = useActionState(signUpAction, INITIAL)

  return (
    <form action={formAction} className="space-y-5" noValidate>
      {state.error && <Callout tone="expuesto">{state.error}</Callout>}

      <Input label="Cómo te llamás" name="name" type="text" autoComplete="name" required />

      <Input label="Correo" name="email" type="email" autoComplete="email" required />

      <Input
        label="Contraseña"
        name="password"
        type="password"
        autoComplete="new-password"
        hint="Al menos 8 caracteres."
        required
      />

      <Input
        label="Repetí la contraseña"
        name="passwordConfirm"
        type="password"
        autoComplete="new-password"
        required
      />

      <Button
        type="submit"
        fullWidth
        loading={pending}
        loadingLabel="Creando tu cuenta…"
        icon={<UserPlus strokeWidth={1.9} />}
      >
        Crear cuenta
      </Button>

      <p className="text-center text-xs leading-relaxed text-ink-subtle">
        Al registrarte aceptás que leamos tu código para auditarlo y nada más: no entrenamos
        modelos con él, y se borra cuando vos lo pedís.
      </p>
    </form>
  )
}
