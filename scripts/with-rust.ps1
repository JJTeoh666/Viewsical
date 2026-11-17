param([Parameter(ValueFromRemainingArguments=$true)][string[]]$CommandArgs)
$projectRoot = Split-Path -Parent $PSScriptRoot
$localCargo = Join-Path $projectRoot '.tools\cargo'
if (Test-Path -LiteralPath $localCargo) {
    $env:CARGO_HOME = $localCargo
    $env:RUSTUP_HOME = Join-Path $projectRoot '.tools\rustup'
    $env:PATH = (Join-Path $localCargo 'bin') + ';' + $env:PATH
}
$vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
if (Test-Path -LiteralPath $vswhere) {
    $vsPath = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
} elseif (Test-Path -LiteralPath (Join-Path $projectRoot '.tools\vs\VC\Auxiliary\Build\vcvars64.bat')) {
    $vsPath = Join-Path $projectRoot '.tools\vs'
}
if ($vsPath) {
    $vsDev = Join-Path $vsPath 'Common7\Tools\Microsoft.VisualStudio.DevShell.dll'
    if (Test-Path -LiteralPath $vsDev) {
        Import-Module $vsDev
        Enter-VsDevShell -VsInstallPath $vsPath -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64' | Out-Null
    }
}
if (!$CommandArgs.Count) { $CommandArgs = @('check') }
& cargo @CommandArgs
exit $LASTEXITCODE
