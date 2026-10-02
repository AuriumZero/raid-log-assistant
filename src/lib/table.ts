// Reads an uploaded export into rows of text, whichever format it's in.

import { parseCsv } from './csv'
import { readXlsx } from './xlsxRead'

export async function readTable(file: { name: string; arrayBuffer(): Promise<ArrayBuffer> }, preferSheet?: RegExp): Promise<string[][]> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const lower = file.name.toLowerCase()
  // .xlsx files are zips, which start with "PK".
  if (lower.endsWith('.xlsx') || (bytes[0] === 0x50 && bytes[1] === 0x4b)) return readXlsx(bytes, preferSheet)
  if (lower.endsWith('.xls')) {
    throw new Error('Old-style .xls files aren\'t supported. In Excel, use Save As → Excel Workbook (.xlsx) or CSV, then upload that.')
  }
  const text = new TextDecoder('utf-8').decode(bytes)
  if (/^\s*<(!doctype|html|table)/i.test(text)) {
    throw new Error('This looks like an HTML "Excel" export. Export as CSV instead, or open it in Excel and save as .xlsx.')
  }
  return parseCsv(text)
}
