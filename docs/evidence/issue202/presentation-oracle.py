"""Freeze independent 10-bit presentation values before candidate comparison."""
import json
from pathlib import Path
import sys
import oracle

root = Path(__file__).resolve().parent
inputs = json.loads((root/'inputs-v1.json').read_text())
rows = []
for case in inputs['cases']:
    if not case['halfStorageComparison'] or case['input']['op'] == 'scope':
        continue
    value = oracle.evaluate(case['input'])
    op = case['input']['op']
    if op == 'lens':
        rgb, alpha = value['associated'][:3], value['associated'][3]
    elif op == 'view':
        rows.append({'id': case['id'], 'code10': oracle.serialize([v*1023 for v in value]), 'alpha': '1'})
        continue
    else:
        if op in ['source', 'unassociate']:
            value = oracle.associated(value)
        rgb, alpha = value[:3], value[3]
    rows.append({'id': case['id'], 'code10': oracle.serialize([v*1023 for v in oracle.view(rgb)]),
                 'alpha': oracle.serialize(alpha)})
payload = (json.dumps({'contract': 'issue202-numerical-v1', 'rows': rows}, indent=2)+'\n').encode()
target = root/'presentations-v1.json'
if sys.argv[1:] == ['--freeze']:
    if target.exists():
        raise RuntimeError('Refusing to overwrite frozen presentation oracle')
    target.write_bytes(payload)
elif sys.argv[1:] == ['--verify']:
    assert target.read_bytes() == payload
else:
    raise RuntimeError('Use --freeze or --verify')
print(json.dumps({'presentationCases': len(rows)}))
