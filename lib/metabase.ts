// Metabase query layer — fetches qris_transaction records for a date range
// and returns a lookup map keyed by the relevant recon reference.
// Database: [Prod] Snap Core Processor (ID 5) + [Prod] Backend Portal (ID 2)
//
// Snap query is split into daily UTC windows run in parallel to avoid the
// Cloudflare 100s origin timeout that a wide date-range query would hit.

export type MetabaseRefColumn = 'acquirer_reference_no' | 'issuerInfo_rrn'

const GMT7_OFFSET_MS = 7 * 60 * 60 * 1000
const DAY_MS = 86400000
const FEE_BATCH_SIZE = 2000
const SNAP_CONCURRENCY = 3  // max parallel daily-window queries to Metabase
const FEE_CONCURRENCY  = 3  // max parallel fee-batch queries to Metabase

async function withConcurrency<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let idx = 0
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++
      results[i] = await tasks[i]()
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
  return results
}

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

function fmt(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

function buildSnapQuery(start: string, end: string, refColumn: MetabaseRefColumn, acquirerValues: string[]): string {
  const acquirerList = acquirerValues.map((v) => `'${v}'`).join(', ')

  if (refColumn === 'acquirer_reference_no') {
    // STRAIGHT_JOIN forces qris (acquirer-filtered, small set) to drive the join
    // instead of qris_transaction (full date-range scan, very large).
    return `
      SELECT STRAIGHT_JOIN
        qt.uuid AS transaction_uuid,
        q.acquirer_reference_no AS recon_ref,
        CASE WHEN q.qr_type = 'DYNAMIC' THEN q.status ELSE qt.status END AS status,
        JSON_UNQUOTE(JSON_EXTRACT(q.amount, '$.value')) AS amount_value,
        qt.updated_at,
        q.originator_reference_no
      FROM qris q
      JOIN qris_transaction qt ON qt.qris_id = q.uuid
      WHERE q.acquirer IN (${acquirerList})
        AND q.acquirer_reference_no IS NOT NULL
        AND q.acquirer_reference_no != ''
        AND qt.created_at >= '${start}'
        AND qt.created_at < '${end}'
      LIMIT 100000
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

async function runQuery(
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

  // Split the full UTC window into 24h slices and run them in parallel.
  // Each slice completes well within Cloudflare's 100s origin timeout.
  const utcStart = new Date(minDate.getTime() - GMT7_OFFSET_MS)
  const utcEnd   = new Date(maxDate.getTime() + DAY_MS - GMT7_OFFSET_MS)

  const windows: { start: string; end: string }[] = []
  let cur = new Date(utcStart)
  while (cur < utcEnd) {
    const next = new Date(Math.min(cur.getTime() + DAY_MS, utcEnd.getTime()))
    windows.push({ start: fmt(cur), end: fmt(next) })
    cur = next
  }

  const snapResults = await withConcurrency(
    windows.map(({ start, end }) => () =>
      runQuery(baseUrl, headers, 5, buildSnapQuery(start, end, refColumn, acquirerValues))
    ),
    SNAP_CONCURRENCY,
  )

  // Build initial map and collect UUIDs for the fee lookup
  const map = new Map<string, MetabaseRow>()
  const uuidToRef = new Map<string, string>()

  for (const snapData of snapResults) {
    const snapCols = snapData.cols.map((c) => c.name)
    const idxUuid        = snapCols.indexOf('transaction_uuid')
    const idxRef         = snapCols.indexOf('recon_ref')
    const idxStatus      = snapCols.indexOf('status')
    const idxAmount      = snapCols.indexOf('amount_value')
    const idxUpdatedAt   = snapCols.indexOf('updated_at')
    const idxOriginator  = snapCols.indexOf('originator_reference_no')

    for (const row of snapData.rows) {
      const reconRef = String(row[idxRef] ?? '').trim()
      if (!reconRef) continue

      const uuid = idxUuid >= 0 && row[idxUuid] != null ? String(row[idxUuid]) : null

      map.set(reconRef, {
        reconRef,
        status: String(row[idxStatus] ?? ''),
        amount: parseFloat(String(row[idxAmount] ?? '0')) || 0,
        updatedAt: String(row[idxUpdatedAt] ?? ''),
        clientRefId: idxOriginator >= 0 && row[idxOriginator] != null ? String(row[idxOriginator]) : null,
        merchantId: null,
        merchantName: null,
        parentMerchantName: null,
        feeToMerchant: null,
      })

      if (uuid) {
        uuidToRef.set(uuid, reconRef)
      }
    }
  }

  if (uuidToRef.size === 0) {
    return map
  }

  // Query 2: Fee + merchant data from Backend Portal (DB 2) — targeted by UUIDs, parallel batches
  const allUuids = Array.from(uuidToRef.keys())
  const batches: string[][] = []
  for (let i = 0; i < allUuids.length; i += FEE_BATCH_SIZE) {
    batches.push(allUuids.slice(i, i + FEE_BATCH_SIZE))
  }

  await withConcurrency(batches.map((batch) => async () => {
    const feeData = await runQuery(baseUrl, headers, 2, buildFeeQuery(batch))

    const feeCols             = feeData.cols.map((c) => c.name)
    const idxFeeUuid          = feeCols.indexOf('transaction_uuid')
    const idxMerchantId       = feeCols.indexOf('merchant_id')
    const idxMerchantName     = feeCols.indexOf('merchant_name')
    const idxParentMerchant   = feeCols.indexOf('parent_merchant_name')
    const idxFeeToMerchant    = feeCols.indexOf('fee_to_merchant')

    for (const row of feeData.rows) {
      const uuid = idxFeeUuid >= 0 && row[idxFeeUuid] != null ? String(row[idxFeeUuid]) : null
      if (!uuid) continue
      const reconRef = uuidToRef.get(uuid)
      if (!reconRef) continue
      const entry = map.get(reconRef)
      if (!entry) continue

      entry.merchantId        = idxMerchantId >= 0 && row[idxMerchantId] != null ? String(row[idxMerchantId]) : null
      entry.merchantName      = idxMerchantName >= 0 && row[idxMerchantName] != null ? String(row[idxMerchantName]) : null
      entry.parentMerchantName = idxParentMerchant >= 0 && row[idxParentMerchant] != null ? String(row[idxParentMerchant]) : null
      entry.feeToMerchant     = idxFeeToMerchant >= 0 && row[idxFeeToMerchant] != null ? parseFloat(String(row[idxFeeToMerchant])) || 0 : null
    }
  }), FEE_CONCURRENCY)

  return map
}
