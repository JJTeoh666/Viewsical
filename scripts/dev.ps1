$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1')
Set-Location $projectRoot
if (!(Test-Path -LiteralPath 'tools\python\bundle.lock')) { & (Join-Path $PSScriptRoot 'setup-tools.ps1') }
& npm run tauri -- dev
exit $LASTEXITCODE
