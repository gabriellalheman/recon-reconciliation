import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/supabase'

const RETENTION_DAYS = 90

export async function GET(req: NextRequest) {
  const secret = req.headers.get('authorization')?.replace('Bearer ', '')
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS)

  const { error, count } = await getSupabase()
    .from('recon_results')
    .delete({ count: 'exact' })
    .lt('last_upload_at', cutoff.toISOString())

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ deleted: count, cutoff: cutoff.toISOString() })
}
