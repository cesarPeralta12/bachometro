// ============================================================
// Vista de cuadrilla: la orden de trabajo.
//
// Es la pantalla del que va a tapar el bache, no la del que planifica. Por eso
// muestra una cosa a la vez, con la foto grande y botones grandes: se usa
// desde el celular, parado en la calle.
//
// Los tres botones son el avance real del trabajo:
//   🚚 En camino  →  🔧 Arreglando  →  ✅ Solucionado
// Cada uno mueve también el bache en el mapa público.
// ============================================================

let ordenes        = [];
let ordenElegida   = null;
let cuadrillaId    = null;
let deptoCuadrilla = 'scz';
let mapaOrden      = null;
let capasOrden     = [];

// Qué se puede hacer desde cada estado. La cuadrilla no puede saltar de
// "pendiente" a "solucionado" sin pasar por el medio: si el trabajo se hizo
// sin avisar, igual hay que marcar los pasos, que es lo que deja el registro.
const PASOS = {
  pendiente:  ['en_ruta'],
  en_ruta:    ['arreglando'],
  arreglando: ['ejecutado'],
  ejecutado:  [],
  cancelado:  [],
};

const BOTONES = {
  en_ruta:    { texto: '🚚 Voy en camino',      clase: 'paso-camino' },
  arreglando: { texto: '🔧 Estoy arreglando',   clase: 'paso-arreglando' },
  ejecutado:  { texto: '✅ Bache solucionado',  clase: 'paso-solucionado' },
};

const LINEA_DE_TIEMPO = [
  { estado: 'pendiente',  etiqueta: 'Asignado' },
  { estado: 'en_ruta',    etiqueta: 'En camino' },
  { estado: 'arreglando', etiqueta: 'Arreglando' },
  { estado: 'ejecutado',  etiqueta: 'Solucionado' },
];

// ---------- Carga ----------
async function cargarCuadrilla() {
  try {
    const propias = await pedir(`/api/admin/cuadrillas?depto=${deptoCuadrilla}`);

    const selector = document.getElementById('cua-cuadrilla');
    selector.innerHTML = propias.length
      ? propias.map(c => `<option value="${c.id}">${esc(c.nombre)}</option>`).join('')
      : '<option value="">No hay cuadrillas en este departamento</option>';

    // Si la cuadrilla elegida no es de este departamento, se elige otra. Se
    // prefiere una que tenga trabajo pendiente: abrir la pestaña en una
    // cuadrilla vacía hace parecer que no hay órdenes cuando sí las hay.
    if (!propias.some(c => c.id === cuadrillaId)) {
      const conTrabajo = propias.find(c => c.trabajos_abiertos > 0);
      cuadrillaId = (conTrabajo ?? propias[0])?.id ?? null;
    }
    selector.value = cuadrillaId ?? '';

    await cargarOrdenes();
  } catch (error) {
    avisar(error.message);
  }
}

async function cargarOrdenes() {
  if (!cuadrillaId) {
    ordenes = [];
    dibujarOrdenes();
    return;
  }

  try {
    const todas = await pedir(`/api/admin/plan?depto=${deptoCuadrilla}&cuadrilla=${cuadrillaId}`);
    const verTerminadas = document.getElementById('cua-terminadas').checked;

    // Por defecto solo el trabajo que queda por hacer: es lo que le sirve a
    // la cuadrilla cuando sale a la calle.
    ordenes = verTerminadas
      ? todas
      : todas.filter(o => o.estado !== 'ejecutado' && o.estado !== 'cancelado');

    dibujarOrdenes();

    // La orden abierta se refresca con los datos nuevos. Se la busca en la
    // lista completa y no en la filtrada: al marcar un bache como solucionado
    // sale de la lista de pendientes, y vaciar la pantalla justo ahí dejaría
    // a la cuadrilla sin ver que su trabajo quedó registrado.
    if (ordenElegida) {
      const actual = todas.find(o => o.id === ordenElegida.id);
      if (actual) mostrarOrden(actual);
      else limpiarOrden();
    }
  } catch (error) {
    avisar(error.message);
  }
}

function dibujarOrdenes() {
  const ul = document.getElementById('cua-lista');
  document.getElementById('cua-conteo').textContent = `(${ordenes.length})`;

  if (!ordenes.length) {
    ul.innerHTML = `<li class="ayuda">
      Esta cuadrilla no tiene trabajo asignado. Se asigna desde
      <strong>Plan de bacheo</strong>, editando el trabajo con ✏️.
    </li>`;
    return;
  }

  ul.innerHTML = ordenes.map(o => `
    <li class="orden-item ${ordenElegida?.id === o.id ? 'elegido' : ''} ${o.estado}"
        data-orden="${o.id}">
      <div class="orden-item-cabecera">
        <span class="prioridad p${o.prioridad}">${o.prioridad}</span>
        <strong>${esc(o.referencia)}</strong>
      </div>
      <div class="celda-sub">
        <span class="chip ${o.estado}">${ETIQUETAS_PLAN[o.estado]}</span>
        ${o.fecha_programada || 'sin fecha'}
      </div>
    </li>
  `).join('');
}

function limpiarOrden() {
  ordenElegida = null;
  document.getElementById('cua-orden').innerHTML =
    '<p class="ayuda orden-vacia">Elegí una orden de la lista para verla.</p>';
}

// ---------- La orden ----------
function mostrarOrden(o) {
  ordenElegida = o;
  const siguientes = PASOS[o.estado] ?? [];

  document.getElementById('cua-orden').innerHTML = `
    <header class="orden-cabecera">
      <div>
        <span class="orden-numero">Orden #${o.id}</span>
        <h2>${esc(o.referencia)}</h2>
      </div>
      <span class="chip ${o.estado}">${ETIQUETAS_PLAN[o.estado]}</span>
    </header>

    ${dibujarLineaDeTiempo(o.estado)}

    <div class="orden-columnas">
      <div>
        ${o.foto_url
          ? `<img class="orden-foto" src="${esc(o.foto_url)}" alt="Foto del bache" data-ver="${esc(o.foto_url)}">`
          : '<div class="orden-sin-foto">El vecino no adjuntó foto</div>'}

        <dl class="orden-datos">
          <div><dt>Gravedad</dt><dd><i class="punto ${o.gravedad}"></i> ${ETIQUETAS_GRAVEDAD[o.gravedad]}</dd></div>
          <div><dt>Tamaño</dt><dd>${esc(o.tamano)}</dd></div>
          <div><dt>Prioridad</dt><dd><span class="prioridad p${o.prioridad}">${o.prioridad}</span></dd></div>
          <div><dt>Programado</dt><dd>${o.fecha_programada || 'sin fecha'}</dd></div>
          <div><dt>Desde la alcaldía</dt><dd>${metrosLegibles(o.distancia_m)}</dd></div>
          <div><dt>Viaje estimado</dt><dd>${minutosLegibles(o.duracion_s) || '—'}</dd></div>
        </dl>

        ${o.descripcion ? `
          <div class="orden-bloque">
            <dt>Lo que reportó el vecino</dt>
            <p>${esc(o.descripcion)}</p>
          </div>` : ''}

        ${o.notas ? `
          <div class="orden-bloque orden-notas">
            <dt>📝 Indicaciones de la alcaldía</dt>
            <p>${esc(o.notas)}</p>
          </div>` : ''}
      </div>

      <div>
        <div id="mapa-orden" class="mapa-orden"></div>
        <a class="btn-secundario boton-navegar" target="_blank" rel="noopener noreferrer"
           href="https://www.google.com/maps/dir/${o.alcaldia_lat},${o.alcaldia_lng}/${o.lat},${o.lng}">
          🧭 Navegar hasta el bache
        </a>
      </div>
    </div>

    <div class="orden-acciones">
      ${siguientes.map(estado => `
        <button class="paso ${BOTONES[estado].clase}" data-avanzar="${estado}">
          ${BOTONES[estado].texto}
        </button>
      `).join('')}

      ${o.estado === 'ejecutado'
        ? '<p class="orden-listo">✅ Este bache ya quedó solucionado.</p>' : ''}
      ${o.estado === 'cancelado'
        ? '<p class="ayuda">Este trabajo fue cancelado por la alcaldía.</p>' : ''}
      ${o.estado !== 'ejecutado' && o.estado !== 'cancelado'
        ? '<button class="btn-secundario" data-avanzar="cancelado">No se pudo hacer</button>' : ''}
    </div>
  `;

  dibujarOrdenes();
  dibujarMapaDeLaOrden(o);
}

// Muestra en qué punto del trabajo está, con los pasos ya cumplidos marcados.
function dibujarLineaDeTiempo(estado) {
  if (estado === 'cancelado') return '';

  const actual = LINEA_DE_TIEMPO.findIndex(p => p.estado === estado);

  return `
    <ol class="linea-tiempo">
      ${LINEA_DE_TIEMPO.map((paso, i) => `
        <li class="${i < actual ? 'hecho' : i === actual ? 'actual' : 'pendiente'}">
          <span class="punto-tiempo">${i < actual ? '✓' : i + 1}</span>
          ${paso.etiqueta}
        </li>
      `).join('')}
    </ol>
  `;
}

async function dibujarMapaDeLaOrden(o) {
  if (!mapaOrden) {
    mapaOrden = L.map('mapa-orden');
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap', maxZoom: 19,
    }).addTo(mapaOrden);
  } else {
    // El contenedor se volvió a crear con el innerHTML: hay que remontarlo.
    const nuevo = document.getElementById('mapa-orden');
    if (mapaOrden.getContainer() !== nuevo) {
      mapaOrden.remove();
      mapaOrden = L.map('mapa-orden');
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap', maxZoom: 19,
      }).addTo(mapaOrden);
      capasOrden = [];
    }
  }

  capasOrden.forEach(c => mapaOrden.removeLayer(c));
  capasOrden = [];

  const color = o.cuadrilla_color || '#ff6b35';
  mapaOrden.setView([o.lat, o.lng], 16);
  setTimeout(() => mapaOrden.invalidateSize(), 80);

  capasOrden.push(
    L.marker([o.lat, o.lng], { icon: iconoCuadrilla(color) })
      .addTo(mapaOrden).bindPopup(esc(o.referencia))
  );

  if (!o.alcaldia_lat) return;

  capasOrden.push(
    L.marker([o.alcaldia_lat, o.alcaldia_lng], { icon: ICONO_SEDE })
      .addTo(mapaOrden).bindPopup('Salida')
  );

  try {
    const p = new URLSearchParams({
      desdeLat: o.alcaldia_lat, desdeLng: o.alcaldia_lng,
      hastaLat: o.lat, hastaLng: o.lng,
    });
    const ruta = await (await fetch(`/api/ruta?${p}`)).json();

    const linea = L.polyline(ruta.geometria, { color, weight: 5, opacity: 0.85 }).addTo(mapaOrden);
    capasOrden.push(linea);
    mapaOrden.fitBounds(linea.getBounds(), { padding: [30, 30] });
  } catch {
    // Sin ruta el mapa igual sirve: el bache está marcado.
  }
}

// ---------- Avance del trabajo ----------
document.getElementById('cua-orden').addEventListener('click', async (e) => {
  const ver = e.target.dataset.ver;
  if (ver) return mostrarVisor(ver);

  const estado = e.target.dataset.avanzar;
  if (!estado || !ordenElegida) return;

  const boton = e.target;
  boton.disabled = true;

  try {
    await pedir(`/api/admin/plan/${ordenElegida.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ estado }),
    });

    const mensajes = {
      en_ruta:    'Marcado en camino. El vecino ya lo ve como "En progreso".',
      arreglando: 'Marcado como en reparación.',
      ejecutado:  '¡Bache solucionado! Quedó como "Reparado" en el mapa.',
      cancelado:  'Trabajo marcado como no realizado.',
    };
    avisar(mensajes[estado]);

    await cargarOrdenes();
    // El resto del panel también refleja el cambio.
    cargarResumen();
    cargarReportes();
  } catch (error) {
    boton.disabled = false;
    avisar(error.message);
  }
});

// ---------- Interacción ----------
document.getElementById('cua-lista').addEventListener('click', (e) => {
  const fila = e.target.closest('[data-orden]');
  if (!fila) return;

  const orden = ordenes.find(o => o.id === Number(fila.dataset.orden));
  if (orden) mostrarOrden(orden);
});

document.getElementById('cua-depto').onchange = (e) => {
  deptoCuadrilla = e.target.value;
  limpiarOrden();
  cargarCuadrilla();
};

document.getElementById('cua-cuadrilla').onchange = (e) => {
  cuadrillaId = Number(e.target.value) || null;
  limpiarOrden();
  cargarOrdenes();
};

document.getElementById('cua-terminadas').onchange = cargarOrdenes;
document.getElementById('cua-recargar').onclick = () => cargarCuadrilla();
