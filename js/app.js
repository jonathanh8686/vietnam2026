/* Vietnam '26 — renders every page from two data files:
 *   data/trip.json     curated facts (stays, people, places, day titles)
 *   notion.json        plans + to-dos exported from Joyce's Notion page.
 *                      data/live/notion.json is refreshed every few minutes on
 *                      the server; data/notion.json is the committed fallback.
 * Add ?date=2026-11-24 to any URL to preview the site as of that day.
 */
(function () {
  'use strict';

  var page = document.body.getAttribute('data-page');
  var params = new URLSearchParams(location.search);

  // ---------- tiny DOM helper ----------
  function h(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : v);
      });
    }
    for (var i = 2; i < arguments.length; i++) append(node, arguments[i]);
    return node;
  }
  function append(node, child) {
    if (child == null || child === false) return;
    if (Array.isArray(child)) child.forEach(function (c) { append(node, c); });
    else node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }

  // ---------- dates (all trip dates are Vietnam calendar dates) ----------
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function parseISO(d) { var p = d.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); }
  function fmtDay(d) { var x = parseISO(d); return MONTHS[x.getUTCMonth()] + ' ' + x.getUTCDate(); }
  function weekday(d) { return WEEKDAYS[parseISO(d).getUTCDay()]; }
  function daysBetween(a, b) { return Math.round((parseISO(b) - parseISO(a)) / 864e5); }

  function nowDate() {
    var o = params.get('date');
    return o && /^\d{4}-\d{2}-\d{2}$/.test(o) ? new Date(o + 'T12:00:00+07:00') : new Date();
  }
  function dateIn(tz, when) {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(when);
    } catch (e) {
      return new Date(when.getTime() + 7 * 36e5).toISOString().slice(0, 10); // UTC+7, no DST
    }
  }

  // ---------- data ----------
  function getJSON(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error(url + ' ' + r.status);
      return r.json();
    });
  }
  function load() {
    var notion = getJSON('data/live/notion.json').catch(function () { return getJSON('data/notion.json'); })
      .catch(function () { return { todos: [], itinerary: [], fetchedAt: null, failed: true }; });
    return Promise.all([getJSON('data/trip.json'), notion]);
  }

  // ---------- Notion rich text ----------
  function plain(segs) { return (segs || []).map(function (s) { return s.t; }).join('').trim(); }
  function segsNodes(segs, opts) {
    opts = opts || {};
    var out = [], first = true;
    (segs || []).forEach(function (s) {
      var t = s.t;
      if (first && opts.capitalize) { t = t.replace(/^\s+/, ''); t = t.charAt(0).toUpperCase() + t.slice(1); }
      if (!t) return;
      first = false;
      var node;
      if (s.href) {
        var label = t;
        if (/^https?:\/\//.test(t.trim())) {
          try { label = new URL(t.trim()).hostname.replace(/^www\./, ''); } catch (e) { /* keep */ }
        }
        node = h('a', { href: s.href, target: '_blank', rel: 'noopener' }, label + ' ↗');
      } else {
        node = document.createTextNode(t);
      }
      out.push(s.b ? h('strong', null, node) : node);
    });
    return out;
  }

  // ---------- turning Notion rows into a day's plan ----------
  var DAY_PREFIX = /^\s*(hcm|hcmc|ho chi minh|saigon|hanoi)\s*-?\s*day\s*\d+\s*:?\s*(\([^)]*\)\s*)?/i;
  var KINDS = [
    ['checkout', /check-?\s?out/i, 'Check-out'],
    ['checkin', /check-?\s?in/i, 'Check-in'],
    ['fly', /\bfl(y|ight)\b|departure/i, 'Flight'],
    ['arrive', /arriv|transit/i, 'Arrival']
  ];
  function parseTime(text) {
    var m = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text);
    if (!m) return null;
    var hr = +m[1] % 12 + (m[3].toLowerCase() === 'pm' ? 12 : 0);
    return hr * 60 + (+m[2] || 0);
  }
  function toItem(row) {
    var name = (row.name || []).map(function (s) { return Object.assign({}, s); });
    var notes = row.notes || [];
    if (name.length && DAY_PREFIX.test(name[0].t)) name[0].t = name[0].t.replace(DAY_PREFIX, '');
    if (!plain(name)) { name = notes; notes = []; }
    if (!plain(name)) return null; // bare "hcm - day 2" header rows
    var nameText = plain(name), all = nameText + ' ' + plain(notes);
    var kind = null, label = null;
    for (var i = 0; i < KINDS.length; i++) {
      if (KINDS[i][1].test(nameText)) { kind = KINDS[i][0]; label = KINDS[i][2]; break; }
    }
    return {
      name: name, notes: notes, kind: kind, label: label,
      time: parseTime(all),
      maybe: /\?|\btbd\b/i.test(nameText),
      done: !!row.checked
    };
  }
  function plansByDate(notion) {
    var map = {};
    (notion.itinerary || []).forEach(function (row) {
      var it = toItem(row);
      if (!it) return;
      (map[row.date] = map[row.date] || []).push(it);
    });
    Object.keys(map).forEach(function (d) {
      var items = map[d];
      var logi = items.filter(function (i) { return i.kind; });
      var rest = items.filter(function (i) { return !i.kind; });
      logi.sort(function (a, b) { return (a.time == null ? 1e4 : a.time) - (b.time == null ? 1e4 : b.time); }); // untimed last
      map[d] = { logistics: logi, plans: rest };
    });
    return map;
  }

  // ---------- trip model ----------
  function model(trip, notion) {
    var now = nowDate();
    var today = dateIn(trip.tz, now);
    var departLocal = new Date(+trip.start.slice(0, 4), +trip.start.slice(5, 7) - 1, +trip.start.slice(8, 10));
    if (params.get('date')) departLocal = new Date(trip.start + 'T00:00:00+07:00');
    var phase = now < departLocal ? 'before' : today > trip.end ? 'after' : 'during';
    var dayIndex = Math.min(Math.max(daysBetween(trip.start, today), 0), trip.days.length - 1);
    return {
      trip: trip, notion: notion, now: now, today: today, phase: phase,
      departLocal: departLocal,
      dayIndex: dayIndex,
      plans: plansByDate(notion)
    };
  }
  function stayFor(trip, date) {
    for (var i = 0; i < trip.stays.length; i++) {
      var s = trip.stays[i];
      if (s.checkIn <= date && date < s.checkOut) return s;
    }
    return null;
  }
  function placeOf(trip, key) { return trip.places[key] || { name: key }; }

  // ---------- shared components ----------
  function mapsUrl(stay) {
    return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(stay.mapsQuery || stay.address);
  }
  function copyText(text, btn) {
    function done(ok) {
      var old = btn.textContent;
      btn.textContent = ok ? 'Copied ✓' : 'Press and hold to copy';
      setTimeout(function () { btn.textContent = old; }, 1600);
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
    } else {
      var ta = h('textarea', { readonly: true, style: 'position:fixed;opacity:0' });
      ta.value = text; document.body.appendChild(ta); ta.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) { /* ignore */ }
      ta.remove(); done(ok);
    }
  }
  var driverDialog;
  function showDriver(stay) {
    if (!driverDialog) {
      driverDialog = h('dialog', { class: 'driver', 'aria-label': 'Address for the driver' });
      document.body.appendChild(driverDialog);
      driverDialog.addEventListener('click', function (e) { if (e.target === driverDialog) driverDialog.close(); });
    }
    driverDialog.textContent = '';
    append(driverDialog, [
      h('p', { class: 'driver-ask', lang: 'vi' }, 'Vui lòng đưa tôi đến địa chỉ này:'),
      h('p', { class: 'driver-ask-en' }, 'Please take me to this address:'),
      h('p', { class: 'driver-address', lang: 'vi' }, stay.address),
      h('p', { class: 'driver-name' }, stay.name),
      h('div', { class: 'btn-row' },
        h('a', { class: 'btn', href: mapsUrl(stay), target: '_blank', rel: 'noopener' }, 'Open in Maps'),
        h('button', { class: 'btn btn-quiet', type: 'button', onclick: function () { driverDialog.close(); } }, 'Close'))
    ]);
    if (driverDialog.showModal) driverDialog.showModal(); else driverDialog.setAttribute('open', '');
  }
  function stayActions(stay) {
    return h('div', { class: 'btn-row' },
      h('a', { class: 'btn', href: mapsUrl(stay), target: '_blank', rel: 'noopener' }, 'Maps ↗'),
      h('button', { class: 'btn btn-quiet', type: 'button', onclick: function (e) { copyText(stay.address, e.currentTarget); } }, 'Copy address'),
      h('button', { class: 'btn btn-quiet', type: 'button', onclick: function () { showDriver(stay); } }, 'Show driver'));
  }
  function cityChip(trip, key, extra) {
    return h('span', { class: 'day-city ' + key }, extra || placeOf(trip, key).name);
  }

  function itemNode(it) {
    var cls = 'plan-item' + (it.kind ? ' logi logi-' + it.kind : '') + (it.maybe ? ' maybe' : '') + (it.done ? ' done' : '');
    return h('li', { class: cls },
      it.label ? h('span', { class: 'logi-tag' }, it.label) : null,
      h('span', { class: 'plan-text' },
        h('span', { class: 'plan-name' }, segsNodes(it.name, { capitalize: true })),
        it.maybe ? h('span', { class: 'maybe-tag' }, 'maybe') : null,
        plain(it.notes) ? h('span', { class: 'plan-notes' }, segsNodes(it.notes)) : null));
  }

  function dayCard(m, i, opts) {
    opts = opts || {};
    var trip = m.trip, day = trip.days[i];
    var p = m.plans[day.date] || { logistics: [], plans: [] };
    var stay = stayFor(trip, day.date);
    var isToday = m.phase === 'during' && day.date === m.today;
    var isPast = m.phase !== 'before' && day.date < m.today;
    var placeKey = day.place;
    var chipText = placeKey === 'transit' ? (i === trip.days.length - 1 ? 'Departure' : 'In transit') : null;

    var body = h('div', { class: 'day-stub-body' },
      h('div', { class: 'day-head' },
        cityChip(trip, placeKey, chipText),
        isToday ? h('span', { class: 'stamp' }, 'Today') : null),
      h(opts.compact ? 'h3' : 'h3', null, day.title),
      day.tip ? h('p', { class: 'day-tip' }, h('strong', null, 'Heads up: '), day.tip) : null,
      p.logistics.length ? h('ul', { class: 'plan-list logistics' }, p.logistics.map(itemNode)) : null,
      p.plans.length ? h('ul', { class: 'plan-list' }, p.plans.map(itemNode)) : null,
      !p.logistics.length && !p.plans.length ? h('p', { class: 'muted' }, 'Nothing planned in Notion yet.') : null,
      stay ? h('p', { class: 'day-sleep' },
        h('span', { class: 'logi-tag' }, 'Sleep'),
        h('span', null, stay.name + ' · ', h('a', { href: mapsUrl(stay), target: '_blank', rel: 'noopener' }, stay.address + ' ↗'))) : null);

    return h('article', {
      class: 'day-stub' + (isToday ? ' is-today' : '') + (isPast ? ' is-past' : ''),
      id: 'd-' + day.date
    },
      h('div', { class: 'day-stub-date' },
        h('div', { class: 'day-num' }, 'Day ' + (i + 1)),
        h('div', { class: 'day-date' }, fmtDay(day.date)),
        h('div', { class: 'day-wd' }, weekday(day.date))),
      body);
  }

  function stayCard(m, stay, opts) {
    opts = opts || {};
    var trip = m.trip;
    var nights = daysBetween(stay.checkIn, stay.checkOut);
    var current = m.phase === 'during' && stay.checkIn <= m.today && m.today < stay.checkOut;
    var past = m.phase !== 'before' && stay.checkOut < m.today;
    return h('article', { class: 'stay-card' + (current ? ' is-current' : '') + (past ? ' is-past' : '') },
      h('div', { class: 'day-head' },
        cityChip(trip, stay.place),
        current ? h('span', { class: 'stamp' }, 'Tonight') : opts.label ? h('span', { class: 'stamp stamp-quiet' }, opts.label) : null),
      h('h3', null, stay.name),
      h('p', { class: 'stay-dates' }, fmtDay(stay.checkIn) + ' → ' + fmtDay(stay.checkOut) + ' · ' + nights + (nights === 1 ? ' night' : ' nights')),
      h('p', { class: 'stay-address', lang: 'vi' }, stay.address),
      stayActions(stay),
      h('dl', { class: 'field-list' },
        h('div', null, h('dt', null, 'Check-in'), h('dd', null, weekday(stay.checkIn) + ' ' + fmtDay(stay.checkIn) + ' · ' + stay.checkInTime)),
        h('div', null, h('dt', null, 'Check-out'), h('dd', null, weekday(stay.checkOut) + ' ' + fmtDay(stay.checkOut) + ' · ' + stay.checkOutTime)),
        h('div', null, h('dt', null, 'Who'), h('dd', null, stay.who)),
        stay.note ? h('div', null, h('dt', null, 'Note'), h('dd', null, stay.note)) : null));
  }

  function syncLine(m) {
    var el = document.getElementById('sync');
    if (!el) return;
    el.textContent = '';
    var t = m.notion.fetchedAt ? new Date(m.notion.fetchedAt) : null;
    var ago = '';
    if (t) {
      var mins = Math.max(0, Math.round((Date.now() - t) / 6e4));
      ago = mins < 2 ? 'just now' : mins < 90 ? mins + ' min ago' : mins < 48 * 60 ? Math.round(mins / 60) + ' hr ago' : Math.round(mins / 1440) + ' days ago';
    }
    append(el, [
      m.notion.failed ? 'Couldn’t load plans from Notion. ' : 'Plans sync from Joyce’s Notion' + (ago ? ' · updated ' + ago : '') + ' · ',
      h('a', { href: m.trip.notionUrl, target: '_blank', rel: 'noopener' }, 'Open Notion ↗')
    ]);
  }

  // ---------- hub ----------
  function renderStatus(m) {
    var el = document.getElementById('status');
    if (!el) return;
    el.textContent = '';
    if (m.phase === 'before') {
      var units = [['days', 'Days'], ['hours', 'Hours'], ['mins', 'Mins'], ['secs', 'Secs']];
      var nums = {};
      append(el, h('div', { class: 'countdown', 'aria-label': 'Countdown to departure' },
        units.map(function (u) {
          nums[u[0]] = h('div', { class: 'num' }, '–');
          return h('div', { class: 'unit' }, nums[u[0]], h('div', { class: 'unit-label' }, u[1]));
        })));
      var tick = function () {
        var diff = m.departLocal - new Date();
        if (diff <= 0) { location.reload(); return; }
        nums.days.textContent = Math.floor(diff / 864e5);
        nums.hours.textContent = Math.floor(diff / 36e5) % 24;
        nums.mins.textContent = Math.floor(diff / 6e4) % 60;
        nums.secs.textContent = Math.floor(diff / 1e3) % 60;
      };
      tick();
      if (!params.get('date')) setInterval(tick, 1000);
    } else if (m.phase === 'during') {
      var day = m.trip.days[m.dayIndex];
      append(el, h('div', { class: 'countdown' },
        h('div', { class: 'unit' }, h('div', { class: 'num' }, String(m.dayIndex + 1)), h('div', { class: 'unit-label' }, 'Day')),
        h('div', { class: 'unit' }, h('div', { class: 'num' }, String(m.trip.days.length)), h('div', { class: 'unit-label' }, 'Of')),
        h('div', { class: 'unit unit-wide' }, h('div', { class: 'num num-text' }, placeOf(m.trip, day.place).short || ''), h('div', { class: 'unit-label' }, 'Where'))));
    } else {
      append(el, h('p', { class: 'status-line' }, 'That’s a wrap. Home safe, everyone.'));
    }
  }

  function renderToday(m) {
    var el = document.getElementById('today');
    if (!el) return;
    if (m.phase === 'after') { el.hidden = true; return; }
    var trip = m.trip, i = m.phase === 'during' ? m.dayIndex : 0;
    var day = trip.days[i];
    var stay = stayFor(trip, day.date);
    var stayLabel = 'Tonight';
    if (!stay && m.phase === 'before') { stay = trip.stays[0]; stayLabel = 'First night'; }
    var next = trip.days[i + 1];
    var nextP = next && m.plans[next.date];
    var nextFirst = nextP && (nextP.logistics[0] || nextP.plans[0]);

    el.textContent = '';
    append(el, [
      h('div', { class: 'section-head' },
        h('p', { class: 'eyebrow' }, m.phase === 'during' ? 'Today · ' + weekday(day.date) + ' ' + fmtDay(day.date) : 'First up · ' + weekday(day.date) + ' ' + fmtDay(day.date)),
        h('h2', null, m.phase === 'during' ? 'Today & tonight' : 'Where we start')),
      h('div', { class: 'today-grid' },
        h('div', { class: 'today-day' }, dayCard(m, i, { compact: true }),
          next ? h('p', { class: 'tomorrow' },
            h('span', { class: 'logi-tag' }, 'Next'),
            h('span', null, h('a', { href: 'itinerary.html#d-' + next.date }, weekday(next.date) + ' ' + fmtDay(next.date) + ': ' + next.title),
              nextFirst ? h('span', { class: 'muted' }, ' — ', segsNodes(nextFirst.name, { capitalize: true })) : null)) : null),
        h('div', { class: 'today-stay' },
          stay ? stayCard(m, stay, { label: stayLabel })
            : h('div', { class: 'stay-card stay-empty' },
              h('h3', null, i === 0 ? 'Tonight: in the air' : 'No bed tonight'),
              h('p', { class: 'muted' }, i === trip.days.length - 1 ? 'Departure day. Check-out is by 11am.' : 'Overnight travel.'))))
    ]);
  }

  function todoNode(t) {
    return h('li', { class: t.done ? 'done' : null },
      h('span', null, segsNodes(t.text, { capitalize: true })),
      t.children && t.children.length ? h('ul', { class: 'checklist sub' }, t.children.map(todoNode)) : null);
  }
  function renderTodos(m) {
    var el = document.getElementById('todos');
    if (!el) return;
    var todos = m.notion.todos || [];
    if (m.phase !== 'before' || !todos.length) { el.hidden = true; return; }
    var open = todos.filter(function (t) { return !t.done; });
    var done = todos.filter(function (t) { return t.done; });
    el.textContent = '';
    append(el, [
      h('div', { class: 'section-head' },
        h('p', { class: 'eyebrow' }, 'Before we go'),
        h('h2', null, open.length ? open.length + ' thing' + (open.length === 1 ? '' : 's') + ' left to do' : 'All set'),
        h('p', null, 'Synced from the to-do list in Notion. Tick things off there.')),
      open.length ? h('ul', { class: 'checklist' }, open.map(todoNode)) : null,
      done.length ? h('details', { class: 'done-list' },
        h('summary', null, done.length + ' done'),
        h('ul', { class: 'checklist' }, done.map(todoNode))) : null,
      m.trip.missing && m.trip.missing.length ? h('div', { class: 'missing' },
        h('h3', null, 'Info the site is still missing'),
        h('ul', null, m.trip.missing.map(function (x) { return h('li', null, x); })),
        h('p', { class: 'muted' }, 'Add it to Notion and it’ll make its way here.')) : null
    ]);
  }

  function renderMap(m) {
    var el = document.getElementById('trip-map');
    if (!el) return;
    var trip = m.trip;
    var keys = ['hcm', 'hanoi', 'ninhbinh'];
    function fallback() {
      el.classList.add('map-fallback');
      el.removeAttribute('role');
      el.textContent = '';
      append(el, h('ol', null, keys.map(function (k) {
        var p = trip.places[k];
        return h('li', null, h('strong', null, p.name), ' · ' + p.dates + ' · ' + p.blurb);
      })));
    }
    if (typeof L === 'undefined') { fallback(); return; }
    try {
      var map = L.map(el, { scrollWheelZoom: false, zoomControl: true });
      // CARTO's free basemaps now demand an API key, so use OSM's standard tiles (tinted in CSS).
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 18
      }).addTo(map);
      trip.route.forEach(function (leg) {
        var a = trip.places[leg.from], b = trip.places[leg.to];
        L.polyline([[a.lat, a.lng], [b.lat, b.lng]], leg.kind === 'daytrip'
          ? { color: '#1F5C52', weight: 2.5, dashArray: '5 7', lineCap: 'round' }
          : { color: '#1C1912', weight: 2.5, dashArray: '1 7', lineCap: 'round' }).addTo(map);
      });
      var labels = { hcm: '1', hanoi: '2', ninhbinh: '↻' };
      var dirs = { hcm: 'right', hanoi: 'left', ninhbinh: 'right' };
      keys.forEach(function (k) {
        var p = trip.places[k];
        var icon = L.divIcon({
          className: '',
          html: '<div class="trip-pin ' + k + '"><span class="trip-pin-num">' + labels[k] + '</span></div>',
          iconSize: [22, 22], iconAnchor: [11, 11], popupAnchor: [0, -12]
        });
        var popup = h('div', null, h('p', { class: 'popup-city' }, p.name), h('p', { class: 'popup-meta' }, p.dates + ' · ' + p.blurb));
        L.marker([p.lat, p.lng], { icon: icon, title: p.name }).addTo(map).bindPopup(popup)
          .bindTooltip(p.name, { permanent: true, direction: dirs[k], offset: dirs[k] === 'left' ? [-14, 0] : [14, 0], className: 'trip-label' });
      });
      map.fitBounds(keys.map(function (k) { return [trip.places[k].lat, trip.places[k].lng]; }), { padding: [40, 40] });
      el.addEventListener('click', function () { map.scrollWheelZoom.enable(); });
      el.addEventListener('mouseleave', function () { map.scrollWheelZoom.disable(); });
    } catch (e) {
      fallback();
    }
  }

  // ---------- pages ----------
  function renderItinerary(m) {
    var el = document.getElementById('days');
    if (!el) return;
    el.textContent = '';
    m.trip.days.forEach(function (_, i) { el.appendChild(dayCard(m, i)); });
    var jump = document.getElementById('jump-today');
    if (m.phase === 'during') {
      var target = document.getElementById('d-' + m.today);
      if (jump && target) {
        jump.hidden = false;
        jump.addEventListener('click', function () { target.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
      }
      if (target && !location.hash) setTimeout(function () { target.scrollIntoView({ block: 'start' }); }, 50);
    }
    if (location.hash) {
      var t = document.getElementById(location.hash.slice(1));
      if (t) setTimeout(function () { t.scrollIntoView({ block: 'start' }); }, 50);
    }
  }

  function renderStays(m) {
    var el = document.getElementById('stays');
    if (!el) return;
    el.textContent = '';
    m.trip.stays.forEach(function (s) { el.appendChild(stayCard(m, s)); });
  }

  function fail(err) {
    var main = document.querySelector('main');
    if (main) {
      main.insertBefore(h('div', { class: 'wrap' }, h('p', { class: 'load-error' },
        'Couldn’t load the trip data (' + err.message + '). If you’re offline, open the site once while online so it can save a copy.')), main.firstChild);
    }
  }

  load().then(function (res) {
    var m = model(res[0], res[1]);
    document.documentElement.setAttribute('data-phase', m.phase);
    syncLine(m);
    if (page === 'hub') { renderStatus(m); renderToday(m); renderTodos(m); renderMap(m); }
    if (page === 'itinerary') renderItinerary(m);
    if (page === 'stays') renderStays(m);
  }).catch(fail);

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(function () { /* offline cache is a bonus */ });
  }
})();
