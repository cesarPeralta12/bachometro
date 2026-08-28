-- ============================================================
-- Datos iniciales: los 9 departamentos y unos reportes de ejemplo.
--   psql -U postgres -d bachometro -f db/semilla.sql
-- Se puede correr varias veces sin duplicar nada.
-- ============================================================

BEGIN;

INSERT INTO departamentos (codigo, nombre, capital, lat, lng) VALUES
  ('scz', 'Santa Cruz', 'Santa Cruz de la Sierra', -17.7833, -63.1821),
  ('lpz', 'La Paz',     'La Paz',                  -16.4897, -68.1193),
  ('cbb', 'Cochabamba', 'Cochabamba',              -17.3895, -66.1568),
  ('oru', 'Oruro',      'Oruro',                   -17.9833, -67.1500),
  ('pts', 'Potosí',     'Potosí',                  -19.5836, -65.7531),
  ('chu', 'Chuquisaca', 'Sucre',                   -19.0333, -65.2627),
  ('tja', 'Tarija',     'Tarija',                  -21.5355, -64.7296),
  ('ben', 'Beni',       'Trinidad',                -14.8333, -64.9000),
  ('pan', 'Pando',      'Cobija',                  -11.0267, -68.7692)
ON CONFLICT (codigo) DO UPDATE
  SET nombre = EXCLUDED.nombre,
      capital = EXCLUDED.capital,
      lat = EXCLUDED.lat,
      lng = EXCLUDED.lng;

-- Reportes de ejemplo. Solo se cargan si la tabla está vacía, para no
-- ensuciar los datos reales cuando se vuelve a correr el archivo.
INSERT INTO reportes (depto, lat, lng, referencia, descripcion, gravedad, tamano, estado, fuente, autor, creado_en)
SELECT * FROM (VALUES
  ('scz', -17.7790, -63.1810, 'Av. Cristo Redentor, 2do anillo',
   'Bache profundo en el carril derecho, ya reventó dos llantas.',
   'critico'::gravedad_bache, 'grande'::tamano_bache, 'reportado'::estado_reporte,
   'ciudadano'::fuente_reporte, 'Marcela R.', now() - interval '15 days'),

  ('scz', -17.7865, -63.1900, 'Av. Banzer esq. 4to anillo',
   'Hundimiento junto al semáforo, se acumula agua cuando llueve.',
   'grave', 'grande', 'verificado', 'ciudadano', 'Anónimo', now() - interval '17 days'),

  ('scz', -17.7750, -63.1750, 'Calle Libertad, zona centro',
   'Varios baches chicos seguidos, todo el tramo está roto.',
   'moderado', 'mediano', 'en_progreso', 'ciudadano', 'Juan P.', now() - interval '20 days'),

  ('scz', -17.7900, -63.1700, 'Av. Roca y Coronado',
   'Ya lo taparon, quedó parejo.',
   'leve', 'chico', 'reparado', 'ciudadano', 'Vecinos del barrio', now() - interval '28 days'),

  ('scz', -17.7700, -63.1950, 'Doble vía La Guardia km 3',
   'Alerta reportada por conductores en Waze.',
   'grave', 'mediano', 'reportado', 'waze', 'Waze', now() - interval '11 days'),

  ('lpz', -16.4950, -68.1330, 'Av. Arce, bajada a San Jorge',
   'Bache en plena bajada, peligroso para motos.',
   'grave', 'grande', 'reportado', 'ciudadano', 'Ricardo M.', now() - interval '13 days'),

  ('lpz', -16.5030, -68.1250, 'Autopista La Paz – El Alto',
   'Alerta de Waze reiterada por varios conductores.',
   'critico', 'grande', 'verificado', 'waze', 'Waze', now() - interval '10 days'),

  ('cbb', -17.3930, -66.1570, 'Av. Blanco Galindo km 4',
   'Bache ancho que ocupa medio carril.',
   'grave', 'grande', 'en_progreso', 'ciudadano', 'Anónimo', now() - interval '16 days'),

  ('tja', -21.5340, -64.7310, 'Av. La Paz, salida al aeropuerto',
   'Tramo con baches repetidos después de la lluvia.',
   'moderado', 'mediano', 'reportado', 'ciudadano', 'Sofía V.', now() - interval '9 days'),

  ('chu', -19.0350, -65.2600, 'Calle Junín, centro histórico',
   'Adoquines sueltos y un hueco en la esquina.',
   'moderado', 'chico', 'verificado', 'ciudadano', 'Anónimo', now() - interval '14 days')
) AS v
WHERE NOT EXISTS (SELECT 1 FROM reportes);

COMMIT;

-- ============================================================
-- Alcaldías de cada departamento.
--
-- OJO: las coordenadas son las de la plaza principal de cada capital, que es
-- donde suele estar el edificio municipal, pero son APROXIMADAS. Conviene
-- corregir la de tu ciudad con la ubicación exacta:
--   UPDATE alcaldias SET lat = -17.78xxx, lng = -63.18xxx WHERE depto = 'scz';
-- ============================================================

BEGIN;

INSERT INTO alcaldias (depto, nombre, direccion, lat, lng) VALUES
  ('scz', 'Gobierno Autónomo Municipal de Santa Cruz de la Sierra', 'Plaza 24 de Septiembre',  -17.78389, -63.18194),
  ('lpz', 'Gobierno Autónomo Municipal de La Paz',                  'Plaza Mayor de San Francisco', -16.49647, -68.13549),
  ('cbb', 'Gobierno Autónomo Municipal de Cochabamba',              'Plaza 14 de Septiembre',  -17.39364, -66.15700),
  ('oru', 'Gobierno Autónomo Municipal de Oruro',                   'Plaza 10 de Febrero',     -17.97070, -67.11090),
  ('pts', 'Gobierno Autónomo Municipal de Potosí',                  'Plaza 10 de Noviembre',   -19.58917, -65.75333),
  ('chu', 'Gobierno Autónomo Municipal de Sucre',                   'Plaza 25 de Mayo',        -19.04750, -65.25917),
  ('tja', 'Gobierno Autónomo Municipal de Tarija',                  'Plaza Luis de Fuentes',   -21.53550, -64.72960),
  ('ben', 'Gobierno Autónomo Municipal de Trinidad',                'Plaza José Ballivián',    -14.83472, -64.90083),
  ('pan', 'Gobierno Autónomo Municipal de Cobija',                  'Plaza Germán Busch',      -11.02670, -68.76920)
ON CONFLICT (depto) DO UPDATE
  SET nombre = EXCLUDED.nombre,
      direccion = EXCLUDED.direccion;
      -- lat/lng NO se pisan: si ya las corregiste a mano, se respetan.

COMMIT;

-- ============================================================
-- Cuadrillas de ejemplo: dos por departamento, con colores distintos
-- para que se distingan sus rutas en el mapa.
-- ============================================================

BEGIN;

INSERT INTO cuadrillas (depto, nombre, color)
SELECT d.codigo, v.nombre, v.color
FROM departamentos d
CROSS JOIN (VALUES
  ('Cuadrilla Norte', '#38bdf8'),
  ('Cuadrilla Sur',   '#a855f7')
) AS v(nombre, color)
ON CONFLICT (depto, nombre) DO NOTHING;

-- Santa Cruz es la más grande: dos cuadrillas más.
INSERT INTO cuadrillas (depto, nombre, color) VALUES
  ('scz', 'Cuadrilla Este',  '#4ade80'),
  ('scz', 'Cuadrilla Oeste', '#f472b6')
ON CONFLICT (depto, nombre) DO NOTHING;

COMMIT;
