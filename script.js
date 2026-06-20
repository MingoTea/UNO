// ─────────────────────────────────────────────
// FIREBASE SETUP
// ─────────────────────────────────────────────
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getDatabase, ref, set, get, update, onValue, off, remove, push, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db  = getDatabase(app);

// ─────────────────────────────────────────────
// CONSTANTS & STATE
// ─────────────────────────────────────────────
const MAX_PLAYERS = 12;
const AVATARS = ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮'];

let myId     = 'p_' + Math.random().toString(36).substr(2, 9);
let myName   = '';
let myAvatar = '';
let roomCode = '';
let isHost   = false;
let players  = [];
let gameState = null;
let pendingWild = null;

// Firebase listener refs (so we can detach them)
let roomListener    = null;
let stateListener   = null;
let actionsListener = null;
let roomsListener   = null;
let chatListener    = null;

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
function detachListeners() {
  if (roomListener)    { off(ref(db, `rooms/${roomCode}`));              roomListener    = null; }
  if (stateListener)   { off(ref(db, `games/${roomCode}/state`));        stateListener   = null; }
  if (actionsListener) { off(ref(db, `games/${roomCode}/actions`));      actionsListener = null; }
  if (chatListener)    { off(ref(db, `games/${roomCode}/chat`));         chatListener    = null; }
}

// ─────────────────────────────────────────────
// LOBBY – ROOM LIST
// ─────────────────────────────────────────────
function startLobbyListener() {
  const roomsRef = ref(db, 'rooms');
  roomsListener = onValue(roomsRef, snap => {
    const data = snap.val() || {};
    renderLobbyRooms(data);
  });
}
function stopLobbyListener() {
  if (roomsListener) { off(ref(db, 'rooms')); roomsListener = null; }
}

function renderLobbyRooms(data) {
  const list    = document.getElementById('room-list');
  const now     = Date.now();
  const entries = Object.values(data)
    .filter(r => !r.gameStarted && r.playerCount < MAX_PLAYERS && (now - r.ts) < 120000);

  if (entries.length === 0) {
    list.innerHTML = '<div id="no-rooms">Chưa có phòng nào. Hãy tạo phòng đầu tiên!</div>';
    return;
  }
  list.innerHTML = entries.map(r => `
    <div class="room-item" onclick="quickJoin('${escHtml(r.code)}')">
      <div>
        <div class="room-name">${escHtml(r.name || r.code)}</div>
        <div class="room-count">Mã: ${escHtml(r.code)}</div>
      </div>
      <div class="room-count">${r.playerCount}/${MAX_PLAYERS} người</div>
    </div>
  `).join('');
}

// ─────────────────────────────────────────────
// CREATE / JOIN ROOM
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

  // Write room to Firebase
  await set(ref(db, `rooms/${roomCode}`), {
    code: roomCode,
    name: roomInput || 'Phòng ' + roomCode,
    playerCount: 1,
    gameStarted: false,
    ts: Date.now()
  });

  // Write initial player list
  await set(ref(db, `games/${roomCode}/players`), players);

  stopLobbyListener();
  attachRoomListener();
  showWaiting();
};

window.joinByCode = function () {
  const code = document.getElementById('join-code').value.trim().toUpperCase().substring(0, 4);
  const name = document.getElementById('join-name').value.trim() ||
               document.getElementById('create-name').value.trim();
  if (!code) { toast('Nhập mã phòng!'); return; }
  if (!name) { toast('Nhập tên của bạn!'); return; }
  doJoin(code, name);
};

window.quickJoin = function (code) {
  const name = document.getElementById('join-name').value.trim() ||
               document.getElementById('create-name').value.trim();
  if (!name) { toast('Nhập tên của bạn trước!'); document.getElementById('join-name').focus(); return; }
  doJoin(code, name);
};

async function doJoin(code, name) {
  myName   = name;
  myAvatar = AVATARS[Math.floor(Math.random() * AVATARS.length)];
  roomCode = code;
  isHost   = false;

  // Check room exists
  const roomSnap = await get(ref(db, `rooms/${roomCode}`));
  if (!roomSnap.exists()) { toast('Không tìm thấy phòng!'); return; }
  const room = roomSnap.val();
  if (room.gameStarted)          { toast('Game đã bắt đầu rồi!'); return; }
  if (room.playerCount >= MAX_PLAYERS) { toast('Phòng đã đầy!'); return; }

  // Read current players and add self
  const playersSnap = await get(ref(db, `games/${roomCode}/players`));
  const existing    = playersSnap.val() || [];
  if (existing.find(p => p.id === myId)) { /* already joined */ }
  else existing.push({ id: myId, name: myName, avatar: myAvatar, isHost: false });

  players = existing;
  await set(ref(db, `games/${roomCode}/players`), players);
  await update(ref(db, `rooms/${roomCode}`), { playerCount: players.length });

  stopLobbyListener();
  attachRoomListener();
  showWaiting();
}

// ─────────────────────────────────────────────
// WAITING ROOM
// ─────────────────────────────────────────────
function attachRoomListener() {
  // Listen for player list changes
  roomListener = onValue(ref(db, `games/${roomCode}/players`), snap => {
    const data = snap.val();
    if (!data) return;
    players = data;
    renderWaiting();

    // Also check if game was launched
    get(ref(db, `games/${roomCode}/state`)).then(stateSnap => {
      if (stateSnap.exists() && !gameState) {
        gameState = stateSnap.val();
        attachGameListeners();
        showGame();
      }
    });
  });
}

function renderWaiting() {
  const list  = document.getElementById('player-list-wait');
  const slots = [];
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const p = players[i];
    if (p) {
      slots.push(`<div class="player-wait-card ${p.id===myId?'me':''} ${p.isHost?'host':''}">
        <div class="avatar">${p.avatar}</div>
        <div>${escHtml(p.name)}</div>
      </div>`);
    } else {
      slots.push(`<div class="player-wait-card"><div class="slot-empty">Chờ...</div></div>`);
    }
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
  detachListeners();
  if (isHost) {
    await remove(ref(db, `rooms/${roomCode}`));
    await remove(ref(db, `games/${roomCode}`));
  } else {
    players = players.filter(p => p.id !== myId);
    await set(ref(db, `games/${roomCode}/players`), players);
    await update(ref(db, `rooms/${roomCode}`), { playerCount: players.length });
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
    hand: deck.splice(0, 7),
    calledUno: false
  }));

  let topIdx = deck.findIndex(c => c.color !== 'wild');
  const topCard = deck.splice(topIdx, 1)[0];
  topCard.activeColor = topCard.color;

  gameState = {
    players: gamePlayers,
    deck,
    discard: [topCard],
    currentTurn: 0,
    direction: 1,
    drawStack: 0,
    phase: 'play',
    winner: null,
  };

  applyTopCardEffect(true);

  await set(ref(db, `games/${roomCode}/state`), gameState);
  await update(ref(db, `rooms/${roomCode}`), { gameStarted: true });

  attachGameListeners();
  document.getElementById('waiting').style.display = 'none';
  showGame();
};

// ─────────────────────────────────────────────
// GAME LISTENERS (non-host)
// ─────────────────────────────────────────────
function attachGameListeners() {
  if (!isHost) {
    // Non-host listens for state updates
    stateListener = onValue(ref(db, `games/${roomCode}/state`), snap => {
      if (!snap.exists()) return;
      const prev = gameState;
      gameState = snap.val();

      // Auto-show game screen if not already shown
      if (document.getElementById('game').style.display !== 'block') {
        showGame();
      } else {
        renderGame();
      }

      if (gameState.winner && (!prev || !prev.winner)) {
        setTimeout(() => endGame(gameState.winner), 300);
      }
    });
  }

  // ALL players listen for actions from others (host processes, others react)
  actionsListener = onValue(ref(db, `games/${roomCode}/actions`), snap => {
    if (!snap.exists() || !isHost) return;
    const actions = snap.val();
    if (!actions) return;
    // Process each pending action
    Object.entries(actions).forEach(([key, act]) => {
      if (act.processed) return;
      processAction(act.fromId, act.action, act.payload);
      // Mark processed
      update(ref(db, `games/${roomCode}/actions/${key}`), { processed: true });
    });
  });

  // Chat / quick reactions
  chatListener = onValue(ref(db, `games/${roomCode}/chat`), snap => {
    if (!snap.exists()) return;
    const msgs = snap.val();
    const last  = Object.values(msgs).sort((a, b) => b.ts - a.ts)[0];
    if (last && last.fromId !== myId) {
      const el = document.getElementById('chat-log');
      if (el) el.textContent = `${last.fromName}: ${last.msg}`;
    }
  });

  // Also listen for player disconnects
  onValue(ref(db, `games/${roomCode}/players`), snap => {
    if (!snap.exists()) return;
    const updated = snap.val();
    if (!gameState || !updated) return;
    if (updated.length < players.length) {
      players = updated;
      if (gameState) {
        const removed = gameState.players.filter(p => !updated.find(u => u.id === p.id));
        removed.forEach(r => {
          gameState.players = gameState.players.filter(p => p.id !== r.id);
          toast(`${r.name} đã thoát khỏi phòng`);
        });
        if (gameState.players.length < 2 && document.getElementById('game').style.display === 'block') {
          toast('Không đủ người chơi!');
          endGame(null);
        } else {
          // fix currentTurn index
          if (gameState.currentTurn >= gameState.players.length) gameState.currentTurn = 0;
          if (isHost) broadcastState();
          else renderGame();
        }
      }
    }
  });
}

// ─────────────────────────────────────────────
// CARD ENGINE
// ─────────────────────────────────────────────
const COLORS   = ['red','blue','green','yellow'];
const SPECIALS = ['Skip','Rev','+2'];

function buildDeck() {
  const deck = [];
  let id = 0;
  for (const c of COLORS) {
    deck.push({ id: id++, color: c, value: '0', display: '0' });
    for (let i = 1; i <= 9; i++) {
      for (let j = 0; j < 2; j++) deck.push({ id: id++, color: c, value: String(i), display: String(i) });
    }
    for (const s of SPECIALS) {
      for (let j = 0; j < 2; j++) deck.push({
        id: id++, color: c, value: s,
        display: s === 'Rev' ? '↩' : s === 'Skip' ? '⊘' : '+2'
      });
    }
  }
  for (let i = 0; i < 4; i++) deck.push({ id: id++, color: 'wild', value: 'Wild',    display: '🌈' });
  for (let i = 0; i < 4; i++) deck.push({ id: id++, color: 'wild', value: 'Wild+4',  display: '🌈+4' });
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
  if (!top)                         return true;
  if (card.color === 'wild')        return true;
  if (card.color === top.activeColor) return true;
  if (card.value === top.value)     return true;
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
  const gs    = gameState;
  const steps = skip ? 2 : 1;
  gs.currentTurn = ((gs.currentTurn + gs.direction * steps) % gs.players.length + gs.players.length) % gs.players.length;
}

function forceDraw(count) {
  const gs     = gameState;
  const target = gs.players[gs.currentTurn];
  const n      = count || gs.drawStack || 1;
  for (let i = 0; i < n; i++) {
    if (gs.deck.length === 0) reshuffleDeck();
    if (gs.deck.length > 0)  target.hand.push(gs.deck.pop());
  }
  target.calledUno = false;
}

function reshuffleDeck() {
  const gs  = gameState;
  if (gs.discard.length <= 1) return;
  const top = gs.discard.pop();
  gs.deck   = shuffle(gs.discard.map(c => { const nc = { ...c }; nc.activeColor = undefined; return nc; }));
  gs.discard = [top];
}

function applyTopCardEffect(isFirst = false) {
  const gs  = gameState;
  const top = gs.discard[gs.discard.length - 1];
  if (top.value === 'Rev') {
    gs.direction *= -1;
  } else if (top.value === 'Skip' && isFirst) {
    advanceTurn();
  } else if (top.value === '+2' && isFirst) {
    gs.drawStack += 2;
    advanceTurn();
    forceDraw();
    gs.drawStack = 0;
  }
}

// ─────────────────────────────────────────────
// ACTION PROCESSOR (HOST)
// ─────────────────────────────────────────────
function processAction(fromId, action, payload) {
  const gs            = gameState;
  const currentPlayer = gs.players[gs.currentTurn];

  if (action === 'PLAY_CARD') {
    if (currentPlayer.id !== fromId) return;
    const cardIdx = currentPlayer.hand.findIndex(c => c.id === payload.cardId);
    if (cardIdx === -1) return;
    const card = currentPlayer.hand[cardIdx];
    const top  = gs.discard[gs.discard.length - 1];

    if (gs.drawStack > 0 && card.value !== '+2' && card.value !== 'Wild+4') {
      forceDraw(gs.drawStack);
      gs.drawStack = 0;
      advanceTurn();
      broadcastState();
      return;
    }
    if (!canPlay(card, top)) return;

    currentPlayer.hand.splice(cardIdx, 1);
    card.activeColor  = payload.chosenColor || card.color;
    gs.discard.push(card);

    if (currentPlayer.hand.length === 0) {
      gs.winner = { id: currentPlayer.id, name: currentPlayer.name };
      broadcastState();
      return;
    }

    if (currentPlayer.hand.length !== 1) currentPlayer.calledUno = false;

    if (card.value === 'Skip') {
      advanceTurn(true);
    } else if (card.value === 'Rev') {
      gs.direction *= -1;
      gs.players.length === 2 ? advanceTurn(true) : advanceTurn();
    } else if (card.value === '+2') {
      gs.drawStack += 2;
      advanceTurn();
      const next     = gs.players[gs.currentTurn];
      const canStack = next.hand.some(c => c.value === '+2' || c.value === 'Wild+4');
      if (!canStack) { forceDraw(gs.drawStack); gs.drawStack = 0; advanceTurn(); }
    } else if (card.value === 'Wild+4') {
      gs.drawStack += 4;
      advanceTurn();
      const next     = gs.players[gs.currentTurn];
      const canStack = next.hand.some(c => c.value === 'Wild+4');
      if (!canStack) { forceDraw(gs.drawStack); gs.drawStack = 0; advanceTurn(); }
    } else {
      advanceTurn();
    }

    broadcastState();
  }

  else if (action === 'DRAW_CARD') {
    if (currentPlayer.id !== fromId) return;
    const top = gs.discard[gs.discard.length - 1];
    if (gs.drawStack > 0) {
      forceDraw(gs.drawStack);
      gs.drawStack = 0;
    } else {
      forceDraw(1);
      const drawn = currentPlayer.hand[currentPlayer.hand.length - 1];
      if (!canPlay(drawn, top)) advanceTurn();
    }
    broadcastState();
  }

  else if (action === 'CATCH_UNO') {
    catchUnoProcess(fromId, payload.targetId);
  }

  else if (action === 'UNO_CALL') {
    const gp = gs.players.find(p => p.id === fromId);
    if (gp) { gp.calledUno = true; broadcastState(); }
    toast(`${payload.name} hô UNO! 🔴`);
  }
}

function catchUnoProcess(catcherId, targetId) {
  const gs     = gameState;
  const target = gs.players.find(p => p.id === targetId);
  if (!target) return;
  if (target.hand.length === 1 && !target.calledUno) {
    for (let i = 0; i < 2; i++) {
      if (gs.deck.length === 0) reshuffleDeck();
      if (gs.deck.length) target.hand.push(gs.deck.pop());
    }
    toast(`${target.name} bị bắt UNO! +2 bài 🎉`);
    broadcastState();
  }
}

async function broadcastState() {
  // Host writes state to Firebase
  await set(ref(db, `games/${roomCode}/state`), gameState);
  renderGame();
  if (gameState.winner) {
    setTimeout(() => endGame(gameState.winner), 300);
  }
}

// ─────────────────────────────────────────────
// MY ACTIONS (CLIENT)
// ─────────────────────────────────────────────
window.playCard = function (cardId) {
  if (!gameState) return;
  const me            = gameState.players.find(p => p.id === myId);
  if (!me) return;
  const currentPlayer = gameState.players[gameState.currentTurn];
  if (currentPlayer.id !== myId) { toast('Chưa đến lượt bạn!'); return; }

  const card = me.hand.find(c => c.id === cardId);
  if (!card) return;
  const top  = gameState.discard[gameState.discard.length - 1];

  if (gameState.drawStack > 0 && card.value !== '+2' && card.value !== 'Wild+4') {
    toast(`Phải đánh +2/+4 để stack, hoặc rút ${gameState.drawStack} bài!`); return;
  }
  if (!canPlay(card, top) && gameState.drawStack === 0) {
    toast('Không thể đánh bài này!'); return;
  }
  if (card.color === 'wild') {
    pendingWild = cardId;
    document.getElementById('color-picker').classList.add('show');
    return;
  }
  sendAction('PLAY_CARD', { cardId });
};

window.pickColor = function (color) {
  document.getElementById('color-picker').classList.remove('show');
  if (pendingWild !== null) {
    sendAction('PLAY_CARD', { cardId: pendingWild, chosenColor: color });
    pendingWild = null;
  }
};

window.drawCard = function () {
  if (!gameState) return;
  const currentPlayer = gameState.players[gameState.currentTurn];
  if (currentPlayer.id !== myId) { toast('Chưa đến lượt bạn!'); return; }
  sendAction('DRAW_CARD', {});
};

window.callUno = function () {
  if (!gameState) return;
  sendAction('UNO_CALL', { name: myName });
  toast('Bạn hô UNO! 🔴');
  document.getElementById('uno-btn').classList.remove('show');
};

window.tryCatchUno = function (targetId) {
  const gs     = gameState;
  if (!gs) return;
  const target = gs.players.find(p => p.id === targetId);
  if (!target) return;
  if (target.hand.length === 1 && !target.calledUno) {
    sendAction('CATCH_UNO', { targetId });
    toast(`Bắt UNO ${target.name}! 🎯`);
  }
};

async function sendAction(action, payload) {
  if (isHost) {
    processAction(myId, action, payload);
  } else {
    // Write action to Firebase; host will pick it up
    await push(ref(db, `games/${roomCode}/actions`), {
      fromId:    myId,
      fromName:  myName,
      action,
      payload,
      ts:        Date.now(),
      processed: false
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
  if (!gameState) return;
  const gs            = gameState;
  const myIdx         = gs.players.findIndex(p => p.id === myId);
  const me            = gs.players[myIdx];
  const currentPlayer = gs.players[gs.currentTurn];
  const top           = gs.discard[gs.discard.length - 1];
  const isMyTurn      = currentPlayer && currentPlayer.id === myId;

  const ti = document.getElementById('turn-indicator');
  ti.textContent = isMyTurn ? '🎯 Lượt của bạn!' : `⏳ Lượt: ${currentPlayer ? currentPlayer.name : '?'}`;
  ti.className   = isMyTurn ? 'my-turn' : '';

  document.getElementById('direction-indicator').textContent = gs.direction === 1 ? '🔄' : '🔃';
  let deckInfo = ` ${gs.deck.length} bài`;
  if (gs.drawStack > 0) deckInfo += ` | Stack: +${gs.drawStack}`;
  document.getElementById('deck-count').textContent = deckInfo;

  const dp = document.getElementById('discard-pile');
  if (top) dp.innerHTML = cardHTML(top);

  document.getElementById('my-name-display').textContent = me ? me.name  : 'Bạn';
  document.getElementById('my-card-count').textContent   = me ? `${me.hand.length} bài` : '';

  const handContainer = document.getElementById('hand-container');
  if (me) {
    handContainer.innerHTML = me.hand.map(card => {
      const playable = isMyTurn && (
        gs.drawStack === 0 ? canPlay(card, top) : (card.value === '+2' || card.value === 'Wild+4')
      );
      return `<div class="card ${card.color}${playable ? ' playable' : ''}" data-id="${card.id}" onclick="playCard(${card.id})">
        <span class="corner tl">${card.display}</span>
        <span class="center">${card.display}</span>
        <span class="corner br">${card.display}</span>
      </div>`;
    }).join('');
  }

  const unoBtn = document.getElementById('uno-btn');
  if (me && me.hand.length === 1 && isMyTurn && !me.calledUno) unoBtn.classList.add('show');
  else unoBtn.classList.remove('show');

  renderOtherPlayers(me, myIdx);
}

function renderOtherPlayers(me, myIdx) {
  const gs        = gameState;
  const container = document.getElementById('other-players-container');
  const others    = gs.players.filter((_, i) => i !== myIdx);
  const n         = others.length;
  if (n === 0) { container.innerHTML = ''; return; }

  const W     = window.innerWidth;
  const H     = window.innerHeight;
  const handH = 120;
  let html    = '';

  others.forEach((p, i) => {
    const angle     = Math.PI + (Math.PI * (i + 1) / (n + 1));
    const cx = W / 2, cy = (H - handH) / 2;
    const rx = Math.min(W * 0.42, 280), ry = Math.min((H - handH) * 0.38, 150);
    const x  = cx + rx * Math.cos(angle);
    const y  = cy + ry * Math.sin(angle);
    const isCurrent = gs.players.indexOf(p) === gs.currentTurn;
    const miniCards = Math.min(p.hand.length, 10);
    const cardsHtml = Array(miniCards).fill('<div class="mini-card"></div>').join('');

    html += `<div class="other-player ${p.calledUno && p.hand.length === 1 ? 'has-uno' : ''}"
      style="left:${x}px;top:${y}px;transform:translate(-50%,-50%)"
      onclick="tryCatchUno('${p.id}')">
      <div class="op-name ${isCurrent ? 'current-turn' : ''}">${p.avatar} ${escHtml(p.name)}</div>
      <div class="op-cards">${cardsHtml}</div>
      <div class="op-count">${p.hand.length} bài${p.calledUno && p.hand.length === 1 ? ' 🔴' : ''}</div>
    </div>`;
  });
  container.innerHTML = html;
}

// ─────────────────────────────────────────────
// END GAME
// ─────────────────────────────────────────────
function endGame(winner) {
  const ws = document.getElementById('win-screen');
  if (winner) {
    const isMe = winner.id === myId;
    document.getElementById('win-title').textContent = isMe ? '🏆 Bạn thắng!' : `${winner.name} thắng!`;
    document.getElementById('win-sub').textContent   = isMe
      ? 'Xuất sắc! Bạn đã đánh hết bài!'
      : `${winner.name} đã đánh hết bài trước!`;
  } else {
    document.getElementById('win-title').textContent = 'Trò chơi kết thúc';
    document.getElementById('win-sub').textContent   = 'Không đủ người chơi.';
  }
  ws.classList.add('show');
}

window.backToLobby = async function () {
  detachListeners();
  if (isHost) {
    await remove(ref(db, `rooms/${roomCode}`));
    await remove(ref(db, `games/${roomCode}`));
  } else {
    players = players.filter(p => p.id !== myId);
    if (players.length > 0) await set(ref(db, `games/${roomCode}/players`), players);
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
    fromId:   myId,
    fromName: myName,
    msg:      emoji,
    ts:       Date.now()
  });
  const el = document.getElementById('chat-log');
  if (el) el.textContent = `Bạn: ${emoji}`;
}

window.addEventListener('load', () => {
  document.querySelectorAll('.emoji-btn').forEach(b => {
    b.onclick = () => sendReaction(b.textContent);
  });
});

// ─────────────────────────────────────────────
// VISUAL FX
// ─────────────────────────────────────────────
function playBeep(freq = 500, duration = 0.08) {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start();
    gain.gain.setValueAtTime(0.05, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    osc.stop(ctx.currentTime + duration);
  } catch (e) {}
}

function screenShake() {
  document.body.classList.add('screen-shake');
  setTimeout(() => document.body.classList.remove('screen-shake'), 350);
}

function createParticles(color = '#ffd700', amount = 30) {
  for (let i = 0; i < amount; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.style.background = color;
    p.style.left = (window.innerWidth / 2) + 'px';
    p.style.top  = (window.innerHeight / 2) + 'px';
    p.style.setProperty('--dx', (Math.random() * 400 - 200) + 'px');
    p.style.setProperty('--dy', (Math.random() * 400 - 200) + 'px');
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 1000);
  }
}

function showUnoFlash() {
  const d = document.createElement('div');
  d.className = 'uno-flash';
  d.textContent = 'UNO!';
  document.body.appendChild(d);
  createParticles('#ff2b2b', 50);
  setTimeout(() => d.remove(), 1000);
}

function deluxeBanner(msg, color = '#fff') {
  const b = document.createElement('div');
  b.id = 'event-banner';
  b.style.color = color;
  b.textContent = msg;
  document.body.appendChild(b);
  setTimeout(() => b.remove(), 1000);
}

// Override toast with FX
const _rawToast = toast;
window.toast = toast = function (msg) {
  _rawToast(msg);
  if (msg.includes('UNO'))   { showUnoFlash(); deluxeBanner('UNO!', '#ff3030'); }
  if (msg.includes('thắng')) { deluxeBanner('VICTORY!', '#ffd700'); createParticles('#ffd700', 120); }
  if (msg.includes('+4'))    { screenShake(); deluxeBanner('+4', '#ff66ff'); }
  if (msg.includes('+2'))    { screenShake(); deluxeBanner('+2', '#66ccff'); }
  if (/wild|đổi màu/i.test(msg)) {
    document.body.classList.add('wild-screen');
    setTimeout(() => document.body.classList.remove('wild-screen'), 1000);
  }
};

// Override playCard / drawCard for beep
const _origPlayCard = window.playCard;
window.playCard = function (cardId) { playBeep(700); return _origPlayCard(cardId); };
const _origDrawCard = window.drawCard;
window.drawCard = function ()       { playBeep(350); return _origDrawCard(); };

// ─────────────────────────────────────────────
// CLEANUP ON CLOSE
// ─────────────────────────────────────────────
window.addEventListener('beforeunload', () => {
  if (!roomCode) return;
  // Best-effort removal of self from players
  if (players.length > 0) {
    const updated = players.filter(p => p.id !== myId);
    if (isHost) {
      // Can't async here, but navigator.sendBeacon could be used
      remove(ref(db, `rooms/${roomCode}`));
      remove(ref(db, `games/${roomCode}`));
    } else if (updated.length !== players.length) {
      set(ref(db, `games/${roomCode}/players`), updated);
    }
  }
});

window.addEventListener('resize', () => { if (gameState) renderGame(); });

window.addEventListener('load', () => {
  const game = document.getElementById('game');
  if (game) game.classList.add('table-glow');
  startLobbyListener();
});
