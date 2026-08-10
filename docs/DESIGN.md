# Sistema visual de caughtcode

> Manual para todos los frentes. Si vas a escribir UI, esto es normativo.
> Los tokens viven en `src/styles/tokens.css`. Las primitivas, en `src/components/ui/`.
> **No redefinas nada de acá en tu carpeta.** Si te falta algo, pedilo en tu reporte.

---

## 0. La idea, en una frase

**La interfaz es acromática. El color significa una sola cosa: el estado de un hallazgo.**

Por eso el botón principal es tinta (casi negro) y no un color de marca. Si "Analizar"
fuera azul o violeta, el rojo de un hallazgo grave sería un color más en la pantalla.
Como no lo es, cuando aparece rojo, se ve.

Todo lo demás sale de ahí:

| Decisión | Por qué |
|---|---|
| Fondo de papel tibio, no blanco de pantalla | Le da carácter de documento revisado, no de dashboard |
| Serif de alto contraste en los títulos grandes | Autoridad. Un informe firmado por alguien, no salida de una máquina |
| Cero color en la navegación, en los botones, en los avatares | Deja el espectro libre para la semántica |
| El hallazgo grave lleva marca al margen y fondo teñido | Se distingue del menor **sin leer**, a tres metros |

Nuestra única ventaja defendible es que se entiende. Un diseño genérico la mata.

---

## 1. Tipografía

| Familia | Utilidad | Dónde va |
|---|---|---|
| **Instrument Sans** | `font-sans` (default) | Toda la interfaz: navegación, botones, formularios, tablas, prosa |
| **Instrument Serif** | `font-display` | Solo los momentos importantes: título de un hallazgo, título de pantalla con `display`, la marca |
| **JetBrains Mono** | `font-mono` | Código, rutas de archivo, números de línea, IDs, cadenas de conexión |

### Por qué estas

**Instrument Serif** en los titulares porque el producto le tiene que decir a una persona
no técnica *"esto es serio"* antes de que lea la primera palabra. Una serif de alto
contraste hace eso; una grotesca en negrita solo hace ruido. Además tiene la ventaja de
no parecer generada: es la tipografía de una revista o de un peritaje, no la de una
plantilla de SaaS.

**Instrument Sans** para la interfaz porque es de la misma fundición — las dos comparten
proporciones y se ven de la misma familia — y porque es una grotesca ligeramente
condensada, técnica, que aguanta bien 13px con acentos del español. Es variable, así que
el peso se ajusta sin cargar archivos extra.

**JetBrains Mono** para el código porque es la más legible del grupo en fragmentos cortos,
que es exactamente lo que mostramos: cuatro líneas con una marcada.

**Ninguna es Inter.** Inter por default es el tic visual más reconocible de una interfaz
generada por IA, y nuestro usuario objetivo lo tiene visto.

Se cargan con `next/font/google` en `src/app/layout.tsx`, con `display: swap`. No las
importes de nuevo en ningún lado: ya están en `--font-sans` / `--font-display` / `--font-mono`.

### Escala

Saltos reales, no seis tamaños casi iguales:

| Clase | px | Para qué |
|---|---|---|
| `text-2xs` | 11 | Contadores, insignias chiquitas |
| `text-eyebrow` | 11 | Etiqueta en versalitas arriba de un título (`SEGURIDAD`) |
| `text-xs` | 12 | Metadatos, nombres de archivo |
| `text-sm` | 13 | Ayuda de campo, texto secundario, migas de pan |
| `text-base` | 15 | **Interfaz.** El default de todo control y etiqueta |
| `text-lg` | 17 | **Prosa que el usuario tiene que entender.** Explicación de un hallazgo |
| `text-xl` | 22 | Título de tarjeta |
| `text-2xl` | 28 | Título de pantalla |
| `text-3xl` | 40 | Titular de hallazgo (con `font-display`) |
| `text-4xl` / `text-5xl` | 56 / 72 | Landing |

**15 vs 17 no es capricho.** 15 es densidad de interfaz. 17 es para el párrafo que explica
por qué a alguien le importa lo que encontramos. Para esos párrafos existe la clase
`.prose-lectura`: mide 68 caracteres, interlínea 1.7, y ya trae estilo de `<strong>` y `<code>`.

---

## 2. Color

### Los cuatro tonos semánticos

Los mismos en la UI y en el video. Se definen una vez y no se tocan.

| Tono | Color | Qué significa |
|---|---|---|
| `expuesto` | rojo | Se comprobó que está abierto o roto |
| `incompleto` | ámbar | Falta algo, o quedó a medias |
| `verificado` | verde | Se probó y está bien |
| `revisar` | azul apagado | No hay certeza suficiente para afirmarlo |

`revisar` tiene el croma a propósito bajo (0.085 contra 0.205 del rojo): **nunca compite
con un hallazgo grave.**

Cada tono tiene cinco utilidades:

```
bg-expuesto-soft      fondo tenue        → fondo de una tarjeta marcada, de un aviso
border-expuesto-border borde             → borde de esa tarjeta
text-expuesto-text     texto             → texto sobre el fondo tenue
bg-expuesto            sólido            → sello, punto, barra al margen, relleno de insignia
text-expuesto-on       texto sobre sólido → el único texto que va arriba del sólido
```

Igual para `incompleto`, `verificado`, `revisar`, y `neutral` (que mapea a los neutros).

**Los sólidos no cambian entre tema claro y oscuro.** Son tinta de sello: el mismo rojo en
la pantalla y en el video. Lo que cambia es el fondo tenue, el borde y el texto.

### Neutros

| Utilidad | Para qué |
|---|---|
| `bg-canvas` | Fondo de página |
| `bg-canvas-sunken` | Pozos: bloque de código, caja de costo, estado vacío |
| `bg-surface` | Tarjetas y paneles |
| `bg-surface-raised` | Lo que flota: diálogo, menú, popover |
| `bg-surface-hover` | Hover sobre una superficie |
| `text-ink` | Texto principal (14:1 sobre blanco) |
| `text-ink-muted` | Texto secundario (5.6:1 — sirve para leer) |
| `text-ink-subtle` | Placeholder y decorativo. **No lo uses para texto que haya que leer** (3.4:1) |
| `text-ink-inverse` | Texto sobre tinta sólida |
| `border-line` | Divisor fino |
| `border-line-strong` | Divisor con peso |
| `border-field` | Borde de control de formulario (≥3:1, exigencia de WCAG) |

`text-focus` / `outline-focus` es cromo del sistema, **no semántica**: el anillo de foco
es azul porque es la convención, no porque signifique "revisar".

### Prohibido

- Hex sueltos en un componente. Todo sale de un token.
- La paleta por default de Tailwind (`bg-blue-500`, `text-red-600`, `bg-slate-100`, …).
  Existe porque no la borramos para no romperle el build a nadie, pero **no se usa**.
  Si te falta un color, es que falta un token: pedilo.
- Gradiente violeta→azul de fondo. Glassmorphism decorativo. Partículas.
- Emojis como iconografía. Los íconos son de `lucide-react`, con `strokeWidth` entre 1.7 y 2.

---

## 3. Jerarquía: grave contra menor

Esta es la regla que más importa del sistema. Un hallazgo grave y uno menor **no pueden
verse iguales**.

`visualFor({ severity, confidence, status })` devuelve `{ tone, emphasis }` y es la
**única** traducción de dominio a color. No inventes la tuya.

```ts
import { visualFor } from '@/components/ui'

const { tone, emphasis } = visualFor({ severity: 'critical', confidence: 'confirmed' })
// → { tone: 'expuesto', emphasis: 'stamp' }
```

Reglas, en orden:

1. Resuelto → `verificado`, callado.
2. Descartado → `neutral`, callado.
3. **Confianza baja → `revisar` (azul), sin importar la gravedad.** Si no estamos seguros,
   no gritamos. Es la regla de "ninguna afirmación sin evidencia" hecha color.
4. `critical` / `high` → `expuesto`.
5. `medium` → `incompleto`.
6. `low` → `neutral`. **Un hallazgo menor no lleva color.**

Y el peso (`emphasis`) se traduce a `<Card>`:

| emphasis | Cómo se ve | Cuándo |
|---|---|---|
| `stamp` | Fondo teñido + barra de 6px al margen + sombra del tono + título en serif | Solo `critical`. Como mucho 3 por pantalla |
| `marked` | Superficie normal + barra fina de 3px al margen | `high` |
| `plain` | Superficie normal, sin marca | Todo lo demás |
| `flat` | Sin borde ni sombra | Agrupar adentro de otra tarjeta |

```tsx
<Card tone="expuesto" emphasis="stamp">
  <CardHeader>
    <Badge tone="expuesto" variant="solid" size="sm">Grave</Badge>
    <CardHeadline>Cualquiera puede ver las facturas de todos</CardHeadline>
    <CardDescription>Creamos una cuenta nueva y desde ahí…</CardDescription>
  </CardHeader>
</Card>
```

### Bien / mal

```tsx
// ✅ El grave grita, el menor susurra.
<Card tone="expuesto" emphasis="stamp">…</Card>
<Card><SeverityDot tone="neutral" size="sm" /> Falta el texto alternativo…</Card>

// ❌ Todo con el mismo peso: el usuario no sabe por dónde empezar.
<Card tone="expuesto" emphasis="stamp">…</Card>
<Card tone="incompleto" emphasis="stamp">…</Card>
<Card tone="revisar" emphasis="stamp">…</Card>
```

### Accesibilidad del color

`<SeverityDot>` usa una **silueta distinta por tono**: octógono, triángulo, círculo con
tilde, anillo con punto, guion. Se distinguen en escala de grises. Nunca dependas solo
del color: al lado de un punto siempre va texto.

---

## 4. Espaciado, radios, sombras

- **Espaciado**: escala de 4px de Tailwind. Secciones con `mb-8` / `mb-12`; interior de
  tarjeta con `p-5 sm:p-6`. Respirá: entre dos bloques distintos, mínimo 32px.
- **Radios**: `rounded-xs` (6) para chips y celdas · `rounded-sm` (8) para controles ·
  `rounded-md` (10) para botones y avisos · `rounded-lg` (14) para tarjetas ·
  `rounded-xl` (20) para carcasas · `rounded-full` para píldoras.
- **Sombras** (siempre con color tibio, nunca negro puro al 10%):
  `shadow-support` (tarjeta en reposo) · `shadow-raised` (hover, menú) ·
  `shadow-float` (diálogo) · `shadow-stamp` (tarjeta `expuesto`, teñida de rojo).

### Doble bisel

`<Bezel>` envuelve algo en una carcasa exterior con un núcleo interior de radio
concéntrico, para que se lea como una pieza física.

**Reservado para el video de un hallazgo y la evidencia.** Si todo lleva bisel, deja de
significar algo.

```tsx
<Bezel>
  <video … />
</Bezel>
```

---

## 5. Movimiento

Todo sale de `src/components/ui/motion.ts`. No escribas duraciones ni curvas a mano.

```ts
import { fadeUp, listContainer, listItem, enter, exit, DUR, EASE } from '@/components/ui/motion'
```

- **Duraciones**: 90 / 150 / 220 / 340 / 520 ms. Nada arriba de 520.
- **Curvas**: `EASE.outSoft` para entrar, `EASE.inSoft` para salir (siempre más corta que
  la entrada), `EASE.glide` para paneles, `EASE.firm` para cambios de estado chicos.
- **Nada de `linear` ni `ease-in-out`.**
- Solo `transform` y `opacity`. Nunca `width`, `height`, `top`, `left`.
- `prefers-reduced-motion` está resuelto globalmente por `<MotionProvider>` y por el CSS
  base. **No lo chequees componente por componente.** La excepción es
  `[data-motion-essential]` (spinners, barra indeterminada): siguen girando, más lento,
  porque un spinner congelado le dice al usuario que la app se colgó.

**Regla de producto:** nunca animes algo decorativo al lado de un hallazgo grave. La
atención va al hallazgo.

Para una lista de hallazgos que llega de a poco mientras el análisis corre:

```tsx
<motion.ul variants={listContainer} initial="hidden" animate="show">
  {findings.map(f => <motion.li key={f.id} variants={listItem}>…</motion.li>)}
</motion.ul>
```

---

## 6. Primitivas

Importá siempre desde `@/components/ui`.

### Acción

| Componente | Notas |
|---|---|
| `Button` | `variant`: `primary` (tinta) · `secondary` · `ghost` · `danger` (rojo) · `link`. `size`: `sm` (36px, solo desktop denso) · `md` (**44px, el default y el mínimo táctil**) · `lg` (52px). `loading` + `loadingLabel` bloquea sin apagar el botón. `iconOnly` exige `aria-label`. En `primary`, `iconEnd` se anida en su propio círculo. |
| `buttonStyles()` | Para que un `<Link>` se vea igual que un botón. |
| `CopyButton` | Copia, confirma en el propio botón y lo anuncia por `aria-live`. Para el prompt de arreglo. |
| `DropdownMenu` + `DropdownItem` | Para **verbos** (renombrar, borrar). Flechas, Esc, clic afuera. `destructive` separa y tiñe. |

**Una sola acción principal por pantalla.** Va en `PageHeader action`. El resto,
`secondaryActions`.

### Datos y estado

| Componente | Notas |
|---|---|
| `Card` + `CardHeader/Title/Headline/Description/Body/Footer` | Ver §3. `CardHeadline` usa la serif. |
| `Badge` / `SeverityBadge` | `SeverityBadge` deriva tono y peso solo desde `severity`+`confidence`+`status`. Usalo en vez de armar el `Badge` a mano. |
| `SeverityDot` | Silueta por tono. `labelled` si va solo, sin texto al lado. |
| `Callout` | Aviso dentro del flujo de lectura: descargo legal, aviso de costo, "no tocamos tu base". |
| `CodeBlock` | Evidencia. `highlightLines` marca en numeración del archivo real. Sin resaltado de sintaxis a propósito: menos color = más claro dónde mirar. |
| `Progress` | Sin `value` va indeterminada. **Si no sabemos cuánto falta, no mentimos con una barra que avanza sola** — el `label` tiene que decir qué está haciendo de verdad. |
| `Avatar`, `Tabs`, `Tooltip` | `Tooltip` nunca guarda información necesaria para decidir: en el celular no hay hover. |

### Formularios

`Input`, `Textarea`, `Select` (nativo, mejor en celular), `Checkbox`, `Switch`.

Todos aplican solos: etiqueta visible (el placeholder **no** es etiqueta), ayuda
persistente debajo, error pegado al campo con `role="alert"`, 44px de alto, 16px de fuente
en pantallas chicas para que iOS no haga zoom.

```tsx
<Input
  label="Link del repositorio"
  hint="También podés subir un zip si no usás GitHub."
  error={errors.repo}
  required
/>
```

`Switch` es para preferencias que se aplican al instante. **Si la acción cuesta plata o no
se deshace, no va un switch: va un botón con `ConfirmDialog`.**

### Superposiciones

| Componente | Notas |
|---|---|
| `Dialog` | Foco atrapado, Esc, scroll bloqueado, foco devuelto al cerrar. En celular entra como sheet desde abajo. `dismissible={false}` solo cuando cerrar sin querer pierde trabajo. |
| `ConfirmDialog` | **Acá viven dos reglas duras del producto.** Ver abajo. |
| `Toaster` + `notify` | `notify.ok / problema / aviso / info / trabajando`. Para confirmar algo que **ya pasó**. |

**Los toasts no son para errores que el usuario tiene que resolver.** Eso es un
`ErrorState` o un `Callout` en la pantalla, que no se autodestruye a los 4 segundos.

### Estados sin contenido

`EmptyState`, `ErrorState`, `Skeleton`, `SkeletonCard`, `Spinner`.

`ErrorState` trae textos por defecto para `error`, `forbidden`, `not-found`, `job-failed`
y `offline`, y un `<details>` para el detalle técnico. **Toda pantalla tiene que tener
diseñados sus estados de carga, vacío, error y sin permisos.** No existe la pantalla en
blanco: es literalmente uno de los defectos que auditamos en las apps de otros.

---

## 7. Confirmar y mostrar el costo

```tsx
<ConfirmDialog
  open={open}
  onOpenChange={setOpen}
  title="¿Analizar “Tienda de Ana”?"
  consequences={[
    'Vamos a leer tu código y a navegar tu app publicada.',
    'No escribimos nada en tu base de datos.',
  ]}
  cost={{ usd: 1.85, units: '1 análisis completo · ~7 min de agente · hasta 3 videos' }}
  confirmLabel="Analizar"
  onConfirm={run}
/>
```

- **Nada irreversible sin confirmar.**
- **Si cuesta plata, se muestra cuánto — en dólares y en unidades concretas — antes de
  ejecutar.** Nunca "créditos": el usuario no sabe cuánto vale un crédito.
- Para lo que no se deshace (borrar proyecto, borrar cuenta), `requireTyping` obliga a
  escribir el nombre exacto.

---

## 8. Armazón

```tsx
import { AppShell, PageHeader, projectNav, GLOBAL_NAV, ACCOUNT_NAV } from '@/components/shell'

<AppShell
  navGroups={[GLOBAL_NAV, projectNav(projectId, hallazgosAbiertos), ACCOUNT_NAV]}
  currentProjectId={projectId}
  projects={projects}
  user={user}
>
  <PageHeader
    crumbs={[{ label: 'Proyectos', href: '/proyectos' }, { label: proyecto.name }]}
    title="Hallazgos"
    description="Tres cosas para arreglar hoy. El resto puede esperar."
    action={<Button>Volver a analizar</Button>}
  />
  …
</AppShell>
```

**Un patrón de navegación por tamaño de pantalla:**

- **≥1024px** — barra lateral fija, cada ítem con ícono **y** texto. El activo lleva una
  barra de tinta al margen.
- **<1024px** — barra inferior, hasta 5 destinos, siempre con texto, con margen para el
  área segura del iPhone. **No hay hamburguesa**: no escondemos lo que ya está abajo.

`AppShell` incluye el link "Saltar al contenido" y el `<main id="contenido">`.

`PageHeader` acepta `display` para que el título vaya en serif — usalo en la pantalla de
un hallazgo, no en las de listado.

Probá siempre a **375 / 768 / 1280**. Nada de scroll horizontal en la página; si una
tabla o un bloque de código no entra, que scrollee **adentro de su propio contenedor**
(`overflow-x-auto`).

---

## 9. Escritura

Cero jerga en texto visible. La regla no es simplificar: es traducir.

| No | Sí |
|---|---|
| RLS mal configurada | Cualquiera puede ver las facturas de todos tus clientes |
| Hardcoded API key | Tu clave de Stripe está en el código que llega al navegador |
| Falta el flujo de password reset | No se puede recuperar la contraseña |
| Error 500 | Algo se rompió de nuestro lado |

- Español rioplatense (*podés*, *tenés*, *pegá*). Vos, nunca tú.
- El usuario **no es tonto, es no técnico**. No lo trates con guantes ni le expliques de más.
- Cada error dice **qué pasó y cómo salir**. "Entrada inválida" no es un mensaje.
- Nunca dictaminamos sobre legalidad: *"esto es lo que un revisor de App Store o un
  regulador podría marcar"*, jamás *"viola el GDPR artículo X"*.
- Para copy de cara al usuario usá las skills `ux-writing` / `copywriting` / `copy-editing`.
  No transcribas instrucciones informales: entendé la intención y reescribí.

---

## 10. Antes de dar por hecha una pantalla

- [ ] Hay **una** cosa más importante y se nota sin leer.
- [ ] El hallazgo grave y el menor no se ven iguales.
- [ ] Cero hex sueltos, cero colores de la paleta default de Tailwind.
- [ ] Todos los estados diseñados: carga, vacío, error, sin permisos, sin conexión.
- [ ] Cada hallazgo termina en una acción, no en un diagnóstico.
- [ ] Nada irreversible sin confirmar; si cuesta plata, se ve cuánto antes.
- [ ] Probado a 375 / 768 / 1280, sin scroll horizontal.
- [ ] Todo alcanzable con el teclado; el foco se ve siempre.
- [ ] Todo control táctil ≥44px.
- [ ] Contraste: texto normal ≥4.5:1, bordes de control ≥3:1. Probado en claro **y** en oscuro.
- [ ] Cero jerga en pantalla.

> Auditamos apps de otros por flujos faltantes, estados sin diseñar, acciones destructivas
> sin confirmar y placeholders olvidados. **La nuestra no puede fallar en eso.**
