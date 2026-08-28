// ============================================================
// Almacén de fotos.
//
// El mismo código corre en dos lugares muy distintos:
//
//   En tu PC       -> las fotos van a la carpeta api/uploads/
//   En la nube     -> van a PostgreSQL, a la tabla `fotos`
//
// La diferencia no es un capricho: en serverless el código corre en funciones
// que arrancan y mueren por pedido y NO tienen disco propio. Una foto escrita
// en el disco de una función desaparece con ella.
//
// El primer intento fue Netlify Blobs, pero su entorno no queda configurado en
// las funciones de este sitio: el paquete pide siteID y token que la plataforma
// debería inyectar sola y no inyecta. La base ya está andando, así que las
// fotos van ahí.
//
// Guardar imágenes en la base no escala a millones, pero para esta app cierra:
// cada foto viaja comprimida a 60-120 KB. Si algún día queda chico, se cambia
// este archivo y el resto del código ni se entera.
// ============================================================

import path from 'node:path';
import { enServerless, carpetaDe } from './entorno.js';

// Se reexporta para que el resto del código no tenga que saber de entorno.js.
export const enNetlify = enServerless;

// Dónde guarda las fotos cuando corre en tu PC.
//
// Es una función y no una constante porque al empaquetar a CommonJS
// `import.meta.url` queda undefined, y calcularlo al cargar el módulo hacía
// fallar la función entera —aunque en la nube esta carpeta no se toque nunca—.
function carpetaLocal() {
  const aqui = carpetaDe(import.meta.url);
  if (!aqui) throw new Error('No se puede saber dónde guardar las fotos en disco.');
  return path.join(aqui, 'uploads');
}

const TIPOS_POR_EXTENSION = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png', webp: 'image/webp',
};

export function tipoDe(nombre) {
  const extension = nombre.split('.').pop().toLowerCase();
  return TIPOS_POR_EXTENSION[extension] || 'application/octet-stream';
}

// Las dos dependencias pesadas se cargan solo cuando hacen falta: así este
// módulo no arrastra la conexión a la base en una PC, ni el sistema de
// archivos en la nube.
async function base() {
  const { pool } = await import('./db.js');
  return pool;
}

async function fs() {
  return import('node:fs/promises');
}

// Solo se aceptan nombres simples. Un "../../algo" no puede salir de la
// carpeta ni pisar archivos de otro lado.
function nombreSeguro(nombre) {
  const limpio = path.basename(String(nombre));
  return /^[\w.-]+$/.test(limpio) ? limpio : null;
}

// ============================================================
// Operaciones
// ============================================================

export async function guardar(nombre, binario, tipo) {
  const seguro = nombreSeguro(nombre);
  if (!seguro) throw new Error('Nombre de archivo inválido.');

  if (enServerless) {
    const pool = await base();
    await pool.query(
      `INSERT INTO fotos (nombre, tipo, contenido, bytes)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (nombre) DO UPDATE
         SET contenido = EXCLUDED.contenido,
             tipo = EXCLUDED.tipo,
             bytes = EXCLUDED.bytes`,
      [seguro, tipo, binario, binario.length]
    );
    return;
  }

  const disco = await fs();
  await disco.mkdir(carpetaLocal(), { recursive: true });
  await disco.writeFile(path.join(carpetaLocal(), seguro), binario);
}

// Devuelve { binario, tipo } o null si no está.
export async function leer(nombre) {
  const seguro = nombreSeguro(nombre);
  if (!seguro) return null;

  if (enServerless) {
    const pool = await base();
    const { rows } = await pool.query(
      'SELECT contenido, tipo FROM fotos WHERE nombre = $1', [seguro]
    );
    if (!rows.length) return null;
    return { binario: rows[0].contenido, tipo: rows[0].tipo || tipoDe(seguro) };
  }

  try {
    const disco = await fs();
    return {
      binario: await disco.readFile(path.join(carpetaLocal(), seguro)),
      tipo: tipoDe(seguro),
    };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function borrar(nombre) {
  const seguro = nombreSeguro(nombre);
  if (!seguro) return;

  if (enServerless) {
    const pool = await base();
    await pool.query('DELETE FROM fotos WHERE nombre = $1', [seguro]);
    return;
  }

  try {
    const disco = await fs();
    await disco.unlink(path.join(carpetaLocal(), seguro));
  } catch (error) {
    // Si ya no está, el objetivo igual se cumplió.
    if (error.code !== 'ENOENT') console.error('No se pudo borrar la foto:', error.message);
  }
}

// Devuelve [{ nombre, bytes }] con todo lo guardado.
export async function listar() {
  if (enServerless) {
    const pool = await base();
    // No se trae la columna `contenido`: acá solo interesa el peso.
    const { rows } = await pool.query('SELECT nombre, bytes FROM fotos ORDER BY nombre');
    return rows;
  }

  const disco = await fs();
  await disco.mkdir(carpetaLocal(), { recursive: true });

  const archivos = (await disco.readdir(carpetaLocal())).filter(a => !a.startsWith('.'));
  const resultado = [];

  for (const nombre of archivos) {
    const info = await disco.stat(path.join(carpetaLocal(), nombre));
    if (info.isFile()) resultado.push({ nombre, bytes: info.size });
  }
  return resultado;
}
