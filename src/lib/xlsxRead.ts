// Reads a worksheet of an .xlsx file into rows of strings: the first sheet whose
// name matches `prefer`, or else the first sheet.
//
// An .xlsx file is a zip of XML parts. This unzips it with fflate (a small,
// dependency-free library) and reads the XML with the browser's DOMParser, so
// the file never leaves the page. Only what a Jira export needs is supported:
// shared strings, inline strings, numbers, booleans and date-formatted numbers.

import { unzipSync, strFromU8 } from 'fflate'

const parser = () => new DOMParser()

function xml(files: Record<string, Uint8Array>, path: string): Document | null {
  const bytes = files[path]
  return bytes ? parser().parseFromString(strFromU8(bytes), 'application/xml') : null
}

const all = (node: Document | Element, name: string) => Array.from(node.getElementsByTagNameNS('*', name))

/** Column index from a cell reference: `A1` → 0, `AB7` → 27. */
export function columnIndex(ref: string): number {
  let n = 0
  for (const ch of ref) {
    const code = ch.charCodeAt(0)
    if (code < 65 || code > 90) break
    n = n * 26 + (code - 64)
  }
  return n - 1
}

// Built-in number formats that Excel displays as dates or times.
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57])

function isDateFormat(code: string): boolean {
  // Ignore quoted text, escaped characters and [color]/[condition] sections.
  const bare = code.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, '')
  return /[dmyhs]/i.test(bare) && /[dy]/i.test(bare)
}

/** Excel serial date → `YYYY-MM-DDTHH:MM` (Excel counts days from 1899-12-30). */
export function serialToIso(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400) * 1000
  return new Date(ms).toISOString().slice(0, 16)
}

export function readXlsx(data: Uint8Array, prefer?: RegExp): string[][] {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(data)
  } catch {
    throw new Error('This file is not a valid .xlsx workbook.')
  }

  // Which styles are dates?
  const dateStyles = new Set<number>()
  const styles = xml(files, 'xl/styles.xml')
  if (styles) {
    const custom = new Map<number, string>()
    for (const f of all(styles, 'numFmt')) custom.set(Number(f.getAttribute('numFmtId')), f.getAttribute('formatCode') ?? '')
    const cellXfs = all(styles, 'cellXfs')[0]
    if (cellXfs) {
      Array.from(cellXfs.children).forEach((xf, i) => {
        const id = Number(xf.getAttribute('numFmtId') ?? 0)
        if (BUILTIN_DATE_FORMATS.has(id) || (custom.has(id) && isDateFormat(custom.get(id)!))) dateStyles.add(i)
      })
    }
  }

  const shared: string[] = []
  const sst = xml(files, 'xl/sharedStrings.xml')
  if (sst) for (const si of all(sst, 'si')) shared.push(all(si, 't').map((t) => t.textContent ?? '').join(''))

  // Pick the sheet: a preferred name if there is one, otherwise the first in workbook order.
  let sheetPath = 'xl/worksheets/sheet1.xml'
  const wb = xml(files, 'xl/workbook.xml')
  const rels = xml(files, 'xl/_rels/workbook.xml.rels')
  const sheets = wb ? all(wb, 'sheet') : []
  const first = (prefer && sheets.find((s) => prefer.test(s.getAttribute('name') ?? ''))) || sheets[0]
  if (first && rels) {
    const rid = first.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ?? first.getAttribute('r:id')
    const rel = all(rels, 'Relationship').find((r) => r.getAttribute('Id') === rid)
    const target = rel?.getAttribute('Target')
    if (target) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`
  }
  const sheet = xml(files, sheetPath)
  if (!sheet) throw new Error('Could not find a worksheet in this workbook.')

  const rows: string[][] = []
  for (const r of all(sheet, 'row')) {
    const out: string[] = []
    let next = 0
    for (const c of all(r, 'c')) {
      const ref = c.getAttribute('r')
      const col = ref ? columnIndex(ref) : next
      next = col + 1
      const type = c.getAttribute('t')
      const v = all(c, 'v')[0]?.textContent ?? ''
      let value: string
      if (type === 's') value = shared[Number(v)] ?? ''
      else if (type === 'inlineStr') value = all(c, 't').map((t) => t.textContent ?? '').join('')
      else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE'
      else if (type === 'str' || type === 'e') value = v
      else if (v !== '' && dateStyles.has(Number(c.getAttribute('s') ?? -1))) value = serialToIso(Number(v))
      else value = v
      while (out.length < col) out.push('')
      out[col] = value
    }
    const rowIndex = Number(r.getAttribute('r') ?? rows.length + 1) - 1
    while (rows.length < rowIndex) rows.push([])
    rows.push(out)
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ''))
}
