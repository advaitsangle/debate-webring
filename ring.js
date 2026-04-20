(() => {
  // ── Navigation redirect ───────────────────────────────────────────────────
  // Handles: debate-webring.com/#theirsite.com?nav=next
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

  // ── Seeded PRNG (mulberry32) — deterministic organic positions ─────────────
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
  const svg = document.getElementById('ring-svg');
  const infoCard = document.getElementById('info-card');
  const counter = document.getElementById('ring-counter');
  const zoomHint = document.getElementById('zoom-hint');
  const NS = 'http://www.w3.org/2000/svg';
  const TAU = Math.PI * 2;

  let scale = 1;
  let panX = 0;
  let panY = 0;
  let selectedIdx = -1;
  let isDragging = false;
  let dragStart = { x: 0, y: 0, panX: 0, panY: 0 };
  let hintTimer;

  // SVG layer order: lines → dots → labels
  const gLines  = makeSvgEl('g');
  const gDots   = makeSvgEl('g');
  const gLabels = makeSvgEl('g');
  svg.append(gLines, gDots, gLabels);

  // ── Constellation positions ───────────────────────────────────────────────
  function getPositions(cx, cy, r) {
    const n = SITES.length;
    if (n <= 15) {
      // Ring layout with organic jitter for small counts
      const rand = makePrng(0xDEBA7E);
      return SITES.map((_, i) => {
        const baseAngle   = (i / n) * TAU - TAU / 4;
        const angleJitter = (rand() - 0.5) * 0.28;
        const radiusScale = 0.82 + rand() * 0.36;
        const angle  = baseAngle + angleJitter;
        const radius = r * radiusScale;
        return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
      });
    } else {
      // Phyllotaxis (golden angle) spiral — fills space evenly with no overlap
      const golden = Math.PI * (3 - Math.sqrt(5));
      return SITES.map((_, i) => {
        const angle  = i * golden;
        const radius = r * Math.sqrt((i + 0.5) / n);
        return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
      });
    }
  }

  function getRingRadius() {
    return Math.min(window.innerWidth, window.innerHeight) * 0.38;
  }

  // ── Build SVG elements ────────────────────────────────────────────────────
  const lines  = [];
  const dots   = [];
  const labels = [];

  SITES.forEach((site, i) => {
    const line = makeSvgEl('line', { class: 'ring-line' });
    gLines.appendChild(line);
    lines.push(line);

    const dot = makeSvgEl('circle', { class: 'ring-dot', r: 4 });
    dot.addEventListener('click',      () => selectSite(i));
    dot.addEventListener('mouseenter', () => hoverSite(i, true));
    dot.addEventListener('mouseleave', () => hoverSite(i, false));
    gDots.appendChild(dot);
    dots.push(dot);

    const label = makeSvgEl('text', { class: 'ring-label' });
    label.textContent = site.name.split(' ')[0];
    label.addEventListener('click',      () => selectSite(i));
    label.addEventListener('mouseenter', () => hoverSite(i, true));
    label.addEventListener('mouseleave', () => hoverSite(i, false));
    gLabels.appendChild(label);
    labels.push(label);
  });

  // ── Layout ────────────────────────────────────────────────────────────────
  function layout() {
    const cx = window.innerWidth  / 2 + panX;
    const cy = window.innerHeight / 2 + panY;
    const r  = getRingRadius() * scale;
    const pos = getPositions(cx, cy, r);
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

      // Label: offset outward from centre
      const dx = p.x - cx, dy = p.y - cy;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const lx = p.x + (dx / len) * 18;
      const ly = p.y + (dy / len) * 18;
      labels[i].setAttribute('x', lx);
      labels[i].setAttribute('y', ly);

      // dy baseline shift based on vertical position
      const sin = Math.abs(Math.sin(Math.atan2(dy, dx)));
      labels[i].setAttribute('dy', sin > 0.5 ? (dy > 0 ? '1em' : '-0.3em') : '0.35em');

      // text-anchor based on horizontal position
      if (dx > 15)       labels[i].setAttribute('text-anchor', 'start');
      else if (dx < -15) labels[i].setAttribute('text-anchor', 'end');
      else               labels[i].setAttribute('text-anchor', 'middle');
    });
  }

  // ── Selection ─────────────────────────────────────────────────────────────
  function selectSite(i) {
    selectedIdx = i;
    dots.forEach((d, j)   => d.classList.toggle('selected', j === i));
    labels.forEach((l, j) => l.classList.toggle('selected', j === i));
    updateLines();
    updateCounter();
    showCard(i);
    layout();
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

  function showCard(i) {
    const site = SITES[i];
    const n = SITES.length;
    const prevSite = SITES[(i - 1 + n) % n];
    const nextSite = SITES[(i + 1) % n];

    document.getElementById('card-name').textContent = site.name;
    document.getElementById('card-type').textContent =
      TYPE_LABELS[site.type] || site.type || 'website';

    const parts = [site.club, site.location].filter(Boolean);
    document.getElementById('card-meta').textContent = parts.join(' · ');
    document.getElementById('card-description').textContent = site.description || '';

    const visitLink = document.getElementById('card-visit');
    visitLink.href = site.url;
    const hostname = (() => { try { return new URL(site.url).hostname; } catch { return site.url; } })();
    visitLink.textContent = `visit ${hostname} →`;

    // Bio links
    const BASE = 'https://debate-webring.com';
    const domain = hostname;
    document.getElementById('bio-prev').href = `${BASE}/#${domain}?nav=prev`;
    document.getElementById('bio-next').href = `${BASE}/#${domain}?nav=next`;

    // Copy button
    const copyBtn = document.getElementById('btn-copy');
    copyBtn.textContent = 'copy';
    copyBtn.classList.remove('copied');
    copyBtn.onclick = () => {
      const html =
        `<a href="${BASE}/#${domain}?nav=prev">←</a> ` +
        `<a href="${BASE}">${BASE}</a> ` +
        `<a href="${BASE}/#${domain}?nav=next">→</a>`;
      navigator.clipboard.writeText(html).then(() => {
        copyBtn.textContent = 'copied';
        copyBtn.classList.add('copied');
        setTimeout(() => {
          copyBtn.textContent = 'copy';
          copyBtn.classList.remove('copied');
        }, 2000);
      });
    };

    // Position card next to the clicked node
    const nodeX = parseFloat(dots[i].getAttribute('cx') || window.innerWidth / 2);
    const nodeY = parseFloat(dots[i].getAttribute('cy') || window.innerHeight / 2);
    const cardW = Math.min(460, window.innerWidth - 32);
    const cardH = 300;
    const margin = 16;
    const offset = 28;

    let left = nodeX + offset;
    if (left + cardW > window.innerWidth - margin) {
      left = nodeX - offset - cardW;
    }
    left = Math.max(margin, left);

    let top = nodeY - cardH / 2;
    top = Math.max(margin + 56, Math.min(window.innerHeight - cardH - margin, top));

    infoCard.style.left  = left + 'px';
    infoCard.style.top   = top + 'px';
    infoCard.style.bottom = 'auto';

    infoCard.classList.remove('hidden');
  }

  function hideCard() {
    infoCard.classList.add('hidden');
    selectedIdx = -1;
    dots.forEach((d)   => { d.classList.remove('selected'); d.setAttribute('r', 4); });
    labels.forEach((l) => l.classList.remove('selected'));
    updateLines();
    updateCounter();
    layout();
  }

  document.getElementById('card-close').addEventListener('click', hideCard);

  // ── Prev / Next buttons ───────────────────────────────────────────────────
  document.getElementById('prev-btn').addEventListener('click', () => {
    const n = SITES.length;
    selectSite(selectedIdx === -1 ? n - 1 : (selectedIdx - 1 + n) % n);
  });

  document.getElementById('next-btn').addEventListener('click', () => {
    const n = SITES.length;
    selectSite(selectedIdx === -1 ? 0 : (selectedIdx + 1) % n);
  });

  // ── Zoom ──────────────────────────────────────────────────────────────────
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    scale = Math.max(0.3, Math.min(5, scale * (e.deltaY < 0 ? 1.1 : 0.91)));
    layout();
    dismissHint();
  }, { passive: false });

  // ── Pan ───────────────────────────────────────────────────────────────────
  svg.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    isDragging = true;
    dragStart = { x: e.clientX, y: e.clientY, panX, panY };
    svg.style.cursor = 'grabbing';
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

  // Touch pan
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
    clearTimeout(hintTimer);
    zoomHint.classList.add('fade');
  }
  hintTimer = setTimeout(dismissHint, 3000);

  // ── Directory listing ─────────────────────────────────────────────────────
  function buildDirectory() {
    const list = document.getElementById('directory-list');
    if (!list) return;
    SITES.forEach((site, i) => {
      const btn = document.createElement('button');
      btn.className = 'dir-entry';
      const typeLabel = TYPE_LABELS[site.type] || site.type || 'website';
      const meta = [site.club, site.location].filter(Boolean).join(' · ');
      btn.innerHTML =
        `<div class="dir-entry-top">` +
          `<span class="dir-entry-name">${site.name}</span>` +
          `<span class="dir-entry-type">${typeLabel}</span>` +
        `</div>` +
        `<div class="dir-entry-meta">${meta}</div>`;
      btn.addEventListener('click', () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        setTimeout(() => selectSite(i), 300);
      });
      list.appendChild(btn);
    });
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  updateCounter();
  layout();
  buildDirectory();

  // ── Helpers ───────────────────────────────────────────────────────────────
  function makeSvgEl(tag, attrs = {}) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }
})();
