/* DreamResolution calm voice — playback, pre-rendered phrases and on-device synthesis (Kokoro-82M in a worker). */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.DRVoice) return;
  var W = window;

  function norm(t) {
    return String(t || '').replace(/[‘’]/g, "'").replace(/[“”«»]/g, '"').replace(/\s+/g, ' ').trim();
  }
  function abs(u) { try { return new URL(u, document.baseURI).href; } catch (e) { return u; } }
  function b64ToBuf(b64) {
    var bin = atob(b64), n = bin.length, out = new Uint8Array(n);
    for (var i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  var S = {
    cfg: null, ctx: null, out: null, bus: null, amb: null, ambOn: false,
    worker: null, engine: 'idle', progress: 0, error: '',
    clipSrc: {}, clipLoad: {}, buffers: {}, waiting: {}, jobId: 0,
    subs: [], speakers: 0
  };

  function emit() { var st = api.status(); S.subs.slice().forEach(function (f) { try { f(st); } catch (e) {} }); }

  function hasAudio() { return !!(W.AudioContext || W.webkitAudioContext); }
  function canNeural() { return hasAudio() && typeof W.Worker !== 'undefined' && typeof W.WebAssembly !== 'undefined' && !!(S.cfg && S.cfg.workerUrl); }

  // ---------- audio graph ----------
  function impulse(ctx, secs, decay) {
    var rate = ctx.sampleRate, len = Math.floor(rate * secs), buf = ctx.createBuffer(2, len, rate);
    for (var c = 0; c < 2; c++) {
      var d = buf.getChannelData(c), last = 0;
      for (var i = 0; i < len; i++) {
        var t = i / len, n = Math.random() * 2 - 1;
        last = last * 0.55 + n * 0.45; // darker tail
        d[i] = (i < rate * 0.012 ? 0 : last) * Math.pow(1 - t, decay);
      }
    }
    return buf;
  }
  function ensureCtx() {
    if (S.ctx) return S.ctx;
    var AC = W.AudioContext || W.webkitAudioContext;
    if (!AC) return null;
    var ctx = new AC();
    var master = ctx.createGain(); master.gain.value = 0.95;
    var low = ctx.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 190; low.gain.value = 2.5;
    var high = ctx.createBiquadFilter(); high.type = 'highshelf'; high.frequency.value = 5200; high.gain.value = -4.5;
    var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 9500; lp.Q.value = 0.5;
    var comp = ctx.createDynamicsCompressor(); comp.threshold.value = -20; comp.knee.value = 18; comp.ratio.value = 2.5; comp.attack.value = 0.01; comp.release.value = 0.3;
    master.connect(low); low.connect(high); high.connect(lp); lp.connect(comp); comp.connect(ctx.destination);
    var bus = ctx.createGain(); bus.gain.value = 1;
    var dry = ctx.createGain(); dry.gain.value = 0.86;
    var conv = ctx.createConvolver(); conv.buffer = impulse(ctx, 2.6, 2.4);
    var wet = ctx.createGain(); wet.gain.value = 0.2;
    bus.connect(dry); dry.connect(master);
    bus.connect(conv); conv.connect(wet); wet.connect(master);
    S.ctx = ctx; S.out = master; S.bus = bus;
    return ctx;
  }

  // Soft night air: brown noise and a low, slowly breathing drone.
  function startAmbient() {
    var ctx = ensureCtx(); if (!ctx || S.amb) return;
    var g = ctx.createGain(); g.gain.value = 0.0001;
    g.connect(ctx.destination);
    var nodes = [];
    var len = ctx.sampleRate * 8, nb = ctx.createBuffer(2, len, ctx.sampleRate);
    for (var c = 0; c < 2; c++) {
      var d = nb.getChannelData(c), last = 0;
      for (var i = 0; i < len; i++) { var w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = last * 3.2; }
      var x = Math.floor(ctx.sampleRate * 0.5); // crossfade the loop seam
      for (var j = 0; j < x; j++) { var a = j / x; d[len - x + j] = d[len - x + j] * (1 - a) + d[j] * a; }
    }
    var noise = ctx.createBufferSource(); noise.buffer = nb; noise.loop = true; noise.loopStart = 0.5; noise.loopEnd = 8 - 0.0001;
    var nf = ctx.createBiquadFilter(); nf.type = 'lowpass'; nf.frequency.value = 420; nf.Q.value = 0.3;
    var ng = ctx.createGain(); ng.gain.value = 0.55;
    var swell = ctx.createOscillator(); swell.frequency.value = 0.07; var swellG = ctx.createGain(); swellG.gain.value = 0.18;
    swell.connect(swellG); swellG.connect(ng.gain);
    noise.connect(nf); nf.connect(ng); ng.connect(g);
    nodes.push(noise, swell);
    var pad = ctx.createGain(); pad.gain.value = 0.16;
    var pf = ctx.createBiquadFilter(); pf.type = 'lowpass'; pf.frequency.value = 700; pf.Q.value = 0.4;
    pad.connect(pf); pf.connect(g);
    [[110, 0.5, 0.041], [164.81, 0.32, 0.029], [220, 0.16, 0.053]].forEach(function (v) {
      var o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = v[0];
      var og = ctx.createGain(); og.gain.value = v[1] * 0.6;
      var l = ctx.createOscillator(); l.frequency.value = v[2]; var lg = ctx.createGain(); lg.gain.value = v[1] * 0.4;
      l.connect(lg); lg.connect(og.gain); o.connect(og); og.connect(pad);
      nodes.push(o, l);
    });
    var t = ctx.currentTime;
    nodes.forEach(function (n) { try { n.start(t); } catch (e) {} });
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.06, t + 4);
    S.amb = { g: g, nodes: nodes };
  }
  function stopAmbient(fadeSecs) {
    var a = S.amb; if (!a || !S.ctx) return; S.amb = null;
    var t = S.ctx.currentTime, f = fadeSecs == null ? 3 : fadeSecs;
    try { a.g.gain.cancelScheduledValues(t); a.g.gain.setValueAtTime(Math.max(a.g.gain.value, 0.0001), t); a.g.gain.exponentialRampToValueAtTime(0.0001, t + f); } catch (e) {}
    setTimeout(function () { a.nodes.forEach(function (n) { try { n.stop(); } catch (e) {} }); try { a.g.disconnect(); } catch (e) {} }, f * 1000 + 200);
  }

  // ---------- phrase buffers ----------
  function bufKey(voice, key) { return voice + '|' + key; }
  function loadClips(voice) {
    if (S.clipLoad[voice]) return S.clipLoad[voice];
    var url = S.cfg && S.cfg.clips && S.cfg.clips[voice];
    if (!url) { S.clipLoad[voice] = Promise.resolve({}); return S.clipLoad[voice]; }
    S.clipLoad[voice] = fetch(abs(url), { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : {}; }).then(function (j) {
      S.clipSrc[voice] = j || {}; return S.clipSrc[voice];
    }).catch(function () { S.clipSrc[voice] = {}; return {}; });
    return S.clipLoad[voice];
  }
  function decode(arrBuf) {
    var ctx = ensureCtx();
    return new Promise(function (res, rej) {
      try {
        var p = ctx.decodeAudioData(arrBuf, res, rej);
        if (p && p.then) p.then(res, rej);
      } catch (e) { rej(e); }
    });
  }
  function fromPcm(f32) {
    var ctx = ensureCtx();
    var b = ctx.createBuffer(1, f32.length, 24000);
    if (b.copyToChannel) b.copyToChannel(f32, 0); else b.getChannelData(0).set(f32);
    return b;
  }

  function startWorker() {
    if (S.worker || !canNeural()) return S.worker;
    try {
      var w = new W.Worker(abs(S.cfg.workerUrl));
      w.onmessage = onWorker;
      w.onerror = function (e) { failEngine((e && e.message) || 'The voice engine could not start.'); };
      S.worker = w;
      S.engine = 'loading'; S.progress = 0; emit();
      w.postMessage(Object.assign({ type: 'load' }, engineCfg()));
    } catch (e) { failEngine(e && e.message); }
    return S.worker;
  }
  function engineCfg() { return { wasmUrl: abs(S.cfg.wasmUrl), modelUrls: S.cfg.modelUrls.map(abs) }; }
  function failEngine(msg) {
    S.engine = 'error'; S.error = msg || 'error';
    Object.keys(S.waiting).forEach(function (k) { S.waiting[k].forEach(function (cb) { cb.rej(new Error(S.error)); }); delete S.waiting[k]; });
    emit();
  }
  function onWorker(ev) {
    var m = ev.data || {};
    if (m.type === 'progress') { S.progress = m.value; if (S.engine !== 'ready') S.engine = 'loading'; emit(); }
    else if (m.type === 'ready') { S.engine = 'ready'; S.progress = 1; emit(); }
    else if (m.type === 'audio') {
      var bk = bufKey(m.voice, m.key);
      try { S.buffers[bk] = fromPcm(m.audio); } catch (e) {}
      var ws = S.waiting[bk] || []; delete S.waiting[bk];
      ws.forEach(function (cb) { S.buffers[bk] ? cb.res(S.buffers[bk]) : cb.rej(new Error('decode')); });
      emit();
    } else if (m.type === 'error') {
      if (m.key) {
        var bk2 = bufKey(m.voice || '', m.key);
        (S.waiting[bk2] || []).forEach(function (cb) { cb.rej(new Error(m.message)); });
        delete S.waiting[bk2];
        emit();
      } else failEngine(m.message);
    }
  }

  function getBuffer(text, voice, urgent) {
    var key = norm(text), bk = bufKey(voice, key);
    if (S.buffers[bk]) return Promise.resolve(S.buffers[bk]);
    return loadClips(voice).then(function (clips) {
      if (S.buffers[bk]) return S.buffers[bk];
      var c = clips[key];
      if (c && c.b64) {
        return decode(b64ToBuf(c.b64)).then(function (b) { S.buffers[bk] = b; return b; });
      }
      if (!canNeural()) throw new Error('no-engine');
      if (S.engine === 'error') throw new Error(S.error || 'engine');
      startWorker();
      if (!S.worker) throw new Error('no-worker');
      return new Promise(function (res, rej) {
        var first = !S.waiting[bk];
        (S.waiting[bk] = S.waiting[bk] || []).push({ res: res, rej: rej });
        if (first) S.worker.postMessage(Object.assign({ type: 'synth', id: ++S.jobId, key: key, voice: voice, speed: (S.cfg.speed && S.cfg.speed[voice]) || 0.84, text: key, urgent: !!urgent, cfg: engineCfg() }));
      });
    });
  }

  function isInstant(text, voice) {
    var key = norm(text);
    if (S.buffers[bufKey(voice, key)]) return true;
    var c = S.clipSrc[voice];
    return !!(c && c[key]);
  }

  // ---------- device voice fallback ----------
  function ss() { try { return (W.speechSynthesis && typeof W.SpeechSynthesisUtterance !== 'undefined') ? W.speechSynthesis : null; } catch (e) { return null; } }
  function pickDeviceVoice(prefMale) {
    var s = ss(); if (!s) return null;
    var vs = []; try { vs = s.getVoices() || []; } catch (e) {}
    var bad = /compact|novelty|bad news|bells|boing|bubbles|cellos|wobble|whisper|zarvox|trinoids|albert|jester|organ|superstar|ralph|fred|junior|kathy|princess|grandma|grandpa|eddy|flo|reed|rocko|sandy|shelley|good news|hysterical/i;
    var femaleRe = /ava|zoe|allison|samantha|serena|karen|moira|tessa|fiona|aria|jenny|libby|sonia|emma|female|susan|victoria/i;
    var maleRe = /daniel|evan|nathan|tom|alex|arthur|guy|ryan|davis|andrew|brian|christopher|male|aaron|oliver/i;
    var best = null, bestS = -1e9;
    vs.forEach(function (v) {
      if (!/^en/i.test(v.lang)) return;
      var n = v.name, sc = 0;
      if (/natural|neural|premium|enhanced|siri|online/i.test(n)) sc += 50;
      if ((prefMale ? maleRe : femaleRe).test(n)) sc += 20;
      if (/^en[-_](US|GB|AU|IE|CA)/i.test(v.lang)) sc += 5;
      if (bad.test(n)) sc -= 80;
      if (v.localService) sc += 2;
      if (sc > bestS) { bestS = sc; best = v; }
    });
    return best;
  }
  function speakDevice(text, gain, prefMale) {
    var s = ss();
    return new Promise(function (res) {
      if (!s) { setTimeout(res, Math.max(1500, text.split(' ').length * 420)); return; }
      var done = false, fin = function () { if (!done) { done = true; clearTimeout(t); res(); } };
      var t = setTimeout(fin, (text.split(' ').length / 2.0) * 1000 / 0.82 + 4000);
      try {
        var u = new W.SpeechSynthesisUtterance(text);
        u.rate = 0.82; u.pitch = prefMale ? 0.9 : 0.96; u.volume = Math.max(0.25, Math.min(1, gain));
        var v = pickDeviceVoice(prefMale); if (v) u.voice = v;
        u.onend = fin; u.onerror = fin;
        s.speak(u);
      } catch (e) { fin(); }
    });
  }

  // ---------- playback ----------
  var current = null;
  function wait(ms, h) { return new Promise(function (r) { var t = setTimeout(r, ms); h.timers.push(t); }); }
  function playBuffer(buf, gain, h) {
    var ctx = ensureCtx();
    return new Promise(function (res) {
      var src = ctx.createBufferSource(); src.buffer = buf;
      var g = ctx.createGain();
      var t = ctx.currentTime + 0.04;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.001, gain), t + 0.06);
      src.connect(g); g.connect(S.bus);
      src.start(t);
      h.sources.push(src);
      var tm = setTimeout(res, (buf.duration + 0.04) * 1000);
      h.timers.push(tm);
    });
  }

  api_play.counter = 0;
  function api_play(o) {
    stopCurrent(true);
    var h = { stopped: false, timers: [], sources: [], id: ++api_play.counter };
    current = h;
    var texts = (o.texts || []).filter(Boolean);
    var voice = o.voice || 'af_heart';
    var gain = o.gain == null ? 1 : o.gain;
    var gaps = o.gaps || [];
    var male = voice.indexOf('am_') === 0 || voice.indexOf('bm_') === 0;
    var ctx = ensureCtx();
    if (ctx && ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
    if (o.ambient && ctx) { S.ambOn = true; startAmbient(); }
    var notify = function (fn, a) { if (!h.stopped && fn) { try { fn(a); } catch (e) {} } };
    var useDevice = !ctx;
    (async function run() {
      // Make sure the whole reading can be voiced the same way before it starts.
      var bufs = [];
      if (!useDevice) {
        var instant = texts.every(function (t) { return isInstant(t, voice); });
        if (!instant) notify(o.onWait, true);
        try {
          var limit = new Promise(function (_, rej) { var t = setTimeout(function () { rej(new Error('timeout')); }, o.timeout || 60000); h.timers.push(t); });
          var all = Promise.all(texts.map(function (t, i) { return getBuffer(t, voice, i < 2); }));
          bufs = await Promise.race([all, limit]);
        } catch (e) { useDevice = true; }
        if (h.stopped) return;
        notify(o.onWait, false);
        notify(o.onSource, useDevice ? 'device' : 'calm');
      } else notify(o.onSource, 'device');
      for (var i = 0; i < texts.length; i++) {
        if (h.stopped) return;
        notify(o.onLine, i);
        if (useDevice) await speakDevice(texts[i], gain, male);
        else await playBuffer(bufs[i], gain, h);
        if (h.stopped) return;
        var gap = gaps[i] != null ? gaps[i] : (i < texts.length - 1 ? 650 : 0);
        if (gap) await wait(gap, h);
      }
      if (h.stopped) return;
      if (current === h) current = null;
      notify(o.onDone);
    })();
    return { stop: function () { stopHandle(h); } };
  }
  function stopHandle(h) {
    if (!h || h.stopped) return;
    h.stopped = true;
    h.timers.forEach(function (t) { clearTimeout(t); });
    var ctx = S.ctx;
    h.sources.forEach(function (s) { try { s.stop(ctx ? ctx.currentTime + 0.12 : 0); } catch (e) {} });
    var s2 = ss(); if (s2) { try { if (s2.speaking || s2.pending) s2.cancel(); } catch (e) {} }
    if (current === h) current = null;
  }
  function stopCurrent() { if (current) stopHandle(current); }

  var api = {
    version: 1,
    norm: norm,
    configure: function (cfg) { S.cfg = cfg || null; if (cfg && cfg.clips && cfg.clips.af_heart) loadClips('af_heart'); },
    unlock: function () {
      var ctx = ensureCtx(); if (!ctx) return;
      try { if (ctx.state === 'suspended') ctx.resume(); } catch (e) {}
      try { var b = ctx.createBuffer(1, 1, 22050), s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0); } catch (e) {}
    },
    status: function () { return { engine: S.engine, progress: S.progress, error: S.error, neural: canNeural() }; },
    subscribe: function (fn) { S.subs.push(fn); return function () { S.subs = S.subs.filter(function (f) { return f !== fn; }); }; },
    isInstant: function (texts, voice) { return (texts || []).every(function (t) { return isInstant(t, voice); }); },
    prepare: function (texts, voice) {
      var v = voice || 'af_heart';
      return loadClips(v).then(function () {
        var need = (texts || []).filter(function (t) { return t && !isInstant(t, v); });
        if (need.length && S.worker) S.worker.postMessage({ type: 'retain', keys: need.map(norm) });
        return Promise.all((texts || []).filter(Boolean).map(function (t) { return getBuffer(t, v, false).catch(function () {}); }));
      });
    },
    play: api_play,
    stop: function () { stopCurrent(); },
    ambient: function (on, fade) { S.ambOn = !!on; if (on) startAmbient(); else stopAmbient(fade); },
    ambientOn: function () { return !!S.amb; }
  };
  W.DRVoice = api;
})();
