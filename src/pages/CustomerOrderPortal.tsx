import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertCircle,
  Bell,
  Check,
  CheckCircle2,
  ChefHat,
  Clock,
  CreditCard,
  Minus,
  Plus,
  QrCode,
  Receipt,
  Search,
  ShoppingBag,
  Smartphone,
  Sparkles,
  Tag,
  Trash2,
  Utensils,
  X,
} from 'lucide-react';
import type {
  MenuAddon,
  MenuCategory,
  MenuItem,
  MenuVariant,
  Order,
  RestaurantInfo,
} from '../types.ts';
import { apiFetch, parseJsonSafe } from '../lib/api.ts';
import { formatDateTimeIST, formatINR } from '../lib/format.ts';
import { useRealtimeRoom } from '../lib/ws.ts';
import { SafeImage, StatusLabel, VegIndicator } from '../components/ui.tsx';

interface LocalCartLine {
  uid: string;
  item: MenuItem;
  quantity: number;
  variant: MenuVariant | null;
  addons: MenuAddon[];
  special_instructions: string;
}

const TIMELINE_STEPS = [
  { key: 'placed', label: 'Order Placed' },
  { key: 'accepted', label: 'Accepted' },
  { key: 'processing', label: 'Preparing' },
  { key: 'ready', label: 'Ready to Serve' },
  { key: 'served', label: 'Served' },
  { key: 'completed', label: 'Completed' },
];

export function CustomerOrderPortal({
  restaurant,
  categories,
  items,
  onExitToSite,
}: {
  restaurant: RestaurantInfo | null;
  categories: MenuCategory[];
  items: MenuItem[];
  onExitToSite: () => void;
}) {
  const [validating, setValidating] = useState(true);
  const [qrError, setQrError] = useState<string | null>(null);
  const [tableInfo, setTableInfo] = useState<{
    id: number;
    table_number: number;
    label: string;
    section: string;
  } | null>(null);
  const [sessionInfo, setSessionInfo] = useState<{ id: number; session_code: string; status?: string } | null>(null);
  const [customerToken, setCustomerToken] = useState<string | null>(null);
  const [sessionClosed, setSessionClosed] = useState(false);
  const [closedInvoiceNumber, setClosedInvoiceNumber] = useState<string | null>(null);

  // Active tab: menu vs live tracking
  const [viewMode, setViewMode] = useState<'menu' | 'tracking'>('menu');

  // Menu filters
  const [search, setSearch] = useState('');
  const [selectedCat, setSelectedCat] = useState<number | 'all'>('all');
  const [vegOnly, setVegOnly] = useState<'all' | 'veg' | 'nonveg'>('all');
  const [bestsellerOnly, setBestsellerOnly] = useState(false);

  // Customization Modal
  const [customizingItem, setCustomizingItem] = useState<MenuItem | null>(null);
  const [selVariant, setSelVariant] = useState<MenuVariant | null>(null);
  const [selAddons, setSelAddons] = useState<MenuAddon[]>([]);
  const [itemQty, setItemQty] = useState(1);
  const [itemNote, setItemNote] = useState('');

  // Cart & Checkout
  const [cart, setCart] = useState<LocalCartLine[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [customerName, setCustomerName] = useState('');
  const [orderNotes, setOrderNotes] = useState('');
  const [couponInput, setCouponInput] = useState('');
  const [appliedCoupon, setAppliedCoupon] = useState<{ code: string; discount_paise: number } | null>(null);
  const [couponFeedback, setCouponFeedback] = useState<string | null>(null);
  const [checkoutIdemKey, setCheckoutIdemKey] = useState<string>(() => crypto.randomUUID());
  const [submittingCheckout, setSubmittingCheckout] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  // Payment Gateway Modal
  const [pendingPayment, setPendingPayment] = useState<{
    order: Order;
    provider_order_id: string;
    amount_paise: number;
    is_sandbox_demo: boolean;
  } | null>(null);
  const [payMethod, setPayMethod] = useState<'upi' | 'card' | 'netbanking' | 'wallet'>('upi');
  const [payingBusy, setPayingBusy] = useState(false);
  const [paymentMessage, setPaymentMessage] = useState<{ type: 'error' | 'success'; text: string } | null>(null);

  // Session Orders & Consolidated Bill
  const [sessionOrders, setSessionOrders] = useState<Order[]>([]);
  const [sessionTotals, setSessionTotals] = useState<{
    subtotal_paise: number;
    gst_paise: number;
    service_charge_paise: number;
    discount_paise: number;
    grand_total_paise: number;
    paid_paise: number;
    outstanding_paise: number;
  } | null>(null);
  const [waiterBanner, setWaiterBanner] = useState<string | null>(null);

  // Ready Order Toast Notifications
  const [readyToasts, setReadyToasts] = useState<
    Array<{ id: string; orderId: number; orderNumber: string; message: string }>
  >([]);
  const prevOrderStatusesRef = useRef<Map<number, string>>(new Map());
  const notifiedReadyIdsRef = useRef<Set<number>>(new Set());
  const initialOrdersLoadedRef = useRef(false);

  const dismissReadyToast = useCallback((toastId: string) => {
    setReadyToasts((prev) => prev.filter((t) => t.id !== toastId));
  }, []);

  const triggerReadyToast = useCallback((orderId: number, orderNumber?: string) => {
    if (!orderId || notifiedReadyIdsRef.current.has(orderId)) return;
    notifiedReadyIdsRef.current.add(orderId);

    const toastId = `ready-${orderId}-${Date.now()}`;
    const label = orderNumber ? `Order ${orderNumber}` : `Order #${orderId}`;
    setReadyToasts((prev) => [
      ...prev.slice(-2),
      {
        id: toastId,
        orderId,
        orderNumber: orderNumber || `#${orderId}`,
        message: `${label} is freshly plated and ready for service.`,
      },
    ]);

    try {
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        navigator.vibrate([100, 50, 120]);
      }
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(587.33, ctx.currentTime);
        osc.frequency.setValueAtTime(880, ctx.currentTime + 0.14);
        gain.gain.setValueAtTime(0.08, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.45);
      }
    } catch {
      // Ignore audio/vibration blocks on autoplay-restricted devices
    }

    window.setTimeout(() => {
      setReadyToasts((prev) => prev.filter((t) => t.id !== toastId));
    }, 9000);
  }, []);

  const fetchSessionState = useCallback(
    async (tok: string, tblNum: number) => {
      try {
        const resp = await apiFetch(`/api/table-session/current?table=${tblNum}`, {
          headers: { 'X-Table-Session-Token': tok },
        });
        if (!resp.ok) return;
        const data = await parseJsonSafe<{
          session?: { id: number; session_code: string; status?: string };
          invoice_number?: string | null;
          orders?: Order[];
          totals?: typeof sessionTotals;
        }>(resp);
        const nextOrders = data.orders || [];
        if (data.session?.status === 'closed') {
          setSessionClosed(true);
          if (data.invoice_number) {
            setClosedInvoiceNumber(data.invoice_number);
          }
          setCart([]);
          setCartOpen(false);
          setConfirmOpen(false);
        }

        if (!initialOrdersLoadedRef.current) {
          initialOrdersLoadedRef.current = true;
          for (const ord of nextOrders) {
            prevOrderStatusesRef.current.set(ord.id, ord.status);
            if (ord.status === 'ready') {
              notifiedReadyIdsRef.current.add(ord.id);
            }
          }
        } else {
          for (const ord of nextOrders) {
            const prevStatus = prevOrderStatusesRef.current.get(ord.id);
            if (ord.status === 'ready' && prevStatus !== 'ready') {
              triggerReadyToast(ord.id, ord.order_number);
            }
            prevOrderStatusesRef.current.set(ord.id, ord.status);
          }
        }

        setSessionOrders(nextOrders);
        setSessionTotals(data.totals || null);
      } catch {
        // Ignore transient refresh failure
      }
    },
    [triggerReadyToast]
  );

  // Validate QR from URL on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tableParam = params.get('table');
    const tokenParam = params.get('token');

    if (!tableParam || !tokenParam) {
      setQrError('Missing table number or security QR token in URL. Please scan the QR plaque on your table.');
      setValidating(false);
      return;
    }

    (async () => {
      try {
        const resp = await apiFetch('/api/qr/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ table: Number(tableParam), token: tokenParam }),
        });
        const data = await parseJsonSafe<{
          table: typeof tableInfo;
          session: typeof sessionInfo;
          customer_token: string;
          error?: string;
        }>(resp);
        if (!resp.ok) {
          throw new Error(data.error || 'QR validation failed.');
        }
        setTableInfo(data.table);
        setSessionInfo(data.session);
        setCustomerToken(data.customer_token);
        if (data.table) {
          await fetchSessionState(data.customer_token, data.table.table_number);
        }
      } catch (err: unknown) {
        setQrError(err instanceof Error ? err.message : 'Unable to verify table QR.');
      } finally {
        setValidating(false);
      }
    })();
  }, [fetchSessionState]);

  // Live WebSocket Synchronization for this Table Session
  const { connected: wsConnected } = useRealtimeRoom({
    room: sessionInfo ? `table:${sessionInfo.id}` : null,
    tableToken: customerToken,
    onEvent: (eventName, payload) => {
      if (eventName === 'sync:update' && payload && typeof payload === 'object') {
        const p = payload as {
          type?: string;
          orderId?: number;
          orderNumber?: string;
          status?: string;
          orderStatus?: string;
          invoiceNumber?: string | null;
        };
        if (
          p.type === 'kitchen_status_changed' &&
          (p.status === 'ready' || p.orderStatus === 'ready') &&
          typeof p.orderId === 'number'
        ) {
          triggerReadyToast(p.orderId, p.orderNumber);
        }
        if (p.type === 'session_closed') {
          setSessionClosed(true);
          if (p.invoiceNumber) setClosedInvoiceNumber(p.invoiceNumber);
          setCart([]);
          setCartOpen(false);
          setConfirmOpen(false);
          setViewMode('tracking');
        }
      }
      if (customerToken && tableInfo && (eventName === 'sync:update' || eventName === 'menu:updated')) {
        fetchSessionState(customerToken, tableInfo.table_number);
      }
    },
  });

  const filteredItems = useMemo(() => {
    let list = [...items];
    if (selectedCat !== 'all') list = list.filter((i) => i.category_id === selectedCat);
    if (vegOnly === 'veg') list = list.filter((i) => i.is_veg === 1);
    if (vegOnly === 'nonveg') list = list.filter((i) => i.is_veg === 0);
    if (bestsellerOnly) list = list.filter((i) => i.is_bestseller === 1);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (i) => i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q)
      );
    }
    return list;
  }, [items, selectedCat, vegOnly, bestsellerOnly, search]);

  const cartSummary = useMemo(() => {
    const subtotal = cart.reduce((sum, line) => {
      const vDelta = line.variant?.price_delta_paise || 0;
      const aSum = line.addons.reduce((a, x) => a + x.price_paise, 0);
      return sum + (line.item.price_paise + vDelta + aSum) * line.quantity;
    }, 0);
    const discount = appliedCoupon ? Math.min(appliedCoupon.discount_paise, subtotal) : 0;
    const taxable = Math.max(0, subtotal - discount);
    const gstBps = restaurant?.gst_rate_bps ?? 500;
    const svcBps = restaurant?.service_charge_bps ?? 500;
    const gst = Math.round((taxable * gstBps) / 10000);
    const svc = Math.round((taxable * svcBps) / 10000);
    return {
      count: cart.reduce((s, l) => s + l.quantity, 0),
      subtotal,
      discount,
      gst,
      svc,
      grandTotal: taxable + gst + svc,
    };
  }, [cart, appliedCoupon, restaurant]);

  function openCustomize(item: MenuItem) {
    setCustomizingItem(item);
    setSelVariant(item.variants.length > 0 ? item.variants[0] : null);
    setSelAddons([]);
    setItemQty(1);
    setItemNote('');
  }

  function addCustomizedToCart() {
    if (!customizingItem) return;
    const line: LocalCartLine = {
      uid: `${customizingItem.id}-${Date.now()}-${Math.random()}`,
      item: customizingItem,
      quantity: itemQty,
      variant: selVariant,
      addons: selAddons,
      special_instructions: itemNote.trim(),
    };
    setCart((prev) => [...prev, line]);
    setCustomizingItem(null);
  }

  function quickAdd(item: MenuItem) {
    if (item.variants.length > 0 || item.addons.length > 0) {
      openCustomize(item);
      return;
    }
    setCart((prev) => {
      const idx = prev.findIndex((l) => l.item.id === item.id && !l.variant && l.addons.length === 0 && !l.special_instructions);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], quantity: next[idx].quantity + 1 };
        return next;
      }
      return [
        ...prev,
        {
          uid: `${item.id}-${Date.now()}`,
          item,
          quantity: 1,
          variant: null,
          addons: [],
          special_instructions: '',
        },
      ];
    });
  }

  async function applyCoupon() {
    setCouponFeedback(null);
    if (!couponInput.trim()) return;
    try {
      const resp = await apiFetch('/api/coupons/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: couponInput.trim(), subtotal_paise: cartSummary.subtotal }),
      });
      const data = await parseJsonSafe<{ coupon: { code: string }; discount_paise: number; error?: string }>(resp);
      if (!resp.ok) throw new Error(data.error || 'Coupon invalid');
      setAppliedCoupon({ code: data.coupon.code, discount_paise: data.discount_paise });
      setCouponFeedback(`Applied ${data.coupon.code}: -${formatINR(data.discount_paise)}`);
    } catch (err: unknown) {
      setAppliedCoupon(null);
      setCouponFeedback(err instanceof Error ? err.message : 'Coupon invalid');
    }
  }

  async function submitCheckout() {
    if (!customerToken || !tableInfo || cart.length === 0) return;
    setSubmittingCheckout(true);
    setCheckoutError(null);
    try {
      const resp = await apiFetch('/api/orders/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Table-Session-Token': customerToken,
        },
        body: JSON.stringify({
          idempotency_key: checkoutIdemKey,
          customer_name: customerName || undefined,
          coupon_code: appliedCoupon?.code || null,
          special_instructions: orderNotes || undefined,
          items: cart.map((l) => ({
            menu_item_id: l.item.id,
            quantity: l.quantity,
            variant_name: l.variant?.name || null,
            addon_names: l.addons.map((a) => a.name),
            special_instructions: l.special_instructions || null,
          })),
        }),
      });
      const data = await parseJsonSafe<{
        order: Order;
        payment_order: { provider_order_id: string; amount_paise: number; is_sandbox_demo: boolean };
        error?: string;
      }>(resp);
      if (!resp.ok) throw new Error(data.error || 'Checkout failed');

      setPendingPayment({
        order: data.order,
        provider_order_id: data.payment_order.provider_order_id,
        amount_paise: data.payment_order.amount_paise,
        is_sandbox_demo: data.payment_order.is_sandbox_demo,
      });
      setPaymentMessage(null);
      setConfirmOpen(false);
      setCartOpen(false);
    } catch (err: unknown) {
      setCheckoutError(err instanceof Error ? err.message : 'Unable to create order');
    } finally {
      setSubmittingCheckout(false);
    }
  }

  async function completeSandboxPayment() {
    if (!pendingPayment || !customerToken || !tableInfo) return;
    setPayingBusy(true);
    setPaymentMessage(null);
    try {
      const authResp = await apiFetch('/api/payments/sandbox-authorize', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Table-Session-Token': customerToken,
        },
        body: JSON.stringify({
          provider_order_id: pendingPayment.provider_order_id,
          method: payMethod,
        }),
      });
      const authData = await parseJsonSafe<{
        razorpay_order_id: string;
        razorpay_payment_id: string;
        razorpay_signature: string;
        error?: string;
      }>(authResp);
      if (!authResp.ok) throw new Error(authData.error || 'Gateway authorization failed');

      const verResp = await apiFetch('/api/payments/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Table-Session-Token': customerToken,
        },
        body: JSON.stringify({
          razorpay_order_id: authData.razorpay_order_id,
          razorpay_payment_id: authData.razorpay_payment_id,
          razorpay_signature: authData.razorpay_signature,
          method: payMethod,
        }),
      });
      const verData = await parseJsonSafe<{ error?: string }>(verResp);
      if (!verResp.ok) throw new Error(verData.error || 'Payment verification failed');

      setCart([]);
      setAppliedCoupon(null);
      setCouponInput('');
      setOrderNotes('');
      setCheckoutIdemKey(crypto.randomUUID());
      setPendingPayment(null);
      await fetchSessionState(customerToken, tableInfo.table_number);
      setViewMode('tracking');
    } catch (err: unknown) {
      setPaymentMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Payment verification failed',
      });
    } finally {
      setPayingBusy(false);
    }
  }

  async function simulatePaymentOutcome(outcome: 'failed' | 'cancelled') {
    if (!pendingPayment || !customerToken || !tableInfo) return;
    setPayingBusy(true);
    try {
      const reason = outcome === 'failed' ? 'Bank declined transaction (Sandbox Simulation)' : 'Customer cancelled payment';
      await apiFetch('/api/payments/mark-failed', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Table-Session-Token': customerToken,
        },
        body: JSON.stringify({
          provider_order_id: pendingPayment.provider_order_id,
          reason,
        }),
      });
      setPaymentMessage({ type: 'error', text: `${reason}. Kitchen ticket was NOT released. You may retry checkout.` });
      await fetchSessionState(customerToken, tableInfo.table_number);
    } catch (err: unknown) {
      setPaymentMessage({ type: 'error', text: err instanceof Error ? err.message : 'Gateway error' });
    } finally {
      setPayingBusy(false);
    }
  }

  async function callWaiter() {
    if (!customerToken) return;
    try {
      const resp = await apiFetch('/api/table-session/call-waiter', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Table-Session-Token': customerToken,
        },
        body: JSON.stringify({ note: 'Guest requested assistance via QR menu' }),
      });
      if (resp.ok) {
        setWaiterBanner('Your waiter has been notified and is on the way.');
        window.setTimeout(() => setWaiterBanner(null), 5000);
      }
    } catch {
      // Ignore transient failure
    }
  }

  if (validating) {
    return (
      <div className="min-h-screen bg-[#FAF8F5] flex items-center justify-center p-6">
        <div className="text-center max-w-sm">
          <QrCode className="w-10 h-10 text-[#B47B2B] mx-auto animate-pulse" />
          <h1 className="mt-4 font-display text-2xl font-semibold text-[#18181B]">Verifying Table QR</h1>
          <p className="mt-2 text-sm text-zinc-600">Authenticating your table token and loading your live dining session...</p>
        </div>
      </div>
    );
  }

  if (qrError || !tableInfo || !sessionInfo) {
    return (
      <div className="min-h-screen bg-[#FAF8F5] flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white border border-red-200 rounded-xl p-8 text-center shadow-sm">
          <AlertCircle className="w-10 h-10 text-red-600 mx-auto" />
          <h1 className="mt-4 font-display text-2xl font-semibold text-[#18181B]">QR Verification Failed</h1>
          <p className="mt-2 text-sm text-zinc-600 leading-relaxed">{qrError}</p>
          <button
            type="button"
            onClick={onExitToSite}
            className="mt-6 px-5 py-2.5 text-sm font-medium bg-[#18181B] text-white rounded-md hover:bg-[#B47B2B] transition-colors"
          >
            Return to Restaurant Website
          </button>
        </div>
      </div>
    );
  }

  const paddedTable = String(tableInfo.table_number).padStart(2, '0');

  return (
    <div className="min-h-screen bg-[#FAF8F5] pb-24">
      {/* Compact Sticky Table Header */}
      <header className="sticky top-0 z-30 bg-[#18181B] text-white border-b border-zinc-800">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[11px] text-[#D4A359] font-medium truncate">
              {restaurant?.name || 'FoodMitra'} · {tableInfo.section}
            </p>
            <h1 className="text-sm sm:text-base font-semibold truncate">
              Welcome to our restaurant · Table {paddedTable}
            </h1>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={callWaiter}
              className="px-2.5 py-1.5 text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-100 rounded-md inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
            >
              <Bell className="w-3.5 h-3.5 text-[#D4A359]" />
              <span className="hidden sm:inline">Call Waiter</span>
            </button>

            <div className="inline-flex bg-zinc-800 rounded-md p-0.5">
              <button
                type="button"
                onClick={() => setViewMode('menu')}
                className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                  viewMode === 'menu' ? 'bg-[#B47B2B] text-white' : 'text-zinc-300 hover:text-white'
                }`}
              >
                Menu
              </button>
              <button
                type="button"
                onClick={() => setViewMode('tracking')}
                className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                  viewMode === 'tracking' ? 'bg-[#B47B2B] text-white' : 'text-zinc-300 hover:text-white'
                }`}
              >
                Orders ({sessionOrders.length})
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Welcome Banner */}
      <div className="bg-[#F2EFE9] border-b border-zinc-200 px-4 py-3">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-zinc-700">
          <span>
            <strong>You are ordering from Table {paddedTable}.</strong> Session{' '}
            <span className="font-mono">{sessionInfo.session_code}</span> · Multiple rounds share one table bill.
          </span>
          <span className="text-zinc-500 flex items-center gap-1.5 shrink-0">
            <span className={`w-1.5 h-1.5 rounded-full ${wsConnected ? 'bg-emerald-600' : 'bg-amber-500'}`} />
            {wsConnected ? 'Live Kitchen Sync Active' : 'Reconnecting Sync...'}
          </span>
        </div>
      </div>

      {waiterBanner && (
        <div className="max-w-5xl mx-auto px-4 mt-4">
          <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-medium rounded-md flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            {waiterBanner}
          </div>
        </div>
      )}

      {/* ==================== MENU MODE ==================== */}
      {viewMode === 'menu' ? (
        <main className="max-w-5xl mx-auto px-4 py-6">
          {/* Search & Filters */}
          <div className="space-y-3">
            <div className="relative">
              <Search className="w-4 h-4 text-zinc-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search Paneer Tikka, Butter Naan, Cold Coffee..."
                className="w-full pl-10 pr-4 py-2.5 text-sm bg-white border border-zinc-300 rounded-lg focus:outline-none focus:border-[#B47B2B]"
              />
            </div>

            <div className="flex items-center gap-2 overflow-x-auto pb-1">
              <button
                type="button"
                onClick={() => setSelectedCat('all')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap shrink-0 cursor-pointer ${
                  selectedCat === 'all' ? 'bg-[#18181B] text-white' : 'bg-white border border-zinc-200 text-zinc-700'
                }`}
              >
                All
              </button>
              {categories.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSelectedCat(c.id)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap shrink-0 cursor-pointer ${
                    selectedCat === c.id ? 'bg-[#18181B] text-white' : 'bg-white border border-zinc-200 text-zinc-700'
                  }`}
                >
                  {c.name}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {(['all', 'veg', 'nonveg'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setVegOnly(v)}
                  className={`px-3 py-1 text-xs font-medium rounded border cursor-pointer ${
                    vegOnly === v ? 'bg-[#18181B] text-white border-[#18181B]' : 'bg-white border-zinc-200 text-zinc-700'
                  }`}
                >
                  {v === 'all' ? 'All Dishes' : v === 'veg' ? 'Veg Only' : 'Non-Veg'}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setBestsellerOnly(!bestsellerOnly)}
                className={`px-3 py-1 text-xs font-medium rounded border cursor-pointer ${
                  bestsellerOnly ? 'bg-[#B47B2B] text-white border-[#B47B2B]' : 'bg-white border-zinc-200 text-zinc-700'
                }`}
              >
                Bestsellers
              </button>
            </div>
          </div>

          {/* Menu Items List */}
          <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
            {filteredItems.map((item) => {
              const inCartCount = cart
                .filter((l) => l.item.id === item.id)
                .reduce((s, l) => s + l.quantity, 0);

              return (
                <div
                  key={item.id}
                  className="bg-white border border-zinc-200 rounded-lg p-4 flex gap-4 justify-between"
                >
                  <div className="flex-1 min-w-0 flex flex-col justify-between">
                    <div>
                      <div className="flex items-center gap-2 text-[11px] text-zinc-500">
                        <VegIndicator isVeg={item.is_veg} />
                        <span>{item.category_name}</span>
                        {item.is_bestseller === 1 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="text-[#B47B2B] font-medium">Bestseller</span>
                          </>
                        )}
                      </div>
                      <h3 className="mt-1 text-sm sm:text-base font-semibold text-[#18181B]">{item.name}</h3>
                      <p className="mt-1 text-xs text-zinc-600 line-clamp-2 leading-relaxed">{item.description}</p>
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-[#18181B] tabular-nums">
                        {formatINR(item.price_paise)}
                      </span>
                      {(item.variants.length > 0 || item.addons.length > 0) && (
                        <span className="text-[11px] text-zinc-500">Customizable</span>
                      )}
                    </div>
                  </div>

                  <div className="w-28 shrink-0 flex flex-col items-center gap-2">
                    <div className="w-28 h-24 rounded-md overflow-hidden bg-zinc-100">
                      <SafeImage src={item.image_url} alt={item.name} className="w-full h-full object-cover" />
                    </div>
                    <button
                      type="button"
                      disabled={!item.is_available}
                      onClick={() => quickAdd(item)}
                      className="w-full py-1.5 text-xs font-semibold rounded border transition-colors cursor-pointer disabled:opacity-40 bg-[#FAF8F5] border-[#B47B2B] text-[#18181B] hover:bg-[#B47B2B] hover:text-white whitespace-nowrap"
                    >
                      {!item.is_available ? 'Sold Out' : inCartCount > 0 ? `Add (${inCartCount})` : '+ Add'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </main>
      ) : (
        /* ==================== LIVE ORDER TRACKING & REPEAT ORDERING ==================== */
        <main className="max-w-4xl mx-auto px-4 py-6 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white border border-zinc-200 rounded-xl p-5">
            <div>
              <h2 className="font-display text-2xl font-semibold text-[#18181B]">
                Table {paddedTable} Live Order Tracker
              </h2>
              <p className="mt-1 text-xs text-zinc-600">
                {sessionClosed
                  ? 'This dining session is settled and completed. Table is now available for the next guests.'
                  : 'Each order sends a separate ticket to the kitchen and updates your consolidated table bill automatically.'}
              </p>
            </div>
            {sessionClosed ? (
              <button
                type="button"
                onClick={onExitToSite}
                className="px-4 py-2.5 text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 text-white rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Session Completed · Done
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setViewMode('menu')}
                className="px-4 py-2.5 text-xs font-semibold bg-[#18181B] text-white hover:bg-[#B47B2B] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                + Order More Items
              </button>
            )}
          </div>

          {sessionClosed && (
            <div className="bg-emerald-50 border border-emerald-300 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 text-emerald-900">
                <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                <div>
                  <p className="text-sm font-semibold">
                    Thank you for dining with {restaurant?.name || 'FoodMitra'}!
                  </p>
                  <p className="text-xs text-emerald-800">
                    Table {paddedTable} session is complete{closedInvoiceNumber ? ` · Invoice ${closedInvoiceNumber}` : ''}.
                  </p>
                </div>
              </div>
            </div>
          )}

          {sessionOrders.length === 0 ? (
            <div className="bg-white border border-zinc-200 rounded-xl p-12 text-center">
              <ChefHat className="w-10 h-10 text-zinc-400 mx-auto" />
              <h3 className="mt-3 text-base font-semibold text-zinc-900">No Orders Placed Yet</h3>
              <p className="mt-1 text-sm text-zinc-600">Browse the digital menu to place your first round for Table {paddedTable}.</p>
              <button
                type="button"
                onClick={() => setViewMode('menu')}
                className="mt-5 px-5 py-2.5 text-xs font-medium bg-[#18181B] text-white rounded-md"
              >
                Browse Menu
              </button>
            </div>
          ) : (
            <div className="space-y-5">
              {sessionOrders.map((ord, idx) => {
                const isRejectedOrCancelled = ord.status === 'rejected' || ord.status === 'cancelled';
                const currentStepIdx = TIMELINE_STEPS.findIndex((s) => s.key === ord.status);

                return (
                  <div key={ord.id} className="bg-white border border-zinc-200 rounded-xl p-5 space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-zinc-100">
                      <div>
                        <div className="flex items-center gap-2.5">
                          <span className="font-mono text-sm font-semibold text-[#18181B]">{ord.order_number}</span>
                          {ord.ticket_number && (
                            <span className="font-mono text-xs text-zinc-500">· Ticket {ord.ticket_number}</span>
                          )}
                          <span className="text-xs text-zinc-400">· Round #{idx + 1}</span>
                        </div>
                        <p className="text-xs text-zinc-500 mt-0.5">{formatDateTimeIST(ord.created_at)}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <StatusLabel status={ord.payment_status} />
                        <StatusLabel status={ord.status} />
                      </div>
                    </div>

                    {/* Visual Progress Timeline */}
                    {!isRejectedOrCancelled ? (
                      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 py-2">
                        {TIMELINE_STEPS.map((step, sIdx) => {
                          const done = sIdx <= currentStepIdx;
                          return (
                            <div key={step.key} className="flex flex-col items-center text-center">
                              <div
                                className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold border ${
                                  done
                                    ? 'bg-emerald-600 border-emerald-600 text-white'
                                    : 'bg-zinc-50 border-zinc-300 text-zinc-400'
                                }`}
                              >
                                {done ? <Check className="w-3.5 h-3.5" /> : sIdx + 1}
                              </div>
                              <span className={`mt-1.5 text-[11px] font-medium ${done ? 'text-zinc-900' : 'text-zinc-400'}`}>
                                {step.label}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="p-3 bg-red-50 border border-red-200 rounded text-xs text-red-800">
                        Order {ord.status}: {ord.rejection_reason || 'Cancelled'}
                      </div>
                    )}

                    {/* Ordered Items */}
                    <div className="divide-y divide-zinc-100 text-sm">
                      {ord.items.map((it) => (
                        <div key={it.id} className="py-2 flex items-start justify-between gap-4">
                          <div>
                            <p className={`font-medium ${it.is_cancelled ? 'line-through text-zinc-400' : 'text-zinc-900'}`}>
                              {it.quantity} × {it.item_name}
                              {it.variant_name ? ` (${it.variant_name})` : ''}
                            </p>
                            {it.addons && it.addons.length > 0 && (
                              <p className="text-xs text-zinc-500">
                                Add-ons: {it.addons.map((a) => a.name).join(', ')}
                              </p>
                            )}
                            {it.special_instructions && (
                              <p className="text-xs text-[#B47B2B]">Note: {it.special_instructions}</p>
                            )}
                          </div>
                          <span className="font-medium tabular-nums text-zinc-800">{formatINR(it.line_total_paise)}</span>
                        </div>
                      ))}
                    </div>

                    {/* Order Totals & History */}
                    <div className="pt-3 border-t border-zinc-100 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-600">
                      <span>
                        Subtotal {formatINR(ord.subtotal_paise)} · GST {formatINR(ord.gst_paise)} · Service{' '}
                        {formatINR(ord.service_charge_paise)}
                        {ord.discount_paise > 0 ? ` · Discount -${formatINR(ord.discount_paise)}` : ''}
                      </span>
                      <span className="text-sm font-semibold text-[#18181B] tabular-nums">
                        Order Total: {formatINR(ord.total_paise)}
                      </span>
                    </div>

                    {ord.history && ord.history.length > 0 && (
                      <div className="bg-zinc-50 rounded-lg p-3 text-xs text-zinc-600 space-y-1">
                        <p className="font-semibold text-zinc-800">Status History</p>
                        {ord.history.map((h) => (
                          <div key={h.id} className="flex items-center justify-between gap-2">
                            <span>{h.note || h.to_status}</span>
                            <span className="font-mono text-[11px] text-zinc-400 shrink-0">
                              {formatDateTimeIST(h.created_at)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Consolidated Table Session Bill Summary */}
              {sessionTotals && (
                <div className="bg-[#18181B] text-white rounded-xl p-6 space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="font-display text-xl font-semibold">Consolidated Table {paddedTable} Bill</h3>
                    <Receipt className="w-5 h-5 text-[#D4A359]" />
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-2 text-xs">
                    <div>
                      <p className="text-zinc-400">Combined Subtotal</p>
                      <p className="mt-1 text-sm font-semibold tabular-nums">{formatINR(sessionTotals.subtotal_paise)}</p>
                    </div>
                    <div>
                      <p className="text-zinc-400">GST &amp; Service</p>
                      <p className="mt-1 text-sm font-semibold tabular-nums">
                        {formatINR(sessionTotals.gst_paise + sessionTotals.service_charge_paise)}
                      </p>
                    </div>
                    <div>
                      <p className="text-zinc-400">Paid Online / POS</p>
                      <p className="mt-1 text-sm font-semibold text-emerald-400 tabular-nums">
                        {formatINR(sessionTotals.paid_paise)}
                      </p>
                    </div>
                    <div>
                      <p className="text-zinc-400">Grand Total</p>
                      <p className="mt-1 text-base font-bold text-[#D4A359] tabular-nums">
                        {formatINR(sessionTotals.grand_total_paise)}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </main>
      )}

      {/* Compact Sticky Cart Bar (Strict <= 15% mobile height) */}
      {cart.length > 0 && !sessionClosed && !cartOpen && !confirmOpen && !pendingPayment && (
        <div className="fixed bottom-3 left-0 right-0 z-30 px-4 pointer-events-none">
          <div className="max-w-3xl mx-auto pointer-events-auto">
            <button
              type="button"
              onClick={() => setCartOpen(true)}
              className="w-full h-13 px-5 bg-[#18181B] text-white rounded-xl shadow-lg flex items-center justify-between hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-3 text-sm">
                <ShoppingBag className="w-4 h-4 text-[#D4A359]" />
                <span className="font-semibold tabular-nums">
                  {cartSummary.count} {cartSummary.count === 1 ? 'Item' : 'Items'}
                </span>
                <span className="text-zinc-400">·</span>
                <span className="font-semibold tabular-nums">{formatINR(cartSummary.grandTotal)}</span>
              </div>
              <span className="text-xs font-semibold text-[#D4A359] uppercase tracking-wider">Review Cart →</span>
            </button>
          </div>
        </div>
      )}

      {/* Item Customization Modal */}
      {customizingItem && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="w-full sm:max-w-lg bg-white rounded-t-2xl sm:rounded-xl overflow-hidden max-h-[90vh] flex flex-col">
            <div className="px-5 py-4 border-b border-zinc-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <VegIndicator isVeg={customizingItem.is_veg} />
                <h3 className="font-semibold text-base text-[#18181B]">{customizingItem.name}</h3>
              </div>
              <button type="button" onClick={() => setCustomizingItem(null)} className="text-zinc-500">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 overflow-y-auto space-y-5">
              <p className="text-sm text-zinc-600">{customizingItem.description}</p>

              {customizingItem.variants.length > 0 && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">Choose Variant</p>
                  <div className="space-y-2">
                    {customizingItem.variants.map((v) => (
                      <label
                        key={v.name}
                        className="flex items-center justify-between p-3 border border-zinc-200 rounded-lg cursor-pointer hover:border-[#B47B2B]"
                      >
                        <div className="flex items-center gap-2.5 text-sm">
                          <input
                            type="radio"
                            name="variant"
                            checked={selVariant?.name === v.name}
                            onChange={() => setSelVariant(v)}
                          />
                          <span>{v.name}</span>
                        </div>
                        <span className="text-xs font-medium tabular-nums text-zinc-600">
                          {v.price_delta_paise > 0 ? `+${formatINR(v.price_delta_paise)}` : 'Included'}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {customizingItem.addons.length > 0 && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">Optional Add-ons</p>
                  <div className="space-y-2">
                    {customizingItem.addons.map((a) => {
                      const checked = selAddons.some((x) => x.name === a.name);
                      return (
                        <label
                          key={a.name}
                          className="flex items-center justify-between p-3 border border-zinc-200 rounded-lg cursor-pointer hover:border-[#B47B2B]"
                        >
                          <div className="flex items-center gap-2.5 text-sm">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                setSelAddons((prev) =>
                                  checked ? prev.filter((x) => x.name !== a.name) : [...prev, a]
                                )
                              }
                            />
                            <span>{a.name}</span>
                          </div>
                          <span className="text-xs font-medium tabular-nums text-zinc-600">
                            +{formatINR(a.price_paise)}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1.5">
                  Special Cooking Instructions
                </label>
                <input
                  value={itemNote}
                  onChange={(e) => setItemNote(e.target.value)}
                  placeholder="E.g. Less oil, no onion/garlic, extra crispy..."
                  className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-md focus:outline-none focus:border-[#B47B2B]"
                />
              </div>
            </div>

            <div className="p-4 border-t border-zinc-200 bg-zinc-50 flex items-center justify-between gap-4">
              <div className="flex items-center border border-zinc-300 bg-white rounded-md">
                <button
                  type="button"
                  onClick={() => setItemQty(Math.max(1, itemQty - 1))}
                  className="p-2 text-zinc-700"
                >
                  <Minus className="w-4 h-4" />
                </button>
                <span className="px-3 text-sm font-semibold tabular-nums">{itemQty}</span>
                <button type="button" onClick={() => setItemQty(itemQty + 1)} className="p-2 text-zinc-700">
                  <Plus className="w-4 h-4" />
                </button>
              </div>
              <button
                type="button"
                onClick={addCustomizedToCart}
                className="flex-1 py-2.5 px-4 text-sm font-semibold bg-[#18181B] text-white rounded-md hover:bg-[#B47B2B] transition-colors cursor-pointer"
              >
                Add to Order
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Slide-Over Cart Drawer */}
      {cartOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 flex justify-end">
          <div className="w-full max-w-md bg-white h-full flex flex-col justify-between">
            <div className="px-5 py-4 border-b border-zinc-200 flex items-center justify-between">
              <div>
                <h3 className="font-semibold text-base text-[#18181B]">Table {paddedTable} Cart</h3>
                <p className="text-xs text-zinc-500">{cartSummary.count} items ready to send</p>
              </div>
              <button type="button" onClick={() => setCartOpen(false)} className="p-1.5 text-zinc-500 hover:text-zinc-900">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {cart.map((line) => {
                const unitTotal =
                  line.item.price_paise +
                  (line.variant?.price_delta_paise || 0) +
                  line.addons.reduce((s, a) => s + a.price_paise, 0);
                return (
                  <div key={line.uid} className="pb-4 border-b border-zinc-100 flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <VegIndicator isVeg={line.item.is_veg} />
                        <p className="text-sm font-semibold text-zinc-900">{line.item.name}</p>
                      </div>
                      {line.variant && <p className="text-xs text-zinc-500 mt-0.5">{line.variant.name}</p>}
                      {line.addons.length > 0 && (
                        <p className="text-xs text-zinc-500">+{line.addons.map((a) => a.name).join(', ')}</p>
                      )}
                      {line.special_instructions && (
                        <p className="text-xs text-[#B47B2B] mt-0.5">{line.special_instructions}</p>
                      )}
                      <p className="mt-1 text-xs font-medium tabular-nums text-zinc-700">
                        {formatINR(unitTotal * line.quantity)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <div className="flex items-center border border-zinc-200 rounded">
                        <button
                          type="button"
                          onClick={() =>
                            setCart((prev) =>
                              line.quantity <= 1
                                ? prev.filter((x) => x.uid !== line.uid)
                                : prev.map((x) => (x.uid === line.uid ? { ...x, quantity: x.quantity - 1 } : x))
                            )
                          }
                          className="p-1.5 text-zinc-700"
                        >
                          <Minus className="w-3.5 h-3.5" />
                        </button>
                        <span className="px-2.5 text-xs font-semibold tabular-nums">{line.quantity}</span>
                        <button
                          type="button"
                          onClick={() =>
                            setCart((prev) =>
                              prev.map((x) => (x.uid === line.uid ? { ...x, quantity: x.quantity + 1 } : x))
                            )
                          }
                          className="p-1.5 text-zinc-700"
                        >
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => setCart((prev) => prev.filter((x) => x.uid !== line.uid))}
                        className="p-1.5 text-zinc-400 hover:text-red-600"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}

              {/* Coupon */}
              <div className="pt-2">
                <label className="block text-xs font-medium text-zinc-700 mb-1 flex items-center gap-1">
                  <Tag className="w-3.5 h-3.5" /> Promo Coupon (Try FOODMITRA10)
                </label>
                <div className="flex gap-2">
                  <input
                    value={couponInput}
                    onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
                    placeholder="FOODMITRA10"
                    className="flex-1 px-3 py-2 text-xs border border-zinc-300 rounded-md uppercase"
                  />
                  <button
                    type="button"
                    onClick={applyCoupon}
                    className="px-3.5 py-2 text-xs font-medium bg-zinc-900 text-white rounded-md"
                  >
                    Apply
                  </button>
                </div>
                {couponFeedback && (
                  <p className={`mt-1.5 text-xs ${appliedCoupon ? 'text-emerald-700' : 'text-red-600'}`}>
                    {couponFeedback}
                  </p>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">Kitchen / Order Notes</label>
                <input
                  value={orderNotes}
                  onChange={(e) => setOrderNotes(e.target.value)}
                  placeholder="Serve starters together, extra napkins..."
                  className="w-full px-3 py-2 text-xs border border-zinc-300 rounded-md"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">Your Name (Optional)</label>
                <input
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder="Guest Name"
                  className="w-full px-3 py-2 text-xs border border-zinc-300 rounded-md"
                />
              </div>
            </div>

            <div className="p-5 border-t border-zinc-200 bg-zinc-50 space-y-2 text-xs">
              <div className="flex justify-between text-zinc-600">
                <span>Subtotal</span>
                <span className="tabular-nums">{formatINR(cartSummary.subtotal)}</span>
              </div>
              {cartSummary.discount > 0 && (
                <div className="flex justify-between text-emerald-700">
                  <span>Discount ({appliedCoupon?.code})</span>
                  <span className="tabular-nums">-{formatINR(cartSummary.discount)}</span>
                </div>
              )}
              <div className="flex justify-between text-zinc-600">
                <span>GST (5%)</span>
                <span className="tabular-nums">{formatINR(cartSummary.gst)}</span>
              </div>
              <div className="flex justify-between text-zinc-600">
                <span>Service Charge (5%)</span>
                <span className="tabular-nums">{formatINR(cartSummary.svc)}</span>
              </div>
              <div className="pt-2 border-t border-zinc-200 flex justify-between text-base font-bold text-[#18181B]">
                <span>Grand Total</span>
                <span className="tabular-nums">{formatINR(cartSummary.grandTotal)}</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setCartOpen(false);
                  setConfirmOpen(true);
                }}
                className="w-full mt-3 py-3 text-sm font-semibold bg-[#18181B] text-white hover:bg-[#B47B2B] rounded-md transition-colors cursor-pointer"
              >
                ORDER NOW · Proceed to Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Order Confirmation Screen */}
      {confirmOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white rounded-xl p-6 space-y-4 shadow-xl">
            <h3 className="font-display text-2xl font-semibold text-[#18181B]">Confirm Order for Table {paddedTable}</h3>
            <p className="text-xs text-zinc-600">
              All totals are verified by the restaurant server before payment. Please review your order below.
            </p>
            <div className="max-h-52 overflow-y-auto divide-y divide-zinc-100 border-y border-zinc-200 py-2 text-sm">
              {cart.map((l) => (
                <div key={l.uid} className="py-1.5 flex justify-between">
                  <span>
                    {l.quantity} × {l.item.name}
                    {l.variant ? ` (${l.variant.name})` : ''}
                  </span>
                  <span className="tabular-nums font-medium">
                    {formatINR((l.item.price_paise + (l.variant?.price_delta_paise || 0)) * l.quantity)}
                  </span>
                </div>
              ))}
            </div>
            <div className="flex justify-between text-base font-bold text-[#18181B]">
              <span>Payable Total (incl. GST &amp; Service)</span>
              <span className="tabular-nums">{formatINR(cartSummary.grandTotal)}</span>
            </div>

            {checkoutError && (
              <div className="p-3 bg-red-50 border border-red-200 text-red-700 text-xs rounded">{checkoutError}</div>
            )}

            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="flex-1 py-2.5 text-xs font-medium bg-zinc-100 text-zinc-800 rounded-md"
              >
                Back to Cart
              </button>
              <button
                type="button"
                disabled={submittingCheckout}
                onClick={submitCheckout}
                className="flex-1 py-2.5 text-xs font-semibold bg-[#18181B] text-white hover:bg-[#B47B2B] rounded-md disabled:opacity-50 cursor-pointer"
              >
                {submittingCheckout ? 'Creating Order...' : 'SEND ORDER & PAY'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Online Payment Gateway Modal (Razorpay / Clearly Labelled Sandbox Demo Mode) */}
      {pendingPayment && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white rounded-xl overflow-hidden shadow-2xl border border-zinc-200">
            <div className="bg-[#18181B] text-white p-5 flex items-center justify-between">
              <div>
                <p className="text-[11px] uppercase tracking-wider text-[#D4A359] font-semibold">
                  {pendingPayment.is_sandbox_demo ? 'Simulated Sandbox Payment Mode' : 'Razorpay Checkout'}
                </p>
                <h3 className="text-lg font-semibold mt-0.5">
                  {restaurant?.name || 'FoodMitra'} · Table {paddedTable}
                </h3>
                <p className="text-xs text-zinc-400 font-mono mt-0.5">{pendingPayment.order.order_number}</p>
              </div>
              <div className="text-right">
                <p className="text-xs text-zinc-400">Amount</p>
                <p className="text-xl font-bold text-[#D4A359] tabular-nums">
                  {formatINR(pendingPayment.amount_paise)}
                </p>
              </div>
            </div>

            <div className="p-5 space-y-4">
              {pendingPayment.is_sandbox_demo && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-md text-xs text-amber-900 leading-relaxed">
                  <strong>Demo Sandbox Notice:</strong> Live Razorpay keys are not set in environment variables. This checkout simulates gateway signature verification via server-side HMAC-SHA256.
                </div>
              )}

              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">
                  Select Payment Method
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { id: 'upi', label: 'UPI (GPay / PhonePe)', icon: Smartphone },
                    { id: 'card', label: 'Debit / Credit Card', icon: CreditCard },
                    { id: 'netbanking', label: 'Net Banking', icon: Sparkles },
                    { id: 'wallet', label: 'Wallets', icon: Clock },
                  ].map((m) => {
                    const Icon = m.icon;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => setPayMethod(m.id as typeof payMethod)}
                        className={`p-3 rounded-lg border text-left text-xs font-medium flex items-center gap-2 cursor-pointer ${
                          payMethod === m.id
                            ? 'border-[#B47B2B] bg-[#FAF8F5] text-[#18181B]'
                            : 'border-zinc-200 text-zinc-600'
                        }`}
                      >
                        <Icon className="w-4 h-4 text-[#B47B2B] shrink-0" />
                        <span>{m.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {paymentMessage && (
                <div
                  className={`p-3 rounded text-xs border ${
                    paymentMessage.type === 'error'
                      ? 'bg-red-50 border-red-200 text-red-700'
                      : 'bg-emerald-50 border-emerald-200 text-emerald-700'
                  }`}
                >
                  {paymentMessage.text}
                </div>
              )}

              <div className="space-y-2 pt-2">
                <button
                  type="button"
                  disabled={payingBusy}
                  onClick={completeSandboxPayment}
                  className="w-full py-3 text-sm font-semibold bg-emerald-700 hover:bg-emerald-800 text-white rounded-md transition-colors cursor-pointer disabled:opacity-50"
                >
                  {payingBusy ? 'Verifying Signature...' : `Complete Payment (${formatINR(pendingPayment.amount_paise)})`}
                </button>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    disabled={payingBusy}
                    onClick={() => simulatePaymentOutcome('failed')}
                    className="py-2 text-xs font-medium border border-red-200 text-red-700 hover:bg-red-50 rounded-md cursor-pointer"
                  >
                    Simulate Failed
                  </button>
                  <button
                    type="button"
                    disabled={payingBusy}
                    onClick={() => {
                      simulatePaymentOutcome('cancelled');
                      setPendingPayment(null);
                    }}
                    className="py-2 text-xs font-medium border border-zinc-200 text-zinc-700 hover:bg-zinc-100 rounded-md cursor-pointer"
                  >
                    Cancel Payment
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Real-Time Order Ready Toast Notifications */}
      <div
        aria-live="polite"
        className="fixed top-16 right-4 left-4 sm:left-auto sm:w-96 z-50 flex flex-col gap-2.5 pointer-events-none"
      >
        <AnimatePresence>
          {readyToasts.map((toast) => (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, y: -16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -12, scale: 0.96 }}
              transition={{ duration: 0.2 }}
              role="status"
              className="pointer-events-auto bg-[#18181B] text-white border border-[#B47B2B]/60 rounded-xl shadow-2xl p-4 flex items-start gap-3"
            >
              <div className="w-9 h-9 rounded-lg bg-emerald-500/15 border border-emerald-400/30 flex items-center justify-center shrink-0 mt-0.5">
                <Utensils className="w-4 h-4 text-emerald-400" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold uppercase tracking-wider text-emerald-400">
                    Order Ready
                  </p>
                  <span className="font-mono text-[11px] text-zinc-400">{toast.orderNumber}</span>
                </div>
                <p className="text-sm font-medium text-white mt-0.5 leading-snug">
                  {toast.message}
                </p>
                <div className="mt-2.5 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setViewMode('tracking');
                      dismissReadyToast(toast.id);
                    }}
                    className="px-2.5 py-1 text-xs font-semibold bg-[#B47B2B] hover:bg-[#D4A359] text-white rounded transition-colors cursor-pointer"
                  >
                    Track Order
                  </button>
                  <button
                    type="button"
                    onClick={() => dismissReadyToast(toast.id)}
                    className="text-xs text-zinc-400 hover:text-white cursor-pointer"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
              <button
                type="button"
                aria-label="Close notification"
                onClick={() => dismissReadyToast(toast.id)}
                className="text-zinc-400 hover:text-white p-0.5 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
