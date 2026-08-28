// ============================================================
// Convierte los archivos .sql en un módulo JavaScript.
//
//   node scripts/generar-esquema.js
//
// ¿Por qué? El empaquetador de Netlify solo se lleva código: los archivos
// .sql sueltos no llegan a la función. Metiéndolos dentro de un .js viajan
// con el resto y no hay que adivinar rutas en producción.
//
// Los .sql siguen siendo la fuente: se editan ahí y se regenera esto.
// `npm run db` lo regenera solo antes de instalar.
// ============================================================

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const esquema = await fs.readFile(path.join(raiz, 'db', 'schema.sql'), 'utf8');
const semilla = await fs.readFile(path.join(raiz, 'db', 'semilla.sql'), 'utf8');

// Se usan acentos graves como delimitador, así que hay que escapar los que
// aparezcan en el SQL, y también \ y ${ para que no se interpreten.
function comoTexto(sql) {
  return sql.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

const salida = `// ============================================================
// ARCHIVO GENERADO — no lo edites a mano.
//
// Se arma con:  node scripts/generar-esquema.js
// La fuente son db/schema.sql y db/semilla.sql.
// ============================================================

export const ESQUEMA = \`${comoTexto(esquema)}\`;

export const SEMILLA = \`${comoTexto(semilla)}\`;
`;

await fs.writeFile(path.join(raiz, 'api', 'esquema.js'), salida);

console.log(`api/esquema.js generado (${Math.round(salida.length / 1024)} KB)`);
