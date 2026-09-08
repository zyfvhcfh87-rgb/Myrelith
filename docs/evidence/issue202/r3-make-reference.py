"""Freeze R3 working-buffer inputs/oracles before the Float32 shader exists."""
import json
import sys
from decimal import ROUND_HALF_UP
from pathlib import Path
import oracle

root = Path(__file__).resolve().parent
d = oracle.d
a = [[d(v) for v in row] for row in [
    ['0', '0', '0', '1'], ['1', '1', '1', '1'],
    ['4', '1', '.25', '.5'], ['0', '4', '1', '.25'],
    ['.5', '.25', '.125', '1'], ['8', '2', '0', '.25'],
    ['-.125', '.25', '1', '.5'], ['8', '8', '8', '0'],
]]
b = [[d(v) for v in row] for row in [
    ['1', '0', '0', '1'], ['0', '0', '1', '1'],
    ['.25', '4', '1', '.5'], ['1', '.25', '4', '1'],
    ['.125', '.5', '.25', '.25'], ['0', '.5', '4', '.5'],
    ['1', '.25', '-.125', '.25'], ['1', '1', '1', '1'],
]]
associated_a = [oracle.associated(p) for p in a]
associated_b = [oracle.associated(p) for p in b]
rows = []
for frame in [0, 1, 59, 118, 119]:
    weight = d(frame)/119
    for patch in range(8):
        working = [x*(1-weight)+y*weight for x, y in zip(associated_a[patch], associated_b[patch])]
        rows.append({'frame': frame, 'patch': patch, 'working': oracle.serialize(working),
                     'viewCode10': oracle.serialize([x*1023 for x in oracle.view(working[:3])])})


def byte(value):
    return int((value*255).to_integral_value(rounding=ROUND_HALF_UP))


payload = (json.dumps({
    'contract': 'issue202-r3-resident-dissolve-v1',
    'qualification': 'Preinterpreted linear BT2020 working buffers only. No decoder, transfer inversion, scope, lens, font, plugin, full renderer or physical display qualification.',
    'workingRepresentation': 'Associated linear BT2020 D65;1=203nits;exact binary16 input values;zero-alpha RGB zero.',
    'associatedA': oracle.serialize(associated_a), 'associatedB': oracle.serialize(associated_b),
    'legacyA': [[byte(v) for v in oracle.view(p[:3])]+[byte(p[3])] for p in a],
    'legacyB': [[byte(v) for v in oracle.view(p[:3])]+[byte(p[3])] for p in b],
    'legacyInputQualification': 'Independent SDR-view RGB swatches with8-bit alpha for the unmodified legacy compositor cost baseline; no claim of pixel equality across color versions.',
    'pattern': 'Logical top-left origin: patch=(floor(x/64)+floor(y/64))%8. Tiny qualification uses patch=x in an8x1 image.',
    'weight': 'Integer frame0..119 divided by119; complementary associated legs then frozen technical SDR view over black.',
    'rows': rows,
}, indent=2)+'\n').encode()
target = root/'r3-reference-v1.json'
if sys.argv[1:] == ['--freeze']:
    if target.exists():
        raise RuntimeError('Refusing to overwrite frozen R3 reference')
    target.write_bytes(payload)
elif sys.argv[1:] == ['--verify']:
    assert target.read_bytes() == payload
else:
    raise RuntimeError('Use --freeze or --verify')
print(json.dumps({'shaderReferenceCases': len(rows), 'bytes': len(payload)}))
