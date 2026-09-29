/**
 * Dev server for the lifecycle runner with HMR disabled: a frozen page drops the
 * HMR socket, and Vite's client would reload the page on reconnect (a dev-only
 * artifact that would otherwise masquerade as a product reload).
 */
import { mergeConfig } from 'vite'
import base from '../../../vite.config'

export default mergeConfig(base, { server: { hmr: false } })
