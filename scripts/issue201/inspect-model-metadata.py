# Read-only metadata probe of the pinned known ONNX files. Never decode raw tensors or execute models.
import json,hashlib,collections
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def fields(b):
 b=memoryview(b);i=0
 def varint(i):
  value=0
  for shift in range(0,70,7):
   assert i<len(b)
   n=b[i];i+=1;value|=(n&127)<<shift
   if n<128:return value,i
  raise ValueError('oversized protobuf varint')
 while i<len(b):
  tag,i=varint(i);number=tag>>3;wire=tag&7
  if wire==0:value,i=varint(i)
  elif wire==2:
   size,i=varint(i);assert size<=len(b)-i;value=b[i:i+size];i+=size
  elif wire in [1,5]:
   size=8 if wire==1 else 4;assert size<=len(b)-i;value=b[i:i+size];i+=size
  else:raise ValueError('unsupported wire')
  yield number,wire,value

def f(b,n):return [v for k,w,v in fields(b) if k==n]
def text(b):return bytes(b).decode('utf-8')
def one(b,n,default=b''):return next(iter(f(b,n)),default)
def value_info(b):
 tensor=one(one(b,2),1); shape=one(tensor,2)
 return {'name':text(one(b,1)),'type':one(tensor,1,0),'shape':[one(dim,1,None) if f(dim,1) else text(one(dim,2)) for dim in f(shape,1)]}

def graph(b,label,parents=()):
 assert len(parents) <= 8, 'Unexpected subgraph nesting'
 initializers={text(one(t,8)):t for t in f(b,5)}
 nodes=f(b,1);names=[text(one(n,4)) for n in nodes]
 assert len(nodes) <= 5000, 'Unexpected node count'
 result={'scope':label,'name':text(one(b,2)),'nodes':len(nodes),'operators':dict(collections.Counter(names)),'initializerCount':len(initializers),'inputs':[value_info(v) for v in f(b,11)],'outputs':[value_info(v) for v in f(b,12)],'scaleLocations':[]}
 scale='model.decoder.embed_tokens.weight_merged_0_scale'
 if scale in initializers:
  t=initializers[scale];result['scaleLocations'].append({'name':scale,'scope':label,'type':one(t,2,0),'rawBytes':len(one(t,9))})
 for node in nodes:
  inputs=[text(x) for x in f(node,1)]
  if scale in inputs: result['scaleLocations'].append({'node':text(one(node,3)),'operator':text(one(node,4)),'scope':label,'localInitializer':scale in initializers,'outerInitializer':any(scale in p for p in parents)})
 result['subgraphs']=[]
 for i,node in enumerate(nodes):
  for attr in f(node,5):
   for j,sub in enumerate(f(attr,6)+f(attr,11)):
    result['subgraphs'].append(graph(sub,f'{label}/{i}:{text(one(node,4))}/{text(one(attr,1))}/{j}',parents+(initializers,)))
 return result


def main():
 manifest = json.loads((ROOT/'docs/evidence/issue201/replacement-manifest.json').read_text())
 assert manifest['model']['id'] == 'Xenova/whisper-tiny'
 assert manifest['model']['revision'] == '5332fcc35e32a33b86612b9a57a89be7906102b1'
 selected = [f for f in manifest['model']['files'] if f['path'] in [
  'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx']]
 assert len(selected) == 2
 out=[]
 for entry in selected:
  p=ROOT/'.tmp/issue201-package-probe/model'/entry['path']
  assert p.stat().st_size == entry['bytes'] < 40000000
  b=p.read_bytes(); digest=hashlib.sha256(b).hexdigest(); assert digest == entry['sha256']
  out.append({'file':p.name,'bytes':len(b),'sha256':digest,'graph':graph(one(b,7),'root')})
 destination=ROOT/'.tmp/issue201-memory-source/model-graph-metadata.json'
 destination.parent.mkdir(parents=True,exist_ok=True)
 destination.write_text(json.dumps(out,indent=2)+'\n')
 print(json.dumps({'output':str(destination),'models':len(out),'qualification':'Pinned metadata only; no raw tensor decoding or model execution'}))

if __name__ == '__main__':
 main()
