// Metabase query layer — fetches qris_transaction records for a date range
// and returns a lookup map keyed by the relevant recon reference.
// Database: [Prod] Snap Core Processor (ID 5)

export type MetabaseRefColumn = 'acquirer_reference_no' | 'issuerInfo_rrn'

export interface MetabaseRow {
  reconRef: string
  status: string
  amount: number
  createdAt: string
}

function buildQuery(minDate: Date, maxDate: Date, refColumn: MetabaseRefColumn): string {
  const start = minDate.toISOString().slice(0, 10)
  // maxDate is inclusive — query up to end of that day
  const endExclusive = new Date(maxDate.getTime() + 86400000).toISOString().slice(0, 10)

  if (refColumn === 'acquirer_reference_no') {
    return `
      SELECT
        acquirer_reference_no AS recon_ref,
        status,
        JSON_UNQUOTE(JSON_EXTRACT(amount, '$.value')) AS amount_value,
        created_at
      FROM qris_transaction
      WHERE DATE(created_at) >= '${start}'
        AND DATE(created_at) < '${endExclusive}'
        AND acquirer_reference_no IS NOT NULL
        AND acquirer_reference_no != ''
    `.trim()
  } else {
    // BRI: match on additional_info.issuerInfo.rrn
    return `
      SELECT
        JSON_UNQUOTE(JSON_EXTRACT(additional_info, '$.issuerInfo.rrn')) AS recon_ref,
        status,
        JSON_UNQUOTE(JSON_EXTRACT(amount, '$.value')) AS amount_value,
        created_at
      FROM qris_transaction
      WHERE DATE(created_at) >= '${start}'
        AND DATE(created_at) < '${endExclusive}'
        AND JSON_EXTRACT(additional_info, '$.issuerInfo.rrn') IS NOT NULL
    `.trim()
  }
}

export async function fetchMetabaseRows(
  minDate: Date,
  maxDate: Date,
  refColumn: MetabaseRefColumn,
): Promise<Map<string, MetabaseRow>> {
  const baseUrl = process.env.METABASE_URL
  const apiKey = process.env.METABASE_API_KEY

  if (!baseUrl || !apiKey) {
    throw new Error('METABASE_URL and METABASE_API_KEY must be set in environment')
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Api-Key': apiKey,
  }

  if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
    headers['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID
    headers['CF-Access-Client-Secret'] = process.env.CF_ACCESS_CLIENT_SECRET
  }

  const query = buildQuery(minDate, maxDate, refColumn)

  const res = await fetch(`${baseUrl}/api/dataset`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      database: 5,
      type: 'native',
      native: { query },
    }),
  })

  if (!res.ok) {
    throw new Error(`Metabase request failed: ${res.status} ${await res.text()}`)
  }

  const result = await res.json() as {
    status?: string
    error?: string
    data: { rows: unknown[][]; cols: { name: string }[] }
  }

  if (result.status === 'failed' || result.error) {
    throw new Error(`Metabase query error: ${result.error ?? 'unknown'}`)
  }

  const cols = result.data.cols.map((c) => c.name)
  const idxRef = cols.indexOf('recon_ref')
  const idxStatus = cols.indexOf('status')
  const idxAmount = cols.indexOf('amount_value')
  const idxCreatedAt = cols.indexOf('created_at')

  const map = new Map<string, MetabaseRow>()

  for (const row of result.data.rows) {
    const reconRef = String(row[idxRef] ?? '').trim()
    if (!reconRef) continue

    map.set(reconRef, {
      reconRef,
      status: String(row[idxStatus] ?? ''),
      amount: parseFloat(String(row[idxAmount] ?? '0')) || 0,
      createdAt: String(row[idxCreatedAt] ?? ''),
    })
  }

  return map
}
