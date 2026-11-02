# ============================================================================
#  启动器 —— DSH 插件管理器
#
#  为什么不直接双击 app.ps1：
#    PowerShell 5.1 读取 .ps1 时，如果文件没有 UTF-8 BOM，
#    会按系统 ANSI 代码页（简中系统是 GBK）解析。
#    本程序含大量中文注释和提示，缺 BOM 会导致解析出一堆
#    "方法调用中缺少 )" 之类的假错误，脚本直接起不来。
#
#    文本编辑器保存时经常不写 BOM，为了避免每次改完就报错，
#    这里在启动前自动检查并补齐 BOM，再交给 app.ps1。
# ============================================================================

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSCommandPath
$HostScript = Join-Path $Root 'src\app.ps1'

if (-not (Test-Path $HostScript)) {
    Write-Host "找不到 $HostScript，程序目录不完整。" -ForegroundColor Red
    Read-Host '按回车退出'
    exit 1
}

# 确保 app.ps1 带 UTF-8 BOM，否则 PowerShell 5.1 会按 GBK 解析中文而报错
try {
    $bytes = [System.IO.File]::ReadAllBytes($HostScript)
    $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    if (-not $hasBom) {
        $text = [System.IO.File]::ReadAllText($HostScript, [System.Text.UTF8Encoding]::new($false))
        [System.IO.File]::WriteAllText($HostScript, $text, [System.Text.UTF8Encoding]::new($true))
    }
} catch {
    Write-Host "无法处理脚本编码：$($_.Exception.Message)" -ForegroundColor Red
}

# E: 盘会被 .NET 判定为不受信任位置，加一道保险（app.ps1 内还有更完整的处理）
try { [System.AppDomain]::CurrentDomain.SetData('loadFromRemoteSources', $true) } catch { }

& $HostScript
