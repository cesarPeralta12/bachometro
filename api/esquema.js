// ============================================================
// ARCHIVO GENERADO — no lo edites a mano.
//
// Se arma con:  node scripts/generar-esquema.js
// La fuente son db/schema.sql y db/semilla.sql.
// ============================================================

export const ESQUEMA = `-- ============================================================
-- Bachómetro — esquema de la base de datos (PostgreSQL)
--
-- Se aplica sobre una base ya creada:
--   psql -U postgres -d bachometro -f db/schema.sql
--
-- Es idempotente: se puede correr de nuevo sin romper nada.
-- ============================================================

BEGIN;

-- ---------- Tipos ----------
-- Los ENUM dejan que la base rechace un valor inventado, cosa que en la
-- Fase 1 solo cuidaba el <select> del formulario.
DO $$ BEGIN
  CREATE TYPE gravedad_bache AS ENUM ('leve', 'moderado', 'grave', 'critico');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE tamano_bache AS ENUM ('chico', 'mediano', 'grande');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE estado_reporte AS ENUM ('reportado', 'verificado', 'en_progreso', 'reparado');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE fuente_reporte AS ENUM ('ciudadano', 'waze');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- Departamentos ----------
CREATE TABLE IF NOT EXISTS departamentos (
  codigo  text PRIMARY KEY,
  nombre  text NOT NULL,
  capital text NOT NULL,
  lat     double precision NOT NULL,
  lng     double precision NOT NULL
);

-- ---------- Reportes ----------
CREATE TABLE IF NOT EXISTS reportes (
  id             bigserial PRIMARY KEY,
  depto          text NOT NULL REFERENCES departamentos(codigo),
  lat            double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng            double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  referencia     text NOT NULL CHECK (length(btrim(referencia)) > 0),
  descripcion    text NOT NULL DEFAULT '',
  gravedad       gravedad_bache NOT NULL DEFAULT 'moderado',
  tamano         tamano_bache   NOT NULL DEFAULT 'mediano',
  estado         estado_reporte NOT NULL DEFAULT 'reportado',
  fuente         fuente_reporte NOT NULL DEFAULT 'ciudadano',
  autor          text NOT NULL DEFAULT 'Anónimo',
  foto_url       text,
  creado_en      timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reportes_depto_estado_idx ON reportes (depto, estado);
CREATE INDEX IF NOT EXISTS reportes_creado_idx       ON reportes (creado_en DESC);

-- ---------- Votos ----------
-- Un voto por reporte y por cliente. Hoy "cliente" es un id que el navegador
-- guarda en localStorage; cuando haya login pasa a ser el id del usuario.
-- La clave primaria compuesta es la que impide votar dos veces: no depende
-- de que el frontend se porte bien.
CREATE TABLE IF NOT EXISTS votos (
  reporte_id bigint NOT NULL REFERENCES reportes(id) ON DELETE CASCADE,
  cliente_id uuid   NOT NULL,
  creado_en  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (reporte_id, cliente_id)
);

CREATE INDEX IF NOT EXISTS votos_reporte_idx ON votos (reporte_id);

-- ---------- actualizado_en automático ----------
CREATE OR REPLACE FUNCTION tocar_actualizado_en() RETURNS trigger AS $$
BEGIN
  NEW.actualizado_en := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS reportes_actualizado_en ON reportes;
CREATE TRIGGER reportes_actualizado_en
  BEFORE UPDATE ON reportes
  FOR EACH ROW EXECUTE FUNCTION tocar_actualizado_en();

COMMIT;

-- ============================================================
-- Alcaldías y plan de bacheo
-- ============================================================

BEGIN;

-- ---------- Alcaldías ----------
-- Punto de partida de las cuadrillas. Una por departamento.
CREATE TABLE IF NOT EXISTS alcaldias (
  id        serial PRIMARY KEY,
  depto     text NOT NULL UNIQUE REFERENCES departamentos(codigo),
  nombre    text NOT NULL,
  direccion text NOT NULL DEFAULT '',
  telefono  text NOT NULL DEFAULT '',
  lat       double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng       double precision NOT NULL CHECK (lng BETWEEN -180 AND 180)
);

-- ---------- Plan de bacheo ----------
DO $$ BEGIN
  CREATE TYPE estado_plan AS ENUM ('pendiente', 'en_ruta', 'ejecutado', 'cancelado');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Un reporte entra al plan una sola vez: por eso reporte_id es UNIQUE.
CREATE TABLE IF NOT EXISTS plan_bacheo (
  id               bigserial PRIMARY KEY,
  reporte_id       bigint NOT NULL UNIQUE REFERENCES reportes(id) ON DELETE CASCADE,
  prioridad        integer NOT NULL DEFAULT 3 CHECK (prioridad BETWEEN 1 AND 5),
  fecha_programada date,
  cuadrilla        text NOT NULL DEFAULT '',
  costo_estimado   numeric(12, 2) CHECK (costo_estimado IS NULL OR costo_estimado >= 0),
  notas            text NOT NULL DEFAULT '',
  estado           estado_plan NOT NULL DEFAULT 'pendiente',
  distancia_m      integer,   -- distancia por calle desde la alcaldía
  duracion_s       integer,   -- tiempo estimado de viaje
  creado_en        timestamptz NOT NULL DEFAULT now(),
  actualizado_en   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS plan_fecha_idx     ON plan_bacheo (fecha_programada);
CREATE INDEX IF NOT EXISTS plan_estado_idx    ON plan_bacheo (estado);
CREATE INDEX IF NOT EXISTS plan_prioridad_idx ON plan_bacheo (prioridad, fecha_programada);

DROP TRIGGER IF EXISTS plan_actualizado_en ON plan_bacheo;
CREATE TRIGGER plan_actualizado_en
  BEFORE UPDATE ON plan_bacheo
  FOR EACH ROW EXECUTE FUNCTION tocar_actualizado_en();

COMMIT;

-- ============================================================
-- Cuadrillas
-- ============================================================

BEGIN;

-- Antes la cuadrilla era texto libre dentro de plan_bacheo. Ahora es una
-- entidad propia: tiene color, y ese color es el que pinta su ruta en el
-- mapa. Con texto libre, "Cuadrilla Norte" y "cuadrilla norte" eran dos
-- cosas distintas y no se les podía asignar un color estable.
CREATE TABLE IF NOT EXISTS cuadrillas (
  id          serial PRIMARY KEY,
  depto       text NOT NULL REFERENCES departamentos(codigo),
  nombre      text NOT NULL CHECK (length(btrim(nombre)) > 0),
  color       text NOT NULL DEFAULT '#ff6b35' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  responsable text NOT NULL DEFAULT '',
  telefono    text NOT NULL DEFAULT '',
  activa      boolean NOT NULL DEFAULT true,
  creado_en   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (depto, nombre)
);

CREATE INDEX IF NOT EXISTS cuadrillas_depto_idx ON cuadrillas (depto, activa);

-- Si se borra una cuadrilla, el trabajo programado no se pierde: queda sin
-- asignar, para que alguien lo reasigne.
ALTER TABLE plan_bacheo
  ADD COLUMN IF NOT EXISTS cuadrilla_id integer REFERENCES cuadrillas(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS plan_cuadrilla_idx ON plan_bacheo (cuadrilla_id);

COMMIT;

-- ============================================================
-- Estado "arreglando"
--
-- La cuadrilla necesita distinguir "voy en camino" de "ya estoy trabajando
-- en el bache": son dos momentos distintos y el vecino que mira el mapa
-- también quiere saber en cuál está.
--
-- Va después de 'en_ruta' y antes de 'ejecutado' para que el orden del enum
-- coincida con el orden real del trabajo.
-- ============================================================

ALTER TYPE estado_plan ADD VALUE IF NOT EXISTS 'arreglando' AFTER 'en_ruta';

-- ============================================================
-- Fotos
--
-- En tu PC las fotos van a la carpeta api/uploads/. En la nube no hay disco
-- que sobreviva a la petición, así que van acá.
--
-- Guardar imágenes en la base no escala a millones, pero para esta app cierra:
-- cada foto viaja comprimida a 60-120 KB, así que el medio giga del plan
-- gratuito da para varios miles. Si algún día queda chico, se cambia el
-- almacén sin tocar el resto del código.
-- ============================================================

CREATE TABLE IF NOT EXISTS fotos (
  nombre    text PRIMARY KEY,
  tipo      text NOT NULL,
  contenido bytea NOT NULL,
  bytes     integer NOT NULL,
  creado_en timestamptz NOT NULL DEFAULT now()
);
`;

export const SEMILLA = `-- ============================================================
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
`;
