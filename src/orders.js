// order 模块：下单、追加、支付确认、状态机、取餐号、排队数、退款、定时任务
// 对应设计文档第 3、4 节。这是整个系统最核心的文件。
const { ApiError } = require('./errors');
const { tx } = require('./db');

// ---------- 订单状态机（设计文档 4.1）：集中保存合法的状态转移，其他转移一律拒绝 ----------
const TRANSITIONS = {
  PENDING_PAY: ['WAIT_ACCEPT', 'CLOSED'],
  WAIT_ACCEPT: ['COOKING', 'REFUNDED', 'REFUND_FAILED'],
  COOKING: ['DONE', 'REFUNDED', 'REFUND_FAILED'],
  DONE: ['PICKED', 'REFUNDED', 'REFUND_FAILED'],
  REFUND_FAILED: ['REFUNDED'],
  CLOSED: [], PICKED: [], REFUNDED: [],
};
const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

// 顾客端 / 店员端的状态文字（设计文档 7.2）
const CUSTOMER_TEXT = {
  PENDING_PAY: '待支付', CLOSED: '已关闭', WAIT_ACCEPT: '等待中', COOKING: '制作中',
  DONE: '已完成，请取餐', PICKED: '已取餐', REFUNDED: '已退款', REFUND_FAILED: '退款失败，请联系店员',
};
const STAFF_TEXT = { ...CUSTOMER_TEXT, WAIT_ACCEPT: '待接单', DONE: '待取餐', REFUND_FAILED: '退款失败' };

const pad = (n, w) => String(n).padStart(w, '0');
function bizDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
}

function create(db, clock, menu, mockpay, cfg) {
  const now = () => clock.now();

  // ---------- 内部工具 ----------
  function buildLines(items) {
    if (!Array.isArray(items) || items.length === 0 || items.length > 50) throw new ApiError(40001, '购物车不能为空');
    const lines = [];
    let total = 0;
    for (const it of items) {
      if (!Number.isInteger(it.dish_id) || !Number.isInteger(it.quantity) || it.quantity < 1 || it.quantity > 99)
        throw new ApiError(40001, '菜品数量需要在 1~99 之间');
      const ids = Array.isArray(it.spec_option_ids) ? it.spec_option_ids : [];
      if (!ids.every(Number.isInteger)) throw new ApiError(40001, '规格参数错误');
      // 金额一律由服务端按数据库当前价格重新计算，不信任客户端（FR-04、FR-14）
      const p = menu.priceOf(it.dish_id, ids);
      lines.push({ dish_id: it.dish_id, dish_name: p.dish.name, spec_text: p.spec_text, unit_price_fen: p.unit_price_fen, quantity: it.quantity });
      total += p.unit_price_fen * it.quantity;
    }
    return { lines, total };
  }

  function checkRemark(remark) {
    remark = remark == null ? '' : String(remark);
    if ([...remark].length > cfg.REMARK_MAX) throw new ApiError(40001, `备注最多 ${cfg.REMARK_MAX} 字`);
    return remark;
  }

  function mustOwn(userId, orderId) {
    const o = db.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(orderId, userId);
    if (!o) throw new ApiError(40401, '订单不存在'); // 顾客访问他人订单也是这个结果（NFR-06）
    return o;
  }
  const openPayment = (orderId) =>
    db.prepare("SELECT * FROM payment WHERE order_id=? AND status='CREATED' ORDER BY batch_no DESC LIMIT 1").get(orderId);
  const payParams = (p) => mockpay.prepay(p.out_trade_no, p.amount_fen);

  function insertPayment(orderId, orderNo, batchNo, amount, lines) {
    const t = now();
    const outTradeNo = `${orderNo}-${batchNo}`; // 商户订单号 = 订单号 + "-" + 批次号
    const pid = Number(db.prepare(
      'INSERT INTO payment(order_id,batch_no,out_trade_no,amount_fen,expire_at,created_at) VALUES (?,?,?,?,?,?)'
    ).run(orderId, batchNo, outTradeNo, amount, t + cfg.PAY_TIMEOUT_MIN * 60000, t).lastInsertRowid);
    const ins = db.prepare(
      'INSERT INTO order_item(order_id,payment_id,batch_no,dish_id,dish_name,spec_text,unit_price_fen,quantity) VALUES (?,?,?,?,?,?,?,?)');
    for (const l of lines) ins.run(orderId, pid, batchNo, l.dish_id, l.dish_name, l.spec_text, l.unit_price_fen, l.quantity);
    return db.prepare('SELECT * FROM payment WHERE id=?').get(pid);
  }

  function queueAhead(o) {
    if (!['WAIT_ACCEPT', 'COOKING'].includes(o.status) || o.pickup_no == null) return 0;
    // 设计文档 4.4：同一营业日、待接单或制作中、取餐号比本单小的订单数
    return db.prepare(
      "SELECT COUNT(*) c FROM orders WHERE biz_date=? AND status IN ('WAIT_ACCEPT','COOKING') AND pickup_no<?"
    ).get(o.biz_date, o.pickup_no).c;
  }

  // 系统自动退款：支付已成功，但订单已关闭/取餐号用完/追加时订单已完成（设计文档 4.3）
  function autoRefund(order, payment, why) {
    const rid = Number(db.prepare(
      "INSERT INTO refund(order_id,payment_id,amount_fen,reason_code,reason_text,status,operator_id,created_at) VALUES (?,?,?,'SYSTEM',?, 'PROCESSING',NULL,?)"
    ).run(order.id, payment.id, payment.amount_fen, why, now()).lastInsertRowid);
    const no = `R${order.order_no}-${rid}`;
    const r = mockpay.refund(no, payment.out_trade_no, payment.amount_fen);
    db.prepare('UPDATE refund SET out_refund_no=?, status=? WHERE id=?').run(no, r.ok ? 'SUCCESS' : 'FAILED', rid);
    db.prepare('UPDATE payment SET manual_check=1, note=? WHERE id=?').run(why + (r.ok ? '（已自动退款）' : '（自动退款失败，请人工处理）'), payment.id);
  }

  const self = {
    TRANSITIONS, canTransition, CUSTOMER_TEXT, STAFF_TEXT, bizDate,

    // ---------- A4 下单 ----------
    createOrder(userId, body) {
      const requestId = body.request_id;
      if (typeof requestId !== 'string' || requestId.length < 8 || requestId.length > 64) throw new ApiError(40001, 'request_id 无效');
      // 同一个 request_id 重试，直接返回已有订单，不会重复下单（EX-04）
      const dup = db.prepare('SELECT * FROM orders WHERE user_id=? AND request_id=?').get(userId, requestId);
      if (dup) return self.createResult(dup);

      const remark = checkRemark(body.remark);
      const { lines, total } = buildLines(body.items);
      if (Number.isInteger(body.expected_total_fen) && body.expected_total_fen !== total)
        throw new ApiError(40903, '价格已更新', { total_fen: total }); // EX-05

      const order = tx(db, () => {
        const t = now();
        const date = bizDate(t);
        db.prepare('INSERT OR IGNORE INTO daily_counter(biz_date) VALUES (?)').run(date);
        const c = db.prepare('SELECT * FROM daily_counter WHERE biz_date=?').get(date);
        if (c.pickup_seq >= cfg.MAX_PICKUP_NO) throw new ApiError(40904, '今日取餐号已发完');
        db.prepare('UPDATE daily_counter SET order_seq=order_seq+1 WHERE biz_date=?').run(date);
        const orderNo = date.replace(/-/g, '') + pad(c.order_seq + 1, 6);
        const oid = Number(db.prepare(
          "INSERT INTO orders(order_no,user_id,request_id,biz_date,status,remark,total_fen,created_at) VALUES (?,?,?,?, 'PENDING_PAY',?,?,?)"
        ).run(orderNo, userId, requestId, date, remark, total, t).lastInsertRowid);
        const pay = insertPayment(oid, orderNo, 0, total, lines);
        mockpay.prepay(pay.out_trade_no, pay.amount_fen);
        return db.prepare('SELECT * FROM orders WHERE id=?').get(oid);
      });
      return self.createResult(order);
    },
    createResult(o) {
      const p = o.status === 'PENDING_PAY' ? openPayment(o.id) : null;
      return { order_id: o.id, order_no: o.order_no, status: o.status, total_fen: o.total_fen, pay_params: p ? payParams(p) : null };
    },

    // ---------- A5 继续支付 ----------
    continuePay(userId, orderId) {
      const o = mustOwn(userId, orderId);
      const p = openPayment(o.id);
      if (!p || p.expire_at <= now()) throw new ApiError(40901, '订单已超时关闭，请重新下单');
      return { pay_params: payParams(p) };
    },

    // ---------- A6 支付后主动确认：向"微信"查单，成功就走 onPaid ----------
    payCheck(userId, orderId) {
      const o = mustOwn(userId, orderId);
      for (const p of db.prepare("SELECT * FROM payment WHERE order_id=? AND status='CREATED'").all(o.id)) {
        let q;
        try { q = mockpay.query(p.out_trade_no); } catch (e) { throw new ApiError(50001, '微信接口调用失败，请稍后重试'); }
        if (q.state === 'SUCCESS') self.onPaid(p.out_trade_no, q.transaction_id, q.amount_fen);
      }
      return { status: db.prepare('SELECT status FROM orders WHERE id=?').get(o.id).status };
    },

    // ---------- A7 追加菜品（R-2：只有待接单/制作中才能追加）----------
    addOn(userId, orderId, body) {
      const o = mustOwn(userId, orderId);
      if (!['WAIT_ACCEPT', 'COOKING'].includes(o.status)) throw new ApiError(40901, '订单已完成，请重新下单');
      const open = openPayment(o.id);
      if (open) return { pay_params: payParams(open), payment_batch: open.batch_no }; // 同时只能有一笔未支付的追加
      const { lines, total } = buildLines(body.items);
      if (Number.isInteger(body.expected_total_fen) && body.expected_total_fen !== total)
        throw new ApiError(40903, '价格已更新', { total_fen: total });
      const pay = tx(db, () => {
        const batch = db.prepare('SELECT MAX(batch_no) m FROM payment WHERE order_id=?').get(o.id).m + 1;
        return insertPayment(o.id, o.order_no, batch, total, lines);
      });
      return { pay_params: payParams(pay), payment_batch: pay.batch_no };
    },

    // ---------- onPaid：支付结果处理，幂等（设计文档 4.3）----------
    // 微信通知、主动查单、对账任务三条途径，谁先到都调用它，重复调用是安全的
    onPaid(outTradeNo, transactionId, amountFen) {
      return tx(db, () => {
        const p = db.prepare('SELECT * FROM payment WHERE out_trade_no=?').get(outTradeNo);
        if (!p) return { ok: false, reason: 'unknown' };
        if (p.status === 'SUCCESS') return { ok: true, repeated: true };          // 1. 已处理过，直接返回（EX-03）
        if (p.status === 'CLOSED') {                                              //    已关闭的支付又收到成功通知：收了钱就要退
          db.prepare("UPDATE payment SET status='SUCCESS', wx_transaction_id=?, paid_at=? WHERE id=?").run(transactionId, now(), p.id);
          autoRefund(db.prepare('SELECT * FROM orders WHERE id=?').get(p.order_id), p, '支付关闭后才收到付款');
          return { ok: true, refunded: true };
        }
        if (amountFen !== p.amount_fen) {                                         // 2. 金额不符：不改订单，标记人工核对
          db.prepare('UPDATE payment SET manual_check=1, note=? WHERE id=?').run(`通知金额 ${amountFen} 与订单金额 ${p.amount_fen} 不符`, p.id);
          return { ok: false, reason: 'amount_mismatch' };
        }
        const t = now();
        db.prepare("UPDATE payment SET status='SUCCESS', wx_transaction_id=?, paid_at=? WHERE id=?").run(transactionId, t, p.id); // 3.
        const o = db.prepare('SELECT * FROM orders WHERE id=?').get(p.order_id);
        if (p.batch_no === 0) {                                                   // 4. 首次付款
          const c = db.prepare('SELECT * FROM daily_counter WHERE biz_date=?').get(o.biz_date);
          if (o.status !== 'PENDING_PAY' || c.pickup_seq >= cfg.MAX_PICKUP_NO) {
            autoRefund(o, p, o.status !== 'PENDING_PAY' ? '订单已关闭后才收到付款' : '今日取餐号已发完');
            return { ok: true, refunded: true };
          }
          // 取餐号：在计数器行里加 1（事务内串行），并有 (biz_date, pickup_no) 唯一索引兜底
          const no = c.pickup_seq + 1;
          db.prepare('UPDATE daily_counter SET pickup_seq=? WHERE biz_date=?').run(no, o.biz_date);
          // 条件更新：只有还是"待支付"才改成"待接单"
          db.prepare("UPDATE orders SET status='WAIT_ACCEPT', pickup_no=?, paid_at=? WHERE id=? AND status='PENDING_PAY'").run(no, t, o.id);
          db.prepare("UPDATE order_item SET status='CONFIRMED' WHERE payment_id=?").run(p.id);
        } else {                                                                  // 5. 追加付款
          if (['WAIT_ACCEPT', 'COOKING'].includes(o.status)) {
            db.prepare("UPDATE order_item SET status='CONFIRMED' WHERE payment_id=?").run(p.id);
            db.prepare('UPDATE orders SET total_fen=total_fen+? WHERE id=?').run(p.amount_fen, o.id);
          } else {
            db.prepare("UPDATE order_item SET status='CANCELLED' WHERE payment_id=?").run(p.id);
            autoRefund(o, p, '追加付款时订单已不能追加');
          }
        }
        return { ok: true };
      });
    },

    // ---------- A8 / A9 顾客查看订单 ----------
    view(userId, orderId) {
      return self.viewOrder(mustOwn(userId, orderId));
    },
    viewOrder(o) {
      const open = o.status === 'PENDING_PAY' || ['WAIT_ACCEPT', 'COOKING'].includes(o.status) ? openPayment(o.id) : null;
      const items = db.prepare("SELECT * FROM order_item WHERE order_id=? AND status<>'CANCELLED' ORDER BY id").all(o.id)
        .map((i) => ({ dish_name: i.dish_name, spec_text: i.spec_text, unit_price_fen: i.unit_price_fen, quantity: i.quantity,
                       is_addon: i.batch_no > 0, confirmed: i.status === 'CONFIRMED' }));
      return {
        id: o.id, order_no: o.order_no, status: o.status, status_text: CUSTOMER_TEXT[o.status],
        pickup_no: o.pickup_no, pickup_no_text: o.pickup_no == null ? null : pad(o.pickup_no, 3),
        queue_ahead: queueAhead(o), items, total_fen: o.total_fen, remark: o.remark,
        created_at: o.created_at, paid_at: o.paid_at,
        open_payment: open ? { batch_no: open.batch_no, amount_fen: open.amount_fen, expire_at: open.expire_at } : null,
        can_addon: ['WAIT_ACCEPT', 'COOKING'].includes(o.status) && !open,
      };
    },
    listMine(userId, scope) {
      const rows = scope === 'active'
        ? db.prepare("SELECT * FROM orders WHERE user_id=? AND status IN ('PENDING_PAY','WAIT_ACCEPT','COOKING','DONE') ORDER BY id DESC").all(userId)
        : db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 20').all(userId);
      return { orders: rows.map((o) => self.viewOrder(o)) };
    },

    // ---------- B1 店员订单列表 ----------
    staffList() {
      const rows = db.prepare("SELECT * FROM orders WHERE status IN ('WAIT_ACCEPT','COOKING','DONE') ORDER BY biz_date, pickup_no").all();
      const t = now();
      return {
        now: t,
        orders: rows.map((o) => {
          const items = db.prepare(
            `SELECT i.*, d.sold_out, d.on_sale FROM order_item i LEFT JOIN dish d ON d.id=i.dish_id
             WHERE i.order_id=? AND i.status='CONFIRMED' ORDER BY i.id`).all(o.id);
          return {
            id: o.id, order_no: o.order_no, pickup_no: o.pickup_no, pickup_no_text: pad(o.pickup_no, 3),
            status: o.status, status_text: STAFF_TEXT[o.status], remark: o.remark, total_fen: o.total_fen,
            paid_at: o.paid_at, reminded_at: o.reminded_at,
            overdue: o.status === 'WAIT_ACCEPT' && t - o.paid_at >= cfg.ACCEPT_REMIND_MIN * 60000, // 超过 5 分钟没接单标红
            contains_sold_out: ['WAIT_ACCEPT', 'COOKING'].includes(o.status) && items.some((i) => i.sold_out || !i.on_sale),
            items: items.map((i) => ({ dish_name: i.dish_name, spec_text: i.spec_text, quantity: i.quantity, is_addon: i.batch_no > 0 })),
          };
        }),
      };
    },

    // ---------- B2 改订单状态：依次改变，不能跳过（FR-11）----------
    changeStatus(orderId, to) {
      const next = { COOKING: 'WAIT_ACCEPT', DONE: 'COOKING', PICKED: 'DONE' }; // 目标状态 -> 必须的当前状态
      if (!next[to]) throw new ApiError(40001, '目标状态无效');
      // 条件更新（WHERE status=?）：两个店员同时点，只有一个能成功（设计文档 6.3 第 4 条）
      const r = db.prepare('UPDATE orders SET status=? WHERE id=? AND status=?').run(to, orderId, next[to]);
      if (!r.changes) {
        if (!db.prepare('SELECT 1 FROM orders WHERE id=?').get(orderId)) throw new ApiError(40401, '订单不存在');
        throw new ApiError(40901, '订单状态不允许此操作，请刷新');
      }
      return { id: orderId, status: to };
    },

    // ---------- B4 整单退款（R-1、R-3）----------
    refund(operatorId, orderId, reasonCode, reasonText) {
      if (!['SOLD_OUT', 'CUSTOMER_REQUEST', 'OTHER'].includes(reasonCode)) throw new ApiError(40001, '请选择退款原因');
      reasonText = reasonText == null ? '' : String(reasonText).trim();
      if (reasonCode === 'OTHER' && !reasonText) throw new ApiError(40001, '选择"其他"时请填写原因');
      if ([...reasonText].length > 50) throw new ApiError(40001, '退款原因最多 50 字');
      return tx(db, () => {
        const o = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
        if (!o) throw new ApiError(40401, '订单不存在');
        if (!['WAIT_ACCEPT', 'COOKING', 'DONE'].includes(o.status)) throw new ApiError(40901, '该订单状态不能退款（已取餐的订单请线下处理）');
        // 还没付款的追加：先作废，不退款
        const open = openPayment(o.id);
        if (open) {
          mockpay.close(open.out_trade_no);
          db.prepare("UPDATE payment SET status='CLOSED' WHERE id=?").run(open.id);
          db.prepare("UPDATE order_item SET status='CANCELLED' WHERE payment_id=?").run(open.id);
        }
        // 每一笔已成功的支付各建一条退款记录（记录操作人、时间、原因）
        const pays = db.prepare("SELECT * FROM payment WHERE order_id=? AND status='SUCCESS'").all(o.id);
        let allOk = true;
        for (const p of pays) {
          if (db.prepare("SELECT 1 FROM refund WHERE payment_id=? AND status IN ('SUCCESS','PROCESSING')").get(p.id)) continue;
          const rid = Number(db.prepare(
            "INSERT INTO refund(order_id,payment_id,amount_fen,reason_code,reason_text,status,operator_id,created_at) VALUES (?,?,?,?,?,'PROCESSING',?,?)"
          ).run(o.id, p.id, p.amount_fen, reasonCode, reasonText, operatorId, now()).lastInsertRowid);
          const no = `R${o.order_no}-${rid}`;
          const r = mockpay.refund(no, p.out_trade_no, p.amount_fen);
          db.prepare('UPDATE refund SET out_refund_no=?, status=? WHERE id=?').run(no, r.ok ? 'SUCCESS' : 'FAILED', rid);
          if (!r.ok) allOk = false;
        }
        const to = allOk ? 'REFUNDED' : 'REFUND_FAILED';
        const r = db.prepare("UPDATE orders SET status=? WHERE id=? AND status IN ('WAIT_ACCEPT','COOKING','DONE')").run(to, o.id);
        if (!r.changes) throw new ApiError(40901, '订单状态已变化，请刷新');
        return { id: o.id, status: to };
      });
    },
    // C6 店长重试退款：用同一个退款单号（幂等）
    retryRefund(orderId) {
      return tx(db, () => {
        const o = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
        if (!o) throw new ApiError(40401, '订单不存在');
        if (o.status !== 'REFUND_FAILED') throw new ApiError(40901, '只有"退款失败"的订单可以重试');
        for (const f of db.prepare("SELECT r.*, p.out_trade_no FROM refund r JOIN payment p ON p.id=r.payment_id WHERE r.order_id=? AND r.status='FAILED'").all(o.id)) {
          const r = mockpay.refund(f.out_refund_no, f.out_trade_no, f.amount_fen);
          if (r.ok) db.prepare("UPDATE refund SET status='SUCCESS' WHERE id=?").run(f.id);
        }
        const left = db.prepare("SELECT COUNT(*) c FROM refund WHERE order_id=? AND status<>'SUCCESS' AND operator_id IS NOT NULL").get(o.id).c;
        if (left === 0) db.prepare("UPDATE orders SET status='REFUNDED' WHERE id=? AND status='REFUND_FAILED'").run(o.id);
        return { id: o.id, status: left === 0 ? 'REFUNDED' : 'REFUND_FAILED' };
      });
    },

    // ---------- C5 / C6 店长查询 ----------
    listByDate(from, to, page, pageSize) {
      const re = /^\d{4}-\d{2}-\d{2}$/;
      if (!re.test(from || '') || !re.test(to || '')) throw new ApiError(40001, '日期格式应为 YYYY-MM-DD');
      page = Math.max(1, Number(page) || 1);
      pageSize = Math.min(50, Math.max(1, Number(pageSize) || 20));
      const total = db.prepare('SELECT COUNT(*) c FROM orders WHERE biz_date BETWEEN ? AND ?').get(from, to).c;
      const rows = db.prepare('SELECT * FROM orders WHERE biz_date BETWEEN ? AND ? ORDER BY id DESC LIMIT ? OFFSET ?')
        .all(from, to, pageSize, (page - 1) * pageSize);
      return {
        total, page, page_size: pageSize,
        orders: rows.map((o) => ({ id: o.id, order_no: o.order_no, pickup_no_text: o.pickup_no == null ? '' : pad(o.pickup_no, 3),
          total_fen: o.total_fen, status: o.status, status_text: STAFF_TEXT[o.status], created_at: o.created_at, biz_date: o.biz_date })),
      };
    },
    // 店长端“营业统计”：某一天的营业额、订单数、热销菜、分时段订单数
    // 营业额 = 当天已支付金额 - 当天已成功的退款；有效订单 = 已付款且没有退款的订单
    stats(date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new ApiError(40001, '日期格式应为 YYYY-MM-DD');
      const gross = db.prepare(
        `SELECT COALESCE(SUM(p.amount_fen),0) s FROM payment p JOIN orders o ON o.id=p.order_id
         WHERE o.biz_date=? AND p.status='SUCCESS'`).get(date).s;
      const refunded = db.prepare(
        `SELECT COALESCE(SUM(r.amount_fen),0) s, COUNT(DISTINCT r.order_id) n FROM refund r JOIN orders o ON o.id=r.order_id
         WHERE o.biz_date=? AND r.status='SUCCESS'`).get(date);
      const valid = "o.status IN ('WAIT_ACCEPT','COOKING','DONE','PICKED')";
      const orderCount = db.prepare(`SELECT COUNT(*) c FROM orders o WHERE o.biz_date=? AND ${valid}`).get(date).c;
      const top = db.prepare(
        `SELECT i.dish_name name, SUM(i.quantity) qty, SUM(i.quantity*i.unit_price_fen) amount_fen
         FROM order_item i JOIN orders o ON o.id=i.order_id
         WHERE o.biz_date=? AND ${valid} AND i.status='CONFIRMED'
         GROUP BY i.dish_name ORDER BY qty DESC, amount_fen DESC LIMIT 5`).all(date);
      const paidTimes = db.prepare(`SELECT paid_at FROM orders o WHERE o.biz_date=? AND ${valid} AND paid_at IS NOT NULL`).all(date);
      const byHour = Array(24).fill(0);
      for (const r of paidTimes) byHour[new Date(r.paid_at).getHours()]++;
      const revenue = gross - refunded.s;
      return {
        date, revenue_fen: revenue, gross_fen: gross, refund_fen: refunded.s, refund_orders: refunded.n,
        order_count: orderCount, avg_fen: orderCount ? Math.round(revenue / orderCount) : 0, top_dishes: top, by_hour: byHour,
      };
    },
    exceptions() {
      return {
        payments: db.prepare(
          `SELECT p.id, p.out_trade_no, p.amount_fen, p.note, p.created_at, o.order_no, o.status
           FROM payment p JOIN orders o ON o.id=p.order_id WHERE p.manual_check=1 ORDER BY p.id`).all(),
        refund_failed: db.prepare("SELECT id, order_no, total_fen, pickup_no FROM orders WHERE status='REFUND_FAILED' ORDER BY id").all(),
      };
    },
    resolvePayment(id, note) {
      note = String(note || '').trim();
      if (!note || [...note].length > 100) throw new ApiError(40001, '请填写核对说明（最多 100 字）');
      const r = db.prepare('UPDATE payment SET manual_check=0, note=COALESCE(note,\'\') || \' | 已核对：\' || ? WHERE id=? AND manual_check=1').run(note, id);
      if (!r.changes) throw new ApiError(40401, '没有找到待核对的支付');
      return { id };
    },

    // ---------- 定时任务（设计文档 4.7）：只靠扫描数据库状态，服务重启后继续扫描，不会丢任务 ----------
    closeExpired() {
      let n = 0;
      for (const p of db.prepare("SELECT * FROM payment WHERE status='CREATED' AND expire_at<=?").all(now())) {
        let r;
        try { r = mockpay.close(p.out_trade_no); } catch (e) { continue; } // 关单失败，下一轮再试
        if (r.state === 'PAID') { self.onPaid(p.out_trade_no, r.transaction_id, r.amount_fen); continue; } // 实际已支付，以微信为准
        tx(db, () => {
          const c = db.prepare("UPDATE payment SET status='CLOSED' WHERE id=? AND status='CREATED'").run(p.id).changes;
          if (!c) return;
          db.prepare("UPDATE order_item SET status='CANCELLED' WHERE payment_id=?").run(p.id);
          if (p.batch_no === 0) db.prepare("UPDATE orders SET status='CLOSED' WHERE id=? AND status='PENDING_PAY'").run(p.order_id);
          n++;
        });
      }
      return n;
    },
    reconcile() {
      let n = 0;
      const rows = db.prepare("SELECT * FROM payment WHERE status='CREATED' AND created_at<=? AND expire_at>?")
        .all(now() - cfg.RECONCILE_AFTER_SEC * 1000, now());
      for (const p of rows) {
        let q;
        try { q = mockpay.query(p.out_trade_no); } catch (e) {
          // 连续 3 次查不到结果，转人工核对
          const cnt = p.query_fail_count + 1;
          db.prepare('UPDATE payment SET query_fail_count=?, manual_check=?, note=? WHERE id=?')
            .run(cnt, cnt >= 3 ? 1 : p.manual_check, cnt >= 3 ? '微信查单连续失败，待人工核对' : p.note, p.id);
          continue;
        }
        db.prepare('UPDATE payment SET query_fail_count=0 WHERE id=?').run(p.id);
        if (q.state === 'SUCCESS') { self.onPaid(p.out_trade_no, q.transaction_id, q.amount_fen); n++; }
      }
      return n;
    },
    remindUnaccepted() {
      return db.prepare("UPDATE orders SET reminded_at=? WHERE status='WAIT_ACCEPT' AND reminded_at IS NULL AND paid_at<=?")
        .run(now(), now() - cfg.ACCEPT_REMIND_MIN * 60000).changes;
    },
    runJobs() {
      return { closed: self.closeExpired(), reconciled: self.reconcile(), reminded: self.remindUnaccepted() };
    },
  };
  return self;
}
module.exports = { create, TRANSITIONS, canTransition };
