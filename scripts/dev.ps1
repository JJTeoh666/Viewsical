$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1')
Set-Location $projectRoot
& npm run tauri -- dev
exit $LASTEXITCODE
