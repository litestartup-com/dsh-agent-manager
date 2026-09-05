# Oh! dsh — Windows 一键安装（裸机形态：manager + 主脑 + 个人，本机直跑）。
#
# 推荐（先下载查看再执行）：
#   irm https://get.ohdsh.com/install.ps1 -OutFile install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
# 熟手一行（直接执行，参数不可传）：
#   irm https://get.ohdsh.com/install.ps1 | iex
#
# 幂等：Node/git/pnpm/DSH 已装且版本对 = 跳过；仓库/配置已存在 = 不覆盖。
# 计划先行：DRY_RUN=1 只看不执行；-Yes 跳过确认。唯一人肉输入 = DeepSeek API key
# （-ApiKey 或环境变量 DEEPSEEK_API_KEY 预置则全自动）。
param(
  [string]$ApiKey = $env:DEEPSEEK_API_KEY,
  [string]$WorkspaceDir = "$env:USERPROFILE\ohdsh",
  [switch]$Service,
  [switch]$Yes,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$DSH_VERSION = '0.1.1-rc.2' # 与 src/dsh-version.ts 保持一致

function Step([string]$Msg) { Write-Host "[install] $Msg" -ForegroundColor Cyan }
function Plan([string]$Msg) { Write-Host "[plan] $Msg" -ForegroundColor DarkGray }
function Confirm-Step([string]$Msg) {
  if ($Yes) { return }
  if ($DryRun) { Plan "DRY: $Msg"; return }
  $Ans = Read-Host "$Msg [y/N]"
  if ($Ans -notmatch '^[yY]') { Write-Host '[install] 已取消。'; exit 0 }
}
function Have([string]$Cmd) { return $null -ne (Get-Command $Cmd -ErrorAction SilentlyContinue) }

# ---- 计划先行 ----
Plan '探测并补齐 Node/git/pnpm/DSH（已装且版本对=跳过）→ 问 API key → 克隆 → npm install → setup（自检表）→ build → 启动'
if (-not $DryRun) { Confirm-Step '按计划继续？' }

# ---- Node ----
if (-not (Have 'node')) {
  Step '安装 Node LTS（winget）…'
  if (-not $DryRun) { winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements }
} else {
  $NodeV = (node --version) 2>$null
  Step "Node 已装（$NodeV），跳过。"
}

# ---- git ----
if (-not (Have 'git')) {
  Step '安装 git（winget）…'
  if (-not $DryRun) { winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements }
} else { Step 'git 已装，跳过。' }

# ---- pnpm ----
if (-not (Have 'pnpm')) {
  Step '安装 pnpm…'
  if (-not $DryRun) { npm install -g pnpm }
} else { Step 'pnpm 已装，跳过。' }

# ---- DSH（钉版本）----
$DshOk = $false
if (Have 'dsh') {
  $V = (& dsh --version) 2>$null
  if ("$V".Trim() -eq $DSH_VERSION) { Step "DSH 已装且版本正确（$V），跳过。"; $DshOk = $true }
  else { Step "DSH 已装但版本不符（$V ≠ $DSH_VERSION），升级到钉死版本…" }
}
if (-not $DshOk) {
  if (-not $DryRun) { npm install -g "@deepseek-ai/dsh@$DSH_VERSION" }
}

# ---- API key（唯一人肉输入）----
if ([string]::IsNullOrEmpty($ApiKey)) {
  if (-not $DryRun) { $ApiKey = Read-Host 'DeepSeek API key（已配过凭据可留空跳过）' }
}
if (-not [string]::IsNullOrEmpty($ApiKey)) {
  $CredsDir = Join-Path $env:USERPROFILE '.dsh'
  if ($DryRun) { Plan "DRY: 写入 $CredsDir\.credentials.yaml" }
  else {
    New-Item -ItemType Directory -Force -Path $CredsDir | Out-Null
    Set-Content -Path (Join-Path $CredsDir '.credentials.yaml') -Value "version: 1`nrefs:`n  DEEPSEEK_API_KEY: $ApiKey" -Encoding utf8
    Step '已写入 DSH 凭据（无需打开 DSH GUI）。'
  }
}

# ---- 克隆 ----
if (Test-Path (Join-Path $WorkspaceDir 'package.json')) {
  Step "仓库已存在（$WorkspaceDir），跳过克隆。"
} else {
  Step '克隆 dsh-agent-manager…'
  if (-not $DryRun) { git clone https://github.com/litestartup-com/dsh-agent-manager.git $WorkspaceDir }
}

# ---- install + setup + build + 启动 ----
Push-Location $WorkspaceDir
try {
  if (Test-Path 'manager.config.yaml') {
    Step 'manager.config.yaml 已存在——跳过 setup（改配置请直接编辑；重装 npm run setup -- --force）。'
  } else {
    Step 'npm install + npm run setup（自检表：node/pnpm/git/dsh 红绿分明）…'
    if (-not $DryRun) { npm install; if ($LASTEXITCODE -ne 0) { throw 'npm install 失败' }; npm run setup }
  }
  Step 'npm run build…'
  if (-not $DryRun) { npm run build }

  if ($Service) {
    Step '安装开机自启服务…'
    if (-not $DryRun) { npm run service -- install }
  }

  Step '启动 manager（自动拉起主脑 + 个人节点）…'
  if ($DryRun) { Plan 'DRY: npm start + 打开浏览器' }
  else {
    Start-Process -FilePath 'npm.cmd' -ArgumentList 'start' -WorkingDirectory $WorkspaceDir -WindowStyle Hidden
    Step '完成：http://127.0.0.1:8080（初始密码见 .env 的 MANAGER_INITIAL_PASSWORD；首登强制改密）'
    Start-Process 'http://127.0.0.1:8080'
  }
} finally {
  Pop-Location
}
