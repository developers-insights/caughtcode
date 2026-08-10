import type { Metadata, Viewport } from 'next'
import { Instrument_Sans, Instrument_Serif, JetBrains_Mono } from 'next/font/google'
import { MotionProvider, Toaster } from '@/components/ui'
import { THEME_INIT_SCRIPT } from '@/components/shell'
import '@/styles/globals.css'

/**
 * Tipografía — la justificación completa está en docs/DESIGN.md.
 *  · Instrument Serif  → los momentos importantes. Da autoridad de documento.
 *  · Instrument Sans   → toda la interfaz. Grotesca técnica, legible a 13px.
 *  · JetBrains Mono    → código, rutas de archivo, números de línea.
 * Ninguna es Inter.
 */

const sans = Instrument_Sans({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-instrument-sans',
  display: 'swap',
  preload: true,
})

const serif = Instrument_Serif({
  subsets: ['latin', 'latin-ext'],
  weight: '400',
  style: ['normal', 'italic'],
  variable: '--font-instrument-serif',
  display: 'swap',
  preload: true,
})

const mono = JetBrains_Mono({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
  preload: false,
})

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'https://caughtcode.app'),
  title: {
    default: 'caughtcode — revisamos tu app y te mostramos qué está roto',
    template: '%s · caughtcode',
  },
  description:
    'Un agente entra a tu app, intenta romperla y te muestra en video lo que encontró. ' +
    'Sin jerga: tres cosas para arreglar, en orden, con el prompt listo para pegar.',
  applicationName: 'caughtcode',
  authors: [{ name: 'caughtcode' }],
  openGraph: {
    type: 'website',
    locale: 'es_AR',
    siteName: 'caughtcode',
    title: 'caughtcode — revisamos tu app y te mostramos qué está roto',
    description:
      'Auditamos apps hechas con IA. Encontramos lo peligroso, lo demostramos en video y te damos el prompt para arreglarlo.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'caughtcode',
    description: 'Revisamos tu app hecha con IA y te mostramos en video qué está roto.',
  },
  formatDetection: { telephone: false },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  /* Sin maximumScale ni userScalable: nunca bloqueamos el zoom. */
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f5f1' },
    { media: '(prefers-color-scheme: dark)', color: '#131211' },
  ],
  colorScheme: 'light dark',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="es-AR"
      className={`${sans.variable} ${serif.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Fija el tema antes del primer pintado: sin flash blanco en oscuro. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="font-sans antialiased">
        <MotionProvider>
          {children}
          <Toaster />
        </MotionProvider>
      </body>
    </html>
  )
}
