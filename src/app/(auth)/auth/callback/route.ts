import { NextResponse, type NextRequest } from 'next/server'
import type { EmailOtpType } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'

/**
 * Confirma el enlace que llega por correo: verificación de cuenta nueva y
 * recuperación de contraseña pasan los dos por acá (`type=signup` o
 * `type=recovery`), siguiendo el patrón oficial de Supabase para SSR con
 * Next.js (verifyOtp con token_hash, no con código en la URL del cliente).
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const tokenHash = searchParams.get('token_hash')
  const type = searchParams.get('type') as EmailOtpType | null
  const next = searchParams.get('next') ?? '/proyectos'

  const redirectTo = request.nextUrl.clone()
  redirectTo.searchParams.delete('token_hash')
  redirectTo.searchParams.delete('type')
  redirectTo.searchParams.delete('next')

  if (tokenHash && type) {
    const supabase = await createClient()
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash })

    if (!error) {
      redirectTo.pathname = next.startsWith('/') ? next : '/proyectos'
      return NextResponse.redirect(redirectTo)
    }
  }

  redirectTo.pathname = '/entrar'
  redirectTo.searchParams.set('enlaceInvalido', '1')
  return NextResponse.redirect(redirectTo)
}
