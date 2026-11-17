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
if (!$vsPath -and (Test-Path -LiteralPath (Join-Path $projectRoot '.tools\vs\VC\Auxiliary\Build\vcvars64.bat'))) { $vsPath = Join-Path $projectRoot '.tools\vs' }
if ($vsPath) {
    $devShell = Join-Path $vsPath 'Common7\Tools\Microsoft.VisualStudio.DevShell.dll'
    if (Test-Path -LiteralPath $devShell) {
        Import-Module $devShell
        Enter-VsDevShell -VsInstallPath $vsPath -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64' | Out-Null
    }
}
