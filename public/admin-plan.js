// ============================================================
// Plan de bacheo y ruta desde la alcaldía.
//
// Vive aparte de admin.js porque es la parte que usa la alcaldía, no el
// moderador de contenido. Comparte con admin.js las funciones `pedir`,
// `esc`, `avisar`, `abrir`, `cerrar`, `pedirConfirmacion` y `mostrarVisor`.
// ============================================================

function metrosLegibles(m) {
  if (m == null) return '—';
  return m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`;
}

function minutosLegibles(s) {
  if (s == null) return null;
  const min = Math.round(s / 60);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

// ---------- Detalle del bache con la ruta ----------
let mapaRuta   = null;
let capaRuta   = null;
let marcasRuta = [];

const ICONO_ALCALDIA = L.divIcon({
  className: 'icono-alcaldia',
  html: '<div class="pin-alcaldia">🏛️</div>',
  iconSize: [34, 34],
  iconAnchor: [17, 17],
});

async function abrirDetalle(id) {
  const r = reportes.find(x => x.id === id) || plan.find(x => x.reporte_id === id);
  if (!r) return;

  detalleR = r;
  const alcaldia = alcaldias[r.depto];

  document.getElementById('v-titulo').textContent = r.referencia;

  const foto = document.getElementById('v-foto');
  if (r.foto_url) {
    foto.src = r.foto_url;
    foto.hidden = false;
  } else {
    foto.removeAttribute('src');
    foto.hidden = true;
  }

  // Ojo: en una fila del plan, `estado` es el estado del TRABAJO y el del bache
  // viene en `estado_reporte`. En una fila de la tabla de reportes solo existe
  // `estado`. Por eso se prefiere `estado_reporte` cuando está.
  const estadoBache = r.estado_reporte ?? r.estado;

  document.getElementById('v-ficha').innerHTML = `
    <div><dt>Gravedad</dt><dd><i class="punto ${r.gravedad}"></i> ${ETIQUETAS_GRAVEDAD[r.gravedad]}</dd></div>
    <div><dt>Tamaño</dt><dd>${esc(r.tamano)}</dd></div>
    <div><dt>Estado</dt><dd>${ETIQUETAS_ESTADO[estadoBache]}</dd></div>
    <div><dt>Confirmaciones</dt><dd>👍 ${r.votos}</dd></div>
    <div><dt>Reportó</dt><dd>${esc(r.autor)}</dd></div>
    <div><dt>Fecha</dt><dd>${r.fecha ?? r.fecha_reporte}</dd></div>
    <div><dt>Descripción</dt><dd>${esc(r.descripcion) || '—'}</dd></div>
    <div><dt>Coordenadas</dt><dd>${Number(r.lat).toFixed(5)}, ${Number(r.lng).toFixed(5)}</dd></div>
  `;

  // Enlace a Google Maps, por si la cuadrilla prefiere navegar desde el celular.
  const google = document.getElementById('v-google');
  google.href = alcaldia
    ? `https://www.google.com/maps/dir/${alcaldia.lat},${alcaldia.lng}/${r.lat},${r.lng}`
    : `https://www.google.com/maps/search/?api=1&query=${r.lat},${r.lng}`;

  const idReporte = r.reporte_id ?? r.id;
  const yaEnPlan = plan.some(p => p.reporte_id === idReporte);
  const botonPlan = document.getElementById('v-planificar');
  botonPlan.textContent = yaEnPlan ? '📋 Ya está en el plan' : '📋 Agregar al plan';
  botonPlan.disabled = yaEnPlan;

  abrir('modal-detalle');
  await dibujarRuta(r, alcaldia);
}

async function dibujarRuta(r, alcaldia) {
  const resumen = document.getElementById('v-ruta');

  if (!mapaRuta) {
    mapaRuta = L.map('mapa-ruta');
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 19,
    }).addTo(mapaRuta);
  }

  // Limpiar lo que quedó dibujado de la apertura anterior.
  if (capaRuta) {
    mapaRuta.removeLayer(capaRuta);
    capaRuta = null;
  }
  marcasRuta.forEach(m => mapaRuta.removeLayer(m));
  marcasRuta = [];

  const colores = { leve: '#4ade80', moderado: '#facc15', grave: '#fb923c', critico: '#ef4444' };
  marcasRuta.push(
    L.circleMarker([r.lat, r.lng], {
      radius: 10, color: '#000', weight: 1,
      fillColor: colores[r.gravedad], fillOpacity: 0.9,
    }).addTo(mapaRuta).bindPopup('Bache')
  );

  // El contenedor estaba oculto: Leaflet necesita que le avisen el tamaño.
  setTimeout(() => mapaRuta.invalidateSize(), 80);

  if (!alcaldia) {
    mapaRuta.setView([r.lat, r.lng], 16);
    resumen.innerHTML = '<span class="aproximado">No hay alcaldía cargada para este departamento.</span>';
    return;
  }

  marcasRuta.push(
    L.marker([alcaldia.lat, alcaldia.lng], { icon: ICONO_ALCALDIA })
      .addTo(mapaRuta).bindPopup(alcaldia.nombre)
  );

  resumen.textContent = 'Calculando la ruta…';

  try {
    const p = new URLSearchParams({
      desdeLat: alcaldia.lat, desdeLng: alcaldia.lng,
      hastaLat: r.lat, hastaLng: r.lng,
    });
    const respuesta = await fetch(`/api/ruta?${p}`);
    if (!respuesta.ok) throw new Error(`Error ${respuesta.status}`);
    const ruta = await respuesta.json();

    capaRuta = L.polyline(ruta.geometria, {
      color: '#ff6b35',
      weight: 5,
      opacity: 0.85,
      dashArray: ruta.aproximada ? '8, 8' : null,
    }).addTo(mapaRuta);

    mapaRuta.fitBounds(capaRuta.getBounds(), { padding: [30, 30] });

    const tiempo = minutosLegibles(ruta.duracionS);
    resumen.innerHTML = `
      <strong>${metrosLegibles(ruta.distanciaM)}</strong> desde la alcaldía
      ${tiempo ? ` · aprox. <strong>${tiempo}</strong> en auto` : ''}
      <div class="celda-sub">${esc(alcaldia.nombre)}</div>
      ${ruta.aproximada
        ? '<span class="aproximado">⚠ Ruta aproximada (línea recta): el servicio de ruteo no respondió.</span>'
        : ''}
    `;
  } catch (error) {
    mapaRuta.setView([r.lat, r.lng], 15);
    resumen.innerHTML = `<span class="aproximado">No se pudo calcular la ruta: ${esc(error.message)}</span>`;
  }
}

document.getElementById('v-planificar').onclick = () => {
  cerrar('modal-detalle');
  abrirFormularioPlan(detalleR);
};

// ---------- Alta y edición en el plan ----------
function abrirFormularioPlan(reporte, itemDelPlan = null) {
  if (!reporte && !itemDelPlan) return;

  planEditando = itemDelPlan;
  const datos = itemDelPlan || {};
  const bache = itemDelPlan || reporte;

  document.getElementById('pl-titulo').textContent =
    itemDelPlan ? 'Editar programación' : 'Programar bacheo';
  document.getElementById('pl-bache').textContent = bache.referencia;

  document.getElementById('pl-prioridad').value = datos.prioridad ?? 3;
  document.getElementById('pl-fecha').value     = datos.fecha_programada ?? '';
  document.getElementById('pl-costo').value     = datos.costo_estimado ?? '';
  document.getElementById('pl-notas').value     = datos.notas ?? '';

  // Solo las cuadrillas del departamento del bache: no se manda la cuadrilla
  // de Tarija a tapar un bache en Santa Cruz.
  const selector = document.getElementById('pl-cuadrilla');
  const propias = cuadrillas.filter(c => c.depto === bache.depto && c.activa);
  selector.innerHTML = '<option value="">Sin asignar todavía</option>' +
    propias.map(c => `<option value="${c.id}">${esc(c.nombre)}</option>`).join('');
  selector.value = datos.cuadrilla_id ?? '';

  if (!propias.length) {
    selector.innerHTML = '<option value="">No hay cuadrillas en este departamento</option>';
  }

  // El estado del trabajo solo tiene sentido sobre algo ya programado.
  document.getElementById('pl-estado-campo').hidden = !itemDelPlan;
  if (itemDelPlan) document.getElementById('pl-estado').value = datos.estado;

  document.getElementById('form-plan').dataset.reporteId = bache.reporte_id ?? bache.id;
  abrir('modal-plan');
}

document.getElementById('form-plan').onsubmit = async (e) => {
  e.preventDefault();

  const cuerpo = {
    prioridad:        Number(document.getElementById('pl-prioridad').value),
    fecha_programada: document.getElementById('pl-fecha').value || null,
    cuadrilla_id:     document.getElementById('pl-cuadrilla').value || null,
    costo_estimado:   document.getElementById('pl-costo').value,
    notas:            document.getElementById('pl-notas').value,
  };

  try {
    if (planEditando) {
      cuerpo.estado = document.getElementById('pl-estado').value;
      await pedir(`/api/admin/plan/${planEditando.id}`, {
        method: 'PATCH',
        body: JSON.stringify(cuerpo),
      });
      avisar('Programación actualizada.');
    } else {
      cuerpo.reporte_id = Number(e.target.dataset.reporteId);
      await pedir('/api/admin/plan', { method: 'POST', body: JSON.stringify(cuerpo) });
      avisar('Bache agregado al plan de bacheo.');
    }

    cerrar('modal-plan');
    planEditando = null;
    await Promise.all([cargarPlan(), cargarReportes(), cargarResumen()]);
  } catch (error) {
    avisar(error.message);
  }
};

// ---------- Tabla del plan ----------
async function cargarPlan() {
  try {
    const p = new URLSearchParams();
    const depto  = document.getElementById('plan-depto').value;
    const estado = document.getElementById('plan-estado').value;
    if (depto)  p.set('depto', depto);
    if (estado) p.set('estado', estado);

    plan = await pedir(`/api/admin/plan?${p}`);
    dibujarPlan();
    await cargarResumenPlan();
  } catch (error) {
    avisar(error.message);
  }
}

function dibujarPlan() {
  const cuerpo = document.getElementById('cuerpo-plan');

  if (!plan.length) {
    cuerpo.innerHTML = `<tr><td colspan="10" class="tabla-vacia">
      El plan está vacío. Agregá baches desde la pestaña <strong>Reportes</strong>, con el botón 📋.
    </td></tr>`;
    return;
  }

  cuerpo.innerHTML = plan.map(p => `
    <tr data-plan="${p.id}">
      <td><span class="prioridad p${p.prioridad}">${p.prioridad}</span></td>
      <td>
        ${p.foto_url
          ? `<img class="foto-celda" src="${esc(p.foto_url)}" alt="" loading="lazy" data-ver="${esc(p.foto_url)}">`
          : '<div class="foto-celda-vacia">sin<br>foto</div>'}
      </td>
      <td>
        <div class="celda-titulo">${esc(p.referencia)}</div>
        <div class="celda-sub"><i class="punto ${p.gravedad}"></i> ${ETIQUETAS_GRAVEDAD[p.gravedad]} · 👍 ${p.votos}</div>
        ${p.notas ? `<div class="celda-sub">📝 ${esc(p.notas).slice(0, 60)}</div>` : ''}
      </td>
      <td>${esc(p.depto_nombre)}</td>
      <td>${p.fecha_programada || '<span class="sin-programar">sin fecha</span>'}</td>
      <td>${p.cuadrilla_nombre
        ? `<span class="muestra-color" style="background:${p.cuadrilla_color || '#9aa3b2'}"></span> ${esc(p.cuadrilla_nombre)}`
        : '<span class="sin-programar">sin asignar</span>'}</td>
      <td>
        ${metrosLegibles(p.distancia_m)}
        ${p.duracion_s ? `<div class="celda-sub">${minutosLegibles(p.duracion_s)}</div>` : ''}
      </td>
      <td>${p.costo_estimado != null ? `${Number(p.costo_estimado).toFixed(2)} Bs` : '—'}</td>
      <td><span class="chip ${p.estado}">${ETIQUETAS_PLAN[p.estado]}</span></td>
      <td>
        <div class="acciones-fila">
          <button class="icono" data-ruta="${p.reporte_id}" title="Ver ruta desde la alcaldía">🗺️</button>
          <button class="icono" data-editar-plan="${p.id}" title="Editar programación">✏️</button>
          <button class="icono peligro" data-sacar-plan="${p.id}" title="Sacar del plan">✕</button>
        </div>
      </td>
    </tr>
  `).join('');
}

document.getElementById('cuerpo-plan').addEventListener('click', (e) => {
  const ver = e.target.dataset.ver;
  if (ver) return mostrarVisor(ver);

  const ruta = e.target.dataset.ruta;
  if (ruta) return abrirDetalle(Number(ruta));

  const editar = e.target.dataset.editarPlan;
  if (editar) return abrirFormularioPlan(null, plan.find(x => x.id === Number(editar)));

  const sacar = e.target.dataset.sacarPlan;
  if (sacar) {
    const item = plan.find(x => x.id === Number(sacar));
    return pedirConfirmacion(
      `Se saca "${item.referencia}" del plan. El bache sigue en el mapa.`,
      async () => {
        await pedir(`/api/admin/plan/${sacar}`, { method: 'DELETE' });
        avisar('Sacado del plan.');
        await cargarPlan();
      }
    );
  }
});

async function cargarResumenPlan() {
  try {
    const datos = await pedir('/api/admin/plan/resumen');
    const por = Object.fromEntries(datos.porEstado.map(f => [f.estado, f]));

    document.getElementById('p-pendientes').textContent = por.pendiente?.cantidad ?? 0;
    // "En la calle" junta a los que van en camino y a los que ya están
    // trabajando: para la alcaldía son la misma cosa, cuadrillas afuera.
    document.getElementById('p-ruta').textContent =
      (por.en_ruta?.cantidad ?? 0) + (por.arreglando?.cantidad ?? 0);
    document.getElementById('p-ejecutados').textContent = por.ejecutado?.cantidad ?? 0;

    const costo = datos.porEstado.reduce((suma, f) => suma + (f.costo || 0), 0);
    document.getElementById('p-costo').textContent =
      costo.toLocaleString('es-BO', { maximumFractionDigits: 0 });

    document.getElementById('p-proxima').textContent = datos.proximaFecha || '—';
  } catch (error) {
    avisar(error.message);
  }
}

document.getElementById('plan-depto').onchange   = cargarPlan;
document.getElementById('plan-estado').onchange  = cargarPlan;
document.getElementById('plan-recargar').onclick = cargarPlan;
