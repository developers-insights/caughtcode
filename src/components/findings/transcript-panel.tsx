'use client'

import { useMemo, useState, type RefObject } from 'react'
import { ChevronRight, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui'
import { TRANSCRIPCION } from './copy'
import { filtrarCues, reloj, type Cue } from './view'

export interface TranscriptPanelProps {
  cues: readonly Cue[]
  /** Texto plano, cuando no tenemos el guion escena por escena. */
  transcripcion?: string | null
  /** Segundo que está sonando, para marcar la línea. */
  tiempo?: number
  videoRef?: RefObject<HTMLVideoElement | null>
  className?: string
}

/**
 * Lo que dice el video, escrito.
 *
 * Sirve para tres cosas distintas: leerlo si no se puede escuchar, buscar una
 * palabra sin mirar los cinco minutos, y saltar al momento exacto tocando la
 * línea. Va colapsado porque el video ya está arriba — pero está.
 */
export function TranscriptPanel({
  cues,
  transcripcion,
  tiempo = 0,
  videoRef,
  className,
}: TranscriptPanelProps) {
  const [consulta, setConsulta] = useState('')
  const visibles = useMemo(() => filtrarCues(cues, consulta), [cues, consulta])

  const hayLineas = cues.length > 0
  if (!hayLineas && !transcripcion) return null

  return (
    <details
      className={cn(
        'group overflow-hidden rounded-lg border border-line bg-surface shadow-support',
        className,
      )}
    >
      <summary
        className={cn(
          'flex min-h-12 cursor-pointer list-none items-center gap-2.5 px-4 py-3',
          'transition-colors duration-150 ease-firm hover:bg-surface-hover',
          'focus-visible:focus-ring-inset [&::-webkit-details-marker]:hidden',
        )}
      >
        <ChevronRight
          aria-hidden="true"
          strokeWidth={1.8}
          className="size-4 shrink-0 text-ink-subtle transition-transform duration-200 ease-firm group-open:rotate-90"
        />
        <span className="text-base font-medium text-ink">{TRANSCRIPCION.titulo}</span>
      </summary>

      <div className="space-y-4 border-t border-line p-4 sm:p-5">
        {!hayLineas ? (
          <p className="prose-lectura text-base text-ink-muted">{transcripcion}</p>
        ) : (
          <>
            <div>
              <Input
                type="search"
                label={TRANSCRIPCION.buscar}
                hint={TRANSCRIPCION.buscarAyuda}
                placeholder={TRANSCRIPCION.placeholder}
                value={consulta}
                onChange={(e) => setConsulta(e.target.value)}
                prefix={<Search aria-hidden="true" strokeWidth={1.8} className="size-4" />}
              />
            </div>

            {visibles.length === 0 ? (
              <p role="status" className="py-2 text-base text-ink-muted">
                {TRANSCRIPCION.sinResultados}
              </p>
            ) : (
              <ol className="flex flex-col gap-0.5">
                {visibles.map((cue) => {
                  const sonando = tiempo >= cue.startSeconds && tiempo < cue.endSeconds
                  return (
                    <li key={cue.id}>
                      <button
                        type="button"
                        aria-current={sonando ? 'true' : undefined}
                        onClick={() => {
                          const el = videoRef?.current
                          if (!el) return
                          el.currentTime = cue.startSeconds
                          void el.play()
                        }}
                        className={cn(
                          'flex w-full min-h-11 items-baseline gap-3 rounded-sm px-2.5 py-2 text-left',
                          'transition-colors duration-150 ease-firm hover:bg-surface-hover',
                          'focus-visible:focus-ring',
                          sonando && 'bg-canvas-sunken',
                        )}
                      >
                        <span
                          aria-label={TRANSCRIPCION.irA(reloj(cue.startSeconds))}
                          className={cn(
                            'shrink-0 font-mono text-xs tabular',
                            sonando ? 'text-ink' : 'text-ink-subtle',
                          )}
                        >
                          {reloj(cue.startSeconds)}
                        </span>
                        <span
                          className={cn(
                            'min-w-0 text-base',
                            sonando ? 'font-medium text-ink' : 'text-ink-muted',
                          )}
                        >
                          {cue.narration}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ol>
            )}
          </>
        )}
      </div>
    </details>
  )
}
