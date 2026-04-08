const photoInput = document.getElementById('photoInput');
const preview = document.getElementById('preview');
const candidateList = document.getElementById('candidateList');
const toast = document.getElementById('toast');
const form = document.getElementById('profileForm');
const modal = document.getElementById('modal');
const modalContent = document.getElementById('modalContent');
const modalClose = document.getElementById('modalClose');
const cameraToggle = document.getElementById('cameraToggle');
const videoEl = document.getElementById('video');
const canvasEl = document.getElementById('canvas');
const captureBtn = document.getElementById('captureBtn');
const archiveList = document.getElementById('archiveList');
const archiveClear = document.getElementById('archiveClear');

let stream = null;
let archives = [];
let modelsLoaded = false;
let myProfile = null;

// Demo freshmen (DB未接続のためダミー)
let freshmen = [
  { id: 'f1', name: '山田 太郎', department: '情報工学科 1年', tags: ['ゲーム制作', 'バドミントン', 'AI'], intro: 'プログラミング同好会でゲームエンジン班。' },
  { id: 'f2', name: '佐藤 花子', department: 'デザイン学部 1年', tags: ['UI/UX', '写真', 'カフェ'], intro: 'Figmaが得意。写真部にも所属。' },
  { id: 'f3', name: '鈴木 一平', department: '経済学部 1年', tags: ['起業', 'ランニング', '読書'], intro: 'スタートアップ研究会でピッチ練習中。' }
];

photoInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  renderPreview(url);
  await ensureModels();
  const embedding = await extractEmbeddingFromFile(file);
  const candidates = fakeMatch();
  renderCandidates(candidates);
  addArchive(url, candidates[0]?.name || '不明');
});

cameraToggle.addEventListener('click', async () => {
  if (stream) {
    stopCamera();
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
    videoEl.srcObject = stream;
    videoEl.classList.remove('hidden');
    captureBtn.classList.remove('hidden');
    preview.querySelector('.placeholder')?.classList.add('hidden');
    showToast('カメラを起動しました');
    await ensureModels();
  } catch (e) {
    console.error(e);
    showToast('カメラを利用できません');
  }
});

captureBtn.addEventListener('click', async () => {
  if (!stream) return;
  const ctx = canvasEl.getContext('2d');
  canvasEl.width = videoEl.videoWidth;
  canvasEl.height = videoEl.videoHeight;
  ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
  const dataUrl = canvasEl.toDataURL('image/jpeg');
  renderPreview(dataUrl);
  const blob = await (await fetch(dataUrl)).blob();
  const embedding = await extractEmbeddingFromFile(blob);
  const candidates = fakeMatch();
  renderCandidates(candidates);
  addArchive(dataUrl, candidates[0]?.name || '不明');
});

function stopCamera() {
  stream?.getTracks().forEach(t => t.stop());
  stream = null;
  videoEl.classList.add('hidden');
  captureBtn.classList.add('hidden');
  preview.querySelector('.placeholder')?.classList.remove('hidden');
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = form.name.value.trim();
  const dept = form.department.value.trim();
  const tags = form.tags.value.split(',').map(t => t.trim()).filter(Boolean);
  const intro = form.intro.value.trim();
  if (!name) return showToast('名前は必須です');
  myProfile = { name, department: dept || '未設定', tags, intro: intro || '未設定' };
  form.reset();
  showToast('あなたのプロフィールを登録しました');
});

async function ensureModels() {
  if (modelsLoaded) return;
  const MODEL_URL = 'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/weights';
  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
    faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
    faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
  ]);
  modelsLoaded = true;
}

async function extractEmbeddingFromFile(file) {
  try {
    const img = await faceapi.bufferToImage(file);
    const det = await faceapi.detectSingleFace(img, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceDescriptor();
    if (!det || !det.descriptor) return null;
    const desc = Array.from(det.descriptor); // 128 dims
    const padded = new Array(512).fill(0);
    for (let i = 0; i < Math.min(128, padded.length); i++) padded[i] = desc[i];
    return padded;
  } catch (e) {
    console.warn('detect failed', e);
    return null;
  }
}

function fakeMatch() {
  return freshmen
    .map((p) => ({ ...p, score: Math.random() * 0.3 + 0.05 }))
    .sort((a, b) => a.score - b.score)
    .slice(0, 5);
}

function renderPreview(url) {
  // show captured image
  const existing = preview.querySelector('img.captured');
  if (existing) existing.remove();
  const img = document.createElement('img');
  img.src = url;
  img.className = 'captured';
  preview.appendChild(img);
  preview.querySelector('.placeholder')?.classList.add('hidden');
  videoEl.classList.add('hidden');
  captureBtn.classList.add('hidden');
  const cardExisting = preview.querySelector('.overlay-card');
  if (cardExisting) cardExisting.remove();
  const card = document.createElement('div');
  card.className = 'overlay-card';
  card.innerHTML = `<h4>マッチ候補</h4><p class="mini">現在はダミーデータで表示</p>`;
  preview.appendChild(card);
}

function renderCandidates(list) {
  candidateList.innerHTML = '';
  list.forEach((p, idx) => {
    const li = document.createElement('li');
    li.className = 'candidate';
    li.innerHTML = `
      <div class="info">
        <h4>${idx + 1}. ${p.name}</h4>
        <p>${p.department}</p>
        <p class="muted">${p.intro}</p>
      </div>
      <div class="chip">距離 ${Number(p.score).toFixed(2)}</div>
    `;
    li.addEventListener('click', () => openModal(p));
    candidateList.appendChild(li);
  });
}

function openModal(profile) {
  modalContent.innerHTML = `
    <h3>${profile.name}</h3>
    <p class="muted">${profile.department}</p>
    <div class="tag-row">${(profile.tags || []).map(t => `<span class="chip">${t}</span>`).join('')}</div>
    <p style="margin-top:12px;">${profile.intro || ''}</p>
  `;
  modal.classList.remove('hidden');
}

modalClose.addEventListener('click', () => modal.classList.add('hidden'));
modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });

archiveClear.addEventListener('click', () => {
  archives = [];
  renderArchive();
});

function addArchive(imageUrl, topName) {
  archives = [{ imageUrl, topName, ts: new Date() }, ...archives];
  renderArchive();
}

function renderArchive() {
  if (!archives.length) {
    archiveList.textContent = 'まだありません';
    archiveList.classList.add('muted');
    return;
  }
  archiveList.classList.remove('muted');
  archiveList.innerHTML = '';
  archives.forEach((a) => {
    const card = document.createElement('div');
    card.className = 'archive-card';
    card.innerHTML = `
      <img src="${a.imageUrl}" alt="snapshot" />
      <div class="archive-meta">
        <span>${a.topName}</span>
        <span>${formatTime(a.ts)}</span>
      </div>
    `;
    archiveList.appendChild(card);
  });
}

function formatTime(d) {
  const dt = new Date(d);
  return `${dt.getMonth() + 1}/${dt.getDate()} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
}

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 1800);
}

// 初期ダミー描画
renderCandidates(freshmen.map((p, i) => ({ ...p, score: 0.1 + i * 0.05 })));
renderArchive();
