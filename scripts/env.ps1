$projectRoot = Split-Path -Parent $PSScriptRoot
$cargoPath = Join-Path $projectRoot '.tools\cargo'
if (Test-Path -LiteralPath $cargoPath) {
    $env:CARGO_HOME = $cargoPath
    $env:RUSTUP_HOME = Join-Path $projectRoot '.tools\rustup'
    $env:PATH = (Join-Path $cargoPath 'bin') + ';' + $env:PATH
}
$vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
$vsPath = $null
if (Test-Path -LiteralPath $vswhere) { $vsPath = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath }
if ($vsPath) {
    $devShell = Join-Path $vsPath 'Common7\Tools\Microsoft.VisualStudio.DevShell.dll'
    if (Test-Path -LiteralPath $devShell) {
        Import-Module $devShell
        Enter-VsDevShell -VsInstallPath $vsPath -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64' | Out-Null
    }
} else {
    $localVc = Join-Path $projectRoot '.tools\vs\VC\Auxiliary\Build'
    if (Test-Path -LiteralPath (Join-Path $localVc 'vcvars64.bat')) {
        Push-Location -LiteralPath $localVc
        try {
            $compilerEnv = & cmd.exe /d /c 'call vcvars64.bat >nul && set PATH && set INCLUDE && set LIB'
            if ($LASTEXITCODE -ne 0) { throw 'Could not initialize the local Visual C++ toolchain.' }
            foreach ($line in $compilerEnv) {
                if ($line -match '^(Path|Include|Lib|LibPath)=(.*)$') {
                    [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
                }
            }
        } finally {
            Pop-Location
        }
    }
}
