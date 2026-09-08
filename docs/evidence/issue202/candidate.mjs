// Disposable numerical candidate. No production imports, browser resources or goldens.
const n = value => {
  const parts = String(value).split('/').map(Number);
  return parts.length === 1 ? parts[0] : parts[0] / parts[1];
};
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const mul = (matrix, vector) => matrix.map(row => dot(row, vector));

function inverse(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const co = [[e*i-f*h, c*h-b*i, b*f-c*e], [f*g-d*i, a*i-c*g, c*d-a*f], [d*h-e*g, b*g-a*h, a*e-b*d]];
  const determinant = a*co[0][0] + b*co[1][0] + c*co[2][0];
  return co.map(row => row.map(v => v / determinant));
}

function matrix(space) {
  const primaries = {
    '709': [[.64, .33], [.3, .6], [.15, .06]],
    p3: [[.68, .32], [.265, .69], [.15, .06]],
    '2020': [[.708, .292], [.17, .797], [.131, .046]],
  }[space];
  if (!primaries) throw new Error('unsupported-primaries');
  const columns = primaries.map(([x, y]) => [x/y, 1, (1-x-y)/y]);
  const unscaled = [0, 1, 2].map(row => columns.map(column => column[row]));
  const white = [.3127/.329, 1, (1-.3127-.329)/.329];
  const scale = mul(inverse(unscaled), white);
  return unscaled.map(row => row.map((v, col) => v * scale[col]));
}

const matrices = Object.fromEntries(['709', 'p3', '2020'].map(space => [space, matrix(space)]));
const inverseMatrices = Object.fromEntries(Object.entries(matrices).map(([space, m]) => [space, inverse(m)]));
const luma = [.2627, .678, .0593];
export function convert(rgb, source, target) {
  if (!(source in matrices) || !(target in matrices)) throw new Error('unsupported-primaries');
  return source === target ? [...rgb] : mul(inverseMatrices[target], mul(matrices[source], rgb));
}
export const srgbDecode = x => Math.abs(x) <= .04045 ? x/12.92 : Math.sign(x)*((Math.abs(x)+.055)/1.055)**2.4;
export const srgbEncode = x => Math.abs(x) <= .0031308 ? x*12.92 : Math.sign(x)*(1.055*Math.abs(x)**(1/2.4)-.055);
export function pqDecode(x) {
  if (!Number.isFinite(x) || x < 0 || x > 1) throw new Error('invalid-pq-signal');
  const q = x**(1/(2523/32));
  return 10000*(Math.max(q-3424/4096, 0)/(2413/128-2392/128*q))**(1/(2610/16384));
}
export function pqEncode(x) {
  if (!Number.isFinite(x) || x < 0 || x > 10000) throw new Error('invalid-pq-nits');
  const q = (x/10000)**(2610/16384);
  return ((3424/4096+2413/128*q)/(1+2392/128*q))**(2523/32);
}
export function hlgDecode(rgb) {
  if (rgb.length !== 3 || rgb.some(v => !Number.isFinite(v) || v < 0 || v > 1)) throw new Error('invalid-hlg-signal');
  const a = .17883277, b = 1-4*a, c = .5-a*Math.log(4*a);
  const scene = rgb.map(v => v <= .5 ? v*v/3 : (Math.exp((v-c)/a)+b)/12);
  const gain = 1000*dot(scene, luma)**.2;
  return scene.map(v => v*gain);
}
const associate = p => [p[0]*p[3], p[1]*p[3], p[2]*p[3], p[3]];
const unassociate = p => p[3] > 0 ? [p[0]/p[3], p[1]/p[3], p[2]/p[3], p[3]] : [0, 0, 0, 0];
export function view(rgb) {
  const y = dot(rgb.slice(0, 3), luma);
  if (y <= 0) return [0, 0, 0];
  const mapped = y <= .75 ? y : .75+.25*(y-.75)/(y-.5);
  return convert(rgb.slice(0, 3).map(v => v*mapped/y), '2020', '709').map(v => srgbEncode(Math.min(1, Math.max(0, v))));
}
function source(node) {
  if (!['srgb', 'bt1886', 'pq', 'hlg'].includes(node.transfer)) throw new Error('unsupported-transfer');
  const rgb = node.rgb.map(n), alpha = n(node.alpha);
  if (rgb.length !== 3 || rgb.some(v => !Number.isFinite(v) || v < 0 || v > 1)) throw new Error('invalid-source-signal');
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) throw new Error('invalid-source-alpha');
  if (['pq', 'hlg'].includes(node.transfer) && node.primaries !== '2020') throw new Error('unsupported-hdr-colorimetry');
  let linear;
  if (node.transfer === 'pq') linear = rgb.map(v => pqDecode(v)/203);
  else if (node.transfer === 'hlg') linear = hlgDecode(rgb).map(v => v/203);
  else {
    const white = n(node.white);
    if (!Number.isFinite(white) || white <= 0 || white > 1000) throw new Error('invalid-source-white');
    linear = rgb.map(v => (node.transfer === 'srgb' ? srgbDecode(v) : v**2.4)*white/203);
  }
  const working = convert(linear, node.primaries, '2020');
  if (working.some(v => !Number.isFinite(v) || v < -64 || v > 64)) throw new Error('working-range-exceeded');
  return [...working, alpha];
}

function sampleLens(node, q) {
  const [outputX, outputY] = node.point.map(n);
  const [k1, k2, k3, p1, p2, strength] = node.model.map(n);
  const x = outputX-.5, y = outputY-.5, r2 = x*x+y*y;
  const radial = 1+k1*r2+k2*r2*r2+k3*r2*r2*r2;
  const distorted = [x*radial+2*p1*x*y+p2*(r2+2*x*x), y*radial+p1*(r2+2*y*y)+2*p2*x*y];
  const sx = (.5+x+(distorted[0]-x)*strength)*node.width-.5;
  const sy = (.5+y+(distorted[1]-y)*strength)*node.height-.5;
  const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx-ix, fy = sy-iy;
  const tap = (x, y) => x < 0 || y < 0 || x >= node.width || y >= node.height ? [0, 0, 0, 0] : q(associate(q(node.pixels[y*node.width+x].map(n))));
  const mix = (a, b, weight) => a.map((v, i) => v+(b[i]-v)*weight);
  const top = mix(tap(ix, iy), tap(ix+1, iy), fx);
  const bottom = mix(tap(ix, iy+1), tap(ix+1, iy+1), fx);
  return {coordinate: [sx, sy], associated: q(mix(top, bottom, fy))};
}

export function evaluate(node, storage = 'float64') {
  if (!['float64', 'binary16-storage'].includes(storage)) throw new Error('unknown-storage');
  const q = values => storage === 'binary16-storage' ? values.map(Math.f16round) : values;
  const run = child => evaluate(child, storage);
  switch (node.op) {
    case 'values': return q(node.v.map(n));
    case 'transfer': {
      const fn = {'pq-encode': pqEncode, 'pq-decode': pqDecode, 'srgb-encode': srgbEncode, 'srgb-decode': srgbDecode}[node.kind];
      if (!fn) throw new Error('unknown-transfer-operation');
      return node.v.map(v => fn(n(v)));
    }
    case 'hlg': return hlgDecode(node.v.map(n));
    case 'source': return q(source(node));
    case 'convert': return q(convert(node.v.map(n), node.from, node.to));
    case 'associate': return q(associate(run(node.input)));
    case 'unassociate': return q(unassociate(run(node.input)));
    case 'over': {
      const a = run(node.source), b = run(node.destination);
      return q(a.map((v, i) => v+b[i]*(1-a[3])));
    }
    case 'dissolve': {
      const a = run(node.a), b = run(node.b), w = n(node.weight);
      return q(a.map((v, i) => v*(1-w)+b[i]*w));
    }
    case 'exposure': {
      const p = run(node.input), gain = 2**n(node.stops);
      return q([...p.slice(0, 3).map(v => v*gain), p[3]]);
    }
    case 'coverage': return q(run(node.input).map(v => v*n(node.amount)));
    case 'view': return view(run(node.input));
    case 'scope': {
      const values = node.pixels.map(p => 203*dot(run(p).slice(0, 3), luma));
      const bins = Array(11).fill(0);
      for (const v of values) bins[Math.min(10, Math.floor(Math.max(0, v)/100))]++;
      return {nits: values, peak: Math.max(...values), bins};
    }
    case 'range': {
      const [kr, kb] = node.matrix === '709' ? [.2126, .0722] : [.2627, .0593];
      return node.codes.map(([y, cb, cr]) => {
        y = (y-(node.limited ? 64 : 0))/(node.limited ? 876 : 1023);
        cb = (cb-512)/(node.limited ? 896 : 1023);
        cr = (cr-512)/(node.limited ? 896 : 1023);
        const red = y+2*(1-kr)*cr, blue = y+2*(1-kb)*cb;
        return [red, (y-kr*red-kb*blue)/(1-kr-kb), blue];
      });
    }
    case 'lens': return sampleLens(node, q);
    case 'half': return node.v.map(v => Math.f16round(n(v)));
    default: throw new Error('unsupported-operation');
  }
}

export function presentation(node, result) {
  if (node.op === 'view') return {code10: result.map(v => v*1023), alpha: 1};
  let pixel = node.op === 'lens' ? result.associated : result;
  if (['source', 'unassociate'].includes(node.op)) pixel = associate(pixel);
  return {code10: view(pixel).map(v => v*1023), alpha: pixel[3]};
}

// Proposed fail-closed policy only. This is not wired into Myrelith.
export function managedStageStatus(stage) {
  if (stage.kind === 'plugin') return {supported: false, reason: 'plugin-abi-not-qualified-for-managed-color'};
  if (['legacy-lut', 'legacy-wheels', 'legacy-curves', 'legacy-lens', 'legacy-blend'].includes(stage.kind)) return {supported: false, reason: 'legacy-stage-needs-explicit-color-version'};
  if (stage.kind === 'linear-exposure' && stage.version === 1) return {supported: true, reason: null};
  return {supported: false, reason: 'unknown-managed-stage'};
}

export function interpretTags(container, bitstream) {
  const fields = ['primaries', 'transfer', 'matrix', 'fullRange'];
  if (!container || !bitstream || fields.some(k => container[k] == null || bitstream[k] == null)) return 'unresolved-missing-tags';
  if (fields.some(k => container[k] !== bitstream[k])) return 'unresolved-conflicting-tags';
  if (typeof container.fullRange !== 'boolean') return 'unresolved-invalid-range';
  const {primaries, transfer, matrix} = container;
  if (primaries === 'bt2020' && ['pq', 'hlg'].includes(transfer) && matrix === 'bt2020-ncl') return transfer;
  if (primaries === 'smpte432' && transfer === 'iec61966-2-1' && matrix === 'rgb' && container.fullRange) return 'sdr-p3';
  if (primaries === 'bt709' && transfer === 'bt709' && matrix === 'bt709') return 'sdr-709';
  return 'unresolved-unsupported-tags';
}
