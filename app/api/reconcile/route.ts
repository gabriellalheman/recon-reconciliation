import { NextRequest, NextResponse } from 'next/server'
import { getPartner } from '@/lib/partners'
import { parsePartnerFile } from '@/lib/parse'
import { fetchMetabaseRows } from '@/lib/metabase'
import { reconcile } from '@/lib/reconcile'
import * as XLSX from 'xlsx'

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
    internalMap = await fetchMetabaseRows(parseResult.minDate, parseResult.maxDate, config.metabaseRefColumn)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to fetch internal data' },
      { status: 502 },
    )
  }

  // Reconcile
  const rows = reconcile(parseResult.rows, internalMap)

  // Summary counts
  const summary = {
    total: rows.length,
    done: rows.filter((r) => r.status === 'done').length,
    status_not_success: rows.filter((r) => r.status === 'status_not_success').length,
    not_in_internal: rows.filter((r) => r.status === 'not_in_internal').length,
    not_in_partner: rows.filter((r) => r.status === 'not_in_partner').length,
    parseErrors: parseResult.errors,
    dateRange: {
      min: parseResult.minDate.toISOString().slice(0, 10),
      max: parseResult.maxDate.toISOString().slice(0, 10),
    },
  }

  // Build downloadable Excel
  const excelRows = rows.map((r) => ({
    'Recon Ref': r.reconRef,
    'Recon Ref 2': r.reconRef2 ?? '',
    'Partner': r.partner ?? '',
    'Channel': r.channel ?? '',
    'Partner Amount': r.partnerAmount ?? '',
    'Internal Amount': r.internalAmount ?? '',
    'Partner Datetime': r.partnerDatetime ?? '',
    'Internal Created At': r.internalCreatedAt ?? '',
    'Internal Status': r.internalStatus ?? '',
    'Recon Status': r.status,
  }))

  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.json_to_sheet(excelRows)
  XLSX.utils.book_append_sheet(wb, ws, 'Reconciliation')
  const excelBuffer = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
  const excelBase64 = excelBuffer.toString('base64')

  return NextResponse.json({ rows, summary, excelBase64 })
}
