// ============================================================
// Catálogos de presentación.
//
// Los departamentos y los reportes ya NO viven acá: vienen de PostgreSQL
// a través de la API. Lo que queda son etiquetas y colores, que son
// decisiones de diseño y no datos.
// ============================================================

const ETIQUETAS_ESTADO = {
  reportado:   'Reportado',
  verificado:  'Verificado',
  en_progreso: 'En progreso',
  reparado:    'Reparado',
};

const ETIQUETAS_GRAVEDAD = {
  leve: 'Leve', moderado: 'Moderado', grave: 'Grave', critico: 'Crítico',
};

const COLORES_GRAVEDAD = {
  leve:     '#4ade80',
  moderado: '#facc15',
  grave:    '#fb923c',
  critico:  '#ef4444',
};

// Se llena al arrancar con lo que devuelve /api/departamentos.
let DEPARTAMENTOS = {};
