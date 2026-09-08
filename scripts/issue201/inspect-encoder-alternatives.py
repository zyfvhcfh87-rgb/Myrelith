# Read-only comparison of exact published encoder bytes. No tensor decoding or inference.
import collections, hashlib, json, re, runpy, struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
reader = runpy.run_path(str(Path(__file__).with_name('inspect-model-metadata.py')), run_name='issue201_metadata')
fields, values, one, text, graph = (reader[k] for k in ['fields', 'f', 'one', 'text', 'graph'])
SCRATCH = ROOT / '.tmp/issue201-model-alternatives'
MODELS = [
 ('current', ROOT / '.tmp/issue201-package-probe/model/onnx/encoder_model_quantized.onnx', 10124910, 'fd9d995b9dcb0520f0dbf6cf68651af639fc385f594d9d876e69ca2802dc438e'),
 ('uint8', SCRATCH / 'encoder_model_uint8.onnx', 10079602, '40df112bf7fa198a05f802c67a1b98e19b9287cf008de4496df51338e3f2cb47'),
 ('july2023', SCRATCH / 'encoder-2023-07.onnx', 10113248, 'ca9d7bb2836193704b7e2435e3bbadbed985ac3a79ab7406b244b8865ab1a5c0'),
]


def initializer_content(tensor):
 # Ignore only the generated initializer name. Retain exact type, dimensions,
 # encoded payload, scale/zero-point values and every other TensorProto field.
 content = [(n, w, bytes(v).hex() if w != 0 else v) for n, w, v in fields(tensor) if n != 8]
 return hashlib.sha256(json.dumps(content, separators=(',', ':')).encode()).hexdigest()


def core_wiring(g, historical):
 nodes = values(g, 1)
 producers = {text(v): (node, i) for node in nodes for i, v in enumerate(values(node, 2))}
 tensors = {text(one(t, 8)): initializer_content(t) for t in values(g, 5)}
 def canonical(name):
  # Four downstream view/quantizer names shifted by two in the attention export.
  return re.sub(r'(/layers\.[0-3]/self_attn/Reshape_)([67])(?=_output|$)',
   lambda m: m[1] + str(int(m[2]) + 2), name) if historical else name
 def token(name, depth=0):
  assert depth < 8
  if name in tensors: return 'initializer:' + tensors[name]
  if name not in producers: return 'input:' + name
  node, i = producers[name]; op = text(one(node, 4)); node_name = text(one(node, 3))
  # Only the eight additional current views are bypassed for this diagnostic.
  # All original 34 Reshapes and all Transposes remain named input producers.
  if not historical and op == 'Reshape' and re.fullmatch(r'/layers\.[0-3]/self_attn/Reshape_[67]', node_name):
   return token(text(values(node, 1)[0]), depth+1)
  if op == 'Constant':
   hashes = [initializer_content(t) for attr in values(node, 5) for t in values(attr, 5)]
   return 'constant:' + json.dumps(hashes)
  return 'node:' + canonical(node_name) + '|' + op + '|output' + str(i)
 result = {}
 for node in nodes:
  op = text(one(node, 4))
  if op in ['Constant', 'Reshape', 'Shape', 'Gather', 'Unsqueeze', 'Concat']: continue
  key = canonical(text(one(node, 3))) + '|' + op
  assert key not in result
  result[key] = {'attributeSha256': hashlib.sha256(b''.join(bytes(a) for a in values(node, 5))).hexdigest(),
   'inputs': [token(text(v)) for v in values(node, 1)]}
 return result


def original_view_wiring(g, historical):
 nodes = values(g, 1)
 producers = {text(v): (node, i) for node in nodes for i, v in enumerate(values(node, 2))}
 tensors = {text(one(t, 8)): initializer_content(t) for t in values(g, 5)}
 def canonical(name):
  return re.sub(r'(/layers\.[0-3]/self_attn/Reshape_)([67])(?=_output|$)',
   lambda m: m[1] + str(int(m[2]) + 2), name) if historical else name
 def origin(value):
  if value in tensors: return 'initializer:' + tensors[value]
  if value not in producers: return 'input:' + value
  node, i = producers[value]
  return canonical(text(one(node, 3))) + '|' + text(one(node, 4)) + '|output' + str(i)
 def shape(value, depth=0):
  assert depth < 16
  if value in tensors: return 'initializer:' + tensors[value]
  node, _ = producers[value]; op = text(one(node, 4))
  if op == 'Constant': return ['constant', [initializer_content(t) for a in values(node, 5) for t in values(a, 5)]]
  attrs = [bytes(a).hex() for a in values(node, 5)]
  if op == 'Shape': return [op, attrs, [origin(text(v)) for v in values(node, 1)]]
  assert op in ['Gather', 'Unsqueeze', 'Concat', 'Mul']
  return [op, attrs, [shape(text(v), depth+1) for v in values(node, 1)]]
 result = {}
 for node in nodes:
  name = text(one(node, 3))
  if text(one(node, 4)) != 'Reshape': continue
  if not historical and re.fullmatch(r'/layers\.[0-3]/self_attn/Reshape_[67]', name): continue
  result.setdefault(canonical(name), []).append({'dataInput': origin(text(values(node, 1)[0])),
   'attributeSha256': hashlib.sha256(b''.join(bytes(a) for a in values(node, 5))).hexdigest(),
   'targetShape': shape(text(values(node, 1)[1]))})
 for rows in result.values(): rows.sort(key=lambda x: json.dumps(x, sort_keys=True))
 return result


def added_view_shapes(g):
 nodes = values(g, 1); producers = {text(v): n for n in nodes for v in values(n, 2)}
 def describe(value, depth=0):
  assert depth < 12
  node = producers.get(value)
  if node is None: return {'external': value}
  op = text(one(node, 4)); inputs = [text(v) for v in values(node, 1)]
  row = {'op': op, 'name': text(one(node, 3))}
  if op == 'Shape': row['shapeOf'] = inputs; return row
  if op == 'Constant':
   tensor = one(values(node, 5)[0], 5); raw = one(tensor, 9)
   assert one(tensor, 2, 0) == 7 and 0 < len(raw) <= 64 and len(raw) % 8 == 0
   row['int64ShapeConstant'] = list(struct.unpack('<' + 'q' * (len(raw)//8), raw))
   return row
  assert op in ['Gather', 'Unsqueeze', 'Concat', 'Mul']
  row['attributesHex'] = [bytes(a).hex() for a in values(node, 5)]
  row['inputs'] = [describe(v, depth+1) for v in inputs]
  return row
 result = []
 for layer in range(4):
  for view in [6, 7]:
   name = f'/layers.{layer}/self_attn/Reshape_{view}'
   node = next(n for n in nodes if text(one(n, 3)) == name)
   result.append({'name': name, 'dataInput': text(values(node, 1)[0]), 'shape': describe(text(values(node, 1)[1]))})
 return result


def main():
 models, initializers, roles, wiring, views = {}, {}, {}, {}, {}
 shapes = None
 for label, path, size, digest in MODELS:
  assert path.stat().st_size == size < 11000000
  data = path.read_bytes()
  assert hashlib.sha256(data).hexdigest() == digest
  g = one(data, 7)
  if label != 'uint8':
   wiring[label] = core_wiring(g, label == 'july2023')
   views[label] = original_view_wiring(g, label == 'july2023')
  if label == 'current': shapes = added_view_shapes(g)
  models[label] = {'bytes': size, 'sha256': digest, 'ir': one(data, 1, 0),
   'producer': text(one(data, 2)), 'producerVersion': text(one(data, 3)),
   'opsets': [{'domain': text(one(x, 1)), 'version': one(x, 2, 0)} for x in values(data, 8)], 'graph': graph(g, 'root')}
  initializers[label] = {text(one(t, 8)): initializer_content(t) for t in values(g, 5)}
  roles[label] = {}
  for node in values(g, 1):
   for i, raw_name in enumerate(values(node, 1)):
    name = text(raw_name)
    if name in initializers[label]:
     key = text(one(node, 3)) + '|' + text(one(node, 4)) + '|input' + str(i)
     roles[label].setdefault(key, []).append(initializers[label][name])
  for hashes in roles[label].values(): hashes.sort()
 a, b = (collections.Counter(initializers[label].values()) for label in ['july2023', 'current'])
 all_roles = set(roles['july2023']) | set(roles['current'])
 equal_roles = sorted(k for k in all_roles if roles['july2023'].get(k) == roles['current'].get(k))
 comparison = {'identicalInitializerContentMultisets': a == b, 'oldInitializerCount': len(initializers['july2023']),
  'currentInitializerCount': len(initializers['current']), 'oldUnmatched': sorted((a-b).elements()),
  'currentUnmatched': sorted((b-a).elements()), 'equalNamedInputRoles': len(equal_roles),
  'differentNamedInputRoles': sorted(all_roles - set(equal_roles)),
  'roleOccurrences': sum(len(x) for x in roles['current'].values()),
  'roleContentHashes': {k: roles['current'][k] for k in equal_roles}}
 assert comparison['identicalInitializerContentMultisets'] and comparison['oldInitializerCount'] == comparison['currentInitializerCount'] == 121
 assert len(equal_roles) == 119 and not comparison['differentNamedInputRoles']
 assert wiring['current'] == wiring['july2023'] and len(wiring['current']) == 305
 assert views['current'] == views['july2023'] and sum(len(v) for v in views['current'].values()) == 34
 result = {'qualification': 'Published bytes and metadata only. Reads bounded int64 shape constants; no weight decoding, graph patching or inference. View-normalized structural comparison is not numerical execution proof.',
  'currentRevision': '5332fcc35e32a33b86612b9a57a89be7906102b1', 'historicalRevision': 'ce70c25689c3694faf5ec8206517cd53f0cfb03f',
  'models': models, 'comparison': comparison,
  'coreWiringComparison': {'equalAfterDocumentedViewNormalization': True, 'coreOperators': 305, 'ignoredCurrentViews': 8, 'originalViewTargetsAndInputsEqual': 34,
   'qualification': 'Only current self_attn Reshape_6/_7 views are bypassed. Old downstream Reshape_6/_7 names map to current _8/_9. All original views, transposes, core attributes, quantizer output slots and initializer contents remain in comparison.'},
  'addedCurrentViewShapeMetadata': shapes}
 destination = SCRATCH / 'encoder-alternative-comparison.json'
 destination.write_text(json.dumps(result, indent=2) + '\n')
 print(json.dumps({'output': str(destination), 'models': len(models), 'identicalInitializers': 121, 'identicalNamedRoles': 119, 'inference': False}))


if __name__ == '__main__':
 main()
