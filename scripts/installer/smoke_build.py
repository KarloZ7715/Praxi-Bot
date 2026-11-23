#!/usr/bin/env python3
"""Compile the branded installer script quickly, without a full Tauri build (Windows, local tool).

`pnpm build:desktop` is the real thing, but it needs a release build of the whole app. To work on
the installer pages you only need makensis, so this script renders apps/desktop/nsis/installer.nsi
the way Tauri does (the {{...}} placeholders, dummy app files) and compiles it. With --preview the
installer is built in a mode that fakes the install work (no files copied, no registry written), so
the pages can be opened and looked at safely: run the .exe, or run the preview uninstaller that the
preview installer writes next to itself.

Needs the NSIS copy that Tauri downloads on its first bundle (%LOCALAPPDATA%/tauri/NSIS) and the
helper files of the Tauri bundler, which are fetched once from GitHub into --work.

    python scripts/installer/smoke_build.py --work D:/praxi-builds/c600/nsis-smoke --preview
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NSIS_SRC = ROOT / "apps" / "desktop" / "nsis"
TAURI_TAG = "tauri-cli-v2.12.4"  # keep in step with the @tauri-apps/cli version in pnpm-lock.yaml
RAW = f"https://raw.githubusercontent.com/tauri-apps/tauri/{TAURI_TAG}/crates/tauri-bundler/src/bundle/windows/nsis"
HELPERS = ["utils.nsh", "FileAssociation.nsh"]
LANGUAGES = ["English", "Turkish", "German"]


def fetch(url: str, dest: Path) -> None:
    if dest.exists() and dest.stat().st_size > 0:
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=60) as r:  # noqa: S310 - fixed https URL
        dest.write_bytes(r.read())


def render(template: str, values: dict[str, str], language_files: list[str]) -> str:
    # {{#if signed_plugins_path}}...{{/if}} is dropped, {{#if installer_hooks}}...{{/if}} kept
    template = re.sub(r"\{\{#if signed_plugins_path\}\}.*?\{\{/if\}\}\n?", "", template, flags=re.S)
    template = re.sub(r"\{\{#if installer_hooks\}\}\n?(.*?)\{\{/if\}\}\n?", r"\1", template, flags=re.S)

    def each_languages(m: re.Match[str]) -> str:
        return "".join(m.group(1).replace("{{this}}", name) for name in LANGUAGES)

    template = re.sub(r"\{\{#each languages\}\}(.*?)\{\{/each\}\}", each_languages, template, flags=re.S)

    def each_files(m: re.Match[str]) -> str:
        return "".join(m.group(1).replace("{{this}}", f) for f in language_files)

    template = re.sub(r"\{\{#each language_files\}\}(.*?)\{\{/each\}\}", each_files, template, flags=re.S)
    # resources / binaries / associations / deep links: none in the smoke build
    inner = re.compile(r"\{\{#each[^}]*\}\}(?:(?!\{\{#each).)*?\{\{/each\}\}", re.S)
    while inner.search(template):
        template = inner.sub("", template)
    for key, value in values.items():
        template = template.replace("{{" + key + "}}", value)
    left = re.findall(r"\{\{[^}]*\}\}", template)
    if left:
        raise SystemExit(f"unrendered placeholders: {sorted(set(left))}")
    return template


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True, help="scratch directory (on D:, not in the repo)")
    ap.add_argument("--preview", action="store_true", help="fake the install work so the pages can be viewed")
    ap.add_argument("--nsis", default=str(Path(os.environ.get("LOCALAPPDATA", "")) / "tauri" / "NSIS"))
    args = ap.parse_args()

    work = Path(args.work).resolve()
    if ROOT in work.parents or work == ROOT:
        raise SystemExit("--work must be outside the repository")
    nsis = Path(args.nsis)
    makensis = nsis / "makensis.exe"
    if not makensis.exists():
        raise SystemExit(f"{makensis} not found: run `pnpm build:desktop` once so Tauri downloads NSIS")

    out = work / "nsis"
    out.mkdir(parents=True, exist_ok=True)
    for name in HELPERS:
        fetch(f"{RAW}/{name}", out / name)
    language_files = []
    for lang in LANGUAGES:
        dest = out / "languages" / f"{lang}.nsh"
        fetch(f"{RAW}/languages/{lang}.nsh", dest)
        text = dest.read_text(encoding="utf-8")
        rendered = out / "languages" / f"{lang}.rendered.nsh"
        rendered.write_text("\ufeff" + text.replace("{{product_name}}", "Praxi-Bot"), encoding="utf-8")
        language_files.append(str(rendered))

    dummy = out / "bot-desktop.exe"
    dummy.write_bytes(b"MZ smoke-test placeholder\n")
    icon = ROOT / "apps" / "desktop" / "icons" / "icon.ico"
    hooks = NSIS_SRC / "installer-hooks.nsh"
    values = {
        "compression": "zlib",
        "manufacturer": "Praxi-Bot",
        "product_name": "Praxi-Bot",
        "version": "0.1.0",
        "version_with_build": "0.1.0.0",
        "homepage": "",
        "install_mode": "currentUser",
        "license": "",
        "installer_icon": str(icon),
        "sidebar_image": "",
        "header_image": "",
        "uninstaller_icon": str(icon),
        "uninstaller_header_image": "",
        "main_binary_name": "bot-desktop",
        "main_binary_path": str(dummy),
        "bundle_id": "com.praxibot.desktop",
        "copyright": "",
        "out_file": str(out / "Praxi-Bot-smoke-setup.exe"),
        "arch": "x64",
        "additional_plugins_path": str(nsis / "Plugins" / "x86-unicode" / "additional"),
        "allow_downgrades": "false",
        "display_language_selector": "false",
        "install_webview2_mode": "skip",
        "webview2_installer_args": "/silent",
        "webview2_bootstrapper_path": "",
        "webview2_installer_path": "",
        "minimum_webview2_version": "",
        "uninstaller_sign_cmd": "",
        "estimated_size": "1",
        "start_menu_folder": "Praxi-Bot",
        "installer_hooks": str(hooks),
    }
    template = (NSIS_SRC / "installer.nsi").read_text(encoding="utf-8")
    script = out / "installer.nsi"
    script.write_text("\ufeff" + render(template, values, language_files), encoding="utf-8")

    cmd = [str(makensis), "/INPUTCHARSET", "UTF8", "/V3"]
    if args.preview:
        cmd.append("/DPRAXI_PREVIEW")
    cmd.append(str(script))
    print(" ".join(cmd))
    result = subprocess.run(cmd, cwd=out)
    if result.returncode == 0:
        print(f"built {values['out_file']}")
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
