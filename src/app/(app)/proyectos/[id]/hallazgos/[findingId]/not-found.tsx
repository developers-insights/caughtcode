import { ErrorState } from '@/components/ui'

/**
 * El hallazgo no está.
 *
 * Casi siempre es un enlace viejo: la revisión se volvió a correr y este
 * hallazgo ya no existe. Lo decimos así, no con un número de error.
 */
export default function HallazgoNoEncontrado() {
  return (
    <ErrorState
      kind="not-found"
      title="Este hallazgo ya no está"
      description="Puede que la revisión se haya vuelto a correr y el problema ya no aparezca. Mirá la lista completa: si sigue estando, va a figurar ahí."
    />
  )
}
