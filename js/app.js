/* Vietnam '26 — renders every page from two data files:
 *   data/trip.json     curated facts (stays, people, places, day titles)
 *   notion.json        plans exported from Joyce's Notion page.
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
  // Times are minutes after midnight (Vietnam time) of the day they're listed on.
  var TIME_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/ig;
  function parseTimes(text) {
    var out = [], m;
    TIME_RE.lastIndex = 0;
    while ((m = TIME_RE.exec(text))) {
      var mins = (+m[1] % 12 + (m[3].toLowerCase() === 'pm' ? 12 : 0)) * 60 + (+m[2] || 0);
      out.push({ mins: mins, index: m.index, end: TIME_RE.lastIndex });
    }
    return out;
  }
  function parseTime(text) { var t = parseTimes(text); return t.length ? t[0].mins : null; }
  function hhmm(v) { var p = /^(\d{1,2}):(\d{2})/.exec(v || ''); return p ? +p[1] * 60 + +p[2] : null; }

  // Rough windows for items with no clock time. First match wins, so the
  // explicit "daytime:/nighttime:" prefixes Joyce uses beat activity words.
  var BANDS = [
    [/^\s*(nighttime|night|tonight)\b/i, 21 * 60, 25 * 60, 'night'],
    [/^\s*(daytime|day)\b/i, 10 * 60, 17 * 60, 'daytime'],
    [/^\s*(morning)\b/i, 8 * 60, 11 * 60, 'morning'],
    [/\bday trip\b/i, 7 * 60, 18 * 60, 'all day'],
    [/\bleave early|early morning|sunrise\b/i, 6 * 60, 9 * 60, 'early'],
    [/\b(bar|bars|nightlife|go out|club|clubs|night market)\b/i, 21 * 60, 25 * 60, 'night'],
    [/\b(sightseeing|museum|market|temple|pagoda|cathedral|boat|cave|tour|explore|walking|cafes?|boutiques?|shops?|tunnels?|lake|post office|opera)\b/i, 10 * 60, 17 * 60, 'daytime'],
    [/\b(dinner|michelin|street food)\b/i, 18 * 60, 20.5 * 60, 'evening'],
    [/\b(lunch)\b/i, 11.5 * 60, 13.5 * 60, 'lunch'],
    [/\b(breakfast|brunch|egg coffee)\b/i, 8 * 60, 10.5 * 60, 'morning'],
    [/\bafternoon\b/i, 13 * 60, 17 * 60, 'afternoon']
  ];
  function timing(row, kind, nameText, notesText) {
    var start = hhmm(row.time);
    if (start != null) {
      var e = hhmm(row.endTime);
      return { start: start, end: e != null && e > start ? e : start + 60, exact: true };
    }
    var all = nameText + ' ' + notesText;
    var ts = parseTimes(all);
    if (ts.length) {
      var s0 = ts[0].mins;
      if (s0 < 5 * 60 && kind !== 'fly' && kind !== 'checkout') s0 += 24 * 60; // "1am" means after midnight
      var between = ts[1] ? all.slice(ts[0].end, ts[1].index) : '';
      var isRange = ts[1] && ts[1].mins > ts[0].mins && (/^\s*(-|–|—|to|→|>)\s*$/i.test(between) || kind === 'fly');
      return { start: s0, end: isRange ? ts[1].mins : s0 + 60, exact: true };
    }
    for (var i = 0; i < BANDS.length; i++) {
      if (BANDS[i][0].test(i < 3 ? nameText : all)) return { start: BANDS[i][1], end: BANDS[i][2], exact: false, band: BANDS[i][3] };
    }
    return null;
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
      when: timing(row, kind, nameText, plain(notes)),
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
    if (trip.departAt) departLocal = new Date(trip.departAt); // actual first wheels-up
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
    if (stay.mapsUrl) return stay.mapsUrl;
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

  // Curated blocks with an "owner" are one person's suggested schedule layered on
  // top of the group's Notion plan, so they're drawn apart from the Notion pins.
  function ownerName(o) { return o ? o.charAt(0).toUpperCase() + o.slice(1) : ''; }
  function minePlan(day) {
    var mine = (day.events || []).filter(function (e) { return e.owner; });
    if (!mine.length) return null;
    var who = ownerName(mine[0].owner);
    return h('div', { class: 'mine-plan' },
      h('div', { class: 'mine-plan-head' },
        h('span', { class: 'src-tag mine' }, who + '’s plan'),
        h('span', { class: 'muted' }, 'Suggestions around the Notion pins'),
        day.planUrl ? h('a', { href: day.planUrl, target: '_blank', rel: 'noopener' }, 'Full plan ↗') : null),
      h('ul', { class: 'mine-list' }, mine.map(function (e) {
        var s = hhmm(e.time);
        return h('li', { class: e.fuzzy ? 'fuzzy' : null },
          h('span', { class: 'mine-time' }, (e.fuzzy ? '~' : '') + fmtClock(s)),
          h('span', { class: 'plan-text' },
            h('span', { class: 'plan-name' }, e.label),
            e.note ? h('span', { class: 'plan-notes' }, e.note) : null));
      })));
  }
  function legend(day) {
    var mine = (day.events || []).filter(function (e) { return e.owner; });
    return h('p', { class: 'cal-legend' },
      h('span', { class: 'src-tag notion' }, 'Notion'), h('span', null, 'group plan from Joyce’s Notion'),
      h('span', { class: 'src-tag mine' }, ownerName(mine[0].owner)), h('span', null, ownerName(mine[0].owner) + '’s suggested blocks'),
      day.planUrl ? h('a', { href: day.planUrl, target: '_blank', rel: 'noopener' }, 'Full plan ↗') : null);
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
      minePlan(day),
      opts.compact ? null : h('p', { class: 'day-links' },
        h('a', { class: 'hours-link', href: 'calendar.html#' + day.date }, 'Hour by hour →'),
        day.stops ? h('a', { class: 'hours-link', href: 'map.html#' + day.date }, 'Map of the day →') : null),
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
        stay.floor ? h('div', null, h('dt', null, 'Floor'), h('dd', null, stay.floor)) : null,
        stay.listingUrl ? h('div', null, h('dt', null, 'Listing'), h('dd', null, h('a', { href: stay.listingUrl, target: '_blank', rel: 'noopener' }, (stay.listingName || 'Airbnb listing') + ' ↗'))) : null,
        stay.guideUrl ? h('div', null, h('dt', null, 'Guide'), h('dd', null, h('a', { href: stay.guideUrl, target: '_blank', rel: 'noopener' }, 'Host check-in steps ↗'))) : null,
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

  // ---------- hour-by-hour calendar ----------
  function fmtClock(mins) {
    var m = ((Math.round(mins) % 1440) + 1440) % 1440, hr = Math.floor(m / 60), mm = m % 60;
    return (hr % 12 || 12) + (mm ? ':' + (mm < 10 ? '0' : '') + mm : '') + (hr < 12 ? 'am' : 'pm');
  }
  function fmtRange(ev) {
    if (!ev.exact) return '~ ' + (ev.band || 'roughly');
    if (!ev.ranged) return fmtClock(ev.start);
    var a = fmtClock(ev.start), b = fmtClock(ev.end);
    if (a.slice(-2) === b.slice(-2)) a = a.slice(0, -2);
    return a + '–' + b;
  }
  function vnMinutesNow() {
    var parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
    var hh = 0, mm = 0;
    parts.forEach(function (p) { if (p.type === 'hour') hh = +p.value % 24; if (p.type === 'minute') mm = +p.value; });
    return hh * 60 + mm;
  }
  function eventsFor(m, day) {
    var p = m.plans[day.date] || { logistics: [], plans: [] };
    var timed = [], anytime = [];
    // day.notionTimes slots an untimed Notion item into the hour view at a suggested
    // time ({"huelley rose": ["13:45", "14:35"]}). It stays a Notion pin; adding a
    // time to the row in Notion itself takes over automatically.
    var slots = day.notionTimes || {};
    p.logistics.concat(p.plans).forEach(function (it) {
      var w = it.when;
      if (!w) {
        var name = plain(it.name).toLowerCase(), key = null;
        Object.keys(slots).forEach(function (k) { if (!key && name.indexOf(k.toLowerCase()) !== -1) key = k; });
        if (key) {
          var s0 = hhmm(slots[key][0]), e0 = hhmm(slots[key][1]);
          timed.push({ item: it, start: s0, end: e0 != null ? e0 : s0 + 60, exact: false, band: fmtClock(s0), ranged: true });
          return;
        }
        anytime.push(it); return;
      }
      timed.push({ item: it, start: w.start, end: w.end, exact: w.exact, band: w.band, ranged: w.end - w.start > 60 && w.exact });
    });
    (day.events || []).forEach(function (e) {
      var s = hhmm(e.time), en = hhmm(e.end);
      timed.push({
        item: { name: [{ t: e.label }], notes: e.note ? [{ t: e.note }] : [], kind: e.kind || null, label: null, maybe: false, curated: true, owner: e.owner || null },
        start: s, end: en != null ? en : s + 60, exact: !e.fuzzy, band: e.fuzzy ? 'about ' + fmtClock(s) : null, ranged: en != null
      });
    });
    timed.sort(function (a, b) { return a.start - b.start || (b.end - b.start) - (a.end - a.start); });
    return { timed: timed, anytime: anytime };
  }
  // Side-by-side columns for overlapping blocks. Sets ev.col / ev.ncols; returns the column count.
  function layoutColumns(list) {
    var clusters = [], cur = null, most = 0;
    list.forEach(function (ev) {
      if (!cur || ev.start >= cur.end) { cur = { end: ev.end, cols: [], items: [] }; clusters.push(cur); }
      cur.end = Math.max(cur.end, ev.end);
      var c = 0;
      while (cur.cols[c] != null && cur.cols[c] > ev.start) c++;
      cur.cols[c] = ev.end; ev.col = c; cur.items.push(ev);
    });
    clusters.forEach(function (cl) {
      most = Math.max(most, cl.cols.length);
      cl.items.forEach(function (ev) { ev.ncols = cl.cols.length; });
    });
    return most;
  }

  // Drop whatever doesn't fit in a block rather than clipping it mid-line:
  // first the notes, then the title shrinks to one line, then time + title share a row.
  function fitBlocks(lane) {
    function run() {
      lane.querySelectorAll('.cal-ev').forEach(function (b) {
        b.classList.remove('notag', 'tight', 'tiny', 'micro');
        if (b.classList.contains('open')) return;
        var t = b.querySelector('.cal-ev-time');
        if (t && t.scrollWidth > b.clientWidth - 16) b.classList.add('notag');
        ['tight', 'tiny', 'micro'].forEach(function (c) {
          if (b.scrollHeight > b.clientHeight + 1) b.classList.add(c);
        });
      });
    }
    requestAnimationFrame(run);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(run); // re-fit once web fonts change the metrics
  }

  function renderCalendar(m) {
    var trip = m.trip;
    var strip = document.getElementById('cal-strip'), view = document.getElementById('cal-view');
    if (!strip || !view) return;
    var PX = 1.2; // px per minute
    var nowTimer;

    function pick() {
      var hash = location.hash.slice(1);
      for (var i = 0; i < trip.days.length; i++) if (trip.days[i].date === hash) return i;
      return m.phase === 'during' ? m.dayIndex : 0;
    }

    function draw() {
      var i = pick(), day = trip.days[i];
      var isToday = m.phase === 'during' && day.date === m.today;
      var ev = eventsFor(m, day);
      var stay = stayFor(trip, day.date);

      strip.textContent = '';
      trip.days.forEach(function (d, j) {
        strip.appendChild(h('a', {
          class: 'cal-chip ' + d.place + (j === i ? ' is-selected' : '') + (m.phase === 'during' && d.date === m.today ? ' is-today' : ''),
          href: '#' + d.date, 'aria-current': j === i ? 'date' : null
        }, h('span', { class: 'cal-chip-wd' }, weekday(d.date)), h('span', { class: 'cal-chip-d' }, String(parseISO(d.date).getUTCDate()))));
      });
      var sel = strip.querySelector('.is-selected');
      if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest', inline: 'center' });

      var lo = 6 * 60, hi = 24 * 60;
      ev.timed.forEach(function (e) { lo = Math.min(lo, e.start); hi = Math.max(hi, e.end); });
      lo = Math.floor(lo / 60) * 60; hi = Math.min(Math.ceil(hi / 60) * 60, 30 * 60);

      var grid = h('div', { class: 'cal-grid', style: 'height:' + (hi - lo) * PX + 'px' });
      for (var t = lo; t <= hi; t += 60) {
        grid.appendChild(h('div', { class: 'cal-hour' + (t % 1440 === 0 ? ' midnight' : ''), style: 'top:' + (t - lo) * PX + 'px' },
          h('span', null, t % 1440 === 0 ? 'midnight' : fmtClock(t))));
      }
      // On phones, long rough guesses ("daytime", "night", "day trip") become a slim rail on the
      // left so the real, timed events keep most of the width instead of being squeezed into thirds.
      var narrow = window.matchMedia('(max-width:640px)').matches;
      var rail = [], main = [];
      ev.timed.forEach(function (e) {
        e.rail = narrow && !e.exact && e.end - e.start >= 180;
        (e.rail ? rail : main).push(e);
      });
      var RAIL_W = 30, railCols = layoutColumns(rail);
      rail.forEach(function (e) { e.ncols = 1; });
      layoutColumns(main);
      var railPx = railCols * RAIL_W;
      var lane = h('div', { class: 'cal-lane' });
      grid.appendChild(lane);
      ev.timed.forEach(function (e) {
        var it = e.item, height = Math.max((e.end - e.start) * PX, 44);
        var pos = e.rail
          ? 'left:' + (e.col * RAIL_W) + 'px;width:' + (RAIL_W - 4) + 'px'
          : 'left:calc(' + railPx + 'px + (100% - ' + railPx + 'px) * ' + (e.col / e.ncols) + ' + 2px);width:calc((100% - ' + railPx + 'px) / ' + e.ncols + ' - 4px)';
        var block = h('button', {
          type: 'button',
          class: 'cal-ev' + (e.exact ? ' exact' : ' fuzzy') + (e.rail ? ' rail' : '') + (it.kind ? ' logi-' + it.kind : '') + (it.maybe ? ' maybe' : '') + (it.curated ? ' curated' : ' from-notion') + (it.owner ? ' mine' : '') + (height < 56 ? ' short' : ''),
          style: 'top:' + (e.start - lo) * PX + 'px;height:' + height + 'px;' + pos,
          'data-label': e.rail ? '~ ' + plain(it.name) : null,
          'aria-expanded': 'false',
          onclick: function (evt) {
            var b = evt.currentTarget, open = b.classList.toggle('open');
            b.setAttribute('aria-expanded', open ? 'true' : 'false');
            fitBlocks(lane);
          }
        },
          h('span', { class: 'cal-ev-time' }, fmtRange(e),
            it.owner ? h('span', { class: 'src-tag mine' }, ownerName(it.owner)) : !it.curated ? h('span', { class: 'src-tag notion' }, 'Notion') : null),
          h('span', { class: 'cal-ev-name' }, segsNodes(it.name, { capitalize: true }), it.maybe ? h('span', { class: 'maybe-tag' }, 'maybe') : null),
          plain(it.notes) ? h('span', { class: 'cal-ev-notes' }, segsNodes(it.notes)) : null);
        lane.appendChild(block);
      });

      var nowLine = isToday ? h('div', { class: 'cal-now' }, h('span', null, 'now')) : null;
      function placeNow() {
        var n = vnMinutesNow();
        if (n < lo && n + 1440 <= hi) n += 1440;
        if (n < lo || n > hi) { nowLine.hidden = true; return; }
        nowLine.hidden = false; nowLine.style.top = (n - lo) * PX + 'px';
      }
      if (nowLine) { grid.appendChild(nowLine); placeNow(); }
      clearInterval(nowTimer);
      if (nowLine) nowTimer = setInterval(placeNow, 60000);

      var prev = trip.days[i - 1], next = trip.days[i + 1];
      view.textContent = '';
      append(view, [
        h('div', { class: 'cal-head' },
          prev ? h('a', { class: 'btn btn-quiet cal-nav', href: '#' + prev.date, 'aria-label': 'Previous day' }, '←') : h('span', { class: 'cal-nav' }),
          h('div', { class: 'cal-title' },
            h('div', { class: 'day-head' }, cityChip(trip, day.place, day.place === 'transit' ? (i === trip.days.length - 1 ? 'Departure' : 'In transit') : null),
              isToday ? h('span', { class: 'stamp' }, 'Today') : null),
            h('h2', null, 'Day ' + (i + 1) + ' · ' + weekday(day.date) + ' ' + fmtDay(day.date)),
            h('p', { class: 'muted' }, day.title)),
          next ? h('a', { class: 'btn btn-quiet cal-nav', href: '#' + next.date, 'aria-label': 'Next day' }, '→') : h('span', { class: 'cal-nav' })),
        day.tip ? h('p', { class: 'day-tip' }, h('strong', null, 'Heads up: '), day.tip) : null,
        ev.anytime.length ? h('div', { class: 'cal-anytime' },
          h('span', { class: 'logi-tag' }, 'Anytime'),
          h('ul', null, ev.anytime.map(function (it) {
            return h('li', null, h('span', { class: 'plan-name' }, segsNodes(it.name, { capitalize: true })),
              plain(it.notes) ? h('span', { class: 'plan-notes' }, segsNodes(it.notes)) : null);
          }))) : null,
        !ev.timed.length && !ev.anytime.length ? h('p', { class: 'muted' }, 'Nothing planned in Notion for this day yet.') : null,
        ev.timed.some(function (e) { return e.item.owner; }) ? legend(day) : null,
        ev.timed.length ? grid : null,
        stay ? h('p', { class: 'day-sleep' }, h('span', { class: 'logi-tag' }, 'Sleep'),
          h('span', null, stay.name + ' · ', h('a', { href: mapsUrl(stay), target: '_blank', rel: 'noopener' }, stay.address + ' ↗'))) : null
      ]);
      fitBlocks(lane);
      if (isToday && nowLine && !nowLine.hidden && !draw.scrolled) {
        draw.scrolled = true;
        setTimeout(function () { nowLine.scrollIntoView({ block: 'center' }); }, 50);
      }
    }

    window.addEventListener('hashchange', draw);
    var mq = window.matchMedia('(max-width:640px)');
    if (mq.addEventListener) mq.addEventListener('change', draw);
    document.addEventListener('keydown', function (e) {
      if (e.target.closest && e.target.closest('input,textarea')) return;
      var i = pick();
      if (e.key === 'ArrowLeft' && i > 0) location.hash = trip.days[i - 1].date;
      if (e.key === 'ArrowRight' && i < trip.days.length - 1) location.hash = trip.days[i + 1].date;
    });
    draw();
  }

  // ---------- map page: each day's stops in order ----------
  function stopUrl(s) { return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(s.q || s.name); }
  function dirUrl(path) {
    var q = path.map(function (s) { return s.q || (s.lat + ',' + s.lng); });
    var u = 'https://www.google.com/maps/dir/?api=1&origin=' + encodeURIComponent(q[0]) + '&destination=' + encodeURIComponent(q[q.length - 1]);
    if (q.length > 2) u += '&waypoints=' + encodeURIComponent(q.slice(1, -1).join('|'));
    return u;
  }
  // Split a day's stops at {leg} markers and number the stops on the path (1, 2, 3 … across the whole day).
  function daySegments(day) {
    var segs = [{ label: null, items: [] }], n = 0;
    (day.stops || []).forEach(function (s) {
      if (s.leg) { segs.push({ label: s.leg, items: [] }); return; }
      var it = Object.assign({}, s);
      if (s.lat != null && !s.off) it.num = ++n;
      segs[segs.length - 1].items.push(it);
    });
    segs.forEach(function (sg) {
      sg.path = sg.items.filter(function (s) { return s.num; });
      sg.side = sg.items.filter(function (s) { return s.off && s.lat != null; });
    });
    return segs.filter(function (sg) { return sg.items.length; });
  }

  function renderRoutes(m) {
    var trip = m.trip;
    var strip = document.getElementById('map-strip'), view = document.getElementById('map-view');
    if (!strip || !view) return;
    var map = null, layer = null, mapEl = null, markers = {};

    function pick() {
      var hash = location.hash.slice(1).split('/')[0];
      for (var i = 0; i < trip.days.length; i++) if (trip.days[i].date === hash) return i;
      if (m.phase === 'during') return m.dayIndex;
      for (var j = 0; j < trip.days.length; j++) if (trip.days[j].stops) return j;
      return 0;
    }
    function pickSeg(n) { var p = +location.hash.split('/')[1]; return p >= 1 && p <= n ? p - 1 : 0; }

    function pinIcon(cls, text, title) {
      return L.divIcon({
        className: '',
        html: '<div class="trip-pin stop-pin ' + cls + '"><span class="trip-pin-num">' + text + '</span></div>',
        iconSize: [24, 24], iconAnchor: [12, 12], popupAnchor: [0, -13]
      });
    }
    function popupFor(s, nums) {
      return h('div', null,
        h('p', { class: 'popup-city' }, (nums ? nums + ' · ' : '') + s.name),
        s.time || s.note ? h('p', { class: 'popup-meta' }, [s.time, s.note].filter(Boolean).join(' · ')) : null,
        h('p', { class: 'popup-meta' }, h('a', { href: stopUrl(s), target: '_blank', rel: 'noopener' }, 'Open in Google Maps ↗')));
    }

    function drawMap(place, seg) {
      if (typeof L === 'undefined') { mapEl.classList.add('map-fallback'); mapEl.textContent = 'The map couldn’t load. The stops are listed below.'; return; }
      if (!map) {
        map = L.map(mapEl, { scrollWheelZoom: false, zoomControl: true });
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
          maxZoom: 18
        }).addTo(map);
        mapEl.addEventListener('click', function () { map.scrollWheelZoom.enable(); });
        mapEl.addEventListener('mouseleave', function () { map.scrollWheelZoom.disable(); });
      }
      if (layer) layer.remove();
      layer = L.layerGroup().addTo(map);
      markers = {};
      var pts = seg.path.map(function (s) { return [s.lat, s.lng]; });
      if (pts.length > 1) {
        L.polyline(pts, { color: '#1C1912', weight: 7, opacity: 0.18, lineCap: 'round', lineJoin: 'round' }).addTo(layer);
        L.polyline(pts, { color: '#B8391F', weight: 3, lineCap: 'round', lineJoin: 'round' }).addTo(layer);
        // An arrow halfway along each hop shows which way we go.
        for (var k = 0; k < pts.length - 1; k++) {
          var a = map.project(pts[k], 10), b = map.project(pts[k + 1], 10);
          if (a.distanceTo(b) < 2) continue;
          var ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
          L.marker([(pts[k][0] + pts[k + 1][0]) / 2, (pts[k][1] + pts[k + 1][1]) / 2], {
            interactive: false, keyboard: false,
            icon: L.divIcon({ className: '', html: '<div class="path-arrow" style="transform:rotate(' + ang + 'deg)">➤</div>', iconSize: [16, 16], iconAnchor: [8, 8] })
          }).addTo(layer);
        }
      }
      // One pin per place; a place we pass twice (out from the Airbnb and back) shows both numbers.
      var pins = [];
      seg.path.forEach(function (s) {
        var same = pins.filter(function (p) { return p.s.lat === s.lat && p.s.lng === s.lng; })[0];
        if (same) same.nums.push(s.num); else pins.push({ s: s, nums: [s.num] });
      });
      pins.forEach(function (p) {
        var label = p.nums.join(',');
        var mk = L.marker([p.s.lat, p.s.lng], { icon: pinIcon(place + (p.s.maybe ? ' maybe' : '') + (label.length > 2 ? ' wide' : ''), label), title: p.s.name, zIndexOffset: 100 })
          .addTo(layer).bindPopup(popupFor(p.s, label));
        p.nums.forEach(function (n) { markers[n] = mk; });
      });
      seg.side.forEach(function (s) {
        markers[s.name] = L.marker([s.lat, s.lng], { icon: pinIcon('side', '◇'), title: s.name }).addTo(layer).bindPopup(popupFor(s));
      });
      var all = pts.concat(seg.side.map(function (s) { return [s.lat, s.lng]; }));
      // Fit the path; a far side trip (Cu Chi, the Mekong) stays off-screen until you zoom out, so the city route stays readable.
      var fit = pts.length ? pts : all;
      if (fit.length === 1) map.setView(fit[0], 15);
      else if (fit.length) map.fitBounds(fit, { padding: [36, 36], maxZoom: 16 });
      setTimeout(function () { map.invalidateSize(); }, 0);
    }

    function focusStop(s) {
      var mk = markers[s.num || s.name];
      if (!map || !mk) return;
      map.setView(mk.getLatLng(), Math.max(map.getZoom(), 16));
      mk.openPopup();
      mapEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    function stopRow(s, k, list) {
      var prev = null;
      if (s.num) for (var j = k - 1; j >= 0; j--) if (list[j].num) { prev = list[j]; break; }
      var hop = prev && !(prev.lat === s.lat && prev.lng === s.lng) ? prev : null;
      return h('li', { class: 'stop' + (s.num ? '' : s.off ? ' stop-side' : ' stop-loose') + (s.maybe ? ' is-maybe' : '') },
        s.lat != null ? h('button', { type: 'button', class: 'stop-num' + (s.num ? '' : ' none'), 'aria-label': 'Show ' + s.name + ' on the map', onclick: function () { focusStop(s); } }, s.num ? String(s.num) : '◇')
          : h('span', { class: 'stop-num none' }, '·'),
        h('div', { class: 'stop-body' },
          h('p', { class: 'stop-name' }, s.name, s.maybe ? h('span', { class: 'maybe-tag' }, 'maybe') : null,
            s.who ? h('span', { class: 'stop-who' }, s.who) : null),
          s.time || s.note ? h('p', { class: 'stop-meta' }, s.time ? h('span', { class: 'stop-time' }, s.time) : null, s.time && s.note ? ' · ' : null, s.note || null) : null),
        s.lat != null ? h('span', { class: 'stop-links' },
          h('a', { class: 'stop-link', href: stopUrl(s), target: '_blank', rel: 'noopener', 'aria-label': 'Open ' + s.name + ' in Google Maps' }, 'Maps ↗'),
          hop ? h('a', { class: 'stop-link', href: dirUrl([hop, s]), target: '_blank', rel: 'noopener', 'aria-label': 'Directions from ' + hop.name + ' to ' + s.name }, 'Route here ↗') : null) : null);
    }

    function draw() {
      var i = pick(), day = trip.days[i];
      var isToday = m.phase === 'during' && day.date === m.today;
      var segs = daySegments(day), si = pickSeg(segs.length), seg = segs[si];
      var segPlace = segs.length > 1 && si === 0 && i > 0 ? trip.days[i - 1].place : day.place;

      strip.textContent = '';
      trip.days.forEach(function (d, j) {
        strip.appendChild(h('a', {
          class: 'cal-chip ' + d.place + (j === i ? ' is-selected' : '') + (m.phase === 'during' && d.date === m.today ? ' is-today' : ''),
          href: '#' + d.date, 'aria-current': j === i ? 'date' : null
        }, h('span', { class: 'cal-chip-wd' }, weekday(d.date)), h('span', { class: 'cal-chip-d' }, String(parseISO(d.date).getUTCDate()))));
      });
      var sel = strip.querySelector('.is-selected');
      if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest', inline: 'center' });

      var prev = trip.days[i - 1], next = trip.days[i + 1];
      if (map) { map.remove(); map = null; layer = null; }
      mapEl = seg ? h('div', { id: 'day-map', role: 'region', 'aria-label': 'Map of the stops for ' + fmtDay(day.date) }) : null;
      view.textContent = '';
      append(view, [
        h('div', { class: 'cal-head' },
          prev ? h('a', { class: 'btn btn-quiet cal-nav', href: '#' + prev.date, 'aria-label': 'Previous day' }, '←') : h('span', { class: 'cal-nav' }),
          h('div', { class: 'cal-title' },
            h('div', { class: 'day-head' }, cityChip(trip, day.place, day.place === 'transit' ? (i === trip.days.length - 1 ? 'Departure' : 'In transit') : null),
              isToday ? h('span', { class: 'stamp' }, 'Today') : null),
            h('h2', null, 'Day ' + (i + 1) + ' · ' + weekday(day.date) + ' ' + fmtDay(day.date)),
            h('p', { class: 'muted' }, day.title)),
          next ? h('a', { class: 'btn btn-quiet cal-nav', href: '#' + next.date, 'aria-label': 'Next day' }, '→') : h('span', { class: 'cal-nav' })),
        !seg ? h('p', { class: 'muted' }, i === 0 ? 'Travel day — nothing to map.' : 'No stops mapped for this day yet.') : null,
        segs.length > 1 ? h('div', { class: 'seg-tabs', role: 'tablist' }, segs.map(function (sg, k) {
          return h('a', { class: 'seg-tab' + (k === si ? ' is-selected' : ''), role: 'tab', 'aria-selected': k === si ? 'true' : 'false', href: '#' + day.date + '/' + (k + 1) },
            k === 0 ? 'Before the flight' : 'After landing');
        })) : null,
        seg ? h('div', { class: 'route-map day-route-map' }, mapEl) : null,
        seg && seg.path.length > 1 && seg.path.length <= 11 ? h('p', { class: 'btn-row' },
          h('a', { class: 'btn', href: dirUrl(seg.path), target: '_blank', rel: 'noopener' }, 'Directions for this route ↗')) : null,
        seg && seg.label ? h('p', { class: 'seg-leg' }, '✈ ' + seg.label) : null,
        seg ? h('ol', { class: 'stop-list' }, seg.items.filter(function (s) { return !s.off; }).map(stopRow)) : null,
        seg && seg.side.length ? h('div', { class: 'stop-side-wrap' },
          h('p', { class: 'eyebrow' }, 'Off the path'),
          h('ol', { class: 'stop-list' }, seg.side.map(stopRow))) : null,
        seg ? h('p', { class: 'muted small-print' }, 'Numbers are the order we’ll go in; tap one to zoom to it. Where there are no times, the order is a best guess that keeps travel short. Lines are straight hops, not streets — “Route here” gives real directions from the stop before.') : null
      ]);
      if (seg) drawMap(segPlace, seg);
    }

    window.addEventListener('hashchange', draw);
    document.addEventListener('keydown', function (e) {
      if (e.target.closest && e.target.closest('input,textarea')) return;
      var i = pick();
      if (e.key === 'ArrowLeft' && i > 0) location.hash = trip.days[i - 1].date;
      if (e.key === 'ArrowRight' && i < trip.days.length - 1) location.hash = trip.days[i + 1].date;
    });
    draw();
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
    if (page === 'hub') { renderStatus(m); renderToday(m); renderMap(m); }
    if (page === 'itinerary') renderItinerary(m);
    if (page === 'stays') renderStays(m);
    if (page === 'calendar') renderCalendar(m);
    if (page === 'map') renderRoutes(m);
  }).catch(fail);

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(function () { /* offline cache is a bonus */ });
  }
})();
