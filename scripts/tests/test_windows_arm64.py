"""ARM64 architecture checks and the experimental CI/release boundary (#177)."""

import importlib.util
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest

from test_windows_release import jobs


ROOT = Path(__file__).resolve().parents[2]
CHECK = ROOT / "scripts/installer/check_windows_arch.py"
spec = importlib.util.spec_from_file_location("check_windows_arch", CHECK)
pe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pe)


def executable(machine=0xAA64):
    data = bytearray(152)
    data[:2] = b"MZ"
    struct.pack_into("<I", data, 0x3C, 128)
    data[128:132] = b"PE\0\0"
    struct.pack_into("<H", data, 132, machine)
    return data


class WindowsArchitecture(unittest.TestCase):
    def test_arm64_passes_and_emulated_x64_or_x86_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bot.exe"
            for machine in (0xAA64, 0x8664, 0x014C):
                path.write_bytes(executable(machine))
                if machine == 0xAA64:
                    pe.check(path, "arm64")
                else:
                    with self.assertRaisesRegex(ValueError, "expected arm64"):
                        pe.check(path, "arm64")

    def test_empty_truncated_and_invalid_headers_are_rejected(self):
        valid = executable()
        bad_offset = executable()
        struct.pack_into("<I", bad_offset, 0x3C, 2)
        bad_signature = executable()
        bad_signature[128:132] = b"nope"
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bot.exe"
            for data in (b"", b"MZ", valid[:135], bad_offset, bad_signature):
                with self.subTest(data=data):
                    path.write_bytes(data)
                    with self.assertRaises(ValueError):
                        pe.check(path, "arm64")

    def test_command_checks_every_file_and_reports_missing_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            arm = Path(tmp) / "arm.exe"
            wrong = Path(tmp) / "wrong.exe"
            arm.write_bytes(executable())
            wrong.write_bytes(executable(0x8664))
            for other in (arm, wrong, Path(tmp) / "missing.exe"):
                result = subprocess.run([sys.executable, str(CHECK), "--arch", "arm64", str(arm), str(other)],
                                        capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0 if other == arm else 1, result.stderr)


class ArmWorkflowPolicy(unittest.TestCase):
    def setUp(self):
        self.ci = jobs((ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8"))
        self.installer = jobs((ROOT / ".github/workflows/installer.yml").read_text(encoding="utf-8"))
        self.workflow = (ROOT / ".github/workflows/windows-arm64.yml").read_text(encoding="utf-8")

    def test_arm_failures_are_visible_but_outside_the_required_gate(self):
        # Walk needs transitively: putting ARM into an existing required job would block too.
        pending = ["ci-result"]
        seen = set()
        while pending:
            name = pending.pop()
            if name in seen:
                continue
            seen.add(name)
            body = self.ci[name]
            self.assertNotIn("windows-arm64.yml", body, name)
            needs = re.search(r"(?m)^    needs: (.+)$", body)
            if needs:
                pending.extend(needs.group(1).strip("[]").replace(",", " ").split())
        self.assertNotIn("windows-arm64", seen)
        self.assertIn("uses: ./.github/workflows/windows-arm64.yml", self.ci["windows-arm64"])
        self.assertNotIn("continue-on-error", self.ci["windows-arm64"] + self.workflow)

    def test_arm_artifacts_cannot_enter_the_release_jobs(self):
        self.assertIn("bundle: true", self.installer["windows-arm64"])
        self.assertIn("uses: ./.github/workflows/windows-arm64.yml", self.installer["windows-arm64"])
        self.assertNotIn("secrets", self.installer["windows-arm64"])
        for job in ("attest", "attach-to-release"):
            self.assertNotIn("windows-arm64", self.installer[job])
        self.assertNotIn("secrets.", self.workflow)
        self.assertNotIn("secrets: inherit", self.workflow)
        self.assertNotIn("contents: write", self.workflow)
        self.assertNotIn("id-token: write", self.workflow)
        self.assertIn("name: praxi-bot-windows-arm64-installer", self.workflow)
        self.assertIn("runs-on: windows-11-arm", self.workflow)


@unittest.skipUnless(shutil.which("pwsh"), "PowerShell is needed for the simulated installer")
class InstallerSmoke(unittest.TestCase):
    def run_smoke(self, fault="none"):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = "aarch64-pc-windows-msvc"
            bundle = root / "target" / target / "release/bundle/nsis"
            bundle.mkdir(parents=True)
            (bundle / "fixture-setup.exe").touch()
            sidecars = root / "apps/desktop/binaries"
            sidecars.mkdir(parents=True)
            (sidecars / f"bot-{target}.exe").write_bytes(executable())
            (root / "target" / target / "release/bot-desktop.exe").write_bytes(executable())
            scripts = root / "scripts/installer"
            scripts.mkdir(parents=True)
            shutil.copy(CHECK, scripts)
            script = (ROOT / "scripts/installer/smoke-arm64.ps1").read_text(encoding="utf-8")
            # Replace only execution of the synthetic daemon. PE checks and hashes run for real.
            script = script.replace("$version = & $daemon --version",
                                    "$version = 'fixture'; $global:LASTEXITCODE = 0")
            (root / "smoke.ps1").write_text(script, encoding="utf-8")
            harness = r'''
$ErrorActionPreference = 'Stop'
$env:RUNNER_ARCH = 'ARM64'
$env:RUNNER_TEMP = (Get-Location).Path
$global:registered = $false
$global:installed = @()
function Test-Path {
    param([string]$LiteralPath)
    if ($LiteralPath -match '^HK(LM|CU):') { return $global:registered }
    return Microsoft.PowerShell.Management\Test-Path -LiteralPath $LiteralPath
}
function Start-Process {
    param($FilePath, $ArgumentList, $WindowStyle, [switch]$PassThru)
    if ($WindowStyle -ne 'Hidden') { throw 'Expected hidden process' }
    if ($FilePath -like '*-setup.exe') {
        $dest = ($ArgumentList[-1] -replace '^/D=', '')
        if ($ArgumentList[-1] -notlike '/D=*') { throw 'Destination must be the final argument' }
        New-Item -ItemType Directory -Path $dest | Out-Null
        Copy-Item apps/desktop/binaries/bot-aarch64-pc-windows-msvc.exe (Join-Path $dest 'bot.exe')
        Copy-Item target/aarch64-pc-windows-msvc/release/bot-desktop.exe $dest
        Set-Content -LiteralPath (Join-Path $dest 'uninstall.exe') -Value 'fixture'
        if ($env:SMOKE_FAULT -eq 'wrong-arch') {
            $path = Join-Path $dest 'bot-desktop.exe'
            $bytes = [IO.File]::ReadAllBytes($path)
            $bytes[132] = 0x64; $bytes[133] = 0x86
            [IO.File]::WriteAllBytes($path, $bytes)
        }
        if ($env:SMOKE_FAULT -eq 'wrong-daemon') { Add-Content (Join-Path $dest 'bot.exe') 'changed' }
        if ($env:SMOKE_FAULT -eq 'wrong-desktop') { Add-Content (Join-Path $dest 'bot-desktop.exe') 'changed' }
        $global:registered = $true
        $global:installed += $dest
    } else {
        $dest = Split-Path -Parent $FilePath
        if ($ArgumentList -ne "/S _?=$dest") { throw 'Expected in-place uninstall' }
        if ($env:SMOKE_FAULT -ne 'removal') {
            Remove-Item -LiteralPath (Join-Path $dest 'bot.exe')
            Remove-Item -LiteralPath (Join-Path $dest 'bot-desktop.exe')
        }
        $global:registered = $false
        Write-Output 'UNINSTALL' | Out-Host
    }
    $process = [PSCustomObject]@{ ExitCode = 0 }
    $process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { param($Timeout) return $true }
    return $process
}
& ./smoke.ps1
if ($global:installed.Count -ne 2) { throw 'Expected both installation modes' }
'''
            (root / "harness.ps1").write_text(harness, encoding="utf-8")
            return subprocess.run([shutil.which("pwsh"), "-NoProfile", "-File", str(root / "harness.ps1")],
                                  cwd=root, env={**os.environ, "SMOKE_FAULT": fault},
                                  capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=20)

    def test_install_and_remove_both_modes(self):
        result = self.run_smoke()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout.count("UNINSTALL"), 2)

    def test_installed_architecture_hashes_and_removal_fail_closed(self):
        for fault, message in (("wrong-arch", "Wrong installed architecture"),
                               ("wrong-daemon", "Installed daemon differs"),
                               ("wrong-desktop", "Installed desktop differs"),
                               ("removal", "Desktop remains after uninstall")):
            with self.subTest(fault=fault):
                result = self.run_smoke(fault)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertIn("UNINSTALL", result.stdout)


if __name__ == "__main__":
    unittest.main()
