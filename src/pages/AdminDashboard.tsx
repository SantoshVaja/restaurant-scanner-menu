import React, { useCallback, useEffect, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { jsPDF } from 'jspdf';
import {
  Check,
  Download,
  ExternalLink,
  Plus,
  Printer,
  QrCode,
  RefreshCw,
  RotateCcw,
  Shield,
  Trash2,
} from 'lucide-react';
import type {
  Coupon,
  MenuCategory,
  MenuItem,
  Reservation,
  RestaurantInfo,
  RoleSlug,
  StaffUser,
} from '../types.ts';
import { apiFetch, parseJsonSafe } from '../lib/api.ts';
import { downloadAllTableQrsPdf, exportRowsToCsv, formatDateTimeIST, formatINR } from '../lib/format.ts';
import { useRealtimeRoom } from '../lib/ws.ts';
import { ConfirmModal, StatusLabel, VegIndicator } from '../components/ui.tsx';

type AdminTab =
  | 'overview'
  | 'menu'
  | 'tables'
  | 'staff'
  | 'coupons'
  | 'reservations'
  | 'reports'
  | 'settings';

export function AdminDashboard({
  staffToken,
  userRole,
  restaurant,
  categories,
  items,
  onMenuChanged,
  onOpenQrUrl,
}: {
  staffToken: string;
  userRole: RoleSlug;
  restaurant: RestaurantInfo | null;
  categories: MenuCategory[];
  items: MenuItem[];
  onMenuChanged: () => void;
  onOpenQrUrl: (relativeUrl: string) => void;
}) {
  const [tab, setTab] = useState<AdminTab>('overview');
  const [overview, setOverview] = useState<any>(null);
  const [qrTables, setQrTables] = useState<any[]>([]);
  const [staffList, setStaffList] = useState<StaffUser[]>([]);
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [reports, setReports] = useState<any>(null);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);

  // Forms
  const [newItem, setNewItem] = useState({
    category_id: categories[0]?.id || 1,
    name: '',
    description: '',
    price_inr: '',
    is_veg: true,
    is_bestseller: false,
    prep_time_mins: '15',
  });
  const [newCatName, setNewCatName] = useState('');
  const [newTable, setNewTable] = useState({ table_number: '', capacity: '4', section: 'Main Hall' });
  const [newStaff, setNewStaff] = useState({ name: '', email: '', phone: '', password: '', role: 'waiter' as RoleSlug });
  const [newCoupon, setNewCoupon] = useState({
    code: '',
    description: '',
    discount_type: 'percent' as 'percent' | 'fixed',
    discount_value: '10',
    min_order_inr: '500',
    valid_until: '2027-12-31',
  });
  const [settingsForm, setSettingsForm] = useState({
    name: restaurant?.name || '',
    tagline: restaurant?.tagline || '',
    address: restaurant?.address || '',
    phone: restaurant?.phone || '',
    email: restaurant?.email || '',
    gstin: restaurant?.gstin || '',
    gst_rate_bps: String(restaurant?.gst_rate_bps ?? 500),
    service_charge_bps: String(restaurant?.service_charge_bps ?? 500),
    auto_accept_kitchen: restaurant?.auto_accept_kitchen || false,
  });

  const authHeaders = { Authorization: `Bearer ${staffToken}`, 'Content-Type': 'application/json' };

  const loadTabData = useCallback(async () => {
    try {
      const [ovRes, qrRes, stRes, cpRes, rsRes, rpRes, auRes] = await Promise.all([
        apiFetch('/api/admin/overview', { headers: { Authorization: `Bearer ${staffToken}` } }),
        apiFetch('/api/admin/tables/qrs', { headers: { Authorization: `Bearer ${staffToken}` } }),
        apiFetch('/api/admin/staff', { headers: { Authorization: `Bearer ${staffToken}` } }),
        apiFetch('/api/admin/coupons', { headers: { Authorization: `Bearer ${staffToken}` } }),
        apiFetch('/api/admin/reservations', { headers: { Authorization: `Bearer ${staffToken}` } }),
        apiFetch('/api/admin/reports', { headers: { Authorization: `Bearer ${staffToken}` } }),
        apiFetch('/api/admin/audit-logs', { headers: { Authorization: `Bearer ${staffToken}` } }),
      ]);
      if (ovRes.ok) setOverview(await parseJsonSafe(ovRes));
      if (qrRes.ok) setQrTables((await parseJsonSafe(qrRes)).tables || []);
      if (stRes.ok) setStaffList((await parseJsonSafe(stRes)).staff || []);
      if (cpRes.ok) setCoupons((await parseJsonSafe(cpRes)).coupons || []);
      if (rsRes.ok) setReservations((await parseJsonSafe(rsRes)).reservations || []);
      if (rpRes.ok) setReports(await parseJsonSafe(rpRes));
      if (auRes.ok) setAuditLogs((await parseJsonSafe(auRes)).logs || []);
    } catch {
      // Ignore transient error
    }
  }, [staffToken]);

  useEffect(() => {
    loadTabData();
  }, [loadTabData]);

  useRealtimeRoom({
    room: 'role:admin',
    staffToken,
    onEvent: () => loadTabData(),
  });

  function showNotice(msg: string) {
    setFeedback(msg);
    window.setTimeout(() => setFeedback(null), 4000);
  }

  async function addMenuItem(e: React.FormEvent) {
    e.preventDefault();
    const resp = await apiFetch('/api/admin/menu/items', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        category_id: Number(newItem.category_id),
        name: newItem.name,
        description: newItem.description,
        price_inr: Number(newItem.price_inr),
        is_veg: newItem.is_veg,
        is_bestseller: newItem.is_bestseller,
        prep_time_mins: Number(newItem.prep_time_mins),
      }),
    });
    if (resp.ok) {
      setNewItem({ ...newItem, name: '', description: '', price_inr: '' });
      onMenuChanged();
      showNotice('Menu item added and synced to public & QR menus.');
    }
  }

  async function toggleItemAvailability(item: MenuItem) {
    await apiFetch(`/api/admin/menu/items/${item.id}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ is_available: !item.is_available }),
    });
    onMenuChanged();
    showNotice(`${item.name} marked ${item.is_available ? 'Unavailable' : 'Available'}.`);
  }

  async function updateItemPrice(item: MenuItem, newRupees: number) {
    if (!Number.isFinite(newRupees) || newRupees <= 0) return;
    await apiFetch(`/api/admin/menu/items/${item.id}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ price_inr: newRupees }),
    });
    onMenuChanged();
    showNotice(`Updated ${item.name} price to ₹${newRupees}.`);
  }

  async function deleteMenuItem(item: MenuItem) {
    await apiFetch(`/api/admin/menu/items/${item.id}`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    onMenuChanged();
    showNotice(`Removed or archived ${item.name}.`);
  }

  async function addCategory(e: React.FormEvent) {
    e.preventDefault();
    if (!newCatName.trim()) return;
    const resp = await apiFetch('/api/admin/menu/categories', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name: newCatName.trim() }),
    });
    if (resp.ok) {
      setNewCatName('');
      onMenuChanged();
      showNotice('Category created.');
    }
  }

  async function addTable(e: React.FormEvent) {
    e.preventDefault();
    const resp = await apiFetch('/api/admin/tables', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        table_number: Number(newTable.table_number),
        capacity: Number(newTable.capacity),
        section: newTable.section,
      }),
    });
    if (resp.ok) {
      setNewTable({ table_number: '', capacity: '4', section: 'Main Hall' });
      loadTabData();
      showNotice('Table & cryptographic QR code created.');
    }
  }

  async function regenerateQr(tableId: number, tableNum: number) {
    const resp = await apiFetch(`/api/admin/tables/${tableId}/regenerate-qr`, {
      method: 'POST',
      headers: authHeaders,
    });
    if (resp.ok) {
      await loadTabData();
      showNotice(`Table ${String(tableNum).padStart(2, '0')} QR token regenerated; previous token revoked.`);
    }
  }

  async function createStaff(e: React.FormEvent) {
    e.preventDefault();
    try {
      const resp = await apiFetch('/api/admin/staff', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(newStaff),
      });
      const data = await parseJsonSafe<{ error?: string }>(resp);
      if (resp.ok) {
        setNewStaff({ name: '', email: '', phone: '', password: '', role: 'waiter' });
        loadTabData();
        showNotice('Staff account created.');
      } else {
        showNotice(data.error || 'Could not create staff');
      }
    } catch (err: unknown) {
      showNotice(err instanceof Error ? err.message : 'Could not create staff');
    }
  }

  async function toggleStaffActive(u: StaffUser) {
    await apiFetch(`/api/admin/staff/${u.id}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ is_active: !u.is_active }),
    });
    loadTabData();
  }

  async function createCoupon(e: React.FormEvent) {
    e.preventDefault();
    const resp = await apiFetch('/api/admin/coupons', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        ...newCoupon,
        discount_value: Number(newCoupon.discount_value),
        min_order_inr: Number(newCoupon.min_order_inr),
      }),
    });
    if (resp.ok) {
      setNewCoupon({ ...newCoupon, code: '', description: '' });
      loadTabData();
      showNotice('Promo coupon created.');
    }
  }

  async function updateReservationStatus(id: number, status: string) {
    await apiFetch(`/api/admin/reservations/${id}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ status }),
    });
    loadTabData();
    showNotice(`Reservation updated to ${status}.`);
  }

  async function saveSettings(e: React.FormEvent) {
    e.preventDefault();
    await apiFetch('/api/admin/settings', {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        ...settingsForm,
        gst_rate_bps: Number(settingsForm.gst_rate_bps),
        service_charge_bps: Number(settingsForm.service_charge_bps),
      }),
    });
    onMenuChanged();
    showNotice('Restaurant & tax settings saved.');
  }

  async function handleDemoReset() {
    setResetConfirmOpen(false);
    const resp = await apiFetch('/api/admin/demo/reset', {
      method: 'POST',
      headers: authHeaders,
    });
    if (resp.ok) {
      onMenuChanged();
      loadTabData();
      showNotice('Demo restaurant data reset cleanly.');
    }
  }

  function exportSalesReportPdf() {
    if (!reports) return;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.text(`${restaurant?.name || 'FoodMitra'} — Financial Sales Report`, 44, 48);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text(`Generated: ${new Date().toLocaleString('en-IN')}`, 44, 66);

    let y = 95;
    doc.setFont('helvetica', 'bold');
    doc.text('Tax & Revenue Summary', 44, y);
    y += 18;
    doc.setFont('helvetica', 'normal');
    doc.text(`Subtotal: Rs. ${(reports.taxSummary.subtotal_paise / 100).toFixed(2)}`, 44, y);
    y += 16;
    doc.text(`GST Collected: Rs. ${(reports.taxSummary.gst_paise / 100).toFixed(2)}`, 44, y);
    y += 16;
    doc.text(`Service Charge: Rs. ${(reports.taxSummary.service_charge_paise / 100).toFixed(2)}`, 44, y);
    y += 16;
    doc.text(`Grand Revenue: Rs. ${(reports.taxSummary.total_paise / 100).toFixed(2)}`, 44, y);
    y += 28;

    doc.setFont('helvetica', 'bold');
    doc.text('Top Selling Items', 44, y);
    y += 18;
    doc.setFont('helvetica', 'normal');
    for (const row of (reports.itemWise || []).slice(0, 18)) {
      doc.text(`${row.item_name} (${row.category_name}) — Qty: ${row.qty} — Rs. ${(row.revenue_paise / 100).toFixed(2)}`, 44, y);
      y += 15;
    }
    doc.save('restaurant360-sales-report.pdf');
  }

  const tabs: Array<{ id: AdminTab; label: string }> = [
    { id: 'overview', label: 'Overview & Analytics' },
    { id: 'menu', label: 'Menu & Categories' },
    { id: 'tables', label: 'Tables & QR Codes' },
    { id: 'staff', label: 'Staff & Audit' },
    { id: 'coupons', label: 'Coupons' },
    { id: 'reservations', label: 'Reservations' },
    { id: 'reports', label: 'Reports & Export' },
    { id: 'settings', label: 'Settings' },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-zinc-200">
        <div>
          <h2 className="text-xl font-bold text-zinc-900">Admin Operations Console</h2>
          <p className="text-xs text-zinc-500">Menu management, cryptographic table QRs, staff RBAC, analytics, and reports</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={loadTabData}
            className="px-3 py-1.5 text-xs font-medium bg-white border border-zinc-200 rounded-md inline-flex items-center gap-1.5 cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
          {userRole === 'super_admin' && (
            <button
              type="button"
              onClick={() => setResetConfirmOpen(true)}
              className="px-3 py-1.5 text-xs font-medium bg-red-50 border border-red-200 text-red-700 hover:bg-red-100 rounded-md inline-flex items-center gap-1.5 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" /> Reset Demo Data
            </button>
          )}
        </div>
      </div>

      {feedback && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-medium rounded-md flex items-center gap-2">
          <Check className="w-4 h-4 shrink-0" /> {feedback}
        </div>
      )}

      {/* Sub-navigation */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`px-3.5 py-2 text-xs font-medium rounded-md whitespace-nowrap shrink-0 cursor-pointer ${
              tab === t.id ? 'bg-[#18181B] text-white' : 'bg-white border border-zinc-200 text-zinc-700 hover:bg-zinc-50'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* 1. OVERVIEW */}
      {tab === 'overview' && overview && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { label: "Today's Revenue", val: formatINR(overview.kpis.today_revenue_paise) },
              { label: 'Cumulative Revenue', val: formatINR(overview.kpis.total_revenue_paise) },
              { label: 'Average Order Value', val: formatINR(overview.kpis.average_order_value_paise) },
              { label: 'Tables Occupied / Free', val: `${overview.kpis.occupied_tables} / ${overview.kpis.available_tables}` },
              { label: 'Total Orders', val: String(overview.kpis.total_orders) },
              { label: 'Active Orders', val: String(overview.kpis.active_orders) },
              { label: 'Completed Orders', val: String(overview.kpis.completed_orders) },
              { label: 'Cancelled / Rejected', val: String(overview.kpis.cancelled_orders) },
            ].map((k) => (
              <div key={k.label} className="bg-white border border-zinc-200 rounded-xl p-4">
                <p className="text-xs text-zinc-500">{k.label}</p>
                <p className="mt-1.5 text-2xl font-bold text-zinc-900 tabular-nums">{k.val}</p>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-8 bg-white border border-zinc-200 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-zinc-900 mb-4">Daily Revenue Trend (INR)</h3>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={(overview.daily_sales || []).map((d: any) => ({
                      day: d.day,
                      revenue_inr: Math.round(d.revenue_paise / 100),
                      orders: d.orders_count,
                    }))}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
                    <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Bar dataKey="revenue_inr" name="Revenue (₹)" fill="#B47B2B" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="lg:col-span-4 bg-white border border-zinc-200 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-zinc-900 mb-4">Top Performing Dishes</h3>
              <div className="space-y-3">
                {(overview.popular_items || []).map((p: any) => (
                  <div key={p.item_name} className="flex items-center justify-between text-xs pb-2 border-b border-zinc-100">
                    <div>
                      <p className="font-semibold text-zinc-900">{p.item_name}</p>
                      <p className="text-zinc-500">{p.total_qty} sold</p>
                    </div>
                    <span className="font-semibold tabular-nums">{formatINR(p.total_sales_paise)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="bg-white border border-zinc-200 rounded-xl p-5 overflow-x-auto">
            <h3 className="text-sm font-semibold text-zinc-900 mb-3">Recent Transactions</h3>
            <table className="w-full text-left text-xs">
              <thead className="bg-zinc-50 border-b border-zinc-200 text-zinc-600">
                <tr>
                  <th className="py-2.5 px-3">Payment ID</th>
                  <th className="py-2.5 px-3">Order</th>
                  <th className="py-2.5 px-3">Method</th>
                  <th className="py-2.5 px-3">Status</th>
                  <th className="py-2.5 px-3 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {(overview.recent_transactions || []).map((tx: any) => (
                  <tr key={tx.id}>
                    <td className="py-2.5 px-3 font-mono">{tx.provider_payment_id || tx.provider_order_id}</td>
                    <td className="py-2.5 px-3 font-mono">{tx.order_number || `Table ${tx.table_number || '—'}`}</td>
                    <td className="py-2.5 px-3 uppercase">{tx.method}</td>
                    <td className="py-2.5 px-3"><StatusLabel status={tx.status} /></td>
                    <td className="py-2.5 px-3 text-right font-semibold tabular-nums">{formatINR(tx.amount_paise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 2. MENU & CATEGORIES */}
      {tab === 'menu' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <form onSubmit={addMenuItem} className="lg:col-span-8 bg-white border border-zinc-200 rounded-xl p-5 space-y-4">
              <h3 className="text-sm font-semibold text-zinc-900 flex items-center gap-1.5">
                <Plus className="w-4 h-4 text-[#B47B2B]" /> Add Menu Dish
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <input
                  required
                  value={newItem.name}
                  onChange={(e) => setNewItem({ ...newItem, name: e.target.value })}
                  placeholder="Dish Name"
                  className="px-3 py-2 text-xs border border-zinc-300 rounded-md"
                />
                <select
                  value={newItem.category_id}
                  onChange={(e) => setNewItem({ ...newItem, category_id: Number(e.target.value) })}
                  className="px-3 py-2 text-xs border border-zinc-300 rounded-md"
                >
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                <input
                  required
                  type="number"
                  value={newItem.price_inr}
                  onChange={(e) => setNewItem({ ...newItem, price_inr: e.target.value })}
                  placeholder="Price (INR)"
                  className="px-3 py-2 text-xs border border-zinc-300 rounded-md"
                />
              </div>
              <input
                required
                value={newItem.description}
                onChange={(e) => setNewItem({ ...newItem, description: e.target.value })}
                placeholder="Culinary description"
                className="w-full px-3 py-2 text-xs border border-zinc-300 rounded-md"
              />
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-4 text-xs">
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={newItem.is_veg} onChange={(e) => setNewItem({ ...newItem, is_veg: e.target.checked })} />
                    Vegetarian
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={newItem.is_bestseller} onChange={(e) => setNewItem({ ...newItem, is_bestseller: e.target.checked })} />
                    Bestseller
                  </label>
                </div>
                <button type="submit" className="px-4 py-2 text-xs font-semibold bg-[#18181B] text-white rounded-md cursor-pointer">
                  Save Dish
                </button>
              </div>
            </form>

            <form onSubmit={addCategory} className="lg:col-span-4 bg-white border border-zinc-200 rounded-xl p-5 space-y-3">
              <h3 className="text-sm font-semibold text-zinc-900">Add Category</h3>
              <input
                required
                value={newCatName}
                onChange={(e) => setNewCatName(e.target.value)}
                placeholder="e.g. Tandoor Specials"
                className="w-full px-3 py-2 text-xs border border-zinc-300 rounded-md"
              />
              <button type="submit" className="w-full py-2 text-xs font-semibold bg-zinc-900 text-white rounded-md cursor-pointer">
                Create Category
              </button>
              <p className="text-[11px] text-zinc-500">{categories.length} active categories configured.</p>
            </form>
          </div>

          <div className="bg-white border border-zinc-200 rounded-xl overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-zinc-50 border-b border-zinc-200 text-zinc-600">
                <tr>
                  <th className="py-3 px-4">Dish</th>
                  <th className="py-3 px-4">Category</th>
                  <th className="py-3 px-4">Price (₹)</th>
                  <th className="py-3 px-4">Availability</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {items.map((it) => (
                  <tr key={it.id}>
                    <td className="py-2.5 px-4">
                      <div className="flex items-center gap-2 font-semibold text-zinc-900">
                        <VegIndicator isVeg={it.is_veg} />
                        {it.name}
                      </div>
                    </td>
                    <td className="py-2.5 px-4 text-zinc-600">{it.category_name}</td>
                    <td className="py-2.5 px-4 tabular-nums font-medium">
                      <button
                        type="button"
                        onClick={() => {
                          const nxt = window.prompt(`Update INR price for ${it.name}:`, String(it.price_paise / 100));
                          if (nxt) updateItemPrice(it, Number(nxt));
                        }}
                        className="hover:underline text-zinc-900 cursor-pointer"
                      >
                        {formatINR(it.price_paise)}
                      </button>
                    </td>
                    <td className="py-2.5 px-4">
                      <button
                        type="button"
                        onClick={() => toggleItemAvailability(it)}
                        className={`px-2.5 py-1 text-[11px] font-medium rounded border cursor-pointer ${
                          it.is_available
                            ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                            : 'bg-zinc-100 border-zinc-300 text-zinc-600'
                        }`}
                      >
                        {it.is_available ? 'Available' : 'Unavailable'}
                      </button>
                    </td>
                    <td className="py-2.5 px-4 text-right">
                      <button
                        type="button"
                        onClick={() => deleteMenuItem(it)}
                        className="p-1.5 text-zinc-400 hover:text-red-600 cursor-pointer"
                        title="Delete / Archive"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 3. TABLES & CRYPTOGRAPHIC QR CODES */}
      {tab === 'tables' && (
        <div className="space-y-6">
          <div className="bg-white border border-zinc-200 rounded-xl p-5 flex flex-col lg:flex-row lg:items-end justify-between gap-4 no-print">
            <form onSubmit={addTable} className="flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-[11px] font-medium text-zinc-600 mb-1">Table #</label>
                <input
                  required
                  type="number"
                  min={1}
                  value={newTable.table_number}
                  onChange={(e) => setNewTable({ ...newTable, table_number: e.target.value })}
                  placeholder="11"
                  className="w-24 px-3 py-2 text-xs border border-zinc-300 rounded-md"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-zinc-600 mb-1">Seats</label>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={newTable.capacity}
                  onChange={(e) => setNewTable({ ...newTable, capacity: e.target.value })}
                  className="w-20 px-3 py-2 text-xs border border-zinc-300 rounded-md"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-zinc-600 mb-1">Section</label>
                <input
                  value={newTable.section}
                  onChange={(e) => setNewTable({ ...newTable, section: e.target.value })}
                  className="w-40 px-3 py-2 text-xs border border-zinc-300 rounded-md"
                />
              </div>
              <button type="submit" className="px-4 py-2 text-xs font-semibold bg-[#18181B] text-white rounded-md cursor-pointer">
                + Add Table &amp; QR
              </button>
            </form>

            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                disabled={qrTables.length === 0}
                onClick={() => {
                  downloadAllTableQrsPdf(qrTables, restaurant);
                  showNotice(`Print-ready PDF downloaded for ${qrTables.length} tables.`);
                }}
                className="px-4 py-2 text-xs font-semibold bg-[#B47B2B] hover:bg-[#9A6620] text-white rounded-md inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                <Download className="w-3.5 h-3.5" /> Download All Table QR Codes as PDF
              </button>
              <button
                type="button"
                onClick={() => window.print()}
                className="px-4 py-2 text-xs font-medium bg-zinc-100 hover:bg-zinc-200 text-zinc-800 rounded-md inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Printer className="w-3.5 h-3.5" /> Print All Table QR Plaques
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
            {qrTables.map((t) => (
              <div key={t.id} className="bg-white border border-zinc-200 rounded-xl p-5 flex flex-col items-center text-center">
                <div className="w-full flex items-center justify-between mb-3">
                  <span className="font-bold text-sm text-zinc-900">{t.label}</span>
                  <StatusLabel status={t.status} />
                </div>
                <img src={t.qr_data_url} alt={`QR for ${t.label}`} className="w-40 h-40 border border-zinc-100 rounded" />
                <p className="mt-2 text-xs text-zinc-500">{t.section} · {t.capacity} Seats</p>
                <p className="mt-1 font-mono text-[10px] text-zinc-400 break-all line-clamp-1">{t.qr_relative_url}</p>

                <div className="mt-4 w-full grid grid-cols-2 gap-2 no-print">
                  <button
                    type="button"
                    onClick={() => onOpenQrUrl(t.qr_relative_url)}
                    className="py-2 px-2 text-xs font-semibold bg-[#18181B] text-white hover:bg-[#B47B2B] rounded-md inline-flex items-center justify-center gap-1 cursor-pointer"
                  >
                    <ExternalLink className="w-3 h-3" /> Open QR
                  </button>
                  <a
                    href={t.qr_data_url}
                    download={`table-${t.table_number}-qr.png`}
                    className="py-2 px-2 text-xs font-medium bg-zinc-100 hover:bg-zinc-200 text-zinc-800 rounded-md inline-flex items-center justify-center gap-1"
                  >
                    <Download className="w-3 h-3" /> PNG
                  </a>
                </div>
                <button
                  type="button"
                  onClick={() => regenerateQr(t.id, t.table_number)}
                  className="mt-2 w-full py-1.5 text-[11px] font-medium text-red-700 hover:bg-red-50 rounded border border-red-100 cursor-pointer no-print"
                >
                  <QrCode className="w-3 h-3 inline mr-1" /> Regenerate &amp; Revoke Old Token
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 4. STAFF & AUDIT */}
      {tab === 'staff' && (
        <div className="space-y-6">
          <form onSubmit={createStaff} className="bg-white border border-zinc-200 rounded-xl p-5 space-y-3">
            <h3 className="text-sm font-semibold text-zinc-900 flex items-center gap-1.5">
              <Shield className="w-4 h-4 text-[#B47B2B]" /> Create Staff Account
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
              <input
                required
                value={newStaff.name}
                onChange={(e) => setNewStaff({ ...newStaff, name: e.target.value })}
                placeholder="Full Name"
                className="px-3 py-2 text-xs border border-zinc-300 rounded-md"
              />
              <input
                required
                type="email"
                value={newStaff.email}
                onChange={(e) => setNewStaff({ ...newStaff, email: e.target.value })}
                placeholder="Email"
                className="px-3 py-2 text-xs border border-zinc-300 rounded-md"
              />
              <input
                required
                type="password"
                minLength={6}
                value={newStaff.password}
                onChange={(e) => setNewStaff({ ...newStaff, password: e.target.value })}
                placeholder="Password (6+ chars)"
                className="px-3 py-2 text-xs border border-zinc-300 rounded-md"
              />
              <select
                value={newStaff.role}
                onChange={(e) => setNewStaff({ ...newStaff, role: e.target.value as RoleSlug })}
                className="px-3 py-2 text-xs border border-zinc-300 rounded-md"
              >
                <option value="waiter">Waiter</option>
                <option value="counter">Counter / POS</option>
                <option value="chef">Kitchen Chef</option>
                <option value="admin">Restaurant Admin</option>
                {userRole === 'super_admin' && <option value="super_admin">Super Admin</option>}
              </select>
              <button type="submit" className="px-4 py-2 text-xs font-semibold bg-[#18181B] text-white rounded-md cursor-pointer">
                Add Staff
              </button>
            </div>
          </form>

          <div className="bg-white border border-zinc-200 rounded-xl overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-zinc-50 border-b border-zinc-200 text-zinc-600">
                <tr>
                  <th className="py-3 px-4">Name</th>
                  <th className="py-3 px-4">Email</th>
                  <th className="py-3 px-4">Role</th>
                  <th className="py-3 px-4">Last Login</th>
                  <th className="py-3 px-4 text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {staffList.map((u) => (
                  <tr key={u.id}>
                    <td className="py-2.5 px-4 font-semibold">{u.name}</td>
                    <td className="py-2.5 px-4 text-zinc-600">{u.email}</td>
                    <td className="py-2.5 px-4">{u.role_name}</td>
                    <td className="py-2.5 px-4 text-zinc-500">{formatDateTimeIST(u.last_login_at)}</td>
                    <td className="py-2.5 px-4 text-right">
                      <button
                        type="button"
                        onClick={() => toggleStaffActive(u)}
                        className={`px-2.5 py-1 text-[11px] font-medium rounded border cursor-pointer ${
                          u.is_active ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-700'
                        }`}
                      >
                        {u.is_active ? 'Active' : 'Disabled'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="bg-white border border-zinc-200 rounded-xl p-5">
            <h3 className="text-sm font-semibold text-zinc-900 mb-3">Security &amp; Operations Audit Trail</h3>
            <div className="max-h-60 overflow-y-auto divide-y divide-zinc-100 text-xs">
              {auditLogs.map((l) => (
                <div key={l.id} className="py-2 flex items-center justify-between gap-4">
                  <span>
                    <strong className="font-mono">{l.action}</strong> · {l.actor_name || l.actor_role || 'guest'} ({l.entity_type})
                  </span>
                  <span className="font-mono text-[11px] text-zinc-400 shrink-0">{formatDateTimeIST(l.created_at)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 5. COUPONS */}
      {tab === 'coupons' && (
        <div className="space-y-6">
          <form onSubmit={createCoupon} className="bg-white border border-zinc-200 rounded-xl p-5 grid grid-cols-1 sm:grid-cols-6 gap-3 items-end">
            <input
              required
              value={newCoupon.code}
              onChange={(e) => setNewCoupon({ ...newCoupon, code: e.target.value.toUpperCase() })}
              placeholder="CODE"
              className="px-3 py-2 text-xs border border-zinc-300 rounded-md uppercase"
            />
            <input
              required
              value={newCoupon.description}
              onChange={(e) => setNewCoupon({ ...newCoupon, description: e.target.value })}
              placeholder="Offer description"
              className="sm:col-span-2 px-3 py-2 text-xs border border-zinc-300 rounded-md"
            />
            <select
              value={newCoupon.discount_type}
              onChange={(e) => setNewCoupon({ ...newCoupon, discount_type: e.target.value as 'percent' | 'fixed' })}
              className="px-3 py-2 text-xs border border-zinc-300 rounded-md"
            >
              <option value="percent">% Off</option>
              <option value="fixed">Flat ₹ Off</option>
            </select>
            <input
              required
              type="number"
              value={newCoupon.discount_value}
              onChange={(e) => setNewCoupon({ ...newCoupon, discount_value: e.target.value })}
              placeholder="Value"
              className="px-3 py-2 text-xs border border-zinc-300 rounded-md"
            />
            <button type="submit" className="px-4 py-2 text-xs font-semibold bg-[#18181B] text-white rounded-md cursor-pointer">
              Add Coupon
            </button>
          </form>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {coupons.map((c) => (
              <div key={c.id} className="bg-white border border-zinc-200 rounded-xl p-4">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-sm font-bold text-[#B47B2B]">{c.code}</span>
                  <span className="text-xs text-zinc-500">{c.used_count} / {c.usage_limit} used</span>
                </div>
                <p className="mt-1.5 text-xs text-zinc-700">{c.description}</p>
                <p className="mt-2 text-[11px] text-zinc-400">
                  Min order: {formatINR(c.min_order_paise)} · Valid until {c.valid_until}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 6. RESERVATIONS */}
      {tab === 'reservations' && (
        <div className="bg-white border border-zinc-200 rounded-xl overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-zinc-50 border-b border-zinc-200 text-zinc-600">
              <tr>
                <th className="py-3 px-4">Code</th>
                <th className="py-3 px-4">Guest</th>
                <th className="py-3 px-4">Date &amp; Time</th>
                <th className="py-3 px-4">Party</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {reservations.map((r) => (
                <tr key={r.id}>
                  <td className="py-3 px-4 font-mono font-semibold">{r.reservation_code}</td>
                  <td className="py-3 px-4">
                    <p className="font-semibold text-zinc-900">{r.customer_name}</p>
                    <p className="text-zinc-500">{r.customer_phone}</p>
                  </td>
                  <td className="py-3 px-4">{r.reservation_date} · {r.reservation_time}</td>
                  <td className="py-3 px-4">{r.guest_count} guests</td>
                  <td className="py-3 px-4"><StatusLabel status={r.status} /></td>
                  <td className="py-3 px-4 text-right space-x-2">
                    <button type="button" onClick={() => updateReservationStatus(r.id, 'confirmed')} className="text-emerald-700 hover:underline cursor-pointer">Confirm</button>
                    <button type="button" onClick={() => updateReservationStatus(r.id, 'seated')} className="text-sky-700 hover:underline cursor-pointer">Seat</button>
                    <button type="button" onClick={() => updateReservationStatus(r.id, 'rejected')} className="text-red-600 hover:underline cursor-pointer">Reject</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 7. REPORTS & EXPORTS */}
      {tab === 'reports' && reports && (
        <div className="space-y-6">
          <div className="bg-white border border-zinc-200 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-zinc-900">Financial &amp; Tax Reports</h3>
              <p className="text-xs text-zinc-500">
                Total Gross: {formatINR(reports.taxSummary.total_paise)} · GST Collected: {formatINR(reports.taxSummary.gst_paise)}
              </p>
            </div>
            <div className="flex gap-2.5">
              <button
                type="button"
                onClick={() =>
                  exportRowsToCsv(
                    'restaurant360-item-sales.csv',
                    ['Dish', 'Category', 'Qty', 'Revenue (INR)'],
                    (reports.itemWise || []).map((r: any) => [r.item_name, r.category_name, r.qty, (r.revenue_paise / 100).toFixed(2)])
                  )
                }
                className="px-4 py-2 text-xs font-medium bg-white border border-zinc-300 rounded-md inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" /> Export CSV
              </button>
              <button
                type="button"
                onClick={exportSalesReportPdf}
                className="px-4 py-2 text-xs font-semibold bg-[#18181B] text-white rounded-md inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" /> Export PDF Report
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white border border-zinc-200 rounded-xl p-5">
              <h4 className="text-sm font-semibold mb-3">Category-Wise Revenue</h4>
              <div className="space-y-2 text-xs">
                {(reports.categoryWise || []).map((c: any) => (
                  <div key={c.category_name} className="flex justify-between py-1.5 border-b border-zinc-100">
                    <span>{c.category_name} ({c.qty} items)</span>
                    <span className="font-semibold tabular-nums">{formatINR(c.revenue_paise)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-white border border-zinc-200 rounded-xl p-5">
              <h4 className="text-sm font-semibold mb-3">Table-Wise Revenue</h4>
              <div className="space-y-2 text-xs">
                {(reports.tableWise || []).map((t: any) => (
                  <div key={t.table_number} className="flex justify-between py-1.5 border-b border-zinc-100">
                    <span>{t.label} ({t.orders_count} orders)</span>
                    <span className="font-semibold tabular-nums">{formatINR(t.revenue_paise)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 8. SETTINGS */}
      {tab === 'settings' && (
        <form onSubmit={saveSettings} className="bg-white border border-zinc-200 rounded-xl p-6 max-w-2xl space-y-4">
          <h3 className="text-base font-semibold text-zinc-900">Restaurant Brand, Tax &amp; Kitchen Settings</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-zinc-600 mb-1">Restaurant Name</label>
              <input value={settingsForm.name} onChange={(e) => setSettingsForm({ ...settingsForm, name: e.target.value })} className="w-full px-3 py-2 text-xs border border-zinc-300 rounded-md" />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-600 mb-1">GSTIN</label>
              <input value={settingsForm.gstin} onChange={(e) => setSettingsForm({ ...settingsForm, gstin: e.target.value })} className="w-full px-3 py-2 text-xs border border-zinc-300 rounded-md" />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-600 mb-1">GST Rate (basis points, 500 = 5%)</label>
              <input type="number" value={settingsForm.gst_rate_bps} onChange={(e) => setSettingsForm({ ...settingsForm, gst_rate_bps: e.target.value })} className="w-full px-3 py-2 text-xs border border-zinc-300 rounded-md" />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-600 mb-1">Service Charge (bps, 500 = 5%)</label>
              <input type="number" value={settingsForm.service_charge_bps} onChange={(e) => setSettingsForm({ ...settingsForm, service_charge_bps: e.target.value })} className="w-full px-3 py-2 text-xs border border-zinc-300 rounded-md" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-600 mb-1">Address</label>
            <input value={settingsForm.address} onChange={(e) => setSettingsForm({ ...settingsForm, address: e.target.value })} className="w-full px-3 py-2 text-xs border border-zinc-300 rounded-md" />
          </div>
          <label className="flex items-center gap-2 text-xs text-zinc-700">
            <input
              type="checkbox"
              checked={settingsForm.auto_accept_kitchen}
              onChange={(e) => setSettingsForm({ ...settingsForm, auto_accept_kitchen: e.target.checked })}
            />
            Auto-accept paid orders in Kitchen Display System
          </label>
          <button type="submit" className="px-5 py-2.5 text-xs font-semibold bg-[#18181B] text-white rounded-md cursor-pointer">
            Save Configuration
          </button>
        </form>
      )}

      <ConfirmModal
        open={resetConfirmOpen}
        title="Reset Restaurant Demo Database?"
        message="This restores all 10 tables, 37 menu items, 5 staff roles, coupons, and demo history to their initial state."
        confirmLabel="Reset Demo Data"
        destructive
        onConfirm={handleDemoReset}
        onCancel={() => setResetConfirmOpen(false)}
      />
    </div>
  );
}
