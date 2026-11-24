import React, { useState } from 'react';
import { Menu, X, UtensilsCrossed } from 'lucide-react';

export function SafeImage({
  src,
  alt,
  className = '',
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (failed || !src) {
    return (
      <div
        className={`flex flex-col items-center justify-center bg-gradient-to-br from-[#27272A] to-[#18181B] text-[#D4A359] p-4 text-center ${className}`}
      >
        <UtensilsCrossed className="w-7 h-7 mb-2 opacity-80" />
        <span className="text-xs font-medium text-[#FAF8F5]/80 line-clamp-2">{alt}</span>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={className}
    />
  );
}

export function VegIndicator({ isVeg }: { isVeg: boolean | number }) {
  const veg = Boolean(isVeg);
  return (
    <span
      title={veg ? 'Vegetarian' : 'Non-Vegetarian'}
      aria-label={veg ? 'Vegetarian' : 'Non-Vegetarian'}
      className={`inline-flex items-center justify-center w-4 h-4 border shrink-0 ${
        veg ? 'border-emerald-700' : 'border-red-700'
      }`}
    >
      <span
        className={`w-2 h-2 rounded-full ${veg ? 'bg-emerald-700' : 'bg-red-700'}`}
      />
    </span>
  );
}

export function StatusLabel({
  status,
  className = '',
}: {
  status: string;
  className?: string;
}) {
  const map: Record<string, { label: string; color: string }> = {
    placed: { label: 'Order Placed', color: 'text-amber-700 bg-amber-50 border-amber-200' },
    accepted: { label: 'Accepted', color: 'text-sky-700 bg-sky-50 border-sky-200' },
    new: { label: 'New Ticket', color: 'text-amber-700 bg-amber-50 border-amber-200' },
    processing: { label: 'Preparing', color: 'text-orange-700 bg-orange-50 border-orange-200' },
    preparing: { label: 'Preparing', color: 'text-orange-700 bg-orange-50 border-orange-200' },
    ready: { label: 'Ready to Serve', color: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
    served: { label: 'Served', color: 'text-teal-700 bg-teal-50 border-teal-200' },
    completed: { label: 'Completed', color: 'text-zinc-700 bg-zinc-100 border-zinc-200' },
    rejected: { label: 'Rejected', color: 'text-red-700 bg-red-50 border-red-200' },
    cancelled: { label: 'Cancelled', color: 'text-red-700 bg-red-50 border-red-200' },
    paid: { label: 'Paid', color: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
    captured: { label: 'Paid', color: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
    pending: { label: 'Pending', color: 'text-amber-700 bg-amber-50 border-amber-200' },
    failed: { label: 'Failed', color: 'text-red-700 bg-red-50 border-red-200' },
    refunded: { label: 'Refunded', color: 'text-zinc-700 bg-zinc-100 border-zinc-200' },
    available: { label: 'Available', color: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
    occupied: { label: 'Occupied', color: 'text-amber-800 bg-amber-50 border-amber-200' },
    reserved: { label: 'Reserved', color: 'text-sky-700 bg-sky-50 border-sky-200' },
    confirmed: { label: 'Confirmed', color: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
    seated: { label: 'Seated', color: 'text-zinc-700 bg-zinc-100 border-zinc-200' },
  };

  const info = map[status.toLowerCase()] || {
    label: status,
    color: 'text-zinc-700 bg-zinc-100 border-zinc-200',
  };

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-xs font-medium border rounded ${info.color} whitespace-nowrap ${className}`}
    >
      {info.label}
    </span>
  );
}

export function ConfirmModal({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  destructive = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
      <div className="w-full max-w-md bg-white border border-zinc-200 rounded-lg p-6 shadow-xl">
        <h3 className="text-lg font-semibold text-zinc-900">{title}</h3>
        <p className="mt-2 text-sm text-zinc-600 leading-relaxed">{message}</p>
        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-zinc-700 bg-zinc-100 hover:bg-zinc-200 rounded-md transition-colors whitespace-nowrap"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`px-4 py-2 text-sm font-medium text-white rounded-md transition-colors whitespace-nowrap ${
              destructive ? 'bg-red-600 hover:bg-red-700' : 'bg-[#18181B] hover:bg-zinc-800'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export type PublicPageSlug = 'home' | 'menu' | 'about' | 'gallery' | 'reservations' | 'contact';

export function PublicNavbar({
  restaurantName,
  activePage,
  onNavigate,
}: {
  restaurantName: string;
  activePage: PublicPageSlug;
  onNavigate: (page: PublicPageSlug) => void;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);

  const navItems: Array<{ slug: PublicPageSlug; label: string }> = [
    { slug: 'menu', label: 'Menu' },
    { slug: 'about', label: 'About' },
    { slug: 'gallery', label: 'Gallery' },
    { slug: 'reservations', label: 'Reservations' },
    { slug: 'contact', label: 'Contact' },
  ];

  const handleNav = (slug: PublicPageSlug) => {
    onNavigate(slug);
    setMobileOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <header className="sticky top-0 z-40 bg-[#FAF8F5]/95 backdrop-blur-sm border-b border-zinc-200/80">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-8">
        {/* Zone 1: Single-line Brand Wordmark */}
        <button
          type="button"
          onClick={() => handleNav('home')}
          className="font-display text-2xl font-semibold tracking-tight text-[#18181B] whitespace-nowrap shrink-0 cursor-pointer"
        >
          {restaurantName}
        </button>

        {/* Zone 2: 5 Single-Line Navigation Links */}
        <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-zinc-600">
          {navItems.map((item) => (
            <button
              key={item.slug}
              type="button"
              onClick={() => handleNav(item.slug)}
              className={`whitespace-nowrap shrink-0 pb-0.5 transition-colors cursor-pointer border-b-2 ${
                activePage === item.slug
                  ? 'text-[#18181B] border-[#B47B2B]'
                  : 'border-transparent hover:text-[#18181B]'
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>

        {/* Zone 3: Single Primary Action */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => handleNav('reservations')}
            className="hidden sm:inline-flex items-center px-5 py-2.5 text-sm font-medium bg-[#18181B] text-[#FAF8F5] hover:bg-[#B47B2B] transition-colors rounded-md whitespace-nowrap shrink-0 cursor-pointer"
          >
            Book a Table
          </button>
          <button
            type="button"
            aria-label="Toggle Menu"
            onClick={() => setMobileOpen(!mobileOpen)}
            className="md:hidden p-2 text-zinc-800 hover:bg-zinc-200/60 rounded-md"
          >
            {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {mobileOpen && (
        <div className="md:hidden border-t border-zinc-200 bg-[#FAF8F5] px-4 py-4 space-y-2">
          {navItems.map((item) => (
            <button
              key={item.slug}
              type="button"
              onClick={() => handleNav(item.slug)}
              className={`block w-full text-left px-3 py-2.5 text-sm font-medium rounded-md ${
                activePage === item.slug ? 'bg-[#18181B] text-white' : 'text-zinc-800 hover:bg-zinc-200/60'
              }`}
            >
              {item.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => handleNav('reservations')}
            className="w-full mt-2 px-4 py-2.5 text-sm font-medium bg-[#B47B2B] text-white rounded-md"
          >
            Book a Table
          </button>
        </div>
      )}
    </header>
  );
}

export function PublicFooter({
  restaurant,
  onNavigate,
  onOpenStaff,
  onOpenQuickTableQr,
}: {
  restaurant: {
    name: string;
    tagline: string;
    address: string;
    phone: string;
    email: string;
    opening_hours: Record<string, string>;
  } | null;
  onNavigate: (page: PublicPageSlug) => void;
  onOpenStaff: () => void;
  onOpenQuickTableQr: () => void;
}) {
  return (
    <footer className="bg-[#18181B] text-[#FAF8F5] border-t border-zinc-800">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-14 grid grid-cols-1 md:grid-cols-4 gap-10">
        <div>
          <h3 className="font-display text-2xl font-semibold text-white">
            {restaurant?.name || 'FoodMitra'}
          </h3>
          <p className="mt-3 text-sm text-zinc-400 leading-relaxed">
            {restaurant?.tagline || 'Wood-Fired Indian Heritage, Served Table-Side.'}
          </p>
          <p className="mt-4 text-xs text-zinc-500">
            Powered by Restaurant 360° Hospitality Platform
          </p>
        </div>

        <div>
          <h4 className="text-sm font-semibold text-white mb-3">Explore</h4>
          <ul className="space-y-2 text-sm text-zinc-400">
            <li><button type="button" onClick={() => onNavigate('menu')} className="hover:text-[#D4A359] transition-colors">Digital Menu</button></li>
            <li><button type="button" onClick={() => onNavigate('about')} className="hover:text-[#D4A359] transition-colors">Our Story &amp; Chef</button></li>
            <li><button type="button" onClick={() => onNavigate('gallery')} className="hover:text-[#D4A359] transition-colors">Ambience Gallery</button></li>
            <li><button type="button" onClick={() => onNavigate('reservations')} className="hover:text-[#D4A359] transition-colors">Table Reservations</button></li>
            <li><button type="button" onClick={() => onNavigate('contact')} className="hover:text-[#D4A359] transition-colors">Contact &amp; Location</button></li>
          </ul>
        </div>

        <div>
          <h4 className="text-sm font-semibold text-white mb-3">Hours &amp; Location</h4>
          <p className="text-sm text-zinc-400 leading-relaxed">
            {restaurant?.address || '14 Pali Hill Courtyard, Bandra West, Mumbai 400050'}
          </p>
          <p className="mt-3 text-sm text-zinc-300">
            Lunch: {restaurant?.opening_hours?.lunch || '12:00 PM – 3:30 PM'}
          </p>
          <p className="text-sm text-zinc-300">
            Dinner: {restaurant?.opening_hours?.dinner || '6:30 PM – 11:45 PM'}
          </p>
          <p className="mt-2 text-sm text-[#D4A359]">{restaurant?.phone || '+91 22 4890 3600'}</p>
        </div>

        <div>
          <h4 className="text-sm font-semibold text-white mb-3">Operations &amp; Table QR</h4>
          <p className="text-sm text-zinc-400 mb-4 leading-relaxed">
            Seated guests scan their table plaque for instant ordering, payment, and live kitchen tracking.
          </p>
          <div className="flex flex-col gap-2.5 items-start">
            <button
              type="button"
              onClick={onOpenStaff}
              className="px-4 py-2 text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700 rounded-md transition-colors whitespace-nowrap"
            >
              Staff &amp; Operations Portal
            </button>
            <button
              type="button"
              onClick={onOpenQuickTableQr}
              className="text-xs text-[#D4A359] hover:underline whitespace-nowrap"
            >
              View QR Ordering Guide
            </button>
          </div>
        </div>
      </div>
      <div className="border-t border-zinc-800/80 py-5 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-zinc-500">
        <span>© {new Date().getFullYear()} {restaurant?.name || 'FoodMitra'}. All rights reserved.</span>
        <span>GST Compliant · Instant QR Dining · Verified Online Payments</span>
      </div>
    </footer>
  );
}
