'use client'

import { useEffect, useState } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui'

export type ThemePreference = 'light' | 'dark' | 'system'

export const THEME_STORAGE_KEY = 'cc-theme'

/**
 * Script que corre antes de pintar, para que no haya un flash blanco al
 * cargar en oscuro. Se inyecta en <head> desde src/app/layout.tsx.
 * Si falla (localStorage bloqueado), el CSS ya resuelve el tema por
 * prefers-color-scheme: nunca queda ilegible.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var p=localStorage.getItem('${THEME_STORAGE_KEY}');var d=window.matchMedia('(prefers-color-scheme: dark)').matches;var t=p==='light'||p==='dark'?p:(d?'dark':'light');document.documentElement.dataset.theme=t;}catch(e){}})()`

function apply(pref: ThemePreference) {
  const root = document.documentElement
  if (pref === 'system') {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
    root.dataset.theme = dark ? 'dark' : 'light'
  } else {
    root.dataset.theme = pref
  }
}

const NEXT: Record<ThemePreference, ThemePreference> = {
  light: 'dark',
  dark: 'system',
  system: 'light',
}

const COPY: Record<ThemePreference, { icon: typeof Sun; label: string }> = {
  light: { icon: Sun, label: 'Tema claro. Tocá para pasar a oscuro.' },
  dark: { icon: Moon, label: 'Tema oscuro. Tocá para seguir al del sistema.' },
  system: { icon: Monitor, label: 'Sigue al sistema. Tocá para pasar a claro.' },
}

export function ThemeToggle({ className }: { className?: string }) {
  const [pref, setPref] = useState<ThemePreference>('system')
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let stored: string | null = null
    try {
      stored = localStorage.getItem(THEME_STORAGE_KEY)
    } catch {
      /* localStorage bloqueado: seguimos con 'system' */
    }
    setPref(stored === 'light' || stored === 'dark' ? stored : 'system')
    setReady(true)
  }, [])

  useEffect(() => {
    if (!ready || pref !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => apply('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [pref, ready])

  function change(next: ThemePreference) {
    setPref(next)
    apply(next)
    try {
      if (next === 'system') localStorage.removeItem(THEME_STORAGE_KEY)
      else localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {
      /* sin persistencia, pero el cambio ya se aplicó */
    }
  }

  const { icon: Icon, label } = COPY[pref]

  return (
    <Button
      variant="ghost"
      size="sm"
      iconOnly
      aria-label={label}
      title={label}
      onClick={() => change(NEXT[pref])}
      className={className}
      icon={<Icon strokeWidth={1.8} />}
      /* Hasta que hidrate, el ícono es el del sistema: evita que parpadee. */
      suppressHydrationWarning
    />
  )
}
