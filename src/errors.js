// 统一的业务错误：http 状态码 + 业务错误码（见设计文档 5.1 错误码表）
class ApiError extends Error {
  constructor(code, message, data = null, http = 200) {
    super(message);
    this.code = code;
    this.data = data;
    this.http = http;
  }
}
module.exports = { ApiError };
