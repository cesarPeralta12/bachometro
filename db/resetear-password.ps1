# ============================================================
# Reset de la contraseña de PostgreSQL.
#
#   Abrir PowerShell COMO ADMINISTRADOR y correr:
#     .\db\resetear-password.ps1
#
# Qué hace, en orden:
#   1. Respalda pg_hba.conf
#   2. Lo pone en modo "trust" (entrada local sin contraseña)
#   3. Reinicia PostgreSQL y verifica que realmente arrancó
#   4. Te pide la contraseña nueva y la aplica
#   5. Restaura pg_hba.conf tal cual estaba
#   6. Reinicia de nuevo
#
# La ventana entre los pasos 2 y 5 dura segundos, pero durante ese rato
# cualquiera con acceso a esta máquina puede entrar a la base sin contraseña.
# Por eso el restaurado está en un bloque finally: corre aunque algo falle.
#
# La contraseña se pide en pantalla y nunca se escribe en este archivo.
# ============================================================

$ErrorActionPreference = 'Stop'

# ---------- Verificar que estamos como administrador ----------
$esAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $esAdmin) {
    Write-Host "Este script necesita permisos de administrador." -ForegroundColor Red
    Write-Host "Cerra esta ventana, hace clic derecho en Inicio -> 'Terminal (Administrador)'," -ForegroundColor Red
    Write-Host "y volve a correrlo desde ahi." -ForegroundColor Red
    exit 1
}

# ---------- Ubicar la instalacion ----------
$servicio = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $servicio) { Write-Host "No encontre el servicio de PostgreSQL." -ForegroundColor Red; exit 1 }

$instalacion = Get-ChildItem "C:\Program Files\PostgreSQL" -Directory -ErrorAction SilentlyContinue |
               Sort-Object Name -Descending | Select-Object -First 1
if (-not $instalacion) { Write-Host "No encontre la carpeta de PostgreSQL." -ForegroundColor Red; exit 1 }

$hba    = Join-Path $instalacion.FullName 'data\pg_hba.conf'
$psql   = Join-Path $instalacion.FullName 'bin\psql.exe'
$logDir = Join-Path $instalacion.FullName 'data\log'

foreach ($archivo in @($hba, $psql)) {
    if (-not (Test-Path $archivo)) { Write-Host "No existe: $archivo" -ForegroundColor Red; exit 1 }
}

Write-Host "Servicio:     $($servicio.Name)"        -ForegroundColor DarkGray
Write-Host "Instalacion:  $($instalacion.FullName)" -ForegroundColor DarkGray

# ============================================================
# Funciones auxiliares
# ============================================================

# pg_hba.conf NO admite BOM: si el archivo empieza con la marca de UTF-8,
# PostgreSQL no puede leer la primera linea y se niega a arrancar.
# Set-Content -Encoding utf8 en Windows PowerShell 5.1 SIEMPRE agrega BOM,
# por eso se escribe con .NET indicando explicitamente "sin BOM".
function Escribir-SinBOM($ruta, $lineas) {
    $sinBOM = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllLines($ruta, $lineas, $sinBOM)
}

function Postgres-Responde($puerto = 5432) {
    try {
        $cliente = New-Object System.Net.Sockets.TcpClient
        $conexion = $cliente.BeginConnect('127.0.0.1', $puerto, $null, $null)
        $ok = $conexion.AsyncWaitHandle.WaitOne(1000, $false)
        $cliente.Close()
        return $ok
    } catch { return $false }
}

# Restart-Service falla si el arranque tarda mas que su timeout, aunque el
# servicio despues levante bien. Se hace a mano: parar, esperar, arrancar,
# esperar, y recien confirmar cuando el puerto contesta.
function Reiniciar-Postgres($nombre) {
    $svc = Get-Service $nombre

    if ($svc.Status -ne 'Stopped') {
        Stop-Service $nombre -Force -ErrorAction SilentlyContinue
        try { $svc.WaitForStatus('Stopped', '00:00:45') } catch {}
    }

    Start-Service $nombre -ErrorAction SilentlyContinue
    try { (Get-Service $nombre).WaitForStatus('Running', '00:00:45') } catch {}

    for ($i = 0; $i -lt 30; $i++) {
        if ((Get-Service $nombre).Status -eq 'Running' -and (Postgres-Responde)) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

function Mostrar-UltimoLog {
    $log = Get-ChildItem "$logDir\*.log" -ErrorAction SilentlyContinue |
           Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($log -and $log.Length -gt 0) {
        Write-Host "`nUltimas lineas del log de PostgreSQL:" -ForegroundColor Yellow
        Get-Content $log.FullName -Tail 10 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
    }
}

# ============================================================
# Proceso
# ============================================================

$usuario = Read-Host "`nUsuario a modificar (Enter para 'postgres')"
if ([string]::IsNullOrWhiteSpace($usuario)) { $usuario = 'postgres' }

$clave1 = Read-Host "Contrasena nueva para '$usuario'" -AsSecureString
$clave2 = Read-Host "Repetila para confirmar"           -AsSecureString

$texto1 = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($clave1))
$texto2 = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($clave2))

if ($texto1 -ne $texto2) { Write-Host "Las contrasenas no coinciden." -ForegroundColor Red; exit 1 }
if ([string]::IsNullOrWhiteSpace($texto1)) { Write-Host "La contrasena no puede quedar vacia." -ForegroundColor Red; exit 1 }

$respaldo = "$hba.respaldo-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item $hba $respaldo
Write-Host "`nRespaldo guardado en:`n  $respaldo" -ForegroundColor DarkGray

$cambiada = $false

try {
    # ---------- 1. Modo trust ----------
    Write-Host "`n[1/4] Abriendo el acceso local temporalmente..." -ForegroundColor Cyan

    # Solo se tocan las reglas reales; las lineas que empiezan con # son
    # comentarios que explican los metodos y no hay que alterarlas.
    $lineas = Get-Content $hba | ForEach-Object {
        if ($_ -match '^\s*#' -or $_ -match '^\s*$') { $_ }
        else { $_ -replace '(scram-sha-256|md5|password)\s*$', 'trust' }
    }
    Escribir-SinBOM $hba $lineas

    # ---------- 2. Reiniciar y comprobar ----------
    Write-Host "[2/4] Reiniciando PostgreSQL..." -ForegroundColor Cyan
    if (-not (Reiniciar-Postgres $servicio.Name)) {
        Mostrar-UltimoLog
        throw "PostgreSQL no arranco con la configuracion temporal."
    }
    Write-Host "      Arranco y responde en el puerto 5432." -ForegroundColor DarkGray

    # ---------- 3. Cambiar la contrasena ----------
    Write-Host "[3/4] Aplicando la contrasena nueva..." -ForegroundColor Cyan

    # Las comillas simples se duplican para que una contrasena que las
    # contenga no rompa la sentencia SQL.
    $escapada = $texto1 -replace "'", "''"
    $sql = "ALTER USER `"$usuario`" WITH PASSWORD '$escapada';"

    # El SQL va por la entrada estandar: asi no queda en la linea de comandos
    # ni en la lista de procesos.
    $sql | & $psql -U $usuario -d postgres -h 127.0.0.1 -v ON_ERROR_STOP=1 -f -
    if ($LASTEXITCODE -ne 0) { throw "psql devolvio error $LASTEXITCODE" }

    $cambiada = $true
}
catch {
    Write-Host "`nFallo: $($_.Exception.Message)" -ForegroundColor Red
}
finally {
    # ---------- 4. Restaurar SIEMPRE ----------
    Write-Host "[4/4] Restaurando la configuracion original..." -ForegroundColor Cyan
    Copy-Item $respaldo $hba -Force

    if (Reiniciar-Postgres $servicio.Name) {
        Write-Host "      PostgreSQL volvio a la normalidad." -ForegroundColor DarkGray
    } else {
        Write-Host "`nATENCION: PostgreSQL no volvio a arrancar." -ForegroundColor Red
        Write-Host "El archivo original esta en:`n  $respaldo" -ForegroundColor Red
        Mostrar-UltimoLog
    }

    # Limpiar la contrasena de la memoria del script.
    $texto1 = $null; $texto2 = $null; $escapada = $null; $sql = $null
    [GC]::Collect()
}

Write-Host ""
if ($cambiada) {
    Write-Host "--------------------------------------------" -ForegroundColor Green
    Write-Host "Listo. La contrasena de '$usuario' quedo cambiada" -ForegroundColor Green
    Write-Host "y el acceso volvio a pedir contrasena." -ForegroundColor Green
    Write-Host ""
    Write-Host "Ahora abri este archivo:" -ForegroundColor Green
    Write-Host "  $(Join-Path (Split-Path $PSScriptRoot -Parent) 'api\.env')"
    Write-Host "y escribi la misma contrasena en la linea  PGPASSWORD="
    Write-Host "--------------------------------------------" -ForegroundColor Green
} else {
    Write-Host "--------------------------------------------" -ForegroundColor Yellow
    Write-Host "La contrasena NO se cambio." -ForegroundColor Yellow
    Write-Host "La configuracion quedo como estaba." -ForegroundColor Yellow
    Write-Host "--------------------------------------------" -ForegroundColor Yellow
}
