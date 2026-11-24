import React, { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft,
  Bell,
  ChefHat,
  CreditCard,
  LayoutDashboard,
  Lock,
  LogOut,
  ShieldCheck,
  UserCheck,
  Utensils,
} from 'lucide-react';
import type {
  AppNotification,
  MenuCategory,
  MenuItem,
  RestaurantInfo,
  RoleSlug,
  StaffUser,
} from '../types.ts';
import { apiFetch, parseJsonSafe } from '../lib/api.ts';
import { formatDateTimeIST } from '../lib/format.ts';
import { KitchenDashboard } from './KitchenDashboard.tsx';
import { CounterPosDashboard } from './CounterPosDashboard.tsx';
import { WaiterDashboard } from './WaiterDashboard.tsx';
import { AdminDashboard } from './AdminDashboard.tsx';
import { QADashboard } from './QADashboard.tsx';

type StaffModule = 'admin' | 'kitchen' | 'counter' | 'waiter' | 'qa';

interface DemoCredential {
  name: string;
  email: string;
  role: RoleSlug;
  demo_password: string;
}

const ROLE_DEFAULT_MODULE: Record<RoleSlug, StaffModule> = {
  super_admin: 'admin',
  admin: 'admin',
  chef: 'kitchen',
  counter: 'counter',
  waiter: 'waiter',
};

const ROLE_ALLOWED_MODULES: Record<RoleSlug, StaffModule[]> = {
  super_admin: ['admin', 'kitchen', 'counter', 'waiter', 'qa'],
  admin: ['admin', 'kitchen', 'counter', 'waiter', 'qa'],
  chef: ['kitchen'],
  counter: ['counter', 'waiter'],
  waiter: ['waiter'],
};

export function StaffPortal({
  restaurant,
  categories,
  items,
  onMenuChanged,
  onBackToPublic,
  onOpenQrUrl,
}: {
  restaurant: RestaurantInfo | null;
  categories: MenuCategory[];
  items: MenuItem[];
  onMenuChanged: () => void;
  onBackToPublic: () => void;
  onOpenQrUrl: (url: string) => void;
}) {
  // Token kept strictly in React memory (never localStorage) for security hygiene
  const [staffToken, setStaffToken] = useState<string | null>(null);
  const [staffUser, setStaffUser] = useState<StaffUser | null>(null);
  const [activeModule, setActiveModule] = useState<StaffModule>('admin');

  // Login State
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [demoAccounts, setDemoAccounts] = useState<DemoCredential[]>([]);

  // Notifications
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [notifOpen, setNotifOpen] = useState(false);

  useEffect(() => {
    apiFetch('/api/auth/demo-accounts')
      .then((r) => (r.ok ? parseJsonSafe<{ accounts?: DemoCredential[] }>(r) : null))
      .then((d) => {
        if (d?.accounts) setDemoAccounts(d.accounts);
      })
      .catch(() => {});
  }, []);

  const loadNotifications = useCallback(async (tok: string) => {
    try {
      const resp = await apiFetch('/api/notifications', {
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (resp.ok) {
        const d = await parseJsonSafe<{ notifications?: AppNotification[] }>(resp);
        setNotifications(d.notifications || []);
      }
    } catch {
      // Ignore transient refresh failure
    }
  }, []);

  useEffect(() => {
    if (staffToken) {
      loadNotifications(staffToken);
    }
  }, [staffToken, loadNotifications]);

  async function handleLogin(loginEmail: string, loginPass: string) {
    setLoggingIn(true);
    setLoginError(null);
    try {
      const resp = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail, password: loginPass }),
      });
      const data = await parseJsonSafe<{ token: string; user: StaffUser; error?: string }>(resp);
      if (!resp.ok) throw new Error(data.error || 'Login failed');
      setStaffToken(data.token);
      setStaffUser(data.user);
      setActiveModule(ROLE_DEFAULT_MODULE[data.user.role as RoleSlug] || 'admin');
    } catch (err: unknown) {
      setLoginError(err instanceof Error ? err.message : 'Unable to authenticate');
    } finally {
      setLoggingIn(false);
    }
  }

  async function handleLogout() {
    if (staffToken) {
      try {
        await apiFetch('/api/auth/logout', {
          method: 'POST',
          headers: { Authorization: `Bearer ${staffToken}` },
        });
      } catch {
        // Proceed with local sign-out even if request fails
      }
    }
    setStaffToken(null);
    setStaffUser(null);
    setEmail('');
    setPassword('');
  }

  async function markNotificationsRead() {
    if (!staffToken) return;
    try {
      await apiFetch('/api/notifications/read', {
        method: 'POST',
        headers: { Authorization: `Bearer ${staffToken}` },
      });
      loadNotifications(staffToken);
    } catch {
      // Ignore
    }
  }

  // ==================== STAFF LOGIN SCREEN ====================
  if (!staffToken || !staffUser) {
    return (
      <div className="min-h-screen bg-[#FAF8F5] flex flex-col justify-center py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-4xl w-full mx-auto">
          <button
            type="button"
            onClick={onBackToPublic}
            className="mb-6 inline-flex items-center gap-1.5 text-xs font-medium text-zinc-600 hover:text-zinc-900 cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Back to Public Restaurant Website
          </button>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            <div className="lg:col-span-6 bg-white border border-zinc-200 rounded-xl p-6 sm:p-8 shadow-sm">
              <div className="flex items-center gap-2 text-[#B47B2B]">
                <Lock className="w-4 h-4" />
                <span className="text-xs font-semibold uppercase tracking-wider">Restaurant 360° Staff Portal</span>
              </div>
              <h1 className="mt-2 font-display text-3xl font-semibold text-[#18181B]">
                {restaurant?.name || 'Saffron & Ember'} Operations
              </h1>
              <p className="mt-1.5 text-xs text-zinc-600">
                Sign in with your role credentials to access Kitchen KDS, Counter POS, Waiter, Admin, or QA Lab.
              </p>

              {loginError && (
                <div className="mt-4 p-3 bg-red-50 border border-red-200 text-red-700 text-xs rounded-md">
                  {loginError}
                </div>
              )}

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleLogin(email, password);
                }}
                className="mt-6 space-y-4"
              >
                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-1">Staff Email</label>
                  <input
                    required
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="role@saffronember.in"
                    className="w-full px-3.5 py-2.5 text-sm border border-zinc-300 rounded-md focus:outline-none focus:border-[#B47B2B]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-1">Password</label>
                  <input
                    required
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full px-3.5 py-2.5 text-sm border border-zinc-300 rounded-md focus:outline-none focus:border-[#B47B2B]"
                  />
                </div>
                <button
                  type="submit"
                  disabled={loggingIn}
                  className="w-full py-2.5 text-sm font-semibold bg-[#18181B] text-white hover:bg-[#B47B2B] rounded-md transition-colors cursor-pointer disabled:opacity-50"
                >
                  {loggingIn ? 'Authenticating...' : 'Sign In to Operations'}
                </button>
              </form>
            </div>

            {/* Development Demo Role Quick-Login Cards */}
            <div className="lg:col-span-6 bg-white border border-zinc-200 rounded-xl p-6 sm:p-8">
              <h2 className="text-sm font-semibold text-zinc-900">Development Demo Accounts (5 Roles)</h2>
              <p className="mt-1 text-xs text-zinc-500">
                Select any staff role below to authenticate through the server password-verification endpoint and inspect role-scoped permissions.
              </p>

              <div className="mt-4 space-y-2.5">
                {demoAccounts.map((acc) => (
                  <button
                    key={acc.email}
                    type="button"
                    disabled={loggingIn}
                    onClick={() => handleLogin(acc.email, acc.demo_password)}
                    className="w-full p-3.5 border border-zinc-200 hover:border-[#B47B2B] rounded-lg text-left flex items-center justify-between gap-3 transition-colors cursor-pointer bg-[#FAF8F5]/60 hover:bg-[#FAF8F5]"
                  >
                    <div>
                      <p className="text-xs font-bold text-[#18181B]">
                        {acc.name} · <span className="uppercase text-[#B47B2B]">{acc.role.replace('_', ' ')}</span>
                      </p>
                      <p className="text-[11px] font-mono text-zinc-500 mt-0.5">
                        {acc.email} / {acc.demo_password}
                      </p>
                    </div>
                    <span className="text-xs font-medium text-zinc-700 shrink-0">Sign In →</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ==================== AUTHENTICATED STAFF WORKSPACE ====================
  const allowedModules = ROLE_ALLOWED_MODULES[staffUser.role] || ['waiter'];
  const unreadCount = notifications.filter((n) => !n.is_read).length;

  const navItems: Array<{ id: StaffModule; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { id: 'admin', label: 'Admin Console', icon: LayoutDashboard },
    { id: 'kitchen', label: 'Kitchen KDS', icon: ChefHat },
    { id: 'counter', label: 'Counter POS', icon: CreditCard },
    { id: 'waiter', label: 'Waiter Service', icon: Utensils },
    { id: 'qa', label: 'Automated QA Lab', icon: ShieldCheck },
  ].filter((n) => allowedModules.includes(n.id as StaffModule)) as Array<{
    id: StaffModule;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
  }>;

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex flex-col lg:flex-row">
      {/* Sidebar */}
      <aside className="w-full lg:w-64 bg-[#0F172A] text-slate-200 shrink-0 flex flex-col justify-between no-print">
        <div>
          <div className="p-5 border-b border-slate-800">
            <p className="text-[11px] uppercase tracking-wider text-[#D4A359] font-semibold">Restaurant 360°</p>
            <h1 className="font-display text-xl font-semibold text-white mt-0.5">
              {restaurant?.name || 'Saffron & Ember'}
            </h1>
          </div>

          <nav className="p-3 flex lg:flex-col gap-1 overflow-x-auto">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = activeModule === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveModule(item.id)}
                  className={`flex items-center gap-2.5 px-3.5 py-2.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    active ? 'bg-[#B47B2B] text-white' : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        <div className="p-4 border-t border-slate-800 hidden lg:block space-y-3">
          <div className="flex items-center gap-2.5">
            <UserCheck className="w-4 h-4 text-[#D4A359] shrink-0" />
            <div className="min-w-0">
              <p className="text-xs font-semibold text-white truncate">{staffUser.name}</p>
              <p className="text-[11px] text-slate-400 truncate">{staffUser.role_name}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onBackToPublic}
              className="flex-1 py-1.5 text-[11px] font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded cursor-pointer"
            >
              Public Site
            </button>
            <button
              type="button"
              onClick={handleLogout}
              className="flex-1 py-1.5 text-[11px] font-medium bg-slate-800 hover:bg-red-900/60 text-slate-200 rounded inline-flex items-center justify-center gap-1 cursor-pointer"
            >
              <LogOut className="w-3 h-3" /> Sign Out
            </button>
          </div>
        </div>
      </aside>

      {/* Main Workspace Viewport */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 bg-white border-b border-zinc-200 px-4 sm:px-6 flex items-center justify-between gap-4 no-print">
          <div className="text-xs text-zinc-500">
            Operations / <strong className="text-zinc-900 capitalize">{activeModule}</strong>
          </div>

          <div className="flex items-center gap-3">
            <div className="relative">
              <button
                type="button"
                onClick={() => setNotifOpen(!notifOpen)}
                className="relative p-2 text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 rounded-md cursor-pointer"
                aria-label="Notifications"
              >
                <Bell className="w-4 h-4" />
                {unreadCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 px-1.5 min-w-4 h-4 bg-red-600 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                    {unreadCount}
                  </span>
                )}
              </button>

              {notifOpen && (
                <div className="absolute right-0 mt-2 w-80 bg-white border border-zinc-200 rounded-xl shadow-xl z-40 overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-zinc-100 flex items-center justify-between">
                    <span className="text-xs font-semibold text-zinc-900">Notifications</span>
                    <button
                      type="button"
                      onClick={markNotificationsRead}
                      className="text-[11px] text-[#B47B2B] hover:underline cursor-pointer"
                    >
                      Mark all read
                    </button>
                  </div>
                  <div className="max-h-72 overflow-y-auto divide-y divide-zinc-100">
                    {notifications.length === 0 ? (
                      <p className="p-4 text-xs text-zinc-500 text-center">No notifications</p>
                    ) : (
                      notifications.map((n) => (
                        <div key={n.id} className={`p-3 text-xs ${n.is_read ? 'bg-white' : 'bg-amber-50/40'}`}>
                          <p className="font-semibold text-zinc-900">{n.title}</p>
                          <p className="text-zinc-600 mt-0.5">{n.message}</p>
                          <p className="text-[10px] text-zinc-400 mt-1">{formatDateTimeIST(n.created_at)}</p>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={handleLogout}
              className="lg:hidden px-3 py-1.5 text-xs font-medium bg-zinc-100 rounded-md"
            >
              Sign Out
            </button>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto">
          {activeModule === 'admin' && (
            <AdminDashboard
              staffToken={staffToken}
              userRole={staffUser.role}
              restaurant={restaurant}
              categories={categories}
              items={items}
              onMenuChanged={onMenuChanged}
              onOpenQrUrl={onOpenQrUrl}
            />
          )}
          {activeModule === 'kitchen' && <KitchenDashboard staffToken={staffToken} />}
          {activeModule === 'counter' && <CounterPosDashboard staffToken={staffToken} restaurant={restaurant} />}
          {activeModule === 'waiter' && <WaiterDashboard staffToken={staffToken} />}
          {activeModule === 'qa' && <QADashboard staffToken={staffToken} />}
        </main>
      </div>
    </div>
  );
}
