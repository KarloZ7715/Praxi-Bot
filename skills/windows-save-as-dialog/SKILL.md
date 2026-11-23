---
name: windows-save-as-dialog
description: Save a file through the native Windows Save As dialog, including file type selection and existing-file prompts.
version: 0.1.0
when:
  keywords: [save as, guardar como]
---
# Windows Save As dialog

1. After opening **Save As** in the source app, run `desktop_list_apps`. Find
    the dialog for that app, then use `desktop_get_state` with its window ID.
    If the dialog appears inside the source window's tree, use that window ID.
    Match controls by role and label in the language shown on screen. Use
    the index and `gen` from the same current tree for each action. Wait for
    the user's decision whenever Praxi asks for approval.
2. If the user requested a format, choose it in **Save as type** before
    entering the name, since changing the type can change the extension.
    Use `desktop_set_value` on the **File name** edit field next to the type
    selector. Enter the requested absolute path, including the extension.
    Leave paths with spaces unquoted. If the field needs keyboard input, focus
    it and clear it with `Ctrl+A` followed by `Backspace` via `desktop_key`.
    Use a fresh field reference with `desktop_type`. Check the type and the
    visible part of the path before submitting. Long values may be truncated
    in the accessibility tree.
3. Click the observed **Save** button with `desktop_click`. Run
    `desktop_list_apps` again to check for a confirmation or error window.
    If Save As stays open, read its current tree with `desktop_get_state` to
    check for a message in the dialog itself.
4. At an overwrite prompt, choose **Yes** only if the user explicitly
    authorized replacing that exact file. Otherwise choose **No** or
    **Cancel**, report which file already exists, and stop until the user
    authorizes replacement or chooses a different path. If saving fails or
    the dialog stays open after confirmation, report what the app shows and
    stop.
5. Once Save As closes without an error, verify the file at the requested
    path, including its final extension, with `fs_list` on the destination
    folder or the source app's saved-file path.
    If neither check is available, report that you could not verify the file.
