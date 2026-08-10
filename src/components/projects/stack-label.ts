import type { StackFramework } from '@/lib/types/domain'

const FRAMEWORK_LABEL: Partial<Record<StackFramework, string>> = {
  nextjs: 'Next.js',
  react: 'React',
  vite: 'Vite',
  remix: 'Remix',
  astro: 'Astro',
  flutter: 'Flutter',
  python: 'Python',
  node: 'Node',
}

export function frameworkLabel(framework: StackFramework): string | undefined {
  return FRAMEWORK_LABEL[framework]
}
