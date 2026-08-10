'use client'

import { useState } from 'react'
import { Download, FileDiff, FolderDown } from 'lucide-react'
import { COMENTARIOS } from '@/content/copy'
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  CodeBlock,
  notify,
} from '@/components/ui'
import { nombreDelParche, type CleanPlanView } from './model-clean'

const n = (x: number) => x.toLocaleString('es-AR')

function descargar(nombre: string, datos: BlobPart, tipo: string) {
  const url = URL.createObjectURL(new Blob([datos], { type: tipo }))
  const a = document.createElement('a')
  a.href = url
  a.download = nombre
  document.body.append(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export interface ApplyPanelProps {
  plan: CleanPlanView
  className?: string
}

/**
 * Cómo se aplica.
 *
 * Las dos salidas son archivos que se descargan. No pedimos permiso de
 * escritura sobre el repositorio de nadie y no lo vamos a pedir: que el cambio
 * pase por las manos de la persona es parte de por qué se puede confiar en el
 * botón.
 */
export function ApplyPanel({ plan, className }: ApplyPanelProps) {
  const [armandoZip, setArmandoZip] = useState(false)
  const archivoParche = nombreDelParche(plan.mode)

  async function descargarZip() {
    setArmandoZip(true)
    try {
      const { zipSync, strToU8 } = await import('fflate')
      const entradas: Record<string, Uint8Array> = {}
      for (const f of plan.files) entradas[f.file] = strToU8(f.after)

      descargar('caughtcode-archivos-limpios.zip', zipSync(entradas), 'application/zip')
      notify.ok('Listo. Reemplazá esos archivos en tu proyecto.')
    } catch {
      notify.problema('No pudimos armar el zip. Probá con el archivo de cambios.')
    } finally {
      setArmandoZip(false)
    }
  }

  return (
    <Card as="section" className={className}>
      <CardHeader className="gap-2">
        <CardTitle as="h2">{COMENTARIOS.aplicar.titulo}</CardTitle>
        <p className="max-w-prose text-base leading-relaxed text-ink-muted">
          {COMENTARIOS.aplicar.texto}
        </p>
      </CardHeader>

      <CardBody className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-2.5 rounded-md border border-line bg-canvas-sunken/50 p-4">
            <FileDiff aria-hidden="true" className="size-5 text-ink-subtle" strokeWidth={1.9} />
            <p className="text-base font-semibold text-ink">El archivo de cambios</p>
            <p className="flex-1 text-sm leading-relaxed text-ink-muted">
              Se abre en cualquier editor. Se ve línea por línea qué sale, y se aplica cuando estés
              conforme.
            </p>
            <Button
              variant="primary"
              icon={<Download />}
              onClick={() => descargar(archivoParche, plan.patch, 'text/x-patch')}
              className="mt-1 w-full"
            >
              Descargar
            </Button>
          </div>

          <div className="flex min-w-0 flex-col gap-2.5 rounded-md border border-line bg-canvas-sunken/50 p-4">
            <FolderDown aria-hidden="true" className="size-5 text-ink-subtle" strokeWidth={1.9} />
            <p className="text-base font-semibold text-ink">Los archivos ya limpios</p>
            <p className="flex-1 text-sm leading-relaxed text-ink-muted">
              Los {n(plan.files.length)} que cambian, sin los comentarios. Los reemplazás en tu
              proyecto y listo.
            </p>
            <Button
              variant="secondary"
              icon={<FolderDown />}
              loading={armandoZip}
              loadingLabel="Armando el zip…"
              onClick={descargarZip}
              className="mt-1 w-full"
            >
              Descargar
            </Button>
          </div>
        </div>

        <div className="min-w-0">
          <p className="mb-2 text-sm text-ink-muted">
            Si preferís aplicarlo desde la terminal, pegá esto en la carpeta de tu proyecto:
          </p>
          <CodeBlock code={`git apply ${archivoParche}`} showLineNumbers={false} language="terminal" />
        </div>

        <Callout tone="verificado" title="Verificamos que tu app siga funcionando igual">
          {COMENTARIOS.garantia}
        </Callout>
      </CardBody>
    </Card>
  )
}
