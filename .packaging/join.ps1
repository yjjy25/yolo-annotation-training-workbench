param([ValidateSet('Windows','Ubuntu')][string]$Platform='Windows')
$ErrorActionPreference='Stop'
$records=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'parts.json') -Raw | ConvertFrom-Json
foreach($record in $records) {
    if($record.name -notlike "*$Platform*"){continue}
    $target=Join-Path $PSScriptRoot $record.name
    if(Test-Path -LiteralPath $target){throw "Already exists: $target"}
    $temporary="$target.partial"
    $output=[System.IO.File]::Open($temporary,[System.IO.FileMode]::Create)
    try {
        foreach($part in $record.parts) {
            $partPath=Join-Path $PSScriptRoot $part.name
            if((Get-Item -LiteralPath $partPath).Length -ne $part.bytes){throw "Invalid size: $($part.name)"}
            if((Get-FileHash -LiteralPath $partPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $part.sha256){throw "Invalid checksum: $($part.name)"}
            $inputFile=[System.IO.File]::OpenRead($partPath)
            try{$inputFile.CopyTo($output)}finally{$inputFile.Dispose()}
        }
    } finally {$output.Dispose()}
    if((Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash.ToLowerInvariant() -ne $record.sha256){throw 'Complete checksum mismatch'}
    Move-Item -LiteralPath $temporary -Destination $target
    Write-Output "Verified: $($record.name)"
}
