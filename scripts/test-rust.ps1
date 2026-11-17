$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1')
Set-Location $projectRoot
# The dialog plugin imports TaskDialogIndirect. Unlike the Tauri application,
# Cargo's unit-test executable lacks a Common Controls v6 manifest. Embed it
# into a copy of the exact Cargo-produced test artifact, leaving build outputs
# and the application's own manifest untouched.
$messages = & cargo test --manifest-path src-tauri/Cargo.toml --lib --jobs 1 --no-run --message-format=json
$compileExit = $LASTEXITCODE
$messages | ForEach-Object { $message = $_ | ConvertFrom-Json; if ($message.reason -eq 'compiler-message') { Write-Host $message.message.rendered } }
if ($compileExit -ne 0) { exit $compileExit }
$testArtifacts = @($messages | ForEach-Object {
    $message = $_ | ConvertFrom-Json
    if ($message.reason -eq 'compiler-artifact' -and $message.profile.test -and $message.executable) { $message.executable }
})
if (!$testArtifacts.Count) { throw 'Cargo did not produce a native test executable.' }
$runnerFolder = Join-Path $projectRoot '.tools\test-runners'
New-Item -ItemType Directory -Path $runnerFolder -Force | Out-Null
foreach ($artifact in $testArtifacts) {
    $runner = Join-Path $runnerFolder ('native-' + [guid]::NewGuid().ToString() + '.exe')
    Copy-Item -LiteralPath $artifact -Destination $runner
    & mt.exe -nologo -manifest (Join-Path $projectRoot 'resources\windows-common-controls.manifest') "-outputresource:$runner;#1"
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & $runner
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Remove-Item -LiteralPath $runner -Force
}
