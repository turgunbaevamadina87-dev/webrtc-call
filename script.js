const SIGNALING_URL = 'wss://inai-col3.fishrungames.com/signaling/';
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

const $ = (id) => document.getElementById(id);
const localVideo = $('localVideo');
const remoteVideo = $('remoteVideo');
const statusEl = $('status');
const waitingEl = $('waiting');
const joinBtn = $('joinBtn');
const micBtn = $('micBtn');
const camBtn = $('camBtn');
const leaveBtn = $('leaveBtn');

let ws = null;
let pc = null;
let localStream = null;
let pendingCandidates = [];
let leaving = false;

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = 'status ' + kind;
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ---------- Камера и микрофон ----------
async function startMedia() {
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  localVideo.srcObject = localStream;
}

function stopMedia() {
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  localStream = null;
  localVideo.srcObject = null;
}

// ---------- WebRTC ----------
function createPeerConnection() {
  closePeerConnection();
  pc = new RTCPeerConnection(RTC_CONFIG);
  pendingCandidates = [];

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.ontrack = (e) => {
    remoteVideo.srcObject = e.streams[0];
    waitingEl.classList.add('hidden');
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) send({ type: 'candidate', candidate: e.candidate });
  };

  pc.onconnectionstatechange = () => {
    if (!pc) return;
    const s = pc.connectionState;
    if (s === 'connected') setStatus('Соединение установлено', 'ok');
    else if (s === 'connecting') setStatus('Соединяемся…');
    else if (s === 'failed') setStatus('Не удалось соединиться', 'err');
    else if (s === 'disconnected') setStatus('Соединение потеряно…', 'err');
  };
}

function closePeerConnection() {
  if (pc) {
    pc.ontrack = pc.onicecandidate = pc.onconnectionstatechange = null;
    pc.close();
    pc = null;
  }
  pendingCandidates = [];
  remoteVideo.srcObject = null;
}

async function makeOffer() {
  createPeerConnection();
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send({ type: 'offer', sdp: pc.localDescription });
  setStatus('Звоним собеседнику…');
}

async function handleOffer(sdp) {
  createPeerConnection();
  await pc.setRemoteDescription(sdp);
  await flushCandidates();
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  send({ type: 'answer', sdp: pc.localDescription });
}

async function handleAnswer(sdp) {
  if (!pc || pc.signalingState !== 'have-local-offer') return;
  await pc.setRemoteDescription(sdp);
  await flushCandidates();
}

async function handleCandidate(candidate) {
  // кандидат может прийти раньше, чем установлен remoteDescription
  if (!pc || !pc.remoteDescription) {
    pendingCandidates.push(candidate);
    return;
  }
  try { await pc.addIceCandidate(candidate); } catch (e) { console.warn('addIceCandidate', e); }
}

async function flushCandidates() {
  for (const c of pendingCandidates) {
    try { await pc.addIceCandidate(c); } catch (e) { console.warn('addIceCandidate', e); }
  }
  pendingCandidates = [];
}

// ---------- Signaling ----------
function connectSignaling() {
  ws = new WebSocket(SIGNALING_URL);

  ws.onopen = () => {
    setStatus('Подключено к серверу. Ожидаем собеседника…', 'ok');
    waitingEl.classList.remove('hidden');
    // Если собеседник уже в комнате — он получит hello и позвонит нам.
    send({ type: 'hello' });
  };

  ws.onmessage = async (event) => {
    let text = event.data;
    if (text instanceof Blob) text = await text.text();
    let msg;
    try { msg = JSON.parse(text); } catch { return; }

    try {
      switch (msg.type) {
        case 'hello':
          // собеседник только что зашёл — мы звоним ему
          await makeOffer();
          break;
        case 'offer':
          await handleOffer(msg.sdp);
          break;
        case 'answer':
          await handleAnswer(msg.sdp);
          break;
        case 'candidate':
          await handleCandidate(msg.candidate);
          break;
        case 'peer-left':
          closePeerConnection();
          waitingEl.classList.remove('hidden');
          setStatus('Собеседник вышел. Ожидаем нового…');
          break;
      }
    } catch (e) {
      console.error(e);
      setStatus('Ошибка: ' + e.message, 'err');
    }
  };

  ws.onclose = () => {
    if (leaving) return;
    // сервер закрывает соединение, если подключился третий участник
    closePeerConnection();
    stopMedia();
    resetUI();
    setStatus('Соединение с сервером закрыто (возможно, подключился третий участник)', 'err');
  };

  ws.onerror = () => setStatus('Ошибка WebSocket', 'err');
}

// ---------- UI ----------
function resetUI() {
  joinBtn.disabled = false;
  micBtn.disabled = camBtn.disabled = leaveBtn.disabled = true;
  micBtn.textContent = '🎤 Микрофон: вкл';
  camBtn.textContent = '📷 Камера: вкл';
  waitingEl.classList.add('hidden');
}

joinBtn.onclick = async () => {
  joinBtn.disabled = true;
  leaving = false;
  try {
    setStatus('Запрашиваем доступ к камере и микрофону…');
    await startMedia();
  } catch (e) {
    setStatus('Нет доступа к камере/микрофону: ' + e.message, 'err');
    joinBtn.disabled = false;
    return;
  }
  micBtn.disabled = camBtn.disabled = leaveBtn.disabled = false;
  connectSignaling();
};

micBtn.onclick = () => {
  const track = localStream && localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  micBtn.textContent = '🎤 Микрофон: ' + (track.enabled ? 'вкл' : 'выкл');
};

camBtn.onclick = () => {
  const track = localStream && localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  camBtn.textContent = '📷 Камера: ' + (track.enabled ? 'вкл' : 'выкл');
};

leaveBtn.onclick = () => {
  leaving = true;
  if (ws) ws.close();
  ws = null;
  closePeerConnection();
  stopMedia();
  resetUI();
  setStatus('Вы вышли из комнаты');
};
