<#
.SYNOPSIS
  デプロイ用の設定値を GitHub repository secrets に一括登録する。

.DESCRIPTION
  deploy-config.json(bootstrap-gcp.ps1 が出力。手書きも可)を読み取り、
  gh CLI で repository secrets に登録する。空文字の値はスキップする。
  .github/workflows/deploy.yml はこれらの secrets を読み取って動作する。

.EXAMPLE
  ./register-github-secrets.ps1 -Repo tsunaguba/akebono-ai-manager
  ./register-github-secrets.ps1 -Repo tsunaguba/akebono-ai-manager -ConfigPath ./deploy-config.json

.NOTES
  前提: gh CLI がインストール済みで gh auth login 済みであること。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Repo, # 例: tsunaguba/akebono-ai-manager
  [string]$ConfigPath = './deploy-config.json'
)

$ErrorActionPreference = 'Stop'

$requiredKeys = @(
  'GCP_PROJECT_ID',
  'GCP_PROJECT_NUMBER',
  'GCP_REGION',
  'GCP_WORKLOAD_IDENTITY_PROVIDER',
  'GCP_DEPLOY_SERVICE_ACCOUNT',
  'GCP_RUNTIME_SERVICE_ACCOUNT',
  'GCP_ARTIFACT_REPOSITORY'
)
$optionalKeys = @(
  'GCP_VPC_CONNECTOR',
  'ADMIN_SPACE_ID',
  'KNOWLEDGE_DRIVE_FOLDER_ID',
  'DASHBOARD_AUTH_MODE',
  'DASHBOARD_IAP_AUDIENCE'
)

if (-not (Test-Path $ConfigPath)) {
  throw "設定ファイルが見つかりません: $ConfigPath(scripts/setup/deploy-config.sample.json をコピーして作成するか、bootstrap-gcp.ps1 を先に実行してください)"
}

& gh auth status *> $null
if ($LASTEXITCODE -ne 0) {
  throw 'gh CLI が未認証です。先に gh auth login を実行してください'
}

$config = Get-Content -Path $ConfigPath -Raw | ConvertFrom-Json

$missing = @()
foreach ($key in $requiredKeys) {
  $value = $config.$key
  if ([string]::IsNullOrWhiteSpace($value)) { $missing += $key }
}
if ($missing.Count -gt 0) {
  throw "必須の設定値が空です: $($missing -join ', ')($ConfigPath を編集してください)"
}

Write-Host "== repository secrets へ登録: $Repo ==" -ForegroundColor Cyan
foreach ($key in ($requiredKeys + $optionalKeys)) {
  $value = $config.$key
  if ([string]::IsNullOrWhiteSpace($value)) {
    Write-Host "  スキップ(空): $key" -ForegroundColor DarkGray
    continue
  }
  & gh secret set $key --repo $Repo --body "$value"
  if ($LASTEXITCODE -ne 0) { throw "secret $key の登録に失敗しました" }
  Write-Host "  登録済み: $key"
}

Write-Host ""
Write-Host "完了しました。main ブランチへの push で自動デプロイされます。" -ForegroundColor Green
Write-Host "手動実行: GitHub の Actions タブ → Deploy → Run workflow"
