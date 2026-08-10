import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  /**
   * Todo esto se carga en tiempo de ejecución desde el servidor, nunca se
   * empaqueta. `tree-sitter-wasms` es el que obliga: sus `.wasm` traen un
   * cargador que importa un módulo `env` que solo existe dentro del runtime de
   * WebAssembly, así que cualquier intento de bundlearlo rompe el build entero
   * en cuanto la cola de trabajos entra en el grafo de importaciones.
   */
  serverExternalPackages: [
    'pg',
    'web-tree-sitter',
    'tree-sitter-wasms',
    'ffmpeg-static',
    'playwright',
    'playwright-core',
  ],
  outputFileTracingIncludes: {
    '/api/**': ['./node_modules/tree-sitter-wasms/out/*.wasm'],
  },
}

export default nextConfig
