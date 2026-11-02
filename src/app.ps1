# ============================================================================
#  DSH 插件管理器 —— Windows 宿主
#
#  职责：开一个 WebView2 窗口，把界面 (src/ui/index.html) 装进去，
#        并处理界面发来的指令（读取插件、切换开关）。
#
#  为什么用 PowerShell + WebView2 而不是 Electron：
#    本机已有 WebView2 运行时（Edge 自带），托管 SDK 只有 915 KB 随程序携带，
#    双击即开，用户不需要装 node_modules 之外的任何东西。
#
#  为什么界面逻辑放在 Node 侧：
#    cordis.patch.yml 有 1000+ 行、深层嵌套、含 !!js 标签，
#    用 PowerShell 正则处理必然会出错。Node 侧用真正的 YAML 解析器算好，
#    PowerShell 只负责搬运 JSON。
# ============================================================================

param(
    [string]$ProfileDir = ''
)

$ErrorActionPreference = 'Stop'
$script:Root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)

# ---------------------------------------------------------------------------
# 日志：出问题时能直接看文件，不用靠猜。
# 必须定义在文件最前面——后面很多函数会调用它。
# ---------------------------------------------------------------------------
$script:LogFile = Join-Path $script:Root 'data\app.log'
$script:DbgLog = {
    param($text)
    try {
        $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff')] $text"
        Add-Content -LiteralPath $script:LogFile -Value $line -Encoding UTF8
    } catch { }
}
function Write-Log { param($text) & $script:DbgLog $text }

# ---------------------------------------------------------------------------
# 0. 定位 node.exe
# ---------------------------------------------------------------------------
function Find-Node {
    $candidates = @(
        'C:\Program Files\nodejs\node.exe',
        'C:\Program Files (x86)\nodejs\node.exe'
    )
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { $candidates = @($cmd.Source) + $candidates }

    foreach ($c in $candidates) {
        if (Test-Path $c) { return $c }
    }
    return $null
}

$script:NodeExe = Find-Node
if (-not $script:NodeExe) {
    [System.Windows.Forms.MessageBox]::Show(
        "找不到 node.exe，无法读取插件配置。`n`n请确认已安装 Node.js。",
        'DSH 插件管理器', 'OK', 'Error') | Out-Null
    exit 1
}

$script:BridgeJs = Join-Path $script:Root 'src\bridge.js'
# WebView2 的用户数据目录（缓存、Cookie 等）放在 LOCALAPPDATA，
# 不放程序目录：它会长到几十 MB，且属于运行期缓存，
# 跟程序本体混在一起会让整个目录臃肿、备份和迁移都不方便。
$script:WvProfile = Join-Path $env:LOCALAPPDATA 'DSHPluginManager\wv-profile'

# ---------------------------------------------------------------------------
# 1. 加载 WebView2 SDK
# ---------------------------------------------------------------------------
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$wv2Source = Join-Path $script:Root 'lib\webview2'
if (-not (Test-Path (Join-Path $wv2Source 'Microsoft.Web.WebView2.WinForms.dll'))) {
    [System.Windows.Forms.MessageBox]::Show(
        "缺少 WebView2 SDK 文件：`n$wv2Source`n`n请重新解压完整程序目录。",
        'DSH 插件管理器', 'OK', 'Error') | Out-Null
    exit 1
}

# ---------------------------------------------------------------------------
# 1.5 把 SDK 复制到受信任位置再加载
#
# 本机程序装在 E: 盘。E: 盘根目录带 Hidden+System 属性，.NET Framework 会把
# 由此派生的路径判定为"网络/不受信任位置"，加载托管 DLL 时抛
#   0x80131515「尝试从一个网络位置加载程序集…请启用 loadFromRemoteSources」
# 实测：同样的 DLL 从 C: 或 D: 加载正常，从 E:\A0-公共区域 加载必然失败。
#
# 解法：运行时把 DLL 复制到 %LOCALAPPDATA%，从那里加载。
# 这样程序本体仍可放在任意位置（包括 E 盘共享区），
# 又不用改系统配置文件、也不要求用户提权。
# ---------------------------------------------------------------------------
$wv2Dir = Join-Path $env:LOCALAPPDATA 'DSHPluginManager\webview2'
$needCopy = $true
if (Test-Path (Join-Path $wv2Dir 'Microsoft.Web.WebView2.WinForms.dll')) {
    try {
        $srcInfo = Get-Item (Join-Path $wv2Source 'Microsoft.Web.WebView2.Core.dll')
        $dstInfo = Get-Item (Join-Path $wv2Dir 'Microsoft.Web.WebView2.Core.dll')
        if ($srcInfo.Length -eq $dstInfo.Length) { $needCopy = $false }
    } catch { $needCopy = $true }
}
if ($needCopy) {
    New-Item -ItemType Directory -Path $wv2Dir -Force | Out-Null
    Copy-Item (Join-Path $wv2Source '*.dll') $wv2Dir -Force
}

# WebView2Loader.dll 是原生 DLL，必须让加载器能找到它
$sig = @'
[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool SetDllDirectory(string lpPathName);
'@
if (-not ('DSHPM.Native' -as [type])) {
    Add-Type -MemberDefinition $sig -Name Native -Namespace DSHPM | Out-Null
}
[DSHPM.Native]::SetDllDirectory($wv2Dir) | Out-Null
$env:PATH = "$wv2Dir;$env:PATH"

try {
    Add-Type -Path (Join-Path $wv2Dir 'Microsoft.Web.WebView2.Core.dll')
    Add-Type -Path (Join-Path $wv2Dir 'Microsoft.Web.WebView2.WinForms.dll')
} catch {
    [System.Windows.Forms.MessageBox]::Show(
        "WebView2 SDK 加载失败：`n$($_.Exception.Message)`n`n已尝试从 $wv2Dir 加载。",
        'DSH 插件管理器', 'OK', 'Error') | Out-Null
    exit 1
}

# 检查运行时是否可用（缺运行时会给出明确提示，而不是一堆 COM 异常）
try {
    $browserVer = [Microsoft.Web.WebView2.Core.CoreWebView2Environment]::GetAvailableBrowserVersionString()
} catch {
    [System.Windows.Forms.MessageBox]::Show(
        "本机没有可用的 WebView2 运行时。`n`n" +
        "请从微软官网安装 'Microsoft Edge WebView2 Runtime'（Windows 11 通常已自带）。`n`n" +
        "错误：$($_.Exception.Message)",
        'DSH 插件管理器', 'OK', 'Error') | Out-Null
    exit 1
}

# ---------------------------------------------------------------------------
# 2. 后端调用：把指令交给 Node 处理，拿回 JSON
# ---------------------------------------------------------------------------
$script:TmpDir = Join-Path $env:TEMP ('dsh-pm-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $script:TmpDir -Force | Out-Null

# ---------------------------------------------------------------------------
# 2.5 读取设置（启动观察时长）
#
# 这个值决定"等多久没崩算启动成功"。不同机器差异很大：
# 插件多的机器光启动到弹界面就要一分多钟。
# 这里在启动时先读一遍，作为每次 launch 的默认值；
# 界面改了设置会通过 settings 指令回写，并同步更新这两个变量。
# ---------------------------------------------------------------------------
$script:LaunchTimeoutSec = 180
$script:LaunchLimitSec = 180
$script:SettingsFile = Join-Path (Join-Path $script:Root 'data') 'settings.json'
try {
    if (Test-Path $script:SettingsFile) {
        $raw = [System.IO.File]::ReadAllText($script:SettingsFile, [System.Text.UTF8Encoding]::new($false))
        $cfg = $raw | ConvertFrom-Json
        if ($cfg.launchTimeoutSec -ne $null) {
            $sec = [int]$cfg.launchTimeoutSec
            if ($sec -lt 10) { $sec = 10 }
            if ($sec -gt 600) { $sec = 600 }
            $script:LaunchTimeoutSec = $sec
            $script:LaunchLimitSec = $sec
        }
    }
} catch {
    Write-Log "读取设置失败，用默认值：$($_.Exception.Message)"
}
Write-Log "启动观察时长 = $script:LaunchTimeoutSec 秒"

function Invoke-Bridge {
    param(
        [string]$Command,
        [hashtable]$Payload = @{}
    )

    $inFile = Join-Path $script:TmpDir 'in.json'
    $outFile = Join-Path $script:TmpDir 'out.json'

    $payloadObj = @{
        cmd        = $Command
        profileDir = $ProfileDir
        dataDir    = (Join-Path $script:Root 'data')
    }
    foreach ($k in $Payload.Keys) { $payloadObj[$k] = $Payload[$k] }

    $json = $payloadObj | ConvertTo-Json -Depth 8 -Compress
    [System.IO.File]::WriteAllText($inFile, $json, [System.Text.UTF8Encoding]::new($false))

    # 用文件交换数据，避免命令行转义和中文编码的坑
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $script:NodeExe
    $psi.Arguments = "`"$script:BridgeJs`" `"$inFile`" `"$outFile`""
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    # 不重定向 stdout/stderr。
    #
    # 踩过的坑：把两个流都 Redirect 之后，无论按什么顺序读都可能死锁——
    # PowerShell 的 ReadToEnd 要等进程关管道，而子进程要等缓冲区被读走，
    # 双方互相等，一卡就没有上限（实测卡在启动探测那一步，界面永远超时）。
    #
    # 我们本来也不需要 node 的输出：结果走 out.json 文件，
    # 出错信息由 bridge.js 自己写进 out.json。
    # 所以直接不重定向最省事——没有管道，就不存在管道死锁。
    $psi.RedirectStandardError = $false
    $psi.RedirectStandardOutput = $false
    $psi.WorkingDirectory = $script:Root

    $proc = [System.Diagnostics.Process]::Start($psi)
    if ($script:DbgLog) { & $script:DbgLog "  bridge[$Command] pid=$($proc.Id)" }

    if (-not $proc.WaitForExit(60000)) {
        try { $proc.Kill() } catch { }
        throw '后端执行超时（60 秒）'
    }
    if ($script:DbgLog) { & $script:DbgLog "  bridge[$Command] 退出码=$($proc.ExitCode)" }

    if (-not (Test-Path $outFile)) {
        throw "后端执行失败：node 退出码 $($proc.ExitCode)，未产生输出文件"
    }

    $text = [System.IO.File]::ReadAllText($outFile, [System.Text.UTF8Encoding]::new($false))
    return $text
}

# 启动时先用只读指令探一次，确认后端链路通（失败要早说，不要等用户点了才发现）
try {
    $null = Invoke-Bridge -Command 'ping'
} catch {
    [System.Windows.Forms.MessageBox]::Show(
        "后端初始化失败：`n`n$($_.Exception.Message)",
        'DSH 插件管理器', 'OK', 'Error') | Out-Null
    exit 1
}

# ---------------------------------------------------------------------------
# 3. 建窗口
# ---------------------------------------------------------------------------
$form = New-Object System.Windows.Forms.Form
$form.Text = 'DSH 插件管理器'
$form.Width = 1080
$form.Height = 720
$form.MinimumSize = New-Object System.Drawing.Size(760, 480)
$form.StartPosition = 'CenterScreen'
$form.BackColor = [System.Drawing.Color]::FromArgb(15, 20, 25)
$form.Icon = $null

$wv = New-Object Microsoft.Web.WebView2.WinForms.WebView2
$wv.Dock = 'Fill'
$form.Controls.Add($wv)

$script:Ready = $false

$script:WriteLog = ${function:Write-Log}

# ===========================================================================
# 界面消息处理
#
# ⚠ 这里绝对不能在回调里同步执行 node。
#
# 踩过的坑：最初在 WebMessageReceived 回调里直接 Start + WaitForExit 跑 node，
# 界面每次都「后端无响应（超时）」。原因是回调运行在 WebView2 的 UI 线程上，
# WaitForExit 把这个线程占住，而结果又要靠同一个线程把消息送回页面，直接互锁。
#
# 现在的做法把工作彻底拆成非阻塞两步：
#   1. 回调里只登记请求，立刻返回 pending，什么都不等
#   2. 一个 150ms 的界面定时器：空闲时启动 node（只 Start 不 Wait），
#      下一拍检查进程是否退出，退出后读结果文件回传
#
# 全程没有任何 WaitForExit，UI 线程每一拍最多做几毫秒的活，界面不会卡。
# ===========================================================================
# 请求队列。
# 最初这里是单值变量，界面启动时 settings 和 load 几乎同时发出，
# 后到的直接覆盖先到的，先到的请求就永远没人处理（实测丢了 settings）。
# 改成队列，先进先出，一个都不丢。
$script:Queue = New-Object System.Collections.Queue
$script:Running = $null       # @{ proc=...; cmd=...; outFile=...; startedAt=... }

$script:OnMessage = {
    param($sender, $e)

    try {
        # 前端用 postMessage 发的是 JSON 文本，WebMessageAsJson 会把它再包一层引号，
        # 直接 ConvertFrom-Json 得到的是字符串而不是对象。先判断类型再逐层解开。
        $raw = $e.WebMessageAsJson
        $parsed = $raw | ConvertFrom-Json
        if ($parsed -is [string]) { $parsed = $parsed | ConvertFrom-Json }
        $msg = $parsed
        $cmd = [string]$msg.cmd
        Write-Log "收到消息: $cmd"

        switch ($cmd) {
            'openFolder' {
                $dir = $ProfileDir
                if (-not $dir) { $dir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }
                Start-Process explorer.exe $dir
                $wv.CoreWebView2.PostWebMessageAsString(
                    '{"cmd":"openFolder","ok":true,"payload":{}}')
                return
            }
            'load' { }
            'toggle' { }
            'launch' { }
            'suspects' { }
            'settings' { }
            default {
                $wv.CoreWebView2.PostWebMessageAsString(
                    "{""cmd"":""$cmd"",""ok"":false,""payload"":{""error"":""未知指令""}}")
                return
            }
        }

        if ($script:Running) {
            $wv.CoreWebView2.PostWebMessageAsString(
                "{""cmd"":""$cmd"",""ok"":false,""payload"":{""error"":""上一个操作还没结束，请稍候""}}")
            return
        }

        # 入队，立刻返回 pending——前端收到 pending 会继续等，不会断开
        $item = @{
            cmd  = $cmd
            name = if ($msg.arg) { [string]$msg.arg.name } else { '' }
            want = if ($msg.arg) { [bool]$msg.arg.enabled } else { $false }
        }
        # settings 指令要带上"保存什么"，原样转成 JSON 交给 node 侧解析
        if ($cmd -eq 'settings' -and $msg.arg -and $msg.arg.settings) {
            $item['settingsJson'] = ($msg.arg.settings | ConvertTo-Json -Depth 4 -Compress)
        }
        $script:Queue.Enqueue($item)
        $wv.CoreWebView2.PostWebMessageAsString(
            "{""cmd"":""$cmd"",""ok"":true,""payload"":{""pending"":true}}")
    } catch {
        Write-Log "OnMessage 出错: $($_.Exception.Message)"
    }
}

# 每一拍做非阻塞的活：要么启动 node，要么收取上次的结果
$script:Ticker = New-Object System.Windows.Forms.Timer
$script:Ticker.Interval = 150
$script:Ticker.Add_Tick({
    try {
        # 有待收的结果
        if ($script:Running) {
            $r = $script:Running
            if (-not $r.proc.HasExited) {
                # 兜底超时，别让界面无限等。
                # launch 的观察时长来自用户设置（最长 600 秒），这里要多留 30 秒余量：
                # 否则观察还没结束就把 node 杀了，界面拿到的是"后端执行超时"
                # 而不是真实的启动结论。
                $limitSec = if ($r.cmd -eq 'launch') { $script:LaunchLimitSec + 30 } else { 60 }
                if (((Get-Date) - $r.startedAt).TotalSeconds -gt $limitSec) {
                    try { $r.proc.Kill() } catch { }
                    $script:Running = $null
                    $wv.CoreWebView2.PostWebMessageAsString(
                        "{""cmd"":""$($r.cmd)"",""ok"":false,""payload"":{""error"":""后端执行超时""}}")
                }
                return
            }

            $script:Running = $null
            $body = '{"ok":false,"error":"后端未产生输出"}'
            try {
                if (Test-Path $r.outFile) {
                    $body = [System.IO.File]::ReadAllText($r.outFile, [System.Text.UTF8Encoding]::new($false))
                }
            } catch {
                $body = '{"ok":false,"error":"读取后端结果失败"}'
            }
            Write-Log "  $($r.cmd) 完成"

            # 设置保存成功时，把新值同步进内存。
            # 否则界面改完设置，本次运行仍用旧值，要重启程序才生效。
            if ($r.cmd -eq 'settings') {
                try {
                    $parsed = $body | ConvertFrom-Json
                    if ($parsed.ok -and $parsed.settings) {
                        $script:LaunchTimeoutSec = [int]$parsed.settings.launchTimeoutSec
                        $script:LaunchLimitSec = $script:LaunchTimeoutSec
                        Write-Log "  观察时长已更新为 $script:LaunchTimeoutSec 秒"
                    }
                } catch {
                    Write-Log "  解析设置结果失败：$($_.Exception.Message)"
                }
            }

            $wv.CoreWebView2.PostWebMessageAsString(
                "{""cmd"":""$($r.cmd)"",""ok"":true,""payload"":$body}")
            return
        }

        # 有要启动的请求（队列非空才出队）
        if ($script:Queue.Count -eq 0) { return }

        $req = $script:Queue.Dequeue()

        $inFile = Join-Path $script:TmpDir ("in-" + [guid]::NewGuid().ToString('N') + '.json')
        $outFile = Join-Path $script:TmpDir ("out-" + [guid]::NewGuid().ToString('N') + '.json')

        $payloadObj = @{
            cmd        = $req.cmd
            profileDir = $ProfileDir
            dataDir    = (Join-Path $script:Root 'data')
        }
        if ($req.cmd -eq 'toggle') {
            $payloadObj['name'] = $req.name
            $payloadObj['enabled'] = $req.want
        }
        if ($req.cmd -eq 'launch') {
            # 观察时长来自设置（默认 180 秒，可在界面里改）。
            # bridge 会阻塞这么久才写结果文件，所以定时器的超时上限
            # 也跟着这个值走（见上面的 LaunchLimitSec + 30）。
            $payloadObj['watchMs'] = $script:LaunchTimeoutSec * 1000
        }
        if ($req.cmd -eq 'settings') {
            $payloadObj['save'] = $true
            if ($req.settingsJson) {
                $payloadObj['settings'] = $req.settingsJson | ConvertFrom-Json
            }
        }
        $json = $payloadObj | ConvertTo-Json -Depth 8 -Compress
        [System.IO.File]::WriteAllText($inFile, $json, [System.Text.UTF8Encoding]::new($false))

        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $script:NodeExe
        $psi.Arguments = "`"$script:BridgeJs`" `"$inFile`" `"$outFile`""
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.WorkingDirectory = $script:Root
        # 不重定向任何流：没有管道就不会有管道死锁，结果统一走文件
        $psi.RedirectStandardError = $false
        $psi.RedirectStandardOutput = $false

        $proc = [System.Diagnostics.Process]::Start($psi)
        $script:Running = @{
            proc      = $proc
            cmd       = $req.cmd
            outFile   = $outFile
            startedAt = Get-Date
        }
        Write-Log "  $($req.cmd) 已启动 pid=$($proc.Id)"
    } catch {
        Write-Log "定时器出错: $($_.Exception.Message)"
        try {
            $script:Running = $null
            $wv.CoreWebView2.PostWebMessageAsString(
                "{""cmd"":""load"",""ok"":false,""payload"":{""error"":""$($_.Exception.Message)""}}")
        } catch { }
    }
})
$form.Add_Shown({
    try {
        $env2 = [Microsoft.Web.WebView2.Core.CoreWebView2Environment]::CreateAsync(
            $null, $script:WvProfile).GetAwaiter().GetResult()
        $wv.EnsureCoreWebView2Async($env2).GetAwaiter() | Out-Null
    } catch {
        [System.Windows.Forms.MessageBox]::Show(
            "WebView2 初始化失败：`n$($_.Exception.Message)",
            'DSH 插件管理器', 'OK', 'Error') | Out-Null
        $form.Close()
    }
})

$wv.add_CoreWebView2InitializationCompleted({
    param($sender, $e)
    if (-not $e.IsSuccess) {
        [System.Windows.Forms.MessageBox]::Show(
            "WebView2 初始化失败：`n$($e.InitializationException.Message)",
            'DSH 插件管理器', 'OK', 'Error') | Out-Null
        $form.Close()
        return
    }

    # 关掉开发者工具入口和右键菜单，保持界面干净
    $wv.CoreWebView2.Settings.AreDefaultContextMenusEnabled = $false
    $wv.CoreWebView2.Settings.IsStatusBarEnabled = $false
    $wv.CoreWebView2.Settings.AreDevToolsEnabled = ($env:DSH_PM_TEST -eq '1')

    # 先挂消息处理器再导航：顺序反了会漏掉页面初始化时发的第一条消息
    $wv.CoreWebView2.add_WebMessageReceived($script:OnMessage)
    $script:Ticker.Start()
    Write-Log "窗口初始化完成，开始导航"
    $wv.CoreWebView2.Navigate(
        ([System.Uri]::new((Join-Path $script:Root 'src\ui\index.html'))).AbsoluteUri)
})

$form.Add_FormClosed({
    try {
        if (Test-Path $script:TmpDir) {
            Remove-Item $script:TmpDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    } catch { }
})

[void]$form.ShowDialog()
