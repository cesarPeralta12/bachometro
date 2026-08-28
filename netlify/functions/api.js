// ============================================================
// La API como función serverless de Netlify.
//
// Netlify no puede tener un proceso escuchando en un puerto para siempre:
// arranca una función por pedido y la apaga. `serverless-http` traduce entre
// las dos formas — recibe el pedido de Netlify, se lo pasa a Express como si
// fuera un servidor normal, y devuelve lo que Express conteste.
//
// Así el mismo app.js corre en tu PC y acá, sin dos versiones del código.
// (El ajuste de la URL con el prefijo de la función se hace dentro de
// app.js, donde puede correr antes de las rutas.)
// ============================================================

import serverless from 'serverless-http';
import app from '../../api/app.js';

export const handler = serverless(app, {
  // Las fotos viajan en base64 y vuelven como binario: hay que decirle a
  // Netlify qué tipos NO son texto, o las imágenes llegan corruptas.
  binary: ['image/*', 'application/octet-stream'],
});
