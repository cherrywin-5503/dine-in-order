// 店员端：新订单提醒、接单出餐叫号、售罄管理、退款
(function () {
  const view = $('#view');
  const api = makeApi('staff_token', () => { store('staff_token', null); showLogin('登录已失效或账号已停用，请重新登录'); });
  const S = { tab: 'orders', known: new Set(), reminded: {}, timer: null, fresh: {}, started: false, ctx: null, wake: null, orders: [] };

  // ---------- 登录（A2） ----------
  function showLogin(msg) {
    clearInterval(S.timer); closeAllModals(); $('#logout').hidden = true; $('#who').textContent = '';
    view.innerHTML = `<div class="login"><h2>店员登录</h2><label>账号</label><input id="u" autocomplete="username" value="staff1">
      <label>密码</label><input id="p" type="password" autocomplete="current-password" placeholder="演示密码 staff123">
      <button class="primary" id="go" style="width:100%;margin-top:16px;padding:12px">登录</button><div class="err" id="err">${esc(msg || '')}</div></div>`;
    const doLogin = async () => {
      const r = await api('POST', '/api/auth/staff-login', { username: $('#u').value.trim(), password: $('#p').value });
      if (r.code !== 0) { $('#err').textContent = r.message; return; }
      if (r.data.role !== 'STAFF') { $('#err').textContent = '这是店员端，店长请使用店长端'; return; }
      store('staff_token', r.data.token); store('staff_name', r.data.username); init();
    };
    $('#go').onclick = doLogin; $('#p').onkeydown = (e) => { if (e.key === 'Enter') doLogin(); };
  }

  // ---------- 提示音（新订单、5 分钟未接单） ----------
  function beep(times = 3) {
    if (!S.ctx) return;
    for (let i = 0; i < times; i++) {
      const o = S.ctx.createOscillator(), g = S.ctx.createGain(), t = S.ctx.currentTime + i * 0.35;
      o.type = 'sine'; o.frequency.value = 880; g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.5, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      o.connect(g); g.connect(S.ctx.destination); o.start(t); o.stop(t + 0.3);
    }
  }
  // ---------- 语音叫号：店员点“已完成”时自动播报“请 零零一 号顾客取餐” ----------
  function speak(pickupText) {
    if (!('speechSynthesis' in window)) { toast('这个浏览器不支持语音播报'); return; }
    const zh = String(pickupText).replace(/\d/g, (d) => '零一二三四五六七八九'[d]);   // 001 → 零零一，避免被读成“一”
    speechSynthesis.cancel();
    for (let i = 0; i < 2; i++) {                                                    // 报两遍，柜台比较吵
      const u = new SpeechSynthesisUtterance(`请 ${zh} 号顾客取餐`);
      u.lang = 'zh-CN'; u.rate = 0.9; u.volume = 1; speechSynthesis.speak(u);
    }
  }
  // 浏览器规定：声音必须由用户点一下才能播放，所以页首有“开始接单”按钮（设计文档 7.1）
  async function startWork() {
    try { S.ctx = new (window.AudioContext || window.webkitAudioContext)(); await S.ctx.resume(); } catch (e) { /* 没有声音也能用 */ }
    try { if (navigator.wakeLock) S.wake = await navigator.wakeLock.request('screen'); } catch (e) { /* 保持亮屏失败也能用 */ }
    S.started = true; beep(1); render();
  }
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && S.started && navigator.wakeLock) { try { S.wake = await navigator.wakeLock.request('screen'); } catch (e) {} }
  });

  // ---------- 订单列表（B1），每 2 秒刷新 ----------
  let firstLoad = true;
  async function poll() {
    if (S.tab !== 'orders') return;
    let r; try { r = await api('GET', '/api/staff/orders'); } catch (e) { return showNet(); }
    if (r.code !== 0) return;
    const orders = r.data.orders;
    let ring = false;
    for (const o of orders) {
      if (!firstLoad && !S.known.has(o.id)) { S.fresh[o.id] = Date.now() + 10000; ring = true; }              // 新订单：响铃 + 高亮
      if (o.reminded_at && S.reminded[o.id] !== o.reminded_at) { if (S.reminded[o.id] !== undefined || !firstLoad) ring = true; S.reminded[o.id] = o.reminded_at; } // 5 分钟未接单再响一次
      S.known.add(o.id);
    }
    firstLoad = false;
    S.orders = orders;
    if (ring) beep(3);
    if (!hasModal()) drawOrders(orders);
  }
  function showNet() { const n = $('#net'); if (n) n.style.display = 'block'; }

  function drawOrders(orders) {
    const box = $('#orders'); if (!box) return;
    if (!orders.length) { box.innerHTML = '<div class="empty">暂无待处理订单<br><span class="muted">有新订单会自动提醒</span></div>'; return; }
    box.innerHTML = orders.map((o) => {
      const main = { WAIT_ACCEPT: ['COOKING', '开始制作', 'primary'], COOKING: ['DONE', '已完成（叫号）', 'ok'], DONE: ['PICKED', '已取餐', 'ghost'] }[o.status];
      return `<div class="ocard ${o.status} ${o.overdue ? 'overdue' : ''} ${S.fresh[o.id] > Date.now() ? 'fresh' : ''}">
        <div class="row between"><span class="no">${o.pickup_no_text}</span>
          <span><span class="tag ${o.overdue ? 'red' : ''}">${esc(o.status_text)}</span>${o.overdue ? '<span class="tag red">超过 5 分钟未接单</span>' : ''}${o.contains_sold_out ? '<span class="tag red">含售罄菜</span>' : ''}</span></div>
        <ul>${o.items.map((i) => `<li>${esc(i.dish_name)} <span class="muted">${esc(i.spec_text)}</span> × <b>${i.quantity}</b>${i.is_addon ? '<span class="tag">追加</span>' : ''}</li>`).join('')}</ul>
        ${o.remark ? `<div style="background:#fff9db;padding:6px 8px;border-radius:6px">备注：${esc(o.remark)}</div>` : ''}
        <div class="row between" style="margin-top:10px"><span class="muted">${esc(o.order_no)} · ¥${yuan(o.total_fen)} · ${fmtTime(o.paid_at)} 付款</span>
          <span>${o.status === 'DONE' ? `<button class="ghost small" data-say="${o.pickup_no_text}">🔊 重播</button> ` : ''}<button class="danger small" data-refund="${o.id}">退款</button> <button class="${main[2]}" data-st="${o.id}" data-to="${main[0]}">${main[1]}</button></span></div></div>`;
    }).join('');
  }

  async function changeStatus(id, to) {
    const r = await api('POST', `/api/staff/orders/${id}/status`, { to });
    if (r.code !== 0) toast(r.message);
    else if (to === 'DONE') { const o = S.orders.find((x) => x.id === id); if (o) speak(o.pickup_no_text); }   // 点“已完成”就叫号
    poll();
  }

  function refundDialog(id) {
    const o = S.orders.find((x) => x.id === id);
    const m = openModal(`<h3>退款：取餐号 ${o ? o.pickup_no_text : ''}</h3><p class="muted">整单退款，需选择原因。换菜请先和顾客当面商量，需要新菜时让顾客用“追加菜品”。</p>
      <label><input type="radio" name="rc" value="SOLD_OUT" style="width:auto"> 菜品售罄</label>
      <label><input type="radio" name="rc" value="CUSTOMER_REQUEST" style="width:auto"> 顾客要求退款</label>
      <label><input type="radio" name="rc" value="OTHER" style="width:auto"> 其他（请填写）</label>
      <input id="rt" maxlength="50" placeholder="其他原因，最多 50 字" style="margin-top:6px">
      <div class="err" id="rerr"></div>
      <div class="btns"><button data-n>取消</button><button class="danger" data-y>确认退款</button></div>`, 'center');
    $('[data-n]', m.el).onclick = () => { m.close(); poll(); };
    $('[data-y]', m.el).onclick = async () => {
      const rc = $('input[name=rc]:checked', m.el);
      if (!rc) { $('#rerr', m.el).textContent = '请选择退款原因'; return; }
      const r = await api('POST', `/api/staff/orders/${id}/refund`, { reason_code: rc.value, reason_text: $('#rt', m.el).value });
      if (r.code !== 0) { $('#rerr', m.el).textContent = r.message; return; }
      m.close(); toast(r.data.status === 'REFUNDED' ? '已退款' : '退款失败，已通知店长处理', 3000); poll();
    };
  }

  // ---------- 售罄管理（B3） ----------
  async function renderSoldOut() {
    const r = await api('GET', '/api/staff/dishes'); if (r.code !== 0) return;
    const box = $('#orders'); const dishes = r.data.dishes;
    const cats = [...new Set(dishes.map((d) => d.category_name))];
    box.innerHTML = cats.map((c) => `<div class="card"><h3>${esc(c)}</h3>${dishes.filter((d) => d.category_name === c).map((d) =>
      `<div class="row between" style="padding:10px 0;border-bottom:1px solid var(--line)"><div>${esc(d.name)} ${d.sold_out ? '<span class="tag red">已售罄</span>' : ''}</div>
       <button class="switch ${d.sold_out ? 'on' : ''}" data-so="${d.id}" data-v="${d.sold_out ? 0 : 1}" aria-label="售罄开关"></button></div>`).join('')}</div>`).join('')
      + '<div class="muted" style="text-align:center;padding:10px">开关打开 = 售罄，顾客端 5 秒内会置灰</div>';
  }

  // ---------- 页面框架 ----------
  function render() {
    view.innerHTML = `<div class="tabs"><button data-tab="orders" class="${S.tab === 'orders' ? 'on' : ''}">订单</button><button data-tab="soldout" class="${S.tab === 'soldout' ? 'on' : ''}">售罄管理</button></div>
      <div id="net" class="banner" style="display:none;background:#ffe3e3;color:#c92a2a">网络异常，正在重试…</div>
      <div id="orders"></div>
      ${S.started ? '' : '<div class="start"><button class="primary" id="startWork">开始接单<div style="font-size:13px;font-weight:400;margin-top:4px">点击后才会播放提示音并保持亮屏</div></button></div>'}`;
    if (!S.started) $('#startWork').onclick = startWork;
    if (S.tab === 'orders') drawOrders(S.orders); else renderSoldOut();
  }
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-tab],[data-st],[data-refund],[data-so],[data-say]'); if (!t) return;
    if (t.dataset.say) speak(t.dataset.say);
    else if (t.dataset.tab) { S.tab = t.dataset.tab; render(); poll(); }
    else if (t.dataset.st) changeStatus(Number(t.dataset.st), t.dataset.to);
    else if (t.dataset.refund) refundDialog(Number(t.dataset.refund));
    else if (t.dataset.so) {
      const r = await api('PUT', `/api/staff/dishes/${t.dataset.so}/sold-out`, { sold_out: t.dataset.v === '1' });
      if (r.code !== 0) toast(r.message); renderSoldOut();
    }
  });
  $('#logout').onclick = () => { store('staff_token', null); S.started = false; showLogin(); };

  function init() {
    if (!store('staff_token')) return showLogin();
    $('#logout').hidden = false; $('#who').textContent = store('staff_name') || '';
    firstLoad = true; S.known = new Set(); S.reminded = {};
    render(); poll(); clearInterval(S.timer); S.timer = setInterval(poll, 2000);
  }
  init();
})();
