import React, { useCallback, useEffect, useState } from 'react';
import { QrCode, X } from 'lucide-react';
import type { MenuCategory, MenuItem, RestaurantInfo } from './types.ts';
import { useRealtimeRoom } from './lib/ws.ts';
import { PublicFooter, PublicNavbar, type PublicPageSlug } from './components/ui.tsx';
import { PublicWebsite } from './pages/PublicWebsite.tsx';
import { CustomerOrderPortal } from './pages/CustomerOrderPortal.tsx';
import { StaffPortal } from './pages/StaffPortal.tsx';

type AppRouteMode = 'public' | 'order' | 'staff';

function detectInitialRoute(): AppRouteMode {
  const path = window.location.pathname;
  if (path.startsWith('/order')) return 'order';
  if (path.startsWith('/staff') || path.startsWith('/admin') || path.startsWith('/kitchen') || path.startsWith('/pos') || path.startsWith('/qa')) {
    return 'staff';
  }
  return 'public';
}

export default function App() {
  const [routeMode, setRouteMode] = useState<AppRouteMode>(detectInitialRoute);
  const [publicPage, setPublicPage] = useState<PublicPageSlug>('home');
  const [restaurant, setRestaurant] = useState<RestaurantInfo | null>(null);
  const [categories, setCategories] = useState<MenuCategory[]>([]);
  const [items, setItems] = useState<MenuItem[]>([]);
  const [qrGuideOpen, setQrGuideOpen] = useState(false);

  const loadPublicCatalog = useCallback(async () => {
    try {
      const [rRes, mRes] = await Promise.all([fetch('/api/restaurant'), fetch('/api/menu')]);
      if (rRes.ok) setRestaurant(await rRes.json());
      if (mRes.ok) {
        const md = await mRes.json();
        setCategories(md.categories || []);
        setItems(md.items || []);
      }
    } catch {
      // Ignore transient network errors
    }
  }, []);

  useEffect(() => {
    loadPublicCatalog();
  }, [loadPublicCatalog]);

  // Listen to browser back/forward navigation
  useEffect(() => {
    const onPop = () => setRouteMode(detectInitialRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Realtime sync for menu & settings updates across public website and QR menus
  useRealtimeRoom({
    room: 'public:menu',
    onEvent: (evt) => {
      if (evt === 'menu:updated') {
        loadPublicCatalog();
      }
    },
  });

  function navigateToStaff() {
    window.history.pushState({}, '', '/staff');
    setRouteMode('staff');
    window.scrollTo({ top: 0 });
  }

  function navigateToPublic(page: PublicPageSlug = 'home') {
    window.history.pushState({}, '', '/');
    setPublicPage(page);
    setRouteMode('public');
    window.scrollTo({ top: 0 });
  }

  function openQrRelativeUrl(relativeUrl: string) {
    window.history.pushState({}, '', relativeUrl);
    setRouteMode('order');
    window.scrollTo({ top: 0 });
  }

  if (routeMode === 'order') {
    return (
      <CustomerOrderPortal
        restaurant={restaurant}
        categories={categories}
        items={items}
        onExitToSite={() => navigateToPublic('home')}
      />
    );
  }

  if (routeMode === 'staff') {
    return (
      <StaffPortal
        restaurant={restaurant}
        categories={categories}
        items={items}
        onMenuChanged={loadPublicCatalog}
        onBackToPublic={() => navigateToPublic('home')}
        onOpenQrUrl={openQrRelativeUrl}
      />
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#FAF8F5] text-[#18181B]">
      <PublicNavbar
        restaurantName={restaurant?.name || 'Saffron & Ember'}
        activePage={publicPage}
        onNavigate={setPublicPage}
      />

      <main className="flex-1">
        <PublicWebsite
          page={publicPage}
          restaurant={restaurant}
          categories={categories}
          items={items}
          onNavigate={setPublicPage}
          onOpenStaff={navigateToStaff}
        />
      </main>

      <PublicFooter
        restaurant={restaurant}
        onNavigate={(p) => {
          setPublicPage(p);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }}
        onOpenStaff={navigateToStaff}
        onOpenQuickTableQr={() => setQrGuideOpen(true)}
      />

      {qrGuideOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white rounded-xl p-6 space-y-4 shadow-xl">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <QrCode className="w-5 h-5 text-[#B47B2B]" />
                <h3 className="font-semibold text-base text-[#18181B]">How Table QR Ordering Works</h3>
              </div>
              <button type="button" onClick={() => setQrGuideOpen(false)} className="text-zinc-500">
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-sm text-zinc-600 leading-relaxed">
              Every table has a cryptographically signed QR URL (<span className="font-mono text-xs">/order?table=2&amp;token=...</span>). Modifying the table number without a valid token is blocked by the server.
            </p>
            <p className="text-sm text-zinc-600 leading-relaxed">
              To test scanning any of the 10 table QR codes right now, open the <strong>Staff Portal → Admin Console → Tables &amp; QR Codes</strong> and click <strong>Open QR</strong> on any table.
            </p>
            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={() => setQrGuideOpen(false)}
                className="flex-1 py-2 text-xs font-medium bg-zinc-100 rounded-md"
              >
                Close
              </button>
              <button
                type="button"
                onClick={() => {
                  setQrGuideOpen(false);
                  navigateToStaff();
                }}
                className="flex-1 py-2 text-xs font-semibold bg-[#18181B] text-white rounded-md hover:bg-[#B47B2B]"
              >
                Open Staff QR Directory
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
