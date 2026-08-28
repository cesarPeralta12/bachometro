// ============================================================
// Panel de administración.
//
// El token viaja en el header x-admin-token y se guarda en sessionStorage:
// al cerrar la pestaña se pierde, que es lo que se quiere en una máquina
// compartida. Nunca se guarda en localStorage ni en la URL.
// ============================================================

const CLAVE_TOKEN = 'bachometro_admin_token';

let token       = sessionStorage.getItem(CLAVE_TOKEN) || '';
let reportes    = [];
let deptos      = [];
let seleccion   = new Set();
let editandoId  = null;
let alConfirmar = null;   // qué hacer si el usuario confirma el borrado
let plan        = [];     // ítems del plan de bacheo
let alcaldias   = {};     // depto -> alcaldía
let detalleR    = null;   // bache abierto en el modal de detalle
let planEditando = null;  // ítem del plan que se está editando

const ETIQUETAS_ESTADO = {
  reportado: 'Reportado', verificado: 'Verificado',
  en_progreso: 'En progreso', reparado: 'Reparado',
};
const ETIQUETAS_GRAVEDAD = {
  leve: 'Leve', moderado: 'Moderado', grave: 'Grave', critico: 'Crítico',
};
const ETIQUETAS_PLAN = {
  pendiente: 'Pendiente', en_ruta: 'En camino',
  arreglando: 'Arreglando', ejecutado: 'Solucionado',
  cancelado: 'Cancelado',
};

// ---------- Utilidades ----------
function esc(texto) {
  return String(texto ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function pesoLegible(bytes) {
  if (!bytes) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function avisar(mensaje) {
  const caja = document.getElementById('aviso');
  caja.textContent = mensaje;
  caja.classList.remove('oculto');
  clearTimeout(avisar.reloj);
  avisar.reloj = setTimeout(() => caja.classList.add('oculto'), 3500);
}

function abrir(id)  { document.getElementById(id).classList.remove('oculto'); }
function cerrar(id) { document.getElementById(id).classList.add('oculto'); }

// Toda petición del panel pasa por acá, para no repetir el header del token.
async function pedir(ruta, opciones = {}) {
  const respuesta = await fetch(ruta, {
    ...opciones,
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': token,
      ...(opciones.headers || {}),
    },
  });

  if (respuesta.status === 401) {
    cerrarSesion();
    throw new Error('La sesión ya no es válida.');
  }
  if (!respuesta.ok) {
    const detalle = await respuesta.json().catch(() => ({}));
    throw new Error(detalle.error || `Error ${respuesta.status}`);
  }
  return respuesta.json();
}

// ---------- Acceso ----------
document.getElementById('form-acceso').onsubmit = async (e) => {
  e.preventDefault();
  const error = document.getElementById('error-acceso');
  error.textContent = '';

  const intento = document.getElementById('f-token').value;

  try {
    // Acá no se usa `pedir`: esa función interpreta un 401 como "se te vencció
    // la sesión" y desloguea. En el login, un 401 significa otra cosa —
    // el token está mal — y hay que decirlo así.
    const respuesta = await fetch('/api/admin/sesion', {
      headers: { 'x-admin-token': intento },
    });

    if (!respuesta.ok) {
      const detalle = await respuesta.json().catch(() => ({}));
      error.textContent = detalle.error || `Error ${respuesta.status}`;
      return;
    }

    token = intento;
    sessionStorage.setItem(CLAVE_TOKEN, token);
    await entrar();
  } catch (problema) {
    error.textContent = `No hay conexión con el servidor: ${problema.message}`;
  }
};

function cerrarSesion() {
  token = '';
  sessionStorage.removeItem(CLAVE_TOKEN);
  document.getElementById('panel').classList.add('oculto');
  document.getElementById('pantalla-acceso').classList.remove('oculto');
  document.getElementById('f-token').value = '';
}

document.getElementById('btn-salir').onclick = cerrarSesion;

async function entrar() {
  document.getElementById('pantalla-acceso').classList.add('oculto');
  document.getElementById('panel').classList.remove('oculto');

  deptos = await pedir('/api/departamentos');
  document.getElementById('filtro-depto').innerHTML =
    '<option value="">Todos los departamentos</option>' +
    deptos.map(d => `<option value="${d.codigo}">${esc(d.nombre)}</option>`).join('');

  document.getElementById('plan-depto').innerHTML =
    '<option value="">Todos los departamentos</option>' +
    deptos.map(d => `<option value="${d.codigo}">${esc(d.nombre)}</option>`).join('');

  // La pestaña de rutas siempre mira un departamento a la vez: las cuadrillas
  // y la alcaldía son de uno solo, mezclarlas no tendría sentido.
  const opcionesDepto = deptos.map(d => `<option value="${d.codigo}">${esc(d.nombre)}</option>`).join('');

  const selectorRutas = document.getElementById('rutas-depto');
  selectorRutas.innerHTML = opcionesDepto;
  selectorRutas.value = deptoRutas;

  const selectorCuadrilla = document.getElementById('cua-depto');
  selectorCuadrilla.innerHTML = opcionesDepto;
  selectorCuadrilla.value = deptoCuadrilla;

  const lista = await pedir('/api/alcaldias');
  alcaldias = Object.fromEntries(lista.map(a => [a.depto, a]));

  // El plan se carga de entrada aunque la pestaña esté cerrada: la tabla de
  // reportes necesita saber qué baches ya están programados.
  // Las cuadrillas se cargan de entrada porque el formulario del plan las
  // necesita, aunque nunca se abra la pestaña de rutas.
  cuadrillas = await pedir('/api/admin/cuadrillas');

  await Promise.all([cargarResumen(), cargarReportes(), cargarPlan()]);
}

// ---------- Pestañas ----------
document.querySelectorAll('.pestana').forEach(boton => {
  boton.onclick = () => {
    document.querySelectorAll('.pestana').forEach(b => b.classList.remove('activa'));
    boton.classList.add('activa');

    for (const vista of ['resumen', 'reportes', 'plan', 'rutas', 'cuadrilla', 'fotos']) {
      document.getElementById(`vista-${vista}`)
        .classList.toggle('oculto', vista !== boton.dataset.vista);
    }

    if (boton.dataset.vista === 'resumen') cargarResumen();
    if (boton.dataset.vista === 'plan')    cargarPlan();
    if (boton.dataset.vista === 'rutas')   cargarRutas();
    if (boton.dataset.vista === 'cuadrilla') cargarCuadrilla();
    if (boton.dataset.vista === 'fotos')   cargarFotos();
  };
});

// ---------- Resumen ----------
async function cargarResumen() {
  try {
    const datos = await pedir('/api/admin/resumen');

    document.getElementById('r-total').textContent   = datos.total;
    document.getElementById('r-semana').textContent  = datos.ultimos_7_dias;
    document.getElementById('r-votos').textContent   = datos.votos;
    document.getElementById('r-fotos').textContent   = datos.fotosEnDisco;
    document.getElementById('r-disco').textContent   = pesoLegible(datos.bytesEnDisco);

    dibujarBarras('grafico-estado',
      Object.entries(datos.porEstado).map(([c, v]) => [ETIQUETAS_ESTADO[c] || c, v]));
    dibujarBarras('grafico-gravedad',
      Object.entries(datos.porGravedad).map(([c, v]) => [ETIQUETAS_GRAVEDAD[c] || c, v]));
    dibujarBarras('grafico-depto',
      datos.porDepto.map(d => [d.nombre, d.cantidad]));
  } catch (error) {
    avisar(error.message);
  }
}

// Barras horizontales proporcionales al valor más alto de la serie.
function dibujarBarras(id, pares) {
  const caja = document.getElementById(id);
  const maximo = Math.max(1, ...pares.map(([, v]) => v));

  caja.innerHTML = pares.length
    ? pares.map(([etiqueta, valor]) => `
        <div class="barra-fila">
          <span>${esc(etiqueta)}</span>
          <div class="barra-pista">
            <div class="barra-relleno" style="width:${(valor / maximo) * 100}%"></div>
          </div>
          <span class="barra-valor">${valor}</span>
        </div>
      `).join('')
    : '<p class="ayuda">Sin datos todavía.</p>';
}

// ---------- Reportes ----------
function parametrosFiltro() {
  const p = new URLSearchParams();
  const depto    = document.getElementById('filtro-depto').value;
  const estado   = document.getElementById('filtro-estado').value;
  const gravedad = document.getElementById('filtro-gravedad').value;
  const fuente   = document.getElementById('filtro-fuente').value;
  const q        = document.getElementById('filtro-busqueda').value.trim();

  if (depto)    p.set('depto', depto);
  if (estado)   p.set('estado', estado);
  if (gravedad) p.set('gravedad', gravedad);
  if (fuente)   p.set('fuente', fuente);
  if (q)        p.set('q', q);
  return p;
}

async function cargarReportes() {
  try {
    reportes = await pedir(`/api/admin/reportes?${parametrosFiltro()}`);
    seleccion.clear();
    dibujarTabla();
  } catch (error) {
    avisar(error.message);
  }
}

function dibujarTabla() {
  const cuerpo = document.getElementById('cuerpo-tabla');
  document.getElementById('conteo-tabla').textContent = `${reportes.length} reportes`;

  if (!reportes.length) {
    cuerpo.innerHTML = '<tr><td colspan="9" class="tabla-vacia">No hay reportes con estos filtros.</td></tr>';
    actualizarSeleccion();
    return;
  }

  const nombreDepto = Object.fromEntries(deptos.map(d => [d.codigo, d.nombre]));

  cuerpo.innerHTML = reportes.map(r => `
    <tr data-id="${r.id}" class="${seleccion.has(r.id) ? 'seleccionada' : ''}">
      <td><input type="checkbox" class="marcar" data-id="${r.id}" ${seleccion.has(r.id) ? 'checked' : ''}></td>
      <td>
        ${r.foto_url
          ? `<img class="foto-celda" src="${esc(r.foto_url)}" alt="" loading="lazy" data-ver="${esc(r.foto_url)}">`
          : '<div class="foto-celda-vacia">sin<br>foto</div>'}
      </td>
      <td>
        <div class="celda-titulo">${esc(r.referencia)}</div>
        <div class="celda-sub">${esc(r.descripcion).slice(0, 70) || '—'}</div>
        <div class="celda-sub">por ${esc(r.autor)}</div>
      </td>
      <td>${esc(nombreDepto[r.depto] || r.depto)}</td>
      <td><i class="punto ${r.gravedad}"></i> ${ETIQUETAS_GRAVEDAD[r.gravedad]}</td>
      <td>
        <select class="cambiar-estado" data-id="${r.id}">
          ${Object.entries(ETIQUETAS_ESTADO).map(([valor, etiqueta]) =>
            `<option value="${valor}" ${r.estado === valor ? 'selected' : ''}>${etiqueta}</option>`
          ).join('')}
        </select>
      </td>
      <td>👍 ${r.votos}</td>
      <td>${r.fecha}</td>
      <td>
        <div class="acciones-fila">
          <button class="icono" data-detalle="${r.id}" title="Ver detalle y ruta">🗺️</button>
          <button class="icono" data-planificar="${r.id}" title="Agregar al plan de bacheo">📋</button>
          <button class="icono" data-editar="${r.id}" title="Editar">✏️</button>
          <button class="icono peligro" data-borrar="${r.id}" title="Borrar">🗑</button>
        </div>
      </td>
    </tr>
  `).join('');

  actualizarSeleccion();
}

// Un solo listener para toda la tabla: las filas se redibujan seguido y así
// no hay que volver a enganchar eventos en cada celda.
document.getElementById('cuerpo-tabla').addEventListener('click', (e) => {
  const ver = e.target.dataset.ver;
  if (ver) return mostrarVisor(ver);

  const detalle = e.target.dataset.detalle;
  if (detalle) return abrirDetalle(Number(detalle));

  const planificar = e.target.dataset.planificar;
  if (planificar) return abrirFormularioPlan(reportes.find(x => x.id === Number(planificar)));

  const editar = e.target.dataset.editar;
  if (editar) return abrirEditor(Number(editar));

  const borrar = e.target.dataset.borrar;
  if (borrar) {
    const r = reportes.find(x => x.id === Number(borrar));
    return pedirConfirmacion(
      `Se va a borrar el reporte "${r.referencia}" y su foto.`,
      async () => {
        await pedir(`/api/reportes/${borrar}`, { method: 'DELETE' });
        avisar('Reporte borrado.');
        await Promise.all([cargarReportes(), cargarResumen()]);
      }
    );
  }

  if (e.target.classList.contains('marcar')) {
    const id = Number(e.target.dataset.id);
    if (e.target.checked) seleccion.add(id); else seleccion.delete(id);
    e.target.closest('tr').classList.toggle('seleccionada', e.target.checked);
    actualizarSeleccion();
  }
});

document.getElementById('cuerpo-tabla').addEventListener('change', async (e) => {
  if (!e.target.classList.contains('cambiar-estado')) return;

  const id = Number(e.target.dataset.id);
  const estado = e.target.value;

  try {
    await pedir(`/api/reportes/${id}/estado`, {
      method: 'PATCH',
      body: JSON.stringify({ estado }),
    });
    const r = reportes.find(x => x.id === id);
    if (r) r.estado = estado;
    avisar(`Estado cambiado a "${ETIQUETAS_ESTADO[estado]}".`);
    cargarResumen();
  } catch (error) {
    avisar(error.message);
    cargarReportes();
  }
});

// ---------- Selección múltiple ----------
function actualizarSeleccion() {
  const cantidad = seleccion.size;
  document.getElementById('conteo-seleccion').textContent = `${cantidad} seleccionados`;
  document.getElementById('btn-borrar-lote').disabled = cantidad === 0;
  document.getElementById('marcar-todos').checked =
    cantidad > 0 && cantidad === reportes.length;
}

document.getElementById('marcar-todos').onchange = (e) => {
  seleccion = e.target.checked ? new Set(reportes.map(r => r.id)) : new Set();
  dibujarTabla();
};

document.getElementById('btn-borrar-lote').onclick = () => {
  pedirConfirmacion(
    `Se van a borrar ${seleccion.size} reportes con sus fotos.`,
    async () => {
      const resultado = await pedir('/api/admin/reportes/borrar', {
        method: 'POST',
        body: JSON.stringify({ ids: [...seleccion] }),
      });
      avisar(`${resultado.borrados} reportes borrados.`);
      await Promise.all([cargarReportes(), cargarResumen()]);
    }
  );
};

// ---------- Filtros ----------
['filtro-depto', 'filtro-estado', 'filtro-gravedad', 'filtro-fuente'].forEach(id => {
  document.getElementById(id).onchange = cargarReportes;
});

let relojBusqueda = null;
document.getElementById('filtro-busqueda').oninput = () => {
  clearTimeout(relojBusqueda);
  relojBusqueda = setTimeout(cargarReportes, 300);
};

document.getElementById('btn-recargar').onclick = () => {
  cargarReportes();
  cargarResumen();
};

// ---------- Editor ----------
function abrirEditor(id) {
  const r = reportes.find(x => x.id === id);
  if (!r) return;

  editandoId = id;
  document.getElementById('e-id').textContent = `#${id}`;
  document.getElementById('e-referencia').value  = r.referencia;
  document.getElementById('e-descripcion').value = r.descripcion;
  document.getElementById('e-autor').value       = r.autor;
  document.getElementById('e-gravedad').value    = r.gravedad;
  document.getElementById('e-tamano').value      = r.tamano;
  document.getElementById('e-estado').value      = r.estado;
  document.getElementById('e-fuente').value      = r.fuente;

  const foto = document.getElementById('e-foto');
  if (r.foto_url) { foto.src = r.foto_url; foto.hidden = false; }
  else            { foto.removeAttribute('src'); foto.hidden = true; }

  document.getElementById('btn-borrar-foto').hidden = !r.foto_url;
  abrir('modal-editar');
}

document.getElementById('form-editar').onsubmit = async (e) => {
  e.preventDefault();

  try {
    await pedir(`/api/reportes/${editandoId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        referencia:  document.getElementById('e-referencia').value,
        descripcion: document.getElementById('e-descripcion').value,
        autor:       document.getElementById('e-autor').value,
        gravedad:    document.getElementById('e-gravedad').value,
        tamano:      document.getElementById('e-tamano').value,
        estado:      document.getElementById('e-estado').value,
        fuente:      document.getElementById('e-fuente').value,
      }),
    });
    cerrar('modal-editar');
    avisar('Cambios guardados.');
    await Promise.all([cargarReportes(), cargarResumen()]);
  } catch (error) {
    avisar(error.message);
  }
};

document.getElementById('btn-borrar-foto').onclick = () => {
  const id = editandoId;
  pedirConfirmacion('Se va a borrar la foto. El reporte queda sin imagen.', async () => {
    await pedir(`/api/reportes/${id}/foto`, { method: 'DELETE' });
    cerrar('modal-editar');
    avisar('Foto borrada.');
    await Promise.all([cargarReportes(), cargarResumen()]);
  });
};

// ---------- Fotos ----------
async function cargarFotos() {
  try {
    const todos = await pedir('/api/admin/reportes');
    const conFoto = todos.filter(r => r.foto_url);
    const galeria = document.getElementById('galeria');

    galeria.innerHTML = conFoto.length
      ? conFoto.map(r => `
          <div class="foto-caja">
            <img src="${esc(r.foto_url)}" alt="" loading="lazy" data-ver="${esc(r.foto_url)}">
            <div class="foto-pie">
              <strong>${esc(r.referencia).slice(0, 40)}</strong>
              <div class="fila-pie">
                <span>${r.fecha}</span>
                <button class="icono peligro" data-quitar="${r.id}" title="Borrar foto">🗑</button>
              </div>
            </div>
          </div>
        `).join('')
      : '<p class="ayuda">Todavía no hay fotos cargadas.</p>';

    const huerfanas = await pedir('/api/admin/fotos-huerfanas');
    const caja = document.getElementById('huerfanas');
    caja.innerHTML = huerfanas.length
      ? huerfanas.map(h => `<span class="huerfana">${esc(h.archivo)} · ${pesoLegible(h.bytes)}</span>`).join('')
      : '<p class="ayuda">No hay fotos huérfanas. Todo limpio.</p>';

    document.getElementById('btn-limpiar-huerfanas').disabled = !huerfanas.length;
  } catch (error) {
    avisar(error.message);
  }
}

document.getElementById('galeria').addEventListener('click', (e) => {
  const ver = e.target.dataset.ver;
  if (ver) return mostrarVisor(ver);

  const quitar = e.target.dataset.quitar;
  if (quitar) {
    pedirConfirmacion('Se va a borrar la foto de este reporte.', async () => {
      await pedir(`/api/reportes/${quitar}/foto`, { method: 'DELETE' });
      avisar('Foto borrada.');
      await Promise.all([cargarFotos(), cargarResumen()]);
    });
  }
});

document.getElementById('btn-limpiar-huerfanas').onclick = () => {
  pedirConfirmacion('Se van a borrar del disco todas las fotos sin reporte.', async () => {
    const resultado = await pedir('/api/admin/fotos-huerfanas/borrar', { method: 'POST' });
    avisar(`${resultado.borradas} archivos borrados.`);
    await Promise.all([cargarFotos(), cargarResumen()]);
  });
};

// ---------- Visor de foto ----------
function mostrarVisor(url) {
  const visor = document.createElement('div');
  visor.className = 'visor';
  visor.innerHTML = `<img src="${esc(url)}" alt="">`;
  visor.onclick = () => visor.remove();
  document.body.appendChild(visor);
}

// ---------- Confirmación ----------
function pedirConfirmacion(mensaje, accion) {
  document.getElementById('c-mensaje').textContent = mensaje;
  alConfirmar = accion;
  abrir('modal-confirmar');
}

document.getElementById('btn-confirmar').onclick = async (e) => {
  const boton = e.currentTarget;
  boton.disabled = true;

  try {
    await alConfirmar?.();
    cerrar('modal-confirmar');
  } catch (error) {
    avisar(error.message);
  } finally {
    boton.disabled = false;
    alConfirmar = null;
  }
};

// ---------- Modales ----------
document.querySelectorAll('[data-cerrar]').forEach(b => {
  b.onclick = () => cerrar(b.dataset.cerrar);
});

document.querySelectorAll('.modal').forEach(m => {
  m.onclick = (e) => { if (e.target === m) cerrar(m.id); };
});

document.onkeydown = (e) => {
  if (e.key !== 'Escape') return;
  document.querySelector('.visor')?.remove();
  document.querySelectorAll('.modal').forEach(m => cerrar(m.id));
};

// ---------- Arranque ----------
// Si hay un token de una pestaña anterior, se valida antes de mostrar el panel.
(async function iniciar() {
  if (!token) return;
  try {
    await pedir('/api/admin/sesion');
    await entrar();
  } catch {
    cerrarSesion();
  }
})();
