// ============================================================
// Conexión a PostgreSQL.
// La contraseña sale del archivo .env — nunca va escrita en el código.
// ============================================================

import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const aqui = path.dirname(fileURLToPath(import.meta.url));

// El archivo .env es para tu PC. En Netlify no existe: las variables las
// inyecta la plataforma, y leer un archivo inexistente solo agrega ruido.
if (!process.env.NETLIFY) {
  dotenv.config({ path: path.join(aqui, '.env') });
}

// Hay dos formas de decir a qué base conectarse:
//
//   1. Una URL completa  -> la que da Netlify DB (NETLIFY_DATABASE_URL) o
//      cualquier Postgres en la nube. Es una sola variable.
//   2. Las variables PG* -> lo que se usa en tu PC, donde la contraseña la
//      escribís en api/.env.
//
// Se prefiere la URL cuando está, porque es la que existe en producción.
export const urlDeLaBase =
  process.env.NETLIFY_DATABASE_URL ||
  process.env.DATABASE_URL ||
  null;

const enServerless = Boolean(process.env.NETLIFY);

// Qué le falta a la configuración, si es que le falta algo.
//
// Se guarda en vez de cortar el proceso porque en serverless no hay a quién
// avisarle: matar la función deja al navegador con un 502 sin explicación.
// Mejor arrancar igual y que cada pedido conteste qué falta.
export const configuracionFaltante = (() => {
  if (urlDeLaBase) return null;

  const faltantes = ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']
    .filter(v => !process.env[v]);

  if (!faltantes.length) return null;

  return enServerless
    ? 'La base de datos no está configurada. Falta activar Netlify DB, o definir DATABASE_URL en las variables de entorno del sitio.'
    : `Faltan variables en api/.env: ${faltantes.join(', ')}`;
})();

// En tu PC sí conviene cortar: el mensaje se ve en la terminal y arrancar sin
// base solo llevaría a errores confusos más adelante.
if (configuracionFaltante && !enServerless) {
  console.error(`\n${configuracionFaltante}`);
  console.error('Copiá api/.env.example a api/.env y completalo,');
  console.error('o definí DATABASE_URL si la base está en la nube.\n');
  process.exit(1);
}

// Los bigint (OID 20) llegan como texto por defecto: el driver los protege
// así porque un bigint puede superar el número máximo seguro de JavaScript.
// El problema es que el id del reporte queda como "1" en vez de 1, y en el
// navegador `Number(boton.dataset.id) === reporte.id` da false, con lo cual
// ningún botón del panel encuentra su reporte.
//
// Para que pasaran de 2^53 haría falta que Bolivia reportara nueve mil
// billones de baches, así que convertirlos a número es seguro acá.
pg.types.setTypeParser(20, valor => parseInt(valor, 10));

// En serverless conviene un pool chico: cada función es un proceso aparte y
// entre todas pueden agotar las conexiones de la base.
export const pool = new pg.Pool(urlDeLaBase
  ? {
      connectionString: urlDeLaBase,
      // Las bases en la nube exigen TLS.
      ssl: { rejectUnauthorized: false },
      max: enServerless ? 2 : 10,
      idleTimeoutMillis: enServerless ? 5000 : 30000,
    }
  : {
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT),
      database: process.env.PGDATABASE,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      max: 10,
      idleTimeoutMillis: 30000,
    });

pool.on('error', (err) => {
  console.error('Error inesperado en el pool de Postgres:', err.message);
});

// Chequeo al arrancar: mejor fallar acá con un mensaje claro que en la
// primera petición del usuario.
export async function probarConexion() {
  const { rows } = await pool.query('SELECT current_database() AS db, version() AS version');
  return rows[0];
}
