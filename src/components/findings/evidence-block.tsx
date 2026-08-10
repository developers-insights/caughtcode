'use client'

import Image from 'next/image'
import { Clapperboard, Database, FileCode2, Globe, MonitorPlay } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Callout, CodeBlock } from '@/components/ui'
import type { Evidence } from '@/lib/types/domain'
import { DETALLE, EVIDENCIA } from './copy'
import { reloj } from './view'

export interface EvidenceBlockProps {
  evidence: Evidence
  /** Saltar el video a este momento. Solo llega en la evidencia grabada. */
  onIrAlMomento?: (seconds: number) => void
  className?: string
}

/**
 * La prueba de un hallazgo.
 *
 * Hay una forma distinta por cada clase de prueba porque cada una se verifica
 * distinto: el código se abre en el editor, la grabación se mira, la consulta
 * a la base se puede repetir. Lo que nunca cambia es que hay algo concreto
 * que el usuario puede ir a chequear él mismo.
 */
export function EvidenceBlock({ evidence, onIrAlMomento, className }: EvidenceBlockProps) {
  switch (evidence.kind) {
    case 'code':
      return (
        <Marco
          icono={FileCode2}
          titulo={EVIDENCIA.code.titulo}
          ayuda={EVIDENCIA.code.ayuda}
          className={className}
        >
          <CodeBlock
            code={evidence.snippet ?? ''}
            filename={evidence.file}
            startLine={Math.max(1, evidence.line - contexto(evidence.snippet))}
            highlightLines={rangoMarcado(evidence.line, evidence.endLine)}
            maxHeightClassName="max-h-96"
          />
        </Marco>
      )

    case 'recording':
      return (
        <Marco
          icono={Clapperboard}
          titulo={EVIDENCIA.recording.titulo}
          ayuda={EVIDENCIA.recording.ayuda}
          className={className}
        >
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-canvas-sunken px-4 py-3.5">
            <p className="min-w-0 flex-1 text-base text-ink">{evidence.caption}</p>
            <span className="shrink-0 font-mono text-xs text-ink-muted tabular">
              {reloj(evidence.startMs / 1000)} – {reloj(evidence.endMs / 1000)}
            </span>
            {onIrAlMomento && (
              <button
                type="button"
                onClick={() => onIrAlMomento(evidence.startMs / 1000)}
                className={cn(
                  'inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-sm px-2.5',
                  'text-sm text-ink underline decoration-line-strong underline-offset-4',
                  'transition-colors duration-150 ease-firm hover:bg-surface-hover hover:decoration-ink',
                  'focus-visible:focus-ring',
                )}
              >
                <MonitorPlay aria-hidden="true" strokeWidth={1.8} className="size-4" />
                {EVIDENCIA.recording.verMomento}
              </button>
            )}
          </div>
        </Marco>
      )

    case 'database':
      return (
        <Marco
          icono={Database}
          titulo={EVIDENCIA.database.titulo}
          ayuda={EVIDENCIA.database.ayuda}
          className={className}
        >
          <dl className="overflow-hidden rounded-md border border-line bg-canvas-sunken">
            <Fila termino="Dónde" valor={<code className="font-mono">{evidence.object}</code>} />
            <Fila termino="Qué vimos" valor={evidence.detail} ultimo />
          </dl>
        </Marco>
      )

    case 'http':
      return (
        <Marco
          icono={Globe}
          titulo={EVIDENCIA.http.titulo}
          ayuda={EVIDENCIA.http.ayuda}
          className={className}
        >
          <dl className="overflow-hidden rounded-md border border-line bg-canvas-sunken">
            <Fila
              termino="Dirección"
              valor={<code className="font-mono break-all">{evidence.url}</code>}
            />
            <Fila
              termino={EVIDENCIA.http.respondio}
              valor={<span className="font-mono tabular">{evidence.status}</span>}
            />
            <Fila termino="Qué significa" valor={evidence.detail} ultimo />
          </dl>
        </Marco>
      )

    case 'browser':
      return (
        <Marco
          icono={MonitorPlay}
          titulo={EVIDENCIA.browser.titulo}
          ayuda={EVIDENCIA.browser.ayuda}
          className={className}
        >
          <div className="overflow-hidden rounded-md border border-line bg-canvas-sunken">
            {evidence.screenshotPath && (
              <div className="relative aspect-video w-full border-b border-line bg-canvas">
                <Image
                  src={evidence.screenshotPath}
                  alt={`Captura de ${evidence.url}: ${evidence.detail}`}
                  fill
                  sizes="(max-width: 768px) 100vw, 640px"
                  className="object-contain"
                  unoptimized
                />
              </div>
            )}
            <dl>
              <Fila
                termino="Dirección"
                valor={<code className="font-mono break-all">{evidence.url}</code>}
              />
              <Fila termino="Qué vimos" valor={evidence.detail} ultimo />
            </dl>
          </div>
        </Marco>
      )
  }
}

/* ── Lista completa ────────────────────────────────────────────────────── */

export interface EvidenceListProps {
  evidence: readonly Evidence[]
  onIrAlMomento?: (seconds: number) => void
  className?: string
}

/**
 * Toda la prueba de un hallazgo.
 *
 * Si llega vacía no inventamos nada: se muestra el error tal cual es, porque
 * afirmar algo sin poder respaldarlo es la única cosa que no nos podemos
 * permitir (D14).
 */
export function EvidenceList({ evidence, onIrAlMomento, className }: EvidenceListProps) {
  if (!evidence?.length) {
    return (
      <Callout tone="expuesto" title={DETALLE.sinEvidencia.titulo} className={className}>
        {DETALLE.sinEvidencia.texto}
      </Callout>
    )
  }

  return (
    <div className={cn('space-y-6', className)}>
      {evidence.map((item, i) => (
        <EvidenceBlock key={`${item.kind}-${i}`} evidence={item} onIrAlMomento={onIrAlMomento} />
      ))}
    </div>
  )
}

/* ── Piezas internas ───────────────────────────────────────────────────── */

function Marco({
  icono: Icono,
  titulo,
  ayuda,
  children,
  className,
}: {
  icono: LucideIcon
  titulo: string
  ayuda: string
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('space-y-2.5', className)}>
      <div className="flex items-start gap-2.5">
        <Icono
          aria-hidden="true"
          strokeWidth={1.8}
          className="mt-0.5 size-4 shrink-0 text-ink-subtle"
        />
        <div className="min-w-0">
          <h4 className="text-base font-medium text-ink">{titulo}</h4>
          <p className="mt-0.5 text-sm text-ink-muted">{ayuda}</p>
        </div>
      </div>
      {children}
    </section>
  )
}

function Fila({
  termino,
  valor,
  ultimo = false,
}: {
  termino: string
  valor: ReactNode
  ultimo?: boolean
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:gap-4',
        !ultimo && 'border-b border-line',
      )}
    >
      <dt className="shrink-0 text-sm text-ink-muted sm:w-36">{termino}</dt>
      <dd className="min-w-0 text-base text-ink">{valor}</dd>
    </div>
  )
}

/** Cuántas líneas de contexto trae el fragmento antes de la línea marcada. */
function contexto(snippet?: string): number {
  if (!snippet) return 0
  const lineas = snippet.replace(/\n$/, '').split('\n').length
  return Math.min(3, Math.floor((lineas - 1) / 2))
}

function rangoMarcado(line: number, endLine?: number): number[] {
  if (!endLine || endLine <= line) return [line]
  return Array.from({ length: endLine - line + 1 }, (_, i) => line + i)
}
