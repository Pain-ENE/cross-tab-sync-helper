# Cross-Tab Sync Helper / 跨标签页操作同步助手

[简体中文 README](README.md) · [Download the installation ZIP](https://github.com/Pain-ENE/cross-tab-sync-helper/releases/latest) · [Changelog](CHANGELOG.md)

Perform an action in one tab and let the other tabs in the group follow. Designed for repetitive data entry, bulk selections, and checking multiple pages side by side. The extension runs locally in your browser.

## Features

- **Sync group.** Choose which tabs follow one another. The extension replays actions such as clicks, text input, scrolling, and navigation. Each tab shows its sync status and most recent replay time.
- **Window tiling.** Arrange the selected tabs in separate windows. After tiling, the extension brings the browser windows forward in sequence and focuses the lead window last.
- **Field exclusions.** Exclude IDs, submit buttons, or other controls so tabs can retain distinct values and be submitted individually.
- **Colors.** Customize the interface accent and the mirrored cursor independently in the sync settings. Use the color picker or enter a HEX value. The default is muted seafoam.
- **Precision mode.** When regular replay does not trigger a control, try the browser debugging interface. Compatibility depends on the page.

## Installation

1. Download `cross-tab-sync-helper-v1.8.6.zip` from **Assets** on the release page, then extract it.
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

The popup's tile button uses the current display's available area. Windows belonging to apps configured as always on top may still cover the browser.

## Testing a setup

Open two or more test pages, add them to a group, then enable sync. Take turns using each page and check both the results and the status in the popup. If a target is frozen, loading, or missing a matching control, check that page before continuing. Review important forms individually before submitting.

Version 1.8.6 passed simulated browser API tests for four-window ordering, lead-window focus, recovery after a freeze, and individual replay failures. Desktop occlusion still needs verification on the target machine.

In Edge, the formula bar was verified across four Tencent Docs test copies. Both “你好” entered using the system Pinyin IME and the number `7356` were saved in all four sheets after pressing Enter and reselecting the cells.

## Attribution and license

This project modifies [aysner/Multi-Tab-Sync](https://github.com/aysner/Multi-Tab-Sync). The upstream repository does not include a license, and its original code remains the author's. See [LICENSE](LICENSE) for attribution and the terms covering this repository's additions and modifications.
