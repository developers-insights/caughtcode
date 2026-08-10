# Memoria del proyecto — caughtcode

> Gotchas, aprendizajes y cosas que costó descubrir. **Se agrega, no se reescribe.**
> Para el *por qué* de las decisiones de producto → `DECISIONS.md`. Acá va lo táctico.

---

## Trampas conocidas (antes de tropezar)

### Supabase

- **Branching exige plan Pro del USUARIO, no del nuestro.** Las branches se crean sobre *su* proyecto. Además facturan contra su cuenta y **no** están cubiertas por su Spend Cap. Por eso se descartó (D9).
- **Para probar RLS no hace falta crear usuarios.** Se simulan los claims del JWT dentro de una transacción con `ROLLBACK`. No escribe nada, funciona en plan Free. Es la técnica estándar de testeo de RLS en Postgres.
- **Leer el schema de la DB real, no los archivos de migración.** `pg_policies` e `information_schema` reflejan el estado aplicado; el SQL del repo refleja la intención, que puede diferir.
- `get_advisors` (security + performance) después de **cada** migración. No es opcional.

### Análisis de código

- **Las rutas ya son las features.** En Next.js App Router cada `page.tsx` es una. No hay que "descubrirlas" con IA — es un glob del filesystem. Lo mismo con `go_router` en Flutter.
- **El AST de repos grandes falla cerca del final.** Le pasa a Greptile alrededor del 99% de los nodos hoja. Por eso el pipeline tiene que ser por etapas y resumible, no un job monolítico.
- **Los embeddings no son el camino.** Sourcegraph los deprecó por costo, escalabilidad y privacidad. Grafo estructural + PageRank gana para explicar arquitectura completa.
- **Prisma expone DMMF** (AST en JSON del schema) vía `@prisma/get-dmmf`. Drizzle tiene `drizzle-kit pull`. No parsear con regex.

### Video y voz

- **Remotion no es MIT.** Gratis hasta 3 empleados; después el tier "Automators" cuesta $0.01/render con **mínimo $100/mes**. Y hay zona gris para SaaS que renderiza para terceros.
- **Motion Canvas tiene componente de cámara nativo** — el zoom/dim que necesitamos ya viene hecho, y es MIT.
- **ElevenLabs es 5-10x más caro** que Azure/Google. Azure tiene voces **es-AR** específicas.
- **La voz sintética no molesta; la voz apurada sí.** Caso documentado: watch time de 9s → 24s solo bajando el ritmo y agregando pausas.

### GitHub

- **No existe scope OAuth de solo-lectura para repos privados específicos.** Se resuelve con GitHub App o PAT fine-grained.

---

## Contexto del negocio que conviene no olvidar

- **El usuario objetivo no puede detectar una alucinación.** Esa es la diferencia con DeepWiki y Greptile, cuyo público sí puede contrastar. Define todo el diseño del producto.
- **Vibe App Scanner ya existe** con 8 pilares a $19/mes. Competir por cobertura es perder.
- **Lovable ya shippeó chat Q&A y security scan nativos.** No construir nada que la plataforma madre regale.
- **Midrender (YC)** hace codebase → walkthrough animado. Hoy apunta a marketing; el pivot les cuesta nada.

---

### Build de Next (Turbopack) — dos trampas que solo aparecen con la cola enchufada

Ninguna de las dos se ve con `tsc` ni con `vitest`: aparecen recién cuando `jobs/handlers.ts`
importa los motores y estos entran al grafo de `/api/worker/tick`. Por eso conviene correr
`pnpm build` **cada vez que se engancha un handler nuevo**, no solo antes de un release.

- **`require.resolve()` con el nombre de archivo interpolado se traga la carpeta entera.**
  `require.resolve(\`tree-sitter-wasms/out/${'${fileName}'}\`)` hace que Turbopack empaquete *todas* las
  gramáticas de `out/`, y varias traen un cargador que importa un módulo `env` que solo existe
  dentro del runtime de WebAssembly → `Can't resolve 'env'` y build caído por gramáticas que ni
  usamos. Se arregla resolviendo el `package.json` del paquete y armando la ruta con `path.join`.
  `serverExternalPackages` **no alcanza** para esto.
- **`new URL('.', import.meta.url)` lo lee como un import.** Turbopack intenta resolver `'.'` como
  módulo y falla. Usar `path.dirname(fileURLToPath(import.meta.url))`.

### Prueba real sin tocar producción ajena

`auth.users` es compartida con otro producto en producción: sembrar un usuario de prueba a mano
dispararía **sus** triggers. La primera auditoría de punta a punta arranca con alguien registrándose
desde `/registro`, no con un seed. Lo que sí se puede verificar sin base es el camino de ingesta
completo (`scripts/probar-repo-publico.ts`).

## Bitácora de aprendizajes

### 2026-08-09
- Sesión de diseño. Sin código todavía, así que no hay gotchas de implementación aún.
- Aprendizaje de método: las 7 investigaciones en paralelo costaron ~$35 pero **cambiaron el producto entero** — la idea original competía con alternativas gratis y atacaba un dolor secundario. Barato comparado con construir lo equivocado.
- El gate `gateguard-fact-force` pide justificar cada archivo nuevo antes de crearlo. Se desactiva con `ECC_GATEGUARD=off`.
