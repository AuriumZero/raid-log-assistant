// A small .xlsx writer: just enough of the Office Open XML format for styled
// cells, column widths, merged cells, frozen panes and filters. An .xlsx file
// is a zip of XML parts, so this also writes an uncompressed zip. Writing it
// by hand keeps the export free of a large spreadsheet library.

export interface CellStyle {
  bold?: boolean
  size?: number
  /** Text color as hex, e.g. `#ffffff`. */
  color?: string
  /** Solid background as hex. */
  fill?: string
  /** Excel number format, e.g. `mmm d, yyyy`. */
  numFmt?: string
  align?: 'left' | 'center' | 'right'
  indent?: number
  /** A thin line under the cell. */
  underline?: string
  /** Wrap long text onto more lines, making the row taller. */
  wrap?: boolean
  valign?: 'top' | 'center'
}

export interface Cell {
  v?: string | number
  /** Index into the workbook's `styles`. */
  s?: number
}

export interface Sheet {
  name: string
  /** Column widths in characters, from column A. */
  cols?: number[]
  rows: (Cell | null)[][]
  merges?: string[]
  /** Rows and columns that stay put while scrolling. */
  freeze?: { rows: number; cols: number }
  /** Range for filter buttons, e.g. `A1:K20`. */
  autoFilter?: string
  landscape?: boolean
}

export interface Workbook {
  sheets: Sheet[]
  styles: CellStyle[]
}

/** 0 → A, 25 → Z, 26 → AA. */
export function colName(index: number): string {
  let name = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name
  return name
}

/** A cell reference such as `B3`, from zero-based row and column. */
export const ref = (row: number, col: number) => `${colName(col)}${row + 1}`

/** Excel's serial number for a day number (days since 1970-01-01). */
export const excelDate = (day: number) => day + 25569

function esc(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const argb = (hex: string) => `FF${hex.replace('#', '').toUpperCase()}`
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

/** Collects distinct fonts, fills, borders and formats, and one cell format per style. */
function stylesXml(styles: CellStyle[]): string {
  const fonts = ['<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>']
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>']
  const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>']
  const fmts: string[] = []
  const add = (list: string[], xml: string) => {
    const i = list.indexOf(xml)
    return i >= 0 ? i : list.push(xml) - 1
  }
  const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>']
  for (const s of styles) {
    const font = add(fonts, `<font>${s.bold ? '<b/>' : ''}<sz val="${s.size ?? 11}"/>${s.color ? `<color rgb="${argb(s.color)}"/>` : ''}<name val="Calibri"/><family val="2"/></font>`)
    const fill = s.fill ? add(fills, `<fill><patternFill patternType="solid"><fgColor rgb="${argb(s.fill)}"/><bgColor indexed="64"/></patternFill></fill>`) : 0
    const border = s.underline ? add(borders, `<border><left/><right/><top/><bottom style="thin"><color rgb="${argb(s.underline)}"/></bottom><diagonal/></border>`) : 0
    const fmt = s.numFmt ? 164 + add(fmts, s.numFmt) : 0
    const align = `<alignment vertical="${s.valign ?? 'center'}"${s.align ? ` horizontal="${s.align}"` : ''}${s.indent ? ` indent="${s.indent}"` : ''}${s.wrap ? ' wrapText="1"' : ''}/>`
    xfs.push(`<xf numFmtId="${fmt}" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${align}</xf>`)
  }
  const numFmts = fmts.length
    ? `<numFmts count="${fmts.length}">${fmts.map((f, i) => `<numFmt numFmtId="${164 + i}" formatCode="${esc(f)}"/>`).join('')}</numFmts>`
    : ''
  return `${XML}<styleSheet xmlns="${MAIN}">${numFmts}`
    + `<fonts count="${fonts.length}">${fonts.join('')}</fonts>`
    + `<fills count="${fills.length}">${fills.join('')}</fills>`
    + `<borders count="${borders.length}">${borders.join('')}</borders>`
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>`
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    + '</styleSheet>'
}

function sheetXml(sheet: Sheet, selected: boolean): string {
  const { freeze } = sheet
  let pane = ''
  if (freeze && (freeze.rows || freeze.cols)) {
    const active = freeze.rows && freeze.cols ? 'bottomRight' : freeze.rows ? 'bottomLeft' : 'topRight'
    pane = `<pane${freeze.cols ? ` xSplit="${freeze.cols}"` : ''}${freeze.rows ? ` ySplit="${freeze.rows}"` : ''} topLeftCell="${ref(freeze.rows, freeze.cols)}" activePane="${active}" state="frozen"/>`
      + `<selection pane="${active}" activeCell="${ref(freeze.rows, freeze.cols)}" sqref="${ref(freeze.rows, freeze.cols)}"/>`
  }
  const views = `<sheetViews><sheetView${selected ? ' tabSelected="1"' : ''} workbookViewId="0">${pane}</sheetView></sheetViews>`
  const cols = sheet.cols?.length
    ? `<cols>${sheet.cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : ''
  const rows = sheet.rows.map((cells, r) => {
    const body = cells.map((cell, c) => {
      if (!cell || (cell.v === undefined && cell.s === undefined)) return ''
      const s = cell.s === undefined ? '' : ` s="${cell.s + 1}"`
      if (cell.v === undefined || cell.v === '') return `<c r="${ref(r, c)}"${s}/>`
      if (typeof cell.v === 'number') return `<c r="${ref(r, c)}"${s}><v>${cell.v}</v></c>`
      return `<c r="${ref(r, c)}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(cell.v)}</t></is></c>`
    }).join('')
    return `<row r="${r + 1}">${body}</row>`
  }).join('')
  const filter = sheet.autoFilter ? `<autoFilter ref="${sheet.autoFilter}"/>` : ''
  const merges = sheet.merges?.length ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : ''
  const setup = sheet.landscape ? '<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>' : ''
  return `${XML}<worksheet xmlns="${MAIN}" xmlns:r="${REL}">`
    + (sheet.landscape ? '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' : '')
    + `${views}<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${rows}</sheetData>${filter}${merges}`
    + `<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>${setup}</worksheet>`
}

/** Quotes a sheet name for use in a formula or defined name. */
const quoted = (name: string) => `'${name.replace(/'/g, "''")}'`
const absolute = (range: string) => range.split(':').map((r) => r.replace(/^([A-Z]+)(\d+)$/, '$$$1$$$2')).join(':')

/** Builds the bytes of an .xlsx file. */
export function buildXlsx(book: Workbook): Uint8Array {
  const { sheets } = book
  const filters = sheets
    .map((s, i) => s.autoFilter ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${esc(quoted(s.name))}!${absolute(s.autoFilter)}</definedName>` : '')
    .join('')
  const files: [string, string][] = [
    ['[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + '</Types>'],
    ['_rels/.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `${XML}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><bookViews><workbookView activeTab="0"/></bookViews><sheets>`
      + sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
      + `</sheets>${filters ? `<definedNames>${filters}</definedNames>` : ''}</workbook>`],
    ['xl/_rels/workbook.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${sheets.length + 1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', stylesXml(book.styles)],
    ...sheets.map((s, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s, i === 0)]),
  ]
  return zip(files)
}

let crcTable: Uint32Array | undefined
function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** Packs files into a zip archive without compression ("stored" entries). */
export function zip(files: [string, string | Uint8Array][]): Uint8Array {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const [name, content] of files) {
    const nameBytes = enc.encode(name)
    const data = typeof content === 'string' ? enc.encode(content) : content
    const crc = crc32(data)
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true) // version needed
    local.setUint16(6, 0x0800, true) // UTF-8 names
    local.setUint16(8, 0, true) // stored
    local.setUint16(10, 0, true) // time
    local.setUint16(12, 0x21, true) // date: 1980-01-01
    local.setUint32(14, crc, true)
    local.setUint32(18, data.length, true)
    local.setUint32(22, data.length, true)
    local.setUint16(26, nameBytes.length, true)
    const dir = new DataView(new ArrayBuffer(46))
    dir.setUint32(0, 0x02014b50, true)
    dir.setUint16(4, 20, true)
    dir.setUint16(6, 20, true)
    dir.setUint16(8, 0x0800, true)
    dir.setUint16(12, 0, true)
    dir.setUint16(14, 0x21, true)
    dir.setUint32(16, crc, true)
    dir.setUint32(20, data.length, true)
    dir.setUint32(24, data.length, true)
    dir.setUint16(28, nameBytes.length, true)
    dir.setUint32(42, offset, true)
    parts.push(new Uint8Array(local.buffer), nameBytes, data)
    central.push(new Uint8Array(dir.buffer), nameBytes)
    offset += 30 + nameBytes.length + data.length
  }
  const dirSize = central.reduce((n, p) => n + p.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, files.length, true)
  end.setUint16(10, files.length, true)
  end.setUint32(12, dirSize, true)
  end.setUint32(16, offset, true)
  const all = [...parts, ...central, new Uint8Array(end.buffer)]
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of all) { out.set(p, at); at += p.length }
  return out
}
