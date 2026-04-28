// Metabase query layer — fetches qris_transaction records for a date range
// and returns a lookup map keyed by the relevant recon reference.
// Database: [Prod] Snap Core Processor (ID 5) + [Prod] Backend Portal (ID 2)
//
// Split into two queries to avoid slow cross-database JOIN on account_transactions:
//   Query 1 (DB 5): QRIS + qris_transaction — fast, single-DB, indexed updated_at
//   Query 2 (DB 2): account_transactions + merchants — targeted by specific UUIDs

export type MetabaseRefColumn = 'acquirer_reference_no' | 'issuerInfo_rrn'

const GMT7_OFFSET_MS = 7 * 60 * 60 * 1000
const DAY_MS = 86400000
const FEE_BATCH_SIZE = 2000

export interface MetabaseRow {
  reconRef: string
  status: string
  amount: number
  updatedAt: string
  merchantId: string | null
  merchantName: string | null
  parentMerchantName: string | null
  clientRefId: string | null
  feeToMerchant: number | null
}

function buildSnapQuery(minDate: Date, maxDate: Date, refColumn: MetabaseRefColumn, acquirerValues: string[]): string {
  const utcStart = new Date(minDate.getTime() - GMT7_OFFSET_MS)
  const utcEnd   = new Date(maxDate.getTime() + DAY_MS - GMT7_OFFSET_MS)
  const fmt = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ')
  const start = fmt(utcStart)
  const end   = fmt(utcEnd)
  const acquirerList = acquirerValues.map((v) => `'${v}'`).join(', ')

  if (refColumn === 'acquirer_reference_no') {
    return `
      SELECT
        qt.uuid AS transaction_uuid,
        q.acquirer_reference_no AS recon_ref,
        CASE WHEN q.qr_type = 'DYNAMIC' THEN q.status ELSE qt.status END AS status,
        JSON_UNQUOTE(JSON_EXTRACT(q.amount, '$.value')) AS amount_value,
        qt.updated_at,
        q.originator_reference_no
      FROM qris_transaction qt
      JOIN qris q ON q.uuid = qt.qris_id
      WHERE qt.updated_at >= '${start}'
        AND qt.updated_at < '${end}'
        AND q.acquirer_reference_no IS NOT NULL
        AND q.acquirer_reference_no != ''
        AND q.acquirer IN (${acquirerList})
    `.trim()
  } else {
    return `
      SELECT
        qt.uuid AS transaction_uuid,
        COALESCE(
          JSON_UNQUOTE(JSON_EXTRACT(q.additional_info, '$.issuerInfo.rrn')),
          JSON_UNQUOTE(JSON_EXTRACT(q.additional_info, '$.issuerRrn'))
        ) AS recon_ref,
        CASE WHEN q.qr_type = 'DYNAMIC' THEN q.status ELSE qt.status END AS status,
        JSON_UNQUOTE(JSON_EXTRACT(q.amount, '$.value')) AS amount_value,
        qt.updated_at,
        q.originator_reference_no
      FROM qris_transaction qt
      JOIN qris q ON q.uuid = qt.qris_id
      WHERE qt.updated_at >= '${start}'
        AND qt.updated_at < '${end}'
        AND COALESCE(
          JSON_EXTRACT(q.additional_info, '$.issuerInfo.rrn'),
          JSON_EXTRACT(q.additional_info, '$.issuerRrn')
        ) IS NOT NULL
        AND q.acquirer IN (${acquirerList})
      LIMIT 100000
    `.trim()
  }
}

function buildFeeQuery(uuids: string[]): string {
  const list = uuids.map((u) => `'${u}'`).join(', ')
  return `
    SELECT
      at2.processor_transaction_id AS transaction_uuid,
      at2.merchant_id,
      m.name AS merchant_name,
      pm.name AS parent_merchant_name,
      ROUND(JSON_UNQUOTE(JSON_EXTRACT(at2.additional_info, '$.feeDetail.finalAmount')), 0) AS fee_to_merchant
    FROM account_transactions at2
    LEFT JOIN merchants m ON at2.merchant_id = m.uuid
    LEFT JOIN merchants pm ON m.parent_id = pm.uuid
    WHERE at2.processor_transaction_id IN (${list})
  `.trim()
}

async function runQuery<T>(
  baseUrl: string,
  headers: Record<string, string>,
  database: number,
  query: string,
): Promise<{ rows: unknown[][]; cols: { name: string }[] }> {
  const res = await fetch(`${baseUrl}/api/dataset`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      database,
      type: 'native',
      native: { query },
      constraints: { 'max-results': 1000000, 'max-results-bare-rows': 1000000 },
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

  return result.data
}

export async function fetchMetabaseRows(
  minDate: Date,
  maxDate: Date,
  refColumn: MetabaseRefColumn,
  acquirerValues: string[],
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

  // Query 1: QRIS data from Snap Core Processor (DB 5) — no cross-DB joins
  const snapQuery = buildSnapQuery(minDate, maxDate, refColumn, acquirerValues)
  const snapData = await runQuery(baseUrl, headers, 5, snapQuery)

  const snapCols = snapData.cols.map((c) => c.name)
  const idxUuid = snapCols.indexOf('transaction_uuid')
  const idxRef = snapCols.indexOf('recon_ref')
  const idxStatus = snapCols.indexOf('status')
  const idxAmount = snapCols.indexOf('amount_value')
  const idxUpdatedAt = snapCols.indexOf('updated_at')
  const idxOriginatorRef = snapCols.indexOf('originator_reference_no')

  // Build initial map and collect UUIDs for the fee lookup
  const map = new Map<string, MetabaseRow>()
  const uuidToRef = new Map<string, string>()

  for (const row of snapData.rows) {
    const reconRef = String(row[idxRef] ?? '').trim()
    if (!reconRef) continue

    const uuid = idxUuid >= 0 && row[idxUuid] != null ? String(row[idxUuid]) : null

    map.set(reconRef, {
      reconRef,
      status: String(row[idxStatus] ?? ''),
      amount: parseFloat(String(row[idxAmount] ?? '0')) || 0,
      updatedAt: String(row[idxUpdatedAt] ?? ''),
      clientRefId: idxOriginatorRef >= 0 && row[idxOriginatorRef] != null ? String(row[idxOriginatorRef]) : null,
      merchantId: null,
      merchantName: null,
      parentMerchantName: null,
      feeToMerchant: null,
    })

    if (uuid) {
      uuidToRef.set(uuid, reconRef)
    }
  }

  if (uuidToRef.size === 0) {
    return map
  }

  // Query 2: Fee + merchant data from Backend Portal (DB 2) — targeted by UUIDs
  const allUuids = Array.from(uuidToRef.keys())
  const batches: string[][] = []
  for (let i = 0; i < allUuids.length; i += FEE_BATCH_SIZE) {
    batches.push(allUuids.slice(i, i + FEE_BATCH_SIZE))
  }

  for (const batch of batches) {
    const feeQuery = buildFeeQuery(batch)
    const feeData = await runQuery(baseUrl, headers, 2, feeQuery)

    const feeCols = feeData.cols.map((c) => c.name)
    const idxFeeUuid = feeCols.indexOf('transaction_uuid')
    const idxMerchantId = feeCols.indexOf('merchant_id')
    const idxMerchantName = feeCols.indexOf('merchant_name')
    const idxParentMerchantName = feeCols.indexOf('parent_merchant_name')
    const idxFeeToMerchant = feeCols.indexOf('fee_to_merchant')

    for (const row of feeData.rows) {
      const uuid = idxFeeUuid >= 0 && row[idxFeeUuid] != null ? String(row[idxFeeUuid]) : null
      if (!uuid) continue

      const reconRef = uuidToRef.get(uuid)
      if (!reconRef) continue

      const entry = map.get(reconRef)
      if (!entry) continue

      entry.merchantId = idxMerchantId >= 0 && row[idxMerchantId] != null ? String(row[idxMerchantId]) : null
      entry.merchantName = idxMerchantName >= 0 && row[idxMerchantName] != null ? String(row[idxMerchantName]) : null
      entry.parentMerchantName = idxParentMerchantName >= 0 && row[idxParentMerchantName] != null ? String(row[idxParentMerchantName]) : null
      entry.feeToMerchant = idxFeeToMerchant >= 0 && row[idxFeeToMerchant] != null ? parseFloat(String(row[idxFeeToMerchant])) || 0 : null
    }
  }

  return map
}
