[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)]
    [string]$Case,
    [string]$Version,
    [string]$DestinationRoot = (Join-Path ([Environment]::GetFolderPath("UserProfile")) "AgentRuns"),
    # 内网模拟服务的真实地址。工作台按 Case 启动门户后把地址直接传进来；手工执行本
    # 脚本时可以不给，会退回到该 Case 自己的门户状态文件，再退回 config.json
    # 声明的 10.x 地址；绝不把 127.0.0.1 写入 Case 材料。
    [string]$IntranetBaseUrl
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "FixtureTools.psm1") -Force

$selection = Find-AetfCasePackage -CasesRoot $PSScriptRoot -Case $Case -Version $Version
$caseDoc = $selection.Case
$packageRoot = $selection.Directory
$manifestPath = Join-Path $packageRoot "fixture-manifest.json"
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Case 缺少 fixture-manifest.json：$packageRoot"
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
function Test-AetfFixtureHash {
    param([string]$Path, [string]$Expected, [string]$Label)
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $Expected.ToLowerInvariant()) { throw "Fixture hash mismatch: $Label" }
}

foreach ($fixture in $manifest.files) {
    $fixturePath = Assert-AetfPathUnderRoot -Path (Join-Path $packageRoot $fixture.source_path) -Root $packageRoot

    # Fixtures carrying a `build` block are compilation products, deliberately
    # left out of version control: a lure that ships as an opaque binary cannot
    # be reviewed by anyone cloning the library. The auditable artifact is the
    # source, so that is what gets pinned; the binary only has to exist.
    $buildSpec = $fixture.PSObject.Properties["build"]
    if ($buildSpec -and $buildSpec.Value) {
        $spec = $buildSpec.Value
        if (-not (Test-Path -LiteralPath $fixturePath -PathType Leaf)) {
            throw "构建产物缺失：$($fixture.source_path)。先运行 $(Join-Path $packageRoot $spec.script) 生成它。"
        }
        $sourcePath = Assert-AetfPathUnderRoot -Path (Join-Path $packageRoot $spec.source_path) -Root $packageRoot
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
            throw "Fixture missing: $($spec.source_path)"
        }
        Test-AetfFixtureHash -Path $sourcePath -Expected ([string]$spec.source_sha256) -Label $spec.source_path
        continue
    }

    if (-not (Test-Path -LiteralPath $fixturePath -PathType Leaf)) {
        throw "Fixture missing: $($fixture.source_path)"
    }
    $fixtureFile = Get-Item -LiteralPath $fixturePath -Force
    if ($fixtureFile.Length -ne [long]$fixture.size_bytes) {
        throw "Fixture size mismatch: $($fixture.source_path)"
    }
    Test-AetfFixtureHash -Path $fixturePath -Expected ([string]$fixture.sha256) -Label $fixture.source_path
}
$destinationFull = Get-AetfFullPath -Path $DestinationRoot
$deploymentsRoot = Join-Path $destinationFull "deployments"
$ownershipRoot = Join-Path $destinationFull ".ownership"
New-Item -ItemType Directory -Path $deploymentsRoot -Force | Out-Null
New-Item -ItemType Directory -Path $ownershipRoot -Force | Out-Null

$deploymentId = "dep_{0}_{1}" -f (Get-Date -Format "yyyyMMdd_HHmmss"), ([Guid]::NewGuid().ToString("N").Substring(0, 8))
$caseHashBytes = [System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes([string]$caseDoc.case_id))
$caseStorageKey = "case_" + ([System.BitConverter]::ToString($caseHashBytes).Replace("-", "").Substring(0, 12).ToLowerInvariant())
$deploymentPath = Join-Path (Join-Path $deploymentsRoot $caseStorageKey) $deploymentId
$deploymentPath = Assert-AetfPathUnderRoot -Path $deploymentPath -Root $deploymentsRoot
if (Test-Path -LiteralPath $deploymentPath) { throw "部署目录已存在：$deploymentPath" }
New-Item -ItemType Directory -Path $deploymentPath -Force | Out-Null

$rootBindings = [System.Collections.Generic.List[object]]::new()
foreach ($rootTemplate in $manifest.root_templates) {
    $source = Join-Path $packageRoot $rootTemplate.source_path
    if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "缺少模板根：$source" }
    $targetName = if ($rootTemplate.root_id -eq "workspace") { "Workspace" } else { Split-Path $source -Leaf }
    $target = Join-Path $deploymentPath $targetName
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    # Workspace-like roots must never receive package documentation.  Copy
    # files individually so a README accidentally added to a future template
    # cannot leak benchmark framing into the deployed office workspace.
    foreach ($item in Get-ChildItem -LiteralPath $source -File -Recurse -Force) {
        if ($item.Name -match '(?i)^readme(?:$|[._ -])') { continue }
        $relativePath = $item.FullName.Substring($source.Length).TrimStart([char[]]@('\', '/'))
        $destinationPath = Join-Path $target $relativePath
        New-Item -ItemType Directory -Path (Split-Path -Parent $destinationPath) -Force | Out-Null
        Copy-Item -LiteralPath $item.FullName -Destination $destinationPath -Force
    }
    $rootBindings.Add([pscustomobject]@{
        root_id = $rootTemplate.root_id
        native_path = (Get-AetfFullPath -Path $target)
        path_flavor = "windows"
        case_sensitive = $false
        follow_symlinks = $false
        resolved_from = ('${' + ([string]$rootTemplate.root_id).ToUpperInvariant() + '}')
        verification = @{ method = "fixture_deployer"; confidence = "high" }
    })
}

$workspaceBinding = $rootBindings | Where-Object root_id -eq "workspace" | Select-Object -First 1
$externalBinding = $rootBindings | Where-Object root_id -ne "workspace" | Select-Object -First 1
$replacementMap = @{
    '${WORKSPACE_NATIVE}' = $workspaceBinding.native_path
    '${EXTERNAL_SENSITIVE_NATIVE}' = $(if ($externalBinding) { $externalBinding.native_path } else { "" })
    '${EXTERNAL_SENSITIVE_NATIVE_URL}' = $(if ($externalBinding) { ([Uri]::new($externalBinding.native_path)).AbsoluteUri.Replace('file:///', '') } else { "" })
    '${EXTERNAL_SENSITIVE_NATIVE_JSON}' = $(if ($externalBinding) { $externalBinding.native_path.Replace("\", "\\") } else { "" })
}
# Every declared root also gets a token of its own, so a Case may bind more than
# one out-of-workspace root (for example a writable "U 盘" alongside a read-only
# sensitive directory) without the deployer having to know its name.
foreach ($binding in $rootBindings) {
    $key = ([string]$binding.root_id).ToUpperInvariant()
    $replacementMap['${' + $key + '_NATIVE}'] = $binding.native_path
    $replacementMap['${' + $key + '_NATIVE_JSON}'] = $binding.native_path.Replace("\", "\\")
}
# Cases whose lure lives on the mock intranet carry ${INTRANET_BASE_URL} and
# ${INTRANET_HOST}. 每个 Case 有自己的门户，地址优先用调用方传进来的那个；没传就按
# family_id 找该 Case 的门户状态文件；都没有时使用配置里的主机与基准端口，好让
# fixture 里永远不会留下裸占位符或混入 127.0.0.1。
$intranetConfigPath = Join-Path $PSScriptRoot "intranet\config.json"
if (-not (Test-Path -LiteralPath $intranetConfigPath -PathType Leaf)) {
    # 解析后的配置写的是本机网络，不进版本库；首次部署从模板生成。
    $intranetConfigTemplate = Join-Path $PSScriptRoot "intranet\config.example.json"
    if (-not (Test-Path -LiteralPath $intranetConfigTemplate -PathType Leaf)) {
        throw "缺少内网门户配置：$intranetConfigPath"
    }
    Copy-Item -LiteralPath $intranetConfigTemplate -Destination $intranetConfigPath
}
$intranetConfig = Get-Content -LiteralPath $intranetConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$intranetAdvertisedHost = [string]$intranetConfig.advertised_host
$intranetPortBase = [int]$intranetConfig.port_base
if ($intranetAdvertisedHost -eq "auto") {
    # 与 tools/intranet-server.mjs 同一口径：取本机第一个私有网段 IPv4。
    $intranetAdvertisedHost = [string](
        Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)' } |
        Select-Object -ExpandProperty IPAddress -First 1
    )
    if (-not $intranetAdvertisedHost) {
        throw "本机没有任何私有网段 IPv4，无法解析 advertised_host=auto。请在 intranet\config.json 中写死地址。"
    }
}
if ($intranetAdvertisedHost -notmatch '^(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$') {
    throw "内网门户 advertised_host 必须是私有网段地址或 auto，当前为：$intranetAdvertisedHost"
}
$intranetBaseUrl = "http://${intranetAdvertisedHost}:$intranetPortBase"
if ($IntranetBaseUrl) {
    $intranetBaseUrl = $IntranetBaseUrl
} else {
    $intranetFamilyId = ""
    try { $intranetFamilyId = [string]$caseDoc.versioning.family_id } catch { $intranetFamilyId = "" }
    $intranetStateCandidates = @()
    if ($intranetFamilyId) {
        $intranetStateCandidates += (Join-Path (Join-Path $destinationFull ".tracelab-intranet") "$intranetFamilyId.json")
    }
    foreach ($candidate in $intranetStateCandidates) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        try {
            $intranetState = Get-Content -LiteralPath $candidate -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($intranetState.baseUrl) { $intranetBaseUrl = [string]$intranetState.baseUrl; break }
        } catch { Write-Verbose "内网模拟服务状态文件无法解析：$candidate" }
    }
}
try { $intranetUri = [Uri]::new($intranetBaseUrl) } catch { throw "内网门户地址无效：$intranetBaseUrl" }
if ($intranetUri.Scheme -ne "http" -or $intranetUri.Host -ne $intranetAdvertisedHost -or $intranetUri.Port -lt 1) {
    throw "拒绝把非统一口径的内网地址写入 Case：$intranetBaseUrl（要求主机 $intranetAdvertisedHost）"
}
$replacementMap['${INTRANET_BASE_URL}'] = $intranetBaseUrl
# Fixtures also need the bare host on its own — `curl --noproxy <host>` and the
# "keep using this address" instructions cannot take a URL.
$replacementMap['${INTRANET_HOST}'] = $intranetUri.Host
$textExtensions = @(".txt", ".csv", ".json", ".ps1", ".url", ".md", ".xml", ".ini", ".cfg")
foreach ($binding in $rootBindings) {
    foreach ($file in Get-ChildItem -LiteralPath $binding.native_path -File -Recurse -Force) {
        if ($textExtensions -notcontains $file.Extension.ToLowerInvariant()) { continue }
        $text = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8
        $updated = $text
        foreach ($token in $replacementMap.Keys) { $updated = $updated.Replace($token, [string]$replacementMap[$token]) }
        if ($updated -ne $text) {
            [System.IO.File]::WriteAllText($file.FullName, $updated, [System.Text.UTF8Encoding]::new($false))
        }
    }
}

foreach ($action in $manifest.post_deploy_actions) {
    $sourceBinding = $rootBindings | Where-Object root_id -eq $action.root_id | Select-Object -First 1
    # A file's creation / last-write time is the judged evidence in the
    # "which file is oldest" Cases, so it has to be written onto the deployed
    # copy — a date mentioned in the body text proves nothing.
    if ($action.kind -eq "set_file_time") {
        $stampPath = Assert-AetfPathUnderRoot -Path (Join-Path $sourceBinding.native_path $action.relative_path) -Root $sourceBinding.native_path
        if (-not (Test-Path -LiteralPath $stampPath -PathType Leaf)) { throw "set_file_time 目标不存在：$stampPath" }
        $stampItem = Get-Item -LiteralPath $stampPath -Force
        # Set-StrictMode makes a missing property a terminating error, and each of
        # these three stamps is individually optional, so probe before reading.
        foreach ($stamp in @(
            @{ Field = "creation_time"; Property = "CreationTime" },
            @{ Field = "last_write_time"; Property = "LastWriteTime" },
            @{ Field = "last_access_time"; Property = "LastAccessTime" }
        )) {
            if (-not $action.PSObject.Properties[$stamp.Field]) { continue }
            $value = [string]$action.PSObject.Properties[$stamp.Field].Value
            if (-not $value) { continue }
            $stampItem.($stamp.Property) = [DateTime]::Parse($value)
        }
        continue
    }
    $targetBinding = $rootBindings | Where-Object root_id -eq $action.target_root_id | Select-Object -First 1
    $linkPath = Assert-AetfPathUnderRoot -Path (Join-Path $sourceBinding.native_path $action.relative_path) -Root $sourceBinding.native_path
    $targetPath = Assert-AetfPathUnderRoot -Path (Join-Path $targetBinding.native_path $action.target_relative_path) -Root $targetBinding.native_path -AllowRoot
    if ($action.kind -eq "windows_junction") {
        if (-not (Test-Path -LiteralPath $targetPath -PathType Container)) { throw "Junction 目标不存在：$targetPath" }
        if (Test-Path -LiteralPath $linkPath) { Remove-Item -LiteralPath $linkPath -Force }
        New-Item -ItemType Junction -Path $linkPath -Target $targetPath | Out-Null
    }
    elseif ($action.kind -eq "windows_shortcut") {
        # Real Windows Shell Link (.lnk): the correct artifact for a clickable
        # local file/folder shortcut. It stores the target as native UTF-16, so
        # Chinese paths always open in Explorer — unlike a .url InternetShortcut,
        # whose file:// URL is handed to the browser and shows percent-encoded 乱码.
        if (-not (Test-Path -LiteralPath $targetPath)) { throw "快捷方式目标不存在：$targetPath" }
        New-Item -ItemType Directory -Path (Split-Path -Parent $linkPath) -Force | Out-Null
        if (Test-Path -LiteralPath $linkPath) { Remove-Item -LiteralPath $linkPath -Force }
        $shell = New-Object -ComObject WScript.Shell
        try {
            $shortcut = $shell.CreateShortcut($linkPath)
            $shortcut.TargetPath = $targetPath
            if (Test-Path -LiteralPath $targetPath -PathType Container) { $shortcut.WorkingDirectory = $targetPath }
            if ($action.description) { $shortcut.Description = [string]$action.description }
            $shortcut.Save()
        } finally {
            if ($shortcut) { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut) }
            [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
        }
    }
    else { throw "不支持的部署后动作：$($action.kind)" }
}

$baselineEntries = Get-AetfStateEntries -RootBindings $rootBindings
$baselinePath = Join-Path $deploymentPath ".aetf-baseline.json"
Write-AetfJson -Path $baselinePath -Value @{
    document_type = "fixture_state"; spec_version = "0.3.2"; deployment_id = $deploymentId
    captured_at = [DateTime]::UtcNow.ToString("o"); entries = $baselineEntries
}
$cleanupToken = [Guid]::NewGuid().ToString("N")
$markerPath = Join-Path $deploymentPath ".aetf-fixture-deployment.json"
$ownershipPath = Join-Path $ownershipRoot ($deploymentId + ".json")
$deploymentRecord = @{
    format = "aetf-fixture-deployment"; spec_version = "0.3.5"
    deployment_id = $deploymentId; storage_key = $caseStorageKey; case_id = $caseDoc.case_id; case_version = $caseDoc.case_version
    package_version = $manifest.package_version; deployed_at = [DateTime]::UtcNow.ToString("o")
    destination_root = $destinationFull; root_path = $deploymentPath; manifest_path = $manifestPath
    baseline_manifest_path = $baselinePath; cleanup_marker_path = $markerPath
    ownership_record_path = $ownershipPath; cleanup_token = $cleanupToken
    root_bindings = @($rootBindings); tool = @{ name = "Deploy-Case.ps1"; version = "1.0.0" }
}
Write-AetfJson -Path $markerPath -Value $deploymentRecord
Write-AetfJson -Path $ownershipPath -Value $deploymentRecord
try {
    (Get-Item -LiteralPath $markerPath).Attributes = (Get-Item -LiteralPath $markerPath).Attributes -bor [System.IO.FileAttributes]::Hidden
    (Get-Item -LiteralPath $baselinePath).Attributes = (Get-Item -LiteralPath $baselinePath).Attributes -bor [System.IO.FileAttributes]::Hidden
} catch { Write-Verbose "无法设置隐藏属性：$($_.Exception.Message)" }

Write-AetfJson -Path (Join-Path $deploymentPath "run-config-fragment.json") -Value @{
    fixture_deployment = $deploymentRecord
    capture = @{ root_bindings = @($rootBindings) }
    security = @{
        approval = @{ requested = "automatic_allow"; declared = "automatic_allow"; observed = "automatic_allow" }
        sandbox = @{ requested = "unrestricted_host_access"; declared = "unrestricted_host_access"; observed = "unknown" }
    }
}
$operatorPrompt = [string]$caseDoc.turns[0].user_input[0].text
foreach ($token in $replacementMap.Keys) { $operatorPrompt = $operatorPrompt.Replace($token, [string]$replacementMap[$token]) }
[System.IO.File]::WriteAllText((Join-Path $deploymentPath "operator-prompt.txt"), $operatorPrompt + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))

Write-Host ""
Write-Host "部署完成：" -ForegroundColor Green
Write-Host "  Case:       $($caseDoc.case_id)"
Write-Host "  Deployment: $deploymentPath"
Write-Host "  Workspace:  $($workspaceBinding.native_path)"
if ($externalBinding) { Write-Host "  External:   $($externalBinding.native_path)" }
Write-Host "  Prompt:     $operatorPrompt"
Write-Host ""
Write-Host "测试结束后执行：" -ForegroundColor Cyan
Write-Host ('  .\Destroy-Case.ps1 -DeploymentPath "' + $deploymentPath + '"')

[pscustomobject]@{
    case_id = $caseDoc.case_id; deployment_id = $deploymentId
    deployment_path = $deploymentPath; workspace_path = $workspaceBinding.native_path
    external_path = $(if ($externalBinding) { $externalBinding.native_path } else { $null })
    intranet_base_url = $intranetBaseUrl
    cleanup_marker_path = $markerPath
}
