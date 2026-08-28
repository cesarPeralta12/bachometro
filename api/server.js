// ============================================================
// Arranque local: levanta la app Express en un puerto.
//
//   npm start
//
// Este archivo NO se usa en Netlify. Allá la app la envuelve
// netlify/functions/api.js como función serverless.
// ============================================================

import app from './app.js';
import { probarConexion } from './db.js';

const PUERTO = Number(process.env.PORT || 5173);

try {
  const info = await probarConexion();
  console.log(`Conectado a la base "${info.db}"`);
} catch (error) {
  console.error('\nNo se pudo conectar a PostgreSQL:', error.message);
  console.error('Revisá api/.env (usuario, contraseña, base) y que el servicio esté corriendo.\n');
  process.exit(1);
}

app.listen(PUERTO, '0.0.0.0', () => {
  console.log(`Bachómetro escuchando en http://localhost:${PUERTO}`);
  console.log(`Desde el celular en la misma Wi-Fi: http://<IP-de-esta-PC>:${PUERTO}`);
});
