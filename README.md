# Bachómetro Bolivia

Plataforma ciudadana para reportar baches, con foto y ubicación en el mapa.
**Fase 2**: los reportes viven en PostgreSQL, los ve todo el mundo, y la alcaldía
tiene su propio panel con plan de bacheo y rutas hasta cada bache.

## Estructura

```
bachometro/
├── package.json     Dependencias y comandos (npm start, npm run db)
├── netlify.toml     Configuración del despliegue
├── netlify/
│   └── functions/
│       └── api.js   Envuelve Express como función serverless
├── public/          Frontend (lo que ve el ciudadano y el admin)
│   ├── index.html   Mapa público
│   ├── admin.html   Panel de administración
│   ├── api.js       Todo lo que habla con el servidor
│   ├── app.js       Mapa, filtros, alta de reportes
│   ├── admin.js     Lógica del panel (reportes, fotos, moderación)
│   ├── admin-plan.js Plan de bacheo y ruta desde la alcaldía
│   ├── admin-rutas.js Mapa operativo: rutas por cuadrilla
│   ├── fotos.js     Compresión de la foto antes de subirla
│   ├── datos.js     Etiquetas y colores
│   └── *.css
├── api/             Backend (Node + Express + pg)
│   ├── app.js       Las rutas de la API (no abre ningún puerto)
│   ├── server.js    Arranque local: levanta app.js en un puerto
│   ├── almacen.js   Fotos: disco en tu PC, Netlify Blobs en producción
│   ├── db.js        Conexión a PostgreSQL
│   ├── .env         Contraseña y token (NO se comparte)
│   └── uploads/     Fotos subidas
└── db/
    ├── schema.sql   Tablas, tipos, índices, trigger
    └── semilla.sql  9 departamentos + reportes de ejemplo
```

## Puesta en marcha

### Camino corto

```bash
powershell -ExecutionPolicy Bypass -File instalar.ps1
```

Crea la base, aplica el esquema, carga los datos iniciales y genera `api/.env`
con un token de administración aleatorio. Después queda un paso a mano: escribir
tu contraseña de PostgreSQL en `PGPASSWORD=` dentro de `api/.env`.

### Camino largo (paso a paso)

### 1. Crear la base

Con `psql` (está en `C:\Program Files\PostgreSQL\18\bin`). Va a pedir la contraseña
de `postgres` — la escribís vos, no queda guardada en ningún archivo del proyecto:

```bash
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -c "CREATE DATABASE bachometro"
```

### 2. Aplicar el esquema y los datos iniciales

```bash
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -d bachometro -f db/schema.sql
```

```bash
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -d bachometro -f db/semilla.sql
```

### 3. Configurar el `.env`

Copiar `api/.env.example` a `api/.env` y completar:

- `PGPASSWORD` — la contraseña de tu usuario `postgres`
- `ADMIN_TOKEN` — cualquier texto largo que inventes; es la llave del panel

### 4. Instalar dependencias y arrancar

```bash
npm install
```

```bash
npm start
```

Queda todo en **http://localhost:5173** — el mapa y la API en el mismo puerto.

## Direcciones

| Dirección | Qué es |
|---|---|
| `/` | Mapa público: ver y reportar baches |
| `/admin.html` | Panel de administración (pide el token) |
| `/api/...` | La API |

## El panel de administración

Se entra con el `ADMIN_TOKEN`. El token queda en `sessionStorage`: al cerrar la
pestaña se olvida, así que en una máquina compartida no queda la sesión abierta.

**Resumen** — totales, reportes de los últimos 7 días, confirmaciones, cantidad de
fotos y espacio en disco. Barras por estado, por gravedad y por departamento.

**Reportes** — tabla con todos los reportes de todos los departamentos:
- Filtros por departamento, estado, gravedad, fuente y búsqueda de texto
- Cambiar el estado desde la misma fila (reportado → verificado → en progreso → reparado)
- Editar cualquier dato del reporte
- Borrar de a uno, o seleccionar varios y borrar en lote
- Borrar solo la foto y dejar el reporte (útil si alguien sube algo que no corresponde)

**Ruta de bacheo** — el mapa operativo. Cada trabajo programado se dibuja desde la
alcaldía hasta el bache **con el color de la cuadrilla que lo tiene a cargo**:

- Se elige un trabajo de la lista y se pinta su ruta, con distancia y tiempo estimado
- **Mostrar todas las rutas a la vez** dibuja el operativo completo del departamento,
  con un resumen de cuántos trabajos y cuántos kilómetros lleva cada cuadrilla
- Botón **🚚 Mandar la cuadrilla** (el bache pasa a "En progreso" en el mapa público)
  y **✅ Marcar bacheo hecho** (pasa a "Reparado")
- Las cuadrillas se crean, se les cambia el color y se borran desde la misma pantalla
- Las rutas punteadas son trabajos ya ejecutados

Las cuadrillas son una tabla propia con color asignado, no texto libre: con texto libre
"Cuadrilla Norte" y "cuadrilla norte" eran dos cosas distintas y no se les podía dar un
color estable. Cada departamento tiene las suyas y no se mezclan.

**Fotos** — galería de todas las imágenes subidas, con borrado individual, y una
sección de *fotos huérfanas*: archivos que quedaron en `api/uploads/` sin ningún
reporte que los use. Se limpian con un botón.

Todo borrado pide confirmación. Al borrar un reporte se borra también su foto del
disco y sus votos (por el `ON DELETE CASCADE` de la tabla `votos`).

## La API

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/api/departamentos` | Los 9 departamentos |
| GET | `/api/reportes?depto=scz&cliente=<uuid>` | Reportes de un departamento |
| POST | `/api/reportes` | Crear un reporte (con la foto en base64) |
| POST | `/api/reportes/:id/voto` | "Yo también lo vi" |
| GET | `/api/estadisticas?depto=scz` | Conteo por estado |
| GET | `/api/alcaldias?depto=scz` | Alcaldías (para el pin del mapa) |
| GET | `/api/ruta?desdeLat=…&hastaLng=…` | Ruta por calle entre dos puntos |

Las de administración piden el header `x-admin-token`:

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/api/admin/sesion` | Validar el token |
| GET | `/api/admin/reportes` | Todos los reportes, con filtros |
| GET | `/api/admin/resumen` | Números para el tablero |
| PATCH | `/api/reportes/:id` | Editar campos |
| PATCH | `/api/reportes/:id/estado` | Cambiar el estado |
| DELETE | `/api/reportes/:id` | Borrar reporte + foto + votos |
| DELETE | `/api/reportes/:id/foto` | Borrar solo la foto |
| POST | `/api/admin/reportes/borrar` | Borrado en lote |
| GET | `/api/admin/cuadrillas?depto=scz` | Cuadrillas con su color y carga de trabajo |
| POST | `/api/admin/cuadrillas` | Crear una cuadrilla |
| PATCH | `/api/admin/cuadrillas/:id` | Cambiar nombre, color o estado |
| DELETE | `/api/admin/cuadrillas/:id` | Borrar (sus trabajos quedan sin asignar) |
| GET | `/api/admin/fotos-huerfanas` | Archivos sin reporte |
| POST | `/api/admin/fotos-huerfanas/borrar` | Limpiarlos |

## Cómo se guardan las cosas

| Qué | Dónde | Por qué |
|---|---|---|
| Reportes, votos, departamentos, alcaldías, cuadrillas, plan | PostgreSQL | Compartido entre todos |
| Fotos | `api/uploads/` + la ruta en la columna `foto_url` | Más rápido que meter binarios en la base |
| Id del navegador | `localStorage` | Para no votar dos veces el mismo bache |
| Token del panel | `sessionStorage` | Se borra al cerrar la pestaña |

**Un voto por navegador, no por persona.** La tabla `votos` tiene clave primaria
`(reporte_id, cliente_id)`, así que la base rechaza el voto repetido aunque
alguien manipule el frontend. Pero borrando los datos del navegador se puede votar
de nuevo: eso se arregla recién con login (Fase 3).

## Probarlo desde el celular (misma Wi-Fi)

1. Arrancar el servidor: `npm start`
2. Abrir el puerto en el firewall de Windows, **una vez, como administrador**:
   `New-NetFirewallRule -DisplayName "Bachometro 5173" -Direction Inbound -LocalPort 5173 -Protocol TCP -Action Allow -Profile Any`
3. En el celular entrar a `http://<IP-de-la-PC>:5173`

El botón **📍 GPS** solo aparece en HTTPS o en `localhost`: entrando por IP de red el
navegador no entrega la ubicación. Por eso el formulario tiene un mini-mapa donde se
toca para poner el pin.

> Los `.js` y el `.css` se piden con `?v=N`. Si cambiás uno y el navegador sigue
> mostrando la versión vieja, subí ese número.

## Publicarlo en Netlify

**No alcanza con arrastrar la carpeta.** Netlify con arrastrar-y-soltar solo
publica archivos estáticos, y esta app necesita además un proceso que corra la
API, una base PostgreSQL y un lugar donde guardar las fotos. Arrastrando `public/`
las dos páginas abren pero quedan sin datos.

El proyecto ya está preparado para los tres. Así queda repartido:

| Pieza | Dónde vive en Netlify |
|---|---|
| `index.html` y `admin.html` | El CDN, directo desde `public/` |
| La API (`app.js`) | Una función serverless (`netlify/functions/api.js`) |
| La base | Netlify DB (PostgreSQL sobre Neon) |
| Las fotos | Netlify Blobs |

### Pasos

1. **Subir el proyecto a GitHub.** Netlify despliega desde un repositorio; el
   `.gitignore` ya deja afuera `node_modules`, el `.env` y las fotos locales.

2. **Crear el sitio en Netlify** eligiendo ese repositorio. La configuración la
   toma de `netlify.toml`, no hay que completar nada a mano.

3. **Activar Netlify DB** desde el panel del sitio. Al crearla define sola la
   variable `NETLIFY_DATABASE_URL`, que es la que `db.js` busca primero.

4. **Crear las tablas en esa base.** Desde tu PC, con la URL que te dio Netlify:

   ```bash
   DATABASE_URL="postgresql://…" npm run db
   ```

5. **Definir `ADMIN_TOKEN`** en las variables de entorno del sitio. Es la llave
   del panel; sin ella `/admin.html` no deja entrar a nadie.

### Qué cambia respecto a tu PC

- **El GPS del celular empieza a funcionar**, porque Netlify sirve con HTTPS.
- **Las fotos ya no están en `api/uploads/`.** En serverless el disco de una
  función desaparece cuando la función termina, así que allá van a Netlify Blobs.
  `almacen.js` decide solo cuál usar según dónde esté corriendo.
- **Los datos son otros.** La base de Netlify arranca vacía: lo que cargaste en
  tu Postgres local no se copia. Para llevarlo hay que hacer un `pg_dump`.

## Roadmap

### Fase 1 — Boceto ✅
Todo en el navegador, datos de ejemplo.

### Fase 2 — Backend y datos compartidos ✅
PostgreSQL, API REST, fotos en el servidor, panel de administración.

### Fase 3 — Usuarios
- Login (email o Google) — reemplaza al `ADMIN_TOKEN` y al id de navegador
- Voto real: uno por persona
- Roles: ciudadano, moderador, administrador
- Moderación de fotos antes de publicarlas

### Fase 4 — Datos externos y estadísticas
- Importar alertas de Waze de verdad (hoy las de ejemplo están marcadas como tales)
- Presupuesto por zona, como el sitio original
- Tiempo promedio de reparación, ranking de calles peores

### Fase 5 — Producto
- PWA instalable
- Notificaciones cuando reparan un bache que reportaste
- Deploy con HTTPS (ahí el GPS empieza a funcionar en el celular)

## Pendientes conocidos

- **No hay login**: el panel se protege con un token compartido. Sirve para una o dos
  personas de confianza, no para un equipo.
- **Las fotos no se moderan**: se publican apenas se suben. El panel permite borrarlas
  después, pero no antes.
- **`api/node_modules` vive dentro de OneDrive**, que sincroniza miles de archivos y
  hace lento el `npm install`. Si molesta, mover el proyecto fuera de OneDrive.
