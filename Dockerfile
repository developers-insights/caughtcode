# ============================================================================
# caughtcode · worker dedicado (Render, Background Worker)
# ----------------------------------------------------------------------------
# Por qué existe esto: hoy `scripts/worker.ts` corre en Vercel disparado por un
# cron cada 60s contra /api/worker/tick, y ahí no funciona — se muere por OOM y,
# aparte, Playwright vive en devDependencies así que ni siquiera se empaqueta
# ("Cannot find module '.../playwright-core/browsers.json'"). Este Dockerfile
# empaqueta `pnpm worker` como proceso largo, con Chromium ya instalado, para
# correr en un Background Worker de Render (sin HTTP, sin límite de duración
# por request). El cron de Vercel queda como red de seguridad nada más.
#
# ⚠️ VERSIÓN PINEADA A PLAYWRIGHT: la imagen base trae Chromium + todas las
# dependencias de sistema (fonts, libs gráficas) ya instaladas para la versión
# exacta de Playwright que dice el tag. Si algún día se sube la versión de
# `playwright` en package.json, HAY QUE subir el tag (Y el digest de abajo) de
# esta imagen al mismo número — si no, `playwright-core` (JS) y el Chromium
# instalado en el contenedor quedan desalineados y el navegador no arranca. Hoy:
#   playwright == 1.62.1 (pnpm-lock.yaml lo fija exacto, sin rango)
#   imagen     == mcr.microsoft.com/playwright:v1.62.1-noble
# ("noble" = Ubuntu 24.04 LTS; es la distro recomendada por Playwright al día
# de escribir esto. También existe "-jammy" para Ubuntu 22.04 si hiciera falta
# por alguna incompatibilidad puntual de librerías del sistema.)
#
# El tag es mutable (Microsoft puede repushear "v1.62.1-noble" con parches de
# SO sin avisar), así que el `FROM` de abajo fija el digest inmutable del
# índice multi-arch (amd64 + arm64) verificado así:
#   curl -s -H "Accept: application/vnd.oci.image.index.v1+json" \
#     https://mcr.microsoft.com/v2/playwright/manifests/v1.62.1-noble
# → digest confirmado 2026-08-12: sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e
# Si se sube el tag de Playwright, hay que repetir este curl contra el tag
# nuevo y actualizar el digest acá — no copiarlo de memoria.
# ============================================================================

# ── Etapa base: imagen oficial de Playwright + pnpm ─────────────────────────
# Trae Node preinstalado (Playwright empaqueta su propio Node en la imagen,
# no el `node:XX` genérico). El `package.json` del repo pide Node >=20.9.0;
# Vercel usa 24.x, pero acá lo que manda es lo que trae la imagen de
# Playwright para esa versión — no se puede "elegir" Node por separado sin
# arriesgar que Chromium quede sin sus libs de sistema. Se fija la versión de
# pnpm (que es lo que ya usa el repo — hay pnpm-lock.yaml, no package-lock)
# instalándola global con npm; ver el comentario de la línea de abajo por qué
# no Corepack.
FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e AS base

# Se instala pnpm con `npm i -g` en vez de `corepack enable && corepack
# prepare` a propósito. `corepack prepare` (corriendo acá como root) deja el
# tarball descargado en `COREPACK_HOME`, que por defecto es
# `~/.cache/node/corepack` → `/root/.cache/...`. Más abajo el contenedor pasa
# a `USER pwuser` y arranca con `CMD ["pnpm", "worker"]`: el shim de corepack
# corre entonces como `pwuser`, mira `/home/pwuser/.cache/node/corepack`, no
# encuentra nada ahí y sale a **descargar pnpm del registry en cada arranque
# del contenedor**. Con egress restringido, un registry lento o un fallo de
# integridad, el worker no levanta y el error no menciona corepack para nada.
# (Se podría arreglar fijando `ENV COREPACK_HOME=/opt/corepack` antes del
# `prepare` + `chmod -R a+rX /opt/corepack`, pero eso sigue dependiendo de que
# el shim de corepack se comporte igual en cada versión de Node/corepack que
# traiga la imagen base. Instalar con npm dejar pnpm ejecutable como binario
# fijo en `/usr/local/bin`, legible y ejecutable por cualquier usuario por el
# umask por defecto de la imagen, sin ningún paso de red en el arranque.)
#
# Fija la MISMA versión de pnpm que se usó al escribir este Dockerfile
# (`pnpm --version` en la máquina de desarrollo). El repo no declara
# `packageManager` en package.json, así que sin pinearla acá quedaría a
# criterio de lo que traiga la imagen de Playwright — mejor fijarla a mano y
# no depender de eso. pnpm-lock.yaml es `lockfileVersion: '9.0'`, que es el
# formato que escribe esta serie de pnpm.
RUN npm install -g pnpm@10.33.2

WORKDIR /app

# ── Etapa deps: instalar dependencias con lockfile congelado ────────────────
# Copiar solo lo necesario para el install primero, así Docker cachea esta capa
# y no reinstala todo cada vez que cambia código fuente sin tocar el lockfile.
FROM base AS deps

# El repo fuerza `node-linker=hoisted` en .npmrc (ver el comentario ahí: es lo
# que evita symlinks en node_modules). Hay que copiar el .npmrc ANTES del
# install para que pnpm respete ese modo acá también — si no, node_modules
# queda con la estructura por defecto de pnpm (symlinks a .pnpm/), que es
# justo lo que rompe `require.resolve('tree-sitter-wasms/package.json')` en
# `src/server/analysis/parser.ts` cuando el resolve tiene que atravesar un
# symlink en un contexto empaquetado.
COPY .npmrc package.json pnpm-lock.yaml ./

# --frozen-lockfile: instalación reproducible, falla si package.json y
# pnpm-lock.yaml no coinciden en vez de reescribir el lockfile en silencio.
#
# `ffmpeg-static` y `sharp` están en `pnpm.onlyBuiltDependencies` (ver
# package.json): sin permitir sus scripts de build, pnpm los deja "a medio
# instalar" y ffmpeg-static no descarga el binario. --frozen-lockfile no
# bloquea onlyBuiltDependencies (es una allowlist declarada en package.json,
# pnpm la respeta sola), así que no hace falta ninguna flag extra para eso.
#
# Playwright ahora vive en `dependencies` (ver el commit que movió la línea en
# package.json), así que este install ya trae `playwright` + `playwright-core`.
#
# A propósito SIN `--prod`: el comando que corre este contenedor es
# `pnpm worker`, que en package.json es
# `tsx --conditions=react-server ... scripts/worker.ts` — y `tsx` está en
# `devDependencies`. No hay un paso de `next build` / `tsc` que compile a JS
# plano antes: el worker corre el `.ts` directo con `tsx`, así que `tsx` es una
# dependencia de RUNTIME acá aunque package.json lo clasifique como dev. Instalar
# con `--prod` rompería el arranque (`tsx: not found`).
RUN pnpm install --frozen-lockfile

# Los navegadores de Playwright YA están instalados en la imagen base
# (mcr.microsoft.com/playwright los trae en /ms-playwright). No hace falta
# `pnpm exec playwright install` acá — de hecho, si el minor de playwright-core
# no coincide con el de la imagen, ese comando fallaría por versión.

# ── Etapa runtime: la imagen que se despliega ────────────────────────────────
FROM base AS runtime

WORKDIR /app

# node_modules ya resuelto (hoisted, con ffmpeg-static y sharp ya compilados)
# más el código fuente. No hay build de Next acá adentro: el worker corre con
# `tsx`, no con `next build` — el `pnpm worker` de package.json ya apunta a
# `tsx --conditions=react-server scripts/worker.ts`.
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# El `.dockerignore` ya saca .next, tests, .git, etc. Por las dudas, ninguna
# carpeta de esas debería pesar en la imagen final aunque un `COPY . .` sea
# amplio: es más simple mantener un solo `.dockerignore` que curar un COPY
# selectivo cada vez que se agrega un archivo nuevo al repo.

# Directorio de almacenamiento del worker (CAUGHTCODE_STORAGE_DIR, ver
# render.yaml y docs/DEPLOY-WORKER.md): filesystem efímero del contenedor, NO
# un Render Disk.
#
# `/app` (código + node_modules) queda dueño de root a propósito, sin chown:
# `pwuser` es el mismo usuario no root que corre Chromium para navegar el sitio
# de un cliente durante `run_browser_agent` — no tiene ningún motivo para poder
# escribir el código de NUESTRA app. `COPY` sin `--chown` deja los archivos
# como root:root, y `pwuser` solo necesita leerlos y ejecutarlos (Docker
# preserva los permisos del build context, que en un checkout normal de git ya
# son legibles/ejecutables por cualquier usuario). Verificado por lectura de
# código: ningún módulo bajo `src/**` ni `scripts/worker.ts` escribe dentro de
# `/app` en runtime — todo `mkdir`/`writeFile` de la corrida (workspace del
# repo, video, audio, capturas del agente) pasa por `CAUGHTCODE_STORAGE_DIR`
# (`src/server/ingest/workspace.ts`), que es la única ruta que de verdad
# necesita ser escribible por `pwuser`. Si algún día algo nuevo necesita
# escribir bajo `/app` (ej. una caché de `tsx`), va a fallar con `EACCES` en
# vez de silencio — la señal correcta para revisar esta decisión, no un chown
# preventivo.
RUN mkdir -p /data/caughtcode-storage && chown -R pwuser:pwuser /data

# Usuario no root. La imagen de Playwright trae `pwuser` de fábrica (UID 1000)
# pensado justo para correr Chromium en sandbox sin privilegios — es el mismo
# usuario que documenta Playwright para sus propios ejemplos de Docker no-root
# (`docker run --user pwuser mcr.microsoft.com/playwright:...`, confirmado en
# la doc oficial de Playwright). Verificar que sigue existiendo si se cambia de
# imagen base algún día:
#   `docker run --rm mcr.microsoft.com/playwright:v1.62.1-noble id pwuser`
USER pwuser

# Variables que necesita el respawn de arranque de scripts/worker.ts (ver el
# comentario largo al principio de ese archivo): usa `--conditions=react-server`
# para que `server-only` resuelva a su build vacío. No es negociable, está
# documentado ahí mismo por qué.
ENV NODE_ENV=production

# El resto de las variables de entorno (Supabase, Anthropic, GitHub App, TTS,
# etc.) las carga Render desde el Blueprint (`render.yaml`), NUNCA desde acá.
# Ninguna variable con secreto va en este Dockerfile.

# `pnpm worker` == `tsx --conditions=react-server --env-file-if-exists=.env.local scripts/worker.ts`
# En producción no hay `.env.local` (así que esa flag no hace nada, no rompe),
# las variables las inyecta Render directo al proceso.
CMD ["pnpm", "worker"]
