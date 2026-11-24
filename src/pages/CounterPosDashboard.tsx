import React, { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeftRight,
  CheckCircle2,
  CreditCard,
  Download,
  Printer,
  QrCode,
  Receipt,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import type {
  DiningTable,
  InvoiceRecord,
  Order,
  PaymentRecord,
  RestaurantInfo,
} from '../types.ts';
import { apiFetch, parseJsonSafe } from '../lib/api.ts';
import {
  downloadAllTableQrsPdf,
  downloadInvoicePdf,
  formatDateTimeIST,
  formatINR,
  type PrintableTableQr,
} from '../lib/format.ts';
import { useRealtimeRoom } from '../lib/ws.ts';
import { ConfirmModal, StatusLabel } from '../components/ui.tsx';

interface QrTableItem extends PrintableTableQr {
  id: number;
  status: string;
  qr_relative_url: string;
  qr_full_url: string;
}

interface TableBillData {
  table: DiningTable;
  session: { id: number; session_code: string; status: string; opened_at: string } | null;
  orders: Order[];
  payments: PaymentRecord[];
  totals: {
    subtotal_paise: number;
    gst_paise: number;
    service_charge_paise: number;
    discount_paise: number;
    grand_total_paise: number;
    paid_paise: number;
    outstanding_paise: number;
  } | null;
}

export function CounterPosDashboard({
  staffToken,
  restaurant,
}: {
  staffToken: string;
  restaurant: RestaurantInfo | null;
}) {
  const [tab, setTab] = useState<'tables' | 'orders' | 'invoices' | 'qrs'>('tables');
  const [tables, setTables] = useState<DiningTable[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRecord[]>([]);
  const [qrTables, setQrTables] = useState<QrTableItem[]>([]);
  const [generatingQrPdf, setGeneratingQrPdf] = useState(false);
  const [qrNotice, setQrNotice] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [search, setSearch] = useState('');

  // Selected Table Consolidated Bill Drawer
  const [selectedTableId, setSelectedTableId] = useState<number | null>(null);
  const [billData, setBillData] = useState<TableBillData | null>(null);
  const [payAmountRupees, setPayAmountRupees] = useState('');
  const [payMethod, setPayMethod] = useState<'cash' | 'upi' | 'card'>('cash');
  const [confirmReceipt, setConfirmReceipt] = useState(false);
  const [posMessage, setPosMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Table Transfer & Close Confirmation
  const [transferTargetId, setTransferTargetId] = useState<string>('');
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [lastInvoice, setLastInvoice] = useState<InvoiceRecord | null>(null);
  const [printInvoice, setPrintInvoice] = useState<InvoiceRecord | null>(null);
  const [pendingPrint, setPendingPrint] = useState(false);

  const triggerPrintInvoice = useCallback((inv: InvoiceRecord) => {
    setPrintInvoice(inv);
    setPendingPrint(true);
  }, []);

  useEffect(() => {
    if (!pendingPrint || !printInvoice) return;
    setPendingPrint(false);
    const frame1 = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        window.print();
      });
    });
    return () => window.cancelAnimationFrame(frame1);
  }, [pendingPrint, printInvoice]);

  const loadAll = useCallback(async () => {
    try {
      const [tRes, oRes, iRes, qRes] = await Promise.all([
        apiFetch('/api/pos/tables', { headers: { Authorization: `Bearer ${staffToken}` } }),
        apiFetch('/api/pos/orders', { headers: { Authorization: `Bearer ${staffToken}` } }),
        apiFetch('/api/pos/invoices', { headers: { Authorization: `Bearer ${staffToken}` } }),
        apiFetch('/api/admin/tables/qrs', { headers: { Authorization: `Bearer ${staffToken}` } }),
      ]);
      if (tRes.ok) setTables((await parseJsonSafe<{ tables?: DiningTable[] }>(tRes)).tables || []);
      if (oRes.ok) setOrders((await parseJsonSafe<{ orders?: Order[] }>(oRes)).orders || []);
      if (iRes.ok) setInvoices((await parseJsonSafe<{ invoices?: InvoiceRecord[] }>(iRes)).invoices || []);
      if (qRes.ok) setQrTables((await parseJsonSafe<{ tables?: QrTableItem[] }>(qRes)).tables || []);
    } catch {
      // Ignore transient error
    }
  }, [staffToken]);

  const handleBulkGenerateQrPdf = useCallback(
    async (subset?: QrTableItem[]) => {
      setGeneratingQrPdf(true);
      setQrNotice(null);
      try {
        const resp = await apiFetch('/api/admin/tables/qrs', {
          headers: { Authorization: `Bearer ${staffToken}` },
        });
        const data = await parseJsonSafe<{ tables?: QrTableItem[]; error?: string }>(resp);
        if (!resp.ok) {
          throw new Error(data.error || 'Could not generate table QR sheets');
        }
        const freshTables = data.tables || [];
        setQrTables(freshTables);

        const targetTables = subset
          ? freshTables.filter((t) => subset.some((s) => s.id === t.id))
          : freshTables;

        if (targetTables.length === 0) {
          setQrNotice({ type: 'err', text: 'No tables available to include in the QR PDF sheet.' });
          return;
        }

        downloadAllTableQrsPdf(targetTables, restaurant);
        setQrNotice({
          type: 'ok',
          text: `Generated and downloaded printable QR PDF for ${targetTables.length} ${
            targetTables.length === 1 ? 'table' : 'tables'
          }.`,
        });
      } catch (err: unknown) {
        setQrNotice({
          type: 'err',
          text: err instanceof Error ? err.message : 'Failed to generate QR PDF sheet',
        });
      } finally {
        setGeneratingQrPdf(false);
      }
    },
    [staffToken, restaurant]
  );

  const loadTableBill = useCallback(
    async (tableId: number) => {
      try {
        const resp = await apiFetch(`/api/pos/tables/${tableId}/bill`, {
          headers: { Authorization: `Bearer ${staffToken}` },
        });
        if (resp.ok) {
          const data = await parseJsonSafe<TableBillData>(resp);
          setBillData(data);
          if (data.totals) {
            setPayAmountRupees(String(Math.round(data.totals.outstanding_paise / 100)));
          }
        }
      } catch {
        // Ignore transient error
      }
    },
    [staffToken]
  );

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useRealtimeRoom({
    room: 'role:counter',
    staffToken,
    onEvent: () => {
      loadAll();
      if (selectedTableId) loadTableBill(selectedTableId);
    },
  });

  function openTableDrawer(tableId: number) {
    setSelectedTableId(tableId);
    setPosMessage(null);
    setLastInvoice(null);
    setConfirmReceipt(false);
    loadTableBill(tableId);
  }

  async function recordCounterPayment(e: React.FormEvent) {
    e.preventDefault();
    if (!billData || !selectedTableId) return;
    setPosMessage(null);
    const amountPaise = Math.round(Number(payAmountRupees) * 100);
    if (!Number.isFinite(amountPaise) || amountPaise <= 0) {
      setPosMessage({ type: 'err', text: 'Enter a valid payment amount in INR.' });
      return;
    }
    try {
      const resp = await apiFetch('/api/pos/payments/record', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${staffToken}`,
        },
        body: JSON.stringify({
          table_id: selectedTableId,
          amount_paise: amountPaise,
          method: payMethod,
          confirm_received: confirmReceipt,
        }),
      });
      const data = await parseJsonSafe<{ error?: string }>(resp);
      if (!resp.ok) {
        setPosMessage({ type: 'err', text: data.error || 'Failed to record payment' });
        return;
      }
      setPosMessage({ type: 'ok', text: `Payment of ${formatINR(amountPaise)} recorded via ${payMethod.toUpperCase()}.` });
      setConfirmReceipt(false);
      await Promise.all([loadAll(), loadTableBill(selectedTableId)]);
    } catch (err: unknown) {
      setPosMessage({ type: 'err', text: err instanceof Error ? err.message : 'Failed to record payment' });
    }
  }

  async function cancelOrderItem(itemId: number) {
    if (!selectedTableId) return;
    try {
      const resp = await apiFetch(`/api/pos/orders/${itemId}/cancel-item`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${staffToken}`,
        },
        body: JSON.stringify({ reason: 'Cancelled by Counter POS staff' }),
      });
      if (resp.ok) {
        setPosMessage({ type: 'ok', text: 'Item cancelled and consolidated bill recalculated.' });
        await Promise.all([loadAll(), loadTableBill(selectedTableId)]);
      }
    } catch (err: unknown) {
      setPosMessage({ type: 'err', text: err instanceof Error ? err.message : 'Could not cancel item' });
    }
  }

  async function refundPayment(paymentId: number, amountPaise: number) {
    if (!selectedTableId) return;
    try {
      const resp = await apiFetch('/api/pos/refunds', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${staffToken}`,
        },
        body: JSON.stringify({
          payment_id: paymentId,
          amount_paise: amountPaise,
          reason: 'Counter staff authorized refund',
        }),
      });
      if (resp.ok) {
        setPosMessage({ type: 'ok', text: `Refund of ${formatINR(amountPaise)} processed.` });
        await Promise.all([loadAll(), loadTableBill(selectedTableId)]);
      }
    } catch (err: unknown) {
      setPosMessage({ type: 'err', text: err instanceof Error ? err.message : 'Refund failed' });
    }
  }

  async function transferTable() {
    if (!selectedTableId || !transferTargetId) return;
    try {
      const resp = await apiFetch(`/api/pos/tables/${selectedTableId}/transfer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${staffToken}`,
        },
        body: JSON.stringify({ target_table_id: Number(transferTargetId) }),
      });
      const data = await parseJsonSafe<{ error?: string }>(resp);
      if (!resp.ok) {
        setPosMessage({ type: 'err', text: data.error || 'Transfer failed' });
        return;
      }
      const targetNum = Number(transferTargetId);
      setTransferTargetId('');
      await loadAll();
      openTableDrawer(targetNum);
    } catch (err: unknown) {
      setPosMessage({ type: 'err', text: err instanceof Error ? err.message : 'Transfer failed' });
    }
  }

  async function closeTableSession() {
    if (!selectedTableId) return;
    setCloseConfirmOpen(false);
    try {
      const resp = await apiFetch(`/api/pos/tables/${selectedTableId}/close`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${staffToken}` },
      });
      const data = await parseJsonSafe<{ invoice: InvoiceRecord; error?: string }>(resp);
      if (!resp.ok) {
        setPosMessage({ type: 'err', text: data.error || 'Could not close session' });
        return;
      }
      setLastInvoice(data.invoice);
      setPosMessage({ type: 'ok', text: `Table settled! Invoice ${data.invoice.invoice_number} generated.` });
      await loadAll();
    } catch (err: unknown) {
      setPosMessage({ type: 'err', text: err instanceof Error ? err.message : 'Could not close session' });
    }
  }

  const filteredTables = tables.filter(
    (t) =>
      t.label.toLowerCase().includes(search.toLowerCase()) ||
      t.section.toLowerCase().includes(search.toLowerCase())
  );

  const filteredOrders = orders.filter(
    (o) =>
      o.order_number.toLowerCase().includes(search.toLowerCase()) ||
      String(o.table_number).includes(search)
  );

  const filteredInvoices = invoices.filter(
    (inv) =>
      inv.invoice_number.toLowerCase().includes(search.toLowerCase()) ||
      String(inv.table_number).includes(search) ||
      (inv.session_code || '').toLowerCase().includes(search.toLowerCase())
  );

  const filteredQrTables = qrTables.filter(
    (t) =>
      t.label.toLowerCase().includes(search.toLowerCase()) ||
      t.section.toLowerCase().includes(search.toLowerCase()) ||
      String(t.table_number).includes(search)
  );

  const printableItems = (printInvoice?.orders || [])
    .filter((o) => o.status !== 'cancelled' && o.status !== 'rejected')
    .flatMap((o) =>
      o.items
        .filter((it) => !it.is_cancelled)
        .map((it) => ({ ...it, order_number: o.order_number }))
    );

  const printablePayments = (printInvoice?.payments || []).filter((p) => p.status === 'captured');

  return (
    <>
    <div className="space-y-6 no-print">
      {/* Header & Tabs */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-zinc-200">
        <div>
          <h2 className="text-xl font-bold text-zinc-900">Counter POS &amp; Billing</h2>
          <p className="text-xs text-zinc-500">Live table sessions, consolidated bills, payments, refunds, and GST invoices</p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search table or order..."
              className="pl-8 pr-3 py-2 text-xs bg-white border border-zinc-300 rounded-md"
            />
          </div>
          <div className="inline-flex bg-zinc-100 p-0.5 rounded-md">
            {(
              [
                ['tables', 'Table Grid'],
                ['orders', `Live Orders (${orders.length})`],
                ['invoices', `Invoices (${invoices.length})`],
                ['qrs', `QR Sheets (${qrTables.length})`],
              ] as const
            ).map(([k, lbl]) => (
              <button
                key={k}
                type="button"
                onClick={() => setTab(k)}
                className={`px-3 py-1.5 text-xs font-medium rounded cursor-pointer whitespace-nowrap ${
                  tab === k ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-600'
                }`}
              >
                {lbl}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={loadAll}
            className="p-2 bg-white border border-zinc-200 rounded-md text-zinc-600 hover:text-zinc-900 cursor-pointer"
            title="Refresh POS"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* TAB 1: TABLE GRID */}
      {tab === 'tables' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
          {filteredTables.map((t) => {
            const occupied = t.status === 'occupied' || (t.active_orders_count ?? 0) > 0;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => openTableDrawer(t.id)}
                className={`text-left p-4 rounded-xl border transition-all cursor-pointer ${
                  occupied
                    ? 'bg-amber-50/50 border-amber-300 hover:border-amber-500'
                    : 'bg-white border-zinc-200 hover:border-zinc-400'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-base font-bold text-zinc-900">{t.label}</span>
                  <StatusLabel status={t.status} />
                </div>
                <p className="mt-1 text-xs text-zinc-500">{t.section} · {t.capacity} Seats</p>

                {occupied ? (
                  <div className="mt-4 pt-3 border-t border-amber-200/70 space-y-1 text-xs">
                    <div className="flex justify-between">
                      <span className="text-zinc-600">Active Orders</span>
                      <span className="font-semibold tabular-nums">{t.active_orders_count || 0}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-zinc-600">Kitchen Pending</span>
                      <span className="font-semibold tabular-nums">{t.pending_kitchen_count || 0}</span>
                    </div>
                    <div className="flex justify-between text-sm font-bold text-zinc-900 pt-1">
                      <span>Bill Total</span>
                      <span className="tabular-nums">{formatINR(t.total_bill_paise || 0)}</span>
                    </div>
                    {(t.outstanding_paise || 0) > 0 ? (
                      <p className="text-red-600 font-semibold tabular-nums">
                        Due: {formatINR(t.outstanding_paise || 0)}
                      </p>
                    ) : (t.pending_kitchen_count || 0) === 0 ? (
                      <p className="text-emerald-700 font-semibold">
                        Paid &amp; Served · Click to Complete &amp; Free Table
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <div className="mt-4 pt-3 border-t border-zinc-100 text-xs text-zinc-400">
                    Ready for guests · Click to inspect
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* TAB 2: LIVE ORDERS */}
      {tab === 'orders' && (
        <div className="bg-white border border-zinc-200 rounded-xl overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-zinc-50 border-b border-zinc-200 text-zinc-600">
              <tr>
                <th className="py-3 px-4 font-semibold">Order</th>
                <th className="py-3 px-4 font-semibold">Table</th>
                <th className="py-3 px-4 font-semibold">Items</th>
                <th className="py-3 px-4 font-semibold">Kitchen</th>
                <th className="py-3 px-4 font-semibold">Payment</th>
                <th className="py-3 px-4 font-semibold text-right">Total</th>
                <th className="py-3 px-4 font-semibold text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {filteredOrders.map((o) => (
                <tr key={o.id} className="hover:bg-zinc-50/80">
                  <td className="py-3 px-4">
                    <span className="font-mono font-semibold text-zinc-900">{o.order_number}</span>
                    <p className="text-[11px] text-zinc-400">{formatDateTimeIST(o.created_at)}</p>
                  </td>
                  <td className="py-3 px-4 font-semibold">Table {String(o.table_number).padStart(2, '0')}</td>
                  <td className="py-3 px-4 text-zinc-600">
                    {o.items.map((i) => `${i.quantity}× ${i.item_name}`).join(', ')}
                  </td>
                  <td className="py-3 px-4"><StatusLabel status={o.status} /></td>
                  <td className="py-3 px-4"><StatusLabel status={o.payment_status} /></td>
                  <td className="py-3 px-4 text-right font-semibold tabular-nums">{formatINR(o.total_paise)}</td>
                  <td className="py-3 px-4 text-right">
                    <button
                      type="button"
                      onClick={() => openTableDrawer(o.table_id)}
                      className="text-xs font-medium text-[#B47B2B] hover:underline cursor-pointer"
                    >
                      Open Table
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* TAB 3: INVOICES (COMPLETED SESSIONS) */}
      {tab === 'invoices' && (
        <div className="bg-white border border-zinc-200 rounded-xl overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-zinc-50 border-b border-zinc-200 text-zinc-600">
              <tr>
                <th className="py-3 px-4 font-semibold">Invoice #</th>
                <th className="py-3 px-4 font-semibold">Table</th>
                <th className="py-3 px-4 font-semibold">Date</th>
                <th className="py-3 px-4 font-semibold text-right">Subtotal</th>
                <th className="py-3 px-4 font-semibold text-right">Taxes &amp; Svc</th>
                <th className="py-3 px-4 font-semibold text-right">Grand Total</th>
                <th className="py-3 px-4 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {filteredInvoices.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-zinc-500">
                    No completed session invoices found.
                  </td>
                </tr>
              ) : (
                filteredInvoices.map((inv) => (
                  <tr key={inv.id} className="hover:bg-zinc-50">
                    <td className="py-3 px-4">
                      <span className="font-mono font-semibold text-zinc-900">{inv.invoice_number}</span>
                      {inv.session_code && (
                        <p className="font-mono text-[11px] text-zinc-400">{inv.session_code}</p>
                      )}
                    </td>
                    <td className="py-3 px-4">Table {String(inv.table_number).padStart(2, '0')}</td>
                    <td className="py-3 px-4 text-zinc-500">{formatDateTimeIST(inv.created_at)}</td>
                    <td className="py-3 px-4 text-right tabular-nums">{formatINR(inv.subtotal_paise)}</td>
                    <td className="py-3 px-4 text-right tabular-nums">{formatINR(inv.gst_paise + inv.service_charge_paise)}</td>
                    <td className="py-3 px-4 text-right font-semibold tabular-nums">{formatINR(inv.grand_total_paise)}</td>
                    <td className="py-3 px-4 text-right">
                      <div className="inline-flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => triggerPrintInvoice(inv)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-white border border-zinc-300 text-zinc-800 rounded hover:border-[#B47B2B] hover:text-[#B47B2B] cursor-pointer"
                        >
                          <Printer className="w-3 h-3" /> Print Invoice
                        </button>
                        <button
                          type="button"
                          onClick={() => downloadInvoicePdf(inv, inv.orders || [], restaurant)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-zinc-900 text-white rounded hover:bg-[#B47B2B] cursor-pointer"
                        >
                          <Download className="w-3 h-3" /> PDF
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* TAB 4: BULK TABLE QR CODE SHEETS */}
      {tab === 'qrs' && (
        <div className="space-y-5">
          <div className="bg-white border border-zinc-200 rounded-xl p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <QrCode className="w-4 h-4 text-[#B47B2B]" />
                <h3 className="text-sm font-bold text-zinc-900">
                  Bulk Table QR Code Sheets (Print-Ready A4 PDF)
                </h3>
              </div>
              <p className="text-xs text-zinc-500">
                Generate and download a single multi-page PDF with formatted table plaques, cut guides, and verified table-side ordering QR codes ({qrTables.length} tables · 4 plaques per page).
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2.5 shrink-0">
              {search.trim() && filteredQrTables.length > 0 && filteredQrTables.length < qrTables.length && (
                <button
                  type="button"
                  disabled={generatingQrPdf}
                  onClick={() => handleBulkGenerateQrPdf(filteredQrTables)}
                  className="px-3.5 py-2 text-xs font-semibold bg-white border border-zinc-300 text-zinc-800 hover:border-[#B47B2B] hover:text-[#B47B2B] rounded-md inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download Filtered ({filteredQrTables.length}) PDF
                </button>
              )}
              <button
                type="button"
                disabled={generatingQrPdf || qrTables.length === 0}
                onClick={() => handleBulkGenerateQrPdf()}
                className="px-4 py-2 text-xs font-semibold bg-[#B47B2B] hover:bg-[#9A6620] text-white rounded-md inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                <Download className="w-3.5 h-3.5" />
                {generatingQrPdf
                  ? 'Generating QR PDF...'
                  : `Generate & Download All Table QRs (${qrTables.length}) as PDF`}
              </button>
            </div>
          </div>

          {qrNotice && (
            <div
              className={`p-3 rounded-lg text-xs border flex items-center justify-between gap-2 ${
                qrNotice.type === 'ok'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  : 'bg-red-50 border-red-200 text-red-700'
              }`}
            >
              <span>{qrNotice.text}</span>
              <button
                type="button"
                onClick={() => setQrNotice(null)}
                className="font-semibold hover:underline cursor-pointer"
              >
                Dismiss
              </button>
            </div>
          )}

          {filteredQrTables.length === 0 ? (
            <div className="bg-white border border-zinc-200 rounded-xl py-12 text-center text-xs text-zinc-500">
              No matching tables found for QR sheet generation.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {filteredQrTables.map((t) => (
                <div
                  key={t.id}
                  className="bg-white border border-zinc-200 rounded-xl p-4 flex flex-col items-center text-center"
                >
                  <div className="w-full flex items-center justify-between mb-3">
                    <span className="font-bold text-sm text-zinc-900">{t.label}</span>
                    <StatusLabel status={t.status} />
                  </div>
                  <img
                    src={t.qr_data_url}
                    alt={`QR code for ${t.label}`}
                    className="w-36 h-36 border border-zinc-100 rounded"
                  />
                  <p className="mt-2 text-xs text-zinc-500">
                    {t.section} · {t.capacity} Seats
                  </p>
                  <p className="mt-1 font-mono text-[10px] text-zinc-400 break-all line-clamp-1">
                    {t.qr_relative_url}
                  </p>
                  <a
                    href={t.qr_data_url}
                    download={`table-${t.table_number}-qr.png`}
                    className="mt-3 w-full py-1.5 px-3 text-xs font-medium bg-zinc-100 hover:bg-zinc-200 text-zinc-800 rounded-md inline-flex items-center justify-center gap-1.5"
                  >
                    <Download className="w-3 h-3" /> Download PNG
                  </a>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* CONSOLIDATED TABLE BILL DRAWER */}
      {selectedTableId && billData && (
        <div className="fixed inset-0 z-50 bg-black/60 flex justify-end">
          <div className="w-full max-w-2xl bg-white h-full flex flex-col justify-between overflow-hidden">
            <div className="px-6 py-4 border-b border-zinc-200 flex items-center justify-between bg-zinc-50">
              <div>
                <h3 className="text-lg font-bold text-zinc-900">
                  {billData.table.label} · Consolidated Session Bill
                </h3>
                <p className="text-xs text-zinc-500 font-mono">
                  {billData.session ? `Session ${billData.session.session_code}` : 'No Active Session'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedTableId(null)}
                className="p-2 text-zinc-500 hover:text-zinc-900"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {posMessage && (
                <div
                  className={`p-3 rounded-md text-xs border ${
                    posMessage.type === 'ok'
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                      : 'bg-red-50 border-red-200 text-red-700'
                  }`}
                >
                  {posMessage.text}
                </div>
              )}

              {lastInvoice && (
                <div className="p-4 bg-emerald-50 border border-emerald-300 rounded-lg flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-emerald-900 flex items-center gap-1.5">
                      <CheckCircle2 className="w-4 h-4" /> Session Settled · {lastInvoice.invoice_number}
                    </p>
                    <p className="text-xs text-emerald-700 mt-0.5">
                      Total Paid: {formatINR(lastInvoice.paid_paise)}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        downloadInvoicePdf(
                          lastInvoice,
                          lastInvoice.orders || billData.orders,
                          restaurant
                        )
                      }
                      className="px-3 py-1.5 text-xs font-semibold bg-emerald-700 text-white rounded-md inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5" /> Download PDF
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        triggerPrintInvoice({
                          ...lastInvoice,
                          session_code: lastInvoice.session_code || billData.session?.session_code,
                          orders: lastInvoice.orders || billData.orders,
                          payments: lastInvoice.payments || billData.payments,
                        })
                      }
                      className="px-3 py-1.5 text-xs font-semibold bg-white border border-emerald-300 text-emerald-900 hover:bg-emerald-100 rounded-md inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      <Printer className="w-3.5 h-3.5" /> Print Invoice
                    </button>
                  </div>
                </div>
              )}

              {!billData.session ? (
                <div className="py-12 text-center text-sm text-zinc-500 border border-dashed border-zinc-300 rounded-xl">
                  This table is currently available with no active orders.
                </div>
              ) : (
                <>
                  {/* Individual Orders List */}
                  <div className="space-y-4">
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                      Orders in Active Session ({billData.orders.length})
                    </h4>
                    {billData.orders.map((ord) => (
                      <div key={ord.id} className="border border-zinc-200 rounded-lg p-4 space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-zinc-100">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs font-bold text-zinc-900">{ord.order_number}</span>
                            {ord.ticket_number && (
                              <span className="font-mono text-[11px] text-zinc-500">({ord.ticket_number})</span>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5">
                            <StatusLabel status={ord.payment_status} />
                            <StatusLabel status={ord.status} />
                          </div>
                        </div>

                        {ord.items.map((it) => (
                          <div key={it.id} className="flex items-center justify-between text-xs py-1">
                            <span className={it.is_cancelled ? 'line-through text-zinc-400' : 'text-zinc-800'}>
                              {it.quantity} × {it.item_name}
                              {it.variant_name ? ` (${it.variant_name})` : ''}
                            </span>
                            <div className="flex items-center gap-3">
                              <span className="font-medium tabular-nums">{formatINR(it.line_total_paise)}</span>
                              {!it.is_cancelled && ord.status !== 'completed' && (
                                <button
                                  type="button"
                                  onClick={() => cancelOrderItem(it.id)}
                                  className="text-[11px] text-red-600 hover:underline cursor-pointer"
                                >
                                  Cancel Item
                                </button>
                              )}
                            </div>
                          </div>
                        ))}

                        <div className="pt-2 border-t border-zinc-100 flex justify-between text-xs font-semibold">
                          <span>Order Total (incl. GST &amp; Svc)</span>
                          <span className="tabular-nums">{formatINR(ord.total_paise)}</span>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Consolidated Totals */}
                  {billData.totals && (
                    <div className="bg-zinc-900 text-white rounded-xl p-5 space-y-2 text-xs">
                      <div className="flex justify-between text-zinc-300">
                        <span>Combined Subtotal</span>
                        <span className="tabular-nums">{formatINR(billData.totals.subtotal_paise)}</span>
                      </div>
                      <div className="flex justify-between text-zinc-300">
                        <span>GST + Service Charge</span>
                        <span className="tabular-nums">
                          {formatINR(billData.totals.gst_paise + billData.totals.service_charge_paise)}
                        </span>
                      </div>
                      {billData.totals.discount_paise > 0 && (
                        <div className="flex justify-between text-emerald-400">
                          <span>Discounts</span>
                          <span className="tabular-nums">-{formatINR(billData.totals.discount_paise)}</span>
                        </div>
                      )}
                      <div className="flex justify-between text-sm font-bold pt-2 border-t border-zinc-700">
                        <span>Consolidated Grand Total</span>
                        <span className="tabular-nums">{formatINR(billData.totals.grand_total_paise)}</span>
                      </div>
                      <div className="flex justify-between text-emerald-400 font-medium">
                        <span>Total Verified Payments</span>
                        <span className="tabular-nums">{formatINR(billData.totals.paid_paise)}</span>
                      </div>
                      <div className="flex justify-between text-base font-bold text-[#D4A359] pt-1">
                        <span>Outstanding Balance</span>
                        <span className="tabular-nums">{formatINR(billData.totals.outstanding_paise)}</span>
                      </div>
                    </div>
                  )}

                  {/* Payment History & Refund Action */}
                  <div className="space-y-2">
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                      Payment Records ({billData.payments.length})
                    </h4>
                    {billData.payments.map((p) => (
                      <div key={p.id} className="p-3 border border-zinc-200 rounded-lg flex items-center justify-between text-xs">
                        <div>
                          <p className="font-semibold text-zinc-900 uppercase">
                            {p.method} · {formatINR(p.amount_paise)}
                          </p>
                          <p className="text-zinc-500 font-mono text-[11px]">
                            {p.provider_payment_id || p.provider_order_id} · {formatDateTimeIST(p.created_at)}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <StatusLabel status={p.status} />
                          {p.status === 'captured' && (
                            <button
                              type="button"
                              onClick={() => refundPayment(p.id, p.amount_paise)}
                              className="text-[11px] text-red-600 hover:underline cursor-pointer"
                            >
                              Refund
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Record Counter Cash / UPI / Card Settlement */}
                  {billData.totals && billData.totals.outstanding_paise > 0 && (
                    <form onSubmit={recordCounterPayment} className="border border-zinc-200 rounded-xl p-4 space-y-3 bg-zinc-50">
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-700 flex items-center gap-1.5">
                        <CreditCard className="w-3.5 h-3.5 text-[#B47B2B]" /> Record Counter Payment
                      </h4>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[11px] font-medium text-zinc-600 mb-1">Amount (INR)</label>
                          <input
                            type="number"
                            step="0.01"
                            value={payAmountRupees}
                            onChange={(e) => setPayAmountRupees(e.target.value)}
                            className="w-full px-3 py-2 text-sm bg-white border border-zinc-300 rounded-md tabular-nums"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] font-medium text-zinc-600 mb-1">Method</label>
                          <select
                            value={payMethod}
                            onChange={(e) => setPayMethod(e.target.value as typeof payMethod)}
                            className="w-full px-3 py-2 text-sm bg-white border border-zinc-300 rounded-md"
                          >
                            <option value="cash">Cash Received</option>
                            <option value="upi">Counter UPI QR</option>
                            <option value="card">POS Card Terminal</option>
                          </select>
                        </div>
                      </div>
                      <label className="flex items-center gap-2 text-xs text-zinc-700 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={confirmReceipt}
                          onChange={(e) => setConfirmReceipt(e.target.checked)}
                        />
                        I confirm physical/terminal receipt of this payment amount.
                      </label>
                      <button
                        type="submit"
                        disabled={!confirmReceipt}
                        className="w-full py-2.5 text-xs font-semibold bg-emerald-700 text-white rounded-md hover:bg-emerald-800 disabled:opacity-40 cursor-pointer"
                      >
                        Confirm &amp; Record Payment
                      </button>
                    </form>
                  )}

                  {/* Transfer Table Session */}
                  <div className="border border-zinc-200 rounded-xl p-4 flex flex-wrap items-center gap-3">
                    <ArrowLeftRight className="w-4 h-4 text-zinc-500 shrink-0" />
                    <select
                      value={transferTargetId}
                      onChange={(e) => setTransferTargetId(e.target.value)}
                      className="flex-1 px-3 py-2 text-xs border border-zinc-300 rounded-md"
                    >
                      <option value="">Transfer session to available table...</option>
                      {tables
                        .filter((t) => t.id !== selectedTableId && t.status === 'available')
                        .map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.label} ({t.section})
                          </option>
                        ))}
                    </select>
                    <button
                      type="button"
                      disabled={!transferTargetId}
                      onClick={transferTable}
                      className="px-3.5 py-2 text-xs font-medium bg-zinc-900 text-white rounded-md disabled:opacity-40 cursor-pointer"
                    >
                      Transfer
                    </button>
                  </div>
                </>
              )}
            </div>

            {billData.session && (
              <div className="p-4 border-t border-zinc-200 bg-zinc-50 flex flex-wrap items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => {
                    const previewInv: InvoiceRecord = {
                      id: 0,
                      invoice_number: `DRAFT-${billData.session!.session_code}`,
                      table_session_id: billData.session!.id,
                      table_id: billData.table.id,
                      table_number: billData.table.table_number,
                      subtotal_paise: billData.totals?.subtotal_paise || 0,
                      gst_paise: billData.totals?.gst_paise || 0,
                      service_charge_paise: billData.totals?.service_charge_paise || 0,
                      discount_paise: billData.totals?.discount_paise || 0,
                      grand_total_paise: billData.totals?.grand_total_paise || 0,
                      paid_paise: billData.totals?.paid_paise || 0,
                      payment_status: (billData.totals?.outstanding_paise || 0) <= 0 ? 'paid' : 'pending',
                      created_at: new Date().toISOString(),
                    };
                    downloadInvoicePdf(previewInv, billData.orders, restaurant);
                  }}
                  className="px-4 py-2.5 text-xs font-medium bg-white border border-zinc-300 text-zinc-800 rounded-md inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <Receipt className="w-3.5 h-3.5" /> Download Bill PDF
                </button>

                <button
                  type="button"
                  onClick={() => setCloseConfirmOpen(true)}
                  className="px-5 py-2.5 text-xs font-semibold bg-[#18181B] text-white hover:bg-[#B47B2B] rounded-md cursor-pointer"
                >
                  Settle &amp; Close Table Session
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <ConfirmModal
        open={closeConfirmOpen}
        title="Close Table Session & Generate Tax Invoice"
        message="This will finalize all orders in the active table session, generate an official tax invoice, and mark the table Available. Outstanding balance must be ₹0."
        confirmLabel="Close Session"
        onConfirm={closeTableSession}
        onCancel={() => setCloseConfirmOpen(false)}
      />
    </div>

    {/* PRINT-ONLY FORMATTED GST RECEIPT */}
    {printInvoice && (
      <div className="hidden print-only max-w-md mx-auto p-6 text-black bg-white font-sans">
        <div className="text-center border-b-2 border-black pb-4">
          <h1 className="font-display text-2xl font-bold tracking-wide uppercase">
            {restaurant?.name || 'FoodMitra'}
          </h1>
          {restaurant?.tagline && (
            <p className="text-[11px] text-zinc-700 mt-0.5">{restaurant.tagline}</p>
          )}
          <p className="text-xs text-zinc-800 mt-1">
            {restaurant?.address || '14 Pali Hill Courtyard, Bandra West, Mumbai 400050'}
          </p>
          <p className="text-[11px] text-zinc-700 mt-0.5">
            Tel: {restaurant?.phone || '+91 22 4890 3600'} · GSTIN: {restaurant?.gstin || '27AABCS1429B1Z5'}
          </p>
        </div>

        <div className="py-3 border-b border-dashed border-zinc-400 text-xs space-y-1">
          <div className="flex justify-between font-bold text-sm">
            <span>TAX INVOICE</span>
            <span className="font-mono">{printInvoice.invoice_number}</span>
          </div>
          <div className="flex justify-between">
            <span>Table</span>
            <span className="font-semibold">Table {String(printInvoice.table_number).padStart(2, '0')}</span>
          </div>
          {printInvoice.session_code && (
            <div className="flex justify-between">
              <span>Session</span>
              <span className="font-mono">{printInvoice.session_code}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span>Date &amp; Time</span>
            <span>{formatDateTimeIST(printInvoice.created_at)}</span>
          </div>
          <div className="flex justify-between">
            <span>Status</span>
            <span className="font-semibold uppercase">{printInvoice.payment_status}</span>
          </div>
        </div>

        <div className="py-3 border-b border-dashed border-zinc-400">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-zinc-400 text-left">
                <th className="py-1.5 font-semibold">Item</th>
                <th className="py-1.5 font-semibold text-center">Qty</th>
                <th className="py-1.5 font-semibold text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200">
              {printableItems.length > 0 ? (
                printableItems.map((it) => (
                  <tr key={`${it.order_number}-${it.id}`}>
                    <td className="py-1.5 pr-2">
                      <p className="font-medium text-black">{it.item_name}</p>
                      {(it.variant_name || (it.addons && it.addons.length > 0)) && (
                        <p className="text-[10px] text-zinc-600">
                          {[it.variant_name, ...(it.addons || []).map((a) => a.name)]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                      )}
                    </td>
                    <td className="py-1.5 text-center font-mono tabular-nums">{it.quantity}</td>
                    <td className="py-1.5 text-right font-mono tabular-nums">
                      {formatINR(it.line_total_paise)}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="py-2">Consolidated Table Session Charges</td>
                  <td className="py-2 text-center font-mono">1</td>
                  <td className="py-2 text-right font-mono tabular-nums">
                    {formatINR(printInvoice.subtotal_paise)}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="py-3 border-b-2 border-black text-xs space-y-1.5">
          <div className="flex justify-between">
            <span>Subtotal</span>
            <span className="font-mono tabular-nums">{formatINR(printInvoice.subtotal_paise)}</span>
          </div>
          {printInvoice.discount_paise > 0 && (
            <div className="flex justify-between">
              <span>Discount</span>
              <span className="font-mono tabular-nums">-{formatINR(printInvoice.discount_paise)}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span>GST (5%)</span>
            <span className="font-mono tabular-nums">{formatINR(printInvoice.gst_paise)}</span>
          </div>
          <div className="flex justify-between">
            <span>Service Charge (5%)</span>
            <span className="font-mono tabular-nums">{formatINR(printInvoice.service_charge_paise)}</span>
          </div>
          <div className="flex justify-between text-sm font-bold pt-2 border-t border-zinc-400">
            <span>GRAND TOTAL</span>
            <span className="font-mono tabular-nums">{formatINR(printInvoice.grand_total_paise)}</span>
          </div>
          <div className="flex justify-between font-semibold pt-1">
            <span>Total Paid</span>
            <span className="font-mono tabular-nums">{formatINR(printInvoice.paid_paise)}</span>
          </div>
        </div>

        {printablePayments.length > 0 && (
          <div className="py-3 border-b border-dashed border-zinc-400 text-[11px] space-y-1">
            <p className="font-semibold uppercase tracking-wider text-zinc-700">Payment Summary</p>
            {printablePayments.map((p) => (
              <div key={p.id} className="flex justify-between">
                <span className="uppercase">
                  {p.method} {p.provider_payment_id ? `(${p.provider_payment_id})` : ''}
                </span>
                <span className="font-mono tabular-nums">{formatINR(p.amount_paise)}</span>
              </div>
            ))}
          </div>
        )}

        <div className="pt-4 text-center text-[11px] text-zinc-700 space-y-1">
          <p className="font-semibold text-black">
            Thank you for dining with {restaurant?.name || 'FoodMitra'}!
          </p>
          <p>Computer-generated GST Tax Invoice · No signature required</p>
        </div>
      </div>
    )}
    </>
  );
}
