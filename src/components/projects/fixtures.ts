/**
 * Datos de ejemplo para `CAUGHTCODE_DEMO=1`.
 * Mismo patrón que `src/app/(app)/proyectos/[id]/hallazgos/fixtures` (frente
 * de hallazgos): sin base conectada, estas pantallas se sirven con esto.
 */

import type { StackInfo } from '@/lib/types/domain'

export interface ProjectSummary {
  id: string
  name: string
  clientName: string | null
  sourceType: 'github' | 'github_public' | 'zip'
  deployedUrl: string | null
  stackDetected: StackInfo | null
  createdAt: string
  retentionDays: number
}

const STACK_NEXT: StackInfo = {
  framework: 'nextjs',
  language: 'typescript',
  packageManager: 'pnpm',
  backends: ['supabase'],
  hasTypescript: true,
  hasTailwind: true,
  routerKind: 'app',
  evidence: ['next.config.ts → es una app Next.js', 'package.json declara @supabase → los datos viven en Supabase'],
}

const STACK_REACT: StackInfo = {
  framework: 'react',
  language: 'typescript',
  packageManager: 'npm',
  backends: ['firebase'],
  hasTypescript: true,
  hasTailwind: false,
  routerKind: 'react-router',
  evidence: ['package.json declara react-router → las pantallas se definen con react-router'],
}

export const DEMO_PROJECTS: ProjectSummary[] = [
  {
    id: 'demo-project-tienda',
    name: 'Tienda de Ana',
    clientName: null,
    sourceType: 'zip',
    deployedUrl: 'https://tienda-de-ana.vercel.app',
    stackDetected: STACK_NEXT,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3).toISOString(),
    retentionDays: 30,
  },
  {
    id: 'demo-project-crm',
    name: 'CRM interno',
    clientName: 'Estudio Norte',
    sourceType: 'github',
    deployedUrl: null,
    stackDetected: STACK_REACT,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 12).toISOString(),
    retentionDays: 30,
  },
]
