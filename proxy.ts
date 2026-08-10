import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * Proxy de Next.js 16 (reemplaza al viejo `middleware.ts`).
 *
 * Refresca la sesión de Supabase en cada pedido y redirige a `/entrar` a quien
 * no está logueado e intenta entrar a una pantalla de la app.
 *
 * Regla dura: no metas código entre crear el cliente y llamar a
 * `getClaims()`. Es la causa clásica de usuarios deslogueados al azar —
 * ver docs oficiales de Supabase SSR.
 */

const PUBLIC_PREFIXES = [
  '/entrar',
  '/registro',
  '/recuperar',
  '/nueva-contrasena',
  '/auth',
  '/cuenta-borrada',
]

function isPublicPath(pathname: string): boolean {
  if (pathname === '/') return true
  return PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request })

  // Modo demo (sin proyecto de Supabase conectado todavía): la sesión la
  // simulan las pantallas con datos fijos. Nada que refrescar acá.
  if (process.env.CAUGHTCODE_DEMO === '1') {
    return response
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  // Sin config todavía: no hay sesión que refrescar ni cliente que armar.
  // Dejamos pasar el pedido tal cual en vez de romper toda la app.
  if (!supabaseUrl || !supabaseAnonKey) {
    return response
  }

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
        response = NextResponse.next({ request })
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options))
      },
    },
  })

  // IMPORTANTE: no poner nada acá en el medio. Ver docstring de arriba.
  const { data } = await supabase.auth.getClaims()
  const user = data?.claims

  if (!user && !isPublicPath(request.nextUrl.pathname)) {
    const url = request.nextUrl.clone()
    url.pathname = '/entrar'
    url.searchParams.set('siguiente', request.nextUrl.pathname)
    return NextResponse.redirect(url)
  }

  return response
}

export const config = {
  matcher: [
    /*
     * Corre en todo menos:
     * - _next/static (archivos estáticos)
     * - _next/image (optimización de imágenes)
     * - favicon.ico, robots.txt, sitemap.xml
     * - archivos con extensión de imagen o de fuente
     */
    '/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap\\.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|woff|woff2|ttf)$).*)',
  ],
}
