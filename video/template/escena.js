/* ============================================================================
   Reloj de la escena.

   Lo usa: la página que arma `src/server/video/render/page.ts` y que graba
   `src/server/video/render/web.ts` con Playwright.

   Cómo se sincroniza con la voz, que es lo único que importa acá:
   la pista de audio se arma aparte, con cada frase ubicada en un offset
   conocido (ver `audio.ts`). Esta línea de tiempo usa **los mismos offsets**.
   No hay negociación entre audio y video en tiempo de render: los dos leen la
   misma tabla de números, calculada una sola vez en `timing.ts`.

   Protocolo con Playwright:
     1. la página avisa `window.__ccListo = true` cuando el video de la
        grabación ya está posicionado y no va a trabarse a mitad del clip;
     2. Playwright llama `window.__ccArrancar()`;
     3. Playwright espera `__GUION__.totalMs` y cierra.
   ========================================================================== */

(function () {
  'use strict'

  var G = window.__GUION__ || { totalMs: 0, escenas: [], cues: [] }

  var escenas = Array.prototype.slice.call(document.querySelectorAll('.escena'))
  var capa = document.querySelector('.capaGrabacion')
  var encuadre = document.querySelector('.encuadre')
  var moviola = document.querySelector('.moviola')
  var marca = document.querySelector('.marca')
  var video = document.getElementById('grabacion')
  var subtitulo = document.getElementById('subtitulo')
  var barra = document.getElementById('progresoBarra')

  var t0 = 0
  var corriendo = false
  var indiceEscena = -1
  var indiceCue = -1
  var zoomHecho = false
  var marcaHecha = false

  /** Espera antes de acercar: primero se ve el conjunto, después el detalle. */
  var ESPERA_MARCA_MS = 850
  var ESPERA_ZOOM_MS = 1250
  var ZOOM_MAXIMO = 3.2

  /** Máximo que puede ocupar el cuadro dentro del escenario. */
  var CUADRO_MAX_ANCHO = 1136
  var CUADRO_MAX_ALTO = 496

  /**
   * Achica el cuadro a la proporción del video.
   * Sin esto, una grabación de 1280x800 dentro de un marco 1136x496 deja dos
   * franjas muertas a los costados y el borde y la sombra abrazan al vacío en
   * vez de a la evidencia.
   */
  function ajustarCuadroAlVideo() {
    if (!video || !encuadre || !video.videoWidth || !video.videoHeight) return
    var escala = Math.min(
      CUADRO_MAX_ANCHO / video.videoWidth,
      CUADRO_MAX_ALTO / video.videoHeight,
    )
    encuadre.style.width = Math.round(video.videoWidth * escala) + 'px'
    encuadre.style.height = Math.round(video.videoHeight * escala) + 'px'
  }

  /* ── Encuadre de la grabación ───────────────────────────────────────── */

  /**
   * Traduce un rectángulo en píxeles del video a una transformación del
   * encuadre. Hay que rehacer a mano lo que hace `object-fit: contain` porque
   * el video casi nunca tiene la misma proporción que el marco.
   */
  function calcularZoom(rect) {
    if (!video || !video.videoWidth || !video.videoHeight) return null
    var cajaW = encuadre.clientWidth
    var cajaH = encuadre.clientHeight
    var ajuste = Math.min(cajaW / video.videoWidth, cajaH / video.videoHeight)
    var dibW = video.videoWidth * ajuste
    var dibH = video.videoHeight * ajuste
    var margenX = (cajaW - dibW) / 2
    var margenY = (cajaH - dibH) / 2

    var x = margenX + rect.x * ajuste
    var y = margenY + rect.y * ajuste
    var w = Math.max(8, rect.width * ajuste)
    var h = Math.max(8, rect.height * ajuste)

    var z = Math.min(cajaW / w, cajaH / h, ZOOM_MAXIMO)
    // Un acercamiento menor a 1.15x no se percibe: mejor no moverse.
    if (z < 1.15) z = 1
    var cx = x + w / 2
    var cy = y + h / 2
    return {
      z: z,
      tx: cajaW / 2 - cx * z,
      ty: cajaH / 2 - cy * z,
      x: x,
      y: y,
      w: w,
      h: h,
    }
  }

  function ubicarMarca(calculo) {
    if (!marca || !calculo) return
    marca.style.left = calculo.x + 'px'
    marca.style.top = calculo.y + 'px'
    marca.style.width = calculo.w + 'px'
    marca.style.height = calculo.h + 'px'
    marca.style.borderWidth = 2 / calculo.z + 'px'
    marca.setAttribute('data-visible', '1')
  }

  function aplicarZoom(calculo) {
    if (!moviola || !calculo) return
    moviola.style.transform =
      'translate(' + calculo.tx + 'px, ' + calculo.ty + 'px) scale(' + calculo.z + ')'
    if (marca) marca.style.borderWidth = 2 / calculo.z + 'px'
  }

  function resetearEncuadre() {
    if (moviola) moviola.style.transform = 'none'
    if (marca) marca.setAttribute('data-visible', '0')
  }

  /* ── Escenas ─────────────────────────────────────────────────────────── */

  function activarEscena(i) {
    if (i === indiceEscena) return
    indiceEscena = i
    zoomHecho = false
    marcaHecha = false

    for (var k = 0; k < escenas.length; k++) {
      escenas[k].setAttribute('data-activa', k === i ? '1' : '0')
    }

    var def = G.escenas[i]
    if (!def) return

    if (def.tipo === 'recording' && video) {
      if (capa) capa.setAttribute('data-activa', '1')
      resetearEncuadre()
      var objetivo = (def.recording && def.recording.startMs) || 0
      // Si el tramo continúa donde venía, no se busca de nuevo: un seek a mitad
      // del clip congela el cuadro y se nota.
      if (Math.abs(video.currentTime * 1000 - objetivo) > 250) {
        try {
          video.currentTime = objetivo / 1000
        } catch (e) {
          /* algunos contenedores no permiten buscar; se sigue desde donde esté */
        }
      }
      var promesa = video.play()
      if (promesa && promesa.catch) promesa.catch(function () {})
    } else {
      if (capa) capa.setAttribute('data-activa', '0')
      if (video && !video.paused) video.pause()
    }
  }

  function animarEncuadre(def, transcurridoEnEscena) {
    if (!def || def.tipo !== 'recording' || !def.recording || !def.recording.zoom) return
    if (!marcaHecha && transcurridoEnEscena >= ESPERA_MARCA_MS) {
      marcaHecha = true
      ubicarMarca(calcularZoom(def.recording.zoom))
    }
    if (!zoomHecho && transcurridoEnEscena >= ESPERA_ZOOM_MS) {
      zoomHecho = true
      aplicarZoom(calcularZoom(def.recording.zoom))
    }
  }

  /* ── Subtítulos ──────────────────────────────────────────────────────── */

  function pintarCue(t) {
    var encontrado = -1
    for (var i = 0; i < G.cues.length; i++) {
      if (t >= G.cues[i].startMs && t < G.cues[i].endMs) {
        encontrado = i
        break
      }
    }
    if (encontrado === indiceCue) return
    indiceCue = encontrado
    if (!subtitulo) return
    if (encontrado < 0) {
      subtitulo.setAttribute('data-visible', '0')
    } else {
      subtitulo.textContent = G.cues[encontrado].text
      subtitulo.setAttribute('data-visible', '1')
    }
  }

  /* ── Bucle ───────────────────────────────────────────────────────────── */

  function cuadro() {
    if (!corriendo) return
    var t = performance.now() - t0

    var i = 0
    for (var k = 0; k < G.escenas.length; k++) {
      if (t >= G.escenas[k].startMs) i = k
    }
    activarEscena(i)
    animarEncuadre(G.escenas[i], t - G.escenas[i].startMs)
    pintarCue(t)

    if (barra && G.totalMs > 0) {
      barra.style.transform = 'scaleX(' + Math.min(1, t / G.totalMs) + ')'
    }

    if (t >= G.totalMs) {
      corriendo = false
      window.__ccTerminado = true
      if (video && !video.paused) video.pause()
      return
    }
    requestAnimationFrame(cuadro)
  }

  /* ── Preparación ─────────────────────────────────────────────────────── */

  function primerTramoGrabado() {
    for (var i = 0; i < G.escenas.length; i++) {
      if (G.escenas[i].tipo === 'recording' && G.escenas[i].recording) {
        return G.escenas[i].recording.startMs || 0
      }
    }
    return null
  }

  function esperarEvento(elemento, nombre, msMaximo) {
    return new Promise(function (resolver) {
      var listo = false
      function terminar() {
        if (listo) return
        listo = true
        elemento.removeEventListener(nombre, terminar)
        resolver()
      }
      elemento.addEventListener(nombre, terminar)
      setTimeout(terminar, msMaximo)
    })
  }

  /**
   * No avisamos "listo" hasta que el video esté posicionado en el primer cuadro
   * que se va a mostrar. Si se dejara para el arranque, el primer segundo del
   * clip serían fotogramas negros mientras el navegador busca.
   */
  function preparar() {
    var pasos = []

    if (document.fonts && document.fonts.ready) pasos.push(document.fonts.ready)

    if (video) {
      pasos.push(
        (video.readyState >= 1
          ? Promise.resolve()
          : esperarEvento(video, 'loadedmetadata', 15000)
        ).then(function () {
          ajustarCuadroAlVideo()
          var inicio = primerTramoGrabado()
          if (inicio === null) return null
          try {
            video.currentTime = inicio / 1000
          } catch (e) {
            return null
          }
          return esperarEvento(video, 'seeked', 8000)
        }),
      )
    }

    return Promise.all(pasos)
  }

  window.__ccArrancar = function () {
    if (corriendo) return
    t0 = performance.now()
    corriendo = true
    // Se pinta el primer cuadro ya mismo para que no haya un salto al inicio.
    activarEscena(0)
    requestAnimationFrame(cuadro)
  }

  window.__ccEstado = function () {
    return {
      listo: window.__ccListo === true,
      corriendo: corriendo,
      terminado: window.__ccTerminado === true,
      escena: indiceEscena,
      videoAncho: video ? video.videoWidth : 0,
      videoAlto: video ? video.videoHeight : 0,
      videoDuracion: video ? video.duration : 0,
    }
  }

  preparar().then(
    function () {
      window.__ccListo = true
    },
    function () {
      // Si algo falla en la preparación igual arrancamos: mejor un clip con el
      // primer segundo flojo que un job caído.
      window.__ccListo = true
    },
  )
})()
