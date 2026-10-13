---
name: scroll-storytelling
description: Diseño y revisión de presentaciones scrollytelling: coreografía de scroll, gráficos fijados, revelados por pasos, foco de diagramas sin scrim, accesibilidad de data-viz, rendimiento y degradación segura. Úsala para decks Slalom claros con diagramas SVG activados por el avance del scroll.
---

# Scroll Storytelling

## Initial Response

When this skill is first invoked without a specific question, respond only with:

> Estoy listo para ayudarte a construir una narrativa scrollytelling clara, accesible y fluida para la web.

Do not provide any other information until the user asks a question.

Cómo convertir el scroll en una secuencia narrativa: cada sección introduce una idea, activa un paso del diagrama y deja al usuario orientado sobre dónde está y qué acaba de cambiar.

Esta skill complementa `apple-design`: aquí el tema es la **coreografía editorial del scroll y la comprensión de diagramas**, no la física de gestos, los springs, la interruptibilidad, los materiales ni la tipografía óptica.

## La idea central

> El scroll debe revelar una historia, no convertirse en una prueba de habilidad.

Un buen scrollytelling mantiene estable el mapa mental mientras cambia el foco. El texto avanza por una columna legible; el gráfico permanece visible el tiempo suficiente para que el usuario conecte cada afirmación con un grupo, camino o estado del diagrama. Cada paso debe funcionar como explicación completa por sí mismo y como parte de una secuencia mayor.

Para un deck Slalom: prioriza fondo claro, navy como estructura y acentos medidos; usa Poppins/Inter según la jerarquía ya definida por el producto. El movimiento debe reforzar el argumento, no competir con el contenido.

## 1. Coreografía: texto que avanza, gráfico que permanece

El patrón base es una composición de dos columnas dentro de una sección alta:

- **Columna de texto:** varios bloques cortos (`step` o `prose`) que entran y salen del viewport. Cada uno tiene una sola idea y un estado explícito.
- **Gráfico fijado:** un `sticky`/pinned graphic que ocupa la ventana durante la secuencia y cambia de estado cuando el paso activo cambia.
- **Estado compartido:** un índice de paso, no una colección de animaciones independientes. El texto, el gráfico, la leyenda y el anuncio accesible deben responder al mismo estado.

```css
.story {
  display: grid;
  grid-template-columns: minmax(16rem, 0.8fr) minmax(0, 1.2fr);
  gap: clamp(2rem, 8vw, 8rem);
}

.story__graphic {
  position: sticky;
  top: 10vh;
  align-self: start;
  min-height: 70vh;
}

.story__step {
  min-height: 70vh;
  display: grid;
  align-content: center;
}

@media (max-width: 48rem) {
  .story { display: block; }
  .story__graphic { position: relative; top: auto; min-height: 45vh; }
  .story__step { min-height: auto; padding-block: 3rem; }
}
```

Reglas prácticas:

- Reserva altura suficiente para que el gráfico pueda fijarse y para que cada paso tenga un momento de lectura. No fabriques una secuencia larga con párrafos de una línea.
- Mantén el gráfico en el mismo marco, escala y orientación siempre que sea posible. Mover la cámara debe tener una causa narrativa clara.
- Cambia un estado por vez: primero entra el paso, luego se destaca el grupo, la conexión o la capa relevante. Evita que todos los nodos se animen a la vez.
- El paso activo debe ser determinista y reversible. Al desplazarse hacia atrás, la historia debe poder reconstruirse sin estados huérfanos.

### Revelados y stagger

Usa un revelado de entrada sobrio para título, explicación y detalle visual: `opacity` más una pequeña traslación en `transform`. El stagger comunica orden, no decoración: primero el contexto, después el elemento principal y por último los detalles secundarios. Mantén pocos niveles y una ventana corta; un stagger largo hace que la información llegue tarde.

El estado inactivo debe seguir siendo legible. Atenuar un elemento es una pista de jerarquía, no una forma de ocultar contenido.

```css
.story__step {
  opacity: 0.48;
  transform: translateY(1rem);
  transition: opacity 240ms ease, transform 320ms ease;
}

.story__step[data-active="true"] {
  opacity: 1;
  transform: translateY(0);
}

.story__detail {
  transition-delay: calc(var(--order, 0) * 60ms);
}
```

### Scroll-linked frente a scroll-triggered

- **Scroll-linked:** el valor visual sigue el progreso del scroll 1:1. Úsalo para una relación que el usuario deba controlar directamente: una barra de progreso, un recorrido continuo de cámara o una conexión que se dibuja proporcionalmente a una posición conocida.
- **Scroll-triggered:** al entrar un paso en el viewport se dispara un cambio de estado que termina de forma independiente. Úsalo para revelar una capa, activar un nodo o presentar una tarjeta.

Para la mayoría de los pasos narrativos, prefiere **scroll-triggered + spring**: separa el ritmo editorial de cada variación mínima de la rueda o del trackpad, se siente más estable, permite leer durante el asentamiento y evita que el gráfico tiemble cuando el usuario hace scroll lentamente o cambia de dirección. El spring debe comenzar desde el estado visible actual, siguiendo las reglas de `apple-design`; esta skill decide *cuándo* cambiar de estado, no redefine su física.

Elige scroll-linked solo cuando perder la correspondencia 1:1 rompería la explicación. No conviertas todo el deck en un scrubber: el usuario debe poder avanzar y retroceder sin pelear con el scroll nativo.

### Detectar pasos sin castigar el rendimiento

`IntersectionObserver` es el mecanismo preferente para activar pasos: el navegador calcula la visibilidad fuera del camino caliente y el callback solo actualiza el índice de narrativa. Usa un umbral o un `rootMargin` que represente el momento de lectura, no necesariamente el primer píxel visible.

```js
const observer = new IntersectionObserver(
  (entries) => {
    const visible = entries
      .filter((entry) => entry.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];

    if (visible) setActiveStep(visible.target.dataset.step);
  },
  { rootMargin: '-35% 0px -45% 0px', threshold: [0, 0.25, 0.6] }
);

document.querySelectorAll('[data-step]').forEach((step) => observer.observe(step));
```

No uses un listener de `scroll` para consultar geometría y mutar estilos en cada evento. Si una interacción necesita progreso continuo, registra como máximo el último valor y procesa el trabajo visual en un único `requestAnimationFrame`; cancela el frame pendiente cuando la vista deja de necesitarlo. Desconecta observers al desmontar la sección.

### Scroll snapping con criterio

`scroll-snap-type` puede ayudar en una secuencia corta y deliberada, especialmente en una vista móvil que funciona como carrusel vertical. No lo impongas en todo el documento ni en un deck con pasos de distinta altura: el snap inesperado roba control, complica teclado y puede hacer que el lector salte contenido.

```css
.story-scroll {
  scroll-snap-type: y proximity;
}
.story-step {
  scroll-snap-align: start;
  scroll-margin-block-start: 10vh;
}
```

Usa `proximity` como opción segura; considera `mandatory` solo cuando cada panel sea una pantalla autocontenida, el avance sea intencional y hayas probado trackpad, teclado, lector de pantalla y touch.

## 2. La cámara: orientar la atención dentro de un diagrama grande

Un diagrama grande puede tener una “cámara” conceptual que cambia el foco mientras la estructura permanece reconocible. Antes de moverla, define para cada paso:

1. el grupo o conexión que explica;
2. su bounding box normalizada (`x`, `y`, `width`, `height`);
3. el encuadre de destino con margen de contexto;
4. qué queda estable para que el usuario no pierda orientación.

Prefiere transformar un wrapper del diagrama (`translate` y `scale`) en vez de recalcular posiciones de cada nodo. Limita el zoom y conserva un ancla compartida —por ejemplo, el origen del flujo o la línea principal—. La cámara no debe oscilar entre dos cajas cercanas por pequeñas variaciones del observer; usa un umbral, un estado activo único y una transición que parte del encuadre actual.

En móvil, reduce la ambición: el gráfico puede cambiar de escala o mostrar un recorte preparado, pero no debe quedar tan ampliado que desaparezcan las etiquetas necesarias. Si el foco requiere una navegación que el usuario no puede deshacer, ofrece una vista general persistente o un botón “ver todo”.

## 3. Enfocar sin scrim oscuro

No uses un spotlight con scrim oscuro para forzar atención sobre una parte del diagrama. Es preferible conservar el fondo claro y comunicar jerarquía mediante estructura visual. Elige una técnica según el tipo de relación que se esté explicando:

| Técnica | Ventajas | Costes / riesgos | Encaja cuando |
| --- | --- | --- | --- |
| Desaturar y atenuar el resto | Conserva el mapa completo; el grupo activo destaca sin bloquear contexto | Puede reducir contraste o hacer que un estado inactivo parezca deshabilitado | El lector necesita comparar activo y contexto |
| Trazar el camino activo | Explica causalidad y dirección; funciona bien en flujos | Requiere rutas claras, control de `stroke-dashoffset` y una alternativa no animada | La historia es un recorrido entre nodos |
| Zoom y pan de cámara | Da detalle a un grupo grande sin agregar overlays | Puede causar desorientación; exige bbox estable y límites | El diagrama tiene subzonas densas y una jerarquía espacial fuerte |
| Construcción progresiva por capas | Hace visible la secuencia de dependencia; reduce ruido inicial | Si se ocultan demasiadas capas, se pierde el modelo completo | La explicación va de infraestructura base a servicios y resultado |

Para desaturar, modifica el tratamiento visual del grupo inactivo con `opacity`, `filter: saturate()` o una variable de color, pero no lo hagas invisible si sigue siendo parte del argumento. Para el camino activo, prepara la ruta completa y revela su trazo sin depender de un cálculo por frame:

```css
.connection {
  stroke-dasharray: var(--path-length);
  stroke-dashoffset: var(--path-length);
}
.connection[data-active="true"] {
  stroke-dashoffset: 0;
  transition: stroke-dashoffset 480ms ease;
}
```

La construcción por capas debe tener una leyenda o texto que diga qué apareció. No confíes en “se ve más brillante” como única explicación: el orden visual debe coincidir con el orden verbal.

## 4. Accesibilidad de data-viz y diagramas

Un diagrama es contenido, no decoración. Diseña una ruta equivalente para quien no perciba el gráfico, no use movimiento o no ejecute JavaScript.

- **No dependas solo del color.** Combina color con etiqueta, forma, posición, grosor, patrón o estado textual. Verifica contraste de texto, líneas y controles; una conexión fina necesita más que un tono apenas distinto.
- **Ofrece un equivalente textual.** Incluye una lista, tabla o sidebar con los nodos y relaciones en el mismo orden narrativo. Puede ser visualmente compacto, pero debe estar disponible sin abrir un modal.
- **Anuncia cambios relevantes.** Cuando cambia el paso activo, actualiza una región `aria-live="polite"` con una frase breve y específica. No anuncies cada frame de una cámara ni repitas todo el diagrama.
- **Gestiona el foco con moderación.** El scroll no debe robar foco. Si el usuario activa un paso con teclado, el control recibe foco y el contenido asociado se identifica con `aria-describedby` o una región enfocada solo cuando sea necesario. Mantén una ruta clara con Tab.
- **Usa semántica real.** Los pasos son contenido agrupado (`section`, encabezado y texto); el SVG o la imagen tiene un nombre accesible y el equivalente no queda escondido tras `display: none` si debe servir como alternativa.
- **Prueba alto contraste, zoom, teclado, lector de pantalla y touch.** Revisa también que las etiquetas no queden debajo de la cámara o fuera del viewport.

```html
<section aria-labelledby="step-title-2" data-step="2">
  <h2 id="step-title-2">El evento llega al servicio</h2>
  <p>El mensaje activa la función y actualiza el estado del dispositivo.</p>
</section>
<p class="sr-only" aria-live="polite" data-step-announcement>
  Paso 2 de 3: el evento llega al servicio.
</p>
```

### Reduced motion para scrollytelling

Con `prefers-reduced-motion: reduce`, cambia el modelo, no solo la duración:

- desactiva `sticky` ornamental, parallax, zoom/pan automático y cualquier movimiento atado 1:1 al scroll;
- revela el diagrama completo y todas sus capas en una composición estática legible;
- conserva un único estado activo textual o un cambio discreto de color/contraste si ayuda a comprender;
- no uses `stroke-dashoffset`, desplazamientos grandes ni springs para comunicar información;
- permite que cada paso siga siendo alcanzable mediante lectura normal y teclado.

```css
@media (prefers-reduced-motion: reduce) {
  .story__graphic {
    position: static;
  }

  .story__step,
  .connection,
  .diagram-camera {
    opacity: 1;
    transform: none;
    transition: none;
    animation: none;
  }

  .diagram-layer,
  .diagram-node {
    visibility: visible;
  }
}
```

## 5. Degradación segura: la historia funciona sin magia

El contenido debe ser comprensible aunque falle el JavaScript, el observer, la animación o la carga de un asset. El HTML base debe contener encabezados, explicación y orden de pasos; el gráfico puede ser una imagen estática o un fallback textual. JavaScript añade estados activos, no inventa la narrativa.

- Renderiza todos los pasos en el flujo normal del documento antes de activar el modo interactivo.
- No uses `visibility: hidden`, `display: none` ni `aria-hidden="true"` como estado inicial para contenido que solo aparecerá tras un callback.
- Si el gráfico no carga, conserva el título, la descripción y la lista de relaciones; muestra un mensaje de fallback accionable si aporta valor.
- Permite saltar la secuencia y llegar al siguiente bloque del deck. Nunca bloquees el scroll esperando una animación.
- Evita que `position: sticky` sea un requisito semántico: es una mejora visual que puede desaparecer en una viewport estrecha o en reduced motion.

## 6. Rendimiento sin bloquear el scroll

El scroll es una interacción del navegador. Trátalo como una prioridad de respuesta:

- Anima solo `transform` y `opacity` siempre que sea posible; evita animar `top`, `left`, `width`, `height`, filtros costosos o propiedades que provoquen layout repetido.
- Usa `IntersectionObserver` para transiciones por pasos. Para progreso continuo, agrupa lecturas y escrituras en `requestAnimationFrame`; no hagas `getBoundingClientRect()` y cambios de estilo indiscriminadamente en cada evento.
- Aplica `will-change: transform` solo a un elemento que vaya a moverse y durante el intervalo útil. No lo pongas en cada nodo del SVG: aumenta memoria y puede empeorar la composición.
- Mantén los SVG razonables: elimina metadatos y geometría redundante durante el proceso de diseño, sin perder etiquetas o estructura accesible. Divide una ilustración enorme si solo una parte necesita cambiar.
- Usa `content-visibility: auto` con criterio para secciones lejanas, comprobando que no perjudique el cálculo de la narrativa ni la accesibilidad.
- No cargues fuentes, imágenes, trackers ni librerías externas para hacer funcionar el efecto. Reserva trabajo para cuando el gráfico esté cerca del viewport.
- No bloquees el scroll nativo con `preventDefault`, wheel hijacking, contenedores que capturen toda la rueda ni navegación automática agresiva.

Una métrica útil no es “cuántas animaciones hay”, sino cuánto trabajo ocurre durante un gesto normal. Prueba scroll rápido, scroll lento, reversa, trackpad y un dispositivo móvil de gama media.

## 7. Nota aplicada a esta plataforma

Este proyecto usa una CSP con `img-src 'self' data:` y `font-src 'self'`. Los diagramas SVG deben servirse como **asset URLs locales** (`self`), no como SVG inline generado en el componente y no desde dominios externos. Si una capa interna necesita cambiar de estado, usa assets locales preparados, overlays DOM accesibles o estados que el propio componente pueda representar sin introducir un recurso remoto; no relajes la CSP para facilitar la animación.

Las fuentes Poppins/Inter se incorporan mediante los paquetes `@fontsource` ya aprobados por la aplicación y se sirven desde el mismo origen. La skill no debe añadir fuentes, CDN, scripts, iconos ni dependencias externas. Antes de dar por terminado un deck, verifica que el navegador no reporte violaciones CSP y que el fallback siga siendo legible si un SVG no carga.

## 8. Proceso de diseño y revisión

1. Escribe la tesis de cada diagrama en una frase y divide la explicación en pasos observables.
2. Dibuja primero el estado estático completo: mapa general, leyenda, labels y equivalente textual.
3. Define el estado de cada paso y la bbox de cámara antes de elegir transiciones.
4. Implementa primero el flujo HTML accesible; añade `sticky`, observer y revelados como mejora progresiva.
5. Decide explícitamente qué es scroll-linked y qué es scroll-triggered; por defecto, usa trigger para estados narrativos.
6. Revisa sin scrim: prueba atenuación, conexiones, cámara y capas; conserva siempre contexto suficiente.
7. Prueba `prefers-reduced-motion`, JavaScript deshabilitado, SVG ausente, zoom del navegador, teclado y lector de pantalla.
8. Mide con DevTools durante scroll real y elimina listeners, layouts y capas que no aporten comprensión.

## Quick Reference

| Necesidad | Técnica | Regla concreta |
| --- | --- | --- |
| Patrón narrativo | Texto + gráfico `sticky` | Un índice de paso controla texto, gráfico, leyenda y anuncio |
| Activar un paso | `IntersectionObserver` | Observa la zona de lectura; no hagas polling con `scroll` |
| Elegir vínculo con scroll | Linked o triggered | Trigger + spring para estados; linked solo para progreso que deba ser 1:1 |
| Revelado | `opacity` + `transform` | Stagger corto: contexto, principal, detalle |
| Cámara del diagrama | Bbox normalizada | Conserva un ancla y margen de contexto; evita oscilaciones |
| Enfocar sin scrim | Atenuar, trazar, cámara o capas | Escoge según comparación, causalidad, detalle o dependencia |
| Camino activo | `stroke-dashoffset` | Proporciona ruta estática y explicación textual |
| Snap | `scroll-snap-type: y proximity` | Úsalo en secuencias cortas; no secuestres el documento |
| Data-viz accesible | Color + forma + texto | Nunca dependas solo del color o del movimiento |
| Paso activo | `aria-live="polite"` | Anuncia una frase; no cada frame ni todo el gráfico |
| Reduced motion | Estado estático | Desactiva pin/parallax; muestra todas las capas y elimina movimiento |
| Fallback | HTML primero | La narrativa debe leerse sin JavaScript ni scroll-magic |
| Rendimiento | `transform` + `opacity` | IO para triggers, `requestAnimationFrame` para progreso continuo |
| `will-change` | Aplicación puntual | Solo durante movimiento inminente, nunca en todo el SVG |
| Plataforma | Assets y fuentes locales | SVG por asset URL; `@fontsource`; ningún recurso externo |

## Atribución

Parte del enfoque conceptual sobre coreografía de scroll y data-viz se inspiró en el proyecto open-source **`ui-ux-pro-max-skill`**, de **Next Level Builder**, bajo licencia MIT. Esta skill fue redactada de forma independiente y no copia su contenido ni su código.
