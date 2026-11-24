import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  CheckCircle2,
  Clock,
  Flame,
  Maximize2,
  Minimize2,
  Search,
  Volume2,
  VolumeX,
  XCircle,
} from 'lucide-react';
import type { KitchenTicket } from '../types.ts';
import { apiFetch, parseJsonSafe } from '../lib/api.ts';
import { formatDateTimeIST, getElapsedMinutes } from '../lib/format.ts';
import { useRealtimeRoom } from '../lib/ws.ts';
import { StatusLabel } from '../components/ui.tsx';

function playChime() {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(660, ctx.currentTime);
    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.45);
  } catch {
    // Ignore autoplay restriction
  }
}

export interface KitchenCounts {
  active: number;
  new: number;
  accepted: number;
  preparing: number;
  ready: number;
  served: number;
  rejected: number;
}

export function KitchenDashboard({
  staffToken,
  onCountsChange,
}: {
  staffToken: string;
  onCountsChange?: (counts: KitchenCounts) => void;
}) {
  const [tickets, setTickets] = useState<KitchenTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'active' | 'new' | 'accepted' | 'preparing' | 'ready' | 'served' | 'rejected'>('active');
  const [search, setSearch] = useState('');
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [fullScreen, setFullScreen] = useState(false);
  const [rejectModalTicket, setRejectModalTicket] = useState<KitchenTicket | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [nowTick, setNowTick] = useState(Date.now());
  const [freshTicketIds, setFreshTicketIds] = useState<Set<number>>(new Set());
  const [recentlyAcceptedIds, setRecentlyAcceptedIds] = useState<Set<number>>(new Set());
  const [updatingTicketId, setUpdatingTicketId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const hasLoadedOnceRef = useRef(false);
  const seenTicketIdsRef = useRef<Set<number>>(new Set());
  const prevStatusByIdRef = useRef<Map<number, string>>(new Map());

  const markRecentlyAccepted = useCallback((ticketId: number) => {
    setRecentlyAcceptedIds((prev) => {
      const next = new Set(prev);
      next.add(ticketId);
      return next;
    });
    window.setTimeout(() => {
      setRecentlyAcceptedIds((prev) => {
        const next = new Set(prev);
        next.delete(ticketId);
        return next;
      });
    }, 12000);
  }, []);

  const loadTickets = useCallback(async () => {
    try {
      const resp = await apiFetch('/api/kitchen/tickets', {
        headers: { Authorization: `Bearer ${staffToken}` },
      });
      if (!resp.ok) return;
      const data = await parseJsonSafe<{ tickets?: KitchenTicket[] }>(resp);
      const list: KitchenTicket[] = data.tickets || [];

      if (!hasLoadedOnceRef.current) {
        hasLoadedOnceRef.current = true;
        for (const t of list) {
          seenTicketIdsRef.current.add(t.id);
          prevStatusByIdRef.current.set(t.id, t.status);
        }
      } else {
        const newlyArrived = list.filter((t) => t.status === 'new' && !seenTicketIdsRef.current.has(t.id));
        for (const t of list) {
          seenTicketIdsRef.current.add(t.id);
          const prevStatus = prevStatusByIdRef.current.get(t.id);
          if (t.status === 'accepted' && prevStatus !== 'accepted') {
            markRecentlyAccepted(t.id);
          }
          prevStatusByIdRef.current.set(t.id, t.status);
        }
        if (newlyArrived.length > 0) {
          if (soundEnabled) playChime();
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            const first = newlyArrived[0];
            new Notification('New Kitchen Order Ticket', {
              body: `Table ${String(first.table_number).padStart(2, '0')} (${first.ticket_number}) arrived in Kitchen Display.`,
            });
          }
          const arrivedIds = newlyArrived.map((t) => t.id);
          setFreshTicketIds((prev) => {
            const next = new Set(prev);
            for (const id of arrivedIds) next.add(id);
            return next;
          });
          window.setTimeout(() => {
            setFreshTicketIds((prev) => {
              const next = new Set(prev);
              for (const id of arrivedIds) next.delete(id);
              return next;
            });
          }, 15000);
        }
      }

      setTickets(list);
    } catch {
      // Ignore transient error
    } finally {
      setLoading(false);
    }
  }, [staffToken, soundEnabled, markRecentlyAccepted]);

  useEffect(() => {
    loadTickets();
    const timer = window.setInterval(() => setNowTick(Date.now()), 15000);
    return () => clearInterval(timer);
  }, [loadTickets]);

  const { connected: wsConnected } = useRealtimeRoom({
    room: 'role:kitchen',
    staffToken,
    onEvent: (evt, payload) => {
      if (evt === 'kitchen:ticket_updated' || evt === 'sync:update') {
        if (payload && typeof payload === 'object') {
          const p = payload as {
            type?: string;
            ticketId?: number;
            status?: KitchenTicket['status'];
            acceptedByName?: string;
            ticket?: KitchenTicket;
          };
          if (p.type === 'kitchen_status_changed' && typeof p.ticketId === 'number' && p.status) {
            if (p.status === 'accepted') {
              markRecentlyAccepted(p.ticketId);
            }
            prevStatusByIdRef.current.set(p.ticketId, p.status);
            setTickets((prev) =>
              prev.map((t) => {
                if (t.id !== p.ticketId) return t;
                if (p.ticket) return p.ticket;
                return {
                  ...t,
                  status: p.status!,
                  accepted_by_name: p.acceptedByName ?? t.accepted_by_name,
                };
              })
            );
          }
        }
        loadTickets();
      } else if (evt === 'notification:new') {
        loadTickets();
      }
    },
  });

  async function updateTicketStatus(ticketId: number, status: 'accepted' | 'preparing' | 'ready' | 'served' | 'rejected', reason?: string) {
    setUpdatingTicketId(ticketId);
    setActionError(null);
    try {
      const resp = await apiFetch(`/api/kitchen/tickets/${ticketId}/status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${staffToken}`,
        },
        body: JSON.stringify({ status, reason }),
      });
      const data = await parseJsonSafe<{ ok?: boolean; ticket?: KitchenTicket; error?: string }>(resp);
      if (!resp.ok) {
        throw new Error(data.error || 'Could not update ticket status');
      }
      if (status === 'accepted') {
        markRecentlyAccepted(ticketId);
      }
      prevStatusByIdRef.current.set(ticketId, status);
      if (data.ticket) {
        setTickets((prev) => prev.map((t) => (t.id === ticketId ? data.ticket! : t)));
      }
      setRejectModalTicket(null);
      setRejectReason('');
      await loadTickets();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Unable to update ticket status');
    } finally {
      setUpdatingTicketId(null);
    }
  }

  function requestBrowserNotifs() {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  const filteredTickets = useMemo(() => {
    void nowTick;
    let list = tickets;
    if (filter === 'active') {
      list = list.filter((t) => ['new', 'accepted', 'preparing', 'ready'].includes(t.status));
    } else {
      list = list.filter((t) => t.status === filter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (t) =>
          t.ticket_number.toLowerCase().includes(q) ||
          t.order_number.toLowerCase().includes(q) ||
          String(t.table_number).includes(q)
      );
    }
    return list;
  }, [tickets, filter, search, nowTick]);

  const counts: KitchenCounts = useMemo(
    () => ({
      active: tickets.filter((t) => ['new', 'accepted', 'preparing', 'ready'].includes(t.status)).length,
      new: tickets.filter((t) => t.status === 'new').length,
      accepted: tickets.filter((t) => t.status === 'accepted').length,
      preparing: tickets.filter((t) => t.status === 'preparing').length,
      ready: tickets.filter((t) => t.status === 'ready').length,
      served: tickets.filter((t) => t.status === 'served').length,
      rejected: tickets.filter((t) => t.status === 'rejected').length,
    }),
    [tickets]
  );

  useEffect(() => {
    onCountsChange?.(counts);
  }, [counts, onCountsChange]);

  const newTickets = useMemo(() => tickets.filter((t) => t.status === 'new'), [tickets]);

  return (
    <div className={fullScreen ? 'fixed inset-0 z-50 bg-slate-950 text-white overflow-y-auto p-4 sm:p-6' : 'space-y-6'}>
      {/* Toolbar */}
      <div className={`flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b ${fullScreen ? 'border-slate-800' : 'border-zinc-200'}`}>
        <div>
          <div className="flex items-center gap-3">
            <h2 className={`text-xl font-bold ${fullScreen ? 'text-white' : 'text-zinc-900'}`}>
              Kitchen Display System (KDS)
            </h2>
            <span className={`text-xs font-medium flex items-center gap-1.5 ${wsConnected ? 'text-emerald-600' : 'text-amber-600'}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${wsConnected ? 'bg-emerald-500' : 'bg-amber-500'}`} />
              {wsConnected ? 'Realtime Connected' : 'Reconnecting'}
            </span>
          </div>
          <p className={`text-xs mt-1 ${fullScreen ? 'text-slate-400' : 'text-zinc-500'}`}>
            {counts.new} New · {counts.accepted} Accepted · {counts.preparing} Preparing · {counts.ready} Ready · {counts.served} Served
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Table # or KT-1001..."
              className={`pl-8 pr-3 py-2 text-xs rounded-md border focus:outline-none ${
                fullScreen
                  ? 'bg-slate-900 border-slate-700 text-white'
                  : 'bg-white border-zinc-300 text-zinc-900'
              }`}
            />
          </div>

          <button
            type="button"
            onClick={() => setSoundEnabled(!soundEnabled)}
            className={`px-3 py-2 text-xs font-medium rounded-md border inline-flex items-center gap-1.5 cursor-pointer ${
              fullScreen ? 'border-slate-700 bg-slate-900 text-slate-200' : 'border-zinc-300 bg-white text-zinc-700'
            }`}
          >
            {soundEnabled ? <Volume2 className="w-3.5 h-3.5 text-emerald-600" /> : <VolumeX className="w-3.5 h-3.5 text-zinc-400" />}
            Sound
          </button>

          <button
            type="button"
            onClick={requestBrowserNotifs}
            className={`px-3 py-2 text-xs font-medium rounded-md border inline-flex items-center gap-1.5 cursor-pointer ${
              fullScreen ? 'border-slate-700 bg-slate-900 text-slate-200' : 'border-zinc-300 bg-white text-zinc-700'
            }`}
          >
            <Bell className="w-3.5 h-3.5 text-amber-600" />
            Alerts
          </button>

          <button
            type="button"
            onClick={() => setFullScreen(!fullScreen)}
            className={`px-3 py-2 text-xs font-medium rounded-md border inline-flex items-center gap-1.5 cursor-pointer ${
              fullScreen ? 'border-slate-700 bg-slate-800 text-white' : 'border-zinc-300 bg-zinc-900 text-white'
            }`}
          >
            {fullScreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            {fullScreen ? 'Exit Fullscreen' : 'Fullscreen KDS'}
          </button>
        </div>
      </div>

      {/* Prominent Incoming New Order Highlight Banner */}
      {counts.new > 0 && (
        <div
          role="alert"
          className={`rounded-xl border-2 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
            fullScreen
              ? 'bg-amber-950/50 border-amber-400 text-amber-100'
              : 'bg-amber-50 border-amber-500 text-amber-950 shadow-sm'
          }`}
        >
          <div className="flex items-start sm:items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-amber-500 text-white flex items-center justify-center shrink-0">
              <Bell className="w-4 h-4" />
            </div>
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-amber-700 dark:text-amber-300">
                Incoming Kitchen Alert · {counts.new} New {counts.new === 1 ? 'Order' : 'Orders'} Waiting
              </p>
              <p className="text-xs mt-0.5 font-medium">
                {newTickets
                  .slice(0, 4)
                  .map((t) => `Table ${String(t.table_number).padStart(2, '0')} (${t.ticket_number})`)
                  .join(' · ')}
                {newTickets.length > 4 ? ` +${newTickets.length - 4} more` : ''}
              </p>
            </div>
          </div>
          {filter !== 'new' && filter !== 'active' && (
            <button
              type="button"
              onClick={() => setFilter('new')}
              className="px-3.5 py-2 text-xs font-semibold bg-amber-600 hover:bg-amber-700 text-white rounded-md whitespace-nowrap cursor-pointer shrink-0"
            >
              View New Orders ({counts.new})
            </button>
          )}
        </div>
      )}

      {actionError && (
        <div className="p-3 bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg flex items-center justify-between gap-2">
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError(null)} className="font-semibold hover:underline cursor-pointer">
            Dismiss
          </button>
        </div>
      )}

      {/* Status Filter Tabs */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
        {(
          [
            ['active', `Active Queue (${counts.active})`],
            ['new', `New (${counts.new})`],
            ['accepted', `Accepted (${counts.accepted})`],
            ['preparing', `Preparing (${counts.preparing})`],
            ['ready', `Ready (${counts.ready})`],
            ['served', `Served (${counts.served})`],
            ['rejected', `Rejected (${counts.rejected})`],
          ] as const
        ).map(([key, label]) => {
          const highlightNewTab = key === 'new' && counts.new > 0 && filter !== 'new';
          const highlightAcceptedTab = key === 'accepted' && counts.accepted > 0 && filter !== 'accepted';
          return (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className={`px-3.5 py-2 text-xs font-medium rounded-md whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                filter === key
                  ? 'bg-[#B47B2B] text-white'
                  : highlightNewTab
                  ? 'bg-amber-100 border-2 border-amber-500 text-amber-900 font-semibold'
                  : highlightAcceptedTab
                  ? fullScreen
                    ? 'bg-sky-950/70 border border-sky-400 text-sky-200 font-semibold'
                    : 'bg-sky-50 border-2 border-sky-400 text-sky-900 font-semibold'
                  : fullScreen
                  ? 'bg-slate-900 text-slate-300 hover:bg-slate-800'
                  : 'bg-white border border-zinc-200 text-zinc-700 hover:bg-zinc-50'
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* Ticket Grid */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[1, 2, 3].map((n) => (
            <div key={n} className="h-56 bg-zinc-100 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : filteredTickets.length === 0 ? (
        <div className={`py-16 text-center rounded-xl border ${fullScreen ? 'bg-slate-900 border-slate-800' : 'bg-white border-zinc-200'}`}>
          <Flame className="w-9 h-9 text-zinc-400 mx-auto" />
          <p className="mt-3 text-sm font-medium">No kitchen tickets in this view.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filteredTickets.map((ticket) => {
            const elapsed = getElapsedMinutes(ticket.created_at);
            const isOverdue = ['new', 'accepted', 'preparing'].includes(ticket.status) && elapsed >= 18;
            const isNew = ticket.status === 'new';
            const isAccepted = ticket.status === 'accepted';
            const isPreparing = ticket.status === 'preparing';
            const isReady = ticket.status === 'ready';
            const isFresh = freshTicketIds.has(ticket.id);
            const isJustAccepted = recentlyAcceptedIds.has(ticket.id);

            const cardHighlightClass = fullScreen
              ? isNew
                ? 'bg-slate-900 border-2 border-amber-400 ring-2 ring-amber-400/35 shadow-lg'
                : isAccepted
                ? `bg-slate-900 border-2 border-sky-400 ring-2 ${isJustAccepted ? 'ring-sky-400/60 shadow-xl' : 'ring-sky-400/30 shadow-md'}`
                : isPreparing
                ? 'bg-slate-900 border-2 border-orange-400/80'
                : isReady
                ? 'bg-slate-900 border-2 border-emerald-400/80'
                : 'bg-slate-900 border-slate-800'
              : isNew
              ? `bg-amber-50/80 border-2 border-amber-500 ring-2 ${isFresh ? 'ring-amber-500/60 shadow-lg' : 'ring-amber-400/30 shadow-sm'}`
              : isAccepted
              ? `bg-sky-50/85 border-2 border-sky-500 ring-2 ${isJustAccepted ? 'ring-sky-500/60 shadow-lg' : 'ring-sky-400/30 shadow-sm'}`
              : isPreparing
              ? 'bg-orange-50/35 border border-orange-300'
              : isReady
              ? 'bg-emerald-50/45 border border-emerald-400'
              : 'bg-white border-zinc-200';

            return (
              <div
                key={ticket.id}
                className={`rounded-xl border p-5 flex flex-col justify-between transition-all ${cardHighlightClass}`}
              >
                <div>
                  {isNew && (
                    <div className={`mb-3 -mt-1 flex items-center justify-between gap-2 pb-2 border-b text-[11px] font-bold uppercase tracking-wider ${
                      fullScreen ? 'border-amber-400/40 text-amber-300' : 'border-amber-300/60 text-amber-800'
                    }`}>
                      <span>{isFresh ? 'Just Arrived · Action Required' : 'New Order · Needs Acceptance'}</span>
                      <span className="font-mono">{ticket.ticket_number}</span>
                    </div>
                  )}
                  {isAccepted && (
                    <div className={`mb-3 -mt-1 flex items-center justify-between gap-2 pb-2 border-b text-[11px] font-bold uppercase tracking-wider ${
                      fullScreen ? 'border-sky-400/40 text-sky-300' : 'border-sky-300/70 text-sky-800'
                    }`}>
                      <span>{isJustAccepted ? 'Just Accepted · Ready to Cook' : 'Accepted · In Queue'}</span>
                      <span className="font-medium normal-case truncate max-w-[140px]">
                        Chef: {ticket.accepted_by_name || 'Kitchen'}
                      </span>
                    </div>
                  )}
                  <div className="flex items-start justify-between gap-2 pb-3 border-b border-zinc-200/20">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-base font-bold tabular-nums">
                          Table {String(ticket.table_number).padStart(2, '0')}
                        </span>
                        <span className="font-mono text-xs text-[#B47B2B] font-semibold">
                          {ticket.ticket_number}
                        </span>
                      </div>
                      <p className={`text-[11px] font-mono mt-0.5 ${fullScreen ? 'text-slate-400' : 'text-zinc-500'}`}>
                        {ticket.order_number} · {formatDateTimeIST(ticket.created_at)}
                      </p>
                    </div>

                    <div className="text-right space-y-1">
                      <StatusLabel status={ticket.status} />
                      <div
                        className={`text-[11px] font-mono font-medium flex items-center justify-end gap-1 ${
                          isOverdue ? 'text-red-500' : fullScreen ? 'text-slate-400' : 'text-zinc-500'
                        }`}
                      >
                        <Clock className="w-3 h-3" />
                        {elapsed}m {isOverdue ? 'OVERDUE' : ''}
                      </div>
                    </div>
                  </div>

                  {ticket.special_instructions && (
                    <div className="mt-3 p-2.5 rounded bg-amber-500/10 border border-amber-500/30 text-xs text-amber-700 font-medium">
                      Order Note: {ticket.special_instructions}
                    </div>
                  )}

                  <ul className="mt-3 divide-y divide-zinc-200/40 text-sm">
                    {ticket.items.map((it) => (
                      <li key={it.id} className="py-2">
                        <div className="flex items-start justify-between gap-2">
                          <span className="font-semibold">
                            <span className="font-mono text-[#B47B2B] mr-1.5">{it.quantity}×</span>
                            {it.item_name}
                          </span>
                        </div>
                        {it.variant_name && (
                          <p className={`text-xs mt-0.5 ${fullScreen ? 'text-slate-400' : 'text-zinc-500'}`}>
                            Variant: {it.variant_name}
                          </p>
                        )}
                        {it.addons && it.addons.length > 0 && (
                          <p className={`text-xs ${fullScreen ? 'text-slate-400' : 'text-zinc-500'}`}>
                            Add-ons: {it.addons.map((a) => a.name).join(', ')}
                          </p>
                        )}
                        {it.special_instructions && (
                          <p className="text-xs text-amber-600 mt-0.5">Note: {it.special_instructions}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Chef Action Buttons */}
                <div className="mt-4 pt-3 border-t border-zinc-200/30 flex flex-wrap gap-2">
                  {ticket.status === 'new' && (
                    <>
                      <button
                        type="button"
                        disabled={updatingTicketId === ticket.id}
                        onClick={() => updateTicketStatus(ticket.id, 'accepted')}
                        className="flex-1 py-2.5 px-3 text-xs font-semibold bg-sky-600 hover:bg-sky-700 text-white rounded-md cursor-pointer disabled:opacity-50"
                      >
                        {updatingTicketId === ticket.id ? 'Accepting...' : 'Accept Order'}
                      </button>
                      <button
                        type="button"
                        disabled={updatingTicketId === ticket.id}
                        onClick={() => setRejectModalTicket(ticket)}
                        className="py-2.5 px-3 text-xs font-semibold bg-red-600/10 hover:bg-red-600/20 text-red-600 rounded-md cursor-pointer disabled:opacity-50"
                      >
                        Reject
                      </button>
                    </>
                  )}
                  {ticket.status === 'accepted' && (
                    <button
                      type="button"
                      disabled={updatingTicketId === ticket.id}
                      onClick={() => updateTicketStatus(ticket.id, 'preparing')}
                      className="w-full py-2.5 px-3 text-xs font-semibold bg-orange-600 hover:bg-orange-700 text-white rounded-md cursor-pointer disabled:opacity-50"
                    >
                      {updatingTicketId === ticket.id ? 'Starting...' : 'Start Preparing'}
                    </button>
                  )}
                  {ticket.status === 'preparing' && (
                    <button
                      type="button"
                      onClick={() => updateTicketStatus(ticket.id, 'ready')}
                      className="w-full py-2.5 px-3 text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white rounded-md inline-flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <CheckCircle2 className="w-4 h-4" />
                      Mark Ready to Serve
                    </button>
                  )}
                  {ticket.status === 'ready' && (
                    <button
                      type="button"
                      onClick={() => updateTicketStatus(ticket.id, 'served')}
                      className="w-full py-2.5 px-3 text-xs font-semibold bg-teal-700 hover:bg-teal-800 text-white rounded-md cursor-pointer"
                    >
                      Mark Served
                    </button>
                  )}
                  {ticket.status === 'rejected' && (
                    <p className="text-xs text-red-500 flex items-center gap-1">
                      <XCircle className="w-3.5 h-3.5" /> {ticket.rejection_reason}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Reject Reason Modal */}
      {rejectModalTicket && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white text-zinc-900 rounded-xl p-6 space-y-4">
            <h3 className="text-base font-semibold">Reject Ticket {rejectModalTicket.ticket_number}</h3>
            <p className="text-xs text-zinc-600">
              Specify why this order cannot be fulfilled (e.g., ingredient out of stock). Counter will be alerted immediately for refund.
            </p>
            <input
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Reason for rejection..."
              className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-md"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRejectModalTicket(null)}
                className="px-4 py-2 text-xs font-medium bg-zinc-100 rounded-md"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={rejectReason.trim().length < 3}
                onClick={() => updateTicketStatus(rejectModalTicket.id, 'rejected', rejectReason)}
                className="px-4 py-2 text-xs font-semibold bg-red-600 text-white rounded-md disabled:opacity-50"
              >
                Confirm Rejection
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
