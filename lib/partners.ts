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
  // Metabase: which column in qris_transaction to match against recon_ref
  metabaseRefColumn: 'acquirer_reference_no' | 'issuerInfo_rrn'
}

export const PARTNERS: PartnerConfig[] = [
  {
    id: 'bri',
    label: 'BRI — QRIS + Card',
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
    metabaseRefColumn: 'issuerInfo_rrn',
  },
  {
    id: 'bnc-qris',
    label: 'BNC — QRIS',
    group: 'BNC',
    partner: 'BNC',
    channel: 'QRIS',
    headerRow: 0,
    columns: {
      recon_ref: 'E',
      amount: 'K',
      datetime: 'P',
    },
    dateFormat: 'dd/MM/yyyy HH:mm:ss',
    metabaseRefColumn: 'acquirer_reference_no',
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
