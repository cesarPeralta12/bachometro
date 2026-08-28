// ============================================================
// Ruta de bacheo: el mapa operativo de la alcaldía.
//
// Cada trabajo programado se dibuja desde la alcaldía hasta el bache, con el
// color de la cuadrilla que lo tiene a cargo. Sirve para mostrar de un vistazo
// qué se aceptó, a quién se le asignó y por dónde va cada cuadrilla.
// ============================================================

let cuadrillas      = [];
let trabajos        = [];
let mapaRutas       = null;
let capasRuta       = [];   // polilíneas y marcadores dibujados
let trabajoElegido  = null;
let deptoRutas      = 'scz';

// Las rutas ya calculadas se guardan acá: cambiar de trabajo y volver no
// vuelve a pedirlas, y "mostrar todas" no dispara una tormenta de peticiones.
const rutasEnMemoria = new Map();

const ICONO_SEDE = L.divIcon({
  className: 'icono-alcaldia',
  html: '<div class="pin-alcaldia">🏛️</div>',
  iconSize: [34, 34],
  iconAnchor: [17, 17],
});

function iconoCuadrilla(color) {
  return L.divIcon({
    className: 'icono-bache-ruta',
    html: `<div class="pin-bache" style="border-color:${color}">🕳️</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

const COLOR_SIN_ASIGNAR = '#9aa3b2';

// ---------- Carga ----------
async function cargarRutas() {
  try {
    [cuadrillas, trabajos] = await Promise.all([
      pedir(`/api/admin/cuadrillas?depto=${deptoRutas}`),
      pedir(`/api/admin/plan?depto=${deptoRutas}`),
    ]);

    dibujarLeyenda();
    dibujarListaTrabajos();
    prepararMapaRutas();
  } catch (error) {
    avisar(error.message);
  }
}

function dibujarLeyenda() {
  const ul = document.getElementById('rutas-leyenda');

  ul.innerHTML = cuadrillas.length
    ? cuadrillas.map(c => `
        <li class="leyenda-item">
          <input type="color" value="${c.color}" data-color-de="${c.id}" title="Cambiar color">
          <div class="leyenda-texto">
            <strong>${esc(c.nombre)}</strong>
            <span class="celda-sub">${c.trabajos_abiertos} abiertos · ${c.trabajos_hechos} hechos</span>
          </div>
          <button class="icono peligro" data-borrar-cuadrilla="${c.id}" title="Borrar cuadrilla">✕</button>
        </li>
      `).join('')
    : '<li class="ayuda">Todavía no hay cuadrillas en este departamento.</li>';
}

function dibujarListaTrabajos() {
  const ul = document.getElementById('rutas-lista');

  if (!trabajos.length) {
    ul.innerHTML = `<li class="ayuda">
      No hay trabajos programados acá. Agregá baches al plan desde la pestaña
      <strong>Reportes</strong>, con el botón 📋.
    </li>`;
    return;
  }

  ul.innerHTML = trabajos.map(t => {
    const color = t.cuadrilla_color || COLOR_SIN_ASIGNAR;
    return `
      <li class="ruta-item ${trabajoElegido === t.id ? 'elegido' : ''}"
          data-trabajo="${t.id}" style="border-left-color:${color}">
        <div class="celda-titulo">${esc(t.referencia)}</div>
        <div class="celda-sub">
          <span class="chip ${t.estado}">${ETIQUETAS_PLAN[t.estado]}</span>
          ${t.fecha_programada || 'sin fecha'}
        </div>
        <div class="celda-sub" style="color:${color}">
          ${t.cuadrilla_nombre ? '● ' + esc(t.cuadrilla_nombre) : '○ sin cuadrilla asignada'}
        </div>
      </li>
    `;
  }).join('');
}

// ---------- Mapa ----------
function prepararMapaRutas() {
  if (!mapaRutas) {
    mapaRutas = L.map('mapa-rutas');
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 19,
    }).addTo(mapaRutas);
  }

  const sede = trabajos.find(t => t.alcaldia_lat) ||
               { alcaldia_lat: -17.7833, alcaldia_lng: -63.1821 };
  mapaRutas.setView([sede.alcaldia_lat, sede.alcaldia_lng], 13);

  setTimeout(() => mapaRutas.invalidateSize(), 80);

  if (document.getElementById('rutas-todas').checked) pintarTodas();
  else if (trabajoElegido) pintarUno(trabajos.find(t => t.id === trabajoElegido));
  else limpiarMapa();
}

function limpiarMapa() {
  capasRuta.forEach(c => mapaRutas.removeLayer(c));
  capasRuta = [];
}

async function traerRuta(t) {
  const clave = `${t.alcaldia_lat},${t.alcaldia_lng}->${t.lat},${t.lng}`;
  if (rutasEnMemoria.has(clave)) return rutasEnMemoria.get(clave);

  const p = new URLSearchParams({
    desdeLat: t.alcaldia_lat, desdeLng: t.alcaldia_lng,
    hastaLat: t.lat, hastaLng: t.lng,
  });
  const respuesta = await fetch(`/api/ruta?${p}`);
  if (!respuesta.ok) throw new Error(`Error ${respuesta.status}`);

  const ruta = await respuesta.json();
  rutasEnMemoria.set(clave, ruta);
  return ruta;
}

// Dibuja una ruta con el color de su cuadrilla. Los trabajos ya ejecutados
// van punteados: se ve que existieron, sin competir con los que están activos.
async function dibujarUna(t, { protagonista = false } = {}) {
  if (!t.alcaldia_lat) return null;

  const color = t.cuadrilla_color || COLOR_SIN_ASIGNAR;
  const ruta = await traerRuta(t);

  const linea = L.polyline(ruta.geometria, {
    color,
    weight: protagonista ? 6 : 4,
    opacity: protagonista ? 0.95 : 0.55,
    dashArray: t.estado === 'ejecutado' ? '6, 8' : (ruta.aproximada ? '10, 6' : null),
  }).addTo(mapaRutas);

  const marca = L.marker([t.lat, t.lng], { icon: iconoCuadrilla(color) })
    .addTo(mapaRutas)
    .bindPopup(`
      <div class="popup">
        <strong>${esc(t.referencia)}</strong>
        <div class="popup-meta">
          ${t.cuadrilla_nombre ? esc(t.cuadrilla_nombre) : 'Sin cuadrilla'} ·
          ${ETIQUETAS_PLAN[t.estado]}
        </div>
        <div class="popup-meta">${metrosLegibles(ruta.distanciaM)} desde la alcaldía</div>
      </div>
    `);

  capasRuta.push(linea, marca);
  return { linea, ruta };
}

function marcarSede(t) {
  if (!t?.alcaldia_lat) return;
  const sede = L.marker([t.alcaldia_lat, t.alcaldia_lng], { icon: ICONO_SEDE, zIndexOffset: 600 })
    .addTo(mapaRutas)
    .bindPopup(esc(t.alcaldia_nombre || 'Alcaldía'));
  capasRuta.push(sede);
}

async function pintarUno(t) {
  if (!t) return;
  limpiarMapa();

  const detalle = document.getElementById('rutas-detalle');
  detalle.textContent = 'Calculando la ruta…';

  try {
    marcarSede(t);
    const dibujado = await dibujarUna(t, { protagonista: true });
    if (!dibujado) {
      detalle.innerHTML = '<span class="aproximado">Este departamento no tiene alcaldía cargada.</span>';
      return;
    }

    mapaRutas.fitBounds(dibujado.linea.getBounds(), { padding: [40, 40] });

    const color = t.cuadrilla_color || COLOR_SIN_ASIGNAR;
    const tiempo = minutosLegibles(dibujado.ruta.duracionS);

    detalle.innerHTML = `
      <div class="detalle-ruta-cabecera">
        <span class="muestra-color" style="background:${color}"></span>
        <div>
          <strong>${esc(t.cuadrilla_nombre || 'Sin cuadrilla asignada')}</strong>
          <div class="celda-sub">va hacia ${esc(t.referencia)}</div>
        </div>
        <span class="chip ${t.estado}">${ETIQUETAS_PLAN[t.estado]}</span>
      </div>

      <div class="detalle-ruta-datos">
        <div><dt>Distancia</dt><dd>${metrosLegibles(dibujado.ruta.distanciaM)}</dd></div>
        <div><dt>Tiempo estimado</dt><dd>${tiempo || '—'}</dd></div>
        <div><dt>Programado</dt><dd>${t.fecha_programada || 'sin fecha'}</dd></div>
        <div><dt>Prioridad</dt><dd><span class="prioridad p${t.prioridad}">${t.prioridad}</span></dd></div>
      </div>

      <div class="detalle-ruta-acciones">
        ${t.estado === 'pendiente'
          ? `<button class="btn-primario" data-despachar="${t.id}">🚚 Mandar la cuadrilla</button>` : ''}
        ${t.estado === 'en_ruta'
          ? `<button class="btn-primario" data-terminar="${t.id}">✅ Marcar bacheo hecho</button>` : ''}
        ${t.estado === 'ejecutado'
          ? '<span class="ayuda">Trabajo terminado.</span>' : ''}
        <a class="btn-secundario" target="_blank" rel="noopener noreferrer"
           href="https://www.google.com/maps/dir/${t.alcaldia_lat},${t.alcaldia_lng}/${t.lat},${t.lng}">
          Abrir en Google Maps
        </a>
      </div>

      ${dibujado.ruta.aproximada
        ? '<span class="aproximado">⚠ Ruta aproximada: el servicio de ruteo no respondió.</span>' : ''}
    `;
  } catch (error) {
    detalle.innerHTML = `<span class="aproximado">No se pudo calcular la ruta: ${esc(error.message)}</span>`;
  }
}

async function pintarTodas() {
  limpiarMapa();
  const detalle = document.getElementById('rutas-detalle');

  const conAlcaldia = trabajos.filter(t => t.alcaldia_lat);
  if (!conAlcaldia.length) {
    detalle.innerHTML = '<span class="ayuda">No hay trabajos programados para mostrar.</span>';
    return;
  }

  detalle.textContent = `Calculando ${conAlcaldia.length} rutas…`;
  marcarSede(conAlcaldia[0]);

  const dibujadas = [];
  for (const t of conAlcaldia) {
    try { dibujadas.push(await dibujarUna(t)); } catch { /* una ruta que falla no corta el resto */ }
  }

  const validas = dibujadas.filter(Boolean);
  if (validas.length) {
    const grupo = L.featureGroup(validas.map(d => d.linea));
    mapaRutas.fitBounds(grupo.getBounds(), { padding: [40, 40] });
  }

  // Resumen por cuadrilla, que es lo que se muestra en una reunión.
  const porCuadrilla = new Map();
  conAlcaldia.forEach((t, i) => {
    const nombre = t.cuadrilla_nombre || 'Sin asignar';
    const actual = porCuadrilla.get(nombre) || {
      color: t.cuadrilla_color || COLOR_SIN_ASIGNAR, trabajos: 0, metros: 0,
    };
    actual.trabajos++;
    actual.metros += validas[i]?.ruta.distanciaM || 0;
    porCuadrilla.set(nombre, actual);
  });

  detalle.innerHTML = `
    <strong>${conAlcaldia.length} trabajos en el mapa</strong>
    <div class="resumen-cuadrillas">
      ${[...porCuadrilla].map(([nombre, d]) => `
        <div class="resumen-cuadrilla">
          <span class="muestra-color" style="background:${d.color}"></span>
          ${esc(nombre)} — ${d.trabajos} trabajo(s), ${metrosLegibles(d.metros)} en total
        </div>
      `).join('')}
    </div>
    <span class="celda-sub">Las rutas punteadas son trabajos ya ejecutados.</span>
  `;
}

// ---------- Interacción ----------
document.getElementById('rutas-lista').addEventListener('click', (e) => {
  const fila = e.target.closest('[data-trabajo]');
  if (!fila) return;

  trabajoElegido = Number(fila.dataset.trabajo);
  document.getElementById('rutas-todas').checked = false;
  dibujarListaTrabajos();
  pintarUno(trabajos.find(t => t.id === trabajoElegido));
});

// Cambiar el estado del trabajo desde el mapa: es el gesto de "aceptamos el
// bache y mandamos la cuadrilla", que era el punto de esta pantalla.
document.getElementById('rutas-detalle').addEventListener('click', async (e) => {
  const despachar = e.target.dataset.despachar;
  const terminar  = e.target.dataset.terminar;
  if (!despachar && !terminar) return;

  const id = Number(despachar || terminar);
  const estado = despachar ? 'en_ruta' : 'ejecutado';

  try {
    await pedir(`/api/admin/plan/${id}`, { method: 'PATCH', body: JSON.stringify({ estado }) });
    avisar(despachar ? 'Cuadrilla despachada. El bache figura "en progreso".'
                     : 'Bacheo terminado. El bache figura "reparado".');
    await cargarRutas();
    pintarUno(trabajos.find(t => t.id === id));
  } catch (error) {
    avisar(error.message);
  }
});

// ---------- Cuadrillas ----------
document.getElementById('rutas-leyenda').addEventListener('change', async (e) => {
  const id = e.target.dataset.colorDe;
  if (!id) return;

  try {
    await pedir(`/api/admin/cuadrillas/${id}`, {
      method: 'PATCH', body: JSON.stringify({ color: e.target.value }),
    });
    rutasEnMemoria.clear();
    await cargarRutas();
    avisar('Color actualizado.');
  } catch (error) {
    avisar(error.message);
  }
});

document.getElementById('rutas-leyenda').addEventListener('click', (e) => {
  const id = e.target.dataset.borrarCuadrilla;
  if (!id) return;

  const c = cuadrillas.find(x => x.id === Number(id));
  pedirConfirmacion(
    `Se borra "${c.nombre}". Sus ${c.trabajos_abiertos} trabajo(s) abierto(s) quedan sin cuadrilla asignada.`,
    async () => {
      await pedir(`/api/admin/cuadrillas/${id}`, { method: 'DELETE' });
      avisar('Cuadrilla borrada.');
      await cargarRutas();
    }
  );
});

document.getElementById('form-cuadrilla').onsubmit = async (e) => {
  e.preventDefault();

  try {
    await pedir('/api/admin/cuadrillas', {
      method: 'POST',
      body: JSON.stringify({
        depto: deptoRutas,
        nombre: document.getElementById('cu-nombre').value,
        color: document.getElementById('cu-color').value,
      }),
    });
    e.target.reset();
    document.getElementById('cu-color').value = '#22d3ee';
    avisar('Cuadrilla creada.');
    await cargarRutas();
  } catch (error) {
    avisar(error.message);
  }
};

// ---------- Controles ----------
document.getElementById('rutas-depto').onchange = (e) => {
  deptoRutas = e.target.value;
  trabajoElegido = null;
  cargarRutas();
};

document.getElementById('rutas-todas').onchange = (e) => {
  if (e.target.checked) {
    trabajoElegido = null;
    dibujarListaTrabajos();
    pintarTodas();
  } else {
    limpiarMapa();
    document.getElementById('rutas-detalle').textContent =
      'Elegí un trabajo de la lista para ver su ruta.';
  }
};

document.getElementById('rutas-recargar').onclick = () => {
  rutasEnMemoria.clear();
  cargarRutas();
};
