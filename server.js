// 启动入口：node server.js
const { createApp } = require('./src/app');
const app = createApp();
app.start().then((port) => {
  console.log('==== 堂食扫码点单系统已启动 ====');
  console.log(`本机访问： http://localhost:${port}/`);
  app.lanUrls().forEach((u) => console.log(`手机访问（同一 WiFi）： ${u}`));
  console.log('页面入口：  /(顾客)   /staff.html(店员)   /manager.html(店长)   /qr.html(点餐码)   /entry.html(入口导航，三个二维码)');
  console.log('演示账号：  店员 staff1 / staff123      店长 manager / manager123');
  console.log('按 Ctrl+C 停止。');
});
