// --- WebSocket-only transport: Polling overhead'ini ortadan kaldır ---
const socket = io({ transports: ['websocket'], upgrade: false });

const canvas = document.getElementById('tetris');
const context = canvas.getContext('2d');
const playerList = document.getElementById('player-list');

// Lobi Elementleri
const lobbyOverlay = document.getElementById('lobby-overlay');
const gameContainer = document.getElementById('game-container');
const nicknameInput = document.getElementById('nickname');
const joinBtn = document.getElementById('join-btn');
const colorOpts = document.querySelectorAll('.color-opt');
const lobbyHostOptions = document.getElementById('lobby-host-options');
const gameHostOptions = document.getElementById('game-host-options');
const scoreDisplay = document.getElementById('score-display');
const gameOverOverlay = document.getElementById('game-over-overlay');
const finalScoreVal = document.getElementById('final-score-val');
const restartBtn = document.getElementById('restart-btn');
const waitMsg = document.getElementById('wait-msg');
const stopGameBtn = document.getElementById('stop-game-btn');
const backToLobbyBtn = document.getElementById('back-to-lobby-btn');
const muteBtn = document.getElementById('mute-btn');
const muteIcon = muteBtn.querySelector('i');

// --- SOUND MANAGER (Web Audio API) ---
class SoundManager {
    constructor() {
        this.ctx = null;
        this.enabled = false;
        this.initOnInteraction();
    }

    initOnInteraction() {
        const init = () => {
            if (!this.ctx) {
                this.ctx = new (window.AudioContext || window.webkitAudioContext)();
                this.enabled = true;
            } else if (this.ctx.state === 'suspended') {
                this.ctx.resume();
            }
            window.removeEventListener('click', init);
            window.removeEventListener('keydown', init);
        };
        window.addEventListener('click', init);
        window.addEventListener('keydown', init);
    }

    toggle() {
        this.enabled = !this.enabled;
        muteIcon.setAttribute('data-lucide', this.enabled ? 'volume-2' : 'volume-x');
        lucide.createIcons();
        return this.enabled;
    }

    play(type) {
        if (!this.enabled || !this.ctx) return;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        const now = this.ctx.currentTime;

        switch (type) {
            case 'move':
                osc.type = 'square';
                osc.frequency.setValueAtTime(150, now);
                gain.gain.setValueAtTime(0.05, now);
                gain.gain.exponentialRampToValueAtTime(0.01, now + 0.05);
                osc.start(now); osc.stop(now + 0.05);
                break;
            case 'rotate':
                osc.type = 'sine';
                osc.frequency.setValueAtTime(300, now);
                osc.frequency.exponentialRampToValueAtTime(600, now + 0.1);
                gain.gain.setValueAtTime(0.1, now);
                gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
                osc.start(now); osc.stop(now + 0.1);
                break;
            case 'clear':
                osc.type = 'sawtooth';
                osc.frequency.setValueAtTime(400, now);
                osc.frequency.linearRampToValueAtTime(100, now + 0.3);
                gain.gain.setValueAtTime(0.1, now);
                gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
                osc.start(now); osc.stop(now + 0.3);
                break;
            case 'gameover':
                osc.type = 'sawtooth';
                osc.frequency.setValueAtTime(100, now);
                osc.frequency.linearRampToValueAtTime(40, now + 1);
                gain.gain.setValueAtTime(0.2, now);
                gain.gain.exponentialRampToValueAtTime(0.01, now + 1);
                osc.start(now); osc.stop(now + 1);
                break;
            case 'start':
                osc.type = 'sine';
                osc.frequency.setValueAtTime(200, now);
                osc.frequency.exponentialRampToValueAtTime(800, now + 0.2);
                gain.gain.setValueAtTime(0.1, now);
                gain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
                osc.start(now); osc.stop(now + 0.2);
                break;
        }
    }
}

const sounds = new SoundManager();
muteBtn.addEventListener('click', () => sounds.toggle());
lucide.createIcons();

let selectedColor = '#FF0D72';
let myId = null;
let gameStarted = false;
let stateGameOver = false;
let lastScore = 0;
let isHost = false;
let currentHostId = null;
let takenColors = [];

let gridWidth = 10;
let gridHeight = 20;
let SCALE = 30;

// --- OFFSCREEN GRID ÇİZGİ CACHE ---
let gridLinesCanvas = null;

function buildGridLinesCache() {
    gridLinesCanvas = document.createElement('canvas');
    gridLinesCanvas.width = gridWidth * SCALE;
    gridLinesCanvas.height = gridHeight * SCALE;
    const gCtx = gridLinesCanvas.getContext('2d');
    gCtx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    gCtx.lineWidth = 0.05 * SCALE;
    for (let x = 0; x <= gridWidth; x++) {
        gCtx.beginPath(); gCtx.moveTo(x * SCALE, 0); gCtx.lineTo(x * SCALE, gridHeight * SCALE); gCtx.stroke();
    }
    for (let y = 0; y <= gridHeight; y++) {
        gCtx.beginPath(); gCtx.moveTo(0, y * SCALE); gCtx.lineTo(gridWidth * SCALE, y * SCALE); gCtx.stroke();
    }
}

// =============================================
// CLIENT-SIDE PREDICTION SİSTEMİ
// =============================================
// Sunucu otoritesi korunur, ama lokal oyuncu inputları anında yansıtılır.
// Sunucu state geldiğinde lokal tahmin sunucuyla senkronize edilir.

// Tetrominolar (sunucuyla aynı — collision kontrolü için)
const TETROMINOES = [
    [[1, 1, 1, 1]], // I
    [[1, 1], [1, 1]], // O
    [[0, 1, 0], [1, 1, 1]], // T
    [[1, 1, 0], [0, 1, 1]], // S
    [[0, 1, 1], [1, 1, 0]], // Z
    [[1, 0, 0], [1, 1, 1]], // J
    [[0, 0, 1], [1, 1, 1]]  // L
];

// Sunucudan gelen son otoritatif state
let serverGrid = null;
let serverPlayers = null;

// Lokal oyuncunun tahmini pozisyon/parça (sunucu cevabı beklenirken)
let localPiecePos = null;  // { x, y }
let localPiece = null;     // 2D array
let localLastDrop = 0;     // Lokal gravity timer

const DROP_INTERVAL = 1000; // Sunucuyla aynı (1 saniye)

// Basit lokal collision kontrolü
function localCollide(piece, pos, grid) {
    if (!piece || !pos || !grid) return true;
    for (let y = 0; y < piece.length; y++) {
        for (let x = 0; x < piece[y].length; x++) {
            if (piece[y][x] !== 0) {
                const gx = pos.x + x;
                const gy = pos.y + y;
                if (gx < 0 || gx >= gridWidth || gy >= gridHeight ||
                    (gy >= 0 && grid[gy] && grid[gy][gx] !== 0)) {
                    return true;
                }
            }
        }
    }
    return false;
}

// Lokal parçayı hareket ettir (prediction)
function localMove(dir) {
    if (!localPiece || !localPiecePos || !serverGrid) return;
    const newPos = { x: localPiecePos.x + dir, y: localPiecePos.y };
    if (!localCollide(localPiece, newPos, serverGrid)) {
        localPiecePos.x = newPos.x;
    }
}

// Lokal parçayı döndür (prediction)
function localRotate() {
    if (!localPiece || !localPiecePos || !serverGrid) return;
    const rotated = localPiece[0].map((_, i) =>
        localPiece.map(row => row[i]).reverse()
    );
    if (!localCollide(rotated, localPiecePos, serverGrid)) {
        localPiece = rotated;
    }
}

// Lokal parçayı düşür (prediction)
function localDrop() {
    if (!localPiece || !localPiecePos || !serverGrid) return;
    const newPos = { x: localPiecePos.x, y: localPiecePos.y + 1 };
    if (!localCollide(localPiece, newPos, serverGrid)) {
        localPiecePos.y = newPos.y;
        localLastDrop = Date.now();
    }
    // Merge'i lokal yapmıyoruz — sunucu otoritesi
}

// =============================================
// OYUNCU LİSTESİ (DOM — sadece değişiklikte)
// =============================================
let lastPlayerKeys = '';

function updatePlayerListDOM(players) {
    const keys = Object.keys(players).sort().join(',');
    if (keys === lastPlayerKeys) return;
    lastPlayerKeys = keys;

    playerList.innerHTML = '';
    Object.keys(players).forEach(id => {
        const player = players[id];
        const li = document.createElement('li');
        li.className = 'player-item';
        const hostTag = id === currentHostId ? '<span class="host-tag" title="Oyun Sahibi">*</span>' : '';
        li.innerHTML = `
            <div class="color-dot" style="background-color: ${player.color}"></div>
            <span style="color: ${player.color}">${player.nickname} ${hostTag}</span>
            <small>${id === myId ? ' (Sen)' : ''}</small>
        `;
        playerList.appendChild(li);
    });
}

// =============================================
// HOST DURUMU
// =============================================
socket.on('hostStatus', (data) => {
    isHost = data.isHost;
    updateHostUI();
});

socket.on('hostStatusUpdate', (data) => {
    currentHostId = data.hostId;
    isHost = (socket.id === data.hostId || (myId && myId === data.hostId));
    updateHostUI();
});

function updateHostUI() {
    if (isHost && !gameStarted) {
        lobbyHostOptions.classList.remove('hidden');
    } else {
        lobbyHostOptions.classList.add('hidden');
    }

    if (isHost && gameStarted) {
        gameHostOptions.style.display = 'block';
        stopGameBtn.style.display = 'block';
        backToLobbyBtn.style.display = 'block';
    } else {
        gameHostOptions.style.display = 'none';
        stopGameBtn.style.display = 'none';
        backToLobbyBtn.style.display = 'none';
    }

    if (isHost) {
        restartBtn.classList.remove('hidden');
        waitMsg.classList.add('hidden');
    } else {
        restartBtn.classList.add('hidden');
        waitMsg.classList.remove('hidden');
    }
}

// =============================================
// LOBİ & OYUN AKIŞI
// =============================================
colorOpts.forEach(opt => {
    opt.addEventListener('click', () => {
        colorOpts.forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        selectedColor = opt.dataset.color;
    });
});

joinBtn.addEventListener('click', () => {
    const nickname = nicknameInput.value.trim() || 'Oyuncu';
    let dimensions = null;
    if (isHost) {
        const sizeOption = document.querySelector('input[name="size"]:checked');
        if (sizeOption) {
            const [w, h] = sizeOption.value.split('x').map(Number);
            dimensions = { w, h };
        }
    }
    socket.emit('joinGame', { nickname, color: selectedColor, dimensions });
});

restartBtn.addEventListener('click', () => socket.emit('restartGame'));

stopGameBtn.addEventListener('click', () => {
    if (confirm('Oyun durdurulsun mu? (Skor ekranı açılır)')) socket.emit('stopGame');
});

backToLobbyBtn.addEventListener('click', () => {
    if (confirm('Oyun biter ve herkes lobiye döner. Emin misiniz?')) socket.emit('backToLobby');
});

socket.on('goToLobby', () => window.location.reload());

socket.on('init', (data) => {
    myId = data.id;
    gridWidth = data.width || 10;
    gridHeight = data.height || 20;

    canvas.width = gridWidth * SCALE;
    canvas.height = gridHeight * SCALE;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.scale(SCALE, SCALE);

    buildGridLinesCache();

    // İlk state'i kaydet
    serverGrid = data.grid;
    serverPlayers = data.players;

    // Lokal prediction state'i başlat
    if (data.players[myId]) {
        localPiecePos = { ...data.players[myId].pos };
        localPiece = data.players[myId].piece.map(r => [...r]);
        localLastDrop = Date.now();
    }

    gameStarted = true;
    lobbyOverlay.classList.add('hidden');
    gameContainer.classList.remove('hidden');

    if (isHost) gameHostOptions.style.display = 'block';

    // Sürekli render loop başlat (sunucu mesajına bağımlı değil)
    requestAnimationFrame(gameLoop);
});

socket.on('takenColors', (colors) => {
    takenColors = colors;
    updateColorUI();
});

function updateColorUI() {
    colorOpts.forEach(opt => {
        const color = opt.dataset.color;
        if (takenColors.includes(color)) {
            opt.classList.add('disabled');
            if (selectedColor === color) {
                const nextAvailable = Array.from(colorOpts).find(o => !takenColors.includes(o.dataset.color));
                if (nextAvailable) {
                    colorOpts.forEach(o => o.classList.remove('active'));
                    nextAvailable.classList.add('active');
                    selectedColor = nextAvailable.dataset.color;
                }
            }
        } else {
            opt.classList.remove('disabled');
        }
    });
}

// =============================================
// SUNUCU STATE ALIMI — Otoritatif senkronizasyon
// =============================================
socket.on('gameState', (state) => {
    currentHostId = state.hostId;

    if (state.gameOver && !stateGameOver) sounds.play('gameover');
    if (state.score > lastScore) { sounds.play('clear'); lastScore = state.score; }

    stateGameOver = state.gameOver;
    if (state.gameOver) {
        gameOverOverlay.classList.remove('hidden');
        finalScoreVal.innerText = state.score;
    } else {
        gameOverOverlay.classList.add('hidden');
    }

    if (scoreDisplay) scoreDisplay.innerText = state.score;

    // Sunucu state'ini kaydet (otoritatif)
    serverGrid = state.grid;
    serverPlayers = state.players;

    // AKILLI RECONCILIATION:
    // Sadece parça şekli değiştiğinde (yeni parça spawn olduğunda) lokal state'i ez.
    // Normal hareket sırasında lokal prediction'a güven — "geri atlama" efektini önler.
    if (myId && state.players[myId]) {
        const sp = state.players[myId];
        const serverPieceStr = JSON.stringify(sp.piece);
        const localPieceStr = localPiece ? JSON.stringify(localPiece) : null;

        if (serverPieceStr !== localPieceStr) {
            // Parça şekli değişti = yeni parça spawn oldu veya döndürme sunucudan farklı
            localPiecePos = { x: sp.pos.x, y: sp.pos.y };
            localPiece = sp.piece.map(r => [...r]);
            localLastDrop = Date.now();
        }
        // Pozisyon senkronizasyonu: sadece Y ekseninde sunucu öndeyse uygula
        // (merge/clear sonrası grid değişikliği gibi durumlar)
        if (localPiecePos && sp.pos.y > localPiecePos.y) {
            localPiecePos.y = sp.pos.y;
        }
    }

    // Oyuncu listesini güncelle
    updatePlayerListDOM(state.players);
});

// =============================================
// SÜREKLİ RENDER LOOP (60fps, sunucudan bağımsız)
// =============================================
function gameLoop() {
    if (!gameStarted) return;

    // Lokal gravity: Sunucu cevabı gelmeden parçayı düşür
    if (!stateGameOver && localPiece && localPiecePos && serverGrid) {
        const now = Date.now();
        if (now - localLastDrop > DROP_INTERVAL) {
            const newPos = { x: localPiecePos.x, y: localPiecePos.y + 1 };
            if (!localCollide(localPiece, newPos, serverGrid)) {
                localPiecePos.y = newPos.y;
            }
            localLastDrop = now;
        }
    }

    // Çiz
    drawFrame();

    requestAnimationFrame(gameLoop);
}

function drawFrame() {
    if (!serverGrid || !serverPlayers) return;

    // Arka planı temizle
    context.fillStyle = '#000';
    context.fillRect(0, 0, gridWidth, gridHeight);

    // Grid çizgilerini cached canvas'tan kopyala
    if (gridLinesCanvas) {
        context.save();
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.drawImage(gridLinesCanvas, 0, 0);
        context.restore();
    }

    // Sabitlenmiş blokları çiz (sunucu otoritatif)
    serverGrid.forEach((row, y) => {
        row.forEach((value, x) => {
            if (value !== 0) drawBlock(x, y, value);
        });
    });

    // Diğer oyuncuların parçalarını çiz (sunucu state'inden)
    Object.keys(serverPlayers).forEach(id => {
        if (id === myId) return; // Kendi parçamızı lokal prediction'dan çizeceğiz
        const player = serverPlayers[id];
        player.piece.forEach((row, y) => {
            row.forEach((value, x) => {
                if (value !== 0) drawBlock(player.pos.x + x, player.pos.y + y, player.color);
            });
        });
    });

    // KENDİ PARÇAMIZ: Lokal prediction state'inden çiz (anlık tepki)
    if (myId && serverPlayers[myId] && localPiece && localPiecePos) {
        const myColor = serverPlayers[myId].color;
        localPiece.forEach((row, y) => {
            row.forEach((value, x) => {
                if (value !== 0) drawBlock(localPiecePos.x + x, localPiecePos.y + y, myColor);
            });
        });
    }
}

function drawBlock(x, y, color) {
    context.fillStyle = color;
    context.fillRect(x, y, 1, 1);
    context.strokeStyle = 'rgba(0,0,0,0.5)';
    context.lineWidth = 0.1;
    context.strokeRect(x, y, 1, 1);
}

// =============================================
// INPUT SİSTEMİ — Throttle yok, anında tepki
// =============================================
// Sunucu artık input başına broadcast yapmıyor, bu yüzden throttle gereksiz.
// Lokal prediction anında görsel geri bildirim sağlıyor.

function handleInput(event, data, localAction) {
    // 1) Lokal prediction: Anında uygula
    if (localAction) localAction();

    // 2) Sunucuya gönder
    if (data !== undefined) {
        socket.emit(event, data);
    } else {
        socket.emit(event);
    }
    return true;
}

// Klavye
document.addEventListener('keydown', event => {
    if (!gameStarted || stateGameOver) return;

    if (event.keyCode === 37) { // Sol
        if (handleInput('move', -1, () => localMove(-1))) sounds.play('move');
    } else if (event.keyCode === 39) { // Sağ
        if (handleInput('move', 1, () => localMove(1))) sounds.play('move');
    } else if (event.keyCode === 40) { // Aşağı
        if (handleInput('drop', undefined, () => localDrop())) sounds.play('move');
    } else if (event.keyCode === 38) { // Yukarı (Döndür)
        if (handleInput('rotate', undefined, () => localRotate())) sounds.play('rotate');
    }
});

// Gesture & Mouse
let touchStartX = 0;
let touchStartY = 0;
let isMouseDown = false;
const THRESHOLD = 30;

document.addEventListener('touchstart', e => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
}, { passive: true });

document.addEventListener('touchmove', e => {
    if (!gameStarted || stateGameOver) return;
    e.preventDefault();

    const touchEndX = e.touches[0].clientX;
    const touchEndY = e.touches[0].clientY;
    const dx = touchEndX - touchStartX;
    const dy = touchEndY - touchStartY;

    if (Math.abs(dx) > THRESHOLD) {
        const dir = dx > 0 ? 1 : -1;
        if (handleInput('move', dir, () => localMove(dir))) sounds.play('move');
        touchStartX = touchEndX;
    }

    if (Math.abs(dy) > THRESHOLD) {
        if (dy > 0) {
            if (handleInput('drop', undefined, () => localDrop())) sounds.play('move');
        } else {
            if (handleInput('rotate', undefined, () => localRotate())) sounds.play('rotate');
        }
        touchStartY = touchEndY;
    }
}, { passive: false });

document.addEventListener('mousedown', e => {
    if (e.button === 0) { isMouseDown = true; touchStartX = e.clientX; touchStartY = e.clientY; }
});

document.addEventListener('mousemove', e => {
    if (!isMouseDown || !gameStarted || stateGameOver) return;
    const dx = e.clientX - touchStartX;
    const dy = e.clientY - touchStartY;

    if (Math.abs(dx) > THRESHOLD) {
        const dir = dx > 0 ? 1 : -1;
        if (handleInput('move', dir, () => localMove(dir))) sounds.play('move');
        touchStartX = e.clientX;
    }
    if (Math.abs(dy) > THRESHOLD) {
        if (dy > 0) { if (handleInput('drop', undefined, () => localDrop())) sounds.play('move'); }
        touchStartY = e.clientY;
    }
});

document.addEventListener('mouseup', () => { isMouseDown = false; });

document.addEventListener('contextmenu', e => {
    if (gameStarted && !stateGameOver) {
        e.preventDefault();
        if (handleInput('rotate', undefined, () => localRotate())) sounds.play('rotate');
    }
});
