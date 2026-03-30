import * as XLSX from 'xlsx'
import { parse as dateParse } from 'date-fns'
import { PartnerConfig } from './partners'

// Column letter(s) to 0-based index: A=0, B=1, ... P=15, AA=26, etc.
export function colToIndex(col: string): number {
  col = col.toUpperCase()
  let index = 0
  for (let i = 0; i < col.length; i++) {
    index = index * 26 + col.charCodeAt(i) - 64
  }
  return index - 1
}

export function parseDate(value: unknown, format: string): Date {
  if (value instanceof Date) return value

  if (typeof value === 'number') {
    // Excel serial dates for 2020-2035 are ~43831–47847
    // Anything over 2,958,465 (Excel max for year 9999) is a Unix timestamp
    if (value > 2958465) {
      // Unix timestamp — seconds if < 1e10, milliseconds if >= 1e10
      const ts = value >= 1e10 ? value : value * 1000
      const d = new Date(ts)
      if (!isNaN(d.getTime())) return d
    }
    const excelEpoch = new Date(Date.UTC(1899, 11, 30))
    return new Date(excelEpoch.getTime() + value * 86400000)
  }

  if (typeof value === 'string') {
    const str = value.trim().replace(/^'+/, '')  // strip leading apostrophe(s) from Excel text-forced cells
    if (!str) throw new Error('Empty date value')
    const parsed = dateParse(str, format, new Date())
    if (!isNaN(parsed.getTime())) return parsed
    const native = new Date(str)
    if (!isNaN(native.getTime())) return native
  }

  throw new Error(`Cannot parse date value: ${JSON.stringify(value)}`)
}

function resolveChannel(row: unknown[], config: PartnerConfig): string {
  if (config.channel !== null) return config.channel

  if (!config.columns.typeColumn || !config.typeMapping) {
    throw new Error('Partner config is missing typeColumn or typeMapping')
  }

  const colIndex = colToIndex(config.columns.typeColumn)
  const rawValue = String(row[colIndex] ?? '').trim().toUpperCase()

  for (const [key, channel] of Object.entries(config.typeMapping)) {
    if (key === '*') continue
    if (rawValue === key.toUpperCase()) return channel
  }

  if ('*' in config.typeMapping) return config.typeMapping['*']

  throw new Error(`Unknown type value in column ${config.columns.typeColumn}: "${rawValue}"`)
}

export interface ParsedRow {
  rowNum: number        // 1-based source row number
  reconRef: string
  reconRef2: string
  amount: number
  datetime: Date        // parsed Date, used for date range detection
  channel: string
  partner: string
}

export interface ParseResult {
  rows: ParsedRow[]
  errors: { row: number; message: string }[]
  minDate: Date         // earliest date in the file (date part only, midnight UTC)
  maxDate: Date         // latest date in the file (date part only, midnight UTC)
}

function dateOnly(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

export function parsePartnerFile(fileBuffer: Buffer, config: PartnerConfig): ParseResult {
  const workbook = XLSX.read(fileBuffer, { type: 'buffer', cellDates: true, raw: false })
  const sheetName = workbook.SheetNames[0]
  const sheet = workbook.Sheets[sheetName]
  const allRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' })

  const dataStartIndex = config.headerRow + 1
  const colReconRef = colToIndex(config.columns.recon_ref)
  const colReconRef2 = config.columns.recon_ref_2 ? colToIndex(config.columns.recon_ref_2) : null
  const colAmount = colToIndex(config.columns.amount)
  const colDatetime = colToIndex(config.columns.datetime)

  const rows: ParsedRow[] = []
  const errors: { row: number; message: string }[] = []
  let minDate: Date | null = null
  let maxDate: Date | null = null

  for (let i = dataStartIndex; i < allRows.length; i++) {
    const row = allRows[i] as unknown[]
    if (row.every((cell) => cell === '' || cell === null || cell === undefined)) continue

    const sourceRowNum = i + 1

    try {
      const channel = resolveChannel(row, config)

      // Skip rows that don't match the channel filter (e.g. BRI QRIS only)
      if (config.channelFilter !== null && channel !== config.channelFilter) continue

      // Parse datetime — use date-only when config specifies defaultTime
      let datetime: Date
      if (config.columns.defaultTime) {
        const d = parseDate(row[colDatetime], config.dateFormat)
        datetime = dateOnly(d)
      } else {
        datetime = parseDate(row[colDatetime], config.dateFormat)
      }

      let reconRef = String(row[colReconRef] ?? '').trim().replace(/^'+/, '')
      if (config.reconRefPadLength && reconRef.length < config.reconRefPadLength) {
        reconRef = reconRef.padStart(config.reconRefPadLength, '0')
      }
      const reconRef2 = colReconRef2 !== null ? String(row[colReconRef2] ?? '').trim().replace(/^'+/, '') : ''
      const rawAmount = row[colAmount]
      const amount = typeof rawAmount === 'number'
        ? rawAmount
        : Number(String(rawAmount).replace(/[^0-9.-]/g, ''))

      const d = dateOnly(datetime)
      if (!minDate || d < minDate) minDate = d
      if (!maxDate || d > maxDate) maxDate = d

      rows.push({ rowNum: sourceRowNum, reconRef, reconRef2, amount, datetime, channel, partner: config.partner })
    } catch (err) {
      errors.push({
        row: sourceRowNum,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (!minDate || !maxDate) {
    const hint = errors.length > 0
      ? `First error on row ${errors[0].row}: ${errors[0].message}`
      : 'File appears empty or all rows were skipped'
    throw new Error(`No valid rows found. ${hint}`)
  }

  return { rows, errors, minDate, maxDate }
}
