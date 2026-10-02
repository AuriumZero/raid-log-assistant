// Loads the sample exports from public/samples for tests.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const dir = resolve(process.cwd(), 'public/samples') + '/'

export const sampleBytes = (name: string) => new Uint8Array(readFileSync(dir + name))
export const sampleFile = (name: string) => {
  const bytes = sampleBytes(name)
  return { name, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer }
}
