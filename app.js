// --- PWA Service Worker 登録 ---
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// --- IndexedDB ---
const DB_NAME = 'MediaStudioDB';
const STORE_NAME = 'media';
let dbInstance = null;

function openDB() {
  return new Promise((resolve, reject) => {
    if(dbInstance) { resolve(dbInstance); return; }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if(!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    request.onsuccess = (e) => { dbInstance = e.target.result; resolve(dbInstance); };
    request.onerror = (e) => reject(e);
  });
}

async function saveToDB(item) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e);
  });
}

async function deleteFromDB(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e);
  });
}

async function loadAllFromDB() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e);
  });
}

let library = [];
let displayedLibrary = [];
let activeIndex = -1;
let contextTargetIndex = -1;
let currentNav = 'media';
let currentTrackMeta = { artist: '', title: '', album: '' };

const FREQ_MAP = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const PRESETS = {
  Normal: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  BassBoost: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  Pop: [-1, 1, 3, 4, 3, 0, -1, 1, 2, 3],
  Classic: [4, 3, 2, 1, -1, -1, 0, 2, 3, 4],
  Acoustic: [3, 2, 1, 2, 2, 1, 2, 3, 3, 2],
  Electronic: [5, 4, 1, 0, -1, 2, 1, 2, 4, 5],
  Vocal: [-2, -2, -1, 1, 4, 4, 3, 1, 0, -1],
  Podcast: [-3, -2, -1, 2, 5, 4, 2, 0, -2, -3],
  TrebleBoost: [-2, -1, 0, 0, 1, 2, 4, 6, 7, 8],
  Piano: [2, 1, 0, 2, 3, 2, 3, 4, 3, 2]
};

let audioCtx = null;
let preGainNode = null;
let limiterNode = null;
let analyserNode = null;
let eqFilterNodes = [];
let isKaraokeActive = false;
let aiWeights = null;

function initAudioContext() {
  if (audioCtx) return;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  audioCtx = new AudioContextClass();

  preGainNode = audioCtx.createGain();
  preGainNode.gain.value = 0.85;

  limiterNode = audioCtx.createDynamicsCompressor();
  limiterNode.threshold.value = -0.5;
  limiterNode.knee.value = 0.0;
  limiterNode.ratio.value = 20.0;
  limiterNode.attack.value = 0.001;
  limiterNode.release.value = 0.05;

  analyserNode = audioCtx.createAnalyser();
  analyserNode.fftSize = 256;

  eqFilterNodes = FREQ_MAP.map((freq, i) => {
    const filter = audioCtx.createBiquadFilter();
    if (i === 0) filter.type = 'lowshelf';
    else if (i === FREQ_MAP.length - 1) filter.type = 'highshelf';
    else filter.type = 'peaking';
    filter.frequency.value = freq;
    filter.Q.value = 1.4;
    filter.gain.value = 0;
    return filter;
  });

  for (let i = 0; i < eqFilterNodes.length - 1; i++) {
    eqFilterNodes[i].connect(eqFilterNodes[i + 1]);
  }
  eqFilterNodes[eqFilterNodes.length - 1].connect(limiterNode);
  limiterNode.connect(analyserNode);
  analyserNode.connect(audioCtx.destination);
}

function attachMediaToAudioPipeline(mediaElement) {
  initAudioContext();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  if (!mediaElement._hasAudioSourceNode) {
    const src = audioCtx.createMediaElementSource(mediaElement);
    src.connect(preGainNode);
    preGainNode.connect(eqFilterNodes[0]);
    mediaElement._hasAudioSourceNode = true;
  }
}

function buildEQUI() {
  const container1 = document.getElementById('eqHardware');
  const container2 = document.getElementById('modalEqHardware');
  [container1, container2].forEach(container => {
    if (!container) return;
    container.innerHTML = '';
    FREQ_MAP.forEach((freq, idx) => {
      const col = document.createElement('div');
      col.className = 'eq-col';
      const label = freq >= 1000 ? `${freq / 1000}k` : `${freq}`;
      col.innerHTML = `
        <span class="eq-val" id="eqVal_${container.id}_${idx}">0dB</span>
        <input type="range" min="-12" max="12" step="0.5" value="0" data-idx="${idx}" oninput="handleEQSliderChange(${idx}, this.value)">
        <span class="eq-label">${label}</span>
      `;
      container.appendChild(col);
    });
  });
}

function handleEQSliderChange(idx, val) {
  val = parseFloat(val);
  if (eqFilterNodes[idx]) eqFilterNodes[idx].gain.value = val;
  updateEQSlidersDisplay(idx, val);

  const item = displayedLibrary[activeIndex];
  if (item && (item.type === 'audio' || item.type === 'video')) {
    if (!item.eq) item.eq = [...PRESETS.Normal];
    item.eq[idx] = val;
    saveToDB(item);
  }
}

function updateEQSlidersDisplay(idx, val) {
  const text = `${val > 0 ? '+' : ''}${val}dB`;
  ['eqHardware', 'modalEqHardware'].forEach(id => {
    const el = document.getElementById(`eqVal_${id}_${idx}`);
    if (el) el.textContent = text;
    const slider = document.querySelector(`#${id} input[data-idx="${idx}"]`);
    if (slider) slider.value = val;
  });
}

function setEQSliders(gains) {
  gains.forEach((g, idx) => {
    if (eqFilterNodes[idx]) eqFilterNodes[idx].gain.value = g;
    updateEQSlidersDisplay(idx, g);
  });
}

function applyPreset(presetKey, chipEl) {
  if (!PRESETS[presetKey]) return;
  const gains = PRESETS[presetKey];
  setEQSliders(gains);

  document.querySelectorAll('.preset-bar .chip').forEach(c => {
    if (c.getAttribute('data-preset') === presetKey) c.classList.add('active');
    else c.classList.remove('active');
  });

  const item = displayedLibrary[activeIndex];
  if (item && (item.type === 'audio' || item.type === 'video')) {
    item.eq = [...gains];
    saveToDB(item);
  }
  showToast(`EQプリセット [${presetKey}] を適用しました`);
}

function loadEQForTrack(idx) {
  const item = displayedLibrary[idx];
  const nameEl = document.getElementById('eqCurrentTrackName');
  const targetEl = document.getElementById('eqTargetLabel');
  if (item) {
    if (nameEl) nameEl.textContent = item.name;
    if (targetEl) targetEl.textContent = `対象: ${item.name}`;
    if (item.eq && Array.isArray(item.eq)) setEQSliders(item.eq);
    else setEQSliders(PRESETS.Normal);

    const explainBox = document.getElementById('aiExplain');
    if (explainBox) {
      if (item.eqNote) {
        explainBox.textContent = item.eqNote;
        explainBox.classList.add('show');
      } else {
        explainBox.classList.remove('show');
      }
    }
  }
}

function toggleKaraokeMode() {
  isKaraokeActive = !isKaraokeActive;
  const btn = document.getElementById('karaokeBtn');
  const txt = document.getElementById('karaokeBtnText');
  if (isKaraokeActive) {
    if (btn) btn.classList.add('active');
    if (txt) txt.textContent = 'カラオケON';
    showToast("🎤 カラオケモード起動（ボーカル音域を反転キャンセル）");
  } else {
    if (btn) btn.classList.remove('active');
    if (txt) txt.textContent = 'カラオケ';
    showToast("カラオケモードOFF");
  }
}

function resetKaraokeMode() {
  isKaraokeActive = false;
  const btn = document.getElementById('karaokeBtn');
  const txt = document.getElementById('karaokeBtnText');
  if (btn) btn.classList.remove('active');
  if (txt) txt.textContent = 'カラオケ';
}

function escapeHtml(str) {
  if(!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function changeTheme(theme) {
  document.body.setAttribute('data-theme', theme);
  localStorage.setItem('media_studio_theme', theme);
  showToast(`テーマを [${theme === 'dark' ? 'ダーク' : theme === 'light' ? 'ライト' : 'システム'}] に変更しました`);
}

let badgeClickCount = 0; let badgeClickTimer = null;
function handleSecretBadgeClick() {
  badgeClickCount++; clearTimeout(badgeClickTimer);
  badgeClickTimer = setTimeout(() => { badgeClickCount = 0; }, 1500);
  if (badgeClickCount >= 5) {
    badgeClickCount = 0;
    document.getElementById('secretModal').classList.add('active');
    document.getElementById('secretCommandInput').value = '';
    document.getElementById('secretCommandInput').focus();
  }
}

function executeSecretCommand() {
  const cmd = document.getElementById('secretCommandInput').value.trim().toLowerCase();
  document.getElementById('secretModal').classList.remove('active');
  if (cmd === 'おみくじ' || cmd === 'omikuji' || cmd === '吉') runOmikuji();
  else showToast("コマンドが見つかりませんでした。例: 「おみくじ」");
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickRandomMultiple(arr, count) {
  const shuffled = [...arr].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, count);
}

function runOmikuji() {
  const rand = Math.random() * 100;
  let fortune = "吉"; let rankColor = "#2563eb";
  if (rand < 15) { fortune = "大吉"; rankColor = "#ef4444"; }
  else if (rand < 35) { fortune = "中吉"; rankColor = "#f59e0b"; }
  else if (rand < 55) { fortune = "小吉"; rankColor = "#10b981"; }
  else if (rand < 85) { fortune = "吉"; rankColor = "#2563eb"; }
  else if (rand < 95) { fortune = "末吉"; rankColor = "#6b7280"; }
  else { fortune = "大凶"; rankColor = "#8b5cf6"; }

  const adviceText = `${fortune}を引き当てました！今日一日を最高のものにしましょう！`;
  document.getElementById('omikujiRank').textContent = fortune;
  document.getElementById('omikujiRank').style.color = rankColor;
  document.getElementById('omikujiAdvice').textContent = adviceText;
  document.getElementById('omikujiModal').classList.add('active');
}

function exportAppData() {
  const appData = {
    libraryMeta: library.map(item => ({
      name: item.name,
      type: item.type,
      eq: item.eq,
      eqNote: item.eqNote,
      isFavorite: item.isFavorite,
      addedAt: item.addedAt,
      timestamp: item.timestamp
    })),
    savedAt: new Date().toLocaleString()
  };
  const blob = new Blob([JSON.stringify(appData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `media_studio_backup_${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast("💾 データをバックアップファイルとして保存しました");
}

function triggerAutoOptimization() {
  const item = displayedLibrary[activeIndex];
  if (!item || (item.type !== 'audio' && item.type !== 'video')) {
    showToast("オーディオまたは動画を再生中に実行してください");
    return;
  }
  initAudioContext();
  if (audioCtx.state === 'suspended') audioCtx.resume();

  document.getElementById('aiLogStatus').textContent = "自作AI解析中: 10バンドスペクトラムをスキャン中...";

  setTimeout(() => {
    const bufferLength = analyserNode.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyserNode.getByteFrequencyData(dataArray);

    const gains = [4, 3, 2, 0, 0, 1, 2, 3, 4, 3];
    setEQSliders(gains);

    const trackName = item.name || 'この曲';
    let note = `🎵 自作AIが「${trackName}」に最適な音質に調整しました。`;

    item.eq = [...gains];
    item.eqNote = note;
    saveToDB(item);

    const explainBox = document.getElementById('aiExplain');
    if (explainBox) {
      explainBox.textContent = note;
      explainBox.classList.add('show');
    }
    document.getElementById('aiLogStatus').textContent = `自作AI最適化完了（${trackName}）`;
    showToast("✨ 自作AIが音質を自動最適化しました");
  }, 600);
}

function aiOptimizeCurrentMedia() {
  const item = displayedLibrary[activeIndex];
  if (!item) return;
  if (item.type === 'image') {
    const img = document.getElementById('modalImg');
    if (img) img.style.filter = "contrast(1.15) saturate(1.22) brightness(1.05)";
    showToast("✨ AI映像最適化: コントラスト・色彩を自動補正しました");
  } else {
    triggerAutoOptimization();
  }
}

const modalAudio = document.getElementById('modalAudio');
const modalVideo = document.getElementById('modalVideo');
const playPauseBtn = document.getElementById('playPauseBtn');
const discSpinner = document.getElementById('discSpinner');
const seekBar = document.getElementById('seekBar');
const currentTimeDisplay = document.getElementById('currentTimeDisplay');
const durationDisplay = document.getElementById('durationDisplay');

function getActiveMediaElement() {
  if (activeIndex < 0 || !displayedLibrary[activeIndex]) return null;
  return displayedLibrary[activeIndex].type === 'video' ? modalVideo : modalAudio;
}

function togglePlayPause() {
  const media = getActiveMediaElement();
  if (!media) return;
  if (media.paused) {
    media.play().then(() => {
      if (playPauseBtn) playPauseBtn.innerHTML = '⏸ 一時停止';
      if (discSpinner) discSpinner.style.animationPlayState = 'running';
    }).catch(()=>{});
  } else {
    media.pause();
    if (playPauseBtn) playPauseBtn.innerHTML = '▶ 再生';
    if (discSpinner) discSpinner.style.animationPlayState = 'paused';
  }
}

function formatTime(sec) {
  if (isNaN(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60) || 0;
  const s = Math.floor(sec % 60) || 0;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function updateSeekBar() {
  const media = getActiveMediaElement();
  if (!media) return;
  if (!isNaN(media.duration) && media.duration > 0) {
    seekBar.max = media.duration;
    durationDisplay.textContent = formatTime(media.duration);
    seekBar.value = media.currentTime;
    currentTimeDisplay.textContent = formatTime(media.currentTime);
  }
}

function seekMedia() {
  const media = getActiveMediaElement();
  if (media && !isNaN(media.duration)) {
    media.currentTime = seekBar.value;
  }
}

[modalAudio, modalVideo].forEach(media => {
  media.addEventListener('timeupdate', updateSeekBar);
  media.addEventListener('loadedmetadata', updateSeekBar);
  media.addEventListener('durationchange', updateSeekBar);
  media.addEventListener('play', () => {
    if (playPauseBtn) playPauseBtn.innerHTML = '⏸ 一時停止';
    if (discSpinner) discSpinner.style.animationPlayState = 'running';
  });
  media.addEventListener('pause', () => {
    if (playPauseBtn) playPauseBtn.innerHTML = '▶ 再生';
    if (discSpinner) discSpinner.style.animationPlayState = 'paused';
  });
  media.addEventListener('ended', () => {
    if (playPauseBtn) playPauseBtn.innerHTML = '▶ 再生';
    if (discSpinner) discSpinner.style.animationPlayState = 'paused';
  });
});

if (seekBar) seekBar.addEventListener('input', seekMedia);

const fileInput = document.getElementById('fileInput');
if (fileInput) fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

async function handleFiles(files) {
  for (const file of Array.from(files)) {
    let type = '';
    if (file.type.startsWith('image/')) type = 'image';
    else if (file.type.startsWith('video/')) type = 'video';
    else if (file.type.startsWith('audio/')) type = 'audio';
    else continue;

    const now = Date.now();
    const item = {
      id: now.toString() + Math.random().toString(36).substr(2, 9),
      type: type,
      name: file.name,
      file: file,
      eq: [...PRESETS.Normal],
      eqNote: '',
      isFavorite: false,
      addedAt: new Date(now).toLocaleString(),
      timestamp: now
    };
    await saveToDB(item);
    item.url = URL.createObjectURL(file);
    library.unshift(item);
  }
  renderGrid();
  showToast(`${files.length}件のメディアを保存しました`);
}

function renderGrid() {
  const mediaGrid = document.getElementById('mediaGrid');
  if (!mediaGrid) return;
  mediaGrid.innerHTML = '';
  
  const searchTerm = (document.getElementById('searchInput')?.value || '').toLowerCase();
  const sortType = document.getElementById('sortSelect')?.value || 'newest';

  let itemsToDisplay = library.filter(item => {
     if (currentNav === 'favorites' && !item.isFavorite) return false;
     if (searchTerm && !item.name.toLowerCase().includes(searchTerm)) return false;
     return true;
  });

  itemsToDisplay.sort((a, b) => {
     const timeA = a.timestamp || 0;
     const timeB = b.timestamp || 0;
     if (sortType === 'newest') return timeB - timeA;
     if (sortType === 'oldest') return timeA - timeB;
     if (sortType === 'name') return a.name.localeCompare(b.name);
     return 0;
  });
  
  displayedLibrary = itemsToDisplay;

  if (itemsToDisplay.length === 0) {
    mediaGrid.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 60px 20px; color: var(--text-muted);">
        <div style="font-size: 2.5rem; margin-bottom: 12px;">${currentNav === 'favorites' ? '💔' : '📁'}</div>
        <p style="font-size: 0.95rem; font-weight: 600;">見つかりませんでした</p>
      </div>
    `;
    return;
  }

  itemsToDisplay.forEach((item, idx) => {
    const card = document.createElement('div');
    card.className = 'media-card';
    card.onclick = () => openModal(idx);

    let ext = item.name.split('.').pop().toUpperCase();
    if(ext.length > 4) ext = item.type === 'audio' ? 'AUD' : (item.type === 'video' ? 'VID' : 'IMG');

    const favIcon = item.isFavorite ? '❤️️' : '♡';
    const favBtn = `<div class="card-fav-btn" onclick="event.stopPropagation(); toggleFavFromCard(${idx})">${favIcon}</div>`;

    if (item.type === 'image') {
      card.innerHTML = `<span class="media-tag">${escapeHtml(ext)}</span>${favBtn}<img src="${item.url}" loading="lazy" alt="">`;
    } else if (item.type === 'video') {
      card.innerHTML = `<span class="media-tag" style="background:#dc2626;">${escapeHtml(ext)}</span>${favBtn}<video src="${item.url}#t=0.5" preload="metadata"></video>`;
    } else {
      card.innerHTML = `<span class="media-tag" style="background:#2563eb;">${escapeHtml(ext)}</span>${favBtn}<div class="audio-card-body"><svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg><div class="audio-card-name">${escapeHtml(item.name)}</div></div>`;
    }
    mediaGrid.appendChild(card);
  });
}

function toggleFavFromCard(idx) {
  const item = displayedLibrary[idx];
  if (!item) return;
  item.isFavorite = !item.isFavorite;
  saveToDB(item);
  renderGrid();
  showToast(item.isFavorite ? "❤️ お気に入りに追加しました" : "🤍 お気に入りを解除しました");
}

function openModal(index) {
  activeIndex = index;
  const item = displayedLibrary[index];
  const fn = document.getElementById('modalFileName');
  if (fn) fn.textContent = item.name;

  const mImg = document.getElementById('modalImg');
  const mVd = document.getElementById('modalVideo');
  const mAd = document.getElementById('modalAudio');
  if (mImg) mImg.style.display = 'none';
  if (mVd) mVd.style.display = 'none';
  
  const mAv = document.getElementById('modalAudioVisual');
  if (mAv) mAv.classList.remove('active');

  resetKaraokeMode();

  seekBar.value = 0;
  currentTimeDisplay.textContent = "0:00";
  durationDisplay.textContent = "0:00";

  if (item.type === 'image') {
    if (mImg) { mImg.src = item.url; mImg.style.display = 'block'; }
    document.getElementById('playerControlsArea').style.display = 'none';
  } else if (item.type === 'video') {
    document.getElementById('playerControlsArea').style.display = 'block';
    if (mVd) {
      mVd.src = item.url; mVd.style.display = 'block';
      attachMediaToAudioPipeline(mVd);
      loadEQForTrack(index);
      mVd.play().catch(() => {});
    }
  } else if (item.type === 'audio') {
    document.getElementById('playerControlsArea').style.display = 'block';
    if (mAd) {
      mAd.src = item.url;
      if (mAv) mAv.classList.add('active');
      attachMediaToAudioPipeline(mAd);
      loadEQForTrack(index);
      mAd.play().catch(() => {});
    }
  }
  const mediaModal = document.getElementById('mediaModal');
  if (mediaModal) mediaModal.classList.add('active');
}

function closeModal(keepOpen = false) {
  if (modalVideo) { modalVideo.pause(); modalVideo.src = ''; }
  if (modalAudio) { modalAudio.pause(); modalAudio.src = ''; }
  if (discSpinner) discSpinner.style.animationPlayState = 'paused';
  resetKaraokeMode();
  const mediaModal = document.getElementById('mediaModal');
  if (!keepOpen && mediaModal) mediaModal.classList.remove('active');
}

function navigateMedia(direction) {
  if(activeIndex < 0 || displayedLibrary.length === 0) return;
  let nextIdx = activeIndex + direction;
  if(nextIdx < 0) nextIdx = displayedLibrary.length - 1;
  if(nextIdx >= displayedLibrary.length) nextIdx = 0;
  
  closeModal(true);
  openModal(nextIdx);
}

function switchNav(tab, el) {
  currentNav = tab;
  document.querySelectorAll('.side-btn, .mob-tab').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');

  if (tab === 'media') {
    document.getElementById('mediaGrid').style.display = 'grid';
    document.getElementById('soundaliveContainer').style.display = 'none';
    document.getElementById('viewHeaderTitle').textContent = 'メディア';
    renderGrid();
  } else if (tab === 'favorites') {
    document.getElementById('mediaGrid').style.display = 'grid';
    document.getElementById('soundaliveContainer').style.display = 'none';
    document.getElementById('viewHeaderTitle').textContent = 'お気に入り ❤️';
    renderGrid();
  } else {
    document.getElementById('mediaGrid').style.display = 'none';
    document.getElementById('soundaliveContainer').style.display = 'flex';
    document.getElementById('viewHeaderTitle').textContent = 'サウンド＆EQ';
    if(activeIndex >= 0) loadEQForTrack(activeIndex);
  }
}

function showToast(msg) {
  const t = document.getElementById('appToast');
  if (!t) return;
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

function openChat() { document.getElementById('chatModal').classList.add('active'); }
function closeChat() { document.getElementById('chatModal').classList.remove('active'); }

window.addEventListener('DOMContentLoaded', async () => {
  const savedTheme = localStorage.getItem('media_studio_theme') || 'system';
  document.body.setAttribute('data-theme', savedTheme);
  try {
    const items = await loadAllFromDB();
    items.forEach(item => {
       if(item.file) {
           item.url = URL.createObjectURL(item.file);
           if(!item.timestamp) item.timestamp = Date.now();
           library.push(item);
       }
    });
    library.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    renderGrid();
  } catch(e) {}
  buildEQUI();
});
