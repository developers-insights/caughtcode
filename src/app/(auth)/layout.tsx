import Link from 'next/link'
import type { ReactNode } from 'react'

/**
 * Armazón de las pantallas sin sesión: entrar, registro, recuperar,
 * nueva contraseña. Centrado, sin `AppShell` — todavía no hay nada que
 * navegar.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="px-6 pt-8 sm:px-8">
        <Link href="/" className="cc-wordmark inline-block text-2xl text-ink focus-visible:focus-ring">
          caughtcode
        </Link>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-10 sm:px-6">
        <div className="w-full max-w-sm">{children}</div>
      </main>

      <footer className="px-6 pb-8 text-center text-sm text-ink-subtle sm:px-8">
        <p>Auditamos apps hechas con IA. No es asesoramiento legal.</p>
      </footer>
    </div>
  )
}
