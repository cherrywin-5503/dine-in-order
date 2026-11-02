// 店长端：菜品管理、分类、店员账号、订单查询、异常处理、演示开关
(function () {
  const view = $('#view');
  const api = makeApi('mgr_token', () => { store('mgr_token', null); showLogin('登录已失效，请重新登录'); });
  const S = { tab: 'dishes', sdate: todayStr(), cats: [], dishes: [], page: 1, from: todayStr(), to: todayStr() };
  const TABS = [['dishes', '菜品'], ['cats', '分类'], ['staff', '员工'], ['orders', '订单'], ['stats', '统计'], ['exc', '异常'], ['demo', '演示']];

  function showLogin(msg) {
    closeAllModals(); $('#logout').hidden = true; $('#who').textContent = '';
    view.innerHTML = `<div class="login"><h2>店长登录</h2><label>账号</label><input id="u" value="manager">
      <label>密码</label><input id="p" type="password" placeholder="演示密码 manager123">
      <button class="primary" id="go" style="width:100%;margin-top:16px;padding:12px">登录</button><div class="err" id="err">${esc(msg || '')}</div></div>`;
    const doLogin = async () => {
      const r = await api('POST', '/api/auth/staff-login', { username: $('#u').value.trim(), password: $('#p').value });
      if (r.code !== 0) { $('#err').textContent = r.message; return; }
      if (r.data.role !== 'MANAGER') { $('#err').textContent = '这是店长端，店员请使用店员端'; return; }
      store('mgr_token', r.data.token); store('mgr_name', r.data.username); init();
    };
    $('#go').onclick = doLogin; $('#p').onkeydown = (e) => { if (e.key === 'Enter') doLogin(); };
  }

  function frame() {
    view.innerHTML = `<div class="tabs">${TABS.map(([k, n]) => `<button data-tab="${k}" class="${S.tab === k ? 'on' : ''}">${n}</button>`).join('')}</div><div id="body"></div>`;
    ({ dishes: tabDishes, cats: tabCats, staff: tabStaff, orders: tabOrders, stats: tabStats, exc: tabExc, demo: tabDemo })[S.tab]();
  }
  const body = () => $('#body');
  const check = (r) => { if (r.code !== 0) { toast(r.message, 3200); return false; } return true; };

  // ---------- 菜品管理（C2）：新增、编辑、上下架、改价、规格 ----------
  async function tabDishes() {
    const [c, d] = await Promise.all([api('GET', '/api/manager/categories'), api('GET', '/api/manager/dishes')]);
    if (c.code !== 0 || d.code !== 0) return;
    S.cats = c.data.categories; S.dishes = d.data.dishes;
    body().innerHTML = `<div class="card row between"><b>共 ${S.dishes.length} 个菜品</b><button class="primary" data-edit="0">+ 新增菜品</button></div>` +
      S.dishes.map((x) => `<div class="card row"><div class="grow"><b>${esc(x.name)}</b> ${x.on_sale ? '' : '<span class="tag gray">已下架</span>'}${x.sold_out ? '<span class="tag red">售罄</span>' : ''}
        <div class="muted">${esc(x.category_name)} · <span class="price">¥${yuan(x.price_fen)}</span>${x.spec_groups.length ? ' · 规格：' + x.spec_groups.map((g) => esc(g.group_name)).join('、') : ''}</div></div>
        <button class="ghost small" data-edit="${x.id}">编辑</button></div>`).join('');
  }
  function dishForm(id) {
    const d = id ? JSON.parse(JSON.stringify(S.dishes.find((x) => x.id === id))) : { name: '', category_id: S.cats[0]?.id, price_fen: 1000, image_url: '', on_sale: true, spec_groups: [] };
    const m = openModal(''); m.mask.dataset.lock = '1';
    function draw() {
      m.el.innerHTML = `<h3>${id ? '编辑菜品' : '新增菜品'}</h3>
        <label>菜名</label><input id="f_name" maxlength="30" value="${esc(d.name)}">
        <div class="grid2"><div><label>分类</label><select id="f_cat">${S.cats.map((c) => `<option value="${c.id}" ${c.id === d.category_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
        <div><label>价格（元）</label><input id="f_price" type="number" step="0.01" min="0.01" value="${yuan(d.price_fen)}"></div></div>
        <label>图片（可上传照片，也可以填一个 emoji）</label>
        <div class="row" style="gap:10px"><div class="pic" style="width:64px;height:64px;border-radius:12px;background:#fff1e0;display:flex;align-items:center;justify-content:center;font-size:34px;overflow:hidden;flex:none">${d.image_url ? (/^\/|^https?:/.test(d.image_url) ? `<img src="${esc(d.image_url)}" style="width:100%;height:100%;object-fit:cover">` : esc(d.image_url)) : '🍽️'}</div>
          <div class="grow"><input id="f_img" value="${esc(d.image_url || '')}" placeholder="例如 🍜，上传后自动填入"><input type="file" id="f_file" accept="image/*" style="margin-top:6px;padding:6px"></div></div>
        <label><input type="checkbox" id="f_sale" style="width:auto" ${d.on_sale ? 'checked' : ''}> 上架（顾客可见）</label>
        <div class="muted" style="margin-top:6px">修改价格只对之后的新订单生效，历史订单价格不变。</div>
        <h3 style="margin-top:14px">规格</h3>
        ${d.spec_groups.map((g, gi) => `<div class="specgroup"><div class="row"><input data-gn="${gi}" value="${esc(g.group_name)}" placeholder="规格组名，如 辣度"><button class="danger small" data-delg="${gi}">删组</button></div>
          ${g.options.map((o, oi) => `<div class="optrow"><input type="text" data-on="${gi}.${oi}" value="${esc(o.option_name)}" placeholder="选项名"><span class="muted">+¥</span><input type="number" step="0.01" min="0" data-od="${gi}.${oi}" value="${yuan(o.price_delta_fen)}" style="width:80px">
            <label style="margin:0;white-space:nowrap"><input type="radio" name="def${gi}" data-odef="${gi}.${oi}" style="width:auto" ${o.is_default ? 'checked' : ''}>默认</label><button class="danger small" data-delo="${gi}.${oi}">×</button></div>`).join('')}
          <button class="ghost small" data-addo="${gi}" style="margin-top:6px">+ 选项</button></div>`).join('')}
        <button class="ghost small" data-addg>+ 规格组</button>
        <div class="err" id="ferr"></div>
        <div class="btns"><button data-n>取消</button><button class="primary" data-y>保存</button></div>`;
      bind();
    }
    async function upload(file) {            // 在浏览器里先缩小到最长边 640px 再上传，手机拍的大图也能传
      const url = URL.createObjectURL(file);
      const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('读不出这张图片')); i.src = url; });
      const k = Math.min(1, 640 / Math.max(img.width, img.height)), c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      const r = await api('POST', '/api/manager/upload', { data: c.toDataURL('image/jpeg', 0.8) });
      if (!check(r)) return;
      sync(); d.image_url = r.data.url; draw(); toast('图片已上传');
    }
    function sync() { // 把输入框的内容读回 d
      d.name = $('#f_name', m.el).value; d.category_id = Number($('#f_cat', m.el).value);
      d.price_fen = Math.round(parseFloat($('#f_price', m.el).value) * 100); d.image_url = $('#f_img', m.el).value.trim(); d.on_sale = $('#f_sale', m.el).checked;
      $$('[data-gn]', m.el).forEach((e) => { d.spec_groups[+e.dataset.gn].group_name = e.value; });
      $$('[data-on]', m.el).forEach((e) => { const [g, o] = e.dataset.on.split('.'); d.spec_groups[g].options[o].option_name = e.value; });
      $$('[data-od]', m.el).forEach((e) => { const [g, o] = e.dataset.od.split('.'); d.spec_groups[g].options[o].price_delta_fen = Math.round(parseFloat(e.value || '0') * 100); });
      $$('[data-odef]', m.el).forEach((e) => { const [g, o] = e.dataset.odef.split('.'); d.spec_groups[g].options[o].is_default = e.checked; });
    }
    function bind() {
      $('#f_file', m.el).onchange = (e) => { const f = e.target.files[0]; if (f) upload(f).catch((err) => toast(err.message)); };
      m.el.onclick = (e) => {
        const t = e.target.closest('[data-delg],[data-delo],[data-addo],[data-addg],[data-n],[data-y]'); if (!t) return;
        if (t.matches('[data-n]')) return m.close();
        sync();
        if (t.dataset.delg) { d.spec_groups.splice(+t.dataset.delg, 1); draw(); }
        else if (t.dataset.delo) { const [g, o] = t.dataset.delo.split('.'); d.spec_groups[g].options.splice(o, 1); draw(); }
        else if (t.dataset.addo) { d.spec_groups[+t.dataset.addo].options.push({ option_name: '', price_delta_fen: 0, is_default: false }); draw(); }
        else if ('addg' in t.dataset) { d.spec_groups.push({ group_name: '', options: [{ option_name: '', price_delta_fen: 0, is_default: true }] }); draw(); }
        else if ('y' in t.dataset) save();
      };
    }
    async function save() {
      if (!d.name.trim()) return ($('#ferr', m.el).textContent = '请填写菜名');
      if (!(d.price_fen > 0)) return ($('#ferr', m.el).textContent = '价格必须大于 0');
      const payload = { category_id: d.category_id, name: d.name, image_url: d.image_url, price_fen: d.price_fen, on_sale: d.on_sale, spec_groups: d.spec_groups };
      const r = await api(id ? 'PUT' : 'POST', id ? `/api/manager/dishes/${id}` : '/api/manager/dishes', payload);
      if (r.code !== 0) return ($('#ferr', m.el).textContent = r.message);
      m.close(); toast('已保存'); tabDishes();
    }
    draw();
  }

  // ---------- 分类（C1） ----------
  async function tabCats() {
    const r = await api('GET', '/api/manager/categories'); if (!check(r)) return;
    body().innerHTML = r.data.categories.map((c) => `<div class="card row"><input data-cn="${c.id}" value="${esc(c.name)}" maxlength="20" class="grow"><input data-cs="${c.id}" type="number" value="${c.sort_no}" style="width:70px" title="排序号"><button class="ghost small" data-savecat="${c.id}">保存</button></div>`).join('')
      + `<div class="card"><b>新增分类</b><div class="row" style="margin-top:8px"><input id="nc" placeholder="分类名称" maxlength="20" class="grow"><input id="ncs" type="number" value="9" style="width:70px"><button class="primary small" data-addcat>添加</button></div><div class="muted" style="margin-top:6px">右侧数字是排序号，越小越靠前。</div></div>`;
  }

  // ---------- 员工账号（C4） ----------
  async function tabStaff() {
    const r = await api('GET', '/api/manager/staff'); if (!check(r)) return;
    body().innerHTML = r.data.staff.map((u) => `<div class="card row between"><div><b>${esc(u.username)}</b> ${u.status === 'ENABLED' ? '<span class="tag green">启用中</span>' : '<span class="tag gray">已停用</span>'}</div>
      <button class="${u.status === 'ENABLED' ? 'danger' : 'ghost'} small" data-ust="${u.id}" data-to="${u.status === 'ENABLED' ? 'DISABLED' : 'ENABLED'}">${u.status === 'ENABLED' ? '停用' : '启用'}</button></div>`).join('')
      + `<div class="card"><b>新增店员</b><label>用户名（3~20 位字母数字下划线）</label><input id="su"><label>密码（至少 6 位）</label><input id="sp" type="text"><button class="primary" data-addstaff style="margin-top:10px">添加</button></div>`;
  }

  // ---------- 订单查询（C5） ----------
  async function tabOrders() {
    const r = await api('GET', `/api/manager/orders?from=${S.from}&to=${S.to}&page=${S.page}&page_size=20`); if (!check(r)) return;
    const { total, orders, page, page_size } = r.data, pages = Math.max(1, Math.ceil(total / page_size));
    body().innerHTML = `<div class="card"><div class="grid2"><div><label style="margin-top:0">开始日期</label><input type="date" id="df" value="${S.from}"></div><div><label style="margin-top:0">结束日期</label><input type="date" id="dt" value="${S.to}"></div></div>
      <button class="primary" data-q style="margin-top:10px;width:100%">查询</button></div>
      <div class="card" style="overflow:auto"><div class="muted" style="margin-bottom:6px">共 ${total} 单</div><table><tr><th>订单号</th><th>取餐号</th><th>金额</th><th>状态</th><th>时间</th></tr>
      ${orders.map((o) => `<tr><td>${esc(o.order_no)}</td><td>${esc(o.pickup_no_text) || '-'}</td><td>¥${yuan(o.total_fen)}</td><td>${esc(o.status_text)}</td><td>${fmtDateTime(o.created_at)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">没有订单</td></tr>'}</table>
      <div class="row between" style="margin-top:10px"><button class="ghost small" data-pg="-1" ${page <= 1 ? 'disabled' : ''}>上一页</button><span class="muted">${page} / ${pages}</span><button class="ghost small" data-pg="1" ${page >= pages ? 'disabled' : ''}>下一页</button></div></div>`;
  }

  // ---------- 营业统计：当日营业额、订单数、热销菜、分时段订单 ----------
  async function tabStats() {
    const r = await api('GET', `/api/manager/stats?date=${S.sdate}`); if (!check(r)) return;
    const t = r.data, max = Math.max(1, ...t.by_hour);
    const hours = t.by_hour.map((n, h) => [h, n]).filter(([h, n]) => n || (h >= 8 && h <= 21));
    body().innerHTML = `<div class="card row between"><div><label style="margin:0">统计日期</label><input type="date" id="sd" value="${S.sdate}"></div><button class="primary" data-sq>查看</button></div>
      <div class="card"><div class="muted">营业额（已扣除退款）</div><div class="price" style="font-size:34px;font-weight:800">¥${yuan(t.revenue_fen)}</div>
        <div class="grid2" style="margin-top:10px"><div><div class="muted">有效订单</div><b style="font-size:20px">${t.order_count} 单</b></div><div><div class="muted">客单价</div><b style="font-size:20px">¥${yuan(t.avg_fen)}</b></div></div>
        <div class="muted" style="margin-top:8px">收款 ¥${yuan(t.gross_fen)}，退款 ¥${yuan(t.refund_fen)}（${t.refund_orders} 单）</div></div>
      <div class="card"><h3>热销菜品 Top5</h3>${t.top_dishes.map((x, i) => `<div class="row between" style="padding:6px 0;border-bottom:1px solid var(--line)"><span>${i + 1}. ${esc(x.name)}</span><span class="muted">${x.qty} 份 · ¥${yuan(x.amount_fen)}</span></div>`).join('') || '<div class="empty" style="padding:16px">当天还没有订单</div>'}</div>
      <div class="card"><h3>分时段订单数</h3>${hours.map(([h, n]) => `<div class="row" style="gap:8px;padding:2px 0"><span class="muted" style="width:44px">${pad2(h)}:00</span><div style="flex:1;background:#f1f3f5;border-radius:4px;height:14px"><div style="width:${n / max * 100}%;background:var(--brand);height:14px;border-radius:4px"></div></div><span style="width:24px;text-align:right">${n}</span></div>`).join('')}</div>`;
  }

  // ---------- 异常处理（C6） ----------
  async function tabExc() {
    const r = await api('GET', '/api/manager/exceptions'); if (!check(r)) return;
    const { payments, refund_failed } = r.data;
    body().innerHTML = `<div class="card"><h3>待人工核对的支付（${payments.length}）</h3>${payments.map((p) => `<div style="padding:8px 0;border-bottom:1px solid var(--line)"><div><b>${esc(p.order_no)}</b> · ¥${yuan(p.amount_fen)} <span class="tag">${esc(p.status)}</span></div><div class="muted">${esc(p.note || '')}</div><button class="ghost small" data-resolve="${p.id}" style="margin-top:6px">标记已核对</button></div>`).join('') || '<div class="empty" style="padding:16px">没有</div>'}</div>
      <div class="card"><h3>退款失败的订单（${refund_failed.length}）</h3>${refund_failed.map((o) => `<div class="row between" style="padding:8px 0;border-bottom:1px solid var(--line)"><div><b>${esc(o.order_no)}</b> · ¥${yuan(o.total_fen)}</div><button class="primary small" data-retry="${o.id}">重试退款</button></div>`).join('') || '<div class="empty" style="padding:16px">没有</div>'}</div>`;
  }

  // ---------- 演示开关（只在演示版出现） ----------
  async function tabDemo() {
    const r = await api('GET', '/api/dev/mock'); if (r.code !== 0) { body().innerHTML = '<div class="empty">演示开关已关闭</div>'; return; }
    const st = r.data;
    body().innerHTML = `<div class="card"><h3>演示开关</h3><p class="muted">这些开关只用来演示异常流程，正式使用时用环境变量 DEV_TOOLS=0 关闭。</p>
      <div class="row between" style="padding:10px 0"><div>模拟“微信退款申请失败”<div class="muted">打开后店员点退款，订单会变“退款失败”，再到“异常”页重试</div></div><button class="switch ${st.refundFail ? 'on' : ''}" data-mock="refund_fail" data-v="${st.refundFail ? 0 : 1}"></button></div>
      <div class="row between" style="padding:10px 0"><div>模拟“微信查单接口故障”<div class="muted">打开后对账任务连续 3 次查不到会转人工核对</div></div><button class="switch ${st.queryError ? 'on' : ''}" data-mock="query_error" data-v="${st.queryError ? 0 : 1}"></button></div></div>
      <div class="card"><h3>快进时间</h3><p class="muted">系统时间：${new Date(st.server_time).toLocaleString()}。快进后会立即执行一次定时任务。</p>
      <div class="btns"><button class="ghost" data-adv="2">+2 分钟</button><button class="ghost" data-adv="6">+6 分钟（未接单提醒）</button><button class="ghost" data-adv="16">+16 分钟（未支付关闭）</button></div></div>`;
  }

  // ---------- 事件 ----------
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-tab],[data-edit],[data-savecat],[data-addcat],[data-ust],[data-addstaff],[data-q],[data-sq],[data-pg],[data-resolve],[data-retry],[data-mock],[data-adv]'); if (!t) return;
    const d = t.dataset;
    try {
      if (d.tab) { S.tab = d.tab; frame(); }
      else if (d.edit !== undefined) { if (!S.cats.length) await tabDishes(); dishForm(Number(d.edit) || 0); }
      else if (d.savecat) { const id = d.savecat; if (check(await api('PUT', `/api/manager/categories/${id}`, { name: $(`[data-cn="${id}"]`).value, sort_no: Number($(`[data-cs="${id}"]`).value) }))) { toast('已保存'); tabCats(); } }
      else if ('addcat' in d) { if (check(await api('POST', '/api/manager/categories', { name: $('#nc').value, sort_no: Number($('#ncs').value) }))) { toast('已添加'); tabCats(); } }
      else if (d.ust) { if (check(await api('PUT', `/api/manager/staff/${d.ust}/status`, { status: d.to }))) tabStaff(); }
      else if ('addstaff' in d) { if (check(await api('POST', '/api/manager/staff', { username: $('#su').value, password: $('#sp').value }))) { toast('已添加'); tabStaff(); } }
      else if ('q' in d) { S.from = $('#df').value; S.to = $('#dt').value; S.page = 1; tabOrders(); }
      else if ('sq' in d) { S.sdate = $('#sd').value || todayStr(); tabStats(); }
      else if (d.pg) { S.page += Number(d.pg); tabOrders(); }
      else if (d.resolve) {
        const m = openModal(`<h3>标记已核对</h3><label>核对说明（例如：已对照微信账单）</label><input id="note" maxlength="100"><div class="btns"><button data-n>取消</button><button class="primary" data-y>确定</button></div>`, 'center');
        $('[data-n]', m.el).onclick = m.close;
        $('[data-y]', m.el).onclick = async () => { if (check(await api('POST', `/api/manager/payments/${d.resolve}/resolve`, { note: $('#note', m.el).value }))) { m.close(); tabExc(); } };
      }
      else if (d.retry) { const r = await api('POST', `/api/manager/refunds/${d.retry}/retry`, {}); if (check(r)) { toast(r.data.status === 'REFUNDED' ? '退款成功' : '退款仍然失败'); tabExc(); } }
      else if (d.mock) { if (check(await api('POST', '/api/dev/mock', { [d.mock]: d.v === '1' }))) tabDemo(); }
      else if (d.adv) { const r = await api('POST', '/api/dev/advance-clock', { minutes: Number(d.adv) }); if (check(r)) { toast(`已快进，关闭 ${r.data.jobs.closed} 单，提醒 ${r.data.jobs.reminded} 单`); tabDemo(); } }
    } catch (err) { toast(err.message); }
  });
  $('#logout').onclick = () => { store('mgr_token', null); showLogin(); };
  function init() { if (!store('mgr_token')) return showLogin(); $('#logout').hidden = false; $('#who').textContent = store('mgr_name') || ''; frame(); }
  init();
})();
