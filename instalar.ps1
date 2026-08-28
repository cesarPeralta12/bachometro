# ============================================================
# Bachómetro — puesta en marcha de la base de datos.
#
#   .\instalar.ps1
#
# psql va a pedir la contraseña de PostgreSQL varias veces. Esa contraseña
# no se guarda en este script ni queda en el historial de PowerShell.
# ============================================================

$ErrorActionPreference = 'Stop'
$raiz = $PSScriptRoot

# ---------- Encontrar psql ----------
$psql = (Get-Command psql -ErrorAction SilentlyContinue).Source
if (-not $psql) {
    $candidatos = Get-ChildItem "C:\Program Files\PostgreSQL\*\bin\psql.exe" -ErrorAction SilentlyContinue |
                  Sort-Object FullName -Descending
    if ($candidatos) { $psql = $candidatos[0].FullName }
}
if (-not $psql) {
    Write-Host "No encontre psql.exe. Instala PostgreSQL o agregalo al PATH." -ForegroundColor Red
    exit 1
}
Write-Host "psql: $psql" -ForegroundColor DarkGray

$usuario = Read-Host "Usuario de PostgreSQL (Enter para 'postgres')"
if ([string]::IsNullOrWhiteSpace($usuario)) { $usuario = 'postgres' }

# ---------- 1. Crear la base ----------
Write-Host "`n[1/3] Creando la base 'bachometro'..." -ForegroundColor Cyan
& $psql -U $usuario -c "CREATE DATABASE bachometro" 2>&1 | ForEach-Object {
    if ($_ -match 'already exists|ya existe') { Write-Host "  Ya existia, se reutiliza." -ForegroundColor Yellow }
    else { $_ }
}

# ---------- 2. Esquema y datos iniciales ----------
Write-Host "`n[2/3] Aplicando el esquema..." -ForegroundColor Cyan
& $psql -U $usuario -d bachometro -v ON_ERROR_STOP=1 -f (Join-Path $raiz 'db\schema.sql')
if ($LASTEXITCODE -ne 0) { Write-Host "Fallo el esquema." -ForegroundColor Red; exit 1 }

Write-Host "`nCargando departamentos, alcaldias y ejemplos..." -ForegroundColor Cyan
& $psql -U $usuario -d bachometro -v ON_ERROR_STOP=1 -f (Join-Path $raiz 'db\semilla.sql')
if ($LASTEXITCODE -ne 0) { Write-Host "Fallo la semilla." -ForegroundColor Red; exit 1 }

# ---------- 3. Archivo .env ----------
$env_path = Join-Path $raiz 'api\.env'
Write-Host "`n[3/3] Configuracion..." -ForegroundColor Cyan

if (Test-Path $env_path) {
    Write-Host "  api\.env ya existe, no lo toco." -ForegroundColor Yellow
} else {
    # Token del panel: aleatorio, para no dejar uno adivinable.
    $bytes = New-Object byte[] 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $token = [Convert]::ToBase64String($bytes) -replace '[+/=]', ''

    @"
PGHOST=localhost
PGPORT=5432
PGDATABASE=bachometro
PGUSER=$usuario
PGPASSWORD=

PORT=5173

ADMIN_TOKEN=$token
"@ | Out-File -FilePath $env_path -Encoding utf8

    Write-Host "  Cree api\.env con este token de administracion:" -ForegroundColor Green
    Write-Host "  $token" -ForegroundColor White
    Write-Host "  Guardalo: es la llave del panel." -ForegroundColor Green
}

Write-Host "`n--------------------------------------------" -ForegroundColor Green
Write-Host "Base lista. Falta un paso manual:" -ForegroundColor Green
Write-Host "  1. Abri api\.env y escribi tu contrasena en PGPASSWORD="
Write-Host "  2. Arranca el servidor:  npm start --prefix api"
Write-Host "  3. Entra a http://localhost:5173"
Write-Host "     y al panel en http://localhost:5173/admin.html"
Write-Host "--------------------------------------------" -ForegroundColor Green
