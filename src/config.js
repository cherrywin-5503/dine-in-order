// 配置集中放在这里（对应设计文档 2.4：阈值放配置，改阈值不改代码）
module.exports = {
  PORT: Number(process.env.PORT) || 3000,
  DB_FILE: process.env.DB_FILE || 'data/app.db',
  UPLOAD_DIR: process.env.UPLOAD_DIR || 'data/uploads', // 店长上传的菜品图片
  PAY_TIMEOUT_MIN: 15,       // TR-01：未支付 15 分钟关闭
  ACCEPT_REMIND_MIN: 5,      // TR-02：5 分钟没人接单再提醒
  RECONCILE_AFTER_SEC: 60,   // 对账：支付创建超过 1 分钟仍未确认就主动查单
  JOB_INTERVAL_MS: 10000,    // 定时任务扫描间隔（演示用 10 秒）
  MAX_PICKUP_NO: 999,        // 取餐号 001~999
  REMARK_MAX: 50,            // FR-03 备注最多 50 字
  DEV: process.env.DEV_TOOLS !== '0', // 演示用开关（快进时间、模拟退款失败），正式使用可关闭
};
