param([ValidateSet('cpu','gpu')][string]$Device='cpu')
$ErrorActionPreference='Stop'
Set-Location $PSScriptRoot
function Invoke-Checked { param([string]$Program,[string[]]$Arguments) & $Program @Arguments; if ($LASTEXITCODE -ne 0) { throw "$Program failed: $LASTEXITCODE" } }
Invoke-Checked 'py' @('-3.12','-m','venv','.venv')
$python=Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
Invoke-Checked $python @('-m','pip','install','--upgrade','pip')
$index=if($Device -eq 'gpu'){'https://download.pytorch.org/whl/cu128'}else{'https://download.pytorch.org/whl/cpu'}
Invoke-Checked $python @('-m','pip','install','torch==2.10.0','torchvision==0.25.0','--index-url',$index)
Invoke-Checked $python @('-m','pip','install','-e','./X-AnyLabeling[cpu]','ultralytics==8.4.178','polars==1.35.2','onnxslim')
Invoke-Checked 'npm.cmd' @('--prefix','desktop','ci','--no-audit','--no-fund')
Write-Host 'Ready. Run npm --prefix desktop start. The first uncached model requires a download.'
