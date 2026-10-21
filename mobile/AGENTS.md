# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

## Test execution

- Run and measure one named test file per Vitest invocation when establishing or updating a per-file baseline. Record elapsed time and whether it passed, failed, or did not complete.
- Cap every test invocation at five minutes. If it reaches the cap, terminate the entire test process tree, record it as "did not complete", and do not rerun it just to check completion.
- Run `npm test` for the default suite. The measured `src/engine/__tests__/rotation.test.ts` file takes over two minutes, so it is kept in `npm run test:slow` rather than omitted from test coverage.
- Run every test process with its console hidden so it cannot steal focus. In PowerShell, use `Start-Process -WindowStyle Hidden` (or an equivalent hidden runner), redirect stdout and stderr to log files, and preserve the process exit code. For example:

  ```powershell
  $runId = [guid]::NewGuid().ToString('N')
  $stdout = Join-Path $env:TEMP "vitest-$runId.stdout.log"
  $stderr = Join-Path $env:TEMP "vitest-$runId.stderr.log"
  $run = Start-Process -FilePath 'npm.cmd' -ArgumentList @('test') `
    -WorkingDirectory (Get-Location).Path -WindowStyle Hidden `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru -Wait
  if ($run.ExitCode -ne 0) { throw "npm test failed with exit code $($run.ExitCode)." }
  ```

- Because hidden processes cannot be checked visually, process checks are mandatory. Before the first invocation and after each invocation (including the last), from this directory, verify there are zero checkout-specific Node/Vitest processes:

  ```powershell
  $root = (Resolve-Path ..).Path
  $left = @(Get-CimInstance Win32_Process | Where-Object {
      $_.Name -in @('node.exe', 'vitest.exe') -and
      $_.CommandLine -and
      $_.CommandLine.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0
  })
  if ($left.Count -gt 0) {
    $left | Select-Object ProcessId, ParentProcessId, Name, CommandLine
    throw 'Checkout-specific Node/Vitest processes remain.'
  }
  ```

- If a run times out in Copilot, terminate that invocation's process tree using its PowerShell session handle; do not stop Node processes by name. Re-run the process check and investigate any remaining checkout-specific process before continuing.

## Known slow-suite failures

- `npm run test:slow` has 39 known legacy failures in `src/engine/__tests__/rotation.test.ts`: pre-fix triage found 14 cases hung, 25 failed, and 0 passed. Per Tim's amended gate, this file is tracked but not gating.
- Triage results: `C:\Users\tcast\.copilot\session-state\135d9ce3-fb60-417a-8a19-3576fdd519c0\files\triage-rotation-pre-fix\pre-fix-results.csv`; per-case logs are in the adjacent `runs` directory.
