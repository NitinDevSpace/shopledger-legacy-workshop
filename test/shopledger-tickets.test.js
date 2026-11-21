'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const dates = require('../lib/dates');
const inventory = require('../lib/inventory');
const invoice = require('../lib/invoice');
const ledger = require('../lib/ledger');
const orders = require('../lib/orders');
const reports = require('../lib/reports');

test('checkout accepts the last sellable unit while preserving wholesale reservations', () => {
  const product = { id: 1, name: 'Chilli', stock: 4, reserved: 3 };
  const items = [{ id: 1, qty: 1 }];
  assert.equal(inventory.check([product], items).ok, true);
  inventory.reserve([product], items);
  assert.deepEqual([product.stock, product.reserved], [3, 3]);
  assert.equal(inventory.check([product], [{ id: 1, qty: 1 }]).ok, false);
});

test('checkout combines duplicate line quantities when checking sellable stock', () => {
  const product = { id: 1, name: 'Chilli', stock: 4, reserved: 1 };
  assert.equal(inventory.check([product], [{ id: 1, qty: 2 }, { id: '1', qty: 1 }]).ok, true);
  assert.equal(inventory.check([product], [{ id: 1, qty: 2 }, { id: '1', qty: 2 }]).ok, false);
});

test('cancelling a pending order restores physical stock once', () => {
  const product = { id: 1, stock: 2, reserved: 1 };
  const order = { id: 1007, status: 'pending', items: [{ id: 1, qty: 2 }, { productId: 1, qty: 1 }] };
  const db = { products: [product], orders: [order] };
  assert.equal(orders.cancel(db, 1007).ok, true);
  assert.equal(order.status, 'cancelled');
  assert.equal(orders.cancel(db, 1007).ok, false);
  assert.deepEqual([product.stock, product.reserved], [5, 1]);
});

test('order history sorts chronologically and includes both date range endpoints', () => {
  const db = { orders: [
    { id: 1001, date: '28/12/2021' },
    { id: 1004, date: '30/01/2022' },
    { id: 1008, date: '15/03/2022' },
    { id: 1009, date: '15/03/2022' }
  ] };
  const ids = filters => orders.list(db, filters).map(order => order.id);
  assert.deepEqual(ids(), [1009, 1008, 1004, 1001]);
  assert.deepEqual(ids({ from: '2021-12-28', to: '30/01/2022' }), [1004, 1001]);
  assert.deepEqual(ids({ from: '2022-01-30' }), [1009, 1008, 1004]);
  assert.deepEqual(ids({ to: '2022-01-30' }), [1004, 1001]);
  assert.equal(dates.getFiscalYear('2022-04-01'), 'FY22-23');
  assert.equal(dates.getFiscalYear('31/03/2022'), 'FY21-22');
});

test('Khata adds a string settlement amount to historical numeric totals', () => {
  const customer = { id: 1, openingBalance: 1200, totalBilled: 1232.01, totalSettled: '1200' };
  const db = { customers: [customer], nextSettlementId: 1 };
  const result = ledger.recordSettlement(db, '1', '500', 'upi');
  assert.equal(result.ok, true);
  assert.equal(result.settlement.amount, 500);
  assert.equal(customer.totalSettled, 1700);
  assert.equal(customer.balance, 732.01);
  assert.equal(ledger.listCustomers(db)[0].balance, 732.01);
});

test('invalid settlement amounts leave the customer and settlement history intact', () => {
  const customer = { id: 1, totalSettled: 10 };
  const db = { customers: [customer], nextSettlementId: 1, settlements: [] };
  for (const amount of ['invalid', 'Infinity', '0.001', 0, -1, true]) {
    assert.equal(ledger.recordSettlement(db, 1, amount).ok, false);
  }
  assert.deepEqual(customer, { id: 1, totalSettled: 10 });
  assert.equal(db.nextSettlementId, 1);
  assert.deepEqual(db.settlements, []);
});

test('the saved SAVE10 order from the invoice ticket reconciles with the ledger', () => {
  const order = {
    id: 1002, coupon: 'SAVE10', subtotal: 1020, discount: 102, tax: 45.9, total: 963.9,
    items: [{ id: 1, name: 'Rice', hsn: '1006', price: 1020, qty: 1 }]
  };
  assert.match(invoice.render(order), /Invoice Total<\/td><td class="r">₹963\.90/);
  assert.match(invoice.render(order), /Total GST\)<\/td><td class="r">₹45\.90/);
  assert.equal(reports.getGstReconciliation({ orders: [order] }).mismatchCount, 0);
});
