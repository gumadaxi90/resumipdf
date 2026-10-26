pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const $ = (id) => document.getElementById(id);
const boton = $("btn-subir");
const entrada = $("archivo");
const estado = $("estado");
const LIMITE_MB = 20; // tamaño máximo del PDF

// Palabras comunes que no cuentan como conceptos
const IGNORAR = new Set(
  "para como pero este esta esto estos estas entre sobre desde hasta cuando donde porque también todo todos cada otro otra otros otras puede pueden tiene tienen será serán fue fueron son está están más menos muy sin con por que los las del una uno unos unas sus nos les ser han hay así aquí ante bajo contra según tras durante mediante cual cuales además mismo misma forma parte partir".split(" ")
);

boton.addEventListener("click", () => entrada.click());

entrada.addEventListener("change", async () => {
  const archivo = entrada.files[0];
  if (!archivo) return;
  if (archivo.type !== "application/pdf") {
    estado.textContent = "Ese archivo no es un PDF.";
    return;
  }

  if (archivo.size > LIMITE_MB * 1024 * 1024) {
    const mb = (archivo.size / (1024 * 1024)).toFixed(1).replace(".", ",");
    estado.textContent = "Tu PDF pesa " + mb + " MB y el límite es de " + LIMITE_MB + " MB. Probá con uno más liviano o dividilo en partes.";
    entrada.value = "";
    return;
  }

  boton.disabled = true;
  estado.textContent = "";
  $("resultado").hidden = true;
  $("cargando").hidden = false;
  $("cargando-texto").textContent = "¡Genial! Estamos leyendo tu PDF…";

  try {
    const texto = await leerPdf(archivo, (n, total) => {
      $("cargando-texto").textContent = "Leyendo tu PDF… página " + n + " de " + total;
    });
    $("cargando-texto").textContent = "Armando tu resumen, ya casi está…";
    await new Promise((r) => setTimeout(r, 50));
    if (texto.split(/\s+/).length < 30) {
      estado.textContent = "No encontré suficiente texto. Puede ser un PDF escaneado (imagen).";
      return;
    }
    mostrarResultado(texto);
    estado.textContent = "Listo: " + archivo.name;
    $("resultado").scrollIntoView({ behavior: "smooth" });
  } catch (error) {
    estado.textContent = "No pude leer ese PDF. Probá con otro archivo.";
  } finally {
    $("cargando").hidden = true;
    boton.disabled = false;
    entrada.value = "";
  }
});

async function leerPdf(archivo, progreso) {
  const pdf = await pdfjsLib.getDocument({ data: await archivo.arrayBuffer() }).promise;
  let texto = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    if (progreso) progreso(i, pdf.numPages);
    const pagina = await pdf.getPage(i);
    const contenido = await pagina.getTextContent();
    texto += contenido.items.map((x) => x.str).join(" ") + " ";
  }
  return texto.replace(/\s+/g, " ").trim();
}

function palabras(texto) {
  return texto.toLowerCase().match(/[a-záéíóúñü]{5,}/g) || [];
}

function frecuencias(texto) {
  const frec = {};
  palabras(texto).forEach((p) => {
    if (!IGNORAR.has(p)) frec[p] = (frec[p] || 0) + 1;
  });
  return frec;
}

function resumir(texto, frec, cantidad) {
  const frases = texto
    .split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ¿¡0-9])/)
    .filter((f) => f.split(" ").length >= 6 && f.split(" ").length <= 60);
  if (frases.length <= cantidad) return frases;

  return frases
    .map((frase, i) => {
      const ps = palabras(frase);
      const puntaje = ps.reduce((suma, p) => suma + (frec[p] || 0), 0) / Math.pow(ps.length || 1, 0.7);
      return { frase, i, puntaje };
    })
    .sort((a, b) => b.puntaje - a.puntaje)
    .slice(0, cantidad)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.frase);
}

function mostrarResultado(texto) {
  const frec = frecuencias(texto);
  const conceptos = Object.keys(frec).sort((a, b) => frec[b] - frec[a]).slice(0, 8);

  $("res-resumen").textContent = resumir(texto, frec, 6).join(" ");

  $("res-conceptos").innerHTML = "";
  conceptos.forEach((c) => {
    const li = document.createElement("li");
    li.textContent = c;
    $("res-conceptos").appendChild(li);
  });

  const preguntas = ["¿Cuál es la idea principal del documento?"];
  conceptos.slice(0, 5).forEach((c) => preguntas.push("¿Qué explica el texto sobre «" + c + "»?"));
  preguntas.push("¿Cómo se relacionan entre sí los conceptos más importantes?");

  $("res-preguntas").innerHTML = "";
  preguntas.forEach((p) => {
    const li = document.createElement("li");
    li.textContent = p;
    $("res-preguntas").appendChild(li);
  });

  $("resultado").hidden = false;
}
