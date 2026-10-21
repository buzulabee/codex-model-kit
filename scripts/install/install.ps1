param(
    [string]$NodePath,
    [string]$CodexPath,
    [switch]$Check
)
$ErrorActionPreference = 'Stop'
$candidates = @()
if ($NodePath) {
    $candidates += $NodePath
} else {
    if ($env:CODEX_MCP_NODE_PATH) { $candidates += $env:CODEX_MCP_NODE_PATH }
    if ($env:CODEX_ELECTRON_RESOURCES_PATH) {
        $candidates += (Join-Path $env:CODEX_ELECTRON_RESOURCES_PATH 'cua_node\bin\node.exe')
    }
    $systemNode = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
    if ($systemNode) { $candidates += $systemNode.Source }
}
$selected = $null
foreach ($candidate in ($candidates | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    try {
        $info = & $candidate -p 'JSON.stringify({version:process.versions.node,execPath:process.execPath})' 2>$null
        if ($LASTEXITCODE -ne 0) { continue }
        $runtime = $info | ConvertFrom-Json
        if ([int]($runtime.version.Split('.')[0]) -ge 24) {
            $selected = $runtime.execPath
            break
        }
    } catch { continue }
}
if (-not $selected) {
    throw 'No Node >=24 found. Run from the Codex desktop environment or pass -NodePath with its supported Node executable. No system changes were made.'
}
$arguments = @((Join-Path $PSScriptRoot 'install.mjs'), '--node', $selected)
if ($CodexPath) { $arguments += @('--codex', $CodexPath) }
if ($Check) { $arguments += '--check' }
& $selected @arguments
if ($LASTEXITCODE -ne 0) { throw 'Plugin installation/check failed. Review the message above; do not edit the managed plugin cache.' }
