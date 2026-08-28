// ============================================================
// Almacén de fotos.
//
// El mismo código corre en dos lugares muy distintos:
//
//   En tu PC       -> las fotos van a la carpeta api/uploads/
//   En Netlify     -> van a Netlify Blobs
//
// La diferencia no es un capricho: en Netlify el código corre en funciones
// serverless, que arrancan y mueren por pedido y NO tienen disco propio.
// Una foto escrita en el disco de una función desaparece con ella. Por eso
// allá hace falta un almacén aparte.
//
// El resto del código no sabe cuál de los dos está usando: pide guardar,
// leer, borrar o listar, y listo.
// ============================================================

import path from 'node:path';
import { enServerless, carpetaDe } from './entorno.js';

// Dónde guarda las fotos cuando corre en tu PC.
//
// Es una función y no una constante porque el empaquetador de Netlify deja
// `import.meta.url` en undefined, y calcularlo al cargar el módulo hacía
// fallar la función entera —aunque allá las fotos van a Blobs y esta carpeta
// no se toque nunca—.
function carpetaLocal() {
  const aqui = carpetaDe(import.meta.url);
  if (!aqui) throw new Error('No se puede saber dónde guardar las fotos en disco.');
  return path.join(aqui, 'uploads');
}

// Se reexporta para que el resto del código no tenga que saber de entorno.js.
export const enNetlify = enServerless;

const TIPOS_POR_EXTENSION = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png', webp: 'image/webp',
};

export function tipoDe(nombre) {
  const extension = nombre.split('.').pop().toLowerCase();
  return TIPOS_POR_EXTENSION[extension] || 'application/octet-stream';
}

// ---------- Netlify Blobs ----------
let deposito = null;

async function blobs() {
  if (!deposito) {
    const { getStore } = await import('@netlify/blobs');
    deposito = getStore({ name: 'fotos', consistency: 'strong' });
  }
  return deposito;
}

// ---------- Disco ----------
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

  if (enNetlify) {
    const almacen = await blobs();
    await almacen.set(seguro, binario, { metadata: { tipo, bytes: binario.length } });
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

  if (enNetlify) {
    const almacen = await blobs();
    const datos = await almacen.get(seguro, { type: 'arrayBuffer' });
    if (!datos) return null;
    return { binario: Buffer.from(datos), tipo: tipoDe(seguro) };
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

  if (enNetlify) {
    const almacen = await blobs();
    await almacen.delete(seguro);
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
  if (enNetlify) {
    const almacen = await blobs();
    const { blobs: lista } = await almacen.list();

    // list() no trae el tamaño, así que hay que preguntarlo por archivo.
    return Promise.all(lista.map(async b => {
      const meta = await almacen.getMetadata(b.key).catch(() => null);
      return { nombre: b.key, bytes: Number(meta?.metadata?.bytes) || 0 };
    }));
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
