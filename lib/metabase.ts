// Metabase query layer — fetches qris_transaction records for a date range
// and returns a lookup map keyed by the relevant recon reference.
// Database: data-team-production (ID 8, BigQuery) — datasets snap_core_processor + backend_portal

export type MetabaseRefColumn = 'acquirer_reference_no' | 'issuerInfo_rrn'

const GMT7_OFFSET_MS = 7 * 60 * 60 * 1000
const DAY_MS = 86400000
const FETCH_TIMEOUT_MS = 90_000

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
    return `
      SELECT
        qt.uuid AS transaction_uuid,
        q.acquirer_reference_no AS recon_ref,
        CASE WHEN q.qr_type = 'DYNAMIC' THEN q.status ELSE qt.status END AS status,
        JSON_VALUE(q.amount, '$.value') AS amount_value,
        qt.updated_at,
        q.originator_reference_no
      FROM \`data-team-production.snap_core_processor.qris\` q
      JOIN \`data-team-production.snap_core_processor.qris_transaction\` qt ON qt.qris_id = q.uuid
      WHERE q.acquirer IN (${acquirerList})
        AND q.acquirer_reference_no IS NOT NULL
        AND q.acquirer_reference_no != ''
        AND qt.created_at >= TIMESTAMP('${start}')
        AND qt.created_at < TIMESTAMP('${end}')
      LIMIT 100000
    `.trim()
  } else {
    return `
      SELECT
        qt.uuid AS transaction_uuid,
        COALESCE(
          JSON_VALUE(q.additional_info, '$.issuerInfo.rrn'),
          JSON_VALUE(q.additional_info, '$.issuerRrn')
        ) AS recon_ref,
        CASE WHEN q.qr_type = 'DYNAMIC' THEN q.status ELSE qt.status END AS status,
        JSON_VALUE(q.amount, '$.value') AS amount_value,
        qt.updated_at,
        q.originator_reference_no
      FROM \`data-team-production.snap_core_processor.qris_transaction\` qt
      JOIN \`data-team-production.snap_core_processor.qris\` q ON q.uuid = qt.qris_id
      WHERE qt.updated_at >= TIMESTAMP('${start}')
        AND qt.updated_at < TIMESTAMP('${end}')
        AND COALESCE(
          JSON_VALUE(q.additional_info, '$.issuerInfo.rrn'),
          JSON_VALUE(q.additional_info, '$.issuerRrn')
        ) IS NOT NULL
        AND q.acquirer IN (${acquirerList})
      LIMIT 100000
    `.trim()
  }
}

function buildFeeQuery(start: string, end: string): string {
  return `
    SELECT
      at2.processor_transaction_id AS transaction_uuid,
      at2.merchant_id,
      m.name AS merchant_name,
      pm.name AS parent_merchant_name,
      ROUND(CAST(JSON_VALUE(at2.additional_info, '$.feeDetail.finalAmount') AS FLOAT64), 0) AS fee_to_merchant
    FROM \`data-team-production.backend_portal.account_transactions\` at2
    LEFT JOIN \`data-team-production.backend_portal.merchants\` m ON at2.merchant_id = m.uuid
    LEFT JOIN \`data-team-production.backend_portal.merchants\` pm ON m.parent_id = pm.uuid
    WHERE at2.transaction_timestamp >= TIMESTAMP('${start}')
      AND at2.transaction_timestamp < TIMESTAMP('${end}')
      AND at2.type = 'PAYMENT'
      AND at2.channel IN ('QRIS', 'QR')
  `.trim()
}

async function runQuery(
  baseUrl: string,
  headers: Record<string, string>,
  query: string,
): Promise<{ rows: unknown[][]; cols: { name: string }[] }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  let res: Response
  try {
    res = await fetch(`${baseUrl}/api/dataset`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        database: 8,
        type: 'native',
        native: { query },
        constraints: { 'max-results': 1000000, 'max-results-bare-rows': 1000000 },
      }),
    })
  } catch (err) {
    clearTimeout(timer)
    if ((err as Error).name === 'AbortError') {
      throw new Error(`Metabase request timed out after ${FETCH_TIMEOUT_MS / 1000}s`)
    }
    throw err
  }
  clearTimeout(timer)

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

  const utcStart = fmt(new Date(minDate.getTime() - GMT7_OFFSET_MS))
  const utcEnd   = fmt(new Date(maxDate.getTime() + DAY_MS - GMT7_OFFSET_MS))

  // Query 1: Snap data (snap_core_processor)
  const snapData = await runQuery(baseUrl, headers, buildSnapQuery(utcStart, utcEnd, refColumn, acquirerValues))

  const map = new Map<string, MetabaseRow>()
  const uuidToRef = new Map<string, string>()

  const snapCols    = snapData.cols.map((c) => c.name)
  const idxUuid     = snapCols.indexOf('transaction_uuid')
  const idxRef      = snapCols.indexOf('recon_ref')
  const idxStatus   = snapCols.indexOf('status')
  const idxAmount   = snapCols.indexOf('amount_value')
  const idxUpdatedAt = snapCols.indexOf('updated_at')
  const idxOriginator = snapCols.indexOf('originator_reference_no')

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

  if (uuidToRef.size === 0) {
    return map
  }

  // Query 2: Fee + merchant data (backend_portal) — matched in-memory via uuidToRef
  const feeData = await runQuery(baseUrl, headers, buildFeeQuery(utcStart, utcEnd))

  const feeCols        = feeData.cols.map((c) => c.name)
  const idxFeeUuid     = feeCols.indexOf('transaction_uuid')
  const idxMerchantId  = feeCols.indexOf('merchant_id')
  const idxMerchantName   = feeCols.indexOf('merchant_name')
  const idxParentMerchant = feeCols.indexOf('parent_merchant_name')
  const idxFeeToMerchant  = feeCols.indexOf('fee_to_merchant')

  for (const row of feeData.rows) {
    const uuid = idxFeeUuid >= 0 && row[idxFeeUuid] != null ? String(row[idxFeeUuid]) : null
    if (!uuid) continue
    const reconRef = uuidToRef.get(uuid)
    if (!reconRef) continue
    const entry = map.get(reconRef)
    if (!entry) continue

    entry.merchantId         = idxMerchantId >= 0 && row[idxMerchantId] != null ? String(row[idxMerchantId]) : null
    entry.merchantName       = idxMerchantName >= 0 && row[idxMerchantName] != null ? String(row[idxMerchantName]) : null
    entry.parentMerchantName = idxParentMerchant >= 0 && row[idxParentMerchant] != null ? String(row[idxParentMerchant]) : null
    entry.feeToMerchant      = idxFeeToMerchant >= 0 && row[idxFeeToMerchant] != null ? parseFloat(String(row[idxFeeToMerchant])) || 0 : null
  }

  return map
}
