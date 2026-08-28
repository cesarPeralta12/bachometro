// ============================================================
// Bachómetro — la aplicación Express.
//
// Este archivo define las rutas y nada más: no abre ningún puerto. Así el
// mismo código sirve para los dos destinos:
//   - server.js         lo levanta como servidor normal (tu PC)
//   - netlify/functions lo envuelve como función serverless (Netlify)
//
//   GET    /api/departamentos
//   GET    /api/reportes?depto=scz&estado=...&gravedad=...&fuente=...&q=...
//   POST   /api/reportes
//   POST   /api/reportes/:id/voto
//   PATCH  /api/reportes/:id/estado      (requiere ADMIN_TOKEN)
//   GET    /api/estadisticas?depto=scz
// ============================================================

import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { pool, configuracionFaltante } from './db.js';
import { enServerless, carpetaDe } from './entorno.js';
import * as almacen from './almacen.js';
import { ESQUEMA, SEMILLA } from './esquema.js';

const app = express();

// Las fotos llegan en base64 dentro del JSON, por eso el límite alto.
app.use(express.json({ limit: '12mb' }));

// En Netlify el pedido llega con el prefijo de la función adelante
// (/.netlify/functions/servidor/api/reportes) y Express espera /api/reportes.
// El nombre de la función se saca con un comodín para que renombrarla no
// vuelva a romper esto.
// Tiene que ir ANTES de las rutas: un middleware registrado después ya no
// alcanza a modificar la URL a tiempo. En tu PC este prefijo nunca aparece,
// así que no hace nada.
app.use((req, _res, siguiente) => {
  req.url = req.url.replace(/^\/\.netlify\/functions\/[^/]+/, '') || '/';
  siguiente();
});

// Sin base de datos no hay nada que contestar. Se responde con el motivo
// concreto en vez de dejar que reviente más adelante con un error genérico.
app.use('/api', (_req, res, siguiente) => {
  if (configuracionFaltante) {
    return res.status(503).json({ error: configuracionFaltante });
  }
  siguiente();
});

// ---------- Catálogos válidos ----------
const GRAVEDADES = ['leve', 'moderado', 'grave', 'critico'];
const TAMANOS    = ['chico', 'mediano', 'grande'];
const ESTADOS    = ['reportado', 'verificado', 'en_progreso', 'reparado'];
const FUENTES    = ['ciudadano', 'waze'];
const ESTADOS_PLAN = ['pendiente', 'en_ruta', 'arreglando', 'ejecutado', 'cancelado'];

// Qué le pasa al bache del mapa público según avanza el trabajo.
// 'pendiente' no aparece acá: programar algo no cambia todavía el bache.
const ESTADO_BACHE_SEGUN_TRABAJO = {
  en_ruta:    'en_progreso',
  arreglando: 'en_progreso',
  ejecutado:  'reparado',
};

// ---------- Utilidades ----------
function esUuid(valor) {
  return typeof valor === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(valor);
}

// Convierte ?estado=a,b en un array, quedándose solo con los valores válidos.
function listaValida(parametro, permitidos) {
  if (!parametro) return null;
  const valores = String(parametro).split(',').map(v => v.trim()).filter(v => permitidos.includes(v));
  return valores.length ? valores : null;
}

// Guarda la foto que llega como data URL y devuelve la ruta pública.
// Se valida el tipo de verdad, no por la extensión que diga el cliente.
const TIPOS_FOTO = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_FOTO_BYTES = 5 * 1024 * 1024;

async function guardarFoto(dataUrl) {
  const coincidencia = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl || '');
  if (!coincidencia) throw new Error('La foto no tiene un formato válido.');

  const extension = TIPOS_FOTO[coincidencia[1].toLowerCase()];
  if (!extension) throw new Error('La foto debe ser JPG, PNG o WEBP.');

  const binario = Buffer.from(coincidencia[2], 'base64');
  if (binario.length === 0)              throw new Error('La foto llegó vacía.');
  if (binario.length > MAX_FOTO_BYTES)   throw new Error('La foto pesa más de 5 MB.');

  const nombre = `${crypto.randomUUID()}.${extension}`;
  await almacen.guardar(nombre, binario, coincidencia[1].toLowerCase());
  return `/uploads/${nombre}`;
}

// Borra la foto de un reporte. El nombre se reduce a su parte final para que
// un valor manipulado como "../../algo" no pueda salir del almacén.
async function borrarArchivoDeFoto(fotoUrl) {
  if (!fotoUrl) return;
  await almacen.borrar(path.basename(String(fotoUrl)));
}

// Freno simple contra spam: máximo 20 reportes por IP por hora.
const historialPorIp = new Map();
const LIMITE_POR_HORA = 20;

function pasaElLimite(ip) {
  const ahora = Date.now();
  const haceUnaHora = ahora - 3600_000;
  const previos = (historialPorIp.get(ip) || []).filter(t => t > haceUnaHora);

  if (previos.length >= LIMITE_POR_HORA) {
    historialPorIp.set(ip, previos);
    return false;
  }
  previos.push(ahora);
  historialPorIp.set(ip, previos);
  return true;
}

// ---------- Consulta base ----------
// Los votos se cuentan de la tabla `votos` en vez de guardar un contador en
// `reportes`: no se puede desincronizar.
// El LEFT JOIN con plan_bacheo es lo que le permite al ciudadano ver
// "programado para el 12 de septiembre" sin entrar a ningún panel.
// Se exponen solo los campos públicos: la cuadrilla y el costo quedan adentro.
const SELECT_REPORTE = `
  SELECT r.id, r.depto, r.lat, r.lng, r.referencia, r.descripcion,
         r.gravedad, r.tamano, r.estado, r.fuente, r.autor, r.foto_url,
         to_char(r.creado_en, 'YYYY-MM-DD') AS fecha,
         (SELECT count(*) FROM votos v WHERE v.reporte_id = r.id)::int AS votos,
         CASE WHEN $1::uuid IS NULL THEN false
              ELSE EXISTS (SELECT 1 FROM votos v
                           WHERE v.reporte_id = r.id AND v.cliente_id = $1::uuid)
         END AS ya_vote,
         to_char(pb.fecha_programada, 'YYYY-MM-DD') AS programado_para,
         pb.estado::text AS estado_trabajo,
         pb.prioridad AS prioridad_plan
  FROM reportes r
  LEFT JOIN plan_bacheo pb ON pb.reporte_id = r.id
`;

// ---------- Rutas ----------
app.get('/api/departamentos', async (_req, res, siguiente) => {
  try {
    const { rows } = await pool.query(
      'SELECT codigo, nombre, capital, lat, lng FROM departamentos ORDER BY nombre'
    );
    res.json(rows);
  } catch (error) { siguiente(error); }
});

app.get('/api/reportes', async (req, res, siguiente) => {
  try {
    const cliente = esUuid(req.query.cliente) ? req.query.cliente : null;
    const condiciones = [];
    const valores = [cliente];

    if (req.query.depto) {
      valores.push(req.query.depto);
      condiciones.push(`r.depto = $${valores.length}`);
    }
    // Se compara la columna convertida a texto para no tener que nombrar
    // cada tipo ENUM en la consulta.
    for (const [columna, permitidos] of [
      ['estado', ESTADOS],
      ['gravedad', GRAVEDADES],
      ['fuente', FUENTES],
    ]) {
      const lista = listaValida(req.query[columna], permitidos);
      if (lista) {
        valores.push(lista);
        condiciones.push(`r.${columna}::text = ANY($${valores.length}::text[])`);
      }
    }
    if (req.query.q) {
      valores.push(`%${req.query.q}%`);
      condiciones.push(`(r.referencia ILIKE $${valores.length} OR r.descripcion ILIKE $${valores.length})`);
    }

    const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `${SELECT_REPORTE} ${where} ORDER BY r.creado_en DESC LIMIT 500`,
      valores
    );
    res.json(rows);
  } catch (error) { siguiente(error); }
});

app.post('/api/reportes', async (req, res, siguiente) => {
  try {
    if (!pasaElLimite(req.ip)) {
      return res.status(429).json({ error: 'Demasiados reportes seguidos. Probá en un rato.' });
    }

    const cuerpo = req.body ?? {};
    const referencia = String(cuerpo.referencia ?? '').trim();
    const lat = Number(cuerpo.lat);
    const lng = Number(cuerpo.lng);

    if (!referencia)                       return res.status(400).json({ error: 'Falta la calle o referencia.' });
    if (!Number.isFinite(lat) || lat < -90  || lat > 90)  return res.status(400).json({ error: 'Latitud inválida.' });
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) return res.status(400).json({ error: 'Longitud inválida.' });
    if (!cuerpo.fotoBase64)                return res.status(400).json({ error: 'Falta la foto del bache.' });

    const { rowCount } = await pool.query('SELECT 1 FROM departamentos WHERE codigo = $1', [cuerpo.depto]);
    if (!rowCount) return res.status(400).json({ error: 'Departamento desconocido.' });

    const gravedad = GRAVEDADES.includes(cuerpo.gravedad) ? cuerpo.gravedad : 'moderado';
    const tamano   = TAMANOS.includes(cuerpo.tamano)      ? cuerpo.tamano   : 'mediano';
    const autor    = String(cuerpo.autor ?? '').trim().slice(0, 80) || 'Anónimo';

    let fotoUrl;
    try {
      fotoUrl = await guardarFoto(cuerpo.fotoBase64);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    const { rows } = await pool.query(
      `INSERT INTO reportes (depto, lat, lng, referencia, descripcion, gravedad, tamano, autor, foto_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [cuerpo.depto, lat, lng, referencia.slice(0, 200),
       String(cuerpo.descripcion ?? '').trim().slice(0, 1000),
       gravedad, tamano, autor, fotoUrl]
    );

    // El que reporta cuenta como el primer voto.
    const cliente = esUuid(cuerpo.cliente) ? cuerpo.cliente : null;
    if (cliente) {
      await pool.query('INSERT INTO votos (reporte_id, cliente_id) VALUES ($1, $2)', [rows[0].id, cliente]);
    }

    const creado = await pool.query(`${SELECT_REPORTE} WHERE r.id = $2`, [cliente, rows[0].id]);
    res.status(201).json(creado.rows[0]);
  } catch (error) { siguiente(error); }
});

app.post('/api/reportes/:id/voto', async (req, res, siguiente) => {
  try {
    const cliente = req.body?.cliente;
    if (!esUuid(cliente)) return res.status(400).json({ error: 'Falta identificar al cliente.' });

    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Id inválido.' });

    // ON CONFLICT DO NOTHING: si ya votó, no pasa nada y no es un error.
    await pool.query(
      'INSERT INTO votos (reporte_id, cliente_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [id, cliente]
    );

    const { rows } = await pool.query(`${SELECT_REPORTE} WHERE r.id = $2`, [cliente, id]);
    if (!rows.length) return res.status(404).json({ error: 'Ese reporte no existe.' });
    res.json(rows[0]);
  } catch (error) { siguiente(error); }
});

// ============================================================
// Zona de administración
// Todo lo de acá abajo exige el header x-admin-token con el valor de
// ADMIN_TOKEN del .env. Es un candado simple pero real: sin el token no se
// puede leer el panel ni borrar nada.
// ============================================================

function requiereAdmin(req, res, siguiente) {
  const token = process.env.ADMIN_TOKEN;

  if (!token) {
    return res.status(503).json({ error: 'El panel no está configurado: falta ADMIN_TOKEN en api/.env' });
  }
  // Comparación de tiempo constante para no filtrar el token a fuerza de medir.
  const recibido = Buffer.from(String(req.get('x-admin-token') || ''));
  const esperado = Buffer.from(token);
  const iguales = recibido.length === esperado.length &&
                  crypto.timingSafeEqual(recibido, esperado);

  if (!iguales) return res.status(401).json({ error: 'Token incorrecto.' });
  siguiente();
}

// Sirve para que el panel valide el token al iniciar sesión.
app.get('/api/admin/sesion', requiereAdmin, (_req, res) => res.json({ ok: true }));

// Listado completo: todos los departamentos, con filtros opcionales.
app.get('/api/admin/reportes', requiereAdmin, async (req, res, siguiente) => {
  try {
    const condiciones = [];
    const valores = [null];   // $1 = cliente, no se usa en el panel

    if (req.query.depto) {
      valores.push(req.query.depto);
      condiciones.push(`r.depto = $${valores.length}`);
    }
    for (const [columna, permitidos] of [
      ['estado', ESTADOS], ['gravedad', GRAVEDADES], ['fuente', FUENTES],
    ]) {
      const lista = listaValida(req.query[columna], permitidos);
      if (lista) {
        valores.push(lista);
        condiciones.push(`r.${columna}::text = ANY($${valores.length}::text[])`);
      }
    }
    if (req.query.q) {
      valores.push(`%${req.query.q}%`);
      condiciones.push(`(r.referencia ILIKE $${valores.length} OR r.descripcion ILIKE $${valores.length} OR r.autor ILIKE $${valores.length})`);
    }
    if (req.query.sinFoto === '1') condiciones.push('r.foto_url IS NULL');

    const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `${SELECT_REPORTE} ${where} ORDER BY r.creado_en DESC LIMIT 2000`,
      valores
    );
    res.json(rows);
  } catch (error) { siguiente(error); }
});

// Resumen para los tableros del panel.
app.get('/api/admin/resumen', requiereAdmin, async (_req, res, siguiente) => {
  try {
    const [porEstado, porGravedad, porDepto, generales] = await Promise.all([
      pool.query('SELECT estado::text AS clave, count(*)::int AS cantidad FROM reportes GROUP BY estado'),
      pool.query('SELECT gravedad::text AS clave, count(*)::int AS cantidad FROM reportes GROUP BY gravedad'),
      pool.query(`SELECT d.codigo, d.nombre, count(r.id)::int AS cantidad
                  FROM departamentos d LEFT JOIN reportes r ON r.depto = d.codigo
                  GROUP BY d.codigo, d.nombre ORDER BY cantidad DESC, d.nombre`),
      pool.query(`SELECT count(*)::int AS total,
                         count(foto_url)::int AS con_foto,
                         (SELECT count(*) FROM votos)::int AS votos,
                         count(*) FILTER (WHERE creado_en > now() - interval '7 days')::int AS ultimos_7_dias`
                 + ' FROM reportes'),
    ]);

    // Peso real de las fotos guardadas.
    const guardadas = await almacen.listar();
    const fotosEnDisco = guardadas.length;
    const bytesEnDisco = guardadas.reduce((suma, f) => suma + f.bytes, 0);

    res.json({
      ...generales.rows[0],
      porEstado:   Object.fromEntries(porEstado.rows.map(f => [f.clave, f.cantidad])),
      porGravedad: Object.fromEntries(porGravedad.rows.map(f => [f.clave, f.cantidad])),
      porDepto:    porDepto.rows,
      fotosEnDisco,
      bytesEnDisco,
    });
  } catch (error) { siguiente(error); }
});

// Cambio de estado: reportado -> verificado -> en progreso -> reparado.
app.patch('/api/reportes/:id/estado', requiereAdmin, async (req, res, siguiente) => {
  try {
    if (!ESTADOS.includes(req.body?.estado)) {
      return res.status(400).json({ error: `Estado inválido. Válidos: ${ESTADOS.join(', ')}` });
    }

    const { rows } = await pool.query(
      'UPDATE reportes SET estado = $1 WHERE id = $2 RETURNING id, estado',
      [req.body.estado, Number(req.params.id)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Ese reporte no existe.' });
    res.json(rows[0]);
  } catch (error) { siguiente(error); }
});

// Editar los datos de un reporte.
app.patch('/api/reportes/:id', requiereAdmin, async (req, res, siguiente) => {
  try {
    const cuerpo = req.body ?? {};
    const cambios = [];
    const valores = [];

    const campos = {
      referencia:  v => String(v).trim().slice(0, 200) || null,
      descripcion: v => String(v).trim().slice(0, 1000),
      autor:       v => String(v).trim().slice(0, 80) || 'Anónimo',
      gravedad:    v => GRAVEDADES.includes(v) ? v : null,
      tamano:      v => TAMANOS.includes(v)    ? v : null,
      estado:      v => ESTADOS.includes(v)    ? v : null,
      fuente:      v => FUENTES.includes(v)    ? v : null,
    };

    for (const [campo, limpiar] of Object.entries(campos)) {
      if (cuerpo[campo] === undefined) continue;
      const valor = limpiar(cuerpo[campo]);
      if (valor === null) return res.status(400).json({ error: `Valor inválido para ${campo}.` });
      valores.push(valor);
      // El nombre de la columna sale de `campos`, nunca del cuerpo de la
      // petición, así que no hay forma de inyectar SQL por acá.
      cambios.push(`${campo} = $${valores.length}`);
    }

    if (!cambios.length) return res.status(400).json({ error: 'No mandaste ningún cambio.' });

    valores.push(Number(req.params.id));
    const { rows } = await pool.query(
      `UPDATE reportes SET ${cambios.join(', ')} WHERE id = $${valores.length} RETURNING id`,
      valores
    );
    if (!rows.length) return res.status(404).json({ error: 'Ese reporte no existe.' });

    const actualizado = await pool.query(`${SELECT_REPORTE} WHERE r.id = $2`, [null, rows[0].id]);
    res.json(actualizado.rows[0]);
  } catch (error) { siguiente(error); }
});

// Borra la foto pero deja el reporte (por ejemplo, una foto inapropiada).
app.delete('/api/reportes/:id/foto', requiereAdmin, async (req, res, siguiente) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await pool.query('SELECT foto_url FROM reportes WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Ese reporte no existe.' });

    await pool.query('UPDATE reportes SET foto_url = NULL WHERE id = $1', [id]);
    await borrarArchivoDeFoto(rows[0].foto_url);
    res.json({ ok: true });
  } catch (error) { siguiente(error); }
});

// Borra el reporte, sus votos (por el ON DELETE CASCADE) y su foto del disco.
app.delete('/api/reportes/:id', requiereAdmin, async (req, res, siguiente) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM reportes WHERE id = $1 RETURNING id, foto_url',
      [Number(req.params.id)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Ese reporte no existe.' });

    await borrarArchivoDeFoto(rows[0].foto_url);
    res.json({ ok: true, id: rows[0].id });
  } catch (error) { siguiente(error); }
});

// Borrado en lote desde el panel.
app.post('/api/admin/reportes/borrar', requiereAdmin, async (req, res, siguiente) => {
  try {
    const ids = (req.body?.ids ?? [])
      .map(Number)
      .filter(Number.isInteger);

    if (!ids.length) return res.status(400).json({ error: 'No seleccionaste ningún reporte.' });

    const { rows } = await pool.query(
      'DELETE FROM reportes WHERE id = ANY($1::bigint[]) RETURNING id, foto_url',
      [ids]
    );
    for (const fila of rows) await borrarArchivoDeFoto(fila.foto_url);
    res.json({ ok: true, borrados: rows.length });
  } catch (error) { siguiente(error); }
});

// Fotos huérfanas: archivos en disco que ya no referencia ningún reporte.
// Aparecen si alguna vez se borró una fila a mano desde psql.
app.get('/api/admin/fotos-huerfanas', requiereAdmin, async (_req, res, siguiente) => {
  try {
    const { rows } = await pool.query('SELECT foto_url FROM reportes WHERE foto_url IS NOT NULL');
    const usadas = new Set(rows.map(f => path.basename(f.foto_url)));

    const huerfanas = (await almacen.listar())
      .filter(f => !usadas.has(f.nombre))
      .map(f => ({ archivo: f.nombre, bytes: f.bytes }));

    res.json(huerfanas);
  } catch (error) { siguiente(error); }
});

app.post('/api/admin/fotos-huerfanas/borrar', requiereAdmin, async (_req, res, siguiente) => {
  try {
    const { rows } = await pool.query('SELECT foto_url FROM reportes WHERE foto_url IS NOT NULL');
    const usadas = new Set(rows.map(f => path.basename(f.foto_url)));

    let borradas = 0;
    for (const foto of await almacen.listar()) {
      if (usadas.has(foto.nombre)) continue;
      await almacen.borrar(foto.nombre);
      borradas++;
    }
    res.json({ ok: true, borradas });
  } catch (error) { siguiente(error); }
});

// ---------- Alcaldías y rutas ----------
app.get('/api/alcaldias', async (req, res, siguiente) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, depto, nombre, direccion, telefono, lat, lng
       FROM alcaldias
       WHERE ($1::text IS NULL OR depto = $1)
       ORDER BY nombre`,
      [req.query.depto || null]
    );
    res.json(rows);
  } catch (error) { siguiente(error); }
});

// Distancia en línea recta, como respaldo si el ruteo no responde.
function distanciaEnLineaRecta(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = g => (g * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

// Ruta por calle entre dos puntos. Se consulta desde el servidor y no desde el
// navegador para no depender de que OSRM permita CORS, y para poder cachear.
// OSRM es el ruteador público de OpenStreetMap: gratis y sin API key.
const cacheRutas = new Map();
const CACHE_RUTAS_MAX = 300;

app.get('/api/ruta', async (req, res, siguiente) => {
  try {
    const puntos = ['desdeLat', 'desdeLng', 'hastaLat', 'hastaLng'].map(p => Number(req.query[p]));
    if (puntos.some(n => !Number.isFinite(n))) {
      return res.status(400).json({ error: 'Faltan coordenadas de origen o destino.' });
    }
    const [desdeLat, desdeLng, hastaLat, hastaLng] = puntos;

    const clave = puntos.map(n => n.toFixed(5)).join(',');
    if (cacheRutas.has(clave)) return res.json(cacheRutas.get(clave));

    let respuesta;
    try {
      const url = `https://router.project-osrm.org/route/v1/driving/` +
        `${desdeLng},${desdeLat};${hastaLng},${hastaLat}` +
        `?overview=full&geometries=geojson`;

      const osrm = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!osrm.ok) throw new Error(`OSRM respondió ${osrm.status}`);

      const datos = await osrm.json();
      const ruta = datos.routes?.[0];
      if (!ruta) throw new Error('Sin ruta');

      respuesta = {
        distanciaM: Math.round(ruta.distance),
        duracionS:  Math.round(ruta.duration),
        // OSRM devuelve [lng, lat]; Leaflet espera [lat, lng].
        geometria:  ruta.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
        aproximada: false,
      };
    } catch (error) {
      // Sin internet o con OSRM caído se devuelve la línea recta, avisando
      // que es aproximada para que el panel lo muestre distinto.
      console.warn('Ruteo no disponible, se usa línea recta:', error.message);
      respuesta = {
        distanciaM: distanciaEnLineaRecta(desdeLat, desdeLng, hastaLat, hastaLng),
        duracionS:  null,
        geometria:  [[desdeLat, desdeLng], [hastaLat, hastaLng]],
        aproximada: true,
      };
    }

    if (cacheRutas.size >= CACHE_RUTAS_MAX) cacheRutas.clear();
    cacheRutas.set(clave, respuesta);
    res.json(respuesta);
  } catch (error) { siguiente(error); }
});

app.get('/api/estadisticas', async (req, res, siguiente) => {
  try {
    const { rows } = await pool.query(
      `SELECT estado, count(*)::int AS cantidad
       FROM reportes
       WHERE ($1::text IS NULL OR depto = $1)
       GROUP BY estado`,
      [req.query.depto || null]
    );
    res.json(Object.fromEntries(rows.map(f => [f.estado, f.cantidad])));
  } catch (error) { siguiente(error); }
});

// ============================================================
// Plan de bacheo (alcaldía)
// ============================================================

// El color sale de la cuadrilla asignada: es lo que pinta la ruta en el mapa.
// `cuadrilla_nombre` cae al texto viejo si el trabajo se cargó antes de que
// las cuadrillas fueran una tabla.
const SELECT_PLAN = `
  SELECT p.id, p.reporte_id, p.prioridad, p.fecha_programada,
         p.costo_estimado, p.notas, p.estado, p.distancia_m, p.duracion_s,
         p.cuadrilla_id,
         coalesce(c.nombre, nullif(p.cuadrilla, '')) AS cuadrilla_nombre,
         c.color AS cuadrilla_color,
         r.referencia, r.descripcion, r.depto, r.lat, r.lng, r.gravedad,
         r.tamano, r.foto_url, r.estado AS estado_reporte, r.autor,
         to_char(r.creado_en, 'YYYY-MM-DD') AS fecha_reporte,
         (SELECT count(*) FROM votos v WHERE v.reporte_id = r.id)::int AS votos,
         d.nombre AS depto_nombre,
         a.lat AS alcaldia_lat, a.lng AS alcaldia_lng, a.nombre AS alcaldia_nombre
  FROM plan_bacheo p
  JOIN reportes r      ON r.id = p.reporte_id
  JOIN departamentos d ON d.codigo = r.depto
  LEFT JOIN cuadrillas c  ON c.id = p.cuadrilla_id
  LEFT JOIN alcaldias  a  ON a.depto = r.depto
`;

app.get('/api/admin/plan', requiereAdmin, async (req, res, siguiente) => {
  try {
    const condiciones = [];
    const valores = [];

    if (req.query.depto) {
      valores.push(req.query.depto);
      condiciones.push(`r.depto = $${valores.length}`);
    }
    if (ESTADOS_PLAN.includes(req.query.estado)) {
      valores.push(req.query.estado);
      condiciones.push(`p.estado::text = $${valores.length}`);
    }

    if (req.query.cuadrilla) {
      valores.push(Number(req.query.cuadrilla));
      condiciones.push(`p.cuadrilla_id = $${valores.length}`);
    }

    const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `${SELECT_PLAN} ${where}
       ORDER BY p.prioridad, p.fecha_programada NULLS LAST, p.creado_en`,
      valores
    );
    res.json(rows);
  } catch (error) { siguiente(error); }
});

// Mete un reporte en el plan. Calcula de una la distancia desde la alcaldía
// del departamento, así la cuadrilla ya sabe cuán lejos queda.
app.post('/api/admin/plan', requiereAdmin, async (req, res, siguiente) => {
  try {
    const reporteId = Number(req.body?.reporte_id);
    if (!Number.isInteger(reporteId)) return res.status(400).json({ error: 'Falta el reporte.' });

    const reporte = await pool.query('SELECT id, depto, lat, lng FROM reportes WHERE id = $1', [reporteId]);
    if (!reporte.rowCount) return res.status(404).json({ error: 'Ese reporte no existe.' });

    const yaEsta = await pool.query('SELECT 1 FROM plan_bacheo WHERE reporte_id = $1', [reporteId]);
    if (yaEsta.rowCount) return res.status(409).json({ error: 'Ese bache ya está en el plan.' });

    const { lat, lng, depto } = reporte.rows[0];
    let distancia = null, duracion = null;

    const alcaldia = await pool.query('SELECT lat, lng FROM alcaldias WHERE depto = $1', [depto]);
    if (alcaldia.rowCount) {
      const a = alcaldia.rows[0];
      try {
        const url = `http://127.0.0.1:${PUERTO}/api/ruta?desdeLat=${a.lat}&desdeLng=${a.lng}&hastaLat=${lat}&hastaLng=${lng}`;
        const ruta = await (await fetch(url, { signal: AbortSignal.timeout(10000) })).json();
        distancia = ruta.distanciaM ?? null;
        duracion  = ruta.duracionS ?? null;
      } catch (error) {
        console.warn('No se pudo calcular la ruta al planificar:', error.message);
      }
    }

    const prioridad = Number.isInteger(Number(req.body?.prioridad))
      ? Math.min(5, Math.max(1, Number(req.body.prioridad))) : 3;

    // La cuadrilla tiene que ser del mismo departamento que el bache: no se
    // manda la cuadrilla de Tarija a tapar un bache en Santa Cruz.
    let cuadrillaId = null;
    if (req.body?.cuadrilla_id) {
      const c = await pool.query('SELECT depto FROM cuadrillas WHERE id = $1', [Number(req.body.cuadrilla_id)]);
      if (!c.rowCount) return res.status(400).json({ error: 'Esa cuadrilla no existe.' });
      if (c.rows[0].depto !== depto) {
        return res.status(400).json({ error: 'Esa cuadrilla es de otro departamento.' });
      }
      cuadrillaId = Number(req.body.cuadrilla_id);
    }

    const { rows } = await pool.query(
      `INSERT INTO plan_bacheo (reporte_id, prioridad, fecha_programada, cuadrilla_id, costo_estimado, notas, distancia_m, duracion_s)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [reporteId, prioridad,
       req.body?.fecha_programada || null,
       cuadrillaId,
       req.body?.costo_estimado === '' || req.body?.costo_estimado == null ? null : Number(req.body.costo_estimado),
       String(req.body?.notas ?? '').trim().slice(0, 500),
       distancia, duracion]
    );

    const creado = await pool.query(`${SELECT_PLAN} WHERE p.id = $1`, [rows[0].id]);
    res.status(201).json(creado.rows[0]);
  } catch (error) { siguiente(error); }
});

app.patch('/api/admin/plan/:id', requiereAdmin, async (req, res, siguiente) => {
  try {
    const cuerpo = req.body ?? {};
    const cambios = [];
    const valores = [];

    const campos = {
      prioridad:        v => Math.min(5, Math.max(1, Number(v) || 3)),
      fecha_programada: v => (v ? String(v) : null),
      cuadrilla_id:     v => (v === '' || v == null ? null : Number(v)),
      costo_estimado:   v => (v === '' || v == null ? null : Number(v)),
      notas:            v => String(v).trim().slice(0, 500),
      estado:           v => (ESTADOS_PLAN.includes(v) ? v : undefined),
    };

    for (const [campo, limpiar] of Object.entries(campos)) {
      if (cuerpo[campo] === undefined) continue;
      const valor = limpiar(cuerpo[campo]);
      if (valor === undefined) return res.status(400).json({ error: `Valor inválido para ${campo}.` });
      valores.push(valor);
      cambios.push(`${campo} = $${valores.length}`);
    }
    if (!cambios.length) return res.status(400).json({ error: 'No mandaste ningún cambio.' });

    valores.push(Number(req.params.id));
    const { rows } = await pool.query(
      `UPDATE plan_bacheo SET ${cambios.join(', ')} WHERE id = $${valores.length} RETURNING id, reporte_id`,
      valores
    );
    if (!rows.length) return res.status(404).json({ error: 'Ese ítem del plan no existe.' });

    // El avance del trabajo arrastra el estado del bache en el mapa público,
    // para que la alcaldía no tenga que actualizar dos lados.
    const estadoDelBache = ESTADO_BACHE_SEGUN_TRABAJO[cuerpo.estado];
    if (estadoDelBache) {
      await pool.query('UPDATE reportes SET estado = $1 WHERE id = $2',
                       [estadoDelBache, rows[0].reporte_id]);
    }

    const actualizado = await pool.query(`${SELECT_PLAN} WHERE p.id = $1`, [rows[0].id]);
    res.json(actualizado.rows[0]);
  } catch (error) { siguiente(error); }
});

// Sacar del plan no borra el reporte: el bache sigue en el mapa.
app.delete('/api/admin/plan/:id', requiereAdmin, async (req, res, siguiente) => {
  try {
    const { rows } = await pool.query('DELETE FROM plan_bacheo WHERE id = $1 RETURNING id', [Number(req.params.id)]);
    if (!rows.length) return res.status(404).json({ error: 'Ese ítem del plan no existe.' });
    res.json({ ok: true });
  } catch (error) { siguiente(error); }
});

// Resumen del plan para las tarjetas de la pestaña.
app.get('/api/admin/plan/resumen', requiereAdmin, async (_req, res, siguiente) => {
  try {
    const { rows } = await pool.query(
      `SELECT estado::text AS estado, count(*)::int AS cantidad,
              coalesce(sum(costo_estimado), 0)::float AS costo,
              coalesce(sum(distancia_m), 0)::int AS distancia
       FROM plan_bacheo GROUP BY estado`
    );
    const proxima = await pool.query(
      `SELECT to_char(min(fecha_programada), 'YYYY-MM-DD') AS fecha
       FROM plan_bacheo WHERE estado = 'pendiente' AND fecha_programada >= current_date`
    );
    res.json({ porEstado: rows, proximaFecha: proxima.rows[0].fecha });
  } catch (error) { siguiente(error); }
});

// ============================================================
// Cuadrillas
// ============================================================

const COLOR_VALIDO = /^#[0-9a-fA-F]{6}$/;

app.get('/api/admin/cuadrillas', requiereAdmin, async (req, res, siguiente) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.depto, c.nombre, c.color, c.responsable, c.telefono, c.activa,
              (SELECT count(*) FROM plan_bacheo p
               WHERE p.cuadrilla_id = c.id AND p.estado <> 'ejecutado')::int AS trabajos_abiertos,
              (SELECT count(*) FROM plan_bacheo p
               WHERE p.cuadrilla_id = c.id AND p.estado = 'ejecutado')::int AS trabajos_hechos
       FROM cuadrillas c
       WHERE ($1::text IS NULL OR c.depto = $1)
       ORDER BY c.depto, c.nombre`,
      [req.query.depto || null]
    );
    res.json(rows);
  } catch (error) { siguiente(error); }
});

app.post('/api/admin/cuadrillas', requiereAdmin, async (req, res, siguiente) => {
  try {
    const nombre = String(req.body?.nombre ?? '').trim().slice(0, 80);
    const color  = String(req.body?.color ?? '').trim();

    if (!nombre) return res.status(400).json({ error: 'Falta el nombre de la cuadrilla.' });
    if (!COLOR_VALIDO.test(color)) return res.status(400).json({ error: 'El color debe ser tipo #ff6b35.' });

    const depto = await pool.query('SELECT 1 FROM departamentos WHERE codigo = $1', [req.body?.depto]);
    if (!depto.rowCount) return res.status(400).json({ error: 'Departamento desconocido.' });

    const { rows } = await pool.query(
      `INSERT INTO cuadrillas (depto, nombre, color, responsable, telefono)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (depto, nombre) DO NOTHING
       RETURNING id, depto, nombre, color, responsable, telefono, activa`,
      [req.body.depto, nombre, color,
       String(req.body?.responsable ?? '').trim().slice(0, 80),
       String(req.body?.telefono ?? '').trim().slice(0, 30)]
    );

    if (!rows.length) return res.status(409).json({ error: 'Ya existe una cuadrilla con ese nombre en el departamento.' });
    res.status(201).json({ ...rows[0], trabajos_abiertos: 0, trabajos_hechos: 0 });
  } catch (error) { siguiente(error); }
});

app.patch('/api/admin/cuadrillas/:id', requiereAdmin, async (req, res, siguiente) => {
  try {
    const cuerpo = req.body ?? {};
    const cambios = [];
    const valores = [];

    const campos = {
      nombre:      v => String(v).trim().slice(0, 80) || undefined,
      color:       v => (COLOR_VALIDO.test(String(v).trim()) ? String(v).trim() : undefined),
      responsable: v => String(v).trim().slice(0, 80),
      telefono:    v => String(v).trim().slice(0, 30),
      activa:      v => Boolean(v),
    };

    for (const [campo, limpiar] of Object.entries(campos)) {
      if (cuerpo[campo] === undefined) continue;
      const valor = limpiar(cuerpo[campo]);
      if (valor === undefined) return res.status(400).json({ error: `Valor inválido para ${campo}.` });
      valores.push(valor);
      cambios.push(`${campo} = $${valores.length}`);
    }
    if (!cambios.length) return res.status(400).json({ error: 'No mandaste ningún cambio.' });

    valores.push(Number(req.params.id));
    const { rows } = await pool.query(
      `UPDATE cuadrillas SET ${cambios.join(', ')} WHERE id = $${valores.length}
       RETURNING id, depto, nombre, color, responsable, telefono, activa`,
      valores
    );
    if (!rows.length) return res.status(404).json({ error: 'Esa cuadrilla no existe.' });
    res.json(rows[0]);
  } catch (error) { siguiente(error); }
});

// Borrar una cuadrilla no borra sus trabajos: quedan sin asignar.
app.delete('/api/admin/cuadrillas/:id', requiereAdmin, async (req, res, siguiente) => {
  try {
    const id = Number(req.params.id);
    const abiertos = await pool.query(
      `SELECT count(*)::int AS n FROM plan_bacheo WHERE cuadrilla_id = $1 AND estado <> 'ejecutado'`,
      [id]
    );

    const { rows } = await pool.query('DELETE FROM cuadrillas WHERE id = $1 RETURNING id', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Esa cuadrilla no existe.' });

    res.json({ ok: true, trabajosLiberados: abiertos.rows[0].n });
  } catch (error) { siguiente(error); }
});

// ---------- Diagnóstico ----------
// Dice qué variables de conexión ve el servidor, para saber si la plataforma
// se las está pasando. Devuelve NOMBRES y si tienen valor, nunca los valores:
// una cadena de conexión lleva usuario y contraseña adentro.
app.get('/api/admin/diagnostico', requiereAdmin, (_req, res) => {
  const interesantes = Object.keys(process.env)
    .filter(k => /DATABASE|POSTGRES|^PG|NEON|NETLIFY|LAMBDA/i.test(k))
    .sort()
    .map(k => ({ variable: k, tieneValor: Boolean(process.env[k]) }));

  res.json({
    enServerless,
    baseConfigurada: !configuracionFaltante,
    motivo: configuracionFaltante,
    variables: interesantes,
    node: process.version,
  });
});

// ---------- Instalación de la base ----------
// Crea las tablas y carga los datos iniciales usando la conexión que ya tiene
// el servidor. Existe porque en Netlify la cadena de conexión no se puede
// copiar a ningún lado: la plataforma se la inyecta a la función y nadie más
// la ve. Así el sitio se instala solo, sin que la credencial ande dando vueltas.
//
// Se puede llamar las veces que haga falta: el esquema es idempotente y la
// semilla solo carga ejemplos si la tabla de reportes está vacía.
app.post('/api/admin/instalar', requiereAdmin, async (_req, res, siguiente) => {
  try {
    await pool.query(ESQUEMA);
    await pool.query(SEMILLA);

    const { rows: [conteo] } = await pool.query(`
      SELECT (SELECT count(*) FROM departamentos)::int AS departamentos,
             (SELECT count(*) FROM alcaldias)::int     AS alcaldias,
             (SELECT count(*) FROM cuadrillas)::int    AS cuadrillas,
             (SELECT count(*) FROM reportes)::int      AS reportes,
             (SELECT count(*) FROM plan_bacheo)::int   AS plan
    `);

    res.json({ ok: true, ...conteo });
  } catch (error) {
    console.error('Falló la instalación de la base:', error);
    res.status(500).json({ error: `No se pudo instalar el esquema: ${error.message}` });
  }
});

// ---------- Fotos ----------
// Antes esto era express.static sobre la carpeta uploads/. Ahora pasa por el
// almacén, porque en Netlify las fotos no están en ningún disco.
app.get('/uploads/:archivo', async (req, res, siguiente) => {
  try {
    const foto = await almacen.leer(req.params.archivo);
    if (!foto) return res.status(404).json({ error: 'Esa foto no existe.' });

    res.set('Content-Type', foto.tipo);
    res.set('Cache-Control', 'public, max-age=604800, immutable');
    res.send(foto.binario);
  } catch (error) { siguiente(error); }
});

// ---------- Frontend ----------
// En Netlify las páginas las sirve su CDN directamente y esto no se usa,
// pero en tu PC es lo que hace que todo viva en una sola dirección.
if (!almacen.enNetlify) {
  // Si no se puede saber dónde está este archivo, no hay carpeta public/ que
  // servir; en ese caso se omite en vez de fallar.
  const aqui = carpetaDe(import.meta.url);
  if (aqui) app.use(express.static(path.join(aqui, '..', 'public')));
}

// ---------- Errores ----------
app.use((error, _req, res, _siguiente) => {
  console.error('Error en la API:', error);
  res.status(500).json({ error: 'Algo falló en el servidor.' });
});

export default app;
