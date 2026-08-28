// ============================================================
// Bachómetro — Fase 2 (los datos viven en PostgreSQL)
//
// El navegador ya no guarda reportes: los pide a la API y los manda a la API.
// Lo único que queda en localStorage es el id del cliente (ver api.js).
// ============================================================

let reportes      = [];      // lo que devolvió la API para el depto actual
let deptoActual   = 'scz';
let marcadores    = [];
let coordsNuevas  = null;    // ubicación elegida para el reporte nuevo
let fotoNueva     = null;    // foto ya comprimida, lista para subir
let detalleActual = null;    // id del reporte abierto en el modal

// Cómo se le muestra al ciudadano el avance del trabajo de la alcaldía.
const ETIQUETAS_TRABAJO = {
  pendiente: 'Programado',
  en_ruta:    'Cuadrilla en camino',
  arreglando: 'Arreglando el bache ahora',
  ejecutado: 'Trabajo ejecutado',
  cancelado: 'Trabajo cancelado',
};

// Fecha en formato legible: 2026-09-12 -> 12 de septiembre
function fechaLegible(iso) {
  if (!iso) return '';
  const [a, m, d] = iso.split('-').map(Number);
  return new Date(a, m - 1, d).toLocaleDateString('es-BO', { day: 'numeric', month: 'long' });
}

// Evita que el texto que escribe el usuario rompa el HTML.
function esc(texto) {
  return String(texto ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ---------- Mapa ----------
const mapa = L.map('mapa').setView([-17.7833, -63.1821], 13);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap',
  maxZoom: 19,
}).addTo(mapa);

let marcaProvisional = null;   // pin en el mapa grande
let miniMapa   = null;         // mapa chico dentro del formulario
let miniMarca  = null;         // pin arrastrable del mapa chico

mapa.on('click', (e) => fijarUbicacion(e.latlng.lat, e.latlng.lng));

// Marca la ubicación del reporte nuevo en los dos mapas a la vez.
function fijarUbicacion(lat, lng, centrarMini = false) {
  coordsNuevas = { lat, lng };
  document.getElementById('f-coords').value = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

  if (!marcaProvisional) {
    marcaProvisional = L.marker([lat, lng]).addTo(mapa).bindPopup('Bache que estás reportando');
  } else {
    marcaProvisional.setLatLng([lat, lng]);
    if (!mapa.hasLayer(marcaProvisional)) marcaProvisional.addTo(mapa);
  }

  if (miniMapa) {
    if (!miniMarca) {
      miniMarca = L.marker([lat, lng], { draggable: true }).addTo(miniMapa);
      // Arrastrar el pin también actualiza la ubicación.
      miniMarca.on('dragend', () => {
        const p = miniMarca.getLatLng();
        fijarUbicacion(p.lat, p.lng);
      });
    } else {
      miniMarca.setLatLng([lat, lng]);
      if (!miniMapa.hasLayer(miniMarca)) miniMarca.addTo(miniMapa);
    }
    if (centrarMini) miniMapa.setView([lat, lng], 17);
  }
}

// El mapa chico se crea recién cuando se abre el formulario: Leaflet no puede
// medir un contenedor escondido, por eso además hay que avisarle el tamaño.
function prepararMiniMapa() {
  if (!miniMapa) {
    miniMapa = L.map('mini-mapa').setView(mapa.getCenter(), 16);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 19,
    }).addTo(miniMapa);
    miniMapa.on('click', (e) => fijarUbicacion(e.latlng.lat, e.latlng.lng));
  }

  setTimeout(() => {
    miniMapa.invalidateSize();
    miniMapa.setView(
      coordsNuevas ? [coordsNuevas.lat, coordsNuevas.lng] : mapa.getCenter(),
      coordsNuevas ? 17 : 16
    );
  }, 80);
}

// ---------- Alcaldía ----------
// Se marca en el mapa porque es de donde salen las cuadrillas: ver a qué
// distancia está cada bache ayuda a entender el plan de bacheo.
let marcaAlcaldia  = null;
let alcaldiaActual = null;   // la del departamento que se está mirando
let capaRuta       = null;   // ruta dibujada del bache elegido

const ICONO_ALCALDIA = L.divIcon({
  className: 'icono-alcaldia',
  html: '<div class="pin-alcaldia">🏛️</div>',
  iconSize: [34, 34],
  iconAnchor: [17, 17],
});

async function dibujarAlcaldia() {
  if (marcaAlcaldia) {
    mapa.removeLayer(marcaAlcaldia);
    marcaAlcaldia = null;
  }

  try {
    const [alcaldia] = await API.alcaldias(deptoActual);
    alcaldiaActual = alcaldia || null;
    if (!alcaldia) return;

    marcaAlcaldia = L.marker([alcaldia.lat, alcaldia.lng], {
      icon: ICONO_ALCALDIA,
      title: alcaldia.nombre,
      zIndexOffset: 500,
    }).addTo(mapa);

    marcaAlcaldia.bindPopup(`
      <div class="popup">
        <strong>${esc(alcaldia.nombre)}</strong>
        <div class="popup-meta">${esc(alcaldia.direccion)}</div>
        <div class="popup-meta">Punto de partida de las cuadrillas</div>
      </div>
    `);
  } catch (error) {
    console.warn('No se pudo cargar la alcaldía:', error.message);
  }
}

// ---------- Ruta de la cuadrilla ----------
// Solo se dibuja cuando la alcaldía ya se hizo cargo del bache. Con un bache
// recién reportado no hay ninguna ruta que mostrar (nadie lo revisó todavía),
// y con uno reparado tampoco (el trabajo ya terminó). Dibujarla igual sería
// prometerle al vecino un operativo que no existe.
const ESTADOS_CON_RUTA = {
  verificado:   { color: '#38bdf8', texto: 'Bache aceptado por la alcaldía' },
  en_progreso:  { color: '#a855f7', texto: 'Cuadrilla en camino' },
};

// La ruta es una respuesta a "¿por dónde viene la cuadrilla?", no algo que
// tenga que quedar tapando el mapa. Se muestra un rato y se va sola.
const SEGUNDOS_DE_RUTA = 15;
let temporizadorRuta = null;

function borrarRuta() {
  clearTimeout(temporizadorRuta);
  temporizadorRuta = null;

  if (capaRuta) {
    mapa.removeLayer(capaRuta);
    capaRuta = null;
  }
}

// Se desvanece al final: desaparecer de golpe se lee como un error del mapa.
//
// El avance se calcula por reloj y no contando pasos. Los navegadores frenan
// los temporizadores en pestañas que no están a la vista, y contando pasos el
// desvanecimiento se estiraba a varios segundos en vez de durar poco más de
// uno. Midiendo el tiempo real, termina cuando tiene que terminar.
const MILIS_DE_FUNDIDO = 1200;

function desvanecerYBorrar(idReporte) {
  const capa = capaRuta;
  const arranque = Date.now();

  const reloj = setInterval(() => {
    if (capaRuta !== capa) return clearInterval(reloj);   // ya se dibujó otra

    const avance = (Date.now() - arranque) / MILIS_DE_FUNDIDO;

    if (avance >= 1) {
      clearInterval(reloj);
      borrarRuta();
      ofrecerVerDeNuevo(idReporte);
    } else {
      capa.setStyle({ opacity: 0.85 * (1 - avance) });
    }
  }, 80);
}

// Cuando la ruta se fue, el cartel del detalle no puede seguir diciendo
// "marcada en el mapa": se cambia por un botón para volver a verla.
function ofrecerVerDeNuevo(idReporte) {
  const caja = document.getElementById('d-ruta');
  if (caja.hidden || detalleActual !== idReporte) return;

  const boton = caja.querySelector('[data-rever]');
  if (boton) return;

  caja.insertAdjacentHTML('beforeend',
    `<button class="btn-ruta-otra-vez" data-rever="${idReporte}">↻ Ver la ruta otra vez</button>`);
}

document.getElementById('d-ruta').addEventListener('click', (e) => {
  const id = e.target.dataset.rever;
  if (!id) return;

  const r = reportes.find(x => x.id === Number(id));
  if (r) mostrarRuta(r);
});

async function dibujarRutaDe(r) {
  borrarRuta();

  const info = ESTADOS_CON_RUTA[r.estado];
  if (!info || !alcaldiaActual) return null;

  try {
    const ruta = await API.ruta(
      { lat: alcaldiaActual.lat, lng: alcaldiaActual.lng },
      { lat: r.lat, lng: r.lng }
    );

    capaRuta = L.polyline(ruta.geometria, {
      color: info.color,
      weight: 5,
      opacity: 0.85,
      dashArray: ruta.aproximada ? '8, 8' : null,
    }).addTo(mapa);

    capaRuta.bindPopup(`
      <div class="popup">
        <strong>${esc(info.texto)}</strong>
        <div class="popup-meta">Desde ${esc(alcaldiaActual.nombre)}</div>
      </div>
    `);

    temporizadorRuta = setTimeout(() => desvanecerYBorrar(r.id), SEGUNDOS_DE_RUTA * 1000);

    return { ruta, info };
  } catch (error) {
    console.warn('No se pudo dibujar la ruta:', error.message);
    return null;
  }
}

// ---------- Datos ----------
// El filtrado por departamento lo hace la base; el resto se filtra acá para
// que tocar una casilla se sienta instantáneo y no dispare una petición.
async function traerReportes() {
  try {
    reportes = await API.reportes(deptoActual);
  } catch (error) {
    reportes = [];
    avisar(`No se pudieron cargar los reportes: ${error.message}`);
  }
  render();
}

function valoresMarcados(clase) {
  return [...document.querySelectorAll(`.${clase}:checked`)].map(c => c.value);
}

function reportesVisibles() {
  const estados    = valoresMarcados('f-estado');
  const gravedades = valoresMarcados('f-gravedad');
  const fuentes    = valoresMarcados('f-fuente');
  const busqueda   = document.getElementById('buscador').value.trim().toLowerCase();

  return reportes
    .filter(r => estados.includes(r.estado))
    .filter(r => gravedades.includes(r.gravedad))
    .filter(r => fuentes.includes(r.fuente))
    .filter(r => !busqueda ||
      `${r.referencia} ${r.descripcion}`.toLowerCase().includes(busqueda));
}

// ---------- Render ----------
function render() {
  const visibles = reportesVisibles();
  dibujarMarcadores(visibles);
  dibujarLista(visibles);
  dibujarStats(visibles);
}

function dibujarMarcadores(lista) {
  marcadores.forEach(m => mapa.removeLayer(m));
  marcadores = lista.map(r => {
    const marcador = L.circleMarker([r.lat, r.lng], {
      radius: r.gravedad === 'critico' ? 11 : 9,
      color: '#000',
      weight: 1,
      fillColor: COLORES_GRAVEDAD[r.gravedad],
      fillOpacity: r.estado === 'reparado' ? 0.3 : 0.9,
    }).addTo(mapa);

    marcador.bindPopup(`
      <div class="popup">
        ${r.foto_url ? `<img src="${esc(r.foto_url)}" alt="">` : ''}
        <strong>${esc(r.referencia)}</strong>
        <div class="popup-meta">
          ${ETIQUETAS_GRAVEDAD[r.gravedad]} · ${ETIQUETAS_ESTADO[r.estado]} · 👍 ${r.votos}
        </div>
        ${r.programado_para
          ? `<div class="popup-plan">📅 Bacheo programado: ${fechaLegible(r.programado_para)}</div>`
          : ''}
        <button onclick="verDetalle(${r.id})">Ver detalle</button>
      </div>
    `);
    return marcador;
  });
}

function dibujarLista(lista) {
  const ul = document.getElementById('lista-reportes');
  document.getElementById('conteo-lista').textContent = `(${lista.length})`;
  ul.innerHTML = '';

  if (lista.length === 0) {
    ul.innerHTML = '<li class="vacio">Sin reportes con estos filtros.</li>';
    return;
  }

  lista.forEach(r => {
    const li = document.createElement('li');
    li.className = `item ${r.gravedad}`;
    li.innerHTML = `
      <div class="miniatura">
        ${r.foto_url ? `<img src="${esc(r.foto_url)}" alt="" loading="lazy">`
                     : '<span class="sin-foto">sin foto</span>'}
      </div>
      <div class="item-texto">
        <strong>${esc(r.referencia)}</strong>
        <div class="meta">
          <span class="chip ${r.estado}">${ETIQUETAS_ESTADO[r.estado]}</span>
          ${r.fuente === 'waze' ? '<span class="chip waze">Waze</span>' : ''}
          ${r.programado_para ? '<span class="chip programado">📅 Programado</span>' : ''}
          👍 ${r.votos}
        </div>
        <div class="meta">${r.fecha}</div>
      </div>
    `;
    li.onclick = () => {
      mapa.setView([r.lat, r.lng], 17);
      verDetalle(r.id);
    };
    ul.appendChild(li);
  });
}

function dibujarStats(lista) {
  document.getElementById('stat-total').textContent = lista.length;
  document.getElementById('stat-abiertos').textContent =
    lista.filter(r => r.estado === 'reportado' || r.estado === 'verificado').length;
  document.getElementById('stat-progreso').textContent =
    lista.filter(r => r.estado === 'en_progreso').length;
  document.getElementById('stat-reparados').textContent =
    lista.filter(r => r.estado === 'reparado').length;
}

// ---------- Detalle y votos ----------
function verDetalle(id) {
  const r = reportes.find(x => x.id === id);
  if (!r) return;

  detalleActual = id;
  const img = document.getElementById('d-foto');

  if (r.foto_url) {
    img.src = r.foto_url;
    img.hidden = false;
  } else {
    img.removeAttribute('src');
    img.hidden = true;
  }

  document.getElementById('d-titulo').textContent = r.referencia;
  document.getElementById('d-cuerpo').innerHTML = `
    <p class="descripcion">${esc(r.descripcion) || '<em>Sin descripción</em>'}</p>

    ${r.estado_trabajo ? `
      <div class="aviso-plan ${r.estado_trabajo}">
        <strong>${ETIQUETAS_TRABAJO[r.estado_trabajo]}</strong>
        ${r.programado_para
          ? `<div>Bacheo previsto para el <strong>${fechaLegible(r.programado_para)}</strong>.</div>`
          : '<div>Está en el plan de bacheo, todavía sin fecha asignada.</div>'}
      </div>` : ''}
    <dl class="ficha">
      <div><dt>Gravedad</dt><dd><i class="punto ${r.gravedad}"></i> ${ETIQUETAS_GRAVEDAD[r.gravedad]}</dd></div>
      <div><dt>Tamaño</dt><dd>${esc(r.tamano)}</dd></div>
      <div><dt>Estado</dt><dd>${ETIQUETAS_ESTADO[r.estado]}</dd></div>
      <div><dt>Fuente</dt><dd>${r.fuente === 'waze' ? 'Alerta Waze' : 'Reporte ciudadano'}</dd></div>
      <div><dt>Reportó</dt><dd>${esc(r.autor) || 'Anónimo'}</dd></div>
      <div><dt>Fecha</dt><dd>${r.fecha}</dd></div>
      <div><dt>Coordenadas</dt><dd>${Number(r.lat).toFixed(5)}, ${Number(r.lng).toFixed(5)}</dd></div>
      <div><dt>Confirmaciones</dt><dd>👍 ${r.votos}</dd></div>
    </dl>
  `;

  const botonVoto = document.getElementById('btn-votar');
  botonVoto.disabled = r.ya_vote;
  botonVoto.textContent = r.ya_vote ? '✓ Ya confirmaste este bache' : '👍 Yo también lo vi';

  abrir('modal-detalle');

  // La ruta se dibuja en el mapa de atrás, para que quede visible al cerrar
  // esta ventana. Si el bache no está aceptado ni en obra, se borra la que
  // hubiera de un bache anterior.
  mostrarRuta(r);
}

// Dibuja la ruta y cuenta en el detalle qué se está viendo. Se usa al abrir
// el bache y también desde el botón "ver la ruta otra vez".
async function mostrarRuta(r) {
  const caja = document.getElementById('d-ruta');
  const resultado = await dibujarRutaDe(r);

  if (detalleActual !== r.id) return;   // se abrió otro bache mientras tanto

  if (!resultado) {
    caja.hidden = true;
    return;
  }

  const { ruta, info } = resultado;
  const minutos = ruta.duracionS ? Math.round(ruta.duracionS / 60) : null;
  const distancia = ruta.distanciaM < 1000
    ? `${ruta.distanciaM} m`
    : `${(ruta.distanciaM / 1000).toFixed(1)} km`;

  caja.hidden = false;
  caja.style.borderLeftColor = info.color;
  caja.innerHTML = `
    <strong style="color:${info.color}">🚚 ${esc(info.texto)}</strong>
    <div><strong>${distancia}</strong> desde la alcaldía${
      minutos ? `, unos <strong>${minutos} min</strong> en auto` : ''}.</div>
    <div class="nota-ruta">El recorrido se muestra en el mapa por ${SEGUNDOS_DE_RUTA} segundos.</div>
    ${ruta.aproximada ? '<div>Trazado aproximado.</div>' : ''}
  `;
}
window.verDetalle = verDetalle;   // el popup del mapa la llama por onclick

document.getElementById('btn-votar').onclick = async (e) => {
  const boton = e.currentTarget;
  boton.disabled = true;

  try {
    const actualizado = await API.votar(detalleActual);
    // La API devuelve el reporte con el conteo real: se reemplaza el local.
    const i = reportes.findIndex(x => x.id === actualizado.id);
    if (i !== -1) reportes[i] = actualizado;
    render();
    verDetalle(actualizado.id);
  } catch (error) {
    boton.disabled = false;
    avisar(`No se pudo registrar el voto: ${error.message}`);
  }
};

// ---------- Modales ----------
function abrir(id)  { document.getElementById(id).classList.remove('oculto'); }
function cerrar(id) { document.getElementById(id).classList.add('oculto'); }

document.querySelectorAll('[data-cerrar]').forEach(b => {
  b.onclick = () => cerrar(b.dataset.cerrar);
});

document.querySelectorAll('.modal').forEach(m => {
  m.onclick = (e) => { if (e.target === m) cerrar(m.id); };
});

document.onkeydown = (e) => {
  if (e.key === 'Escape') document.querySelectorAll('.modal').forEach(m => cerrar(m.id));
};

function avisar(mensaje) {
  const caja = document.getElementById('aviso');
  caja.textContent = mensaje;
  caja.classList.remove('oculto');
  clearTimeout(avisar.reloj);
  avisar.reloj = setTimeout(() => caja.classList.add('oculto'), 4000);
}

// ---------- Filtros y departamento ----------
const selectDepto = document.getElementById('departamento');

selectDepto.onchange = (e) => {
  deptoActual = e.target.value;
  const d = DEPARTAMENTOS[deptoActual];
  if (d) mapa.setView([d.lat, d.lng], 13);
  borrarRuta();
  traerReportes();
  dibujarAlcaldia();
};

document.querySelectorAll('.f-estado, .f-gravedad, .f-fuente')
  .forEach(c => c.onchange = render);

document.getElementById('buscador').oninput = render;

// ---------- Formulario: foto ----------
const entradaFoto = document.getElementById('f-foto');
const preview     = document.getElementById('preview-foto');
const zonaTexto   = document.getElementById('zona-foto-texto');
const fotoInfo    = document.getElementById('foto-info');

entradaFoto.onchange = async () => {
  const archivo = entradaFoto.files[0];
  if (!archivo) return;

  fotoInfo.textContent = 'Procesando la foto…';
  try {
    fotoNueva = await comprimirImagen(archivo);
    preview.src = fotoNueva;
    preview.hidden = false;
    zonaTexto.hidden = true;
    fotoInfo.textContent = `Foto lista (${pesoKB(fotoNueva)} KB). Tocá la imagen para cambiarla.`;
  } catch (error) {
    fotoNueva = null;
    fotoInfo.textContent = error.message;
  }
};

// ---------- Formulario: GPS ----------
// El navegador solo entrega la ubicación en HTTPS o en localhost. Entrando por
// la IP de la red (http://192.168.x.x) no funciona, así que ni mostramos el botón.
const botonGps = document.getElementById('btn-gps');

if (!window.isSecureContext || !navigator.geolocation) {
  botonGps.hidden = true;
} else {
  botonGps.onclick = () => {
    avisar('Buscando tu ubicación…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        fijarUbicacion(pos.coords.latitude, pos.coords.longitude, true);
        mapa.setView([pos.coords.latitude, pos.coords.longitude], 17);
        avisar('Ubicación tomada del GPS.');
      },
      () => avisar('No se pudo obtener la ubicación. Marcala tocando el mapa.'),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };
}

// ---------- Formulario: envío ----------
document.getElementById('btn-reportar').onclick = () => {
  abrir('modal-reporte');
  prepararMiniMapa();
};

document.getElementById('form-reporte').onsubmit = async (e) => {
  e.preventDefault();

  if (!fotoNueva)    return avisar('Falta la foto del bache.');
  if (!coordsNuevas) return avisar('Falta la ubicación: marcala tocando el mapa.');

  const boton = e.target.querySelector('button[type="submit"]');
  boton.disabled = true;
  boton.textContent = 'Enviando…';

  try {
    const creado = await API.crearReporte({
      depto: deptoActual,
      lat: coordsNuevas.lat,
      lng: coordsNuevas.lng,
      referencia:  document.getElementById('f-referencia').value.trim(),
      descripcion: document.getElementById('f-desc').value.trim(),
      gravedad:    document.getElementById('f-gravedad').value,
      tamano:      document.getElementById('f-tamano').value,
      autor:       document.getElementById('f-autor').value.trim(),
      fotoBase64:  fotoNueva,
    });

    reportes.unshift(creado);
    render();
    limpiarFormulario();
    cerrar('modal-reporte');
    avisar('¡Reporte enviado! Ya lo puede ver cualquiera que entre.');
  } catch (error) {
    avisar(`No se pudo enviar: ${error.message}`);
  } finally {
    boton.disabled = false;
    boton.textContent = 'Enviar reporte';
  }
};

function limpiarFormulario() {
  document.getElementById('form-reporte').reset();
  fotoNueva = null;
  coordsNuevas = null;
  preview.hidden = true;
  preview.removeAttribute('src');
  zonaTexto.hidden = false;
  fotoInfo.textContent = '';
  document.getElementById('f-coords').value = '';

  if (marcaProvisional) mapa.removeLayer(marcaProvisional);
  if (miniMarca && miniMapa) miniMapa.removeLayer(miniMarca);
}

// ---------- Arranque ----------
(async function iniciar() {
  try {
    const lista = await API.departamentos();
    DEPARTAMENTOS = Object.fromEntries(lista.map(d => [d.codigo, d]));

    selectDepto.innerHTML = lista
      .map(d => `<option value="${d.codigo}">${esc(d.nombre)}</option>`)
      .join('');
    selectDepto.value = deptoActual;

    const d = DEPARTAMENTOS[deptoActual];
    if (d) mapa.setView([d.lat, d.lng], 13);
  } catch (error) {
    avisar(`No hay conexión con el servidor: ${error.message}`);
    return;
  }

  await traerReportes();
  dibujarAlcaldia();
})();
