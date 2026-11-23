# The Windows installer

Praxi-Bot ships one Windows installer, a per-user NSIS `.exe` built by Tauri. It has its own look:
one dark window in the Obsidian colours with the ghost, the product name, a short line, one big
button, a progress bar and plain status text. This page explains how that is put together and how
to change it. Users never need to read it.

## What the user sees

| Situation | What the window shows |
|-----------|----------------------|
| Nothing installed yet | **Install Praxi-Bot**, a short line, **Install**, an *Advanced options* link |
| An older version is installed (found automatically) | **Update Praxi-Bot** and **Update**. No options, no radio buttons |
| The same version is installed | **Reinstall Praxi-Bot** and **Reinstall** |
| A newer version is installed | Says so and changes nothing. Only **Close** |
| While working | Title, one plain status line (*Copying files...*), a progress bar |
| Done | **Praxi-Bot is ready**, **Launch Praxi-Bot**, **Close** |
| Uninstall | **Uninstall Praxi-Bot**, the box **Also delete app data** (off), **Uninstall**, **Cancel**. Ticking the box shows a plain warning |

*Advanced options* (fresh installs only) hold the install folder (a **Browse...** button, so nothing
has to be typed), *Just for me* (default, no administrator needed) or *For everyone on this PC*, and
the desktop shortcut tick. The language follows Windows (English, Turkish, German); there is no
language picker.

Everything the stock installer supported keeps working: `/S` (silent), `/P` (progress only),
`/UPDATE` (what the in-app updater uses), `/NS`, `/R`, `/D=<folder>`, `/AUTOSTART=1`, the WebView2
bootstrapper, the bundled `bot` sidecar and the unsigned SmartScreen behaviour. `/ALLUSERS` installs
for everyone (needs an administrator prompt; the Advanced choice does the same through a UAC
prompt).

## How it is built

Tauri renders an NSIS script from a template and runs `makensis` (it downloads a pinned NSIS on its
first bundle). We replace Tauri's template with our own through `bundle.windows.nsis.template`.
No NSIS plug-in beyond what Tauri already ships is used, so the installer stays small (the pages add
about 100 KB) and every licence stays as it was.

```
apps/desktop/nsis/
  installer.nsi          copy of Tauri's template, changed where it says PRAXI / Px
  praxi-ui.nsh           the pages: drawing, buttons, advanced options, progress, finish, uninstall
  installer-hooks.nsh    Tauri hooks (stop the app before replacing it, autostart, app data on uninstall)
  strings.json           every text, in en / tr / de  (source of truth)
  praxi-strings.nsh      generated from strings.json
  praxi-theme.nsh        generated from packages/ui/tokens.css (the Obsidian colours)
  art/ghost.bmp          generated from apps/desktop/icons/icon.png
scripts/installer/
  generate_installer_assets.py   writes the three generated files
  smoke_build.py                 compiles the template quickly, without a full Tauri build
scripts/tests/test_installer_assets.py   texts, colours and template checks (runs in CI)
```

The stock wizard window is kept, so silent mode and the update flow behave as before. Its header,
line and buttons are hidden, the page area is stretched over the whole window, and our controls are
drawn on it. Buttons are flat labels because a stock Windows button cannot be coloured, and
Windows draws no hover state for them. The title bar is made dark with `DwmSetWindowAttribute`
(Windows 11; older Windows keeps the normal bar). Rounded corners were tried and do not
render on these controls, so the design is flat.

### Changing a text or a colour

1. Edit `strings.json` (all three languages, real translations, no ASCII double quote) or the theme.
2. Run `python scripts/installer/generate_installer_assets.py` (the ghost needs `pip install pillow`).
3. Commit the three generated files with the change. CI fails if they are stale.

`$PxOldVer` and `${VERSION}` inside a text are filled in by the installer. Colours are never typed
into the NSIS code: `SetCtlColors` only accepts colours written out in the script, so they come in
as `${PX_...}` defines from `praxi-theme.nsh`.

### Looking at the pages without installing anything

```powershell
pnpm install --frozen-lockfile
pnpm build:desktop        # once, so Tauri downloads NSIS into %LOCALAPPDATA%\tauri\NSIS
python scripts/installer/smoke_build.py --work D:\scratch\nsis-smoke --preview
```

`--preview` builds a variant that fakes the work: nothing is copied and nothing is written to the
registry. Run the `.exe` it prints. Useful switches (put them after the exe): `/XLANG=1055` Turkish,
`/XLANG=1031` German, `/XLANG=1033` English, `/XMODE=1|2|3` forces the update / same-version /
newer-version page, `/XHOLD=5000` keeps the progress page open longer. When a preview install ends it
writes `praxi-preview-uninstall.exe` next to itself; run it with `_?=<that folder>` to see the
uninstall pages (it does not remove anything either).

Command-line gotcha: Git Bash rewrites an argument that starts with `/` into a Windows path, which
the installer then reads as `/P` (passive). Use PowerShell, or `MSYS_NO_PATHCONV=1`.

### Compile check in CI

The **Windows Installer** workflow builds the real installer and then installs, runs and removes it
silently (per user, and for everyone with `/ALLUSERS`). It runs on tags, weekly, by hand, and on any
pull request that touches `apps/desktop/nsis/`, `apps/desktop/tauri.conf.json` or
`scripts/installer/`. The cheap checks (texts, colours, template placeholders, generated files) run
in the normal CI on every pull request.

## After a Tauri upgrade

`installer.nsi` is a copy of Tauri's template (tauri-cli 2.12.x), so a new Tauri can add or change
placeholders. After bumping `@tauri-apps/cli`:

1. Diff upstream `crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi` between the old and the
   new tag and port the changes (our changes are marked `PRAXI`).
2. Update `TAURI_VARIABLES` in `scripts/tests/test_installer_assets.py` and `TAURI_TAG` in
   `scripts/installer/smoke_build.py`.
3. Run the Windows Installer workflow by hand.

## What is not covered by automatic checks

- The pages are looked at with `--preview`; CI never opens a window.
- *For everyone on this PC* from the window relaunches the installer through a UAC prompt. CI covers
  the silent `/ALLUSERS` path, not the prompt.
- An older install is replaced by running its own uninstaller first (`/P /UPDATE`), which may show
  that old uninstaller's small progress window for a moment.
