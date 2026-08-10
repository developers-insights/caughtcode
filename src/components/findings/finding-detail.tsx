'use client'

import { useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { Callout } from '@/components/ui'
import { DISCLAIMER_LEGAL } from '@/content/lenguaje'
import type { Finding } from '@/lib/types/domain'
import { DETALLE } from './copy'
import { EvidenceList } from './evidence-block'
import { FindingStatusControl } from './finding-status-control'
import { FixPromptPanel } from './fix-prompt-panel'
import { TranscriptPanel } from './transcript-panel'
import { VideoPlayer } from './video-player'
import { cuesDelGuion, tieneEvidencia, type FindingVideo } from './view'

export interface FindingDetailProps {
  finding: Finding
  video: FindingVideo | null
  soloLectura?: boolean
  className?: string
}

/**
 * La pantalla de un hallazgo.
 *
 * Orden deliberado: primero la demostración, después qué pasa, después la
 * prueba, y recién ahí el arreglo. Es el orden en que se convence a alguien:
 * mostrale, explicale, probáselo, dale la salida.
 *
 * Es cliente porque el video, la prueba y la transcripción comparten un mismo
 * reproductor — tocar "ver este momento" en la prueba tiene que mover el video
 * de arriba.
 */
export function FindingDetail({ finding, video, soloLectura, className }: FindingDetailProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [tiempo, setTiempo] = useState(0)

  const cues = cuesDelGuion(video?.script)
  const hayPrueba = tieneEvidencia(finding)
  const esDeTienda = finding.pillar === 'store_hygiene'

  function irAlMomento(seconds: number) {
    const el = videoRef.current
    if (!el) return
    el.currentTime = seconds
    void el.play()
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  return (
    <div className={cn('space-y-10', className)}>
      {/* El video manda: primero y a todo el ancho de la columna. */}
      <section aria-label={DETALLE.loQuePasa} className="space-y-3">
        <VideoPlayer
          video={video}
          titulo={finding.titlePlain}
          videoRef={videoRef}
          onTiempo={setTiempo}
        />
        <TranscriptPanel
          cues={cues}
          transcripcion={video?.transcript}
          tiempo={tiempo}
          videoRef={videoRef}
        />
      </section>

      <section className="space-y-3">
        <h2 className="text-eyebrow uppercase text-ink-subtle">{DETALLE.loQuePasa}</h2>
        <p className="prose-lectura text-lg text-ink">{finding.explanationPlain}</p>
      </section>

      <section className="space-y-3">
        <h2 className="text-eyebrow uppercase text-ink-subtle">{DETALLE.quePuedePasar}</h2>
        <p className="prose-lectura text-lg text-ink-muted">{finding.impactPlain}</p>
      </section>

      {esDeTienda && <Callout tone="revisar">{DISCLAIMER_LEGAL}</Callout>}

      <section className="space-y-4">
        <div>
          <h2 className="text-xl font-semibold text-ink">{DETALLE.laPrueba}</h2>
          {hayPrueba && <p className="mt-1 text-base text-ink-muted">{DETALLE.pruebaAyuda}</p>}
        </div>
        <EvidenceList evidence={finding.evidence} onIrAlMomento={irAlMomento} />
      </section>

      <FixPromptPanel prompt={finding.fixPrompt} />

      <div className="border-t border-line pt-6">
        <FindingStatusControl finding={finding} soloLectura={soloLectura} />
      </div>
    </div>
  )
}
