export type RoleSlug = 'super_admin' | 'admin' | 'chef' | 'counter' | 'waiter';

export type TableStatus = 'available' | 'occupied' | 'reserved' | 'cleaning';
export type TableSessionStatus = 'active' | 'settling' | 'closed';

export type OrderStatus =
  | 'placed'
  | 'accepted'
  | 'processing'
  | 'ready'
  | 'served'
  | 'completed'
  | 'rejected'
  | 'cancelled';

export type PaymentStatus =
  | 'pending'
  | 'paid'
  | 'failed'
  | 'refund_pending'
  | 'refunded';

export type KitchenTicketStatus =
  | 'new'
  | 'accepted'
  | 'preparing'
  | 'ready'
  | 'served'
  | 'rejected'
  | 'cancelled';

export interface RestaurantInfo {
  id: number;
  name: string;
  tagline: string;
  description: string;
  address: string;
  phone: string;
  email: string;
  gstin: string;
  currency: string;
  timezone: string;
  opening_hours: Record<string, string>;
  social_links: Record<string, string>;
  gst_rate_bps: number;
  service_charge_bps: number;
  payment_mode: 'razorpay' | 'sandbox';
  razorpay_key_id: string | null;
  auto_accept_kitchen: boolean;
}

export interface MenuVariant {
  name: string;
  price_delta_paise: number;
}

export interface MenuAddon {
  name: string;
  price_paise: number;
}

export interface MenuCategory {
  id: number;
  restaurant_id: number;
  name: string;
  slug: string;
  description: string;
  image_url: string;
  sort_order: number;
  is_active: number;
}

export interface MenuItem {
  id: number;
  category_id: number;
  category_name?: string;
  name: string;
  slug: string;
  description: string;
  price_paise: number;
  image_url: string;
  is_veg: number;
  is_bestseller: number;
  is_available: number;
  prep_time_mins: number;
  variants: MenuVariant[];
  addons: MenuAddon[];
}

export interface DiningTable {
  id: number;
  restaurant_id: number;
  table_number: number;
  label: string;
  capacity: number;
  section: string;
  status: TableStatus;
  assigned_waiter_id: number | null;
  assigned_waiter_name?: string | null;
  active_session_id?: number | null;
  active_session_code?: string | null;
  active_orders_count?: number;
  pending_kitchen_count?: number;
  total_bill_paise?: number;
  paid_paise?: number;
  outstanding_paise?: number;
}

export interface OrderItem {
  id: number;
  order_id: number;
  menu_item_id: number;
  item_name: string;
  unit_price_paise: number;
  quantity: number;
  variant_name: string | null;
  variant_delta_paise: number;
  addons: MenuAddon[];
  addons_total_paise: number;
  line_total_paise: number;
  special_instructions: string | null;
  is_cancelled: number;
  cancel_reason: string | null;
}

export interface OrderStatusHistoryEntry {
  id: number;
  order_id: number;
  from_status: string | null;
  to_status: string;
  changed_by_user_id: number | null;
  changed_by_role: string | null;
  changed_by_name?: string | null;
  note: string | null;
  created_at: string;
}

export interface Order {
  id: number;
  order_number: string;
  table_session_id: number;
  table_id: number;
  table_number: number;
  customer_name: string | null;
  customer_phone: string | null;
  subtotal_paise: number;
  gst_paise: number;
  service_charge_paise: number;
  discount_paise: number;
  total_paise: number;
  coupon_code: string | null;
  status: OrderStatus;
  payment_status: PaymentStatus;
  rejection_reason: string | null;
  special_instructions: string | null;
  is_demo: number;
  created_at: string;
  updated_at: string;
  items: OrderItem[];
  history?: OrderStatusHistoryEntry[];
  ticket_number?: string | null;
  ticket_status?: KitchenTicketStatus | null;
}

export interface KitchenTicketItem {
  id: number;
  kitchen_ticket_id: number;
  order_item_id: number;
  item_name: string;
  quantity: number;
  variant_name: string | null;
  addons: MenuAddon[];
  special_instructions: string | null;
  status: string;
}

export interface KitchenTicket {
  id: number;
  ticket_number: string;
  order_id: number;
  order_number: string;
  table_id: number;
  table_number: number;
  table_session_id: number;
  status: KitchenTicketStatus;
  payment_status: PaymentStatus;
  accepted_by_user_id: number | null;
  accepted_by_name?: string | null;
  started_at: string | null;
  ready_at: string | null;
  served_at: string | null;
  rejection_reason: string | null;
  special_instructions: string | null;
  created_at: string;
  items: KitchenTicketItem[];
}

export interface PaymentRecord {
  id: number;
  order_id: number | null;
  table_session_id: number;
  provider: string;
  provider_order_id: string | null;
  provider_payment_id: string | null;
  amount_paise: number;
  method: string;
  status: string;
  recorded_by_user_id: number | null;
  recorded_by_name?: string | null;
  is_demo: number;
  created_at: string;
}

export interface InvoiceRecord {
  id: number;
  invoice_number: string;
  table_session_id: number;
  table_id: number;
  table_number: number;
  subtotal_paise: number;
  gst_paise: number;
  service_charge_paise: number;
  discount_paise: number;
  grand_total_paise: number;
  paid_paise: number;
  payment_status: string;
  created_at: string;
}

export interface Reservation {
  id: number;
  reservation_code: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  reservation_date: string;
  reservation_time: string;
  guest_count: number;
  table_id: number | null;
  table_number?: number | null;
  special_requests: string | null;
  status: 'pending' | 'confirmed' | 'seated' | 'rejected' | 'cancelled';
  created_at: string;
}

export interface Coupon {
  id: number;
  code: string;
  description: string;
  discount_type: 'percent' | 'fixed';
  discount_value: number;
  min_order_paise: number;
  max_discount_paise: number | null;
  usage_limit: number;
  used_count: number;
  valid_from: string;
  valid_until: string;
  is_active: number;
}

export interface StaffUser {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  role: RoleSlug;
  role_name: string;
  permissions: string[];
  is_active: number;
  assigned_tables: number[];
  last_login_at: string | null;
}

export interface AppNotification {
  id: number;
  target_role: string | null;
  target_table_id: number | null;
  title: string;
  message: string;
  type: 'order' | 'kitchen' | 'payment' | 'reservation' | 'alert' | 'waiter';
  reference_id: string | null;
  is_read: number;
  created_at: string;
}

export interface CartItemInput {
  menu_item_id: number;
  quantity: number;
  variant_name?: string | null;
  addon_names?: string[];
  special_instructions?: string | null;
}

export interface QATestCaseResult {
  id: string;
  suite: string;
  name: string;
  status: 'passed' | 'failed' | 'pending' | 'skipped';
  duration_ms: number;
  assertion_count: number;
  error?: string;
  details?: string;
}

export interface QABugEntry {
  bug_id: string;
  module: string;
  description: string;
  severity: 'critical' | 'major' | 'minor';
  reproduction_steps: string;
  root_cause: string;
  fix: string;
  retest_result: 'PASS' | 'OPEN';
}

export interface QAReport {
  project_name: string;
  version: string;
  executed_at: string;
  final_status: 'PASS' | 'PASS WITH WARNINGS' | 'FAIL';
  summary: {
    total: number;
    passed: number;
    failed: number;
    pending: number;
    skipped: number;
    critical_bugs: number;
    warnings: number;
    completion_pct: number;
    total_duration_ms: number;
  };
  test_cases: QATestCaseResult[];
  performance: {
    endpoint: string;
    avg_ms: number;
    p95_ms: number;
    requests: number;
    status: string;
  }[];
  security_checks: {
    check: string;
    status: 'PASS' | 'FAIL';
    notes: string;
  }[];
  responsive_matrix: {
    viewport: string;
    tested_pages: string;
    horizontal_overflow: boolean;
    status: 'PASS' | 'WARNING';
  }[];
  bugs: QABugEntry[];
  production_notes: string[];
}
