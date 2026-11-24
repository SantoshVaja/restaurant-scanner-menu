import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { generateSecureToken, hashPassword, sha256 } from './security.ts';

export type DBInstance = Database.Database;

export function openDatabase(dbPath?: string): DBInstance {
  const target = dbPath || process.env.DB_PATH || path.resolve(process.cwd(), 'data', 'restaurant360.db');
  if (target !== ':memory:') {
    const dir = path.dirname(target);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
  const db = new Database(target);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  return db;
}

export function initSchema(db: DBInstance): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
      PRIMARY KEY (role_id, permission_id)
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT,
      password_hash TEXT NOT NULL,
      role_id INTEGER NOT NULL REFERENCES roles(id),
      is_active INTEGER NOT NULL DEFAULT 1,
      assigned_tables_json TEXT NOT NULL DEFAULT '[]',
      last_login_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS staff_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS restaurants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      tagline TEXT NOT NULL,
      description TEXT NOT NULL,
      address TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT NOT NULL,
      gstin TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'INR',
      timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
      opening_hours_json TEXT NOT NULL,
      social_links_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS restaurant_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id INTEGER NOT NULL UNIQUE REFERENCES restaurants(id) ON DELETE CASCADE,
      gst_rate_bps INTEGER NOT NULL DEFAULT 500,
      service_charge_bps INTEGER NOT NULL DEFAULT 500,
      payment_mode TEXT NOT NULL DEFAULT 'sandbox',
      razorpay_key_id TEXT,
      auto_accept_kitchen INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS dining_tables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      table_number INTEGER NOT NULL UNIQUE,
      label TEXT NOT NULL,
      capacity INTEGER NOT NULL DEFAULT 4,
      section TEXT NOT NULL DEFAULT 'Main Dining',
      status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'occupied', 'reserved', 'cleaning')),
      assigned_waiter_id INTEGER REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS table_qr_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_id INTEGER NOT NULL REFERENCES dining_tables(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      token_value TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS table_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_id INTEGER NOT NULL REFERENCES dining_tables(id) ON DELETE CASCADE,
      session_code TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'settling', 'closed')),
      guest_count INTEGER NOT NULL DEFAULT 2,
      opened_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at TEXT,
      closed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      is_demo INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS table_access_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_id INTEGER NOT NULL REFERENCES dining_tables(id) ON DELETE CASCADE,
      session_id INTEGER NOT NULL REFERENCES table_sessions(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS menu_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      image_url TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS menu_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL REFERENCES menu_categories(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      price_paise INTEGER NOT NULL CHECK (price_paise >= 0),
      image_url TEXT NOT NULL,
      is_veg INTEGER NOT NULL DEFAULT 1,
      is_bestseller INTEGER NOT NULL DEFAULT 0,
      is_available INTEGER NOT NULL DEFAULT 1,
      prep_time_mins INTEGER NOT NULL DEFAULT 15,
      variants_json TEXT NOT NULL DEFAULT '[]',
      addons_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS coupons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      discount_type TEXT NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
      discount_value INTEGER NOT NULL CHECK (discount_value > 0),
      min_order_paise INTEGER NOT NULL DEFAULT 0,
      max_discount_paise INTEGER,
      usage_limit INTEGER NOT NULL DEFAULT 500,
      used_count INTEGER NOT NULL DEFAULT 0,
      valid_from TEXT NOT NULL,
      valid_until TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT NOT NULL UNIQUE,
      table_session_id INTEGER NOT NULL REFERENCES table_sessions(id) ON DELETE CASCADE,
      table_id INTEGER NOT NULL REFERENCES dining_tables(id),
      customer_name TEXT,
      customer_phone TEXT,
      idempotency_key TEXT UNIQUE,
      subtotal_paise INTEGER NOT NULL,
      gst_paise INTEGER NOT NULL,
      service_charge_paise INTEGER NOT NULL,
      discount_paise INTEGER NOT NULL DEFAULT 0,
      total_paise INTEGER NOT NULL,
      coupon_code TEXT,
      status TEXT NOT NULL DEFAULT 'placed' CHECK (status IN ('placed', 'accepted', 'processing', 'ready', 'served', 'completed', 'rejected', 'cancelled')),
      payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'failed', 'refund_pending', 'refunded')),
      rejection_reason TEXT,
      special_instructions TEXT,
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      menu_item_id INTEGER NOT NULL REFERENCES menu_items(id),
      item_name TEXT NOT NULL,
      unit_price_paise INTEGER NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      variant_name TEXT,
      variant_delta_paise INTEGER NOT NULL DEFAULT 0,
      addons_json TEXT NOT NULL DEFAULT '[]',
      addons_total_paise INTEGER NOT NULL DEFAULT 0,
      line_total_paise INTEGER NOT NULL,
      special_instructions TEXT,
      is_cancelled INTEGER NOT NULL DEFAULT 0,
      cancel_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS order_status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      from_status TEXT,
      to_status TEXT NOT NULL,
      changed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      changed_by_role TEXT,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS kitchen_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_number TEXT NOT NULL UNIQUE,
      order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
      table_id INTEGER NOT NULL REFERENCES dining_tables(id),
      table_session_id INTEGER NOT NULL REFERENCES table_sessions(id),
      status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'accepted', 'preparing', 'ready', 'served', 'rejected', 'cancelled')),
      accepted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      started_at TEXT,
      ready_at TEXT,
      served_at TEXT,
      rejection_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS kitchen_ticket_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kitchen_ticket_id INTEGER NOT NULL REFERENCES kitchen_tickets(id) ON DELETE CASCADE,
      order_item_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
      item_name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      variant_name TEXT,
      addons_json TEXT NOT NULL DEFAULT '[]',
      special_instructions TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
      table_session_id INTEGER NOT NULL REFERENCES table_sessions(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      provider_order_id TEXT,
      provider_payment_id TEXT,
      provider_signature TEXT,
      amount_paise INTEGER NOT NULL,
      method TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('created', 'authorized', 'captured', 'failed', 'refunded')),
      idempotency_key TEXT UNIQUE,
      recorded_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS refunds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
      order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
      amount_paise INTEGER NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'processed',
      processed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_number TEXT NOT NULL UNIQUE,
      table_session_id INTEGER NOT NULL REFERENCES table_sessions(id) ON DELETE CASCADE,
      table_id INTEGER NOT NULL REFERENCES dining_tables(id),
      subtotal_paise INTEGER NOT NULL,
      gst_paise INTEGER NOT NULL,
      service_charge_paise INTEGER NOT NULL,
      discount_paise INTEGER NOT NULL DEFAULT 0,
      grand_total_paise INTEGER NOT NULL,
      paid_paise INTEGER NOT NULL,
      payment_status TEXT NOT NULL,
      generated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reservation_code TEXT NOT NULL UNIQUE,
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      reservation_date TEXT NOT NULL,
      reservation_time TEXT NOT NULL,
      guest_count INTEGER NOT NULL,
      table_id INTEGER REFERENCES dining_tables(id) ON DELETE SET NULL,
      special_requests TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'seated', 'rejected', 'cancelled')),
      reviewed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_role TEXT,
      target_table_id INTEGER,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      type TEXT NOT NULL,
      reference_id TEXT,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      actor_role TEXT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      details_json TEXT NOT NULL DEFAULT '{}',
      ip_address TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS contact_inquiries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_orders_session ON orders(table_session_id);
    CREATE INDEX IF NOT EXISTS idx_orders_table ON orders(table_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_tickets_status ON kitchen_tickets(status);
    CREATE INDEX IF NOT EXISTS idx_tickets_session ON kitchen_tickets(table_session_id);
    CREATE INDEX IF NOT EXISTS idx_payments_session ON payments(table_session_id);
    CREATE INDEX IF NOT EXISTS idx_qr_table ON table_qr_tokens(table_id, is_active);
    CREATE INDEX IF NOT EXISTS idx_sessions_table ON table_sessions(table_id, status);
  `);
}

export const DEMO_STAFF_SEEDS = [
  {
    name: 'Arjun Malhotra',
    email: 'owner@foodmitra.in',
    phone: '+91 98201 44001',
    role: 'super_admin',
    demoPass: 'Owner@360',
    assignedTables: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  },
  {
    name: 'Meera Nair',
    email: 'admin@foodmitra.in',
    phone: '+91 98201 44002',
    role: 'admin',
    demoPass: 'Admin@360',
    assignedTables: [],
  },
  {
    name: 'Chef Vikram Singh',
    email: 'chef@foodmitra.in',
    phone: '+91 98201 44003',
    role: 'chef',
    demoPass: 'Chef@360',
    assignedTables: [],
  },
  {
    name: 'Rohan Kulkarni',
    email: 'counter@foodmitra.in',
    phone: '+91 98201 44004',
    role: 'counter',
    demoPass: 'Counter@360',
    assignedTables: [],
  },
  {
    name: 'Kabir Sharma',
    email: 'waiter@foodmitra.in',
    phone: '+91 98201 44005',
    role: 'waiter',
    demoPass: 'Waiter@360',
    assignedTables: [1, 2, 3, 4, 5],
  },
];

const IMG_STARTERS = '/src/assets/images/dish_paneer_tikka_1795504318614.jpg';
const IMG_CURRIES = '/src/assets/images/dish_indian_curries_1795504318494.jpg';
const IMG_BIRYANI = '/src/assets/images/dish_dum_biryani_1795504319695.jpg';
const IMG_CHINESE = '/src/assets/images/dish_indo_chinese_1795504319795.jpg';
const IMG_DESSERTS = '/src/assets/images/dish_gulab_jamun_1795504319193.jpg';
const IMG_BEVERAGES = '/src/assets/images/dish_craft_beverages_1795504321083.jpg';

export function seedDatabaseIfEmpty(db: DBInstance, forceReset = false): void {
  const existing = db.prepare('SELECT COUNT(*) as cnt FROM restaurants').get() as { cnt: number };
  if (existing.cnt > 0 && !forceReset) {
    // Idempotent upgrade for existing SQLite databases created prior to FoodMitra rebrand
    db.transaction(() => {
      db.prepare("UPDATE restaurants SET name = 'FoodMitra' WHERE name = 'Saffron & Ember'").run();
      db.prepare("UPDATE restaurants SET email = 'concierge@foodmitra.in' WHERE email = 'concierge@saffronember.in'").run();
      db.prepare("UPDATE restaurants SET social_links_json = REPLACE(social_links_json, 'saffronember', 'foodmitra') WHERE social_links_json LIKE '%saffronember%'").run();
      db.prepare("UPDATE users SET email = REPLACE(email, '@saffronember.in', '@foodmitra.in') WHERE email LIKE '%@saffronember.in'").run();
      db.prepare("UPDATE coupons SET code = 'FOODMITRA10' WHERE code = 'SAFFRON10'").run();
    })();
    return;
  }

  const runSeed = db.transaction(() => {
    if (forceReset) {
      db.exec(`
        DELETE FROM notifications;
        DELETE FROM audit_logs;
        DELETE FROM refunds;
        DELETE FROM payments;
        DELETE FROM invoices;
        DELETE FROM kitchen_ticket_items;
        DELETE FROM kitchen_tickets;
        DELETE FROM order_status_history;
        DELETE FROM order_items;
        DELETE FROM orders;
        DELETE FROM table_access_tokens;
        DELETE FROM table_sessions;
        DELETE FROM table_qr_tokens;
        DELETE FROM reservations;
        DELETE FROM dining_tables;
        DELETE FROM menu_items;
        DELETE FROM menu_categories;
        DELETE FROM coupons;
        DELETE FROM staff_sessions;
        DELETE FROM users;
        DELETE FROM role_permissions;
        DELETE FROM permissions;
        DELETE FROM roles;
        DELETE FROM restaurant_settings;
        DELETE FROM restaurants;
        DELETE FROM contact_inquiries;
      `);
    }

    // 1. Roles & Permissions
    const roleDefs = [
      { slug: 'super_admin', name: 'Super Admin / Owner', description: 'Full platform ownership, settings, staff, QR, and QA access.' },
      { slug: 'admin', name: 'Restaurant Admin', description: 'Manage menu, categories, tables, reservations, offers, and analytics.' },
      { slug: 'chef', name: 'Kitchen Chef', description: 'Kitchen Display System access to accept, prepare, and complete tickets.' },
      { slug: 'counter', name: 'Counter / POS', description: 'Live billing, table sessions, cash/UPI settlements, refunds, and invoices.' },
      { slug: 'waiter', name: 'Dining Waiter', description: 'Serve ready items on assigned tables and coordinate guest requests.' },
    ];
    const insertRole = db.prepare('INSERT INTO roles (slug, name, description) VALUES (?, ?, ?)');
    const roleIdMap = new Map<string, number>();
    for (const r of roleDefs) {
      const res = insertRole.run(r.slug, r.name, r.description);
      roleIdMap.set(r.slug, Number(res.lastInsertRowid));
    }

    const permDefs = [
      ['menu:write', 'Create, update, and toggle menu items and categories'],
      ['tables:manage', 'Create tables and generate or revoke QR tokens'],
      ['staff:manage', 'Create staff accounts and assign roles'],
      ['kitchen:operate', 'Accept, prepare, reject, and mark tickets ready'],
      ['pos:operate', 'Record payments, generate invoices, and close table sessions'],
      ['waiter:serve', 'Mark ready orders as served on assigned tables'],
      ['reservations:manage', 'Approve, seat, and manage guest reservations'],
      ['reports:view', 'Access revenue analytics and export financial reports'],
      ['settings:manage', 'Update restaurant branding, GST, and payment settings'],
      ['qa:run', 'Execute automated QA tests and reset demo environment'],
    ];
    const insertPerm = db.prepare('INSERT INTO permissions (slug, description) VALUES (?, ?)');
    const permIdMap = new Map<string, number>();
    for (const [slug, desc] of permDefs) {
      const res = insertPerm.run(slug, desc);
      permIdMap.set(slug, Number(res.lastInsertRowid));
    }

    const rolePermGrants: Record<string, string[]> = {
      super_admin: permDefs.map((p) => p[0]),
      admin: ['menu:write', 'tables:manage', 'staff:manage', 'reservations:manage', 'reports:view', 'settings:manage'],
      chef: ['kitchen:operate'],
      counter: ['pos:operate', 'reservations:manage', 'reports:view'],
      waiter: ['waiter:serve'],
    };
    const insertRP = db.prepare('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)');
    for (const [roleSlug, perms] of Object.entries(rolePermGrants)) {
      const rId = roleIdMap.get(roleSlug)!;
      for (const pSlug of perms) {
        insertRP.run(rId, permIdMap.get(pSlug)!);
      }
    }

    // 2. Staff Users
    const insertUser = db.prepare(
      'INSERT INTO users (name, email, phone, password_hash, role_id, is_active, assigned_tables_json) VALUES (?, ?, ?, ?, ?, 1, ?)'
    );
    const userIdByRole = new Map<string, number>();
    for (const staff of DEMO_STAFF_SEEDS) {
      const rId = roleIdMap.get(staff.role)!;
      const hash = hashPassword(staff.demoPass);
      const res = insertUser.run(staff.name, staff.email, staff.phone, hash, rId, JSON.stringify(staff.assignedTables));
      userIdByRole.set(staff.role, Number(res.lastInsertRowid));
    }

    // 3. Restaurant & Settings
    const restRes = db
      .prepare(
        `INSERT INTO restaurants (name, tagline, description, address, phone, email, gstin, currency, timezone, opening_hours_json, social_links_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'FoodMitra',
        'Wood-Fired Indian Heritage, Served Table-Side',
        'An intimate modern Indian dining room in Bandra West celebrating charcoal tandoor craft, slow-simmered gravies, and regional spice blends.',
        '14 Pali Hill Courtyard, Bandra West, Mumbai 400050',
        '+91 22 4890 3600',
        'concierge@foodmitra.in',
        '27AABCS1429B1Z5',
        'INR',
        'Asia/Kolkata',
        JSON.stringify({
          lunch: '12:00 PM – 3:30 PM',
          dinner: '6:30 PM – 11:45 PM',
          days: 'Open Daily · Monday to Sunday',
        }),
        JSON.stringify({
          instagram: 'https://instagram.com/foodmitra',
          facebook: 'https://facebook.com/foodmitra',
          maps: 'https://maps.google.com/?q=Pali+Hill+Bandra+Mumbai',
        })
      );
    const restaurantId = Number(restRes.lastInsertRowid);

    db.prepare(
      `INSERT INTO restaurant_settings (restaurant_id, gst_rate_bps, service_charge_bps, payment_mode, razorpay_key_id, auto_accept_kitchen)
       VALUES (?, 500, 500, ?, ?, 0)`
    ).run(restaurantId, process.env.RAZORPAY_KEY_ID ? 'razorpay' : 'sandbox', process.env.RAZORPAY_KEY_ID || null);

    // 4. 10 Dining Tables with Unique Cryptographic QR Tokens
    const waiterId = userIdByRole.get('waiter')!;
    const tableSections = [
      'Window Alcove', 'Window Alcove', 'Main Hall', 'Main Hall', 'Main Hall',
      'Chef Counter', 'Chef Counter', 'Courtyard Terrace', 'Courtyard Terrace', 'Private Lounge',
    ];
    const tableCapacities = [2, 4, 4, 4, 6, 2, 4, 4, 6, 8];
    const insertTable = db.prepare(
      'INSERT INTO dining_tables (restaurant_id, table_number, label, capacity, section, status, assigned_waiter_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const insertQr = db.prepare(
      'INSERT INTO table_qr_tokens (table_id, token_hash, token_value, is_active) VALUES (?, ?, ?, 1)'
    );
    const tableIds: number[] = [];
    for (let num = 1; num <= 10; num++) {
      const label = `Table ${String(num).padStart(2, '0')}`;
      const status = num === 4 ? 'occupied' : num === 7 ? 'reserved' : 'available';
      const tRes = insertTable.run(
        restaurantId,
        num,
        label,
        tableCapacities[num - 1],
        tableSections[num - 1],
        status,
        num <= 5 ? waiterId : null
      );
      const tableId = Number(tRes.lastInsertRowid);
      tableIds.push(tableId);
      const rawToken = generateSecureToken(20);
      insertQr.run(tableId, sha256(rawToken), rawToken);
    }

    // 5. Menu Categories (10 categories)
    const categories = [
      { name: 'Starters', slug: 'starters', description: 'Charcoal-grilled tikkas, crisp patties, and small plates.', image: IMG_STARTERS, order: 1 },
      { name: 'Soups', slug: 'soups', description: 'Slow-simmered broths and comforting spiced bowls.', image: IMG_CHINESE, order: 2 },
      { name: 'Indian Main Course', slug: 'indian-main-course', description: 'Signature copper-handi gravies and slow-cooked dals.', image: IMG_CURRIES, order: 3 },
      { name: 'Chinese & Wok', slug: 'chinese', description: 'High-flame Indo-Chinese noodles, fried rice, and chilli specials.', image: IMG_CHINESE, order: 4 },
      { name: 'Biryani & Rice', slug: 'biryani-and-rice', description: 'Sealed earthen pot dum biryanis and fragrant basmati rice.', image: IMG_BIRYANI, order: 5 },
      { name: 'Indian Breads', slug: 'indian-breads', description: 'Blistered tandoor naans, rotis, and flaky parathas.', image: IMG_CURRIES, order: 6 },
      { name: 'Desserts', slug: 'desserts', description: 'Warm saffron confections and artisanal sweet plates.', image: IMG_DESSERTS, order: 7 },
      { name: 'Beverages', slug: 'beverages', description: 'Craft cold coffee, spiced buttermilk, and citrus coolers.', image: IMG_BEVERAGES, order: 8 },
      { name: 'Accompaniments', slug: 'accompaniments', description: 'Roasted papads, house raitas, and chutneys.', image: IMG_BIRYANI, order: 9 },
      { name: 'Chef Tasting Platters', slug: 'chef-platters', description: 'Curated sharing boards for celebratory tables.', image: IMG_STARTERS, order: 10 },
    ];
    const insertCat = db.prepare(
      'INSERT INTO menu_categories (restaurant_id, name, slug, description, image_url, sort_order, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)'
    );
    const catMap = new Map<string, number>();
    for (const c of categories) {
      const res = insertCat.run(restaurantId, c.name, c.slug, c.description, c.image, c.order);
      catMap.set(c.slug, Number(res.lastInsertRowid));
    }

    // 6. 35 Menu Items with INR paise prices, variants, addons, and prep times
    const stdVariants = JSON.stringify([
      { name: 'Regular', price_delta_paise: 0 },
      { name: 'Chef Portion (Large)', price_delta_paise: 8000 },
    ]);
    const spiceVariants = JSON.stringify([
      { name: 'Mild Spice', price_delta_paise: 0 },
      { name: 'Medium Spice', price_delta_paise: 0 },
      { name: 'Fiery Kolhapuri', price_delta_paise: 2000 },
    ]);
    const tikkaAddons = JSON.stringify([
      { name: 'Extra Mint Chutney', price_paise: 2500 },
      { name: 'Charred Garlic Dip', price_paise: 3500 },
      { name: 'Extra Paneer Skewers', price_paise: 9000 },
    ]);
    const curryAddons = JSON.stringify([
      { name: 'Extra Amul Butter', price_paise: 3000 },
      { name: 'Saffron Cream Drizzle', price_paise: 4000 },
    ]);
    const biryaniAddons = JSON.stringify([
      { name: 'Burhani Cucumber Raita', price_paise: 4500 },
      { name: 'Mirchi Ka Salan', price_paise: 5000 },
    ]);

    const menuData: Array<{
      cat: string;
      name: string;
      slug: string;
      desc: string;
      price: number;
      img: string;
      veg: number;
      best: number;
      prep: number;
      variants?: string;
      addons?: string;
    }> = [
      // Starters
      { cat: 'starters', name: 'Paneer Tikka', slug: 'paneer-tikka', desc: 'Cottage cheese marinated in hung curd, Kashmiri chilli, and carom seeds, finished over charcoal.', price: 240, img: IMG_STARTERS, veg: 1, best: 1, prep: 16, variants: spiceVariants, addons: tikkaAddons },
      { cat: 'starters', name: 'Hara Bhara Kebab', slug: 'hara-bhara-kebab', desc: 'Crisp spinach, green pea, and roasted cashew medallions dusted with house chaat masala.', price: 190, img: IMG_STARTERS, veg: 1, best: 0, prep: 14, addons: tikkaAddons },
      { cat: 'starters', name: 'Veg Crispy', slug: 'veg-crispy', desc: 'Golden wok-fried seasonal vegetables glazed in crushed garlic, chilli oil, and spring onion.', price: 210, img: IMG_CHINESE, veg: 1, best: 1, prep: 12, variants: spiceVariants },
      { cat: 'starters', name: 'Cheese Balls', slug: 'cheese-balls', desc: 'Crisp herb-crusted mozzarella and aged cheddar bites served with smoky tomato relish.', price: 180, img: IMG_STARTERS, veg: 1, best: 0, prep: 12 },
      { cat: 'starters', name: 'Spring Rolls', slug: 'spring-rolls', desc: 'Hand-rolled crisp pastry cigars stuffed with julienned vegetables, glass noodles, and sesame.', price: 170, img: IMG_CHINESE, veg: 1, best: 0, prep: 12 },
      { cat: 'starters', name: 'Tandoori Chicken Tikka', slug: 'tandoori-chicken-tikka', desc: 'Boneless free-range chicken thighs smoked over white oak charcoal with fenugreek and lime.', price: 290, img: IMG_STARTERS, veg: 0, best: 1, prep: 18, variants: spiceVariants, addons: tikkaAddons },

      // Soups
      { cat: 'soups', name: 'Tomato Soup', slug: 'tomato-soup', desc: 'Vine-ripened roasted tomato velouté infused with crushed black pepper and sourdough croutons.', price: 120, img: IMG_CURRIES, veg: 1, best: 0, prep: 10 },
      { cat: 'soups', name: 'Hot and Sour Soup', slug: 'hot-and-sour-soup', desc: 'Rich dark soy broth brimming with shiitake mushrooms, bamboo shoots, and white pepper.', price: 140, img: IMG_CHINESE, veg: 1, best: 0, prep: 10 },
      { cat: 'soups', name: 'Manchow Soup', slug: 'manchow-soup', desc: 'Garlicky Indo-Chinese vegetable broth crowned with golden crisp noodles.', price: 140, img: IMG_CHINESE, veg: 1, best: 1, prep: 10 },
      { cat: 'soups', name: 'Sweet Corn Soup', slug: 'sweet-corn-soup', desc: 'Silky golden corn kernel broth delicately seasoned with ginger and toasted sesame.', price: 130, img: IMG_CHINESE, veg: 1, best: 0, prep: 10 },

      // Indian Main Course
      { cat: 'indian-main-course', name: 'Paneer Butter Masala', slug: 'paneer-butter-masala', desc: 'Soft malai paneer simmered in heirloom tomato makhani gravy enriched with cashew cream and kasuri methi.', price: 260, img: IMG_CURRIES, veg: 1, best: 1, prep: 18, variants: stdVariants, addons: curryAddons },
      { cat: 'indian-main-course', name: 'Kadai Paneer', slug: 'kadai-paneer', desc: 'Paneer tossed with charred bell peppers, shallots, and freshly pounded coriander seeds in an iron kadai.', price: 250, img: IMG_CURRIES, veg: 1, best: 1, prep: 18, variants: spiceVariants, addons: curryAddons },
      { cat: 'indian-main-course', name: 'Dal Makhani', slug: 'dal-makhani', desc: 'Whole black urad lentils slow-simmered for 24 hours over dying embers with white butter and cream.', price: 230, img: IMG_CURRIES, veg: 1, best: 1, prep: 14, variants: stdVariants, addons: curryAddons },
      { cat: 'indian-main-course', name: 'Mix Veg', slug: 'mix-veg', desc: 'Seasonal market vegetables braised in caramelized onion and roasted cumin masala.', price: 210, img: IMG_CURRIES, veg: 1, best: 0, prep: 15 },
      { cat: 'indian-main-course', name: 'Chole Masala', slug: 'chole-masala', desc: 'Amritsari-style Kabuli chickpeas simmered with black cardamom, dried pomegranate, and ginger juliennes.', price: 190, img: IMG_CURRIES, veg: 1, best: 0, prep: 14 },
      { cat: 'indian-main-course', name: 'Butter Chicken', slug: 'butter-chicken', desc: 'Tandoor-charred chicken tikka folded into our velvety smoked tomato and fenugreek butter gravy.', price: 320, img: IMG_CURRIES, veg: 0, best: 1, prep: 20, variants: stdVariants, addons: curryAddons },

      // Chinese & Wok
      { cat: 'chinese', name: 'Veg Hakka Noodles', slug: 'veg-hakka-noodles', desc: 'Artisanal wheat noodles wok-tossed on high flame with crisp cabbage, peppers, and light soy.', price: 190, img: IMG_CHINESE, veg: 1, best: 1, prep: 14, variants: spiceVariants },
      { cat: 'chinese', name: 'Schezwan Noodles', slug: 'schezwan-noodles', desc: 'Smoky noodles glazed in house-roasted red chilli Schezwan paste and toasted garlic.', price: 210, img: IMG_CHINESE, veg: 1, best: 0, prep: 14 },
      { cat: 'chinese', name: 'Veg Fried Rice', slug: 'veg-fried-rice', desc: 'Steamed aged rice stir-fried with finely diced garden vegetables, scallions, and white pepper.', price: 180, img: IMG_CHINESE, veg: 1, best: 0, prep: 13 },
      { cat: 'chinese', name: 'Paneer Chilli', slug: 'paneer-chilli', desc: 'Crispy glazed cottage cheese cubes tossed with green chillies, onions, and dark soy reduction.', price: 230, img: IMG_CHINESE, veg: 1, best: 1, prep: 15, variants: spiceVariants },

      // Biryani & Rice
      { cat: 'biryani-and-rice', name: 'Veg Biryani', slug: 'veg-biryani', desc: 'Long-grain aged basmati layered with spiced root vegetables, saffron milk, and mint, slow-cooked on dum.', price: 220, img: IMG_BIRYANI, veg: 1, best: 1, prep: 20, addons: biryaniAddons },
      { cat: 'biryani-and-rice', name: 'Paneer Biryani', slug: 'paneer-biryani', desc: 'Charred paneer tikka and saffron basmati sealed in an earthen handi with rosewater and crispy birista.', price: 250, img: IMG_BIRYANI, veg: 1, best: 1, prep: 22, addons: biryaniAddons },
      { cat: 'biryani-and-rice', name: 'Jeera Rice', slug: 'jeera-rice', desc: 'Fluffy aromatic basmati tempered in clarified butter with roasted cumin seeds and fresh coriander.', price: 140, img: IMG_BIRYANI, veg: 1, best: 0, prep: 10 },
      { cat: 'biryani-and-rice', name: 'Steam Rice', slug: 'steam-rice', desc: 'Delicately steamed Himalayan basmati rice.', price: 110, img: IMG_BIRYANI, veg: 1, best: 0, prep: 10 },

      // Indian Breads
      { cat: 'indian-breads', name: 'Butter Naan', slug: 'butter-naan', desc: 'Leavened refined flour flatbread baked on the clay tandoor wall and brushed with cultured butter.', price: 45, img: IMG_CURRIES, veg: 1, best: 1, prep: 8 },
      { cat: 'indian-breads', name: 'Garlic Naan', slug: 'garlic-naan', desc: 'Tandoor-blistered naan topped with roasted garlic slivers, sea salt, and fresh coriander.', price: 65, img: IMG_CURRIES, veg: 1, best: 1, prep: 8 },
      { cat: 'indian-breads', name: 'Tandoori Roti', slug: 'tandoori-roti', desc: 'Whole wheat stone-ground roti baked crisp in the charcoal tandoor.', price: 25, img: IMG_CURRIES, veg: 1, best: 0, prep: 7 },
      { cat: 'indian-breads', name: 'Laccha Paratha', slug: 'laccha-paratha', desc: 'Multi-layered flaky whole wheat flatbread glazed with pure desi ghee.', price: 60, img: IMG_CURRIES, veg: 1, best: 0, prep: 9 },

      // Desserts
      { cat: 'desserts', name: 'Gulab Jamun', slug: 'gulab-jamun', desc: 'Warm khoya milk dumplings steeped in saffron cardamom syrup, finished with crushed pistachio.', price: 80, img: IMG_DESSERTS, veg: 1, best: 1, prep: 8 },
      { cat: 'desserts', name: 'Warm Chocolate Brownie', slug: 'brownie', desc: '70% dark Belgian chocolate fudge brownie served warm with roasted hazelnut crumble.', price: 120, img: IMG_DESSERTS, veg: 1, best: 0, prep: 10 },
      { cat: 'desserts', name: 'Artisanal Ice Cream', slug: 'ice-cream', desc: 'Two generous scoops of Madagascar vanilla bean and roasted almond praline.', price: 90, img: IMG_DESSERTS, veg: 1, best: 0, prep: 5 },

      // Beverages
      { cat: 'beverages', name: 'Cold Coffee', slug: 'cold-coffee', desc: 'Single-estate Chikmagalur espresso shaken over ice with chilled cream and cocoa dust.', price: 120, img: IMG_BEVERAGES, veg: 1, best: 1, prep: 6 },
      { cat: 'beverages', name: 'Masala Chaas', slug: 'masala-chaas', desc: 'Churned probiotic buttermilk tempered with roasted cumin, rock salt, mint, and green chilli.', price: 50, img: IMG_BEVERAGES, veg: 1, best: 0, prep: 5 },
      { cat: 'beverages', name: 'Fresh Lime Soda', slug: 'fresh-lime-soda', desc: 'Hand-pressed Gondhoraj lime over sparkling soda, served sweet, salted, or mixed.', price: 70, img: IMG_BEVERAGES, veg: 1, best: 0, prep: 5 },
      { cat: 'beverages', name: 'Alphonso Mango Shake', slug: 'mango-shake', desc: 'Ratnagiri Alphonso mango puree blended thick with chilled organic milk and saffron.', price: 130, img: IMG_BEVERAGES, veg: 1, best: 1, prep: 6 },

      // Accompaniments & Platters
      { cat: 'accompaniments', name: 'Masala Papad', slug: 'masala-papad', desc: 'Charcoal-roasted urad papad topped with spiced heirloom tomato, red onion, and coriander.', price: 55, img: IMG_STARTERS, veg: 1, best: 0, prep: 5 },
      { cat: 'chef-platters', name: 'Royal Tandoor Sharing Platter', slug: 'royal-tandoor-platter', desc: 'Curated board of Paneer Tikka, Hara Bhara Kebab, Tandoori Broccoli, and stuffed mushrooms for the table.', price: 640, img: IMG_STARTERS, veg: 1, best: 1, prep: 22 },
    ];

    const insertItem = db.prepare(
      `INSERT INTO menu_items (category_id, name, slug, description, price_paise, image_url, is_veg, is_bestseller, is_available, prep_time_mins, variants_json, addons_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
    );
    const itemIdBySlug = new Map<string, number>();
    for (const m of menuData) {
      const catId = catMap.get(m.cat)!;
      const res = insertItem.run(
        catId,
        m.name,
        m.slug,
        m.desc,
        m.price * 100,
        m.img,
        m.veg,
        m.best,
        m.prep,
        m.variants || '[]',
        m.addons || '[]'
      );
      itemIdBySlug.set(m.slug, Number(res.lastInsertRowid));
    }

    // 7. Coupons
    const insertCoupon = db.prepare(
      `INSERT INTO coupons (code, description, discount_type, discount_value, min_order_paise, max_discount_paise, usage_limit, used_count, valid_from, valid_until, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, '2025-01-01', '2028-12-31', 1)`
    );
    insertCoupon.run('FOODMITRA10', '10% off dining orders above ₹500', 'percent', 10, 50000, 30000, 1000);
    insertCoupon.run('WELCOME100', 'Flat ₹100 off on orders above ₹700', 'fixed', 10000, 70000, null, 500);
    insertCoupon.run('FESTIVE15', '15% chef celebration offer above ₹1,200', 'percent', 15, 120000, 50000, 250);

    // 8. Sample Active Session on Table 04 + Historical Completed Sessions for Analytics
    const chefId = userIdByRole.get('chef')!;
    const counterId = userIdByRole.get('counter')!;
    const table4Id = tableIds[3];

    // Active demo session on Table 04 (shows live occupancy in POS & Kitchen)
    const activeSessRes = db
      .prepare("INSERT INTO table_sessions (table_id, session_code, status, guest_count, is_demo) VALUES (?, 'SES-T04-LIVE', 'active', 4, 1)")
      .run(table4Id);
    const activeSessId = Number(activeSessRes.lastInsertRowid);

    const pTikkaId = itemIdBySlug.get('paneer-tikka')!;
    const butterNaanId = itemIdBySlug.get('butter-naan')!;
    const coldCoffeeId = itemIdBySlug.get('cold-coffee')!;
    const dalMakhaniId = itemIdBySlug.get('dal-makhani')!;
    const vegBiryaniId = itemIdBySlug.get('veg-biryani')!;

    // Order #0998 on Table 04 (Currently Preparing in Kitchen)
    const o1Sub = 24000 + 2 * 4500 + 12000; // 45000 paise = ₹450
    const o1Gst = Math.round(o1Sub * 0.05);
    const o1Svc = Math.round(o1Sub * 0.05);
    const o1Tot = o1Sub + o1Gst + o1Svc;
    const o1Res = db
      .prepare(
        `INSERT INTO orders (order_number, table_session_id, table_id, customer_name, subtotal_paise, gst_paise, service_charge_paise, discount_paise, total_paise, status, payment_status, special_instructions, is_demo)
         VALUES ('ORD-0998', ?, ?, 'Ananya Deshmukh', ?, ?, ?, 0, ?, 'processing', 'paid', 'Serve starters first', 1)`
      )
      .run(activeSessId, table4Id, o1Sub, o1Gst, o1Svc, o1Tot);
    const o1Id = Number(o1Res.lastInsertRowid);

    const insertOI = db.prepare(
      `INSERT INTO order_items (order_id, menu_item_id, item_name, unit_price_paise, quantity, line_total_paise, special_instructions)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const oi1 = Number(insertOI.run(o1Id, pTikkaId, 'Paneer Tikka', 24000, 1, 24000, 'Extra charred edges').lastInsertRowid);
    const oi2 = Number(insertOI.run(o1Id, butterNaanId, 'Butter Naan', 4500, 2, 9000, null).lastInsertRowid);
    const oi3 = Number(insertOI.run(o1Id, coldCoffeeId, 'Cold Coffee', 12000, 1, 12000, 'Less sugar').lastInsertRowid);

    db.prepare("INSERT INTO order_status_history (order_id, from_status, to_status, changed_by_user_id, changed_by_role, note) VALUES (?, NULL, 'placed', NULL, 'customer', 'Order placed via Table 04 QR')").run(o1Id);
    db.prepare("INSERT INTO order_status_history (order_id, from_status, to_status, changed_by_user_id, changed_by_role, note) VALUES (?, 'placed', 'accepted', ?, 'chef', 'Accepted by Chef Vikram')").run(o1Id, chefId);
    db.prepare("INSERT INTO order_status_history (order_id, from_status, to_status, changed_by_user_id, changed_by_role, note) VALUES (?, 'accepted', 'processing', ?, 'chef', 'Tandoor & Bar preparing')").run(o1Id, chefId);

    const kt1Res = db
      .prepare("INSERT INTO kitchen_tickets (ticket_number, order_id, table_id, table_session_id, status, accepted_by_user_id, started_at) VALUES ('KT-0998', ?, ?, ?, 'preparing', ?, datetime('now', '-6 minutes'))")
      .run(o1Id, table4Id, activeSessId, chefId);
    const kt1Id = Number(kt1Res.lastInsertRowid);
    const insertKTI = db.prepare('INSERT INTO kitchen_ticket_items (kitchen_ticket_id, order_item_id, item_name, quantity, special_instructions) VALUES (?, ?, ?, ?, ?)');
    insertKTI.run(kt1Id, oi1, 'Paneer Tikka', 1, 'Extra charred edges');
    insertKTI.run(kt1Id, oi2, 'Butter Naan', 2, null);
    insertKTI.run(kt1Id, oi3, 'Cold Coffee', 1, 'Less sugar');

    db.prepare(
      `INSERT INTO payments (order_id, table_session_id, provider, provider_order_id, provider_payment_id, amount_paise, method, status, is_demo)
       VALUES (?, ?, 'sandbox', 'order_demo_0998', 'pay_demo_0998', ?, 'upi', 'captured', 1)`
    ).run(o1Id, activeSessId, o1Tot);

    // Historical closed sessions (past 7 days) so Admin analytics & charts show real DB figures
    const historicalSamples = [
      { daysAgo: 6, tableIdx: 0, code: 'SES-HIST-1', orderNo: 'ORD-0991', ticketNo: 'KT-0991', invNo: 'INV-2026-091', total: 142000, sub: 129091, gst: 6455, svc: 6454, method: 'upi' },
      { daysAgo: 5, tableIdx: 2, code: 'SES-HIST-2', orderNo: 'ORD-0992', ticketNo: 'KT-0992', invNo: 'INV-2026-092', total: 186000, sub: 169091, gst: 8455, svc: 8454, method: 'card' },
      { daysAgo: 4, tableIdx: 4, code: 'SES-HIST-3', orderNo: 'ORD-0993', ticketNo: 'KT-0993', invNo: 'INV-2026-093', total: 224000, sub: 203636, gst: 10182, svc: 10182, method: 'upi' },
      { daysAgo: 3, tableIdx: 1, code: 'SES-HIST-4', orderNo: 'ORD-0994', ticketNo: 'KT-0994', invNo: 'INV-2026-094', total: 168000, sub: 152727, gst: 7636, svc: 7637, method: 'cash' },
      { daysAgo: 2, tableIdx: 5, code: 'SES-HIST-5', orderNo: 'ORD-0995', ticketNo: 'KT-0995', invNo: 'INV-2026-095', total: 274000, sub: 249091, gst: 12455, svc: 12454, method: 'card' },
      { daysAgo: 1, tableIdx: 7, code: 'SES-HIST-6', orderNo: 'ORD-0996', ticketNo: 'KT-0996', invNo: 'INV-2026-096', total: 312000, sub: 283636, gst: 14182, svc: 14182, method: 'upi' },
      { daysAgo: 0, tableIdx: 8, code: 'SES-HIST-7', orderNo: 'ORD-0997', ticketNo: 'KT-0997', invNo: 'INV-2026-097', total: 194000, sub: 176364, gst: 8818, svc: 8818, method: 'upi' },
    ];
    for (const h of historicalSamples) {
      const tId = tableIds[h.tableIdx];
      const dtMod = `-${h.daysAgo} days`;
      const sRes = db
        .prepare(
          `INSERT INTO table_sessions (table_id, session_code, status, guest_count, opened_at, closed_at, closed_by_user_id, is_demo)
           VALUES (?, ?, 'closed', 4, datetime('now', ?), datetime('now', ?), ?, 1)`
        )
        .run(tId, h.code, dtMod, dtMod, counterId);
      const sId = Number(sRes.lastInsertRowid);
      const oRes = db
        .prepare(
          `INSERT INTO orders (order_number, table_session_id, table_id, customer_name, subtotal_paise, gst_paise, service_charge_paise, discount_paise, total_paise, status, payment_status, is_demo, created_at, updated_at)
           VALUES (?, ?, ?, 'Dining Guest', ?, ?, ?, 0, ?, 'completed', 'paid', 1, datetime('now', ?), datetime('now', ?))`
        )
        .run(h.orderNo, sId, tId, h.sub, h.gst, h.svc, h.total, dtMod, dtMod);
      const oId = Number(oRes.lastInsertRowid);
      const hOi1 = Number(insertOI.run(oId, dalMakhaniId, 'Dal Makhani', 23000, 2, 46000, null).lastInsertRowid);
      const hOi2 = Number(insertOI.run(oId, vegBiryaniId, 'Veg Biryani', 22000, 2, 44000, null).lastInsertRowid);
      const hKtRes = db
        .prepare(
          `INSERT INTO kitchen_tickets (ticket_number, order_id, table_id, table_session_id, status, accepted_by_user_id, created_at)
           VALUES (?, ?, ?, ?, 'served', ?, datetime('now', ?))`
        )
        .run(h.ticketNo, oId, tId, sId, chefId, dtMod);
      const hKtId = Number(hKtRes.lastInsertRowid);
      insertKTI.run(hKtId, hOi1, 'Dal Makhani', 2, null);
      insertKTI.run(hKtId, hOi2, 'Veg Biryani', 2, null);
      db.prepare(
        `INSERT INTO payments (order_id, table_session_id, provider, provider_order_id, provider_payment_id, amount_paise, method, status, recorded_by_user_id, is_demo, created_at)
         VALUES (?, ?, 'sandbox', ?, ?, ?, ?, 'captured', ?, 1, datetime('now', ?))`
      ).run(oId, sId, `ord_${h.orderNo}`, `pay_${h.orderNo}`, h.total, h.method, counterId, dtMod);
      db.prepare(
        `INSERT INTO invoices (invoice_number, table_session_id, table_id, subtotal_paise, gst_paise, service_charge_paise, discount_paise, grand_total_paise, paid_paise, payment_status, generated_by_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 'paid', ?, datetime('now', ?))`
      ).run(h.invNo, sId, tId, h.sub, h.gst, h.svc, h.total, h.total, counterId, dtMod);
    }

    // 9. Sample Reservations
    const insertRes = db.prepare(
      `INSERT INTO reservations (reservation_code, customer_name, customer_email, customer_phone, reservation_date, reservation_time, guest_count, table_id, special_requests, status)
       VALUES (?, ?, ?, ?, date('now', ?), ?, ?, ?, ?, ?)`
    );
    insertRes.run('RES-401', 'Siddharth Kapoor', 'siddharth@example.in', '+91 98111 22334', '+0 days', '20:00', 4, tableIds[6], 'Anniversary table near courtyard', 'confirmed');
    insertRes.run('RES-402', 'Priya Venkatesh', 'priya.v@example.in', '+91 98209 55110', '+1 days', '19:30', 6, tableIds[8], 'Jain options appreciated', 'pending');
    insertRes.run('RES-403', 'Nikhil Chatterjee', 'nikhil@example.in', '+91 98300 77889', '+2 days', '20:30', 2, tableIds[0], 'Window alcove if available', 'pending');

    // 10. Sample Notifications
    db.prepare(
      `INSERT INTO notifications (target_role, target_table_id, title, message, type, reference_id)
       VALUES ('kitchen', ?, 'Ticket KT-0998 Active', 'Table 04 order is currently in preparation.', 'kitchen', 'KT-0998')`
    ).run(table4Id);
    db.prepare(
      `INSERT INTO notifications (target_role, title, message, type, reference_id)
       VALUES ('admin', 'New Reservation Request', 'Priya Venkatesh requested a table for 6 guests.', 'reservation', 'RES-402')`
    ).run();
  });

  runSeed();
}
