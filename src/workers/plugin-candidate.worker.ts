import {
  parsePluginWasmModule,
  type PluginWasmModuleExpectations,
  type PluginWasmModuleFacts,
} from './plugin-wasm/moduleParser'

export interface PluginCandidateEngine {
  validate(bytes: Uint8Array): boolean
  compile(bytes: Uint8Array): Promise<unknown>
  createMemory(descriptor: { readonly initial: number; readonly maximum: number }): unknown
  instantiate(
    module: unknown,
    imports: { readonly myrelith: { readonly memory: unknown } },
  ): Promise<unknown>
}

export interface PluginCandidateActivationInput {
  readonly moduleBytes: Uint8Array
  readonly expectations: PluginWasmModuleExpectations
}

export interface PluginCandidateActivation {
  readonly facts: PluginWasmModuleFacts
  readonly module: unknown
  readonly memory: unknown
  readonly instance: unknown
}

/** Candidate-only core. The parent must still own its non-resetting activation deadline. */
export function createPluginCandidateCore(engine: PluginCandidateEngine): {
  activate(input: PluginCandidateActivationInput): Promise<PluginCandidateActivation>
} {
  return {
    async activate(input): Promise<PluginCandidateActivation> {
      const facts = parsePluginWasmModule(input.moduleBytes, input.expectations)
      if (!engine.validate(input.moduleBytes)) {
        throw new Error('The policy-valid WebAssembly module failed engine validation.')
      }
      const module = await engine.compile(input.moduleBytes)
      const memory = engine.createMemory({
        initial: facts.importedMemory.minimumPages,
        maximum: facts.importedMemory.maximumPages,
      })
      const instance = await engine.instantiate(module, { myrelith: { memory } })
      return Object.freeze({ facts, module, memory, instance })
    },
  }
}
