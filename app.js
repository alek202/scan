'use strict';

var GS = String.fromCharCode(29);
var STORE = 'scanner.codes.v1';
var MODE_STORE = 'scanner.mode.v1';
var JOURNAL = 'scanner.journal.v1';

var el = function (id) { return document.getElementById(id); };
var video = el('video'), overlay = el('overlay'), statusEl = el('status');
var listEl = el('list'), countEl = el('count'), msgEl = el('msg');
var btnStart = el('btnStart'), btnTorch = el('btnTorch'), btnShow = el('btnShow');
var btnUndo = el('btnUndo'), btnClear = el('btnClear');

var codes = [];
var stream = null, track = null, detector = null, torchOn = false, scanning = false;
var lastSeen = {}, wakeLock = null, audio = null;
var viewIndex = 0, viewMode = 'dmA';

try { codes = JSON.parse(localStorage.getItem(STORE) || '[]'); } catch (e) { codes = []; }
try { viewMode = localStorage.getItem(MODE_STORE) || 'dmA'; } catch (e) { viewMode = 'dmA'; }
if (viewMode === 'dm') viewMode = 'dmA';
if (['dmA','qr'].indexOf(viewMode) === -1) viewMode = 'dmA';

var journal = [];
try { journal = JSON.parse(localStorage.getItem(JOURNAL) || '[]'); } catch (e) { journal = []; }
(function pruneJournal() {
  var lim = Date.now() - 90 * 24 * 3600 * 1000;
  journal = journal.filter(function (j) { return j.t >= lim; });
})();
function saveJournal() { try { localStorage.setItem(JOURNAL, JSON.stringify(journal)); } catch (e) {} }

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

// Крупная строка + мелкие пояснения (sub: строка или массив строк; предупреждения идут оранжевым)
function setStatus(text, cls, sub, warn) {
  statusEl.className = cls || '';
  statusEl.textContent = '';
  var big = document.createElement('div'); big.className = 'big'; big.textContent = text;
  statusEl.appendChild(big);
  (sub ? [].concat(sub) : []).forEach(function (t, i) {
    var d = document.createElement('div'); d.className = 'small' + (warn && i === 0 ? ' warn' : '');
    d.textContent = t; statusEl.appendChild(d);
  });
}
function fmtWhen(t) {
  var d = new Date(t);
  return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear() + ' в ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// ---------- разбор кода ----------
function normalize(raw) {
  var s = String(raw || '').replace(/[\r\n]+$/g, '');
  s = s.replace(/^\][A-Za-z][0-9A-Za-z]/, '');  // префикс идентификатора символики, если есть
  s = s.replace(/^\x1d+/, '').replace(/\x1d+$/, '');  // GS в начале (FNC1) и в конце не храним
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
    setStatus('Это не код маркировки', 'bad', s.slice(0, 40).split(GS).join('\u241d'));
    return;
  }
  if (codes.indexOf(s) !== -1) {
    beep('dup');
    setStatus('Уже есть в списке (№' + (codes.indexOf(s) + 1) + ')', 'bad');
    return;
  }
  var prev = null;
  for (var k = journal.length - 1; k >= 0; k--) { if (journal[k].c === s) { prev = journal[k]; break; } }
  codes.push(s); save();
  journal.push({ t: Date.now(), c: s }); saveJournal();
  render(); beep('ok');
  var sub = [];
  if (prev) sub.push('Этот код уже сканировали: ' + fmtWhen(prev.t));
  sub.push(s.slice(0, 34).split(GS).join('\u241d'));
  setStatus('Принят № ' + codes.length, 'ok', sub, !!prev);
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
var MODES = ['dmA', 'qr'];
var MODE_NAMES = { dmA: 'Data Matrix', qr: 'QR' };

function esc(t) { return t.replace(/\^/g, '^094'); }

function drawCode() {
  var c = codes[viewIndex];
  var next = MODES[(MODES.indexOf(viewMode) + 1) % MODES.length];
  el('vinfo').textContent = (viewIndex + 1) + ' из ' + codes.length + '  (' + MODE_NAMES[viewMode] + ')';
  el('vtxt').textContent = c.split(GS).join('\u241d');
  el('vPrev').disabled = viewIndex === 0;
  el('vNext').disabled = viewIndex >= codes.length - 1;
  el('vMode').textContent = MODE_NAMES[next];
  var cv = el('vcode');
  var base = { scale: 6, padding: 10, backgroundcolor: 'FFFFFF' };
  var o;
  try {
    if (viewMode === 'dmA') {
      // GS1 DataMatrix: FNC1 в начале и FNC1 вместо разделителя GS
      o = { bcid: 'datamatrix', text: '^FNC1' + esc(c).split(GS).join('^FNC1'), parsefnc: true };
    } else {
      o = { bcid: 'qrcode', text: c, eclevel: 'M' };
    }
    Object.keys(base).forEach(function (k) { o[k] = base[k]; });
    bwipjs.toCanvas(cv, o);
  } catch (e) {
    cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
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
btnUndo.addEventListener('click', function () {
  var last = codes.pop(); save();
  for (var i = journal.length - 1; i >= 0; i--) { if (journal[i].c === last) { journal.splice(i, 1); break; } }
  saveJournal(); render();
});
btnClear.addEventListener('click', function () {
  if (confirm('Удалить все ' + codes.length + ' кодов из списка?')) { codes = []; save(); render(); }
});
el('vPrev').addEventListener('click', function () { if (viewIndex > 0) { viewIndex--; drawCode(); } });
el('vNext').addEventListener('click', function () { if (viewIndex < codes.length - 1) { viewIndex++; drawCode(); } });
el('vMode').addEventListener('click', function () {
  viewMode = MODES[(MODES.indexOf(viewMode) + 1) % MODES.length];
  try { localStorage.setItem(MODE_STORE, viewMode); } catch (e) {}
  drawCode();
});
el('vClose').addEventListener('click', function () { el('viewer').classList.remove('on'); });

render();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(function () {});
}

// ---------- журнал за день ----------
function pad(n) { return (n < 10 ? '0' : '') + n; }
function dayKey(t) { var d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function dayEntries(key) { return journal.filter(function (j) { return dayKey(j.t) === key; }); }

function updateJournalInfo() {
  var key = el('jDate').value;
  var n = key ? dayEntries(key).length : 0;
  el('jInfo').textContent = key ? ('Кодов за этот день: ' + n) : 'Выберите дату';
  el('jShare').disabled = n === 0; el('jSave').disabled = n === 0;
}

function buildCsv(key) {
  var rows = ['Дата;Время;№;Код (разделители показаны как ␝);Код (как есть, с разделителями GS)'];
  dayEntries(key).forEach(function (j, i) {
    var d = new Date(j.t);
    var tm = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    var vis = j.c.split(GS).join('\u241d');
    rows.push([key, tm, i + 1, '"' + vis.replace(/"/g, '""') + '"', '"' + j.c.replace(/"/g, '""') + '"'].join(';'));
  });
  return '\ufeff' + rows.join('\r\n') + '\r\n';
}

function makeFile(key) {
  var name = 'коды-' + key + '.csv';
  var blob = new Blob([buildCsv(key)], { type: 'text/csv;charset=utf-8' });
  return { name: name, blob: blob };
}

function saveFile() {
  var f = makeFile(el('jDate').value);
  var u = URL.createObjectURL(f.blob);
  var a = document.createElement('a');
  a.href = u; a.download = f.name; document.body.appendChild(a); a.click();
  setTimeout(function () { URL.revokeObjectURL(u); a.remove(); }, 1000);
  el('jInfo').textContent = 'Файл сохранён в «Загрузки»: ' + f.name;
}

function shareFile() {
  var f = makeFile(el('jDate').value);
  var file = new File([f.blob], f.name, { type: 'text/csv' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: f.name }).catch(function () {});
  } else {
    saveFile();
  }
}

el('btnJournal').addEventListener('click', function () {
  el('jDate').value = dayKey(Date.now());
  updateJournalInfo(); el('jrn').classList.add('on');
});
el('jDate').addEventListener('change', updateJournalInfo);
el('jShare').addEventListener('click', shareFile);
el('jSave').addEventListener('click', saveFile);
el('jClose').addEventListener('click', function () { el('jrn').classList.remove('on'); });
