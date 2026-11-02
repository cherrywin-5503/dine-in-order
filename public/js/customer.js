// 顾客端：扫码 → 选菜和规格 → 购物车 → 模拟支付 → 看取餐号和排队数
(function () {
  const api = makeApi('cust_token', () => { store('cust_token', null); });
  const S = {
    menu: null, cat: null, cart: store('cart') || [], addon: store('addon'), remark: '', reqId: null,
    activeOrders: [], timers: [], busy: false,
  };
  const view = $('#view');
  // 跳转：地址没变时 hashchange 不会触发，所以手动刷新
  function go(h) { if (location.hash === h) route(); else location.hash = h; }

  // ---------- 登录（A1）：演示版用本机生成的设备编号代替微信登录 ----------
  async function ensureLogin() {
    if (store('cust_token')) return true;
    let dev = store('device_id'); if (!dev) { dev = uuid(); store('device_id', dev); }
    const r = await api('POST', '/api/auth/guest-login', { device_id: dev });
    if (r.code !== 0) { toast(r.message); return false; }
    store('cust_token', r.data.token); return true;
  }
  // 带登录的调用：token 失效时自动重新登录一次
  async function call(method, path, body) {
    await ensureLogin();
    let r = await api(method, path, body);
    if (r.code === 40101) { await ensureLogin(); r = await api(method, path, body); }
    return r;
  }

  // ---------- 购物车 ----------
  const saveCart = () => { store('cart', S.cart); S.reqId = null; };
  const cartKey = (d, ids) => d + '|' + [...ids].sort().join(',');
  const cartCount = () => S.cart.reduce((s, c) => s + c.quantity, 0);
  const cartTotal = () => S.cart.reduce((s, c) => s + c.unit_price_fen * c.quantity, 0);
  const dishQty = (id) => S.cart.filter((c) => c.dish_id === id).reduce((s, c) => s + c.quantity, 0);
  function addToCart(dish, optionIds, specText, unit, qty = 1) {
    const key = cartKey(dish.id, optionIds);
    const ex = S.cart.find((c) => c.key === key);
    if (ex) { ex.quantity = Math.min(99, ex.quantity + qty); ex.unit_price_fen = unit; }
    else S.cart.push({ key, dish_id: dish.id, name: dish.name, spec_option_ids: optionIds, spec_text: specText, unit_price_fen: unit, quantity: qty });
    saveCart();
  }

  // ---------- 菜单 ----------
  async function loadMenu() {
    const r = await api('GET', '/api/menu');
    if (r.code !== 0) { toast(r.message); return false; }
    const old = S.menu && JSON.stringify(S.menu.dishes.map((d) => [d.id, d.sold_out, d.price_fen]));
    S.menu = r.data;
    if (!S.cat || !S.menu.categories.some((c) => c.id === S.cat)) S.cat = S.menu.categories[0]?.id;
    return old !== JSON.stringify(S.menu.dishes.map((d) => [d.id, d.sold_out, d.price_fen]));
  }

  function renderMenu() {
    if (!S.menu) { view.innerHTML = '<div class="empty">加载中…</div>'; return; }
    const cats = S.menu.categories.filter((c) => S.menu.dishes.some((d) => d.category_id === c.id));
    const list = S.menu.dishes.filter((d) => d.category_id === S.cat);
    const banner = S.addon
      ? `<div class="banner"><span>正在给订单 ${esc(S.addon.pickup_text)} 追加菜品</span><a href="#" data-act="cancel-addon" style="color:inherit">放弃追加</a></div>`
      : S.activeOrders.length
        ? `<div class="banner" data-go="#/order/${S.activeOrders[0].id}" style="cursor:pointer"><span>您有进行中的订单${S.activeOrders[0].pickup_no_text ? '（取餐号 ' + S.activeOrders[0].pickup_no_text + '）' : ''}</span><span>查看 ›</span></div>` : '';
    view.innerHTML = `${banner}
      <div class="menu-wrap">
        <nav class="cats">${cats.map((c) => `<button class="${c.id === S.cat ? 'on' : ''}" data-cat="${c.id}">${esc(c.name)}</button>`).join('')}</nav>
        <section class="dishes">${list.map((d) => {
          const n = dishQty(d.id);
          const pic = d.image_url ? (/^https?:|^\//.test(d.image_url) ? `<img src="${esc(d.image_url)}" alt="">` : esc(d.image_url)) : '🍽️';
          return `<div class="dish ${d.sold_out ? 'soldout' : ''}">
            <div class="pic" style="background:hsl(${(d.id * 47) % 360} 75% 92%)">${pic}</div>
            <div class="grow"><div class="name">${esc(d.name)}${d.sold_out ? '<span class="tag gray">已售罄</span>' : ''}</div>
              <div class="price">¥${yuan(d.price_fen)}${d.spec_groups.length ? ' <span class="muted">起</span>' : ''}</div></div>
            ${d.sold_out ? '' : `<button class="add" data-dish="${d.id}">+${n ? `<span class="n">${n}</span>` : ''}</button>`}
          </div>`;
        }).join('') || '<div class="empty">这个分类暂时没有菜品</div>'}</section>
      </div>
      ${cartCount() ? `<div class="cartbar"><div><span class="sum">¥${yuan(cartTotal())}</span> <span class="muted" style="color:#ccc">共 ${cartCount()} 份</span></div><button class="primary" data-go="#/checkout">${S.addon ? '去结算（追加）' : '去结算'}</button></div>` : ''}`;
  }

  // 规格弹窗：每组必选一项，默认项已选好（FR-03）
  function openSpec(dish) {
    const sel = {};
    dish.spec_groups.forEach((g) => { sel[g.group_name] = (g.options.find((o) => o.is_default) || g.options[0]).id; });
    let qty = 1;
    const m = openModal('');
    function draw() {
      const ids = Object.values(sel);
      const delta = dish.spec_groups.flatMap((g) => g.options).filter((o) => ids.includes(o.id)).reduce((s, o) => s + o.price_delta_fen, 0);
      const unit = dish.price_fen + delta;
      m.el.innerHTML = `<h3>${esc(dish.name)}</h3>
        ${dish.spec_groups.map((g) => `<div class="muted" style="margin-top:8px">${esc(g.group_name)}</div>` + g.options.map((o) =>
          `<span class="opt ${sel[g.group_name] === o.id ? 'on' : ''}" data-g="${esc(g.group_name)}" data-o="${o.id}">${esc(o.option_name)}${o.price_delta_fen ? ' +¥' + yuan(o.price_delta_fen) : ''}</span>`).join('')).join('')}
        <div class="row between" style="margin-top:16px"><span class="price" style="font-size:20px">¥${yuan(unit * qty)}</span>
          <span class="qty"><button data-q="-1">−</button><b>${qty}</b><button data-q="1">+</button></span></div>
        <div class="btns"><button class="primary" data-ok>加入购物车</button></div>`;
      $$('.opt', m.el).forEach((e) => { e.onclick = () => { sel[e.dataset.g] = Number(e.dataset.o); draw(); }; });
      $$('[data-q]', m.el).forEach((e) => { e.onclick = () => { qty = Math.max(1, Math.min(99, qty + Number(e.dataset.q))); draw(); }; });
      $('[data-ok]', m.el).onclick = () => {
        const text = dish.spec_groups.map((g) => g.options.find((o) => o.id === sel[g.group_name]).option_name).join('、');
        addToCart(dish, ids, text, unit, qty); m.close(); renderMenu();
      };
    }
    draw();
  }

  // ---------- 确认页（购物车） ----------
  function renderCheckout() {
    if (!S.cart.length) { go('#/menu'); return; }
    view.innerHTML = `
      <div class="card"><div class="row between"><h3>${S.addon ? '追加菜品（订单 ' + esc(S.addon.pickup_text) + '）' : '确认订单'}</h3><a href="#" data-act="clear" class="muted">清空</a></div>
        ${S.cart.map((c, i) => `<div class="row" style="padding:10px 0;border-bottom:1px solid var(--line)">
          <div class="grow"><b>${esc(c.name)}</b><div class="muted">${esc(c.spec_text)}</div></div>
          <div class="price">¥${yuan(c.unit_price_fen * c.quantity)}</div>
          <span class="qty"><button data-i="${i}" data-d="-1">−</button><b>${c.quantity}</b><button data-i="${i}" data-d="1">+</button></span></div>`).join('')}
        <div class="row between" style="margin-top:12px"><span>合计</span><span class="price" style="font-size:22px">¥${yuan(cartTotal())}</span></div></div>
      ${S.addon ? '' : `<div class="card"><label style="margin-top:0">备注（选填，最多 50 字）</label>
        <textarea id="remark" maxlength="50" placeholder="例如：少放葱">${esc(S.remark)}</textarea><div class="muted" style="text-align:right" id="rc">${[...S.remark].length}/50</div></div>`}
      <div class="card"><button class="primary" id="submit" style="width:100%;padding:14px">${S.addon ? '提交追加并支付' : '提交订单并支付'}</button>
        <div class="muted" style="margin-top:8px;text-align:center">先付款后出餐 · 如需取消请联系店员</div></div>`;
    const ta = $('#remark');
    if (ta) ta.oninput = () => { S.remark = ta.value; S.reqId = null; $('#rc').textContent = [...S.remark].length + '/50'; };
    $('#submit').onclick = submit;
  }

  async function submit() {
    if (S.busy) return; S.busy = true; $('#submit').disabled = true;     // 提交后置灰，防重复点击（EX-03）
    try {
      const items = S.cart.map((c) => ({ dish_id: c.dish_id, spec_option_ids: c.spec_option_ids, quantity: c.quantity }));
      const expected = cartTotal();
      let r, info;
      if (S.addon) {
        r = await call('POST', `/api/orders/${S.addon.id}/addons`, { items, expected_total_fen: expected });
        info = { order_id: S.addon.id, amount_fen: expected };
      } else {
        S.reqId = S.reqId || uuid();   // 网络重试时 request_id 不变，服务端不会重复下单（EX-04）
        r = await call('POST', '/api/orders', { request_id: S.reqId, items, remark: S.remark, expected_total_fen: expected });
        info = { order_id: r.data && r.data.order_id, amount_fen: r.data && r.data.total_fen };
      }
      if (r.code === 40903) {                                    // EX-05 价格变化：让顾客确认后再付
        await loadMenu(); refreshCartPrices();
        S.reqId = null;
        toast(`价格已更新，合计 ¥${yuan(r.data.total_fen)}，请确认后重新提交`, 3500); return renderCheckout();
      }
      if (r.code === 40902) {                                    // EX-05 售罄：移出购物车
        toast(r.message + '，已从购物车移除'); S.cart = S.cart.filter((c) => c.dish_id !== (r.data && r.data.dish_id)); saveCart();
        await loadMenu(); return S.cart.length ? renderCheckout() : go('#/menu');
      }
      if (r.code !== 0) { toast(r.message); return renderCheckout(); }
      if (!r.data.pay_params) { go('#/order/' + info.order_id); return; }  // 已经付过了
      showPay({ order_id: info.order_id, pay: r.data.pay_params });
    } catch (e) { toast(e.message); renderCheckout(); }
    finally { S.busy = false; }
  }
  function refreshCartPrices() {
    for (const c of S.cart) {
      const d = S.menu.dishes.find((x) => x.id === c.dish_id); if (!d) continue;
      const delta = d.spec_groups.flatMap((g) => g.options).filter((o) => c.spec_option_ids.includes(o.id)).reduce((s, o) => s + o.price_delta_fen, 0);
      c.unit_price_fen = d.price_fen + delta;
    }
    saveCart();
  }

  // ---------- 模拟微信支付窗口（演示版，对应设计文档里的 MockPay） ----------
  function showPay({ order_id, pay }) {
    const m = openModal(`<h3>模拟微信支付</h3><div class="pickup" style="font-size:40px">¥${yuan(pay.amount_fen)}</div>
      <p class="muted" style="text-align:center">演示环境，不会真实扣款</p>
      <div class="btns"><button data-n>取消支付</button><button class="primary" data-y>确认支付</button></div>
      <div class="demo"><a data-lost1>演示：支付成功，但微信通知丢失（点击后自动查单补上）</a><a data-lost2>演示：支付成功，通知和查单都丢失（等 1 分钟后对账任务补上）</a></div>`, 'center');
    m.mask.dataset.lock = '1';
    const pay_ = async (notify, check) => {
      try {
        const r = await call('POST', `/api/mockpay/${pay.out_trade_no}/pay`, { notify });
        if (r.code !== 0) { toast(r.message); m.close(); go('#/order/' + order_id); return; }
        if (check) await call('POST', `/api/orders/${order_id}/pay-check`, {}); // A6：支付后主动确认
        S.cart = []; S.remark = ''; S.reqId = null; S.addon = null; store('addon', null); saveCart();
        m.close(); toast('支付成功'); go('#/order/' + order_id);
      } catch (e) { toast(e.message); }
    };
    $('[data-y]', m.el).onclick = () => pay_(true, true);
    $('[data-lost1]', m.el).onclick = () => pay_(false, true);
    $('[data-lost2]', m.el).onclick = () => pay_(false, false);
    $('[data-n]', m.el).onclick = () => { m.close(); toast('已取消支付，订单仍为待支付，可继续支付'); go('#/order/' + order_id); };
  }

  // ---------- 订单完成提醒：弹窗 + 震动 + 提示音 + 标题闪烁 ----------
  // 注意：iPhone 的 Safari 不支持网页震动，所以同时用弹窗和提示音；安卓手机三种都有
  let beepCtx = null;
  document.addEventListener('click', () => { try { beepCtx = beepCtx || new (window.AudioContext || window.webkitAudioContext)(); beepCtx.resume(); } catch (e) {} }, { once: true });
  function notifyDone(o) {
    const seen = store('seen_status') || {};
    const prev = seen[o.id]; seen[o.id] = o.status; store('seen_status', seen);
    if (o.status !== 'DONE' || prev === undefined || prev === 'DONE') return; // 只在“刚变成已完成”时提醒；打开页面时已经是完成的不重复提醒
    if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 600]);
    if (beepCtx) for (let i = 0; i < 3; i++) {
      const os = beepCtx.createOscillator(), g = beepCtx.createGain(), t = beepCtx.currentTime + i * 0.3;
      os.frequency.value = 988; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.4, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      os.connect(g); g.connect(beepCtx.destination); os.start(t); os.stop(t + 0.28);
    }
    const old = document.title; let k = 0; const iv = setInterval(() => { document.title = k++ % 2 ? old : '🔔 餐好了'; if (k > 20) { clearInterval(iv); document.title = old; } }, 800);
    const m = openModal(`<div style="text-align:center"><div style="font-size:48px">🍽️</div><h3>您的餐好了！</h3><div class="pickup">${esc(o.pickup_no_text)}</div><p>请凭取餐号到柜台取餐</p><button class="primary" data-ok style="width:100%;padding:12px">知道了</button></div>`, 'center');
    $('[data-ok]', m.el).onclick = () => { m.close(); clearInterval(iv); document.title = old; renderOrder(o.id); };
  }

  // ---------- 订单页 ----------
  async function renderOrder(id) {
    const r = await call('GET', '/api/orders/' + id);
    if (location.hash !== '#/order/' + id) return;
    if (r.code !== 0) { view.innerHTML = `<div class="empty">${esc(r.message)}</div>`; return; }
    const o = r.data;
    notifyDone(o);
    const queue = ['WAIT_ACCEPT', 'COOKING'].includes(o.status) ? (o.queue_ahead > 0 ? `前面还有 ${o.queue_ahead} 个订单` : '下一个就是您') : '';
    view.innerHTML = `<div class="card">
        <div class="muted" style="text-align:center">取餐号</div>
        <div class="pickup">${o.pickup_no_text || '—'}</div>
        <div class="statusbig ${o.status === 'DONE' ? 'done' : ''}">${esc(o.status_text)}</div>
        ${queue ? `<div style="text-align:center" class="price">${queue}</div>` : ''}
        ${o.status === 'DONE' ? '<div style="text-align:center">请凭取餐号到柜台取餐</div>' : ''}
        ${o.status === 'PENDING_PAY' ? '<div class="muted" style="text-align:center">15 分钟内未支付订单将自动关闭</div>' : ''}
      </div>
      <div class="card"><div class="muted">订单号 ${esc(o.order_no)}</div>
        ${o.items.map((i) => `<div class="row between" style="padding:6px 0"><div>${esc(i.dish_name)} <span class="muted">${esc(i.spec_text)}</span> × ${i.quantity}${i.is_addon ? '<span class="tag">追加</span>' : ''}${!i.confirmed ? '<span class="tag gray">待支付</span>' : ''}</div><div>¥${yuan(i.unit_price_fen * i.quantity)}</div></div>`).join('')}
        ${o.remark ? `<div class="muted">备注：${esc(o.remark)}</div>` : ''}
        <div class="row between" style="margin-top:8px"><span>合计</span><b class="price">¥${yuan(o.total_fen)}</b></div></div>
      <div class="card">
        ${o.open_payment ? `<button class="primary" data-act="pay" style="width:100%;padding:12px;margin-bottom:8px">继续支付 ¥${yuan(o.open_payment.amount_fen)}</button>` : ''}
        ${o.can_addon ? `<button class="ghost" data-act="addon" style="width:100%;padding:12px;margin-bottom:8px">追加菜品</button>` : ''}
        <button class="ghost" data-go="#/menu" style="width:100%;padding:12px">${o.status === 'PENDING_PAY' || o.can_addon ? '返回菜单' : '再点一单'}</button>
        <div class="muted" style="margin-top:10px;text-align:center">如需取消订单，请联系店员</div></div>`;
    view.querySelector('[data-act="pay"]')?.addEventListener('click', async () => {
      const p = await call('POST', `/api/orders/${o.id}/pay`, {});
      if (p.code !== 0) { toast(p.message); return renderOrder(id); }
      showPay({ order_id: o.id, pay: p.data.pay_params });
    });
    view.querySelector('[data-act="addon"]')?.addEventListener('click', () => {
      S.addon = { id: o.id, pickup_text: o.pickup_no_text || o.order_no }; store('addon', S.addon);
      S.cart = []; saveCart(); go('#/menu');
    });
  }
  async function renderOrders() {
    const r = await call('GET', '/api/orders?scope=all');
    view.innerHTML = `<div class="card"><h3>我的订单</h3></div>` + (r.data.orders.map((o) =>
      `<div class="card" data-go="#/order/${o.id}" style="cursor:pointer"><div class="row between"><b>${o.pickup_no_text ? '取餐号 ' + o.pickup_no_text : '未支付'}</b><span class="tag">${esc(o.status_text)}</span></div>
       <div class="muted">${esc(o.order_no)} · ${fmtDateTime(o.created_at)} · ¥${yuan(o.total_fen)}</div></div>`).join('') || '<div class="empty">还没有订单</div>');
  }

  // ---------- 路由和定时刷新 ----------
  function clearTimers() { S.timers.forEach(clearInterval); S.timers = []; }
  async function route() {
    clearTimers();
    const h = location.hash || '#/menu';
    if (h.startsWith('#/order/')) {
      const id = Number(h.split('/')[2]); await renderOrder(id);
      S.timers.push(setInterval(() => { if (!hasModal()) renderOrder(id); }, 5000));    // 订单页每 5 秒刷新
    } else if (h === '#/orders') await renderOrders();
    else if (h === '#/checkout') renderCheckout();
    else {
      renderMenu();
      await loadMenu(); await refreshActive(); renderMenu();
      // 菜单每 4 秒检查一次（售罄、改价同步，FR-12）
      S.timers.push(setInterval(async () => {
        if (hasModal()) return;
        await refreshActive(); S.activeOrders.forEach(notifyDone);              // 人在菜单页也能收到“餐好了”
        if (await loadMenu()) renderMenu();
      }, 4000));
    }
  }
  async function refreshActive() {
    try { const r = await call('GET', '/api/orders?scope=active'); if (r.code === 0) S.activeOrders = r.data.orders; } catch (e) { /* 忽略 */ }
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-go],[data-cat],[data-dish],[data-act],[data-i]'); if (!t) return;
    if (t.dataset.go) { e.preventDefault(); go(t.dataset.go); return; }
    if (t.dataset.cat) { S.cat = Number(t.dataset.cat); renderMenu(); return; }
    if (t.dataset.dish) { const d = S.menu.dishes.find((x) => x.id === Number(t.dataset.dish));
      if (!d) return; if (d.spec_groups.length) openSpec(d); else { addToCart(d, [], '', d.price_fen); renderMenu(); } return; }
    if (t.dataset.i !== undefined) { const c = S.cart[Number(t.dataset.i)]; c.quantity += Number(t.dataset.d);
      if (c.quantity <= 0) S.cart.splice(Number(t.dataset.i), 1); c && (c.quantity = Math.min(99, c.quantity)); saveCart(); renderCheckout(); return; }
    if (t.dataset.act === 'clear') { e.preventDefault(); S.cart = []; saveCart(); route(); }
    if (t.dataset.act === 'cancel-addon') { e.preventDefault(); S.addon = null; store('addon', null); S.cart = []; saveCart(); renderMenu(); }
  });
  $('#btnOrders').onclick = () => go('#/orders');
  $('#title').onclick = () => go('#/menu');
  window.addEventListener('hashchange', route);
  route();
})();
