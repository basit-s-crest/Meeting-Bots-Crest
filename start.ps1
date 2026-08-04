# ==============================================================================
# CrestMeet Central Launch Script (PowerShell)
# Starts Backend, Frontend, Memory Service, and Ngrok Tunnel concurrently
# ==============================================================================

param (
    [switch]$Background = $false,
    [switch]$NoNgrok = $false
)

$rootDir = $PSScriptRoot

Write-Host ""
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "   CrestMeet - Central Multi-Service Launcher" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host ""

# Check if .env exists
$envPath = Join-Path $rootDir ".env"
if (-not (Test-Path $envPath)) {
    Write-Host "  [WARN] .env file not found in root folder ($rootDir)." -ForegroundColor Yellow
    Write-Host "  Please run .\install.ps1 first to setup environment template." -ForegroundColor Yellow
    Write-Host ""
}

$backendDir = Join-Path $rootDir "dashboard/backend"
$frontendDir = Join-Path $rootDir "dashboard/frontend"
$memoryDir = Join-Path $rootDir "memory-service"

$hasNgrok = (Get-Command "ngrok" -ErrorAction SilentlyContinue) -and (-not $NoNgrok)

if ($Background) {
    Write-Host "Starting CrestMeet services in Background Jobs..." -ForegroundColor Yellow

    # Start Backend Job
    Start-Job -Name "CrestMeet-Backend" -ScriptBlock {
        param($dir)
        Set-Location $dir
        npm start
    } -ArgumentList $backendDir

    # Start Frontend Job
    Start-Job -Name "CrestMeet-Frontend" -ScriptBlock {
        param($dir)
        Set-Location $dir
        npm run dev
    } -ArgumentList $frontendDir

    # Start Memory Service Job
    Start-Job -Name "CrestMeet-MemoryService" -ScriptBlock {
        param($dir)
        Set-Location $dir
        $hasUv = Get-Command "uv" -ErrorAction SilentlyContinue
        if ($hasUv) {
            uv run serve
        } else {
            & .\.venv\Scripts\python -m uvicorn app.main:app --port 8001
        }
    } -ArgumentList $memoryDir

    # Start Ngrok Tunnel Job
    if ($hasNgrok) {
        Start-Job -Name "CrestMeet-Ngrok" -ScriptBlock {
            ngrok http 3000
        }
        Write-Host "  [OK] Ngrok HTTP 3000 tunnel started in background job!" -ForegroundColor Green
    }

    Write-Host "  [OK] All core services started in background jobs!" -ForegroundColor Green
    Write-Host ""
    Write-Host "To view background job status:   Get-Job" -ForegroundColor Gray
    Write-Host "To view a service log:           Receive-Job -Name CrestMeet-Backend -Keep" -ForegroundColor Gray
    Write-Host "To stop all background jobs:     Stop-Job -Name CrestMeet-*" -ForegroundColor Gray
    Write-Host ""

} else {
    Write-Host "Launching CrestMeet services in individual PowerShell windows..." -ForegroundColor Yellow

    # Launch Backend Terminal Window
    Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$backendDir'; Write-Host '--- CrestMeet Backend Server (Port 3000) ---' -ForegroundColor Cyan; npm start"

    # Launch Frontend Terminal Window
    Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$frontendDir'; Write-Host '--- CrestMeet Frontend App ---' -ForegroundColor Magenta; npm run dev"

    # Launch Memory Service Terminal Window
    $memoryCmd = "Set-Location '$memoryDir'; Write-Host '--- CrestMeet Memory Service (Port 8001) ---' -ForegroundColor Green; if (Get-Command 'uv' -ErrorAction SilentlyContinue) { uv run serve } else { & .\.venv\Scripts\python -m uvicorn app.main:app --port 8001 }"
    Start-Process powershell -ArgumentList "-NoExit", "-Command", $memoryCmd

    # Launch Ngrok Tunnel Terminal Window
    if ($hasNgrok) {
        Start-Process powershell -ArgumentList "-NoExit", "-Command", "Write-Host '--- CrestMeet Ngrok Tunnel (Port 3000) ---' -ForegroundColor Yellow; ngrok http 3000"
        Write-Host "  [OK] Launched Ngrok HTTP 3000 tunnel window." -ForegroundColor Green
    }

    Write-Host "  [OK] Services launched in separate terminal windows!" -ForegroundColor Green
    Write-Host ""
}

Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "   Active CrestMeet Endpoints and Access Links" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "  Frontend Dashboard:       http://localhost:3000 (or http://localhost:3001)" -ForegroundColor White
Write-Host "  Backend Express API:      http://localhost:3000" -ForegroundColor White
Write-Host "  Python Memory Service:   http://localhost:8001" -ForegroundColor White
if ($hasNgrok) {
    Write-Host "  Ngrok Webhook Tunnel:     http://localhost:4040 (Tunnel details)" -ForegroundColor White
}
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host ""
