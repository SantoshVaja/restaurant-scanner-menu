import React, { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeftRight,
  CheckCircle2,
  CreditCard,
  Download,
  Printer,
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
import { downloadInvoicePdf, formatDateTimeIST, formatINR } from '../lib/format.ts';
import { useRealtimeRoom } from '../lib/ws.ts';
import { ConfirmModal, StatusLabel } from '../components/ui.tsx';

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
  const [tab, setTab] = useState<'tables' | 'orders' | 'invoices'>('tables');
  const [tables, setTables] = useState<DiningTable[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRecord[]>([]);
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

  const loadAll = useCallback(async () => {
    const [tRes, oRes, iRes] = await Promise.all([
      fetch('/api/pos/tables', { headers: { Authorization: `Bearer ${staffToken}` } }),
      fetch('/api/pos/orders', { headers: { Authorization: `Bearer ${staffToken}` } }),
      fetch('/api/pos/invoices', { headers: { Authorization: `Bearer ${staffToken}` } }),
    ]);
    if (tRes.ok) setTables((await tRes.json()).tables || []);
    if (oRes.ok) setOrders((await oRes.json()).orders || []);
    if (iRes.ok) setInvoices((await iRes.json()).invoices || []);
  }, [staffToken]);

  const loadTableBill = useCallback(
    async (tableId: number) => {
      const resp = await fetch(`/api/pos/tables/${tableId}/bill`, {
        headers: { Authorization: `Bearer ${staffToken}` },
      });
      if (resp.ok) {
        const data: TableBillData = await resp.json();
        setBillData(data);
        if (data.totals) {
          setPayAmountRupees(String(Math.round(data.totals.outstanding_paise / 100)));
        }
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
    const resp = await fetch('/api/pos/payments/record', {
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
    const data = await resp.json();
    if (!resp.ok) {
      setPosMessage({ type: 'err', text: data.error || 'Failed to record payment' });
      return;
    }
    setPosMessage({ type: 'ok', text: `Payment of ${formatINR(amountPaise)} recorded via ${payMethod.toUpperCase()}.` });
    setConfirmReceipt(false);
    await Promise.all([loadAll(), loadTableBill(selectedTableId)]);
  }

  async function cancelOrderItem(itemId: number) {
    if (!selectedTableId) return;
    const resp = await fetch(`/api/pos/orders/${itemId}/cancel-item`, {
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
  }

  async function refundPayment(paymentId: number, amountPaise: number) {
    if (!selectedTableId) return;
    const resp = await fetch('/api/pos/refunds', {
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
  }

  async function transferTable() {
    if (!selectedTableId || !transferTargetId) return;
    const resp = await fetch(`/api/pos/tables/${selectedTableId}/transfer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${staffToken}`,
      },
      body: JSON.stringify({ target_table_id: Number(transferTargetId) }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      setPosMessage({ type: 'err', text: data.error || 'Transfer failed' });
      return;
    }
    const targetNum = Number(transferTargetId);
    setTransferTargetId('');
    await loadAll();
    openTableDrawer(targetNum);
  }

  async function closeTableSession() {
    if (!selectedTableId) return;
    setCloseConfirmOpen(false);
    const resp = await fetch(`/api/pos/tables/${selectedTableId}/close`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${staffToken}` },
    });
    const data = await resp.json();
    if (!resp.ok) {
      setPosMessage({ type: 'err', text: data.error || 'Could not close session' });
      return;
    }
    setLastInvoice(data.invoice);
    setPosMessage({ type: 'ok', text: `Table settled! Invoice ${data.invoice.invoice_number} generated.` });
    await loadAll();
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

  return (
    <div className="space-y-6">
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
                    {(t.outstanding_paise || 0) > 0 && (
                      <p className="text-red-600 font-semibold tabular-nums">
                        Due: {formatINR(t.outstanding_paise || 0)}
                      </p>
                    )}
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

      {/* TAB 3: INVOICES */}
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
                <th className="py-3 px-4 font-semibold text-right">PDF</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {invoices.map((inv) => (
                <tr key={inv.id} className="hover:bg-zinc-50">
                  <td className="py-3 px-4 font-mono font-semibold">{inv.invoice_number}</td>
                  <td className="py-3 px-4">Table {String(inv.table_number).padStart(2, '0')}</td>
                  <td className="py-3 px-4 text-zinc-500">{formatDateTimeIST(inv.created_at)}</td>
                  <td className="py-3 px-4 text-right tabular-nums">{formatINR(inv.subtotal_paise)}</td>
                  <td className="py-3 px-4 text-right tabular-nums">{formatINR(inv.gst_paise + inv.service_charge_paise)}</td>
                  <td className="py-3 px-4 text-right font-semibold tabular-nums">{formatINR(inv.grand_total_paise)}</td>
                  <td className="py-3 px-4 text-right">
                    <button
                      type="button"
                      onClick={() => downloadInvoicePdf(inv, [], restaurant)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-zinc-900 text-white rounded hover:bg-[#B47B2B] cursor-pointer"
                    >
                      <Download className="w-3 h-3" /> PDF
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
                      onClick={() => downloadInvoicePdf(lastInvoice, billData.orders, restaurant)}
                      className="px-3 py-1.5 text-xs font-semibold bg-emerald-700 text-white rounded-md inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5" /> Download PDF
                    </button>
                    <button
                      type="button"
                      onClick={() => window.print()}
                      className="px-3 py-1.5 text-xs font-semibold bg-white border border-emerald-300 text-emerald-900 rounded-md inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      <Printer className="w-3.5 h-3.5" /> Print
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
  );
}
