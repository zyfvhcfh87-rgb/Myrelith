from pathlib import Path
import json, hashlib, collections, itertools, math, datetime

root = Path('/Users/razvan-constantinbotezatu/Documents/Codex/Myrelith/.worktrees/issue198')
path = root / '.tmp/issue198-52a64ba-raster-attempt1'
manifest_bytes = (path / 'manifest.json').read_bytes()
manifest = json.loads(manifest_bytes)
assert {p.name for p in path.iterdir()} == {item['name'] for item in manifest} | {'manifest.json'}
for item in manifest:
    raw = (path / item['name']).read_bytes()
    assert len(raw) == item['bytes'] and hashlib.sha256(raw).hexdigest() == item['sha256'], item['name']
records = [json.loads((path / item['name']).read_text()) for item in manifest]
assert [r['sequence'] for r in records] == list(range(len(records)))
by_kind = collections.defaultdict(list)
for r in records:
    by_kind[r['kind']].append(r)
counts = {key: len(value) for key, value in by_kind.items()}
for kind, expected in {'cell-dispatched': 180, 'cell-start': 180, 'raster-trial': 1080, 'raster-parity': 540,
                       'cell-complete': 180, 'cell-released': 180, 'held-selection': 1, 'segment-complete': 1,
                       'run-teardown': 1, 'evidence-closed': 1}.items():
    assert counts[kind] == expected, (kind, counts[kind])
assert not any('fail' in kind for kind in counts)
fields = ['width', 'height', 'shape', 'feather', 'invert', 'offCanvas']
def key(cell):
    return tuple(cell[f] for f in fields)
expected_cells = {(w, h, shape, feather, invert, off) for (w, h), shape, feather, invert, off in itertools.product(
    [(1280, 720), (1920, 1080), (3840, 2160)], ['rectangle', 'ellipse', 1, 4, 8], [0, .05, 1], [False, True], [False, True])}
assert {key(r['cell']) for r in by_kind['cell-complete']} == expected_cells
trials_by_cell, parity_by_cell = collections.defaultdict(list), collections.defaultdict(list)
for r in by_kind['raster-trial']:
    assert math.isfinite(r['milliseconds']) and r['milliseconds'] >= 0
    if r['cell']['width'] == 3840:
        assert r['milliseconds'] <= 10000
    trials_by_cell[key(r['cell'])].append(r)
for r in by_kind['raster-parity']:
    assert r['comparedBytes'] == r['cell']['width'] * r['cell']['height'] * 4
    assert r['mismatches'] == r['maximumChannelDelta'] == 0 and r['firstMismatch'] is None
    parity_by_cell[key(r['cell'])].append(r)
for r in by_kind['cell-complete']:
    raw = trials_by_cell[key(r['cell'])]
    assert len(raw) == 6 and [t['order'] for t in raw] == list(range(6))
    assert [(t['frame'], t['held']) for t in raw] == [(0, False), (0, True), (127, True), (127, False), (255, False), (255, True)]
    assert [{f: trial[f] for f in r['trials'][i]} for i, trial in enumerate(raw)] == r['trials']
    assert [p['frame'] for p in parity_by_cell[key(r['cell'])]] == [0, 127, 255]
    for variant in r['perVariant']:
        times = sorted(t['milliseconds'] for t in raw if t['held'] == variant['held'])
        assert variant['samples'] == 3 and variant['p50'] == times[1] and variant['p95'] == times[2]
for r in by_kind['cell-start']:
    assert r['keyCount'] == 256 and [v['frame'] for v in r['selections']] == list(range(256))
    paths = [v['path'] for v in r['selections']]
    if isinstance(r['cell']['shape'], int):
        assert paths[0] != paths[1] and all(p == paths[i % 2] for i, p in enumerate(paths))
        assert all(p.count(' C ') == r['cell']['shape'] for p in paths)
    else:
        assert len(set(paths)) == 1
assert all(r['retainedInputBytes'] == 0 for r in by_kind['cell-released'])
held = by_kind['held-selection'][0]
times = held['milliseconds']
assert held['calls'] == len(times) == 5000 and held['warmups'] == 1000
assert all(math.isfinite(v) and v >= 0 for v in times)
assert held['p95'] == sorted(times)[math.ceil(len(times) * .95) - 1] and held['p95'] < 1
start, end, complete = (by_kind[k][0] for k in ['run-start', 'run-teardown', 'segment-complete'])
assert start['source'] == complete['source'] and not start['source']['dirty']
assert end['outcome'] == 'segment-complete' and not any(end[k] for k in ['error', 'problems', 'alivePids', 'portOpen'])
assert all(r['status'] == 'closed' for r in end['cleanup'])
assert not by_kind['evidence-closed'][0]['partial']
ns = by_kind['native-memory-sample']
assert all(r['result']['status'] == 'measured' for r in ns)
peak = max(ns, key=lambda r: r['result']['sample']['totalBytes'])
worst = max(by_kind['raster-trial'], key=lambda r: r['milliseconds'])
by_resolution = []
for width, height in [(1280, 720), (1920, 1080), (3840, 2160)]:
    group = [r for r in by_kind['raster-trial'] if r['cell']['width'] == width]
    p = max(group, key=lambda r: r['milliseconds'])
    by_resolution.append({'width': width, 'height': height, 'cells': len(group) // 6, 'calls': len(group),
                          'slowestMs': p['milliseconds'], 'slowestCell': p['cell'], 'slowestHeld': p['held'], 'slowestFrame': p['frame']})
provenance = by_kind['browser-provenance'][0]
cleanup = json.loads((root / '.tmp/issue198-52a64ba-raster-attempt1-cleanup.json').read_text())
def instant(value):
    return datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
summary = {
    'verifiedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'source': start['source'], 'directory': str(path),
    'outcome': 'passed-scoped-raster-segment',
    'manifest': {'sha256': hashlib.sha256(manifest_bytes).hexdigest(), 'bytes': len(manifest_bytes),
                 'entries': len(manifest), 'verifiedFileBytes': sum(item['bytes'] for item in manifest)},
    'counts': counts, 'canonicalSelections': sum(len(r['selections']) for r in by_kind['cell-start']),
    'rgbaBytesCompared': sum(r['comparedBytes'] for r in by_kind['raster-parity']),
    'startedAt': start['receivedAt'], 'endedAt': end['receivedAt'],
    'durationSeconds': (instant(end['receivedAt']) - instant(start['receivedAt'])).total_seconds(),
    'byResolution': by_resolution, 'slowestTrial': worst,
    'heldSelection': {k: v for k, v in held.items() if k != 'milliseconds'},
    'maxActualMaskScratchBytes': max(r['metrics']['ownedScratchBytesPeak'] for r in by_kind['raster-trial']),
    'maxHarnessInputBytes': max(r['harnessOwnedBufferBytes'] for r in by_kind['cell-complete']),
    'nativeMemory': {'sampleCount': len(ns), 'unavailableCount': 0,
                     'baselineRssBytes': ns[0]['result']['sample']['totalBytes'],
                     'sampledPeakRssBytes': peak['result']['sample']['totalBytes'], 'sampledPeakSequence': peak['sequence'],
                     'finalRssBytes': ns[-1]['result']['sample']['totalBytes'], 'exactAllocationPeakProven': False},
    'provenance': {'chromium': provenance['version'], 'gpuMode': provenance['gpu']['acceleration']['mode'],
                   'renderer': provenance['gpu']['renderer']['value'], 'crossOriginIsolated': provenance['browser']['crossOriginIsolated'],
                   'timerMinimumMs': provenance['browser']['timerMinimumMs']},
    'cleanup': cleanup,
    'limits': ['Raster and canonical held resolver only; no production export or renderer-admission native exercise.',
               'Three samples per variant: p95 equals maximum, not stable tail latency.',
               'Timer granularity about 0.1 ms; zero-valued resolver samples are quantized, not free operations.',
               'Summed sampled process RSS is not exact allocation peak, a native leak result or the 256 MiB logical render allowance.',
               'Software headless Chromium provenance does not establish hardware playback performance.'],
}
out = root / '.tmp/issue198-52a64ba-raster-attempt1-audit.json'
with out.open('x') as f:
    json.dump(summary, f, indent=2)
    f.write('\n')
print(json.dumps({k: v for k, v in summary.items() if k not in ['cleanup', 'slowestTrial']}, indent=2))
