// Deliberately accepts only the approved multilingual tiny-q8_0 file profile.
// This is byte inspection, never a model/runtime loader.
export const MODEL_BYTES = 43_537_433;
export const MODEL_SHA256 = 'c2085835d3f50733e2ff6e4b41ae8a2b8d8110461e18821b09a15c40c42d1cca';
const HEADER = [0x67676d6c, 51865, 1500, 384, 6, 4, 448, 384, 6, 4, 80, 2007];

function tensorProfile() {
  const tensors = new Map();
  const add = (name, dimensions, type = 0) => tensors.set(name, { dimensions, type });
  add('encoder.positional_embedding', [384, 1500]);
  add('decoder.positional_embedding', [384, 448]);
  add('decoder.token_embedding.weight', [384, 51865], 8);
  for (const [name, channels] of [['conv1', 80], ['conv2', 384]]) {
    add(`encoder.${name}.weight`, [3, channels, 384], 1);
    add(`encoder.${name}.bias`, [1, 384]);
  }
  for (const name of ['encoder.ln_post', 'decoder.ln']) {
    add(`${name}.weight`, [384]); add(`${name}.bias`, [384]);
  }
  for (const side of ['encoder', 'decoder']) for (let i = 0; i < 4; i++) {
    const root = `${side}.blocks.${i}`;
    for (const name of ['mlp_ln', 'attn_ln', ...(side === 'decoder' ? ['cross_attn_ln'] : [])]) {
      add(`${root}.${name}.weight`, [384]); add(`${root}.${name}.bias`, [384]);
    }
    add(`${root}.mlp.0.weight`, [384, 1536], 8); add(`${root}.mlp.0.bias`, [1536]);
    add(`${root}.mlp.2.weight`, [1536, 384], 8); add(`${root}.mlp.2.bias`, [384]);
    for (const kind of ['attn', ...(side === 'decoder' ? ['cross_attn'] : [])]) {
      for (const name of ['query', 'key', 'value', 'out']) {
        add(`${root}.${kind}.${name}.weight`, [384, 384], 8);
        if (name !== 'key') add(`${root}.${kind}.${name}.bias`, [384]);
      }
    }
  }
  return tensors;
}

export function inspectTinyQ8(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== MODEL_BYTES) throw Error('model-size');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  function skip(n) {
    if (!Number.isSafeInteger(n) || n < 0 || n > bytes.length - offset) throw Error('truncated-model');
    const start = offset; offset += n; return start;
  }
  const i32 = () => view.getInt32(skip(4), true);
  for (const expected of HEADER) if (i32() !== expected) throw Error('model-header');
  if (i32() !== 80 || i32() !== 201) throw Error('mel-shape');
  for (let i = 0; i < 80 * 201; i++) if (!Number.isFinite(view.getFloat32(skip(4), true))) throw Error('mel-value');
  // The pinned converter stores 50,257 base tokens; the core constructs special
  // multilingual tokens up to hparams.n_vocab=51,865. No external tokenizer.
  if (i32() !== 50257) throw Error('vocabulary-count');
  let maxTokenBytes = 0;
  for (let i = 0; i < 50257; i++) {
    const n = i32(); if (n < 0 || n > 1024) throw Error('vocabulary-token-size');
    maxTokenBytes = Math.max(maxTokenBytes, n); skip(n);
  }
  const tensorStart = offset, expected = tensorProfile(), inventory = [];
  const ascii = new TextDecoder('utf-8', { fatal: true });
  while (offset < bytes.length) {
    const dimensionsCount = i32(), nameBytes = i32(), type = i32();
    if (dimensionsCount < 1 || dimensionsCount > 3 || nameBytes < 1 || nameBytes > 128) throw Error('tensor-header');
    const dimensions = Array.from({ length: dimensionsCount }, i32);
    const start = skip(nameBytes), name = ascii.decode(bytes.subarray(start, offset));
    const profile = expected.get(name);
    if (!profile || type !== profile.type || dimensions.join(',') !== profile.dimensions.join(',')) throw Error('tensor-profile');
    expected.delete(name);
    const count = dimensions.reduce((a, b) => a * b, 1);
    if (type === 8 && dimensions[0] % 32 !== 0) throw Error('quantization-block');
    const length = type === 8 ? count / 32 * 34 : count * (type === 0 ? 4 : 2);
    inventory.push({ name, dimensions, type, offset, bytes: length }); skip(length);
  }
  if (expected.size !== 0 || inventory.length !== 167 || offset !== MODEL_BYTES) throw Error('tensor-completeness');
  return { bytes: offset, hparams: HEADER.slice(1), mel: [80, 201], storedVocabulary: 50257,
    maxTokenBytes, tensorStart, tensorCount: inventory.length, inventory };
}
