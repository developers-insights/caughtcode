/**
 * Zips armados a propósito para atacar al extractor.
 *
 * Se generan en memoria con fflate en vez de guardarse como binarios en el repo:
 * un .zip malicioso versionado es exactamente lo que después vamos a estar
 * marcándole a otro como problema.
 */

import { zipSync, type Zippable } from 'fflate'

const encoder = new TextEncoder()

export function bytes(text: string): Uint8Array {
  return encoder.encode(text)
}

/** Proyecto chiquito pero válido. */
export function zipLimpio(): Uint8Array {
  return zipSync({
    'mi-app/package.json': bytes('{"name":"mi-app","dependencies":{"next":"^16.0.0"}}'),
    'mi-app/src/app/page.tsx': bytes('export default function Page() { return <main>hola</main> }\n'),
    'mi-app/README.md': bytes('# mi app\n'),
  } satisfies Zippable)
}

/** Intenta escribir fuera de la carpeta destino. El clásico "zip slip". */
export function zipConPathTraversal(): Uint8Array {
  return zipSync({
    'app/package.json': bytes('{"name":"app"}'),
    '../../../../etc/perfil-comprometido': bytes('root::0:0:::\n'),
  } satisfies Zippable)
}

/** Ruta absoluta: otra forma de escaparse. */
export function zipConRutaAbsoluta(): Uint8Array {
  return zipSync({
    'app/package.json': bytes('{"name":"app"}'),
    '/tmp/caughtcode-no-deberia-existir': bytes('nada'),
  } satisfies Zippable)
}

/** Un archivo que se declara enlace simbólico a /etc/passwd. */
export function zipConSymlink(): Uint8Array {
  return zipSync({
    'app/package.json': bytes('{"name":"app"}'),
    // os 3 = Unix, modo 0o120777 = enlace simbólico.
    'app/atajo': [bytes('/etc/passwd'), { os: 3, attrs: 0o120777 << 16 }],
  } satisfies Zippable)
}

/**
 * Bomba de descompresión: 40 MB de ceros comprimen a unos pocos KB.
 * La relación entre lo comprimido y lo descomprimido lo delata.
 */
export function zipBomba(): Uint8Array {
  return zipSync({
    'app/package.json': bytes('{"name":"app"}'),
    'app/relleno.txt': new Uint8Array(40 * 1024 * 1024),
  } satisfies Zippable)
}

/** Un archivo de código de más de 5 MB: se saltea, no frena la corrida. */
export function zipConArchivoPesado(): Uint8Array {
  const grande = bytes('const x = "' + 'a'.repeat(6 * 1024 * 1024) + '";\n')
  return zipSync({
    'app/package.json': bytes('{"name":"app"}'),
    'app/src/index.ts': bytes('export const ok = 1\n'),
    'app/src/enorme.ts': grande,
  } satisfies Zippable)
}

/** Trae dependencias y compilados: tienen que quedar todos afuera. */
export function zipConBasura(): Uint8Array {
  return zipSync({
    'app/package.json': bytes('{"name":"app"}'),
    'app/src/index.ts': bytes('export const ok = 1\n'),
    'app/node_modules/left-pad/index.js': bytes('module.exports = () => {}\n'),
    'app/.next/static/chunk.js': bytes('console.log(1)\n'),
    'app/dist/bundle.js': bytes('console.log(2)\n'),
    'app/.git/config': bytes('[core]\n'),
    'app/public/logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  } satisfies Zippable)
}
