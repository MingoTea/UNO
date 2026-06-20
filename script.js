// ─────────────────────────────────────────────
// FIREBASE SETUP
// ─────────────────────────────────────────────
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getDatabase, ref, set, get, update, onValue, off, remove, push }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db  = getDatabase(app);

// ─────────────────────────────────────────────
// CONSTANTS & STATE
// ─────────────────────────────────────────────
const MAX_PLAYERS = 12;
const AVATARS = ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮'];

let myId      = 'p_' + Math.random().toString(36).substr(2, 9);
let myName    = '';
let myAvatar  = '';
let roomCode  = '';
let isHost    = false;
let players   = [];
let gameState = null;
let pendingWild = null;

// Listener unsubscribe functions
let unsubRooms   = null;
let unsubPlayers = null;
let unsubStatus  = null;   // watches games/{code}/status → "started"
let unsubState   = null;   // watches games/{code}/state  (non-host only)
let unsubActions = null;   // watches games/{code}/actions (host only)
let unsubChat    = null;

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function randomCode() {
  return Math.random().toString(36).substr(2, 4).toUpperCase();
}

function detachAll() {
  [unsubRooms, unsubPlayers, unsubStatus, unsubState, unsubActions, unsubChat]
    .forEach(u => { if (u) u(); });
  unsubRooms = unsubPlayers = unsubStatus = unsubState = unsubActions = unsubChat = null;
}

// ─────────────────────────────────────────────
// LOBBY
// ─────────────────────────────────────────────
function startLobbyListener() {
  if (unsubRooms) return;
  unsubRooms = onValue(ref(db, 'rooms'), snap => {
    const data = snap.val() || {};
    const now  = Date.now();
    const entries = Object.values(data).filter(
      r => !r.gameStarted && r.playerCount < MAX_PLAYERS && (now - r.ts) < 120000
    );
    const list = document.getElementById('room-list');
    if (entries.length === 0) {
      list.innerHTML = '<div id="no-rooms">Chưa có phòng nào. Hãy tạo phòng đầu tiên!</div>';
      return;
    }
    list.innerHTML = entries.map(r => `
      <div class="room-item" onclick="quickJoin('${escHtml(r.code)}')">
        <div>
          <div class="room-name">${escHtml(r.name || r.code)}</div>
          <div class="room-count">Mã: <b>${escHtml(r.code)}</b></div>
        </div>
        <div class="room-count">${r.playerCount}/${MAX_PLAYERS} 👥</div>
      </div>
    `).join('');
  });
}

// ─────────────────────────────────────────────
// CREATE ROOM
// ─────────────────────────────────────────────
window.createRoom = async function () {
  const nameInput = document.getElementById('create-name').value.trim();
  if (!nameInput) { toast('Nhập tên của bạn!'); return; }
  myName   = nameInput;
  myAvatar = AVATARS[Math.floor(Math.random() * AVATARS.length)];
  const roomInput = document.getElementById('create-room').value.trim();
  roomCode = roomInput.substring(0, 4).toUpperCase() || randomCode();
  isHost   = true;
  players  = [{ id: myId, name: myName, avatar: myAvatar, isHost: true }];

  await set(ref(db, `rooms/${roomCode}`), {
    code: roomCode, name: roomInput || 'Phòng ' + roomCode,
    playerCount: 1, gameStarted: false, ts: Date.now()
  });
  await set(ref(db, `games/${roomCode}/players`), players);

  if (unsubRooms) { unsubRooms(); unsubRooms = null; }
  attachWaitingListeners();
  showWaiting();
};

window.quickJoin = function (code) {

  const name =
    document.getElementById('create-name').value.trim();

  if (!name) {
    toast('Nhập tên của bạn trước!');
    document.getElementById('create-name').focus();
    return;
  }

  doJoin(code, name);
};

async function doJoin(code, name) {
  myName   = name;
  myAvatar = AVATARS[Math.floor(Math.random() * AVATARS.length)];
  roomCode = code;
  isHost   = false;

  const roomSnap = await get(ref(db, `rooms/${roomCode}`));
  if (!roomSnap.exists())              { toast('Không tìm thấy phòng!'); return; }
  const room = roomSnap.val();
  if (room.gameStarted)                { toast('Game đã bắt đầu rồi!'); return; }
  if (room.playerCount >= MAX_PLAYERS) { toast('Phòng đã đầy!'); return; }

  const playersSnap = await get(ref(db, `games/${roomCode}/players`));
  const existing    = toArray(playersSnap.val());
  if (!existing.find(p => p.id === myId))
    existing.push({ id: myId, name: myName, avatar: myAvatar, isHost: false });

  players = existing;
  await set(ref(db, `games/${roomCode}/players`), players);
  await update(ref(db, `rooms/${roomCode}`), { playerCount: players.length });

  if (unsubRooms) { unsubRooms(); unsubRooms = null; }
  attachWaitingListeners();
  showWaiting();
}

// ─────────────────────────────────────────────
// WAITING ROOM LISTENERS
// ─────────────────────────────────────────────
function toArray(val) {
  // Firebase stores arrays as objects {0:..., 1:...} when keys are numeric
  if (!val) return [];
  if (Array.isArray(val)) return val;
  return Object.values(val);
}

function normalizeState(gs) {
  // Firebase converts arrays → objects; convert back everywhere
  gs.players = toArray(gs.players).map(p => ({
    ...p,
    hand: toArray(p.hand)
  }));
  gs.discard = toArray(gs.discard);
  gs.deck    = toArray(gs.deck);
  return gs;
}

function attachWaitingListeners() {

  if (unsubPlayers) return;

  // Danh sách người chơi
  unsubPlayers = onValue(ref(db, `games/${roomCode}/players`), snap => {

    if (!snap.exists()) return;

    players = toArray(snap.val());

    renderWaiting();
  });

  // Chuyển sang game khi state xuất hiện
  unsubState = onValue(ref(db, `games/${roomCode}/state`), snap => {

    if (!snap.exists()) return;

    gameState = normalizeState(snap.val());

    if (document.getElementById('game').style.display !== 'block') {

      document.getElementById('waiting').style.display = 'none';

      showGame();
    }

    renderGame();
  });
}

function renderWaiting() {
  const list  = document.getElementById('player-list-wait');
  const slots = [];
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const p = players[i];
    slots.push(p
      ? `<div class="player-wait-card ${p.id===myId?'me':''} ${p.isHost?'host':''}">
           <div class="avatar">${p.avatar}</div>
           <div>${escHtml(p.name)}</div>
         </div>`
      : `<div class="player-wait-card"><div class="slot-empty">Chờ...</div></div>`
    );
  }
  list.innerHTML = slots.join('');
  document.getElementById('wait-status').textContent = `${players.length}/${MAX_PLAYERS} người chơi`;
  document.getElementById('start-btn').style.display =
    (isHost && players.length >= 2) ? 'block' : 'none';
}

function showWaiting() {
  document.getElementById('lobby').style.display   = 'none';
  document.getElementById('waiting').style.display = 'flex';
  document.getElementById('room-code-display').textContent = roomCode;
  renderWaiting();
}

window.leaveRoom = async function () {
  detachAll();
  if (isHost) {
    await remove(ref(db, `rooms/${roomCode}`));
    await remove(ref(db, `games/${roomCode}`));
  } else {
    const updated = players.filter(p => p.id !== myId);
    await set(ref(db, `games/${roomCode}/players`), updated);
    await update(ref(db, `rooms/${roomCode}`), { playerCount: updated.length });
  }
  location.reload();
};

// ─────────────────────────────────────────────
// GAME START (HOST)
// ─────────────────────────────────────────────
window.startGame = async function () {
  if (!isHost || players.length < 2) return;

  const deck        = buildDeck();
  const gamePlayers = players.map(p => ({
    id: p.id, name: p.name, avatar: p.avatar,
    hand: deck.splice(0, 7), calledUno: false
  }));

  let topIdx = deck.findIndex(c => c.color !== 'wild');
  const topCard = deck.splice(topIdx, 1)[0];
  topCard.activeColor = topCard.color;

  gameState = {
    players: gamePlayers, deck, discard: [topCard],
    currentTurn: 0, direction: 1, drawStack: 0,
    phase: 'play', winner: null,
  };

  applyTopCardEffect(true);

await set(ref(db, `games/${roomCode}/state`), gameState);
console.log("HOST START GAME");
console.log(gameState);

await update(ref(db, `rooms/${roomCode}`), {
  gameStarted: true
});

attachGameStateListener();
attachActionsListener();

document.getElementById('waiting').style.display = 'none';

showGame();
};

// ─────────────────────────────────────────────
// GAME LISTENERS
// ─────────────────────────────────────────────

// Non-host: watch state node for every update from host
function attachGameStateListener() {

  if (unsubState) return;

  unsubState = onValue(ref(db, `games/${roomCode}/state`), snap => {

    if (!snap.exists()) return;

    const prev = gameState;

    gameState = normalizeState(snap.val());

    if (document.getElementById('game').style.display !== 'block') {
      showGame();
    }

    renderGame();

    if (gameState.winner && (!prev || !prev.winner)) {

      setTimeout(() => {
        endGame(gameState.winner);
      }, 300);
    }
  });

  attachChatListener();
}

// Host: watch actions queue
function attachActionsListener() {
  if (unsubActions) return;
  unsubActions = onValue(ref(db, `games/${roomCode}/actions`), snap => {
    if (!snap.exists()) return;
    const actions = snap.val();
    Object.entries(actions).forEach(([key, act]) => {
      if (act.processed) return;
      processAction(act.fromId, act.action, act.payload);
      update(ref(db, `games/${roomCode}/actions/${key}`), { processed: true });
    });
  });

  // Also attach chat
  attachChatListener();
}

function attachChatListener() {
  if (unsubChat) return;
  unsubChat = onValue(ref(db, `games/${roomCode}/chat`), snap => {
    if (!snap.exists()) return;
    const msgs = snap.val();
    const last = Object.values(msgs).sort((a, b) => b.ts - a.ts)[0];
    if (last && last.fromId !== myId) {
      const el = document.getElementById('chat-log');
      if (el) el.textContent = `${last.fromName}: ${last.msg}`;
    }
  });
}

// ─────────────────────────────────────────────
// CARD ENGINE
// ─────────────────────────────────────────────
const COLORS   = ['red','blue','green','yellow'];
const SPECIALS = ['Skip','Rev','+2'];

function buildDeck() {
  const deck = []; let id = 0;
  for (const c of COLORS) {
    deck.push({ id: id++, color: c, value: '0', display: '0' });
    for (let i = 1; i <= 9; i++)
      for (let j = 0; j < 2; j++) deck.push({ id: id++, color: c, value: String(i), display: String(i) });
    for (const s of SPECIALS)
      for (let j = 0; j < 2; j++) deck.push({
        id: id++, color: c, value: s,
        display: s === 'Rev' ? '↩' : s === 'Skip' ? '⊘' : '+2'
      });
  }
  for (let i = 0; i < 4; i++) deck.push({ id: id++, color: 'wild', value: 'Wild',   display: '🌈' });
  for (let i = 0; i < 4; i++) deck.push({ id: id++, color: 'wild', value: 'Wild+4', display: '🌈+4' });
  return shuffle(deck);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function canPlay(card, top) {
  if (!top)                           return true;
  if (card.color === 'wild')          return true;
  if (card.color === top.activeColor) return true;
  if (card.value === top.value)       return true;
  return false;
}

function cardHTML(card) {
  return `<div class="card ${card.color}" data-id="${card.id}" onclick="playCard(${card.id})">
    <span class="corner tl">${card.display}</span>
    <span class="center">${card.display}</span>
    <span class="corner br">${card.display}</span>
  </div>`;
}

// ─────────────────────────────────────────────
// TURN MANAGEMENT (HOST)
// ─────────────────────────────────────────────
function advanceTurn(skip = false) {
  const gs = gameState, steps = skip ? 2 : 1;
  gs.currentTurn = ((gs.currentTurn + gs.direction * steps) % gs.players.length + gs.players.length) % gs.players.length;
}

function forceDraw(count) {
  const gs = gameState, target = gs.players[gs.currentTurn];
  const n  = count ?? gs.drawStack ?? 1;
  for (let i = 0; i < n; i++) {
    if (gs.deck.length === 0) reshuffleDeck();
    if (gs.deck.length > 0) target.hand.push(gs.deck.pop());
  }
  target.calledUno = false;
}

function reshuffleDeck() {
  const gs = gameState;
  if (gs.discard.length <= 1) return;
  const top = gs.discard.pop();
  gs.deck   = shuffle(gs.discard.map(c => { const nc = {...c}; delete nc.activeColor; return nc; }));
  gs.discard = [top];
}

function applyTopCardEffect(isFirst = false) {
  const gs = gameState, top = gs.discard[gs.discard.length - 1];
  if (top.value === 'Rev')                    { gs.direction *= -1; }
  else if (top.value === 'Skip' && isFirst)   { advanceTurn(); }
  else if (top.value === '+2' && isFirst)     { gs.drawStack += 2; advanceTurn(); forceDraw(); gs.drawStack = 0; }
}

// ─────────────────────────────────────────────
// ACTION PROCESSOR (HOST)
// ─────────────────────────────────────────────
function processAction(fromId, action, payload) {
  const gs = gameState, cur = gs.players[gs.currentTurn];

  if (action === 'PLAY_CARD') {
    if (cur.id !== fromId) return;
    const cardIdx = cur.hand.findIndex(c => c.id === payload.cardId);
    if (cardIdx === -1) return;
    const card = cur.hand[cardIdx];
    const top  = gs.discard[gs.discard.length - 1];

    if (gs.drawStack > 0 && card.value !== '+2' && card.value !== 'Wild+4') {
      forceDraw(gs.drawStack); gs.drawStack = 0; advanceTurn(); broadcastState(); return;
    }
    if (!canPlay(card, top)) return;

    cur.hand.splice(cardIdx, 1);
    card.activeColor = payload.chosenColor || card.color;
    gs.discard.push(card);

    if (cur.hand.length === 0) {
      gs.winner = { id: cur.id, name: cur.name };
      broadcastState(); return;
    }
    if (cur.hand.length !== 1) cur.calledUno = false;

    if      (card.value === 'Skip')   { advanceTurn(true); }
    else if (card.value === 'Rev')    { gs.direction *= -1; gs.players.length === 2 ? advanceTurn(true) : advanceTurn(); }
    else if (card.value === '+2')     {
      gs.drawStack += 2; advanceTurn();
      const next = gs.players[gs.currentTurn];
      if (!next.hand.some(c => c.value === '+2' || c.value === 'Wild+4'))
        { forceDraw(gs.drawStack); gs.drawStack = 0; advanceTurn(); }
    }
    else if (card.value === 'Wild+4') {
      gs.drawStack += 4; advanceTurn();
      const next = gs.players[gs.currentTurn];
      if (!next.hand.some(c => c.value === 'Wild+4'))
        { forceDraw(gs.drawStack); gs.drawStack = 0; advanceTurn(); }
    }
    else { advanceTurn(); }

    broadcastState();
  }

  else if (action === 'DRAW_CARD') {
    if (cur.id !== fromId) return;
    const top = gs.discard[gs.discard.length - 1];
    if (gs.drawStack > 0) { forceDraw(gs.drawStack); gs.drawStack = 0; }
    else {
      forceDraw(1);
      const drawn = cur.hand[cur.hand.length - 1];
      if (!canPlay(drawn, top)) advanceTurn();
    }
    broadcastState();
  }

  else if (action === 'CATCH_UNO') {
    const target = gs.players.find(p => p.id === payload.targetId);
    if (target && target.hand.length === 1 && !target.calledUno) {
      for (let i = 0; i < 2; i++) {
        if (gs.deck.length === 0) reshuffleDeck();
        if (gs.deck.length) target.hand.push(gs.deck.pop());
      }
      toast(`${target.name} bị bắt UNO! +2 bài 🎉`);
      broadcastState();
    }
  }

  else if (action === 'UNO_CALL') {
    const gp = gs.players.find(p => p.id === fromId);
    if (gp) { gp.calledUno = true; broadcastState(); }
    toast(`${payload.name} hô UNO! 🔴`);
  }
}

async function broadcastState() {
  await set(ref(db, `games/${roomCode}/state`), gameState);
  renderGame();
  if (gameState.winner) setTimeout(() => endGame(gameState.winner), 300);
}

// ─────────────────────────────────────────────
// MY ACTIONS (CLIENT)
// ─────────────────────────────────────────────
window.playCard = function (cardId) {
  if (!gameState) return;
  const me  = gameState.players.find(p => p.id === myId);
  if (!me)  return;
  const cur = gameState.players[gameState.currentTurn];
  if (cur.id !== myId) { toast('Chưa đến lượt bạn!'); return; }
  const card = me.hand.find(c => c.id === cardId);
  if (!card) return;
  const top = gameState.discard[gameState.discard.length - 1];
  if (gameState.drawStack > 0 && card.value !== '+2' && card.value !== 'Wild+4')
    { toast(`Phải đánh +2/+4, hoặc rút ${gameState.drawStack} bài!`); return; }
  if (!canPlay(card, top) && gameState.drawStack === 0)
    { toast('Không thể đánh bài này!'); return; }
  if (card.color === 'wild') { pendingWild = cardId; document.getElementById('color-picker').classList.add('show'); return; }
  sendAction('PLAY_CARD', { cardId });
};

window.pickColor = function (color) {
  document.getElementById('color-picker').classList.remove('show');
  if (pendingWild !== null) { sendAction('PLAY_CARD', { cardId: pendingWild, chosenColor: color }); pendingWild = null; }
};

window.drawCard = function () {
  if (!gameState) return;
  if (gameState.players[gameState.currentTurn].id !== myId) { toast('Chưa đến lượt bạn!'); return; }
  sendAction('DRAW_CARD', {});
};

window.callUno = function () {
  if (!gameState) return;
  sendAction('UNO_CALL', { name: myName });
  toast('Bạn hô UNO! 🔴');
  document.getElementById('uno-btn').classList.remove('show');
};

window.tryCatchUno = function (targetId) {
  if (!gameState) return;
  const target = gameState.players.find(p => p.id === targetId);
  if (target && target.hand.length === 1 && !target.calledUno)
    { sendAction('CATCH_UNO', { targetId }); toast(`Bắt UNO ${target.name}! 🎯`); }
};

async function sendAction(action, payload) {
  if (isHost) {
    processAction(myId, action, payload);
  } else {
    await push(ref(db, `games/${roomCode}/actions`), {
      fromId: myId, fromName: myName, action, payload,
      ts: Date.now(), processed: false
    });
  }
}

// ─────────────────────────────────────────────
// RENDER GAME
// ─────────────────────────────────────────────
function showGame() {
  document.getElementById('waiting').style.display = 'none';
  document.getElementById('lobby').style.display   = 'none';
  document.getElementById('game').style.display    = 'block';
  renderGame();
}

function renderGame() {
  if (gameState.winner) {

  if (!document.getElementById('win-screen').classList.contains('show')) {

    setTimeout(() => {
      endGame(gameState.winner);
    }, 200);

  }

  return;
}
  if (!gameState) return;
  const gs  = gameState;
  const myIdx = gs.players.findIndex(p => p.id === myId);
  const me  = gs.players[myIdx];
  const cur = gs.players[gs.currentTurn];
  const top = gs.discard[gs.discard.length - 1];
  const isMyTurn = cur && cur.id === myId;

  const ti = document.getElementById('turn-indicator');
  ti.textContent = isMyTurn ? '🎯 Lượt của bạn!' : `⏳ Lượt: ${cur ? cur.name : '?'}`;
  ti.className   = isMyTurn ? 'my-turn' : '';

  document.getElementById('direction-indicator').textContent = gs.direction === 1 ? '🔄' : '🔃';
  document.getElementById('deck-count').textContent =
    ` ${gs.deck.length} bài` + (gs.drawStack > 0 ? ` | Stack: +${gs.drawStack}` : '');

  const dp = document.getElementById('discard-pile');
  if (top) dp.innerHTML = cardHTML(top);

  document.getElementById('my-name-display').textContent = me ? me.name : 'Bạn';
  document.getElementById('my-card-count').textContent   = me ? `${me.hand.length} bài` : '';

  const handContainer = document.getElementById('hand-container');
  if (me) {
    handContainer.innerHTML = me.hand.map(card => {
      const playable = isMyTurn && (
        gs.drawStack === 0 ? canPlay(card, top) : (card.value === '+2' || card.value === 'Wild+4')
      );
      return `<div class="card ${card.color}${playable?' playable':''}" data-id="${card.id}" onclick="playCard(${card.id})">
        <span class="corner tl">${card.display}</span>
        <span class="center">${card.display}</span>
        <span class="corner br">${card.display}</span>
      </div>`;
    }).join('');
  }

  const unoBtn = document.getElementById('uno-btn');
  (me && me.hand.length === 2 && isMyTurn)
    ? unoBtn.classList.add('show') : unoBtn.classList.remove('show');

  renderOtherPlayers(myIdx);
}

function renderOtherPlayers(myIdx) {
  const gs = gameState, container = document.getElementById('other-players-container');
  const others = gs.players.filter((_, i) => i !== myIdx);
  const n = others.length;
  if (n === 0) { container.innerHTML = ''; return; }
  const W = window.innerWidth, H = window.innerHeight, handH = 120;
  let html = '';
  others.forEach((p, i) => {
    const angle = Math.PI + (Math.PI * (i + 1) / (n + 1));
    const cx = W/2, cy = (H-handH)/2;
    const rx = Math.min(W*0.42,280), ry = Math.min((H-handH)*0.38,150);
    const x = cx + rx*Math.cos(angle), y = cy + ry*Math.sin(angle);
    const isCurrent = gs.players.indexOf(p) === gs.currentTurn;
    const miniCards = Array(Math.min(p.hand.length,10)).fill('<div class="mini-card"></div>').join('');
    html += `<div class="other-player ${p.calledUno&&p.hand.length===1?'has-uno':''}"
      style="left:${x}px;top:${y}px;transform:translate(-50%,-50%)"
      onclick="tryCatchUno('${p.id}')">
      <div class="op-name ${isCurrent?'current-turn':''}">${p.avatar} ${escHtml(p.name)}</div>
      <div class="op-cards">${miniCards}</div>
      <div class="op-count">${p.hand.length} bài${p.hand.length===1
 ? (p.calledUno ? ' 🔴' : ' 🚨')
 : ''
}</div>
    </div>`;
  });
  container.innerHTML = html;
}

// ─────────────────────────────────────────────
// END GAME
// ─────────────────────────────────────────────
function endGame(winner) {
  createParticles('#ffd700', 120);
  const ws = document.getElementById('win-screen');
  if (winner) {
    const isMe = winner.id === myId;
    document.getElementById('win-title').textContent = isMe ? '🏆 Bạn thắng!' : `${winner.name} thắng!`;
    document.getElementById('win-sub').textContent   = isMe ? 'Xuất sắc! Bạn đã đánh hết bài!' : `${winner.name} đã đánh hết bài trước!`;
  } else {
    document.getElementById('win-title').textContent = 'Trò chơi kết thúc';
    document.getElementById('win-sub').textContent   = 'Không đủ người chơi.';
  }
  ws.classList.add('show');
}

window.backToLobby = async function () {

  try {

    detachAll();

    if (isHost) {

      await remove(ref(db, `rooms/${roomCode}`));
      await remove(ref(db, `games/${roomCode}`));

    }

  } catch (e) {
    console.log(e);
  }

  location.reload();
};

// ─────────────────────────────────────────────
// TOAST
// ─────────────────────────────────────────────
let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// ─────────────────────────────────────────────
// CHAT / REACTIONS
// ─────────────────────────────────────────────
async function sendReaction(emoji) {
  if (!roomCode) return;
  await push(ref(db, `games/${roomCode}/chat`), {
    fromId: myId, fromName: myName, msg: emoji, ts: Date.now()
  });
  const el = document.getElementById('chat-log');
  if (el) el.textContent = `Bạn: ${emoji}`;
}

// ─────────────────────────────────────────────
// VISUAL FX
// ─────────────────────────────────────────────
function playBeep(freq=500, dur=0.08) {
  try {
    const ctx=new(window.AudioContext||window.webkitAudioContext)();
    const osc=ctx.createOscillator(), gain=ctx.createGain();
    osc.frequency.value=freq; osc.connect(gain); gain.connect(ctx.destination);
    osc.start();
    gain.gain.setValueAtTime(0.05,ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001,ctx.currentTime+dur);
    osc.stop(ctx.currentTime+dur);
  } catch(e){}
}
function screenShake(){
  document.body.classList.add('screen-shake');
  setTimeout(()=>document.body.classList.remove('screen-shake'),350);
}
function createParticles(color='#ffd700',amount=30){
  for(let i=0;i<amount;i++){
    const p=document.createElement('div'); p.className='particle';
    p.style.background=color;
    p.style.left=(window.innerWidth/2)+'px'; p.style.top=(window.innerHeight/2)+'px';
    p.style.setProperty('--dx',(Math.random()*400-200)+'px');
    p.style.setProperty('--dy',(Math.random()*400-200)+'px');
    document.body.appendChild(p); setTimeout(()=>p.remove(),1000);
  }
}
function showUnoFlash(){
  const d=document.createElement('div'); d.className='uno-flash'; d.textContent='UNO!';
  document.body.appendChild(d); createParticles('#ff2b2b',50); setTimeout(()=>d.remove(),1000);
}
function deluxeBanner(msg,color='#fff'){
  const b=document.createElement('div'); b.id='event-banner'; b.style.color=color; b.textContent=msg;
  document.body.appendChild(b); setTimeout(()=>b.remove(),1000);
}

const _rawToast = toast;
window.toast = toast = function(msg){
  _rawToast(msg);
  if(msg.includes('UNO'))   { showUnoFlash(); deluxeBanner('UNO!','#ff3030'); }
  if(msg.includes('thắng')) { deluxeBanner('VICTORY!','#ffd700'); }
  if(msg.includes('+4'))    { screenShake(); deluxeBanner('+4','#ff66ff'); }
  if(msg.includes('+2'))    { screenShake(); deluxeBanner('+2','#66ccff'); }
  if(/wild|đổi màu/i.test(msg)){ document.body.classList.add('wild-screen'); setTimeout(()=>document.body.classList.remove('wild-screen'),1000); }
};

const _origPlayCard = window.playCard;
window.playCard = function(id){ playBeep(700); return _origPlayCard(id); };
const _origDrawCard = window.drawCard;
window.drawCard = function(){ playBeep(350); return _origDrawCard(); };

// ─────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────
window.addEventListener('beforeunload', () => {
  if (!roomCode) return;
  if (isHost) { remove(ref(db,`rooms/${roomCode}`)); remove(ref(db,`games/${roomCode}`)); }
  else {
    const updated = players.filter(p=>p.id!==myId);
    if (updated.length !== players.length) set(ref(db,`games/${roomCode}/players`), updated);
  }
});

window.addEventListener('resize', () => { if (gameState) renderGame(); });

window.addEventListener('load', () => {
  document.getElementById('game').classList.add('table-glow');
  document.querySelectorAll('.emoji-btn').forEach(b => {
    b.onclick = () => sendReaction(b.textContent);
  });
  startLobbyListener();
});
