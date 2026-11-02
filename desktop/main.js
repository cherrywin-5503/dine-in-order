// 电脑软件外壳：用 Electron 把店员端/店长端网页放进一个独立窗口。
// 它会自动启动后端服务（如果你已经用 npm start 启动过，就直接连接）。
// 用法：cd desktop && npm install && npm run staff   （或 npm run manager）
const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 3000;
const which = process.argv[2] === 'manager' ? 'manager' : 'staff';
let child = null;

function ping(cb) {
  http.get(`http://127.0.0.1:${PORT}/api/info`, (r) => { r.resume(); cb(true); }).on('error', () => cb(false));
}
function waitReady(tries, cb) {
  ping((ok) => { if (ok) return cb(); if (tries <= 0) return cb(new Error('服务启动超时')); setTimeout(() => waitReady(tries - 1, cb), 200); });
}
function openWindow() {
  const win = new BrowserWindow({ width: 1000, height: 780, title: which === 'manager' ? '店长端' : '店员端' });
  win.loadURL(`http://127.0.0.1:${PORT}/${which}.html`);
}
app.whenReady().then(() => {
  ping((running) => {
    if (!running) child = spawn('node', ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, PORT } });
    waitReady(60, (err) => { if (err) { console.error(err.message); app.quit(); } else openWindow(); });
  });
});
app.on('window-all-closed', () => { if (child) child.kill(); app.quit(); });
