// ============================================================
// Crea la base de datos y le aplica el esquema y los datos iniciales.
//
//   npm run db --prefix api
//   (o bien:  node api/instalar-db.js)
//
// Vive dentro de api/ porque es donde están las dependencias (pg, dotenv).
// Lee la conexión de api/.env, así que la contraseña no se escribe en ningún
// otro lado ni pasa por la línea de comandos.
// Se puede correr las veces que haga falta: no duplica nada.
// ============================================================

import pg from 'pg';
import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const carpetaSql = path.join(aqui, '..', 'db');

dotenv.config({ path: path.join(aqui, '.env'), quiet: true });

const { PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE } = process.env;

if (!PGPASSWORD) {
  console.error('\nFalta PGPASSWORD en api/.env');
  console.error('Abrí el archivo y escribí tu contraseña de PostgreSQL después del signo =\n');
  process.exit(1);
}

const conexionBase = { host: PGHOST, port: Number(PGPORT), user: PGUSER, password: PGPASSWORD };
const nombreBase = PGDATABASE || 'bachometro';

async function correrArchivo(cliente, archivo) {
  const sql = await fs.readFile(path.join(carpetaSql, archivo), 'utf8');
  await cliente.query(sql);
}

async function principal() {
  // ---------- 1. Crear la base ----------
  // Hay que conectarse a otra base para poder crear ésta: PostgreSQL no
  // permite CREATE DATABASE desde la base que se está creando.
  const admin = new pg.Client({ ...conexionBase, database: 'postgres' });

  try {
    await admin.connect();
  } catch (error) {
    console.error(`\nNo pude conectarme a PostgreSQL: ${error.message}`);
    if (error.code === '28P01') {
      console.error('La contraseña de api/.env no coincide con la de PostgreSQL.\n');
    }
    process.exit(1);
  }

  const existe = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [nombreBase]);

  if (existe.rowCount) {
    console.log(`La base "${nombreBase}" ya existía, se reutiliza.`);
  } else {
    // El nombre no puede ir como parámetro en CREATE DATABASE, así que se
    // escapa como identificador antes de interpolarlo.
    await admin.query(`CREATE DATABASE "${nombreBase.replace(/"/g, '""')}"`);
    console.log(`Base "${nombreBase}" creada.`);
  }
  await admin.end();

  // ---------- 2. Esquema y semilla ----------
  const cliente = new pg.Client({ ...conexionBase, database: nombreBase });
  await cliente.connect();

  console.log('Aplicando el esquema...');
  await correrArchivo(cliente, 'schema.sql');

  console.log('Cargando departamentos, alcaldías y reportes de ejemplo...');
  await correrArchivo(cliente, 'semilla.sql');

  // ---------- 3. Comprobar ----------
  const conteos = await cliente.query(`
    SELECT
      (SELECT count(*) FROM departamentos)::int AS departamentos,
      (SELECT count(*) FROM alcaldias)::int     AS alcaldias,
      (SELECT count(*) FROM reportes)::int      AS reportes,
      (SELECT count(*) FROM plan_bacheo)::int   AS plan
  `);

  const { departamentos, alcaldias, reportes, plan } = conteos.rows[0];
  console.log('\n----------------------------------------');
  console.log(`  Departamentos:   ${departamentos}`);
  console.log(`  Alcaldías:       ${alcaldias}`);
  console.log(`  Reportes:        ${reportes}`);
  console.log(`  Plan de bacheo:  ${plan}`);
  console.log('----------------------------------------');
  console.log('\nBase lista. Arrancá el servidor con:  npm start --prefix api\n');

  await cliente.end();
}

principal().catch(error => {
  console.error('\nFalló la instalación:', error.message);
  process.exit(1);
});
