@echo off
setlocal EnableDelayedExpansion

REM ─── Tom Lander Web Terrain Editor launcher ─────────────────────────────────
REM Starts a static HTTP server and opens the editor in your default browser.
REM
REM Behaviour:
REM   1. If the parent's parent has an "assets\textures" folder (i.e. this
REM      bundle sits inside the game repo at utilities\WebTerrainEditor),
REM      serve from the game root so the editor can fetch real game maps and
REM      textures via "../../assets/...".
REM   2. Otherwise, serve from this folder. The editor still works fully via
REM      File > Open; quick map presets won't load unless you set the
REM      "Game Root URL" via the File menu.
REM
REM Requires either Python 3 (preferred) or PowerShell 5+.

set "EDITOR_DIR=%~dp0"
set "EDITOR_DIR=%EDITOR_DIR:~0,-1%"
set "REL_URL=index.html"

pushd "%EDITOR_DIR%\..\.." >nul 2>&1
if errorlevel 1 goto SERVE_LOCAL
if exist "assets\textures" (
  set "SERVE_DIR=%CD%"
  set "REL_URL=utilities/WebTerrainEditor/index.html"
  popd
  goto FOUND_ROOT
)
popd

:SERVE_LOCAL
set "SERVE_DIR=%EDITOR_DIR%"

:FOUND_ROOT

set /a PORT=8765
set "URL=http://localhost:%PORT%/%REL_URL%"

echo ─────────────────────────────────────────────
echo  Tom Lander Web Terrain Editor
echo  serving:  %SERVE_DIR%
echo  url:      %URL%
echo  press Ctrl+C in this window to stop
echo ─────────────────────────────────────────────

REM ── try python ─────────────────────────────────────────────────────────────
where python >nul 2>&1
if not errorlevel 1 (
  start "" "%URL%"
  pushd "%SERVE_DIR%"
  python -m http.server %PORT% --bind 127.0.0.1
  popd
  goto END
)
where py >nul 2>&1
if not errorlevel 1 (
  start "" "%URL%"
  pushd "%SERVE_DIR%"
  py -3 -m http.server %PORT% --bind 127.0.0.1
  popd
  goto END
)

REM ── powershell fallback (single-threaded but works) ────────────────────────
where powershell >nul 2>&1
if not errorlevel 1 (
  start "" "%URL%"
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '%SERVE_DIR%'; $listener = [System.Net.HttpListener]::new(); $listener.Prefixes.Add('http://127.0.0.1:%PORT%/'); $listener.Start(); Write-Host 'PowerShell static server on %PORT%'; while ($listener.IsListening) { try { $ctx = $listener.GetContext(); $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/')); if ($rel -eq '') { $rel = 'index.html' }; $path = Join-Path -LiteralPath '%SERVE_DIR%' -ChildPath $rel; if (Test-Path -LiteralPath $path -PathType Leaf) { $bytes = [IO.File]::ReadAllBytes($path); $ext = [IO.Path]::GetExtension($path).ToLower(); switch ($ext) { '.html' { $ctx.Response.ContentType = 'text/html' } '.js' { $ctx.Response.ContentType = 'application/javascript' } '.css' { $ctx.Response.ContentType = 'text/css' } '.json' { $ctx.Response.ContentType = 'application/json' } '.png' { $ctx.Response.ContentType = 'image/png' } default { $ctx.Response.ContentType = 'application/octet-stream' } }; $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length); } else { $ctx.Response.StatusCode = 404 }; $ctx.Response.Close(); } catch { } }"
  goto END
)

echo ERROR: Neither python nor PowerShell was found on PATH.
echo Install Python 3 from https://python.org and re-run this script.
pause

:END
endlocal
