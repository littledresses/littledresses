(() => {
  'use strict';

  const API_URL = (window.SHOP_CONFIG && window.SHOP_CONFIG.API_URL || '').trim();
  const DEMO = !API_URL;

  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => 'NT$ ' + Number(n || 0).toLocaleString('zh-TW');

  // 日期一律用 'YYYY-MM-DD' 字串，以台灣時間計算
  const D = {
    parse: s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); },
    fmt: t => new Date(t).toISOString().slice(0, 10),
    add: (s, n) => D.fmt(D.parse(s) + n * 864e5),
    today: () => new Date(Date.now() + 8 * 36e5).toISOString().slice(0, 10),
    pretty: s => { const t = new Date(D.parse(s)); return `${t.getUTCMonth() + 1}/${t.getUTCDate()}（${'日一二三四五六'[t.getUTCDay()]}）`; },
    full: s => s ? `${s.replace(/-/g, '/')}（${'日一二三四五六'[new Date(D.parse(s)).getUTCDay()]}）` : '—',
    addMonth: (ym, n) => { const [y, m] = ym.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 + n, 1)); return t.toISOString().slice(0, 7); },
  };

  const store = {
    get(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 無痕模式等情況，忽略 */ } },
  };

  let shop = null;
  let products = [];
  let bookings = {};
  const state = {
    cart: store.get('sg_cart', []),
    start: store.get('sg_start', ''),
    form: store.get('sg_form', {}),
    // 在這台裝置下單的訂單 [{ no, phone }]，新的在前；查詢紀錄時自動列出（只查詢過的不記）
    orders: store.get('sg_orders', []),
    cartStep: 'cart',
    size: '',
  };
  const save = () => { store.set('sg_cart', state.cart); store.set('sg_start', state.start); store.set('sg_form', state.form); store.set('sg_orders', state.orders); };
  const sameNo = (a, b) => String(a).toUpperCase().replace(/[^0-9A-Z]/g, '') === String(b).toUpperCase().replace(/[^0-9A-Z]/g, '');
  function rememberOrder(no, phone) {
    state.orders = [{ no, phone }].concat(state.orders.filter(o => !sameNo(o.no, no))).slice(0, 20);
    save();
  }

  const dlg = {
    product: $('#dlg-product'),
    cart: $('#dlg-cart'),
    lookup: $('#dlg-lookup'),
    notice: $('#dlg-notice'),
  };

  // ───────── 檔期計算 ─────────
  const endOf = start => D.add(start, shop.rentalDays);
  const minStart = () => D.add(D.today(), shop.minLeadDays);
  const maxStart = () => D.add(D.today(), shop.maxAheadDays);
  const inWindow = s => s >= minStart() && s <= maxStart();
  // 同款同尺寸有 qty 件：每筆租借佔用一件 [起日, 迄日＋間隔天數]，同一天同時佔用的件數加上新的這件不能超過 qty
  // （跟後台 Code.gs 的 canBook 是同一套算法，兩邊要一起改）
  function canBook(ranges, qty, start, end, gap) {
    const lo = start;
    const hi = D.add(end, gap);
    const hits = (ranges || []).map(([bs, be]) => [bs, D.add(be, gap)]).filter(([bs, be]) => bs <= hi && lo <= be);
    if (hits.length < qty) return true;
    const points = [];
    hits.forEach(([bs, be]) => { points.push([bs < lo ? lo : bs, 1]); points.push([be > hi ? hi : be, -1]); });
    points.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : b[1] - a[1]);
    let cur = 0;
    let max = 0;
    points.forEach(([, d]) => { cur += d; max = Math.max(max, cur); });
    return max < qty;
  }
  const isFree = (id, start) => {
    const p = byId(id);
    return canBook(bookings[id], (p && p.qty) || 1, start, endOf(start), shop.gapDays);
  };
  const canStart = (ids, s) => inWindow(s) && ids.every(id => isFree(id, s));
  const byId = id => products.find(p => p.id === id);
  // 同品牌＋同名稱的多列＝同一款的不同尺寸（每個尺寸可以有好幾件，見 qty）
  let styles = [];
  const sizeNum = v => { const n = parseFloat(v); return isFinite(n) ? n : 9999; };
  function buildStyles() {
    const map = new Map();
    products.forEach(p => {
      const key = (p.brand || '') + '｜' + p.name;
      if (!map.has(key)) map.set(key, { key, brand: p.brand || '', name: p.name, images: [], pieces: [] });
      const st = map.get(key);
      st.pieces.push(p);
      (p.images || []).forEach(u => { if (!st.images.includes(u)) st.images.push(u); });
    });
    styles = [...map.values()];
    styles.forEach(st => st.pieces.sort((a, b) => sizeNum(a.size) - sizeNum(b.size) || String(a.size).localeCompare(String(b.size))));
  }
  const styleOf = p => styles.find(st => st.pieces.includes(p));
  const fullName = p => (p.brand ? p.brand + ' ' : '') + p.name;
  const cartItems = () => state.cart.map(byId).filter(Boolean);

  // ───────── API ─────────
  async function apiGet(params) {
    if (DEMO) return demoApi(params);
    const res = await fetch(API_URL + '?' + new URLSearchParams(params));
    return res.json();
  }
  async function apiPost(body) {
    if (DEMO) return demoApi(body);
    // 用 text/plain 避免瀏覽器的 CORS 預檢，Apps Script 才收得到
    const res = await fetch(API_URL, { method: 'POST', body: JSON.stringify(body) });
    return res.json();
  }

  async function loadCatalog() {
    const r = await apiGet({ action: 'catalog' });
    if (!r.ok) throw new Error(r.error || '載入失敗');
    shop = r.shop;
    products = r.products || [];
    bookings = r.bookings || {};
    buildStyles();
    state.cart = state.cart.filter(id => byId(id));
    if (state.start && !inWindow(state.start)) state.start = '';
    save();
  }

  // ───────── 圖片 ─────────
  const PLACEHOLDER_BG = ['#f4e3df', '#ece5da', '#e3e8df', '#ebe2ea', '#f3e8da'];
  function placeholder(p) {
    let h = 0;
    for (const ch of p.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const bg = PLACEHOLDER_BG[h % PLACEHOLDER_BG.length];
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 400'><rect width='300' height='400' fill='${bg}'/>`
      + `<path d='M150 70 v14 M138 92 q12-12 24 0' stroke='#b9a08d' stroke-width='3' fill='none' stroke-linecap='round'/>`
      + `<path d='M122 100 L140 92 Q150 104 160 92 L178 100 L170 160 Q220 250 238 318 Q150 340 62 318 Q80 250 130 160 Z' fill='#fffdfa' opacity='.9'/>`
      + `<path d='M130 160 Q150 170 170 160' stroke='#e3b9b3' stroke-width='6' fill='none'/>`
      + `<path d='M228 108 l3 9 9 3 -9 3 -3 9 -3 -9 -9 -3 9 -3z M70 210 l2 6 6 2 -6 2 -2 6 -2 -6 -6 -2 6 -2z' fill='#c4a274' opacity='.7'/></svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
  const styleImg = st => st.images[0] || placeholder({ id: st.key });
  // 雲端硬碟的照片如果帶著網站網址（Referer）去要圖會被 Google 擋掉，所以不送 Referer
  const imgTag = (src, alt, key) => `<img src="${esc(src)}" alt="${esc(alt)}" loading="lazy" referrerpolicy="no-referrer" data-ph="${esc(key)}">`;
  // 圖片網址失效時換成預設圖
  document.addEventListener('error', e => {
    const img = e.target;
    if (img.tagName === 'IMG' && img.dataset.ph && !img.dataset.failed) {
      img.dataset.failed = '1';
      img.src = placeholder({ id: img.dataset.ph });
    }
  }, true);

  // ───────── 商品列表 ─────────
  // 依尺寸篩選：只列出有這個尺寸的款式，點進去時直接選好該尺寸
  const pieceOfSize = (st, size) => st.pieces.find(p => String(p.size) === size);
  function renderFilters() {
    const el = $('#filters');
    const sizes = [...new Set(products.map(p => String(p.size || '')).filter(Boolean))]
      .sort((a, b) => sizeNum(a) - sizeNum(b) || a.localeCompare(b));
    if (state.size && !sizes.includes(state.size)) state.size = '';
    el.hidden = sizes.length < 2;
    el.innerHTML = '<p class="filters-label"><span>Size</span><b>依尺寸挑選</b></p><div class="chips">'
      + ['', ...sizes].map(s => `<button type="button" class="chip${s ? '' : ' chip-all'}" data-filter="${esc(s)}" aria-pressed="${s === state.size}">${s ? esc(s) : '全部'}</button>`).join('')
      + '</div>';
  }

  function renderGrid() {
    const grid = $('#grid');
    if (!styles.length) { grid.innerHTML = '<p class="empty">目前沒有衣服，敬請期待 ✦</p>'; return; }
    const list = state.size ? styles.filter(st => pieceOfSize(st, state.size)) : styles;
    if (!list.length) { grid.innerHTML = `<p class="empty">目前沒有 ${esc(state.size)} 號的衣服</p>`; return; }
    grid.innerHTML = list.map(st => `
      <button type="button" class="card" data-product="${esc(st.key)}"${state.size ? ` data-piece="${esc(pieceOfSize(st, state.size).id)}"` : ''}>
        <div class="card-img">${imgTag(styleImg(st), st.name, st.key)}${st.pieces.some(p => state.cart.includes(p.id)) ? '<span class="card-badge">已加入</span>' : ''}</div>
        <div class="card-body">
          ${st.brand ? `<span class="card-brand">${esc(st.brand)}</span>` : ''}
          <span class="card-name">${esc(st.name)}</span>
        </div>
      </button>`).join('');
  }

  function updateCount(bump) {
    const el = $('#cart-count');
    el.textContent = state.cart.length;
    el.classList.toggle('is-empty', !state.cart.length);
    if (bump) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
  }

  // ───────── 日曆 ─────────
  function calendar(container, { isSelectable, isTaken, selected, onPick }) {
    let first = minStart();
    while (first < maxStart() && !isSelectable(first)) first = D.add(first, 1);
    let view = (selected || first).slice(0, 7);
    const firstView = D.today().slice(0, 7);
    const lastView = maxStart().slice(0, 7);
    function draw() {
      const [y, m] = view.split('-').map(Number);
      const startDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
      const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const selEnd = selected ? endOf(selected) : '';
      let cells = '<span></span>'.repeat(startDow);
      for (let d = 1; d <= days; d++) {
        const ds = `${view}-${String(d).padStart(2, '0')}`;
        const ok = isSelectable(ds);
        const cls = ['day', ok ? 'ok' : '', !ok && isTaken && inWindow(ds) && isTaken(ds) ? 'taken' : '',
          selected && ds === selected ? 'sel' : '',
          selected && ds > selected && ds <= selEnd ? 'range' : '',
          selected && ds === selEnd ? 'range-end' : ''].filter(Boolean).join(' ');
        cells += `<button type="button" class="${cls}" data-day="${ds}" ${ok ? '' : 'disabled'} aria-label="${ds}">${d}</button>`;
      }
      container.innerHTML = `
        <div class="cal">
          <div class="cal-head">
            <button type="button" class="cal-nav" data-nav="-1" ${view <= firstView ? 'disabled' : ''} aria-label="上個月">‹</button>
            <b>${y} 年 ${m} 月</b>
            <button type="button" class="cal-nav" data-nav="1" ${view >= lastView ? 'disabled' : ''} aria-label="下個月">›</button>
          </div>
          <div class="cal-dow">${[...'日一二三四五六'].map(x => `<span>${x}</span>`).join('')}</div>
          <div class="cal-grid">${cells}</div>
          <div class="cal-legend">
            <span><i style="background:var(--rose-deep)"></i>起日</span>
            <span><i style="background:var(--rose-soft)"></i>租借期間</span>
            <span><i style="background:#e6dcd3"></i>不可選</span>
          </div>
        </div>`;
    }
    container.onclick = e => {
      const nav = e.target.closest('[data-nav]');
      if (nav && !nav.disabled) { view = D.addMonth(view, Number(nav.dataset.nav)); draw(); return; }
      const day = e.target.closest('[data-day]');
      if (day && !day.disabled) { selected = day.dataset.day; draw(); onPick(selected); }
    };
    draw();
  }

  function rangeText(start) {
    return `<b>${D.pretty(start)}</b> 起 ～ <b>${D.pretty(endOf(start))}</b> 止`;
  }

  // ───────── 商品詳情 ─────────
  function openProduct(key, pieceId) {
    const st = styles.find(x => x.key === key);
    if (!st) return;
    const imgs = st.images.length ? st.images : [placeholder({ id: st.key })];
    let piece = st.pieces.find(p => p.id === pieceId) || (st.pieces.length === 1 ? st.pieces[0] : null);
    dlg.product.innerHTML = `
      <div class="dlg-head"><h2>${esc(st.name)}</h2><button type="button" class="dlg-close" data-close aria-label="關閉">×</button></div>
      <div class="dlg-body">
        <div class="gallery-main">${imgTag(imgs[0], st.name, st.key)}</div>
        ${imgs.length > 1 ? `<div class="thumbs">${imgs.map((src, i) => `<button type="button" data-thumb="${i}" aria-current="${i === 0}">${imgTag(src, st.name, st.key)}</button>`).join('')}</div>` : ''}
        ${st.brand ? `<p class="p-brand">${esc(st.brand)}</p>` : ''}
        <h3 class="p-title">${esc(st.name)}</h3>
        <h3 class="sec-title">選擇尺寸</h3>
        <div class="sizes">${st.pieces.map(p => `<button type="button" class="chip" data-size="${esc(p.id)}" aria-pressed="${p === piece}">${esc(p.size || p.id)}</button>`).join('')}</div>
        <div id="p-detail"></div>
      </div>
      <div class="dlg-foot">
        <button type="button" class="btn primary block" id="p-add"></button>
      </div>`;

    const drawDetail = () => {
      const el = $('#p-detail', dlg.product);
      const btn = $('#p-add', dlg.product);
      if (!piece) {
        el.innerHTML = '<p class="hint" style="margin-top:10px">選擇尺寸後，會顯示租金、押金與可租借日期。</p>';
        btn.disabled = true;
        btn.textContent = '請先選擇尺寸';
        return;
      }
      btn.dataset.id = piece.id;
      // 租借清單不能改日期，所以日期在商品頁就要選好；清單裡已有衣服時，日期固定為清單的期間
      const locked = !!state.start && cartItems().some(x => x.id !== piece.id);
      el.innerHTML = `
        <div class="price-row" style="margin-top:14px">
          <div class="rent"><span>租金（每次）</span><b>${money(piece.rent)}</b></div>
          <div><span>押金</span><b>${money(piece.deposit)}</b></div>
        </div>
        <h3 class="sec-title">選擇租借日期</h3>
        <p class="hint">${locked ? '同一張訂單的租借期間相同，已固定為租借清單的日期。要換日期，請先移除清單裡的衣服。' : `點選起日，迄日自動為起日＋${shop.rentalDays} 天。`}</p>
        <div id="p-cal"></div>
        <div id="p-status"></div>`;
      const p = piece;
      const showStatus = () => {
        const box = $('#p-status', dlg.product);
        const free = !!state.start && canStart([p.id], state.start);
        if (state.cart.includes(p.id)) { btn.disabled = false; btn.textContent = '已在清單・前往結帳'; }
        else { btn.disabled = !free; btn.textContent = free ? '加入租借清單' : state.start ? '這段期間無法租借' : '請先選擇租借日期'; }
        if (!state.start) { box.innerHTML = ''; return; }
        box.innerHTML = `<div class="range-box">${rangeText(state.start)}
          <div class="status-line ${free ? 'ok' : 'bad'}">${free ? '✓ 這段期間可以租借' : locked ? '✕ 這個尺寸在租借清單的期間已被預約' : '✕ 這個尺寸在這段期間已被預約，請換日期或尺寸'}</div></div>`;
      };
      calendar($('#p-cal', dlg.product), {
        isSelectable: d => locked ? d === state.start : canStart([p.id], d),
        isTaken: d => !isFree(p.id, d),
        selected: state.start && (locked || canStart([p.id], state.start)) ? state.start : '',
        onPick: d => { if (locked) return; state.start = d; save(); showStatus(); },
      });
      showStatus();
    };
    drawDetail();

    dlg.product.onclick = e => {
      const t = e.target.closest('[data-thumb]');
      if (t) {
        $('.gallery-main', dlg.product).innerHTML = imgTag(imgs[Number(t.dataset.thumb)], st.name, st.key);
        dlg.product.querySelectorAll('[data-thumb]').forEach(b => b.setAttribute('aria-current', b === t));
        return;
      }
      const sz = e.target.closest('[data-size]');
      if (sz) {
        piece = st.pieces.find(p => p.id === sz.dataset.size);
        dlg.product.querySelectorAll('[data-size]').forEach(b => b.setAttribute('aria-pressed', b === sz));
        drawDetail();
      }
    };
    showModal(dlg.product);
  }

  function addToCart(id) {
    if (!state.cart.includes(id)) {
      state.cart.push(id);
      save();
      updateCount(true);
      renderGrid();
      toast('已加入租借清單');
      $('#p-add', dlg.product).textContent = '已在清單・前往結帳';
      return;
    }
    dlg.product.close();
    openCart();
  }

  // ───────── 租借清單／結帳 ─────────
  function openCart() {
    state.cartStep = 'cart';
    renderCart();
    showModal(dlg.cart);
  }

  function summaryHTML(items) {
    const rent = items.reduce((a, p) => a + p.rent, 0);
    const dep = items.reduce((a, p) => a + p.deposit, 0);
    const ship = shop.shippingFee || 0;
    return `<dl class="summary">
      <div><dt>租借期間</dt><dd>${state.start ? `${D.pretty(state.start)} ～ ${D.pretty(endOf(state.start))}` : '尚未選擇'}</dd></div>
      <div><dt>租金（${items.length} 件）</dt><dd>${money(rent)}</dd></div>
      <div><dt>押金</dt><dd>${money(dep)}</dd></div>
      ${ship ? `<div><dt>順豐運費</dt><dd>${money(ship)}</dd></div>` : ''}
      <div class="total"><dt>應付總額</dt><dd>${money(rent + dep + ship)}</dd></div>
    </dl>`;
  }

  function renderCart() {
    const items = cartItems();
    const head = title => `<div class="dlg-head"><h2>${title}</h2><button type="button" class="dlg-close" data-close aria-label="關閉">×</button></div>`;
    if (!items.length) {
      dlg.cart.innerHTML = head('租借清單') + `<div class="dlg-body"><div class="empty-state"><p>清單裡還沒有衣服</p><button type="button" class="btn primary" data-close>去挑衣服</button></div></div>`;
      return;
    }
    const ids = items.map(p => p.id);
    if (state.start && !inWindow(state.start)) state.start = '';
    const allOk = !!state.start && canStart(ids, state.start);

    if (state.cartStep === 'cart') {
      dlg.cart.innerHTML = head('租借清單') + `
        <div class="dlg-body">
          ${items.map(p => {
            const bad = state.start && !isFree(p.id, state.start);
            return `<div class="line ${bad ? 'bad' : ''}">
              ${imgTag(styleImg(styleOf(p)), p.name, styleOf(p).key)}
              <div class="line-info">
                ${p.brand ? `<span class="line-brand">${esc(p.brand)}</span>` : ''}
                <b>${esc(p.name)}</b>
                <span>${esc(p.size ? '尺寸 ' + p.size : p.id)}</span>
                <span>租金 ${money(p.rent)}・押金 ${money(p.deposit)}</span>
                ${bad ? '<em>這件在所選期間已被預約，請移除</em>' : ''}
              </div>
              <button type="button" class="icon-btn" data-remove="${esc(p.id)}">移除</button>
            </div>`;
          }).join('')}
          ${state.start ? '' : '<p class="hint">還沒有選擇租借日期，請回到商品頁選好日期。</p>'}
          ${summaryHTML(items)}
        </div>
        <div class="dlg-foot">
          <button type="button" class="btn primary block" id="to-form" ${allOk ? '' : 'disabled'}>${allOk ? '確認，填寫收件資料' : state.start ? '有衣服在這段期間無法租借' : '請先在商品頁選擇租借日期'}</button>
        </div>`;
      return;
    }

    // 填寫資料
    const f = state.form;
    dlg.cart.innerHTML = head('填寫收件資料') + `
      <form class="dlg-body form" id="order-form" novalidate>
        <label><span>姓名 <span class="req">*</span></span><input name="name" required maxlength="50" autocomplete="name" value="${esc(f.name)}"></label>
        <label><span>電話 <span class="req">*</span></span><input name="phone" type="tel" required inputmode="tel" maxlength="20" autocomplete="tel" placeholder="09xx-xxx-xxx" value="${esc(f.phone)}"><small>之後用這支電話查詢租借紀錄</small></label>
        <label><span>順豐收件地址 <span class="req">*</span></span><textarea name="address" required rows="2" maxlength="200" autocomplete="street-address" placeholder="收件地址，或順豐服務站名稱">${esc(f.address)}</textarea></label>
        <fieldset class="refund-set">
          <legend>退押金帳戶 <span class="req">*</span></legend>
          <p class="hint">衣服歸還、確認無損後，押金會退到這個帳戶。</p>
          <div class="form-row">
            <label><span>銀行代碼</span><input name="refundBankCode" required inputmode="numeric" maxlength="3" placeholder="例如 013" value="${esc(f.refundBankCode)}"></label>
            <label><span>銀行名稱</span><input name="refundBank" required maxlength="50" placeholder="例如 國泰世華" value="${esc(f.refundBank)}"></label>
          </div>
          <label><span>帳號</span><input name="refundAccount" required inputmode="numeric" maxlength="30" autocomplete="off" placeholder="帳號數字"></label>
          <label><span>戶名</span><input name="refundHolder" required maxlength="50" value="${esc(f.refundHolder)}"></label>
        </fieldset>
        <label>備註<textarea name="note" rows="3" maxlength="500" placeholder="需要加購或借配件（例如髮飾、頭紗、鞋子），請寫在這裡">${esc(f.note)}</textarea><small>加購內容由我們確認後，會顯示在租借紀錄中</small></label>
        <input name="website" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
        <label class="check"><input type="checkbox" name="agree" required> 我已閱讀並同意 <button type="button" class="link-btn" data-open="notice">租借須知</button></label>
        ${summaryHTML(items)}
        <p class="form-error" id="form-error" hidden></p>
      </form>
      <div class="dlg-foot foot-row">
        <button type="button" class="btn" id="to-cart">上一步</button>
        <button type="submit" class="btn primary" form="order-form" id="submit-order">送出訂單</button>
      </div>`;
    $('#order-form', dlg.cart).addEventListener('input', e => {
      // 退押金帳號不存在手機裡
      if (e.target.name && !['agree', 'website', 'refundAccount'].includes(e.target.name)) { state.form[e.target.name] = e.target.value; save(); }
    });
  }

  async function submitOrder(form) {
    const err = $('#form-error', dlg.cart);
    const fd = new FormData(form);
    const v = k => String(fd.get(k) || '').trim();
    const problem = !v('name') ? '請填寫姓名'
      : v('phone').replace(/\D/g, '').length < 8 ? '請填寫正確的電話號碼'
      : !v('address') ? '請填寫順豐收件地址'
      : !/^\d{3}$/.test(v('refundBankCode')) ? '請填寫 3 碼的退押金銀行代碼'
      : !v('refundBank') ? '請填寫退押金的銀行名稱'
      : v('refundAccount').replace(/\D/g, '').length < 6 ? '請填寫正確的退押金帳號'
      : !v('refundHolder') ? '請填寫退押金帳戶的戶名'
      : !fd.get('agree') ? '請勾選同意租借須知' : '';
    if (problem) { err.textContent = problem; err.hidden = false; err.scrollIntoView({ block: 'nearest' }); return; }

    const btn = $('#submit-order', dlg.cart);
    btn.disabled = true;
    btn.textContent = '送出中…';
    err.hidden = true;
    try {
      const r = await apiPost({
        action: 'order',
        items: state.cart,
        startDate: state.start,
        customer: {
          name: v('name'), phone: v('phone'), address: v('address'), note: v('note'),
          refundBankCode: v('refundBankCode'), refundBank: v('refundBank'), refundAccount: v('refundAccount'), refundHolder: v('refundHolder'),
        },
        website: v('website'),
      });
      if (!r.ok) throw new Error(r.error || '送出失敗，請稍後再試');
      const phone = v('phone');
      state.cart = [];
      state.start = '';
      state.form = { name: v('name'), phone, address: v('address'), refundBankCode: v('refundBankCode'), refundBank: v('refundBank'), refundHolder: v('refundHolder') };
      rememberOrder(r.order.no, phone);
      updateCount();
      renderDone(r, phone);
      loadCatalog().then(renderGrid).catch(() => {});
    } catch (e) {
      err.textContent = e.message || '網路不穩，請稍後再試';
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = '送出訂單';
      // 可能剛好被別人訂走，重新抓檔期
      loadCatalog().then(renderGrid).catch(() => {});
    }
  }

  function orderSummaryHTML(o) {
    return `<dl class="summary">
      <div><dt>租借期間</dt><dd>${D.pretty(o.startDate)} ～ ${D.pretty(o.endDate)}</dd></div>
      ${o.items.map(p => `<div><dt>${esc(fullName(p))}${p.size ? `（${esc(p.size)}）` : ''}</dt><dd>${p.rent != null ? money(p.rent) : ''}</dd></div>`).join('')}
      <div><dt>押金</dt><dd>${money(o.depositTotal)}</dd></div>
      ${o.shipping ? `<div><dt>順豐運費</dt><dd>${money(o.shipping)}</dd></div>` : ''}
      <div class="total"><dt>應付總額</dt><dd>${money(o.total)}</dd></div>
    </dl>`;
  }

  function paymentHTML(o, bank, phone) {
    return `<div class="pay-box">
      <h3>匯款資訊</h3>
      <dl class="bank">
        <div><dt>銀行</dt><dd>${esc(bank.bankName)}（${esc(bank.bankCode)}）</dd></div>
        <div><dt>帳號</dt><dd><span class="mono">${esc(bank.account)}</span><button type="button" class="copy" data-copy="${esc(bank.account.replace(/\D/g, ''))}">複製</button></dd></div>
        <div><dt>戶名</dt><dd>${esc(bank.holder)}</dd></div>
        <div><dt>金額</dt><dd><span class="amount">${money(o.total)}</span><button type="button" class="copy" data-copy="${o.total}">複製</button></dd></div>
      </dl>
      ${o.deadline ? `<p class="hint">請於 <b>${esc(o.deadline)}</b> 前完成匯款。</p>` : ''}
      <form class="form report-form" data-no="${esc(o.no)}" data-phone="${esc(phone)}">
        <h4 class="report-title">匯款後，請回報匯款資料</h4>
        <label>匯款戶名<input name="name" required maxlength="50" placeholder="匯款人姓名"></label>
        <label>匯款銀行<input name="bank" required maxlength="50" placeholder="例如：國泰世華"></label>
        <div class="form-row">
          <label>匯款日期<input name="date" type="date" required value="${D.today()}" max="${D.today()}"></label>
          <label>匯款金額<input name="amount" inputmode="numeric" required value="${o.total}"></label>
        </div>
        <label>帳號後五碼<input name="last5" inputmode="numeric" maxlength="5" required placeholder="12345"></label>
        <button type="submit" class="btn primary block">送出匯款資料</button>
      </form>
    </div>`;
  }

  function remitHTML(r) {
    return `<div class="remit-box">
      <div class="remit-head"><b>匯款回報</b><span class="status-badge ${r.confirmed ? 'ok' : ''}">${r.confirmed ? '已確認收款' : '待確認'}</span></div>
      <dl class="bank">
        <div><dt>戶名</dt><dd>${esc(r.name)}</dd></div>
        <div><dt>銀行</dt><dd>${esc(r.bank)}</dd></div>
        <div><dt>日期</dt><dd>${esc(r.date)}</dd></div>
        <div><dt>金額</dt><dd>${money(r.amount)}</dd></div>
        <div><dt>後五碼</dt><dd class="mono">${esc(r.last5)}</dd></div>
      </dl>
      ${r.confirmed ? '' : '<p class="hint">我們確認入帳後會更新狀態。</p>'}
    </div>`;
  }

  function renderDone(r, phone) {
    const o = r.order;
    dlg.cart.innerHTML = `
      <div class="dlg-head"><h2>預約成功</h2><button type="button" class="dlg-close" data-close aria-label="關閉">×</button></div>
      <div class="dlg-body">
        <div class="done-hero">
          <div class="check-icon">✓</div>
          <p class="hint">訂單編號</p>
          <p class="order-no">${esc(o.no)}</p>
          <p class="hint">請截圖保存。查詢租借紀錄時需要「電話＋訂單編號」。</p>
        </div>
        ${orderSummaryHTML(o)}
        ${paymentHTML(o, r.bank, phone)}
        <p class="hint" style="margin-top:14px">我們確認入帳後會盡快與您聯繫，並於起日前以順豐寄出。謝謝您 ✦</p>
      </div>
      <div class="dlg-foot"><button type="button" class="btn block" data-close>繼續逛逛</button></div>`;
    state.cartStep = 'done';
    dlg.cart.querySelector('.dlg-body').scrollTop = 0;
  }

  async function submitReport(form) {
    const fd = new FormData(form);
    const v = k => String(fd.get(k) || '').trim();
    const remit = { name: v('name'), bank: v('bank'), date: v('date'), amount: Number(v('amount').replace(/[^\d.]/g, '')), last5: v('last5') };
    const problem = !remit.name ? '請填寫匯款戶名'
      : !remit.bank ? '請填寫匯款銀行'
      : !remit.date ? '請選擇匯款日期'
      : !(remit.amount > 0) ? '請填寫匯款金額'
      : !/^\d{5}$/.test(remit.last5) ? '帳號後五碼請輸入 5 位數字' : '';
    if (problem) { toast(problem); return; }
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = '送出中…';
    try {
      const r = await apiPost({ action: 'report', orderNo: form.dataset.no, phone: form.dataset.phone, remit });
      if (!r.ok) throw new Error(r.error);
      const note = form.closest('.record') && form.closest('.record').querySelector('.notice-box');
      if (note) note.remove();
      form.outerHTML = remitHTML(Object.assign({ confirmed: false }, remit));
      toast('已收到您的匯款資料');
    } catch (e) {
      toast(e.message || '送出失敗，請稍後再試');
      btn.disabled = false;
      btn.textContent = '送出匯款資料';
    }
  }

  // ───────── 查詢租借紀錄 ─────────
  // 要「電話＋訂單編號」才查得到；在這台裝置下單的訂單會自動列出
  function openLookup() {
    const saved = state.orders.length;
    dlg.lookup.innerHTML = `
      <div class="dlg-head"><h2>查詢租借紀錄</h2><button type="button" class="dlg-close" data-close aria-label="關閉">×</button></div>
      <div class="dlg-body">
        ${saved ? '<div id="saved-result"><p class="hint">讀取中…</p></div><h3 class="sec-title">查詢其他訂單</h3>' : ''}
        <form class="form" id="lookup-form">
          <label>下單時填寫的電話<input name="phone" type="tel" required inputmode="tel" autocomplete="tel" placeholder="09xx-xxx-xxx" value="${esc(state.form.phone)}"></label>
          <label>訂單編號<input name="no" required autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="例如 SG1023-K7QF"><small>預約成功畫面上的編號。忘記的話請私訊我們。</small></label>
          <button type="submit" class="btn primary">查詢</button>
        </form>
        <div id="lookup-result"></div>
      </div>`;
    showModal(dlg.lookup);
    if (saved) loadSavedOrders();
  }

  async function loadSavedOrders() {
    const out = $('#saved-result', dlg.lookup);
    const results = await Promise.all(state.orders.map(s =>
      apiPost({ action: 'lookup', phone: s.phone, no: s.no }).then(r => ({ s, r })).catch(() => ({ s, r: null }))));
    // 後台查不到（例如訂單被刪掉）的就不再記住；網路錯誤的先留著
    const gone = results.filter(x => x.r && !x.r.ok).map(x => x.s);
    if (gone.length) { state.orders = state.orders.filter(s => !gone.includes(s)); save(); }
    const ok = results.filter(x => x.r && x.r.ok);
    if (!out) return;
    out.innerHTML = ok.length
      ? ok.map(x => recordHTML(x.r.orders[0], x.r.bank, x.s.phone)).join('')
      : `<p class="hint">${results.some(x => !x.r) ? '網路不穩，請稍後再試。' : '目前沒有可顯示的訂單。'}</p>`;
  }

  async function submitLookup(form) {
    const fd = new FormData(form);
    const phone = String(fd.get('phone') || '').trim();
    const no = String(fd.get('no') || '').trim().toUpperCase();
    const out = $('#lookup-result', dlg.lookup);
    if (phone.replace(/\D/g, '').length < 8) { out.innerHTML = '<p class="form-error" style="margin-top:12px">請輸入正確的電話號碼</p>'; return; }
    if (!/[0-9A-Z]{4}/.test(no.replace(/[^0-9A-Z]/g, ''))) { out.innerHTML = '<p class="form-error" style="margin-top:12px">請輸入訂單編號</p>'; return; }
    out.innerHTML = '<p class="hint" style="margin-top:12px">查詢中…</p>';
    try {
      const r = await apiPost({ action: 'lookup', phone, no });
      if (!r.ok) throw new Error(r.error);
      const o = r.orders[0];
      out.innerHTML = '<p class="hint" style="margin-top:16px">查詢成功</p>' + recordHTML(o, r.bank, phone);
    } catch (e) {
      out.innerHTML = `<p class="form-error" style="margin-top:12px">${esc(e.message || '查詢失敗，請稍後再試')}</p>`;
    }
  }

  function recordHTML(o, bank, phone) {
    // 還沒回報匯款、或店家查無款項時，再顯示一次匯款資訊和回報表單
    const needPay = o.status === '待付款' && (!o.remit || o.payNote);
    return `<article class="record">
      <div class="record-head"><span>訂單 ${esc(o.no)}</span><span class="status-badge">${esc(o.status)}</span></div>
      <dl class="record-info">
        <div><dt>姓名</dt><dd>${esc(o.name)}</dd></div>
        <div><dt>電話</dt><dd>${esc(o.phone)}</dd></div>
        <div><dt>租借起日</dt><dd>${D.full(o.startDate)}</dd></div>
        <div><dt>截止日</dt><dd>${D.full(o.endDate)}</dd></div>
        <div><dt>租借商品</dt><dd>${o.items.map(p => esc(fullName(p)) + (p.size ? `（${esc(p.size)}）` : '')).join('<br>')}</dd></div>
        ${o.addon ? `<div><dt>加購</dt><dd class="pre">${esc(o.addon)}</dd></div>` : ''}
        <div><dt>應付總額</dt><dd class="amount">${money(o.total)}</dd></div>
      </dl>
      ${o.payNote && o.status === '待付款' ? `<div class="notice-box"><b>查帳結果</b><p>${esc(o.payNote)}</p><p class="hint">請確認後重新回報匯款資料，或私訊我們。</p></div>` : ''}
      ${needPay ? paymentHTML(o, bank, phone) : o.remit ? remitHTML(o.remit) : ''}
      ${progressHTML(o)}
    </article>`;
  }

  // 出貨、歸還、退押金的進度
  function progressHTML(o) {
    const rows = [];
    if (o.tracking) rows.push(`<div><dt>順豐單號</dt><dd><span class="mono">${esc(o.tracking)}</span><button type="button" class="copy" data-copy="${esc(o.tracking)}">複製</button>${o.shippedAt ? `<br><small>${D.full(o.shippedAt)} 寄出</small>` : ''}</dd></div>`);
    if (o.extendFee) rows.push(`<div><dt>延期加收</dt><dd>${money(o.extendFee)}<br><small>會從押金扣除</small></dd></div>`);
    if (o.returnedAt) rows.push(`<div><dt>歸還驗收</dt><dd>${!o.inspected ? `已收到衣服，檢查中<br><small>${D.full(o.returnedAt)} 收到</small>` : o.deduct ? `扣款 ${money(o.deduct)}<br><small>${esc(o.deductReason)}</small>` : '衣服完好，謝謝您 ✦'}</dd></div>`);
    // 退款日期＋轉出帳號後五碼，方便客戶對帳（舊資料沒有的話用系統記錄的時間）
    const refundNote = at => o.refundDate ? `<br><small>${D.full(o.refundDate)} 已退回您的帳戶${o.refundLast5 ? `<br>轉出帳號後五碼 ${esc(o.refundLast5)}` : ''}</small>` : at ? `<br><small>${D.full(at)} 已退回您的帳戶</small>` : '';
    if (o.refund != null) rows.push(`<div><dt>退押金</dt><dd><span class="amount">${money(o.refund)}</span>${refundNote(o.refundedAt)}</dd></div>`);
    else if (o.returnedAt && o.inspected) rows.push(`<div><dt>退押金</dt><dd>處理中，退款後會更新</dd></div>`);
    // 已付款後取消的訂單
    if (o.cancelRefund != null) rows.push(`<div><dt>取消退款</dt><dd><span class="amount">${money(o.cancelRefund)}</span>${o.cancelRefundedAt ? refundNote(o.cancelRefundedAt) : '<br><small>訂單已取消，退款處理中</small>'}</dd></div>`);
    return rows.length ? `<dl class="bank progress-box">${rows.join('')}</dl>` : '';
  }

  function openNotice() {
    dlg.notice.innerHTML = `
      <div class="dlg-head"><h2>租借須知</h2><button type="button" class="dlg-close" data-close aria-label="關閉">×</button></div>
      <div class="dlg-body">
        <p class="notice-text">${esc(shop ? shop.notice : '')}</p>
        ${shop ? `<p class="hint" style="margin-top:14px">租期：起日至迄日（起日＋${shop.rentalDays} 天）。最早可預約 ${shop.minLeadDays} 天後的日期。</p>` : ''}
      </div>`;
    showModal(dlg.notice);
  }

  // ───────── 共用 ─────────
  function showModal(d) { if (!d.open) d.showModal(); }

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    // 有對話框開著時，提示要放進最上層的對話框才看得到
    const open = [...document.querySelectorAll('dialog[open]')].pop();
    (open || document.body).appendChild(el);
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('已複製'); }
    catch (e) { toast(text); }
  }

  document.addEventListener('click', e => {
    const t = e.target;
    if (t.tagName === 'DIALOG') { t.close(); return; } // 點背景關閉
    const el = t.closest('[data-close],[data-open],[data-filter],[data-product],[data-remove],[data-copy],#p-add,#to-form,#to-cart');
    if (!el) return;
    if (el.matches('[data-close]')) { el.closest('dialog').close(); return; }
    if (el.matches('[data-open]')) {
      if (!shop) return;
      ({ cart: openCart, lookup: openLookup, notice: openNotice })[el.dataset.open]();
      return;
    }
    if (el.matches('[data-filter]')) { state.size = el.dataset.filter; renderFilters(); renderGrid(); return; }
    if (el.matches('[data-product]')) { openProduct(el.dataset.product, el.dataset.piece); return; }
    if (el.matches('[data-remove]')) {
      state.cart = state.cart.filter(id => id !== el.dataset.remove);
      save(); updateCount(); renderGrid(); renderCart();
      return;
    }
    if (el.matches('[data-copy]')) { copy(el.dataset.copy); return; }
    if (el.id === 'p-add') { addToCart(el.dataset.id); return; }
    if (el.id === 'to-form') { state.cartStep = 'form'; renderCart(); return; }
    if (el.id === 'to-cart') { state.cartStep = 'cart'; renderCart(); }
  });

  document.addEventListener('submit', e => {
    const f = e.target;
    if (f.id === 'order-form') { e.preventDefault(); submitOrder(f); }
    else if (f.id === 'lookup-form') { e.preventDefault(); submitLookup(f); }
    else if (f.classList.contains('report-form')) { e.preventDefault(); submitReport(f); }
  });

  // ───────── 啟動 ─────────
  // 大 logo 有一半以上捲到頁首後面時，頁首才顯示小洋裝圖示
  // （不等完全捲出畫面，商品少、頁面短的時候大 logo 可能永遠捲不完）
  function watchHeroLogo() {
    const header = $('.site-header');
    const hero = $('.hero-logo');
    if (!hero || !('IntersectionObserver' in window)) { header.classList.add('show-mark'); return; }
    new IntersectionObserver(([en]) => header.classList.toggle('show-mark', en.intersectionRatio < .5),
      { rootMargin: `-${header.offsetHeight}px 0px 0px 0px`, threshold: [0, .5, 1] }).observe(hero);
  }

  async function init() {
    if (DEMO) $('#demo-banner').hidden = false;
    watchHeroLogo();
    try {
      await loadCatalog();
    } catch (e) {
      console.error(e);
      $('#grid').innerHTML = '<p class="error">衣服載入失敗，請稍後重新整理頁面。</p>';
      return;
    }
    renderFilters();
    renderGrid();
    updateCount();
    const item = new URLSearchParams(location.search).get('item');
    if (item && byId(item)) openProduct(styleOf(byId(item)).key);
  }

  // ───────── 示範模式（還沒設定 API_URL 時使用）─────────
  function demoApi(req) {
    return new Promise(resolve => setTimeout(() => resolve(demoHandle(req)), 350));
  }
  const demoOrders = (() => {
    const t = D.today();
    return [{
      no: 'SG' + D.add(t, -20).slice(5).replace(/-/g, '') + '-K7QF', status: '已退押金', name: '陳小美', phone: '0912345678',
      startDate: D.add(t, -14), endDate: D.add(t, -9), items: [{ id: 'SG001', brand: '多霏', name: '粉漾微光', size: '80' }],
      total: 10600, addon: '', remit: { name: '陳小美', bank: '國泰世華', date: D.add(t, -19), amount: 10600, last5: '24680', confirmed: true },
      tracking: 'SF1234567890', shippedAt: D.add(t, -16), returnedAt: D.add(t, -7), inspected: true, deduct: 0, refund: 10000, refundedAt: D.add(t, -6), refundDate: D.add(t, -6), refundLast5: '88123',
    }, {
      no: 'SG' + D.add(t, -2).slice(5).replace(/-/g, '') + '-M3XA', status: '已付款', name: '陳小美', phone: '0912345678',
      startDate: D.add(t, 40), endDate: D.add(t, 45), items: [{ id: 'SG005', brand: '多霏', name: '我的羅曼史', size: '90' }],
      total: 10750, addon: '珍珠髮箍 ×1（加購 NT$ 150，已含在應付總額內）\n白色小皮鞋 15cm 借用', remit: { name: '陳小美', bank: '中國信託', date: D.add(t, -1), amount: 10750, last5: '13579', confirmed: true },
    }];
  })();
  const DEMO_BANK = { bankName: '範例銀行', bankCode: '000', account: '0000-0000-0000', holder: '蒔光衣櫥' };
  function demoHandle(req) {
    const t = D.today();
    if (req.action === 'catalog') {
      const extra = {};
      demoOrders.forEach(o => o.items.forEach(p => (extra[p.id] = extra[p.id] || []).push([o.startDate, o.endDate])));
      const base = {
        SG002: [[D.add(t, 9), D.add(t, 14)]],
        SG004: [[D.add(t, 5), D.add(t, 10)], [D.add(t, 24), D.add(t, 29)]],
      };
      const merged = {};
      [base, extra].forEach(m => Object.keys(m).forEach(k => { merged[k] = (merged[k] || []).concat(m[k]); }));
      return {
        ok: true,
        shop: {
          name: '蒔光衣櫥', rentalDays: 5, gapDays: 4, minLeadDays: 3, maxAheadDays: 90, shippingFee: 0, paymentHours: 24,
          notice: '・訂單成立後請於期限內完成匯款，逾期未付款的訂單可能會被取消。\n・衣服會以順豐寄出，於租借起日前送達。\n・請於租借迄日當天以順豐寄回，包裹內會附上回寄說明。\n・押金於收到衣服並確認無損後全額退還。\n・如有難以清除的污漬或損壞，將視情況從押金扣除清潔或修補費用。\n・衣服皆已專業清洗，歸還前無須自行清洗。',
        },
        products: [
          { id: 'SG001', brand: '多霏', name: '粉漾微光', size: '80', qty: 1, rent: 600, deposit: 10000, images: ['images/rose-lace.jpg'] },
          { id: 'SG002', brand: '多霏', name: '粉漾微光', size: '90', qty: 2, rent: 600, deposit: 10000, images: [] },
          { id: 'SG003', brand: '多霏', name: '粉漾微光', size: '100', qty: 1, rent: 600, deposit: 10000, images: [] },
          { id: 'SG004', brand: '多霏', name: '我的羅曼史', size: '80', qty: 1, rent: 600, deposit: 10000, images: ['images/lavender-garden.jpg'] },
          { id: 'SG005', brand: '多霏', name: '我的羅曼史', size: '90', qty: 1, rent: 600, deposit: 10000, images: [] },
          { id: 'SG006', brand: '多霏', name: '我的羅曼史', size: '110', qty: 1, rent: 600, deposit: 10000, images: [] },
        ],
        bookings: merged,
      };
    }
    if (req.action === 'order') {
      const items = req.items.map(byId);
      const taken = items.filter(p => !isFree(p.id, req.startDate));
      if (taken.length) return { ok: false, error: `很抱歉，${taken.map(p => '「' + fullName(p) + '」').join('、')}在這段期間剛好被預約了。` };
      const rentTotal = items.reduce((a, p) => a + p.rent, 0);
      const depositTotal = items.reduce((a, p) => a + p.deposit, 0);
      const order = {
        no: 'SG' + t.slice(5).replace(/-/g, '') + '-' + Array.from({ length: 4 }, () => '23456789ABCDEFGHJKMNPQRSTUVWXYZ'[Math.floor(Math.random() * 31)]).join(''),
        status: '待付款', startDate: req.startDate, endDate: endOf(req.startDate),
        items: items.map(p => ({ id: p.id, brand: p.brand, name: p.name, size: p.size, rent: p.rent, deposit: p.deposit })),
        rentTotal, depositTotal, shipping: 0, total: rentTotal + depositTotal,
        deadline: new Date(Date.now() + 24 * 36e5).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }),
        name: req.customer.name, phone: req.customer.phone, addon: '', remit: null,
      };
      demoOrders.push(order);
      return { ok: true, order, bank: DEMO_BANK };
    }
    const digits = x => String(x || '').replace(/\D/g, '');
    if (req.action === 'report') {
      const o = demoOrders.find(x => sameNo(x.no, req.orderNo) && digits(x.phone) === digits(req.phone));
      if (!o) return { ok: false, error: '查不到這筆訂單' };
      o.remit = Object.assign({ confirmed: false }, req.remit);
      o.payNote = '';
      return { ok: true };
    }
    // 跟正式後台一樣：要電話＋訂單編號都對，姓名、電話遮掉一部分
    const o = demoOrders.find(x => sameNo(x.no, req.no) && digits(x.phone) === digits(req.phone));
    if (!o) return { ok: false, error: `查不到這筆訂單，請確認訂單編號與手機號碼。（示範模式可以試試 0912345678＋${demoOrders[1].no}）` };
    const mask = n => n.length <= 1 ? n : n.length === 2 ? n[0] + '*' : n[0] + '*'.repeat(n.length - 2) + n[n.length - 1];
    const ph = digits(o.phone);
    const view = Object.assign({}, o, {
      name: mask(o.name), phone: ph.slice(0, 4) + '-***-' + ph.slice(-3),
      remit: o.remit && Object.assign({}, o.remit, { name: mask(o.remit.name) }),
    });
    return { ok: true, orders: [view], bank: DEMO_BANK };
  }

  init();
})();
