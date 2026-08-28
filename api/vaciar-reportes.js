// ============================================================
// Deja la base sin reportes, para empezar a probar desde cero.
//
//   node api/vaciar-reportes.js            -> solo muestra qué hay
//   node api/vaciar-reportes.js --borrar   -> borra de verdad
//
// Borra reportes, votos, plan de bacheo y las fotos del disco.
// NO toca los departamentos ni las alcaldías: sin eso la app no funciona.
// ============================================================

import pg from 'pg';
import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const SUBIDAS = path.join(aqui, 'uploads');

dotenv.config({ path: path.join(aqui, '.env'), quiet: true });

const borrarDeVerdad = process.argv.includes('--borrar');

const cliente = new pg.Client({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
});

await cliente.connect();

// ---------- Qué hay ahora ----------
const { rows: [conteo] } = await cliente.query(`
  SELECT (SELECT count(*) FROM reportes)::int      AS reportes,
         (SELECT count(*) FROM votos)::int         AS votos,
         (SELECT count(*) FROM plan_bacheo)::int   AS plan,
         (SELECT count(*) FROM reportes WHERE foto_url IS NOT NULL)::int AS con_foto,
         (SELECT count(*) FROM departamentos)::int AS departamentos,
         (SELECT count(*) FROM alcaldias)::int     AS alcaldias
`);

const { rows: lista } = await cliente.query(`
  SELECT id, depto, referencia, autor, foto_url,
         to_char(creado_en, 'YYYY-MM-DD HH24:MI') AS creado
  FROM reportes ORDER BY id
`);

const archivos = (await fs.readdir(SUBIDAS)).filter(a => !a.startsWith('.'));

console.log('\n=== Contenido actual ===');
console.log(`  Reportes:        ${conteo.reportes}  (${conteo.con_foto} con foto)`);
console.log(`  Votos:           ${conteo.votos}`);
console.log(`  Plan de bacheo:  ${conteo.plan}`);
console.log(`  Fotos en disco:  ${archivos.length}`);
console.log(`\n  Se conservan:    ${conteo.departamentos} departamentos, ${conteo.alcaldias} alcaldías`);

console.log('\n=== Reportes que se van a borrar ===');
for (const r of lista) {
  console.log(`  #${r.id}  [${r.depto}]  ${r.referencia}`);
  console.log(`        por ${r.autor} · ${r.creado} · ${r.foto_url ? 'con foto' : 'sin foto'}`);
}

if (!borrarDeVerdad) {
  console.log('\n(Nada se borró. Para borrar de verdad: node api/vaciar-reportes.js --borrar)\n');
  await cliente.end();
  process.exit(0);
}

// ---------- Borrar ----------
console.log('\n=== Borrando ===');

// Los votos y el plan se van solos por el ON DELETE CASCADE de sus tablas.
const { rowCount } = await cliente.query('DELETE FROM reportes');
console.log(`  ${rowCount} reportes borrados (con sus votos y su plan).`);

// Las fotos hay que borrarlas del disco aparte: la base solo guarda la ruta.
let fotosBorradas = 0;
for (const archivo of archivos) {
  await fs.unlink(path.join(SUBIDAS, archivo));
  fotosBorradas++;
}
console.log(`  ${fotosBorradas} fotos borradas del disco.`);

// Que el próximo reporte sea el #1 y no el #11.
await cliente.query('ALTER SEQUENCE reportes_id_seq RESTART WITH 1');
await cliente.query('ALTER SEQUENCE plan_bacheo_id_seq RESTART WITH 1');
console.log('  Numeración reiniciada: el próximo reporte será el #1.');

// ---------- Comprobar ----------
const { rows: [final] } = await cliente.query(`
  SELECT (SELECT count(*) FROM reportes)::int      AS reportes,
         (SELECT count(*) FROM votos)::int         AS votos,
         (SELECT count(*) FROM plan_bacheo)::int   AS plan,
         (SELECT count(*) FROM departamentos)::int AS departamentos,
         (SELECT count(*) FROM alcaldias)::int     AS alcaldias
`);

console.log('\n=== Estado final ===');
console.log(`  Reportes: ${final.reportes} · Votos: ${final.votos} · Plan: ${final.plan}`);
console.log(`  Departamentos: ${final.departamentos} · Alcaldías: ${final.alcaldias} (intactos)`);
console.log('\nBase vacía y lista para tus pruebas.\n');

await cliente.end();
