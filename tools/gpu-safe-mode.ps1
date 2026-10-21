# GPU safe mode for long AI video jobs (OPTIMIZATION_PLAN 6.x).
# The RTX 5070 Ti dropped off the bus ("GPU is lost") twice after minutes at 100 % load. Lowering the power limit and
# capping the boost clock cuts the transient power spikes that typically cause this. Needs an elevated PowerShell.
# Settings are NOT persistent: run again after every reboot (tests/run-dance-e2e.mjs refuses to start otherwise).
#
#   .\tools\gpu-safe-mode.ps1            # apply: 250 W power limit, graphics clock 210-1900 MHz (measured: max 75 C at ~180 W)
#   .\tools\gpu-safe-mode.ps1 -Reset     # back to defaults (300 W, unlocked clocks)
param(
  [switch]$Reset,
  [int]$PowerLimitW = 250,
  [int]$MaxGraphicsClockMHz = 1900
)

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host '需要系統管理員權限：請在開始功能表的 Windows PowerShell 上按右鍵，選「以系統管理員身分執行」，再重新執行此指令。' -ForegroundColor Red
  exit 1
}

if ($Reset) {
  nvidia-smi -pl 300
  nvidia-smi -rgc
  Write-Host '已還原顯示卡預設設定（300 瓦、不限時脈）。' -ForegroundColor Yellow
} else {
  nvidia-smi -pl $PowerLimitW
  nvidia-smi -lgc "210,$MaxGraphicsClockMHz"
}
$limit = [double](nvidia-smi --query-gpu=power.limit --format=csv,noheader,nounits)
if (-not $Reset -and $limit -le $PowerLimitW) {
  Write-Host "完成：顯示卡功耗上限 $limit 瓦、時脈上限 $MaxGraphicsClockMHz MHz。重新開機後需再執行一次。" -ForegroundColor Green
} elseif (-not $Reset) {
  Write-Host "設定失敗：目前功耗上限仍是 $limit 瓦。" -ForegroundColor Red
}
