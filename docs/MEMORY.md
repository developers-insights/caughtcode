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
- **En `rls.sql`, ningún `count(*)` puede asumir base vacía.** El seed corre como `postgres` (sin RLS) en la sección 1, así que un `count(*) from organizations_caughtcode` global cuenta también las organizaciones de producción reales. Hay que filtrar por los ids sembrados (`owner_user_id in (...)`). Los `count(*)` de las secciones 2+ (bajo `role authenticated`) no tienen este problema porque las policies ya acotan el resultado a lo que ve ese usuario.

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

### 2026-08-22 — Railway, linter y la primera auditoría E2E real

**El `Dockerfile` construye. Ya no es una incógnita.** Nunca se había corrido (no hay Docker en la
máquina de desarrollo) y era el riesgo abierto más grande del deploy. Primera construcción real en
Railway: imagen de 1.13 GB sobre `mcr.microsoft.com/playwright:v1.62.1-noble`,
`pnpm install --frozen-lockfile` sin tocar el lockfile, `/data/caughtcode-storage` creado con dueño
`pwuser`. Salió sin un solo ajuste.

**El conector de Supabase `supabase-comunidad-latina` NO llega a la base de caughtcode.** Apunta a
`vnfqzlcxpmofvsoxnptf` ("Comunidad Latina", inactivo), que es un proyecto **distinto y homónimo**.
El nuestro es `ktmbtpuhqqofdkisqseq`, que en el panel se llama "Comunidad latina y caughtcode". El
que sí llega es `supabase-cuenta-dev` (es un PAT con alcance de cuenta), pasándole
`project_id: "ktmbtpuhqqofdkisqseq"` en cada llamada. Perder tiempo con el conector equivocado es
fácil: los dos proyectos se llaman casi igual.

**`typescript-eslint` no soporta TypeScript 7, y no hay versión que sí.** Verificado contra el
registro: ni la última estable (8.67.0) ni las alpha. Todas piden `typescript >=4.8.4 <6.1.0`. Y no
alcanza con sacar `next/typescript` del config: `eslint-config-next` importa `typescript-eslint`
desde su propio `index.js`, así que ni `core-web-vitals` carga. El side-by-side con TS 6 que
recomienda el equipo de TypeScript **tampoco aplica acá**, porque el `.npmrc` fija
`node-linker=hoisted` y con el árbol aplanado no puede haber dos versiones de `typescript`
(probado con `pnpm.overrides`: el parser siguió resolviendo la 7.0.2). Se pasó a **oxlint** (ver
D21).

**Un linter que no corre cuesta plata.** Apenas `pnpm lint` volvió a funcionar aparecieron **27
errores** de accesibilidad y de React que llevaban meses invisibles, en un producto cuyo trabajo es
encontrarle esos mismos problemas a las apps de otros.

**Ojo con los falsos positivos de a11y sobre componentes propios.** `control-has-associated-label`
marcaba tres botones del wizard que **sí** tienen texto — pero adentro de `<Card>`/`<CardBody>`, que
el linter no puede analizar. No era un bug real. Se resolvió con `aria-label` explícito, que además
mejora lo que anuncia el lector de pantalla. Antes de "arreglar" un hallazgo de a11y sobre un
componente compuesto, mirar si el linter simplemente no puede ver adentro.

**Lo que sí era un bug real:** `source-drop-zone.tsx` tenía el `<input type="file">` **dentro** de un
`<div role="button">`. Es HTML inválido (un control interactivo no puede vivir dentro de un botón).
Ahora es un `<button>` de verdad con el input como hermano — y se fueron el `tabIndex` y el
`onKeyDown` a mano, que el navegador ya hace solo.

**El pipeline produce hallazgos reales sobre repos reales.** `scripts/auditar-repo-real.ts`
(`pnpm auditar [url]`) encadena ingesta → índice → chequeos sin base de datos ni cola, y sin
`ANTHROPIC_API_KEY` (`usarModelo: false`, determinístico). Probado contra tres repos públicos, con
hallazgos verificables en cada uno — entre ellos `/api/seed` sin autenticación en la plantilla
oficial de Next.js de Vercel, y la tabla `users` sin RLS más dos `.env.local.ci` versionados en el
monorepo de `supabase-js`. Las tres reglas duras (evidencia siempre, máximo 3 destacados, cero
marcadores `{{}}` sin completar) se verifican en cada corrida.

**`process.exit()` en un script que usó tree-sitter revienta en Windows.** Deja handles de libuv
abiertos y cerrarlos a la fuerza termina en `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`
después de la última línea — parece que el script falló cuando terminó bien. Usar `process.exitCode`.

**Las 10 funciones `SECURITY DEFINER` expuestas a `authenticated` están bien.** Auditadas con
explotación real (JWT de un tercero contra datos de otra organización, todo dentro de
`begin; … rollback;`), con controles negativos para descartar un falso verde y una prueba de
mutación que confirma que el test detecta el agujero si se lo introduce. Red de contención nueva:
`supabase/tests/rpc_autorizacion.sql`. Los WARN de `get_advisors` sobre estas funciones son
**esperados**: son para que las llame el navegador, y validan al llamante por dentro.
