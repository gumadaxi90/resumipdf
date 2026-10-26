pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const $ = (id) => document.getElementById(id);
const entrada = $("archivo");
const zona = $("zona");

const LIMITE_MB = 20; // tamaño máximo del PDF
const LIMITE_PAGINAS = 80; // páginas máximas
const LARGOS = { corto: 4, medio: 8, detallado: 14 }; // frases por tamaño de resumen

// Todo queda solo en la memoria de esta pestaña. No se guarda ni se envía a ningún lado.
let datos = null; // { nombre, frases, frec }
let resumenActual = "";
let sesion = 0; // sirve para ignorar lecturas canceladas
let tarea = null; // lectura de PDF en curso

// Palabras comunes que no cuentan como conceptos
const IGNORAR = new Set(
  "para como pero este esta esto estos estas entre sobre desde hasta cuando donde porque también todo todos cada otro otra otros otras puede pueden tiene tienen será serán fue fueron son está están más menos muy sin con por que los las del una uno unos unas sus nos les ser han hay así aquí ante bajo contra según tras durante mediante cual cuales además mismo misma forma parte partir".split(" ")
);

/* ---------- Pantallas y mensajes ---------- */

function vista(mostrarZona, mostrarInfo, mostrarProgreso, mostrarOtro) {
  $("zona").hidden = !mostrarZona;
  $("archivo-info").hidden = !mostrarInfo;
  $("progreso").hidden = !mostrarProgreso;
  $("btn-otro").hidden = !mostrarOtro;
}

function mensaje(titulo, texto) {
  $("msg-titulo").textContent = titulo;
  $("msg-texto").textContent = texto;
  $("mensaje").hidden = false;
}

function destruirTarea() {
  if (tarea) {
    tarea.destroy();
    tarea = null;
  }
}

function reiniciar() {
  sesion++; // cancela cualquier lectura en curso
  destruirTarea();
  datos = null;
  resumenActual = "";
  $("resultado").hidden = true;
  $("mensaje").hidden = true;
  vista(true, false, false, false);
}

function fallar(titulo, texto) {
  destruirTarea();
  $("resultado").hidden = true;
  vista(true, false, false, false);
  mensaje(titulo, texto);
}

function tamanoLegible(bytes) {
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1).replace(".", ",") + " MB";
}

/* ---------- Elegir o soltar el archivo ---------- */

$("btn-subir").addEventListener("click", () => entrada.click());

entrada.addEventListener("change", () => {
  const archivo = entrada.files[0];
  entrada.value = ""; // permite elegir el mismo archivo otra vez
  if (archivo) procesar(archivo);
});

["dragenter", "dragover"].forEach((ev) =>
  zona.addEventListener(ev, (e) => {
    e.preventDefault();
    zona.classList.add("arrastrando");
  })
);
["dragleave", "drop"].forEach((ev) =>
  zona.addEventListener(ev, (e) => {
    e.preventDefault();
    zona.classList.remove("arrastrando");
  })
);
zona.addEventListener("drop", (e) => {
  const archivo = e.dataTransfer.files[0];
  if (archivo) procesar(archivo);
});
// Evita que el navegador abra el PDF si se suelta fuera de la zona
["dragover", "drop"].forEach((ev) => window.addEventListener(ev, (e) => e.preventDefault()));

$("btn-otro").addEventListener("click", () => {
  reiniciar();
  entrada.click();
});

$("btn-cancelar-2").addEventListener("click", () => {
  reiniciar();
  mensaje("Cancelaste la lectura", "No pasa nada. Podés elegir otro PDF cuando quieras.");
});

/* ---------- Lectura y validación del PDF ---------- */

async function procesar(archivo) {
  const mi = ++sesion;
  const vigente = () => mi === sesion;

  destruirTarea();
  $("mensaje").hidden = true;
  $("resultado").hidden = true;
  datos = null;

  if (archivo.type !== "application/pdf" && !/\.pdf$/i.test(archivo.name)) {
    return fallar("Ese archivo no es un PDF", "Elegí un archivo con extensión .pdf.");
  }
  if (archivo.size === 0) {
    return fallar("El archivo está vacío", "Probá con otro PDF.");
  }
  if (archivo.size > LIMITE_MB * 1024 * 1024) {
    return fallar(
      "Tu PDF es muy pesado",
      "Pesa " + tamanoLegible(archivo.size) + " y el límite es de " + LIMITE_MB + " MB. Probá con uno más liviano o dividilo en partes."
    );
  }

  vista(false, false, true, false);
  $("barra").value = 0;
  $("progreso-texto").textContent = "Abriendo tu PDF…";

  try {
    const buffer = await archivo.arrayBuffer();
    if (!vigente()) return;

    const cabecera = new TextDecoder("latin1").decode(new Uint8Array(buffer, 0, Math.min(1024, buffer.byteLength)));
    if (!cabecera.includes("%PDF-")) {
      return fallar("No pude abrir este archivo", "No parece un PDF válido. Puede estar dañado; probá con otra copia.");
    }

    tarea = pdfjsLib.getDocument({ data: buffer });
    const pdf = await tarea.promise;
    if (!vigente()) return;

    const total = pdf.numPages;
    if (total > LIMITE_PAGINAS) {
      return fallar(
        "Tu PDF tiene demasiadas páginas",
        "Tiene " + total + " páginas y el límite es de " + LIMITE_PAGINAS + ". Dividilo en partes más cortas y probá de nuevo."
      );
    }

    // Archivo aceptado
    $("arch-nombre").textContent = archivo.name;
    $("arch-detalle").textContent = tamanoLegible(archivo.size) + " · " + total + (total === 1 ? " página" : " páginas");
    vista(false, true, true, false);

    let texto = "";
    let paginasConTexto = 0;
    for (let i = 1; i <= total; i++) {
      if (!vigente()) return;
      $("barra").value = Math.round(((i - 1) / total) * 100);
      $("progreso-texto").textContent = "Leyendo página " + i + " de " + total;

      const pagina = await pdf.getPage(i);
      const contenido = await pagina.getTextContent();
      const t = contenido.items.map((x) => x.str).join(" ").replace(/\s+/g, " ").trim();
      if (t.split(" ").filter(Boolean).length >= 10) paginasConTexto++;
      texto += t + " ";

      await new Promise((r) => setTimeout(r, 0)); // deja respirar a la página
    }
    if (!vigente()) return;

    $("barra").value = 100;
    $("progreso-texto").textContent = "Armando tu resumen…";
    await new Promise((r) => setTimeout(r, 30));
    destruirTarea();

    const cantidad = texto.split(/\s+/).filter(Boolean).length;
    if (cantidad < 30 || paginasConTexto / total < 0.5) {
      vista(false, true, false, true);
      mensaje(
        "Este PDF parece escaneado o sin texto seleccionable",
        "Esta versión de ResumiPDF necesita PDFs con texto que puedas marcar con el cursor. Probá con un PDF exportado desde Word, Google Docs o una página web."
      );
      return;
    }

    prepararDatos(archivo.name.replace(/\.pdf$/i, ""), texto);
    mostrarResultado();
    vista(false, true, false, true);
    $("resultado").scrollIntoView({ behavior: "smooth" });
  } catch (e) {
    if (!vigente()) return; // fue cancelado
    if (e && e.name === "PasswordException") {
      return fallar("Este PDF tiene contraseña", "Quitale la protección con contraseña y probá de nuevo.");
    }
    if (e && (e.name === "InvalidPDFException" || e.name === "MissingPDFException")) {
      return fallar("No pude abrir este PDF", "Puede estar dañado. Probá con otra copia del archivo.");
    }
    fallar("No pude leer este PDF", "Algo salió mal al leerlo. Probá con otro archivo.");
  }
}

/* ---------- Resumen automático ---------- */

function palabras(texto) {
  return texto.toLowerCase().match(/[a-záéíóúñü]{5,}/g) || [];
}

function prepararDatos(nombre, texto) {
  const frec = {};
  palabras(texto).forEach((p) => {
    if (!IGNORAR.has(p)) frec[p] = (frec[p] || 0) + 1;
  });
  const frases = texto
    .split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ¿¡0-9])/)
    .filter((f) => f.split(" ").length >= 6 && f.split(" ").length <= 60);
  datos = { nombre, frases, frec };
}

function puntaje(frase) {
  const ps = palabras(frase);
  return ps.reduce((suma, p) => suma + (datos.frec[p] || 0), 0) / Math.pow(ps.length || 1, 0.7);
}

function resumir(cantidad) {
  if (datos.frases.length <= cantidad) return datos.frases;
  return datos.frases
    .map((frase, i) => ({ frase, i, p: puntaje(frase) }))
    .sort((a, b) => b.p - a.p)
    .slice(0, cantidad)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.frase);
}

function mostrarResumen() {
  resumenActual = resumir(LARGOS[$("longitud").value]).join(" ");
  $("res-resumen").textContent = resumenActual;
}

function recortar(texto, max) {
  if (texto.length <= max) return texto;
  return texto.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

function mostrarResultado() {
  const conceptos = Object.keys(datos.frec).sort((a, b) => datos.frec[b] - datos.frec[a]).slice(0, 8);

  mostrarResumen();

  const etiquetas = conceptos.map((c) => {
    const li = document.createElement("li");
    li.textContent = c;
    return li;
  });
  $("res-conceptos").replaceChildren(...etiquetas);

  const tarjetas = [];
  conceptos.forEach((c) => {
    const candidatas = datos.frases.filter((f) => f.toLowerCase().includes(c));
    if (!candidatas.length) return;
    const mejor = candidatas.sort((a, b) => puntaje(b) - puntaje(a))[0];
    const nombre = c.charAt(0).toUpperCase() + c.slice(1);
    const explicacion = recortar(mejor, 240);

    const tarjeta = document.createElement("button");
    tarjeta.type = "button";
    tarjeta.className = "flash";
    tarjeta.setAttribute("aria-pressed", "false");
    tarjeta.textContent = nombre;
    tarjeta.addEventListener("click", () => {
      const abierta = tarjeta.classList.toggle("abierta");
      tarjeta.textContent = abierta ? explicacion : nombre;
      tarjeta.setAttribute("aria-pressed", String(abierta));
    });
    tarjetas.push(tarjeta);
  });
  $("res-tarjetas").replaceChildren(...tarjetas);

  const preguntas = ["¿Cuál es la idea principal del documento?"];
  conceptos.slice(0, 5).forEach((p) => preguntas.push("¿Qué explica el texto sobre «" + p + "»?"));
  preguntas.push("¿Cómo se relacionan entre sí los conceptos más importantes?");
  $("res-preguntas").replaceChildren(
    ...preguntas.map((p) => {
      const li = document.createElement("li");
      li.textContent = p;
      return li;
    })
  );

  $("resultado").hidden = false;
}

/* ---------- Acciones ---------- */

$("longitud").addEventListener("change", () => datos && mostrarResumen());

$("btn-copiar").addEventListener("click", async () => {
  const b = $("btn-copiar");
  try {
    await navigator.clipboard.writeText(resumenActual);
    b.textContent = "¡Copiado!";
  } catch (e) {
    const t = document.createElement("textarea"); // plan B
    t.value = resumenActual;
    document.body.appendChild(t);
    t.select();
    b.textContent = document.execCommand("copy") ? "¡Copiado!" : "No se pudo copiar";
    t.remove();
  }
  setTimeout(() => (b.textContent = "Copiar resumen"), 2000);
});

$("btn-descargar").addEventListener("click", () => {
  const contenido =
    "Resumen de " + datos.nombre + " (" + $("longitud").value + ")\n\n" + resumenActual + "\n\nGenerado con ResumiPDF\n";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\uFEFF" + contenido], { type: "text/plain;charset=utf-8" }));
  a.download = datos.nombre + "-resumen.txt";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
