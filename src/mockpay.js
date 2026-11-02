// MockPay：模拟微信支付的适配器（设计文档 A1：开发和演示阶段用它代替真实支付）
// 业务层只调用这里的 prepay / query / close / refund，
// 以后换成真实微信支付，只需要重写这个文件，业务层不用改。
const crypto = require('crypto');

function create(db, hooks = {}) {
  const state = { refundFail: false, queryError: false };

  return {
    state,
    // 对应 EXT-02 小程序下单：生成预支付单，返回调起支付所需的参数
    prepay(outTradeNo, amountFen) {
      db.prepare('INSERT OR IGNORE INTO mock_wx_pay(out_trade_no, amount_fen) VALUES (?,?)').run(outTradeNo, amountFen);
      return { mock: true, out_trade_no: outTradeNo, amount_fen: amountFen };
    },
    // 顾客在"支付窗口"点了确认：微信那边记为支付成功；notify=true 时再通知后端（对应 D1）
    // amountOverride 只用来测试"通知金额与订单不符"
    userPays(outTradeNo, { notify = true, amountOverride } = {}) {
      const row = db.prepare('SELECT * FROM mock_wx_pay WHERE out_trade_no=?').get(outTradeNo);
      if (!row) return null;
      if (row.status === 'CLOSED') return { status: 'CLOSED' };
      const txId = row.transaction_id || 'MOCK' + crypto.randomBytes(6).toString('hex').toUpperCase();
      db.prepare("UPDATE mock_wx_pay SET status='SUCCESS', transaction_id=? WHERE out_trade_no=?").run(txId, outTradeNo);
      if (notify && hooks.onNotify) hooks.onNotify(outTradeNo, txId, amountOverride ?? row.amount_fen);
      return { status: 'SUCCESS', transaction_id: txId };
    },
    // 对应 EXT-03 按商户订单号查单
    query(outTradeNo) {
      if (state.queryError) throw new Error('mock: 微信接口不可用');
      const row = db.prepare('SELECT * FROM mock_wx_pay WHERE out_trade_no=?').get(outTradeNo);
      if (!row) return { state: 'NOTFOUND' };
      return { state: row.status, transaction_id: row.transaction_id, amount_fen: row.amount_fen };
    },
    // 对应 EXT-04 关闭订单：已支付的关不掉，返回 PAID
    close(outTradeNo) {
      const row = db.prepare('SELECT * FROM mock_wx_pay WHERE out_trade_no=?').get(outTradeNo);
      if (!row) return { state: 'CLOSED' };
      if (row.status === 'SUCCESS') return { state: 'PAID', transaction_id: row.transaction_id, amount_fen: row.amount_fen };
      db.prepare("UPDATE mock_wx_pay SET status='CLOSED' WHERE out_trade_no=?").run(outTradeNo);
      return { state: 'CLOSED' };
    },
    // 对应 EXT-05 申请退款：受理成功返回 ok:true；失败返回 ok:false
    refund(/* outRefundNo, outTradeNo, amountFen */) {
      if (state.refundFail) return { ok: false, reason: 'mock: 退款申请失败' };
      return { ok: true };
    },
  };
}
module.exports = { create };
