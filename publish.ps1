#Requires -Version 5.1
<#
.SYNOPSIS
    发布 DSH 插件：测试 → 提版本 → 推送 → 打 tag → 等 CI → 验证上线。

.DESCRIPTION
    把这一轮反复手敲的步骤固化成一条命令。默认走 OIDC（无需 token）；
    若目标包尚未发布过，会自动检测并提示首次发布路径。

    CI 那边的流程是 release.yml：跑测试、npm pack、附 tgz 到 Release、
    然后 publish-npm（有 NPM_TOKEN 走 token，否则走 OIDC）。

.PARAMETER Bump
    版本提升类型：patch（默认）、minor、major，或跳过（值 none，即用当前版本）。

.PARAMETER RepoPath
    插件仓库根目录。默认当前目录。

.PARAMETER SkipTests
    跳过本地测试（CI 仍会跑）。不建议。

.EXAMPLE
    .\publish.ps1
    提升 patch 版本并走完整发布流程。

.EXAMPLE
    .\publish.ps1 -Bump minor -RepoPath F:\path\to\plugin
#>
[CmdletBinding()]
param(
    [ValidateSet('patch', 'minor', 'major', 'none')]
    [string]$Bump = 'patch',

    [string]$RepoPath = (Get-Location).Path,

    [switch]$SkipTests,

    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ($DryRun) {
    Write-Host '*** DryRun 模式：只做检查与测试，不提交、不推送、不打 tag ***' -ForegroundColor Magenta
}

# ---------------------------------------------------------------- 工具函数

function Write-Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  OK  $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "  !!  $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "  XX  $msg" -ForegroundColor Red }

function Require-Command($name) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        throw "缺少命令：$name。请先安装（git: winget install Git.Git；node: winget install OpenJS.NodeJS.LTS）。"
    }
}

# PowerShell 5.1 的 Get-Content 默认按系统 ANSI 解码无 BOM 的 UTF-8，
# 这会把 package.json 里的中文读成乱码并让 ConvertFrom-Json 失败。
# 统一走显式 UTF-8 读写。
function Read-Utf8Text($path) {
    return [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
}

function Write-Utf8Text($path, $text) {
    [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding $false))
}

# ---------------------------------------------------------------- 前置检查

Write-Step '前置检查'
Require-Command git
Require-Command node

$RepoPath = (Resolve-Path $RepoPath).Path
if (-not (Test-Path (Join-Path $RepoPath 'package.json'))) {
    throw "不是插件根目录（缺 package.json）：$RepoPath"
}
Set-Location $RepoPath

$pkg = Read-Utf8Text (Join-Path $RepoPath 'package.json') | ConvertFrom-Json
$oldVersion = $pkg.version
Write-Ok "包名 $($pkg.name)，当前版本 $oldVersion"

# 工作区必须干净：否则打 tag 会把半截改动带进去
$dirty = git status --porcelain
if ($dirty) {
    Write-Err "工作区有未提交改动："
    $dirty | ForEach-Object { Write-Host "    $_" }
    throw '请先提交或暂存，再发布。'
}
Write-Ok '工作区干净'

# 分支与远端
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne 'main') { Write-Warn2 "当前分支是 $branch，不是 main" }

# ---------------------------------------------------------------- 版本提升

Write-Step "提升版本（$Bump）"
if ($Bump -ne 'none') {
    $parts = $oldVersion.Split('.')
    if ($parts.Count -lt 3) { throw "版本号不是 SemVer：$oldVersion" }
    $major = [int]$parts[0]; $minor = [int]$parts[1]; $patchNum = [int]$parts[2].Split('-')[0]
    switch ($Bump) {
        'major' { $major++; $minor = 0; $patchNum = 0 }
        'minor' { $minor++; $patchNum = 0 }
        'patch' { $patchNum++ }
    }
    $newVersion = "$major.$minor.$patchNum"
    $raw = Read-Utf8Text (Join-Path $RepoPath 'package.json')
    $raw = $raw.Replace("`"version`": `"$oldVersion`"", "`"version`": `"$newVersion`"")
    Write-Utf8Text (Join-Path $RepoPath 'package.json') $raw
    Write-Ok "$oldVersion -> $newVersion"
} else {
    $newVersion = $oldVersion
    Write-Ok "保持 $newVersion"
}

$tag = "v$newVersion"

# ---------------------------------------------------------------- 测试

if (-not $SkipTests) {
    Write-Step '本地测试'
    $testFiles = @(Get-ChildItem -File -Filter 'test*.mjs' | ForEach-Object { $_.Name })
    $e2e = Test-Path 'e2e.mjs'
    $targets = @()
    if ($testFiles.Count -gt 0) { $targets += $testFiles }
    if ($e2e) { $targets += 'e2e.mjs' }

    if ($targets.Count -eq 0) {
        Write-Warn2 '没找到测试文件，跳过'
    } else {
        foreach ($t in $targets) {
            $out = & node $t 2>&1
            if ($LASTEXITCODE -ne 0) {
                Write-Err "$t 失败："
                $out | Select-Object -Last 15 | ForEach-Object { Write-Host "    $_" }
                throw '测试未通过，发布中止。'
            }
            $summary = ($out | Select-Object -Last 1).ToString().Trim()
            Write-Ok "$t  $summary"
        }
    }
}

# ---------------------------------------------------------------- 提交与推送

if ($DryRun) {
    Write-Step 'DryRun：跳过提交、推送、tag 与 CI 等待'
    Write-Host "  将要打 tag：$tag"
    Write-Host "  将要发布：$($pkg.name)@$newVersion"
    # 把 DryRun 期间可能改动的 package.json 还原
    git checkout -- package.json 2>$null
    Write-Ok '已还原 package.json'
    return
}

Write-Step '提交并推送'
git add -A | Out-Null
$staged = git status --porcelain
if ($staged) {
    git commit -q -m "chore: release $tag"
    Write-Ok "已提交 $tag"
} else {
    Write-Ok '无需提交（版本未变）'
}
git push origin $branch
if ($LASTEXITCODE -ne 0) { throw '推送失败。' }
Write-Ok "已推送 $branch"

# ---------------------------------------------------------------- 打 tag

Write-Step "打 tag $tag"
$existing = git tag --list $tag
if ($existing) {
    Write-Warn2 "本地已存在 tag $tag"
    $remoteTag = git ls-remote --tags origin $tag
    if ($remoteTag) {
        Write-Ok "远端已有 $tag，跳过（Release 应已触发）"
        $skipTagPush = $true
    } else {
        git push origin $tag
        $skipTagPush = $true
    }
}
if (-not $skipTagPush) {
    git tag -a $tag -m "Release $tag"
    git push origin $tag
    if ($LASTEXITCODE -ne 0) { throw '推送 tag 失败。' }
    Write-Ok "已推送 $tag，Release 工作流应开始运行"
}

# ---------------------------------------------------------------- 等 CI

Write-Step '等待 Release 工作流'
$remoteUrl = (git config --get remote.origin.url).Trim()
if ($remoteUrl -notmatch 'github\.com[:/](?<slug>[^/]+/[^/.]+)') {
    Write-Warn2 "无法从 remote 解析 GitHub 仓库：$remoteUrl"
    Write-Warn2 '请手动到 Actions 页面确认。'
    return
}
$slug = $Matches['slug']
Write-Ok "仓库 $slug"

# 用 GitHub API 查运行状态；无 token 时匿名可用（限额 60/小时）
$apiBase = "https://api.github.com/repos/$slug/actions/runs?per_page=10"
$found = $null
for ($i = 1; $i -le 40; $i++) {
    Start-Sleep -Seconds 10
    try {
        $runs = Invoke-RestMethod -Uri $apiBase -Headers @{ 'User-Agent' = 'dsh-publish' } -TimeoutSec 30
        $run = $runs.workflow_runs | Where-Object { $_.name -eq 'Release' -and $_.head_branch -eq $tag } | Select-Object -First 1
        if ($run) {
            Write-Host "    [$i] $($run.status) $($run.conclusion)" -NoNewline
            Write-Host ''
            if ($run.status -eq 'completed') { $found = $run; break }
        } else {
            Write-Host "    [$i] 尚未出现 $tag 的运行"
        }
    } catch {
        Write-Warn2 "查询失败：$($_.Exception.Message)"
    }
}

if (-not $found) {
    Write-Warn2 '等待超时，请到 Actions 页面手动确认。'
    return
}

if ($found.conclusion -ne 'success') {
    Write-Err "Release 失败：$($found.html_url)"
    throw '工作流未成功。'
}
Write-Ok "Release 成功：$($found.html_url)"

# ---------------------------------------------------------------- 验证 npm

Write-Step '验证 npm 上线'
$registryUrl = "https://registry.npmjs.org/$($pkg.name)"
$live = $null
for ($i = 1; $i -le 30; $i++) {
    try {
        $doc = Invoke-RestMethod -Uri $registryUrl -TimeoutSec 30
        if ($doc.versions.PSObject.Properties.Name -contains $newVersion) {
            $live = $doc
            break
        }
        Write-Host "    [$i] registry 尚未同步 $newVersion"
    } catch {
        Write-Host "    [$i] registry 查询失败"
    }
    Start-Sleep -Seconds 10
}

if (-not $live) {
    Write-Warn2 "registry 未在预期时间内出现 $newVersion。"
    Write-Warn2 '可能是 npm 处理延迟；稍后用下面命令复查：'
    Write-Host "    npm view $($pkg.name) version"
    return
}

$v = $live.versions.$newVersion
Write-Ok "npm 已有 $($pkg.name)@$newVersion"
Write-Ok "latest = $($live.'dist-tags'.latest)"
Write-Ok "tarball = $($v.dist.tarball)"

# OIDC 发布的标志：dist.attestations 存在
$hasAttestation = $null -ne $v.dist.attestations
if ($hasAttestation) {
    Write-Ok '签发来源证明（attestations）→ 确认走的是 OIDC'
    Write-Host "    https://registry.npmjs.org/-/npm/v1/attestations/$($pkg.name)@$newVersion"
} else {
    Write-Warn2 '无 attestations —— 这次可能走了 token 而非 OIDC（不影响功能，但少一层证明）'
}

Write-Step '发布完成'
Write-Host "  $($pkg.name)@$newVersion"
Write-Host "  GitHub Release: $($found.html_url)"
