import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/supabase'
import * as XLSX from 'xlsx'

const PAGE_SIZE = 1000

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const partner = searchParams.get('partner')
  const dateFrom = searchParams.get('dateFrom')
  const dateTo = searchParams.get('dateTo')
  const download = searchParams.get('download') === '1'

  if (!partner || !dateFrom || !dateTo) {
    return NextResponse.json({ error: 'Missing partner, dateFrom, or dateTo' }, { status: 400 })
  }

  const utcFrom = new Date(dateFrom + 'T00:00:00.000Z').toISOString()
  const utcTo = new Date(dateTo + 'T23:59:59.999Z').toISOString()

  const supabase = getSupabase()

  // Fetch partner rows (paginated)
  const partnerRows: unknown[] = []
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from('recon_results')
      .select('*')
      .eq('partner', partner)
      .gte('partner_datetime', utcFrom)
      .lte('partner_datetime', utcTo)
      .order('partner_datetime', { ascending: true, nullsFirst: false })
      .range(from, from + PAGE_SIZE - 1)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data || data.length === 0) break
    partnerRows.push(...data)
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }

  // Fetch not_in_partner / manually_resolved rows by internal_updated_at (paginated)
  const internalOnlyRows: unknown[] = []
  let from2 = 0
  while (true) {
    const { data, error } = await supabase
      .from('recon_results')
      .select('*')
      .eq('partner', partner)
      .in('recon_status', ['not_in_partner', 'manually_resolved'])
      .gte('internal_updated_at', utcFrom)
      .lte('internal_updated_at', utcTo)
      .range(from2, from2 + PAGE_SIZE - 1)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data || data.length === 0) break
    internalOnlyRows.push(...data)
    if (data.length < PAGE_SIZE) break
    from2 += PAGE_SIZE
  }

  // Merge, deduplicate by recon_ref
  const seen = new Set<string>()
  const combined = [...partnerRows, ...internalOnlyRows].filter((r) => {
    const row = r as { recon_ref: string }
    if (seen.has(row.recon_ref)) return false
    seen.add(row.recon_ref)
    return true
  }) as Record<string, unknown>[]

  if (download) {
    const excelRows = combined.map((r) => ({
      'Recon Ref': r.recon_ref,
      'Recon Ref 2': r.recon_ref_2 ?? '',
      'Partner': r.partner,
      'Channel': r.channel ?? '',
      'Merchant Name': r.merchant_name ?? '',
      'Parent Merchant Name': r.parent_merchant_name ?? '',
      'Merchant ID': r.merchant_id ?? '',
      'Client Ref ID': r.client_ref_id ?? '',
      'Fee to Merchant': r.fee_to_merchant ?? '',
      'Amount Settle to Merchant': r.amount_settle_to_merchant ?? '',
      'Partner Amount': r.partner_amount ?? '',
      'Internal Amount': r.internal_amount ?? '',
      'Partner Datetime': r.partner_datetime ?? '',
      'Settlement Date (Bank)': r.settlement_date_bank ?? '',
      'Amount Settle from Bank': r.amount_settle_from_bank ?? '',
      'Internal Updated At': r.internal_updated_at ?? '',
      'Internal Status': r.internal_status ?? '',
      'Recon Status': r.recon_status,
      'Last Upload At': r.last_upload_at,
    }))
    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.json_to_sheet(excelRows)
    XLSX.utils.book_append_sheet(wb, ws, 'Reconciliation')
    const excelBuffer = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
    return NextResponse.json({ excelBase64: excelBuffer.toString('base64') })
  }

  const summary = {
    total: combined.length,
    done: combined.filter((r) => r.recon_status === 'done').length,
    status_not_success: combined.filter((r) => r.recon_status === 'status_not_success').length,
    not_in_internal: combined.filter((r) => r.recon_status === 'not_in_internal').length,
    not_in_partner: combined.filter((r) => r.recon_status === 'not_in_partner').length,
    manually_resolved: combined.filter((r) => r.recon_status === 'manually_resolved').length,
  }

  return NextResponse.json({ rows: combined, summary })
}

export async function PATCH(req: NextRequest) {
  const body = await req.json() as { reconRefs: string[]; partner: string }
  const { reconRefs, partner } = body

  if (!reconRefs?.length || !partner) {
    return NextResponse.json({ error: 'Missing reconRefs or partner' }, { status: 400 })
  }

  const { error } = await getSupabase()
    .from('recon_results')
    .update({ recon_status: 'manually_resolved', last_upload_at: new Date().toISOString() })
    .eq('partner', partner)
    .in('recon_ref', reconRefs)
    .not('recon_status', 'eq', 'done')

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ updated: reconRefs.length })
}
