// ============================================================
// Todo lo que habla con el servidor vive acá.
// Antes esto era localStorage + IndexedDB; ahora es PostgreSQL.
// ============================================================

const CLAVE_CLIENTE = 'bachometro_cliente';

// Identificador del navegador. Sirve para que un mismo celular no vote dos
// veces el mismo bache. Cuando haya login, esto lo reemplaza el id del usuario.
function idCliente() {
  let id = localStorage.getItem(CLAVE_CLIENTE);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(CLAVE_CLIENTE, id);
  }
  return id;
}

async function pedir(ruta, opciones = {}) {
  const respuesta = await fetch(ruta, {
    headers: { 'Content-Type': 'application/json' },
    ...opciones,
  });

  if (!respuesta.ok) {
    // El servidor manda { error: "..." }; si no, queda el código HTTP.
    const detalle = await respuesta.json().catch(() => ({}));
    throw new Error(detalle.error || `Error ${respuesta.status}`);
  }
  return respuesta.json();
}

const API = {
  idCliente,

  departamentos() {
    return pedir('/api/departamentos');
  },

  reportes(depto) {
    return pedir(`/api/reportes?depto=${encodeURIComponent(depto)}&cliente=${idCliente()}`);
  },

  alcaldias(depto) {
    const filtro = depto ? `?depto=${encodeURIComponent(depto)}` : '';
    return pedir(`/api/alcaldias${filtro}`);
  },

  // Ruta por calle entre dos puntos (la calcula el servidor con OSRM).
  ruta(desde, hasta) {
    const p = new URLSearchParams({
      desdeLat: desde.lat, desdeLng: desde.lng,
      hastaLat: hasta.lat, hastaLng: hasta.lng,
    });
    return pedir(`/api/ruta?${p}`);
  },

  crearReporte(datos) {
    return pedir('/api/reportes', {
      method: 'POST',
      body: JSON.stringify({ ...datos, cliente: idCliente() }),
    });
  },

  votar(id) {
    return pedir(`/api/reportes/${id}/voto`, {
      method: 'POST',
      body: JSON.stringify({ cliente: idCliente() }),
    });
  },
};
