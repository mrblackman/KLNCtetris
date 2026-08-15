class TetrisGame {
    constructor() {
        this.width = 20;
        this.height = 20;
        this.players = {}; // socket.id -> { nickname, piece, pos, color, lastDrop }
        this.colors = [
            '#FF0D72', '#0DC2FF', '#0DFF72',
            '#F538FF', '#FF8E0D', '#FFE138', '#3877FF'
        ];
        this.tetrominoes = [
            [[1, 1, 1, 1]], // I
            [[1, 1], [1, 1]], // O
            [[0, 1, 0], [1, 1, 1]], // T
            [[1, 1, 0], [0, 1, 1]], // S
            [[0, 1, 1], [1, 1, 0]], // Z
            [[1, 0, 0], [1, 1, 1]], // J
            [[0, 0, 1], [1, 1, 1]]  // L
        ];
        this.dirty = false; // Input sonrası anlık broadcast için flag
        this.resetGame();
    }

    resetGame() {
        this.grid = this.createGrid();
        this.score = 0;
        this.gameOver = false;
        this.dirty = true;
        // Tüm oyuncuların pozisyonlarını sıfırla
        Object.keys(this.players).forEach(id => this.resetPlayer(id));
    }

    setDimensions(w, h) {
        this.width = w;
        this.height = h;
        if (!this.grid) {
            this.grid = this.createGrid();
        }
    }

    createGrid() {
        return Array.from({ length: this.height }, () => Array(this.width).fill(0));
    }

    addPlayer(id, nickname, color) {
        this.players[id] = {
            nickname: nickname || id.substring(0, 6),
            piece: this.tetrominoes[Math.floor(Math.random() * this.tetrominoes.length)],
            pos: { x: Math.floor(this.width / 2) - 1, y: 0 },
            color: color || this.colors[Math.floor(Math.random() * this.colors.length)],
            lastDrop: Date.now()
        };
        this.dirty = true;
    }

    removePlayer(id) {
        delete this.players[id];
        this.dirty = true;
    }

    movePlayer(id, dir) {
        const player = this.players[id];
        if (!player) return;

        const newPos = { x: player.pos.x + dir, y: player.pos.y };
        if (!this.collide(player.piece, newPos)) {
            player.pos.x = newPos.x;
            this.dirty = true;
        }
    }

    rotatePlayer(id) {
        const player = this.players[id];
        if (!player) return;

        const rotated = player.piece[0].map((_, i) =>
            player.piece.map(row => row[i]).reverse()
        );

        if (!this.collide(rotated, player.pos)) {
            player.piece = rotated;
            this.dirty = true;
        }
    }

    dropPlayer(id) {
        const player = this.players[id];
        if (!player) return;

        const newPos = { x: player.pos.x, y: player.pos.y + 1 };
        if (!this.collide(player.piece, newPos)) {
            player.pos.y = newPos.y;
            player.lastDrop = Date.now();
        } else {
            this.merge(player);
            this.clearLines();
            this.resetPlayer(id);
        }
        this.dirty = true;
    }

    resetPlayer(id) {
        const typeId = Math.floor(Math.random() * this.tetrominoes.length);
        this.players[id].piece = this.tetrominoes[typeId];
        this.players[id].pos = { x: Math.floor(this.width / 2) - 1, y: 0 };
        this.players[id].lastDrop = Date.now();
        // Rengi değiştirmiyoruz, oyuncunun başlangıç rengi korunuyor

        // Eğer yeni çıkan parça hemen çarpışıyorsa oyun biter
        if (this.collide(this.players[id].piece, this.players[id].pos)) {
            this.gameOver = true;
        }
    }

    collide(piece, pos) {
        for (let y = 0; y < piece.length; y++) {
            for (let x = 0; x < piece[y].length; x++) {
                if (piece[y][x] !== 0) {
                    const gridX = pos.x + x;
                    const gridY = pos.y + y;
                    if (gridX < 0 || gridX >= this.width ||
                        gridY >= this.height ||
                        (gridY >= 0 && this.grid[gridY][gridX] !== 0)) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    merge(player) {
        let placementScore = 10; // Temel yerleştirme puanı
        player.piece.forEach((row, y) => {
            row.forEach((value, x) => {
                if (value !== 0) {
                    const gridY = player.pos.y + y;
                    const gridX = player.pos.x + x;
                    if (gridY >= 0) {
                        this.grid[gridY][gridX] = player.color;
                        // Yükseklik Bonusu: Ne kadar altta ise o kadar puan
                        placementScore += (this.height - gridY);
                    }
                }
            });
        });
        this.score += placementScore;
    }

    clearLines() {
        let linesCleared = 0;
        outer: for (let y = this.height - 1; y >= 0; y--) {
            for (let x = 0; x < this.width; x++) {
                if (this.grid[y][x] === 0) continue outer;
            }
            const row = this.grid.splice(y, 1)[0].fill(0);
            this.grid.unshift(row);
            linesCleared++;
            y++;
        }

        if (linesCleared > 0) {
            const rowPoints = [0, 100, 300, 500, 800];
            this.score += (rowPoints[Math.min(linesCleared, 4)] || 800);
        }
    }

    // Gravity tick — sadece düşme zamanı geldiyse parçaları düşürür
    // Değişiklik olup olmadığını boolean olarak döner
    update() {
        if (this.gameOver) return false;

        const now = Date.now();
        const dropInterval = 1000; // 1 saniyede bir düşme
        let changed = false;

        Object.keys(this.players).forEach(id => {
            const player = this.players[id];
            if (now - player.lastDrop > dropInterval) {
                this.dropPlayer(id);
                changed = true;
            }
        });

        return changed;
    }
}

module.exports = TetrisGame;
