// 自动化测试：node --test test/   （或 npm test）
// 对应设计文档第 11 节：状态机、接口、MockPay 场景、越权测试
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { canTransition } = require('../src/orders');

let app, base, mgr, staff;
before(async () => {
  app = createApp({ DB_FILE: ':memory:', UPLOAD_DIR: require('os').tmpdir() + '/mq-test-uploads', PORT: 0, JOB_INTERVAL_MS: 3600000 });
  base = `http://127.0.0.1:${await app.start()}`;
  mgr = (await api('POST', '/api/auth/staff-login', { username: 'manager', password: 'manager123' })).data.token;
  staff = (await api('POST', '/api/auth/staff-login', { username: 'staff1', password: 'staff123' })).data.token;
});
after(() => app.stop());

async function api(method, path, body, token) {
  const r = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  const j = await r.json();
  return { http: r.status, ...j };
}
let seq = 0;
const newCustomer = async () => (await api('POST', '/api/auth/guest-login', { device_id: 'device-test-' + ++seq + '-' + Date.now() })).data.token;
const rid = () => 'req-' + ++seq + '-' + Math.random().toString(36).slice(2);
const dishes = async () => (await api('GET', '/api/menu')).data.dishes;
const dishByName = async (n) => (await dishes()).find((d) => d.name === n);

// 下单并支付成功，返回订单详情
async function orderAndPay(tok, items, extra = {}) {
  const c = await api('POST', '/api/orders', { request_id: rid(), items, remark: '', ...extra }, tok);
  assert.equal(c.code, 0, JSON.stringify(c));
  const p = await api('POST', `/api/mockpay/${c.data.pay_params.out_trade_no}/pay`, {}, tok);
  assert.equal(p.code, 0, JSON.stringify(p));
  await api('POST', `/api/orders/${c.data.order_id}/pay-check`, {}, tok);
  return (await api('GET', `/api/orders/${c.data.order_id}`, null, tok)).data;
}
const noodle = async () => dishByName('牛肉米粉');

test('状态机：合法与非法转移', () => {
  assert.ok(canTransition('PENDING_PAY', 'WAIT_ACCEPT'));
  assert.ok(canTransition('WAIT_ACCEPT', 'COOKING'));
  assert.ok(canTransition('COOKING', 'DONE'));
  assert.ok(canTransition('DONE', 'PICKED'));
  assert.ok(canTransition('REFUND_FAILED', 'REFUNDED'));
  assert.ok(!canTransition('WAIT_ACCEPT', 'DONE'), '不能跳过制作中');
  assert.ok(!canTransition('PICKED', 'COOKING'), '不能回退');
  assert.ok(!canTransition('CLOSED', 'WAIT_ACCEPT'));
  assert.ok(!canTransition('PICKED', 'REFUNDED'), 'R-3 已取餐不退款');
});

test('FR-02/03 菜单与规格加价：大碗 +2 元', async () => {
  const d = await noodle();
  const big = d.spec_groups.find((g) => g.group_name === '规格').options.find((o) => o.option_name === '大碗');
  const tok = await newCustomer();
  const c = await api('POST', '/api/orders', { request_id: rid(), items: [{ dish_id: d.id, spec_option_ids: [big.id], quantity: 1 }], expected_total_fen: d.price_fen + 200 }, tok);
  assert.equal(c.code, 0);
  assert.equal(c.data.total_fen, 1600);
  const o = (await api('GET', `/api/orders/${c.data.order_id}`, null, tok)).data;
  assert.match(o.items[0].spec_text, /大碗/);
});

test('FR-03 备注 50 字可以，51 字被拒绝', async () => {
  const d = await dishByName('茶叶蛋'), tok = await newCustomer();
  const ok = await api('POST', '/api/orders', { request_id: rid(), items: [{ dish_id: d.id, quantity: 1 }], remark: '字'.repeat(50) }, tok);
  assert.equal(ok.code, 0);
  const bad = await api('POST', '/api/orders', { request_id: rid(), items: [{ dish_id: d.id, quantity: 1 }], remark: '字'.repeat(51) }, tok);
  assert.equal(bad.code, 40001);
});

test('规格校验：不属于该菜品的选项、同组选两项都被拒绝', async () => {
  const a = await noodle(), b = await dishByName('卤肉饭'), tok = await newCustomer();
  const sizes = a.spec_groups.find((g) => g.group_name === '规格').options;
  const r1 = await api('POST', '/api/orders', { request_id: rid(), items: [{ dish_id: b.id, spec_option_ids: [sizes[0].id], quantity: 1 }] }, tok);
  assert.equal(r1.code, 40001);
  const r2 = await api('POST', '/api/orders', { request_id: rid(), items: [{ dish_id: a.id, spec_option_ids: [sizes[0].id, sizes[1].id], quantity: 1 }] }, tok);
  assert.equal(r2.code, 40001);
});

test('FR-05 未支付店员看不到订单，支付后出现“待接单”并分配取餐号', async () => {
  const d = await dishByName('蒜蓉青菜'), tok = await newCustomer();
  const before = (await api('GET', '/api/staff/orders', null, staff)).data.orders.length;
  const c = await api('POST', '/api/orders', { request_id: rid(), items: [{ dish_id: d.id, quantity: 1 }] }, tok);
  assert.equal((await api('GET', '/api/staff/orders', null, staff)).data.orders.length, before, '未支付不应出现');
  await api('POST', `/api/mockpay/${c.data.pay_params.out_trade_no}/pay`, {}, tok);
  const list = (await api('GET', '/api/staff/orders', null, staff)).data.orders;
  assert.equal(list.length, before + 1);
  const mine = list.find((o) => o.id === c.data.order_id);
  assert.equal(mine.status, 'WAIT_ACCEPT');
  assert.match(mine.pickup_no_text, /^\d{3}$/);
});

test('EX-04 同一个 request_id 重试只生成一个订单', async () => {
  const d = await dishByName('茶叶蛋'), tok = await newCustomer(), id = rid();
  const a = await api('POST', '/api/orders', { request_id: id, items: [{ dish_id: d.id, quantity: 2 }] }, tok);
  const b = await api('POST', '/api/orders', { request_id: id, items: [{ dish_id: d.id, quantity: 2 }] }, tok);
  assert.equal(a.data.order_id, b.data.order_id);
});

test('EX-03 同一笔支付通知两次：订单只变一次，取餐号不重复', async () => {
  const d = await dishByName('茶叶蛋'), tok = await newCustomer();
  const o = await orderAndPay(tok, [{ dish_id: d.id, quantity: 1 }]);
  const pay = app.db.prepare('SELECT * FROM payment WHERE order_id=?').get(o.id);
  const r = app.orders.onPaid(pay.out_trade_no, pay.wx_transaction_id, pay.amount_fen);
  assert.equal(r.repeated, true);
  const o2 = (await api('GET', `/api/orders/${o.id}`, null, tok)).data;
  assert.equal(o2.pickup_no, o.pickup_no);
  assert.equal(app.db.prepare('SELECT COUNT(*) c FROM payment WHERE order_id=?').get(o.id).c, 1);
});

test('EX-02 通知丢失：A6 主动查单补上状态；对账任务也能补上', async () => {
  const d = await dishByName('茶叶蛋'), tok = await newCustomer();
  const c1 = await api('POST', '/api/orders', { request_id: rid(), items: [{ dish_id: d.id, quantity: 1 }] }, tok);
  await api('POST', `/api/mockpay/${c1.data.pay_params.out_trade_no}/pay`, { notify: false }, tok);
  assert.equal((await api('GET', `/api/orders/${c1.data.order_id}`, null, tok)).data.status, 'PENDING_PAY');
  await api('POST', `/api/orders/${c1.data.order_id}/pay-check`, {}, tok);
  assert.equal((await api('GET', `/api/orders/${c1.data.order_id}`, null, tok)).data.status, 'WAIT_ACCEPT');

  const c2 = await api('POST', '/api/orders', { request_id: rid(), items: [{ dish_id: d.id, quantity: 1 }] }, tok);
  await api('POST', `/api/mockpay/${c2.data.pay_params.out_trade_no}/pay`, { notify: false }, tok);
  app.clock.offsetMs += 90 * 1000; // 过 1.5 分钟，对账任务扫描
  app.orders.runJobs();
  assert.equal((await api('GET', `/api/orders/${c2.data.order_id}`, null, tok)).data.status, 'WAIT_ACCEPT');
  app.clock.offsetMs -= 90 * 1000;
});

test('F-2 通知金额与订单不符：订单不变，支付标记人工核对', async () => {
  const d = await dishByName('茶叶蛋'), tok = await newCustomer();
  const c = await api('POST', '/api/orders', { request_id: rid(), items: [{ dish_id: d.id, quantity: 1 }] }, tok);
  app.mockpay.userPays(c.data.pay_params.out_trade_no, { amountOverride: 1 });
  assert.equal((await api('GET', `/api/orders/${c.data.order_id}`, null, tok)).data.status, 'PENDING_PAY');
  const ex = (await api('GET', '/api/manager/exceptions', null, mgr)).data;
  assert.ok(ex.payments.some((p) => p.order_no === c.data.order_no));
  const pid = ex.payments.find((p) => p.order_no === c.data.order_no).id;
  assert.equal((await api('POST', `/api/manager/payments/${pid}/resolve`, { note: '已和微信账单核对' }, mgr)).code, 0);
});

test('FR-06 15 分钟未支付自动关闭，且不能再支付', async () => {
  const d = await dishByName('茶叶蛋'), tok = await newCustomer();
  const c = await api('POST', '/api/orders', { request_id: rid(), items: [{ dish_id: d.id, quantity: 1 }] }, tok);
  app.clock.offsetMs += 16 * 60000;
  app.orders.runJobs();
  assert.equal((await api('GET', `/api/orders/${c.data.order_id}`, null, tok)).data.status, 'CLOSED');
  const p = await api('POST', `/api/mockpay/${c.data.pay_params.out_trade_no}/pay`, {}, tok);
  assert.equal(p.code, 40901);
  app.clock.offsetMs -= 16 * 60000;
});

test('关单后又收到付款：自动整单退款并标记人工核对，订单保持已关闭', async () => {
  const d = await dishByName('茶叶蛋'), tok = await newCustomer();
  const c = await api('POST', '/api/orders', { request_id: rid(), items: [{ dish_id: d.id, quantity: 1 }] }, tok);
  app.clock.offsetMs += 16 * 60000; app.orders.runJobs();
  const pay = app.db.prepare('SELECT * FROM payment WHERE order_id=?').get(c.data.order_id);
  app.orders.onPaid(pay.out_trade_no, 'LATE123', pay.amount_fen);
  assert.equal((await api('GET', `/api/orders/${c.data.order_id}`, null, tok)).data.status, 'CLOSED');
  assert.equal(app.db.prepare("SELECT COUNT(*) c FROM refund WHERE order_id=? AND status='SUCCESS'").get(c.data.order_id).c, 1);
  assert.equal(app.db.prepare('SELECT manual_check m FROM payment WHERE id=?').get(pay.id).m, 1);
  app.clock.offsetMs -= 16 * 60000;
});

test('FR-07/FR-11 排队数随前面订单完成而减少；状态不能跳过', async () => {
  const d = await dishByName('茶叶蛋');
  const t1 = await newCustomer(), t2 = await newCustomer(), t3 = await newCustomer();
  const o1 = await orderAndPay(t1, [{ dish_id: d.id, quantity: 1 }]);
  const o2 = await orderAndPay(t2, [{ dish_id: d.id, quantity: 1 }]);
  const o3 = await orderAndPay(t3, [{ dish_id: d.id, quantity: 1 }]);
  const q = async (t, o) => (await api('GET', `/api/orders/${o.id}`, null, t)).data;
  assert.equal(o3.queue_ahead - o1.queue_ahead, 2);
  const base3 = o3.queue_ahead;
  // 跳过“制作中”直接“已完成”被拒绝
  assert.equal((await api('POST', `/api/staff/orders/${o1.id}/status`, { to: 'DONE' }, staff)).code, 40901);
  assert.equal((await api('POST', `/api/staff/orders/${o1.id}/status`, { to: 'COOKING' }, staff)).code, 0);
  assert.equal((await api('POST', `/api/staff/orders/${o1.id}/status`, { to: 'DONE' }, staff)).code, 0);
  assert.equal((await q(t3, o3)).queue_ahead, base3 - 1, '前面完成一单，数字减少');
  assert.equal((await q(t1, o1)).status_text, '已完成，请取餐');
  // 重复点“开始制作”（别人已处理）被拒绝
  assert.equal((await api('POST', `/api/staff/orders/${o1.id}/status`, { to: 'COOKING' }, staff)).code, 40901);
  assert.equal((await q(t2, o2)).status_text, '等待中');
});

test('FR-08 追加菜品：订单号和取餐号不变，补付后店员看到“追加”', async () => {
  const d = await dishByName('茶叶蛋'), e = await dishByName('蒜蓉青菜'), tok = await newCustomer();
  const o = await orderAndPay(tok, [{ dish_id: d.id, quantity: 1 }]);
  const a = await api('POST', `/api/orders/${o.id}/addons`, { items: [{ dish_id: e.id, quantity: 1 }] }, tok);
  assert.equal(a.code, 0);
  await api('POST', `/api/mockpay/${a.data.pay_params.out_trade_no}/pay`, {}, tok);
  const o2 = (await api('GET', `/api/orders/${o.id}`, null, tok)).data;
  assert.equal(o2.order_no, o.order_no); assert.equal(o2.pickup_no, o.pickup_no);
  assert.equal(o2.total_fen, 200 + 1200);
  const s = (await api('GET', '/api/staff/orders', null, staff)).data.orders.find((x) => x.id === o.id);
  assert.ok(s.items.some((i) => i.is_addon && i.dish_name === '蒜蓉青菜'));
  // 制作完成后不能再追加（R-2）
  await api('POST', `/api/staff/orders/${o.id}/status`, { to: 'COOKING' }, staff);
  await api('POST', `/api/staff/orders/${o.id}/status`, { to: 'DONE' }, staff);
  assert.equal((await api('POST', `/api/orders/${o.id}/addons`, { items: [{ dish_id: e.id, quantity: 1 }] }, tok)).code, 40901);
});

test('FR-12 售罄：不能下单；恢复后可以', async () => {
  const d = await dishByName('扁肉汤'), tok = await newCustomer();
  assert.equal((await api('PUT', `/api/staff/dishes/${d.id}/sold-out`, { sold_out: true }, staff)).code, 0);
  assert.equal((await dishByName('扁肉汤')).sold_out, true);
  const r = await api('POST', '/api/orders', { request_id: rid(), items: [{ dish_id: d.id, quantity: 1 }] }, tok);
  assert.equal(r.code, 40902);
  await api('PUT', `/api/staff/dishes/${d.id}/sold-out`, { sold_out: false }, staff);
  assert.equal((await api('POST', '/api/orders', { request_id: rid(), items: [{ dish_id: d.id, quantity: 1 }] }, tok)).code, 0);
});

test('EX-06 支付后菜品才售罄：店员端订单带“含售罄菜”标记', async () => {
  const d = await dishByName('炖罐汤'), tok = await newCustomer();
  const o = await orderAndPay(tok, [{ dish_id: d.id, quantity: 1 }]);
  await api('PUT', `/api/staff/dishes/${d.id}/sold-out`, { sold_out: true }, staff);
  const s = (await api('GET', '/api/staff/orders', null, staff)).data.orders.find((x) => x.id === o.id);
  assert.equal(s.contains_sold_out, true);
  await api('PUT', `/api/staff/dishes/${d.id}/sold-out`, { sold_out: false }, staff);
});

test('FR-16 改价只对新订单生效；EX-05 价格变化返回 40903', async () => {
  const d = await dishByName('鸡腿饭'), tok = await newCustomer();
  const o = await orderAndPay(tok, [{ dish_id: d.id, quantity: 1 }]);
  assert.equal(o.total_fen, 1600);
  const cat = d.category_id;
  const upd = await api('PUT', `/api/manager/dishes/${d.id}`, { category_id: cat, name: d.name, image_url: d.image_url, price_fen: 1800, on_sale: true, spec_groups: d.spec_groups }, mgr);
  assert.equal(upd.code, 0, JSON.stringify(upd));
  const old = (await api('GET', `/api/orders/${o.id}`, null, tok)).data;
  assert.equal(old.items[0].unit_price_fen, 1600, '旧订单仍是原价');
  assert.equal((await api('POST', '/api/orders', { request_id: rid(), items: [{ dish_id: d.id, quantity: 1 }], expected_total_fen: 1600 }, tok)).code, 40903);
  const n = await api('POST', '/api/orders', { request_id: rid(), items: [{ dish_id: d.id, quantity: 1 }], expected_total_fen: 1800 }, tok);
  assert.equal(n.data.total_fen, 1800);
});

test('FR-13 退款：必须选原因；退款后有记录；已取餐不能退', async () => {
  const d = await dishByName('茶叶蛋'), tok = await newCustomer();
  const o = await orderAndPay(tok, [{ dish_id: d.id, quantity: 1 }]);
  assert.equal((await api('POST', `/api/staff/orders/${o.id}/refund`, {}, staff)).code, 40001);
  assert.equal((await api('POST', `/api/staff/orders/${o.id}/refund`, { reason_code: 'OTHER', reason_text: '' }, staff)).code, 40001);
  const r = await api('POST', `/api/staff/orders/${o.id}/refund`, { reason_code: 'SOLD_OUT' }, staff);
  assert.equal(r.data.status, 'REFUNDED');
  const rec = app.db.prepare('SELECT * FROM refund WHERE order_id=?').get(o.id);
  assert.ok(rec.operator_id && rec.created_at && rec.reason_code === 'SOLD_OUT');
  // 已取餐
  const o2 = await orderAndPay(tok, [{ dish_id: d.id, quantity: 1 }]);
  for (const to of ['COOKING', 'DONE', 'PICKED']) await api('POST', `/api/staff/orders/${o2.id}/status`, { to }, staff);
  assert.equal((await api('POST', `/api/staff/orders/${o2.id}/refund`, { reason_code: 'SOLD_OUT' }, staff)).code, 40901);
});

test('EX-07 退款失败：订单变“退款失败”，店长重试成功（同一退款单号）', async () => {
  const d = await dishByName('茶叶蛋'), tok = await newCustomer();
  const o = await orderAndPay(tok, [{ dish_id: d.id, quantity: 1 }]);
  await api('POST', '/api/dev/mock', { refund_fail: true }, mgr);
  const r = await api('POST', `/api/staff/orders/${o.id}/refund`, { reason_code: 'CUSTOMER_REQUEST' }, staff);
  assert.equal(r.data.status, 'REFUND_FAILED');
  const no1 = app.db.prepare('SELECT out_refund_no n FROM refund WHERE order_id=?').get(o.id).n;
  assert.ok((await api('GET', '/api/manager/exceptions', null, mgr)).data.refund_failed.some((x) => x.id === o.id));
  assert.equal((await api('POST', `/api/manager/refunds/${o.id}/retry`, {}, mgr)).data.status, 'REFUND_FAILED');
  await api('POST', '/api/dev/mock', { refund_fail: false }, mgr);
  assert.equal((await api('POST', `/api/manager/refunds/${o.id}/retry`, {}, mgr)).data.status, 'REFUNDED');
  assert.equal(app.db.prepare('SELECT out_refund_no n FROM refund WHERE order_id=?').get(o.id).n, no1);
});

test('NFR-06/FR-14 越权测试：全部被拒绝', async () => {
  const d = await dishByName('茶叶蛋'), a = await newCustomer(), b = await newCustomer();
  const o = await orderAndPay(a, [{ dish_id: d.id, quantity: 1 }]);
  assert.equal((await api('GET', '/api/staff/orders', null, a)).code, 40301, '顾客调店员接口');
  assert.equal((await api('GET', '/api/manager/dishes', null, a)).code, 40301, '顾客调店长接口');
  assert.equal((await api('GET', '/api/manager/dishes', null, staff)).code, 40301, '店员调店长接口');
  assert.equal((await api('PUT', `/api/manager/dishes/${d.id}`, { price_fen: 1 }, staff)).code, 40301, '店员不能改价');
  assert.equal((await api('GET', `/api/orders/${o.id}`, null, b)).code, 40401, '顾客看他人订单');
  assert.equal((await api('GET', `/api/orders/${o.id}`, null, undefined)).http, 401, '没有 token');
  assert.equal((await api('POST', `/api/staff/orders/${o.id}/refund`, { reason_code: 'SOLD_OUT' }, a)).code, 40301);
  assert.equal((await api('POST', `/api/orders/${o.id}/cancel`, {}, a)).http, 404, 'FR-09 没有取消接口');
});

test('FR-17 停用店员账号后立即无法使用，也无法重新登录', async () => {
  const name = 'tmp_staff' + Date.now() % 100000;
  const c = await api('POST', '/api/manager/staff', { username: name, password: 'abc12345' }, mgr);
  assert.equal(c.code, 0);
  const tk = (await api('POST', '/api/auth/staff-login', { username: name, password: 'abc12345' })).data.token;
  assert.equal((await api('GET', '/api/staff/orders', null, tk)).code, 0);
  await api('PUT', `/api/manager/staff/${c.data.id}/status`, { status: 'DISABLED' }, mgr);
  assert.equal((await api('GET', '/api/staff/orders', null, tk)).code, 40102);
  assert.equal((await api('POST', '/api/auth/staff-login', { username: name, password: 'abc12345' })).code, 40102);
});

test('登录：错误密码被拒绝，密码不以明文保存', async () => {
  assert.equal((await api('POST', '/api/auth/staff-login', { username: 'staff1', password: 'wrong' })).code, 40102);
  const u = app.db.prepare("SELECT password_hash h FROM app_user WHERE username='staff1'").get();
  assert.ok(!u.h.includes('staff123'));
});

test('FR-10 超过 5 分钟没人接单：标红并写入提醒时间', async () => {
  const d = await dishByName('茶叶蛋'), tok = await newCustomer();
  const o = await orderAndPay(tok, [{ dish_id: d.id, quantity: 1 }]);
  let s = (await api('GET', '/api/staff/orders', null, staff)).data.orders.find((x) => x.id === o.id);
  assert.equal(s.overdue, false); assert.equal(s.reminded_at, null);
  app.clock.offsetMs += 6 * 60000; app.orders.runJobs();
  s = (await api('GET', '/api/staff/orders', null, staff)).data.orders.find((x) => x.id === o.id);
  assert.equal(s.overdue, true); assert.ok(s.reminded_at);
  app.clock.offsetMs -= 6 * 60000;
});

test('FR-18 按日期查询订单；菜品管理：下架后顾客看不到', async () => {
  const today = app.orders.bizDate(app.clock.now());
  const r = await api('GET', `/api/manager/orders?from=${today}&to=${today}`, null, mgr);
  assert.ok(r.data.total > 0 && r.data.orders[0].order_no);
  const none = await api('GET', '/api/manager/orders?from=2000-01-01&to=2000-01-02', null, mgr);
  assert.equal(none.data.total, 0);
  assert.equal((await api('GET', '/api/manager/orders?from=bad&to=bad', null, mgr)).code, 40001);
  const d = await dishByName('香菇鸡肉饭');
  await api('PUT', `/api/manager/dishes/${d.id}`, { category_id: d.category_id, name: d.name, price_fen: d.price_fen, on_sale: false, spec_groups: [] }, mgr);
  assert.equal(await dishByName('香菇鸡肉饭'), undefined);
  assert.ok((await api('GET', '/api/manager/dishes', null, mgr)).data.dishes.some((x) => x.name === '香菇鸡肉饭' && !x.on_sale));
});

test('TR-03 取餐号每天重置；取餐号用完返回 40904', async () => {
  const d = await dishByName('茶叶蛋'), tok = await newCustomer();
  app.clock.offsetMs += 30 * 3600000; // 快进到第二天
  const o = await orderAndPay(tok, [{ dish_id: d.id, quantity: 1 }]);
  assert.equal(o.pickup_no, 1);
  const date = app.orders.bizDate(app.clock.now());
  app.db.prepare('UPDATE daily_counter SET pickup_seq=999 WHERE biz_date=?').run(date);
  assert.equal((await api('POST', '/api/orders', { request_id: rid(), items: [{ dish_id: d.id, quantity: 1 }] }, tok)).code, 40904);
  app.clock.offsetMs -= 30 * 3600000;
});

test('限流：同一用户每分钟下单请求不超过 10 次（42901）', async () => {
  const tok = await newCustomer();
  let last;
  for (let i = 0; i < 11; i++) last = await api('POST', '/api/orders', { request_id: rid(), items: [] }, tok);
  assert.equal(last.code, 42901);
});

test('点餐二维码接口返回 SVG', async () => {
  const r = await fetch(base + '/api/qr?text=' + encodeURIComponent('http://192.168.1.2:3000/'));
  assert.match(r.headers.get('content-type'), /svg/);
  assert.match(await r.text(), /<svg/);
});

test('静态页面可访问，且不能用 ../ 读取服务器文件', async () => {
  for (const p of ['/', '/staff.html', '/manager.html', '/qr.html']) assert.equal((await fetch(base + p)).status, 200, p);
  const r = await fetch(base + '/..%2f..%2fpackage.json');
  assert.notEqual(r.status, 200);
});

// ---------- 新增功能：营业统计、图片上传 ----------
test('营业统计：营业额=收款-退款（用前后差值，不受其他测试影响）', async () => {
  const stat = async () => (await api('GET', '/api/manager/stats', null, mgr)).data;
  const before = await stat();
  const tok = await newCustomer();
  const a = await dishByName('番茄炒蛋'), b = await dishByName('蒜蓉青菜');
  await orderAndPay(tok, [{ dish_id: a.id, spec_option_ids: [], quantity: 2 }]);
  const ob = await orderAndPay(tok, [{ dish_id: b.id, spec_option_ids: [], quantity: 1 }]);
  const mid = await stat();
  assert.equal(mid.order_count - before.order_count, 2);
  assert.equal(mid.revenue_fen - before.revenue_fen, a.price_fen * 2 + b.price_fen);
  const rf = await api('POST', `/api/staff/orders/${ob.id}/refund`, { reason_code: 'CUSTOMER_REQUEST' }, staff);
  assert.equal(rf.code, 0, JSON.stringify(rf));
  const after_ = await stat();
  assert.equal(after_.order_count - before.order_count, 1);
  assert.equal(after_.revenue_fen - before.revenue_fen, a.price_fen * 2);
  assert.equal(after_.refund_fen - before.refund_fen, b.price_fen);
  assert.equal((await api('GET', '/api/manager/stats?date=abc', null, mgr)).code, 40001);
  assert.equal((await api('GET', '/api/manager/stats', null, staff)).code, 40301, '店员不能看统计');
});

test('图片上传：只有店长能传，只收 jpg/png/webp，返回的地址能打开', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  assert.equal((await api('POST', '/api/manager/upload', { data: png }, staff)).code, 40301);
  assert.equal((await api('POST', '/api/manager/upload', { data: 'data:text/html;base64,PGI+' }, mgr)).code, 40001);
  const r = await api('POST', '/api/manager/upload', { data: png }, mgr);
  assert.equal(r.code, 0, JSON.stringify(r));
  const f = await fetch(base + r.data.url);
  assert.equal(f.status, 200); assert.equal(f.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(base + '/uploads/../package.json')).status === 200, false, '不能用 ../ 读到别的文件');
});

test('入口导航页可访问，/api/qr 能生成二维码', async () => {
  const p = await fetch(base + '/entry.html'); assert.equal(p.status, 200);
  const q = await fetch(base + '/api/qr?text=' + encodeURIComponent('http://10.0.0.1:3000/staff.html'));
  assert.equal(q.status, 200); assert.match(await q.text(), /<svg/);
});
