// Watch: streaming premieres for the next 7 days (new movies, new series, new seasons) on the
// family's services, from /api/watch (worker/watch.js). Day tabs with counts, a poster grid, filter
// chips per service, per extra language (e.g. Telugu) and "Family-friendly", and a detail sheet with IMDb rating and cast. Filters
// are remembered on this frame.
(function () {
  'use strict';
  var V = { el: null, data: null, loaded: 0, day: null, service: 'all', family: false, lang: null };
  var REFRESH_MS = 15 * 60e3;

  function load(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  V.service = load('hq-watch-service', 'all');
  V.family = load('hq-watch-family', false);
  V.lang = load('hq-watch-lang', null);

  function svc(id) { return (V.data.services || []).filter(function (s) { return s.id === id; })[0] || { name: id, color: '#555' }; }
  function ymdDate(ymd) { var a = ymd.split('-'); return new Date(+a[0], +a[1] - 1, +a[2]); }
  function dayLabel(ymd, i) { return i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : App.fmt.dayShort(ymdDate(ymd)) + ' ' + ymdDate(ymd).getDate(); }
  function shown() {
    return V.data.items.filter(function (x) {
      return (V.service === 'all' || x.service === V.service) && (!V.family || x.family) && (!V.lang || x.lang === V.lang);
    });
  }
  function rating(x) {
    return x.imdbRating ? '<span class="wt-star">★ ' + x.imdbRating.toFixed(1) + '</span>' : x.tmdbScore ? '<span class="wt-star is-tmdb">★ ' + x.tmdbScore.toFixed(1) + '</span>' : '';
  }
  function langName(code) { return ((V.data.languages || []).filter(function (l) { return l.code === code; })[0] || { name: code }).name; }
  function badge(id) { var s = svc(id); return '<span class="wt-svc" style="--svc:' + s.color + '">' + App.esc(s.name) + '</span>'; }

  // ------------------------------------------------------------ painting
  function card(x) {
    return '<button class="wt-card" data-title="' + x.type + '/' + x.tmdb + '">' +
      '<span class="wt-poster">' + (x.poster ? '<img loading="lazy" alt="" src="/api/watch/img/w185' + x.poster + '">' : '<span class="wt-noposter serif">' + App.esc(x.title) + '</span>') + '</span>' +
      '<b class="wt-name">' + App.esc(x.title) + '</b>' +
      '<span class="wt-meta">' + badge(x.service) + '<span class="wt-label">' + App.esc(x.label) + '</span>' + (x.lang ? '<span class="wt-lang">' + App.esc(langName(x.lang)) + '</span>' : '') + '</span>' +
      '<span class="wt-meta">' + rating(x) + (x.cert ? '<span class="wt-cert' + (x.family ? '' : ' is-mature') + '">' + App.esc(x.cert) + '</span>' : '') +
      (x.time ? '<span class="wt-time">' + App.esc(x.time) + '</span>' : '') + '</span></button>';
  }
  function paint() {
    var el = V.el, d = V.data;
    if (!d) { el.innerHTML = '<div class="watch"><p class="wt-empty serif">Loading…</p></div>'; return; }
    if (!d.configured) {
      el.innerHTML = '<div class="watch"><header class="wt-head"><div><div class="label">Streaming</div><h1 class="serif">Watch</h1></div></header>' +
        '<p class="wt-empty serif">Watch isn’t set up yet: it needs free TMDB and Trakt keys.</p></div>';
      return;
    }
    if (V.lang && !(d.languages || []).some(function (l) { return l.code === V.lang; })) V.lang = null;
    var items = shown();
    if (V.day && V.day !== 'week' && d.days.indexOf(V.day) < 0) V.day = null;
    if (!V.day) V.day = d.days[0];
    var count = function (ymd) { return items.filter(function (x) { return x.date === ymd; }).length; };
    var body;
    if (V.day === 'week') {
      body = d.days.map(function (ymd, i) {
        var list = items.filter(function (x) { return x.date === ymd; });
        return list.length ? '<h3 class="label wt-dayh">' + dayLabel(ymd, i) + '</h3><div class="wt-grid">' + list.map(card).join('') + '</div>' : '';
      }).join('');
    } else {
      var list = items.filter(function (x) { return x.date === V.day; });
      body = list.length ? '<div class="wt-grid">' + list.map(card).join('') + '</div>' : '';
    }
    if (!body) body = '<p class="wt-empty serif">' + (d.building ? 'Updating this week’s list…' : 'Nothing new on these services.') + '</p>';
    el.innerHTML = '<div class="watch">' +
      '<header class="wt-head"><div><div class="label">This week on streaming' + (d.building ? ' · updating' : '') + '</div><h1 class="serif">Watch</h1></div>' +
      '<div class="wt-filters">' +
      '<button class="chip' + (V.service === 'all' ? ' is-on' : '') + '" data-svc="all">All</button>' +
      d.services.map(function (s) { return '<button class="chip wt-chip' + (V.service === s.id ? ' is-on' : '') + '" data-svc="' + s.id + '" style="--svc:' + s.color + '"><i></i>' + App.esc(s.name.replace(' (India)', '')) + '</button>'; }).join('') +
      (d.languages || []).map(function (l) { return '<button class="chip chip--ghost' + (V.lang === l.code ? ' is-on' : '') + '" data-lang="' + App.esc(l.code) + '">' + App.esc(l.name) + '</button>'; }).join('') +
      '<button class="chip chip--ghost' + (V.family ? ' is-on' : '') + '" data-family>Family-friendly</button></div></header>' +
      '<div class="seg wt-days">' + d.days.map(function (ymd, i) {
        return '<button class="' + (V.day === ymd ? 'is-on' : '') + '" data-day="' + ymd + '">' + dayLabel(ymd, i) + ' <span class="num">' + count(ymd) + '</span></button>';
      }).join('') + '<button class="' + (V.day === 'week' ? 'is-on' : '') + '" data-day="week">All week <span class="num">' + items.length + '</span></button></div>' +
      '<div class="wt-body">' + body +
      '<p class="wt-credits">Data from TMDB, JustWatch and Trakt; IMDb ratings via OMDb. Not endorsed or certified by TMDB or Trakt.</p></div></div>';
  }

  // ------------------------------------------------------------ details
  function openTitle(type, id) {
    var x = V.data.items.filter(function (i) { return i.type === type && String(i.tmdb) === id; })[0];
    App.sheet('<div class="sheet-pad wt-sheet"><p class="wt-empty serif">Loading…</p></div>', { cls: 'sheet--wide' });
    App.api('GET', '/watch/' + type + '/' + id).then(function (t) {
      var layer = document.querySelector('#sheetLayer .wt-sheet');
      if (!layer) return;
      var when = x ? dayLabel(x.date, V.data.days.indexOf(x.date)) + ', ' + App.fmt.monthShort(ymdDate(x.date)) + ' ' + ymdDate(x.date).getDate() + (x.time ? ' · ' + x.time : '') : '';
      var facts = [t.year, t.type === 'movie' ? (t.runtime ? t.runtime + ' min' : '') : (t.seasons ? t.seasons + ' season' + (t.seasons > 1 ? 's' : '') : ''),
        (t.genres || []).join(', ')].filter(Boolean).join(' · ');
      layer.innerHTML =
        (t.poster ? '<img class="wt-big" alt="" src="/api/watch/img/w500' + t.poster + '">' : '') +
        '<div class="wt-info">' +
        '<div class="label">' + (x ? App.esc(x.label) + ' · ' + App.esc(when) : '') + '</div>' +
        '<h2 class="serif sheet-h">' + App.esc(t.title) + '</h2>' +
        '<div class="wt-meta">' + (t.service ? badge(t.service) : '') + (t.cert ? '<span class="wt-cert' + (t.family ? '' : ' is-mature') + '">' + App.esc(t.cert) + '</span>' : '') + '</div>' +
        '<div class="wt-scores">' +
        (t.imdbRating ? '<span><b>★ ' + t.imdbRating.toFixed(1) + '</b> IMDb</span>' : '') +
        (t.rt ? '<span><b>' + App.esc(t.rt) + '</b> Rotten Tomatoes</span>' : '') +
        (t.tmdbScore ? '<span><b>' + t.tmdbScore.toFixed(1) + '</b> TMDB</span>' : '') + '</div>' +
        (facts ? '<p class="wt-facts">' + App.esc(facts) + '</p>' : '') +
        (t.overview ? '<p class="wt-plot">' + App.esc(t.overview) + '</p>' : '') +
        (t.cast && t.cast.length ? '<div class="label">Cast</div><ul class="wt-cast">' + t.cast.map(function (c) {
          return '<li><b>' + App.esc(c.name) + '</b>' + (c.as ? '<small>' + App.esc(c.as) + '</small>' : '') + '</li>';
        }).join('') + '</ul>' : '') +
        (t.by && t.by.length ? '<p class="wt-facts">' + (t.type === 'movie' ? 'Directed by ' : 'Created by ') + App.esc(t.by.join(', ')) + '</p>' : '') +
        (x ? '<div class="sheet-actions"><button class="btn btn--solid" data-remind>Add to calendar · 7 PM</button></div>' : '') +
        '</div>';
      var remind = layer.querySelector('[data-remind]');
      if (remind) remind.addEventListener('click', function () { addToCalendar(x, t, remind); });
    }, function (err) {
      var layer = document.querySelector('#sheetLayer .wt-sheet');
      if (layer) layer.innerHTML = '<p class="wt-empty serif">Couldn’t load the details · ' + App.esc(err.message) + '</p>';
    });
  }
  function addToCalendar(x, t, btn) {
    var d = ymdDate(x.date), start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 19, 0).getTime();
    btn.disabled = true;
    App.write('calendar', 'POST', '/events', {
      id: App.uid(), title: 'Watch: ' + t.title + ' (' + svc(x.service).name + ')',
      people: App.state.people.map(function (p) { return p.id; }), start: start, end: start + 2 * 3600e3,
    }).then(function () {
      App.toast('Added to the calendar · ' + App.esc(t.title), { icon: 'calendar', ms: 2500 });
      App.refresh('calendar'); App.closeSheet();
    }, function () { btn.disabled = false; });
  }

  // ------------------------------------------------------------ data + events
  function fetchWeek() {
    return App.api('GET', '/watch').then(function (d) { V.data = d; V.loaded = Date.now(); if (V.el && App.current === 'watch') paint(); })
      .catch(function () { /* offline: keep what is shown */ });
  }
  function onClick(e) {
    var t = e.target.closest('[data-title]'), s = e.target.closest('[data-svc]'), day = e.target.closest('[data-day]');
    if (t) { var p = t.dataset.title.split('/'); openTitle(p[0], p[1]); }
    else if (s) { V.service = s.dataset.svc; save('hq-watch-service', V.service); paint(); }
    else if (e.target.closest('[data-lang]')) { var l = e.target.closest('[data-lang]').dataset.lang; V.lang = V.lang === l ? null : l; save('hq-watch-lang', V.lang); paint(); }
    else if (e.target.closest('[data-family]')) { V.family = !V.family; save('hq-watch-family', V.family); paint(); }
    else if (day) { V.day = day.dataset.day; paint(); var b = V.el.querySelector('.wt-body'); if (b) b.scrollTop = 0; }
  }

  App.register('watch', {
    show: function (el) {
      if (!V.el) { V.el = el; el.addEventListener('click', onClick); }
      paint();
      if (!V.data || Date.now() - V.loaded > REFRESH_MS || V.data.building) fetchWeek();
    }
  });
})();
