// ============================================================
// Preparación de la foto antes de mandarla al servidor.
//
// La compresión se hace en el navegador a propósito: una foto de celular
// pesa 3-5 MB y subirla entera por Wi-Fi o datos móviles es lento. Comprimida
// queda en 60-120 KB y se ve igual de bien en el mapa.
// ============================================================

function comprimirImagen(archivo, ladoMax = 900, calidad = 0.6) {
  return new Promise((resolve, reject) => {
    const lector = new FileReader();
    lector.onerror = () => reject(new Error('No se pudo leer el archivo.'));
    lector.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('El archivo no es una imagen válida.'));
      img.onload = () => {
        const escala = Math.min(1, ladoMax / Math.max(img.width, img.height));
        const lienzo = document.createElement('canvas');
        lienzo.width  = Math.round(img.width  * escala);
        lienzo.height = Math.round(img.height * escala);
        lienzo.getContext('2d').drawImage(img, 0, 0, lienzo.width, lienzo.height);
        resolve(lienzo.toDataURL('image/jpeg', calidad));
      };
      img.src = lector.result;
    };
    lector.readAsDataURL(archivo);
  });
}

// Peso aproximado de un data URL, para mostrárselo al usuario.
function pesoKB(dataUrl) {
  return Math.round((dataUrl.length * 3 / 4) / 1024);
}
