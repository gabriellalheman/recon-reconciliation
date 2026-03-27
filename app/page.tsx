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
  parseErrors: { row: number; message: string }[]
  dateRange: { min: string; max: string }
}

interface ApiResponse {
  rows: ReconRow[]
  summary: Summary
  excelBase64: string
  error?: string
}

const STATUS_LABELS: Record<ReconStatus, string> = {
  done: 'Done',
  status_not_success: 'Status Not Success',
  not_in_internal: 'Not in Internal',
  not_in_partner: 'Not in Partner',
}

const STATUS_STYLES: Record<ReconStatus, string> = {
  done: 'bg-green-100 text-green-800',
  status_not_success: 'bg-yellow-100 text-yellow-800',
  not_in_internal: 'bg-red-100 text-red-700',
  not_in_partner: 'bg-orange-100 text-orange-700',
}

const STATUS_CHIP_ACTIVE: Record<ReconStatus, string> = {
  done: 'bg-green-600 text-white',
  status_not_success: 'bg-yellow-500 text-white',
  not_in_internal: 'bg-red-600 text-white',
  not_in_partner: 'bg-orange-500 text-white',
}

const STATUS_CHIP_INACTIVE: Record<ReconStatus, string> = {
  done: 'bg-green-50 text-green-700 border border-green-200',
  status_not_success: 'bg-yellow-50 text-yellow-700 border border-yellow-200',
  not_in_internal: 'bg-red-50 text-red-700 border border-red-200',
  not_in_partner: 'bg-orange-50 text-orange-700 border border-orange-200',
}

function formatDate(iso: string | undefined): string {
  if (!iso) return '—'
  return iso.replace('T', ' ').slice(0, 19)
}

function formatAmount(v: number | undefined): string {
  if (v === undefined || v === null) return '—'
  return v.toLocaleString('id-ID')
}

export default function Home() {
  const [partnerId, setPartnerId] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<ApiResponse | null>(null)
  const [activeFilters, setActiveFilters] = useState<Set<ReconStatus>>(new Set())
  const fileInputRef = useRef<HTMLInputElement>(null)

  const grouped = partnersByGroup()
  const selectedPartner = PARTNERS.find((p) => p.id === partnerId)

  function resetForm() {
    setFile(null)
    setResult(null)
    setError('')
    setActiveFilters(new Set())
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!file || !partnerId) return

    setLoading(true)
    setError('')
    setResult(null)

    const formData = new FormData()
    formData.append('file', file)
    formData.append('partner', partnerId)

    try {
      const res = await fetch('/api/reconcile', { method: 'POST', body: formData })
      const json = await res.json() as ApiResponse

      if (!res.ok) {
        setError(json.error ?? 'Something went wrong')
        return
      }

      setResult(json)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unexpected error')
    } finally {
      setLoading(false)
    }
  }

  function toggleFilter(status: ReconStatus) {
    setActiveFilters((prev) => {
      const next = new Set(prev)
      if (next.has(status)) next.delete(status)
      else next.add(status)
      return next
    })
  }

  function handleDownload() {
    if (!result?.excelBase64) return
    const bytes = Uint8Array.from(atob(result.excelBase64), (c) => c.charCodeAt(0))
    const blob = new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const date = result.summary.dateRange.min
    a.href = url
    a.download = `recon-${partnerId}-${date}.xlsx`
    a.click()
    URL.revokeObjectURL(url)
  }

  const filteredRows = result
    ? result.rows.filter((r) =>
        activeFilters.size === 0 || activeFilters.has(r.status),
      )
    : []

  return (
    <main className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-7xl mx-auto space-y-6">

        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Recon Reconciliation</h1>
          <p className="text-slate-500 text-sm mt-1">
            Upload a partner settlement report to reconcile against internal transaction data.
          </p>
        </div>

        {/* Upload form */}
        <form onSubmit={handleSubmit} className="bg-white rounded-xl border border-slate-200 p-6 space-y-5 max-w-lg">
          <div className="space-y-2">
            <label className="block text-sm font-medium text-slate-700">Partner & Channel</label>
            <select
              value={partnerId}
              onChange={(e) => { setPartnerId(e.target.value); resetForm() }}
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
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null); setError('') }}
              className="w-full text-sm text-slate-600 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-slate-100 file:text-slate-700 hover:file:bg-slate-200 cursor-pointer"
            />
            {selectedPartner && file && (
              <p className="text-xs text-slate-400">
                Date col {selectedPartner.columns.datetime} · Recon ref col {selectedPartner.columns.recon_ref} · Amount col {selectedPartner.columns.amount}
              </p>
            )}
          </div>

          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
              {error}
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

        {/* Results */}
        {result && (
          <div className="space-y-4">

            {/* Summary bar */}
            <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold text-slate-700">
                    {result.summary.total} rows · {result.summary.dateRange.min === result.summary.dateRange.max
                      ? result.summary.dateRange.min
                      : `${result.summary.dateRange.min} → ${result.summary.dateRange.max}`}
                  </p>
                  {result.summary.parseErrors.length > 0 && (
                    <p className="text-xs text-yellow-600 mt-0.5">
                      ⚠ {result.summary.parseErrors.length} row(s) skipped during parsing
                    </p>
                  )}
                </div>
                <button
                  onClick={handleDownload}
                  className="h-9 px-4 rounded-md bg-slate-900 text-white text-sm font-medium hover:bg-slate-700 transition-colors"
                >
                  Download Excel
                </button>
              </div>

              {/* Status filter chips */}
              <div className="flex flex-wrap gap-2">
                {(Object.keys(STATUS_LABELS) as ReconStatus[]).map((status) => {
                  const count = result.summary[status === 'done' ? 'done'
                    : status === 'status_not_success' ? 'status_not_success'
                    : status === 'not_in_internal' ? 'not_in_internal'
                    : 'not_in_partner']
                  const isActive = activeFilters.has(status)
                  return (
                    <button
                      key={status}
                      onClick={() => toggleFilter(status)}
                      className={`inline-flex items-center gap-1.5 px-3 h-8 rounded-full text-xs font-medium transition-colors ${
                        isActive ? STATUS_CHIP_ACTIVE[status] : STATUS_CHIP_INACTIVE[status]
                      }`}
                    >
                      {STATUS_LABELS[status]}
                      <span className={`inline-flex items-center justify-center rounded-full w-4 h-4 text-[10px] font-bold ${
                        isActive ? 'bg-white/25' : 'bg-white/60'
                      }`}>
                        {count}
                      </span>
                    </button>
                  )
                })}
                {activeFilters.size > 0 && (
                  <button
                    onClick={() => setActiveFilters(new Set())}
                    className="inline-flex items-center px-3 h-8 rounded-full text-xs font-medium text-slate-500 border border-slate-200 hover:bg-slate-50"
                  >
                    Clear filters
                  </button>
                )}
              </div>
            </div>

            {/* Table */}
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50">
                      <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Recon Ref</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Partner</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Channel</th>
                      <th className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wide">Partner Amt</th>
                      <th className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wide">Internal Amt</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Partner Date</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Internal Date</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Internal Status</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Recon Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredRows.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="px-4 py-8 text-center text-slate-400 text-sm">
                          No rows match the selected filters
                        </td>
                      </tr>
                    ) : (
                      filteredRows.map((row, i) => (
                        <tr key={i} className="hover:bg-slate-50 transition-colors">
                          <td className="px-4 py-2.5 font-mono text-xs text-slate-700 max-w-[180px] truncate" title={row.reconRef}>
                            {row.reconRef}
                          </td>
                          <td className="px-4 py-2.5 text-slate-600">{row.partner ?? '—'}</td>
                          <td className="px-4 py-2.5 text-slate-600">{row.channel ?? '—'}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">
                            {formatAmount(row.partnerAmount)}
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">
                            {formatAmount(row.internalAmount)}
                          </td>
                          <td className="px-4 py-2.5 text-slate-500 text-xs whitespace-nowrap">
                            {formatDate(row.partnerDatetime)}
                          </td>
                          <td className="px-4 py-2.5 text-slate-500 text-xs whitespace-nowrap">
                            {formatDate(row.internalCreatedAt)}
                          </td>
                          <td className="px-4 py-2.5 text-slate-500 text-xs">
                            {row.internalStatus ?? '—'}
                          </td>
                          <td className="px-4 py-2.5">
                            <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[row.status]}`}>
                              {STATUS_LABELS[row.status]}
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              {filteredRows.length > 0 && (
                <div className="px-4 py-2 border-t border-slate-100 text-xs text-slate-400">
                  Showing {filteredRows.length} of {result.rows.length} rows
                </div>
              )}
            </div>

          </div>
        )}

      </div>
    </main>
  )
}
