/**
 * 彩蛋：连点顶栏版本号 7 次打开「接单猫」
 */
(function initCatchCat(TD) {
  const CLICKS_NEEDED = 7;
  const CLICK_GAP_MS = 900;
  const LABELS = ["小票机", "断网", "电表异常", "PDA", "网络", "48h", "高频", "短时"];

  const overlay = document.getElementById("easterEggOverlay");
  const stage = document.getElementById("easterEggStage");
  const catEl = document.getElementById("easterEggCat");
  const scoreEl = document.getElementById("easterEggScore");
  const missEl = document.getElementById("easterEggMiss");
  const statusEl = document.getElementById("easterEggStatus");
  const closeBtn = document.getElementById("easterEggCloseBtn");
  const restartBtn = document.getElementById("easterEggRestartBtn");
  const badge = document.getElementById("appVersionBadge");

  if (!overlay || !stage || !catEl) return;

  let clickCount = 0;
  let clickTimer = 0;
  let open = false;
  let running = false;
  let paused = false;
  let raf = 0;
  let lastTs = 0;
  let spawnAcc = 0;
  let spawnEvery = 1000;
  let catX = 0.5;
  let keys = { left: false, right: false };
  let score = 0;
  let miss = 0;
  /** @type {{el: HTMLElement, x: number, y: number, vy: number, w: number}[]} */
  let tickets = [];

  function setHud() {
    if (scoreEl) scoreEl.textContent = String(score);
    if (missEl) missEl.textContent = String(miss);
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text || "";
  }

  function stageSize() {
    return { w: stage.clientWidth || 480, h: stage.clientHeight || 320 };
  }

  function placeCat() {
    const { w } = stageSize();
    const cw = catEl.offsetWidth || 56;
    const x = Math.max(0, Math.min(w - cw, catX * w - cw / 2));
    catEl.style.left = `${x}px`;
  }

  function clearTickets() {
    for (const t of tickets) t.el.remove();
    tickets = [];
  }

  function spawnTicket() {
    const { w } = stageSize();
    const el = document.createElement("div");
    el.className = "easter-egg-ticket";
    el.textContent = LABELS[Math.floor(Math.random() * LABELS.length)];
    stage.appendChild(el);
    const tw = el.offsetWidth || 72;
    const x = Math.random() * Math.max(8, w - tw - 8);
    el.style.left = `${x}px`;
    el.style.top = "-28px";
    tickets.push({
      el,
      x,
      y: -28,
      vy: 90 + Math.random() * 70 + score * 3,
      w: tw
    });
  }

  function hitTest(t) {
    const catRect = catEl.getBoundingClientRect();
    const tr = t.el.getBoundingClientRect();
    return !(tr.right < catRect.left + 6 || tr.left > catRect.right - 6 || tr.bottom < catRect.top + 8 || tr.top > catRect.bottom);
  }

  function gameOver() {
    running = false;
    paused = false;
    setStatus("漏单过多。再来一局，或 Esc 关掉。");
    if (restartBtn) restartBtn.hidden = false;
  }

  function resetGame() {
    score = 0;
    miss = 0;
    spawnAcc = 0;
    spawnEvery = 1000;
    lastTs = 0;
    paused = false;
    running = true;
    clearTickets();
    setHud();
    setStatus("接住落下的工单");
    if (restartBtn) restartBtn.hidden = true;
    placeCat();
  }

  function tick(ts) {
    if (!open) return;
    raf = requestAnimationFrame(tick);
    if (!running || paused) {
      lastTs = ts;
      return;
    }
    if (!lastTs) lastTs = ts;
    const dt = Math.min(0.05, (ts - lastTs) / 1000);
    lastTs = ts;

    const { h } = stageSize();
    const speed = (keys.left ? -1 : 0) + (keys.right ? 1 : 0);
    if (speed) {
      catX = Math.max(0.06, Math.min(0.94, catX + speed * dt * 1.35));
      placeCat();
    }

    spawnAcc += dt * 1000;
    spawnEvery = Math.max(480, 1000 - score * 18);
    if (spawnAcc >= spawnEvery) {
      spawnAcc = 0;
      spawnTicket();
    }

    for (let i = tickets.length - 1; i >= 0; i -= 1) {
      const t = tickets[i];
      t.y += t.vy * dt;
      t.el.style.top = `${t.y}px`;
      if (hitTest(t)) {
        t.el.remove();
        tickets.splice(i, 1);
        score += 1;
        setHud();
        continue;
      }
      if (t.y > h - 8) {
        t.el.remove();
        tickets.splice(i, 1);
        miss += 1;
        setHud();
        if (miss >= 3) gameOver();
      }
    }
  }

  function onKey(e) {
    if (!open) return;
    const down = e.type === "keydown";
    if (e.key === "Escape") {
      if (!down) return;
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === " " || e.code === "Space") {
      if (!down) return;
      e.preventDefault();
      if (!running) return;
      paused = !paused;
      setStatus(paused ? "已暂停" : "接住落下的工单");
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "a" || e.key === "A") {
      e.preventDefault();
      keys.left = down;
    }
    if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") {
      e.preventDefault();
      keys.right = down;
    }
  }

  function onStageMove(e) {
    if (!open || !running || paused) return;
    const rect = stage.getBoundingClientRect();
    catX = (e.clientX - rect.left) / Math.max(1, rect.width);
    placeCat();
  }

  function openGame() {
    if (open) return;
    open = true;
    overlay.hidden = false;
    keys = { left: false, right: false };
    resetGame();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  }

  function close() {
    open = false;
    running = false;
    paused = false;
    overlay.hidden = true;
    cancelAnimationFrame(raf);
    raf = 0;
    lastTs = 0;
    clearTickets();
    keys = { left: false, right: false };
  }

  function onBadgeClick(e) {
    e.preventDefault();
    clearTimeout(clickTimer);
    clickCount += 1;
    if (clickCount >= CLICKS_NEEDED) {
      clickCount = 0;
      openGame();
      return;
    }
    clickTimer = window.setTimeout(() => {
      clickCount = 0;
    }, CLICK_GAP_MS);
  }

  badge?.addEventListener("click", onBadgeClick);
  closeBtn?.addEventListener("click", close);
  restartBtn?.addEventListener("click", () => {
    resetGame();
    lastTs = 0;
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  stage.addEventListener("mousemove", onStageMove);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("keyup", onKey, true);

  TD.easterEgg = { open: openGame, close };
})(window.TTDesktop || (window.TTDesktop = {}));
