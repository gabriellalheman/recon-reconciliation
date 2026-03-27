import { ParsedRow } from './parse'
import { MetabaseRow } from './metabase'

export type ReconStatus =
  | 'done'
  | 'status_not_success'
  | 'not_in_internal'
  | 'not_in_partner'

export interface ReconRow {
  source: 'partner' | 'internal'
  reconRef: string
  reconRef2?: string
  partnerAmount?: number
  internalAmount?: number
  partnerDatetime?: string   // ISO string
  internalCreatedAt?: string
  channel?: string
  partner?: string
  internalStatus?: string
  status: ReconStatus
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
      internalCreatedAt: internal.createdAt,
      channel: row.channel,
      partner: row.partner,
      internalStatus: internal.status,
      status: reconStatus,
    })
  }

  // Step 2: internal records not found in partner file
  for (const [ref, internal] of internalMap.entries()) {
    if (matchedInternalRefs.has(ref)) continue

    results.push({
      source: 'internal',
      reconRef: ref,
      internalAmount: internal.amount,
      internalCreatedAt: internal.createdAt,
      internalStatus: internal.status,
      status: 'not_in_partner',
    })
  }

  return results
}
