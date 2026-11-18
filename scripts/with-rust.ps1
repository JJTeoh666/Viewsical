param([Parameter(ValueFromRemainingArguments=$true)][string[]]$CommandArgs)
. (Join-Path $PSScriptRoot 'env.ps1')
if (!$CommandArgs.Count) { $CommandArgs = @('check') }
& cargo @CommandArgs
exit $LASTEXITCODE
