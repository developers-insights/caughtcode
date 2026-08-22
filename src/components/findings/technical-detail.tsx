import { DETALLE_TECNICO } from './copy'

export interface TechnicalDetailProps {
  /** El texto crudo del motor. Si no hay, no se renderiza nada. */
  detalle: string | null | undefined
  className?: string
}

/**
 * El texto original del error, plegado.
 *
 * Regla dura: cero jerga en texto visible. Pero "cero jerga" no es "borrar la
 * información": lo que dijo el motor es lo único que nos deja diagnosticar
 * cuando alguien nos escribe. Así que no se elimina, se reubica — un
 * desplegable cerrado, debajo del mensaje en criollo, que nadie tiene que abrir
 * para entender qué pasó ni qué hacer.
 *
 * Mismo tratamiento que el `detail` de `ErrorState`, para que el gesto se
 * reconozca igual en toda la app.
 */
export function TechnicalDetail({ detalle, className }: TechnicalDetailProps) {
  if (!detalle?.trim()) return null

  return (
    <details className={className}>
      <summary className="cursor-pointer list-none text-sm text-ink-muted underline underline-offset-4 hover:text-ink focus-visible:focus-ring">
        {DETALLE_TECNICO.abrir}
      </summary>
      <pre className="mt-3 max-h-48 overflow-auto rounded-sm bg-canvas-sunken p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink-muted">
        {detalle}
      </pre>
    </details>
  )
}
