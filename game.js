"use strict";

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const menuPanel = document.getElementById("menu-panel");
const startBtn = document.getElementById("start-btn");
const hudObjective = document.getElementById("objective");
const hudStatus = document.getElementById("status");
const promptBox = document.getElementById("prompt");
const puzzlePanel = document.getElementById("puzzle-panel");
const puzzleTitle = document.getElementById("puzzle-title");
const puzzleCopy = document.getElementById("puzzle-copy");
const puzzleOptions = document.getElementById("puzzle-options");
const closePuzzle = document.getElementById("close-puzzle");
const controlButtons = document.querySelectorAll(".ctrl-btn");

const W = canvas.width;
const H = canvas.height;
const FOV = Math.PI / 3;
const MAX_DEPTH = 14;

const rawMap = [
  "111111111111",
  "100001000A01",
  "101101011101",
  "100100000001",
  "110111101101",
  "1B0001000C01",
  "101010101101",
  "1000001000E1",
  "111111111111",
];

const map = rawMap.map((row) => row.split(""));
const terminals = [
  {
    id: "A",
    name: "節點 A：序列鎖",
    x: 9.5,
    y: 1.5,
    clue: "牆上殘留住四個封包：3 1 4 2。按返正確次序先可以拎到金鑰碎片。",
    options: ["3142", "2413", "1337", "4040"],
    answer: "3142",
  },
  {
    id: "B",
    name: "節點 B：二進制門",
    x: 1.5,
    y: 5.5,
    clue: "舊螢幕閃住 1011。轉成十進制，然後提交。",
    options: ["9", "10", "11", "12"],
    answer: "11",
  },
  {
    id: "C",
    name: "節點 C：幽靈端口",
    x: 9.5,
    y: 5.5,
    clue: "出口只信任加密通道。揀 HTTPS 預設端口。",
    options: ["22", "80", "443", "8080"],
    answer: "443",
  },
];

const state = {
  mode: "menu",
  player: { x: 1.5, y: 1.5, angle: 0, bob: 0 },
  ghost: { x: 6.5, y: 3.5, timer: 0, visible: false },
  solved: new Set(),
  signal: 100,
  trace: 0,
  message: "搵到發光終端，按「破解」",
  messageTimer: 0,
  scare: 0,
  glitch: 0,
  lastScareAt: 0,
  input: { forward: false, backward: false, turnLeft: false, turnRight: false, interact: false },
  audio: { ctx: null, enabled: true, drone: null, droneGain: null },
  lastTime: 0,
  rng: 404,
};

function rand() {
  state.rng = (state.rng * 1664525 + 1013904223) >>> 0;
  return state.rng / 4294967296;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function wrapAngle(angle) {
  while (angle < -Math.PI) angle += Math.PI * 2;
  while (angle > Math.PI) angle -= Math.PI * 2;
  return angle;
}

function cellAt(x, y) {
  const mx = Math.floor(x);
  const my = Math.floor(y);
  if (my < 0 || my >= map.length || mx < 0 || mx >= map[0].length) return "1";
  return map[my][mx];
}

function isWall(x, y) {
  return cellAt(x, y) === "1";
}

function distance(a, b, x, y) {
  return Math.hypot(a - x, b - y);
}

function setMessage(text, seconds = 2) {
  state.message = text;
  state.messageTimer = seconds;
}

function unlockAudio() {
  if (state.audio.ctx) {
    state.audio.ctx.resume?.();
    return;
  }
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;
  const audio = new AudioCtx();
  const drone = audio.createOscillator();
  const gain = audio.createGain();
  drone.type = "sawtooth";
  drone.frequency.value = 46;
  gain.gain.value = state.audio.enabled ? 0.018 : 0;
  drone.connect(gain);
  gain.connect(audio.destination);
  drone.start();
  state.audio.ctx = audio;
  state.audio.drone = drone;
  state.audio.droneGain = gain;
}

function setDroneVolume() {
  if (!state.audio.droneGain || !state.audio.ctx) return;
  const now = state.audio.ctx.currentTime;
  const base = state.audio.enabled && state.mode === "playing" ? 0.016 + state.trace * 0.00012 : 0;
  state.audio.droneGain.gain.setTargetAtTime(base, now, 0.08);
}

function tone(freq, duration, type = "square", volume = 0.04, bend = 1) {
  if (!state.audio.enabled || !state.audio.ctx) return;
  const audio = state.audio.ctx;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  const now = audio.currentTime;
  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);
  if (bend !== 1) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq * bend), now + duration);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(volume, now + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  osc.connect(gain);
  gain.connect(audio.destination);
  osc.start(now);
  osc.stop(now + duration + 0.03);
}

function noise(duration = 0.25, volume = 0.08) {
  if (!state.audio.enabled || !state.audio.ctx) return;
  const audio = state.audio.ctx;
  const length = Math.floor(audio.sampleRate * duration);
  const buffer = audio.createBuffer(1, length, audio.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / length);
  const source = audio.createBufferSource();
  const gain = audio.createGain();
  gain.gain.value = volume;
  source.buffer = buffer;
  source.connect(gain);
  gain.connect(audio.destination);
  source.start();
}

function sfx(kind) {
  if (kind === "tap") tone(520, 0.05, "square", 0.025, 1.2);
  if (kind === "ok") {
    tone(540, 0.08, "triangle", 0.05, 1.4);
    window.setTimeout(() => tone(840, 0.08, "triangle", 0.045, 1.2), 80);
  }
  if (kind === "bad") tone(120, 0.23, "sawtooth", 0.065, 0.55);
  if (kind === "door") tone(72, 0.38, "sawtooth", 0.06, 1.7);
  if (kind === "scare") {
    noise(0.45, 0.13);
    tone(58, 0.45, "sawtooth", 0.08, 0.45);
  }
}

function startGame() {
  unlockAudio();
  state.mode = "playing";
  state.player.x = 1.5;
  state.player.y = 1.5;
  state.player.angle = 0;
  state.player.bob = 0;
  state.ghost.x = 6.5;
  state.ghost.y = 3.5;
  state.ghost.timer = 0;
  state.ghost.visible = false;
  state.solved = new Set();
  state.signal = 100;
  state.trace = 0;
  state.scare = 0;
  state.glitch = 0;
  state.lastScareAt = 0;
  state.rng = 404;
  menuPanel.classList.add("hidden");
  puzzlePanel.classList.add("hidden");
  setMessage("入侵開始。搵三個發光節點。", 2.6);
  sfx("door");
  setDroneVolume();
}

function endGame(won) {
  state.mode = won ? "win" : "lose";
  menuPanel.classList.remove("hidden");
  startBtn.textContent = won ? "再入侵一次" : "重新入侵";
  menuPanel.querySelector(".kicker").textContent = won ? "出口已打開" : "訊號斷線";
  menuPanel.querySelector("h1").textContent = won ? "你逃出 404 層" : "黑箱反追蹤成功";
  menuPanel.querySelector("p").textContent = won
    ? `三個節點全部破解，追蹤值停喺 ${Math.round(state.trace)}%。你拎住金鑰離開咗廢棄機房。`
    : "螢幕全黑之前，你見到自己嘅帳號喺牆上重複閃動。";
  sfx(won ? "ok" : "scare");
  setDroneVolume();
}

function castRay(angle) {
  const px = state.player.x;
  const py = state.player.y;
  const rayDirX = Math.cos(angle);
  const rayDirY = Math.sin(angle);
  let mapX = Math.floor(px);
  let mapY = Math.floor(py);
  const deltaDistX = Math.abs(1 / (rayDirX || 0.0001));
  const deltaDistY = Math.abs(1 / (rayDirY || 0.0001));
  const stepX = rayDirX < 0 ? -1 : 1;
  const stepY = rayDirY < 0 ? -1 : 1;
  let sideDistX = rayDirX < 0 ? (px - mapX) * deltaDistX : (mapX + 1 - px) * deltaDistX;
  let sideDistY = rayDirY < 0 ? (py - mapY) * deltaDistY : (mapY + 1 - py) * deltaDistY;
  let side = 0;
  let depth = 0;

  while (depth < MAX_DEPTH) {
    if (sideDistX < sideDistY) {
      sideDistX += deltaDistX;
      mapX += stepX;
      side = 0;
    } else {
      sideDistY += deltaDistY;
      mapY += stepY;
      side = 1;
    }
    depth += 1;
    if (mapY < 0 || mapY >= map.length || mapX < 0 || mapX >= map[0].length || map[mapY][mapX] === "1") {
      const dist = side === 0 ? sideDistX - deltaDistX : sideDistY - deltaDistY;
      const hit = side === 0 ? py + dist * rayDirY : px + dist * rayDirX;
      return { dist, side, hit: hit - Math.floor(hit), mapX, mapY };
    }
  }
  return { dist: MAX_DEPTH, side: 0, hit: 0, mapX, mapY };
}

function drawBackground() {
  const ceiling = ctx.createLinearGradient(0, 0, 0, H / 2);
  ceiling.addColorStop(0, "#020303");
  ceiling.addColorStop(1, "#071312");
  ctx.fillStyle = ceiling;
  ctx.fillRect(0, 0, W, H / 2);

  const floor = ctx.createLinearGradient(0, H / 2, 0, H);
  floor.addColorStop(0, "#081816");
  floor.addColorStop(1, "#020303");
  ctx.fillStyle = floor;
  ctx.fillRect(0, H / 2, W, H / 2);

  ctx.strokeStyle = "rgba(49,246,178,0.12)";
  ctx.lineWidth = 1;
  for (let y = H / 2 + 18; y < H; y += 28) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  for (let x = -W; x < W * 2; x += 80) {
    ctx.beginPath();
    ctx.moveTo(W / 2, H / 2);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
}

function wallColor(ray, shade) {
  const stripe = Math.floor(ray.hit * 8) % 2 === 0;
  const base = ray.side ? [8, 92, 78] : [10, 124, 96];
  const pulse = stripe ? 34 : 0;
  return `rgb(${Math.floor((base[0] + pulse) * shade)}, ${Math.floor((base[1] + pulse) * shade)}, ${Math.floor((base[2] + pulse) * shade)})`;
}

function renderWalls() {
  const strip = 2;
  for (let x = 0; x < W; x += strip) {
    const cameraX = (x / W) * 2 - 1;
    const angle = state.player.angle + cameraX * (FOV / 2);
    const ray = castRay(angle);
    const corrected = Math.max(0.001, ray.dist * Math.cos(angle - state.player.angle));
    const wallHeight = Math.min(H * 1.65, H / corrected);
    const top = H / 2 - wallHeight / 2 + Math.sin(state.player.bob) * 3;
    const shade = clamp(1.2 - corrected / MAX_DEPTH, 0.22, 1);
    ctx.fillStyle = wallColor(ray, shade);
    ctx.fillRect(x, top, strip + 1, wallHeight);

    if (ray.hit > 0.47 && ray.hit < 0.53) {
      ctx.fillStyle = `rgba(49,246,178,${0.2 * shade})`;
      ctx.fillRect(x, top, strip + 1, wallHeight);
    }
  }
}

function projectObject(obj) {
  const dx = obj.x - state.player.x;
  const dy = obj.y - state.player.y;
  const dist = Math.hypot(dx, dy);
  const worldAngle = Math.atan2(dy, dx);
  const angle = wrapAngle(worldAngle - state.player.angle);
  if (Math.abs(angle) > FOV * 0.68 || dist < 0.15) return null;
  if (castRay(worldAngle).dist < dist - 0.25) return null;
  const screenX = W / 2 + Math.tan(angle) * (W / 2) / Math.tan(FOV / 2);
  const size = clamp((H / dist) * (obj.scale || 0.68), 26, H * 1.2);
  return { screenX, size, dist };
}

function drawTerminal(obj, projection, solved) {
  const { screenX, size, dist } = projection;
  const x = screenX - size * 0.36;
  const y = H / 2 - size * 0.32;
  const alpha = clamp(1.2 - dist / 9, 0.25, 1);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = solved ? "#13332c" : "#061211";
  ctx.fillRect(x, y, size * 0.72, size * 0.58);
  ctx.strokeStyle = solved ? "#6fffcf" : "#31f6b2";
  ctx.lineWidth = Math.max(1, size * 0.018);
  ctx.strokeRect(x, y, size * 0.72, size * 0.58);
  ctx.fillStyle = solved ? "#6fffcf" : "#ff315f";
  ctx.fillRect(x + size * 0.12, y + size * 0.15, size * 0.48, size * 0.08);
  ctx.fillRect(x + size * 0.12, y + size * 0.3, size * 0.32, size * 0.06);
  ctx.fillStyle = "#e9fff8";
  ctx.font = `700 ${Math.max(10, size * 0.13)}px monospace`;
  ctx.textAlign = "center";
  ctx.fillText(obj.id, screenX, y + size * 0.5);
  ctx.globalAlpha = 1;
}

function drawExit(obj, projection) {
  const { screenX, size, dist } = projection;
  const open = state.solved.size >= 3;
  const alpha = clamp(1.25 - dist / 10, 0.25, 1);
  const x = screenX - size * 0.4;
  const y = H / 2 - size * 0.44;
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = open ? "#ffffff" : "#ff315f";
  ctx.lineWidth = Math.max(2, size * 0.03);
  ctx.strokeRect(x, y, size * 0.8, size * 0.9);
  ctx.fillStyle = open ? "rgba(49,246,178,0.24)" : "rgba(255,49,95,0.16)";
  ctx.fillRect(x, y, size * 0.8, size * 0.9);
  ctx.fillStyle = open ? "#31f6b2" : "#ff315f";
  ctx.font = `700 ${Math.max(12, size * 0.11)}px monospace`;
  ctx.textAlign = "center";
  ctx.fillText(open ? "EXIT" : "LOCKED", screenX, y + size * 0.5);
  ctx.globalAlpha = 1;
}

function drawGhost(projection) {
  const { screenX, size, dist } = projection;
  const x = screenX;
  const y = H / 2 - size * 0.22;
  const alpha = clamp(1.15 - dist / 8, 0.18, 0.9);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = "rgba(230,255,250,0.72)";
  ctx.beginPath();
  ctx.arc(x, y, size * 0.22, Math.PI, 0);
  ctx.lineTo(x + size * 0.22, y + size * 0.36);
  ctx.lineTo(x + size * 0.08, y + size * 0.28);
  ctx.lineTo(x, y + size * 0.39);
  ctx.lineTo(x - size * 0.08, y + size * 0.28);
  ctx.lineTo(x - size * 0.22, y + size * 0.36);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#020303";
  ctx.fillRect(x - size * 0.1, y - size * 0.02, size * 0.05, size * 0.08);
  ctx.fillRect(x + size * 0.05, y - size * 0.02, size * 0.05, size * 0.08);
  ctx.globalAlpha = 1;
}

function renderObjects() {
  const objects = terminals.map((terminal) => ({ ...terminal, type: "terminal", scale: 0.78 }));
  objects.push({ type: "exit", x: 10.5, y: 7.5, scale: 0.9 });
  if (state.ghost.visible || state.scare > 0) objects.push({ type: "ghost", x: state.ghost.x, y: state.ghost.y, scale: 0.8 });

  const projected = objects
    .map((obj) => ({ obj, projection: projectObject(obj) }))
    .filter((item) => item.projection)
    .sort((a, b) => b.projection.dist - a.projection.dist);

  for (const item of projected) {
    if (item.obj.type === "terminal") drawTerminal(item.obj, item.projection, state.solved.has(item.obj.id));
    if (item.obj.type === "exit") drawExit(item.obj, item.projection);
    if (item.obj.type === "ghost") drawGhost(item.projection);
  }
}

function renderOverlay() {
  if (state.glitch > 0) {
    ctx.globalAlpha = clamp(state.glitch, 0, 0.75);
    for (let i = 0; i < 18; i += 1) {
      ctx.fillStyle = i % 2 ? "#ff315f" : "#31f6b2";
      ctx.fillRect(rand() * W, rand() * H, 40 + rand() * 220, 2 + rand() * 18);
    }
    ctx.globalAlpha = 1;
  }

  if (state.scare > 0) {
    const alpha = clamp(state.scare * 1.5, 0, 1);
    ctx.fillStyle = `rgba(0,0,0,${0.42 * alpha})`;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = `rgba(255,255,255,${0.85 * alpha})`;
    ctx.beginPath();
    ctx.arc(W / 2, H / 2 - 20, 106, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#020303";
    ctx.fillRect(W / 2 - 48, H / 2 - 56, 28, 52);
    ctx.fillRect(W / 2 + 20, H / 2 - 56, 28, 52);
    ctx.fillRect(W / 2 - 56, H / 2 + 34, 112, 18);
    ctx.fillStyle = `rgba(255,49,95,${0.72 * alpha})`;
    ctx.fillRect(0, H * 0.18, W, 12);
    ctx.fillRect(0, H * 0.8, W, 10);
  }

  ctx.fillStyle = "rgba(49,246,178,0.06)";
  for (let y = 0; y < H; y += 4) ctx.fillRect(0, y, W, 1);
}

function render() {
  ctx.clearRect(0, 0, W, H);
  drawBackground();
  renderWalls();
  renderObjects();
  renderOverlay();
}

function nearestTerminal() {
  let best = null;
  let bestDist = Infinity;
  for (const terminal of terminals) {
    const dist = distance(state.player.x, state.player.y, terminal.x, terminal.y);
    if (dist < bestDist) {
      best = terminal;
      bestDist = dist;
    }
  }
  return bestDist < 1.25 ? best : null;
}

function nearExit() {
  return distance(state.player.x, state.player.y, 10.5, 7.5) < 1.05;
}

function openPuzzle(terminal) {
  if (state.solved.has(terminal.id)) {
    setMessage("呢個節點已經解鎖。", 1.6);
    return;
  }
  state.mode = "puzzle";
  puzzleTitle.textContent = terminal.name;
  puzzleCopy.textContent = terminal.clue;
  puzzleOptions.innerHTML = "";
  for (const option of terminal.options) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = option;
    button.addEventListener("click", () => answerPuzzle(terminal, option, button));
    puzzleOptions.appendChild(button);
  }
  puzzlePanel.classList.remove("hidden");
  sfx("tap");
  setDroneVolume();
}

function answerPuzzle(terminal, option, button) {
  unlockAudio();
  if (option === terminal.answer) {
    state.solved.add(terminal.id);
    state.mode = "playing";
    puzzlePanel.classList.add("hidden");
    state.trace = clamp(state.trace - 5, 0, 100);
    state.glitch = 0.25;
    setMessage(`${terminal.name} 已破解。金鑰碎片 ${state.solved.size}/3`, 2.2);
    sfx("ok");
    if (state.solved.size === 3) {
      setMessage("三個節點完成。出口已解鎖，搵 EXIT。", 3);
      sfx("door");
    }
  } else {
    button.classList.add("wrong");
    state.signal = clamp(state.signal - 12, 0, 100);
    state.trace = clamp(state.trace + 9, 0, 100);
    state.glitch = 0.65;
    setMessage("錯誤封包。系統開始反追蹤。", 2);
    sfx("bad");
    if (state.signal <= 0) endGame(false);
  }
  setDroneVolume();
}

function closePuzzlePanel() {
  if (state.mode === "puzzle") state.mode = "playing";
  puzzlePanel.classList.add("hidden");
  setDroneVolume();
}

function tryInteract() {
  if (state.mode !== "playing") return;
  const terminal = nearestTerminal();
  if (terminal) {
    openPuzzle(terminal);
    return;
  }
  if (nearExit()) {
    if (state.solved.size >= 3) endGame(true);
    else {
      setMessage("出口鎖死。仲差節點金鑰。", 1.8);
      sfx("bad");
    }
    return;
  }
  setMessage("附近冇可破解目標。", 1.2);
}

function updatePlayer(dt) {
  const turnSpeed = 2.25;
  const moveSpeed = 2.1;
  if (state.input.turnLeft) state.player.angle -= turnSpeed * dt;
  if (state.input.turnRight) state.player.angle += turnSpeed * dt;
  state.player.angle = wrapAngle(state.player.angle);

  const dir = (state.input.forward ? 1 : 0) - (state.input.backward ? 1 : 0);
  if (dir !== 0) {
    const speed = moveSpeed * dir * dt;
    const nx = state.player.x + Math.cos(state.player.angle) * speed;
    const ny = state.player.y + Math.sin(state.player.angle) * speed;
    if (!isWall(nx, state.player.y)) state.player.x = nx;
    if (!isWall(state.player.x, ny)) state.player.y = ny;
    state.player.bob += dt * 9;
  } else {
    state.player.bob += dt * 2;
  }
}

function updateGhost(dt) {
  state.ghost.timer += dt;
  const t = state.ghost.timer;
  state.ghost.x = 6.5 + Math.cos(t * 0.42) * 2.3 + Math.sin(t * 0.17) * 0.7;
  state.ghost.y = 4.3 + Math.sin(t * 0.36) * 1.8;
  state.ghost.visible = state.trace > 24 || Math.sin(t * 1.7) > 0.92;
  const ghostDist = distance(state.player.x, state.player.y, state.ghost.x, state.ghost.y);
  if (ghostDist < 1.1) {
    state.signal = clamp(state.signal - dt * 24, 0, 100);
    state.trace = clamp(state.trace + dt * 18, 0, 100);
    if (performance.now() - state.lastScareAt > 4200) {
      state.lastScareAt = performance.now();
      state.scare = 0.75;
      state.glitch = 0.9;
      setMessage("監控幽影貼近咗你。", 1.8);
      sfx("scare");
    }
  }
}

function updateWorld(dt) {
  if (state.mode !== "playing") return;
  state.trace = clamp(state.trace + dt * (0.9 + state.solved.size * 0.2), 0, 100);
  if (state.trace >= 100) state.signal = clamp(state.signal - dt * 10, 0, 100);
  if (state.signal <= 0) endGame(false);
  updatePlayer(dt);
  updateGhost(dt);

  if (state.input.interact) {
    state.input.interact = false;
    tryInteract();
  }
}

function updatePrompt() {
  if (state.mode !== "playing") {
    promptBox.classList.add("hidden");
    return;
  }
  const terminal = nearestTerminal();
  if (terminal && !state.solved.has(terminal.id)) {
    promptBox.textContent = `按「破解」打開 ${terminal.name}`;
    promptBox.classList.remove("hidden");
  } else if (terminal) {
    promptBox.textContent = `${terminal.name} 已完成`;
    promptBox.classList.remove("hidden");
  } else if (nearExit()) {
    promptBox.textContent = state.solved.size >= 3 ? "按「破解」離開 404 層" : "出口需要 3 個金鑰碎片";
    promptBox.classList.remove("hidden");
  } else if (state.messageTimer > 0) {
    promptBox.textContent = state.message;
    promptBox.classList.remove("hidden");
  } else {
    promptBox.classList.add("hidden");
  }
}

function updateHud() {
  hudObjective.textContent = state.solved.size >= 3 ? "出口已解鎖：搵 EXIT" : `破解節點 ${state.solved.size}/3`;
  hudStatus.textContent = `訊號 ${Math.ceil(state.signal)}% · 追蹤 ${Math.ceil(state.trace)}%`;
  hudStatus.style.color = state.signal < 35 ? "#ffb8c6" : "#e9fff8";
}

function update(dt) {
  updateWorld(dt);
  if (state.messageTimer > 0) state.messageTimer -= dt;
  if (state.scare > 0) state.scare -= dt;
  if (state.glitch > 0) state.glitch -= dt * 1.8;
  updatePrompt();
  updateHud();
  setDroneVolume();
}

function tick(timestamp) {
  if (!state.lastTime) state.lastTime = timestamp;
  const dt = Math.min(0.04, (timestamp - state.lastTime) / 1000);
  state.lastTime = timestamp;
  update(dt);
  render();
  requestAnimationFrame(tick);
}

function setInput(action, active) {
  if (action === "sound" && active) {
    unlockAudio();
    state.audio.enabled = !state.audio.enabled;
    sfx("tap");
    setDroneVolume();
    return;
  }
  if (action === "full" && active) {
    toggleFullscreen();
    return;
  }
  if (action === "interact" && active) {
    state.input.interact = true;
    return;
  }
  if (action in state.input) state.input[action] = active;
}

function toggleFullscreen() {
  const shell = document.getElementById("game-shell");
  if (!document.fullscreenElement) shell.requestFullscreen?.();
  else document.exitFullscreen?.();
}

controlButtons.forEach((button) => {
  const action = button.dataset.action;
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    unlockAudio();
    button.classList.add("pressed");
    setInput(action, true);
    button.setPointerCapture?.(event.pointerId);
  });
  button.addEventListener("pointerup", (event) => {
    event.preventDefault();
    button.classList.remove("pressed");
    setInput(action, false);
    button.releasePointerCapture?.(event.pointerId);
  });
  button.addEventListener("pointercancel", () => {
    button.classList.remove("pressed");
    setInput(action, false);
  });
});

window.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  if (key === "arrowup" || key === "w") state.input.forward = true;
  if (key === "arrowdown" || key === "s") state.input.backward = true;
  if (key === "arrowleft" || key === "a") state.input.turnLeft = true;
  if (key === "arrowright" || key === "d") state.input.turnRight = true;
  if (key === " " || key === "e" || key === "enter") state.input.interact = true;
  if (key === "m") setInput("sound", true);
  if (key === "f") toggleFullscreen();
});

window.addEventListener("keyup", (event) => {
  const key = event.key.toLowerCase();
  if (key === "arrowup" || key === "w") state.input.forward = false;
  if (key === "arrowdown" || key === "s") state.input.backward = false;
  if (key === "arrowleft" || key === "a") state.input.turnLeft = false;
  if (key === "arrowright" || key === "d") state.input.turnRight = false;
});

startBtn.addEventListener("click", startGame);
closePuzzle.addEventListener("click", closePuzzlePanel);

window.advanceTime = (ms) => {
  const steps = Math.max(1, Math.round(ms / (1000 / 60)));
  for (let i = 0; i < steps; i += 1) update(1 / 60);
  render();
};

window.render_game_to_text = () => {
  const terminal = nearestTerminal();
  return JSON.stringify({
    mode: state.mode,
    player: {
      x: Number(state.player.x.toFixed(2)),
      y: Number(state.player.y.toFixed(2)),
      angle: Number(state.player.angle.toFixed(2)),
    },
    signal: Number(state.signal.toFixed(1)),
    trace: Number(state.trace.toFixed(1)),
    solved: [...state.solved],
    nearbyTerminal: terminal ? terminal.id : null,
    nearExit: nearExit(),
    prompt: promptBox.classList.contains("hidden") ? "" : promptBox.textContent,
    note: "First-person canvas ray-cast hacker puzzle. Move with WASD/arrows or touch, interact with terminals, solve A/B/C, then exit.",
  });
};

updateHud();
render();
requestAnimationFrame(tick);
