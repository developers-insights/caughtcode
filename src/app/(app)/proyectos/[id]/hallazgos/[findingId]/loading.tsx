import { Skeleton } from '@/components/ui'

/** El hueco del video primero, porque es lo primero que se ve. */
export default function CargandoHallazgo() {
  return (
    <div aria-busy="true" aria-live="polite">
      <div className="mb-8 space-y-3">
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-10 w-full max-w-xl" />
        <Skeleton className="h-6 w-40" />
      </div>

      <Skeleton className="aspect-video w-full rounded-xl" />

      <div className="mt-10 space-y-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton lines={3} />
      </div>

      <div className="mt-10 space-y-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton lines={2} />
      </div>

      <Skeleton className="mt-10 h-48 w-full rounded-lg" />
    </div>
  )
}
