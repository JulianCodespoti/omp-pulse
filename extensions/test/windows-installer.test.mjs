import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Parsing only: never executes the installer or downloads a release. Runs on
// Windows PowerShell 5.1 and PowerShell 7 when either is installed on the host.
for (const shell of ['pwsh', 'powershell']) {
  test(`Windows installer parses with ${shell} and emits safely quoted PowerShell PATH guidance`, (t) => {
    const script = String.raw`
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:PULSE_INSTALL_SCRIPT, [ref]$tokens, [ref]$errors)
if ($errors.Count) { $errors | ForEach-Object { Write-Error $_ }; exit 1 }
# Execute only the PATH guidance branch, selected by its variable condition.
$branch = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.IfStatementAst] -and $node.Clauses[0].Item1.Extent.Text -eq '-not $OnPath' }, $true)
if (-not $branch) { throw 'PATH guidance branch not found' }
$InstallDir = "C:\Users\O'Brien\Programs\omp pulse"
$guidance = [scriptblock]::Create($branch.Clauses[0].Item2.Extent.Text.TrimStart('{').TrimEnd('}'))
$lines = @(& $guidance 6>&1) | ForEach-Object { $_.ToString() }
$command = $lines | Where-Object { $_.TrimStart().StartsWith('$env:Path +=') }
if (-not $command) { throw 'PowerShell PATH guidance missing' }
$old = $env:Path
try {
  $env:Path = 'existing-path'
  & ([scriptblock]::Create($command))
  if ($env:Path -ne ('existing-path;' + $InstallDir)) { throw 'PATH guidance changed or expanded the directory' }
} finally { $env:Path = $old }
`;
    const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      env: { ...process.env, PULSE_INSTALL_SCRIPT: fileURLToPath(new URL('../../install.ps1', import.meta.url)) },
    });
    if (result.error?.code === 'ENOENT') return t.skip(`${shell} is not installed; native parser coverage unavailable`);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
