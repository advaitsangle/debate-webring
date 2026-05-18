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

  // ── Seeded PRNG (mulberry32) — kept for deterministic pin jitter ─────────
  function makePrng(seed) {
    let s = seed;
    return function () {
      s |= 0; s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ── DOM references ───────────────────────────────────────────────────────
  const svg      = document.getElementById('ring-svg');
  const infoCard = document.getElementById('info-card');
  const counter  = document.getElementById('ring-counter');
  const controls = document.getElementById('ring-controls');
  const zoomHint = document.getElementById('zoom-hint');
  const NS       = 'http://www.w3.org/2000/svg';

  // ── State ────────────────────────────────────────────────────────────────
  let selectedIdx   = -1;
  let searchQuery   = '';
  let filterType    = '';
  let filterCountry = '';

  let projection;
  let zoomBehavior;
  let pinOffsets = [];
  const pinElems = [];
  const siteRows = [];

  // ── D3 setup ─────────────────────────────────────────────────────────────
  const svgD3 = d3.select(svg);
  let rootG, gCountries, gPins;

  // ── Tooltip element ──────────────────────────────────────────────────────
  const tooltip = document.createElement('div');
  tooltip.id = 'pin-tooltip';
  tooltip.className = 'hidden';
  document.body.appendChild(tooltip);

  // ── Type constants ───────────────────────────────────────────────────────
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

  // ── Helpers ──────────────────────────────────────────────────────────────
  function makeSvgEl(tag, attrs = {}) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }

  function getSvgSize() {
    const r = svg.getBoundingClientRect();
    return {
      w: r.width  || svg.clientWidth  || window.innerWidth  * 0.58,
      h: r.height || svg.clientHeight || window.innerHeight,
    };
  }

  function dismissHint() {
    zoomHint.classList.add('fade');
  }

  // ── Cluster jitter: only fans out pins that share exact coords ───────────
  function computeJitter() {
    const groups = new Map();
    SITES.forEach((s, i) => {
      if (s.lat == null || s.lng == null) return;
      const key = `${s.lat.toFixed(3)},${s.lng.toFixed(3)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(i);
    });
    const offsets = SITES.map(() => [0, 0]);
    groups.forEach((indices) => {
      if (indices.length === 1) return;
      const r = 9;
      indices.forEach((idx, k) => {
        const angle = (k / indices.length) * Math.PI * 2;
        offsets[idx] = [Math.cos(angle) * r, Math.sin(angle) * r];
      });
    });
    return offsets;
  }

  // ── Map + pin rendering ──────────────────────────────────────────────────
  async function renderMap() {
    svgD3.selectAll('*').remove();
    rootG       = svgD3.append('g').attr('class', 'map-root');
    gCountries  = rootG.append('g').attr('class', 'countries');
    gPins       = rootG.append('g').attr('class', 'pins');

    let topology;
    try {
      const res = await fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json');
      topology = await res.json();
    } catch (err) {
      console.error('Failed to load world atlas', err);
      return;
    }

    const land = topojson.feature(topology, topology.objects.countries);

    const { w, h } = getSvgSize();
    projection = d3.geoNaturalEarth1().fitExtent(
      [[w * 0.04, h * 0.06], [w * 0.96, h * 0.94]],
      land,
    );

    const pathGen = d3.geoPath(projection);

    gCountries
      .selectAll('path')
      .data(land.features)
      .join('path')
      .attr('class', 'country')
      .attr('d', pathGen);

    pinOffsets = computeJitter();
    pinElems.length = 0;
    drawPins();

    zoomBehavior = d3.zoom()
      .scaleExtent([1, 8])
      .on('zoom', onZoom);
    svgD3.call(zoomBehavior);

    // Restore any pre-render selection state
    applyPinClasses();
    applyDimming();
  }

  function onZoom(event) {
    rootG.attr('transform', event.transform);
    if (selectedIdx !== -1 && !infoCard.classList.contains('hidden')) {
      repositionCard(selectedIdx);
    }
    dismissHint();
  }

  function drawPins() {
    SITES.forEach((site, i) => {
      if (site.lat == null || site.lng == null) {
        pinElems.push(null);
        return;
      }
      const [px, py] = projection([site.lng, site.lat]);
      const [jx, jy] = pinOffsets[i];
      const x = px + jx;
      const y = py + jy;
      const color = site.color || '#EF3B71';

      const g = makeSvgEl('g', { class: 'pin', transform: `translate(${x},${y})` });
      g.dataset.idx = String(i);

      const halo = makeSvgEl('circle', { class: 'pin-halo', r: 9, fill: 'none' });
      halo.setAttribute('stroke', color);
      g.appendChild(halo);

      const dot = makeSvgEl('circle', { class: 'pin-dot', r: 4.5 });
      dot.setAttribute('fill', color);
      g.appendChild(dot);

      g.addEventListener('click', (e) => {
        e.stopPropagation();
        selectSite(i, true);
      });
      g.addEventListener('mouseenter', (e) => {
        hoverSite(i, true);
        showTooltip(site.name, e);
      });
      g.addEventListener('mousemove', positionTooltip);
      g.addEventListener('mouseleave', () => {
        hoverSite(i, false);
        hideTooltip();
      });

      gPins.node().appendChild(g);
      pinElems.push(g);
    });
  }

  // ── Tooltip ──────────────────────────────────────────────────────────────
  function showTooltip(text, e) {
    tooltip.textContent = text;
    tooltip.classList.remove('hidden');
    positionTooltip(e);
  }

  function positionTooltip(e) {
    tooltip.style.left = (e.clientX + 14) + 'px';
    tooltip.style.top  = (e.clientY - 8)  + 'px';
  }

  function hideTooltip() {
    tooltip.classList.add('hidden');
  }

  // Background click → deselect (pins stopPropagation; countries are pointer-events:none)
  svg.addEventListener('click', () => hideCard());

  // ── Selection ────────────────────────────────────────────────────────────
  function selectSite(i, animate) {
    selectedIdx = i;
    applyPinClasses();
    siteRows.forEach((r, j) => r.classList.toggle('active', j === i));
    updateCounter();
    siteRows[i]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    if (animate) {
      centerOnPin(i, () => showCard(i));
    } else {
      showCard(i);
    }
  }

  function applyPinClasses() {
    pinElems.forEach((p, j) => {
      if (!p) return;
      p.classList.toggle('selected', j === selectedIdx);
    });
  }

  function hoverSite(i, on) {
    if (i === selectedIdx) return;
    if (pinElems[i]) pinElems[i].classList.toggle('hovered', on);
  }

  function updateCounter() {
    counter.textContent = selectedIdx === -1
      ? `${SITES.length} sites`
      : `${selectedIdx + 1} / ${SITES.length}`;
    controls.classList.toggle('has-selection', selectedIdx !== -1);
  }

  // ── Dimming: filter mode greys non-matching rows + pins ──────────────────
  function computeVisible() {
    const anyFilter = searchQuery || filterType || filterCountry;
    if (!anyFilter) return SITES.map(() => true);
    return SITES.map(s => siteMatches(s));
  }

  function applyDimming() {
    const vis = computeVisible();
    pinElems.forEach((p, i) => { if (p) p.classList.toggle('dimmed', !vis[i]); });
    siteRows.forEach((r, i) => r.classList.toggle('dimmed', !vis[i]));
  }

  // ── Animated pan/zoom to a pin ───────────────────────────────────────────
  function centerOnPin(i, onDone) {
    if (!pinElems[i] || !zoomBehavior) { onDone?.(); return; }
    const site = SITES[i];
    const [px, py] = projection([site.lng, site.lat]);
    const [jx, jy] = pinOffsets[i];
    const x = px + jx;
    const y = py + jy;
    const { w, h } = getSvgSize();
    const current = d3.zoomTransform(svg);
    const k  = Math.max(current.k, 2.4);
    const tx = w / 2 - x * k;
    const ty = h / 2 - y * k;
    svgD3.transition().duration(700)
      .call(zoomBehavior.transform, d3.zoomIdentity.translate(tx, ty).scale(k))
      .on('end', () => onDone?.());
  }

  // ── Info card ────────────────────────────────────────────────────────────
  function repositionCard(i) {
    if (!pinElems[i]) return;
    const svgRect = svg.getBoundingClientRect();
    const m = pinElems[i].getCTM();
    if (!m) return;
    const nodeX = svgRect.left + m.e;
    const nodeY = svgRect.top  + m.f;

    const cW         = Math.min(320, svgRect.width - 24);
    const cH         = 220;
    const margin     = 12;
    const nodeR      = 24;
    const bottomSafe = window.innerHeight - 90;

    const spaceAbove = nodeY - svgRect.top - margin;
    const spaceBelow = bottomSafe - nodeY - margin;

    let top;
    if (spaceAbove >= cH + nodeR || spaceAbove >= spaceBelow) {
      top = Math.max(svgRect.top + margin, nodeY - nodeR - cH);
    } else {
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
    applyPinClasses();
    siteRows.forEach((r) => r.classList.remove('active'));
    updateCounter();
  }

  document.getElementById('card-close').addEventListener('click', hideCard);

  // ── Prev / Next ──────────────────────────────────────────────────────────
  document.getElementById('prev-btn').addEventListener('click', () => {
    const n = SITES.length;
    selectSite(selectedIdx === -1 ? n - 1 : (selectedIdx - 1 + n) % n, true);
  });

  document.getElementById('next-btn').addEventListener('click', () => {
    const n = SITES.length;
    selectSite(selectedIdx === -1 ? 0 : (selectedIdx + 1) % n, true);
  });

  // ── Filter / search helpers ──────────────────────────────────────────────
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

  // ── Site list (left panel) ───────────────────────────────────────────────
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
      if (site.color) row.style.setProperty('--row-accent', site.color);
      const typeLabel = TYPE_LABELS[site.type] || site.type || 'website';
      const typeClass = TYPE_CLASS[site.type] || '';
      const country = getCountry(site.location);
      const flag = countryFlag(country) || country;
      const flagHtml = flag ? `<span class="site-row-flag">${flag}</span> ` : '';
      const meta = flagHtml + (site.club || '');

      row.innerHTML =
        `<div class="site-row-main">` +
          `<span class="site-row-name">${site.name}</span>` +
          `<span class="site-row-type ${typeClass}">${typeLabel}</span>` +
        `</div>` +
        `<div class="site-row-sub">` +
          `<span class="site-row-location">${meta}</span>` +
        `</div>`;

      row.addEventListener('click', () => selectSite(i, true));

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

  // ── Resize ───────────────────────────────────────────────────────────────
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      renderMap();
    }, 250);
  });

  // ── Init ─────────────────────────────────────────────────────────────────
  buildList();
  initCustomSelects();
  updateCounter();
  renderMap();
})();
