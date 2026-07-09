<#
.SYNOPSIS
  ランタイム用の秘匿情報(RDS 接続情報)を GCP Secret Manager に登録する。

.DESCRIPTION
  要件 6.3: DB 接続情報は GCP Secret Manager で管理し、アプリには埋め込まない。
  以下のシークレットを作成し、値を新しいバージョンとして登録する(冪等):
    ai-manager-db-host               … RDS エンドポイント
    ai-manager-db-name               … データベース名(既定 ai_manager)
    ai-manager-db-app-user/password       … アプリ用(app_rw)
    ai-manager-db-dashboard-user/password … ダッシュボード用(dashboard_ro)
    ai-manager-db-admin-user/password     … マイグレーション用(管理ユーザー)
  DB ロールの作成は scripts/setup/create-db-roles.sql を参照。

.EXAMPLE
  ./register-gcp-runtime-secrets.ps1 -ProjectId my-project
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ProjectId,
  [string]$DbHost,
  [string]$DbName = 'ai_manager',
  [string]$AppUser = 'app_rw',
  [string]$DashboardUser = 'dashboard_ro',
  [string]$AdminUser
)

$ErrorActionPreference = 'Stop'

function Read-RequiredValue {
  param([string]$Current, [string]$Prompt)
  if (-not [string]::IsNullOrWhiteSpace($Current)) { return $Current }
  $value = Read-Host -Prompt $Prompt
  if ([string]::IsNullOrWhiteSpace($value)) { throw "$Prompt は必須です" }
  return $value
}

function Read-SecretValue {
  param([string]$Prompt)
  $secure = Read-Host -Prompt $Prompt -AsSecureString
  $plain = [System.Net.NetworkCredential]::new('', $secure).Password
  if ([string]::IsNullOrWhiteSpace($plain)) { throw "$Prompt は必須です" }
  return $plain
}

function Set-GcpSecret {
  param([string]$Name, [string]$Value)
  & gcloud secrets describe $Name --project $ProjectId *> $null
  if ($LASTEXITCODE -ne 0) {
    & gcloud secrets create $Name --replication-policy automatic --project $ProjectId | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "シークレット $Name の作成に失敗しました" }
  }
  $Value | & gcloud secrets versions add $Name --data-file=- --project $ProjectId | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "シークレット $Name への値の登録に失敗しました" }
  Write-Host "  登録済み: $Name"
}

$DbHost = Read-RequiredValue -Current $DbHost -Prompt 'RDS エンドポイント(例: xxx.ap-northeast-1.rds.amazonaws.com)'
$AdminUser = Read-RequiredValue -Current $AdminUser -Prompt 'マイグレーション用の管理 DB ユーザー名'

$appPassword = Read-SecretValue -Prompt "アプリ用ユーザー($AppUser)のパスワード"
$dashboardPassword = Read-SecretValue -Prompt "ダッシュボード用ユーザー($DashboardUser)のパスワード"
$adminPassword = Read-SecretValue -Prompt "管理ユーザー($AdminUser)のパスワード"

Write-Host "== Secret Manager へ登録 ==" -ForegroundColor Cyan
Set-GcpSecret -Name 'ai-manager-db-host' -Value $DbHost
Set-GcpSecret -Name 'ai-manager-db-name' -Value $DbName
Set-GcpSecret -Name 'ai-manager-db-app-user' -Value $AppUser
Set-GcpSecret -Name 'ai-manager-db-app-password' -Value $appPassword
Set-GcpSecret -Name 'ai-manager-db-dashboard-user' -Value $DashboardUser
Set-GcpSecret -Name 'ai-manager-db-dashboard-password' -Value $dashboardPassword
Set-GcpSecret -Name 'ai-manager-db-admin-user' -Value $AdminUser
Set-GcpSecret -Name 'ai-manager-db-admin-password' -Value $adminPassword

Write-Host ""
Write-Host "完了しました。デプロイ時に Cloud Run へ自動的にマウントされます。" -ForegroundColor Green
