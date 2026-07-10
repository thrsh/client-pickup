import React, { useEffect, useState } from 'react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  PieChart,
  Pie,
  Cell,
  Legend,
  LineChart,
  Line,
} from 'recharts'
import { Download, Wallet, CheckCircle, Clock, TrendingUp, Loader2 } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { formatCurrency } from '../../lib/utils'

// Corporate Branding Colors
const BRAND = {
  teal: '#0d9488', // teal-600
  tealLight: '#14b8a6', // teal-500
  orange: '#f97316', // orange-500
  orangeLight: '#fb923c', // orange-400
  gray: '#64748b', // slate-500
}

const PIE_COLORS = [BRAND.teal, BRAND.orange]

export default function AdminReports() {
  const [byPayor, setByPayor] = useState([])
  const [statusSplit, setStatusSplit] = useState([])
  const [aging, setAging] = useState([])
  const [pickupTrend, setPickupTrend] = useState([])
  const [kpis, setKpis] = useState({
    availableCount: 0,
    availableValue: 0,
    pickedUpCount: 0,
    pickedUpValue: 0,
  })
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    const { data } = await supabase
      .from('checks')
      .select('payor, amount, status, check_date, picked_up_at')

    const rows = data || []
    const now = new Date()

    // 1. Calculate KPIs
    let availCount = 0, availVal = 0, pickedCount = 0, pickedVal = 0
    rows.forEach(r => {
      const amt = Number(r.amount || 0)
      if (r.status === 'available') {
        availCount++
        availVal += amt
      } else if (r.status === 'picked_up') {
        pickedCount++
        pickedVal += amt
      }
    })
    setKpis({ availableCount: availCount, availableValue: availVal, pickedUpCount: pickedCount, pickedUpValue: pickedVal })

    // 2. Amount available by payor (Top 8)
    const payorMap = {}
    rows
      .filter((r) => r.status === 'available')
      .forEach((r) => {
        payorMap[r.payor] = (payorMap[r.payor] || 0) + Number(r.amount || 0)
      })
    setByPayor(
      Object.entries(payorMap)
        .map(([payor, amount]) => ({ payor, amount }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 8)
    )

    // 3. Status Split
    setStatusSplit([
      { name: 'Available', value: availCount },
      { name: 'Picked up', value: pickedCount },
    ])

    // 4. Aging buckets for available checks
    const buckets = { '0-7 days': { count: 0, value: 0 }, '8-30 days': { count: 0, value: 0 }, '31-60 days': { count: 0, value: 0 }, '60+ days': { count: 0, value: 0 } }
    rows
      .filter((r) => r.status === 'available' && r.check_date)
      .forEach((r) => {
        const days = Math.floor((now - new Date(r.check_date)) / 86400000)
        const amt = Number(r.amount || 0)
        if (days <= 7) { buckets['0-7 days'].count++; buckets['0-7 days'].value += amt; }
        else if (days <= 30) { buckets['8-30 days'].count++; buckets['8-30 days'].value += amt; }
        else if (days <= 60) { buckets['31-60 days'].count++; buckets['31-60 days'].value += amt; }
        else { buckets['60+ days'].count++; buckets['60+ days'].value += amt; }
      })
    setAging(Object.entries(buckets).map(([bucket, data]) => ({ bucket, count: data.count, value: data.value })))

    // 5. Pickup Trend (Last 14 Days)
    const trendMap = {}
    const fourteenDaysAgo = new Date(now)
    fourteenDaysAgo.setDate(now.getDate() - 14)
    
    // Initialize last 14 days with 0
    for(let i=0; i<=14; i++) {
        const d = new Date(fourteenDaysAgo)
        d.setDate(d.getDate() + i)
        trendMap[d.toISOString().slice(0, 10)] = 0
    }

    rows
      .filter(r => r.status === 'picked_up' && r.picked_up_at)
      .forEach(r => {
        const dateStr = r.picked_up_at.slice(0, 10)
        if (trendMap[dateStr] !== undefined) {
            trendMap[dateStr]++
        }
      })
    
    setPickupTrend(Object.entries(trendMap).map(([date, count]) => ({ 
      date: new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), 
      count 
    })))

    setLoading(false)
  }

  async function exportCsv() {
    setExporting(true)
    try {
      const { data } = await supabase
        .from('checks')
        .select('row_number, payee, payor, check_no, check_date, amount, status, picked_up_by, picked_up_at, upload_batches(file_name)')
        .order('created_at', { ascending: false })

      const header = ['File', 'Row', 'Payee', 'Payor', 'Check No', 'Check Date', 'Amount', 'Status', 'Picked Up By', 'Picked Up At']
      const lines = (data || []).map((r) => [
        r.upload_batches?.file_name || '',
        r.row_number,
        r.payee,
        r.payor,
        r.check_no,
        r.check_date,
        r.amount,
        r.status,
        r.picked_up_by || '',
        r.picked_up_at || '',
      ])

      const csv = [header, ...lines]
        .map((row) => row.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
        .join('\n')

      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `disbursement-ledger-${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } finally {
      setExporting(false)
    }
  }

  // Helper component for KPI loading states
  const StatSkeleton = () => <div className="h-10 w-full animate-pulse rounded-md bg-gray-100" />
  const ChartSkeleton = () => <div className="h-full w-full animate-pulse rounded-lg bg-gray-50" />

  return (
    <div className="space-y-6 pb-12">
      {/* Header Area */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">Analytics Dashboard</h1>
          <p className="text-sm text-gray-500">
            Monitor outstanding balances, check aging, and pickup performance.
          </p>
        </div>
        <Button 
          variant="outline" 
          onClick={exportCsv} 
          disabled={exporting}
          className="w-full sm:w-auto border-teal-200 text-teal-700 hover:bg-teal-50"
        >
          {exporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
          {exporting ? 'Exporting...' : 'Export Master Ledger'}
        </Button>
      </div>

      {/* Top Level KPIs */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="border-gray-100 shadow-sm">
          <CardContent className="p-5">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-orange-50 text-orange-600">
                <Clock className="h-5 w-5" />
              </div>
              <div className="flex flex-col">
                <span className="text-sm font-medium text-gray-500">Available Checks</span>
                {loading ? <StatSkeleton /> : <span className="text-2xl font-bold text-gray-900">{kpis.availableCount}</span>}
              </div>
            </div>
          </CardContent>
        </Card>
        
        <Card className="border-gray-100 shadow-sm">
          <CardContent className="p-5">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-orange-50 text-orange-600">
                <Wallet className="h-5 w-5" />
              </div>
              <div className="flex flex-col">
                <span className="text-sm font-medium text-gray-500">Unclaimed Value</span>
                {loading ? <StatSkeleton /> : <span className="text-2xl font-bold text-gray-900">{formatCurrency(kpis.availableValue)}</span>}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-gray-100 shadow-sm">
          <CardContent className="p-5">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-teal-50 text-teal-600">
                <CheckCircle className="h-5 w-5" />
              </div>
              <div className="flex flex-col">
                <span className="text-sm font-medium text-gray-500">Checks Disbursed</span>
                {loading ? <StatSkeleton /> : <span className="text-2xl font-bold text-gray-900">{kpis.pickedUpCount}</span>}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-gray-100 shadow-sm">
          <CardContent className="p-5">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-teal-50 text-teal-600">
                <TrendingUp className="h-5 w-5" />
              </div>
              <div className="flex flex-col">
                <span className="text-sm font-medium text-gray-500">Value Disbursed</span>
                {loading ? <StatSkeleton /> : <span className="text-2xl font-bold text-gray-900">{formatCurrency(kpis.pickedUpValue)}</span>}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Charts Grid */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Payor Chart */}
        <Card className="lg:col-span-2 border-gray-100 shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Outstanding Value by Payor (Top 8)</CardTitle>
            <CardDescription>Highest uncollected balances waiting for pickup.</CardDescription>
          </CardHeader>
          <CardContent className="h-80 pt-0">
            {loading ? <ChartSkeleton /> : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={byPayor} layout="vertical" margin={{ left: 10, right: 30 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                  <XAxis type="number" tickFormatter={(v) => formatCurrency(v)} fontSize={11} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="payor" width={120} fontSize={11} axisLine={false} tickLine={false} />
                  <Tooltip 
                    formatter={(value) => [formatCurrency(value), 'Total Amount']}
                    contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                  />
                  <Bar dataKey="amount" fill={BRAND.teal} radius={[0, 4, 4, 0]} maxBarSize={40} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Status Pie Chart */}
        <Card className="border-gray-100 shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Overall Status</CardTitle>
            <CardDescription>Volume of checks picked up vs. available.</CardDescription>
          </CardHeader>
          <CardContent className="h-80 pt-0">
            {loading ? <ChartSkeleton /> : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={statusSplit}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={65}
                    outerRadius={95}
                    paddingAngle={4}
                  >
                    {statusSplit.map((_, i) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
                  <Legend verticalAlign="bottom" height={36} iconType="circle" />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Pickup Trend Line Chart */}
        <Card className="lg:col-span-2 border-gray-100 shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Pickup Momentum (Last 14 Days)</CardTitle>
            <CardDescription>Daily volume of checks claimed by representatives.</CardDescription>
          </CardHeader>
          <CardContent className="h-72 pt-0">
            {loading ? <ChartSkeleton /> : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={pickupTrend} margin={{ top: 10, right: 30, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  <XAxis dataKey="date" fontSize={11} axisLine={false} tickLine={false} tickMargin={10} />
                  <YAxis allowDecimals={false} fontSize={11} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
                  <Line 
                    type="monotone" 
                    dataKey="count" 
                    name="Checks Picked Up"
                    stroke={BRAND.teal} 
                    strokeWidth={3}
                    dot={{ fill: BRAND.teal, strokeWidth: 2, r: 4 }}
                    activeDot={{ r: 6, fill: BRAND.orange }}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Aging Bar Chart */}
        <Card className="border-gray-100 shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Check Aging</CardTitle>
            <CardDescription>How long unclaimed checks have been sitting.</CardDescription>
          </CardHeader>
          <CardContent className="h-72 pt-0">
            {loading ? <ChartSkeleton /> : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={aging} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  <XAxis dataKey="bucket" fontSize={11} axisLine={false} tickLine={false} tickMargin={10} />
                  <YAxis allowDecimals={false} fontSize={11} axisLine={false} tickLine={false} />
                  <Tooltip 
                    cursor={{fill: '#f8fafc'}}
                    contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                  />
                  <Bar dataKey="count" name="Total Checks" fill={BRAND.orange} radius={[4, 4, 0, 0]} maxBarSize={40} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}