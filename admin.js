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

  const refundProofText = o => o.refundDate ? `<small>（${pretty(o.refundDate)} 轉出，後五碼 ${esc(o.refundLast5)}）</small>` : '';

  function cardHTML(o) {
    const left = o.startDate ? dayDiff(today(), o.startDate) : null;
    const urgent = o.status === '已付款' && left !== null && left <= 3;
    const remitOk = o.remit && o.remit.amount === o.total;
    return `<article class="adm-card${urgent ? ' urgent' : ''}" data-no="${esc(o.no)}">
      <div class="adm-card-head">
        <span class="mono">${esc(o.no)}</span>
        <span class="status-badge${['已付款', '已出貨', '檢查中', '已歸還', '已退押金'].includes(o.status) ? ' ok' : ''}">${esc(o.status)}</span>
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
        ${o.status === '檢查中' && o.returnedAt ? `<div><dt>收到歸還</dt><dd>${pretty(o.returnedAt)}</dd></div>` : ''}
        ${o.status === '已歸還' || o.status === '已退押金' || (o.status === '待退款' && o.cancelRefund == null) ? `<div><dt>驗收</dt><dd>${o.deduct ? `扣款 ${money(o.deduct)}：${esc(o.deductReason)}` : '衣服完好'}</dd></div>` : ''}
        ${o.extendFee ? `<div><dt>延期加收</dt><dd>${money(o.extendFee)}<small>（從押金扣除）</small></dd></div>` : ''}
        ${o.refund != null ? `<div><dt>已退押金</dt><dd>${money(o.refund)}${refundProofText(o)}</dd></div>` : ''}
        ${o.cancelRefund != null ? `<div><dt>${o.status === '待退款' ? '應退款' : '已退款'}</dt><dd>${money(o.cancelRefund)}${o.status === '待退款' ? '' : refundProofText(o)}</dd></div>` : ''}
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
        if (open === 'cancel') return paidCancelForm(o, form);
        return form('ship', `<label>順豐單號<input name="tracking" required autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="寄出後填寫，例如 SF1234567890"></label>`, '已寄出')
          .replace('<button type="button" class="btn" data-op="close">取消</button>', btn('cancel', '取消訂單', 'ghost'));
      case '已出貨':
        if (open === 'retrack') return form('ship', `<label>修改順豐單號<input name="tracking" required value="${esc(o.tracking)}" autocapitalize="characters" autocomplete="off" spellcheck="false"></label>`, '儲存單號');
        if (open === 'cancel') return paidCancelForm(o, form);
        if (open === 'extend') return form('extend', `
          <label>新的歸還日（原本 ${pretty(o.endDate)}）<input name="newEnd" type="date" required min="${addDays(o.endDate, 1)}" value="${addDays(o.endDate, 1)}"></label>
          <label>加收金額（選填，會從押金扣除）<input name="fee" inputmode="numeric" placeholder="0"></label>
          <p class="hint">系統會檢查這件衣服延後之後，會不會影響下一位客戶的檔期。</p>`, '延後歸還日');
        return `<div class="adm-actions">${btn('received', '收到歸還', 'primary')}${btn('extend', '延後歸還日')}${btn('retrack', '修改單號', 'ghost')}${btn('cancel', '取消並退款', 'ghost')}</div>`;
      case '檢查中':
        return form('inspect', `
          <fieldset class="adm-choice">
            <label class="check"><input type="radio" name="result" value="ok" checked> 衣服完好，全額退押金</label>
            <label class="check"><input type="radio" name="result" value="deduct"> 有損壞或污漬，要扣款</label>
          </fieldset>
          <div class="adm-deduct" hidden>
            <label>扣款金額<input name="deduct" inputmode="numeric" placeholder="例如 500"></label>
            <label>扣款原因（客戶查詢時看得到）<textarea name="reason" rows="2" maxlength="200" placeholder="例如：裙擺有一處勾紗，需要修補"></textarea></label>
          </div>`, '檢查完成').replace('<button type="button" class="btn" data-op="close">取消</button>', '');
      case '待退款':
        if (o.cancelRefund != null) return refundAccountHTML(o) + form('refundCancel', `<label>退款金額<input name="amount" inputmode="numeric" required value="${o.cancelRefund}"></label>
          ${refundProofFields()}
          <p class="hint">這筆訂單已取消，客戶付了 ${money(o.paid)}。轉帳完成後再按「已退款」。</p>`, '已退款')
          .replace('<button type="button" class="btn" data-op="close">取消</button>', '');
        // 沒有取消退款金額的＝檢查完成、要退押金
        // falls through
      case '已歸還': {
        const amount = Math.max(0, o.depositTotal - (o.deduct || 0) - (o.extendFee || 0));
        return refundAccountHTML(o) + form('refund', `<label>退款金額<input name="amount" inputmode="numeric" required value="${amount}"></label>
          ${refundProofFields()}
          <p class="hint">押金 ${money(o.depositTotal)}${o.deduct ? ` − 扣款 ${money(o.deduct)}` : ''}${o.extendFee ? ` − 延期加收 ${money(o.extendFee)}` : ''} ＝ ${money(amount)}。轉帳完成後再按「已退押金」。</p>`, '已退押金')
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
        if (!e.conflict || !(await ask(e.message + '\n\n仍然要延後嗎？（請先跟下一位客戶協調）', '仍然延後'))) throw e;
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

  // ───────── 事件 ─────────
  document.addEventListener('submit', async e => {
    const f = e.target;
    e.preventDefault();
    if (f.id === 'login-form') { login(f); return; }
    const no = f.closest('.adm-card') && f.closest('.adm-card').dataset.no;
    const fd = new FormData(f);
    const v = k => String(fd.get(k) || '').trim();
    switch (f.dataset.submit) {
      case 'rejectPay': runOp(no, 'rejectPay', { message: v('message') }, '已回覆查帳結果'); break;
      case 'ship': runOp(no, 'ship', { tracking: v('tracking').replace(/\s/g, '') }, '已更新順豐單號'); break;
      case 'inspect': {
        const deduct = v('result') === 'deduct' ? Number(v('deduct').replace(/[^\d]/g, '')) : 0;
        if (v('result') === 'deduct' && !(deduct > 0)) { toast('請填扣款金額'); return; }
        runOp(no, 'inspect', { deduct, reason: v('reason') }, '檢查完成，接著退押金');
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
        runOp(no, 'extend', { newEnd: v('newEnd'), fee: Number(v('fee').replace(/[^\d]/g, '')) || 0 }, '已延後歸還日');
        break;
    }
  });

  document.addEventListener('click', async e => {
    if (e.target.closest('.adm-ask')) return;
    const t = e.target.closest('[data-act],[data-tab],[data-op],[data-copy]');
    if (!t) return;
    if (t.dataset.copy != null) { copy(t.dataset.copy); return; }
    if (t.dataset.act === 'refresh') { refresh(); toast('已重新整理'); return; }
    if (t.dataset.act === 'logout') { if (await ask('確定要登出嗎？', '登出')) logout(); return; }
    if (t.dataset.tab) { state.tab = t.dataset.tab; render(); window.scrollTo(0, 0); return; }
    const no = t.closest('.adm-card') && t.closest('.adm-card').dataset.no;
    const op = t.dataset.op;
    if (op === 'confirmPay') {
      if (await ask('已經在銀行確認這筆款項入帳了嗎？', '確認收款')) runOp(no, 'confirmPay', {}, '已確認收款');
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
    box.innerHTML = `<div class="adm-ask-card"><p>請長按下面的文字複製：</p><input readonly value="${esc(text)}"><div class="foot-row"><button type="button" class="btn primary" data-ask="no">好</button></div></div>`;
    box.addEventListener('click', e => { if (e.target.closest('[data-ask]') || e.target === box) box.remove(); });
    document.body.appendChild(box);
    box.querySelector('input').select();
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
    const item = (id, name, size) => ({ id, brand: '多霏', name, size });
    const acct = { code: '013', bank: '國泰世華', account: '0123-4567-8901', holder: '林小華' };
    return [
      Object.assign({}, base, { no: no(0, 'H8KD'), status: '待付款', createdAt: t + ' 10:12', name: '林小華', phone: '0987654321', address: '台北市大安區復興南路一段 100 號', startDate: addDays(t, 6), endDate: addDays(t, 11), items: [item('SG002', '粉漾微光', '90')], rentTotal: 600, depositTotal: 10000, total: 10600, remit: { name: '林小華', bank: '國泰世華', date: t, amount: 10600, last5: '55123' }, refundAccount: acct, log: '' }),
      Object.assign({}, base, { no: no(0, 'P2WQ'), status: '待付款', createdAt: t + ' 09:40', name: '張美玲', phone: '0922333444', address: '順豐 台中文心站', startDate: addDays(t, 9), endDate: addDays(t, 14), items: [item('SG004', '我的羅曼史', '80'), item('SG003', '粉漾微光', '100')], rentTotal: 1200, depositTotal: 20000, total: 21200, remit: { name: '張美玲', bank: '中國信託', date: t, amount: 20000, last5: '77001' }, note: '想加購珍珠髮箍', refundAccount: acct, log: '' }),
      Object.assign({}, base, { no: no(-1, 'Z7MN'), status: '待付款', createdAt: addDays(t, -1) + ' 21:05', name: '王大明', phone: '0911222333', address: '新北市板橋區文化路一段 1 號', startDate: addDays(t, 12), endDate: addDays(t, 17), items: [item('SG006', '我的羅曼史', '110')], rentTotal: 600, depositTotal: 10000, total: 10600, remit: null, refundAccount: acct, log: '' }),
      Object.assign({}, base, { no: no(-3, 'M3XA'), status: '已付款', createdAt: addDays(t, -3) + ' 14:20', name: '陳小美', phone: '0912345678', address: '高雄市左營區博愛二路 2 號', startDate: addDays(t, 2), endDate: addDays(t, 7), items: [item('SG005', '我的羅曼史', '90')], rentTotal: 600, depositTotal: 10000, total: 10750, addon: '珍珠髮箍 ×1（加購 NT$ 150）', remit: { name: '陳小美', bank: '中國信託', date: addDays(t, -2), amount: 10750, last5: '13579' }, refundAccount: acct, log: '' }),
      Object.assign({}, base, { no: no(-8, 'R4TE'), status: '已出貨', createdAt: addDays(t, -8) + ' 11:00', name: '李安安', phone: '0933444555', address: '桃園市中壢區中正路 3 號', startDate: addDays(t, -3), endDate: addDays(t, 2), items: [item('SG001', '粉漾微光', '80')], rentTotal: 600, depositTotal: 10000, total: 10600, tracking: 'SF1029384756', remit: { name: '李安安', bank: '台新', date: addDays(t, -7), amount: 10600, last5: '24680' }, refundAccount: acct, log: '' }),
      Object.assign({}, base, { no: no(-15, 'B9CV'), status: '待退款', createdAt: addDays(t, -15) + ' 16:30', name: '周曉雯', phone: '0955666777', address: '台南市東區大學路 1 號', startDate: addDays(t, -10), endDate: addDays(t, -5), items: [item('SG004', '我的羅曼史', '80')], rentTotal: 600, depositTotal: 10000, total: 10600, tracking: 'SF5647382910', deduct: 500, deductReason: '裙擺一處勾紗，需要修補', remit: { name: '周曉雯', bank: '玉山', date: addDays(t, -14), amount: 10600, last5: '11223' }, refundAccount: { code: '808', bank: '玉山銀行', account: '0987-6543-2100', holder: '周曉雯' }, log: '' }),
      Object.assign({}, base, { no: no(-12, 'K5WS'), status: '檢查中', createdAt: addDays(t, -12) + ' 19:10', name: '吳佳佳', phone: '0966777888', address: '新竹市東區光復路 2 號', startDate: addDays(t, -8), endDate: addDays(t, -3), returnedAt: addDays(t, -1), items: [item('SG006', '我的羅曼史', '110')], rentTotal: 600, depositTotal: 10000, total: 10600, tracking: 'SF2233445566', remit: { name: '吳佳佳', bank: '富邦', date: addDays(t, -11), amount: 10600, last5: '99881' }, refundAccount: { code: '012', bank: '台北富邦', account: '1111-2222-3333', holder: '吳佳佳' }, log: '' }),
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
      case 'received': o.status = '檢查中'; o.returnedAt = today(); log('收到歸還，檢查中'); break;
      case 'inspect':
        if (req.deduct > o.depositTotal) return { ok: false, error: '扣款金額不能超過押金。' };
        if (req.deduct && !req.reason) return { ok: false, error: '請寫扣款原因，客戶查詢時會看到。' };
        o.status = '待退款'; o.deduct = req.deduct; o.deductReason = req.reason;
        log(req.deduct ? `檢查完成，扣款 ${req.deduct}：${req.reason}` : '檢查完成，衣服完好');
        break;
      case 'refund': o.status = '已退押金'; o.refund = req.amount; o.refundDate = req.date; o.refundLast5 = req.last5; log(`已退押金 ${req.amount}（${req.date} 轉出，後五碼 ${req.last5}）`); break;
      case 'cancel':
        if (o.status === '已付款' || o.status === '已出貨') { o.status = '待退款'; o.cancelRefund = req.refund; log(`取消訂單，待退款 ${req.refund}` + (req.reason ? '：' + req.reason : '')); }
        else { o.status = '已取消'; log('取消訂單' + (req.reason ? '：' + req.reason : '')); }
        break;
      case 'refundCancel': o.status = '已取消'; o.cancelRefund = req.amount; o.refundDate = req.date; o.refundLast5 = req.last5; log(`已退款 ${req.amount}（${req.date} 轉出，後五碼 ${req.last5}）`); break;
      case 'extend': {
        if (!req.newEnd || req.newEnd <= o.endDate) return { ok: false, error: `新的歸還日要晚於原本的 ${o.endDate}。` };
        // 示範：延超過 5 天就假裝撞到下一位客戶
        if (!req.force && dayDiff(o.endDate, req.newEnd) > 5) return { ok: false, conflict: true, error: `延到 ${req.newEnd} 會跟其他檔期衝突：\nSG1101-DEMO 王小姐（${addDays(req.newEnd, 2)} 起租）\n（衣服歸還後要空 3 天才能再出租）` };
        o.extendFee = (o.extendFee || 0) + (req.fee || 0);
        log(`延後歸還日 ${o.endDate} → ${req.newEnd}` + (req.fee ? `，加收 ${req.fee}（從押金扣除）` : ''));
        o.endDate = req.newEnd;
        break;
      }
    }
    demo.forEach(x => { x.paid = x.remit ? x.remit.amount : x.total; });
    return { ok: true, name, orders: demo };
  }

  // ───────── 啟動 ─────────
  if (DEMO) $('#demo-banner').hidden = false;
  if (state.auth) refresh(true);
  else renderLogin();
})();
