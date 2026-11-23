"""The branded Windows installer: texts, colours and template stay consistent (fast, no NSIS needed).

The full proof that the script compiles is the Windows Installer workflow (it builds the real
installer); these checks catch the mistakes that would only show up there, or worse, in a
language the author does not read.
"""

import importlib.util
import json
import re
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
NSIS = ROOT / "apps" / "desktop" / "nsis"


def load_generator():
    spec = importlib.util.spec_from_file_location(
        "generate_installer_assets", ROOT / "scripts" / "installer" / "generate_installer_assets.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# Placeholders Tauri's bundler fills in (tauri-cli 2.12.x). A typo here would make `tauri build`
# fail, and so would a stray double-brace in a comment.
TAURI_VARIABLES = {
    "compression", "manufacturer", "product_name", "version", "version_with_build", "homepage",
    "install_mode", "license", "installer_icon", "sidebar_image", "header_image", "uninstaller_icon",
    "uninstaller_header_image", "main_binary_name", "main_binary_path", "bundle_id", "copyright",
    "out_file", "arch", "additional_plugins_path", "allow_downgrades", "display_language_selector",
    "install_webview2_mode", "webview2_installer_args", "webview2_bootstrapper_path",
    "webview2_installer_path", "minimum_webview2_version", "uninstaller_sign_cmd", "estimated_size",
    "start_menu_folder", "installer_hooks", "signed_plugins_path",
    # loop variables inside the {{#each}} blocks
    "this", "ext", "protocol",
}
TAURI_BLOCKS = {
    "each languages", "each language_files", "each resources_dirs", "each resources",
    "each binaries", "each resources_ancestors", "each file_associations as |association| ~",
    "each association.ext as |ext| ~", "each deep_link_protocols as |protocol| ~",
    "if signed_plugins_path", "if installer_hooks",
}
IDENTICAL_TO_ENGLISH_OK = {"version_line"}  # "Version 0.1.0" is the same word in German


class InstallerAssetsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.gen = load_generator()
        cls.strings = cls.gen.load_strings()
        cls.sources = {
            name: (NSIS / name).read_text(encoding="utf-8")
            for name in ("installer.nsi", "praxi-ui.nsh", "installer-hooks.nsh")
        }

    def test_every_text_exists_in_english_turkish_and_german(self):
        self.assertEqual(self.gen.validate_strings(), [])

    def test_turkish_and_german_are_real_translations(self):
        for key, values in self.strings.items():
            if key in IDENTICAL_TO_ENGLISH_OK:
                continue
            self.assertNotEqual(values["tr"], values["en"], f"{key}: tr is a copy of en")
            self.assertNotEqual(values["de"], values["en"], f"{key}: de is a copy of en")

    def test_generated_files_are_up_to_date(self):
        self.assertEqual((NSIS / "praxi-strings.nsh").read_text(encoding="utf-8"), self.gen.strings_nsh())
        self.assertEqual((NSIS / "praxi-theme.nsh").read_text(encoding="utf-8"), self.gen.theme_nsh())
        self.assertEqual(self.gen.bmp_size(self.gen.GHOST), (self.gen.GHOST_PX, self.gen.GHOST_PX))

    def test_every_text_the_script_uses_exists_and_none_is_unused(self):
        code = self.sources["installer.nsi"] + self.sources["praxi-ui.nsh"]
        used = set(re.findall(r"\$\(px_([a-z_]+)\)", code))
        self.assertEqual(sorted(used - set(self.strings)), [], "script uses texts that strings.json lacks")
        self.assertEqual(sorted(set(self.strings) - used), [], "strings.json has texts nothing shows")

    def test_template_only_uses_placeholders_tauri_fills_in(self):
        template = self.sources["installer.nsi"]
        variables = set(re.findall(r"\{\{([a-z_]+)\}\}", template))
        self.assertEqual(sorted(variables - TAURI_VARIABLES), [])
        blocks = {b.strip() for b in re.findall(r"\{\{[#]([^}]*)\}\}", template)}
        self.assertEqual(sorted(blocks - TAURI_BLOCKS), [])
        self.assertEqual(template.count("{{#each"), template.count("{{/each}}"))
        self.assertEqual(template.count("{{#if"), template.count("{{/if}}"))
        # A double brace anywhere else (a comment, say) is parsed by Tauri too.
        stripped = re.sub(r"\{\{[^}]*\}\}", "", template)
        self.assertNotIn("{{", stripped)

    def test_colours_come_from_the_theme_tokens(self):
        theme = (NSIS / "praxi-theme.nsh").read_text(encoding="utf-8")
        tokens = self.gen.read_tokens()
        self.assertIn(f"!define PX_BG {tokens['--color-background'][1:].upper()}", theme)
        self.assertIn(f"!define PX_ACCENT {tokens['--color-accent'][1:].upper()}", theme)
        # nothing in the UI code hard-codes a colour
        self.assertEqual(re.findall(r"SetCtlColors[^\n]*\b[0-9A-Fa-f]{6}\b", self.sources["praxi-ui.nsh"]), [])

    def test_data_is_kept_unless_the_box_is_ticked(self):
        # The uninstaller page starts with the box off, and only state 1 deletes app data.
        ui = self.sources["praxi-ui.nsh"]
        self.assertIn("${NSD_GetState} $PxCheckData $R0", ui)
        self.assertNotIn("${NSD_Check $PxCheckData}", ui)
        self.assertNotIn("BM_SETCHECK} ${BST_CHECKED}", ui[ui.index("un.PraxiConfirmPage"):ui.index("un.PxToggleWarning")])
        hooks = self.sources["installer-hooks.nsh"]
        self.assertIn("${If} $DeleteAppDataCheckboxState == 1", hooks)

    def test_tauri_config_points_at_the_template_and_has_three_languages(self):
        config = json.loads((ROOT / "apps" / "desktop" / "tauri.conf.json").read_text(encoding="utf-8"))
        nsis = config["bundle"]["windows"]["nsis"]
        self.assertEqual(nsis["template"], "nsis/installer.nsi")
        self.assertEqual(nsis["languages"], ["English", "Turkish", "German"])
        self.assertEqual(nsis["installMode"], "currentUser")
        for name in ("template", "installerHooks"):
            self.assertTrue((ROOT / "apps" / "desktop" / nsis[name]).exists(), name)


if __name__ == "__main__":
    unittest.main()
