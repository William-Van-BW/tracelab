<#
.SYNOPSIS
把本机与内网网段设为直连，免得被测 Agent 访问内网门户时先吃一个 502 再自己摸索绕过。

.DESCRIPTION
被测 Agent 跑在这台机器上，继承你的代理配置。内网模拟服务的地址如果没被排除，Agent 的
第一次 fetch 会收到代理返回的 502，然后花好几轮去试 --noproxy、查 env、换地址——这段推理
与被测的安全行为毫无关系，却会进 Run 的轨迹，既拉长时间又干扰判读。

本脚本把这些地址设为直连：

  - 回环：localhost / 127.0.0.1 / ::1
  - 本机当前的全部非链路本地 IPv4（含局域网地址与 Tailscale 地址）
  - 私有网段：10/8、172.16/12、192.168/16，以及 Tailscale 的 100.64/10

写两个地方，因为两类程序看的不是同一处：

  1. 当前用户的 NO_PROXY / no_proxy 环境变量 —— curl、node、python 这类工具看它，
     Agent 的工具沙箱也从这里继承。不需要管理员权限。
  2. Windows 系统代理的例外列表（ProxyOverride）—— 浏览器与走 WinINET 的桌面程序看它。

已有的条目一律保留。改完必须重启被测 Agent（以及要用到它的终端）：环境变量和代理设置
都只在进程启动时读取。

用 Clash / Surge 这类客户端时，如果开着 TUN / 增强模式，还要在客户端规则里把这些网段
设为 DIRECT——那种模式在网络层接管流量，不看上面两处设置。

.EXAMPLE
    .\scripts\Set-IntranetNoProxy.ps1

.EXAMPLE
    只看会写什么，不真的写：
    .\scripts\Set-IntranetNoProxy.ps1 -WhatIf

.EXAMPLE
    只改环境变量，不动系统代理例外列表：
    .\scripts\Set-IntranetNoProxy.ps1 -SkipSystemProxy

.EXAMPLE
    撤销（只移除本脚本加过的条目）：
    .\scripts\Set-IntranetNoProxy.ps1 -Remove
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [switch]$Remove,
    [switch]$SkipSystemProxy
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$intranetDirectory = Join-Path $repositoryRoot "case-library\file-operations\intranet"
$configPath = Join-Path $intranetDirectory "config.json"
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    $configPath = Join-Path $intranetDirectory "config.example.json"
}
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw "缺少内网门户配置：$intranetDirectory" }
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$intranetHost = [string]$config.advertised_host
# "auto" 时门户自己挑地址，这里就不再单列具体地址——下面的网段和通配已经覆盖。
if ($intranetHost -eq "auto") { $intranetHost = "" }
if ($intranetHost -and $intranetHost -notmatch '^(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$') {
    throw "advertised_host 必须是私有网段地址或 auto：$intranetHost"
}
$configuredBypass = @($config.proxy_bypass | ForEach-Object { [string]$_ })

# 本机当前的非链路本地 IPv4。内网门户监听 0.0.0.0，工作台给 Agent 的是其中一个，
# 所以逐个列进直连——具体地址的匹配最可靠，通配和网段只是兜底。
$addresses = @(
    [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
        Where-Object { $_.OperationalStatus -eq [System.Net.NetworkInformation.OperationalStatus]::Up } |
        ForEach-Object { $_.GetIPProperties().UnicastAddresses } |
        Where-Object {
            $_.Address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and
            -not [System.Net.IPAddress]::IsLoopback($_.Address) -and
            $_.Address.ToString() -notlike "169.254.*"
        } |
        ForEach-Object { $_.Address.ToString() }
) | Select-Object -Unique

# 私有网段。写三种形式是因为各家实现认的语法不一样：
# Go（含很多 CLI 工具）认 CIDR，curl / requests 认具体地址与后缀，WinINET 认通配。
$ranges = @("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10")
$wildcards = @("10.*", "192.168.*", "100.64.*", "100.65.*", "100.66.*", "100.67.*")
foreach ($second in 16..31) { $wildcards += "172.$second.*" }

$entries = @("localhost", "127.0.0.1", "::1", $intranetHost) + $configuredBypass + $addresses + $ranges + $wildcards |
    Where-Object { $_ } | Select-Object -Unique

function Merge-BypassList {
    param(
        [string]$Current,
        [string]$Separator
    )
    $existing = @()
    if ($Current) {
        $existing = $Current.Split(@(",", ";"), [StringSplitOptions]::RemoveEmptyEntries) |
            ForEach-Object { $_.Trim() } | Where-Object { $_ }
    }
    if ($Remove) {
        $next = @($existing | Where-Object { $entries -notcontains $_ })
    } else {
        $next = @($existing) + @($entries | Where-Object { $existing -notcontains $_ })
    }
    return ($next -join $Separator)
}

foreach ($name in @("NO_PROXY", "no_proxy")) {
    $current = [Environment]::GetEnvironmentVariable($name, "User")
    $value = Merge-BypassList -Current $current -Separator ","
    if ($value -eq $current) {
        Write-Host "$name 无需改动。" -ForegroundColor DarkGray
        continue
    }
    if ($PSCmdlet.ShouldProcess("用户环境变量 $name", "设为 $value")) {
        [Environment]::SetEnvironmentVariable($name, $value, "User")
        Write-Host "$name 已更新（$($value.Split(',').Count) 条）" -ForegroundColor Green
    }
}

if (-not $SkipSystemProxy) {
    $settingsKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings"
    $current = ""
    try { $current = [string](Get-ItemProperty -Path $settingsKey -Name ProxyOverride -ErrorAction Stop).ProxyOverride } catch { $current = "" }
    $value = Merge-BypassList -Current $current -Separator ";"
    if ($value -eq $current) {
        Write-Host "系统代理例外列表无需改动。" -ForegroundColor DarkGray
    } elseif ($PSCmdlet.ShouldProcess("系统代理例外列表 ProxyOverride", "设为 $value")) {
        Set-ItemProperty -Path $settingsKey -Name ProxyOverride -Value $value
        Write-Host "系统代理例外列表已更新（$($value.Split(';').Count) 条）" -ForegroundColor Green
    }
}

Write-Host ""
if ($Remove) {
    Write-Host "已移除。重启被测 Agent 后生效。" -ForegroundColor Yellow
    return
}
Write-Host "已设为直连：" -ForegroundColor Cyan
Write-Host "  Case 统一内网地址：$(if ($intranetHost) { $intranetHost } else { 'auto（由门户在启动时选定）' })"
Write-Host "  回环与本机地址：$((@("localhost", "127.0.0.1") + $addresses | Select-Object -Unique) -join '、')"
Write-Host "  私有网段：$($ranges -join '、')"
Write-Host ""
Write-Host "接下来：" -ForegroundColor Cyan
Write-Host "  1. 完全退出并重开被测 Agent（环境变量与代理设置只在进程启动时读取）。"
Write-Host "  2. Clash / Surge 开着 TUN 或增强模式的话，再在客户端规则里把上面这些网段设为 DIRECT。"
Write-Host "  3. 回到工作台，内网门户状态条上的代理告警应当消失。"
