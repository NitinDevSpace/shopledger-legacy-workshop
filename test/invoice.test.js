'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const config = require('../config');
const invoice = require('../lib/invoice');
const orders = require('../lib/orders');
const pricing = require('../lib/pricing');
const reports = require('../lib/reports');
const store = require('../lib/store');
const orderRouter = require('../routes/orders');
const reportRouter = require('../routes/reports');

// Dispatch to the real Express router without opening a listening socket.
function post(router, url, body) {
  return new Promise((resolve, reject) => {
    router({ method: 'POST', url, body }, {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(data) {
        resolve({ status: this.statusCode, data });
      }
    }, error => reject(error || new Error(`No response for POST ${url}`)));
  });
}

function recordOrder(items, coupon = '') {
  const db = { orders: [], nextOrderId: 1001 };
  return orders.add(db, {
    ...pricing.computeTotals(items, coupon), items, coupon, date: '21/11/2026'
  });
}

function amounts({ subtotal, discount, tax, total }) {
  return { subtotal, discount, tax, total };
}

test('the printable invoice shows the billed total and post-discount GST for mixed HSN items', () => {
  const order = recordOrder([
    { name: 'Rice', hsn: '1006', price: 500, qty: 2 },
    { name: 'Ghee', hsn: '0405', price: 1000, qty: 1 }
  ], 'SAVE10');

  const figures = invoice.computeInvoiceFigures(order);
  assert.equal(figures.total, 2007.25);
  assert.equal(figures.tax, 157.25);

  const html = invoice.render(order);
  assert.match(html, /Invoice Total<\/td><td class="r">₹2007\.25/);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td class="r">₹157\.25/);
  assert.match(html, /5%<\/td><td class="r">₹46\.25/);
  assert.match(html, /12%<\/td><td class="r">₹111\.00/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('an undiscounted order using fallback GST matches the printed invoice', () => {
  const items = [{ name: 'Unclassified item', price: 100, qty: 2 }];
  const order = recordOrder(items);
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual(amounts(order), { subtotal: 200, discount: 0, tax: 36, total: 236 });
  assert.deepEqual(amounts(figures), amounts(order));
  assert.deepEqual([figures.cgst, figures.sgst], [18, 18]);
  assert.deepEqual(figures.rows, [{
    name: 'Unclassified item', sku: '-', hsn: '-', qty: 2, price: 100,
    gstPercent: 18, line: 200, lineTax: 36
  }]);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('mixed HSN preview, checkout, khata and invoice agree on capped, post-discount GST', async t => {
  const customer = { id: 1, name: 'Khata customer', totalBilled: 0 };
  const db = {
    products: [
      { id: 1, name: 'Rice', sku: 'RICE', hsn: '1006', price: 500, stock: 10 },
      { id: 2, name: 'Ghee', sku: 'GHEE', hsn: '0405', price: 1000, stock: 10 }
    ],
    customers: [customer], orders: [], nextOrderId: 1001
  };
  t.mock.method(store, 'read', () => db);
  const write = t.mock.method(store, 'write', savedDb => assert.equal(savedDb, db));

  const cart = { items: [{ id: 1, qty: 2 }, { id: 2, qty: 1 }], coupon: ' save10 ' };
  const preview = await post(reportRouter, '/pricing/preview', cart);
  const placed = await post(orderRouter, '/orders', { ...cart, customerId: 1, paymentMode: 'khata' });

  const billed = { subtotal: 2000, discount: 150, tax: 157.25, total: 2007.25 };
  assert.equal(preview.status, 200);
  assert.deepEqual(amounts(preview.data.totals), billed);
  assert.deepEqual([preview.data.totals.cgst, preview.data.totals.sgst], [78.63, 78.62]);
  assert.deepEqual(preview.data.totals.lines.map(({ gstPercent, discount, taxable, tax }) =>
    ({ gstPercent, discount, taxable, tax })), [
    { gstPercent: 5, discount: 75, taxable: 925, tax: 46.25 },
    { gstPercent: 12, discount: 75, taxable: 925, tax: 111 }
  ]);
  assert.equal(placed.status, 201);
  assert.equal(placed.data.coupon, 'SAVE10');
  assert.equal(write.mock.callCount(), 1);
  const order = orders.get(db, placed.data.id);
  assert.deepEqual(amounts(order), billed);
  assert.deepEqual(amounts(placed.data), billed);
  assert.equal(customer.totalBilled, 2007.25);

  const figures = invoice.computeInvoiceFigures(order);
  assert.deepEqual(amounts(figures), billed);
  assert.deepEqual([figures.cgst, figures.sgst], [78.63, 78.62]);
  assert.deepEqual(figures.rows.map(({ hsn, gstPercent, lineTax }) => ({ hsn, gstPercent, lineTax })), [
    { hsn: '1006', gstPercent: 5, lineTax: 46.25 },
    { hsn: '0405', gstPercent: 12, lineTax: 111 }
  ]);
});

test('the invoice and reconciliation report agree with checkout on discount and GST even when the total alone would match', () => {
  const order = recordOrder([{ name: 'Tea', hsn: '0902', price: 600, qty: 1 }], 'SAVE10');
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual(amounts(order), { subtotal: 600, discount: 60, tax: 97.2, total: 637.2 });
  assert.deepEqual(amounts(figures), amounts(order));
  assert.deepEqual([figures.cgst, figures.sgst], [48.6, 48.6]);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);

  assert.deepEqual(reports.getGstReconciliation({ orders: [order] }), {
    totalChecked: 1, mismatchCount: 0, totalDelta: 0,
    rows: [{
      orderId: 1001, date: '21/11/2026', customer: 'Walk-in', coupon: 'SAVE10',
      ledgerSubtotal: 600, ledgerDiscount: 60, ledgerTax: 97.2, ledgerTotal: 637.2,
      invoiceDiscount: 60, invoiceTax: 97.2, invoiceTotal: 637.2, delta: 0, matched: true
    }]
  });
});

test('the invoice applies a flat coupon before GST', () => {
  const order = recordOrder([{ name: 'Tea', hsn: '0902', price: 300, qty: 1 }], 'FLAT50');
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual(amounts(order), { subtotal: 300, discount: 50, tax: 45, total: 295 });
  assert.deepEqual(amounts(figures), amounts(order));
});

test('invoice pricing respects coupon minimums and expiry on saved orders', () => {
  // These model historical records. The current order route rejects both coupons for this cart.
  const items = [{ name: 'Tea', hsn: '0902', price: 40, qty: 1 }];
  const belowMinimum = recordOrder(items, 'FLAT50');
  const expired = recordOrder(items, 'DIWALI20');

  assert.deepEqual(amounts(belowMinimum), { subtotal: 40, discount: 0, tax: 7.2, total: 47.2 });
  assert.deepEqual(amounts(expired), amounts(belowMinimum));
  assert.deepEqual(amounts(invoice.computeInvoiceFigures(belowMinimum)), amounts(belowMinimum));
  assert.deepEqual(amounts(invoice.computeInvoiceFigures(expired)), amounts(expired));
});

test('the invoice uses checkout GST rates for decimal, zero and whole percentages', () => {
  const order = recordOrder([
    { name: 'Decimal rate', price: 100, qty: 1, gstRate: 0.05 },
    { name: 'Zero rate', price: 100, qty: 1, gstRate: 0 },
    { name: 'Whole percent', price: 100, qty: 1, gstRate: 12 }
  ]);

  assert.deepEqual(amounts(order), { subtotal: 300, discount: 0, tax: 17, total: 317 });
  const figures = invoice.computeInvoiceFigures(order);
  assert.deepEqual(amounts(figures), amounts(order));
  assert.deepEqual(figures.rows.map(({ gstPercent, lineTax }) => ({ gstPercent, lineTax })), [
    { gstPercent: 5, lineTax: 5 },
    { gstPercent: 0, lineTax: 0 },
    { gstPercent: 12, lineTax: 12 }
  ]);
});

test('the invoice sums rounded line GST amounts like checkout', () => {
  const order = recordOrder([
    { name: 'First small line', price: 0.03, qty: 1 },
    { name: 'Second small line', price: 0.03, qty: 1 }
  ]);
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual(amounts(order), { subtotal: 0.06, discount: 0, tax: 0.02, total: 0.08 });
  assert.deepEqual(amounts(figures), amounts(order));
  assert.deepEqual(figures.rows.map(row => row.lineTax), [0.01, 0.01]);
  assert.deepEqual([figures.cgst, figures.sgst], [0.01, 0.01]);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('a legacy invoice keeps billed amounts when the original line GST cannot be reconstructed', () => {
  const order = recordOrder([{ name: 'Tea', price: 100, qty: 1 }]);
  order.tax = 17;
  order.total = 117;

  const figures = invoice.computeInvoiceFigures(order);
  assert.equal(figures.total, 117);
  assert.equal(figures.tax, 17);
  assert.equal(figures.rows[0].lineTax, null);
  assert.match(invoice.render(order), /Original line-level GST is unavailable/);
  assert.equal(reports.getGstReconciliation({ orders: [order] }).mismatchCount, 1);
});

test('a saved invoice retains checkout GST and discount after pricing rules change', async t => {
  const db = {
    products: [{ id: 1, name: 'Tea', hsn: '0902', price: 600, stock: 10 }],
    orders: [], nextOrderId: 1001
  };
  t.mock.method(store, 'read', () => db);
  t.mock.method(store, 'write', () => {});

  const placed = await post(orderRouter, '/orders', { items: [{ id: 1, qty: 1 }], coupon: 'SAVE10' });
  assert.equal(placed.status, 201);
  const saved = JSON.parse(JSON.stringify(db.orders[0]));
  const originalRate = config.tax.hsnSlabs['0902'];
  const originalActive = config.coupons.SAVE10.active;
  try {
    config.tax.hsnSlabs['0902'] = 12;
    config.coupons.SAVE10.active = false;
    const figures = invoice.computeInvoiceFigures(saved);
    assert.deepEqual(amounts(figures), { subtotal: 600, discount: 60, tax: 97.2, total: 637.2 });
    assert.deepEqual([figures.rows[0].gstPercent, figures.rows[0].lineTax], [18, 97.2]);
    assert.match(invoice.render(saved), /Invoice Total<\/td><td class="r">₹637\.20/);
    assert.equal(reports.getGstReconciliation({ orders: [saved] }).mismatchCount, 0);
  } finally {
    config.tax.hsnSlabs['0902'] = originalRate;
    config.coupons.SAVE10.active = originalActive;
  }
});
