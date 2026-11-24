import React, { useCallback, useEffect, useState } from 'react';
import { Bell, CheckCircle2, Utensils } from 'lucide-react';
import type { AppNotification, DiningTable, KitchenTicket } from '../types.ts';
import { apiFetch, parseJsonSafe } from '../lib/api.ts';
import { useRealtimeRoom } from '../lib/ws.ts';
import { StatusLabel } from '../components/ui.tsx';

export function WaiterDashboard({ staffToken }: { staffToken: string }) {
  const [tables, setTables] = useState<DiningTable[]>([]);
  const [tickets, setTickets] = useState<KitchenTicket[]>([]);
  const [alerts, setAlerts] = useState<AppNotification[]>([]);

  const loadData = useCallback(async () => {
    try {
      const [wResp, nResp] = await Promise.all([
        apiFetch('/api/waiter/overview', { headers: { Authorization: `Bearer ${staffToken}` } }),
        apiFetch('/api/notifications', { headers: { Authorization: `Bearer ${staffToken}` } }),
      ]);
      if (wResp.ok) {
        const wd = await parseJsonSafe<{ tables?: DiningTable[]; tickets?: KitchenTicket[] }>(wResp);
        setTables(wd.tables || []);
        setTickets(wd.tickets || []);
      }
      if (nResp.ok) {
        const nd = await parseJsonSafe<{ notifications?: AppNotification[] }>(nResp);
        setAlerts((nd.notifications || []).slice(0, 8));
      }
    } catch {
      // Ignore transient error
    }
  }, [staffToken]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useRealtimeRoom({
    room: 'role:waiter',
    staffToken,
    onEvent: () => loadData(),
  });

  async function markServed(ticketId: number) {
    const resp = await apiFetch(`/api/waiter/tickets/${ticketId}/serve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${staffToken}` },
    });
    if (resp.ok) loadData();
  }

  const readyTickets = tickets.filter((t) => t.status === 'ready');
  const inKitchenTickets = tickets.filter((t) => ['new', 'accepted', 'preparing'].includes(t.status));

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-4 border-b border-zinc-200">
        <div>
          <h2 className="text-xl font-bold text-zinc-900">Waiter Service Console</h2>
          <p className="text-xs text-zinc-500">Assigned tables, ready-to-serve dishes, and guest call alerts</p>
        </div>
        <div className="text-xs font-semibold text-emerald-700">
          {readyTickets.length} Ready to Serve · {inKitchenTickets.length} In Kitchen
        </div>
      </div>

      {/* Ready To Serve Priority Queue */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-zinc-900">Ready for Pickup at Pass</h3>
        {readyTickets.length === 0 ? (
          <div className="bg-white border border-zinc-200 rounded-lg p-8 text-center text-sm text-zinc-500">
            No dishes waiting at the pass right now.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {readyTickets.map((t) => (
              <div key={t.id} className="bg-emerald-50/60 border border-emerald-300 rounded-xl p-5 flex flex-col justify-between gap-4">
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-lg font-bold text-zinc-900">
                      Table {String(t.table_number).padStart(2, '0')}
                    </span>
                    <span className="font-mono text-xs font-semibold text-emerald-800">{t.ticket_number}</span>
                  </div>
                  <ul className="mt-3 space-y-1 text-sm text-zinc-800">
                    {t.items.map((it) => (
                      <li key={it.id}>
                        <span className="font-mono font-semibold mr-1.5">{it.quantity}×</span>
                        {it.item_name}
                        {it.special_instructions && (
                          <span className="text-xs text-amber-700 ml-2">({it.special_instructions})</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
                <button
                  type="button"
                  onClick={() => markServed(t.id)}
                  className="w-full py-3 text-sm font-semibold bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg inline-flex items-center justify-center gap-2 cursor-pointer"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  Mark Delivered to Table
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Assigned Tables & Active Kitchen Tracking */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7 bg-white border border-zinc-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-zinc-900 mb-4 flex items-center gap-2">
            <Utensils className="w-4 h-4 text-[#B47B2B]" /> Assigned Tables
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {tables.map((tbl) => {
              const tblTickets = tickets.filter((tk) => tk.table_id === tbl.id);
              return (
                <div key={tbl.id} className="p-3.5 border border-zinc-200 rounded-lg bg-zinc-50/50">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-sm text-zinc-900">{tbl.label}</span>
                    <StatusLabel status={tbl.status} />
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">{tbl.section} · {tbl.capacity} Seats</p>
                  <p className="mt-2 text-xs font-medium text-zinc-700">
                    {tblTickets.length} active kitchen ticket(s)
                  </p>
                </div>
              );
            })}
          </div>
        </div>

        <div className="lg:col-span-5 bg-white border border-zinc-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-zinc-900 mb-4 flex items-center gap-2">
            <Bell className="w-4 h-4 text-[#B47B2B]" /> Guest Calls &amp; Alerts
          </h3>
          <div className="space-y-3">
            {alerts.length === 0 ? (
              <p className="text-xs text-zinc-500">No recent alerts.</p>
            ) : (
              alerts.map((a) => (
                <div key={a.id} className="p-3 border border-zinc-100 bg-zinc-50 rounded-lg text-xs">
                  <p className="font-semibold text-zinc-900">{a.title}</p>
                  <p className="text-zinc-600 mt-0.5">{a.message}</p>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
