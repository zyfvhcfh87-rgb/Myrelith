"""Create deterministic input data only; no expected values or candidate imports."""
import json
from pathlib import Path

root = Path(__file__).resolve().parent
cases = []


def add(name, graph, precision=False):
    cases.append({'id': name, 'input': graph, 'halfStorageComparison': precision})


def val(*items):
    return {'op': 'values', 'v': list(map(str, items))}


def src(transfer, rgb, alpha='1', white='203', primaries='2020'):
    return {'op': 'source', 'transfer': transfer, 'primaries': primaries,
            'rgb': rgb, 'white': white, 'alpha': alpha}


def assoc(graph):
    return {'op': 'associate', 'input': graph}


def over(a, b):
    return {'op': 'over', 'source': a, 'destination': b}


add('pq-nits-anchors', {'op': 'transfer', 'kind': 'pq-encode', 'v': ['0', '.0001', '.1', '1', '100', '203', '1000', '4000', '10000']})
add('pq-signal-ramp', {'op': 'transfer', 'kind': 'pq-decode', 'v': [f'{i}/1023' for i in range(1024)]})
add('srgb-decode', {'op': 'transfer', 'kind': 'srgb-decode', 'v': ['-1', '-.04045', '0', '.01', '.04045', '.04045001', '.5', '1']})
add('srgb-encode', {'op': 'transfer', 'kind': 'srgb-encode', 'v': ['-1', '-.0031308', '0', '.001', '.0031308', '.00313081', '.5', '1']})
for signal in ['0', '.5', '.50000001', '.75', '1']:
    add('hlg-neutral-'+signal, {'op': 'hlg', 'v': [signal]*3})
add('hlg-chromatic', {'op': 'hlg', 'v': ['.75', '.5', '1']})
for space in ['709', 'p3', '2020']:
    for index, rgb in enumerate([['1', '0', '0'], ['0', '1', '0'], ['0', '0', '1'], ['1', '1', '1'], ['-.2', '.4', '1.2']]):
        for target in ['709', '2020']:
            add(f'gamut-{space}-{target}-{index}', {'op': 'convert', 'from': space, 'to': target, 'v': rgb})
for transfer, primaries in [('srgb', '709'), ('srgb', 'p3'), ('bt1886', '709'), ('pq', '2020'), ('hlg', '2020')]:
    for white in ['100', '203']:
        add(f'source-{transfer}-{primaries}-{white}', src(transfer, ['1', '.5', '.1'], white=white, primaries=primaries), True)
for matrix in ['709', '2020']:
    for limited in [False, True]:
        values = range(64, 941) if limited else range(1024)
        add(f'10bit-neutral-{matrix}-{limited}', {'op': 'range', 'limited': limited, 'matrix': matrix, 'codes': [[v, 512, 512] for v in values]})
        add(f'10bit-chroma-{matrix}-{limited}', {'op': 'range', 'limited': limited, 'matrix': matrix, 'codes': [[512, 64, 960], [512, 960, 64], [64, 512, 512], [940, 512, 512]]})
bottom = assoc(src('srgb', ['.1', '.2', '.4'], primaries='709', white='100'))
for alpha in ['0', '1/1023', '.25', '.5', '1']:
    bright = assoc(val('1000/203', '.2', '.1', alpha))
    add('alpha-associate-'+alpha, bright, True)
    add('alpha-over-'+alpha, over(bright, bottom), True)
    add('alpha-unassociate-'+alpha, {'op': 'unassociate', 'input': bright}, True)
for weight in ['0', '1/4', '1/2', '3/4', '1']:
    mixed = {'op': 'dissolve', 'a': assoc(src('pq', ['.75', '.5', '.1'], alpha='.5')),
             'b': assoc(src('hlg', ['.75', '.5', '.2'], alpha='.75')), 'weight': weight}
    add('mixed-dissolve-'+weight, over(mixed, bottom), True)
    equal = {'op': 'dissolve', 'a': assoc(val('1', '1', '1', '1')), 'b': assoc(val('1', '1', '1', '1')), 'weight': weight}
    add('equal-white-dissolve-'+weight, equal, True)
for stops in ['-1', '0', '1']:
    exposure = {'op': 'exposure', 'stops': stops, 'input': assoc(val('.3', '2', '8', '.5'))}
    add('linear-exposure-'+stops, exposure, True)
    add('coverage-exposure-'+stops, {'op': 'coverage', 'amount': '.25', 'input': exposure}, True)
for coverage in ['0', '.25', '.5', '1']:
    background = assoc(src('srgb', ['.1', '.1', '.1'], alpha='.75', primaries='709'))
    outline = assoc(src('srgb', ['0', '0', '0'], alpha=coverage, primaries='709'))
    fill = assoc(src('srgb', ['1', '.5', '.2'], alpha=coverage, primaries='709'))
    add('text-fixed-coverage-'+coverage, over(fill, over(outline, over(background, bottom))), True)
for luminance in ['0', '.1', '1', '100', '152.25', '152.250001', '203', '1000', '4000', '10000']:
    add('view-neutral-'+luminance, {'op': 'view', 'input': val(*([luminance+'/203']*3))}, True)
for index, rgb in enumerate([['10', '.1', '0'], ['-.2', '2', '8'], ['0', '10', '0']]):
    add('view-gamut-'+str(index), {'op': 'view', 'input': val(*rgb)}, True)
add('scopes-pre-view-bin-edges', {'op': 'scope', 'pixels': [assoc(val(*([v+'/203']*3), '1')) for v in ['0', '99.999', '100', '100.001', '203', '1000', '4000']]}, True)
pixels = [['8', '.1', '0', '1'], ['0', '2', '0', '.5'], ['64', '0', '64', '0'], ['0', '0', '4', '1'], ['1', '1', '1', '.25'], ['2', '0', '0', '1'], ['0', '8', '0', '1'], ['0', '0', '0', '0'], ['1', '2', '3', '.5']]
for model in [['0', '0', '0', '0', '0', '1'], ['.2', '-.03', '.001', '.01', '-.02', '1']]:
    for point in [['1/6', '1/6'], ['.5', '.5'], ['5/6', '5/6'], ['0', '0'], ['1', '1']]:
        add(f'lens-{model[0]}-{point[0]}', {'op': 'lens', 'width': 3, 'height': 3, 'pixels': pixels, 'model': model, 'point': point}, True)
add('binary16-quantizer', {'op': 'half', 'v': ['0', '-0', '1', '-1', '1.00048828125', '1.00146484375', '0.0000000298023223876953125', '0.000000059604644775390625', '.00006103515625', '.000060', '49.2610837438', '-64', '64', '65504']})
assert len({c['id'] for c in cases}) == len(cases)
target = root/'inputs-v1.json'
payload = json.dumps({'contract': 'issue202-numerical-v1', 'cases': cases}, separators=(',', ':'))+'\n'
if target.exists():
    assert target.read_text() == payload, 'Refusing to change frozen inputs'
else:
    target.write_text(payload)
print(json.dumps({'cases': len(cases), 'bytes': len(payload)}))
