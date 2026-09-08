import type { PortableColorLutV1 } from './colorLut'
export type ColorLutImportReply = { readonly table: PortableColorLutV1 } | { readonly error: string }
export interface ColorLutImportRequest { readonly file: Blob; readonly name: string; readonly id: string }
