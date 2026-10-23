// 蒔光衣櫥｜手機管理頁
// 用「管理員」分頁的密碼登入；看訂單、確認收款、填順豐單號、歸還驗收、退押金、取消訂單
(() => {
  'use strict';

  const API_URL = (window.SHOP_CONFIG && window.SHOP_CONFIG.API_URL || '').trim();
  const DEMO = !API_URL;

  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => 'NT$ ' + Number(n || 0).toLocaleString('zh-TW');
  const today = () => new Date(Date.now() + 8 * 36e5).toISOString().slice(0, 10);
  const addDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
  const dayDiff = (a, b) => { const p = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); }; return Math.round((p(b) - p(a)) / 864e5); };
  const pretty = s => {
    if (!s) return '—';
    const [y, m, d] = s.split('-').map(Number);
    return `${m}/${d}（${'日一二三四五六'[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}）`;
  };
  const itemName = p => (p.brand ? p.brand + ' ' : '') + p.name + (p.size ? `（${p.size}）` : '');

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 無痕模式等情況，忽略 */ } },
  };

  const state = {
    auth: store.get('sg_admin'),
    orders: [],
    tab: '',
    q: '',
    open: {}, // 展開中的操作表單 { 訂單編號: 'reject' | 'return' | ... }
    busy: false,
  };

  // 分頁：依訂單狀態分組，順序就是每天要處理的順序
  const TABS = [
    { key: 'pay', label: '待確認收款', match: o => o.status === '待付款' && o.remit && !o.payNote },
    { key: 'ship', label: '待出貨', match: o => o.status === '已付款' },
    { key: 'refund', label: '待退押金', match: o => o.status === '已歸還' },
    { key: 'out', label: '出租中', match: o => o.status === '已出貨' },
    { key: 'unpaid', label: '待付款', match: o => o.status === '待付款' && (!o.remit || o.payNote) },
    { key: 'done', label: '已完成', match: o => o.status === '已退押金' || o.status === '已取消' },
  ];

  async function api(body) {
    if (DEMO) return new Promise(r => setTimeout(() => r(demoApi(body)), 300));
    const res = await fetch(API_URL, { method: 'POST', body: JSON.stringify(body) });
    return res.json();
  }

  async function adminCall(op, extra) {
    const r = await api(Object.assign({ action: 'admin', token: state.auth && state.auth.token, op }, extra));
    if (r.needLogin) { logout(r.error); throw new Error(r.error); }
    if (!r.ok) throw new Error(r.error || '操作失敗，請稍後再試');
    state.orders = r.orders || [];
    return r;
  }

  // ───────── 登入 ─────────
  function renderLogin(msg) {
    $('#app').innerHTML = `
      <main class="login">
        <img src="mark.png" alt="" class="login-mark">
        <h1>蒔光衣櫥・管理</h1>
        <form class="form" id="login-form">
          <label>管理密碼<input name="password" type="password" required autocomplete="current-password" inputmode="text"></label>
          <button type="submit" class="btn primary block">登入</button>
          ${msg ? `<p class="form-error">${esc(msg)}</p>` : ''}
        </form>
        <p class="hint">密碼在試算表的「管理員」分頁。登入一次可以保持 30 天。</p>
      </main>`;
  }

  async function login(form) {
    const btn = form.querySelector('button');
    btn.disabled = true;
    btn.textContent = '登入中…';
    try {
      const r = await api({ action: 'adminLogin', password: form.password.value });
      if (!r.ok) throw new Error(r.error || '登入失敗');
      state.auth = { token: r.token, name: r.name };
      store.set('sg_admin', state.auth);
      await refresh(true);
    } catch (e) {
      renderLogin(e.message);
    }
  }

  function logout(msg) {
    state.auth = null;
    store.set('sg_admin', null);
    renderLogin(msg);
  }

  // ───────── 訂單列表 ─────────
  async function refresh(first) {
    if (first) $('#app').innerHTML = '<p class="loading">讀取訂單中…</p>';
    try {
      await adminCall('orders');
      render();
    } catch (e) {
      if (state.auth) { render(); toast(e.message); }
    }
  }

  function render() {
    const counts = {};
    TABS.forEach(t => { counts[t.key] = state.orders.filter(t.match).length; });
    if (!state.tab) state.tab = (TABS.find(t => t.key !== 'done' && counts[t.key]) || TABS[0]).key;
    const tab = TABS.find(t => t.key === state.tab);
    const q = state.q.trim().toLowerCase();
    const list = q
      ? state.orders.filter(o => [o.no, o.name, o.phone, o.tracking].join(' ').toLowerCase().replace(/-/g, '').includes(q.replace(/-/g, '')))
      : state.orders.filter(tab.match);

    $('#app').innerHTML = `
      <header class="adm-head">
        <div class="adm-title"><img src="mark.png" alt=""><div><b>蒔光衣櫥・管理</b><small>${esc(state.auth.name)}</small></div></div>
        <div class="adm-tools">
          <button type="button" class="nav-btn" data-act="refresh">重新整理</button>
          <button type="button" class="nav-btn" data-act="logout">登出</button>
        </div>
      </header>
      <div class="adm-search"><input type="search" id="q" placeholder="搜尋姓名、電話、訂單編號、單號" value="${esc(state.q)}"></div>
      ${q ? `<p class="adm-result">搜尋結果 ${list.length} 筆</p>` : `
      <nav class="adm-tabs">
        ${TABS.map(t => `<button type="button" data-tab="${t.key}" aria-pressed="${t.key === state.tab}">${t.label}${counts[t.key] && t.key !== 'done' ? `<span>${counts[t.key]}</span>` : ''}</button>`).join('')}
      </nav>`}
      <main class="adm-list">
        ${list.length ? list.map(cardHTML).join('') : `<p class="empty-state">${q ? '找不到符合的訂單' : '這裡目前沒有訂單 ✦'}</p>`}
      </main>`;
  }

  function cardHTML(o) {
    const left = o.startDate ? dayDiff(today(), o.startDate) : null;
    const urgent = o.status === '已付款' && left !== null && left <= 3;
    const remitOk = o.remit && o.remit.amount === o.total;
    return `<article class="adm-card${urgent ? ' urgent' : ''}" data-no="${esc(o.no)}">
      <div class="adm-card-head">
        <span class="mono">${esc(o.no)}</span>
        <span class="status-badge${['已付款', '已出貨', '已歸還', '已退押金'].includes(o.status) ? ' ok' : ''}">${esc(o.status)}</span>
      </div>
      <div class="adm-who">
        <b>${esc(o.name)}</b>
        <a href="tel:${esc(o.phone.replace(/[^\d+]/g, ''))}" class="copy">撥打 ${esc(o.phone)}</a>
      </div>
      <dl class="adm-info">
        <div><dt>租期</dt><dd>${pretty(o.startDate)} ～ ${pretty(o.endDate)}${o.status === '已付款' && left !== null ? `<em class="${urgent ? 'warn' : ''}">${left > 0 ? `還有 ${left} 天` : left === 0 ? '今天起租' : `已過 ${-left} 天`}</em>` : ''}</dd></div>
        <div><dt>衣服</dt><dd>${o.items.map(p => esc(itemName(p))).join('<br>')}</dd></div>
        <div><dt>金額</dt><dd>${money(o.total)}<small>（租金 ${money(o.rentTotal)}＋押金 ${money(o.depositTotal)}${o.shipping ? `＋運費 ${money(o.shipping)}` : ''}）</small></dd></div>
        <div><dt>地址</dt><dd>${esc(o.address)} <button type="button" class="copy" data-copy="${esc(o.address)}">複製</button></dd></div>
        ${o.note ? `<div><dt>客戶備註</dt><dd class="pre">${esc(o.note)}</dd></div>` : ''}
        ${o.addon ? `<div><dt>加購</dt><dd class="pre">${esc(o.addon)}</dd></div>` : ''}
        ${o.tracking ? `<div><dt>順豐單號</dt><dd><span class="mono">${esc(o.tracking)}</span> <button type="button" class="copy" data-copy="${esc(o.tracking)}">複製</button></dd></div>` : ''}
        ${o.status === '已歸還' || o.status === '已退押金' ? `<div><dt>驗收</dt><dd>${o.deduct ? `扣款 ${money(o.deduct)}：${esc(o.deductReason)}` : '衣服完好'}</dd></div>` : ''}
        ${o.refund != null ? `<div><dt>已退押金</dt><dd>${money(o.refund)}</dd></div>` : ''}
      </dl>
      ${o.remit ? `<div class="adm-remit ${remitOk ? 'match' : 'mismatch'}">
        <b>客戶匯款回報</b>${remitOk ? '<span>金額相符</span>' : `<span>⚠ 金額不同（應付 ${money(o.total)}）</span>`}
        <p>${esc(o.remit.name)}・${esc(o.remit.bank)}・${pretty(o.remit.date)}<br><b class="mono">${money(o.remit.amount)}</b>　後五碼 <b class="mono">${esc(o.remit.last5)}</b></p>
        ${o.payNote ? `<p class="adm-note">已回覆客戶：${esc(o.payNote)}</p>` : ''}
      </div>` : ''}
      ${actionsHTML(o)}
      ${o.log ? `<details class="adm-log"><summary>操作紀錄</summary><pre>${esc(o.log)}</pre></details>` : ''}
    </article>`;
  }

  // 依狀態顯示可以做的操作；需要填資料的操作先展開小表單
  function actionsHTML(o) {
    const open = state.open[o.no];
    const btn = (op, label, cls) => `<button type="button" class="btn ${cls || ''}" data-op="${op}">${label}</button>`;
    const form = (op, inner, submitLabel) => `<form class="form adm-form" data-submit="${op}">${inner}
      <div class="foot-row"><button type="button" class="btn" data-op="close">取消</button><button type="submit" class="btn primary">${submitLabel}</button></div></form>`;
    switch (o.status) {
      case '待付款':
        if (open === 'reject') return form('rejectPay', `<label>要告訴客戶的話（客戶查詢時看得到）<textarea name="message" rows="2" maxlength="200" required>還沒看到這筆款項入帳，請確認匯款帳號和金額，或私訊我們。</textarea></label>`, '送出查帳結果');
        if (open === 'cancel') return cancelForm(form);
        return `<div class="adm-actions">
          ${o.remit && !o.payNote ? btn('confirmPay', '✓ 確認收款', 'primary') + btn('reject', '查無款項') : ''}
          ${btn('cancel', '取消訂單', 'ghost')}
        </div>`;
      case '已付款':
        if (open === 'cancel') return cancelForm(form);
        return form('ship', `<label>順豐單號<input name="tracking" required autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="寄出後填寫，例如 SF1234567890"></label>`, '已寄出')
          .replace('<button type="button" class="btn" data-op="close">取消</button>', btn('cancel', '取消訂單', 'ghost'));
      case '已出貨':
        if (open === 'return') return form('return', `
          <fieldset class="adm-choice">
            <label class="check"><input type="radio" name="result" value="ok" checked> 衣服完好，全額退押金</label>
            <label class="check"><input type="radio" name="result" value="deduct"> 有損壞或污漬，要扣款</label>
          </fieldset>
          <div class="adm-deduct" hidden>
            <label>扣款金額<input name="deduct" inputmode="numeric" placeholder="例如 500"></label>
            <label>扣款原因（客戶查詢時看得到）<textarea name="reason" rows="2" maxlength="200" placeholder="例如：裙擺有一處勾紗，需要修補"></textarea></label>
          </div>`, '確認收到歸還');
        if (open === 'retrack') return form('ship', `<label>修改順豐單號<input name="tracking" required value="${esc(o.tracking)}" autocapitalize="characters" autocomplete="off" spellcheck="false"></label>`, '儲存單號');
        return `<div class="adm-actions">${btn('return', '收到歸還', 'primary')}${btn('retrack', '修改單號', 'ghost')}</div>`;
      case '已歸還': {
        const amount = Math.max(0, o.depositTotal - (o.deduct || 0));
        const ra = o.refundAccount || {};
        return `<div class="adm-refund">
          <b>退押金到</b>
          <p>${esc(ra.bank)}<br><span class="mono">${esc(ra.account)}</span> <button type="button" class="copy" data-copy="${esc(String(ra.account).replace(/\D/g, ''))}">複製帳號</button><br>戶名 ${esc(ra.holder)}</p>
        </div>` + form('refund', `<label>退款金額<input name="amount" inputmode="numeric" required value="${amount}"></label>
          <p class="hint">押金 ${money(o.depositTotal)}${o.deduct ? ` − 扣款 ${money(o.deduct)}` : ''} ＝ ${money(amount)}。轉帳完成後再按「已退押金」。</p>`, '已退押金')
          .replace('<button type="button" class="btn" data-op="close">取消</button>', '');
      }
      default:
        return '';
    }
  }

  function cancelForm(form) {
    return form('cancel', `<label>取消原因（選填，只有你們看得到）<input name="reason" maxlength="200" placeholder="例如：逾期未付款"></label>
      <p class="hint">取消後衣服的檔期會立刻釋出，其他客戶可以預約。</p>`, '確認取消訂單');
  }

  async function runOp(no, op, data, okMsg) {
    if (state.busy) return;
    state.busy = true;
    const card = document.querySelector(`.adm-card[data-no="${CSS.escape(no)}"]`);
    if (card) card.classList.add('busy');
    try {
      await adminCall(op, Object.assign({ no }, data));
      delete state.open[no];
      render();
      toast(okMsg);
    } catch (e) {
      if (card) card.classList.remove('busy');
      if (state.auth) toast(e.message);
    } finally {
      state.busy = false;
    }
  }

  // ───────── 事件 ─────────
  document.addEventListener('submit', e => {
    const f = e.target;
    e.preventDefault();
    if (f.id === 'login-form') { login(f); return; }
    const no = f.closest('.adm-card') && f.closest('.adm-card').dataset.no;
    const fd = new FormData(f);
    const v = k => String(fd.get(k) || '').trim();
    switch (f.dataset.submit) {
      case 'rejectPay': runOp(no, 'rejectPay', { message: v('message') }, '已回覆查帳結果'); break;
      case 'ship': runOp(no, 'ship', { tracking: v('tracking').replace(/\s/g, '') }, '已更新順豐單號'); break;
      case 'return': {
        const deduct = v('result') === 'deduct' ? Number(v('deduct').replace(/[^\d]/g, '')) : 0;
        if (v('result') === 'deduct' && !(deduct > 0)) { toast('請填扣款金額'); return; }
        runOp(no, 'return', { deduct, reason: v('reason') }, '已記錄歸還');
        break;
      }
      case 'refund': {
        const amount = Number(v('amount').replace(/[^\d]/g, ''));
        if (!confirm(`確定已經轉帳退押金 ${money(amount)} 嗎？`)) return;
        runOp(no, 'refund', { amount }, '已完成這筆訂單 ✦');
        break;
      }
      case 'cancel':
        if (!confirm('確定要取消這筆訂單嗎？')) return;
        runOp(no, 'cancel', { reason: v('reason') }, '已取消訂單');
        break;
    }
  });

  document.addEventListener('click', e => {
    const t = e.target.closest('[data-act],[data-tab],[data-op],[data-copy]');
    if (!t) return;
    if (t.dataset.copy != null) { copy(t.dataset.copy); return; }
    if (t.dataset.act === 'refresh') { refresh(); toast('已重新整理'); return; }
    if (t.dataset.act === 'logout') { if (confirm('確定要登出嗎？')) logout(); return; }
    if (t.dataset.tab) { state.tab = t.dataset.tab; render(); window.scrollTo(0, 0); return; }
    const no = t.closest('.adm-card') && t.closest('.adm-card').dataset.no;
    const op = t.dataset.op;
    if (op === 'confirmPay') {
      if (confirm('已經在銀行確認這筆款項入帳了嗎？')) runOp(no, 'confirmPay', {}, '已確認收款');
      return;
    }
    if (op === 'close') delete state.open[no];
    else state.open[no] = op;
    render();
  });

  document.addEventListener('change', e => {
    if (e.target.name === 'result') {
      const box = e.target.closest('form').querySelector('.adm-deduct');
      box.hidden = e.target.value !== 'deduct';
    }
  });

  let searchTimer;
  document.addEventListener('input', e => {
    if (e.target.id !== 'q') return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = e.target.value;
      render();
      const q = $('#q');
      q.focus();
      q.setSelectionRange(q.value.length, q.value.length);
    }, 250);
  });

  // 從背景切回來時自動更新（例如剛從銀行 App 回來）
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.auth && !state.busy && !Object.keys(state.open).length) refresh();
  });

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove('show'), 2200);
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('已複製'); }
    catch (e) { prompt('請長按複製：', text); }
  }

  // ───────── 示範模式（還沒設定 API_URL 時使用）─────────
  const demo = (() => {
    const t = today();
    const no = (d, code) => 'SG' + addDays(t, d).slice(5).replace('-', '') + '-' + code;
    const base = { shipping: 0, addon: '', note: '', internal: '', payNote: '', tracking: '', deduct: 0, deductReason: '', refund: null };
    const item = (id, name, size) => ({ id, brand: '多霏', name, size });
    const acct = { bank: '國泰世華 013', account: '0123-4567-8901', holder: '林小華' };
    return [
      Object.assign({}, base, { no: no(0, 'H8KD'), status: '待付款', createdAt: t + ' 10:12', name: '林小華', phone: '0987654321', address: '台北市大安區復興南路一段 100 號', startDate: addDays(t, 6), endDate: addDays(t, 11), items: [item('SG002', '粉漾微光', '90')], rentTotal: 600, depositTotal: 10000, total: 10600, remit: { name: '林小華', bank: '國泰世華', date: t, amount: 10600, last5: '55123' }, refundAccount: acct, log: '' }),
      Object.assign({}, base, { no: no(0, 'P2WQ'), status: '待付款', createdAt: t + ' 09:40', name: '張美玲', phone: '0922333444', address: '順豐 台中文心站', startDate: addDays(t, 9), endDate: addDays(t, 14), items: [item('SG004', '我的羅曼史', '80'), item('SG003', '粉漾微光', '100')], rentTotal: 1200, depositTotal: 20000, total: 21200, remit: { name: '張美玲', bank: '中國信託', date: t, amount: 20000, last5: '77001' }, note: '想加購珍珠髮箍', refundAccount: acct, log: '' }),
      Object.assign({}, base, { no: no(-1, 'Z7MN'), status: '待付款', createdAt: addDays(t, -1) + ' 21:05', name: '王大明', phone: '0911222333', address: '新北市板橋區文化路一段 1 號', startDate: addDays(t, 12), endDate: addDays(t, 17), items: [item('SG006', '我的羅曼史', '110')], rentTotal: 600, depositTotal: 10000, total: 10600, remit: null, refundAccount: acct, log: '' }),
      Object.assign({}, base, { no: no(-3, 'M3XA'), status: '已付款', createdAt: addDays(t, -3) + ' 14:20', name: '陳小美', phone: '0912345678', address: '高雄市左營區博愛二路 2 號', startDate: addDays(t, 2), endDate: addDays(t, 7), items: [item('SG005', '我的羅曼史', '90')], rentTotal: 600, depositTotal: 10000, total: 10750, addon: '珍珠髮箍 ×1（加購 NT$ 150）', remit: { name: '陳小美', bank: '中國信託', date: addDays(t, -2), amount: 10750, last5: '13579' }, refundAccount: acct, log: '' }),
      Object.assign({}, base, { no: no(-8, 'R4TE'), status: '已出貨', createdAt: addDays(t, -8) + ' 11:00', name: '李安安', phone: '0933444555', address: '桃園市中壢區中正路 3 號', startDate: addDays(t, -3), endDate: addDays(t, 2), items: [item('SG001', '粉漾微光', '80')], rentTotal: 600, depositTotal: 10000, total: 10600, tracking: 'SF1029384756', remit: { name: '李安安', bank: '台新', date: addDays(t, -7), amount: 10600, last5: '24680' }, refundAccount: acct, log: '' }),
      Object.assign({}, base, { no: no(-15, 'B9CV'), status: '已歸還', createdAt: addDays(t, -15) + ' 16:30', name: '周曉雯', phone: '0955666777', address: '台南市東區大學路 1 號', startDate: addDays(t, -10), endDate: addDays(t, -5), items: [item('SG004', '我的羅曼史', '80')], rentTotal: 600, depositTotal: 10000, total: 10600, tracking: 'SF5647382910', deduct: 500, deductReason: '裙擺一處勾紗，需要修補', remit: { name: '周曉雯', bank: '玉山', date: addDays(t, -14), amount: 10600, last5: '11223' }, refundAccount: { bank: '玉山銀行 808', account: '0987-6543-2100', holder: '周曉雯' }, log: '' }),
    ];
  })();

  function demoApi(req) {
    if (req.action === 'adminLogin') return req.password === 'demo1234' ? { ok: true, token: 'demo', name: '示範管理員' } : { ok: false, error: '密碼不正確。（示範模式的密碼是 demo1234）' };
    const o = demo.find(x => x.no === req.no);
    const name = '示範管理員';
    const now = new Date(Date.now() + 8 * 36e5).toISOString().slice(5, 16).replace('-', '/').replace('T', ' ');
    const log = text => { o.log = (o.log ? o.log + '\n' : '') + `${now} ${name}：${text}`; };
    switch (req.op) {
      case 'confirmPay': o.status = '已付款'; o.payNote = ''; log('確認收款'); break;
      case 'rejectPay': o.payNote = req.message; log('查無款項：' + req.message); break;
      case 'ship':
        if (!/^[0-9A-Z]{8,20}$/i.test(req.tracking)) return { ok: false, error: '順豐單號格式不對，請再確認一次。' };
        log((o.status === '已出貨' ? '修改順豐單號：' : '已寄出，順豐單號 ') + req.tracking.toUpperCase());
        o.status = '已出貨'; o.tracking = req.tracking.toUpperCase();
        break;
      case 'return':
        if (req.deduct > o.depositTotal) return { ok: false, error: '扣款金額不能超過押金。' };
        if (req.deduct && !req.reason) return { ok: false, error: '請寫扣款原因，客戶查詢時會看到。' };
        o.status = '已歸還'; o.deduct = req.deduct; o.deductReason = req.reason;
        log(req.deduct ? `收到歸還，扣款 ${req.deduct}：${req.reason}` : '收到歸還，衣服完好');
        break;
      case 'refund': o.status = '已退押金'; o.refund = req.amount; log('已退押金 ' + req.amount); break;
      case 'cancel': o.status = '已取消'; log('取消訂單' + (req.reason ? '：' + req.reason : '')); break;
    }
    return { ok: true, name, orders: demo };
  }

  // ───────── 啟動 ─────────
  if (DEMO) $('#demo-banner').hidden = false;
  if (state.auth) refresh(true);
  else renderLogin();
})();
