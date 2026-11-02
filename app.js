'use strict';

var GS = String.fromCharCode(29);
var STORE = 'scanner.codes.v1';
var MODE_STORE = 'scanner.mode.v1';

var el = function (id) { return document.getElementById(id); };
var video = el('video'), overlay = el('overlay'), statusEl = el('status');
var listEl = el('list'), countEl = el('count'), msgEl = el('msg');
var btnStart = el('btnStart'), btnTorch = el('btnTorch'), btnShow = el('btnShow');
var btnUndo = el('btnUndo'), btnClear = el('btnClear');

var codes = [];
var stream = null, track = null, detector = null, torchOn = false, scanning = false;
var lastSeen = {}, wakeLock = null, audio = null;
var viewIndex = 0, viewMode = 'dm';

try { codes = JSON.parse(localStorage.getItem(STORE) || '[]'); } catch (e) { codes = []; }
try { viewMode = localStorage.getItem(MODE_STORE) || 'dm'; } catch (e) { viewMode = 'dm'; }

function save() { try { localStorage.setItem(STORE, JSON.stringify(codes)); } catch (e) {} }

// ---------- звук и вибрация ----------
function beep(kind) {
  try {
    if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    var o = audio.createOscillator(), g = audio.createGain();
    var f = kind === 'ok' ? 1500 : kind === 'dup' ? 600 : 300;
    var d = kind === 'ok' ? 0.12 : kind === 'dup' ? 0.18 : 0.35;
    o.frequency.value = f; o.type = 'square'; g.gain.value = 0.25;
    o.connect(g); g.connect(audio.destination);
    o.start(); o.stop(audio.currentTime + d);
  } catch (e) {}
  try { if (navigator.vibrate) navigator.vibrate(kind === 'ok' ? 60 : [80, 60, 80]); } catch (e) {}
}

function setStatus(text, cls) { statusEl.textContent = text; statusEl.className = cls || ''; }

// ---------- разбор кода ----------
function normalize(raw) {
  var s = String(raw || '').replace(/[\r\n]+$/g, '');
  s = s.replace(/^\][A-Za-z][0-9A-Za-z]/, '');  // префикс идентификатора символики, если есть
  return s;
}
// Код маркировки Честного знака: 01 + GTIN(14) + 21 + серийный номер ...
function isMarking(s) { return /^01\d{14}21[\x21-\x7e]{3,}/.test(s); }

// ---------- список ----------
function render() {
  listEl.innerHTML = '';
  codes.forEach(function (c, i) {
    var li = document.createElement('li');
    var b = document.createElement('b'); b.textContent = (i + 1) + '.';
    var t = document.createElement('span');
    t.textContent = c.split(GS).join('␝');
    li.appendChild(b); li.appendChild(t);
    listEl.appendChild(li);
  });
  var n = codes.length;
  countEl.textContent = n + ' ' + (n % 10 === 1 && n % 100 !== 11 ? 'код' : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'кода' : 'кодов'));
  btnShow.disabled = n === 0; btnUndo.disabled = n === 0; btnClear.disabled = n === 0;
  listEl.scrollTop = listEl.scrollHeight;
}

function addCode(raw) {
  var s = normalize(raw);
  var now = Date.now();
  if (lastSeen[s] && now - lastSeen[s] < 1500) { lastSeen[s] = now; return; }
  lastSeen[s] = now;
  if (!isMarking(s)) {
    beep('bad');
    setStatus('Это не код маркировки: ' + s.slice(0, 40), 'bad');
    return;
  }
  if (codes.indexOf(s) !== -1) {
    beep('dup');
    setStatus('Уже есть в списке (№' + (codes.indexOf(s) + 1) + ')', 'bad');
    return;
  }
  codes.push(s); save(); render(); beep('ok');
  setStatus('Принят № ' + codes.length + ': ' + s.slice(0, 34), 'ok');
}

// ---------- камера и распознавание ----------
function drawBox(points) {
  var w = video.videoWidth, h = video.videoHeight;
  var cw = overlay.clientWidth, ch = overlay.clientHeight;
  overlay.width = cw; overlay.height = ch;
  var ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, cw, ch);
  if (!points || !points.length || !w || !h) return;
  // object-fit: cover
  var sc = Math.max(cw / w, ch / h);
  var ox = (cw - w * sc) / 2, oy = (ch - h * sc) / 2;
  ctx.lineWidth = 4; ctx.strokeStyle = '#2ecc71'; ctx.beginPath();
  points.forEach(function (p, i) {
    var x = p.x * sc + ox, y = p.y * sc + oy;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.closePath(); ctx.stroke();
}

function loop() {
  if (!scanning) return;
  if (video.readyState >= 2) {
    detector.detect(video).then(function (found) {
      if (found.length) {
        drawBox(found[0].cornerPoints);
        found.forEach(function (f) { addCode(f.rawValue); });
      } else {
        drawBox(null);
      }
    }).catch(function () {}).then(function () { setTimeout(loop, 90); });
  } else {
    setTimeout(loop, 150);
  }
}

function startCamera() {
  if (!('BarcodeDetector' in window)) {
    msgEl.textContent = 'Этот браузер не умеет распознавать коды. Откройте страницу в Chrome на Android.';
    return;
  }
  var fmts = ['data_matrix', 'qr_code'];
  BarcodeDetector.getSupportedFormats().then(function (sup) {
    fmts = fmts.filter(function (f) { return sup.indexOf(f) !== -1; });
    if (!fmts.length) { msgEl.textContent = 'В этом браузере нет поддержки Data Matrix и QR.'; return; }
    detector = new BarcodeDetector({ formats: fmts });
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
    });
  }).then(function (s) {
    if (!s) return;
    stream = s; track = s.getVideoTracks()[0];
    video.srcObject = s; return video.play();
  }).then(function () {
    if (!stream) return;
    el('start').style.display = 'none';
    try {
      var cap = track.getCapabilities ? track.getCapabilities() : {};
      var adv = [];
      if (cap.focusMode && cap.focusMode.indexOf('continuous') !== -1) adv.push({ focusMode: 'continuous' });
      if (adv.length) track.applyConstraints({ advanced: adv });
      btnTorch.disabled = !cap.torch;
    } catch (e) {}
    scanning = true; setStatus('Наведите камеру на код'); keepAwake(); loop();
  }).catch(function (e) {
    msgEl.textContent = 'Камера не включилась: ' + (e && e.message ? e.message : e);
  });
}

function toggleTorch() {
  if (!track) return;
  torchOn = !torchOn;
  track.applyConstraints({ advanced: [{ torch: torchOn }] }).catch(function () { torchOn = !torchOn; });
}

function keepAwake() {
  try {
    if (navigator.wakeLock) navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; }).catch(function () {});
  } catch (e) {}
}
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible' && (scanning || el('viewer').classList.contains('on'))) keepAwake();
});

// ---------- показ кодов ----------
function drawCode() {
  var c = codes[viewIndex];
  el('vinfo').textContent = (viewIndex + 1) + ' из ' + codes.length + (viewMode === 'dm' ? '  (Data Matrix)' : '  (QR)');
  el('vtxt').textContent = c.split(GS).join('␝');
  el('vPrev').disabled = viewIndex === 0;
  el('vNext').disabled = viewIndex >= codes.length - 1;
  el('vMode').textContent = viewMode === 'dm' ? 'QR' : 'DM';
  var cv = el('vcode');
  try {
    if (viewMode === 'dm') {
      // GS1 DataMatrix: FNC1 в начале и FNC1 вместо разделителя GS
      bwipjs.toCanvas(cv, { bcid: 'datamatrix', text: '^FNC1' + c.split(GS).join('^FNC1'), parse: true, scale: 6, padding: 10, backgroundcolor: 'FFFFFF' });
    } else {
      bwipjs.toCanvas(cv, { bcid: 'qrcode', text: c, scale: 6, padding: 10, backgroundcolor: 'FFFFFF', eclevel: 'M' });
    }
  } catch (e) {
    el('vtxt').textContent = 'Ошибка рисования: ' + e;
  }
}

function openViewer() {
  if (!codes.length) return;
  viewIndex = 0; el('viewer').classList.add('on'); keepAwake(); drawCode();
}

btnStart.addEventListener('click', function () { beep('dup'); startCamera(); });
btnTorch.addEventListener('click', toggleTorch);
btnShow.addEventListener('click', openViewer);
btnUndo.addEventListener('click', function () { codes.pop(); save(); render(); });
btnClear.addEventListener('click', function () {
  if (confirm('Удалить все ' + codes.length + ' кодов из списка?')) { codes = []; save(); render(); }
});
el('vPrev').addEventListener('click', function () { if (viewIndex > 0) { viewIndex--; drawCode(); } });
el('vNext').addEventListener('click', function () { if (viewIndex < codes.length - 1) { viewIndex++; drawCode(); } });
el('vMode').addEventListener('click', function () {
  viewMode = viewMode === 'dm' ? 'qr' : 'dm';
  try { localStorage.setItem(MODE_STORE, viewMode); } catch (e) {}
  drawCode();
});
el('vClose').addEventListener('click', function () { el('viewer').classList.remove('on'); });

render();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(function () {});
}
