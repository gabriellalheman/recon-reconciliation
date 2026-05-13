'use client'

import { useState, useRef } from 'react'
import { PARTNERS, partnersByGroup } from '@/lib/partners'
import type { ReconRow, ReconStatus } from '@/lib/reconcile'

interface Summary {
  total: number
  done: number
  status_not_success: number
  not_in_internal: number
  not_in_partner: number
  manually_resolved?: number
  parseErrors?: { row: number; message: string }[]
  dateRange?: { min: string; max: string }
}

interface ApiResponse {
  rows: ReconRow[]
  summary: Summary
  excelBase64: string
  error?: string
  warning?: string
}

interface DbRow {
  recon_ref: string
  recon_ref_2: string | null
  partner: string
  channel: string | null
  partner_amount: number | null
  internal_amount: number | null
  partner_datetime: string | null
  internal_updated_at: string | null
  internal_status: string | null
  recon_status: ReconStatus
  last_upload_at: string
  merchant_id: string | null
  merchant_name: string | null
  parent_merchant_name: string | null
  client_ref_id: string | null
  fee_to_merchant: number | null
  amount_settle_to_merchant: number | null
  settlement_date_bank: string | null
  amount_settle_from_bank: number | null
}

interface ResultsResponse {
  rows: DbRow[]
  summary: Summary
  error?: string
}

const STATUS_LABELS: Record<ReconStatus, string> = {
  done: 'Done',
  status_not_success: 'Status Not Success',
  not_in_internal: 'Not in Internal',
  not_in_partner: 'Not in Partner',
  manually_resolved: 'Manually Resolved',
}

const STATUS_STYLES: Record<ReconStatus, string> = {
  done: 'bg-green-100 text-green-800',
  status_not_success: 'bg-yellow-100 text-yellow-800',
  not_in_internal: 'bg-red-100 text-red-700',
  not_in_partner: 'bg-orange-100 text-orange-700',
  manually_resolved: 'bg-slate-100 text-slate-600',
}

const STATUS_CHIP_ACTIVE: Record<ReconStatus, string> = {
  done: 'bg-green-600 text-white',
  status_not_success: 'bg-yellow-500 text-white',
  not_in_internal: 'bg-red-600 text-white',
  not_in_partner: 'bg-orange-500 text-white',
  manually_resolved: 'bg-slate-500 text-white',
}

const STATUS_CHIP_INACTIVE: Record<ReconStatus, string> = {
  done: 'bg-green-50 text-green-700 border border-green-200',
  status_not_success: 'bg-yellow-50 text-yellow-700 border border-yellow-200',
  not_in_internal: 'bg-red-50 text-red-700 border border-red-200',
  not_in_partner: 'bg-orange-50 text-orange-700 border border-orange-200',
  manually_resolved: 'bg-slate-50 text-slate-600 border border-slate-200',
}

function formatDate(iso: string | undefined | null): string {
  if (!iso) return '—'
  return iso.replace('T', ' ').slice(0, 19)
}

function formatAmount(v: number | undefined | null): string {
  if (v === undefined || v === null) return '—'
  return v.toLocaleString('id-ID')
}

function StatusChips({
  summary,
  activeFilters,
  onToggle,
  onClear,
}: {
  summary: Summary
  activeFilters: Set<ReconStatus>
  onToggle: (s: ReconStatus) => void
  onClear: () => void
}) {
  const counts: Record<ReconStatus, number> = {
    done: summary.done,
    status_not_success: summary.status_not_success,
    not_in_internal: summary.not_in_internal,
    not_in_partner: summary.not_in_partner,
    manually_resolved: summary.manually_resolved ?? 0,
  }
  return (
    <div className="flex flex-wrap gap-2">
      {(Object.keys(STATUS_LABELS) as ReconStatus[]).map((status) => {
        const isActive = activeFilters.has(status)
        return (
          <button
            key={status}
            onClick={() => onToggle(status)}
            className={`inline-flex items-center gap-1.5 px-3 h-8 rounded-full text-xs font-medium transition-colors ${
              isActive ? STATUS_CHIP_ACTIVE[status] : STATUS_CHIP_INACTIVE[status]
            }`}
          >
            {STATUS_LABELS[status]}
            <span className={`inline-flex items-center justify-center rounded-full w-4 h-4 text-[10px] font-bold ${
              isActive ? 'bg-white/25' : 'bg-white/60'
            }`}>
              {counts[status]}
            </span>
          </button>
        )
      })}
      {activeFilters.size > 0 && (
        <button
          onClick={onClear}
          className="inline-flex items-center px-3 h-8 rounded-full text-xs font-medium text-slate-500 border border-slate-200 hover:bg-slate-50"
        >
          Clear filters
        </button>
      )}
    </div>
  )
}

function ReconTable({
  rows,
  activeFilters,
  search,
  totalRows,
  selectable,
  selectedRefs,
  onToggleSelect,
  onToggleSelectAll,
}: {
  rows: (ReconRow | DbRow)[]
  activeFilters: Set<ReconStatus>
  search: string
  totalRows: number
  selectable?: boolean
  selectedRefs?: Set<string>
  onToggleSelect?: (ref: string) => void
  onToggleSelectAll?: (refs: string[]) => void
}) {
  const isDbRow = (r: ReconRow | DbRow): r is DbRow => 'recon_status' in r
  const getStatus = (r: ReconRow | DbRow): ReconStatus =>
    isDbRow(r) ? r.recon_status as ReconStatus : r.status
  const getRef = (r: ReconRow | DbRow) => isDbRow(r) ? r.recon_ref : r.reconRef
  const getRef2 = (r: ReconRow | DbRow) => isDbRow(r) ? r.recon_ref_2 : r.reconRef2
  const getPartner = (r: ReconRow | DbRow) => r.partner
  const getChannel = (r: ReconRow | DbRow) => r.channel
  const getPartnerAmt = (r: ReconRow | DbRow) => isDbRow(r) ? r.partner_amount : r.partnerAmount
  const getInternalAmt = (r: ReconRow | DbRow) => isDbRow(r) ? r.internal_amount : r.internalAmount
  const getPartnerDate = (r: ReconRow | DbRow) => isDbRow(r) ? r.partner_datetime : r.partnerDatetime
  const getInternalDate = (r: ReconRow | DbRow) => isDbRow(r) ? r.internal_updated_at : r.internalUpdatedAt
  const getInternalStatus = (r: ReconRow | DbRow) => isDbRow(r) ? r.internal_status : r.internalStatus
  const getMerchantId = (r: ReconRow | DbRow) => isDbRow(r) ? r.merchant_id : r.merchantId
  const getMerchantName = (r: ReconRow | DbRow) => isDbRow(r) ? r.merchant_name : r.merchantName
  const getClientRefId = (r: ReconRow | DbRow) => isDbRow(r) ? r.client_ref_id : r.clientRefId
  const getSettlementDate = (r: ReconRow | DbRow) => isDbRow(r) ? r.settlement_date_bank : r.settlementDateBank
  const getParentMerchantName = (r: ReconRow | DbRow) => isDbRow(r) ? r.parent_merchant_name : r.parentMerchantName
  const getFeeToMerchant = (r: ReconRow | DbRow) => isDbRow(r) ? r.fee_to_merchant : r.feeToMerchant
  const getAmountSettleToMerchant = (r: ReconRow | DbRow) => isDbRow(r) ? r.amount_settle_to_merchant : r.amountSettleToMerchant
  const getAmountSettleFromBank = (r: ReconRow | DbRow) => isDbRow(r) ? r.amount_settle_from_bank : r.amountSettleFromBank
  const isSelectable = (r: ReconRow | DbRow) => {
    const s = getStatus(r)
    return s !== 'done' && s !== 'manually_resolved'
  }

  const filtered = rows.filter((r) => {
    if (activeFilters.size > 0 && !activeFilters.has(getStatus(r))) return false
    if (search) {
      const ref = getRef(r).toLowerCase()
      if (!ref.includes(search.toLowerCase())) return false
    }
    return true
  })

  const selectableRefs = filtered.filter(isSelectable).map(getRef)
  const allSelected = selectableRefs.length > 0 && selectableRefs.every((r) => selectedRefs?.has(r))

  const colSpan = selectable ? 18 : 17

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50">
              {selectable && (
                <th className="px-3 py-3 w-8">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={() => onToggleSelectAll?.(selectableRefs)}
                    className="rounded border-slate-300 cursor-pointer"
                  />
                </th>
              )}
              <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Recon Ref</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Partner</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Channel</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Merchant Name</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Merchant ID</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Client Ref ID</th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wide">Partner Amt</th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wide">Internal Amt</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Partner Date</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Settlement Date (Bank)</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Internal Updated At (UTC)</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Parent Merchant</th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wide">Fee to Merchant</th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wide">Settle to Merchant</th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wide">Settle from Bank</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Internal Status</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Recon Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={colSpan} className="px-4 py-8 text-center text-slate-400 text-sm">
                  No rows match the selected filters
                </td>
              </tr>
            ) : (
              filtered.map((row, i) => {
                const ref = getRef(row)
                const canSelect = selectable && isSelectable(row)
                const isSelected = selectedRefs?.has(ref) ?? false
                return (
                <tr key={i} className={`transition-colors ${isSelected ? 'bg-blue-50' : 'hover:bg-slate-50'}`}>
                  {selectable && (
                    <td className="px-3 py-2.5 w-8">
                      {canSelect && (
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => onToggleSelect?.(ref)}
                          className="rounded border-slate-300 cursor-pointer"
                        />
                      )}
                    </td>
                  )}
                  <td className="px-4 py-2.5 font-mono text-xs text-slate-900 max-w-[180px] truncate" title={ref}>
                    {ref}
                  </td>
                  <td className="px-4 py-2.5 text-slate-900">{getPartner(row) ?? '—'}</td>
                  <td className="px-4 py-2.5 text-slate-900">{getChannel(row) ?? '—'}</td>
                  <td className="px-4 py-2.5 text-slate-900 text-xs max-w-[160px] truncate" title={getMerchantName(row) ?? ''}>
                    {getMerchantName(row) ?? '—'}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-slate-500 max-w-[120px] truncate" title={getMerchantId(row) ?? ''}>
                    {getMerchantId(row) ?? '—'}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-slate-900">
                    {getClientRefId(row) ?? '—'}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-900">
                    {formatAmount(getPartnerAmt(row))}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-900">
                    {formatAmount(getInternalAmt(row))}
                  </td>
                  <td className="px-4 py-2.5 text-slate-900 text-xs whitespace-nowrap">
                    {formatDate(getPartnerDate(row))}
                  </td>
                  <td className="px-4 py-2.5 text-slate-900 text-xs whitespace-nowrap">
                    {getSettlementDate(row) ?? '—'}
                  </td>
                  <td className="px-4 py-2.5 text-slate-900 text-xs whitespace-nowrap">
                    {formatDate(getInternalDate(row))}
                  </td>
                  <td className="px-4 py-2.5 text-slate-900 text-xs max-w-[160px] truncate" title={getParentMerchantName(row) ?? ''}>
                    {getParentMerchantName(row) ?? '—'}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-900">
                    {formatAmount(getFeeToMerchant(row))}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-900">
                    {formatAmount(getAmountSettleToMerchant(row))}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-900">
                    {formatAmount(getAmountSettleFromBank(row))}
                  </td>
                  <td className="px-4 py-2.5 text-slate-900 text-xs">
                    {getInternalStatus(row) ?? '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[getStatus(row)]}`}>
                      {STATUS_LABELS[getStatus(row)]}
                    </span>
                  </td>
                </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
      {filtered.length > 0 && (
        <div className="px-4 py-2 border-t border-slate-100 text-xs text-slate-400">
          Showing {filtered.length} of {totalRows} rows
        </div>
      )}
    </div>
  )
}

export default function Home() {
  const grouped = partnersByGroup()

  // Upload state
  const [partnerId, setPartnerId] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [loading, setLoading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [uploadResult, setUploadResult] = useState<ApiResponse | null>(null)
  const [uploadFilters, setUploadFilters] = useState<Set<ReconStatus>>(new Set())
  const [uploadSearch, setUploadSearch] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Results view state
  const [viewChannel, setViewChannel] = useState('')
  const [viewDateFrom, setViewDateFrom] = useState('')
  const [viewDateTo, setViewDateTo] = useState('')
  const [viewLoading, setViewLoading] = useState(false)
  const [viewError, setViewError] = useState('')
  const [viewResult, setViewResult] = useState<ResultsResponse | null>(null)
  const [viewFilters, setViewFilters] = useState<Set<ReconStatus>>(new Set())
  const [viewSearch, setViewSearch] = useState('')
  const [selectedRefs, setSelectedRefs] = useState<Set<string>>(new Set())
  const [resolving, setResolving] = useState(false)
  const [uploadTableOpen, setUploadTableOpen] = useState(true)
  const [viewTableOpen, setViewTableOpen] = useState(true)

  // Disbursement upload state
  const [disbFile, setDisbFile] = useState<File | null>(null)
  const [disbLoading, setDisbLoading] = useState(false)
  const [disbError, setDisbError] = useState('')
  const [disbResult, setDisbResult] = useState<ApiResponse | null>(null)
  const [disbFilters, setDisbFilters] = useState<Set<ReconStatus>>(new Set())
  const [disbSearch, setDisbSearch] = useState('')
  const [disbTableOpen, setDisbTableOpen] = useState(true)
  const disbFileRef = useRef<HTMLInputElement>(null)

  const selectedPartner = PARTNERS.find((p) => p.id === partnerId)

  function resetUpload() {
    setFile(null)
    setUploadResult(null)
    setUploadError('')
    setUploadFilters(new Set())
    setUploadSearch('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!file || !partnerId) return

    setLoading(true)
    setUploadError('')
    setUploadResult(null)

    const formData = new FormData()
    formData.append('file', file)
    formData.append('partner', partnerId)

    try {
      const res = await fetch('/api/reconcile', { method: 'POST', body: formData })
      const json = await res.json() as ApiResponse
      if (!res.ok) {
        setUploadError(json.error ?? 'Something went wrong')
        return
      }
      setUploadResult(json)
      setUploadTableOpen(false)
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Unexpected error')
    } finally {
      setLoading(false)
    }
  }

  async function handleDisbursementSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!disbFile) return
    setDisbLoading(true)
    setDisbError('')
    setDisbResult(null)
    const formData = new FormData()
    formData.append('file', disbFile)
    try {
      const res = await fetch('/api/reconcile/disbursement', { method: 'POST', body: formData })
      const json = await res.json()
      if (!res.ok) { setDisbError(json.error ?? 'Something went wrong'); return }
      setDisbResult(json)
    } catch (err) {
      setDisbError(err instanceof Error ? err.message : 'Unexpected error')
    } finally {
      setDisbLoading(false)
    }
  }

  function handleUploadDownload() {
    if (!uploadResult?.excelBase64) return
    downloadExcel(uploadResult.excelBase64, `recon-${partnerId}-${uploadResult.summary.dateRange?.min}.xlsx`)
  }

  async function handleViewSearch(e: React.FormEvent) {
    e.preventDefault()
    if (!viewDateFrom || !viewDateTo) return

    setViewLoading(true)
    setViewError('')
    setViewResult(null)
    setViewFilters(new Set())
    setViewSearch('')

    try {
      const params = new URLSearchParams({ dateFrom: viewDateFrom, dateTo: viewDateTo })
      if (viewChannel) params.set('channel', viewChannel)
      const res = await fetch(`/api/results?${params}`)
      const json = await res.json() as ResultsResponse
      if (!res.ok) {
        setViewError(json.error ?? 'Something went wrong')
        return
      }
      setViewResult(json)
    } catch (err) {
      setViewError(err instanceof Error ? err.message : 'Unexpected error')
    } finally {
      setViewLoading(false)
    }
  }

  function toggleSelect(ref: string) {
    setSelectedRefs((prev) => { const n = new Set(prev); n.has(ref) ? n.delete(ref) : n.add(ref); return n })
  }

  function toggleSelectAll(refs: string[]) {
    setSelectedRefs((prev) => {
      const allSelected = refs.every((r) => prev.has(r))
      const n = new Set(prev)
      if (allSelected) refs.forEach((r) => n.delete(r))
      else refs.forEach((r) => n.add(r))
      return n
    })
  }

  async function handleMarkResolved() {
    if (selectedRefs.size === 0) return
    setResolving(true)
    try {
      const res = await fetch('/api/results', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reconRefs: Array.from(selectedRefs) }),
      })
      if (res.ok) {
        setSelectedRefs(new Set())
        const params = new URLSearchParams({ dateFrom: viewDateFrom, dateTo: viewDateTo })
        if (viewChannel) params.set('channel', viewChannel)
        const r2 = await fetch(`/api/results?${params}`)
        const json = await r2.json() as ResultsResponse
        setViewResult(json)
      }
    } finally {
      setResolving(false)
    }
  }

  async function handleViewDownload() {
    if (!viewResult) return
    const params = new URLSearchParams({ dateFrom: viewDateFrom, dateTo: viewDateTo, download: '1' })
    if (viewChannel) params.set('channel', viewChannel)
    const res = await fetch(`/api/results?${params}`)
    const json = await res.json() as { excelBase64: string }
    const label = viewChannel || 'all'
    downloadExcel(json.excelBase64, `recon-${label}-${viewDateFrom}-${viewDateTo}.xlsx`)
  }

  function downloadExcel(base64: string, filename: string) {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <main className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-7xl mx-auto space-y-10">

        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Pivot Reconciliation</h1>
          <p className="text-slate-500 text-sm mt-1">
            Upload partner settlement reports and view the full accumulated reconciliation picture.
          </p>
        </div>

        {/* ── Section 1: Upload ── */}
        <section className="space-y-4">
          <h2 className="text-base font-semibold text-slate-700">Upload Report</h2>

          <form onSubmit={handleSubmit} className="bg-white rounded-xl border border-slate-200 p-6 space-y-5 max-w-lg">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-700">Partner & Channel</label>
              <select
                value={partnerId}
                onChange={(e) => { setPartnerId(e.target.value); resetUpload() }}
                required
                className="w-full h-10 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-400"
              >
                <option value="">Select partner...</option>
                {Object.entries(grouped).map(([group, partners]) => (
                  <optgroup key={group} label={group}>
                    {partners.map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-700">
                Partner Settlement Report
                <span className="text-slate-400 font-normal ml-1">(.xlsx or .xls)</span>
              </label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                required
                onChange={(e) => { setFile(e.target.files?.[0] ?? null); setUploadResult(null); setUploadError('') }}
                className="w-full text-sm text-slate-600 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-slate-100 file:text-slate-700 hover:file:bg-slate-200 cursor-pointer"
              />
              {selectedPartner && file && (
                <p className="text-xs text-slate-400">
                  Date col {selectedPartner.columns.datetime} · Recon ref col {selectedPartner.columns.recon_ref} · Amount col {selectedPartner.columns.amount}
                </p>
              )}
            </div>

            {uploadError && (
              <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
                {uploadError}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !file || !partnerId}
              className="w-full h-10 rounded-md bg-slate-900 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? 'Reconciling...' : 'Run Reconciliation'}
            </button>
          </form>

          {/* Upload results */}
          {uploadResult && (
            <div className="space-y-4">
              {uploadResult.warning && (
                <div className="rounded-lg bg-yellow-50 border border-yellow-200 p-3 text-sm text-yellow-700">
                  ⚠ {uploadResult.warning}
                </div>
              )}
              <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold text-slate-700">
                      {uploadResult.summary.total} rows · {uploadResult.summary.dateRange?.min === uploadResult.summary.dateRange?.max
                        ? uploadResult.summary.dateRange?.min
                        : `${uploadResult.summary.dateRange?.min} → ${uploadResult.summary.dateRange?.max}`}
                    </p>
                    {(uploadResult.summary.parseErrors?.length ?? 0) > 0 && (
                      <p className="text-xs text-yellow-600 mt-0.5">
                        ⚠ {uploadResult.summary.parseErrors!.length} row(s) skipped during parsing
                      </p>
                    )}
                    <p className="text-xs text-slate-400 mt-0.5">Results saved — view full picture in the Results section below.</p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setUploadTableOpen((v) => !v)}
                      className="h-9 px-4 rounded-md border border-slate-200 text-slate-600 text-sm font-medium hover:bg-slate-50 transition-colors"
                    >
                      {uploadTableOpen ? 'Collapse ▲' : 'Expand ▼'}
                    </button>
                    <button onClick={handleUploadDownload} className="h-9 px-4 rounded-md bg-slate-900 text-white text-sm font-medium hover:bg-slate-700 transition-colors">
                      Download Excel
                    </button>
                  </div>
                </div>
                <StatusChips
                  summary={uploadResult.summary}
                  activeFilters={uploadFilters}
                  onToggle={(s) => setUploadFilters((prev) => { const n = new Set(prev); n.has(s) ? n.delete(s) : n.add(s); return n })}
                  onClear={() => setUploadFilters(new Set())}
                />
              </div>
              {uploadTableOpen && (
                <>
                  <div className="flex gap-3 items-center">
                    <input
                      type="text"
                      placeholder="Search by recon ref..."
                      value={uploadSearch}
                      onChange={(e) => setUploadSearch(e.target.value)}
                      className="h-9 w-72 rounded-md border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
                    />
                  </div>
                  <ReconTable
                    rows={uploadResult.rows}
                    activeFilters={uploadFilters}
                    search={uploadSearch}
                    totalRows={uploadResult.rows.length}
                  />
                </>
              )}
            </div>
          )}
        </section>

        <div className="border-t border-slate-200" />

        {/* ── Section: Mandiri Disbursement Upload ── */}
        <section className="space-y-4">
          <div>
            <h2 className="text-base font-semibold text-slate-700">Mandiri Disbursement</h2>
            <p className="text-slate-500 text-sm mt-0.5">Upload an MT940 bank statement file to reconcile disbursements against internal records.</p>
          </div>

          <form onSubmit={handleDisbursementSubmit} className="bg-white rounded-xl border border-slate-200 p-6 space-y-5 max-w-lg">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-700">
                MT940 Statement File
                <span className="text-slate-400 font-normal ml-1">(Mandiri KopRA export)</span>
              </label>
              <input
                ref={disbFileRef}
                type="file"
                required
                onChange={(e) => { setDisbFile(e.target.files?.[0] ?? null); setDisbResult(null); setDisbError(''); setDisbFilters(new Set()); setDisbSearch('') }}
                className="w-full text-sm text-slate-600 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-slate-100 file:text-slate-700 hover:file:bg-slate-200 cursor-pointer"
              />
            </div>

            {disbError && (
              <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
                {disbError}
              </div>
            )}

            <button
              type="submit"
              disabled={disbLoading || !disbFile}
              className="w-full h-10 rounded-md bg-slate-900 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {disbLoading ? 'Reconciling...' : 'Run Reconciliation'}
            </button>
          </form>

          {disbResult && (
            <div className="space-y-4">
              <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold text-slate-700">
                      {disbResult.summary.total} rows · {disbResult.summary.dateRange?.min}
                    </p>
                    <p className="text-xs text-slate-400 mt-0.5">Results saved — view full picture in the Results section below.</p>
                  </div>
                  <button
                    onClick={() => setDisbTableOpen((v) => !v)}
                    className="h-9 px-4 rounded-md border border-slate-200 text-slate-600 text-sm font-medium hover:bg-slate-50 transition-colors"
                  >
                    {disbTableOpen ? 'Collapse ▲' : 'Expand ▼'}
                  </button>
                </div>
                <StatusChips
                  summary={disbResult.summary}
                  activeFilters={disbFilters}
                  onToggle={(s) => setDisbFilters((prev) => { const n = new Set(prev); n.has(s) ? n.delete(s) : n.add(s); return n })}
                  onClear={() => setDisbFilters(new Set())}
                />
              </div>
              {disbTableOpen && (
                <>
                  <div className="flex gap-3 items-center">
                    <input
                      type="text"
                      placeholder="Search by recon ref..."
                      value={disbSearch}
                      onChange={(e) => setDisbSearch(e.target.value)}
                      className="h-9 w-72 rounded-md border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
                    />
                  </div>
                  <ReconTable
                    rows={disbResult.rows}
                    activeFilters={disbFilters}
                    search={disbSearch}
                    totalRows={disbResult.rows.length}
                  />
                </>
              )}
            </div>
          )}
        </section>

        <div className="border-t border-slate-200" />

        {/* ── Section 2: Results View ── */}
        <section className="space-y-4">
          <div>
            <h2 className="text-base font-semibold text-slate-700">Full Results</h2>
            <p className="text-slate-500 text-sm mt-0.5">View the accumulated reconciliation picture for any partner and date range.</p>
          </div>

          <form onSubmit={handleViewSearch} className="bg-white rounded-xl border border-slate-200 p-6 space-y-5 max-w-2xl">
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <label className="block text-sm font-medium text-slate-700">Channel</label>
                <select
                  value={viewChannel}
                  onChange={(e) => setViewChannel(e.target.value)}
                  className="w-full h-10 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-400"
                >
                  <option value="">All channels</option>
                  <option value="QRIS">QRIS</option>
                  <option value="DISBURSEMENT">Disbursement</option>
                </select>
              </div>
              <div className="space-y-2">
                <label className="block text-sm font-medium text-slate-700">From</label>
                <input
                  type="date"
                  value={viewDateFrom}
                  onChange={(e) => setViewDateFrom(e.target.value)}
                  required
                  className="w-full h-10 rounded-md border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
                />
              </div>
              <div className="space-y-2">
                <label className="block text-sm font-medium text-slate-700">To</label>
                <input
                  type="date"
                  value={viewDateTo}
                  onChange={(e) => setViewDateTo(e.target.value)}
                  required
                  className="w-full h-10 rounded-md border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={viewLoading || !viewDateFrom || !viewDateTo}
              className="h-10 px-6 rounded-md bg-slate-900 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {viewLoading ? 'Loading...' : 'View Results'}
            </button>
          </form>

          {viewError && (
            <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700 max-w-2xl">
              {viewError}
            </div>
          )}

          {viewResult && (
            <div className="space-y-4">
              <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-slate-700">
                    {viewResult.summary.total} rows · {viewDateFrom} → {viewDateTo}
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setViewTableOpen((v) => !v)}
                      className="h-9 px-4 rounded-md border border-slate-200 text-slate-600 text-sm font-medium hover:bg-slate-50 transition-colors"
                    >
                      {viewTableOpen ? 'Collapse ▲' : 'Expand ▼'}
                    </button>
                    <button onClick={handleViewDownload} className="h-9 px-4 rounded-md bg-slate-900 text-white text-sm font-medium hover:bg-slate-700 transition-colors">
                      Download Excel
                    </button>
                  </div>
                </div>
                <StatusChips
                  summary={viewResult.summary}
                  activeFilters={viewFilters}
                  onToggle={(s) => setViewFilters((prev) => { const n = new Set(prev); n.has(s) ? n.delete(s) : n.add(s); return n })}
                  onClear={() => setViewFilters(new Set())}
                />
              </div>
              {viewTableOpen && (
                <>
                  <div className="flex gap-3 items-center justify-between">
                    <input
                      type="text"
                      placeholder="Search by recon ref..."
                      value={viewSearch}
                      onChange={(e) => setViewSearch(e.target.value)}
                      className="h-9 w-72 rounded-md border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
                    />
                    {selectedRefs.size > 0 && (
                      <button
                        onClick={handleMarkResolved}
                        disabled={resolving}
                        className="h-9 px-4 rounded-md bg-slate-700 text-white text-sm font-medium hover:bg-slate-600 disabled:opacity-40 transition-colors"
                      >
                        {resolving ? 'Saving...' : `Mark ${selectedRefs.size} as Resolved`}
                      </button>
                    )}
                  </div>
                  <ReconTable
                    rows={viewResult.rows}
                    activeFilters={viewFilters}
                    search={viewSearch}
                    totalRows={viewResult.rows.length}
                    selectable
                    selectedRefs={selectedRefs}
                    onToggleSelect={toggleSelect}
                    onToggleSelectAll={toggleSelectAll}
                  />
                </>
              )}
            </div>
          )}
        </section>

      </div>
    </main>
  )
}
