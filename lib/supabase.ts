import { createClient, SupabaseClient } from '@supabase/supabase-js'

let _client: SupabaseClient | null = null

export function getSupabase(): SupabaseClient {
  if (!_client) {
    const url = process.env.SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
    _client = createClient(url, key)
  }
  return _client
}

export interface ReconResultRow {
  recon_ref: string
  partner: string
  recon_ref_2: string | null
  channel: string | null
  partner_amount: number | null
  internal_amount: number | null
  partner_datetime: string | null
  internal_updated_at: string | null
  internal_status: string | null
  recon_status: string
  last_upload_at: string
  created_at: string
  merchant_id: string | null
  merchant_name: string | null
  parent_merchant_name: string | null
  client_ref_id: string | null
  fee_to_merchant: number | null
  amount_settle_to_merchant: number | null
  settlement_date_bank: string | null
  amount_settle_from_bank: number | null
}
