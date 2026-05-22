import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/supabase'
import * as XLSX from 'xlsx'

const PAGE_SIZE = 1000

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const channel = searchParams.get('channel') || null
  const dateFrom = searchParams.get('dateFrom')
  const dateTo = searchParams.get('dateTo')
  const download = searchParams.get('download') === '1'

  if (!dateFrom || !dateTo) {
    return NextResponse.json({ error: 'Missing dateFrom or dateTo' }, { status: 400 })
  }

  const utcFrom = new Date(dateFrom + 'T00:00:00+07:00').toISOString()
  const utcTo = new Date(dateTo + 'T23:59:59+07:00').toISOString()

  const supabase = getSupabase()

  const combined: unknown[] = []
  let from = 0
  while (true) {
    let query = supabase
      .from('recon_results')
      .select('*')
      .gte('internal_updated_at', utcFrom)
      .lte('internal_updated_at', utcTo)
      .order('internal_updated_at', { ascending: true, nullsFirst: false })
      .range(from, from + PAGE_SIZE - 1)
    if (channel) query = query.eq('channel', channel)
    const { data, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data || data.length === 0) break
    combined.push(...data)
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }

  const rows = combined as Record<string, unknown>[]

  if (download) {
    const excelRows = rows.map((r) => ({
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
    total: rows.length,
    done: rows.filter((r) => r.recon_status === 'done').length,
    status_not_success: rows.filter((r) => r.recon_status === 'status_not_success').length,
    not_in_internal: rows.filter((r) => r.recon_status === 'not_in_internal').length,
    not_in_partner: rows.filter((r) => r.recon_status === 'not_in_partner').length,
    manually_resolved: rows.filter((r) => r.recon_status === 'manually_resolved').length,
  }

  return NextResponse.json({ rows, summary })
}

export async function PATCH(req: NextRequest) {
  const body = await req.json() as { reconRefs: string[] }
  const { reconRefs } = body

  if (!reconRefs?.length) {
    return NextResponse.json({ error: 'Missing reconRefs' }, { status: 400 })
  }

  const { error } = await getSupabase()
    .from('recon_results')
    .update({ recon_status: 'manually_resolved', last_upload_at: new Date().toISOString() })
    .in('recon_ref', reconRefs)
    .not('recon_status', 'eq', 'done')

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ updated: reconRefs.length })
}
