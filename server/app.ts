import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';
import { DEMO_STAFF_SEEDS, seedDatabaseIfEmpty, type DBInstance } from './db.ts';
import type { RealtimeHub } from './realtime.ts';
import {
  createRateLimiter,
  generateSecureToken,
  hashPassword,
  safeEqualString,
  sanitizeText,
  sha256,
  signPaymentOrder,
  verifyPassword,
  verifyPaymentSignature,
  verifyWebhookSignature,
} from './security.ts';
import type { RoleSlug } from '../src/types.ts';

interface AuthenticatedStaff {
  id: number;
  name: string;
  email: string;
  role: RoleSlug;
  role_name: string;
  permissions: string[];
  assigned_tables: number[];
}

interface AuthenticatedTableSession {
  tableId: number;
  tableNumber: number;
  sessionId: number;
  sessionCode: string;
}

declare global {
  namespace Express {
    interface Request {
      staffUser?: AuthenticatedStaff;
      tableSession?: AuthenticatedTableSession;
    }
  }
}

export function createApp(db: DBInstance, realtime: RealtimeHub, options?: { runQaHandler?: () => Promise<unknown> }) {
  const app = express();
  app.set('trust proxy', 1);

  app.use(
    express.json({
      limit: '2mb',
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: string }).rawBody = buf.toString('utf8');
      },
    })
  );

  // Rate limiters on auth, QR validation, and checkout
  const authLimiter = createRateLimiter(40, 60_000);
  const publicWriteLimiter = createRateLimiter(80, 60_000);

  // Helper: Audit log writer
  function writeAudit(
    actorUserId: number | null,
    actorRole: string | null,
    action: string,
    entityType: string,
    entityId: string | number | null,
    details: Record<string, unknown> = {},
    ip = ''
  ) {
    db.prepare(
      `INSERT INTO audit_logs (actor_user_id, actor_role, action, entity_type, entity_id, details_json, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(actorUserId, actorRole, action, entityType, entityId !== null ? String(entityId) : null, JSON.stringify(details), ip);
  }

  // Helper: Create notification
  function pushNotification(
    targetRole: string | null,
    targetTableId: number | null,
    title: string,
    message: string,
    type: string,
    referenceId?: string | number
  ) {
    const res = db
      .prepare(
        `INSERT INTO notifications (target_role, target_table_id, title, message, type, reference_id)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(targetRole, targetTableId, title, message, type, referenceId ? String(referenceId) : null);

    const payload = {
      id: Number(res.lastInsertRowid),
      target_role: targetRole,
      target_table_id: targetTableId,
      title,
      message,
      type,
      reference_id: referenceId ? String(referenceId) : null,
      is_read: 0,
      created_at: new Date().toISOString(),
    };
    if (targetRole) {
      realtime.broadcastToRoom(`role:${targetRole}`, 'notification:new', payload);
    }
  }

  // Middleware: Staff Bearer Auth
  function requireAuth(req: Request, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const tokenHash = sha256(token);
    const row = db
      .prepare(
        `SELECT u.id, u.name, u.email, u.assigned_tables_json, r.slug as role, r.name as role_name, r.id as role_id
         FROM staff_sessions s
         JOIN users u ON u.id = s.user_id
         JOIN roles r ON r.id = u.role_id
         WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND u.is_active = 1`
      )
      .get(tokenHash) as
      | {
          id: number;
          name: string;
          email: string;
          assigned_tables_json: string;
          role: RoleSlug;
          role_name: string;
          role_id: number;
        }
      | undefined;

    if (!row) {
      return res.status(401).json({ error: 'Session expired or invalid' });
    }
    const permRows = db
      .prepare(
        `SELECT p.slug FROM permissions p
         JOIN role_permissions rp ON rp.permission_id = p.id
         WHERE rp.role_id = ?`
      )
      .all(row.role_id) as { slug: string }[];

    req.staffUser = {
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      role_name: row.role_name,
      permissions: permRows.map((p) => p.slug),
      assigned_tables: JSON.parse(row.assigned_tables_json || '[]'),
    };
    return next();
  }

  function requireRole(allowedRoles: RoleSlug[]) {
    return (req: Request, res: Response, next: NextFunction) => {
      if (!req.staffUser) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      if (!allowedRoles.includes(req.staffUser.role)) {
        writeAudit(
          req.staffUser.id,
          req.staffUser.role,
          'unauthorized_access_attempt',
          'route',
          req.originalUrl,
          { required: allowedRoles },
          req.ip || ''
        );
        return res.status(403).json({
          error: `Access denied for role ${req.staffUser.role}. Required: ${allowedRoles.join(', ')}`,
        });
      }
      return next();
    };
  }

  // Middleware: Customer Table Session Token Auth
  function requireTableSession(req: Request, res: Response, next: NextFunction) {
    const token = String(req.headers['x-table-session-token'] || '').trim();
    if (!token) {
      return res.status(401).json({ error: 'Valid table QR session required. Please scan your table QR code.' });
    }
    const row = db
      .prepare(
        `SELECT tat.table_id, tat.session_id, dt.table_number, ts.session_code, ts.status
         FROM table_access_tokens tat
         JOIN dining_tables dt ON dt.id = tat.table_id
         JOIN table_sessions ts ON ts.id = tat.session_id
         WHERE tat.token_hash = ? AND tat.expires_at > datetime('now')`
      )
      .get(sha256(token)) as
      | { table_id: number; session_id: number; table_number: number; session_code: string; status: string }
      | undefined;

    if (!row || row.status === 'closed') {
      return res.status(403).json({ error: 'Table session expired or closed. Please scan the table QR code again.' });
    }

    // Prevent cross-table tampering if client passes ?table= or body.table_number
    const claimedTable = req.query.table || (req.body && req.body.table_number);
    if (claimedTable !== undefined && Number(claimedTable) !== row.table_number) {
      return res.status(403).json({
        error: `Cross-table access blocked. Token is strictly bound to Table ${String(row.table_number).padStart(2, '0')}.`,
      });
    }

    req.tableSession = {
      tableId: row.table_id,
      tableNumber: row.table_number,
      sessionId: row.session_id,
      sessionCode: row.session_code,
    };
    return next();
  }

  // Helper: Load full order(s) with items & history
  function hydrateOrders(orderRows: Array<Record<string, unknown>>) {
    if (orderRows.length === 0) return [];
    const orderIds = orderRows.map((o) => Number(o.id));
    const placeholders = orderIds.map(() => '?').join(',');
    const items = db
      .prepare(`SELECT * FROM order_items WHERE order_id IN (${placeholders}) ORDER BY id ASC`)
      .all(...orderIds) as Array<Record<string, unknown>>;
    const history = db
      .prepare(
        `SELECT h.*, u.name as changed_by_name
         FROM order_status_history h
         LEFT JOIN users u ON u.id = h.changed_by_user_id
         WHERE h.order_id IN (${placeholders})
         ORDER BY h.id ASC`
      )
      .all(...orderIds) as Array<Record<string, unknown>>;

    return orderRows.map((o) => ({
      ...o,
      items: items
        .filter((it) => Number(it.order_id) === Number(o.id))
        .map((it) => ({
          ...it,
          addons: JSON.parse(String(it.addons_json || '[]')),
        })),
      history: history.filter((h) => Number(h.order_id) === Number(o.id)),
    }));
  }

  // Helper: Calculate consolidated table session bill
  function getSessionBillSummary(sessionId: number) {
    const orders = db
      .prepare(
        `SELECT o.*, dt.table_number, kt.ticket_number, kt.status as ticket_status
         FROM orders o
         JOIN dining_tables dt ON dt.id = o.table_id
         LEFT JOIN kitchen_tickets kt ON kt.order_id = o.id
         WHERE o.table_session_id = ?
         ORDER BY o.id ASC`
      )
      .all(sessionId) as Array<Record<string, unknown>>;

    const activeOrders = orders.filter((o) => o.status !== 'cancelled' && o.status !== 'rejected');
    const subtotal_paise = activeOrders.reduce((s, o) => s + Number(o.subtotal_paise), 0);
    const gst_paise = activeOrders.reduce((s, o) => s + Number(o.gst_paise), 0);
    const service_charge_paise = activeOrders.reduce((s, o) => s + Number(o.service_charge_paise), 0);
    const discount_paise = activeOrders.reduce((s, o) => s + Number(o.discount_paise), 0);
    const grand_total_paise = activeOrders.reduce((s, o) => s + Number(o.total_paise), 0);

    const payments = db
      .prepare(
        `SELECT p.*, u.name as recorded_by_name
         FROM payments p
         LEFT JOIN users u ON u.id = p.recorded_by_user_id
         WHERE p.table_session_id = ?
         ORDER BY p.id DESC`
      )
      .all(sessionId) as Array<Record<string, unknown>>;

    const paid_paise = payments
      .filter((p) => p.status === 'captured')
      .reduce((s, p) => s + Number(p.amount_paise), 0);

    const refunded_paise = payments
      .filter((p) => p.status === 'refunded')
      .reduce((s, p) => s + Number(p.amount_paise), 0);

    const net_paid_paise = Math.max(0, paid_paise - refunded_paise);
    const outstanding_paise = Math.max(0, grand_total_paise - net_paid_paise);

    return {
      orders: hydrateOrders(orders),
      payments,
      totals: {
        subtotal_paise,
        gst_paise,
        service_charge_paise,
        discount_paise,
        grand_total_paise,
        paid_paise: net_paid_paise,
        outstanding_paise,
      },
    };
  }

  // Helper: Execute verified payment capture and issue separate Kitchen Ticket atomically
  function finalizePaidOrderTransaction(
    orderId: number,
    paymentId: number,
    providerPaymentId: string,
    providerSignature: string | null,
    method: string
  ) {
    return db.transaction(() => {
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as
        | Record<string, unknown>
        | undefined;
      if (!order) throw new Error('Order not found');

      // Idempotency guard: if ticket already exists for this order, do not duplicate!
      const existingTicket = db.prepare('SELECT * FROM kitchen_tickets WHERE order_id = ?').get(orderId) as
        | { id: number; ticket_number: string }
        | undefined;

      db.prepare(
        `UPDATE payments SET status = 'captured', provider_payment_id = ?, provider_signature = ?, method = ?
         WHERE id = ?`
      ).run(providerPaymentId, providerSignature, method, paymentId);

      db.prepare(`UPDATE orders SET payment_status = 'paid', updated_at = datetime('now') WHERE id = ?`).run(orderId);

      if (existingTicket) {
        return { order, ticketNumber: existingTicket.ticket_number, alreadyProcessed: true };
      }

      const settings = db.prepare('SELECT auto_accept_kitchen FROM restaurant_settings LIMIT 1').get() as
        | { auto_accept_kitchen: number }
        | undefined;
      const initialTicketStatus = settings?.auto_accept_kitchen ? 'accepted' : 'new';

      const ticketNumber = `KT-${String(1000 + orderId)}`;
      const ktRes = db
        .prepare(
          `INSERT INTO kitchen_tickets (ticket_number, order_id, table_id, table_session_id, status)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(ticketNumber, orderId, order.table_id, order.table_session_id, initialTicketStatus);
      const ktId = Number(ktRes.lastInsertRowid);

      const orderItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId) as Array<
        Record<string, unknown>
      >;
      const insertKTI = db.prepare(
        `INSERT INTO kitchen_ticket_items (kitchen_ticket_id, order_item_id, item_name, quantity, variant_name, addons_json, special_instructions)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const oi of orderItems) {
        insertKTI.run(
          ktId,
          oi.id,
          oi.item_name,
          oi.quantity,
          oi.variant_name,
          oi.addons_json,
          oi.special_instructions
        );
      }

      if (initialTicketStatus === 'accepted') {
        db.prepare(`UPDATE orders SET status = 'accepted' WHERE id = ?`).run(orderId);
        db.prepare(
          `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by_role, note)
           VALUES (?, 'placed', 'accepted', 'system', 'Payment verified and auto-accepted by kitchen')`
        ).run(orderId);
      } else {
        db.prepare(
          `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by_role, note)
           VALUES (?, 'placed', 'placed', 'system', 'Payment verified; kitchen ticket generated')`
        ).run(orderId);
      }

      const tableRow = db
        .prepare('SELECT table_number FROM dining_tables WHERE id = ?')
        .get(order.table_id) as { table_number: number };

      return { order, ticketNumber, tableNumber: tableRow.table_number, alreadyProcessed: false };
    })();
  }

  // ==================== 1. HEALTH & PUBLIC ====================

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'restaurant-360', timestamp: new Date().toISOString() });
  });

  app.get('/api/restaurant', (_req, res) => {
    const rest = db.prepare('SELECT * FROM restaurants LIMIT 1').get() as Record<string, unknown>;
    const settings = db.prepare('SELECT * FROM restaurant_settings LIMIT 1').get() as Record<string, unknown>;
    res.json({
      id: rest.id,
      name: rest.name,
      tagline: rest.tagline,
      description: rest.description,
      address: rest.address,
      phone: rest.phone,
      email: rest.email,
      gstin: rest.gstin,
      currency: rest.currency,
      timezone: rest.timezone,
      opening_hours: JSON.parse(String(rest.opening_hours_json)),
      social_links: JSON.parse(String(rest.social_links_json)),
      gst_rate_bps: settings.gst_rate_bps,
      service_charge_bps: settings.service_charge_bps,
      payment_mode: process.env.RAZORPAY_KEY_ID ? 'razorpay' : 'sandbox',
      razorpay_key_id: process.env.RAZORPAY_KEY_ID || null,
      auto_accept_kitchen: Boolean(settings.auto_accept_kitchen),
    });
  });

  app.get('/api/menu', (_req, res) => {
    const categories = db
      .prepare('SELECT * FROM menu_categories WHERE is_active = 1 ORDER BY sort_order ASC, id ASC')
      .all();
    const items = db
      .prepare(
        `SELECT mi.*, mc.name as category_name
         FROM menu_items mi
         JOIN menu_categories mc ON mc.id = mi.category_id
         ORDER BY mc.sort_order ASC, mi.is_bestseller DESC, mi.id ASC`
      )
      .all() as Array<Record<string, unknown>>;

    res.json({
      categories,
      items: items.map((item) => ({
        ...item,
        variants: JSON.parse(String(item.variants_json || '[]')),
        addons: JSON.parse(String(item.addons_json || '[]')),
      })),
    });
  });

  app.post('/api/coupons/validate', publicWriteLimiter, (req, res) => {
    const code = sanitizeText(req.body?.code, 40).toUpperCase();
    const subtotalPaise = Number(req.body?.subtotal_paise || 0);
    if (!code) return res.status(400).json({ error: 'Coupon code is required' });

    const coupon = db
      .prepare(
        `SELECT * FROM coupons
         WHERE code = ? AND is_active = 1 AND date('now') BETWEEN valid_from AND valid_until`
      )
      .get(code) as Record<string, unknown> | undefined;

    if (!coupon) return res.status(404).json({ error: 'Invalid or expired coupon code' });
    if (Number(coupon.used_count) >= Number(coupon.usage_limit)) {
      return res.status(400).json({ error: 'Coupon usage limit reached' });
    }
    if (subtotalPaise < Number(coupon.min_order_paise)) {
      return res.status(400).json({
        error: `Minimum order ₹${Math.round(Number(coupon.min_order_paise) / 100)} required for ${code}`,
      });
    }

    let discountPaise =
      coupon.discount_type === 'percent'
        ? Math.round((subtotalPaise * Number(coupon.discount_value)) / 100)
        : Number(coupon.discount_value);

    if (coupon.max_discount_paise && discountPaise > Number(coupon.max_discount_paise)) {
      discountPaise = Number(coupon.max_discount_paise);
    }
    discountPaise = Math.min(discountPaise, subtotalPaise);

    res.json({ valid: true, coupon, discount_paise: discountPaise });
  });

  app.post('/api/reservations', publicWriteLimiter, (req, res) => {
    const schema = z.object({
      customer_name: z.string().min(2).max(100),
      customer_email: z.string().email(),
      customer_phone: z.string().min(7).max(20),
      reservation_date: z.string().min(8).max(20),
      reservation_time: z.string().min(3).max(20),
      guest_count: z.number().int().min(1).max(20),
      special_requests: z.string().max(400).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Please complete all reservation fields accurately.' });
    }
    const d = parsed.data;
    const code = `RES-${Math.floor(1000 + Math.random() * 9000)}`;
    const result = db
      .prepare(
        `INSERT INTO reservations (reservation_code, customer_name, customer_email, customer_phone, reservation_date, reservation_time, guest_count, special_requests, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
      )
      .run(
        code,
        sanitizeText(d.customer_name, 100),
        sanitizeText(d.customer_email, 120),
        sanitizeText(d.customer_phone, 20),
        sanitizeText(d.reservation_date, 20),
        sanitizeText(d.reservation_time, 20),
        d.guest_count,
        sanitizeText(d.special_requests || '', 400),
      );

    pushNotification(
      'admin',
      null,
      'New Table Reservation',
      `${d.customer_name} requested a table for ${d.guest_count} on ${d.reservation_date} at ${d.reservation_time}.`,
      'reservation',
      code
    );
    realtime.broadcastToRoom('role:admin', 'reservation:new', { id: Number(result.lastInsertRowid), code });
    res.status(201).json({
      id: Number(result.lastInsertRowid),
      reservation_code: code,
      status: 'pending',
      message: 'Reservation request received. Our concierge will confirm shortly.',
    });
  });

  app.post('/api/contact', publicWriteLimiter, (req, res) => {
    const schema = z.object({
      name: z.string().min(2).max(100),
      email: z.string().email(),
      phone: z.string().max(20).optional(),
      message: z.string().min(5).max(1000),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Please provide your name, valid email, and message.' });
    }
    const d = parsed.data;
    db.prepare('INSERT INTO contact_inquiries (name, email, phone, message) VALUES (?, ?, ?, ?)').run(
      sanitizeText(d.name, 100),
      sanitizeText(d.email, 120),
      sanitizeText(d.phone || '', 20),
      sanitizeText(d.message, 1000)
    );
    res.status(201).json({ ok: true, message: 'Thank you for reaching out. Our hospitality desk will respond soon.' });
  });

  // ==================== 2. QR VALIDATION & TABLE SESSIONS ====================

  app.post('/api/qr/validate', publicWriteLimiter, (req, res) => {
    const tableNumber = Number(req.body?.table);
    const token = String(req.body?.token || '').trim();

    if (!Number.isInteger(tableNumber) || tableNumber < 1 || !token) {
      return res.status(400).json({ error: 'Missing table number or QR security token.' });
    }

    const table = db.prepare('SELECT * FROM dining_tables WHERE table_number = ?').get(tableNumber) as
      | { id: number; table_number: number; label: string; capacity: number; section: string; status: string }
      | undefined;

    if (!table) {
      return res.status(404).json({ error: 'Table not found.' });
    }

    const activeTokenRow = db
      .prepare('SELECT * FROM table_qr_tokens WHERE table_id = ? AND is_active = 1 ORDER BY id DESC LIMIT 1')
      .get(table.id) as { id: number; token_hash: string } | undefined;

    if (!activeTokenRow || !safeEqualString(activeTokenRow.token_hash, sha256(token))) {
      writeAudit(null, 'customer', 'invalid_qr_attempt', 'dining_tables', table.id, { tableNumber }, req.ip || '');
      return res.status(403).json({
        error: 'Invalid or revoked QR code. Please scan the current QR plaque on your table or ask your waiter.',
      });
    }

    const result = db.transaction(() => {
      let session = db
        .prepare("SELECT * FROM table_sessions WHERE table_id = ? AND status IN ('active', 'settling') ORDER BY id DESC LIMIT 1")
        .get(table.id) as { id: number; session_code: string; status: string } | undefined;

      if (!session) {
        const sessionCode = `SES-T${String(table.table_number).padStart(2, '0')}-${Date.now().toString(36).toUpperCase()}`;
        const sRes = db
          .prepare("INSERT INTO table_sessions (table_id, session_code, status, guest_count) VALUES (?, ?, 'active', ?)")
          .run(table.id, sessionCode, table.capacity);
        session = { id: Number(sRes.lastInsertRowid), session_code: sessionCode, status: 'active' };
        db.prepare("UPDATE dining_tables SET status = 'occupied' WHERE id = ?").run(table.id);
      }

      const customerToken = generateSecureToken(24);
      db.prepare(
        `INSERT INTO table_access_tokens (table_id, session_id, token_hash, expires_at)
         VALUES (?, ?, ?, datetime('now', '+12 hours'))`
      ).run(table.id, session.id, sha256(customerToken));

      return { session, customerToken };
    })();

    realtime.broadcastOrderUpdate(result.session.id, { type: 'table_session_active', tableId: table.id });

    res.json({
      verified: true,
      table: {
        id: table.id,
        table_number: table.table_number,
        label: table.label,
        section: table.section,
        capacity: table.capacity,
      },
      session: result.session,
      customer_token: result.customerToken,
    });
  });

  app.get('/api/table-session/current', requireTableSession, (req, res) => {
    const sess = req.tableSession!;
    const table = db.prepare('SELECT id, table_number, label, section, capacity, status FROM dining_tables WHERE id = ?').get(sess.tableId);
    const bill = getSessionBillSummary(sess.sessionId);
    res.json({
      table,
      session: { id: sess.sessionId, session_code: sess.sessionCode },
      ...bill,
    });
  });

  app.post('/api/table-session/call-waiter', requireTableSession, (req, res) => {
    const sess = req.tableSession!;
    const note = sanitizeText(req.body?.note || 'Guest requested assistance at table', 200);
    pushNotification('waiter', sess.tableId, `Table ${String(sess.tableNumber).padStart(2, '0')} Assistance`, note, 'waiter', sess.sessionCode);
    pushNotification('counter', sess.tableId, `Table ${String(sess.tableNumber).padStart(2, '0')} Assistance`, note, 'waiter', sess.sessionCode);
    res.json({ ok: true, message: 'Your waiter has been notified.' });
  });

  // ==================== 3. CHECKOUT & ONLINE PAYMENTS ====================

  app.post('/api/orders/checkout', publicWriteLimiter, requireTableSession, (req, res) => {
    const sess = req.tableSession!;
    const schema = z.object({
      idempotency_key: z.string().min(8).max(100),
      customer_name: z.string().max(100).optional(),
      customer_phone: z.string().max(20).optional(),
      coupon_code: z.string().max(40).optional().nullable(),
      special_instructions: z.string().max(400).optional(),
      items: z
        .array(
          z.object({
            menu_item_id: z.number().int().positive(),
            quantity: z.number().int().min(1).max(30),
            variant_name: z.string().max(80).optional().nullable(),
            addon_names: z.array(z.string().max(80)).optional(),
            special_instructions: z.string().max(200).optional().nullable(),
          })
        )
        .min(1),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid cart payload.' });
    }
    const payload = parsed.data;

    // Idempotency check: prevent duplicate order submission on double clicks or retries
    const existingOrder = db.prepare('SELECT * FROM orders WHERE idempotency_key = ?').get(payload.idempotency_key) as
      | Record<string, unknown>
      | undefined;

    if (existingOrder) {
      const existingPay = db
        .prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1')
        .get(existingOrder.id) as Record<string, unknown> | undefined;
      return res.status(200).json({
        deduplicated: true,
        order: hydrateOrders([existingOrder])[0],
        payment_order: existingPay,
      });
    }

    try {
      const created = db.transaction(() => {
        const settings = db.prepare('SELECT * FROM restaurant_settings LIMIT 1').get() as {
          gst_rate_bps: number;
          service_charge_bps: number;
          payment_mode: string;
        };

        let subtotalPaise = 0;
        const resolvedItems: Array<{
          menu_item_id: number;
          item_name: string;
          unit_price_paise: number;
          quantity: number;
          variant_name: string | null;
          variant_delta_paise: number;
          addons: Array<{ name: string; price_paise: number }>;
          addons_total_paise: number;
          line_total_paise: number;
          special_instructions: string | null;
        }> = [];

        for (const reqItem of payload.items) {
          const dbItem = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(reqItem.menu_item_id) as
            | Record<string, unknown>
            | undefined;

          if (!dbItem) {
            throw new Error(`Menu item #${reqItem.menu_item_id} does not exist.`);
          }
          if (!dbItem.is_available) {
            throw new Error(`"${dbItem.name}" is currently unavailable. Please remove it from your cart.`);
          }

          const variants = JSON.parse(String(dbItem.variants_json || '[]')) as Array<{
            name: string;
            price_delta_paise: number;
          }>;
          const addonsCatalog = JSON.parse(String(dbItem.addons_json || '[]')) as Array<{
            name: string;
            price_paise: number;
          }>;

          let variantDelta = 0;
          let resolvedVariant: string | null = null;
          if (reqItem.variant_name) {
            const matchedVar = variants.find((v) => v.name === reqItem.variant_name);
            if (matchedVar) {
              resolvedVariant = matchedVar.name;
              variantDelta = matchedVar.price_delta_paise;
            }
          }

          const chosenAddons: Array<{ name: string; price_paise: number }> = [];
          let addonsTotal = 0;
          for (const aName of reqItem.addon_names || []) {
            const matchedAddon = addonsCatalog.find((a) => a.name === aName);
            if (matchedAddon) {
              chosenAddons.push(matchedAddon);
              addonsTotal += matchedAddon.price_paise;
            }
          }

          const baseUnit = Number(dbItem.price_paise);
          const singleUnitTotal = baseUnit + variantDelta + addonsTotal;
          const lineTotal = singleUnitTotal * reqItem.quantity;
          subtotalPaise += lineTotal;

          resolvedItems.push({
            menu_item_id: Number(dbItem.id),
            item_name: String(dbItem.name),
            unit_price_paise: baseUnit,
            quantity: reqItem.quantity,
            variant_name: resolvedVariant,
            variant_delta_paise: variantDelta,
            addons: chosenAddons,
            addons_total_paise: addonsTotal,
            line_total_paise: lineTotal,
            special_instructions: reqItem.special_instructions ? sanitizeText(reqItem.special_instructions, 200) : null,
          });
        }

        // Server-side coupon calculation
        let discountPaise = 0;
        let appliedCoupon: string | null = null;
        if (payload.coupon_code) {
          const code = sanitizeText(payload.coupon_code, 40).toUpperCase();
          const coupon = db
            .prepare(
              `SELECT * FROM coupons WHERE code = ? AND is_active = 1 AND date('now') BETWEEN valid_from AND valid_until`
            )
            .get(code) as Record<string, unknown> | undefined;
          if (
            coupon &&
            Number(coupon.used_count) < Number(coupon.usage_limit) &&
            subtotalPaise >= Number(coupon.min_order_paise)
          ) {
            discountPaise =
              coupon.discount_type === 'percent'
                ? Math.round((subtotalPaise * Number(coupon.discount_value)) / 100)
                : Number(coupon.discount_value);
            if (coupon.max_discount_paise && discountPaise > Number(coupon.max_discount_paise)) {
              discountPaise = Number(coupon.max_discount_paise);
            }
            discountPaise = Math.min(discountPaise, subtotalPaise);
            appliedCoupon = code;
            db.prepare('UPDATE coupons SET used_count = used_count + 1 WHERE id = ?').run(coupon.id);
          }
        }

        const taxablePaise = Math.max(0, subtotalPaise - discountPaise);
        const gstPaise = Math.round((taxablePaise * settings.gst_rate_bps) / 10000);
        const serviceChargePaise = Math.round((taxablePaise * settings.service_charge_bps) / 10000);
        const totalPaise = taxablePaise + gstPaise + serviceChargePaise;

        const nextSeqRow = db.prepare('SELECT COALESCE(MAX(id), 1000) + 1 as next_id FROM orders').get() as {
          next_id: number;
        };
        const orderNumber = `ORD-${1000 + nextSeqRow.next_id}`;

        const orderRes = db
          .prepare(
            `INSERT INTO orders (
               order_number, table_session_id, table_id, customer_name, customer_phone, idempotency_key,
               subtotal_paise, gst_paise, service_charge_paise, discount_paise, total_paise, coupon_code,
               status, payment_status, special_instructions
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'placed', 'pending', ?)`
          )
          .run(
            orderNumber,
            sess.sessionId,
            sess.tableId,
            payload.customer_name ? sanitizeText(payload.customer_name, 100) : 'Table Guest',
            payload.customer_phone ? sanitizeText(payload.customer_phone, 20) : null,
            payload.idempotency_key,
            subtotalPaise,
            gstPaise,
            serviceChargePaise,
            discountPaise,
            totalPaise,
            appliedCoupon,
            payload.special_instructions ? sanitizeText(payload.special_instructions, 400) : null
          );
        const orderId = Number(orderRes.lastInsertRowid);

        const insertOI = db.prepare(
          `INSERT INTO order_items (
             order_id, menu_item_id, item_name, unit_price_paise, quantity, variant_name, variant_delta_paise,
             addons_json, addons_total_paise, line_total_paise, special_instructions
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const item of resolvedItems) {
          insertOI.run(
            orderId,
            item.menu_item_id,
            item.item_name,
            item.unit_price_paise,
            item.quantity,
            item.variant_name,
            item.variant_delta_paise,
            JSON.stringify(item.addons),
            item.addons_total_paise,
            item.line_total_paise,
            item.special_instructions
          );
        }

        db.prepare(
          `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by_role, note)
           VALUES (?, NULL, 'placed', 'customer', ?)`
        ).run(orderId, `Order initiated at Table ${String(sess.tableNumber).padStart(2, '0')}`);

        // Create Payment Order
        const provider = process.env.RAZORPAY_KEY_ID ? 'razorpay_sandbox' : 'demo_gateway';
        const providerOrderId = `order_${generateSecureToken(10)}`;
        const payRes = db
          .prepare(
            `INSERT INTO payments (
               order_id, table_session_id, provider, provider_order_id, amount_paise, method, status, idempotency_key
             ) VALUES (?, ?, ?, ?, ?, 'online', 'created', ?)`
          )
          .run(orderId, sess.sessionId, provider, providerOrderId, totalPaise, `pay_${payload.idempotency_key}`);
        const paymentId = Number(payRes.lastInsertRowid);

        const savedOrder = db
          .prepare('SELECT o.*, dt.table_number FROM orders o JOIN dining_tables dt ON dt.id = o.table_id WHERE o.id = ?')
          .get(orderId) as Record<string, unknown>;

        return {
          order: hydrateOrders([savedOrder])[0],
          payment_order: {
            id: paymentId,
            provider,
            provider_order_id: providerOrderId,
            amount_paise: totalPaise,
            currency: 'INR',
            key_id: process.env.RAZORPAY_KEY_ID || 'rzp_sandbox_demo',
            is_sandbox_demo: !process.env.RAZORPAY_KEY_ID,
          },
        };
      })();

      res.status(201).json(created);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unable to process checkout';
      res.status(400).json({ error: msg });
    }
  });

  // Sandbox helper: simulate gateway returning a signed authorization payload (NEVER marks DB paid directly!)
  app.post('/api/payments/sandbox-authorize', publicWriteLimiter, requireTableSession, (req, res) => {
    const providerOrderId = String(req.body?.provider_order_id || '');
    const method = sanitizeText(req.body?.method || 'upi', 30);
    const payment = db.prepare('SELECT * FROM payments WHERE provider_order_id = ?').get(providerOrderId) as
      | Record<string, unknown>
      | undefined;

    if (!payment || Number(payment.table_session_id) !== req.tableSession!.sessionId) {
      return res.status(404).json({ error: 'Payment order not found for this table session' });
    }

    const providerPaymentId = `pay_sbx_${generateSecureToken(8)}`;
    const signature = signPaymentOrder(providerOrderId, providerPaymentId);

    res.json({
      sandbox: true,
      razorpay_order_id: providerOrderId,
      razorpay_payment_id: providerPaymentId,
      razorpay_signature: signature,
      method,
    });
  });

  // Server-side Payment Signature Verification (Required before releasing Kitchen Ticket!)
  app.post('/api/payments/verify', publicWriteLimiter, requireTableSession, (req, res) => {
    const schema = z.object({
      razorpay_order_id: z.string().min(5),
      razorpay_payment_id: z.string().min(5),
      razorpay_signature: z.string().min(10),
      method: z.string().max(40).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Incomplete payment verification payload' });
    }
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, method } = parsed.data;

    const payment = db.prepare('SELECT * FROM payments WHERE provider_order_id = ?').get(razorpay_order_id) as
      | { id: number; order_id: number; table_session_id: number; status: string }
      | undefined;

    if (!payment || payment.table_session_id !== req.tableSession!.sessionId) {
      return res.status(404).json({ error: 'Payment record not found' });
    }

    if (!verifyPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
      db.prepare("UPDATE payments SET status = 'failed' WHERE id = ?").run(payment.id);
      db.prepare("UPDATE orders SET payment_status = 'failed', updated_at = datetime('now') WHERE id = ?").run(payment.order_id);
      writeAudit(null, 'customer', 'invalid_payment_signature', 'payments', payment.id, { razorpay_order_id }, req.ip || '');
      return res.status(400).json({ error: 'Payment signature verification failed. Transaction rejected.' });
    }

    const result = finalizePaidOrderTransaction(
      payment.order_id,
      payment.id,
      razorpay_payment_id,
      razorpay_signature,
      sanitizeText(method || 'upi', 30)
    );

    if (!result.alreadyProcessed) {
      const orderNum = String(result.order.order_number);
      const tNum = String(result.tableNumber).padStart(2, '0');
      pushNotification('kitchen', Number(result.order.table_id), `New Ticket ${result.ticketNumber}`, `Table ${tNum} placed ${orderNum}`, 'kitchen', result.ticketNumber);
      pushNotification('counter', Number(result.order.table_id), `Order Paid · ${orderNum}`, `Table ${tNum} payment verified`, 'payment', orderNum);
      pushNotification('admin', Number(result.order.table_id), `New Paid Order ${orderNum}`, `Table ${tNum} order confirmed`, 'order', orderNum);
      realtime.broadcastOrderUpdate(req.tableSession!.sessionId, {
        type: 'order_paid',
        orderId: payment.order_id,
        ticketNumber: result.ticketNumber,
      });
    }

    const updatedOrder = db
      .prepare('SELECT o.*, dt.table_number, kt.ticket_number, kt.status as ticket_status FROM orders o JOIN dining_tables dt ON dt.id = o.table_id LEFT JOIN kitchen_tickets kt ON kt.order_id = o.id WHERE o.id = ?')
      .get(payment.order_id) as Record<string, unknown>;

    res.json({
      verified: true,
      already_processed: result.alreadyProcessed,
      ticket_number: result.ticketNumber,
      order: hydrateOrders([updatedOrder])[0],
    });
  });

  app.post('/api/payments/mark-failed', publicWriteLimiter, requireTableSession, (req, res) => {
    const providerOrderId = String(req.body?.provider_order_id || '');
    const reason = sanitizeText(req.body?.reason || 'Payment failed or cancelled by user', 200);
    const payment = db.prepare('SELECT * FROM payments WHERE provider_order_id = ?').get(providerOrderId) as
      | { id: number; order_id: number; table_session_id: number; status: string }
      | undefined;

    if (!payment || payment.table_session_id !== req.tableSession!.sessionId) {
      return res.status(404).json({ error: 'Payment order not found' });
    }
    if (payment.status === 'captured') {
      return res.status(400).json({ error: 'Cannot fail an already captured payment' });
    }

    db.transaction(() => {
      db.prepare("UPDATE payments SET status = 'failed', metadata_json = ? WHERE id = ?").run(
        JSON.stringify({ reason }),
        payment.id
      );
      db.prepare("UPDATE orders SET payment_status = 'failed', updated_at = datetime('now') WHERE id = ?").run(
        payment.order_id
      );
      db.prepare(
        `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by_role, note)
         VALUES (?, 'placed', 'placed', 'system', ?)`
      ).run(payment.order_id, reason);
    })();

    realtime.broadcastOrderUpdate(req.tableSession!.sessionId, { type: 'payment_failed', orderId: payment.order_id });
    res.json({ ok: true, status: 'failed', reason });
  });

  // Payment Webhook with HMAC Signature Verification & Duplicate Event Prevention
  app.post('/api/payments/webhook', (req: Request & { rawBody?: string }, res) => {
    const signature = String(req.headers['x-razorpay-signature'] || '');
    const rawBody = req.rawBody || JSON.stringify(req.body);
    if (!verifyWebhookSignature(rawBody, signature)) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    const event = req.body?.event as string;
    const entity = req.body?.payload?.payment?.entity as
      | { id?: string; order_id?: string; method?: string }
      | undefined;

    if (!entity?.order_id || !entity?.id) {
      return res.status(400).json({ error: 'Malformed webhook payload' });
    }

    const payment = db.prepare('SELECT * FROM payments WHERE provider_order_id = ?').get(entity.order_id) as
      | { id: number; order_id: number; table_session_id: number; status: string }
      | undefined;

    if (!payment) {
      return res.status(404).json({ error: 'Order payment record not found' });
    }

    if (event === 'payment.captured') {
      if (payment.status === 'captured') {
        return res.json({ ok: true, deduplicated: true });
      }
      const result = finalizePaidOrderTransaction(
        payment.order_id,
        payment.id,
        entity.id,
        signature,
        entity.method || 'online'
      );
      realtime.broadcastOrderUpdate(payment.table_session_id, {
        type: 'order_paid_webhook',
        orderId: payment.order_id,
        ticketNumber: result.ticketNumber,
      });
      return res.json({ ok: true, deduplicated: result.alreadyProcessed, ticket_number: result.ticketNumber });
    }

    if (event === 'payment.failed') {
      if (payment.status !== 'captured') {
        db.prepare("UPDATE payments SET status = 'failed' WHERE id = ?").run(payment.id);
        db.prepare("UPDATE orders SET payment_status = 'failed' WHERE id = ?").run(payment.order_id);
      }
      return res.json({ ok: true, status: 'failed' });
    }

    return res.json({ ok: true });
  });

  // ==================== 4. STAFF AUTHENTICATION ====================

  app.get('/api/auth/demo-accounts', (_req, res) => {
    res.json({
      demo_mode: true,
      accounts: DEMO_STAFF_SEEDS.map((s) => ({
        name: s.name,
        email: s.email,
        role: s.role,
        demo_password: s.demoPass,
      })),
    });
  });

  app.post('/api/auth/login', authLimiter, (req, res) => {
    const email = sanitizeText(req.body?.email, 120).toLowerCase();
    const password = String(req.body?.password || '');

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = db
      .prepare(
        `SELECT u.*, r.slug as role, r.name as role_name, r.id as role_id
         FROM users u
         JOIN roles r ON r.id = u.role_id
         WHERE lower(u.email) = ?`
      )
      .get(email) as
      | {
          id: number;
          name: string;
          email: string;
          password_hash: string;
          is_active: number;
          assigned_tables_json: string;
          role: RoleSlug;
          role_name: string;
          role_id: number;
        }
      | undefined;

    if (!user || !verifyPassword(password, user.password_hash)) {
      writeAudit(null, null, 'login_failed', 'users', email, {}, req.ip || '');
      return res.status(401).json({ error: 'Invalid staff credentials' });
    }
    if (!user.is_active) {
      return res.status(403).json({ error: 'This staff account has been disabled by Admin' });
    }

    const rawToken = generateSecureToken(32);
    db.prepare(
      `INSERT INTO staff_sessions (user_id, token_hash, expires_at)
       VALUES (?, ?, datetime('now', '+12 hours'))`
    ).run(user.id, sha256(rawToken));
    db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);

    const permRows = db
      .prepare(
        `SELECT p.slug FROM permissions p
         JOIN role_permissions rp ON rp.permission_id = p.id
         WHERE rp.role_id = ?`
      )
      .all(user.role_id) as { slug: string }[];

    writeAudit(user.id, user.role, 'login_success', 'users', user.id, {}, req.ip || '');

    res.json({
      token: rawToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        role_name: user.role_name,
        permissions: permRows.map((p) => p.slug),
        assigned_tables: JSON.parse(user.assigned_tables_json || '[]'),
      },
    });
  });

  app.post('/api/auth/logout', requireAuth, (req, res) => {
    const token = String(req.headers.authorization || '').replace('Bearer ', '').trim();
    if (token) {
      db.prepare('DELETE FROM staff_sessions WHERE token_hash = ?').run(sha256(token));
    }
    res.json({ ok: true });
  });

  app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ user: req.staffUser });
  });

  // ==================== 5. KITCHEN DASHBOARD (KDS) ====================

  app.get('/api/kitchen/tickets', requireAuth, requireRole(['chef', 'admin', 'super_admin']), (_req, res) => {
    const tickets = db
      .prepare(
        `SELECT kt.*, o.order_number, o.payment_status, o.special_instructions, dt.table_number, u.name as accepted_by_name
         FROM kitchen_tickets kt
         JOIN orders o ON o.id = kt.order_id
         JOIN dining_tables dt ON dt.id = kt.table_id
         LEFT JOIN users u ON u.id = kt.accepted_by_user_id
         ORDER BY CASE kt.status
           WHEN 'new' THEN 1
           WHEN 'accepted' THEN 2
           WHEN 'preparing' THEN 3
           WHEN 'ready' THEN 4
           WHEN 'served' THEN 5
           ELSE 6 END, kt.id DESC`
      )
      .all() as Array<Record<string, unknown>>;

    const ticketIds = tickets.map((t) => Number(t.id));
    let items: Array<Record<string, unknown>> = [];
    if (ticketIds.length > 0) {
      const ph = ticketIds.map(() => '?').join(',');
      items = db
        .prepare(`SELECT * FROM kitchen_ticket_items WHERE kitchen_ticket_id IN (${ph}) ORDER BY id ASC`)
        .all(...ticketIds) as Array<Record<string, unknown>>;
    }

    res.json({
      tickets: tickets.map((t) => ({
        ...t,
        items: items
          .filter((i) => Number(i.kitchen_ticket_id) === Number(t.id))
          .map((i) => ({ ...i, addons: JSON.parse(String(i.addons_json || '[]')) })),
      })),
    });
  });

  app.post('/api/kitchen/tickets/:id/status', requireAuth, requireRole(['chef', 'admin', 'super_admin']), (req, res) => {
    const ticketId = Number(req.params.id);
    const nextStatus = String(req.body?.status || '') as
      | 'accepted'
      | 'preparing'
      | 'ready'
      | 'served'
      | 'rejected';
    const reason = sanitizeText(req.body?.reason || '', 250);

    if (!['accepted', 'preparing', 'ready', 'served', 'rejected'].includes(nextStatus)) {
      return res.status(400).json({ error: 'Invalid kitchen ticket status' });
    }
    if (nextStatus === 'rejected' && reason.length < 3) {
      return res.status(400).json({ error: 'Rejection reason is required' });
    }

    const ticket = db
      .prepare(
        `SELECT kt.*, o.status as order_status, o.order_number, dt.table_number
         FROM kitchen_tickets kt
         JOIN orders o ON o.id = kt.order_id
         JOIN dining_tables dt ON dt.id = kt.table_id
         WHERE kt.id = ?`
      )
      .get(ticketId) as
      | {
          id: number;
          ticket_number: string;
          order_id: number;
          order_status: string;
          order_number: string;
          table_id: number;
          table_number: number;
          table_session_id: number;
          status: string;
        }
      | undefined;

    if (!ticket) return res.status(404).json({ error: 'Kitchen ticket not found' });

    const orderStatusMap: Record<string, string> = {
      accepted: 'accepted',
      preparing: 'processing',
      ready: 'ready',
      served: 'served',
      rejected: 'rejected',
    };
    const nextOrderStatus = orderStatusMap[nextStatus];

    db.transaction(() => {
      if (nextStatus === 'accepted') {
        db.prepare("UPDATE kitchen_tickets SET status = 'accepted', accepted_by_user_id = ? WHERE id = ?").run(
          req.staffUser!.id,
          ticketId
        );
      } else if (nextStatus === 'preparing') {
        db.prepare(
          "UPDATE kitchen_tickets SET status = 'preparing', accepted_by_user_id = COALESCE(accepted_by_user_id, ?), started_at = COALESCE(started_at, datetime('now')) WHERE id = ?"
        ).run(req.staffUser!.id, ticketId);
      } else if (nextStatus === 'ready') {
        db.prepare("UPDATE kitchen_tickets SET status = 'ready', ready_at = datetime('now') WHERE id = ?").run(ticketId);
      } else if (nextStatus === 'served') {
        db.prepare("UPDATE kitchen_tickets SET status = 'served', served_at = datetime('now') WHERE id = ?").run(ticketId);
      } else if (nextStatus === 'rejected') {
        db.prepare("UPDATE kitchen_tickets SET status = 'rejected', rejection_reason = ? WHERE id = ?").run(
          reason,
          ticketId
        );
        db.prepare("UPDATE orders SET rejection_reason = ? WHERE id = ?").run(reason, ticket.order_id);
      }

      db.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?").run(
        nextOrderStatus,
        ticket.order_id
      );

      db.prepare(
        `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by_user_id, changed_by_role, note)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        ticket.order_id,
        ticket.order_status,
        nextOrderStatus,
        req.staffUser!.id,
        req.staffUser!.role,
        reason || `Kitchen updated ticket ${ticket.ticket_number} to ${nextStatus}`
      );
    })();

    const tLabel = `Table ${String(ticket.table_number).padStart(2, '0')}`;
    if (nextStatus === 'ready') {
      pushNotification('waiter', ticket.table_id, `${ticket.ticket_number} Ready`, `${tLabel} (${ticket.order_number}) is ready to serve!`, 'kitchen', ticket.order_number);
      pushNotification('counter', ticket.table_id, `${ticket.ticket_number} Ready`, `${tLabel} food ready`, 'kitchen', ticket.order_number);
    } else if (nextStatus === 'rejected') {
      pushNotification('counter', ticket.table_id, `${ticket.ticket_number} Rejected`, `${tLabel}: ${reason}`, 'alert', ticket.order_number);
    }

    writeAudit(req.staffUser!.id, req.staffUser!.role, `kitchen_ticket_${nextStatus}`, 'kitchen_tickets', ticketId, { reason });
    realtime.broadcastOrderUpdate(ticket.table_session_id, {
      type: 'kitchen_status_changed',
      ticketId,
      orderId: ticket.order_id,
      status: nextStatus,
      orderStatus: nextOrderStatus,
    });

    res.json({ ok: true, ticket_status: nextStatus, order_status: nextOrderStatus });
  });

  // ==================== 6. COUNTER / POS SYSTEM ====================

  app.get('/api/pos/tables', requireAuth, requireRole(['counter', 'admin', 'super_admin']), (_req, res) => {
    const tables = db
      .prepare(
        `SELECT dt.*, u.name as assigned_waiter_name
         FROM dining_tables dt
         LEFT JOIN users u ON u.id = dt.assigned_waiter_id
         ORDER BY dt.table_number ASC`
      )
      .all() as Array<Record<string, unknown>>;

    const enriched = tables.map((t) => {
      const activeSess = db
        .prepare("SELECT * FROM table_sessions WHERE table_id = ? AND status IN ('active', 'settling') ORDER BY id DESC LIMIT 1")
        .get(t.id) as { id: number; session_code: string; status: string } | undefined;

      if (!activeSess) {
        return {
          ...t,
          active_session_id: null,
          active_session_code: null,
          active_orders_count: 0,
          pending_kitchen_count: 0,
          total_bill_paise: 0,
          paid_paise: 0,
          outstanding_paise: 0,
        };
      }

      const bill = getSessionBillSummary(activeSess.id);
      const pendingKitchen = db
        .prepare(
          "SELECT COUNT(*) as cnt FROM kitchen_tickets WHERE table_session_id = ? AND status IN ('new', 'accepted', 'preparing')"
        )
        .get(activeSess.id) as { cnt: number };

      return {
        ...t,
        active_session_id: activeSess.id,
        active_session_code: activeSess.session_code,
        active_orders_count: bill.orders.filter((o) => {
          const st = String((o as Record<string, unknown>).status || '');
          return st !== 'cancelled' && st !== 'rejected';
        }).length,
        pending_kitchen_count: pendingKitchen.cnt,
        total_bill_paise: bill.totals.grand_total_paise,
        paid_paise: bill.totals.paid_paise,
        outstanding_paise: bill.totals.outstanding_paise,
      };
    });

    res.json({ tables: enriched });
  });

  app.get('/api/pos/orders', requireAuth, requireRole(['counter', 'admin', 'super_admin']), (_req, res) => {
    const orders = db
      .prepare(
        `SELECT o.*, dt.table_number, kt.ticket_number, kt.status as ticket_status
         FROM orders o
         JOIN dining_tables dt ON dt.id = o.table_id
         LEFT JOIN kitchen_tickets kt ON kt.order_id = o.id
         ORDER BY o.id DESC LIMIT 100`
      )
      .all() as Array<Record<string, unknown>>;

    res.json({ orders: hydrateOrders(orders) });
  });

  app.get('/api/pos/tables/:id/bill', requireAuth, requireRole(['counter', 'admin', 'super_admin', 'waiter']), (req, res) => {
    const tableId = Number(req.params.id);
    const table = db.prepare('SELECT * FROM dining_tables WHERE id = ?').get(tableId) as Record<string, unknown> | undefined;
    if (!table) return res.status(404).json({ error: 'Table not found' });

    const activeSess = db
      .prepare("SELECT * FROM table_sessions WHERE table_id = ? AND status IN ('active', 'settling') ORDER BY id DESC LIMIT 1")
      .get(tableId) as { id: number; session_code: string; status: string; opened_at: string } | undefined;

    if (!activeSess) {
      return res.json({ table, session: null, orders: [], payments: [], totals: null });
    }

    const bill = getSessionBillSummary(activeSess.id);
    res.json({ table, session: activeSess, ...bill });
  });

  // Counter Manual Payment (Cash / UPI / Card) — only authorized counter/admin staff
  app.post('/api/pos/payments/record', requireAuth, requireRole(['counter', 'admin', 'super_admin']), (req, res) => {
    const schema = z.object({
      table_id: z.number().int().positive(),
      order_id: z.number().int().positive().optional().nullable(),
      amount_paise: z.number().int().positive(),
      method: z.enum(['cash', 'upi', 'card']),
      confirm_received: z.boolean(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success || !parsed.data.confirm_received) {
      return res.status(400).json({ error: 'Authorized confirmation of receipt and valid amount are required.' });
    }
    const { table_id, order_id, amount_paise, method } = parsed.data;

    const activeSess = db
      .prepare("SELECT * FROM table_sessions WHERE table_id = ? AND status IN ('active', 'settling') ORDER BY id DESC LIMIT 1")
      .get(table_id) as { id: number } | undefined;

    if (!activeSess) {
      return res.status(400).json({ error: 'No active table session found for this table' });
    }

    const payRes = db.transaction(() => {
      const pRef = `pos_${generateSecureToken(8)}`;
      const ins = db
        .prepare(
          `INSERT INTO payments (order_id, table_session_id, provider, provider_order_id, provider_payment_id, amount_paise, method, status, recorded_by_user_id)
           VALUES (?, ?, 'counter_pos', ?, ?, ?, ?, 'captured', ?)`
        )
        .run(order_id || null, activeSess.id, pRef, pRef, amount_paise, method, req.staffUser!.id);

      // If total paid now covers unpaid pending orders in this session, mark them paid & create kitchen tickets if missing
      const summary = getSessionBillSummary(activeSess.id);
      if (summary.totals.outstanding_paise <= 0) {
        const pendingOrders = db
          .prepare("SELECT id FROM orders WHERE table_session_id = ? AND payment_status != 'paid' AND status NOT IN ('cancelled', 'rejected')")
          .all(activeSess.id) as { id: number }[];
        for (const po of pendingOrders) {
          db.prepare("UPDATE orders SET payment_status = 'paid', updated_at = datetime('now') WHERE id = ?").run(po.id);
        }
      } else if (order_id) {
        const ord = db.prepare('SELECT total_paise FROM orders WHERE id = ?').get(order_id) as { total_paise: number } | undefined;
        if (ord && amount_paise >= ord.total_paise) {
          db.prepare("UPDATE orders SET payment_status = 'paid', updated_at = datetime('now') WHERE id = ?").run(order_id);
        }
      }

      return { paymentId: Number(ins.lastInsertRowid), summary: getSessionBillSummary(activeSess.id) };
    })();

    writeAudit(req.staffUser!.id, req.staffUser!.role, 'pos_payment_recorded', 'payments', payRes.paymentId, {
      table_id,
      amount_paise,
      method,
    });
    realtime.broadcastOrderUpdate(activeSess.id, { type: 'pos_payment_recorded', tableId: table_id });

    res.status(201).json({ ok: true, payment_id: payRes.paymentId, totals: payRes.summary.totals });
  });

  app.post('/api/pos/refunds', requireAuth, requireRole(['counter', 'admin', 'super_admin']), (req, res) => {
    const schema = z.object({
      payment_id: z.number().int().positive(),
      amount_paise: z.number().int().positive(),
      reason: z.string().min(3).max(250),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Valid payment ID, amount, and reason required.' });

    const { payment_id, amount_paise, reason } = parsed.data;
    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(payment_id) as
      | { id: number; order_id: number | null; table_session_id: number; amount_paise: number; status: string }
      | undefined;

    if (!payment || payment.status !== 'captured') {
      return res.status(400).json({ error: 'Only captured payments can be refunded' });
    }
    if (amount_paise > payment.amount_paise) {
      return res.status(400).json({ error: 'Refund amount cannot exceed captured payment amount' });
    }

    db.transaction(() => {
      db.prepare(
        `INSERT INTO refunds (payment_id, order_id, amount_paise, reason, status, processed_by_user_id)
         VALUES (?, ?, ?, ?, 'processed', ?)`
      ).run(payment.id, payment.order_id, amount_paise, sanitizeText(reason, 250), req.staffUser!.id);

      db.prepare("UPDATE payments SET status = 'refunded' WHERE id = ?").run(payment.id);
      if (payment.order_id) {
        db.prepare("UPDATE orders SET payment_status = 'refunded', updated_at = datetime('now') WHERE id = ?").run(
          payment.order_id
        );
      }
    })();

    writeAudit(req.staffUser!.id, req.staffUser!.role, 'refund_processed', 'payments', payment_id, { amount_paise, reason });
    realtime.broadcastOrderUpdate(payment.table_session_id, { type: 'refund_processed', paymentId: payment_id });
    res.json({ ok: true });
  });

  app.post('/api/pos/tables/:id/transfer', requireAuth, requireRole(['counter', 'admin', 'super_admin']), (req, res) => {
    const sourceTableId = Number(req.params.id);
    const targetTableId = Number(req.body?.target_table_id);
    if (!targetTableId || sourceTableId === targetTableId) {
      return res.status(400).json({ error: 'Valid target table ID required' });
    }

    const targetTable = db.prepare('SELECT * FROM dining_tables WHERE id = ?').get(targetTableId) as
      | { id: number; table_number: number; status: string }
      | undefined;
    if (!targetTable || targetTable.status === 'occupied') {
      return res.status(400).json({ error: 'Target table must be available for transfer' });
    }

    const activeSess = db
      .prepare("SELECT * FROM table_sessions WHERE table_id = ? AND status IN ('active', 'settling') ORDER BY id DESC LIMIT 1")
      .get(sourceTableId) as { id: number } | undefined;

    if (!activeSess) {
      return res.status(400).json({ error: 'No active session on source table' });
    }

    db.transaction(() => {
      db.prepare('UPDATE table_sessions SET table_id = ? WHERE id = ?').run(targetTableId, activeSess.id);
      db.prepare('UPDATE table_access_tokens SET table_id = ? WHERE session_id = ?').run(targetTableId, activeSess.id);
      db.prepare('UPDATE orders SET table_id = ? WHERE table_session_id = ?').run(targetTableId, activeSess.id);
      db.prepare('UPDATE kitchen_tickets SET table_id = ? WHERE table_session_id = ?').run(targetTableId, activeSess.id);
      db.prepare("UPDATE dining_tables SET status = 'available' WHERE id = ?").run(sourceTableId);
      db.prepare("UPDATE dining_tables SET status = 'occupied' WHERE id = ?").run(targetTableId);
    })();

    writeAudit(req.staffUser!.id, req.staffUser!.role, 'table_session_transferred', 'table_sessions', activeSess.id, {
      from: sourceTableId,
      to: targetTableId,
    });
    realtime.broadcastOrderUpdate(activeSess.id, { type: 'table_transferred', from: sourceTableId, to: targetTableId });
    res.json({ ok: true });
  });

  app.post('/api/pos/orders/:id/cancel-item', requireAuth, requireRole(['counter', 'admin', 'super_admin']), (req, res) => {
    const orderItemId = Number(req.params.id);
    const reason = sanitizeText(req.body?.reason || 'Cancelled by counter staff', 200);

    const oi = db.prepare('SELECT * FROM order_items WHERE id = ?').get(orderItemId) as
      | { id: number; order_id: number; is_cancelled: number }
      | undefined;
    if (!oi || oi.is_cancelled) {
      return res.status(404).json({ error: 'Order item not found or already cancelled' });
    }

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(oi.order_id) as {
      id: number;
      table_session_id: number;
      discount_paise: number;
    };

    db.transaction(() => {
      db.prepare('UPDATE order_items SET is_cancelled = 1, cancel_reason = ? WHERE id = ?').run(reason, orderItemId);
      const remaining = db
        .prepare('SELECT COALESCE(SUM(line_total_paise), 0) as sub FROM order_items WHERE order_id = ? AND is_cancelled = 0')
        .get(order.id) as { sub: number };
      const settings = db.prepare('SELECT gst_rate_bps, service_charge_bps FROM restaurant_settings LIMIT 1').get() as {
        gst_rate_bps: number;
        service_charge_bps: number;
      };
      const taxable = Math.max(0, remaining.sub - order.discount_paise);
      const gst = Math.round((taxable * settings.gst_rate_bps) / 10000);
      const svc = Math.round((taxable * settings.service_charge_bps) / 10000);
      const total = taxable + gst + svc;
      db.prepare(
        `UPDATE orders SET subtotal_paise = ?, gst_paise = ?, service_charge_paise = ?, total_paise = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(remaining.sub, gst, svc, total, order.id);
      if (remaining.sub === 0) {
        db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(order.id);
        db.prepare("UPDATE kitchen_tickets SET status = 'cancelled' WHERE order_id = ?").run(order.id);
      }
    })();

    writeAudit(req.staffUser!.id, req.staffUser!.role, 'order_item_cancelled', 'order_items', orderItemId, { reason });
    realtime.broadcastOrderUpdate(order.table_session_id, { type: 'item_cancelled', orderId: order.id });
    res.json({ ok: true });
  });

  app.post('/api/pos/tables/:id/close', requireAuth, requireRole(['counter', 'admin', 'super_admin']), (req, res) => {
    const tableId = Number(req.params.id);
    const activeSess = db
      .prepare("SELECT * FROM table_sessions WHERE table_id = ? AND status IN ('active', 'settling') ORDER BY id DESC LIMIT 1")
      .get(tableId) as { id: number; session_code: string } | undefined;

    if (!activeSess) {
      return res.status(400).json({ error: 'No active session to close on this table' });
    }

    const summary = getSessionBillSummary(activeSess.id);
    if (summary.totals.outstanding_paise > 0) {
      return res.status(400).json({
        error: `Cannot close table session with ₹${(summary.totals.outstanding_paise / 100).toFixed(2)} outstanding balance. Please settle payment first.`,
      });
    }

    const invoice = db.transaction(() => {
      const invSeq = db.prepare('SELECT COALESCE(MAX(id), 100) + 1 as nxt FROM invoices').get() as { nxt: number };
      const invoiceNumber = `INV-2026-${String(invSeq.nxt).padStart(3, '0')}`;
      const invRes = db
        .prepare(
          `INSERT INTO invoices (invoice_number, table_session_id, table_id, subtotal_paise, gst_paise, service_charge_paise, discount_paise, grand_total_paise, paid_paise, payment_status, generated_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?)`
        )
        .run(
          invoiceNumber,
          activeSess.id,
          tableId,
          summary.totals.subtotal_paise,
          summary.totals.gst_paise,
          summary.totals.service_charge_paise,
          summary.totals.discount_paise,
          summary.totals.grand_total_paise,
          summary.totals.paid_paise,
          req.staffUser!.id
        );

      db.prepare("UPDATE orders SET status = 'completed', updated_at = datetime('now') WHERE table_session_id = ? AND status NOT IN ('cancelled', 'rejected')").run(
        activeSess.id
      );
      db.prepare("UPDATE kitchen_tickets SET status = 'served' WHERE table_session_id = ? AND status IN ('ready')").run(
        activeSess.id
      );
      db.prepare("UPDATE table_sessions SET status = 'closed', closed_at = datetime('now'), closed_by_user_id = ? WHERE id = ?").run(
        req.staffUser!.id,
        activeSess.id
      );
      db.prepare("UPDATE dining_tables SET status = 'available' WHERE id = ?").run(tableId);

      return db
        .prepare('SELECT i.*, dt.table_number FROM invoices i JOIN dining_tables dt ON dt.id = i.table_id WHERE i.id = ?')
        .get(Number(invRes.lastInsertRowid));
    })();

    writeAudit(req.staffUser!.id, req.staffUser!.role, 'table_session_closed', 'table_sessions', activeSess.id, {
      tableId,
    });
    realtime.broadcastOrderUpdate(activeSess.id, { type: 'session_closed', tableId });
    res.json({ ok: true, invoice });
  });

  app.get('/api/pos/invoices', requireAuth, requireRole(['counter', 'admin', 'super_admin']), (_req, res) => {
    const invoices = db
      .prepare(
        `SELECT i.*, dt.table_number
         FROM invoices i
         JOIN dining_tables dt ON dt.id = i.table_id
         ORDER BY i.id DESC LIMIT 50`
      )
      .all();
    res.json({ invoices });
  });

  // ==================== 7. WAITER DASHBOARD ====================

  app.get('/api/waiter/overview', requireAuth, requireRole(['waiter', 'counter', 'admin', 'super_admin']), (req, res) => {
    const assigned = req.staffUser!.assigned_tables;
    const allTables = db.prepare('SELECT * FROM dining_tables ORDER BY table_number ASC').all() as Array<Record<string, unknown>>;
    const tables =
      req.staffUser!.role === 'waiter' && assigned.length > 0
        ? allTables.filter((t) => assigned.includes(Number(t.table_number)))
        : allTables;

    const readyTickets = db
      .prepare(
        `SELECT kt.*, o.order_number, dt.table_number, o.special_instructions
         FROM kitchen_tickets kt
         JOIN orders o ON o.id = kt.order_id
         JOIN dining_tables dt ON dt.id = kt.table_id
         WHERE kt.status IN ('new', 'accepted', 'preparing', 'ready')
         ORDER BY CASE kt.status WHEN 'ready' THEN 1 ELSE 2 END, kt.id ASC`
      )
      .all() as Array<Record<string, unknown>>;

    const ticketIds = readyTickets.map((t) => Number(t.id));
    let items: Array<Record<string, unknown>> = [];
    if (ticketIds.length > 0) {
      const ph = ticketIds.map(() => '?').join(',');
      items = db.prepare(`SELECT * FROM kitchen_ticket_items WHERE kitchen_ticket_id IN (${ph})`).all(...ticketIds) as Array<
        Record<string, unknown>
      >;
    }

    res.json({
      tables,
      tickets: readyTickets.map((t) => ({
        ...t,
        items: items.filter((i) => Number(i.kitchen_ticket_id) === Number(t.id)),
      })),
    });
  });

  app.post('/api/waiter/tickets/:id/serve', requireAuth, requireRole(['waiter', 'counter', 'admin', 'super_admin']), (req, res) => {
    const ticketId = Number(req.params.id);
    const ticket = db.prepare('SELECT * FROM kitchen_tickets WHERE id = ?').get(ticketId) as
      | { id: number; order_id: number; table_session_id: number; status: string; ticket_number: string }
      | undefined;

    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (ticket.status !== 'ready') {
      return res.status(400).json({ error: 'Only Ready tickets can be marked as Served' });
    }

    db.transaction(() => {
      db.prepare("UPDATE kitchen_tickets SET status = 'served', served_at = datetime('now') WHERE id = ?").run(ticketId);
      db.prepare("UPDATE orders SET status = 'served', updated_at = datetime('now') WHERE id = ?").run(ticket.order_id);
      db.prepare(
        `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by_user_id, changed_by_role, note)
         VALUES (?, 'ready', 'served', ?, ?, 'Delivered to guest table')`
      ).run(ticket.order_id, req.staffUser!.id, req.staffUser!.role);
    })();

    realtime.broadcastOrderUpdate(ticket.table_session_id, {
      type: 'order_served',
      ticketId,
      orderId: ticket.order_id,
    });
    res.json({ ok: true });
  });

  // ==================== 8. ADMIN & SUPER ADMIN ====================

  app.get('/api/admin/overview', requireAuth, requireRole(['admin', 'super_admin']), (_req, res) => {
    const todayRevenue = db
      .prepare("SELECT COALESCE(SUM(amount_paise), 0) as rev FROM payments WHERE status = 'captured' AND date(created_at) = date('now')")
      .get() as { rev: number };
    const totalRevenue = db
      .prepare("SELECT COALESCE(SUM(amount_paise), 0) as rev FROM payments WHERE status = 'captured'")
      .get() as { rev: number };
    const counts = db
      .prepare(
        `SELECT
          COUNT(*) as total_orders,
          SUM(CASE WHEN status IN ('placed', 'accepted', 'processing', 'ready', 'served') THEN 1 ELSE 0 END) as active_orders,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_orders,
          SUM(CASE WHEN status IN ('cancelled', 'rejected') THEN 1 ELSE 0 END) as cancelled_orders
         FROM orders`
      )
      .get() as { total_orders: number; active_orders: number; completed_orders: number; cancelled_orders: number };

    const tableCounts = db
      .prepare(
        `SELECT
          SUM(CASE WHEN status = 'occupied' THEN 1 ELSE 0 END) as occupied_tables,
          SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) as available_tables
         FROM dining_tables`
      )
      .get() as { occupied_tables: number; available_tables: number };

    const aovRow = db
      .prepare("SELECT COALESCE(AVG(total_paise), 0) as aov FROM orders WHERE status NOT IN ('cancelled', 'rejected')")
      .get() as { aov: number };

    const popularItems = db
      .prepare(
        `SELECT item_name, SUM(quantity) as total_qty, SUM(line_total_paise) as total_sales_paise
         FROM order_items WHERE is_cancelled = 0
         GROUP BY item_name ORDER BY total_qty DESC LIMIT 6`
      )
      .all();

    const dailySales = db
      .prepare(
        `SELECT date(created_at) as day, COUNT(*) as orders_count, SUM(total_paise) as revenue_paise
         FROM orders WHERE status NOT IN ('cancelled', 'rejected')
         GROUP BY date(created_at) ORDER BY day ASC LIMIT 14`
      )
      .all();

    const recentTransactions = db
      .prepare(
        `SELECT p.*, o.order_number, dt.table_number
         FROM payments p
         LEFT JOIN orders o ON o.id = p.order_id
         LEFT JOIN table_sessions ts ON ts.id = p.table_session_id
         LEFT JOIN dining_tables dt ON dt.id = ts.table_id
         ORDER BY p.id DESC LIMIT 12`
      )
      .all();

    res.json({
      kpis: {
        today_revenue_paise: todayRevenue.rev,
        total_revenue_paise: totalRevenue.rev,
        total_orders: counts.total_orders,
        active_orders: counts.active_orders,
        completed_orders: counts.completed_orders,
        cancelled_orders: counts.cancelled_orders,
        occupied_tables: tableCounts.occupied_tables,
        available_tables: tableCounts.available_tables,
        average_order_value_paise: Math.round(aovRow.aov),
      },
      popular_items: popularItems,
      daily_sales: dailySales,
      recent_transactions: recentTransactions,
    });
  });

  // Menu Management CRUD
  app.post('/api/admin/menu/items', requireAuth, requireRole(['admin', 'super_admin']), (req, res) => {
    const schema = z.object({
      category_id: z.number().int().positive(),
      name: z.string().min(2).max(120),
      description: z.string().min(3).max(500),
      price_inr: z.number().positive(),
      image_url: z.string().max(400).optional(),
      is_veg: z.boolean().optional(),
      is_bestseller: z.boolean().optional(),
      is_available: z.boolean().optional(),
      prep_time_mins: z.number().int().min(1).max(120).optional(),
      variants: z.array(z.object({ name: z.string(), price_delta_paise: z.number().int() })).optional(),
      addons: z.array(z.object({ name: z.string(), price_paise: z.number().int() })).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid menu item details' });

    const d = parsed.data;
    const slug = `${d.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36)}`;
    const img = d.image_url || '/src/assets/images/dish_indian_curries_1795504318494.jpg';

    const ins = db
      .prepare(
        `INSERT INTO menu_items (category_id, name, slug, description, price_paise, image_url, is_veg, is_bestseller, is_available, prep_time_mins, variants_json, addons_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        d.category_id,
        sanitizeText(d.name, 120),
        slug,
        sanitizeText(d.description, 500),
        Math.round(d.price_inr * 100),
        img,
        d.is_veg === false ? 0 : 1,
        d.is_bestseller ? 1 : 0,
        d.is_available === false ? 0 : 1,
        d.prep_time_mins || 15,
        JSON.stringify(d.variants || []),
        JSON.stringify(d.addons || [])
      );

    writeAudit(req.staffUser!.id, req.staffUser!.role, 'menu_item_created', 'menu_items', Number(ins.lastInsertRowid), { name: d.name });
    realtime.broadcastMenuUpdate();
    res.status(201).json({ id: Number(ins.lastInsertRowid) });
  });

  app.put('/api/admin/menu/items/:id', requireAuth, requireRole(['admin', 'super_admin']), (req, res) => {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!existing) return res.status(404).json({ error: 'Menu item not found' });

    const d = req.body || {};
    db.prepare(
      `UPDATE menu_items SET
        category_id = ?, name = ?, description = ?, price_paise = ?, image_url = ?,
        is_veg = ?, is_bestseller = ?, is_available = ?, prep_time_mins = ?,
        variants_json = ?, addons_json = ?
       WHERE id = ?`
    ).run(
      d.category_id ?? existing.category_id,
      d.name ? sanitizeText(d.name, 120) : existing.name,
      d.description ? sanitizeText(d.description, 500) : existing.description,
      d.price_inr !== undefined ? Math.round(Number(d.price_inr) * 100) : existing.price_paise,
      d.image_url ?? existing.image_url,
      d.is_veg !== undefined ? (d.is_veg ? 1 : 0) : existing.is_veg,
      d.is_bestseller !== undefined ? (d.is_bestseller ? 1 : 0) : existing.is_bestseller,
      d.is_available !== undefined ? (d.is_available ? 1 : 0) : existing.is_available,
      d.prep_time_mins ?? existing.prep_time_mins,
      d.variants !== undefined ? JSON.stringify(d.variants) : existing.variants_json,
      d.addons !== undefined ? JSON.stringify(d.addons) : existing.addons_json,
      id
    );

    writeAudit(req.staffUser!.id, req.staffUser!.role, 'menu_item_updated', 'menu_items', id);
    realtime.broadcastMenuUpdate();
    res.json({ ok: true });
  });

  app.delete('/api/admin/menu/items/:id', requireAuth, requireRole(['admin', 'super_admin']), (req, res) => {
    const id = Number(req.params.id);
    const usedCount = db.prepare('SELECT COUNT(*) as cnt FROM order_items WHERE menu_item_id = ?').get(id) as { cnt: number };
    if (usedCount.cnt > 0) {
      db.prepare('UPDATE menu_items SET is_available = 0 WHERE id = ?').run(id);
      realtime.broadcastMenuUpdate();
      return res.json({ ok: true, archived: true, message: 'Item has historical orders so it was marked unavailable.' });
    }
    db.prepare('DELETE FROM menu_items WHERE id = ?').run(id);
    realtime.broadcastMenuUpdate();
    res.json({ ok: true });
  });

  app.post('/api/admin/menu/categories', requireAuth, requireRole(['admin', 'super_admin']), (req, res) => {
    const name = sanitizeText(req.body?.name, 80);
    const description = sanitizeText(req.body?.description || '', 300);
    const sortOrder = Number(req.body?.sort_order || 99);
    if (!name) return res.status(400).json({ error: 'Category name required' });

    const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36)}`;
    const ins = db
      .prepare(
        `INSERT INTO menu_categories (restaurant_id, name, slug, description, image_url, sort_order, is_active)
         VALUES (1, ?, ?, ?, '/src/assets/images/dish_indian_curries_1795504318494.jpg', ?, 1)`
      )
      .run(name, slug, description, sortOrder);
    realtime.broadcastMenuUpdate();
    res.status(201).json({ id: Number(ins.lastInsertRowid) });
  });

  app.put('/api/admin/menu/categories/:id', requireAuth, requireRole(['admin', 'super_admin']), (req, res) => {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM menu_categories WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!existing) return res.status(404).json({ error: 'Category not found' });

    db.prepare('UPDATE menu_categories SET name = ?, description = ?, sort_order = ?, is_active = ? WHERE id = ?').run(
      req.body?.name ? sanitizeText(req.body.name, 80) : existing.name,
      req.body?.description !== undefined ? sanitizeText(req.body.description, 300) : existing.description,
      req.body?.sort_order ?? existing.sort_order,
      req.body?.is_active !== undefined ? (req.body.is_active ? 1 : 0) : existing.is_active,
      id
    );
    realtime.broadcastMenuUpdate();
    res.json({ ok: true });
  });

  // Table & QR Code Management
  app.get('/api/admin/tables/qrs', requireAuth, requireRole(['admin', 'super_admin', 'counter']), async (req, res) => {
    const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
    const proto = forwardedProto || req.protocol || 'https';
    const baseUrl = `${proto}://${req.get('host')}`;
    const rows = db
      .prepare(
        `SELECT dt.*, tqr.token_value, tqr.created_at as token_created_at
         FROM dining_tables dt
         LEFT JOIN table_qr_tokens tqr ON tqr.table_id = dt.id AND tqr.is_active = 1
         ORDER BY dt.table_number ASC`
      )
      .all() as Array<Record<string, unknown>>;

    const withQr = await Promise.all(
      rows.map(async (row) => {
        const relativeUrl = `/order?table=${row.table_number}&token=${row.token_value || ''}`;
        const fullUrl = `${baseUrl}${relativeUrl}`;
        const qrDataUrl = await QRCode.toDataURL(fullUrl, { width: 280, margin: 2, color: { dark: '#18181B', light: '#FFFFFF' } });
        return {
          ...row,
          qr_relative_url: relativeUrl,
          qr_full_url: fullUrl,
          qr_data_url: qrDataUrl,
        };
      })
    );

    res.json({ tables: withQr });
  });

  app.post('/api/admin/tables', requireAuth, requireRole(['admin', 'super_admin']), (req, res) => {
    const tableNumber = Number(req.body?.table_number);
    const capacity = Number(req.body?.capacity || 4);
    const section = sanitizeText(req.body?.section || 'Main Hall', 60);
    if (!Number.isInteger(tableNumber) || tableNumber < 1) {
      return res.status(400).json({ error: 'Valid positive table number required' });
    }

    try {
      const created = db.transaction(() => {
        const label = `Table ${String(tableNumber).padStart(2, '0')}`;
        const ins = db
          .prepare(
            "INSERT INTO dining_tables (restaurant_id, table_number, label, capacity, section, status) VALUES (1, ?, ?, ?, ?, 'available')"
          )
          .run(tableNumber, label, capacity, section);
        const tableId = Number(ins.lastInsertRowid);
        const rawToken = generateSecureToken(20);
        db.prepare('INSERT INTO table_qr_tokens (table_id, token_hash, token_value, is_active) VALUES (?, ?, ?, 1)').run(
          tableId,
          sha256(rawToken),
          rawToken
        );
        return { id: tableId, table_number: tableNumber, token: rawToken };
      })();
      writeAudit(req.staffUser!.id, req.staffUser!.role, 'table_created', 'dining_tables', created.id);
      res.status(201).json(created);
    } catch {
      res.status(400).json({ error: `Table ${tableNumber} already exists` });
    }
  });

  app.post('/api/admin/tables/:id/regenerate-qr', requireAuth, requireRole(['admin', 'super_admin']), (req, res) => {
    const tableId = Number(req.params.id);
    const table = db.prepare('SELECT * FROM dining_tables WHERE id = ?').get(tableId) as { table_number: number } | undefined;
    if (!table) return res.status(404).json({ error: 'Table not found' });

    const newToken = generateSecureToken(20);
    db.transaction(() => {
      db.prepare("UPDATE table_qr_tokens SET is_active = 0, revoked_at = datetime('now') WHERE table_id = ? AND is_active = 1").run(tableId);
      db.prepare('INSERT INTO table_qr_tokens (table_id, token_hash, token_value, is_active) VALUES (?, ?, ?, 1)').run(
        tableId,
        sha256(newToken),
        newToken
      );
    })();

    writeAudit(req.staffUser!.id, req.staffUser!.role, 'qr_token_regenerated', 'dining_tables', tableId);
    res.json({ ok: true, table_number: table.table_number, token: newToken });
  });

  // Staff Management
  app.get('/api/admin/staff', requireAuth, requireRole(['admin', 'super_admin']), (_req, res) => {
    const users = db
      .prepare(
        `SELECT u.id, u.name, u.email, u.phone, u.is_active, u.assigned_tables_json, u.last_login_at, r.slug as role, r.name as role_name
         FROM users u
         JOIN roles r ON r.id = u.role_id
         ORDER BY u.id ASC`
      )
      .all() as Array<Record<string, unknown>>;

    res.json({
      staff: users.map((u) => ({
        ...u,
        assigned_tables: JSON.parse(String(u.assigned_tables_json || '[]')),
      })),
    });
  });

  app.post('/api/admin/staff', requireAuth, requireRole(['super_admin', 'admin']), (req, res) => {
    const schema = z.object({
      name: z.string().min(2).max(100),
      email: z.string().email(),
      phone: z.string().max(20).optional(),
      password: z.string().min(6).max(100),
      role: z.enum(['super_admin', 'admin', 'chef', 'counter', 'waiter']),
      assigned_tables: z.array(z.number().int()).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Valid staff fields and password (6+ chars) required' });

    const d = parsed.data;
    if (d.role === 'super_admin' && req.staffUser!.role !== 'super_admin') {
      return res.status(403).json({ error: 'Only Super Admin can create Super Admin accounts' });
    }
    const roleRow = db.prepare('SELECT id FROM roles WHERE slug = ?').get(d.role) as { id: number } | undefined;
    if (!roleRow) return res.status(400).json({ error: 'Role not found' });

    try {
      const ins = db
        .prepare(
          'INSERT INTO users (name, email, phone, password_hash, role_id, is_active, assigned_tables_json) VALUES (?, ?, ?, ?, ?, 1, ?)'
        )
        .run(
          sanitizeText(d.name, 100),
          d.email.toLowerCase(),
          sanitizeText(d.phone || '', 20),
          hashPassword(d.password),
          roleRow.id,
          JSON.stringify(d.assigned_tables || [])
        );
      writeAudit(req.staffUser!.id, req.staffUser!.role, 'staff_created', 'users', Number(ins.lastInsertRowid), { role: d.role });
      res.status(201).json({ id: Number(ins.lastInsertRowid) });
    } catch {
      res.status(400).json({ error: 'Email already registered' });
    }
  });

  app.put('/api/admin/staff/:id', requireAuth, requireRole(['super_admin', 'admin']), (req, res) => {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!existing) return res.status(404).json({ error: 'Staff member not found' });

    const roleSlug = req.body?.role;
    let roleId = Number(existing.role_id);
    if (roleSlug) {
      if (roleSlug === 'super_admin' && req.staffUser!.role !== 'super_admin') {
        return res.status(403).json({ error: 'Only Super Admin can assign Super Admin role' });
      }
      const r = db.prepare('SELECT id FROM roles WHERE slug = ?').get(roleSlug) as { id: number } | undefined;
      if (r) roleId = r.id;
    }

    db.prepare('UPDATE users SET name = ?, phone = ?, role_id = ?, is_active = ?, assigned_tables_json = ? WHERE id = ?').run(
      req.body?.name ? sanitizeText(req.body.name, 100) : existing.name,
      req.body?.phone !== undefined ? sanitizeText(req.body.phone, 20) : existing.phone,
      roleId,
      req.body?.is_active !== undefined ? (req.body.is_active ? 1 : 0) : existing.is_active,
      req.body?.assigned_tables !== undefined ? JSON.stringify(req.body.assigned_tables) : existing.assigned_tables_json,
      id
    );

    writeAudit(req.staffUser!.id, req.staffUser!.role, 'staff_updated', 'users', id);
    res.json({ ok: true });
  });

  // Coupons & Offers
  app.get('/api/admin/coupons', requireAuth, requireRole(['admin', 'super_admin']), (_req, res) => {
    res.json({ coupons: db.prepare('SELECT * FROM coupons ORDER BY id DESC').all() });
  });

  app.post('/api/admin/coupons', requireAuth, requireRole(['admin', 'super_admin']), (req, res) => {
    const schema = z.object({
      code: z.string().min(3).max(30),
      description: z.string().min(3).max(200),
      discount_type: z.enum(['percent', 'fixed']),
      discount_value: z.number().int().positive(),
      min_order_inr: z.number().min(0),
      max_discount_inr: z.number().nullable().optional(),
      usage_limit: z.number().int().positive().optional(),
      valid_until: z.string().min(8),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid coupon configuration' });
    const d = parsed.data;
    const val = d.discount_type === 'fixed' ? d.discount_value * 100 : d.discount_value;
    try {
      const ins = db
        .prepare(
          `INSERT INTO coupons (code, description, discount_type, discount_value, min_order_paise, max_discount_paise, usage_limit, valid_from, valid_until, is_active)
           VALUES (?, ?, ?, ?, ?, ?, ?, date('now'), ?, 1)`
        )
        .run(
          d.code.toUpperCase(),
          sanitizeText(d.description, 200),
          d.discount_type,
          val,
          Math.round(d.min_order_inr * 100),
          d.max_discount_inr ? Math.round(d.max_discount_inr * 100) : null,
          d.usage_limit || 500,
          d.valid_until
        );
      res.status(201).json({ id: Number(ins.lastInsertRowid) });
    } catch {
      res.status(400).json({ error: 'Coupon code already exists' });
    }
  });

  // Reservations Management
  app.get('/api/admin/reservations', requireAuth, requireRole(['admin', 'super_admin', 'counter']), (_req, res) => {
    const rows = db
      .prepare(
        `SELECT r.*, dt.table_number
         FROM reservations r
         LEFT JOIN dining_tables dt ON dt.id = r.table_id
         ORDER BY r.reservation_date DESC, r.id DESC`
      )
      .all();
    res.json({ reservations: rows });
  });

  app.put('/api/admin/reservations/:id', requireAuth, requireRole(['admin', 'super_admin', 'counter']), (req, res) => {
    const id = Number(req.params.id);
    const status = String(req.body?.status || '');
    const tableId = req.body?.table_id ? Number(req.body.table_id) : null;
    if (!['pending', 'confirmed', 'seated', 'rejected', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'Invalid reservation status' });
    }
    db.prepare('UPDATE reservations SET status = ?, table_id = COALESCE(?, table_id), reviewed_by_user_id = ? WHERE id = ?').run(
      status,
      tableId,
      req.staffUser!.id,
      id
    );
    if (status === 'confirmed' && tableId) {
      db.prepare("UPDATE dining_tables SET status = 'reserved' WHERE id = ? AND status = 'available'").run(tableId);
    }
    res.json({ ok: true });
  });

  // Settings Management
  app.put('/api/admin/settings', requireAuth, requireRole(['admin', 'super_admin']), (req, res) => {
    const b = req.body || {};
    db.transaction(() => {
      if (b.name || b.tagline || b.address || b.phone || b.email || b.gstin) {
        const cur = db.prepare('SELECT * FROM restaurants LIMIT 1').get() as Record<string, unknown>;
        db.prepare(
          `UPDATE restaurants SET name = ?, tagline = ?, description = ?, address = ?, phone = ?, email = ?, gstin = ? WHERE id = ?`
        ).run(
          b.name ? sanitizeText(b.name, 120) : cur.name,
          b.tagline ? sanitizeText(b.tagline, 200) : cur.tagline,
          b.description ? sanitizeText(b.description, 600) : cur.description,
          b.address ? sanitizeText(b.address, 250) : cur.address,
          b.phone ? sanitizeText(b.phone, 30) : cur.phone,
          b.email ? sanitizeText(b.email, 120) : cur.email,
          b.gstin ? sanitizeText(b.gstin, 30) : cur.gstin,
          cur.id
        );
      }
      if (b.gst_rate_bps !== undefined || b.service_charge_bps !== undefined || b.auto_accept_kitchen !== undefined) {
        const curSet = db.prepare('SELECT * FROM restaurant_settings LIMIT 1').get() as Record<string, unknown>;
        db.prepare(
          `UPDATE restaurant_settings SET gst_rate_bps = ?, service_charge_bps = ?, auto_accept_kitchen = ?, updated_at = datetime('now') WHERE id = ?`
        ).run(
          b.gst_rate_bps ?? curSet.gst_rate_bps,
          b.service_charge_bps ?? curSet.service_charge_bps,
          b.auto_accept_kitchen !== undefined ? (b.auto_accept_kitchen ? 1 : 0) : curSet.auto_accept_kitchen,
          curSet.id
        );
      }
    })();
    writeAudit(req.staffUser!.id, req.staffUser!.role, 'settings_updated', 'restaurants', 1);
    res.json({ ok: true });
  });

  // Financial & Operational Reports
  app.get('/api/admin/reports', requireAuth, requireRole(['admin', 'super_admin', 'counter']), (_req, res) => {
    const itemWise = db
      .prepare(
        `SELECT oi.item_name, mc.name as category_name, SUM(oi.quantity) as qty, SUM(oi.line_total_paise) as revenue_paise
         FROM order_items oi
         JOIN menu_items mi ON mi.id = oi.menu_item_id
         JOIN menu_categories mc ON mc.id = mi.category_id
         WHERE oi.is_cancelled = 0
         GROUP BY oi.item_name, mc.name
         ORDER BY revenue_paise DESC`
      )
      .all();

    const categoryWise = db
      .prepare(
        `SELECT mc.name as category_name, SUM(oi.quantity) as qty, SUM(oi.line_total_paise) as revenue_paise
         FROM order_items oi
         JOIN menu_items mi ON mi.id = oi.menu_item_id
         JOIN menu_categories mc ON mc.id = mi.category_id
         WHERE oi.is_cancelled = 0
         GROUP BY mc.name
         ORDER BY revenue_paise DESC`
      )
      .all();

    const tableWise = db
      .prepare(
        `SELECT dt.table_number, dt.label, COUNT(o.id) as orders_count, COALESCE(SUM(o.total_paise), 0) as revenue_paise
         FROM dining_tables dt
         LEFT JOIN orders o ON o.table_id = dt.id AND o.status NOT IN ('cancelled', 'rejected')
         GROUP BY dt.id ORDER BY dt.table_number ASC`
      )
      .all();

    const paymentWise = db
      .prepare(
        `SELECT method, status, COUNT(*) as tx_count, SUM(amount_paise) as total_paise
         FROM payments GROUP BY method, status`
      )
      .all();

    const taxSummary = db
      .prepare(
        `SELECT COALESCE(SUM(subtotal_paise), 0) as subtotal_paise, COALESCE(SUM(gst_paise), 0) as gst_paise,
                COALESCE(SUM(service_charge_paise), 0) as service_charge_paise, COALESCE(SUM(discount_paise), 0) as discount_paise,
                COALESCE(SUM(total_paise), 0) as total_paise
         FROM orders WHERE status NOT IN ('cancelled', 'rejected')`
      )
      .get();

    res.json({ itemWise, categoryWise, tableWise, paymentWise, taxSummary });
  });

  app.get('/api/admin/audit-logs', requireAuth, requireRole(['super_admin', 'admin']), (_req, res) => {
    const logs = db
      .prepare(
        `SELECT a.*, u.name as actor_name
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.actor_user_id
         ORDER BY a.id DESC LIMIT 60`
      )
      .all();
    res.json({ logs });
  });

  app.post('/api/admin/demo/reset', requireAuth, requireRole(['super_admin']), (req, res) => {
    seedDatabaseIfEmpty(db, true);
    writeAudit(req.staffUser?.id || null, 'super_admin', 'demo_data_reset', 'system', 'all');
    realtime.broadcastMenuUpdate();
    res.json({ ok: true, message: 'Demo restaurant data has been cleanly reset.' });
  });

  // ==================== 9. NOTIFICATIONS ====================

  app.get('/api/notifications', requireAuth, (req, res) => {
    const role = req.staffUser!.role;
    const rows =
      role === 'super_admin' || role === 'admin'
        ? db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT 40').all()
        : db.prepare('SELECT * FROM notifications WHERE target_role = ? OR target_role IS NULL ORDER BY id DESC LIMIT 40').all(role);
    res.json({ notifications: rows });
  });

  app.post('/api/notifications/read', requireAuth, (req, res) => {
    const role = req.staffUser!.role;
    if (role === 'super_admin' || role === 'admin') {
      db.prepare('UPDATE notifications SET is_read = 1').run();
    } else {
      db.prepare('UPDATE notifications SET is_read = 1 WHERE target_role = ?').run(role);
    }
    res.json({ ok: true });
  });

  // ==================== 10. AUTOMATED QA RUNNER ====================

  app.post('/api/qa/run', requireAuth, requireRole(['super_admin', 'admin']), async (_req, res) => {
    if (!options?.runQaHandler) {
      return res.status(501).json({ error: 'QA Runner not wired' });
    }
    const report = await options.runQaHandler();
    res.json(report);
  });

  return app;
}
