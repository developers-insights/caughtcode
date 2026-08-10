import { ChevronRight, Wand2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Card, CardBody, CardHeader, CardTitle, CopyButton } from '@/components/ui'
import { ARREGLO } from './copy'

export interface FixPromptPanelProps {
  prompt: string
  className?: string
}

/**
 * La acción principal de la pantalla.
 *
 * El usuario no tiene que entender el problema: tiene que poder arreglarlo.
 * Por eso el botón de copiar pesa más que el texto del prompt, y el texto en
 * sí arranca plegado — verlo no ayuda a nadie que no programe, y desplegado
 * empuja hacia abajo todo lo demás.
 */
export function FixPromptPanel({ prompt, className }: FixPromptPanelProps) {
  return (
    <Card className={cn('overflow-hidden', className)}>
      <CardHeader className="gap-2">
        <div className="flex items-center gap-2.5">
          <Wand2 aria-hidden="true" strokeWidth={1.8} className="size-4 shrink-0 text-ink-subtle" />
          <CardTitle as="h2">{ARREGLO.titulo}</CardTitle>
        </div>
        <p className="prose-lectura text-base text-ink-muted">{ARREGLO.bajada}</p>
      </CardHeader>

      <CardBody className="space-y-4">
        <CopyButton
          value={prompt}
          label={ARREGLO.copiar}
          copiedLabel={ARREGLO.copiado}
          failedLabel={ARREGLO.fallo}
          variant="primary"
          size="lg"
          className="w-full sm:w-auto"
        />

        <details className="group">
          <summary
            className={cn(
              'inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-sm pr-2',
              'text-sm text-ink-muted transition-colors duration-150 ease-firm hover:text-ink',
              'focus-visible:focus-ring [&::-webkit-details-marker]:hidden',
            )}
          >
            <ChevronRight
              aria-hidden="true"
              strokeWidth={1.8}
              className="size-4 transition-transform duration-200 ease-firm group-open:rotate-90"
            />
            {ARREGLO.verTexto}
          </summary>

          <pre
            className={cn(
              'mt-2 max-h-80 overflow-auto rounded-md border border-line bg-canvas-sunken',
              'p-4 font-mono text-sm leading-[1.65] whitespace-pre-wrap text-ink-muted',
            )}
          >
            {prompt}
          </pre>
        </details>
      </CardBody>
    </Card>
  )
}
