/**
 * La puerta de calidad, en un solo comando: `pnpm verificar`.
 *
 * Corre todo lo que tiene que estar en verde antes de decir que algo está
 * terminado, y **no se detiene en el primer rojo**: corre todo y al final
 * muestra la lista completa. Frenar en el primero obliga a repetir el ciclo
 * una vez por problema.
 *
 * La última etapa es la que más importa y la que ninguna otra reemplaza:
 * auditar un repositorio público de verdad, de punta a punta. Los tests
 * prueban cada motor por separado contra fixtures; esto prueba que el
 * producto hace lo que promete sobre código que nadie preparó.
 *
 * Necesita red para esa última etapa (baja repos de GitHub). No necesita
 * base de datos, ni la cola, ni `ANTHROPIC_API_KEY`.
 */
import { spawn } from 'node:child_process'

interface Etapa {
  nombre: string
  /**
   * Línea de comando completa, no comando + args.
   *
   * Con `shell: true`, pasar los argumentos por separado hace que Node avise
   * `DEP0190` (no los escapa, los concatena igual). Acá no hay nada que
   * escapar —los comandos son literales de este archivo, no entra nada de
   * afuera— así que se los escribe ya concatenados y el aviso desaparece.
   */
  comando: string
  /** Qué se rompe si esto falla. Se muestra solo cuando falla. */
  significa: string
}

const ETAPAS: Etapa[] = [
  {
    nombre: 'typecheck',
    comando: 'pnpm typecheck',
    significa: 'Hay tipos que no cierran. El build de Vercel va a fallar.',
  },
  {
    nombre: 'lint',
    comando: 'pnpm lint',
    significa: 'Hay errores de accesibilidad o de React. Ver `docs/DECISIONS.md` D21.',
  },
  {
    nombre: 'tests',
    comando: 'pnpm test',
    significa: 'Se rompió una invariante que alguien se tomó el trabajo de fijar.',
  },
  {
    nombre: 'build',
    comando: 'pnpm build',
    significa: 'No compila para producción. Nada de esto se puede desplegar.',
  },
  {
    nombre: 'auditoría real',
    comando: 'pnpm auditar',
    significa:
      'El producto no puede auditar un repositorio real. Es la única etapa que prueba el ' +
      'pipeline completo (ingesta → índice → chequeos) contra código que nadie preparó.',
  },
]

function correr(etapa: Etapa): Promise<{ ok: boolean; ms: number; ultimasLineas: string[] }> {
  return new Promise((resolve) => {
    const arranque = Date.now()
    const hijo = spawn(etapa.comando, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })

    const buffer: string[] = []
    const guardar = (chunk: Buffer) => {
      for (const linea of chunk.toString().split('\n')) {
        if (linea.trim()) buffer.push(linea)
      }
      /* Solo interesan las últimas: los errores van al final. */
      if (buffer.length > 400) buffer.splice(0, buffer.length - 400)
    }

    hijo.stdout.on('data', guardar)
    hijo.stderr.on('data', guardar)
    hijo.on('close', (code) => {
      resolve({ ok: code === 0, ms: Date.now() - arranque, ultimasLineas: buffer.slice(-15) })
    })
  })
}

async function main() {
  console.log(`\ncaughtcode — puerta de calidad\n${'═'.repeat(60)}`)

  const fallaron: { etapa: Etapa; ultimasLineas: string[] }[] = []

  for (const etapa of ETAPAS) {
    process.stdout.write(`  ${etapa.nombre.padEnd(16)} … `)
    const { ok, ms, ultimasLineas } = await correr(etapa)
    const segundos = `${(ms / 1000).toFixed(0)}s`
    console.log(ok ? `OK    ${segundos}` : `FALLA ${segundos}`)
    if (!ok) fallaron.push({ etapa, ultimasLineas })
  }

  console.log('═'.repeat(60))

  if (fallaron.length === 0) {
    console.log('\nTodo en verde.\n')
    return
  }

  console.log(`\n${fallaron.length} etapa(s) en rojo:\n`)
  for (const { etapa, ultimasLineas } of fallaron) {
    console.log(`── ${etapa.nombre} ──`)
    console.log(`   ${etapa.significa}\n`)
    for (const linea of ultimasLineas) console.log(`   ${linea}`)
    console.log('')
  }

  process.exitCode = 1
}

main().catch((error) => {
  console.error('\nLa verificación no pudo correr:', error)
  process.exitCode = 1
})
