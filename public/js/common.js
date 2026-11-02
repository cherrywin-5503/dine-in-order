// 三个页面共用的小工具：接口调用、提示、弹窗、金额和时间格式
function $(s, e) { return (e || document).querySelector(s); }
function $$(s, e) { return [...(e || document).querySelectorAll(s)]; }
function esc(s) { // 防止把用户输入（备注等）当成 HTML 执行
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function yuan(fen) { return (fen / 100).toFixed(2); }          // 金额统一用“分”，显示时 ÷100，保留 2 位小数
function pad2(n) { return String(n).padStart(2, '0'); }
function fmtTime(ms) { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; }
function fmtDateTime(ms) { const d = new Date(ms); return `${d.getMonth() + 1}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function todayStr() { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function uuid() { return (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2)); }
function store(key, val) { try { if (val === undefined) { const v = localStorage.getItem(key); return v == null ? null : JSON.parse(v); } if (val === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(val)); } catch (e) { return null; } }

// makeApi：返回一个调用后端的函数。登录失效（40101/40102）时调用 onAuthFail
function makeApi(tokenKey, onAuthFail) {
  return async function api(method, path, body) {
    const token = store(tokenKey);
    let res;
    try {
      res = await fetch(path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
    } catch (e) { throw new Error('网络异常，请重试'); }   // EX-04 网络中断
    let j;
    try { j = await res.json(); } catch (e) { throw new Error('服务异常，请稍后重试'); }
    if (j.code === 40101 || j.code === 40102) { if (onAuthFail) onAuthFail(j); }
    return j;
  };
}

let toastTimer;
function toast(msg, ms = 2400) {
  let t = $('.toast'); if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.style.display = 'block'; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.style.display = 'none'; }, ms);
}
// 弹窗：mode='sheet'（底部弹出）或 'center'（居中）。返回 { el, close }
function openModal(html, mode = 'sheet') {
  const mask = document.createElement('div'); mask.className = 'mask' + (mode === 'center' ? ' center' : '');
  mask.innerHTML = `<div class="sheet">${html}</div>`;
  mask.addEventListener('click', (e) => { if (e.target === mask && !mask.dataset.lock) close(); });
  document.body.appendChild(mask);
  function close() { mask.remove(); }
  return { el: mask.firstElementChild, mask, close };
}
function closeAllModals() { $$('.mask').forEach((m) => m.remove()); }
function hasModal() { return !!$('.mask'); }
function confirmBox(title, text, okText = '确定') {
  return new Promise((resolve) => {
    const m = openModal(`<h3>${esc(title)}</h3><p>${esc(text)}</p><div class="btns"><button data-n>取消</button><button class="primary" data-y>${esc(okText)}</button></div>`, 'center');
    m.el.querySelector('[data-n]').onclick = () => { m.close(); resolve(false); };
    m.el.querySelector('[data-y]').onclick = () => { m.close(); resolve(true); };
  });
}
