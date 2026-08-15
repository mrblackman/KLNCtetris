require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const TetrisGame = require('./game-engine');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// İstemci dosyalarını servis et
app.use(express.static(path.join(__dirname, '../client')));

const game = new TetrisGame();
let hostId = null;

function broadcastHostStatus() {
    io.emit('hostStatusUpdate', { hostId });
}

function broadcastTakenColors() {
    const takenColors = Object.values(game.players).map(p => p.color);
    io.emit('takenColors', takenColors);
}

// Oyun durumunu yayınla (merkezi fonksiyon)
function broadcastGameState() {
    io.emit('gameState', {
        grid: game.grid,
        players: game.players,
        score: game.score,
        gameOver: game.gameOver,
        hostId: hostId
    });
}

io.on('connection', (socket) => {
    console.log(`Bağlantı: ${socket.id}`);

    // Eğer host yoksa veya mevcut host bağlı değilse yeni hostu belirle
    const currentSockets = Array.from(io.sockets.sockets.keys());
    if (!hostId || !currentSockets.includes(hostId)) {
        hostId = socket.id;
        console.log(`Host atandı/güncellendi: ${hostId}`);
    }

    // Bağlanan kişiye mevcut host ve alınmış renkleri gönder
    socket.emit('hostStatus', { isHost: socket.id === hostId });
    broadcastTakenColors();
    broadcastHostStatus();

    // Oyuncu lobi ekranından "Katıl" dediğinde
    socket.on('joinGame', (data) => {
        const { nickname, color, dimensions } = data;

        // Eğer bu kişi host ise ve oyunun ilk oyuncusuysa boyutları ayarlar
        // game.players boşsa boyutları değiştirebilir
        if (socket.id === hostId && dimensions && Object.keys(game.players).length === 0) {
            game.width = dimensions.w;
            game.height = dimensions.h;
            game.grid = game.createGrid();
            console.log(`Oyun alanı ${dimensions.w}x${dimensions.h} olarak kuruldu.`);
        }

        game.addPlayer(socket.id, nickname, color);
        broadcastTakenColors(); // Renk alındı

        socket.emit('init', {
            id: socket.id,
            grid: game.grid,
            players: game.players,
            width: game.width,
            height: game.height,
            score: game.score,
            gameOver: game.gameOver
        });

        console.log(`${nickname} oyuna katıldı. (Sayı: ${Object.keys(game.players).length})`);
    });

    // --- INPUT HANDLER'LARI: Her input sonrası anlık broadcast ---
    socket.on('move', (dir) => {
        game.movePlayer(socket.id, dir);
        // Broadcast yok — tick loop halledecek. Client-side prediction anında yansıtıyor.
    });

    socket.on('rotate', () => {
        game.rotatePlayer(socket.id);
    });

    socket.on('drop', () => {
        game.dropPlayer(socket.id);
    });

    socket.on('restartGame', () => {
        if (socket.id === hostId) {
            console.log('Oyun yeniden başlatılıyor...');
            game.score = 0;
            game.gameOver = false;
            game.grid = game.createGrid();
            // Tüm oyuncuların pozisyonlarını sıfırla
            Object.keys(game.players).forEach(id => game.resetPlayer(id));
            io.emit('gameRestarted');
        }
    });

    socket.on('stopGame', () => {
        if (socket.id === hostId) {
            console.log('Oyun host tarafından durduruldu.');
            game.gameOver = true;
            broadcastGameState();
        }
    });

    socket.on('backToLobby', () => {
        if (socket.id === hostId) {
            console.log('Tüm oyuncular lobiye yönlendiriliyor...');
            game.score = 0;
            game.gameOver = false;
            game.grid = game.createGrid();
            // Oyuncu listesini sıfırlıyoruz çünkü herkes lobiye dönecek
            game.players = {};
            io.emit('goToLobby');
        }
    });

    socket.on('disconnect', () => {
        console.log(`Bağlantı kesildi: ${socket.id}`);
        game.removePlayer(socket.id);

        if (socket.id === hostId) {
            hostId = null;
            const connectedSockets = Array.from(io.sockets.sockets.keys());
            if (connectedSockets.length > 0) {
                hostId = connectedSockets[0];
                console.log(`Host ayrıldı. Yeni Host: ${hostId}`);
            }
            broadcastHostStatus();
            // Yeni hosta yetki bilgisini gönder
            if (hostId) {
                io.to(hostId).emit('hostStatus', { isHost: true });
            }
        }
        broadcastTakenColors();
    });
});

// Oyun döngüsü (20 tick/saniye — yalnızca gravity drop'u kontrol eder)
// Input'lar zaten kendi handler'larında anlık broadcast yapıyor
setInterval(() => {
    const gravityChanged = game.update();

    // Sadece gravity drop gerçekleştiyse yayınla
    // (Input kaynaklı değişiklikler zaten anında yayınlanıyor)
    if (gravityChanged || game.dirty) {
        broadcastGameState();
        game.dirty = false;
    }
}, 1000 / 20);

server.listen(PORT, () => {
    console.log(`Sunucu http://localhost:${PORT} adresinde çalışıyor`);
});

// --- GLOBAL HATA YAKALAMA (Crash Protection) ---
process.on('uncaughtException', (err) => {
    console.error('BEKLENMEDİK HATA (Uncaught Exception):', err);
    // Sunucuyu ayakta tutmaya çalışıyoruz
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('YAKALANAMAYAN RED (Unhandled Rejection):', reason);
});

