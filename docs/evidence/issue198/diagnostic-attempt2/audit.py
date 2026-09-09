"""Read-only audit of the exact immutable diagnostic's saved JSON observations."""
import collections
import datetime
import hashlib
import json
import pathlib
import sys

raw = pathlib.Path(sys.argv[1])
manifest_bytes = (raw / 'manifest.json').read_bytes()
manifest = json.loads(manifest_bytes)
assert [entry['name'] for entry in manifest] == [f'{n:05d}.json' for n in range(63)]
assert sorted(path.name for path in raw.iterdir()) == [entry['name'] for entry in manifest] + ['manifest.json']
records = []
for entry in manifest:
    data = (raw / entry['name']).read_bytes()
    assert len(data) == entry['bytes'] <= 2 * 1024 * 1024
    assert hashlib.sha256(data).hexdigest() == entry['sha256']
    records.append(json.loads(data))
assert [record['sequence'] for record in records] == list(range(63))
by_kind = collections.defaultdict(list)
for record in records:
    by_kind[record['kind']].append(record)

def one(kind):
    values = by_kind[kind]
    assert len(values) == 1, kind
    return values[0]

start = one('diagnostic-run-start')
assert start['source']['commit'] == '1ae6baedf4e9788836e566cd58541fc459d702ee'
assert start['source']['dirty'] is False
assert one('diagnostic-run-observed')['source'] == start['source']
assert one('diagnostic-run-observed')['servedMediaRequests'] == 2
assert not any('failed' in kind for kind in by_kind)
assert one('evidence-closed')['partial'] == []
teardown = one('diagnostic-run-teardown')
assert teardown['outcome'] == 'observations-collected' and teardown['error'] is None
assert teardown['alivePids'] == [] and teardown['portOpen'] is False and teardown['problems'] == []
assert all(owner['status'] == 'closed' for owner in teardown['cleanup'])
assert teardown['evidence']['fallbackReceipts'] == 0 and teardown['evidence']['partial'] is False

frames = [0, 126, 127, 128, 255, 299]
decoded = by_kind['decoded-frame']
assert len(decoded) == 24
assert len(by_kind['decode-source-released']) == 2
for release in by_kind['decode-source-released']:
    assert release['ordinalSamples'] == 300 and release['sparseSamples'] == 6
    assert release['samplesClosed'] == 306
    assert release['videoFramesOpened'] == release['videoFramesClosed'] == 12
    assert release['inputDisposed'] is True and release['surface'] == {'width': 1, 'height': 1}
    assert release['error'] is None and release['cleanupError'] is None
    times = release['ordinalSampleTimes']
    assert len(times) == 300
    for n, value in enumerate(times):
        assert value['ordinal'] == n and value['timestamp'] == n / 30
        assert value['duration'] == 1 / 30
for name in ['source', 'output']:
    for method in ['ordinal', 'sparse']:
        values = [row for row in decoded if row['name'] == name and row['method'] == method]
        assert [row['frame'] for row in values] == frames
        for row in values:
            assert row['sampleTimestamp'] == row['frame'] / 30
            assert row['sampleDuration'] == 1 / 30 and row['rgbaBytes'] == 3_686_400
            assert abs(row['videoFrameTimestampUs'] - row['frame'] * 1_000_000 / 30) < 1
parities = by_kind['ordinal-sparse-parity']
assert len(parities) == 12
for row in parities:
    assert row['exactRgbaHashMatch'] is True
    assert row['ordinalRgbaSha256'] == row['sparseRgbaSha256']
    assert row['errors']['maximumDelta'] == 0

comparisons = [row for row in records if 'errors' in row]
assert len(comparisons) == 21
for row in comparisons:
    error = row['errors']
    hist = error['histogram']
    assert len(hist) == 256 and all(isinstance(n, int) and n >= 0 for n in hist)
    assert sum(hist) == error['channels'] == 2_764_800
    assert sum(n * count for n, count in enumerate(hist)) == error['totalAbsoluteDelta']
    assert error['meanDelta'] == error['totalAbsoluteDelta'] / error['channels']
    assert max(n for n, count in enumerate(hist) if count) == error['maximumDelta']
    assert hist[error['maximumDelta']] == error['maximumCount']
    assert sum(hist[1:]) == error['nonzero'] and sum(hist[13:]) == error['above12']
    for field in ['channels', 'totalAbsoluteDelta', 'nonzero', 'above12']:
        assert sum(region[field] for region in error['regions'].values()) == error[field]
    assert max(region['maximumDelta'] for region in error['regions'].values()) == error['maximumDelta']
    assert error['coordinateLimit'] == 64
    assert len(error['firstAbove12']) == min(error['above12'], 64)
    assert len(error['maximumCoordinates']) == (min(error['maximumCount'], 64) if error['maximumDelta'] else 0)
    for coordinate in error['firstAbove12'] + error['maximumCoordinates']:
        assert 0 <= coordinate['x'] < 1280 and 0 <= coordinate['y'] < 720
        assert coordinate['channel'] in [0, 1, 2] and coordinate['region'] in error['regions']
        assert abs(coordinate['actual'] - coordinate['expected']) == coordinate['delta']
    assert error['originalTolerance'] == {'maximum': 12, 'mean': 2,
        'satisfied': error['maximumDelta'] <= 12 and error['meanDelta'] <= 2}

candidates = by_kind['frame127-candidate']
assert [(row['sourceFrame'], row['pathIndex']) for row in candidates] == [(frame, path) for frame in [126, 127, 128] for path in [0, 1]]
selection = one('production-frame127-selected')
assert selection['requestedFrames'] == list(range(128))
assert selection['sourceFrame'] == selection['actualPlan']['frame'] == 127
items = selection['actualPlan']['items']
assert len(items) == 1 and items[0]['request']['sourceFrame'] == 127
assert items[0]['request']['clip']['effects'][0]['params']['path'] == selection['expectedHeldPath']
render = one('production-composite-rendered')
assert render['actualPlan'] == selection['actualPlan']
assert render['result'] == {'drawn': ['resource-mask'], 'missing': []}
assert render['readbackColorSpaces'] == {'actualSource': 'srgb', 'unencodedOutput': 'srgb'}
production = one('production-composite-released')
assert production['resolverCalls'] == 1 and production['leasesOpened'] == production['leasesClosed'] == production['requests'] == 128
assert production['requestedFrames'] == list(range(128)) and production['composites'] == 1
assert production['mediaClosed'] is True and production['error'] is None and production['cleanupError'] is None
assert len(production['surfaces']) == 4 and all(surface == {'width': 1, 'height': 1} for surface in production['surfaces'])
assert all(production['grading'][key] == 0 for key in ['bytes', 'peakBytes', 'entries', 'pendingTasks', 'ports'])
assert production['grading']['active'] is False
input_comparison = one('production-input-vs-ordinal127')
assert input_comparison['productionInputSha256'] == input_comparison['ordinalInputSha256']
assert input_comparison['errors']['maximumDelta'] == 0
exact = one('production-unencoded-vs-matching-input-oracle')
assert exact['errors']['maximumDelta'] == 0
saved = one('saved-output-vs-production-unencoded')
assert saved['errors'] == candidates[3]['errors']
assert saved['errors']['maximumDelta'] == 19 and saved['errors']['meanDelta'] == 0.06854926215277778
assert saved['errors']['above12'] == saved['errors']['regions']['outside']['above12'] == 45
assert len({(value['x'], value['y']) for value in saved['errors']['firstAbove12']}) == 15
assert all(value['expected'] == 0 and value['region'] == 'outside' for value in saved['errors']['firstAbove12'])
work = {'ordinal': 600, 'sparse': 12, 'productionSource': 128, 'composite': 1, 'candidate': 6,
    'publicSampleAndSourceRequests': 740, 'requestLimit': 740}
assert one('diagnostic-observations-complete')['work'] == one('diagnostic-pixels-released')['work'] == work
pixels = one('diagnostic-pixels-released')['pixelOwner']
assert pixels == {'bytes': 0, 'peakBytes': 47_923_200, 'buffers': 0, 'allocations': 34, 'releases': 34, 'limitBytes': 67_108_864}

compact = lambda row: {'sequence': row['sequence'], 'kind': row['kind'], 'sourceFrame': row.get('sourceFrame'),
    'pathIndex': row.get('pathIndex'), 'maximumDelta': row['errors']['maximumDelta'], 'meanDelta': row['errors']['meanDelta'],
    'above12': row['errors']['above12'], 'regions': row['errors']['regions']}
parse = lambda value: datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
summary = {'testedSha': start['source']['commit'], 'outcome': 'diagnostic-observations-collected-export-still-failed',
    'recordsVerified': 63, 'rawBytes': sum(row['bytes'] for row in manifest),
    'manifest': {'bytes': len(manifest_bytes), 'sha256': hashlib.sha256(manifest_bytes).hexdigest()},
    'start': start['receivedAt'], 'close': one('evidence-closed')['receivedAt'],
    'recordedDurationMs': (parse(one('evidence-closed')['receivedAt']) - parse(start['receivedAt'])).total_seconds() * 1000,
    'browserCollectionMs': one('diagnostic-observations-complete')['elapsedMs'],
    'kindCounts': dict(collections.Counter(row['kind'] for row in records)), 'work': work, 'pixelOwner': pixels,
    'ordinalTimestampsVerified': 600, 'selectedVideoFramesVerified': 24, 'exactOrdinalSparseParities': 12,
    'errorAggregatesVerified': 21, 'productionLeasesOpenedClosed': 128, 'productionComposites': 1,
    'comparisons': [compact(row) for row in candidates + [input_comparison, exact, saved]],
    'savedOutputAbove12Coordinates': saved['errors']['firstAbove12'],
    'savedOutputMaximumCoordinates': saved['errors']['maximumCoordinates'],
    'sourceInputRgbaSha256': input_comparison['productionInputSha256'],
    'unencodedRgbaSha256': exact['unencodedRgbaSha256'], 'savedOutputRgbaSha256': saved['savedOutputRgbaSha256'],
    'canvasPolicies': render['policies'], 'teardown': teardown,
    'qualification': 'Audits saved observations only; no new decode/composite/encode. Exact RGB compositor parity at frame127 does not qualify the unfinished export lifecycle sequence or isolate encoder versus decoder.'}
print(json.dumps(summary, indent=2))
