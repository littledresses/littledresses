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
  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
  // 檢查完成時預計退多少押金：押金 − 延遲費 − 維修費 − 延期加收
  // 延遲費＝總租金（租金原價＋加租）× 10% × 延遲天數（後台 Code.gs 的 LATE_FEE_RATE 要一起改）
  const LATE_FEE_RATE = 0.1;
  const rentBase = o => (o.rentTotal || 0) + (o.addonTotal || 0);
  const lateFeeOf = (o, days) => Math.round(rentBase(o) * LATE_FEE_RATE * days);
  // 延後歸還日加收：一樣是總租金 × 10% × 延後天數
  const extText = (o, oldEnd, newEnd) => {
    const d = newEnd ? daysBetween(oldEnd, newEnd) : 0;
    return d > 0 ? `加收＝總租金 ${money(rentBase(o))} × 10% × ${d} 天＝<b>${money(lateFeeOf(o, d))}</b>（從押金扣除）` : '加收＝總租金 × 10% × 延後天數（從押金扣除）';
  };
  // 改日期（待付款急件／待出貨修改日期）：迄日跟著起日移動（租期天數不變）
  // 新起日早於「今天＋最少提前天數」＝急件，加收加急費：待付款加在應付總額，待出貨從押金扣
  const rushBefore = () => addDays(today(), state.minLead);
  const dateText = (o, s, unpaid) => {
    if (!s) return '選好起日後，歸還日會自動跟著改。';
    if (s === o.startDate) return `<b class="warn">${pretty(s)} 是原本的起日，請選別的日期</b>`;
    const e = addDays(s, daysBetween(o.startDate, o.endDate));
    const head = `新租期：<b>${pretty(s)} ～ ${pretty(e)}</b><br>`;
    if (s >= rushBefore()) return head + (unpaid ? `<b class="warn">${pretty(s)} 客人在網站上就能選，不用改成急件</b>` : '不是急件，不加收。');
    if (o.rushed) return head + '<b class="warn">這筆已經用過急件（每筆只能一次），請選 ' + pretty(rushBefore()) + ' 起的日期</b>';
    return head + (unpaid ? `急件，加收加急費 <b>${money(state.rushFee)}</b>，應付總額變成 ${money(o.total + state.rushFee)}。` : `急件，加急費 <b>${money(state.rushFee)}</b> 從押金扣除。`);
  };
  // 待出貨改完日期：複製給客戶的改期通知
  const dateNoticeText = o => [
    `您好，訂單 ${o.no} 的租期已改為 ${pretty(o.startDate)} ～ ${pretty(o.endDate)}。`,
    o.rushDeposit ? `這次是急件，加急費 ${money(o.rushDeposit)} 會在歸還後從押金扣除。` : '',
    '衣服會在起日前寄達，有任何問題再跟我們說，謝謝您 ✦',
  ].filter(Boolean).join('\n');
  const depOther = o => (o.extendFee || 0) + (o.rushDeposit || 0);
  const refundLeft = (o, late, repair) => Math.max(0, o.depositTotal - late - repair - depOther(o));
  // 傳給客戶的押金結算文字（按「複製給客戶」貼到 LINE／訊息）
  // d = { days, late, repair, reason, deduct（舊資料只有合計時）, amount }
  const settleText = (o, d) => {
    const ext = o.extendFee || 0;
    const lines = ['您好，衣服已經檢查完成，押金結算如下：', `押金 ${money(o.depositTotal)}`];
    if (d.late) lines.push(`－ 延遲費 ${money(d.late)}（延遲 ${d.days} 天：總租金 ${money(rentBase(o))} × 10% × ${d.days} 天）`);
    if (d.repair) lines.push(`－ 維修／清潔費 ${money(d.repair)}${d.reason ? `（${d.reason}）` : ''}`);
    if (d.deduct) lines.push(`－ 扣款 ${money(d.deduct)}${d.reason ? `（${d.reason}）` : ''}`);
    if (ext) lines.push(`－ 延期加收 ${money(ext)}`);
    if (o.rushDeposit) lines.push(`－ 加急費 ${money(o.rushDeposit)}`);
    if (lines.length === 2) lines[1] = `衣服完好，押金 ${money(o.depositTotal)} 全額退還。`;
    else lines.push(`＝ 退還 ${money(d.amount)}`);
    lines.push('款項會轉到您下單時留的帳戶，謝謝您 ✦');
    return lines.join('\n');
  };
  // 待退款卡片：從訂單資料拆出延遲費、維修費（維修原因從扣款原因那一行取出）
  const refundDetail = (o, amount) => {
    if (!o.lateFee && !o.repairFee) return { deduct: o.deduct || 0, reason: o.deductReason, amount };
    const m = String(o.deductReason || '').match(/維修／清潔 NT\$ [\d,]+：(.+)/);
    return { days: o.lateDays, late: o.lateFee, repair: o.repairFee, reason: m ? m[1] : '', amount };
  };
  // 待付款「付款通知」：複製後貼到 LINE／訊息傳給客戶
  const payNoticeText = (o, bank) => {
    const items = o.items || [], addons = o.addons || [], extras = o.extras || [];
    const addonDep = addons.reduce((n, a) => n + (a.deposit || 0) * a.qty, 0) + extras.reduce((n, x) => n + x.deposit, 0);
    const sum = k => items.reduce((n, p) => n + (Number(p[k]) || 0), 0);
    const lines = ['謝謝媽咪的租借 ♡', '', `訂單：${o.no}`];
    // 每件衣服的租金、押金跟訂單合計對得上才分開列，對不上（例如之後改過價錢）就合併成一行
    if (items.length && items.every(p => p.rent != null && p.deposit != null) && sum('rent') === o.rentTotal && sum('deposit') === o.depositTotal - addonDep) {
      items.forEach(p => lines.push(`${itemName(p)}　租金 ${money(p.rent)}　押金 ${money(p.deposit)}`));
    } else {
      lines.push(`${items.map(itemName).join('、')}　租金 ${money(o.rentTotal)}　押金 ${money(o.depositTotal - addonDep)}`);
    }
    addons.forEach(a => lines.push(`${a.name} × ${a.qty}　租金 ${money((a.price || 0) * a.qty)}　押金 ${money((a.deposit || 0) * a.qty)}`));
    extras.forEach(x => lines.push(`${[x.category, x.note].filter(Boolean).join(' ')}　租金 ${money(x.rent)}　押金 ${money(x.deposit)}`));
    if (o.discount) lines.push(`優惠折抵 －${money(o.discount)}`);
    if (o.shipping) lines.push(`運費 ${money(o.shipping)}`);
    if (o.rushFee) lines.push(`加急費 ${money(o.rushFee)}`);
    const ordered = String(o.createdAt || '').slice(0, 10);
    const due = /^\d{4}-\d\d-\d\d$/.test(ordered) ? `於 ${pretty(addDays(ordered, 1))} 23:59 前` : '';
    // 試算表沒填帳號（空白或還是預設的範例值）→ 不列帳號，請客戶看另外傳的圖片
    const hasBank = bank && /\d/.test(bank.account) && !/^[0\-\s]+$/.test(bank.account) && bank.bankName !== '範例銀行';
    lines.push(`費用一共 ${money(o.total)}`, '', hasBank ? `麻煩${due}匯款到以下帳戶，` : `麻煩${due}完成匯款（匯款帳戶請見下方圖片），`);
    if (hasBank) lines.push(`${bank.bankCode ? bank.bankCode + ' ' : ''}${bank.bankName}`, `帳號 ${bank.account}`, `戶名 ${bank.holder}`);
    // 連到網站首頁（管理頁跟網站在同一個資料夾），點了直接打開這張訂單的查詢畫面
    const link = new URL('./', location.href).href + `#order=${encodeURIComponent(o.no)}&tel=${encodeURIComponent(String(o.phone || '').replace(/\D/g, ''))}`;
    lines.push('', '匯款完成後，請到查詢訂單頁面回填匯款資訊，訂單才正式完成唷！', link);
    return lines.join('\n');
  };
  const COPY_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>';
  const copyBtn = text => `<button type="button" class="copy adm-copy-settle" data-copy="${esc(text)}" aria-label="複製押金結算，傳給客戶" title="複製押金結算，傳給客戶">${COPY_ICON}</button>`;
  const calcText = (o, late, repair, days, reason) => {
    const ext = o.extendFee || 0, rd = o.rushDeposit || 0;
    if (late + repair + ext + rd > o.depositTotal) return `<b class="warn">扣款加起來超過押金 ${money(o.depositTotal)} 了</b>`;
    const parts = [late ? ` − 延遲費 ${money(late)}` : '', repair ? ` − 維修費 ${money(repair)}` : '', ext ? ` − 延期加收 ${money(ext)}` : '', rd ? ` − 加急費 ${money(rd)}` : ''].join('');
    const amount = refundLeft(o, late, repair);
    return (late || repair ? '' : '都沒勾＝衣服完好。') + `押金 ${money(o.depositTotal)}${parts} ＝ 預計退 <b>${money(amount)}</b>`
      + copyBtn(settleText(o, { days, late, repair, reason, amount }));
  };
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
    pick: [], // 待出貨分頁勾選要合併出貨的訂單編號
    contactOpen: new Set(), // 展開「收件資料」的訂單（重新整理畫面時保持展開）
    contactClosed: new Set(), // 待出貨預設展開；記住被收起的
    extraMenu: [], // 試算表「加購選單」的類別
    bank: null, // 試算表「設定」的匯款帳號（付款通知用）
    rushFee: 300, // 試算表「設定」的加急費（急件用）
    minLead: 3, // 試算表「設定」的最少提前天數（判斷急件）
    maxAhead: 90, // 最多預約天數
    shipLead: 2, // 試算表「設定」的出貨提前天數：出貨日＝起日往前推幾天
    shipDay: '', // 待出貨分頁的日期篩選：'' 全部、'today' 今日（含逾期）、或 yyyy-mm-dd
    open: {}, // 展開中的操作表單 { 訂單編號: 'reject' | 'cancel' | ... }
    busy: false,
  };

  // 分頁：照一筆訂單從頭到尾的順序排
  const TABS = [
    { key: 'unpaid', label: '待付款', match: o => o.status === '待付款' && (!o.remit || o.payNote) },
    { key: 'pay', label: '待確認收款', match: o => o.status === '待付款' && o.remit && !o.payNote },
    { key: 'ship', label: '待出貨', match: o => o.status === '已付款' },
    { key: 'out', label: '出租中', match: o => o.status === '已出貨' },
    { key: 'check', label: '檢查中', match: o => o.status === '檢查中' },
    // 待退款有兩種：檢查完成要退押金、已付款後取消要退款；都是「要轉帳給客戶」（已歸還是舊版狀態）
    { key: 'refund', label: '待退款', match: o => o.status === '待退款' || o.status === '已歸還' },
    { key: 'done', label: '已完成', match: o => o.status === '已退押金' || o.status === '已取消' },
  ];
  // 一打開先停在最需要處理的分頁（有訂單的話）
  const FIRST_TAB = ['pay', 'ship', 'check', 'refund', 'out', 'unpaid'];

  async function api(body) {
    if (DEMO) return new Promise(r => setTimeout(() => r(demoApi(body)), 300));
    const res = await fetch(API_URL, { method: 'POST', body: JSON.stringify(body) });
    return res.json();
  }

  async function adminCall(op, extra) {
    const r = await api(Object.assign({ action: 'admin', token: state.auth && state.auth.token, op }, extra));
    if (r.needLogin) { logout(r.error); throw new Error(r.error); }
    if (!r.ok) {
      const err = new Error(r.error || '操作失敗，請稍後再試');
      err.conflict = !!r.conflict;
      throw err;
    }
    state.orders = r.orders || [];
    if (r.extraMenu) state.extraMenu = r.extraMenu;
    if (r.bank) state.bank = r.bank;
    if (r.rushFee != null) state.rushFee = r.rushFee;
    if (r.shipLeadDays != null) state.shipLead = r.shipLeadDays;
    if (r.minLeadDays != null) state.minLead = r.minLeadDays;
    if (r.maxAheadDays != null) state.maxAhead = r.maxAheadDays;
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
    if (!state.tab) state.tab = FIRST_TAB.find(k => counts[k]) || 'unpaid';
    const tab = TABS.find(t => t.key === state.tab);
    const q = state.q.trim().toLowerCase();
    let list = q
      ? state.orders.filter(o => [o.no, o.name, o.phone, o.tracking].join(' ').toLowerCase().replace(/-/g, '').includes(q.replace(/-/g, '')))
      : state.orders.filter(tab.match);
    // 待出貨：依出貨日排序，可以只看某一天（或今天＋逾期）要寄的
    const shipTab = !q && state.tab === 'ship';
    const shipAll = shipTab ? list.length : 0;
    if (shipTab) {
      list = list.slice().sort((a, b) => (shipDayOf(a) || '').localeCompare(shipDayOf(b) || ''));
      if (state.shipDay === 'today') list = list.filter(o => shipDayOf(o) && shipDayOf(o) <= today());
      else if (state.shipDay) list = list.filter(o => shipDayOf(o) === state.shipDay);
    }
    // 合併出貨只在「待出貨」分頁；勾選中的訂單如果已經不是已付款就拿掉
    const pickMode = !q && state.tab === 'ship';
    state.pick = pickMode ? state.pick.filter(no => state.orders.some(o => o.no === no && o.status === '已付款')) : [];

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
      ${shipTab ? shipFilterHTML(list.length, shipAll) : ''}
      <main class="adm-list">
        ${list.length ? list.map(o => cardHTML(o, pickMode)).join('') : `<p class="empty-state">${q ? '找不到符合的訂單' : shipTab && state.shipDay ? '這天沒有要出貨的訂單 ✦' : '這裡目前沒有訂單 ✦'}</p>`}
      </main>
      <div id="shipbar"></div>`;
    renderShipBar();
  }

  // ───────── 出貨日篩選 ─────────
  // 出貨日＝起日往前推「出貨提前天數」；遇到週日（順豐不收件）就再往前一天到週六
  const isSunday = s => new Date(s + 'T00:00:00Z').getUTCDay() === 0;
  const shipDayOf = o => {
    if (!o.startDate) return '';
    const d = addDays(o.startDate, -state.shipLead);
    return isSunday(d) ? addDays(d, -1) : d;
  };
  function shipFilterHTML(n, all) {
    const d = state.shipDay;
    const t = today();
    const label = d === 'today' ? `今天（${pretty(t)}）和逾期要出貨` : d ? `${pretty(d)} 要出貨` : '全部待出貨';
    return `<div class="adm-shipday">
      <div class="adm-shipday-row">
        <button type="button" data-shipday="" aria-pressed="${!d}">全部</button>
        <button type="button" data-shipday="today" aria-pressed="${d === 'today'}">今日出貨</button>
        <label class="adm-shipday-date${d && d !== 'today' ? ' on' : ''}"><span>選日期</span><input type="date" id="shipday" value="${d && d !== 'today' ? d : ''}"></label>
      </div>
      <p>${label} <b>${n}</b> 筆<small>出貨日＝起日前 ${state.shipLead} 天，遇週日提前到週六</small></p>
    </div>`;
  }
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-shipday]');
    if (!b) return;
    state.shipDay = b.dataset.shipday;
    render();
  });
  document.addEventListener('change', e => {
    if (e.target.id !== 'shipday') return;
    state.shipDay = e.target.value || '';
    render();
  });

  // ───────── 合併出貨 ─────────
  // 可以合併出貨＝姓名、電話、收件地址都一樣（後台 shipMany 也會再檢查一次）
  const sameKey = o => [String(o.name || '').trim(), String(o.phone || '').replace(/\D/g, ''), String(o.address || '').replace(/\s/g, '')].join('|');
  const sameCustomer = (a, b) => sameKey(a) === sameKey(b);
  // 已經勾了一筆之後，姓名、電話、地址不一樣的訂單不能勾
  function syncPickable() {
    const first = state.orders.find(o => o.no === state.pick[0]);
    document.querySelectorAll('[data-pick]').forEach(box => {
      const o = state.orders.find(x => x.no === box.dataset.pick);
      const off = !!first && !box.checked && !!o && !sameCustomer(o, first);
      box.disabled = off;
      box.closest('.adm-pick').classList.toggle('off', off);
      box.closest('.adm-pick').title = off ? '姓名、電話、收件地址跟已勾選的訂單不同，不能合併' : '';
    });
  }
  function renderShipBar() {
    const bar = $('#shipbar');
    if (!bar) return;
    const picked = state.pick.map(no => state.orders.find(o => o.no === no)).filter(Boolean);
    document.body.classList.toggle('has-shipbar', picked.length > 0);
    syncPickable();
    if (!picked.length) { bar.innerHTML = ''; return; }
    bar.innerHTML = `<form class="adm-shipbar" data-submit="shipMany">
      <div class="adm-shipbar-head"><b>合併出貨 ${picked.length} 筆</b><button type="button" class="link-btn" data-act="unpick">取消選取</button></div>
      <p class="hint">${picked.map(o => `${esc(o.name)}・${esc(o.no)}`).join('<br>')}</p>
      ${picked.length < 2 ? '<p class="hint">再勾一筆姓名、電話、收件地址都一樣的訂單，就能合併出貨。</p>' : `<div class="adm-shipbar-row"><input name="tracking" required autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="順豐單號"><button type="submit" class="btn primary">合併寄出</button></div>`}
    </form>`;
  }

  async function shipMany(tracking) {
    if (state.busy) return;
    const picked = state.pick.map(no => state.orders.find(o => o.no === no)).filter(Boolean);
    if (!(await ask(`這 ${picked.length} 筆訂單（${Array.from(new Set(picked.map(o => o.name))).join('、')}）裝同一箱，用順豐單號 ${tracking} 寄出？`, '合併寄出'))) return;
    state.busy = true;
    try {
      await adminCall('shipMany', { nos: state.pick, tracking });
      state.pick = [];
      render();
      toast(`已合併寄出 ${picked.length} 筆`);
    } catch (e) {
      if (state.auth) toast(e.message);
    } finally {
      state.busy = false;
    }
  }

  const refundProofText = o => o.refundDate ? `<small>（${pretty(o.refundDate)} 轉出，後五碼 ${esc(o.refundLast5)}）</small>` : '';

  function mergeHint(o) {
    const n = state.orders.filter(x => x !== o && x.status === '已付款' && sameCustomer(x, o)).length;
    return n ? `<p class="adm-merge-hint">同一位客人還有 ${n} 筆待出貨，（姓名、電話、地址都一樣），可以勾選訂單編號合併出貨</p>` : '';
  }

  function cardHTML(o, pickMode) {
    const left = o.startDate ? dayDiff(today(), o.startDate) : null;
    const urgent = o.status === '已付款' && left !== null && left <= 3;
    const remitOk = o.remit && o.remit.amount === o.total;
    const remitWaiting = o.status === '待付款' && o.remit && !o.payNote; // 待確認收款
    return `<article class="adm-card${urgent ? ' urgent' : ''}" data-no="${esc(o.no)}">
      <div class="adm-card-head">
        ${pickMode ? `<label class="adm-pick"><input type="checkbox" data-pick="${esc(o.no)}" ${state.pick.includes(o.no) ? 'checked' : ''}><span class="mono">${esc(o.no)}</span></label>` : `<span class="mono">${esc(o.no)}</span>`}
        <span class="status-badge${['已付款', '已出貨', '檢查中', '已歸還', '已退押金'].includes(o.status) ? ' ok' : ''}">${esc(o.status)}</span>
      </div>
      ${pickMode ? mergeHint(o) : ''}
      <details class="adm-sec adm-contact" data-contact="${esc(o.no)}"${(o.status === '已付款' ? !state.contactClosed.has(o.no) : state.contactOpen.has(o.no)) ? ' open' : ''}>
        <summary><span>收件資料</span>${o.status === '已付款' ? `<button type="button" class="copy adm-copy-settle" data-copy="${esc([o.name, o.phone, o.address].join('\n'))}" aria-label="複製姓名、電話、地址" title="複製姓名、電話、地址">${COPY_ICON}</button>` : ''}<svg class="adm-chev" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></summary>
        <dl class="adm-info">
          <div><dt>姓名</dt><dd>${esc(o.name)}</dd></div>
          <div><dt>電話</dt><dd>${esc(o.phone)}</dd></div>
          <div><dt>地址</dt><dd>${esc(o.address)}</dd></div>
        </dl>
      </details>
      <div class="adm-sec">
      <h4 class="adm-sec-title">訂單資料</h4>
      <dl class="adm-info">
        <div><dt>租期</dt><dd>${pretty(o.startDate)} ～ ${pretty(o.endDate)}${o.period ? `<em class="slot">${esc(o.period)}</em>` : ''}${o.status === '已付款' && left !== null ? `<em class="${urgent ? 'warn' : ''}">${left > 0 ? `還有 ${left} 天` : left === 0 ? '今天起租' : `已過 ${-left} 天`}</em>` : ''}</dd></div>
        ${o.status === '已付款' && o.startDate ? (sd => `<div><dt>出貨日</dt><dd>${pretty(sd)}${sd < today() ? '<em class="warn">已過出貨日</em>' : sd === today() ? '<em class="warn">今天要寄</em>' : ''}</dd></div>`)(shipDayOf(o)) : ''}
        <div><dt>衣服</dt><dd>${o.items.map(p => esc(itemName(p))).join('<br>')}</dd></div>
        ${o.addons && o.addons.length ? `<div><dt>加租配件</dt><dd class="adm-addons">${o.addons.map(a => `${esc(a.name)} <b>× ${a.qty}</b>${a.deposit ? `（押金 ${money(a.deposit * a.qty)}）` : ''}`).join('<br>')}<small>跟衣服一起寄出，歸還時記得點收</small></dd></div>` : ''}
        <div><dt>金額</dt><dd>${money(o.total)}<small>（租金 ${money(o.rentTotal)}${o.discount ? `－優惠 ${money(o.discount)}` : ''}${o.addonTotal ? `＋加租 ${money(o.addonTotal)}` : ''}＋押金 ${money(o.depositTotal)}${o.shipping ? `＋運費 ${money(o.shipping)}` : ''}${o.rushFee ? `＋加急費 ${money(o.rushFee)}` : ''}）</small></dd></div>
        ${o.coupon ? `<div><dt>優惠碼</dt><dd><span class="mono">${esc(o.coupon)}</span>　折抵 ${money(o.discount)}</dd></div>` : ''}
        ${o.note ? `<div><dt>客戶備註</dt><dd class="pre">${esc(o.note)}</dd></div>` : ''}
        ${o.addon ? `<div><dt>${o.addons && o.addons.length ? '其他加租' : '加租'}</dt><dd class="pre">${esc(o.addon)}</dd></div>` : ''}
        ${o.extras && o.extras.length ? `<div><dt>手動加租</dt><dd class="adm-extras">${o.extras.map((x, i) => `<div>
          ${x.image ? `<a href="${esc(x.image)}" target="_blank" rel="noopener" class="adm-extra-img"><img src="${esc(x.image)}" alt="" referrerpolicy="no-referrer" loading="lazy"></a>` : ''}
          <span>${x.category ? `<b class="adm-extra-cat">${esc(x.category)}</b>` : ''}${esc(x.note)}<small>租金 ${money(x.rent)}・押金 ${money(x.deposit)}</small></span>
          ${o.status === '待付款' ? `<span class="adm-extra-ops"><button type="button" class="link-btn" data-paste-for="${i}">${x.image ? '貼上換圖片' : '貼上圖片'}</button><button type="button" class="link-btn" data-op="removeExtra" data-idx="${i}">刪除</button></span>` : ''}
        </div>`).join('')}</dd></div>` : ''}
        ${o.tracking ? `<div><dt>順豐單號</dt><dd><span class="mono">${esc(o.tracking)}</span> <button type="button" class="copy" data-copy="${esc(o.tracking)}">複製</button></dd></div>` : ''}
        ${o.status === '檢查中' && o.returnedAt ? `<div><dt>收到歸還</dt><dd>${pretty(o.returnedAt)}</dd></div>` : ''}
        ${o.status === '已歸還' || o.status === '已退押金' || (o.status === '待退款' && o.cancelRefund == null) ? `<div><dt>驗收</dt><dd>${o.deduct ? `扣款 ${money(o.deduct)}<small class="pre">${esc(o.deductReason)}</small>` : '衣服完好'}</dd></div>` : ''}
        ${o.extendFee ? `<div><dt>延期加收</dt><dd>${money(o.extendFee)}<small>（從押金扣除）</small></dd></div>` : ''}
        ${o.rushDeposit ? `<div><dt>加急費</dt><dd>${money(o.rushDeposit)}<small>（急件，從押金扣除）</small></dd></div>` : ''}
        ${o.rescheduled ? `<div><dt>改期</dt><dd>已修改過日期<small>${esc(o.rescheduled)}</small>${o.status === '已付款' ? ` <button type="button" class="copy" data-copy="${esc(dateNoticeText(o))}">複製改期通知</button>` : ''}</dd></div>` : ''}
        ${o.refund != null ? `<div><dt>已退押金</dt><dd>${money(o.refund)}${refundProofText(o)}</dd></div>` : ''}
        ${o.cancelRefund != null ? `<div><dt>${o.status === '待退款' ? '應退款' : '已退款'}</dt><dd>${money(o.cancelRefund)}${o.status === '待退款' ? '' : refundProofText(o)}</dd></div>` : ''}
      </dl>
      </div>
      ${o.remit ? remitWaiting ? `<div class="adm-remit ${remitOk ? 'match' : 'mismatch'}">
        <b>客戶匯款回報</b>${remitOk ? '<span>金額相符</span>' : `<span>⚠ 金額不同（應付 ${money(o.total)}）</span>`}
        <p>${esc(o.remit.name)}・${esc(o.remit.bank)}・${pretty(o.remit.date)}<br><b class="mono">${money(o.remit.amount)}</b>　後五碼 <b class="mono">${esc(o.remit.last5)}</b></p>
      </div>` : '' : ''}
      ${actionsHTML(o)}
      ${o.log ? `<details class="adm-log"><summary>操作紀錄</summary><pre>${logHTML(o, remitWaiting)}</pre></details>` : ''}
    </article>`;
  }

  // 依狀態顯示可以做的操作；需要填資料的操作先展開小表單
  // 操作紀錄：在「確認收款」那行（還沒確認就放在最後一次「客戶回報匯款」）加「客戶匯款資訊」，點了用彈出視窗看
  function logHTML(o, remitWaiting) {
    const lines = String(o.log).split('\n');
    let at = -1;
    if (o.remit && !remitWaiting) {
      const last = re => { for (let i = lines.length - 1; i >= 0; i--) if (re.test(lines[i])) return i; return -1; };
      at = last(/確認收款/);
      if (at < 0) at = last(/客戶回報匯款/);
      if (at < 0) at = lines.length - 1;
    }
    return lines.map((l, i) => esc(l) + (i === at ? ` <button type="button" class="link-btn adm-remit-link" data-remit="${esc(o.no)}">客戶匯款資訊</button>` : '')).join('\n');
  }

  function showRemit(o) {
    const r = o.remit;
    const box = document.createElement('div');
    box.className = 'adm-ask';
    box.innerHTML = `<div class="adm-ask-card">
      <h3 class="adm-pop-title">客戶匯款資訊</h3>
      <p class="adm-pop-sub mono">${esc(o.no)}</p>
      <dl class="adm-info">
        <div><dt>匯款戶名</dt><dd>${esc(r.name)}</dd></div>
        <div><dt>匯款銀行</dt><dd>${esc(r.bank)}</dd></div>
        <div><dt>匯款日期</dt><dd>${pretty(r.date)}</dd></div>
        <div><dt>匯款金額</dt><dd><b class="mono">${money(r.amount)}</b>${r.amount === o.total ? '<small>（金額相符）</small>' : `<small class="warn">（應付 ${money(o.total)}）</small>`}</dd></div>
        <div><dt>後五碼</dt><dd><b class="mono">${esc(r.last5)}</b></dd></div>
        ${o.payNote ? `<div><dt>查帳回覆</dt><dd>${esc(o.payNote)}</dd></div>` : ''}
      </dl>
      <div class="foot-row"><button type="button" class="btn primary" data-ask="no">關閉</button></div>
    </div>`;
    box.addEventListener('click', e => { if (e.target.closest('[data-ask]') || e.target === box) box.remove(); });
    document.body.appendChild(box);
  }
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-remit]');
    if (!b) return;
    const o = state.orders.find(x => x.no === b.dataset.remit);
    if (o && o.remit) showRemit(o);
  });

  function actionsHTML(o) {
    const open = state.open[o.no];
    const btn = (op, label, cls) => `<button type="button" class="btn ${cls || ''}" data-op="${op}">${label}</button>`;
    const form = (op, inner, submitLabel) => `<form class="form adm-form" data-submit="${op}">${inner}
      <div class="foot-row"><button type="button" class="btn" data-op="close">取消</button><button type="submit" class="btn primary">${submitLabel}</button></div></form>`;
    switch (o.status) {
      case '待付款':
        if (open === 'reject') return form('rejectPay', `<label>要告訴客戶的話（客戶查詢時看得到）<textarea name="message" rows="2" maxlength="200" required>還沒看到這筆款項入帳，請確認匯款帳號和金額，或私訊我們。</textarea></label>`, '送出查帳結果');
        if (open === 'cancel') return cancelForm(form);
        if (open === 'rush') return form('rush', `
          <label>急件起日（原本 ${pretty(o.startDate)}）<input name="startDate" type="date" required min="${addDays(today(), 2)}" max="${addDays(rushBefore(), -1)}"></label>
          <p class="hint adm-rush">${dateText(o, '', true)}</p>
          <p class="hint">急件＝客人在網站選不到的日期（早於 ${pretty(rushBefore())}），最早後天。客戶先問過客服、你們評估可以再改；每筆只能用一次急件。系統會檢查前後訂單和停運日。</p>`, '改成急件');
        if (open === 'extra') return form('addExtra', `
          ${state.extraMenu.length ? `<label>加租類別<select name="category" required><option value="">請選擇</option>${state.extraMenu.map(c => `<option>${esc(c)}</option>`).join('')}</select></label>` : ''}
          <label>加租說明（選填，客戶查詢時看得到）<input name="note" maxlength="100" placeholder="例如：露可咪白色雙層"></label>
          <div class="form-row">
            <label>租金（選填）<input name="rent" inputmode="numeric" placeholder="0"></label>
            <label>押金（選填）<input name="deposit" inputmode="numeric" placeholder="0"></label>
          </div>
          <div class="adm-paste">
            <span class="adm-paste-label">圖片（選填）</span>
            <div class="adm-paste-zone" contenteditable="true" data-paste-zone aria-label="貼上圖片的地方"></div>
            <button type="button" class="btn" data-paste-btn>貼上剪貼簿的圖片</button>
            <small>先在相簿或 LINE 複製圖片，再按上面的按鈕；或點虛線框，電腦按 ⌘V、手機長按選「貼上」</small>
          </div>
          <div class="adm-extra-preview" hidden></div>
          <p class="hint">加入後，應付總額會加上租金和押金。可以加好幾項，一次加一項。</p>`, '加入');
        return `<div class="adm-actions">
          ${o.remit && !o.payNote ? btn('confirmPay', '✓ 確認收款', 'primary') + btn('reject', '查無款項') : `<button type="button" class="btn primary" data-copy="${esc(payNoticeText(o, state.bank))}">${COPY_ICON} 付款通知</button>` + btn('extra', '＋ 加租項目') + (o.period || o.rushed ? '' : btn('rush', '急件'))}
          ${btn('cancel', '取消訂單', 'ghost')}
        </div>`;
      case '已付款':
        if (open === 'cancel') return paidCancelForm(o, form);
        if (open === 'reschedule') return form('reschedule', `
          <label>新的起日（原本 ${pretty(o.startDate)}）<input name="startDate" type="date" required min="${addDays(today(), 2)}" max="${addDays(today(), state.maxAhead)}"></label>
          <p class="hint adm-rush">${dateText(o, '', false)}</p>
          <p class="hint">每筆只能修改一次日期。新起日早於 ${pretty(rushBefore())}（最早後天）算急件，加急費從押金扣；其他日期不加收。系統會檢查前後訂單和停運日。</p>`, '修改日期');
        return form('ship', `<label>順豐單號<input name="tracking" required autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="寄出後填寫，例如 SF1234567890"></label>`, '已寄出')
          .replace('<button type="button" class="btn" data-op="close">取消</button>', (o.period || o.rescheduled ? '' : btn('reschedule', '修改日期', 'ghost')) + btn('cancel', '取消訂單', 'ghost'));
      case '已出貨':
        if (open === 'retrack') return form('ship', `<label>修改順豐單號<input name="tracking" required value="${esc(o.tracking)}" autocapitalize="characters" autocomplete="off" spellcheck="false"></label>`, '儲存單號');
        if (open === 'cancel') return paidCancelForm(o, form);
        if (open === 'extend') return form('extend', `
          <label>新的歸還日（原本 ${pretty(o.endDate)}）<input name="newEnd" type="date" required min="${addDays(o.endDate, 1)}" value="${addDays(o.endDate, 1)}"></label>
          <p class="hint adm-ext">${extText(o, o.endDate, addDays(o.endDate, 1))}</p>
          <p class="hint">系統會檢查這件衣服延後之後，會不會影響下一位客戶的檔期。</p>`, '延後歸還日');
        return `<div class="adm-actions">${btn('received', '收到歸還', 'primary')}${btn('extend', '延後歸還日')}${btn('retrack', '修改單號', 'ghost')}${btn('cancel', '取消並退款', 'ghost')}</div>`;
      case '檢查中': {
        const late = o.returnedAt ? daysBetween(o.endDate, o.returnedAt) : 0;
        return form('inspect', `
          <p class="hint">租借迄日 ${pretty(o.endDate)}${o.returnedAt ? `，${pretty(o.returnedAt)} 收到${late > 0 ? `<b class="warn">（晚 ${late} 天，含寄送時間）</b>` : ''}` : ''}</p>
          <fieldset class="adm-choice">
            <label class="check"><input type="checkbox" name="late" data-deduct-box="late"> 延遲歸還，要扣延遲費</label>
            <div class="adm-deduct" data-box="late" hidden>
              <label>延遲天數<input name="lateDays" type="number" inputmode="numeric" min="1" max="60" step="1" value="${late > 0 ? late : ''}" placeholder="例如 2"></label>
              <p class="hint adm-late">延遲費＝總租金 ${money(rentBase(o))} × 10% × 天數${late > 0 ? `＝<b>${money(lateFeeOf(o, late))}</b>` : ''}</p>
            </div>
            <label class="check"><input type="checkbox" name="repair" data-deduct-box="repair"> 有損壞或污漬，要扣維修／清潔費</label>
            <div class="adm-deduct" data-box="repair" hidden>
              <label>維修費<input name="repairFee" inputmode="numeric" placeholder="例如 500"></label>
              <label>原因（客戶查詢時看得到）<textarea name="reason" rows="2" maxlength="200" placeholder="例如：裙擺有一處勾紗，需要修補"></textarea></label>
            </div>
          </fieldset>
          <p class="hint adm-calc" data-deposit="${o.depositTotal}" data-extend="${o.extendFee || 0}" data-rush="${o.rushDeposit || 0}" data-rent="${rentBase(o)}">${calcText(o, 0, 0)}</p>`, '檢查完成').replace('<button type="button" class="btn" data-op="close">取消</button>', '');
      }
      case '待退款':
        if (o.cancelRefund != null) return refundAccountHTML(o) + form('refundCancel', `<label>退款金額<input name="amount" inputmode="numeric" required value="${o.cancelRefund}"></label>
          ${refundProofFields()}
          <p class="hint">這筆訂單已取消，客戶付了 ${money(o.paid)}。轉帳完成後再按「已退款」。</p>`, '已退款')
          .replace('<button type="button" class="btn" data-op="close">取消</button>', '');
        // 沒有取消退款金額的＝檢查完成、要退押金
        // falls through
      case '已歸還': {
        const amount = Math.max(0, o.depositTotal - (o.deduct || 0) - depOther(o));
        return refundAccountHTML(o) + form('refund', `<label>退款金額<input name="amount" inputmode="numeric" required value="${amount}"></label>
          ${refundProofFields()}
          <p class="hint">押金 ${money(o.depositTotal)}${o.lateFee || o.repairFee ? `${o.lateFee ? ` − 延遲費${o.lateDays ? `（${o.lateDays} 天）` : ''} ${money(o.lateFee)}` : ''}${o.repairFee ? ` − 維修費 ${money(o.repairFee)}` : ''}` : o.deduct ? ` − 扣款 ${money(o.deduct)}` : ''}${o.extendFee ? ` − 延期加收 ${money(o.extendFee)}` : ''}${o.rushDeposit ? ` − 加急費 ${money(o.rushDeposit)}` : ''} ＝ ${money(amount)}。轉帳完成後再按「已退押金」。</p>
          <p class="adm-copy-row">${copyBtn(settleText(o, refundDetail(o, amount)))}</p>`, '已退押金')
          .replace('<button type="button" class="btn" data-op="close">取消</button>', '');
      }
      default:
        return '';
    }
  }

  // 已退押金、已退款都要填：轉帳日期＋轉出帳號後五碼（客戶查詢時看得到，方便對帳）
  const refundProofFields = () => `<div class="form-row">
      <label>轉帳日期<input name="date" type="date" required value="${today()}" max="${today()}"></label>
      <label>轉出帳號後五碼<input name="last5" inputmode="numeric" maxlength="5" required placeholder="12345"></label>
    </div>`;

  function refundAccountHTML(o) {
    const ra = o.refundAccount || {};
    return `<div class="adm-refund">
      <b>退款到</b>
      <p>${ra.code ? `<span class="mono">${esc(ra.code)}</span> ` : ''}${esc(ra.bank)}<br><span class="mono">${esc(ra.account)}</span> <button type="button" class="copy" data-copy="${esc(String(ra.account).replace(/\D/g, ''))}">複製帳號</button><br>戶名 ${esc(ra.holder)}</p>
    </div>`;
  }

  // 已付款、已寄出的訂單取消：要記錄退給客戶多少錢，訂單先變「待退款」
  function paidCancelForm(o, form) {
    const shipped = o.status === '已出貨';
    return refundAccountHTML(o) + form('cancel', `
      <label>要退還給客戶的金額<input name="refund" inputmode="numeric" required value="${o.paid}"></label>
      <label>取消原因（選填，只有你們看得到）<input name="reason" maxlength="200" placeholder="${shipped ? '例如：順豐包裹遺失' : '例如：客戶臨時取消'}"></label>
      <p class="hint">客戶已付 ${money(o.paid)}。取消後檔期會立刻釋出，訂單移到「待退款」分頁，轉帳退款後再按「已退款」。</p>
      ${shipped ? '<p class="hint adm-note">⚠ 如果衣服遺失了，記得到試算表「商品」分頁把這件的數量減 1，或取消勾選上架，免得又被預約。</p>' : ''}`, '取消訂單');
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
      try {
        await adminCall(op, Object.assign({ no }, data));
      } catch (e) {
        // 延後歸還日撞到其他檔期：先讓你確認，確定的話再送一次
        const rush = op === 'rush' || op === 'reschedule';
        if (!e.conflict || !(await ask(e.message + (rush ? '\n\n仍然要改日期嗎？（請先確認衣服來得及）' : '\n\n仍然要延後嗎？（請先跟下一位客戶協調）'), rush ? '仍然改日期' : '仍然延後'))) throw e;
        await adminCall(op, Object.assign({ no, force: true }, data));
      }
      delete state.open[no];
      render();
      toast(okMsg);
    } catch (e) {
      if (card) card.classList.remove('busy');
      if (state.auth && !e.conflict) toast(e.message);
    } finally {
      state.busy = false;
    }
  }

  // 日期欄：點欄位任何地方就打開日曆，不用剛好點到日曆圖示
  document.addEventListener('click', e => {
    const d = e.target.closest('input[type="date"]');
    if (d && !d.disabled && d.showPicker) { try { d.showPicker(); } catch (err) { /* 有些瀏覽器不支援，維持原本行為 */ } }
  });

  // ───────── 事件 ─────────
  document.addEventListener('submit', async e => {
    const f = e.target;
    e.preventDefault();
    if (f.id === 'login-form') { login(f); return; }
    const no = f.closest('.adm-card') && f.closest('.adm-card').dataset.no;
    const fd = new FormData(f);
    const v = k => String(fd.get(k) || '').trim();
    switch (f.dataset.submit) {
      case 'addExtra': {
        const amt = k => Number(v(k).replace(/[^\d]/g, '')) || 0;
        if (state.extraMenu.length && !v('category')) { toast('請選加租類別'); return; }
        if (!state.extraMenu.length && !v('note')) { toast('請寫加租說明'); return; }
        const file = f._pasted || (f.image && f.image.files[0]);
        let image = '';
        if (file) {
          try { image = await shrinkImage(file); } catch (err) { toast(err.message); return; }
        }
        runOp(no, 'addExtra', { category: v('category'), note: v('note'), rent: amt('rent'), deposit: amt('deposit'), image }, '已加入加租項目');
        break;
      }
      case 'rejectPay': runOp(no, 'rejectPay', { message: v('message') }, '已回覆查帳結果'); break;
      case 'shipMany': {
        const tracking = v('tracking').replace(/\s/g, '').toUpperCase();
        if (!/^[0-9A-Z]{8,20}$/.test(tracking)) { toast('順豐單號格式不對，請再確認一次'); return; }
        shipMany(tracking);
        break;
      }
      case 'ship': runOp(no, 'ship', { tracking: v('tracking').replace(/\s/g, '') }, '已更新順豐單號'); break;
      case 'inspect': {
        const fee = k => Number(v(k).replace(/[^\d]/g, ''));
        const lateDays = fd.get('late') ? fee('lateDays') : 0;
        const repairFee = fd.get('repair') ? fee('repairFee') : 0;
        if (fd.get('late') && !(lateDays > 0)) { toast('請填延遲天數'); return; }
        if (fd.get('repair') && !(repairFee > 0)) { toast('請填維修費'); return; }
        if (fd.get('repair') && !v('reason')) { toast('請寫維修費的原因，客戶查詢時會看到'); return; }
        runOp(no, 'inspect', { lateDays, repairFee, reason: fd.get('repair') ? v('reason') : '' }, '檢查完成，接著退押金');
        break;
      }
      case 'refund': {
        const amount = Number(v('amount').replace(/[^\d]/g, ''));
        const proof = { date: v('date'), last5: v('last5').replace(/\D/g, '') };
        if (proof.last5.length !== 5) { toast('轉出帳號後五碼請輸入 5 位數字'); return; }
        if (!(await ask(`確定已經在 ${pretty(proof.date)} 轉帳退押金 ${money(amount)} 嗎？`, '已轉帳'))) return;
        runOp(no, 'refund', Object.assign({ amount }, proof), '已完成這筆訂單 ✦');
        break;
      }
      case 'cancel': {
        const refund = f.refund ? Number(v('refund').replace(/[^\d]/g, '')) : undefined;
        if (!(await ask(refund != null ? `確定要取消這筆訂單、之後退還 ${money(refund)} 嗎？` : '確定要取消這筆訂單嗎？', '取消訂單'))) return;
        runOp(no, 'cancel', { reason: v('reason'), refund }, refund != null ? '已取消，記得轉帳退款' : '已取消訂單');
        break;
      }
      case 'refundCancel': {
        const amount = Number(v('amount').replace(/[^\d]/g, ''));
        const proof = { date: v('date'), last5: v('last5').replace(/\D/g, '') };
        if (proof.last5.length !== 5) { toast('轉出帳號後五碼請輸入 5 位數字'); return; }
        if (!(await ask(`確定已經在 ${pretty(proof.date)} 轉帳退款 ${money(amount)} 嗎？`, '已轉帳'))) return;
        runOp(no, 'refundCancel', Object.assign({ amount }, proof), '已完成退款');
        break;
      }
      case 'extend':
        runOp(no, 'extend', { newEnd: v('newEnd') }, '已延後歸還日');
        break;
      case 'rush':
      case 'reschedule':
        if (!v('startDate')) { toast('請選新的起日'); return; }
        if (v('startDate') === (state.orders.find(x => x.no === no) || {}).startDate) { toast('新的起日不能跟原本一樣'); return; }
        runOp(no, f.dataset.submit, { startDate: v('startDate') }, f.dataset.submit === 'rush' ? '已改成急件' : '已修改日期');
        break;
    }
  });

  document.addEventListener('click', async e => {
    if (e.target.closest('.adm-ask')) return;
    const t = e.target.closest('[data-act],[data-tab],[data-op],[data-copy]');
    if (!t) return;
    if (t.dataset.copy != null) { e.preventDefault(); copy(t.dataset.copy); return; }
    if (t.dataset.act === 'refresh') { refresh(); toast('已重新整理'); return; }
    if (t.dataset.act === 'logout') { if (await ask('確定要登出嗎？', '登出')) logout(); return; }
    if (t.dataset.act === 'unpick') { state.pick = []; render(); return; }
    if (t.dataset.tab) { state.tab = t.dataset.tab; state.pick = []; render(); window.scrollTo(0, 0); return; }
    const no = t.closest('.adm-card') && t.closest('.adm-card').dataset.no;
    const op = t.dataset.op;
    if (op === 'confirmPay') {
      if (await ask('已經在銀行確認這筆款項入帳了嗎？', '確認收款')) runOp(no, 'confirmPay', {}, '已確認收款');
      return;
    }
    if (op === 'removeExtra') {
      const o = state.orders.find(x => x.no === no);
      const x = o && o.extras[Number(t.dataset.idx)];
      if (x && await ask(`刪除手動加租「${[x.category, x.note].filter(Boolean).join('・')}」？應付總額會扣掉租金 ${money(x.rent)}、押金 ${money(x.deposit)}。`, '刪除')) {
        runOp(no, 'removeExtra', { index: Number(t.dataset.idx) }, '已刪除加租項目');
      }
      return;
    }
    if (op === 'received') {
      if (await ask('確定已經收到客戶寄回的衣服了嗎？', '已收到')) runOp(no, 'received', {}, '已收到歸還，請檢查衣服');
      return;
    }
    if (op === 'close') delete state.open[no];
    else state.open[no] = op;
    render();
  });

  // 記下哪個表單動過，切回 App 時不要自動重新整理
  ['input', 'change'].forEach(t => document.addEventListener(t, e => { const f = e.target.closest && e.target.closest('form[data-submit]'); if (f) f.dataset.dirty = '1'; }));
  // 手動加租圖片：先在手機上縮小（最長邊 1200px 的 JPEG）再上傳，省流量也比較快
  async function shrinkImage(file) {
    if (!/^image\//.test(file.type || 'image/')) throw new Error('請選一張圖片');
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('讀不到這張圖片，請換一張')); i.src = url; });
      const k = Math.min(1, 1200 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k);
      c.height = Math.round(img.naturalHeight * k);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.82);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  function showExtraPreview(f, file) {
    const box = f.querySelector('.adm-extra-preview');
    if (!box) return;
    if (box.dataset.url) URL.revokeObjectURL(box.dataset.url);
    if (!file) { box.hidden = true; box.innerHTML = ''; return; }
    box.dataset.url = URL.createObjectURL(file);
    box.innerHTML = `<img src="${box.dataset.url}" alt="">`;
    box.hidden = false;
  }
  // 記住哪幾張卡片的「收件資料」是展開的
  document.addEventListener('toggle', e => {
    const d = e.target;
    if (!d.matches || !d.matches('[data-contact]')) return;
    const no = d.dataset.contact;
    if (d.open) { state.contactOpen.add(no); state.contactClosed.delete(no); } else { state.contactOpen.delete(no); state.contactClosed.add(no); }
  }, true);

  // 從剪貼簿讀一張圖片（要使用者按按鈕才能讀；手機會跳出「貼上」確認）
  async function readClipboardImage() {
    if (!navigator.clipboard || !navigator.clipboard.read) throw new Error('這個瀏覽器不能直接讀剪貼簿，請點虛線框後長按選「貼上」');
    let items;
    try { items = await navigator.clipboard.read(); } catch (err) { throw new Error('沒有取得剪貼簿權限，請點虛線框後長按選「貼上」'); }
    for (const it of items) {
      const type = it.types.find(t => t.startsWith('image/'));
      if (type) return new File([await it.getType(type)], 'paste.' + type.split('/')[1], { type });
    }
    throw new Error('剪貼簿裡沒有圖片，請先複製一張圖片');
  }
  document.addEventListener('click', async e => {
    const pasteBtn = e.target.closest('[data-paste-btn]');
    const pasteFor = e.target.closest('[data-paste-for]');
    if (!pasteBtn && !pasteFor) return;
    e.stopPropagation();
    try {
      const file = await readClipboardImage();
      if (pasteBtn) {
        const f = pasteBtn.closest('form');
        f._pasted = file;
        showExtraPreview(f, file);
        toast('已貼上圖片');
      } else {
        const no = pasteFor.closest('.adm-card').dataset.no;
        runOp(no, 'setExtraImage', { index: Number(pasteFor.dataset.pasteFor), image: await shrinkImage(file) }, '已更新圖片');
      }
    } catch (err) { toast(err.message); }
  }, true);
  // 虛線框只收圖片，打字的內容清掉
  document.addEventListener('input', e => { if (e.target.matches && e.target.matches('[data-paste-zone]')) e.target.textContent = ''; });

  // 電腦上可以直接貼上圖片（打開「加租項目」表單時，貼在哪裡都可以）
  document.addEventListener('paste', e => {
    const f = document.querySelector('form[data-submit="addExtra"]');
    if (!f) return;
    const item = [...((e.clipboardData && e.clipboardData.items) || [])].find(x => x.type.startsWith('image/'));
    if (!item) {
      if (e.target.matches && e.target.matches('[data-paste-zone]')) { e.preventDefault(); toast('剪貼簿裡沒有圖片，請先複製一張圖片'); }
      return;
    }
    e.preventDefault();
    f._pasted = item.getAsFile();
    if (f.image) f.image.value = '';
    showExtraPreview(f, f._pasted);
    toast('已貼上圖片');
  });

  document.addEventListener('change', async e => {
    if (e.target.name === 'image' && e.target.closest('form[data-submit="addExtra"]')) {
      const f = e.target.closest('form');
      f._pasted = null;
      showExtraPreview(f, e.target.files[0]);
      return;
    }
    if (e.target.dataset.extraImg != null) {
      const file = e.target.files[0];
      const no = e.target.closest('.adm-card').dataset.no;
      if (!file) return;
      try {
        const image = await shrinkImage(file);
        runOp(no, 'setExtraImage', { index: Number(e.target.dataset.extraImg), image }, '已更新圖片');
      } catch (err) { toast(err.message); }
      return;
    }
    if (e.target.dataset.pick) {
      const no = e.target.dataset.pick;
      state.pick = e.target.checked ? state.pick.concat(no) : state.pick.filter(x => x !== no);
      renderShipBar();
      return;
    }
    if (e.target.dataset.deductBox) {
      const f = e.target.closest('form');
      f.querySelector(`[data-box="${e.target.dataset.deductBox}"]`).hidden = !e.target.checked;
      updateCalc(f);
    }
  });
  // 檢查表單：邊填邊算預計退多少押金
  function updateCalc(f) {
    const calc = f.querySelector('.adm-calc');
    if (!calc) return;
    const fee = (box, k) => f[box].checked ? Number(String(f[k].value).replace(/[^\d]/g, '')) || 0 : 0;
    const o = { depositTotal: Number(calc.dataset.deposit), extendFee: Number(calc.dataset.extend), rushDeposit: Number(calc.dataset.rush || 0), rentTotal: Number(calc.dataset.rent) };
    const days = fee('late', 'lateDays');
    const lateFee = lateFeeOf(o, days);
    const note = f.querySelector('.adm-late');
    if (note) note.innerHTML = `延遲費＝總租金 ${money(o.rentTotal)} × 10% × 天數${days ? `＝<b>${money(lateFee)}</b>` : ''}`;
    calc.innerHTML = calcText(o, lateFee, fee('repair', 'repairFee'), days, f.repair.checked ? f.reason.value.trim() : '');
  }
  document.addEventListener('input', e => {
    const f = e.target.name === 'newEnd' && e.target.closest('form[data-submit="extend"]');
    if (!f) return;
    const o = state.orders.find(x => x.no === f.closest('.adm-card').dataset.no);
    if (o) f.querySelector('.adm-ext').innerHTML = extText(o, o.endDate, e.target.value);
  });
  document.addEventListener('input', e => {
    const f = e.target.name === 'startDate' && e.target.closest('form[data-submit="rush"],form[data-submit="reschedule"]');
    if (!f) return;
    const o = state.orders.find(x => x.no === f.closest('.adm-card').dataset.no);
    if (!o) return;
    f.querySelector('.adm-rush').innerHTML = dateText(o, e.target.value, f.dataset.submit === 'rush');
    // 選到原本的起日：先不能送出
    f.querySelector('button[type="submit"]').disabled = e.target.value === o.startDate;
  });
  document.addEventListener('input', e => { if (['lateDays', 'repairFee', 'reason'].includes(e.target.name) && e.target.closest('form[data-submit="inspect"]')) updateCalc(e.target.closest('form')); });

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
    // 有表單填到一半（例如切去 LINE 傳結算給客戶再回來）就不重新整理，免得填的內容被清掉
    if (!document.hidden && state.auth && !state.busy && !Object.keys(state.open).length && !document.querySelector('form[data-dirty]')) refresh();
  });

  // 自己畫的確認視窗：有些瀏覽器（App 內建瀏覽器、預覽視窗）會直接擋掉系統的 confirm()，按了會沒反應
  function ask(message, okLabel) {
    return new Promise(resolve => {
      const box = document.createElement('div');
      box.className = 'adm-ask';
      box.innerHTML = `<div class="adm-ask-card" role="alertdialog" aria-modal="true">
        <p>${esc(message).replace(/\n/g, '<br>')}</p>
        <div class="foot-row"><button type="button" class="btn" data-ask="no">返回</button><button type="button" class="btn primary" data-ask="yes">${esc(okLabel || '確定')}</button></div>
      </div>`;
      const done = ok => { box.remove(); resolve(ok); };
      box.addEventListener('click', e => {
        const b = e.target.closest('[data-ask]');
        if (b) done(b.dataset.ask === 'yes');
        else if (e.target === box) done(false);
      });
      document.body.appendChild(box);
      box.querySelector('[data-ask="yes"]').focus();
    });
  }

  // 瀏覽器不讓程式複製時，顯示文字讓人自己長按複製
  function showCopy(text) {
    const box = document.createElement('div');
    box.className = 'adm-ask';
    box.innerHTML = `<div class="adm-ask-card"><p>請長按下面的文字複製：</p>${/\n/.test(text) ? `<textarea readonly rows="7">${esc(text)}</textarea>` : `<input readonly value="${esc(text)}">`}<div class="foot-row"><button type="button" class="btn primary" data-ask="no">好</button></div></div>`;
    box.addEventListener('click', e => { if (e.target.closest('[data-ask]') || e.target === box) box.remove(); });
    document.body.appendChild(box);
    box.querySelector('input, textarea').select();
  }

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove('show'), 2200);
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('已複製'); }
    catch (e) { showCopy(text); }
  }

  // ───────── 示範模式（還沒設定 API_URL 時使用）─────────
  const demo = (() => {
    const t = today();
    const no = (d, code) => 'SG' + addDays(t, d).slice(5).replace('-', '') + '-' + code;
    const base = { shipping: 0, addon: '', note: '', internal: '', payNote: '', tracking: '', deduct: 0, deductReason: '', refund: null, extendFee: 0, cancelRefund: null };
    const item = (id, name, size) => ({ id, brand: '多霏', name, size, rent: 600, deposit: 10000 });
    const acct = { code: '013', bank: '國泰世華', account: '0123-4567-8901', holder: '林小華' };
    const list = [
      Object.assign({}, base, { no: no(0, 'H8KD'), status: '待付款', createdAt: t + ' 10:12', name: '林小華', phone: '0987654321', address: '台北市大安區復興南路一段 100 號', startDate: addDays(t, 6), endDate: addDays(t, 11), items: [item('SG002', '粉漾微光', '90')], addons: [{ id: 'AD001', name: '珍珠髮帶', qty: 2, price: 150, deposit: 150 }], addonTotal: 300, rentTotal: 600, depositTotal: 10300, total: 11200, remit: { name: '林小華', bank: '國泰世華', date: t, amount: 11200, last5: '55123' }, refundAccount: acct, log: '' }),
      Object.assign({}, base, { no: no(0, 'P2WQ'), status: '待付款', createdAt: t + ' 09:40', name: '張美玲', phone: '0922333444', address: '順豐 台中文心站', startDate: addDays(t, 9), endDate: addDays(t, 14), items: [item('SG004', '我的羅曼史', '80'), item('SG003', '粉漾微光', '100')], rentTotal: 1200, coupon: 'WELCOME100', discount: 100, depositTotal: 20000, total: 21100, remit: { name: '張美玲', bank: '中國信託', date: t, amount: 20000, last5: '77001' }, note: '想加租珍珠髮箍', refundAccount: acct, log: '' }),
      Object.assign({}, base, { no: no(-1, 'Z7MN'), status: '待付款', createdAt: addDays(t, -1) + ' 21:05', name: '王大明', phone: '0911222333', address: '新北市板橋區文化路一段 1 號', startDate: addDays(t, 12), endDate: addDays(t, 17), items: [item('SG006', '我的羅曼史', '110')], rentTotal: 600, depositTotal: 10000, total: 10600, remit: null, refundAccount: acct, log: '' }),
      Object.assign({}, base, { no: no(-2, 'Q8RP'), status: '已付款', period: '2027 過年檔（示範）', createdAt: addDays(t, -2) + ' 18:30', name: '黃欣怡', phone: '0933222111', address: '台中市西屯區台灣大道三段 99 號', startDate: addDays(t, 4), endDate: addDays(t, 9), items: [item('SG003', '粉漾微光', '100')], rentTotal: 600, depositTotal: 10000, total: 10600, remit: { name: '黃欣怡', bank: '台新', date: addDays(t, -1), amount: 10600, last5: '44556' }, refundAccount: acct, log: '' }),
      Object.assign({}, base, { no: no(-2, 'T6YU'), status: '已付款', createdAt: addDays(t, -2) + ' 20:05', name: '陳小美', phone: '0912345678', address: '高雄市左營區博愛二路 2 號', startDate: addDays(t, 2), endDate: addDays(t, 7), items: [item('SG002', '粉漾微光', '90')], rentTotal: 600, depositTotal: 10000, total: 10600, remit: { name: '陳小美', bank: '中國信託', date: addDays(t, -1), amount: 10600, last5: '13580' }, refundAccount: acct, log: '' }),
      Object.assign({}, base, { no: no(-3, 'M3XA'), status: '已付款', createdAt: addDays(t, -3) + ' 14:20', name: '陳小美', phone: '0912345678', address: '高雄市左營區博愛二路 2 號', startDate: addDays(t, 2), endDate: addDays(t, 7), items: [item('SG005', '我的羅曼史', '90')], rentTotal: 600, depositTotal: 10000, total: 10750, addon: '珍珠髮箍 ×1（加租 NT$ 150）', remit: { name: '陳小美', bank: '中國信託', date: addDays(t, -2), amount: 10750, last5: '13579' }, refundAccount: acct, log: '' }),
      Object.assign({}, base, { no: no(-8, 'R4TE'), status: '已出貨', createdAt: addDays(t, -8) + ' 11:00', name: '李安安', phone: '0933444555', address: '桃園市中壢區中正路 3 號', startDate: addDays(t, -3), endDate: addDays(t, 2), items: [item('SG001', '粉漾微光', '80')], rentTotal: 600, depositTotal: 10000, total: 10600, tracking: 'SF1029384756', remit: { name: '李安安', bank: '台新', date: addDays(t, -7), amount: 10600, last5: '24680' }, refundAccount: acct, log: '' }),
      Object.assign({}, base, { no: no(-15, 'B9CV'), status: '待退款', createdAt: addDays(t, -15) + ' 16:30', name: '周曉雯', phone: '0955666777', address: '台南市東區大學路 1 號', startDate: addDays(t, -10), endDate: addDays(t, -5), items: [item('SG004', '我的羅曼史', '80')], rentTotal: 600, depositTotal: 10000, total: 10600, tracking: 'SF5647382910', deduct: 620, lateDays: 2, lateFee: 120, repairFee: 500, deductReason: '延遲歸還 2 天 NT$ 120（總租金 NT$ 600 × 10% × 2 天）\n維修／清潔 NT$ 500：裙擺一處勾紗，需要修補', remit: { name: '周曉雯', bank: '玉山', date: addDays(t, -14), amount: 10600, last5: '11223' }, refundAccount: { code: '808', bank: '玉山銀行', account: '0987-6543-2100', holder: '周曉雯' }, log: '' }),
      Object.assign({}, base, { no: no(-12, 'K5WS'), status: '檢查中', createdAt: addDays(t, -12) + ' 19:10', name: '吳佳佳', phone: '0966777888', address: '新竹市東區光復路 2 號', startDate: addDays(t, -8), endDate: addDays(t, -3), returnedAt: addDays(t, -1), items: [item('SG006', '我的羅曼史', '110')], rentTotal: 600, depositTotal: 10000, total: 10600, tracking: 'SF2233445566', remit: { name: '吳佳佳', bank: '富邦', date: addDays(t, -11), amount: 10600, last5: '99881' }, refundAccount: { code: '012', bank: '台北富邦', account: '1111-2222-3333', holder: '吳佳佳' }, log: '' }),
    ];
    // 示範用的操作紀錄：依訂單走到哪個階段，補上當時會留下的紀錄
    const md = (d, hm) => addDays(t, d).slice(5).replace('-', '/') + ' ' + hm;
    const ago = o => Math.round((Date.parse(t) - Date.parse(o.createdAt.slice(0, 10))) / 864e5);
    const steps = ['待付款', '已付款', '已出貨', '檢查中', '待退款', '已退押金'];
    list.forEach(o => {
      if (o.log) return;
      const d0 = -ago(o), at = steps.indexOf(o.status), L = [`${o.createdAt.slice(5).replace('-', '/')} 客戶下單`];
      if (o.remit) L.push(`${md(d0, '23:10')} 客戶回報匯款`);
      if (at >= 1) L.push(`${md(d0 + 1, '10:05')} 示範管理員：確認收款`);
      if (at >= 2 && o.tracking) L.push(`${md(d0 + 2, '14:30')} 示範管理員：已寄出，順豐單號 ${o.tracking}`);
      if (at >= 3) L.push(`${o.returnedAt ? o.returnedAt.slice(5).replace('-', '/') + ' 18:00' : md(-3, '18:00')} 示範管理員：收到歸還，檢查中`);
      if (at >= 4) L.push(`${md(-1, '11:20')} 示範管理員：檢查完成，` + (o.deduct ? `扣款 ${o.deduct}（${String(o.deductReason).replace(/\n/g, '；')}）` : '衣服完好'));
      o.log = L.join('\n');
    });
    return list;
  })();

  function demoApi(req) {
    if (req.op === 'shipMany') {
      const list = req.nos.map(n => demo.find(x => x.no === n));
      if (list.length < 2 || list.some(x => !x || x.status !== '已付款')) return { ok: false, error: '合併出貨請選兩筆以上「已付款」的訂單。' };
      list.forEach(x => {
        x.status = '已出貨'; x.tracking = req.tracking;
        x.log = (x.log ? x.log + '\n' : '') + `示範管理員：已寄出（跟 ${list.filter(y => y !== x).map(y => y.no).join('、')} 合併出貨），順豐單號 ${req.tracking}`;
      });
      return { ok: true, name: '示範管理員', orders: demo };
    }
    if (req.action === 'adminLogin') return req.password === 'demo1234' ? { ok: true, token: 'demo', name: '示範管理員' } : { ok: false, error: '密碼不正確。（示範模式的密碼是 demo1234）' };
    const o = demo.find(x => x.no === req.no);
    const name = '示範管理員';
    const now = new Date(Date.now() + 8 * 36e5).toISOString().slice(5, 16).replace('-', '/').replace('T', ' ');
    const log = text => { o.log = (o.log ? o.log + '\n' : '') + `${now} ${name}：${text}`; };
    switch (req.op) {
      case 'setExtraImage': o.extras[req.index].image = req.image; log('更換手動加租圖片：' + o.extras[req.index].note); break;
      case 'addExtra':
        o.extras = (o.extras || []).concat([{ category: req.category || '', note: req.note, rent: req.rent, deposit: req.deposit, image: req.image || '' }]);
        o.addonTotal = (o.addonTotal || 0) + req.rent; o.depositTotal += req.deposit; o.total += req.rent + req.deposit;
        log(`手動加租：${req.note}（租金 ${req.rent}／押金 ${req.deposit}）`);
        break;
      case 'removeExtra': {
        const x = o.extras.splice(req.index, 1)[0];
        o.addonTotal -= x.rent; o.depositTotal -= x.deposit; o.total -= x.rent + x.deposit;
        log('刪除手動加租：' + x.note);
        break;
      }
      case 'confirmPay': o.status = '已付款'; o.payNote = ''; log('確認收款'); break;
      case 'rejectPay': o.payNote = req.message; log('查無款項：' + req.message); break;
      case 'ship':
        if (!/^[0-9A-Z]{8,20}$/i.test(req.tracking)) return { ok: false, error: '順豐單號格式不對，請再確認一次。' };
        log((o.status === '已出貨' ? '修改順豐單號：' : '已寄出，順豐單號 ') + req.tracking.toUpperCase());
        o.status = '已出貨'; o.tracking = req.tracking.toUpperCase();
        break;
      case 'received': o.status = '檢查中'; o.returnedAt = today(); log('收到歸還，檢查中'); break;
      case 'inspect': {
        const lateFee = lateFeeOf(o, req.lateDays);
        const deduct = lateFee + req.repairFee;
        if (deduct + depOther(o) > o.depositTotal) return { ok: false, error: '扣款加上延期加收、加急費不能超過押金。' };
        const parts = [lateFee ? `延遲歸還 ${req.lateDays} 天 ${money(lateFee)}（總租金 ${money(rentBase(o))} × 10% × ${req.lateDays} 天）` : '', req.repairFee ? `維修／清潔 ${money(req.repairFee)}：${req.reason}` : ''].filter(Boolean);
        o.status = '待退款'; o.deduct = deduct; o.lateDays = req.lateDays; o.lateFee = lateFee; o.repairFee = req.repairFee; o.deductReason = parts.join('\n');
        log(deduct ? `檢查完成，扣款 ${deduct}（${parts.join('；')}）` : '檢查完成，衣服完好');
        break;
      }
      case 'refund': o.status = '已退押金'; o.refund = req.amount; o.refundDate = req.date; o.refundLast5 = req.last5; log(`已退押金 ${req.amount}（${req.date} 轉出，後五碼 ${req.last5}）`); break;
      case 'cancel':
        if (o.status === '已付款' || o.status === '已出貨') { o.status = '待退款'; o.cancelRefund = req.refund; log(`取消訂單，待退款 ${req.refund}` + (req.reason ? '：' + req.reason : '')); }
        else { o.status = '已取消'; log('取消訂單' + (req.reason ? '：' + req.reason : '')); }
        break;
      case 'refundCancel': o.status = '已取消'; o.cancelRefund = req.amount; o.refundDate = req.date; o.refundLast5 = req.last5; log(`已退款 ${req.amount}（${req.date} 轉出，後五碼 ${req.last5}）`); break;
      case 'rush':
      case 'reschedule': {
        const unpaid = req.op === 'rush', ns = req.startDate, rb = addDays(today(), 3);
        if (!ns || ns < addDays(today(), 2)) return { ok: false, error: '起日最早只能選後天。' };
        if (unpaid && o.rushed) return { ok: false, error: '這筆訂單已經用過急件了，每筆只能一次。' };
        if (!unpaid && o.rescheduled) return { ok: false, error: '這筆訂單已經修改過一次日期了，不能再改。' };
        if (unpaid && ns >= rb) return { ok: false, error: `${ns} 客人在網站上就能選，不用改成急件；請客人取消後自己重新下單。` };
        const rush = ns < rb;
        if (rush && o.rushed) return { ok: false, error: '這筆訂單已經用過急件了（每筆只能一次）。' };
        const span = dayDiff(o.startDate, o.endDate), oldS = o.startDate, oldE = o.endDate;
        o.startDate = ns; o.endDate = addDays(ns, span);
        const fee = rush ? 300 : 0;
        const how = !fee ? '不是急件，不加收' : unpaid ? `急件，加急費 NT$ ${fee} 加在應付總額` : `急件，加急費 NT$ ${fee} 從押金扣`;
        const rec = `${oldS}～${oldE} → ${o.startDate}～${o.endDate}（${how}）`;
        if (rush) o.rushed = rec;
        if (!unpaid) o.rescheduled = rec;
        if (fee && unpaid) { o.rushFee = fee; o.total += fee; }
        if (fee && !unpaid) o.rushDeposit = fee;
        log(`修改日期：${oldS} ～ ${oldE} → ${o.startDate} ～ ${o.endDate}（${how}${fee && !unpaid ? '除' : ''}）`);
        break;
      }
      case 'extend': {
        if (!req.newEnd || req.newEnd <= o.endDate) return { ok: false, error: `新的歸還日要晚於原本的 ${o.endDate}。` };
        // 示範：延超過 5 天就假裝撞到下一位客戶
        if (!req.force && dayDiff(o.endDate, req.newEnd) > 5) return { ok: false, conflict: true, error: `延到 ${req.newEnd} 會跟其他檔期衝突：\nSG1101-DEMO 王小姐（${addDays(req.newEnd, 2)} 起租）\n（衣服歸還後要空 3 天才能再出租）` };
        const extDays = dayDiff(o.endDate, req.newEnd), extFee = lateFeeOf(o, extDays);
        o.extendFee = (o.extendFee || 0) + extFee;
        log(`延後歸還日 ${o.endDate} → ${req.newEnd}（${extDays} 天）` + (extFee ? `，加收 ${extFee}（總租金 × 10% × ${extDays} 天，從押金扣除）` : ''));
        o.endDate = req.newEnd;
        break;
      }
    }
    demo.forEach(x => { x.paid = x.remit ? x.remit.amount : x.total; });
    return { ok: true, name, orders: demo, extraMenu: ['髮帶', '髮圈', '頭紗', '鞋子'], shipLeadDays: 2, minLeadDays: 3, maxAheadDays: 90, rushFee: 300, bank: { bankName: '國泰世華', bankCode: '013', account: '0123-4567-8901', holder: '蒔光衣櫥' } };
  }

  // ───────── 啟動 ─────────
  if (DEMO) $('#demo-banner').hidden = false;
  if (state.auth) refresh(true);
  else renderLogin();
})();
