"""Verify retained notice bytes against the previously accepted extraction receipt."""
import gzip
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[3]
EVIDENCE = ROOT / 'docs/evidence/issue201'
GENERATED = EVIDENCE / 'whispercpp-generated'


def verify(data, receipt):
    assert len(data) == receipt['bytes'], receipt['path']
    assert hashlib.sha256(data).hexdigest() == receipt['sha256'], receipt['path']


inventory = json.loads(gzip.decompress(
    (EVIDENCE / 'whispercpp-build-preparation/extraction-inventory.json.gz').read_bytes()))
sdk = next(a for a in inventory['archives'] if a['archive'] == 'wasm-binaries-arm64.tar.xz')
members = {m['path']: m for m in sdk['members']}
notices = json.loads((GENERATED / 'runtime-notices.json').read_text())
with zipfile.ZipFile(GENERATED / 'runtime-notices.zip') as archive:
    assert sorted(archive.namelist()) == sorted(r['path'] for r in notices['sources'])
    for receipt in notices['sources']:
        data = archive.read(receipt['path'])
        verify(data, receipt)
        if receipt.get('archive') == sdk['archive']:
            verify(data, members[receipt['path']])
        else:
            assert data == (EVIDENCE / 'whispercpp-preparation' / receipt['path']).read_bytes()
library_source = json.loads((GENERATED / 'system-libraries-source.json').read_text())
assert library_source['archiveSha256'] == sdk['archiveSha256']
verify(gzip.decompress((GENERATED / 'system_libs.py.gz').read_bytes()),
       members[library_source['member']['path']])
print(json.dumps({'status': 'notice-source-bytes-verified', 'noticeEntries': len(notices['sources']),
                  'libraryDefinitionSourceVerified': True, 'wasmExecuted': False}, indent=2))
