<#
.SYNOPSIS
放行 TraceLab 用到的三个端口，让局域网和 Tailscale 都能访问本机的服务。

.DESCRIPTION
三个服务本身都监听 0.0.0.0，连不上时问题几乎总是出在 Windows 防火墙——它默认
只放行本机回环。本脚本按端口建入站规则，作用域限定为私有网段（10/8、172.16/12、
192.168/16）与 Tailscale 的 CGNAT 网段（100.64/10），不对公网开放。

    3000       TraceLab 工作台（当前在用的 Case 与 Run）
    3001       归档查看器（deprecated/ 下已下线的 Case 与 Run）
    8760-8779  内网模拟服务（几个 Case 的诱导材料所在的"公司内网门户"）

内网模拟服务放行的是一段端口而不是一个：同时测多个 Agent 时每个工作台各起一个
门户，端口被占用就顺延到下一个空闲端口，所以整段都要放行。

需要管理员权限。重复执行是安全的：同名规则会被先删掉再重建。

.EXAMPLE
    以管理员身份运行 PowerShell，然后：
    .\scripts\Open-FirewallPorts.ps1

.EXAMPLE
    只放行工作台与归档查看器：
    .\scripts\Open-FirewallPorts.ps1 -Ports 3000,3001

.EXAMPLE
    撤销放行：
    .\scripts\Open-FirewallPorts.ps1 -Remove
#>
[CmdletBinding()]
param(
    # 单个端口写数字，一段端口写 "起-止"，两种都可以传给 -LocalPort。
    [string[]]$Ports = @("3000", "3001", "8760-8779"),
    [switch]$Remove
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    throw "需要管理员权限。请以管理员身份重开 PowerShell 再运行本脚本。"
}

# 私有网段 + Tailscale CGNAT。不含 0.0.0.0/0，公网访问不到。
$remoteScopes = @("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10")

$labels = @{ "3000" = "TraceLab 工作台"; "3001" = "TraceLab 归档查看器"; "8760-8779" = "TraceLab 内网模拟服务（端口自动顺延）" }

foreach ($port in $Ports) {
    $name = "TraceLab $port"
    $existing = @(Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue)
    if ($existing) {
        $existing | Remove-NetFirewallRule
        Write-Host "已移除旧规则：$name" -ForegroundColor DarkGray
    }
    if ($Remove) { continue }

    $label = if ($labels.ContainsKey($port)) { $labels[$port] } else { "TraceLab 服务" }
    New-NetFirewallRule `
        -DisplayName $name `
        -Description "$label（局域网与 Tailscale 可访问，公网不可）" `
        -Direction Inbound `
        -Action Allow `
        -Protocol TCP `
        -LocalPort $port `
        -RemoteAddress $remoteScopes `
        -Profile Any | Out-Null
    Write-Host "已放行 $port/tcp —— $label" -ForegroundColor Green
}

if ($Remove) {
    Write-Host ""
    Write-Host "已撤销放行。" -ForegroundColor Yellow
    return
}

Write-Host ""
Write-Host "本机可用地址：" -ForegroundColor Cyan
$addresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
    Select-Object -ExpandProperty IPAddress)
foreach ($port in $Ports) {
    # 一段端口只演示起始端口；实际用哪个由服务启动时决定，工作台里会显示真实地址。
    $shown = ($port -split "-")[0]
    $suffix = if ($port -match "-") { "  起始端口，实际地址以工作台显示为准" } else { "" }
    foreach ($ip in $addresses) {
        $tag = if ($ip -like "100.*") { "  （Tailscale）" } else { "  （局域网）" }
        Write-Host "  http://${ip}:$shown$tag$suffix"
    }
}
