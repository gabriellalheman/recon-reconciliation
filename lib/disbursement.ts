// Mandiri MT940 reconciliation — disbursement channel
// Parses MT940 bank statement and matches against bank_transfer in Snap Core Processor

const SNAP_CORE_DB_ID = 5

// ─── MT940 Parser ─────────────────────────────────────────────────────────────

export interface Mt940ParseResult {
  isoDate: string          // YYYY-MM-DD (WIB calendar date from :60F: header)
  refs: Set<string>        // partnerExternalIds found in NCHG fee rows
}

export function parseMt940(content: string): Mt940ParseResult {
  const dateMatch = content.match(/:60F:[CD](\d{6})/)
  const yymmdd = dateMatch ? dateMatch[1] : ''
  const isoDate = yymmdd
    ? `20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`
    : ''

  const refs = new Set<string>()
  const lines = content.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line.startsWith(':61:')) continue

    const field61 = line.slice(4)
    if (!field61.match(/^\d{6}D\d+NCHG/)) continue

    const next = lines[i + 1]?.trim() ?? ''
    if (!next.startsWith(':86:')) continue

    const narrative = next.slice(4)
    const m = narrative.match(/Transfer Fee\s+(\d+)/)
    if (m) refs.add(m[1])
  }

  return { isoDate, refs }
}

// ─── Metabase Query ───────────────────────────────────────────────────────────

export interface DisbursementDbRecord {
  partnerExternalId: string
  amount: number | null
  remark: string | null
  transactionDate: string | null
}

function prevDay(isoDate: string): string {
  const d = new Date(isoDate)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

export async function fetchDisbursementRecords(
  isoDate: string,
): Promise<Map<string, DisbursementDbRecord>> {
  const baseUrl = process.env.METABASE_URL
  const apiKey = process.env.METABASE_API_KEY
  if (!baseUrl || !apiKey) throw new Error('METABASE_URL and METABASE_API_KEY must be set')

  const sql = `
    SELECT
      json_unquote(json_extract(additional_info, '$.partnerExternalId')) AS partner_external_id,
      json_unquote(json_extract(amount, '$.value'))                       AS amount_value,
      remark,
      transaction_date
    FROM bank_transfer
    WHERE transaction_date >= '${prevDay(isoDate)} 17:00:00'
      AND transaction_date <  '${isoDate} 17:00:00'
      AND bank_acquirer = 'MANDIRI_CENTRAL'
      AND json_extract(additional_info, '$.partnerExternalId') IS NOT NULL
  `.trim()

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Api-Key': apiKey,
  }
  if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
    headers['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID
    headers['CF-Access-Client-Secret'] = process.env.CF_ACCESS_CLIENT_SECRET
  }

  const res = await fetch(`${baseUrl}/api/dataset`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      database: SNAP_CORE_DB_ID,
      type: 'native',
      native: { query: sql },
      constraints: { 'max-results': 1000000, 'max-results-bare-rows': 1000000 },
    }),
  })

  if (!res.ok) throw new Error(`Metabase request failed: ${res.status} ${await res.text()}`)

  const json = await res.json() as {
    status?: string
    error?: string
    data: { rows: unknown[][]; cols: { name: string }[] }
  }

  if (json.status === 'failed' || json.error) {
    throw new Error(`Metabase query error: ${json.error ?? 'unknown'}`)
  }

  const cols = json.data.cols.map((c) => c.name)
  const idxRef = cols.indexOf('partner_external_id')
  const idxAmt = cols.indexOf('amount_value')
  const idxRemark = cols.indexOf('remark')
  const idxDate = cols.indexOf('transaction_date')

  const map = new Map<string, DisbursementDbRecord>()
  for (const row of json.data.rows) {
    const ref = String(row[idxRef] ?? '').trim()
    if (!ref) continue
    const amtStr = row[idxAmt] != null ? String(row[idxAmt]) : null
    map.set(ref, {
      partnerExternalId: ref,
      amount: amtStr ? parseFloat(amtStr) || null : null,
      remark: row[idxRemark] != null ? String(row[idxRemark]) : null,
      transactionDate: row[idxDate] != null ? String(row[idxDate]) : null,
    })
  }

  return map
}

// ─── Reconcile ────────────────────────────────────────────────────────────────

export type DisbursementStatus = 'done' | 'not_in_partner' | 'not_in_internal'

export interface DisbursementReconRow {
  status: DisbursementStatus
  partnerExternalId: string
  internalAmount: number | null
  remark: string | null
  transactionDate: string | null
}

export function reconcileDisbursement(
  mt940Refs: Set<string>,
  dbMap: Map<string, DisbursementDbRecord>,
  isoDate: string,
): DisbursementReconRow[] {
  const results: DisbursementReconRow[] = []

  // DB records vs MT940
  for (const [ref, db] of dbMap) {
    results.push({
      status: mt940Refs.has(ref) ? 'done' : 'not_in_partner',
      partnerExternalId: ref,
      internalAmount: db.amount,
      remark: db.remark,
      transactionDate: db.transactionDate,
    })
  }

  // MT940 refs with no DB record
  for (const ref of mt940Refs) {
    if (!dbMap.has(ref)) {
      results.push({
        status: 'not_in_internal',
        partnerExternalId: ref,
        internalAmount: null,
        remark: null,
        transactionDate: null,
      })
    }
  }

  return results
}
