export type ParseCSVMsg = { type: 'parse'; file: File }
export type ParseProgressMsg = { type: 'progress'; progress: number; rows: number }
export type ParsedMsg = { type: 'parsed'; ids: string[]; columns: Record<string, Float32Array | Int32Array | string[]>; meta: { numericColumns: string[]; categoricalColumns: string[] }; warnings?: string[] }


export type CrossfilterMsg = { type: 'mask'; op: 'range' | 'category' | 'ids' | 'reset'; payload: any; length: number }
export type CrossfilterResp = { type: 'mask'; mask: Uint8Array }
