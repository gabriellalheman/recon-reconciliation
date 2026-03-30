export interface PartnerConfig {
  id: string
  label: string
  group: string
  partner: string
  channel: string | null
  headerRow: number     // 0-indexed row index of the header row
  columns: {
    recon_ref: string   // column letter in source file
    recon_ref_2?: string
    amount: string
    datetime: string
    defaultTime?: string
    typeColumn?: string
  }
  typeMapping?: Record<string, string>
  dateFormat: string
  // Only include rows where the resolved channel matches this value (null = include all)
  channelFilter: string | null
  // Metabase: which column in qris_transaction to match against recon_ref
  metabaseRefColumn: 'acquirer_reference_no' | 'issuerInfo_rrn'
  // Metabase: qris.acquirer values to filter by (joined via qris_transaction.qris_id = qris.uuid)
  acquirerValues: string[]
  // If set, pad reconRef with leading zeros to this length before matching
  reconRefPadLength?: number
}

export const PARTNERS: PartnerConfig[] = [
  {
    id: 'bri-qris',
    label: 'BRI — QRIS',
    group: 'BRI',
    partner: 'BRI',
    channel: null,
    headerRow: 3,
    columns: {
      recon_ref: 'P',
      amount: 'I',
      datetime: 'D',
      defaultTime: '0:00 AM',
      typeColumn: 'N',
    },
    typeMapping: {
      'QRIS': 'QRIS',
      '*': 'Card',
    },
    dateFormat: 'yyyy-MM-dd',
    channelFilter: 'QRIS',
    metabaseRefColumn: 'issuerInfo_rrn',
    acquirerValues: ['BRI', 'BRI_QRIS'],
    reconRefPadLength: 12,
  },
  {
    id: 'bnc-qris',
    label: 'BNC — QRIS',
    group: 'BNC',
    partner: 'BNC',
    channel: 'QRIS',
    headerRow: 0,        // row 1 is the header (0-indexed)
    columns: {
      recon_ref: 'G',
      amount: 'M',
      datetime: 'U',
    },
    dateFormat: 'dd/MM/yyyy HH:mm:ss',
    channelFilter: null,
    metabaseRefColumn: 'acquirer_reference_no',
    acquirerValues: ['BNC'],
  },
]

export function getPartner(id: string): PartnerConfig | undefined {
  return PARTNERS.find((p) => p.id === id)
}

export function partnersByGroup(): Record<string, PartnerConfig[]> {
  return PARTNERS.reduce<Record<string, PartnerConfig[]>>((acc, p) => {
    if (!acc[p.group]) acc[p.group] = []
    acc[p.group].push(p)
    return acc
  }, {})
}
