"""Extract six pinned build archives locally; never run their contents.

Only regular files, directories, and confined relative symlinks are admitted.
Every archive is hashed and fully inventoried before the output root is created.
No extractall, ownership, extended attributes, special files, or install hooks.
"""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import stat
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[3]
INPUT = ROOT / '.tmp/issue201-whispercpp-preparation'
OUTPUT = ROOT / '.tmp/issue201-whispercpp-build'
SPECS = [
    ('whisper-371b5a7.tar.gz', 'source', 'whisper.cpp-371b5a7561823ab2bb32142d2751e35e7534727b'),
    ('wasm-binaries-arm64.tar.xz', 'toolchain', 'install'),
    ('cmake-4.4.3-macos-universal.tar.gz', 'cmake', 'cmake-4.4.3-macos-universal'),
    ('ninja-1.13.2-mac.zip', 'ninja', 'ninja'),
    ('node-v24.19.0-darwin-arm64.tar.gz', 'node', 'node-v24.19.0-darwin-arm64'),
    ('python-3.13.3-0-macos-arm64.tar.gz', 'python', 'python-3.13.3-0'),
]
MAX_ENTRIES = 60000
MAX_TOTAL = 3 * 1024 ** 3
MAX_MEMBER = 256 * 1024 ** 2
CHUNK = 1024 * 1024


def digest_file(path):
    hasher = hashlib.sha256()
    with path.open('rb') as stream:
        for data in iter(lambda: stream.read(CHUNK), b''):
            hasher.update(data)
    return hasher.hexdigest()


def canonical_path(name, prefix):
    if not name or '\\' in name or '\x00' in name or len(name) > 4096:
        raise ValueError('Invalid archive path: ' + repr(name))
    parts = PurePosixPath(name).parts
    if name.startswith('/') or '..' in parts or not parts or parts[0] != prefix:
        raise ValueError('Unconfined archive path: ' + repr(name))
    canonical = posixpath.normpath(name)
    if canonical != name.rstrip('/'):
        raise ValueError('Noncanonical archive path: ' + repr(name))
    return canonical


def link_target(name, target, prefix):
    if not target or target.startswith('/') or '\\' in target or '\x00' in target:
        raise ValueError('Invalid link target: ' + repr(target))
    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), target))
    canonical_path(resolved, prefix)
    return resolved


def inventory(path, prefix):
    rows = []
    if path.suffix == '.zip':
        with zipfile.ZipFile(path) as archive:
            for member in archive.infolist():
                mode = member.external_attr >> 16
                if member.flag_bits & 1 or member.filename != 'ninja' or not stat.S_ISREG(mode):
                    raise ValueError('Unexpected ZIP member')
                rows.append(dict(path=canonical_path(member.filename, prefix), kind='file',
                                 bytes=member.file_size, mode=0o755))
    else:
        with tarfile.open(path, 'r:*') as archive:
            for member in archive:
                name = canonical_path(member.name, prefix)
                if member.isfile():
                    row = dict(path=name, kind='file', bytes=member.size,
                               mode=0o755 if member.mode & 0o111 else 0o644)
                elif member.isdir():
                    row = dict(path=name, kind='directory', bytes=0, mode=0o755)
                elif member.issym():
                    row = dict(path=name, kind='symlink', bytes=0, target=member.linkname,
                               resolved=link_target(name, member.linkname, prefix))
                else:
                    raise ValueError('Unexpected TAR member type: ' + repr(member.name))
                if row['bytes'] < 0 or row['bytes'] > MAX_MEMBER:
                    raise ValueError('Member byte limit exceeded')
                rows.append(row)
                if len(rows) > MAX_ENTRIES:
                    raise ValueError('Entry limit exceeded')
    by_name = {row['path']: row for row in rows}
    if len(by_name) != len(rows) or len({row['path'].casefold() for row in rows}) != len(rows):
        raise ValueError('Duplicate or case-folding path collision')
    for row in rows:
        for parent in PurePosixPath(row['path']).parents:
            ancestor = by_name.get(str(parent))
            if ancestor and ancestor['kind'] != 'directory':
                raise ValueError('Member below a non-directory: ' + row['path'])
        if row['kind'] == 'symlink':
            # Resolve each symlink prefix using this inventory, with cycle bound.
            pending = PurePosixPath(row['resolved']).parts
            for _ in range(64):
                for count in range(1, len(pending) + 1):
                    target_row = by_name.get('/'.join(pending[:count]))
                    if target_row and target_row['kind'] == 'symlink':
                        pending = PurePosixPath(posixpath.join(target_row['resolved'], *pending[count:])).parts
                        break
                else:
                    final = '/'.join(pending)
                    canonical_path(final, prefix)
                    if final not in by_name:
                        raise ValueError('Missing symlink target: ' + row['path'])
                    row['finalTarget'] = final
                    break
            else:
                raise ValueError('Symlink cycle/depth exceeded')
    return rows


def copy_member(stream, destination, row):
    destination.parent.mkdir(parents=True, exist_ok=True)
    remaining = row['bytes']
    hasher = hashlib.sha256()
    with destination.open('xb') as output:
        while remaining:
            data = stream.read(min(CHUNK, remaining))
            if not data:
                raise ValueError('Truncated member: ' + row['path'])
            output.write(data)
            hasher.update(data)
            remaining -= len(data)
        if stream.read(1):
            raise ValueError('Oversized member: ' + row['path'])
    destination.chmod(row['mode'])
    row['sha256'] = hasher.hexdigest()


def extract_archive(path, destination, rows):
    destination.mkdir()
    for row in rows:
        if row['kind'] == 'directory':
            (destination / row['path']).mkdir(parents=True, exist_ok=True)
    indexed = {row['path']: row for row in rows}
    if path.suffix == '.zip':
        with zipfile.ZipFile(path) as archive:
            for row in rows:
                with archive.open(row['path']) as stream:
                    copy_member(stream, destination / row['path'], row)
    else:
        with tarfile.open(path, 'r:*') as archive:
            for member in archive:
                row = indexed[member.name.rstrip('/')]
                if row['kind'] == 'file':
                    with archive.extractfile(member) as stream:
                        copy_member(stream, destination / row['path'], row)
    # Links are created only after all ordinary writes have finished.
    for row in rows:
        if row['kind'] == 'symlink':
            target = destination / row['path']
            target.parent.mkdir(parents=True, exist_ok=True)
            target.symlink_to(row['target'])
    for row in rows:
        target = destination / row['path']
        if row['kind'] == 'symlink':
            if target.resolve(strict=True) != (destination / row['finalTarget']).resolve(strict=True):
                raise ValueError('Extracted link mismatch')
        elif row['kind'] == 'file':
            if target.is_symlink() or target.stat().st_size != row['bytes'] or digest_file(target) != row['sha256']:
                raise ValueError('Extracted file mismatch')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--extract', action='store_true')
    args = parser.parse_args()
    manifest_path = ROOT / 'docs/evidence/issue201/whispercpp-preparation/assets.json'
    pins = {row['name']: row for row in json.loads(manifest_path.read_text())['archives']}
    records = []
    for name, directory, prefix in SPECS:
        path = INPUT / name
        pin = pins[name]
        if path.is_symlink() or path.stat().st_size != pin['bytes'] or digest_file(path) != pin['sha256']:
            raise ValueError('Archive hash/size mismatch: ' + name)
        rows = inventory(path, prefix)
        records.append(dict(archive=name, archiveBytes=pin['bytes'], archiveSha256=pin['sha256'],
                            directory=directory, prefix=prefix, entries=len(rows),
                            unpackedBytes=sum(row['bytes'] for row in rows), members=rows))
        print(json.dumps({key: value for key, value in records[-1].items() if key != 'members'}), flush=True)
    if sum(row['entries'] for row in records) > MAX_ENTRIES or sum(row['unpackedBytes'] for row in records) > MAX_TOTAL:
        raise ValueError('Aggregate extraction bound exceeded')
    if not args.extract:
        return
    if OUTPUT.exists() or OUTPUT.is_symlink():
        raise ValueError('Refusing existing output directory')
    OUTPUT.mkdir(mode=0o700)
    for directory in ['config', 'logs', 'tmp', 'pycache']:
        (OUTPUT / directory).mkdir()
    for record in records:
        # Rehash after full preflight and immediately before extraction.
        path = INPUT / record['archive']
        if digest_file(path) != record['archiveSha256']:
            raise ValueError('Archive changed since preflight')
        extract_archive(path, OUTPUT / record['directory'], record['members'])
        print('Extracted and rehashed: ' + record['archive'], flush=True)
    evidence = dict(status='extracted-no-contents-executed', extractorSha256=digest_file(Path(__file__)),
                    manifestSha256=digest_file(manifest_path), maxEntries=MAX_ENTRIES,
                    maxUnpackedBytes=MAX_TOTAL, maxMemberBytes=MAX_MEMBER, archives=records)
    raw = (json.dumps(evidence, indent=2) + '\n').encode()
    (OUTPUT / 'logs/extraction-inventory.json.gz').write_bytes(gzip.compress(raw, mtime=0))
    print(json.dumps(dict(status=evidence['status'], entries=sum(row['entries'] for row in records),
                         unpackedBytes=sum(row['unpackedBytes'] for row in records),
                         inventoryBytes=len(raw), inventorySha256=hashlib.sha256(raw).hexdigest())), flush=True)


if __name__ == '__main__':
    main()
