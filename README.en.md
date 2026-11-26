# Cross-Tab Sync Helper / 跨标签页操作同步助手

[简体中文 README](README.md) · [Download the installation ZIP](https://github.com/Pain-ENE/cross-tab-sync-helper/releases/latest) · [Changelog](CHANGELOG.md)

Perform an action in one tab and let the other tabs in the group follow. Designed for repetitive data entry, bulk selections, and checking multiple pages side by side. The extension runs locally in your browser.

## Features

- **Sync group.** Choose which tabs follow one another. The extension replays actions such as clicks, text input, scrolling, and navigation. Each tab shows its sync status and most recent replay time.
- **Window tiling.** Arrange the selected tabs in separate windows. After tiling, the extension brings the browser windows forward in sequence and focuses the lead window last.
- **Field exclusions.** Exclude IDs, submit buttons, or other controls so tabs can retain distinct values and be submitted individually.
- **Colors.** Customize the interface accent and the mirrored cursor independently in the sync settings. Use the color picker or enter a HEX value. The default is muted seafoam.
- **Precision mode.** When regular replay does not trigger a control, try the browser debugging interface. Compatibility depends on the page.

## Clipboard

Enable sync and put the caret at the intended edit position. Right-click and select **同步粘贴** (Paste to all) or **分行粘贴** (Paste by line). When the site replaces the browser context menu, use the equivalent buttons in the extension popup. For Tencent Docs, start with an active formula-bar editor. Each tab uses its own current edit position.

- Paste to all sends the complete plain text to each tab. Paste by line assigns one line to each tab in sync-group list order. Both actions support up to 9 tabs. Extra lines are ignored, blank lines keep their position, and tabs without an assigned line are skipped.
- Each tab shows up to 30 characters, with an ellipsis for longer text. The extension clears the clipboard after a page accepts the paste. It preserves the content if every paste fails and protects text copied while a paste is in progress.
- On a synced page, press **Alt+Shift+V** to paste to all, **Alt+Shift+L** to paste by line, or **Alt+Shift+X** to clear manually. Both paste shortcuts clear the clipboard after a successful paste. Bind browser-wide clipboard shortcuts at `edge://extensions/shortcuts` or `chrome://extensions/shortcuts`.
- Clipboard permissions allow the extension to read and clear the current clipboard. The extension does not store a clipboard history or upload clipboard data. OS clipboard history is managed by the system.

## Installation

1. Extract the offline installation ZIP for the desired version.
2. Open `edge://extensions` in Edge or `chrome://extensions` in Chrome. Enable Developer mode.
3. Choose **Load unpacked** and select the `cross-tab-sync-helper` folder containing `manifest.json`.
4. To update an existing unpacked installation, extract the new files into the same directory, then click **Reload** on the extensions page.

## Shortcuts

| Action | Shortcut |
| --- | --- |
| Enable sync | `Alt+,` |
| Disable sync | `Alt+.` |
| Add or remove the active tab | `Alt+Shift+G` |
| Tile within the current window area | `Alt+Shift+S` |
| Paste to all and clear the clipboard on a synced page | `Alt+Shift+V` |
| Paste by line and clear the clipboard on a synced page | `Alt+Shift+L` |
| Clear the clipboard on a synced page | `Alt+Shift+X` |

The popup's tile button uses the current display's available area. Windows belonging to apps configured as always on top may still cover the browser.

## Testing a setup

Open two or more test pages, add them to a group, then enable sync. Take turns using each page and check both the results and the status in the popup. If a target is frozen, loading, or missing a matching control, check that page before continuing. Review important forms individually before submitting.

Version 1.8.6 passed simulated browser API tests for four-window ordering, lead-window focus, recovery after a freeze, and individual replay failures. Desktop occlusion still needs verification on the target machine.

In v1.8.6, the formula bar was verified in Edge across four Tencent Docs test copies. Both “你好” entered using the system Pinyin IME and the number `7356` were saved in all four sheets after pressing Enter and reselecting the cells.

## Attribution and license

This project modifies [aysner/Multi-Tab-Sync](https://github.com/aysner/Multi-Tab-Sync). The upstream repository does not include a license, and its original code remains the author's. See [LICENSE](LICENSE) for attribution and the terms covering this repository's additions and modifications.
