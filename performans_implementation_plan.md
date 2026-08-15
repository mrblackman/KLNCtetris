# Tetris Multi — Performans Analiz Raporu ve Düzeltme Planı

## Problem Tanımı
Tek oyuncu bile oynarken arada ~1 saniyelik donma/takılma (freeze) yaşanıyor. Donma sonrası parça birden aşağı düşüyor. Sunucu CPU/RAM boşta.

---

## 🔴 Kök Neden Analizi

### Sorun #1 — ASIL SUÇLU: Saniyede 60 Kez Tam Broadcast (Sunucu)

```javascript
// server/index.js:144-154
setInterval(() => {
    game.update();
    io.emit('gameState', { // ← HER FRAME'DE TÜM STATE YAYINLANIYOR
        grid: game.grid,       // 20x20 = 400 hücreli dizi
        players: game.players, // Tüm oyuncu detayları
        score: game.score,
        gameOver: game.gameOver,
        hostId: hostId
    });
}, 1000 / 60);  // ← 16.6ms'de bir
```

> [!CAUTION]
> **Bu, 1 saniyede 60 kez 20x20'lik grid + tüm oyuncu datası serialize → WebSocket üzerinden gönder → client'ta deserialize → tam canvas redraw yapıyor.** Oyunun düşme hızı 1 saniyede 1 satır olmasına rağmen, saniyede 60 kez güncelleme yayınlanıyor. Bu gereksiz 59 update, hem sunucu hem istemci tarafında massive overhead yaratıyor.

**Neden 1 saniyelik donma oluyor?** Node.js single-threaded. `setInterval` 16.6ms aralığıyla ateşleniyor ama her çağrıda `JSON.stringify` (serialize) + socket.io emit işlemi var. Garbage Collector bu küçük nesneleri toplamak için arada büyük bir GC pause yapıyor → 1 saniyelik freeze.

---

### Sorun #2 — Her Frame'de DOM Manipülasyonu (Client)

```javascript
// client/game.js:303
playerList.innerHTML = '';  // ← HER FRAME'DE TAMAMEN YIKIP YENİDEN OLUŞTURUYOR
Object.keys(players).forEach(id => {
    // ...
    const li = document.createElement('li');
    // innerHTML ile karmaşık HTML oluşturuluyor
    playerList.appendChild(li);
});
```

> [!WARNING]
> Saniyede 60 kez `innerHTML = ''` → createElement → appendChild döngüsü DOM'u sürekli reflow/repaint ettiriyor. Oyuncu listesi yalnızca oyuncu eklendiğinde/çıktığında değişmeli.

---

### Sorun #3 — Canvas Her Frame'de Sıfırdan Çiziliyor (Client)

```javascript
// client/game.js:278-326
function draw(grid, players) {
    context.fillRect(0, 0, gridWidth, gridHeight);  // Tümünü sil

    // Grid çizgileri: (gridWidth + gridHeight + 2) adet beginPath + stroke
    for (let x = 0; x <= gridWidth; x++) { /* stroke */ }
    for (let y = 0; y <= gridHeight; y++) { /* stroke */ }

    // 400 hücre taraması
    grid.forEach((row, y) => { /* drawBlock */ });

    // Oyuncu parçaları + DOM manipülasyonu
}
```

Grid çizgileri statiktir, her frame'de yeniden çizmek gereksiz. İki katmanlı canvas yaklaşımı daha iyi olur.

---

### Sorun #4 — `game.update()` Her Çağrıda `Date.now()` + Gereksiz İterasyon

```javascript
// server/game-engine.js:160-172
update() {
    if (this.gameOver) return;
    const now = Date.now();
    Object.keys(this.players).forEach(id => {
        const player = this.players[id];
        if (now - player.lastDrop > dropInterval) {
            this.dropPlayer(id);  // dropPlayer zaten merge + clearLines çağırıyor
        }
    });
}
```

Bu metot saniyede 60 kez çağrılıyor ama gerçek iş yalnızca 1 saniyede 1 kez yapılıyor. Kalan 59 çağrı sadece `Date.now()` karşılaştırması yapıp boş dönüyor. Ama yine de her seferinde `gameState` emit ediliyor.

---

### Sorun #5 — Büyük JSON Payload'ı Her Frame

20×20 grid = 400 hücre. Her hücrede renk string'i (örn. `"#FF0D72"`) veya `0` var. Bu data her 16.6ms'de serialize ediliyor:

```
Tahmini payload boyutu: ~3-5 KB per frame × 60 FPS = ~180-300 KB/saniye
```

Küçük gibi görünse de, serialize/deserialize CPU maliyeti asıl sorun.

---

### Sorun #6 — `socket.io-client` Gereksiz Dependency

```json
// package.json
"socket.io-client": "^4.8.3"
```

Bu client-side kütüphane zaten `/socket.io/socket.io.js` endpoint'inden otomatik servis ediliyor. `node_modules`'da gereksiz yer kaplıyor ama direkt performans etkisi yok.

---

### Sorun #7 — Client Tarafında Throttle/Debounce Yok

Kullanıcı tuşa basılı tutarsa, her `keydown` event'inde anında `socket.emit('move')` yapılıyor. Hızlı tekrarlanan tuşlarda saniyede 30+ emit olabilir.

---

## Proposed Changes

### Sunucu — Tick Rate Düşür ve Delta Update

#### [MODIFY] [index.js](file:///d:/mrblackman/WebProje/GAMEnya.com/TETRIS%20Multi/server/index.js)

**Değişiklik 1: Tick rate'i 60 FPS → 20 FPS'e düşür**

Tetris gibi bir oyun için 20 FPS (50ms) fazlasıyla yeterli. Parça zaten 1 saniyede 1 satır iniyor.

```diff
-// Oyun döngüsü (60 FPS'te durum yayını, ancak oyun mantığı daha yavaş işleyebilir)
-setInterval(() => {
+// Oyun döngüsü (20 tick/saniye — Tetris için fazlasıyla yeterli)
+let lastGrid = null;
+let lastScore = -1;
+let lastGameOver = null;
+setInterval(() => {
+    const hadChange = game.update();
+
+    // Sadece değişiklik varsa yayınla (delta detection)
+    const gridChanged = JSON.stringify(game.grid) !== lastGrid;
+    const scoreChanged = game.score !== lastScore;
+    const gameOverChanged = game.gameOver !== lastGameOver;
+
+    if (!hadChange && !gridChanged && !scoreChanged && !gameOverChanged) return;
+
+    lastGrid = JSON.stringify(game.grid);
+    lastScore = game.score;
+    lastGameOver = game.gameOver;
+
     game.update();
     io.emit('gameState', {
         grid: game.grid,
         players: game.players,
         score: game.score,
         gameOver: game.gameOver,
         hostId: hostId
     });
-}, 1000 / 60);
+}, 1000 / 20);
```

**Değişiklik 2: `game.update()` değişiklik olup olmadığını dönsün**

#### [MODIFY] [game-engine.js](file:///d:/mrblackman/WebProje/GAMEnya.com/TETRIS%20Multi/server/game-engine.js)

```diff
 update() {
-    if (this.gameOver) return;
+    if (this.gameOver) return false;
+    let changed = false;
     const now = Date.now();
     const dropInterval = 1000;
     Object.keys(this.players).forEach(id => {
         const player = this.players[id];
         if (now - player.lastDrop > dropInterval) {
             this.dropPlayer(id);
+            changed = true;
         }
     });
+    return changed;
 }
```

Ayrıca `movePlayer`, `rotatePlayer`, `dropPlayer` çağrıldığında da anlık broadcast yaparak responsiveness'ı koruyacağız.

---

### Client — DOM ve Canvas Optimizasyonu

#### [MODIFY] [game.js](file:///d:/mrblackman/WebProje/GAMEnya.com/TETRIS%20Multi/client/game.js)

**Değişiklik 1: Oyuncu listesini her frame'de yeniden oluşturmayı durdur**

Oyuncu listesi güncellemesini `draw()` dışına çıkar, sadece oyuncu değişikliğinde güncelle.

**Değişiklik 2: `requestAnimationFrame` ile render et**

Server'dan gelen son state'i cache'le, `requestAnimationFrame` ile çiz. Bu sayede tarayıcı kendi render döngüsüne göre çizer, gereksiz frame skip'leri önlenir.

**Değişiklik 3: Grid çizgilerini ayrı bir offscreen canvas'a çiz**

Statik grid çizgileri bir kez çizilip her frame'de `drawImage()` ile kopyalanır.

**Değişiklik 4: Input throttle**

Tuş girişlerini ~50ms'lik throttle ile sınırla.

---

## Özet Etki Tablosu

| Metrik | Şu An | Düzeltme Sonrası |
|--------|--------|------------------|
| Server broadcast/saniye | **60** | **~5-20** (sadece değişiklik olduğunda) |
| JSON serialize/saniye | **60** | **~5-20** |
| DOM rebuild/saniye | **60** | **Sadece oyuncu değişiminde** |
| Canvas full redraw/saniye | **60** | **~60** (ama grid çizgileri cached) |
| WebSocket data/saniye | **~300 KB** | **~25-100 KB** |
| Client GC pressure | **Yüksek** | **Düşük** |

---

## Verification Plan

### Automated Tests
- Sunucuyu başlat, tarayıcıda aç, 2 dakika oyna
- Tarayıcı DevTools → Performance tab ile frame timing ölç
- Network tab ile WebSocket message frekansını doğrula (60/s → ~5-20/s)

### Manual Verification
- Donma/takılma olup olmadığını gözlemle
- Parça düşüş hissinin pürüzsüz olduğunu doğrula
- Input responsiveness'ı test et (tuş basma → anında hareket)

---

## Open Questions

> [!IMPORTANT]
> **Soru 1:** Tick rate olarak 20 FPS öneriyorum. Tetris için yeterli, ama sen hissiyat açısından farklı bir değer tercih eder misin? (10, 15, 20, 30 seçenekleri var)

> [!IMPORTANT]  
> **Soru 2:** Anlık input broadcast'i (move/rotate/drop sonrası immediate emit) eklememi ister misin? Bu sayede tick rate düşse bile input'lar anında yansır. **Öneri: Evet**

> [!NOTE]
> **Soru 3:** `socket.io-client` dependency'sini `package.json`'dan kaldıralım mı? Performans etkisi yok ama gereksiz.
