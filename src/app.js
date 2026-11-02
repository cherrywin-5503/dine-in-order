// 接口层（设计文档 2.2）：路由、登录校验、角色校验、参数校验、统一返回格式
// 只用 Node 自带的 http 模块，不依赖第三方框架。
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');
const { ApiError } = require('./errors');
const dbm = require('./db');
const authM = require('./auth');
const menuM = require('./menu');
const ordersM = require('./orders');
const mockpayM = require('./mockpay');
const qr = require('./qr');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

function createApp(opts = {}) {
  const cfg = { ...config, ...opts };
  cfg.UPLOAD_DIR = path.resolve(cfg.UPLOAD_DIR);
  const clock = { offsetMs: 0, now() { return Date.now() + this.offsetMs; } }; // offsetMs 只用于演示"快进时间"
  const db = dbm.open(cfg.DB_FILE);
  let orders; // 先声明，mockpay 的通知回调要用
  const mockpay = mockpayM.create(db, { onNotify: (no, tx, amt) => orders.onPaid(no, tx, amt) }); // 对应 D1 微信支付通知
  const auth = authM.create(db, clock);
  const menu = menuM.create(db, clock);
  orders = ordersM.create(db, clock, menu, mockpay, cfg);

  // ---------- 路由表 ----------
  const routes = [];
  // roles: null=不需要登录；'ANY'=任意已登录；['STAFF']=指定角色
  const route = (method, p, roles, handler) => {
    const keys = [];
    const re = new RegExp('^' + p.replace(/:([a-z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, roles, handler });
  };
  const int = (v, name = 'id') => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw new ApiError(40001, `${name} 无效`); return n; };

  // 简单限流：A4、A7 每个用户每分钟不超过 10 次（设计文档 5.1）
  const hits = new Map();
  const limit = (userId) => {
    const k = userId + ':' + Math.floor(clock.now() / 60000);
    const n = (hits.get(k) || 0) + 1; hits.set(k, n);
    if (hits.size > 5000) hits.clear();
    if (n > 10) throw new ApiError(42901, '操作太频繁，请稍后再试');
  };

  // 登录（A1、A2）
  route('POST', '/api/auth/guest-login', null, ({ body }) => auth.loginGuest(body.device_id));
  route('POST', '/api/auth/staff-login', null, ({ body }) => auth.loginStaff(body.username, body.password));

  // 顾客（A3~A9）
  route('GET', '/api/menu', null, () => menu.customerMenu());
  route('POST', '/api/orders', ['CUSTOMER'], ({ user, body }) => { limit(user.id); return orders.createOrder(user.id, body); });
  route('GET', '/api/orders', ['CUSTOMER'], ({ user, query }) => orders.listMine(user.id, query.scope));
  route('GET', '/api/orders/:id', ['CUSTOMER'], ({ user, params }) => orders.view(user.id, int(params.id)));
  route('POST', '/api/orders/:id/pay', ['CUSTOMER'], ({ user, params }) => orders.continuePay(user.id, int(params.id)));
  route('POST', '/api/orders/:id/pay-check', ['CUSTOMER'], ({ user, params }) => orders.payCheck(user.id, int(params.id)));
  route('POST', '/api/orders/:id/addons', ['CUSTOMER'], ({ user, params, body }) => { limit(user.id); return orders.addOn(user.id, int(params.id), body); });
  // 注意：顾客端没有"取消订单"接口（FR-09）

  // 演示版的"模拟微信支付窗口"：顾客点了确认支付
  // notify=false 表示"支付成功了但微信通知丢了"，用来演示 A6 主动查单和对账任务
  route('POST', '/api/mockpay/:out_trade_no/pay', ['CUSTOMER'], ({ user, params, body }) => {
    const p = db.prepare('SELECT p.*, o.user_id FROM payment p JOIN orders o ON o.id=p.order_id WHERE p.out_trade_no=?').get(params.out_trade_no);
    if (!p || p.user_id !== user.id) throw new ApiError(40401, '支付单不存在');
    if (p.status === 'CLOSED' || (p.status === 'CREATED' && p.expire_at <= clock.now())) throw new ApiError(40901, '支付已超时，请重新下单');
    const r = mockpay.userPays(params.out_trade_no, { notify: body.notify !== false });
    return { status: r.status };
  });

  // 店员（B1~B4）
  route('GET', '/api/staff/orders', ['STAFF'], () => orders.staffList());
  route('POST', '/api/staff/orders/:id/status', ['STAFF'], ({ params, body }) => orders.changeStatus(int(params.id), body.to));
  route('GET', '/api/staff/dishes', ['STAFF'], () => ({ dishes: menu.allDishes().filter((d) => d.on_sale) }));
  route('PUT', '/api/staff/dishes/:id/sold-out', ['STAFF'], ({ params, body }) => menu.setSoldOut(int(params.id), body.sold_out === true));
  route('POST', '/api/staff/orders/:id/refund', ['STAFF'], ({ user, params, body }) =>
    orders.refund(user.id, int(params.id), body.reason_code, body.reason_text));

  // 店长（C1~C6）
  route('GET', '/api/manager/categories', ['MANAGER'], () => ({ categories: menu.listCategories() }));
  route('POST', '/api/manager/categories', ['MANAGER'], ({ body }) => menu.saveCategory(body));
  route('PUT', '/api/manager/categories/:id', ['MANAGER'], ({ params, body }) => menu.saveCategory({ ...body, id: int(params.id) }));
  route('GET', '/api/manager/dishes', ['MANAGER'], () => ({ dishes: menu.allDishes() }));
  route('POST', '/api/manager/dishes', ['MANAGER'], ({ body }) => menu.saveDish(body));
  route('PUT', '/api/manager/dishes/:id', ['MANAGER'], ({ params, body }) => menu.saveDish(body, int(params.id)));
  route('GET', '/api/manager/staff', ['MANAGER'], () => ({
    staff: db.prepare("SELECT id, username, status FROM app_user WHERE role='STAFF' ORDER BY id").all() }));
  route('POST', '/api/manager/staff', ['MANAGER'], ({ body }) => {
    const u = String(body.username || '').trim(), pw = String(body.password || '');
    if (!/^[A-Za-z0-9_]{3,20}$/.test(u)) throw new ApiError(40001, '用户名需为 3~20 位字母、数字或下划线');
    if (pw.length < 6 || pw.length > 50) throw new ApiError(40001, '密码至少 6 位');
    try { return { id: Number(db.prepare("INSERT INTO app_user(role,username,password_hash) VALUES ('STAFF',?,?)").run(u, dbm.hashPassword(pw)).lastInsertRowid) }; }
    catch (e) { if (/UNIQUE/.test(e.message)) throw new ApiError(40001, '用户名已存在'); throw e; }
  });
  route('PUT', '/api/manager/staff/:id/status', ['MANAGER'], ({ params, body }) => {
    if (!['ENABLED', 'DISABLED'].includes(body.status)) throw new ApiError(40001, '状态无效');
    const r = db.prepare("UPDATE app_user SET status=? WHERE id=? AND role='STAFF'").run(body.status, int(params.id));
    if (!r.changes) throw new ApiError(40401, '员工不存在');
    return { id: Number(params.id), status: body.status };
  });
  route('GET', '/api/manager/orders', ['MANAGER'], ({ query }) => {
    const today = orders.bizDate(clock.now());
    return orders.listByDate(query.from || today, query.to || today, query.page, query.page_size);
  });
  route('GET', '/api/manager/stats', ['MANAGER'], ({ query }) => orders.stats(query.date || orders.bizDate(clock.now())));
  // 上传菜品图片：浏览器先压缩成 JPEG，再以 data URL 形式上传，保存成文件，返回可访问的地址
  route('POST', '/api/manager/upload', ['MANAGER'], ({ body }) => {
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ''));
    if (!m) throw new ApiError(40001, '只支持 jpg / png / webp 图片');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 700 * 1024) throw new ApiError(40001, '图片太大，请换一张（压缩后需小于 700KB）');
    fs.mkdirSync(cfg.UPLOAD_DIR, { recursive: true });
    const name = require('crypto').createHash('sha1').update(buf).digest('hex').slice(0, 16) + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
    fs.writeFileSync(path.join(cfg.UPLOAD_DIR, name), buf);
    return { url: '/uploads/' + name };
  });
  route('GET', '/api/manager/exceptions', ['MANAGER'], () => orders.exceptions());
  route('POST', '/api/manager/refunds/:order_id/retry', ['MANAGER'], ({ params }) => orders.retryRefund(int(params.order_id)));
  route('POST', '/api/manager/payments/:id/resolve', ['MANAGER'], ({ params, body }) => orders.resolvePayment(int(params.id), body.note));

  // 微信回调 D1（演示版由 MockPay 内部直接调用 onPaid，这里留出真实微信回调的入口位置）
  route('POST', '/wx/pay/notify', null, () => { throw new ApiError(50000, '演示版使用 MockPay，没有真实微信回调'); });

  // 其他
  route('GET', '/api/info', null, () => ({ urls: lanUrls(), dev: cfg.DEV, server_time: clock.now() }));
  route('GET', '/api/qr', null, ({ query }) => ({ raw: qr.toSvg(String(query.text || '').slice(0, 200), 8), contentType: MIME['.svg'] }));

  // 演示开关（只有 DEV 打开时可用）：快进时间、模拟退款失败、模拟微信查单失败
  if (cfg.DEV) {
    route('POST', '/api/dev/advance-clock', ['MANAGER'], ({ body }) => {
      const m = Number(body.minutes); if (!(m >= 0 && m <= 24 * 60)) throw new ApiError(40001, 'minutes 无效');
      clock.offsetMs += m * 60000; return { server_time: clock.now(), jobs: orders.runJobs() };
    });
    route('POST', '/api/dev/mock', ['MANAGER'], ({ body }) => {
      if (typeof body.refund_fail === 'boolean') mockpay.state.refundFail = body.refund_fail;
      if (typeof body.query_error === 'boolean') mockpay.state.queryError = body.query_error;
      return { ...mockpay.state };
    });
    route('GET', '/api/dev/mock', ['MANAGER'], () => ({ ...mockpay.state, server_time: clock.now() }));
  }

  function lanUrls() {
    const out = [];
    for (const list of Object.values(os.networkInterfaces()))
      for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(`http://${i.address}:${cfg.PORT}/`);
    return out;
  }

  // ---------- 请求处理 ----------
  function send(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      req.on('data', (c) => { size += c.length; if (size > 1e6) { reject(new ApiError(40001, '请求太大')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { const b = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(b && typeof b === 'object' ? b : {}); }
        catch (e) { reject(new ApiError(40001, 'JSON 格式错误')); }
      });
      req.on('error', reject);
    });
  }
  function serveStatic(req, res, pathname) {
    let rel = pathname === '/' ? '/index.html' : pathname;
    // /uploads/ 下是店长上传的菜品图片，存放在 data/uploads；其余在 public/
    const root = rel.startsWith('/uploads/') ? cfg.UPLOAD_DIR : PUBLIC_DIR;
    if (root === cfg.UPLOAD_DIR) rel = rel.slice('/uploads'.length);
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root)) { res.writeHead(403); return res.end('forbidden'); } // 防止 ../ 越权读文件
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 Not Found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const pathname = decodeURIComponent(url.pathname);
    try {
      if (!pathname.startsWith('/api/') && !pathname.startsWith('/wx/')) return serveStatic(req, res, pathname);
      const r = routes.find((x) => x.method === req.method && x.re.test(pathname));
      if (!r) throw new ApiError(40401, '接口不存在', null, 404);
      const m = pathname.match(r.re);
      const params = {}; r.keys.forEach((k, i) => { params[k] = m[i + 1]; });
      let user = null;
      if (r.roles) {
        const h = req.headers.authorization || '';
        user = auth.verify(h.startsWith('Bearer ') ? h.slice(7) : '');
        // 角色校验：顾客调店员接口、店员调店长接口都返回 40301（NFR-06）
        if (r.roles !== 'ANY' && !r.roles.includes(user.role)) throw new ApiError(40301, '无权限');
      }
      const body = req.method === 'GET' ? {} : await readBody(req);
      const data = await r.handler({ req, user, params, body, query: Object.fromEntries(url.searchParams) });
      if (data && data.raw) { res.writeHead(200, { 'Content-Type': data.contentType, 'Cache-Control': 'no-store' }); return res.end(data.raw); }
      send(res, 200, { code: 0, message: 'ok', data });
    } catch (e) {
      if (e instanceof ApiError) return send(res, e.http, { code: e.code, message: e.message, data: e.data });
      console.error(e);
      send(res, 500, { code: 50000, message: '服务内部错误', data: null });
    }
  });

  let timer = null;
  return {
    server, db, clock, orders, menu, mockpay, auth, cfg,
    start() {
      return new Promise((resolve) => server.listen(cfg.PORT, '0.0.0.0', () => {
        timer = setInterval(() => { try { orders.runJobs(); } catch (e) { console.error('定时任务出错', e); } }, cfg.JOB_INTERVAL_MS);
        resolve(server.address().port);
      }));
    },
    stop() { clearInterval(timer); return new Promise((r) => server.close(() => { db.close(); r(); })); },
    lanUrls,
  };
}
module.exports = { createApp };
