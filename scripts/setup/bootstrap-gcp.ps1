<#
.SYNOPSIS
  AI マネージャーのデプロイに必要な GCP リソースを冪等に作成する。

.DESCRIPTION
  以下を作成・設定する(既存リソースはスキップ):
    1. 必要な API の有効化
    2. Artifact Registry リポジトリ(Docker)
    3. デプロイ用 SA(GitHub Actions が WIF で偽装)とランタイム用 SA(Cloud Run 実行)
    4. Workload Identity Federation(GitHub Actions からのキーレス認証)
    5. IAM ロールバインディング
  完了後、repository secrets に設定すべき値を deploy-config.json 形式で出力する。

.EXAMPLE
  ./bootstrap-gcp.ps1 -ProjectId my-project -GithubRepo TSUNAGUBA/akebono-ai-manager

.NOTES
  前提: gcloud CLI がインストール済みで、オーナー相当の権限で gcloud auth login 済みであること。
  - GithubRepo は GitHub 上の正式な大文字小文字で指定すること(WIF の attribute-condition は
    OIDC トークンの repository クレームと大文字小文字を区別して照合される)。
  - 作成するリソースはすべて ai-manager- プレフィックス付きで、既存アプリと同居する
    GCP プロジェクトでも名前が衝突しない(docs/operations/deployment-setup.md の命名ポリシー参照)。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ProjectId,
  [Parameter(Mandatory = $true)][string]$GithubRepo, # 例: TSUNAGUBA/akebono-ai-manager(大文字小文字も正確に)
  [string]$Region = 'asia-northeast1',
  [string]$ArtifactRepository = 'ai-manager',
  [string]$PoolId = 'ai-manager-github-pool',
  [string]$ProviderId = 'ai-manager-github-provider',
  [string]$DeployerSaName = 'ai-manager-deployer',
  [string]$RuntimeSaName = 'ai-manager-runtime',
  [string]$OutputConfigPath = './deploy-config.json'
)

$ErrorActionPreference = 'Stop'

function Invoke-Gcloud {
  param([string[]]$Arguments)
  & gcloud @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "gcloud コマンドが失敗しました: gcloud $($Arguments -join ' ')"
  }
}

function Test-GcloudResource {
  param([string[]]$DescribeArguments)
  # Windows PowerShell 5.1 では native コマンドの stderr をリダイレクトすると
  # $ErrorActionPreference='Stop' の下で致命的エラーになるため、一時的に緩和する
  # (存在しないリソースの describe は stderr に NOT_FOUND を出すのが正常系)
  $previousEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & gcloud @DescribeArguments *> $null
  } finally {
    $ErrorActionPreference = $previousEap
  }
  return ($LASTEXITCODE -eq 0)
}

Write-Host "== 1/5 API の有効化 ==" -ForegroundColor Cyan
Invoke-Gcloud @(
  'services', 'enable',
  'run.googleapis.com',
  'artifactregistry.googleapis.com',
  'iam.googleapis.com',
  'iamcredentials.googleapis.com',
  'sts.googleapis.com',
  'secretmanager.googleapis.com',
  'aiplatform.googleapis.com',
  'cloudscheduler.googleapis.com',
  'chat.googleapis.com',
  'drive.googleapis.com',
  'vpcaccess.googleapis.com',
  '--project', $ProjectId
)

$projectNumber = (& gcloud projects describe $ProjectId --format 'value(projectNumber)')
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($projectNumber)) {
  throw "プロジェクト番号を取得できませんでした: $ProjectId"
}

Write-Host "== 2/5 Artifact Registry ==" -ForegroundColor Cyan
if (-not (Test-GcloudResource @('artifacts', 'repositories', 'describe', $ArtifactRepository, '--location', $Region, '--project', $ProjectId))) {
  Invoke-Gcloud @(
    'artifacts', 'repositories', 'create', $ArtifactRepository,
    '--repository-format', 'docker',
    '--location', $Region,
    '--project', $ProjectId,
    '--description', 'AI Manager container images'
  )
} else {
  Write-Host "  既存のためスキップ: $ArtifactRepository"
}

Write-Host "== 3/5 サービスアカウント ==" -ForegroundColor Cyan
$deployerSa = "$DeployerSaName@$ProjectId.iam.gserviceaccount.com"
$runtimeSa = "$RuntimeSaName@$ProjectId.iam.gserviceaccount.com"

foreach ($sa in @(
    @{ Name = $DeployerSaName; Email = $deployerSa; Display = 'AI Manager deployer (GitHub Actions)' },
    @{ Name = $RuntimeSaName; Email = $runtimeSa; Display = 'AI Manager runtime (Cloud Run)' }
  )) {
  if (-not (Test-GcloudResource @('iam', 'service-accounts', 'describe', $sa.Email, '--project', $ProjectId))) {
    Invoke-Gcloud @('iam', 'service-accounts', 'create', $sa.Name, '--display-name', $sa.Display, '--project', $ProjectId)
  } else {
    Write-Host "  既存のためスキップ: $($sa.Email)"
  }
}

Write-Host "== 4/5 IAM ロール ==" -ForegroundColor Cyan
# デプロイ SA: Cloud Run 管理・イメージ push・Scheduler 管理・VPC コネクタ利用(最小権限の原則)
# vpcaccess.user は --vpc-connector 付きデプロイ(deploy.yml)に必要
$deployerRoles = @(
  'roles/run.admin',
  'roles/artifactregistry.writer',
  'roles/cloudscheduler.admin',
  'roles/vpcaccess.user'
)
foreach ($role in $deployerRoles) {
  Invoke-Gcloud @(
    'projects', 'add-iam-policy-binding', $ProjectId,
    '--member', "serviceAccount:$deployerSa",
    '--role', $role,
    '--condition', 'None',
    '--quiet'
  ) | Out-Null
}
# デプロイ SA がランタイム SA を Cloud Run に割り当てられるようにする
Invoke-Gcloud @(
  'iam', 'service-accounts', 'add-iam-policy-binding', $runtimeSa,
  '--member', "serviceAccount:$deployerSa",
  '--role', 'roles/iam.serviceAccountUser',
  '--project', $ProjectId,
  '--quiet'
) | Out-Null

# ランタイム SA: Secret 参照・Vertex AI 呼び出し
$runtimeRoles = @('roles/secretmanager.secretAccessor', 'roles/aiplatform.user')
foreach ($role in $runtimeRoles) {
  Invoke-Gcloud @(
    'projects', 'add-iam-policy-binding', $ProjectId,
    '--member', "serviceAccount:$runtimeSa",
    '--role', $role,
    '--condition', 'None',
    '--quiet'
  ) | Out-Null
}

Write-Host "== 5/5 Workload Identity Federation ==" -ForegroundColor Cyan
if (-not (Test-GcloudResource @('iam', 'workload-identity-pools', 'describe', $PoolId, '--location', 'global', '--project', $ProjectId))) {
  Invoke-Gcloud @(
    'iam', 'workload-identity-pools', 'create', $PoolId,
    '--location', 'global',
    '--display-name', 'AI Manager GitHub Actions',
    '--project', $ProjectId
  )
} else {
  Write-Host "  既存のためスキップ: pool $PoolId"
}

if (-not (Test-GcloudResource @('iam', 'workload-identity-pools', 'providers', 'describe', $ProviderId, '--workload-identity-pool', $PoolId, '--location', 'global', '--project', $ProjectId))) {
  # attribute-condition で対象リポジトリからのトークンのみに制限する
  Invoke-Gcloud @(
    'iam', 'workload-identity-pools', 'providers', 'create-oidc', $ProviderId,
    '--workload-identity-pool', $PoolId,
    '--location', 'global',
    '--project', $ProjectId,
    '--display-name', 'AI Manager GitHub OIDC',
    '--issuer-uri', 'https://token.actions.githubusercontent.com',
    '--attribute-mapping', 'google.subject=assertion.sub,attribute.repository=assertion.repository',
    '--attribute-condition', "assertion.repository == '$GithubRepo'"
  )
} else {
  Write-Host "  既存のためスキップ: provider $ProviderId"
}

$wifProvider = "projects/$projectNumber/locations/global/workloadIdentityPools/$PoolId/providers/$ProviderId"
$principalSet = "principalSet://iam.googleapis.com/projects/$projectNumber/locations/global/workloadIdentityPools/$PoolId/attribute.repository/$GithubRepo"

Invoke-Gcloud @(
  'iam', 'service-accounts', 'add-iam-policy-binding', $deployerSa,
  '--member', $principalSet,
  '--role', 'roles/iam.workloadIdentityUser',
  '--project', $ProjectId,
  '--quiet'
) | Out-Null

# repository secrets 用の設定ファイルを出力(register-github-secrets.ps1 の入力)
$config = [ordered]@{
  GCP_PROJECT_ID                 = $ProjectId
  GCP_PROJECT_NUMBER             = "$projectNumber"
  GCP_REGION                     = $Region
  GCP_WORKLOAD_IDENTITY_PROVIDER = $wifProvider
  GCP_DEPLOY_SERVICE_ACCOUNT     = $deployerSa
  GCP_RUNTIME_SERVICE_ACCOUNT    = $runtimeSa
  GCP_ARTIFACT_REPOSITORY        = $ArtifactRepository
  GCP_VPC_CONNECTOR              = ''
  ADMIN_SPACE_ID                 = ''
  KNOWLEDGE_DRIVE_FOLDER_ID      = ''
  DASHBOARD_AUTH_MODE            = ''
  DASHBOARD_IAP_AUDIENCE         = ''
  DASHBOARD_EXPOSURE             = ''
  VERTEX_LOCATION                = ''
  VERTEX_EMBEDDING_LOCATION      = ''
  MODEL_FLASH_LITE               = ''
  MODEL_FLASH                    = ''
  MODEL_PRO                      = ''
  MODEL_PRICING_JSON             = ''
  EMBEDDING_MODEL                = ''
}

# 再実行時、オペレーターが記入済みの任意項目を巻き戻さない(既存ファイルの値を優先してマージ)。
# 必須項目(GCP_* のリソース名)は常に最新の実値で再計算する。
$operatorEditableKeys = @(
  'GCP_VPC_CONNECTOR', 'ADMIN_SPACE_ID', 'KNOWLEDGE_DRIVE_FOLDER_ID',
  'DASHBOARD_AUTH_MODE', 'DASHBOARD_IAP_AUDIENCE', 'DASHBOARD_EXPOSURE',
  'VERTEX_LOCATION', 'VERTEX_EMBEDDING_LOCATION',
  'MODEL_FLASH_LITE', 'MODEL_FLASH', 'MODEL_PRO', 'MODEL_PRICING_JSON', 'EMBEDDING_MODEL'
)
if (Test-Path $OutputConfigPath) {
  try {
    $existing = Get-Content -Path $OutputConfigPath -Raw | ConvertFrom-Json
    foreach ($key in $operatorEditableKeys) {
      $prior = $existing.$key
      if (-not [string]::IsNullOrWhiteSpace([string]$prior)) {
        $config[$key] = [string]$prior
      }
    }
    Write-Host "既存の $OutputConfigPath の任意項目を引き継ぎました" -ForegroundColor DarkGray
  } catch {
    Write-Warning "既存の $OutputConfigPath を読み取れなかったため新規作成します: $_"
  }
}
$config | ConvertTo-Json | Set-Content -Path $OutputConfigPath -Encoding utf8

Write-Host ""
Write-Host "完了しました。" -ForegroundColor Green
Write-Host "repository secrets 用の設定を $OutputConfigPath に出力しました。"
Write-Host "空欄の任意項目(VPC コネクタ等)を必要に応じて埋めた後、以下を実行してください:"
Write-Host "  ./register-github-secrets.ps1 -Repo $GithubRepo -ConfigPath $OutputConfigPath" -ForegroundColor Yellow
Write-Host ""
Write-Host "注意: ナレッジ同期を使う場合は、Drive のナレッジフォルダを $runtimeSa に閲覧者で共有してください。"
