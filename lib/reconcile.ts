import { ParsedRow } from './parse'
import { MetabaseRow } from './metabase'

export type ReconStatus =
  | 'done'
  | 'status_not_success'
  | 'not_in_internal'
  | 'not_in_partner'
  | 'manually_resolved'

export interface ReconRow {
  source: 'partner' | 'internal'
  reconRef: string
  reconRef2?: string
  partnerAmount?: number
  internalAmount?: number
  partnerDatetime?: string   // ISO string
  internalUpdatedAt?: string
  channel?: string
  partner?: string
  internalStatus?: string
  status: ReconStatus
  merchantId?: string | null
  merchantName?: string | null
  parentMerchantName?: string | null
  clientRefId?: string | null
  feeToMerchant?: number | null
  amountSettleToMerchant?: number | null
  settlementDateBank?: string | null
  amountSettleFromBank?: number | null
}

function isoDate(d: Date): string {
  return d.toISOString()
}

export function reconcile(
  partnerRows: ParsedRow[],
  internalMap: Map<string, MetabaseRow>,
): ReconRow[] {
  const results: ReconRow[] = []
  const matchedInternalRefs = new Set<string>()

  // Step 1: for each partner row, look up in internal data
  for (const row of partnerRows) {
    const internal = internalMap.get(row.reconRef)

    if (!internal) {
      results.push({
        source: 'partner',
        reconRef: row.reconRef,
        reconRef2: row.reconRef2 || undefined,
        partnerAmount: row.amount,
        partnerDatetime: isoDate(row.datetime),
        channel: row.channel,
        partner: row.partner,
        status: 'not_in_internal',
        settlementDateBank: row.settlementDateBank,
        amountSettleFromBank: row.amountSettleFromBank,
      })
      continue
    }

    matchedInternalRefs.add(row.reconRef)

    const reconStatus: ReconStatus =
      internal.status.toUpperCase() === 'SUCCESS' ? 'done' : 'status_not_success'

    results.push({
      source: 'partner',
      reconRef: row.reconRef,
      reconRef2: row.reconRef2 || undefined,
      partnerAmount: row.amount,
      internalAmount: internal.amount,
      partnerDatetime: isoDate(row.datetime),
      internalUpdatedAt: internal.updatedAt,
      channel: row.channel,
      partner: row.partner,
      internalStatus: internal.status,
      status: reconStatus,
      merchantId: internal.merchantId,
      merchantName: internal.merchantName,
      parentMerchantName: internal.parentMerchantName,
      clientRefId: internal.clientRefId,
      feeToMerchant: internal.feeToMerchant,
      amountSettleToMerchant: internal.feeToMerchant != null ? internal.amount - internal.feeToMerchant : null,
      settlementDateBank: row.settlementDateBank,
      amountSettleFromBank: row.amountSettleFromBank,
    })
  }

  // Step 2: internal SUCCESS records not found in partner file → not_in_partner
  // Non-success records absent from partner file are expected and skipped
  for (const [ref, internal] of internalMap.entries()) {
    if (matchedInternalRefs.has(ref)) continue
    if (internal.status.toUpperCase() !== 'SUCCESS') continue

    results.push({
      source: 'internal',
      reconRef: ref,
      internalAmount: internal.amount,
      internalUpdatedAt: internal.updatedAt,
      internalStatus: internal.status,
      status: 'not_in_partner',
      merchantId: internal.merchantId,
      merchantName: internal.merchantName,
      parentMerchantName: internal.parentMerchantName,
      clientRefId: internal.clientRefId,
      feeToMerchant: internal.feeToMerchant,
      amountSettleToMerchant: internal.feeToMerchant != null ? internal.amount - internal.feeToMerchant : null,
    })
  }

  return results
}
