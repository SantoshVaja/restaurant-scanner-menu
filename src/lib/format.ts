import { jsPDF } from 'jspdf';
import type { InvoiceRecord, Order, RestaurantInfo } from '../types.ts';

export function formatINR(paise: number): string {
  const rupees = paise / 100;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: paise % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(rupees);
}

export function formatDateTimeIST(iso: string | null | undefined): string {
  if (!iso) return '—';
  const normalized = iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`;
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function getElapsedMinutes(iso: string): number {
  const normalized = iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`;
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return 0;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
}

export function exportRowsToCsv(filename: string, headers: string[], rows: Array<Array<string | number>>) {
  const escape = (val: string | number) => {
    const s = String(val ?? '');
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const csv = [headers.map(escape).join(','), ...rows.map((r) => r.map(escape).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadInvoicePdf(
  invoice: InvoiceRecord,
  orders: Order[],
  restaurant: RestaurantInfo | null
) {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  let y = 48;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.text(restaurant?.name || 'Saffron & Ember', 48, y);
  y += 18;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(restaurant?.address || '14 Pali Hill Courtyard, Bandra West, Mumbai 400050', 48, y);
  y += 14;
  doc.text(`Phone: ${restaurant?.phone || '+91 22 4890 3600'}  |  GSTIN: ${restaurant?.gstin || '27AABCS1429B1Z5'}`, 48, y);
  y += 22;

  doc.setDrawColor(200);
  doc.line(48, y, 547, y);
  y += 20;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text(`TAX INVOICE: ${invoice.invoice_number}`, 48, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(`Table ${String(invoice.table_number).padStart(2, '0')}  |  Date: ${formatDateTimeIST(invoice.created_at)}`, 330, y);
  y += 24;

  doc.setFont('helvetica', 'bold');
  doc.text('Item', 48, y);
  doc.text('Order', 280, y);
  doc.text('Qty', 370, y);
  doc.text('Amount (INR)', 455, y);
  y += 8;
  doc.line(48, y, 547, y);
  y += 16;

  doc.setFont('helvetica', 'normal');
  for (const ord of orders) {
    if (ord.status === 'cancelled' || ord.status === 'rejected') continue;
    for (const item of ord.items) {
      if (item.is_cancelled) continue;
      if (y > 740) {
        doc.addPage();
        y = 48;
      }
      doc.text(item.item_name.slice(0, 36), 48, y);
      doc.text(ord.order_number, 280, y);
      doc.text(String(item.quantity), 375, y);
      doc.text(`Rs. ${(item.line_total_paise / 100).toFixed(2)}`, 455, y);
      y += 16;
    }
  }

  y += 8;
  doc.line(48, y, 547, y);
  y += 18;

  const summaryRows: Array<[string, number]> = [
    ['Subtotal', invoice.subtotal_paise],
    ['Discount', -invoice.discount_paise],
    ['GST (5%)', invoice.gst_paise],
    ['Service Charge (5%)', invoice.service_charge_paise],
  ];

  for (const [label, val] of summaryRows) {
    if (val === 0 && label === 'Discount') continue;
    doc.text(label, 350, y);
    doc.text(`Rs. ${(val / 100).toFixed(2)}`, 455, y);
    y += 16;
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('Grand Total', 350, y + 4);
  doc.text(`Rs. ${(invoice.grand_total_paise / 100).toFixed(2)}`, 455, y + 4);
  y += 22;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(`Paid: Rs. ${(invoice.paid_paise / 100).toFixed(2)}  |  Status: ${invoice.payment_status.toUpperCase()}`, 48, y);
  y += 24;
  doc.text('Thank you for dining with Saffron & Ember · Powered by Restaurant 360°', 48, y);

  doc.save(`${invoice.invoice_number}.pdf`);
}

export interface PrintableTableQr {
  table_number: number;
  label: string;
  section: string;
  capacity: number;
  qr_data_url: string;
}

export function downloadAllTableQrsPdf(
  tables: PrintableTableQr[],
  restaurant: RestaurantInfo | null
) {
  if (!tables || tables.length === 0) return;

  const doc = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'portrait' });
  const pageW = doc.internal.pageSize.getWidth(); // 595.28 pt
  const pageH = doc.internal.pageSize.getHeight(); // 841.89 pt
  const marginX = 36;
  const marginY = 38;
  const gapX = 24;
  const gapY = 26;
  const cardW = (pageW - marginX * 2 - gapX) / 2; // ~249.6 pt
  const cardH = (pageH - marginY * 2 - gapY) / 2; // ~369.9 pt
  const brandName = (restaurant?.name || 'Saffron & Ember').toUpperCase();

  const sorted = [...tables].sort((a, b) => a.table_number - b.table_number);

  sorted.forEach((t, idx) => {
    const slot = idx % 4;
    if (idx > 0 && slot === 0) {
      doc.addPage();
    }

    // Draw subtle dashed cut guides once per page
    if (slot === 0) {
      doc.setDrawColor(210, 210, 214);
      doc.setLineWidth(0.5);
      doc.setLineDashPattern([4, 4], 0);
      doc.line(pageW / 2, 16, pageW / 2, pageH - 16);
      doc.line(16, pageH / 2, pageW - 16, pageH / 2);
      doc.setLineDashPattern([], 0);
    }

    const col = slot % 2;
    const row = Math.floor(slot / 2);
    const x = marginX + col * (cardW + gapX);
    const y = marginY + row * (cardH + gapY);
    const centerX = x + cardW / 2;

    // Outer plaque card
    doc.setFillColor(255, 255, 255);
    doc.setDrawColor(220, 216, 208);
    doc.setLineWidth(1);
    doc.roundedRect(x, y, cardW, cardH, 10, 10, 'FD');

    // Header charcoal band
    doc.setFillColor(24, 24, 27); // #18181B
    doc.roundedRect(x, y, cardW, 56, 10, 10, 'F');
    doc.rect(x, y + 40, cardW, 16, 'F');

    // Gold accent hairline under header
    doc.setFillColor(180, 123, 43); // #B47B2B
    doc.rect(x, y + 56, cardW, 2.5, 'F');

    // Restaurant name in header
    doc.setTextColor(212, 163, 89); // #D4A359
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.text(brandName, centerX, y + 25, { align: 'center' });

    doc.setTextColor(228, 228, 231);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.text('TABLE-SIDE DIGITAL DINING', centerX, y + 40, { align: 'center' });

    // Formatted Table Number Title
    const formattedTableNum = `TABLE ${String(t.table_number).padStart(2, '0')}`;
    doc.setTextColor(24, 24, 27);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(22);
    doc.text(formattedTableNum, centerX, y + 92, { align: 'center' });

    // Section & Seating Subtitle
    doc.setTextColor(113, 113, 122);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text(`${t.section}  ·  ${t.capacity} Seats`, centerX, y + 109, { align: 'center' });

    // QR Code Frame
    const qrSize = 152;
    const qrX = centerX - qrSize / 2;
    const qrY = y + 124;
    doc.setDrawColor(228, 228, 231);
    doc.setLineWidth(0.75);
    doc.roundedRect(qrX - 8, qrY - 8, qrSize + 16, qrSize + 16, 6, 6, 'S');

    if (t.qr_data_url) {
      doc.addImage(t.qr_data_url, 'PNG', qrX, qrY, qrSize, qrSize);
    }

    // Scan Callout
    doc.setTextColor(24, 24, 27);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.text('Scan with Camera to Order & Pay', centerX, y + 308, { align: 'center' });

    doc.setTextColor(113, 113, 122);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.text('Browse Menu · Customize Dishes · Live Kitchen Tracker', centerX, y + 324, { align: 'center' });

    // Subtle footer inside plaque
    doc.setDrawColor(238, 236, 232);
    doc.line(x + 20, y + cardH - 28, x + cardW - 20, y + cardH - 28);
    doc.setTextColor(161, 161, 170);
    doc.setFontSize(7);
    doc.text(`${t.label}  ·  Powered by Restaurant 360°`, centerX, y + cardH - 13, { align: 'center' });
  });

  const slug = (restaurant?.name || 'restaurant-360')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  doc.save(`${slug}-table-qr-codes.pdf`);
}

