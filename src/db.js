// 数据层：SQLite（Node 自带 node:sqlite，不需要安装任何依赖）
// 表结构对应设计文档第 6 节
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS app_user (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('CUSTOMER','STAFF','MANAGER')),
  openid TEXT UNIQUE,            -- 顾客：设备标识（演示版代替微信 openid）
  username TEXT UNIQUE,          -- 员工账号
  password_hash TEXT,            -- 只存哈希，不存明文
  status TEXT NOT NULL DEFAULT 'ENABLED' CHECK (status IN ('ENABLED','DISABLED'))
);
CREATE TABLE IF NOT EXISTS session (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS category (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, sort_no INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS dish (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES category(id),
  name TEXT NOT NULL,
  image_url TEXT,                -- 演示版：可填一个 emoji 或图片地址
  price_fen INTEGER NOT NULL CHECK (price_fen > 0),
  on_sale INTEGER NOT NULL DEFAULT 1,
  sold_out INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dish_spec (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dish_id INTEGER NOT NULL REFERENCES dish(id),
  group_name TEXT NOT NULL, option_name TEXT NOT NULL,
  price_delta_fen INTEGER NOT NULL DEFAULT 0 CHECK (price_delta_fen >= 0),
  is_default INTEGER NOT NULL DEFAULT 0,
  UNIQUE (dish_id, group_name, option_name)
);
CREATE TABLE IF NOT EXISTS daily_counter (
  biz_date TEXT PRIMARY KEY,
  order_seq INTEGER NOT NULL DEFAULT 0,
  pickup_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES app_user(id),
  request_id TEXT NOT NULL,
  biz_date TEXT NOT NULL,
  pickup_no INTEGER,
  status TEXT NOT NULL,
  remark TEXT NOT NULL DEFAULT '',
  total_fen INTEGER NOT NULL,
  reminded_at INTEGER,
  created_at INTEGER NOT NULL,
  paid_at INTEGER,
  UNIQUE (user_id, request_id)   -- 防止网络重试导致重复下单（EX-04）
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pickup ON orders (biz_date, pickup_no) WHERE pickup_no IS NOT NULL;
CREATE TABLE IF NOT EXISTS order_item (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  payment_id INTEGER NOT NULL,
  batch_no INTEGER NOT NULL,
  dish_id INTEGER NOT NULL,
  dish_name TEXT NOT NULL,       -- 下单时的快照（改名、改价不影响历史订单，FR-16）
  spec_text TEXT NOT NULL DEFAULT '',
  unit_price_fen INTEGER NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CONFIRMED','CANCELLED'))
);
CREATE TABLE IF NOT EXISTS payment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  batch_no INTEGER NOT NULL,     -- 0 = 首次下单，1、2... = 追加
  out_trade_no TEXT NOT NULL UNIQUE,
  amount_fen INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED','SUCCESS','CLOSED')),
  expire_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  wx_transaction_id TEXT UNIQUE,
  paid_at INTEGER,
  manual_check INTEGER NOT NULL DEFAULT 0,
  query_fail_count INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  UNIQUE (order_id, batch_no)
);
CREATE TABLE IF NOT EXISTS refund (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  payment_id INTEGER NOT NULL REFERENCES payment(id),
  out_refund_no TEXT UNIQUE,
  amount_fen INTEGER NOT NULL,
  reason_code TEXT NOT NULL CHECK (reason_code IN ('SOLD_OUT','CUSTOMER_REQUEST','OTHER','SYSTEM')),
  reason_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'PROCESSING' CHECK (status IN ('PROCESSING','SUCCESS','FAILED')),
  operator_id INTEGER,           -- 为空表示系统自动退款
  created_at INTEGER NOT NULL
);
-- 模拟"微信支付那一侧"的记录（只在演示版使用，见 src/mockpay.js）
CREATE TABLE IF NOT EXISTS mock_wx_pay (
  out_trade_no TEXT PRIMARY KEY, amount_fen INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'NOTPAY', transaction_id TEXT
);
`;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function checkPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const h = crypto.scryptSync(pw, salt, 32);
  const s = Buffer.from(hash, 'hex');
  return s.length === h.length && crypto.timingSafeEqual(h, s);
}

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  seed(db);
  return db;
}

// 事务：成功提交，出错整体回滚（设计文档 6.3 第 2 条）
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

// 演示数据：账号和快餐菜单
function seed(db) {
  if (db.prepare('SELECT COUNT(*) c FROM app_user').get().c > 0) return;
  const now = Date.now();
  const addUser = db.prepare('INSERT INTO app_user(role,username,password_hash) VALUES (?,?,?)');
  addUser.run('MANAGER', 'manager', hashPassword('manager123'));
  addUser.run('STAFF', 'staff1', hashPassword('staff123'));

  const addCat = db.prepare('INSERT INTO category(name,sort_no) VALUES (?,?)');
  const addDish = db.prepare('INSERT INTO dish(category_id,name,image_url,price_fen,updated_at) VALUES (?,?,?,?,?)');
  const addSpec = db.prepare('INSERT INTO dish_spec(dish_id,group_name,option_name,price_delta_fen,is_default) VALUES (?,?,?,?,?)');
  const cats = ['炒类', '米粉类', '拌饭类', '小吃类', '汤类', '凉菜类', '饮品类'];
  const catId = {};
  cats.forEach((n, i) => { catId[n] = Number(addCat.run(n, i + 1).lastInsertRowid); });

  const size = [['规格', '小碗', 0, 1], ['规格', '大碗', 200, 0]];
  const spicy = [['辣度', '不辣', 0, 1], ['辣度', '微辣', 0, 0], ['辣度', '中辣', 0, 0]];
  const temp = [['温度', '常温', 0, 1], ['温度', '加冰', 0, 0]];
  const cup = [['杯型', '中杯', 0, 1], ['杯型', '大杯', 200, 0]];
  const menu = [
    ['炒类', '青椒肉丝', '🌶️', 1800, [...spicy]],
    ['炒类', '番茄炒蛋', '🍅', 1500, []],
    ['炒类', '蒜蓉青菜', '🥬', 1200, []],
    ['炒类', '宫保鸡丁', '🥜', 1900, [...spicy]],
    ['炒类', '鱼香肉丝', '🥕', 1800, [...spicy]],
    ['炒类', '酸辣土豆丝', '🥔', 1200, [...spicy]],
    ['炒类', '麻婆豆腐', '🧈', 1500, [...spicy]],
    ['炒类', '回锅肉', '🥓', 2200, [...spicy]],
    ['米粉类', '拌面', '🍜', 800, [...size, ...spicy]],
    ['米粉类', '牛肉米粉', '🍲', 1400, [...size, ...spicy]],
    ['米粉类', '扁肉汤', '🥟', 900, [...size]],
    ['米粉类', '炒米粉', '🍝', 1300, [...size, ...spicy]],
    ['米粉类', '肉丝汤面', '🍜', 1200, [...size]],
    ['拌饭类', '卤肉饭', '🍚', 1300, [...spicy]],
    ['拌饭类', '鸡腿饭', '🍗', 1600, [...spicy]],
    ['拌饭类', '香菇鸡肉饭', '🍄', 1500, []],
    ['拌饭类', '排骨饭', '🍖', 1800, [...spicy]],
    ['拌饭类', '蛋炒饭', '🍳', 1100, []],
    ['小吃类', '蒸饺（8个）', '🥟', 900, []],
    ['小吃类', '炖罐汤', '🥣', 1000, []],
    ['小吃类', '茶叶蛋', '🥚', 200, []],
    ['小吃类', '煎饺（8个）', '🥠', 1000, []],
    ['小吃类', '炸鸡排', '🍗', 1200, [...spicy]],
    ['小吃类', '春卷（2个）', '🌯', 600, []],
    ['汤类', '紫菜蛋花汤', '🍵', 600, []],
    ['汤类', '冬瓜排骨汤', '🍲', 1400, []],
    ['汤类', '玉米排骨汤', '🌽', 1500, []],
    ['凉菜类', '凉拌黄瓜', '🥒', 800, [...spicy]],
    ['凉菜类', '口水鸡', '🐔', 1800, [...spicy]],
    ['凉菜类', '凉拌木耳', '🍄', 1000, [...spicy]],
    ['饮品类', '豆浆', '🥛', 400, [...temp]],
    ['饮品类', '酸梅汤', '🧃', 600, [...temp]],
    ['饮品类', '柠檬红茶', '🍋', 800, [...temp, ...cup]],
    ['饮品类', '可乐', '🥤', 500, [...temp]],
    ['饮品类', '矿泉水', '💧', 200, []],
  ];
  for (const [c, name, img, price, specs] of menu) {
    const id = Number(addDish.run(catId[c], name, img, price, now).lastInsertRowid);
    for (const [g, o, d, def] of specs) addSpec.run(id, g, o, d, def);
  }
}

module.exports = { open, tx, hashPassword, checkPassword };
