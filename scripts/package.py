"""Build a reproducible offline ZIP without profiles, tests, screenshots or macOS metadata."""
import hashlib
import json
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
version = json.loads((root / 'manifest.json').read_text())['version']
assert f'v{version}' in (root / 'popup.html').read_text(), 'Popup version differs from manifest'
files = [
    'manifest.json', 'background.js', 'content.js', 'cursor-colors.js',
    'clipboard-worker.js', 'clipboard-offscreen.js', 'clipboard-offscreen.html',
    'popup.js', 'popup.html', 'popup.css', 'README.md', 'README.en.md', 'CHANGELOG.md',
    'LICENSE', 'TESTING.md', *[f'icons/icon{n}.png' for n in [16, 32, 48, 128]],
]
output = root.parent / f'cross-tab-sync-helper-v{version}.zip'
with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for name in sorted(files):
        info = zipfile.ZipInfo(f'cross-tab-sync-helper/{name}', date_time=(2026, 11, 26, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, (root / name).read_bytes())
with zipfile.ZipFile(output) as archive:
    assert archive.testzip() is None
    assert len(archive.namelist()) == len(files)
sha = hashlib.sha256(output.read_bytes()).hexdigest()
output.with_suffix('.sha256').write_text(f'{sha}  {output.name}\n')
print(output)
print(f'SHA-256 {sha}')
