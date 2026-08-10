import { Skeleton, SkeletonCard } from '@/components/ui'

/**
 * Mientras la página se arma.
 *
 * Tiene la forma de lo que viene después —encabezado, tres tarjetas grandes,
 * dos filas plegadas— para que cuando llegue el contenido nada se mueva de
 * lugar. Un esqueleto que no coincide con el resultado es peor que nada.
 */
export default function CargandoHallazgos() {
  return (
    <div aria-busy="true" aria-live="polite">
      <div className="mb-8 space-y-3">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-5 w-72" />
      </div>

      <div className="mb-4 space-y-2">
        <Skeleton className="h-7 w-44" />
        <Skeleton className="h-4 w-full max-w-lg" />
      </div>

      <div className="flex flex-col gap-5">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>

      <div className="mt-12 flex flex-col gap-3">
        <Skeleton className="h-14 w-full rounded-lg" />
        <Skeleton className="h-14 w-full rounded-lg" />
      </div>
    </div>
  )
}
