// Canonical fixture preparation only; never launches a browser or listener.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { prepareDenseScalarFixture } from './continuation/portable.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const productSource = 'b33b7531027979b8886f5db979d57cd96b96175d'
const manifest = await prepareDenseScalarFixture(root, join(root, 'scripts/issue199/fixtures/continuation'), productSource)
console.log(JSON.stringify(manifest, null, 2))
