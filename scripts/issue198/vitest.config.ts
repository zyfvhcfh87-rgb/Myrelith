import base from '../../vite.config'
export default { ...base, test: { ...base.test, include: ['scripts/issue198/*.test.ts'], maxWorkers: 2 } }
