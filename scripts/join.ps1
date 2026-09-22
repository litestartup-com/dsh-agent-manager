# Oh! dsh — Windows 工作机一键加入（能力四舰队：node-agent 计划任务）
# 用法（管理员 PowerShell）：
#   $env:MANAGER_URL="https://app.example.com"; $env:AGENT_JOIN_TOKEN="ohdsh-join-xxx"; .\join.ps1
# 幂等：重跑不重复注册（agent 本地已存身份）；只动 %LOCALAPPDATA%\OhdshAgent 与计划任务。
$ErrorActionPreference = 'Stop'
$managerUrl = $env:MANAGER_URL
$joinToken  = $env:AGENT_JOIN_TOKEN
if (-not $managerUrl -or -not $joinToken) { Write-Error '需要 MANAGER_URL 与 AGENT_JOIN_TOKEN 环境变量'; exit 1 }
$agentDir = if ($env:AGENT_DIR) { $env:AGENT_DIR } else { Join-Path $env:LOCALAPPDATA 'OhdshAgent' }
$nodeBin = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeBin) { Write-Error '需要 Node ≥20（node 不在 PATH）'; exit 1 }

New-Item -ItemType Directory -Force -Path $agentDir | Out-Null
Invoke-WebRequest -Uri "$managerUrl/assets/agent/runtime.mjs" -OutFile (Join-Path $agentDir 'runtime.mjs') -UseBasicParsing
Invoke-WebRequest -Uri "$managerUrl/assets/agent/agent.mjs"     -OutFile (Join-Path $agentDir 'agent.mjs')     -UseBasicParsing

$action = New-ScheduledTaskAction -Execute $nodeBin -Argument 'agent.mjs' -WorkingDirectory $agentDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'OhdshAgent' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

# 环境变量塞进任务：用 Register 的 -Action 不支持 env，改 schtasks /xml 麻烦——直接写一个启动批处理
$launcher = Join-Path $agentDir 'agent-start.cmd'
@"
@echo off
set MANAGER_URL=$managerUrl
set AGENT_JOIN_TOKEN=$joinToken
set AGENT_DIR=$agentDir
"$nodeBin" "$agentDir\agent.mjs"
"@ | Set-Content -Path $launcher -Encoding ASCII
$action2 = New-ScheduledTaskAction -Execute $launcher -WorkingDirectory $agentDir
Register-ScheduledTask -TaskName 'OhdshAgent' -Action $action2 -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName 'OhdshAgent'
Write-Output "join.ps1: agent 已安装并启动（AGENT_DIR=$agentDir）。manager 机器页应出现本机。"
