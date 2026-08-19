param(
  [string]$CapturePath = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($CapturePath)) {
  $searchRoots = @(
    (Join-Path $env:USERPROFILE 'Downloads'),
    (Join-Path $env:USERPROFILE 'Desktop')
  )
  $candidate = $searchRoots |
    Where-Object { Test-Path -LiteralPath $_ } |
    ForEach-Object {
      Get-ChildItem -LiteralPath $_ -File -Filter 'kani-performance-*.json' -ErrorAction SilentlyContinue
    } |
    Where-Object { $_.Name -notlike '*.summary.json' } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if ($null -eq $candidate) {
    throw 'Downloads または Desktop に kani-performance-*.json が見つかりません。-CapturePath で指定してください。'
  }
  $CapturePath = $candidate.FullName
}

$resolvedCapture = (Resolve-Path -LiteralPath $CapturePath).Path
$summarizer = Join-Path $PSScriptRoot 'summarize-kani-performance-capture.mjs'
if (-not (Test-Path -LiteralPath $summarizer)) {
  throw "集計スクリプトが見つかりません: $summarizer"
}

Write-Host "集計対象: $resolvedCapture"
& node '--max-old-space-size=4096' $summarizer $resolvedCapture
if ($LASTEXITCODE -ne 0) {
  throw "性能測定の集計に失敗しました。Node.js 終了コード: $LASTEXITCODE"
}
