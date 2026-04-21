(() => {
  // ── Navigation redirect ───────────────────────────────────────────────────
  function tryRedirect() {
    const raw = window.location.hash.slice(1);
    if (!raw) return false;

    const qIdx = raw.indexOf('?');
    if (qIdx === -1) return false;

    const siteFragment = raw.slice(0, qIdx);
    const params = new URLSearchParams(raw.slice(qIdx + 1));
    const direction = params.get('nav');
    if (!direction || !siteFragment) return false;

    const normalize = (u) =>
      u.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();

    const needle = normalize(siteFragment);
    const idx = SITES.findIndex((s) => normalize(s.url) === needle);
    if (idx === -1) return false;

    const total = SITES.length;
    const target =
      direction === 'next'
        ? SITES[(idx + 1) % total]
        : SITES[(idx - 1 + total) % total];

    window.location.replace(target.url);
    return true;
  }

  if (tryRedirect()) return;

  // ── Seeded PRNG (mulberry32) ──────────────────────────────────────────────
  function makePrng(seed) {
    let s = seed;
    return function () {
      s |= 0; s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ── Setup ─────────────────────────────────────────────────────────────────
  const svg      = document.getElementById('ring-svg');
  const infoCard = document.getElementById('info-card');
  const counter  = document.getElementById('ring-counter');
  const controls = document.getElementById('ring-controls');
  const zoomHint = document.getElementById('zoom-hint');
  const NS  = 'http://www.w3.org/2000/svg';
  const TAU = Math.PI * 2;

  const BASE = window.location.href.split('#')[0].replace(/\/?$/, '');

  let scale = 1;
  let panX  = 0;
  let panY  = 0;
  let selectedIdx = -1;
  let isDragging  = false;
  let dragStart   = { x: 0, y: 0, panX: 0, panY: 0 };
  let panRafId = null;

  // Filter state
  let searchQuery   = '';
  let filterType    = '';
  let filterCountry = '';

  // ── SVG layers: lines → dots → labels ────────────────────────────────────
  const gLines  = makeSvgEl('g');
  const gDots   = makeSvgEl('g');
  const gLabels = makeSvgEl('g');
  svg.append(gLines, gDots, gLabels);

  // ── Force-directed layout — runs once, result cached forever ─────────────
  // Uses seeded random starting positions + Fruchterman-Reingold forces.
  // Returns normalised coords in [-1, 1] space; getPositions scales to actual r.
  let _cachedLayout = null;

  function computeLayout() {
    const n    = SITES.length;
    const rand = makePrng(0xDEBA7F);

    // Seeded random start — uniform distribution inside unit disc
    const px = new Float32Array(n);
    const py = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a    = rand() * TAU;
      const dist = Math.sqrt(rand()) * 0.82;
      px[i] = dist * Math.cos(a);
      py[i] = dist * Math.sin(a);
    }

    // Repulsion-only layout: nodes spread into an organic cloud (no ring attraction)
    const k    = Math.sqrt(Math.PI / n) * 1.35;
    const ITER = 120;

    for (let it = 0; it < ITER; it++) {
      const fx = new Float32Array(n);
      const fy = new Float32Array(n);

      // Repulsion between every pair
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const dx = px[i] - px[j];
          const dy = py[i] - py[j];
          const d  = Math.sqrt(dx * dx + dy * dy) || 1e-4;
          const f  = (k * k) / d;
          fx[i] += (dx / d) * f;  fy[i] += (dy / d) * f;
          fx[j] -= (dx / d) * f;  fy[j] -= (dy / d) * f;
        }
      }

      // Soft center pull keeps the cloud from flying apart
      for (let i = 0; i < n; i++) {
        fx[i] -= px[i] * 0.07;
        fy[i] -= py[i] * 0.07;
      }

      const temp = 0.12 * (1 - it / ITER);
      for (let i = 0; i < n; i++) {
        const mag  = Math.sqrt(fx[i] * fx[i] + fy[i] * fy[i]) || 1;
        const disp = Math.min(mag, temp);
        px[i] += (fx[i] / mag) * disp;
        py[i] += (fy[i] / mag) * disp;
      }
    }

    // Nearest-neighbour TSP: reorder positions so consecutive ring nodes land close
    const visited = new Uint8Array(n);
    const order   = new Int32Array(n);
    order[0]      = 0;
    visited[0]    = 1;
    for (let step = 1; step < n; step++) {
      const cur = order[step - 1];
      let best = -1, bestD = Infinity;
      for (let j = 0; j < n; j++) {
        if (visited[j]) continue;
        const dx = px[cur] - px[j], dy = py[cur] - py[j];
        const d  = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = j; }
      }
      order[step]   = best;
      visited[best] = 1;
    }

    // Normalize so the outermost node sits at exactly radius 0.85 — makes the
    // radius multiplier in getPositions a reliable fraction of the panel size.
    let maxR = 0;
    for (let i = 0; i < n; i++) {
      const d = Math.sqrt(px[order[i]] * px[order[i]] + py[order[i]] * py[order[i]]);
      if (d > maxR) maxR = d;
    }
    const norm = 0.85 / (maxR || 1);

    // Ring node i gets the position at order[i]
    return Array.from({ length: n }, (_, i) => ({ x: px[order[i]] * norm, y: py[order[i]] * norm }));
  }

  // At scale=1 the outermost node (at normalised radius 0.85) sits exactly
  // min(w,h)/2 - NODE_PAD pixels from centre — no guesswork multiplier needed.
  const NODE_PAD = 56; // pixels of breathing room for labels at fit-view

  function fitRadius(w, h) {
    return (Math.min(w, h) / 2 - NODE_PAD) / 0.85;
  }

  function getPositions(cx, cy, w, h) {
    if (!_cachedLayout) _cachedLayout = computeLayout();
    const r = fitRadius(w, h) * scale;
    return _cachedLayout.map(p => ({ x: cx + p.x * r, y: cy + p.y * r }));
  }

  // ── Build SVG elements ────────────────────────────────────────────────────
  const lines    = [];
  const dots     = [];
  const labels   = [];
  const siteRows = [];

  SITES.forEach((site, i) => {
    const line = makeSvgEl('line', { class: 'ring-line' });
    gLines.appendChild(line);
    lines.push(line);

    const dot = makeSvgEl('circle', { class: 'ring-dot', r: 4 });
    dot.addEventListener('click',      () => selectSite(i, true));
    dot.addEventListener('mouseenter', () => hoverSite(i, true));
    dot.addEventListener('mouseleave', () => hoverSite(i, false));
    gDots.appendChild(dot);
    dots.push(dot);

    const label = makeSvgEl('text', { class: 'ring-label' });
    label.textContent = site.name.split(' ')[0];
    label.addEventListener('click',      () => selectSite(i, true));
    label.addEventListener('mouseenter', () => hoverSite(i, true));
    label.addEventListener('mouseleave', () => hoverSite(i, false));
    gLabels.appendChild(label);
    labels.push(label);
  });

  // ── Layout ────────────────────────────────────────────────────────────────
  function getSvgSize() {
    const r = svg.getBoundingClientRect();
    return {
      w: r.width  || svg.clientWidth  || window.innerWidth  * 0.58,
      h: r.height || svg.clientHeight || window.innerHeight,
    };
  }

  function layout() {
    const { w, h } = getSvgSize();
    const cx = w / 2 + panX;
    const cy = h / 2 + panY;
    const pos = getPositions(cx, cy, w, h);
    const n = SITES.length;

    pos.forEach((p, i) => {
      const next = pos[(i + 1) % n];

      lines[i].setAttribute('x1', p.x);
      lines[i].setAttribute('y1', p.y);
      lines[i].setAttribute('x2', next.x);
      lines[i].setAttribute('y2', next.y);

      dots[i].setAttribute('cx', p.x);
      dots[i].setAttribute('cy', p.y);
      dots[i].setAttribute('r', i === selectedIdx ? 6.5 : 4);

      const dx = p.x - cx, dy = p.y - cy;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const lx = p.x + (dx / len) * 18;
      const ly = p.y + (dy / len) * 18;
      labels[i].setAttribute('x', lx);
      labels[i].setAttribute('y', ly);

      const sin = Math.abs(Math.sin(Math.atan2(dy, dx)));
      labels[i].setAttribute('dy', sin > 0.5 ? (dy > 0 ? '1em' : '-0.3em') : '0.35em');

      if (dx > 15)       labels[i].setAttribute('text-anchor', 'start');
      else if (dx < -15) labels[i].setAttribute('text-anchor', 'end');
      else               labels[i].setAttribute('text-anchor', 'middle');
    });

    // Card and connector track the selected node during pan/zoom
    if (selectedIdx !== -1 && !infoCard.classList.contains('hidden')) {
      repositionCard(selectedIdx);
    }
  }

  // ── Animated pan to centre a node ────────────────────────────────────────
  function animatePanTo(targetX, targetY, onDone) {
    if (panRafId) cancelAnimationFrame(panRafId);
    const startX = panX, startY = panY;
    const dx = targetX - startX, dy = targetY - startY;
    const duration = 650;
    const startTime = performance.now();

    function step(now) {
      const t    = Math.min(1, (now - startTime) / duration);
      const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      panX = startX + dx * ease;
      panY = startY + dy * ease;
      layout();
      if (t < 1) {
        panRafId = requestAnimationFrame(step);
      } else {
        panRafId = null;
        if (onDone) onDone();
      }
    }
    panRafId = requestAnimationFrame(step);
  }

  function centerOnNode(i, onDone) {
    const { w, h } = getSvgSize();
    const natural = getPositions(w / 2, h / 2, w, h);
    animatePanTo(w / 2 - natural[i].x, h / 2 - natural[i].y, onDone);
  }

  // ── Selection ─────────────────────────────────────────────────────────────
  function selectSite(i, animateToNode) {
    selectedIdx = i;
    dots.forEach((d, j)     => d.classList.toggle('selected', j === i));
    labels.forEach((l, j)   => l.classList.toggle('selected', j === i));
    siteRows.forEach((r, j) => r.classList.toggle('active', j === i));
    updateLines();
    updateCounter();
    applyDimming();
    siteRows[i]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    if (animateToNode) {
      showCard(i);
      centerOnNode(i);
    } else {
      layout();
      showCard(i);
    }
  }

  function hoverSite(i, on) {
    if (i === selectedIdx) return;
    dots[i].classList.toggle('hovered', on);
    labels[i].classList.toggle('hovered', on);
  }

  function updateLines() {
    const n = SITES.length;
    lines.forEach((l, i) => {
      const active = selectedIdx !== -1 &&
        (i === selectedIdx || i === (selectedIdx - 1 + n) % n);
      l.classList.toggle('active', active);
    });
  }

  function updateCounter() {
    counter.textContent = selectedIdx === -1
      ? `${SITES.length} sites`
      : `${selectedIdx + 1} / ${SITES.length}`;
    controls.classList.toggle('has-selection', selectedIdx !== -1);
  }

  // ── Dimming: selection mode greys all but selected+neighbours ─────────────
  function computeVisible() {
    const n = SITES.length;
    if (selectedIdx !== -1) {
      const sel = new Set([
        selectedIdx,
        (selectedIdx - 1 + n) % n,
        (selectedIdx + 1) % n,
      ]);
      return SITES.map((_, i) => sel.has(i));
    }
    // No selection — apply filter
    const anyFilter = searchQuery || filterType || filterCountry;
    if (!anyFilter) return SITES.map(() => true);
    const matched = new Set(
      SITES.map((s, i) => siteMatches(s) ? i : -1).filter(i => i !== -1)
    );
    return SITES.map((_, i) => matched.has(i));
  }

  function applyDimming() {
    const n = SITES.length;
    const vis = computeVisible();
    dots.forEach((d, i)     => d.classList.toggle('dimmed', !vis[i]));
    labels.forEach((l, i)   => l.classList.toggle('dimmed', !vis[i]));
    lines.forEach((l, i)    => l.classList.toggle('dimmed', !vis[i] || !vis[(i + 1) % n]));
    siteRows.forEach((r, i) => r.classList.toggle('dimmed', !vis[i]));
  }

  // ── Info card ─────────────────────────────────────────────────────────────
  const TYPE_LABELS = {
    website:    'website',
    newsletter: 'newsletter',
    substack:   'newsletter',
    youtube:    'youtube',
    podcast:    'podcast',
    other:      'content',
  };

  const TYPE_CLASS = {
    website:    'type-website',
    newsletter: 'type-newsletter',
    substack:   'type-newsletter',
    youtube:    'type-youtube',
    podcast:    'type-podcast',
    other:      'type-other',
  };

  // Positions the card above/below the node and updates the connector line
  function repositionCard(i) {
    const svgRect = svg.getBoundingClientRect();
    const dotCx = parseFloat(dots[i].getAttribute('cx') || '0');
    const dotCy = parseFloat(dots[i].getAttribute('cy') || '0');
    const nodeX = svgRect.left + dotCx;
    const nodeY = svgRect.top  + dotCy;

    const cW         = Math.min(300, svgRect.width - 24);
    const cH         = 220;
    const margin     = 12;
    const nodeR      = 24; // clearance beyond the selected dot radius
    const bottomSafe = window.innerHeight - 90;

    // Card must be entirely above or below the node — never overlapping it
    const spaceAbove = nodeY - svgRect.top - margin;
    const spaceBelow = bottomSafe - nodeY - margin;

    let top;
    if (spaceAbove >= cH + nodeR || spaceAbove >= spaceBelow) {
      // Place card above: bottom edge = nodeY - nodeR
      top = Math.max(svgRect.top + margin, nodeY - nodeR - cH);
    } else {
      // Place card below: top edge = nodeY + nodeR
      top = Math.min(bottomSafe - cH, nodeY + nodeR);
    }

    let left = nodeX - cW / 2;
    left = Math.max(svgRect.left + margin, Math.min(window.innerWidth - cW - margin, left));

    infoCard.style.left   = left + 'px';
    infoCard.style.top    = top  + 'px';
    infoCard.style.bottom = 'auto';

  }

  function showCard(i) {
    const site = SITES[i];

    document.getElementById('card-name').textContent = site.name;

    const typeEl = document.getElementById('card-type');
    typeEl.textContent = TYPE_LABELS[site.type] || site.type || 'website';
    typeEl.className   = `card-type ${TYPE_CLASS[site.type] || ''}`;

    const parts = [site.club, site.location].filter(Boolean);
    document.getElementById('card-meta').textContent = parts.join(' · ');
    document.getElementById('card-description').textContent = site.description || '';

    const visitLink = document.getElementById('card-visit');
    visitLink.href = site.url;
    const hostname = (() => { try { return new URL(site.url).hostname; } catch { return site.url; } })();
    visitLink.textContent = `visit ${hostname} →`;

    repositionCard(i);
    infoCard.classList.remove('hidden');
  }

  function hideCard() {
    infoCard.classList.add('hidden');
    selectedIdx = -1;
    dots.forEach((d)     => { d.classList.remove('selected'); d.setAttribute('r', 4); });
    labels.forEach((l)   => l.classList.remove('selected'));
    siteRows.forEach((r) => r.classList.remove('active'));
    updateLines();
    updateCounter();
    applyDimming();
    layout();
  }

  document.getElementById('card-close').addEventListener('click', hideCard);

  // ── Prev / Next buttons ───────────────────────────────────────────────────
  document.getElementById('prev-btn').addEventListener('click', () => {
    const n = SITES.length;
    selectSite(selectedIdx === -1 ? n - 1 : (selectedIdx - 1 + n) % n, true);
  });

  document.getElementById('next-btn').addEventListener('click', () => {
    const n = SITES.length;
    selectSite(selectedIdx === -1 ? 0 : (selectedIdx + 1) % n, true);
  });

  // ── Zoom ──────────────────────────────────────────────────────────────────
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    scale = Math.max(0.05, Math.min(5, scale * (e.deltaY < 0 ? 1.1 : 0.91)));
    layout();
    dismissHint();
  }, { passive: false });

  // ── Pan ───────────────────────────────────────────────────────────────────
  svg.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (panRafId) { cancelAnimationFrame(panRafId); panRafId = null; }
    isDragging = true;
    dragStart  = { x: e.clientX, y: e.clientY, panX, panY };
    svg.style.cursor = 'grabbing';
    dismissHint();
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    panX = dragStart.panX + (e.clientX - dragStart.x);
    panY = dragStart.panY + (e.clientY - dragStart.y);
    layout();
  });

  window.addEventListener('mouseup', () => {
    isDragging = false;
    svg.style.cursor = 'grab';
  });

  let lastTouch = null;
  svg.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1)
      lastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY, panX, panY };
  }, { passive: true });

  svg.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 1 || !lastTouch) return;
    e.preventDefault();
    panX = lastTouch.panX + (e.touches[0].clientX - lastTouch.x);
    panY = lastTouch.panY + (e.touches[0].clientY - lastTouch.y);
    layout();
    dismissHint();
  }, { passive: false });

  svg.addEventListener('touchend', () => { lastTouch = null; });

  window.addEventListener('resize', layout);

  // ── Hint ──────────────────────────────────────────────────────────────────
  function dismissHint() {
    zoomHint.classList.add('fade');
  }

  // ── Filter / Search ───────────────────────────────────────────────────────
  function getCountry(loc) {
    if (!loc) return '';
    const parts = loc.split(',');
    return parts[parts.length - 1].trim();
  }

  const COUNTRY_CODES = {
    'Afghanistan':'AF','Albania':'AL','Algeria':'DZ','Argentina':'AR','Armenia':'AM',
    'Australia':'AU','Austria':'AT','Azerbaijan':'AZ','Bangladesh':'BD','Belgium':'BE',
    'Bolivia':'BO','Bosnia':'BA','Brazil':'BR','Bulgaria':'BG','Cambodia':'KH',
    'Canada':'CA','Chile':'CL','China':'CN','Colombia':'CO','Croatia':'HR',
    'Cyprus':'CY','Czech Republic':'CZ','Denmark':'DK','Ecuador':'EC','Egypt':'EG',
    'Estonia':'EE','Ethiopia':'ET','Finland':'FI','France':'FR','Georgia':'GE',
    'Germany':'DE','Ghana':'GH','Greece':'GR','Hong Kong':'HK','Hungary':'HU',
    'Iceland':'IS','India':'IN','Indonesia':'ID','Iran':'IR','Ireland':'IE',
    'Israel':'IL','Italy':'IT','Japan':'JP','Jordan':'JO','Kazakhstan':'KZ',
    'Kenya':'KE','Latvia':'LV','Lebanon':'LB','Lithuania':'LT','Luxembourg':'LU',
    'Malaysia':'MY','Mexico':'MX','Morocco':'MA','Netherlands':'NL','New Zealand':'NZ',
    'Nigeria':'NG','North Macedonia':'MK','Norway':'NO','Pakistan':'PK','Peru':'PE',
    'Philippines':'PH','Poland':'PL','Portugal':'PT','Romania':'RO','Russia':'RU',
    'Saudi Arabia':'SA','Serbia':'RS','Singapore':'SG','Slovakia':'SK',
    'Slovenia':'SI','South Africa':'ZA','South Korea':'KR','Spain':'ES',
    'Sri Lanka':'LK','Sweden':'SE','Switzerland':'CH','Taiwan':'TW','Thailand':'TH',
    'Tunisia':'TN','Turkey':'TR','Türkiye':'TR','UAE':'AE',
    'United Arab Emirates':'AE','United Kingdom':'GB','United States':'US',
    'UK':'GB','USA':'US','Uganda':'UG','Ukraine':'UA','Uruguay':'UY',
    'Vietnam':'VN','Zimbabwe':'ZW',
  };

  function countryFlag(name) {
    const code = COUNTRY_CODES[name];
    if (!code) return '';
    return code.toUpperCase().split('').map(c =>
      String.fromCodePoint(c.charCodeAt(0) - 65 + 0x1F1E6)
    ).join('');
  }

  function siteMatches(site) {
    const q = searchQuery.toLowerCase();
    if (q && !site.name.toLowerCase().includes(q) && !site.url.toLowerCase().includes(q)) return false;
    if (filterType && site.type !== filterType) return false;
    if (filterCountry && getCountry(site.location) !== filterCountry) return false;
    return true;
  }

  // ── Site list (left panel) ────────────────────────────────────────────────
  function buildList() {
    const locationPanel = document.querySelector('#filter-location .custom-select-panel');
    if (locationPanel) {
      const countries = [...new Set(
        SITES.map(s => getCountry(s.location)).filter(Boolean)
      )].sort();
      countries.forEach(c => {
        const opt = document.createElement('div');
        opt.className = 'custom-select-option';
        opt.dataset.value = c;
        opt.setAttribute('role', 'option');
        const flag = countryFlag(c);
        opt.textContent = flag ? `${flag} ${c}` : c;
        locationPanel.appendChild(opt);
      });
    }

    const list = document.getElementById('site-list');
    if (!list) return;

    SITES.forEach((site, i) => {
      const row = document.createElement('div');
      row.className = 'site-row';
      const typeLabel = TYPE_LABELS[site.type] || site.type || 'website';
      const typeClass = TYPE_CLASS[site.type] || '';
      const country = getCountry(site.location);
      const flag = countryFlag(country) || country;
      const flagHtml = flag ? `<span class="site-row-flag">${flag}</span> ` : '';
      const meta = flagHtml + (site.club || '');
      const hostname = (() => { try { return new URL(site.url).hostname; } catch { return site.url; } })();

      row.innerHTML =
        `<div class="site-row-main">` +
          `<span class="site-row-name">${site.name}</span>` +
          `<span class="site-row-type ${typeClass}">${typeLabel}</span>` +
        `</div>` +
        `<div class="site-row-sub">` +
          `<span class="site-row-location">${meta}</span>` +
          `<a class="site-row-url" href="${site.url}" target="_blank" rel="noopener">${hostname}</a>` +
        `</div>`;

      row.addEventListener('click', (e) => {
        if (e.target.classList.contains('site-row-url')) return;
        selectSite(i, true);
      });

      list.appendChild(row);
      siteRows.push(row);
    });

    document.getElementById('search-input')?.addEventListener('input', e => {
      searchQuery = e.target.value.trim();
      applyDimming();
    });
  }

  function initCustomSelects() {
    document.querySelectorAll('.custom-select').forEach(select => {
      const trigger = select.querySelector('.custom-select-trigger');
      const panel   = select.querySelector('.custom-select-panel');

      trigger.addEventListener('click', e => {
        e.stopPropagation();
        const isOpen = select.classList.contains('open');
        document.querySelectorAll('.custom-select.open').forEach(s => {
          s.classList.remove('open');
          s.querySelector('.custom-select-trigger').setAttribute('aria-expanded', 'false');
        });
        if (!isOpen) {
          select.classList.add('open');
          trigger.setAttribute('aria-expanded', 'true');
        }
      });

      panel.addEventListener('click', e => {
        const option = e.target.closest('.custom-select-option');
        if (!option) return;
        const value = option.dataset.value;
        panel.querySelectorAll('.custom-select-option').forEach(o => o.classList.remove('selected'));
        option.classList.add('selected');
        trigger.querySelector('.custom-select-label').textContent = option.textContent;
        select.classList.remove('open');
        trigger.setAttribute('aria-expanded', 'false');
        if (select.id === 'filter-type')     { filterType    = value; }
        if (select.id === 'filter-location') { filterCountry = value; }
        applyDimming();
      });
    });

    document.addEventListener('click', () => {
      document.querySelectorAll('.custom-select.open').forEach(s => {
        s.classList.remove('open');
        s.querySelector('.custom-select-trigger').setAttribute('aria-expanded', 'false');
      });
    });
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  updateCounter();
  layout();
  buildList();
  initCustomSelects();

  // ── Helpers ───────────────────────────────────────────────────────────────
  function makeSvgEl(tag, attrs = {}) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }
})();
