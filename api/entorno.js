// ============================================================
// Dónde está corriendo esto.
//
// Distinguir "tu PC" de "una función serverless" no es un detalle: cambia
// dónde se guardan las fotos, si hay que leer un .env y si existe siquiera
// un disco donde escribir.
// ============================================================

import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Netlify define NETLIFY durante la CONSTRUCCIÓN, pero no siempre dentro de
// la función ya desplegada. Confiar solo en esa variable hacía que el código
// creyera estar en una PC cuando en realidad corría en Lambda.
//
// Por eso se miran también las marcas del entorno de ejecución: LAMBDA_TASK_ROOT
// y AWS_LAMBDA_FUNCTION_NAME sí están presentes mientras la función atiende.
export const enServerless = Boolean(
  process.env.NETLIFY ||
  process.env.LAMBDA_TASK_ROOT ||
  process.env.AWS_LAMBDA_FUNCTION_NAME
);

// La carpeta de un módulo, o null si no se puede saber.
//
// Al empaquetar a CommonJS, `import.meta` queda como un objeto vacío y
// `import.meta.url` es undefined; pasarle eso a fileURLToPath tira una
// excepción que mata el proceso al cargar. Acá se devuelve null y cada
// quien decide qué hacer sin esa información.
export function carpetaDe(urlDelModulo) {
  try {
    if (urlDelModulo) return path.dirname(fileURLToPath(urlDelModulo));
  } catch {
    // Sin ruta utilizable.
  }

  // En CommonJS sí existe __dirname.
  if (typeof __dirname !== 'undefined') return __dirname;

  return null;
}
