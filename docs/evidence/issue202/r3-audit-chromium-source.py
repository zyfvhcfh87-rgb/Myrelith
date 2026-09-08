"""Read-only public source pin; no browser execution, installation or code loading."""
import base64
import hashlib
import json
import pathlib
import plistlib
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
VERSION = '151.0.7922.34'
REVISION = '782af9cb30a53f54487e5d2e44738645a8ec457c'
SOURCE_PATH = 'third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc'
BASE = 'https://chromium.googlesource.com/chromium/src/'

def get(url):
    with urllib.request.urlopen(url, timeout=20) as response:
        return response.read()

target = pathlib.Path(sys.argv[1])
if target.parent != ROOT or target.exists():
    raise RuntimeError('Fresh owned source-audit result required')
tag_url = BASE + '+refs/tags/' + VERSION + '?format=JSON'
tag_bytes = get(tag_url)
tag = json.loads(tag_bytes.split(b'\n', 1)[1])
if tag['refs/tags/' + VERSION]['value'] != REVISION:
    raise RuntimeError('Installed version/source pin differs')
source_url = BASE + '+/' + REVISION + '/' + SOURCE_PATH
source = base64.b64decode(get(source_url + '?format=TEXT'), validate=True)
lines = source.decode().splitlines()
start = lines.index('void WebGLRenderingContextBase::finish() {')
end = next(i for i in range(start + 1, len(lines)) if lines[i] == '}')
excerpt = '\n'.join(lines[start:end + 1])
if 'ContextGL()->Flush();' not in excerpt:
    raise RuntimeError('Unexpected version-specific implementation')
plist_path = pathlib.Path('/Users/razvan-constantinbotezatu/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/Info.plist')
plist_bytes = plist_path.read_bytes()
plist = plistlib.loads(plist_bytes)
if plist['CFBundleShortVersionString'] != VERSION or not plist['SCMRevision'].startswith(REVISION):
    raise RuntimeError('Installed Chrome for Testing metadata differs')
result = {
    'kind': 'issue202-r3-chromium-completion-source-audit',
    'scriptSha256': hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
    'browserVersion': VERSION, 'chromiumRevision': REVISION,
    'tagUrl': tag_url, 'tagResponseSha256': hashlib.sha256(tag_bytes).hexdigest(),
    'sourceUrl': source_url, 'sourceBytes': len(source),
    'sourceSha256': hashlib.sha256(source).hexdigest(),
    'gitBlobSha1': hashlib.sha1(b'blob ' + str(len(source)).encode() + b'\0' + source).hexdigest(),
    'finish': {'startLine': start + 1, 'endLine': end + 1, 'excerpt': excerpt, 'callsFlush': True},
    'installedChromeForTesting': {'plistPath': str(plist_path), 'plistSha256': hashlib.sha256(plist_bytes).hexdigest(),
        'version': plist['CFBundleShortVersionString'], 'scmRevision': plist['SCMRevision']},
    'qualification': 'Run1 reports matching browser version but did not capture Browser.getVersion revision. Installed CfT metadata and exact public version tag agree. Corrected runner must capture and check runtime revision before experiments.',
    'readPixelsAuthority': 'https://registry.khronos.org/webgl/specs/latest/2.0/#3.7.12',
}
with target.open('x') as output:
    json.dump(result, output, indent=2)
    output.write('\n')
print(json.dumps(result, indent=2))
