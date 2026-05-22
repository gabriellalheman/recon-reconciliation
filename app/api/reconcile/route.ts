import { NextRequest, NextResponse } from 'next/server'

export const maxDuration = 300
import { getPartner } from '@/lib/partners'
import { parsePartnerFile } from '@/lib/parse'
import { fetchMetabaseRows } from '@/lib/metabase'
import { reconcile } from '@/lib/reconcile'
import { getSupabase } from '@/lib/supabase'
import * as XLSX from 'xlsx'

// Statuses that are considered "resolved" — never downgrade from these
const RESOLVED_STATUSES = new Set(['done', 'status_not_success', 'manually_resolved'])

export async function POST(req: NextRequest) {
  const formData = await req.formData()
  const file = formData.get('file') as File | null
  const partnerId = formData.get('partner') as string | null

  if (!file || !partnerId) {
    return NextResponse.json({ error: 'Missing file or partner' }, { status: 400 })
  }

  const config = getPartner(partnerId)
  if (!config) {
    return NextResponse.json({ error: `Unknown partner: ${partnerId}` }, { status: 400 })
  }

  const buffer = Buffer.from(await file.arrayBuffer())

  // Parse partner file
  let parseResult
  try {
    parseResult = parsePartnerFile(buffer, config)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to parse file' },
      { status: 400 },
    )
  }

  // Fetch internal data from Metabase
  let internalMap
  try {
    internalMap = await fetchMetabaseRows(parseResult.minDate, parseResult.maxDate, config.metabaseRefColumn, config.acquirerValues)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to fetch internal data' },
      { status: 502 },
    )
  }

  // Reconcile
  const rows = reconcile(parseResult.rows, internalMap)

  // Upsert to Supabase with never-downgrade rule
  const uploadedAt = new Date().toISOString()
  const reconRefs = rows.map((r) => r.reconRef)

  const SUPABASE_BATCH = 500

  function chunks<T>(arr: T[], size: number): T[][] {
    const result: T[][] = []
    for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size))
    return result
  }

  let supabaseWarning: string | undefined
  try {
    const supabase = getSupabase()

    // Fetch existing statuses in batches — large IN clauses hang Supabase
    const existingStatusMap = new Map<string, string>()
    for (const batch of chunks(reconRefs, SUPABASE_BATCH)) {
      const { data } = await supabase
        .from('recon_results')
        .select('recon_ref, recon_status')
        .eq('partner', config.partner)
        .in('recon_ref', batch)
      for (const r of data ?? []) existingStatusMap.set(r.recon_ref, r.recon_status)
    }

    const upsertPayload = rows
      .filter((row) => {
        const existing = existingStatusMap.get(row.reconRef)
        // Skip: existing is resolved and new status is not — never downgrade
        if (existing && RESOLVED_STATUSES.has(existing) && !RESOLVED_STATUSES.has(row.status)) {
          return false
        }
        return true
      })
      .map((row) => ({
        recon_ref: row.reconRef,
        partner: config.partner,
        recon_ref_2: row.reconRef2 ?? null,
        channel: row.channel ?? null,
        partner_amount: row.partnerAmount ?? null,
        internal_amount: row.internalAmount ?? null,
        partner_datetime: row.partnerDatetime ?? null,
        internal_updated_at: row.internalUpdatedAt ?? null,
        internal_status: row.internalStatus ?? null,
        recon_status: row.status,
        last_upload_at: uploadedAt,
        merchant_id: row.merchantId ?? null,
        merchant_name: row.merchantName ?? null,
        parent_merchant_name: row.parentMerchantName ?? null,
        client_ref_id: row.clientRefId ?? null,
        fee_to_merchant: row.feeToMerchant ?? null,
        amount_settle_to_merchant: row.amountSettleToMerchant ?? null,
        settlement_date_bank: row.settlementDateBank ?? null,
        amount_settle_from_bank: row.amountSettleFromBank ?? null,
      }))

    // Upsert in batches — single call with 12K rows hangs Supabase
    for (const batch of chunks(upsertPayload, SUPABASE_BATCH)) {
      const { error: upsertError } = await supabase
        .from('recon_results')
        .upsert(batch, { onConflict: 'recon_ref,partner' })
      if (upsertError) {
        supabaseWarning = `Results not saved to DB: ${upsertError.message}`
        break
      }
    }
  } catch (err) {
    supabaseWarning = `Results not saved to DB: ${err instanceof Error ? err.message : 'Supabase unavailable'}`
  }

  // Derive channel for audit log — use config.channel if fixed, else most common channel in rows
  const auditChannel = config.channel ?? (rows.find((r) => r.channel)?.channel ?? null)

  // Insert upload audit log (non-blocking — don't fail the request if this errors)
  getSupabase()
    .from('upload_logs')
    .insert({
      filename: file.name,
      partner: config.partner,
      channel: auditChannel,
      file_date_min: parseResult.minDate.toISOString().slice(0, 10),
      file_date_max: parseResult.maxDate.toISOString().slice(0, 10),
      total_rows: rows.length,
      done: rows.filter((r) => r.status === 'done').length,
      status_not_success: rows.filter((r) => r.status === 'status_not_success').length,
      not_in_internal: rows.filter((r) => r.status === 'not_in_internal').length,
      not_in_partner: rows.filter((r) => r.status === 'not_in_partner').length,
    })
    .then(({ error }) => {
      if (error) console.error('[upload_logs] insert failed:', error.message)
    })

  // Summary counts
  const summary = {
    total: rows.length,
    done: rows.filter((r) => r.status === 'done').length,
    status_not_success: rows.filter((r) => r.status === 'status_not_success').length,
    not_in_internal: rows.filter((r) => r.status === 'not_in_internal').length,
    not_in_partner: rows.filter((r) => r.status === 'not_in_partner').length,
    internalFetched: internalMap.size,
    parseErrors: parseResult.errors,
    dateRange: {
      min: parseResult.minDate.toISOString().slice(0, 10),
      max: parseResult.maxDate.toISOString().slice(0, 10),
    },
  }

  // Build downloadable Excel from current upload rows only
  const excelRows = rows.map((r) => ({
    'Recon Ref': r.reconRef,
    'Recon Ref 2': r.reconRef2 ?? '',
    'Partner': r.partner ?? '',
    'Channel': r.channel ?? '',
    'Merchant ID': r.merchantId ?? '',
    'Merchant Name': r.merchantName ?? '',
    'Parent Merchant Name': r.parentMerchantName ?? '',
    'Client Ref ID': r.clientRefId ?? '',
    'Fee to Merchant': r.feeToMerchant ?? '',
    'Amount Settle to Merchant': r.amountSettleToMerchant ?? '',
    'Partner Amount': r.partnerAmount ?? '',
    'Internal Amount': r.internalAmount ?? '',
    'Partner Datetime': r.partnerDatetime ?? '',
    'Internal Updated At': r.internalUpdatedAt ?? '',
    'Internal Status': r.internalStatus ?? '',
    'Settlement Date (Bank)': r.settlementDateBank ?? '',
    'Amount Settle from Bank': r.amountSettleFromBank ?? '',
    'Recon Status': r.status,
  }))

  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.json_to_sheet(excelRows)
  XLSX.utils.book_append_sheet(wb, ws, 'Reconciliation')
  const excelBuffer = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
  const excelBase64 = excelBuffer.toString('base64')

  return NextResponse.json({ rows, summary, excelBase64, warning: supabaseWarning })
}
