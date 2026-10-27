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

function reiniciar(limpiarRango) {
  sesion++; // cancela cualquier lectura en curso
  destruirTarea();
  datos = null;
  resumenActual = "";
  $("resultado").hidden = true;
  $("mensaje").hidden = true;
  if (limpiarRango) {
    $("pag-desde").value = "";
    $("pag-hasta").value = "";
  }
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

  const rango = leerRango();
  if (rango.error) return fallar("Revisá el rango de páginas", rango.error);
  const inicioMs = performance.now();

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

    const totalPdf = pdf.numPages;
    const ini = rango.desde || 1;
    const fin = Math.min(rango.hasta || totalPdf, totalPdf);
    if (ini > totalPdf) {
      return fallar("Ese rango no existe", "Tu PDF tiene solo " + totalPdf + " páginas. Elegí un rango dentro de ese total.");
    }
    const total = fin - ini + 1; // páginas que se van a leer
    if (total > LIMITE_PAGINAS) {
      return fallar(
        "Tu PDF tiene demasiadas páginas",
        "Se pidieron " + total + " páginas y el límite es de " + LIMITE_PAGINAS + ". Elegí un rango más corto (por ejemplo, de la página 1 a la 80) o dividí el PDF."
      );
    }

    // Archivo aceptado
    $("arch-nombre").textContent = archivo.name;
    $("arch-detalle").textContent =
      tamanoLegible(archivo.size) + " · " + totalPdf + (totalPdf === 1 ? " página" : " páginas") + (total < totalPdf ? " · leyendo de la " + ini + " a la " + fin : "");
    vista(false, true, true, false);

    let texto = "";
    let paginasConTexto = 0;
    const paginas = [];
    for (let k = 1; k <= total; k++) {
      if (!vigente()) return;
      $("barra").value = Math.round(((k - 1) / total) * 100);
      $("progreso-texto").textContent = "Leyendo página " + k + " de " + total;

      const pagina = await pdf.getPage(ini + k - 1);
      const contenido = await pagina.getTextContent();
      const lineas = lineasDePagina(contenido.items);
      paginas.push(lineas);
      const t = lineas.map((l) => l.t).join(" ");
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

    prepararDatos(archivo.name.replace(/\.pdf$/i, ""), paginas, ini);
    mostrarResultado();
    $("tiempo").textContent = "⏱️ Procesado en " + ((performance.now() - inicioMs) / 1000).toFixed(1).replace(".", ",") + " segundos, en tu dispositivo.";
    $("print-titulo").textContent = "ResumiPDF · " + datos.nombre;
    vista(false, true, false, true);
    $("res-titulo").focus({ preventScroll: true });
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

/* ---------- Análisis del texto (resumen automático, sin IA) ---------- */

// Palabras comunes en español que no cuentan como conceptos
const STOP = new Set(
  ("para como pero este esta esto estos estas entre sobre desde hasta cuando donde porque también todo todos cada otro otra otros otras puede pueden tiene tienen será serán fue fueron son está están más menos muy sin con por que los las del una uno unos unas sus nos les ser han hay así aquí ante bajo contra según tras durante mediante cual cuales además mismo misma forma parte partir " +
    "ellos ellas nosotros ustedes aquel aquella aquellos aquellas dicho dicha dichos dichas estar estaba eso esos esas mientras después antes siempre nunca algunos algunas algún alguna ningún ninguna mucho mucha muchos muchas poco pocos pocas tanto tanta tantos cuyo cuya cuyos quien quienes cuanto cuanta hacer hace hacen hecho haber había hubo sido siendo sería serían podría podrían debe deben debería debido través respecto tambien sino aunque pues entonces luego ahora allí algo nada dado dada dados dadas tales tipo tipos manera modo caso casos vez veces parte partes ejemplo según cuenta tener tiene tenía puede poder pueda puedan existe existen conoce lugar ellos mismos mismas sólo solo donde cuándo cómo qué").split(" ")
);
const DEF = /\b(es|son|se define|se denomina|se llama|se conoce|consiste|se refiere|se entiende|significa|permite)\b/i;

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const terminos = (texto) => (texto.toLowerCase().match(/[a-záéíóúñü]{5,}/g) || []).filter((w) => !STOP.has(w));
function mezclar(a) {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

// Junta las piezas de texto de una página en líneas, con su tamaño de letra
function lineasDePagina(items) {
  const lineas = [];
  let actual = null;
  for (const it of items) {
    const y = it.transform[5];
    if (!actual || Math.abs(y - actual.y) > 2) {
      actual = { y, t: "", h: 0 };
      lineas.push(actual);
    }
    actual.t += it.str;
    actual.h = Math.max(actual.h, it.height || 0);
    if (it.hasEOL) actual = null;
  }
  return lineas.map((l) => ({ t: l.t.replace(/\s+/g, " ").trim(), h: l.h })).filter((l) => l.t);
}

function prepararDatos(nombre, paginas, primera = 1) {
  const alturas = paginas.flat().map((l) => l.h).filter((h) => h > 0).sort((a, b) => a - b);
  const cuerpo = alturas[Math.floor(alturas.length / 2)] || 0;

  // Encabezados y pies que se repiten en muchas páginas
  const veces = {};
  paginas.forEach((ls) => new Set(ls.map((l) => l.t.toLowerCase())).forEach((t) => (veces[t] = (veces[t] || 0) + 1)));
  const sobra = (t) => (paginas.length >= 4 && veces[t.toLowerCase()] > paginas.length * 0.4) || /^(\d{1,3}|p[áa]g(ina)?\.? ?\d+)$/i.test(t);

  const esTitulo = (l) => {
    const n = l.t.split(" ").length;
    if (n > 12 || /[.,;:]$/.test(l.t)) return false;
    const grande = cuerpo > 0 && l.h >= cuerpo * 1.2;
    const numerado = n >= 2 && /^(\d+(\.\d+)*[.)]?|[IVX]+\.)\s+\S/.test(l.t);
    const mayus = l.t.length >= 4 && l.t === l.t.toUpperCase() && /[A-ZÁÉÍÓÚÑ]{3}/.test(l.t);
    const palabra = /^(cap[íi]tulo|unidad|tema|secci[óo]n)\b/i.test(l.t);
    return grande || numerado || mayus || palabra;
  };

  const secciones = [];
  const frases = [];
  const preguntasPDF = [];
  const vistas = new Set();
  let sec = -1;
  const agregar = (buf, pag) => {
    buf
      .trim()
      .split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ¿¡0-9])/)
      .forEach((t) => {
        const n = t.split(" ").length;
        const clave = t.toLowerCase().replace(/[^a-záéíóúñü0-9]/g, "");
        if (n < 8 || n > 45 || vistas.has(clave) || /https?:|www\./i.test(t) || /[¿?]/.test(t)) return;
        if ((t.match(/\d/g) || []).length > t.length * 0.2) return;
        vistas.add(clave);
        frases.push({ t, p: pag, s: sec });
      });
  };
  paginas.forEach((ls, i) => {
    let buf = "";
    // Preguntas que ya trae el PDF (entre ¿ y ?)
    const textoPag = ls.filter((l) => !sobra(l.t)).map((l) => l.t).join(" ");
    (textoPag.match(/¿[^?¿]{4,300}\?/g) || []).forEach((q) => {
      if (preguntasPDF.length < 30 && !preguntasPDF.some((x) => x.q === q)) preguntasPDF.push({ q, p: primera + i });
    });
    const volcar = () => {
      if (buf) agregar(buf, primera + i);
      buf = "";
    };
    ls.forEach((l) => {
      if (sobra(l.t)) return;
      if (esTitulo(l)) {
        volcar();
        secciones.push({ t: l.t, p: primera + i });
        sec = secciones.length - 1;
      } else buf += l.t + " ";
    });
    volcar();
  });

  const frec = {};
  frases.forEach((f) => {
    const ts = terminos(f.t);
    f.k = new Set(ts);
    f.n = ts.length;
    f.m = new Set(raices(f.t));
    ts.forEach((w) => (frec[w] = (frec[w] || 0) + 1));
  });
  const enTitulo = new Set(secciones.flatMap((s) => terminos(s.t)));
  const todos = Object.keys(frec)
    .map((w) => ({ w, v: frec[w] * (enTitulo.has(w) ? 1.8 : 1) }))
    .sort((a, b) => b.v - a.v);
  let elegidos = todos.filter((x) => frec[x.w] >= 2);
  if (elegidos.length < 8) elegidos = todos;

  const df = {};
  frases.forEach((f) => f.m.forEach((r) => (df[r] = (df[r] || 0) + 1)));
  datos = { nombre, frases, secciones, frec, enTitulo, ranking: elegidos.slice(0, 20).map((x) => x.w), df, preguntasPDF };
}

function puntaje(f) {
  let suma = 0;
  f.k.forEach((w) => (suma += datos.frec[w] * (datos.enTitulo.has(w) ? 1.8 : 1)));
  return (suma / Math.pow(f.n || 1, 0.7)) * (DEF.test(f.t) ? 1.25 : 1);
}

function parecidas(a, b) {
  let comun = 0;
  a.k.forEach((w) => b.k.has(w) && comun++);
  return comun / (a.k.size + b.k.size - comun || 1) >= 0.5;
}

function resumir(cantidad) {
  const pool = datos.frases.map((f, i) => ({ f, i, p: puntaje(f) }));
  const elegidas = [];
  const porSeccion = {};
  while (elegidas.length < cantidad && pool.length) {
    let mejor = -1;
    let max = 0;
    pool.forEach((x, k) => {
      const ajustado = x.p / (1 + 0.35 * (porSeccion[x.f.s] || 0)); // reparte entre secciones
      if (ajustado > max) {
        max = ajustado;
        mejor = k;
      }
    });
    if (mejor < 0) break;
    const x = pool.splice(mejor, 1)[0];
    if (elegidas.some((e) => parecidas(e.f, x.f))) continue; // evita repetir ideas
    elegidas.push(x);
    porSeccion[x.f.s] = (porSeccion[x.f.s] || 0) + 1;
  }
  return elegidas.sort((a, b) => a.i - b.i).map((x) => x.f);
}

function paginasDe(termino) {
  return [...new Set(datos.frases.filter((f) => f.k.has(termino)).map((f) => f.p))].sort((a, b) => a - b).slice(0, 4);
}

function recortar(texto, max) {
  if (texto.length <= max) return texto;
  return texto.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

// Para cada concepto, la frase que mejor lo explica (prefiere las que parecen definiciones)
function construirGlosario(terminosElegidos) {
  const entradas = [];
  terminosElegidos.forEach((t) => {
    const cand = datos.frases
      .filter((f) => f.k.has(t))
      .map((f) => ({ f, v: (DEF.test(f.t) ? 2 : 0) + (f.t.toLowerCase().indexOf(t) < 40 ? 1 : 0) }))
      .sort((a, b) => b.v - a.v || puntaje(b.f) - puntaje(a.f))[0];
    if (cand) entradas.push({ termino: t, texto: recortar(cand.f.t, 240), p: cand.f.p });
  });
  return entradas;
}

/* ---------- Mostrar resultados (siempre con textContent) ---------- */

function mostrarResumen() {
  const sel = resumir(LARGOS[$("longitud").value]);
  if (!sel.length) {
    resumenActual = "";
    $("res-resumen").textContent = "No encontré suficientes frases completas para resumir. Este PDF parece tener sobre todo preguntas, listas o fragmentos cortos.";
    return;
  }
  resumenActual = sel.map((f) => f.t + " (p. " + f.p + ")").join(" ");
  const nodos = [];
  sel.forEach((f) => {
    const ref = document.createElement("span");
    ref.className = "pag";
    ref.textContent = "(p. " + f.p + ") ";
    nodos.push(document.createTextNode(f.t + " "), ref);
  });
  $("res-resumen").replaceChildren(...nodos);
}

function item(tag, texto, clase) {
  const e = document.createElement(tag);
  e.textContent = texto;
  if (clase) e.className = clase;
  return e;
}

function mostrarResultado() {
  mostrarResumen();

  const secs = datos.secciones.slice(0, 12);
  $("card-secciones").hidden = secs.length === 0;
  $("res-secciones").replaceChildren(...secs.map((s) => item("li", s.t + " (p. " + s.p + ")")));

  const conceptos = datos.ranking.slice(0, 10);
  $("res-conceptos").replaceChildren(...conceptos.map((c) => item("li", c + " · p. " + paginasDe(c).join(", "))));

  const glosario = construirGlosario(datos.ranking.slice(0, 8));
  datos.glosario = glosario;
  const dl = [];
  glosario.forEach((g) => {
    const dd = item("dd", g.texto + " ");
    dd.appendChild(item("span", "(p. " + g.p + ")", "pag"));
    dl.push(item("dt", cap(g.termino)), dd);
  });
  $("res-glosario").replaceChildren(...dl);

  $("res-tarjetas").replaceChildren(
    ...glosario.map((g) => {
      const b = item("button", cap(g.termino), "flash");
      b.type = "button";
      b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", () => {
        const abierta = b.classList.toggle("abierta");
        b.textContent = abierta ? g.texto + " (p. " + g.p + ")" : cap(g.termino);
        b.setAttribute("aria-pressed", String(abierta));
      });
      return b;
    })
  );

  // Preguntas armadas solo con secciones y conceptos del propio PDF
  const preguntas = [];
  datos.secciones.slice(0, 4).forEach((s) => preguntas.push("¿Qué explica el texto en la sección «" + s.t + "»? (p. " + s.p + ")"));
  glosario.slice(0, 10 - preguntas.length).forEach((g) =>
    preguntas.push((DEF.test(g.texto) ? "¿Qué es «" + g.termino + "» según el texto?" : "¿Qué dice el documento sobre «" + g.termino + "»?") + " (p. " + g.p + ")")
  );
  $("res-preguntas").replaceChildren(...preguntas.map((p) => item("li", p)));
  datos.preguntas = preguntas;

  $("qa-pregunta").value = "";
  $("qa-resultado").replaceChildren();
  mostrarDetectadas();

  $("examen-cont").replaceChildren();
  $("btn-examen").textContent = "Empezar examen";
  $("resultado").hidden = false;
}

/* ---------- Modo examen: completar la palabra que falta ---------- */

function armarExamen() {
  const usadas = new Set();
  const qs = [];
  for (const t of datos.ranking) {
    if (qs.length >= 10) break;
    const prueba = new RegExp("(?<![a-záéíóúñü])" + t + "(?![a-záéíóúñü])", "i");
    const f = datos.frases
      .filter((x) => x.k.has(t) && !usadas.has(x.t) && prueba.test(x.t))
      .sort((a, b) => puntaje(b) - puntaje(a))[0];
    if (!f) continue;
    const otros = mezclar(datos.ranking.filter((o) => o !== t && !f.k.has(o))).slice(0, 3);
    if (otros.length < 3) continue;
    usadas.add(f.t);
    const opciones = mezclar([t, ...otros]);
    const reemplazo = new RegExp("(?<![a-záéíóúñü])" + t + "(?![a-záéíóúñü])", "gi");
    qs.push({ texto: f.t.replace(reemplazo, "_____"), opciones, correcta: opciones.indexOf(t), p: f.p });
  }
  return qs;
}

$("btn-examen").addEventListener("click", () => {
  const cont = $("examen-cont");
  const qs = armarExamen();
  if (qs.length < 4) {
    cont.replaceChildren(item("p", "Este PDF no tiene suficiente contenido para armar un examen confiable."));
    return;
  }
  const campos = qs.map((q, i) => {
    const fs = document.createElement("fieldset");
    fs.className = "pregunta";
    fs.appendChild(item("legend", (i + 1) + ". Completá la frase: " + q.texto));
    q.opciones.forEach((o, j) => {
      const lab = document.createElement("label");
      const r = document.createElement("input");
      r.type = "radio";
      r.name = "q" + i;
      r.value = j;
      lab.append(r, item("span", o));
      fs.appendChild(lab);
    });
    fs.appendChild(item("p", "", "feedback"));
    return fs;
  });

  const res = item("p", "", "examen-res");
  res.setAttribute("role", "status");
  const corregir = item("button", "Corregir", "boton-sec");
  corregir.type = "button";
  corregir.addEventListener("click", () => {
    let puntos = 0;
    campos.forEach((fs, i) => {
      const q = qs[i];
      const marcada = fs.querySelector("input:checked");
      const labels = fs.querySelectorAll("label");
      const bien = marcada && Number(marcada.value) === q.correcta;
      if (bien) puntos++;
      labels[q.correcta].classList.add("ok");
      if (marcada && !bien) labels[Number(marcada.value)].classList.add("mal");
      fs.querySelector(".feedback").textContent =
        (bien ? "✓ Correcto. " : marcada ? "✗ Incorrecto. " : "Sin responder. ") + "Respuesta: «" + q.opciones[q.correcta] + "» (p. " + q.p + ")";
      fs.disabled = true;
    });
    res.textContent = "Tu puntaje: " + puntos + " de " + qs.length + ".";
    corregir.hidden = true;
  });
  cont.replaceChildren(...campos, corregir, res);
  $("btn-examen").textContent = "Nuevo examen";
});

/* ---------- Preguntas y respuestas del texto (búsqueda, no IA) ---------- */

const CORTAS = new Set(
  "que cual cuales como donde cuando quien quienes cuanto cuanta cuantos cuantas por para con sin los las del una uno unos unas son era fue ser esta este eso esos esas ese entre sobre hay han mas muy segun dice texto explica explique define indica describe menciona nombre nombra funcion funciones funciona importancia importante ejemplo ejemplos principal principales caracteristica caracteristicas diferencia diferencias significa relacion concepto".split(" ")
);

// Raíces simples (sin tildes) para comparar palabras parecidas: planta/plantas, fotosíntesis/fotosintética
function raices(texto) {
  const plano = texto.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return (plano.match(/[a-zñ0-9]{3,}/g) || [])
    .filter((w) => !CORTAS.has(w) && !STOP.has(w))
    .map((w) => (w.length > 6 ? w.slice(0, 6) : w.replace(/s$/, "")));
}

function buscarFragmentos(consulta, max = 3) {
  const q = [...new Set(raices(consulta))];
  const vacio = [];
  if (!q.length) return vacio;
  const N = datos.frases.length;
  const idf = (r) => Math.log(1 + N / ((datos.df[r] || 0) + 0.5));
  const total = q.reduce((suma, r) => suma + idf(r), 0);
  const minimo = Math.max(1, Math.floor(q.length / 2));
  const res = datos.frases
    .map((f) => {
      let coinc = 0;
      let p = 0;
      q.forEach((r) => {
        if (f.m.has(r)) {
          coinc++;
          p += idf(r);
        }
      });
      return { f, coinc, razon: p / total, orden: p / (1 + f.t.length / 400) };
    })
    .filter((x) => x.coinc >= minimo)
    .sort((a, b) => b.orden - a.orden);
  const salida = res.slice(0, max).map((x) => x.f);
  salida.parcial = res.length > 0 && res[0].razon < 0.5; // coincidencia débil
  return salida;
}

function pintarFragmentos(destino, frs) {
  if (!frs.length) {
    destino.replaceChildren(item("p", "No encontré en este PDF fragmentos relacionados con esa pregunta."));
    return;
  }
  const nodos = frs.map((f) => {
    const p = item("p", f.t + " ", "fragmento");
    p.appendChild(item("span", "(p. " + f.p + ")", "pag"));
    return p;
  });
  if (frs.parcial) nodos.unshift(item("p", "Coincidencia parcial: es posible que el PDF no trate este tema.", "aviso-qa"));
  destino.replaceChildren(...nodos);
}

function consultar() {
  if (!datos) return;
  const q = $("qa-pregunta").value.trim();
  const cont = $("qa-resultado");
  if (q.length < 3) {
    cont.replaceChildren(item("p", "Escribí una pregunta para buscar en tu PDF."));
    return;
  }
  const caja = document.createElement("div");
  pintarFragmentos(caja, buscarFragmentos(q));
  cont.replaceChildren(item("p", "Fragmentos del PDF relacionados con tu pregunta (no es una respuesta generada):", "qa-tit"), caja);
}

function mostrarDetectadas() {
  const qs = datos.preguntasPDF;
  $("qa-detectadas-t").hidden = qs.length === 0;
  const nodos = [];
  if (qs.length && datos.frases.length < 3) {
    nodos.push(
      item("p", "Tu PDF tiene preguntas pero casi no tiene texto con información para responderlas. ResumiPDF solo busca respuestas dentro del propio PDF; si es una hoja de preguntas, hace falta que el mismo archivo incluya los apuntes.", "aviso-qa")
    );
  }
  qs.forEach((x) => {
    const d = document.createElement("details");
    d.appendChild(item("summary", x.q + " (p. " + x.p + ")"));
    const caja = document.createElement("div");
    d.appendChild(caja);
    d.addEventListener("toggle", () => {
      if (d.open && !caja.hasChildNodes()) pintarFragmentos(caja, buscarFragmentos(x.q));
    });
    nodos.push(d);
  });
  $("qa-detectadas").replaceChildren(...nodos);
}

$("btn-qa").addEventListener("click", consultar);
$("qa-pregunta").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    consultar();
  }
});

/* ---------- Rango de páginas ---------- */

function leerRango() {
  const d = $("pag-desde").value.trim();
  const h = $("pag-hasta").value.trim();
  const num = (v) => (/^\d+$/.test(v) ? parseInt(v, 10) : NaN);
  const desde = d ? num(d) : null;
  const hasta = h ? num(h) : null;
  if ((d && !(desde >= 1)) || (h && !(hasta >= 1))) {
    return { error: "Escribí números enteros mayores que 0, por ejemplo de la página 1 a la 10." };
  }
  if (desde && hasta && desde > hasta) {
    return { error: "El número de «Desde» no puede ser mayor que el de «Hasta»." };
  }
  return { desde, hasta };
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

function textoCompleto() {
  const L = [
    "ResumiPDF · " + datos.nombre,
    "Resumen automático: comprobá la información importante en el PDF original.",
    "",
    "RESUMEN (" + $("longitud").value + ")",
    resumenActual || "(sin resumen)",
    "",
  ];
  if (datos.secciones.length) {
    L.push("SECCIONES DETECTADAS", ...datos.secciones.slice(0, 12).map((x) => "- " + x.t + " (p. " + x.p + ")"), "");
  }
  L.push("CONCEPTOS CLAVE", datos.ranking.slice(0, 10).join(", "), "");
  L.push("GLOSARIO", ...datos.glosario.map((g) => "- " + cap(g.termino) + ": " + g.texto + " (p. " + g.p + ")"), "");
  L.push("PREGUNTAS PARA ESTUDIAR", ...datos.preguntas.map((p, i) => i + 1 + ". " + p));
  if (datos.preguntasPDF.length) {
    L.push("", "PREGUNTAS ENCONTRADAS EN EL PDF Y FRAGMENTOS RELACIONADOS (no son respuestas generadas)");
    datos.preguntasPDF.forEach((x, i) => {
      L.push("", i + 1 + ". " + x.q + " (p. " + x.p + ")");
      const frs = buscarFragmentos(x.q);
      if (!frs.length) L.push("   Sin fragmentos relacionados.");
      else if (frs.parcial) L.push("   (Coincidencia parcial: es posible que el PDF no trate este tema.)");
      frs.forEach((f) => L.push("   - " + f.t + " (p. " + f.p + ")"));
    });
  }
  L.push("", "Generado con ResumiPDF · Procesamiento local", "");
  return L.join("\n");
}

$("btn-descargar").addEventListener("click", () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\uFEFF" + textoCompleto()], { type: "text/plain;charset=utf-8" }));
  a.download = datos.nombre + "-resultado.txt";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$("btn-imprimir").addEventListener("click", () => window.print());

$("btn-nuevo").addEventListener("click", () => {
  reiniciar(true);
  window.scrollTo({ top: 0, behavior: "smooth" });
  $("btn-subir").focus({ preventScroll: true });
});
