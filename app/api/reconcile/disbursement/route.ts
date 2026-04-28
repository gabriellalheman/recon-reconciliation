import { NextRequest, NextResponse } from 'next/server'
import { parseMt940, fetchDisbursementRecords, reconcileDisbursement } from '@/lib/disbursement'
import { getSupabase } from '@/lib/supabase'
import type { ReconRow } from '@/lib/reconcile'

const PARTNER = 'MANDIRI'

export async function POST(req: NextRequest) {
  const formData = await req.formData()
  const file = formData.get('file') as File | null

  if (!file) {
    return NextResponse.json({ error: 'Missing MT940 file' }, { status: 400 })
  }

  const content = await file.text()

  // Parse MT940
  const { isoDate, refs: mt940Refs } = parseMt940(content)
  if (!isoDate) {
    return NextResponse.json({ error: 'Could not parse statement date from MT940 file' }, { status: 400 })
  }

  // Fetch bank_transfer records from Metabase
  let dbMap
  try {
    dbMap = await fetchDisbursementRecords(isoDate)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to fetch internal data' },
      { status: 502 },
    )
  }

  // Reconcile
  const reconRows = reconcileDisbursement(mt940Refs, dbMap, isoDate)

  // Map to Supabase schema
  const uploadedAt = new Date().toISOString()
  const partnerDatetime = new Date(isoDate + 'T00:00:00.000Z').toISOString()

  const upsertPayload = reconRows.map((row) => ({
    recon_ref: row.partnerExternalId,
    partner: PARTNER,
    recon_ref_2: null,
    channel: 'DISBURSEMENT',
    partner_amount: null,
    internal_amount: row.internalAmount,
    partner_datetime: partnerDatetime,
    internal_updated_at: row.transactionDate,
    internal_status: null,
    recon_status: row.status,
    last_upload_at: uploadedAt,
    merchant_id: null,
    merchant_name: null,
    parent_merchant_name: null,
    client_ref_id: row.remark,
    fee_to_merchant: null,
    amount_settle_to_merchant: null,
    settlement_date_bank: null,
    amount_settle_from_bank: null,
  }))

  const supabase = getSupabase()

  // Never downgrade a manually_resolved row
  const reconRefs = reconRows.map((r) => r.partnerExternalId)
  const { data: existing } = await supabase
    .from('recon_results')
    .select('recon_ref, recon_status')
    .eq('partner', PARTNER)
    .in('recon_ref', reconRefs)

  const existingStatusMap = new Map<string, string>(
    (existing ?? []).map((r) => [r.recon_ref, r.recon_status])
  )

  const filtered = upsertPayload.filter((row) => {
    const existing = existingStatusMap.get(row.recon_ref)
    return !(existing === 'manually_resolved' && row.recon_status !== 'done')
  })

  if (filtered.length > 0) {
    const { error } = await supabase
      .from('recon_results')
      .upsert(filtered, { onConflict: 'recon_ref,partner' })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
  }

  // Map to ReconRow shape for the UI table
  const rows: ReconRow[] = reconRows.map((row) => ({
    source: row.status === 'not_in_internal' ? 'internal' : 'partner',
    reconRef: row.partnerExternalId,
    internalAmount: row.internalAmount ?? undefined,
    internalUpdatedAt: row.transactionDate ?? undefined,
    channel: 'DISBURSEMENT',
    partner: PARTNER,
    clientRefId: row.remark ?? null,
    status: row.status,
  }))

  const summary = {
    total: rows.length,
    done: rows.filter((r) => r.status === 'done').length,
    status_not_success: 0,
    not_in_internal: rows.filter((r) => r.status === 'not_in_internal').length,
    not_in_partner: rows.filter((r) => r.status === 'not_in_partner').length,
    dateRange: { min: isoDate, max: isoDate },
  }

  return NextResponse.json({ rows, summary })
}
