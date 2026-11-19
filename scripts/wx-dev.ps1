# Local stack for testing the mini program in WeChat DevTools, all in Docker
# (no local Go, and nothing unsigned runs on the host):
#   act-pg         Postgres, database act_wxdev
#   act-wx-mock    cmd/devmock: stand-in WeChat + model   → 127.0.0.1:8090
#   act-wx-server  ACT                                     → 127.0.0.1:8080 (what the simulator calls)
#
#   .\scripts\wx-dev.ps1        builds, starts, and follows the server log (Ctrl-C stops it)
#   curl.exe -X POST "http://127.0.0.1:8090/mock/grant?n=10"   add stamps (stands in for a purchase)
#
# Vera's replies come from devmock unless a model key is given, e.g.
#   .\scripts\wx-dev.ps1 -KeyFile D:\.ENV -KeyName HUNYUAN_LLM_API_KEY
# which uses the real model (ACT's default base URL and models). The key is
# handed to the container by name only: never on a command line, never printed.
param([string]$KeyFile = '', [string]$KeyName = 'ACT_LLM_API_KEY')
#
# Native tools report through exit codes; Windows PowerShell 5.1 would turn
# their stderr into terminating errors under 'Stop'.
$ErrorActionPreference = 'Continue'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$net = 'act-wxdev'

Write-Host 'building linux binaries...'
docker run --rm -v "${root}:/src" -w /src -v act-gomod:/go/pkg/mod golang:1.26 sh -c 'go build -o bin/linux/act ./cmd/act && go build -o bin/linux/devmock ./cmd/devmock'
if ($LASTEXITCODE -ne 0) { exit 1 }

docker network inspect $net *> $null
if ($LASTEXITCODE -ne 0) { docker network create $net | Out-Null }

docker container inspect act-pg *> $null
if ($LASTEXITCODE -ne 0) {
  docker run -d --name act-pg --network $net -e POSTGRES_USER=act -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=act -p 127.0.0.1:55850:5432 postgres:17 | Out-Null
} else {
  docker start act-pg *> $null
  docker network connect $net act-pg *> $null
}
# A new Postgres container answers once, restarts after initdb, then stays up:
# retry until the database exists rather than trusting the first pg_isready.
for ($i = 0; $i -lt 60; $i++) {
  $exists = docker exec act-pg psql -U act -tAc "SELECT 1 FROM pg_database WHERE datname='act_wxdev'" 2>$null
  if ("$exists".Trim() -eq '1') { break }
  docker exec act-pg psql -U act -c "CREATE DATABASE act_wxdev" *> $null
  Start-Sleep -Milliseconds 500
}

docker rm -f act-wx-mock act-wx-server *> $null
docker run -d --name act-wx-mock --network $net -p 127.0.0.1:8090:8090 -v "${root}/bin/linux:/app:ro" `
  -e DEVMOCK_ADDR=0.0.0.0:8090 -e DEVMOCK_APPKEY=dev-appkey golang:1.26 /app/devmock | Out-Null

if ($KeyFile) {
  $line = Get-Content -LiteralPath $KeyFile | Where-Object { $_ -match "^\s*(export\s+)?$KeyName\s*=" } | Select-Object -First 1
  if (-not $line) { Write-Host "$KeyName not found in $KeyFile"; exit 1 }
  $env:ACT_LLM_API_KEY = ($line -split '=', 2)[1].Trim().Trim('"').Trim("'")
  $model = @('-e', 'ACT_LLM_API_KEY')   # value comes from this process's environment
  Write-Host "model: real ($KeyName from $KeyFile)"
} else {
  $model = @('-e', 'ACT_LLM_BASE_URL=http://act-wx-mock:8090/v1', '-e', 'ACT_LLM_API_KEY=devmock',
    '-e', 'ACT_LLM_MODEL=devmock', '-e', 'ACT_LLM_FAST_MODEL=devmock')
  Write-Host 'model: devmock'
}

docker run -d --name act-wx-server --network $net -p 127.0.0.1:8080:8080 -v "${root}/bin/linux:/app:ro" `
  -e ACT_DATABASE_URL='postgres://act@act-pg:5432/act_wxdev?sslmode=disable' `
  -e ACT_ADDR=':8080' -e ACT_PUBLIC_ORIGIN='http://127.0.0.1:8080' -e ACT_COOKIE_SECURE=false `
  @model -e ACT_WORKERS=1 -e ACT_WX_API_BASE='http://act-wx-mock:8090' -e ACT_WX_APPID=touristappid -e ACT_WX_APPSECRET=devmock `
  -e ACT_WX_OFFER_ID=devmock-offer -e ACT_WX_PAY_APPKEY=dev-appkey -e ACT_WX_PAY_ENV=1 `
  golang:1.26 /app/act serve | Out-Null

Write-Host 'ACT on http://127.0.0.1:8080, devmock on http://127.0.0.1:8090 — Ctrl-C stops both'
try {
  docker logs -f act-wx-server
} finally {
  docker rm -f act-wx-mock act-wx-server *> $null
}
