import type { Metadata } from 'next'
import { CreditCard } from 'lucide-react'
import { PageHeader } from '@/components/shell'
import { EmptyState } from '@/components/ui'
import { requireSession } from '../current-org'

export const metadata: Metadata = { title: 'Plan y pagos' }
export const dynamic = 'force-dynamic'

export default async function FacturacionPage() {
  await requireSession()

  return (
    <>
      <PageHeader title="Plan y pagos" />

      <EmptyState
        icon={<CreditCard aria-hidden="true" strokeWidth={1.7} className="size-7" />}
        title="Todavía no armamos el cobro"
        description="No tenés nada contratado ni te vamos a cobrar nada sin avisarte antes. Cuando esté listo, vas a ver acá cuánto sale cada cosa en dólares, antes de gastar un centavo."
      />
    </>
  )
}
