/* ============================================================
   Éire Daily — countertop news dashboard
   Plain ES5-friendly JS for older Android WebView. No frameworks.
   Replace MOCK_NEWS + fetchNews() with a real backend call later.
   ============================================================ */
(function () {
  "use strict";

  /* ---------- Config ---------- */
  var BUILD_ID    = "clean-weather-ready-001"; // internal version marker (not shown on screen)
  var ROTATE_MS   = 12000;          // dwell time per headline
  var REFRESH_MS  = 5 * 60 * 1000;  // how often we re-poll the backend

  /* Weather ambience (V1) — see the "Weather ambience" section lower down. */
  var AMBIENCE_DIR      = "assets/audio/"; // where the loop MP3s live
  var AMBIENCE_VOLUME   = 0.3;             // low, calm background level
  var WIND_VERY_KMH     = 35;              // "very windy" threshold
  var WIND_MOD_KMH      = 20;              // "windy" threshold
  // Which MP3 plays for each weather/time situation.
  var AMBIENCE_TRACKS = {
    rain:      "rain.mp3",          // any rain / drizzle / thunder
    veryWindy: "windy-beach.mp3",   // windSpeed >= 35
    windy:     "soft-wind.mp3",     // windSpeed >= 20
    night:     "night.mp3",         // 21:00–06:00
    morning:   "bird.mp3",          // 06:00–11:00 + clear/partly cloudy
    clearDay:  "day-clear.mp3",     // clear during the day
    calm:      "background-peace.mp3" // default: cloudy / fog / snow / unknown
  };

  /* Dublin voice clips (V1) — a SECOND audio layer that plays on TOP of the
     ambience (the ambience above is never paused or replaced). Short one-shot
     clips that play at most ONCE per hour, only 08:00–20:59, never at night,
     and never if the ambience sound isn't actually running. Full rules + test
     helpers are in the "Dublin voice clips" section lower down. */
  var VOICE_DIR        = "assets/voices/"; // where the one-shot voice WAVs live
  var VOICE_VOLUME     = 0.8;              // audible over the 0.3 ambience, not blasting
  var VOICE_START_HOUR = 8;                // first hour a voice may play (08:00)
  var VOICE_END_HOUR   = 21;               // stop before this hour (last play 20:00–20:59)
  var VOICE_SLOT_KEY   = "eireVoiceSlot";  // localStorage: last hour-slot we played in
  var VOICE_ALT_KEY    = "eireVoiceAlt";   // localStorage: default-clip alternation counter
  // Which WAV plays for each weather situation (first match wins, in this order).
  var VOICE_FILES = {
    rain:     "rain1.wav",           // rain / drizzle
    wind:     "wind.wav",            // windy (windSpeed >= WIND_MOD_KMH)
    sunny:    "hot_sunny.wav",       // clear / sunny / hot / warm
    default1: "default_dublin1.wav", // generic Dublin personality (alternates 1<->2)
    default2: "default_dublin2.wav"
  };

  /* Backend endpoints. The frontend NEVER fetches RSS directly — it calls these
     Cloudflare Worker endpoints, which normalise RSS + weather into clean JSON.
     API_BASE = "" means same-origin (the Worker/Pages serves this page too).
     Point a local/preview build at the live API by setting API_BASE to the
     Worker origin, e.g. "https://eire-daily.<you>.workers.dev". */
  var API_BASE         = "";
  var NEWS_ENDPOINT    = "/api/news";
  var WEATHER_ENDPOINT = "/api/weather";

  /* Stock Dublin image, used when an article has no image OR its image fails to
     load. Bundled SVG always renders (offline-safe) so the kiosk never shows a
     broken image; swap for any reachable Dublin photo URL if you prefer. */
  var DUBLIN_STOCK_IMAGE = "assets/dublin.svg";

  /* ---------- Source styling map ---------- */
  var SOURCES = {
    "RTÉ News":    { cls: "src-rte",     glyph: "R" },
    "TheJournal":  { cls: "src-journal", glyph: "J" },
    "Dublin Live": { cls: "src-dublin",  glyph: "D" }
  };
  function srcMeta(name) {
    return SOURCES[name] || { cls: "src-default", glyph: (name || "?").charAt(0) };
  }

  /* ---------- Mock data (preview before backend) ---------- */
  var now = Date.now();
  var mins = function (m) { return new Date(now - m * 60000).toISOString(); };

  var MOCK_NEWS = [
    {
      source: "RTÉ News",
      title: "Government unveils €1.4bn housing package aimed at first-time buyers",
      summary: "The plan expands shared-equity supports and fast-tracks delivery of 12,000 cost-rental homes across the State by 2027.",
      url: "https://www.rte.ie/news/",
      published: mins(8),
      image: "https://picsum.photos/seed/dublin-housing/1200/640"
    },
    {
      source: "TheJournal",
      title: "Met Éireann issues yellow rain warning for Leinster and east Munster",
      summary: "Forecasters expect heavy, persistent rain through the evening with localised flooding possible on low-lying routes.",
      url: "https://www.thejournal.ie/",
      published: mins(21),
      image: "https://picsum.photos/seed/eire-rain/1200/640"
    },
    {
      source: "Dublin Live",
      title: "Luas Green Line to run extended late services for summer festival season",
      summary: "Transport for Ireland confirms trams until 1am on weekends through August to ease city-centre crowds.",
      url: "https://www.dublinlive.ie/",
      published: mins(34),
      image: null
    },
    {
      source: "RTÉ News",
      title: "Irish economy grows faster than expected as exports rebound",
      summary: "Modified domestic demand rose 2.6% in the quarter, with strong pharma and tech shipments leading the recovery.",
      url: "https://www.rte.ie/news/business/",
      published: mins(52),
      image: "https://picsum.photos/seed/eire-economy/1200/640"
    },
    {
      source: "TheJournal",
      title: "New cycle network linking Phoenix Park to the docklands opens to the public",
      summary: "The 9km segregated route is the first phase of a wider plan to connect the city's main green corridors.",
      url: "https://www.thejournal.ie/",
      published: mins(68),
      image: null
    },
    {
      source: "Dublin Live",
      title: "Beloved Camden Street record shop saved after community buy-out campaign",
      summary: "Hundreds of locals pledged support to keep the four-decade-old store trading in its original premises.",
      url: "https://www.dublinlive.ie/",
      published: mins(95),
      image: "https://picsum.photos/seed/dublin-records/1200/640"
    }
  ];

  /* ---------- Mock weather (preview / offline fallback) ---------- */
  var MOCK_WEATHER = {
    location: "Dublin",
    temperature: 14,
    condition: "Cloudy",
    rainChance: 40,
    precipitation: 0.4,
    windSpeed: 18,
    updatedAt: new Date(now).toISOString(),
    today:    { max: 17, min: 10, rainChance: 50 },
    tomorrow: { max: 16, min: 9,  rainChance: 35 }
  };

  /* ---------- State ---------- */
  var items = [];
  var idx = 0;
  var rotateTimer = null;
  var refreshTimer = null;

  /* ---------- DOM refs ---------- */
  var $ = function (id) { return document.getElementById(id); };
  var hero        = $("hero");
  var heroFill    = $("heroFill");
  var heroImg     = $("heroImg");
  var fallbackG   = $("fallbackGlyph");
  var heroBadge   = $("heroBadge");
  var heroTime    = $("heroTime");
  var heroTitle   = $("heroTitle");
  var heroSummary = $("heroSummary");
  var heroDots    = $("heroDots");
  var upnext      = $("upnext");
  var sideCount   = $("sideCount");
  var updatedTime = $("updatedTime");
  // Weather card
  var weatherTemp    = $("weatherTemp");
  var weatherCond    = $("weatherCond");
  var weatherRain    = $("weatherRain");
  var weatherPrecip  = $("weatherPrecip");
  var weatherWind    = $("weatherWind");
  var fcTodayTemp    = $("fcTodayTemp");
  var fcTodayRain    = $("fcTodayRain");
  var fcTomorrowTemp = $("fcTomorrowTemp");
  var fcTomorrowRain = $("fcTomorrowRain");

  /* ---------- Helpers ---------- */
  function pad(n) { return n < 10 ? "0" + n : "" + n; }

  function timeAgo(iso) {
    var t = new Date(iso).getTime();
    if (isNaN(t)) return "";
    var diff = Math.round((Date.now() - t) / 60000); // minutes
    if (diff < 1) return "just now";
    if (diff < 60) return diff + " min ago";
    var h = Math.floor(diff / 60);
    if (h < 24) return h + (h === 1 ? " hr ago" : " hrs ago");
    var d = Math.floor(h / 24);
    return d + (d === 1 ? " day ago" : " days ago");
  }

  function fmtClock(date) {
    return pad(date.getHours()) + ":" + pad(date.getMinutes());
  }
  function fmtClockSec(date) { return fmtClock(date) + ":" + pad(date.getSeconds()); }

  var DAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  var MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  function fmtDate(date) {
    return DAYS[date.getDay()] + ", " + date.getDate() + " " + MONTHS[date.getMonth()];
  }

  /* ---------- Hero image: article image -> Dublin stock -> source glyph ---------- */
  function applyMedia(item) {
    if (item.image) {
      loadHeroImage(item, item.image, function () { useStockImage(item); });
    } else {
      useStockImage(item);
    }
  }
  function useStockImage(item) {
    if (DUBLIN_STOCK_IMAGE) {
      loadHeroImage(item, DUBLIN_STOCK_IMAGE, function () { showGlyph(item); });
    } else {
      showGlyph(item);
    }
  }
  // Probe a URL off-screen; only paint it if it actually loads, else run onFail.
  // The items[idx] guard prevents a slow image from overwriting a newer card.
  function loadHeroImage(item, url, onFail) {
    var probe = new Image();
    probe.onload = function () {
      if (items[idx] !== item) return;
      heroImg.style.backgroundImage = "url('" + url + "')";
      hero.className = hero.className.replace(/\s*no-image/, "");
    };
    probe.onerror = function () {
      if (items[idx] === item) onFail();
    };
    probe.src = url;
  }
  function showGlyph(item) {
    heroImg.style.backgroundImage = "none";
    fallbackG.textContent = srcMeta(item.source).glyph;
    if (hero.className.indexOf("no-image") === -1) hero.className += " no-image";
  }

  /* ---------- Render the hero card ---------- */
  var firstPaint = true;
  function fillHero(item, meta) {
    heroBadge.className = "badge " + meta.cls;
    heroBadge.textContent = item.source;
    heroTime.textContent = timeAgo(item.published);
    heroTitle.textContent = item.title;
    heroSummary.textContent = item.summary || "";
    applyMedia(item);
    renderDots();
  }
  function renderHero() {
    if (!items.length) return;
    var item = items[idx];
    var meta = srcMeta(item.source);

    // First paint: show content immediately, no fade-out gating visibility.
    if (firstPaint) {
      firstPaint = false;
      fillHero(item, meta);
      return;
    }

    // Subsequent rotations: fade out, swap content, fade back in.
    hero.className = (hero.className + " swapping").replace(/\s+/g, " ");
    setTimeout(function () {
      fillHero(item, meta);
      // rAF guarantees the reverse (0->1) transition actually fires
      requestAnimationFrame(function () {
        hero.className = hero.className.replace(/\s*swapping/, "");
      });
    }, 240);
  }

  function renderDots() {
    var html = "";
    for (var i = 0; i < items.length; i++) {
      html += '<i class="' + (i === idx ? "on" : "") + '"></i>';
    }
    heroDots.innerHTML = html;
  }

  /* ---------- Render the side "Up Next" column ---------- */
  function renderSide() {
    var html = "";
    var count = Math.min(items.length, 5);
    for (var k = 1; k <= count; k++) {
      var i = (idx + k) % items.length;
      if (i === idx) break;
      var it = items[i];
      var meta = srcMeta(it.source);
      var current = (k === 1);
      html += '<li class="' + (current ? "current" : "") + '">' +
                '<span class="up-rail"></span>' +
                '<span class="up-body">' +
                  '<span class="up-src ' + meta.cls + '">' + it.source + '</span>' +
                  '<span class="up-title">' + escapeHtml(it.title) + '</span>' +
                '</span>' +
              '</li>';
    }
    upnext.innerHTML = html;
    sideCount.textContent = (idx + 1) + " / " + items.length;
  }

  function escapeHtml(s) {
    return (s || "").replace(/[&<>"']/g, function (c) {
      return { "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c];
    });
  }

  /* ---------- Progress bar animation ---------- */
  function runProgress() {
    heroFill.className = "hero-progress-fill";
    heroFill.style.transition = "none";
    heroFill.style.width = "0%";
    // force reflow so the reset takes before we animate
    void heroFill.offsetWidth;
    heroFill.className = "hero-progress-fill run";
    heroFill.style.transition = "width " + ROTATE_MS + "ms linear";
    heroFill.style.width = "100%";
  }

  /* ---------- Rotation ---------- */
  function advance() {
    idx = (idx + 1) % items.length;
    paint();
  }
  function paint() {
    renderHero();
    renderSide();
    runProgress();
  }
  function startRotation() {
    if (rotateTimer) clearInterval(rotateTimer);
    rotateTimer = setInterval(advance, ROTATE_MS);
    paint();
  }

  /* ---------- Data loading ---------- */
  // Frontend calls the backend only (never RSS directly). On any failure it
  // falls back to mock data so the kiosk never appears broken.
  function apiUrl(path) { return API_BASE ? (API_BASE + path) : path; }

  function fetchNews(cb) {
    if (typeof fetch === "undefined") { cb(new Error("no fetch"), MOCK_NEWS.slice(), null); return; }
    fetch(apiUrl(NEWS_ENDPOINT)).then(function (r) { return r.json(); })
      .then(function (data) {
        var list = (data && data.items) ? data.items : data;
        if (Array.isArray(list) && list.length) {
          cb(null, list, (data && data.updatedAt) || null);
        } else {
          cb(new Error("empty news"), MOCK_NEWS.slice(), null);
        }
      })
      .catch(function (e) { cb(e, MOCK_NEWS.slice(), null); });
  }

  function fetchWeather(cb) {
    if (typeof fetch === "undefined") { cb(new Error("no fetch"), MOCK_WEATHER); return; }
    fetch(apiUrl(WEATHER_ENDPOINT)).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && typeof data.temperature !== "undefined") cb(null, data);
        else cb(new Error("bad weather"), MOCK_WEATHER);
      })
      .catch(function (e) { cb(e, MOCK_WEATHER); });
  }

  function loadAndRender(isInitial) {
    fetchNews(function (err, data, updatedAt) {
      items = (data || []).filter(function (d) { return d && d.title; });
      if (!items.length) return;            // mock fallback makes this near-impossible
      if (idx >= items.length) idx = 0;     // keep index in range across refreshes
      setUpdated(updatedAt, err);
      if (isInitial) startRotation(); else { renderSide(); }
    });
  }

  /* ---------- Weather ---------- */
  function loadWeather() {
    fetchWeather(function (err, w) {
      renderWeather(w);
      setUpdated(w && w.updatedAt, err);
      lastWeather = w || lastWeather;   // remember for ambience + voice selection
      applyAmbience();                  // pick + (maybe) play the background track
      maybePlayVoice();                 // and (maybe) play an hourly voice clip on top
    });
  }

  function fmtTemp(t) {
    return (typeof t === "number" && !isNaN(t)) ? Math.round(t) + "°" : "--°";
  }
  function pct(v)  { return (v === 0 || v) ? v + "%" : "--"; }
  function setText(el, s) { if (el) el.textContent = s; }

  function renderWeather(w) {
    if (!w) return;
    setText(weatherTemp,   fmtTemp(w.temperature));
    setText(weatherCond,   w.condition || "—");
    setText(weatherRain,   pct(w.rainChance));
    setText(weatherPrecip, ((w.precipitation === 0 || w.precipitation) ? w.precipitation + " mm" : "--"));
    setText(weatherWind,   ((w.windSpeed === 0 || w.windSpeed) ? w.windSpeed + " km/h" : "--"));
    if (w.today) {
      setText(fcTodayTemp, fmtTemp(w.today.max) + " / " + fmtTemp(w.today.min));
      setText(fcTodayRain, pct(w.today.rainChance));
    }
    if (w.tomorrow) {
      setText(fcTomorrowTemp, fmtTemp(w.tomorrow.max) + " / " + fmtTemp(w.tomorrow.min));
      setText(fcTomorrowRain, pct(w.tomorrow.rainChance));
    }
  }

  // Single small "Updated HH:MM" label, shared by news + weather refreshes.
  function setUpdated(iso, err) {
    if (!updatedTime) return;
    var d = iso ? new Date(iso) : new Date();
    if (isNaN(d.getTime())) d = new Date();
    updatedTime.textContent = fmtClock(d) + (err ? " · cached" : "");
  }

  /* ---------- Weather ambience (V1) ----------
     One looping background track at a time, chosen from the live weather
     condition + the tablet's local time. No layering, no extra APIs — it just
     reuses the /api/weather data we already fetch for the weather card.

     No on-screen control: the sound simply autoplays at low volume. On Fully
     Kiosk autoplay is allowed, so it just works. As a safety net for ordinary
     browsers that block autoplay until a gesture, the first tap/touch/key
     anywhere on the page starts it. Adjust/silence with the tablet's volume. */

  var ambienceEl    = null;   // the <audio> element (assigned in init)
  var currentTrack  = "";     // filename currently loaded, so we don't restart it
  var lastWeather   = null;   // most recent weather object, for re-picks on refresh
  var audioUnlocked = false;  // true once playback has actually started

  /* Decide which track fits the weather + time. First match wins (priority). */
  function pickAmbienceTrack(weather, date) {
    if (!weather) return AMBIENCE_TRACKS.calm;

    var cond = (weather.condition || "").toLowerCase();
    var wind = (typeof weather.windSpeed === "number") ? weather.windSpeed : 0;
    var hour = date.getHours();   // tablet's local hour (same clock as the display)

    var isRainy    = (cond.indexOf("rain") !== -1) ||   // Rain / Heavy rain
                     (cond.indexOf("drizzle") !== -1) ||
                     (cond.indexOf("thunder") !== -1);
    var isNight    = (hour >= 21 || hour < 6);
    var isMorning  = (hour >= 6 && hour < 11);
    var isClearish = (cond === "clear" || cond === "partly cloudy");

    if (isRainy)                 return AMBIENCE_TRACKS.rain;       // 1
    if (wind >= WIND_VERY_KMH)   return AMBIENCE_TRACKS.veryWindy;  // 2
    if (wind >= WIND_MOD_KMH)    return AMBIENCE_TRACKS.windy;      // 3
    if (isNight)                 return AMBIENCE_TRACKS.night;      // 4
    if (isMorning && isClearish) return AMBIENCE_TRACKS.morning;    // 5
    if (cond === "clear")        return AMBIENCE_TRACKS.clearDay;   // 6
    return AMBIENCE_TRACKS.calm;                                    // 7 (default)
  }

  /* Try to start playback at low volume. The browser may refuse (autoplay
     policy); if so, the gesture fallback below will start it on the first tap. */
  function tryPlayAmbience() {
    if (!ambienceEl || !currentTrack) return;
    ambienceEl.volume = AMBIENCE_VOLUME;
    var p = ambienceEl.play();
    if (p && p.then) {
      p.then(function () {
        audioUnlocked = true;
        removeGestureUnlock();   // playing now, stop listening for a gesture
        maybePlayVoice();        // audio is live now — a due voice clip may fire
      }).catch(function (e) {
        // Most common case: autoplay blocked until a real tap. Stay quiet;
        // the gesture fallback (still attached) will start it on first touch.
        console.warn("Ambience autoplay blocked; will start on first tap:", e && e.message);
      });
    } else {
      // Very old WebView: play() returns undefined — assume it started.
      audioUnlocked = true;
      removeGestureUnlock();
      maybePlayVoice();
    }
  }

  /* Gesture fallback: if autoplay was blocked, the first interaction anywhere
     counts as the user gesture browsers require, so we retry play() then. */
  function gestureUnlock() {
    if (!audioUnlocked) tryPlayAmbience();
  }
  function addGestureUnlock() {
    if (!document.addEventListener) return;
    document.addEventListener("click", gestureUnlock, true);
    document.addEventListener("touchstart", gestureUnlock, true);
    document.addEventListener("keydown", gestureUnlock, true);
  }
  function removeGestureUnlock() {
    if (!document.removeEventListener) return;
    document.removeEventListener("click", gestureUnlock, true);
    document.removeEventListener("touchstart", gestureUnlock, true);
    document.removeEventListener("keydown", gestureUnlock, true);
  }

  /* Pick the right track for the current weather/time, switch to it if it
     changed, and (try to) play it. Called after each weather load, so weather
     changes AND day/night changes are picked up on every 5-minute refresh. */
  function applyAmbience() {
    if (!ambienceEl) return;

    var file = pickAmbienceTrack(lastWeather, new Date());

    // Only swap the source when the track actually changes, so an unchanged
    // track keeps looping smoothly instead of restarting harshly.
    if (file !== currentTrack) {
      currentTrack = file;
      ambienceEl.src = AMBIENCE_DIR + file;
    }

    tryPlayAmbience();
  }

  /* ---------- Dublin voice clips (V1) ----------
     A SECOND audio layer on TOP of the ambience above. The ambience is never
     paused or replaced — short one-shot Dublin voice clips play alongside it
     through their own <audio id="voice"> element.

     Rules (kept deliberately simple for this test version):
       • at most ONCE per clock hour
       • only 08:00–20:59 (daytime/evening) — never during night mode
       • the played hour is stored in localStorage, so a page refresh / kiosk
         reload won't replay that hour's clip
       • only when the ambience sound is actually running (audioUnlocked) AND the
         voice layer isn't muted — so "sound off" means no voice either
       • weather picks the clip: rain/drizzle → rain1, windy → wind,
         clear/sunny/hot/warm → hot_sunny, otherwise an alternating Dublin default.

     Test WITHOUT waiting for the top of an hour — open the browser console:
       eireVoice.play()        // play the current weather pick right now
       eireVoice.test("rain")  // play one clip: rain|wind|sunny|default1|default2
       eireVoice.reset()       // clear the "already played this hour" marker
       eireVoice.status()      // log the current state (what it would pick, etc.)
       eireVoice.mute()        // turn the voice layer off (ambience keeps playing)
       eireVoice.unmute()
     …or load the page with ?voicetest=1 to get a tiny on-screen test panel. */

  var voiceEl      = null;   // the one-shot <audio> element (assigned in init)
  var voiceEnabled = true;   // software mute for the voice layer only

  // localStorage with an in-memory fallback (Fully Kiosk / private mode safe).
  var voiceMem = {};
  function vGet(k) {
    try { return window.localStorage.getItem(k); }
    catch (e) { return (k in voiceMem) ? voiceMem[k] : null; }
  }
  function vSet(k, v) {
    try { window.localStorage.setItem(k, v); }
    catch (e) { voiceMem[k] = v; }
  }

  // A unique marker per calendar hour, e.g. "2026-06-25-14".
  function hourSlot(date) {
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" +
           pad(date.getDate()) + "-" + pad(date.getHours());
  }

  function isDefaultVoice(f) {
    return f === VOICE_FILES.default1 || f === VOICE_FILES.default2;
  }

  // Alternate default_dublin1 / default_dublin2 across plays (persisted, so it
  // keeps alternating even across page refreshes).
  function pickDefaultVoice() {
    var n = parseInt(vGet(VOICE_ALT_KEY) || "0", 10);
    if (isNaN(n)) n = 0;
    return (n % 2 === 0) ? VOICE_FILES.default1 : VOICE_FILES.default2;
  }
  function bumpDefaultVoice() {
    var n = parseInt(vGet(VOICE_ALT_KEY) || "0", 10);
    if (isNaN(n)) n = 0;
    vSet(VOICE_ALT_KEY, "" + (n + 1));
  }

  // Choose a clip from the current weather (same priority order as the brief).
  function pickVoiceFile(weather) {
    var cond = (weather && weather.condition ? weather.condition : "").toLowerCase();
    var wind = (weather && typeof weather.windSpeed === "number") ? weather.windSpeed : 0;

    var isRainy = (cond.indexOf("rain") !== -1) || (cond.indexOf("drizzle") !== -1);
    var isWindy = (wind >= WIND_MOD_KMH);
    var isSunny = (cond.indexOf("clear") !== -1) || (cond.indexOf("sunny") !== -1) ||
                  (cond.indexOf("fair")  !== -1) || (cond.indexOf("hot")   !== -1) ||
                  (cond.indexOf("warm")  !== -1);

    if (isRainy) return VOICE_FILES.rain;   // 1
    if (isWindy) return VOICE_FILES.wind;   // 2
    if (isSunny) return VOICE_FILES.sunny;  // 3
    return pickDefaultVoice();              // 4 (default, alternates)
  }

  // Actually play a clip over the ambience. The ambience element is untouched,
  // so the background loop keeps going underneath the voice.
  function playVoiceFile(file) {
    if (!voiceEl || !file) return;
    voiceEl.src = VOICE_DIR + file;
    voiceEl.volume = VOICE_VOLUME;
    try { voiceEl.currentTime = 0; } catch (e) {}
    var p = voiceEl.play();
    if (p && p.catch) {
      p.catch(function (e) {
        console.warn("Voice clip blocked (needs a tap first?):", e && e.message);
      });
    }
    if (isDefaultVoice(file)) bumpDefaultVoice();  // advance the 1<->2 alternation
  }

  // The scheduled gate: enforce the once-per-hour / daytime / sound-on rules.
  // Safe to call as often as we like — it no-ops unless a play is actually due.
  function maybePlayVoice() {
    if (!voiceEl || !voiceEnabled) return;
    if (!audioUnlocked) return;                 // ambience isn't running -> sound is "off"

    var d = new Date();
    var hour = d.getHours();
    if (hour < VOICE_START_HOUR || hour >= VOICE_END_HOUR) return;  // night / too early

    var slot = hourSlot(d);
    if (vGet(VOICE_SLOT_KEY) === slot) return;   // already played this hour (survives refresh)

    vSet(VOICE_SLOT_KEY, slot);                  // claim the hour BEFORE playing (no double-fire)
    playVoiceFile(pickVoiceFile(lastWeather));
  }

  /* ---------- Voice test helpers ----------
     Test plays IGNORE the hour/slot and mute gates (a console call or button
     tap is itself the user gesture browsers need), so every clip can be heard
     immediately without waiting for the top of an hour. */
  function voiceTest(which) {
    var map = {
      rain: VOICE_FILES.rain, wind: VOICE_FILES.wind, sunny: VOICE_FILES.sunny,
      default1: VOICE_FILES.default1, default2: VOICE_FILES.default2
    };
    playVoiceFile(map[which] || which || pickVoiceFile(lastWeather));
  }
  function exposeVoiceApi() {
    window.eireVoice = {
      play:   function () { playVoiceFile(pickVoiceFile(lastWeather)); }, // current weather pick now
      test:   voiceTest,                                                  // a named clip now
      reset:  function () { vSet(VOICE_SLOT_KEY, ""); return "voice hour cleared"; },
      mute:   function () { voiceEnabled = false; return "voice muted"; },
      unmute: function () { voiceEnabled = true;  return "voice on"; },
      status: function () {
        var d = new Date();
        return {
          hour:           d.getHours(),
          inWindow:       (d.getHours() >= VOICE_START_HOUR && d.getHours() < VOICE_END_HOUR),
          playedThisHour: (vGet(VOICE_SLOT_KEY) === hourSlot(d)),
          audioUnlocked:  audioUnlocked,
          voiceEnabled:   voiceEnabled,
          wouldPick:      pickVoiceFile(lastWeather),
          weatherCond:    lastWeather && lastWeather.condition,
          windSpeed:      lastWeather && lastWeather.windSpeed
        };
      }
    };
  }

  // Tiny fixed-position test panel, ONLY when the URL has ?voicetest=1.
  // position:fixed means it overlays the kiosk without touching the 1280x800
  // layout, so it can never shift or clip the dashboard.
  function injectVoiceTestPanel() {
    if (!/[?&]voicetest=1/.test(location.search || "")) return;
    if (!document.body) return;
    var bar = document.createElement("div");
    bar.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:99999;" +
      "background:rgba(11,17,15,0.92);border:1px solid #d8a44a;border-radius:8px;" +
      "padding:6px 8px;font:12px 'IBM Plex Sans',sans-serif;color:#e7d3a0;" +
      "-webkit-box-shadow:0 2px 10px rgba(0,0,0,0.5);box-shadow:0 2px 10px rgba(0,0,0,0.5);";
    var defs = [
      ["Pick now", function () { window.eireVoice.play(); }],
      ["Rain",     function () { voiceTest("rain"); }],
      ["Wind",     function () { voiceTest("wind"); }],
      ["Sunny",    function () { voiceTest("sunny"); }],
      ["Dublin 1", function () { voiceTest("default1"); }],
      ["Dublin 2", function () { voiceTest("default2"); }]
    ];
    var label = document.createElement("span");
    label.textContent = "Voice test:";
    label.style.cssText = "margin-right:4px;opacity:0.8;";
    bar.appendChild(label);
    for (var i = 0; i < defs.length; i++) {
      (function (d) {
        var b = document.createElement("button");
        b.textContent = d[0];
        b.style.cssText = "margin:2px;padding:4px 8px;border:1px solid #4fb583;" +
          "background:#13201b;color:#e7d3a0;border-radius:5px;cursor:pointer;font:12px inherit;";
        b.onclick = d[1];
        bar.appendChild(b);
      })(defs[i]);
    }
    document.body.appendChild(bar);
  }

  /* ---------- Scale-to-fit (use the LAYOUT viewport) ----------
     The <meta name="viewport" content="width=1280"> pins the layout viewport
     to 1280x800 — that is what the dashboard is actually laid out against, and
     it is reported by document.documentElement.clientWidth/clientHeight.
     window.innerWidth / screen.width / visualViewport report the smaller
     *visual* viewport (e.g. 962x602 after the tablet's 1.33 DPR), which would
     wrongly shrink the design. So we size off clientWidth/clientHeight.
     When client == 1280x800 the scale is exactly 1; we only shrink if the
     layout viewport is genuinely smaller than the 1280x800 design. */
  function scaleToFit() {
    var fit = document.getElementById("fit");
    if (!fit) return;

    var de = document.documentElement || {};
    var vw = de.clientWidth  || window.innerWidth  || 1280;
    var vh = de.clientHeight || window.innerHeight || 800;

    // Largest scale that shows the whole 1280x800 canvas with nothing clipped.
    var s = Math.min(vw / 1280, vh / 800);

    // Don't upscale past the design (keeps it crisp; exactly 1 at 1280x800).
    if (s > 1) s = 1;
    if (s < 0.4) s = 0.4;   // sane floor if the viewport is truly tiny

    fit.style.webkitTransform = "scale(" + s + ")";
    fit.style.transform = "scale(" + s + ")";
  }

  /* ---------- Tablet-kiosk compact layout ----------
     On the Lenovo Yoga Tab 3 in Fully Kiosk, the LAYOUT viewport is the full
     1280x800 design (clientWidth/clientHeight), but the visible glass
     (window.innerWidth/innerHeight, ~962x602) is smaller and anchored top-left
     with no scroll — so the right column and bottom strip fall off-screen.
     We don't touch the scale (stays 1). Instead we add body.tablet-compact,
     which re-sizes the canvas to the visible window and tightens spacing so the
     whole dashboard fits. CSS lives in styles.css under body.tablet-compact. */
  function setBodyClass(name, on) {
    var b = document.body;
    if (!b) return;
    var wrapped = " " + b.className + " ";
    var has = wrapped.indexOf(" " + name + " ") !== -1;
    if (on && !has) {
      b.className = (b.className + " " + name).replace(/^\s+/, "");
    } else if (!on && has) {
      b.className = wrapped.split(" " + name + " ").join(" ").replace(/^\s+|\s+$/g, "");
    }
  }

  function applyTabletMode() {
    var de = document.documentElement || {};
    var cw = de.clientWidth  || 0;
    var ch = de.clientHeight || 0;
    var iw = window.innerWidth || 0;
    // Compact when the layout viewport is the full ~1280x800 design but the
    // visible window is meaningfully narrower than it (the Lenovo case ~962).
    var isCompact = (cw >= 1260 && cw <= 1300 && ch >= 780 && ch <= 820 &&
                     iw > 0 && iw < cw - 80);
    setBodyClass("tablet-compact", isCompact);
  }

  // Re-evaluate compact mode first (it changes the canvas size), then re-fit.
  function onViewportChange() {
    applyTabletMode();
    scaleToFit();
  }

  /* ---------- Clock ---------- */
  function tickClock() {
    var d = new Date();
    $("clockTime").textContent = fmtClock(d);
    $("clockDate").textContent = fmtDate(d);
    // refresh the relative "x min ago" label live without re-rendering all
    if (items.length) heroTime.textContent = timeAgo(items[idx].published);
  }

  /* ---------- Boot ---------- */
  function init() {
    // Internal version marker — not shown on screen, but readable in devtools
    // / view-source as <html data-build="..."> to confirm the live build.
    if (document.documentElement) {
      document.documentElement.setAttribute("data-build", BUILD_ID);
    }
    applyTabletMode();      // toggle compact kiosk layout before first paint
    scaleToFit();
    if (window.addEventListener) {
      window.addEventListener("resize", onViewportChange, false);
      window.addEventListener("orientationchange", onViewportChange, false);
      // visualViewport fires on pinch-zoom / on-screen keyboard / URL-bar changes
      if (window.visualViewport && window.visualViewport.addEventListener) {
        window.visualViewport.addEventListener("resize", onViewportChange, false);
      }
    }

    tickClock();
    setInterval(tickClock, 1000);

    // Weather ambience: grab the <audio> element and arm the gesture fallback
    // BEFORE the first weather load, so applyAmbience() is ready to play.
    ambienceEl = $("ambience");
    addGestureUnlock();

    // Voice clips: grab the one-shot <audio>, expose the console test API, and
    // (only with ?voicetest=1) draw the tiny on-screen test panel.
    voiceEl = $("voice");
    exposeVoiceApi();
    injectVoiceTestPanel();

    loadAndRender(true);
    loadWeather();
    refreshTimer = setInterval(function () {
      loadAndRender(false);
      loadWeather();
    }, REFRESH_MS);

    // tap the hero to skip to the next headline (touch-friendly)
    hero.addEventListener("click", function () {
      advance();
      if (rotateTimer) clearInterval(rotateTimer);
      rotateTimer = setInterval(advance, ROTATE_MS);
    }, false);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, false);
  } else {
    init();
  }
})();
