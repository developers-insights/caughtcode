'use client'

import { useActionState } from 'react'
import Link from 'next/link'
import { LogIn } from 'lucide-react'
import { Button, Callout, Input } from '@/components/ui'
import { signInAction, type AuthFormState } from '../actions'

const INITIAL: AuthFormState = { error: null }

export function SignInForm({ siguiente }: { siguiente: string }) {
  const [state, formAction, pending] = useActionState(signInAction, INITIAL)

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <input type="hidden" name="siguiente" value={siguiente} />

      {state.error && <Callout tone="expuesto">{state.error}</Callout>}

      <Input label="Correo" name="email" type="email" autoComplete="email" required />

      <Input
        label="Contraseña"
        name="password"
        type="password"
        autoComplete="current-password"
        required
      />

      <div className="text-right">
        <Link
          href="/recuperar"
          className="rounded-xs text-sm text-ink-muted underline-offset-4 hover:text-ink hover:underline focus-visible:focus-ring"
        >
          ¿Olvidaste tu contraseña?
        </Link>
      </div>

      <Button
        type="submit"
        fullWidth
        loading={pending}
        loadingLabel="Entrando…"
        icon={<LogIn strokeWidth={1.9} />}
      >
        Entrar
      </Button>
    </form>
  )
}
