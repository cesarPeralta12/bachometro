-- ============================================================
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
