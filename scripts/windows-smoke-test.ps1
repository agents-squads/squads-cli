# Windows smoke test: PowerShell parity for scripts/e2e-smoke.sh
#
# Simulates a real Windows user installing squads-cli from npm and running
# their first commands. Catches Windows-specific packaging or path bugs
# that Linux/macOS CI misses.
#
# Usage (from repo root):
#   pwsh scripts/windows-smoke-test.ps1                  # use published @latest
#   pwsh scripts/windows-smoke-test.ps1 -FromTarball     # build + pack local tarball
#   pwsh scripts/windows-smoke-test.ps1 -Tag next        # use @next dist-tag
#
# Requirements: PowerShell 7+, Node 18+, npm, git.

[CmdletBinding()]
param(
    [switch]$FromTarball,
    [string]$Tag = 'latest'
)

$ErrorActionPreference = 'Stop'

function Step($name) {
    Write-Host ""
    Write-Host "=== STEP: $name ===" -ForegroundColor Cyan
}

function Require($cmd, $hint) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Write-Host "  Missing: $cmd" -ForegroundColor Red
        Write-Host "  $hint" -ForegroundColor DarkGray
        exit 1
    }
}

# ── Pre-flight ──────────────────────────────────────────────────────────────

Step "Pre-flight checks"
Require 'node' 'Install Node.js 18+ from https://nodejs.org'
Require 'npm'  'npm ships with Node.js'
Require 'git'  'Install Git from https://git-scm.com'

$nodeVersion = (node --version) -replace 'v',''
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 18) {
    Write-Host "  Node $nodeVersion is too old. Need 18+." -ForegroundColor Red
    exit 1
}
Write-Host "  Node $nodeVersion - OK" -ForegroundColor Green
Write-Host "  npm  $(npm --version) - OK" -ForegroundColor Green

# ── Determine install source ────────────────────────────────────────────────

$repoRoot = Resolve-Path "$PSScriptRoot/.."
$tarballPath = $null

if ($FromTarball) {
    Step "Building local tarball"
    Push-Location $repoRoot
    try {
        npm run build
        $tarball = (npm pack --quiet | Select-Object -Last 1).Trim()
        $tarballPath = Join-Path $repoRoot $tarball
        Write-Host "  Built: $tarball" -ForegroundColor Green
    } finally {
        Pop-Location
    }
}

# ── Cleanup hook ────────────────────────────────────────────────────────────

$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "squads-smoke-$([guid]::NewGuid().ToString('N').Substring(0,8))"

function Cleanup {
    Write-Host ""
    Write-Host "▶ Cleaning up..." -ForegroundColor DarkGray
    npm uninstall -g squads-cli 2>$null
    if (Test-Path $tmpDir) { Remove-Item -Recurse -Force $tmpDir }
    if ($tarballPath -and (Test-Path $tarballPath)) { Remove-Item -Force $tarballPath }
}

try {
    # ── Install ─────────────────────────────────────────────────────────────

    Step "Installing squads-cli"
    if ($FromTarball) {
        npm install -g $tarballPath
    } else {
        npm install -g "squads-cli@$Tag"
    }

    # ── Smoke ───────────────────────────────────────────────────────────────

    New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
    Push-Location $tmpDir
    try {
        git init -q
        git config user.email "smoke@test.local"
        git config user.name "Smoke Test"
        git commit --allow-empty -q -m "init"

        Step "squads --version"
        squads --version

        Step "squads --help (footer should show Resources block)"
        $help = squads --help
        $help | Select-Object -Last 8
        if ($help -notmatch 'Changelog') {
            Write-Host "  WARN: Resources footer missing from --help output" -ForegroundColor Yellow
        }

        Step "squads init --yes --force"
        squads init --yes --force

        Step "squads status"
        squads status

        Step "squads doctor"
        try { squads doctor } catch { Write-Host "  doctor reported issues (non-fatal)" -ForegroundColor Yellow }

        Step "squads run <squad> --dry-run"
        $statusOutput = squads status 2>$null
        $firstSquad = ($statusOutput | Select-String -Pattern '^\s+(\w+)' | Select-Object -First 1).Matches.Groups[1].Value
        if ($firstSquad) {
            try { squads run $firstSquad --dry-run } catch { Write-Host "  dry-run reported issues (non-fatal)" -ForegroundColor Yellow }
        } else {
            Write-Host "  skip: no squads found after init" -ForegroundColor Yellow
        }
    } finally {
        Pop-Location
    }

    Write-Host ""
    Write-Host "All Windows smoke test steps passed" -ForegroundColor Green
} finally {
    Cleanup
}
