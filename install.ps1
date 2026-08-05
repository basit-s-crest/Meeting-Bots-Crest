# ==============================================================================
# CrestMeet Central Installation Script (PowerShell)
# Installs dependencies for Backend, Frontend, Playwright Bots, and Memory Service
# ==============================================================================

$rootDir = $PSScriptRoot

Write-Host ""
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "   CrestMeet - Central Installation & Environment Setup" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host ""

# Helper function to print step headers
function Print-Step ($stepNumber, $stepTitle) {
    Write-Host ""
    Write-Host "[$stepNumber] $stepTitle" -ForegroundColor Yellow
    Write-Host "------------------------------------------------------------------" -ForegroundColor DarkGray
}

# ------------------------------------------------------------------------------
# Step 1: Check Prerequisites
# ------------------------------------------------------------------------------
Print-Step "1/8" "Checking System Prerequisites"

try {
    $nodeVersion = node -v 2>$null
    if ($nodeVersion) {
        Write-Host "  [OK] Node.js detected: $nodeVersion" -ForegroundColor Green
    } else {
        Write-Host "  [ERROR] Node.js is missing! Install Node.js 18+ from https://nodejs.org/" -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "  [ERROR] Node.js check failed." -ForegroundColor Red
    exit 1
}

try {
    $npmVersion = npm -v 2>$null
    if ($npmVersion) {
        Write-Host "  [OK] npm detected: v$npmVersion" -ForegroundColor Green
    } else {
        Write-Host "  [ERROR] npm is missing!" -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "  [ERROR] npm check failed." -ForegroundColor Red
    exit 1
}

try {
    $pythonVersion = python --version 2>$null
    if ($pythonVersion) {
        Write-Host "  [OK] Python detected: $pythonVersion" -ForegroundColor Green
    } else {
        Write-Host "  [WARN] Python is not in PATH." -ForegroundColor Yellow
    }
} catch {
    Write-Host "  [WARN] Python check warning." -ForegroundColor Yellow
}

try {
    $ngrokVersion = ngrok --version 2>$null
    if ($ngrokVersion) {
        Write-Host "  [OK] Ngrok detected: $ngrokVersion" -ForegroundColor Green
    } else {
        Write-Host "  [WARN] Ngrok is not in PATH. Attempting winget installation..." -ForegroundColor Yellow
        $hasWinget = Get-Command "winget" -ErrorAction SilentlyContinue
        if ($hasWinget) {
            winget install --id ngrok.ngrok --silent --accept-package-agreements --accept-source-agreements
            if ($LASTEXITCODE -eq 0) {
                Write-Host "  [OK] Ngrok installed via winget." -ForegroundColor Green
            } else {
                Write-Host "  [WARN] Winget ngrok install skipped. Download from https://ngrok.com/" -ForegroundColor Yellow
            }
        } else {
            Write-Host "  [WARN] Winget not found. Please install ngrok manually from https://ngrok.com/" -ForegroundColor Yellow
        }
    }
} catch {
    Write-Host "  [WARN] Ngrok check completed." -ForegroundColor Yellow
}

# ------------------------------------------------------------------------------
# Step 2: Configure Environment File (.env)
# ------------------------------------------------------------------------------
Print-Step "2/8" "Setting up Environment File (.env)"

$envPath = Join-Path $rootDir ".env"
$envExamplePath = Join-Path $rootDir ".env.example"

if (-not (Test-Path $envPath)) {
    if (Test-Path $envExamplePath) {
        Copy-Item $envExamplePath $envPath
        Write-Host "  [OK] Created .env file from .env.example template." -ForegroundColor Green
    } else {
        Write-Host "  [WARN] .env file missing and .env.example not found." -ForegroundColor Yellow
    }
} else {
    Write-Host "  [OK] Existing .env file detected." -ForegroundColor Green
}

# ------------------------------------------------------------------------------
# Step 3: Install Dashboard Backend Dependencies
# ------------------------------------------------------------------------------
Print-Step "3/8" "Installing Dashboard Backend Dependencies (dashboard/backend)"
Set-Location (Join-Path $rootDir "dashboard/backend")
npm install
if ($LASTEXITCODE -eq 0) {
    Write-Host "  [OK] Dashboard Backend dependencies installed." -ForegroundColor Green
} else {
    Write-Host "  [ERROR] Failed to install Backend dependencies." -ForegroundColor Red
}

# ------------------------------------------------------------------------------
# Step 4: Install Dashboard Frontend Dependencies
# ------------------------------------------------------------------------------
Print-Step "4/8" "Installing Dashboard Frontend Dependencies (dashboard/frontend)"
Set-Location (Join-Path $rootDir "dashboard/frontend")
npm install
if ($LASTEXITCODE -eq 0) {
    Write-Host "  [OK] Dashboard Frontend dependencies installed." -ForegroundColor Green
} else {
    Write-Host "  [ERROR] Failed to install Frontend dependencies." -ForegroundColor Red
}

# ------------------------------------------------------------------------------
# Step 5: Install Playwright Meeting Bots Dependencies
# ------------------------------------------------------------------------------
Print-Step "5/8" "Installing Playwright Bots (Google Meet, Zoom, Microsoft Teams)"

Write-Host "  -> Google Meet Bot..." -ForegroundColor Gray
Set-Location (Join-Path $rootDir "Google Meet")
npm install

Write-Host "  -> Zoom Bot..." -ForegroundColor Gray
Set-Location (Join-Path $rootDir "Zoom")
npm install

Write-Host "  -> Microsoft Teams Bot..." -ForegroundColor Gray
Set-Location (Join-Path $rootDir "Microsoft Teams")
npm install

Write-Host "  [OK] All bot dependencies installed." -ForegroundColor Green

# ------------------------------------------------------------------------------
# Step 6: Install Playwright Chromium Browser Binaries
# ------------------------------------------------------------------------------
Print-Step "6/8" "Installing Playwright Browser Binaries"
Set-Location (Join-Path $rootDir "Google Meet")
npx playwright install chromium
if ($LASTEXITCODE -eq 0) {
    Write-Host "  [OK] Playwright Chromium browser binaries installed." -ForegroundColor Green
} else {
    Write-Host "  [WARN] Playwright browser installation completed." -ForegroundColor Yellow
}

# ------------------------------------------------------------------------------
# Step 7: Install Memory Service (Python dependencies)
# ------------------------------------------------------------------------------
Print-Step "7/8" "Installing Python Memory Service (memory-service)"
Set-Location (Join-Path $rootDir "memory-service")

$hasUv = Get-Command "uv" -ErrorAction SilentlyContinue
if ($hasUv) {
    Write-Host "  -> Syncing Python environment using UV..." -ForegroundColor Gray
    uv sync
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  [OK] Python Memory Service dependencies synced with UV." -ForegroundColor Green
    } else {
        Write-Host "  [WARN] UV sync completed with status code $LASTEXITCODE." -ForegroundColor Yellow
    }
} else {
    Write-Host "  -> Setting up Python virtual environment with pip..." -ForegroundColor Gray
    if (-not (Test-Path ".venv")) {
        python -m venv .venv
    }
    & .\.venv\Scripts\python -m pip install -e .
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  [OK] Python Memory Service installed into .venv." -ForegroundColor Green
    } else {
        Write-Host "  [ERROR] Memory Service pip installation failed." -ForegroundColor Red
    }
}

# ------------------------------------------------------------------------------
# Step 8: Return to Root & Display Summary
# ------------------------------------------------------------------------------
Set-Location $rootDir

Write-Host ""
Write-Host "==================================================================" -ForegroundColor Green
Write-Host "   CrestMeet Installation Completed Successfully!" -ForegroundColor Green
Write-Host "==================================================================" -ForegroundColor Green
Write-Host " Next Steps:" -ForegroundColor Cyan
Write-Host "   1. Edit your .env file with your API keys and credentials" -ForegroundColor White
Write-Host "   2. Run the launch script to start all services:" -ForegroundColor White
Write-Host "      .\start.ps1" -ForegroundColor Yellow
Write-Host ""
