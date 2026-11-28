# Run on the disposable Windows ARM64 runner, from the repository root.
$ErrorActionPreference = 'Stop'
$target = 'aarch64-pc-windows-msvc'
$bundle = "target/$target/release/bundle/nsis"
$installers = @(Get-ChildItem -LiteralPath $bundle -Filter '*-setup.exe')
if ($installers.Count -ne 1) { throw "Expected exactly one NSIS installer in $bundle" }
$installer = $installers[0].FullName
$builtDaemon = "apps/desktop/binaries/bot-$target.exe"
python scripts/installer/check_windows_arch.py --arch arm64 $builtDaemon "target/$target/release/bot-desktop.exe"
if ($LASTEXITCODE -ne 0) { throw 'Wrong build architecture' }

if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP) -or $env:RUNNER_ARCH -ne 'ARM64') {
    throw 'This smoke test needs a disposable ARM64 runner'
}

foreach ($allUsers in @($false, $true)) {
    $mode = if ($allUsers) { 'all-users' } else { 'current-user' }
    $destination = Join-Path $env:RUNNER_TEMP "praxi-arm64-$mode"
    if (Test-Path -LiteralPath $destination) { throw "Install destination already exists: $destination" }
    $arguments = @('/S')
    if ($allUsers) { $arguments += '/ALLUSERS' }
    # NSIS requires /D= to be the final argument, without quotes even if the path has spaces.
    $arguments += "/D=$destination"
    $process = Start-Process -FilePath $installer -ArgumentList $arguments -WindowStyle Hidden -PassThru
    if (-not $process.WaitForExit(120000)) { $process.Kill(); throw "$mode install timed out" }
    if ($process.ExitCode -ne 0) { throw "$mode install failed: $($process.ExitCode)" }

    try {
        $desktop = Join-Path $destination 'bot-desktop.exe'
        $daemons = @(Get-ChildItem -LiteralPath $destination -Recurse -File |
            Where-Object { $_.Name -eq 'bot.exe' -or $_.Name -eq "bot-$target.exe" })
        if ($daemons.Count -ne 1) { throw 'Expected exactly one installed daemon' }
        $daemon = $daemons[0].FullName
        python scripts/installer/check_windows_arch.py --arch arm64 $desktop $daemon
        if ($LASTEXITCODE -ne 0) { throw 'Wrong installed architecture' }
        if ((Get-FileHash -LiteralPath $daemon).Hash -ne (Get-FileHash -LiteralPath $builtDaemon).Hash) {
            throw 'Installed daemon differs from the staged sidecar'
        }
        if ((Get-FileHash -LiteralPath $desktop).Hash -ne (Get-FileHash -LiteralPath "target/$target/release/bot-desktop.exe").Hash) {
            throw 'Installed desktop differs from the built desktop'
        }
        $version = & $daemon --version
        if ($LASTEXITCODE -ne 0 -or -not $version) { throw 'Installed daemon --version failed' }
        Write-Host "$mode installed daemon: $version"
        $hive = if ($allUsers) { 'HKLM:' } else { 'HKCU:' }
        $registryKey = "$hive\Software\Microsoft\Windows\CurrentVersion\Uninstall\Praxi-Bot"
        if (-not (Test-Path -LiteralPath $registryKey)) { throw "Missing $mode uninstall registration" }
    } finally {
        $uninstaller = Join-Path $destination 'uninstall.exe'
        if (-not (Test-Path -LiteralPath $uninstaller)) { throw 'Uninstaller missing' }
        # _?= keeps the uninstaller in place so its exit means removal has finished.
        $process = Start-Process -FilePath $uninstaller -ArgumentList "/S _?=$destination" -WindowStyle Hidden -PassThru
        if (-not $process.WaitForExit(120000)) { $process.Kill(); throw "$mode uninstall timed out" }
        if ($process.ExitCode -ne 0) { throw "$mode uninstall failed: $($process.ExitCode)" }
    }
    if (Test-Path -LiteralPath (Join-Path $destination 'bot-desktop.exe')) { throw 'Desktop remains after uninstall' }
    if (Test-Path -LiteralPath $daemon) { throw 'Daemon remains after uninstall' }
    if (Test-Path -LiteralPath $registryKey) { throw 'Uninstall registration remains after removal' }
}
