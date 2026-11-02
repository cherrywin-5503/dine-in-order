// auth 模块：登录、token、角色校验（设计文档 3.2）
const crypto = require('crypto');
const { ApiError } = require('./errors');
const { checkPassword } = require('./db');

function create(db, clock) {
  function newToken(userId) {
    const token = crypto.randomBytes(24).toString('hex');
    db.prepare('INSERT INTO session(token,user_id,created_at) VALUES (?,?,?)').run(token, userId, clock.now());
    return token;
  }
  return {
    // A1：顾客登录（演示版用设备 id 代替微信 code，没有账号则自动新建）
    loginGuest(deviceId) {
      if (typeof deviceId !== 'string' || deviceId.length < 8 || deviceId.length > 64)
        throw new ApiError(40001, '参数错误');
      let u = db.prepare('SELECT * FROM app_user WHERE openid=?').get(deviceId);
      if (!u) {
        const id = Number(db.prepare("INSERT INTO app_user(role,openid) VALUES ('CUSTOMER',?)").run(deviceId).lastInsertRowid);
        u = { id };
      }
      return { token: newToken(u.id) };
    },
    // A2：员工/店长登录
    loginStaff(username, password) {
      const u = db.prepare("SELECT * FROM app_user WHERE username=? AND role IN ('STAFF','MANAGER')").get(String(username || ''));
      if (!u || u.status !== 'ENABLED' || !checkPassword(String(password || ''), u.password_hash))
        throw new ApiError(40102, '账号或密码错误，或账号已停用');
      return { token: newToken(u.id), role: u.role, username: u.username };
    },
    // 每次请求都查账号状态，所以店长停用账号后立即失效（FR-17）
    verify(token) {
      if (!token) throw new ApiError(40101, '未登录或登录已过期', null, 401);
      const u = db.prepare(
        'SELECT u.id,u.role,u.username,u.status FROM session s JOIN app_user u ON u.id=s.user_id WHERE s.token=?'
      ).get(token);
      if (!u) throw new ApiError(40101, '未登录或登录已过期', null, 401);
      if (u.status !== 'ENABLED') throw new ApiError(40102, '账号已停用', null, 401);
      return { id: u.id, role: u.role, username: u.username };
    },
  };
}
module.exports = { create };
