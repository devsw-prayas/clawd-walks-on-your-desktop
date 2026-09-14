(() => {
  // --- Tauri IPC bridge ---
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const { getCurrentWebviewWindow } = window.__TAURI__.webviewWindow;

  const appWindow = getCurrentWebviewWindow();

  const clawd = document.getElementById('clawd');
  const eyesGroup = document.getElementById('eyes');
  const masterGroup = document.getElementById('master-group');
  const armLeft = document.getElementById('arm-left');
  const panel = document.getElementById('panel');
  const statsToggle = document.getElementById('stats-toggle');
  const closeBtn = document.getElementById('close-btn');
  const instanceBadge = document.getElementById('instance-badge');
  const coffeeStation = document.getElementById('coffee-station');

  let winBounds = { x: 0, y: 0, width: 220, height: 260 };
  invoke('get_window_bounds').then((b) => { winBounds = b; });

  // ---------------- eye tracking (awake only) ----------------

  const EYE_RANGE = 1;
  let lastCursorPoint = { x: 0, y: 0 };

  function updateEyes(globalPoint) {
    if (!eyesGroup) return;
    const localX = globalPoint.x - winBounds.x;
    const localY = globalPoint.y - winBounds.y;

    const svgRect = document.getElementById('body-svg');
    if (!svgRect) return;
    const rect = svgRect.getBoundingClientRect();
    const eyeCenterX = rect.left + (7 / 15) * rect.width;
    const eyeCenterY = rect.top + (9 / 16) * rect.height;

    const dx = localX - eyeCenterX;
    const dy = localY - eyeCenterY;
    const dist = Math.hypot(dx, dy) || 1;
    const clamped = Math.min(dist, 150);
    const ratio = (clamped / 150) * EYE_RANGE;
    const ox = (dx / dist) * ratio;
    const oy = (dy / dist) * ratio;

    eyesGroup.style.transform = `translate(${ox.toFixed(2)}px, ${oy.toFixed(2)}px)`;
  }

  listen('cursor-pos', (event) => {
    const point = event.payload;
    lastCursorPoint = point;
    if (currentMode === 'awake' && idlePhase === 'rest') {
      updateEyes(point);
    }
  });

  // ---------------- dragging ----------------

  let dragging = false;
  let dragStartX = 0;
  let dragStartY = 0;

  clawd.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('#stats-toggle') || e.target.closest('#panel')) return;

    dragging = false;
    dragStartX = e.screenX;
    dragStartY = e.screenY;

    invoke('drag_start', { offsetX: e.screenX - winBounds.x, offsetY: e.screenY - winBounds.y });
  });

  window.addEventListener('mousemove', (e) => {
    if (dragStartX === 0 && dragStartY === 0) return;

    const moved = Math.hypot(e.screenX - dragStartX, e.screenY - dragStartY);
    if (moved > 4) {
      dragging = true;
      clawd.classList.add('dragging');
      invoke('drag_move', { screenX: e.screenX, screenY: e.screenY });
      invoke('get_window_bounds').then((b) => { winBounds = b; });
    }
  });

  window.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      clawd.classList.remove('dragging');
      invoke('drag_end');
      invoke('get_window_bounds').then((b) => { winBounds = b; });
    } else if (dragStartX !== 0) {
      invoke('drag_end');
      if (!desktopRunning) {
        invoke('open_tool');
      }
      triggerHappy();
    }
    dragStartX = 0;
    dragStartY = 0;
  });

  // ---------------- state machine ----------------

  let currentMode = 'awake';
  let happyTimer = null;
  let totalInstances = 1;
  let desktopRunning = false;
  let spotifyPlaying = false;
  let currentHour = new Date().getHours();
  let batteryPct = 100;
  let isCharging = true;
  let wasCharging = true;
  let chargingActive = false;
  const stage = document.getElementById('stage');

  function isLateNight() { return currentHour >= 23 || currentHour < 5; }

  // --- Gradual typing speed ramp ---
  let currentTypeSpeed = 0.15;
  let targetTypeSpeed = 0.15;
  let speedRampTimer = null;

  function getTargetSpeed() {
    if (totalInstances >= 3) return 0.055;
    if (totalInstances >= 2) return 0.09;
    return 0.15;
  }

  function rampSpeed() {
    if (speedRampTimer) return;
    speedRampTimer = setInterval(() => {
      const diff = targetTypeSpeed - currentTypeSpeed;
      if (Math.abs(diff) < 0.002) {
        currentTypeSpeed = targetTypeSpeed;
        clearInterval(speedRampTimer);
        speedRampTimer = null;
      } else {
        currentTypeSpeed += diff * 0.08;
      }
      clawd.style.setProperty('--type-speed', currentTypeSpeed.toFixed(3) + 's');
      clawd.style.setProperty('--read-speed', (currentTypeSpeed * 8).toFixed(2) + 's');
    }, 80);
  }

  function applyStateClasses() {
    if (happyTimer || chargingActive || screenshotActive || isWalking) return;
    clawd.className = 'interactive state-' + currentMode;
    if (currentMode === 'awake') {
      if (spotifyPlaying) {
        clawd.classList.add('vibing');
      } else {
        clawd.classList.add('idle-' + idlePhase);
      }
    }
    if (currentMode === 'action') {
      coffeeStation.classList.add('visible');
      if (spotifyPlaying) clawd.classList.add('vibing');
      targetTypeSpeed = getTargetSpeed();
      rampSpeed();
      startCoffeeBreaks();
      startStretchTimer();
    } else {
      coffeeStation.classList.remove('visible');
      stopCoffeeBreaks();
      stopStretchTimer();
    }
    if (isLateNight()) clawd.classList.add('late-night');
    if (batteryPct <= 20 && !isCharging) clawd.classList.add('low-battery');
    if (copyPhase) clawd.classList.add('copy-' + copyPhase);
    if (pastePhase) clawd.classList.add('paste-' + pastePhase);
    instanceBadge.classList.toggle('show', totalInstances > 1);
  }

  function triggerHappy() {
    if (happyTimer) clearTimeout(happyTimer);
    clawd.className = 'interactive state-happy';
    if (spotifyPlaying) clawd.classList.add('vibing');

    const onEnd = (e) => {
      if (e.animationName !== 'bounce') return;
      masterGroup.removeEventListener('animationend', onEnd);
      clawd.classList.add('settling');
      happyTimer = setTimeout(() => {
        happyTimer = null;
        applyStateClasses();
      }, 500);
    };
    masterGroup.addEventListener('animationend', onEnd);

    happyTimer = setTimeout(() => {
      masterGroup.removeEventListener('animationend', onEnd);
      happyTimer = null;
      applyStateClasses();
    }, 4000);
  }

  let drowsyTimer = null;

  function goDrowsy() {
    if (drowsyTimer) return;
    currentMode = 'drowsy';
    applyStateClasses();
    drowsyTimer = setTimeout(() => {
      drowsyTimer = null;
      if (currentMode === 'drowsy') {
        currentMode = 'asleep';
        applyStateClasses();
      }
    }, 4500);
  }

  function cancelDrowsy() {
    if (drowsyTimer) {
      clearTimeout(drowsyTimer);
      drowsyTimer = null;
    }
  }

  listen('system-state', (event) => {
    const state = event.payload;
    totalInstances = state.totalInstances || 1;
    const newMode = state.mode;
    const wasVibing = spotifyPlaying;
    spotifyPlaying = !!state.spotifyPlaying;
    currentHour = state.hour ?? new Date().getHours();
    batteryPct = state.batteryPct ?? 100;
    wasCharging = isCharging;
    isCharging = state.isCharging ?? true;
    desktopRunning = !!state.isDesktopRunning;

    if (!wasCharging && isCharging) {
      doChargingCelebration();
    }

    if (newMode !== currentMode && newMode !== 'asleep') {
      cancelDrowsy();
      if (newMode === 'action') idleSinceAction = 0;
      if (isWalking && walkAnimFrame) { clearTimeout(walkAnimFrame); isWalking = false; }
      currentMode = newMode;
      applyStateClasses();
    } else if (newMode === 'asleep' && currentMode !== 'asleep' && currentMode !== 'drowsy') {
      goDrowsy();
    } else if (currentMode === 'action') {
      targetTypeSpeed = getTargetSpeed();
      rampSpeed();
      if (spotifyPlaying !== wasVibing) applyStateClasses();
    } else if (spotifyPlaying !== wasVibing) {
      applyStateClasses();
    }

    if (totalInstances > 1) {
      instanceBadge.textContent = '+' + totalInstances;
    }
  });

  // ---------------- idle cycle (awake only) ----------------

  const IDLE_PHASES = ['rest', 'look-right', 'rest', 'look-left', 'rest', 'scratch', 'rest', 'thuglife', 'rest'];
  const IDLE_DURATIONS = [4000, 2000, 3000, 2000, 5000, 1800, 3000, 5000, 2000];
  let idleIndex = 0;
  let idlePhase = 'rest';
  let thugLifeActive = false;

  async function doThugLife() {
    if (currentMode !== 'awake' || happyTimer) return;
    thugLifeActive = true;

    idlePhase = 'thug-on';
    applyStateClasses();
    await new Promise(r => setTimeout(r, 500));
    if (currentMode !== 'awake') { thugLifeActive = false; return; }

    idlePhase = 'thug-pose';
    applyStateClasses();
    await new Promise(r => setTimeout(r, 2500));
    if (currentMode !== 'awake') { thugLifeActive = false; return; }

    idlePhase = 'thug-off';
    applyStateClasses();
    await new Promise(r => setTimeout(r, 500));

    thugLifeActive = false;
    idlePhase = 'rest';
    applyStateClasses();
  }

  function advanceIdle() {
    if (currentMode !== 'awake' || happyTimer || ignoredActive || copyActive || pasteActive || chargingActive || isWalking) {
      if (!ignoredActive) { idleIndex = 0; idlePhase = 'rest'; }
      setTimeout(advanceIdle, 2000);
      return;
    }

    idleIndex = (idleIndex + 1) % IDLE_PHASES.length;
    idlePhase = IDLE_PHASES[idleIndex];

    if (idlePhase === 'thuglife') {
      doThugLife().then(() => {
        setTimeout(advanceIdle, 1000);
      });
      return;
    }

    applyStateClasses();
    setTimeout(advanceIdle, IDLE_DURATIONS[idleIndex]);
  }

  setTimeout(advanceIdle, IDLE_DURATIONS[0]);

  // ---------------- coffee break cycle ----------------

  let coffeeInterval = null;
  let coffeeAnimating = false;

  function startCoffeeBreaks() {
    if (coffeeInterval) return;
    coffeeInterval = setInterval(() => {
      if (currentMode !== 'action' || coffeeAnimating || stretchAnimating || happyTimer) return;
      doCoffeeBreak();
    }, 18000);
    setTimeout(() => {
      if (currentMode === 'action' && !coffeeAnimating && !stretchAnimating && !happyTimer) {
        doCoffeeBreak();
      }
    }, 8000);
  }

  const COFFEE_PHASES = ['coffee-pour', 'coffee-grab', 'coffee-drink', 'coffee-sip', 'coffee-return'];

  function clearCoffeeClasses() {
    COFFEE_PHASES.forEach((c) => stage.classList.remove(c));
  }

  function stopCoffeeBreaks() {
    if (coffeeInterval) {
      clearInterval(coffeeInterval);
      coffeeInterval = null;
    }
    coffeeAnimating = false;
    clearCoffeeClasses();
  }

  function coffeePhase(cls, durationMs) {
    return new Promise((resolve) => {
      if (currentMode !== 'action') { resolve(false); return; }
      clearCoffeeClasses();
      stage.classList.add(cls);
      setTimeout(() => resolve(currentMode === 'action'), durationMs);
    });
  }

  async function doCoffeeBreak() {
    coffeeAnimating = true;
    if (!await coffeePhase('coffee-pour', 2500)) { clearCoffeeClasses(); coffeeAnimating = false; return; }
    if (!await coffeePhase('coffee-grab', 1000)) { clearCoffeeClasses(); coffeeAnimating = false; return; }
    if (!await coffeePhase('coffee-drink', 1200)) { clearCoffeeClasses(); coffeeAnimating = false; return; }
    if (!await coffeePhase('coffee-sip', 1500)) { clearCoffeeClasses(); coffeeAnimating = false; return; }
    if (!await coffeePhase('coffee-return', 800)) { clearCoffeeClasses(); coffeeAnimating = false; return; }
    clearCoffeeClasses();
    coffeeAnimating = false;
  }

  // ---------------- AFK stretch (long typing) ----------------

  let stretchTimer = null;
  let stretchAnimating = false;
  let typingStartTime = 0;

  const STRETCH_AFTER = 25 * 60 * 1000;
  const STRETCH_PHASES = ['stretch-lean', 'stretch-up', 'stretch-hold', 'stretch-yawn', 'stretch-return'];

  function clearStretchClasses() {
    STRETCH_PHASES.forEach((c) => stage.classList.remove(c));
  }

  function startStretchTimer() {
    if (stretchTimer) return;
    typingStartTime = Date.now();
    stretchTimer = setInterval(() => {
      if (currentMode !== 'action' || coffeeAnimating || stretchAnimating || happyTimer) return;
      if (Date.now() - typingStartTime >= STRETCH_AFTER) {
        doStretch();
        typingStartTime = Date.now();
      }
    }, 30000);
  }

  function stopStretchTimer() {
    if (stretchTimer) {
      clearInterval(stretchTimer);
      stretchTimer = null;
    }
    stretchAnimating = false;
    clearStretchClasses();
  }

  function stretchPhase(cls, durationMs) {
    return new Promise((resolve) => {
      if (currentMode !== 'action') { resolve(false); return; }
      clearStretchClasses();
      stage.classList.add(cls);
      setTimeout(() => resolve(currentMode === 'action'), durationMs);
    });
  }

  async function doStretch() {
    stretchAnimating = true;
    if (!await stretchPhase('stretch-lean', 800)) { clearStretchClasses(); stretchAnimating = false; return; }
    if (!await stretchPhase('stretch-up', 600)) { clearStretchClasses(); stretchAnimating = false; return; }
    if (!await stretchPhase('stretch-hold', 2000)) { clearStretchClasses(); stretchAnimating = false; return; }
    if (!await stretchPhase('stretch-yawn', 1500)) { clearStretchClasses(); stretchAnimating = false; return; }
    if (!await stretchPhase('stretch-return', 600)) { clearStretchClasses(); stretchAnimating = false; return; }
    clearStretchClasses();
    stretchAnimating = false;
  }

  // ---------------- random walk (long idle) ----------------

  let walkTimer = null;
  let walkAnimFrame = null;
  let isWalking = false;
  let idleSinceAction = 0;

  function maybeStartWalk() {
    if (isWalking || currentMode !== 'awake' || happyTimer || spotifyPlaying || copyActive || pasteActive || chargingActive) return;
    idleSinceAction++;
    if (idleSinceAction < 8) return;
    if (Math.random() > 0.3) return;

    doWalk();
  }

  async function doWalk() {
    isWalking = true;
    const screenBounds = await invoke('get_screen_bounds');
    const bounds = await invoke('get_window_bounds');
    const startX = bounds.x;
    const startY = bounds.y;

    const goRight = Math.random() > 0.5;
    const distance = 150 + Math.random() * 300;
    let targetX = goRight ? startX + distance : startX - distance;
    targetX = Math.max(0, Math.min(targetX, screenBounds.width - bounds.width));
    const targetY = startY;

    clawd.className = 'interactive state-walk' + (goRight ? '' : ' walk-left');
    if (isLateNight()) clawd.classList.add('late-night');

    const totalSteps = Math.max(1, Math.round(Math.abs(targetX - startX) / 1.5));
    let step = 0;

    function walkStep() {
      if (currentMode !== 'awake') {
        isWalking = false;
        walkAnimFrame = null;
        applyStateClasses();
        return;
      }
      if (step >= totalSteps) {
        invoke('walk_to', { x: targetX, y: targetY });
        winBounds.x = targetX;
        setTimeout(() => {
          isWalking = false;
          walkAnimFrame = null;
          applyStateClasses();
        }, 200);
        return;
      }
      step++;
      const progress = step / totalSteps;
      const x = startX + (targetX - startX) * progress;
      invoke('walk_to', { x: Math.round(x), y: targetY });
      winBounds.x = x;
      walkAnimFrame = setTimeout(walkStep, 16);
    }

    walkAnimFrame = setTimeout(walkStep, 16);
  }

  setInterval(() => {
    if (currentMode === 'awake' && !happyTimer && !isWalking) {
      maybeStartWalk();
    }
  }, 9000);

  // ---------------- edge peek ----------------

  async function checkEdgePeek() {
    if (currentMode !== 'awake' || happyTimer || isWalking) return;
    const bounds = await invoke('get_window_bounds');
    const screenBounds = await invoke('get_screen_bounds');

    const atRight = bounds.x + bounds.width >= screenBounds.width - 5;
    const atLeft = bounds.x <= 5;

    if (atRight || atLeft) {
      clawd.className = 'interactive state-edge-peek';
      if (isLateNight()) clawd.classList.add('late-night');
    }
  }

  setInterval(checkEdgePeek, 3000);

  // ---------------- ignored reaction ----------------

  let lastInteraction = Date.now();
  let ignoredActive = false;

  window.addEventListener('mousemove', () => { lastInteraction = Date.now(); });
  window.addEventListener('mousedown', () => { lastInteraction = Date.now(); });

  async function doIgnoredReaction() {
    if (currentMode !== 'awake' || happyTimer || isWalking || ignoredActive) return;
    ignoredActive = true;

    idlePhase = 'ignored-click';
    applyStateClasses();
    await new Promise(r => setTimeout(r, 500));
    if (currentMode !== 'awake') { ignoredActive = false; return; }

    idlePhase = 'ignored-press';
    applyStateClasses();
    await new Promise(r => setTimeout(r, 300));
    if (currentMode !== 'awake') { ignoredActive = false; return; }

    idlePhase = 'ignored-drop';
    applyStateClasses();
    await new Promise(r => setTimeout(r, 1400));
    if (currentMode !== 'awake') { ignoredActive = false; return; }

    idlePhase = 'ignored-hold';
    applyStateClasses();
    await new Promise(r => setTimeout(r, 4000));
    if (currentMode !== 'awake') { ignoredActive = false; return; }

    idlePhase = 'ignored-away';
    applyStateClasses();
    await new Promise(r => setTimeout(r, 900));

    ignoredActive = false;
    idlePhase = 'rest';
    applyStateClasses();
  }

  setInterval(() => {
    const idleTime = Date.now() - lastInteraction;
    if (idleTime > 120000 && currentMode === 'awake' && !ignoredActive && !happyTimer && !isWalking && !thugLifeActive && !copyActive && !pasteActive && !chargingActive) {
      lastInteraction = Date.now();
      doIgnoredReaction();
    }
  }, 10000);

  // ---------------- copy detection ----------------

  let copyActive = false;
  let copyPhase = null;
  let pasteActive = false;
  let pastePhase = null;

  function canClipboardReact() {
    return !happyTimer && !isWalking && !ignoredActive && !thugLifeActive && !chargingActive && currentMode === 'awake';
  }

  async function doCopyReaction() {
    if (copyActive || !canClipboardReact()) return;
    copyActive = true;

    copyPhase = 'grab';
    applyStateClasses();
    await new Promise(r => setTimeout(r, 350));
    if (currentMode !== 'awake') { copyPhase = null; copyActive = false; return; }

    copyPhase = 'hold';
    applyStateClasses();
    await new Promise(r => setTimeout(r, 2000));
    if (currentMode !== 'awake') { copyPhase = null; copyActive = false; return; }

    copyPhase = 'done';
    applyStateClasses();
    await new Promise(r => setTimeout(r, 350));

    copyPhase = null;
    copyActive = false;
    applyStateClasses();
  }

  async function doPasteReaction() {
    if (pasteActive || !canClipboardReact()) return;
    pasteActive = true;

    pastePhase = 'grab';
    applyStateClasses();
    await new Promise(r => setTimeout(r, 350));
    if (currentMode !== 'awake') { pastePhase = null; pasteActive = false; return; }

    pastePhase = 'hold';
    applyStateClasses();
    await new Promise(r => setTimeout(r, 1800));
    if (currentMode !== 'awake') { pastePhase = null; pasteActive = false; return; }

    pastePhase = 'done';
    applyStateClasses();
    await new Promise(r => setTimeout(r, 350));

    pastePhase = null;
    pasteActive = false;
    applyStateClasses();
  }

  listen('clipboard-copy', () => { doCopyReaction(); });
  listen('clipboard-paste', () => { doPasteReaction(); });

  // ---------------- screenshot detection ----------------

  let screenshotActive = false;

  async function doScreenshotReaction() {
    if (screenshotActive || chargingActive || happyTimer) return;
    screenshotActive = true;

    clawd.className = 'interactive state-cheese';
    if (isLateNight()) clawd.classList.add('late-night');

    await new Promise(r => setTimeout(r, 2500));

    screenshotActive = false;
    applyStateClasses();
  }

  listen('screenshot-taken', () => { doScreenshotReaction(); });

  // ---------------- charging celebration ----------------

  async function doChargingCelebration() {
    if (chargingActive || screenshotActive || happyTimer) return;
    chargingActive = true;

    clawd.className = 'interactive state-charging';
    if (isLateNight()) clawd.classList.add('late-night');

    await new Promise(r => setTimeout(r, 3000));

    chargingActive = false;
    applyStateClasses();
  }

  // ---------------- token panel ----------------

  function formatTokens(n) {
    if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return String(n);
  }

  listen('token-stats', (event) => {
    const stats = event.payload;
    document.getElementById('stat-today').textContent = formatTokens(stats.today);
    document.getElementById('stat-week').textContent = formatTokens(stats.week);
    document.getElementById('stat-all').textContent = formatTokens(stats.allTime);
    document.getElementById('stat-sessions').textContent = String(stats.sessionsToday);
  });

  statsToggle.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    panel.classList.toggle('open');
  });

  closeBtn.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    appWindow.close();
  });

  // ---------------- settings ----------------

  const toolSelect = document.getElementById('tool-select');
  const clickActionSelect = document.getElementById('click-action');

  invoke('get_config').then((config) => {
    if (config.tool) toolSelect.value = config.tool;
    if (config.clickAction) clickActionSelect.value = config.clickAction;
  });

  toolSelect.addEventListener('change', (e) => {
    invoke('save_config', { key: 'tool', value: e.target.value });
  });

  clickActionSelect.addEventListener('change', (e) => {
    invoke('save_config', { key: 'clickAction', value: e.target.value });
  });

})();
