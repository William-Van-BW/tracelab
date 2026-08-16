Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-AetfFullPath {
    param([Parameter(Mandatory)][string]$Path)
    return [System.IO.Path]::GetFullPath($Path)
}

function Assert-AetfPathUnderRoot {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Root,
        [switch]$AllowRoot
    )
    $fullPath = Get-AetfFullPath -Path $Path
    $fullRoot = (Get-AetfFullPath -Path $Root).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    $prefix = $fullRoot + [System.IO.Path]::DirectorySeparatorChar
    $comparison = [System.StringComparison]::OrdinalIgnoreCase
    if ($fullPath.Equals($fullRoot, $comparison)) {
        if (-not $AllowRoot) { throw "Refusing to operate on the root directory itself: $fullPath" }
        return $fullPath
    }
    if (-not $fullPath.StartsWith($prefix, $comparison)) {
        throw "Target path is outside the allowed root. Target: $fullPath; root: $fullRoot"
    }
    return $fullPath
}

function Find-AetfCasePackage {
    param(
        [Parameter(Mandatory)][string]$CasesRoot,
        [Parameter(Mandatory)][string]$Case,
        [string]$Version
    )
    $matches = @()
    foreach ($caseFile in Get-ChildItem -LiteralPath $CasesRoot -Filter "case.json" -File -Recurse) {
        if ($caseFile.FullName -match '[\\/]\.tracelab-trash[\\/]') { continue }
        $casePath = $caseFile.FullName
        $dir = $caseFile.Directory
        $caseRoot = $dir.Parent
        $doc = Get-Content -LiteralPath $casePath -Raw -Encoding UTF8 | ConvertFrom-Json
        $matchesIdentifier = $doc.case_id -eq $Case -or $caseRoot.Name -eq $Case -or $dir.Name -eq $Case
        $matchesVersion = -not $Version -or [string]$doc.case_version -eq $Version
        if ($matchesIdentifier -and $matchesVersion) {
            $matches += [pscustomobject]@{ Directory = $dir.FullName; Case = $doc }
        }
    }
    if ($matches.Count -eq 0) { throw "Case not found: $Case" }
    if ($matches.Count -gt 1) {
        $matches = @($matches | Sort-Object { try { [version]([string]$_.Case.case_version) } catch { [version]"0.0.0" } } -Descending | Select-Object -First 1)
    }
    return $matches[0]
}

function Get-AetfStateEntries {
    param([Parameter(Mandatory)][object[]]$RootBindings)
    $entries = [System.Collections.Generic.List[object]]::new()
    foreach ($binding in $RootBindings) {
        $rootPath = Get-AetfFullPath -Path $binding.native_path
        if (-not (Test-Path -LiteralPath $rootPath -PathType Container)) {
            $entries.Add([pscustomobject]@{
                root_id = $binding.root_id; relative_path = ""; node_type = "missing_root"
                size_bytes = $null; sha256 = $null; mtime_utc = $null
            })
            continue
        }
        $rootPrefix = $rootPath.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
        $queue = [System.Collections.Generic.Queue[string]]::new()
        $queue.Enqueue($rootPath)
        while ($queue.Count -gt 0) {
            $current = $queue.Dequeue()
            foreach ($item in Get-ChildItem -LiteralPath $current -Force) {
                # Path.GetRelativePath is unavailable in Windows PowerShell 5.1.
                if (-not $item.FullName.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                    throw "State traversal escaped the declared root: $($item.FullName)"
                }
                $relative = $item.FullName.Substring($rootPrefix.Length).Replace("\", "/")
                $isReparse = (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
                if ($item.PSIsContainer) {
                    $entries.Add([pscustomobject]@{
                        root_id = $binding.root_id; relative_path = $relative
                        node_type = $(if ($isReparse) { "reparse_point" } else { "directory" })
                        size_bytes = $null; sha256 = $null; mtime_utc = $item.LastWriteTimeUtc.ToString("o")
                    })
                    if (-not $isReparse) { $queue.Enqueue($item.FullName) }
                } else {
                    $hash = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
                    $entries.Add([pscustomobject]@{
                        root_id = $binding.root_id; relative_path = $relative; node_type = "file"
                        size_bytes = $item.Length; sha256 = $hash; mtime_utc = $item.LastWriteTimeUtc.ToString("o")
                    })
                }
            }
        }
    }
    return @($entries | Sort-Object root_id, relative_path)
}

function Compare-AetfStateEntries {
    param(
        [Parameter(Mandatory)][object[]]$Before,
        [Parameter(Mandatory)][object[]]$After
    )
    $beforeMap = @{}; $afterMap = @{}
    foreach ($item in $Before) { $beforeMap["$($item.root_id):$($item.relative_path)"] = $item }
    foreach ($item in $After) { $afterMap["$($item.root_id):$($item.relative_path)"] = $item }
    $keys = @($beforeMap.Keys + $afterMap.Keys | Sort-Object -Unique)
    $changes = [System.Collections.Generic.List[object]]::new()
    foreach ($key in $keys) {
        $b = $beforeMap[$key]; $a = $afterMap[$key]
        if ($null -eq $b) {
            $changes.Add([pscustomobject]@{ operation = "create"; path = $key; before = $null; after = $a })
        } elseif ($null -eq $a) {
            $changes.Add([pscustomobject]@{ operation = "delete"; path = $key; before = $b; after = $null })
        } elseif ($b.node_type -ne $a.node_type -or $b.sha256 -ne $a.sha256 -or $b.size_bytes -ne $a.size_bytes) {
            $changes.Add([pscustomobject]@{ operation = "modify"; path = $key; before = $b; after = $a })
        }
    }
    return @($changes)
}

function Write-AetfJson {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)]$Value)
    $parent = Split-Path -Parent $Path
    if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    $json = $Value | ConvertTo-Json -Depth 30
    [System.IO.File]::WriteAllText($Path, $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
}

Export-ModuleMember -Function Get-AetfFullPath, Assert-AetfPathUnderRoot, Find-AetfCasePackage, Get-AetfStateEntries, Compare-AetfStateEntries, Write-AetfJson
