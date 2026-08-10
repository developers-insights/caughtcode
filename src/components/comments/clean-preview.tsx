'use client'

import { useMemo, useState } from 'react'
import { ArrowDown, FileWarning } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge, Callout, Card, CardBody, CardHeader, CardTitle, CodeBlock } from '@/components/ui'
import { ventanaDeCambio } from './diff-window'
import type { CleanPlanView } from './model-clean'

const n = (x: number) => x.toLocaleString('es-AR')

export interface CleanPreviewProps {
  plan: CleanPlanView
  className?: string
}

/**
 * El antes y el después, archivo por archivo.
 *
 * Nada se aplica a ciegas: lo que se ve acá es exactamente lo que va a salir
 * en el archivo de cambios. Se muestra el tramo que cambia con la numeración
 * del archivo real, para poder ir a mirarlo en el editor.
 */
export function CleanPreview({ plan, className }: CleanPreviewProps) {
  const [elegido, setElegido] = useState(plan.files[0]?.file ?? '')

  const archivo = plan.files.find((f) => f.file === elegido) ?? plan.files[0]
  const ventana = useMemo(
    () => (archivo ? ventanaDeCambio(archivo.before, archivo.after) : null),
    [archivo],
  )

  if (!archivo || !ventana) {
    return (
      <Card className={className}>
        <CardBody className="pt-5 sm:pt-6">
          <p className="text-base text-ink-muted">
            Con este modo no hay nada para sacar. Probá con la limpieza a fondo.
          </p>
        </CardBody>
      </Card>
    )
  }

  return (
    <Card as="section" className={cn('overflow-hidden', className)}>
      <CardHeader className="gap-2">
        <CardTitle as="h2">Qué cambiaría</CardTitle>
        <p className="max-w-prose text-base leading-relaxed text-ink-muted">
          {n(plan.totalRemoved)} {plan.totalRemoved === 1 ? 'comentario' : 'comentarios'} menos en{' '}
          {n(plan.files.length)} {plan.files.length === 1 ? 'archivo' : 'archivos'}. Todo lo demás
          queda igual.
        </p>
      </CardHeader>

      <CardBody className="grid gap-5 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)] lg:gap-6">
        {plan.files.length > 1 && (
          <div className="min-w-0">
            <h3 className="mb-2 text-eyebrow uppercase text-ink-subtle">Archivos</h3>
            <ul className="max-h-72 min-w-0 overflow-y-auto rounded-md border border-line lg:max-h-[26rem]">
              {plan.files.map((f) => {
                const activo = f.file === archivo.file
                return (
                  <li key={f.file} className="border-b border-line last:border-b-0">
                    <button
                      type="button"
                      onClick={() => setElegido(f.file)}
                      aria-current={activo ? 'true' : undefined}
                      className={cn(
                        'flex w-full min-w-0 items-center gap-2 px-3 py-2.5 text-left',
                        'transition-colors duration-150 ease-firm focus-visible:focus-ring',
                        activo ? 'bg-surface-hover' : 'hover:bg-surface-hover',
                      )}
                    >
                      <span
                        className={cn(
                          'min-w-0 flex-1 truncate font-mono text-xs',
                          activo ? 'text-ink' : 'text-ink-muted',
                        )}
                        title={f.file}
                        dir="rtl"
                      >
                        {f.file}
                      </span>
                      <span className="shrink-0 text-xs tabular text-ink-subtle">−{f.removed}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral" size="sm">
              Antes
            </Badge>
            <span className="text-sm text-ink-muted">
              {archivo.removed} {archivo.removed === 1 ? 'comentario sale' : 'comentarios salen'}
              {archivo.kept > 0 && ` · ${archivo.kept} se ${archivo.kept === 1 ? 'queda' : 'quedan'}`}
            </span>
          </div>

          <CodeBlock
            code={ventana.antes.code}
            filename={archivo.file}
            startLine={ventana.antes.startLine}
            highlightLines={ventana.antes.highlightLines}
            copyable={false}
            maxHeightClassName="max-h-80"
          />
          {ventana.tramos > 1 && (
            <p className="text-sm text-ink-subtle">
              Es el primero de {n(ventana.tramos)} tramos que cambian en este archivo. El archivo
              de cambios los trae todos.
            </p>
          )}

          <div className="flex items-center gap-2 pt-1">
            <ArrowDown aria-hidden="true" className="size-4 text-ink-subtle" strokeWidth={2} />
            <Badge tone="verificado" size="sm" dot>
              Después
            </Badge>
          </div>

          <CodeBlock
            code={ventana.despues.code}
            filename={archivo.file}
            startLine={ventana.despues.startLine}
            copyable={false}
            maxHeightClassName="max-h-80"
          />
        </div>
      </CardBody>

      {plan.skipped.length > 0 && (
        <CardBody className="pt-0">
          <Callout
            tone="revisar"
            title={`${n(plan.skipped.length)} ${plan.skipped.length === 1 ? 'archivo quedó' : 'archivos quedaron'} afuera`}
            icon={<FileWarning className="size-[1.15rem]" strokeWidth={1.9} />}
          >
            <ul className="space-y-1.5">
              {plan.skipped.map((s) => (
                <li key={s.file} className="min-w-0">
                  <span className="font-mono text-xs break-all text-ink">{s.file}</span>
                  <span className="block text-sm">{s.reason}</span>
                </li>
              ))}
            </ul>
          </Callout>
        </CardBody>
      )}
    </Card>
  )
}
