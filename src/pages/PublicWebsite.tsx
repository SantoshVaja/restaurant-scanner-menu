import React, { useMemo, useState } from 'react';
import {
  ArrowRight,
  Calendar,
  CheckCircle2,
  Clock,
  MapPin,
  Phone,
  Mail,
  QrCode,
  Search,
  SlidersHorizontal,
  Star,
  Users,
  X,
} from 'lucide-react';
import type { MenuCategory, MenuItem, RestaurantInfo } from '../types.ts';
import { apiFetch, parseJsonSafe } from '../lib/api.ts';
import { formatINR } from '../lib/format.ts';
import { SafeImage, VegIndicator, type PublicPageSlug } from '../components/ui.tsx';

const HERO_IMG = '/src/assets/images/hero_dining_room_1795504316972.jpg';
const CHEF_IMG = '/src/assets/images/chef_signature_portrait_1795504318596.jpg';
const GALLERY_IMAGES = [
  { src: '/src/assets/images/hero_dining_room_1795504316972.jpg', title: 'Main Dining Room & Open Tandoor', category: 'Ambience' },
  { src: '/src/assets/images/chef_signature_portrait_1795504318596.jpg', title: 'Executive Chef Vikram Singh at the Pass', category: 'Kitchen' },
  { src: '/src/assets/images/dish_paneer_tikka_1795504318614.jpg', title: 'Charcoal Tandoori Paneer Tikka', category: 'Starters' },
  { src: '/src/assets/images/dish_indian_curries_1795504318494.jpg', title: 'Copper Handi Makhani & Blistered Naan', category: 'Main Course' },
  { src: '/src/assets/images/dish_dum_biryani_1795504319695.jpg', title: 'Earthen Pot Subz Dum Biryani', category: 'Biryani' },
  { src: '/src/assets/images/dish_indo_chinese_1795504319795.jpg', title: 'High-Flame Wok Hakka & Chilli Paneer', category: 'Wok' },
  { src: '/src/assets/images/dish_gulab_jamun_1795504319193.jpg', title: 'Saffron Cardamom Gulab Jamun', category: 'Desserts' },
  { src: '/src/assets/images/dish_craft_beverages_1795504321083.jpg', title: 'Craft Cold Coffee, Masala Chaas & Lime Cooler', category: 'Beverages' },
];

export function PublicWebsite({
  page,
  restaurant,
  categories,
  items,
  onNavigate,
  onOpenStaff,
}: {
  page: PublicPageSlug;
  restaurant: RestaurantInfo | null;
  categories: MenuCategory[];
  items: MenuItem[];
  onNavigate: (p: PublicPageSlug) => void;
  onOpenStaff: () => void;
}) {
  // Menu State
  const [search, setSearch] = useState('');
  const [selectedCat, setSelectedCat] = useState<number | 'all'>('all');
  const [vegFilter, setVegFilter] = useState<'all' | 'veg' | 'nonveg'>('all');
  const [bestsellerOnly, setBestsellerOnly] = useState(false);
  const [sortBy, setSortBy] = useState<'recommended' | 'price_asc' | 'price_desc'>('recommended');
  const [inspectItem, setInspectItem] = useState<MenuItem | null>(null);
  const [qrNoticeItem, setQrNoticeItem] = useState<MenuItem | null>(null);

  // Gallery Lightbox
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);

  // Reservation Form
  const [resForm, setResForm] = useState({
    customer_name: '',
    customer_email: '',
    customer_phone: '',
    reservation_date: new Date().toISOString().slice(0, 10),
    reservation_time: '19:30',
    guest_count: 4,
    special_requests: '',
  });
  const [resSubmitting, setResSubmitting] = useState(false);
  const [resResult, setResResult] = useState<{ code: string; message: string } | null>(null);
  const [resError, setResError] = useState<string | null>(null);

  // Contact Form
  const [contactForm, setContactForm] = useState({ name: '', email: '', phone: '', message: '' });
  const [contactSubmitting, setContactSubmitting] = useState(false);
  const [contactSuccess, setContactSuccess] = useState<string | null>(null);
  const [contactError, setContactError] = useState<string | null>(null);

  const featuredDishes = useMemo(
    () => items.filter((i) => i.is_bestseller === 1 && i.is_available === 1).slice(0, 6),
    [items]
  );

  const filteredMenu = useMemo(() => {
    let list = [...items];
    if (selectedCat !== 'all') {
      list = list.filter((i) => i.category_id === selectedCat);
    }
    if (vegFilter === 'veg') list = list.filter((i) => i.is_veg === 1);
    if (vegFilter === 'nonveg') list = list.filter((i) => i.is_veg === 0);
    if (bestsellerOnly) list = list.filter((i) => i.is_bestseller === 1);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          i.description.toLowerCase().includes(q) ||
          (i.category_name || '').toLowerCase().includes(q)
      );
    }
    if (sortBy === 'price_asc') list.sort((a, b) => a.price_paise - b.price_paise);
    if (sortBy === 'price_desc') list.sort((a, b) => b.price_paise - a.price_paise);
    return list;
  }, [items, selectedCat, vegFilter, bestsellerOnly, search, sortBy]);

  async function submitReservation(e: React.FormEvent) {
    e.preventDefault();
    setResSubmitting(true);
    setResError(null);
    setResResult(null);
    try {
      const resp = await apiFetch('/api/reservations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(resForm),
      });
      const data = await parseJsonSafe<{ reservation_code: string; message: string; error?: string }>(resp);
      if (!resp.ok) throw new Error(data.error || 'Could not submit reservation');
      setResResult({ code: data.reservation_code, message: data.message });
    } catch (err: unknown) {
      setResError(err instanceof Error ? err.message : 'Reservation failed');
    } finally {
      setResSubmitting(false);
    }
  }

  async function submitContact(e: React.FormEvent) {
    e.preventDefault();
    setContactSubmitting(true);
    setContactError(null);
    setContactSuccess(null);
    try {
      const resp = await apiFetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(contactForm),
      });
      const data = await parseJsonSafe<{ message: string; error?: string }>(resp);
      if (!resp.ok) throw new Error(data.error || 'Could not send message');
      setContactSuccess(data.message);
      setContactForm({ name: '', email: '', phone: '', message: '' });
    } catch (err: unknown) {
      setContactError(err instanceof Error ? err.message : 'Message failed');
    } finally {
      setContactSubmitting(false);
    }
  }

  // ==================== HOME PAGE ====================
  if (page === 'home') {
    return (
      <div>
        {/* Hero Split */}
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-8 pb-16 lg:pt-12 lg:pb-24">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-stretch">
            <div className="lg:col-span-5 flex flex-col justify-center py-4">
              <p className="text-xs font-medium tracking-wider uppercase text-[#B47B2B]">
                Bandra West · Mumbai
              </p>
              <h1 className="mt-4 font-display text-4xl sm:text-5xl lg:text-6xl font-semibold tracking-tight text-[#18181B] leading-[1.06] text-balance">
                {restaurant?.tagline || 'Wood-Fired Indian Heritage, Served Table-Side'}
              </h1>
              <p className="mt-5 text-base text-zinc-600 leading-relaxed max-w-lg">
                {restaurant?.description ||
                  'An intimate modern Indian dining room celebrating charcoal tandoor craft, slow-simmered copper-handi gravies, and seamless QR table service.'}
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-4">
                <button
                  type="button"
                  onClick={() => onNavigate('menu')}
                  className="inline-flex items-center gap-2 px-6 py-3 text-sm font-medium bg-[#18181B] text-[#FAF8F5] hover:bg-[#B47B2B] transition-colors rounded-md whitespace-nowrap cursor-pointer"
                >
                  Explore Menu
                  <ArrowRight className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => onNavigate('reservations')}
                  className="inline-flex items-center gap-2 px-6 py-3 text-sm font-medium border border-zinc-300 text-[#18181B] hover:border-[#18181B] bg-white transition-colors rounded-md whitespace-nowrap cursor-pointer"
                >
                  Book a Table
                </button>
              </div>

              <div className="mt-10 pt-6 border-t border-zinc-200 flex flex-wrap gap-x-6 gap-y-2 text-xs text-zinc-500">
                <span>Lunch 12:00 PM – 3:30 PM</span>
                <span aria-hidden="true">·</span>
                <span>Dinner 6:30 PM – 11:45 PM</span>
                <span aria-hidden="true">·</span>
                <span>10 Private &amp; Courtyard Tables</span>
              </div>
            </div>

            <div className="lg:col-span-7">
              <div className="relative h-80 sm:h-[460px] lg:h-full min-h-[420px] rounded-xl overflow-hidden bg-zinc-900">
                <SafeImage
                  src={HERO_IMG}
                  alt="FoodMitra evening dining room"
                  className="w-full h-full object-cover"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/15 to-transparent flex items-end p-6 sm:p-8">
                  <div className="text-white max-w-md">
                    <p className="text-xs text-[#D4A359] font-medium">Table-Side QR Dining</p>
                    <p className="mt-1 text-sm text-zinc-200 leading-relaxed">
                      Scan the brass QR plaque at your table to customize dishes, order multiple rounds, pay via UPI or Card, and watch kitchen preparation live.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Featured Signature Dishes */}
        <section className="bg-white border-y border-zinc-200/80 py-16 lg:py-20">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-10">
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-[#B47B2B]">From the Tandoor &amp; Handi</p>
                <h2 className="mt-2 font-display text-3xl sm:text-4xl font-semibold text-[#18181B]">
                  House Bestsellers
                </h2>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('menu')}
                className="inline-flex items-center gap-1.5 text-sm font-medium text-[#18181B] hover:text-[#B47B2B] transition-colors whitespace-nowrap cursor-pointer"
              >
                View Full 37-Dish Menu
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-7">
              {featuredDishes.map((dish) => (
                <div
                  key={dish.id}
                  onClick={() => setInspectItem(dish)}
                  className="group bg-[#FAF8F5] border border-zinc-200/90 rounded-lg overflow-hidden hover:-translate-y-0.5 hover:shadow-md transition-all cursor-pointer flex flex-col"
                >
                  <div className="aspect-[4/3] overflow-hidden bg-zinc-200">
                    <SafeImage
                      src={dish.image_url}
                      alt={dish.name}
                      className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-300"
                    />
                  </div>
                  <div className="p-5 flex-1 flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-between gap-2 text-xs text-zinc-500">
                        <span className="truncate">{dish.category_name}</span>
                        <span>Bestseller</span>
                      </div>
                      <div className="mt-1.5 flex items-center gap-2">
                        <VegIndicator isVeg={dish.is_veg} />
                        <h3 className="text-base font-semibold text-[#18181B]">{dish.name}</h3>
                      </div>
                      <p className="mt-2 text-sm text-zinc-600 line-clamp-2 leading-relaxed">{dish.description}</p>
                    </div>
                    <div className="mt-4 pt-3 border-t border-zinc-200/70 flex items-center justify-between text-sm">
                      <span className="font-semibold text-[#18181B] tabular-nums">{formatINR(dish.price_paise)}</span>
                      <span className="text-xs text-zinc-500">{dish.prep_time_mins} mins prep</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Culinary Craft & Chef Story + Special Offers */}
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 lg:py-24">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
            <div className="lg:col-span-5">
              <div className="aspect-[3/4] rounded-xl overflow-hidden bg-zinc-900">
                <SafeImage src={CHEF_IMG} alt="Executive Chef Vikram Singh" className="w-full h-full object-cover" />
              </div>
            </div>
            <div className="lg:col-span-7">
              <p className="text-xs font-medium uppercase tracking-wider text-[#B47B2B]">Our Philosophy</p>
              <h2 className="mt-2 font-display text-3xl sm:text-4xl font-semibold text-[#18181B] leading-tight text-balance">
                24-Hour Simmered Lentils, Hand-Pounded Spices &amp; Effortless Hospitality
              </h2>
              <p className="mt-5 text-base text-zinc-600 leading-relaxed">
                Led by Executive Chef Vikram Singh, every dish at FoodMitra begins with whole spices roasted daily and stone-ground in small batches. Our copper handis and white-oak clay tandoors honor North-West Frontier technique while embracing modern table-side convenience.
              </p>

              <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-6 border-t border-zinc-200 pt-8">
                <div>
                  <p className="text-sm font-semibold text-[#18181B]">Dining Offer · FOODMITRA10</p>
                  <p className="mt-1 text-sm text-zinc-600">Enjoy 10% off table orders above ₹500 when ordering via your table QR.</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-[#18181B]">Celebration Offer · FESTIVE15</p>
                  <p className="mt-1 text-sm text-zinc-600">15% privilege on group feasts above ₹1,200 across all dining rooms.</p>
                </div>
              </div>

              {/* Attributable Guest Testimonials */}
              <div className="mt-10 border-t border-zinc-200 pt-8 grid grid-cols-1 sm:grid-cols-2 gap-6">
                <div>
                  <div className="flex items-center gap-1 text-[#B47B2B] mb-2">
                    <Star className="w-4 h-4 fill-current" /><Star className="w-4 h-4 fill-current" /><Star className="w-4 h-4 fill-current" /><Star className="w-4 h-4 fill-current" /><Star className="w-4 h-4 fill-current" />
                  </div>
                  <p className="text-sm text-zinc-700 leading-relaxed">
                    "We ordered starters first via the Table 04 QR, tracked our naan and dal live, and added biryani mid-meal without waving down anyone. Best dining flow in Bandra."
                  </p>
                  <p className="mt-2 text-xs text-zinc-500">Rhea Menon · Design Director, Studio Malabar</p>
                </div>
                <div>
                  <div className="flex items-center gap-1 text-[#B47B2B] mb-2">
                    <Star className="w-4 h-4 fill-current" /><Star className="w-4 h-4 fill-current" /><Star className="w-4 h-4 fill-current" /><Star className="w-4 h-4 fill-current" /><Star className="w-4 h-4 fill-current" />
                  </div>
                  <p className="text-sm text-zinc-700 leading-relaxed">
                    "The Paneer Tikka char and 24-hour Dal Makhani are extraordinary, and getting one consolidated GST invoice after three rounds at the table made splitting effortless."
                  </p>
                  <p className="mt-2 text-xs text-zinc-500">Karthik Iyer · Partner, Crest Capital Mumbai</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Quick Operations & QR Demo Banner */}
        <section className="bg-[#F2EFE9] border-t border-zinc-200 py-14">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
            <div>
              <h3 className="font-display text-2xl sm:text-3xl font-semibold text-[#18181B]">
                Dining In Tonight or Managing Service?
              </h3>
              <p className="mt-2 text-sm text-zinc-600 max-w-2xl">
                Reserve your table online in seconds, or enter the Staff Operations Suite to generate live Table QR codes, view the Kitchen Display System, Counter POS, Admin Console, and Automated QA Lab.
              </p>
            </div>
            <div className="flex flex-wrap gap-3 shrink-0">
              <button
                type="button"
                onClick={() => onNavigate('reservations')}
                className="px-5 py-2.5 text-sm font-medium bg-[#18181B] text-white hover:bg-[#B47B2B] rounded-md transition-colors whitespace-nowrap cursor-pointer"
              >
                Reserve a Table
              </button>
              <button
                type="button"
                onClick={onOpenStaff}
                className="px-5 py-2.5 text-sm font-medium bg-white border border-zinc-300 text-[#18181B] hover:border-[#18181B] rounded-md transition-colors whitespace-nowrap cursor-pointer"
              >
                Open Staff Portal
              </button>
            </div>
          </div>
        </section>
      </div>
    );
  }

  // ==================== MENU PAGE ====================
  if (page === 'menu') {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-8 border-b border-zinc-200">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-[#B47B2B]">Curated Offerings</p>
            <h1 className="mt-2 font-display text-4xl font-semibold text-[#18181B]">Culinary Menu</h1>
            <p className="mt-2 text-sm text-zinc-600">
              All prices in INR · Exclusive of 5% GST &amp; 5% service charge. Scan your table QR plaque to order directly.
            </p>
          </div>
          <div className="relative w-full md:w-80">
            <Search className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search paneer, biryani, naan..."
              className="w-full pl-9 pr-4 py-2.5 text-sm bg-white border border-zinc-300 rounded-md focus:outline-none focus:border-[#B47B2B]"
            />
          </div>
        </div>

        {/* Category & Dietary Filter Bar */}
        <div className="py-6 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="flex items-center gap-2 overflow-x-auto pb-2 lg:pb-0">
            <button
              type="button"
              onClick={() => setSelectedCat('all')}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-md whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                selectedCat === 'all' ? 'bg-[#18181B] text-white' : 'bg-white border border-zinc-200 text-zinc-700 hover:border-zinc-400'
              }`}
            >
              All Categories ({items.length})
            </button>
            {categories.map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => setSelectedCat(cat.id)}
                className={`px-3.5 py-1.5 text-xs font-medium rounded-md whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                  selectedCat === cat.id ? 'bg-[#18181B] text-white' : 'bg-white border border-zinc-200 text-zinc-700 hover:border-zinc-400'
                }`}
              >
                {cat.name}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <div className="inline-flex bg-white border border-zinc-200 rounded-md p-0.5">
              {(['all', 'veg', 'nonveg'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setVegFilter(v)}
                  className={`px-3 py-1 text-xs font-medium rounded transition-colors cursor-pointer whitespace-nowrap ${
                    vegFilter === v ? 'bg-[#18181B] text-white' : 'text-zinc-600 hover:text-zinc-900'
                  }`}
                >
                  {v === 'all' ? 'All' : v === 'veg' ? 'Veg Only' : 'Non-Veg'}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setBestsellerOnly(!bestsellerOnly)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors cursor-pointer whitespace-nowrap ${
                bestsellerOnly ? 'bg-[#B47B2B] text-white border-[#B47B2B]' : 'bg-white border-zinc-200 text-zinc-700'
              }`}
            >
              Bestsellers
            </button>
            <div className="inline-flex items-center gap-1.5 bg-white border border-zinc-200 rounded-md px-2.5 py-1">
              <SlidersHorizontal className="w-3.5 h-3.5 text-zinc-500" />
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                className="text-xs font-medium text-zinc-700 bg-transparent focus:outline-none"
              >
                <option value="recommended">Recommended</option>
                <option value="price_asc">Price: Low to High</option>
                <option value="price_desc">Price: High to Low</option>
              </select>
            </div>
          </div>
        </div>

        {/* Dish Grid */}
        {filteredMenu.length === 0 ? (
          <div className="py-20 text-center bg-white border border-zinc-200 rounded-lg">
            <p className="text-base font-medium text-zinc-800">No dishes match your current filters.</p>
            <button
              type="button"
              onClick={() => {
                setSearch('');
                setSelectedCat('all');
                setVegFilter('all');
                setBestsellerOnly(false);
              }}
              className="mt-4 px-4 py-2 text-xs font-medium bg-[#18181B] text-white rounded-md"
            >
              Clear All Filters
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredMenu.map((item) => (
              <div
                key={item.id}
                className="bg-white border border-zinc-200 rounded-lg overflow-hidden flex flex-col justify-between hover:shadow-sm transition-shadow"
              >
                <div>
                  <div className="aspect-[4/3] bg-zinc-100 overflow-hidden relative">
                    <SafeImage src={item.image_url} alt={item.name} className="w-full h-full object-cover" />
                    {!item.is_available && (
                      <div className="absolute inset-0 bg-black/55 flex items-center justify-center">
                        <span className="px-3 py-1 bg-white text-zinc-900 text-xs font-semibold rounded">
                          Currently Sold Out
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="p-5">
                    <div className="flex items-center justify-between text-xs text-zinc-500">
                      <span>{item.category_name}</span>
                      <span>
                        {item.is_bestseller ? 'Bestseller · ' : ''}
                        {item.prep_time_mins} min
                      </span>
                    </div>
                    <div className="mt-1.5 flex items-center gap-2">
                      <VegIndicator isVeg={item.is_veg} />
                      <h3 className="text-base font-semibold text-[#18181B]">{item.name}</h3>
                    </div>
                    <p className="mt-2 text-sm text-zinc-600 line-clamp-2 leading-relaxed">{item.description}</p>
                  </div>
                </div>
                <div className="px-5 pb-5 pt-3 border-t border-zinc-100 flex items-center justify-between gap-3">
                  <span className="text-base font-semibold text-[#18181B] tabular-nums">
                    {formatINR(item.price_paise)}
                  </span>
                  <button
                    type="button"
                    disabled={!item.is_available}
                    onClick={() => setQrNoticeItem(item)}
                    className="px-4 py-2 text-xs font-medium bg-[#18181B] text-white hover:bg-[#B47B2B] disabled:opacity-40 rounded-md transition-colors whitespace-nowrap cursor-pointer"
                  >
                    {item.is_available ? 'Order via Table QR' : 'Unavailable'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* QR Ordering Explanation Modal */}
        {qrNoticeItem && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
            <div className="w-full max-w-md bg-white rounded-xl p-6 border border-zinc-200 shadow-xl">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-2.5">
                  <QrCode className="w-5 h-5 text-[#B47B2B]" />
                  <h3 className="text-lg font-semibold text-[#18181B]">Table QR Required to Order</h3>
                </div>
                <button type="button" onClick={() => setQrNoticeItem(null)} className="text-zinc-500 hover:text-zinc-900">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <p className="mt-3 text-sm text-zinc-600 leading-relaxed">
                To add <strong>{qrNoticeItem.name}</strong> ({formatINR(qrNoticeItem.price_paise)}) to a live table order, scan the unique QR plaque on your dining table. Each table QR automatically authenticates your table session.
              </p>
              <div className="mt-5 flex flex-col sm:flex-row gap-2.5">
                <button
                  type="button"
                  onClick={() => {
                    setQrNoticeItem(null);
                    onNavigate('reservations');
                  }}
                  className="flex-1 px-4 py-2.5 text-xs font-medium bg-[#18181B] text-white rounded-md hover:bg-[#B47B2B] transition-colors"
                >
                  Book a Table
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setQrNoticeItem(null);
                    onOpenStaff();
                  }}
                  className="flex-1 px-4 py-2.5 text-xs font-medium bg-zinc-100 text-zinc-800 rounded-md hover:bg-zinc-200 transition-colors"
                >
                  Staff QR Directory (Demo)
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Dish Inspect Modal */}
        {inspectItem && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
            <div className="w-full max-w-lg bg-white rounded-xl overflow-hidden border border-zinc-200 shadow-xl">
              <div className="aspect-[16/10] bg-zinc-100 relative">
                <SafeImage src={inspectItem.image_url} alt={inspectItem.name} className="w-full h-full object-cover" />
                <button
                  type="button"
                  onClick={() => setInspectItem(null)}
                  className="absolute top-3 right-3 p-2 bg-white/90 rounded-full text-zinc-900 hover:bg-white"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="p-6">
                <div className="flex items-center gap-2">
                  <VegIndicator isVeg={inspectItem.is_veg} />
                  <h3 className="text-xl font-semibold text-[#18181B]">{inspectItem.name}</h3>
                </div>
                <p className="mt-2 text-sm text-zinc-600 leading-relaxed">{inspectItem.description}</p>
                <p className="mt-4 text-lg font-semibold text-[#18181B] tabular-nums">{formatINR(inspectItem.price_paise)}</p>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ==================== ABOUT PAGE ====================
  if (page === 'about') {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 space-y-16">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-center">
          <div className="lg:col-span-6">
            <p className="text-xs font-medium uppercase tracking-wider text-[#B47B2B]">Our Story</p>
            <h1 className="mt-2 font-display text-4xl sm:text-5xl font-semibold text-[#18181B] leading-tight">
              Rooted in Hearth, Refined for Modern Dining
            </h1>
            <p className="mt-5 text-base text-zinc-600 leading-relaxed">
              Founded in Bandra West, FoodMitra was conceived as a tribute to slow-cooked Indian regional cuisine without the friction of traditional service delays. Every table is paired with bespoke brass QR hospitality so guests enjoy unhurried conversation alongside immediate kitchen precision.
            </p>
            <div className="mt-8 grid grid-cols-2 gap-6 border-t border-zinc-200 pt-6">
              <div>
                <h3 className="text-sm font-semibold text-[#18181B]">Our Mission</h3>
                <p className="mt-1.5 text-sm text-zinc-600">Preserve heirloom spice craft while delivering transparent, real-time table-side ordering.</p>
              </div>
              <div>
                <h3 className="text-sm font-semibold text-[#18181B]">Ingredient Sourcing</h3>
                <p className="mt-1.5 text-sm text-zinc-600">Single-origin Pampore saffron, Gir cow cultured ghee, and locally farmed organic produce.</p>
              </div>
            </div>
          </div>
          <div className="lg:col-span-6">
            <div className="aspect-[4/3] rounded-xl overflow-hidden">
              <SafeImage src={HERO_IMG} alt="FoodMitra interior" className="w-full h-full object-cover" />
            </div>
          </div>
        </div>

        <div className="bg-white border border-zinc-200 rounded-xl p-8 sm:p-10 grid grid-cols-1 md:grid-cols-12 gap-8 items-center">
          <div className="md:col-span-4 aspect-[3/4] rounded-lg overflow-hidden">
            <SafeImage src={CHEF_IMG} alt="Executive Chef Vikram Singh" className="w-full h-full object-cover" />
          </div>
          <div className="md:col-span-8">
            <p className="text-xs font-medium uppercase tracking-wider text-[#B47B2B]">Culinary Leadership</p>
            <h2 className="mt-2 font-display text-3xl font-semibold text-[#18181B]">Executive Chef Vikram Singh</h2>
            <p className="mt-4 text-sm sm:text-base text-zinc-600 leading-relaxed">
              With two decades across heritage kitchens in Jaipur, Lucknow, and Mumbai, Chef Vikram oversees both the clay tandoor line and our open spice atelier. His signature 24-hour Dal Makhani and charred Paneer Tikka are prepared fresh to order with real-time digital kitchen ticketing.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ==================== GALLERY PAGE ====================
  if (page === 'gallery') {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="pb-8 border-b border-zinc-200">
          <p className="text-xs font-medium uppercase tracking-wider text-[#B47B2B]">Visual Anthology</p>
          <h1 className="mt-2 font-display text-4xl font-semibold text-[#18181B]">Ambience &amp; Culinary Gallery</h1>
        </div>
        <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {GALLERY_IMAGES.map((img, idx) => (
            <button
              key={img.title}
              type="button"
              onClick={() => setLightboxIdx(idx)}
              className="group text-left bg-white border border-zinc-200 rounded-lg overflow-hidden hover:shadow-md transition-shadow cursor-pointer"
            >
              <div className="aspect-[4/3] overflow-hidden bg-zinc-900">
                <SafeImage
                  src={img.src}
                  alt={img.title}
                  className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-300"
                />
              </div>
              <div className="p-4">
                <p className="text-xs text-zinc-500">{img.category}</p>
                <p className="mt-1 text-sm font-semibold text-[#18181B]">{img.title}</p>
              </div>
            </button>
          ))}
        </div>

        {lightboxIdx !== null && (
          <div className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-4" onClick={() => setLightboxIdx(null)}>
            <div className="max-w-4xl w-full bg-zinc-950 rounded-xl overflow-hidden border border-zinc-800" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800 text-white">
                <span className="text-sm font-medium">{GALLERY_IMAGES[lightboxIdx].title}</span>
                <button type="button" onClick={() => setLightboxIdx(null)} className="text-zinc-400 hover:text-white">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <img
                src={GALLERY_IMAGES[lightboxIdx].src}
                alt={GALLERY_IMAGES[lightboxIdx].title}
                className="w-full max-h-[75vh] object-contain bg-black"
              />
            </div>
          </div>
        )}
      </div>
    );
  }

  // ==================== RESERVATIONS PAGE ====================
  if (page === 'reservations') {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10">
          <div className="lg:col-span-5">
            <p className="text-xs font-medium uppercase tracking-wider text-[#B47B2B]">Table Booking</p>
            <h1 className="mt-2 font-display text-4xl font-semibold text-[#18181B]">Reserve Your Table</h1>
            <p className="mt-4 text-sm text-zinc-600 leading-relaxed">
              Join us for lunch or candlelit dinner in Bandra West. Our host desk confirms bookings promptly and assigns preferred seating sections.
            </p>
            <div className="mt-8 space-y-4 text-sm text-zinc-700 border-t border-zinc-200 pt-6">
              <div className="flex items-center gap-3">
                <Clock className="w-4 h-4 text-[#B47B2B]" />
                <span>Lunch 12:00 PM – 3:30 PM · Dinner 6:30 PM – 11:45 PM</span>
              </div>
              <div className="flex items-center gap-3">
                <MapPin className="w-4 h-4 text-[#B47B2B]" />
                <span>{restaurant?.address || '14 Pali Hill Courtyard, Bandra West, Mumbai'}</span>
              </div>
              <div className="flex items-center gap-3">
                <Phone className="w-4 h-4 text-[#B47B2B]" />
                <span>{restaurant?.phone || '+91 22 4890 3600'}</span>
              </div>
            </div>
          </div>

          <div className="lg:col-span-7 bg-white border border-zinc-200 rounded-xl p-6 sm:p-8">
            {resResult ? (
              <div className="py-8 text-center">
                <CheckCircle2 className="w-12 h-12 text-emerald-600 mx-auto" />
                <h2 className="mt-4 font-display text-2xl font-semibold text-[#18181B]">Reservation Requested</h2>
                <p className="mt-2 text-sm text-zinc-600">{resResult.message}</p>
                <p className="mt-4 font-mono text-lg font-semibold text-[#B47B2B]">{resResult.code}</p>
                <button
                  type="button"
                  onClick={() => setResResult(null)}
                  className="mt-6 px-5 py-2.5 text-xs font-medium bg-[#18181B] text-white rounded-md"
                >
                  Make Another Booking
                </button>
              </div>
            ) : (
              <form onSubmit={submitReservation} className="space-y-4">
                <h2 className="text-lg font-semibold text-[#18181B]">Guest &amp; Seating Details</h2>
                {resError && <p className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded">{resError}</p>}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-zinc-700 mb-1">Full Name</label>
                    <input
                      required
                      value={resForm.customer_name}
                      onChange={(e) => setResForm({ ...resForm, customer_name: e.target.value })}
                      placeholder="Ananya Deshmukh"
                      className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-md focus:outline-none focus:border-[#B47B2B]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-zinc-700 mb-1">Phone Number</label>
                    <input
                      required
                      value={resForm.customer_phone}
                      onChange={(e) => setResForm({ ...resForm, customer_phone: e.target.value })}
                      placeholder="+91 98201 00000"
                      className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-md focus:outline-none focus:border-[#B47B2B]"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-1">Email Address</label>
                  <input
                    required
                    type="email"
                    value={resForm.customer_email}
                    onChange={(e) => setResForm({ ...resForm, customer_email: e.target.value })}
                    placeholder="guest@example.in"
                    className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-md focus:outline-none focus:border-[#B47B2B]"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-zinc-700 mb-1 flex items-center gap-1">
                      <Calendar className="w-3.5 h-3.5" /> Date
                    </label>
                    <input
                      required
                      type="date"
                      value={resForm.reservation_date}
                      onChange={(e) => setResForm({ ...resForm, reservation_date: e.target.value })}
                      className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-md focus:outline-none focus:border-[#B47B2B]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-zinc-700 mb-1 flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5" /> Time Slot
                    </label>
                    <select
                      value={resForm.reservation_time}
                      onChange={(e) => setResForm({ ...resForm, reservation_time: e.target.value })}
                      className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-md focus:outline-none focus:border-[#B47B2B]"
                    >
                      <option value="12:30">12:30 PM (Lunch)</option>
                      <option value="13:30">01:30 PM (Lunch)</option>
                      <option value="19:00">07:00 PM (Dinner)</option>
                      <option value="19:30">07:30 PM (Dinner)</option>
                      <option value="20:30">08:30 PM (Dinner)</option>
                      <option value="21:30">09:30 PM (Dinner)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-zinc-700 mb-1 flex items-center gap-1">
                      <Users className="w-3.5 h-3.5" /> Guests
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={resForm.guest_count}
                      onChange={(e) => setResForm({ ...resForm, guest_count: Number(e.target.value) })}
                      className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-md focus:outline-none focus:border-[#B47B2B]"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-1">Special Requests / Dietary Notes</label>
                  <textarea
                    rows={3}
                    value={resForm.special_requests}
                    onChange={(e) => setResForm({ ...resForm, special_requests: e.target.value })}
                    placeholder="Courtyard seating, anniversary celebration, Jain preparation..."
                    className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-md focus:outline-none focus:border-[#B47B2B]"
                  />
                </div>

                <button
                  type="submit"
                  disabled={resSubmitting}
                  className="w-full py-3 text-sm font-medium bg-[#18181B] text-white hover:bg-[#B47B2B] rounded-md transition-colors cursor-pointer disabled:opacity-60"
                >
                  {resSubmitting ? 'Submitting Request...' : 'Request Table Reservation'}
                </button>
              </form>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ==================== CONTACT PAGE ====================
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-10">
        <div className="lg:col-span-5 space-y-6">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-[#B47B2B]">Hospitality Desk</p>
            <h1 className="mt-2 font-display text-4xl font-semibold text-[#18181B]">Visit &amp; Contact Us</h1>
          </div>
          <div className="bg-white border border-zinc-200 rounded-xl p-6 space-y-4 text-sm text-zinc-700">
            <div className="flex items-start gap-3">
              <MapPin className="w-4 h-4 text-[#B47B2B] mt-0.5 shrink-0" />
              <div>
                <p className="font-semibold text-[#18181B]">Address</p>
                <p className="text-zinc-600">{restaurant?.address || '14 Pali Hill Courtyard, Bandra West, Mumbai 400050'}</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Phone className="w-4 h-4 text-[#B47B2B] mt-0.5 shrink-0" />
              <div>
                <p className="font-semibold text-[#18181B]">Concierge Line</p>
                <p className="text-zinc-600">{restaurant?.phone || '+91 22 4890 3600'}</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Mail className="w-4 h-4 text-[#B47B2B] mt-0.5 shrink-0" />
              <div>
                <p className="font-semibold text-[#18181B]">Email</p>
                <p className="text-zinc-600">{restaurant?.email || 'concierge@foodmitra.in'}</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Clock className="w-4 h-4 text-[#B47B2B] mt-0.5 shrink-0" />
              <div>
                <p className="font-semibold text-[#18181B]">Opening Hours</p>
                <p className="text-zinc-600">Lunch: {restaurant?.opening_hours?.lunch || '12:00 PM – 3:30 PM'}</p>
                <p className="text-zinc-600">Dinner: {restaurant?.opening_hours?.dinner || '6:30 PM – 11:45 PM'}</p>
              </div>
            </div>
          </div>

          <div className="bg-[#18181B] text-white rounded-xl p-6">
            <p className="text-xs text-[#D4A359] font-medium">Location Map</p>
            <p className="mt-1 text-sm text-zinc-300">Pali Hill Courtyard · Bandra West, Mumbai (19.0607° N, 72.8295° E)</p>
            <a
              href={restaurant?.social_links?.maps || 'https://maps.google.com/?q=Pali+Hill+Bandra+Mumbai'}
              target="_blank"
              rel="noreferrer"
              className="mt-4 inline-flex items-center gap-1.5 text-xs font-medium text-[#D4A359] hover:underline"
            >
              Open Directions in Google Maps <ArrowRight className="w-3.5 h-3.5" />
            </a>
          </div>
        </div>

        <div className="lg:col-span-7 bg-white border border-zinc-200 rounded-xl p-6 sm:p-8">
          <h2 className="text-lg font-semibold text-[#18181B]">Send an Inquiry</h2>
          <p className="mt-1 text-sm text-zinc-500">Private dining, corporate events, or dietary consultations.</p>

          {contactSuccess && (
            <div className="mt-4 p-3.5 text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-md">
              {contactSuccess}
            </div>
          )}
          {contactError && (
            <div className="mt-4 p-3.5 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md">
              {contactError}
            </div>
          )}

          <form onSubmit={submitContact} className="mt-6 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">Your Name</label>
                <input
                  required
                  value={contactForm.name}
                  onChange={(e) => setContactForm({ ...contactForm, name: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-md focus:outline-none focus:border-[#B47B2B]"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">Phone</label>
                <input
                  value={contactForm.phone}
                  onChange={(e) => setContactForm({ ...contactForm, phone: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-md focus:outline-none focus:border-[#B47B2B]"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-700 mb-1">Email</label>
              <input
                required
                type="email"
                value={contactForm.email}
                onChange={(e) => setContactForm({ ...contactForm, email: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-md focus:outline-none focus:border-[#B47B2B]"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-700 mb-1">Message</label>
              <textarea
                required
                rows={4}
                value={contactForm.message}
                onChange={(e) => setContactForm({ ...contactForm, message: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-md focus:outline-none focus:border-[#B47B2B]"
              />
            </div>
            <button
              type="submit"
              disabled={contactSubmitting}
              className="px-6 py-2.5 text-sm font-medium bg-[#18181B] text-white hover:bg-[#B47B2B] rounded-md transition-colors cursor-pointer"
            >
              {contactSubmitting ? 'Sending...' : 'Send Message'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
