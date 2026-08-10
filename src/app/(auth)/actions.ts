'use server'

/**
 * Acciones de autenticación. Todas usan el cliente de servidor
 * (`src/lib/supabase/server.ts`), que escribe la sesión en cookies — el
 * refresco después lo sostiene `proxy.ts`.
 */

import { redirect } from 'next/navigation'
import type { AuthError } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { env } from '@/lib/env'

export interface AuthFormState {
  error: string | null
}

export interface RecoverFormState {
  error: string | null
  sent: boolean
}

const MENSAJES_ERROR: Partial<Record<string, string>> = {
  invalid_credentials: 'El correo o la contraseña no coinciden.',
  email_not_confirmed: 'Todavía no confirmaste tu correo. Revisá tu bandeja de entrada.',
  user_already_exists: 'Ya existe una cuenta con ese correo. Probá entrar en vez de registrarte.',
  email_exists: 'Ya existe una cuenta con ese correo. Probá entrar en vez de registrarte.',
  weak_password: 'Esa contraseña es demasiado simple. Probá con una más larga.',
  same_password: 'Es la misma contraseña que ya tenías. Elegí una distinta.',
  over_email_send_rate_limit: 'Pediste esto demasiadas veces seguidas. Esperá unos minutos y probá de nuevo.',
  over_request_rate_limit: 'Demasiados intentos seguidos. Esperá un minuto y probá de nuevo.',
  email_address_invalid: 'Ese correo no parece válido.',
  signup_disabled: 'No se están aceptando registros nuevos en este momento.',
  user_banned: 'Esta cuenta no puede acceder. Escribinos si te parece un error.',
}

function mensajeError(error: AuthError): string {
  const code = error.code
  if (code && MENSAJES_ERROR[code]) return MENSAJES_ERROR[code]!
  return 'Algo salió mal de nuestro lado. Probá de nuevo en un minuto.'
}

function siguienteSeguro(valor: FormDataEntryValue | null): string {
  const texto = String(valor ?? '')
  return texto.startsWith('/') && !texto.startsWith('//') ? texto : '/proyectos'
}

/* ── Entrar ──────────────────────────────────────────────────────────────── */

export async function signInAction(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = String(formData.get('email') ?? '').trim()
  const password = String(formData.get('password') ?? '')
  const siguiente = siguienteSeguro(formData.get('siguiente'))

  if (!email || !password) {
    return { error: 'Completá tu correo y tu contraseña.' }
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithPassword({ email, password })

  if (error) return { error: mensajeError(error) }

  redirect(siguiente)
}

/* ── Registro ────────────────────────────────────────────────────────────── */

export async function signUpAction(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const name = String(formData.get('name') ?? '').trim()
  const email = String(formData.get('email') ?? '').trim()
  const password = String(formData.get('password') ?? '')
  const passwordConfirm = String(formData.get('passwordConfirm') ?? '')

  if (!name) return { error: 'Contanos cómo te llamás.' }
  if (!email || !password) return { error: 'Completá tu correo y una contraseña.' }
  if (password.length < 8) return { error: 'La contraseña tiene que tener al menos 8 caracteres.' }
  if (password !== passwordConfirm) return { error: 'Las contraseñas no coinciden.' }

  const supabase = await createClient()
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: name },
      emailRedirectTo: `${env.appUrl()}/auth/callback?next=${encodeURIComponent('/proyectos')}`,
    },
  })

  if (error) return { error: mensajeError(error) }

  // Con confirmación de correo activada, signUp no abre sesión: hay que
  // avisarle a la persona que revise su correo. Sin confirmación, ya quedó
  // adentro y la mandamos directo a lo suyo.
  if (data.session) {
    redirect('/proyectos')
  }
  redirect('/entrar?revisaCorreo=1')
}

/* ── Recuperar contraseña ────────────────────────────────────────────────── */

export async function requestPasswordResetAction(
  _prevState: RecoverFormState,
  formData: FormData,
): Promise<RecoverFormState> {
  const email = String(formData.get('email') ?? '').trim()
  if (!email) return { error: 'Escribí tu correo.', sent: false }

  const supabase = await createClient()
  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${env.appUrl()}/auth/callback?next=${encodeURIComponent('/nueva-contrasena')}`,
  })

  // Nunca decimos si la cuenta existe o no: siempre la misma respuesta.
  return { error: null, sent: true }
}

/* ── Elegir nueva contraseña ─────────────────────────────────────────────── */

export async function updatePasswordAction(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const password = String(formData.get('password') ?? '')
  const passwordConfirm = String(formData.get('passwordConfirm') ?? '')

  if (password.length < 8) return { error: 'La contraseña tiene que tener al menos 8 caracteres.' }
  if (password !== passwordConfirm) return { error: 'Las contraseñas no coinciden.' }

  const supabase = await createClient()

  const { data: userData } = await supabase.auth.getUser()
  if (!userData?.user) {
    return {
      error: 'El enlace venció o ya se usó. Pedí uno nuevo desde "Recuperar contraseña".',
    }
  }

  const { error } = await supabase.auth.updateUser({ password })
  if (error) return { error: mensajeError(error) }

  redirect('/proyectos?contrasenaActualizada=1')
}

/* ── Cerrar sesión ───────────────────────────────────────────────────────── */

export async function signOutAction(): Promise<void> {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect('/entrar')
}
