"""Independent Decimal reference. No candidate or production imports.

Run explicitly: DEVELOPER_DIR=/Library/Developer/CommandLineTools
  /usr/bin/python3 docs/evidence/issue202/oracle.py --freeze
--verify reproduces bytes in memory and never rewrites the frozen fixtures.
"""
import hashlib
import json
from decimal import Decimal, getcontext, ROUND_FLOOR
from fractions import Fraction
from pathlib import Path
import struct
import sys

getcontext().prec = 60
ROOT = Path(__file__).resolve().parent


def d(value):
    text = str(value)
    if '/' in text:
        a, b = text.split('/')
        return Decimal(a) / Decimal(b)
    return Decimal(text)


Z, O = d(0), d(1)
KR, KG, KB = d('.2627'), d('.6780'), d('.0593')


def solve(matrix, vector):
    rows = [list(row) + [value] for row, value in zip(matrix, vector)]
    for col in range(3):
        pivot = max(range(col, 3), key=lambda k: abs(rows[k][col]))
        rows[col], rows[pivot] = rows[pivot], rows[col]
        divisor = rows[col][col]
        rows[col] = [v / divisor for v in rows[col]]
        for row in range(3):
            if row != col:
                factor = rows[row][col]
                rows[row] = [v - factor * p for v, p in zip(rows[row], rows[col])]
    return [row[3] for row in rows]


def matrix_for(space):
    coords = {
        '709': [('0.64', '.33'), ('.30', '.60'), ('.15', '.06')],
        'p3': [('.68', '.32'), ('.265', '.69'), ('.15', '.06')],
        '2020': [('.708', '.292'), ('.170', '.797'), ('.131', '.046')],
    }[space]
    columns = [[d(x) / d(y), O, (O - d(x) - d(y)) / d(y)] for x, y in coords]
    unscaled = [list(row) for row in zip(*columns)]
    white = [d('.3127') / d('.329'), O, (O-d('.3127')-d('.329'))/d('.329')]
    scale = solve(unscaled, white)
    return [[v * scale[col] for col, v in enumerate(row)] for row in unscaled]


MATRICES = {space: matrix_for(space) for space in ['709', 'p3', '2020']}


def convert(rgb, source, target):
    if source == target:
        return list(rgb)
    xyz = [sum(v * c for v, c in zip(row, rgb)) for row in MATRICES[source]]
    return solve(MATRICES[target], xyz)


def srgb_decode(x):
    if abs(x) <= d('.04045'):
        return x / d('12.92')
    return (-O if x < 0 else O) * ((abs(x) + d('.055')) / d('1.055')) ** d('2.4')


def srgb_encode(x):
    if abs(x) <= d('.0031308'):
        return x * d('12.92')
    return (-O if x < 0 else O) * (d('1.055') * abs(x) ** (O/d('2.4')) - d('.055'))


def pq_decode(x):
    q = x ** d('32/2523')
    ratio = max(Z, q-d('3424/4096')) / (d('2413/128')-d('2392/128')*q)
    return d(10000) * ratio ** d('16384/2610')


def pq_encode(nits):
    p = (nits/d(10000)) ** d('2610/16384')
    return ((d('3424/4096')+d('2413/128')*p)/(O+d('2392/128')*p)) ** d('2523/32')


def hlg_decode(rgb):
    a = d('.17883277')
    b = O - 4*a
    c = d('.5') - a*(4*a).ln()
    scene = [v*v/3 if v <= d('.5') else (((v-c)/a).exp()+b)/12 for v in rgb]
    luminance = sum(c*v for c, v in zip([KR, KG, KB], scene))
    gain = d(1000) * luminance ** d('.2') if luminance else Z
    return [v*gain for v in scene]


def source(node):
    rgb = list(map(d, node['rgb']))
    transfer = node['transfer']
    if transfer == 'pq':
        linear = [pq_decode(v)/203 for v in rgb]
    elif transfer == 'hlg':
        linear = [v/203 for v in hlg_decode(rgb)]
    else:
        white = d(node['white'])/203
        linear = [(srgb_decode(v) if transfer == 'srgb' else v**d('2.4'))*white for v in rgb]
    return convert(linear, node['primaries'], '2020') + [d(node.get('alpha', '1'))]


def associated(pixel):
    return [v*pixel[3] for v in pixel[:3]] + [pixel[3]]


def unassociated(pixel):
    return [v/pixel[3] for v in pixel[:3]] + [pixel[3]] if pixel[3] else [Z]*4


def view(rgb):
    y = sum(c*v for c, v in zip([KR, KG, KB], rgb))
    mapped = max(Z, y) if y <= d('.75') else d('.75')+d('.25')*(y-d('.75'))/(y-d('.5'))
    compressed = [v*mapped/y for v in rgb] if y > 0 else [Z]*3
    return [srgb_encode(min(O, max(Z, v))) for v in convert(compressed, '2020', '709')]


def lens(node):
    width, height = node['width'], node['height']
    out_x, out_y = map(d, node['point'])
    x, y = out_x-d('.5'), out_y-d('.5')
    r2 = x*x+y*y
    k1, k2, k3, p1, p2, strength = map(d, node['model'])
    radial = O + k1*r2+k2*r2*r2+k3*r2*r2*r2
    dx = x*radial+2*p1*x*y+p2*(r2+2*x*x)
    dy = y*radial+p1*(r2+2*y*y)+2*p2*x*y
    sx = (d('.5')+x+(dx-x)*strength)*width-d('.5')
    sy = (d('.5')+y+(dy-y)*strength)*height-d('.5')
    ix, iy = int(sx.to_integral_value(rounding=ROUND_FLOOR)), int(sy.to_integral_value(rounding=ROUND_FLOOR))
    fx, fy = sx-ix, sy-iy
    result = [Z]*4
    for ox, oy, weight in [(0, 0, (O-fx)*(O-fy)), (1, 0, fx*(O-fy)), (0, 1, (O-fx)*fy), (1, 1, fx*fy)]:
        px, py = ix+ox, iy+oy
        if 0 <= px < width and 0 <= py < height:
            sample = associated(list(map(d, node['pixels'][py*width+px])))
            result = [a+weight*b for a, b in zip(result, sample)]
    return {'coordinate': [sx, sy], 'associated': result}


def exact_scope_pixel(node):
    # Discrete threshold fixtures use rational arithmetic, not a rounded
    # Decimal value infinitesimally below its mathematically exact bin edge.
    if node['op'] == 'values':
        def fraction(value):
            if '/' in value:
                a, b = value.split('/')
                return Fraction(a) / Fraction(b)
            return Fraction(value)
        return list(map(fraction, node['v']))
    if node['op'] == 'associate':
        p = exact_scope_pixel(node['input'])
        return [v*p[3] for v in p[:3]] + [p[3]]
    raise ValueError('Exact scope fixture requires rational values/association')


def evaluate(node):
    op = node['op']
    if op == 'values':
        return list(map(d, node['v']))
    if op == 'transfer':
        f = {'pq-decode': pq_decode, 'pq-encode': pq_encode,
             'srgb-decode': srgb_decode, 'srgb-encode': srgb_encode}[node['kind']]
        return [f(d(v)) for v in node['v']]
    if op == 'hlg':
        return hlg_decode(list(map(d, node['v'])))
    if op == 'source':
        return source(node)
    if op == 'convert':
        return convert(list(map(d, node['v'])), node['from'], node['to'])
    if op == 'associate':
        return associated(evaluate(node['input']))
    if op == 'unassociate':
        return unassociated(evaluate(node['input']))
    if op == 'over':
        src, dst = evaluate(node['source']), evaluate(node['destination'])
        return [s+t*(O-src[3]) for s, t in zip(src, dst)]
    if op == 'dissolve':
        a, b, w = evaluate(node['a']), evaluate(node['b']), d(node['weight'])
        return [(O-w)*x+w*y for x, y in zip(a, b)]
    if op == 'exposure':
        p = evaluate(node['input'])
        return [v*d(2)**d(node['stops']) for v in p[:3]] + [p[3]]
    if op == 'coverage':
        return [v*d(node['amount']) for v in evaluate(node['input'])]
    if op == 'view':
        return view(evaluate(node['input'])[:3])
    if op == 'scope':
        pixels = [exact_scope_pixel(p) for p in node['pixels']]
        exact_nits = [203*sum(c*v for c, v in zip(map(Fraction, ['.2627', '.6780', '.0593']), p[:3])) for p in pixels]
        bins = [0]*11
        for v in exact_nits:
            bins[min(10, max(0, v)//100)] += 1
        nits = [d(v.numerator)/d(v.denominator) for v in exact_nits]
        return {'nits': nits, 'peak': max(nits), 'bins': bins}
    if op == 'range':
        kr, kb = (d('.2126'), d('.0722')) if node['matrix'] == '709' else (KR, KB)
        result = []
        for y, cb, cr in node['codes']:
            y = (d(y)-(64 if node['limited'] else 0))/(876 if node['limited'] else 1023)
            cb, cr = [(d(v)-512)/(896 if node['limited'] else 1023) for v in [cb, cr]]
            red, blue = y+2*(1-kr)*cr, y+2*(1-kb)*cb
            result.append([red, (y-kr*red-kb*blue)/(1-kr-kb), blue])
        return result
    if op == 'lens':
        return lens(node)
    if op == 'half':
        return [Decimal.from_float(struct.unpack('<e', struct.pack('<e', float(d(v))))[0]) for v in node['v']]
    raise ValueError('Unknown reference operation: '+op)


def serialize(value):
    if isinstance(value, Decimal):
        return str(value) if value else '0'
    if isinstance(value, list):
        return [serialize(v) for v in value]
    if isinstance(value, dict):
        return {k: serialize(v) for k, v in value.items()}
    return value


def check_anchors():
    assert pq_decode(Z) == 0 and pq_decode(O) == 10000
    assert srgb_decode(O) == 1 and srgb_encode(O) == 1
    assert associated([d(64), d(-64), O, Z]) == [Z]*4
    # Independently published CSS Color 4 matrix entries, not candidate output.
    assert abs(MATRICES['709'][0][0]-d('506752/1228815')) < d('1e-55')
    assert abs(MATRICES['p3'][0][0]-d('608311/1250200')) < d('1e-55')
    # Numerical anchors are deliberately loose published-scale cross-checks.
    assert abs(pq_encode(d(100))-d('.508078421517')) < d('1e-12')
    assert abs(hlg_decode([d('.75')]*3)[0]-d('203.1521459')) < d('.0001')


def main():
    check_anchors()
    inputs = json.loads((ROOT/'inputs-v1.json').read_text())
    result = {'contract': 'issue202-numerical-v1', 'precisionDigits': 60,
              'results': [{'id': c['id'], 'expected': serialize(evaluate(c['input']))} for c in inputs['cases']]}
    encoded = (json.dumps(result, indent=2, allow_nan=False)+'\n').encode()
    target = ROOT/'goldens-v1.json'
    if sys.argv[1:] == ['--freeze']:
        if target.exists():
            raise RuntimeError('Refusing to overwrite frozen goldens; use a new version after review.')
        target.write_bytes(encoded)
    elif sys.argv[1:] == ['--verify']:
        assert target.read_bytes() == encoded, 'Frozen oracle bytes differ'
    else:
        raise RuntimeError('Use --freeze or --verify')
    print(json.dumps({'cases': len(inputs['cases']), 'bytes': len(encoded),
                      'sha256': hashlib.sha256(encoded).hexdigest(), 'anchors': 'pass'}))


if __name__ == '__main__':
    main()
