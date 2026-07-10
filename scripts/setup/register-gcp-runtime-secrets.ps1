<#
.SYNOPSIS
  ランタイム用の秘匿情報(RDS 接続情報)を GCP Secret Manager に登録する。

.DESCRIPTION
  要件 6.3: DB 接続情報は GCP Secret Manager で管理し、アプリには埋め込まない。
  以下のシークレットを作成し、値を新しいバージョンとして登録する(冪等):
    ai-manager-db-host               … RDS エンドポイント
    ai-manager-db-name               … データベース名(既定 ai_manager)
    ai-manager-db-app-user/password       … アプリ用(ai_manager_app_rw)
    ai-manager-db-dashboard-user/password … ダッシュボード用(ai_manager_dashboard_ro)
    ai-manager-db-admin-user/password     … マイグレーション用(管理ユーザー)
    ai-manager-db-master-admin-user/password … マスタ管理 UI 用(ai_manager_admin_rw、v0.3)
  DB ロールの作成は scripts/setup/create-db-roles.sql を参照。
  再実行時、変更しないパスワードは空 Enter でスキップできる(既存の値を維持)。
  新規(シークレット未作成)のパスワードは従来どおり必須。

.EXAMPLE
  ./register-gcp-runtime-secrets.ps1 -ProjectId my-project
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ProjectId,
  [string]$DbHost,
  [string]$DbName = 'ai_manager',
  [string]$AppUser = 'ai_manager_app_rw',
  [string]$DashboardUser = 'ai_manager_dashboard_ro',
  [string]$AdminUser,
  [string]$MasterAdminUser = 'ai_manager_admin_rw'
)

$ErrorActionPreference = 'Stop'

function Read-RequiredValue {
  param([string]$Current, [string]$Prompt)
  if (-not [string]::IsNullOrWhiteSpace($Current)) { return $Current }
  $value = Read-Host -Prompt $Prompt
  if ([string]::IsNullOrWhiteSpace($value)) { throw "$Prompt は必須です" }
  return $value
}

function Test-GcpSecretExists {
  param([string]$Name)
  # PS 5.1 では native コマンドの stderr リダイレクトが EAP='Stop' で致命的エラーになるため一時緩和
  # (未作成シークレットの describe は stderr に NOT_FOUND を出すのが正常系)
  $previousEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & gcloud secrets describe $Name --project $ProjectId *> $null
  } finally {
    $ErrorActionPreference = $previousEap
  }
  return ($LASTEXITCODE -eq 0)
}

function Read-SecretValue {
  param([string]$Prompt, [string]$SecretName)
  # 再実行の安全化: 既存シークレットがある場合のみ「空 Enter でスキップ(既存の値を維持)」を許可する。
  # 新規(未作成)の場合に空を許すと、デプロイ時に空パスワードで接続不能になるため必須のまま
  $exists = Test-GcpSecretExists -Name $SecretName
  $hint = if ($exists) { '(変更しない場合は空 Enter でスキップ)' } else { '' }
  $secure = Read-Host -Prompt "$Prompt$hint" -AsSecureString
  $plain = [System.Net.NetworkCredential]::new('', $secure).Password
  if ([string]::IsNullOrWhiteSpace($plain)) {
    if ($exists) { return $null }
    throw "$Prompt は必須です(シークレット $SecretName が未作成のためスキップできません)"
  }
  return $plain
}

function Set-GcpSecret {
  param([string]$Name, [string]$Value)
  # PS 5.1 では native コマンドの stderr リダイレクトが EAP='Stop' で致命的エラーになるため一時緩和
  # (未作成シークレットの describe は stderr に NOT_FOUND を出すのが正常系)
  $previousEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & gcloud secrets describe $Name --project $ProjectId *> $null
  } finally {
    $ErrorActionPreference = $previousEap
  }
  if ($LASTEXITCODE -ne 0) {
    # describe の失敗は「未作成」以外(gcloud の再認証要求など)でも起きるため、
    # create が「already exists」で失敗した場合は既存として扱い先へ進む(冪等)
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $createOutput = (& gcloud secrets create $Name --replication-policy automatic --project $ProjectId 2>&1) -join "`n"
    } finally {
      $ErrorActionPreference = $previousEap
    }
    if ($LASTEXITCODE -ne 0 -and $createOutput -notmatch 'already exists') {
      throw "シークレット $Name の作成に失敗しました: $createOutput"
    }
  }
  # パイプ渡しは末尾に改行が付加され、DB_HOST 等が「\r\n 付き」で保存されて
  # 接続不能になるため、改行なしの一時ファイル経由で登録する
  $tmp = New-TemporaryFile
  try {
    [System.IO.File]::WriteAllText($tmp.FullName, $Value)
    & gcloud secrets versions add $Name --data-file=$($tmp.FullName) --project $ProjectId | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "シークレット $Name への値の登録に失敗しました" }
  }
  finally {
    Remove-Item $tmp.FullName -Force -ErrorAction SilentlyContinue
  }
  Write-Host "  登録済み: $Name"
}

# パスワードは $null(空 Enter でスキップ)の場合に既存の値を維持する(再実行の安全化)
function Set-GcpSecretOrKeep {
  param([string]$Name, [string]$Value)
  if ([string]::IsNullOrEmpty($Value)) {
    Write-Host "  スキップ(既存の値を維持): $Name" -ForegroundColor DarkGray
    return
  }
  Set-GcpSecret -Name $Name -Value $Value
}

$DbHost = Read-RequiredValue -Current $DbHost -Prompt 'RDS エンドポイント(例: xxx.ap-northeast-1.rds.amazonaws.com)'
$AdminUser = Read-RequiredValue -Current $AdminUser -Prompt 'マイグレーション用の管理 DB ユーザー名'

$appPassword = Read-SecretValue -Prompt "アプリ用ユーザー($AppUser)のパスワード" -SecretName 'ai-manager-db-app-password'
$dashboardPassword = Read-SecretValue -Prompt "ダッシュボード用ユーザー($DashboardUser)のパスワード" -SecretName 'ai-manager-db-dashboard-password'
$adminPassword = Read-SecretValue -Prompt "管理ユーザー($AdminUser)のパスワード" -SecretName 'ai-manager-db-admin-password'
$masterAdminPassword = Read-SecretValue -Prompt "マスタ管理用ユーザー($MasterAdminUser)のパスワード" -SecretName 'ai-manager-db-master-admin-password'

Write-Host "== Secret Manager へ登録 ==" -ForegroundColor Cyan
Set-GcpSecret -Name 'ai-manager-db-host' -Value $DbHost
Set-GcpSecret -Name 'ai-manager-db-name' -Value $DbName
Set-GcpSecret -Name 'ai-manager-db-app-user' -Value $AppUser
Set-GcpSecretOrKeep -Name 'ai-manager-db-app-password' -Value $appPassword
Set-GcpSecret -Name 'ai-manager-db-dashboard-user' -Value $DashboardUser
Set-GcpSecretOrKeep -Name 'ai-manager-db-dashboard-password' -Value $dashboardPassword
Set-GcpSecret -Name 'ai-manager-db-admin-user' -Value $AdminUser
Set-GcpSecretOrKeep -Name 'ai-manager-db-admin-password' -Value $adminPassword
Set-GcpSecret -Name 'ai-manager-db-master-admin-user' -Value $MasterAdminUser
Set-GcpSecretOrKeep -Name 'ai-manager-db-master-admin-password' -Value $masterAdminPassword

Write-Host ""
Write-Host "完了しました。デプロイ時に Cloud Run へ自動的にマウントされます。" -ForegroundColor Green
