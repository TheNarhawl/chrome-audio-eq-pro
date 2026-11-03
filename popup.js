/**
 * @fileoverview Контроллер интерфейса Popup.
 * Управляет 10-полосным эквалайзером, усилением, отрисовкой АЧХ + интерактивной кривой EQ на Canvas,
 * переключением тем и синхронизацией пользовательских пресетов в chrome.storage.sync.
 */

const FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/** Встроенные пресеты эквалайзера (в дБ для 10 полос) */
const BUILTIN_PRESETS = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  bass: [7, 6, 4.5, 2, 0, 0, 0, 0, 0, 0],
  vocal: [-3, -2, -1, 1.5, 4, 5, 4, 2, 0, -1],
  rock: [5, 4, 2, -1, -2, 0, 2.5, 4, 5, 5],
  electronic: [6, 5, 1.5, -2, -1, 1, 0.5, 3, 5, 6],
  podcast: [-6, -4, -1, 2, 4.5, 5, 3.5, 1, -1, -3]
};

/** Текущее состояние аудио-настроек открытой вкладки */
const state = {
  tabId: null,
  tabUrl: '',
  captured: false,
  gain: 1.0,
  limiter: true,
  bands: [...BUILTIN_PRESETS.flat],
  presetName: 'flat'
};

/** Массив последних полученных значений FFT от AnalyserNode */
let latestFftBins = new Array(64).fill(0);
let visualizerPort = null;
let editingPresetId = null;

// Состояние интерактивного перетаскивания точек на Canvas
let draggedBandIndex = null;
let hoveredBandIndex = null;
let isSyncingAudio = false;
let audioSyncPending = false;

// Ссылки на DOM-элементы
const dom = {
  captureStatusBadge: document.getElementById('captureStatusBadge'),
  releaseBtn: document.getElementById('releaseBtn'),
  themeToggleBtn: document.getElementById('themeToggleBtn'),
  openDrawerBtn: document.getElementById('openDrawerBtn'),
  closeDrawerBtn: document.getElementById('closeDrawerBtn'),
  drawerBackdrop: document.getElementById('drawerBackdrop'),
  presetsDrawer: document.getElementById('presetsDrawer'),
  errorBanner: document.getElementById('errorBanner'),
  gainSlider: document.getElementById('gainSlider'),
  gainNumberInput: document.getElementById('gainNumberInput'),
  tickButtons: document.querySelectorAll('.tick-btn'),
  limiterCheckbox: document.getElementById('limiterCheckbox'),
  clippingWarning: document.getElementById('clippingWarning'),
  clippingWarningText: document.getElementById('clippingWarningText'),
  spectrumCanvas: document.getElementById('spectrumCanvas'),
  builtinPresetSelect: document.getElementById('builtinPresetSelect'),
  resetEqBtn: document.getElementById('resetEqBtn'),
  eqBandsContainer: document.getElementById('eqBandsContainer'),
  savePresetForm: document.getElementById('savePresetForm'),
  newPresetNameInput: document.getElementById('newPresetNameInput'),
  userPresetsList: document.getElementById('userPresetsList')
};

/**
 * Форматирует частоту для компактного отображения под ползунком (31, 1k, 16k).
 * @param {number} hz
 * @returns {string}
 */
function formatFreq(hz) {
  return hz >= 1000 ? `${hz / 1000}k` : String(hz);
}

/**
 * Создаёт DOM-структуру 10 полос эквалайзера.
 */
function buildEqSliders() {
  dom.eqBandsContainer.innerHTML = '';

  FREQUENCIES.forEach((freq, idx) => {
    const bandEl = document.createElement('div');
    bandEl.className = 'eq-band';
    bandEl.id = `eq-band-${idx}`;

    const dbLabel = document.createElement('span');
    dbLabel.className = 'band-db';
    dbLabel.id = `band-db-${idx}`;
    dbLabel.textContent = '0dB';

    const sliderWrap = document.createElement('div');
    sliderWrap.className = 'band-slider-wrap';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'band-slider';
    slider.min = '-12';
    slider.max = '12';
    slider.step = '0.5';
    slider.value = '0';
    slider.dataset.index = String(idx);

    slider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      state.bands[idx] = val;
      state.presetName = 'custom';
      dom.builtinPresetSelect.value = 'custom';
      updateEqDomLabels();
      syncAudioSettings();
    });

    slider.addEventListener('dblclick', () => {
      setBandValue(idx, 0);
    });

    const freqLabel = document.createElement('span');
    freqLabel.className = 'band-freq';
    freqLabel.textContent = formatFreq(freq);

    sliderWrap.appendChild(slider);
    bandEl.appendChild(dbLabel);
    bandEl.appendChild(sliderWrap);
    bandEl.appendChild(freqLabel);
    dom.eqBandsContainer.appendChild(bandEl);
  });
}

/**
 * Устанавливает значение дБ для выбранной полосы эквалайзера и синхронизирует UI.
 * @param {number} idx
 * @param {number} db
 */
function setBandValue(idx, db) {
  const clamped = Math.max(-12, Math.min(12, db));
  if (state.bands[idx] === clamped) return;

  state.bands[idx] = clamped;
  state.presetName = 'custom';
  dom.builtinPresetSelect.value = 'custom';

  const slider = dom.eqBandsContainer.querySelector(`.band-slider[data-index="${idx}"]`);
  if (slider) {
    slider.value = String(clamped);
  }

  const label = document.getElementById(`band-db-${idx}`);
  if (label) {
    const prefix = clamped > 0 ? '+' : '';
    label.textContent = `${prefix}${clamped}`;
    label.classList.toggle('non-zero', clamped !== 0);
  }

  syncAudioSettings();
}

/**
 * Подсвечивает соответствующий ползунок эквалайзера при наведении/перетаскивании точки на Canvas.
 * @param {number|null} activeIdx
 */
function highlightBandDom(activeIdx) {
  FREQUENCIES.forEach((_, idx) => {
    const el = document.getElementById(`eq-band-${idx}`);
    if (el) {
      el.classList.toggle('canvas-active', idx === activeIdx);
    }
  });
}

/**
 * Синхронизирует все контролы UI с текущим объектом `state`.
 */
function renderStateToUi() {
  const percent = Math.round(state.gain * 100);
  dom.gainSlider.value = String(percent);
  dom.gainNumberInput.value = String(percent);
  dom.limiterCheckbox.checked = state.limiter;

  dom.tickButtons.forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.gain) === percent);
  });

  // Предупреждение о клиппинге при > 300%
  if (percent > 300) {
    dom.clippingWarning.hidden = false;
    dom.clippingWarningText.textContent = state.limiter
      ? `Усиление ${percent}% (>300%): активен DynamicsCompressor для защиты от клиппинга.`
      : `ВНИМАНИЕ (${percent}%): лимитер отключён! Высокий уровень жёстких цифровых искажений.`;
  } else {
    dom.clippingWarning.hidden = true;
  }

  // Статус захвата вкладки
  dom.captureStatusBadge.textContent = state.captured ? 'ACTIVE' : 'STANDBY';
  dom.captureStatusBadge.classList.toggle('active', state.captured);
  dom.releaseBtn.hidden = !state.captured;

  // Селектор пресета
  if (BUILTIN_PRESETS[state.presetName]) {
    dom.builtinPresetSelect.value = state.presetName;
  } else {
    dom.builtinPresetSelect.value = 'custom';
  }

  // Полосы эквалайзера
  const sliders = dom.eqBandsContainer.querySelectorAll('.band-slider');
  sliders.forEach((slider, idx) => {
    slider.value = String(state.bands[idx] ?? 0);
  });
  updateEqDomLabels();
}

/**
 * Обновляет текстовые подписи дБ над ползунками эквалайзера.
 */
function updateEqDomLabels() {
  state.bands.forEach((val, idx) => {
    const label = document.getElementById(`band-db-${idx}`);
    if (!label) return;
    const rounded = Math.round(val * 10) / 10;
    const prefix = rounded > 0 ? '+' : '';
    label.textContent = `${prefix}${rounded}`;
    label.classList.toggle('non-zero', rounded !== 0);
  });
}

/**
 * Отправляет обновлённые параметры звука в Service Worker -> Offscreen.
 * Использует очередь для предотвращения задержек при быстром интерактивном перетаскивании.
 */
async function syncAudioSettings() {
  if (state.tabId === null) return;
  if (isSyncingAudio) {
    audioSyncPending = true;
    return;
  }
  isSyncingAudio = true;

  try {
    do {
      audioSyncPending = false;
      const response = await chrome.runtime.sendMessage({
        target: 'service-worker',
        type: 'APPLY_AUDIO_SETTINGS',
        tabId: state.tabId,
        tabUrl: state.tabUrl,
        settings: {
          gain: state.gain,
          limiter: state.limiter,
          bands: state.bands,
          presetName: state.presetName
        }
      });

      if (!response?.ok) {
        showError(response?.error || 'Ошибка применения настроек звука');
        break;
      }

      hideError();
      state.captured = Boolean(response.captured);
      dom.captureStatusBadge.textContent = state.captured ? 'ACTIVE' : 'STANDBY';
      dom.captureStatusBadge.classList.toggle('active', state.captured);
      dom.releaseBtn.hidden = !state.captured;
      ensureVisualizerConnection();
    } while (audioSyncPending);
  } catch (_) {
    // Безопасный перехват прерванных сообщений
  } finally {
    isSyncingAudio = false;
  }
}

/**
 * Подключает порт реального времени к Offscreen для получения данных спектра АЧХ.
 */
function ensureVisualizerConnection() {
  if (visualizerPort || !state.captured || state.tabId === null) return;

  try {
    visualizerPort = chrome.runtime.connect({ name: 'visualizer-port' });
    visualizerPort.postMessage({ type: 'SUBSCRIBE_TAB', tabId: state.tabId });

    visualizerPort.onMessage.addListener((msg) => {
      if (msg.type === 'FFT_DATA' && Array.isArray(msg.bins)) {
        latestFftBins = msg.bins;
      }
    });

    visualizerPort.onDisconnect.addListener(() => {
      visualizerPort = null;
    });
  } catch (_) {
    visualizerPort = null;
  }
}

const CANVAS_PADDING_X = 16;
const CANVAS_PADDING_Y = 12;

/**
 * Возвращает координаты X и Y полосы эквалайзера на Canvas.
 * @param {number} idx
 * @param {number} width
 * @param {number} height
 * @returns {{ x: number, y: number, stepX: number }}
 */
function getBandCoords(idx, width, height) {
  const stepX = (width - CANVAS_PADDING_X * 2) / (FREQUENCIES.length - 1);
  const x = CANVAS_PADDING_X + idx * stepX;
  const innerHeight = height - CANVAS_PADDING_Y * 2;
  const db = state.bands[idx] ?? 0;
  const normalized = (db + 12) / 24;
  const y = height - CANVAS_PADDING_Y - normalized * innerHeight;
  return { x, y, stepX };
}

/**
 * Картирует значение дБ в координату Y на Canvas.
 * @param {number} db
 * @param {number} height
 * @returns {number}
 */
function dbToCanvasY(db, height) {
  const innerHeight = height - CANVAS_PADDING_Y * 2;
  const normalized = (db + 12) / 24;
  return height - CANVAS_PADDING_Y - normalized * innerHeight;
}

/**
 * Картирует координату Y на Canvas в дБ [-12..+12] с шагом 0.5 дБ и привязкой к 0.
 * @param {number} canvasY
 * @param {number} height
 * @returns {number}
 */
function canvasYToDb(canvasY, height) {
  const innerHeight = height - CANVAS_PADDING_Y * 2;
  const normalized = (height - CANVAS_PADDING_Y - canvasY) / innerHeight;
  let db = normalized * 24 - 12;
  db = Math.max(-12, Math.min(12, db));
  if (Math.abs(db) < 0.25) {
    return 0;
  }
  return Math.round(db * 2) / 2;
}

/**
 * Ищет индекс полосы по координатам клика/касания на Canvas.
 * @param {number} canvasX
 * @param {number} canvasY
 * @param {number} width
 * @param {number} height
 * @returns {number} Индекс полосы [0..9] или -1
 */
function findBandAt(canvasX, canvasY, width, height) {
  const stepX = (width - CANVAS_PADDING_X * 2) / (FREQUENCIES.length - 1);

  // 1. Приоритетный поиск прямого попадания в точку узла (радиус 18px)
  let closestPointIdx = -1;
  let minPointDist = Infinity;
  for (let idx = 0; idx < FREQUENCIES.length; idx++) {
    const { x, y } = getBandCoords(idx, width, height);
    const dist = Math.hypot(canvasX - x, canvasY - y);
    if (dist < minPointDist) {
      minPointDist = dist;
      closestPointIdx = idx;
    }
  }
  if (minPointDist <= 18) {
    return closestPointIdx;
  }

  // 2. Поиск по вертикальной полосе частоты (в пределах половины шага)
  let closestColIdx = -1;
  let minColDist = Infinity;
  for (let idx = 0; idx < FREQUENCIES.length; idx++) {
    const { x } = getBandCoords(idx, width, height);
    const distX = Math.abs(canvasX - x);
    if (distX < minColDist) {
      minColDist = distX;
      closestColIdx = idx;
    }
  }
  if (minColDist <= stepX * 0.5) {
    return closestColIdx;
  }

  return -1;
}

/**
 * Проверяет, находится ли курсор непосредственно над точкой полосы.
 * @param {number} canvasX
 * @param {number} canvasY
 * @param {number} width
 * @param {number} height
 * @returns {number|null}
 */
function getPointUnderCursor(canvasX, canvasY, width, height) {
  for (let idx = 0; idx < FREQUENCIES.length; idx++) {
    const { x, y } = getBandCoords(idx, width, height);
    if (Math.hypot(canvasX - x, canvasY - y) <= 16) {
      return idx;
    }
  }
  return null;
}

/**
 * Инициализирует интерактивную обработку мыши и тач-событий на Canvas эквалайзера.
 */
function setupCanvasInteractions() {
  const canvas = dom.spectrumCanvas;

  const getCanvasCoords = (e) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY
    };
  };

  canvas.addEventListener('pointerdown', (e) => {
    const { x, y } = getCanvasCoords(e);
    const bandIdx = findBandAt(x, y, canvas.width, canvas.height);
    if (bandIdx !== -1) {
      draggedBandIndex = bandIdx;
      hoveredBandIndex = bandIdx;
      canvas.setPointerCapture(e.pointerId);
      const newDb = canvasYToDb(y, canvas.height);
      setBandValue(bandIdx, newDb);
      highlightBandDom(bandIdx);
      canvas.style.cursor = 'ns-resize';
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const { x, y } = getCanvasCoords(e);

    if (draggedBandIndex !== null) {
      const newDb = canvasYToDb(y, canvas.height);
      setBandValue(draggedBandIndex, newDb);
      highlightBandDom(draggedBandIndex);
    } else {
      const pointIdx = getPointUnderCursor(x, y, canvas.width, canvas.height);
      if (pointIdx !== null) {
        hoveredBandIndex = pointIdx;
        canvas.style.cursor = 'ns-resize';
        highlightBandDom(pointIdx);
      } else {
        const colIdx = findBandAt(x, y, canvas.width, canvas.height);
        hoveredBandIndex = colIdx !== -1 ? colIdx : null;
        canvas.style.cursor = colIdx !== -1 ? 'pointer' : 'default';
        highlightBandDom(hoveredBandIndex);
      }
    }
  });

  const onPointerUp = (e) => {
    if (draggedBandIndex !== null) {
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch (_) { }
      draggedBandIndex = null;
      const { x, y } = getCanvasCoords(e);
      const pointIdx = getPointUnderCursor(x, y, canvas.width, canvas.height);
      canvas.style.cursor = pointIdx !== null ? 'ns-resize' : 'default';
      highlightBandDom(hoveredBandIndex);
    }
  };

  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);

  canvas.addEventListener('pointerleave', () => {
    if (draggedBandIndex === null) {
      hoveredBandIndex = null;
      canvas.style.cursor = 'default';
      highlightBandDom(null);
    }
  });

  canvas.addEventListener('dblclick', (e) => {
    const { x, y } = getCanvasCoords(e);
    const bandIdx = findBandAt(x, y, canvas.width, canvas.height);
    if (bandIdx !== -1) {
      setBandValue(bandIdx, 0);
      highlightBandDom(bandIdx);
    }
  });

  canvas.addEventListener('wheel', (e) => {
    const { x, y } = getCanvasCoords(e);
    const bandIdx = findBandAt(x, y, canvas.width, canvas.height);
    if (bandIdx !== -1) {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.5 : -0.5;
      const current = state.bands[bandIdx] ?? 0;
      setBandValue(bandIdx, current + delta);
      highlightBandDom(bandIdx);
    }
  }, { passive: false });
}

/**
 * Запускает цикл отрисовки Canvas:
 * 1) Столбики спектра в реальном времени (AnalyserNode FFT)
 * 2) Направляющая активной полосы
 * 3) Результирующая кривая эквалайзера (АЧХ фильтров)
 * 4) Интерактивные узловые точки с возможностью перетаскивания мышью
 * 5) Всплывающий плоский бейдж с точным значением дБ
 */
function startCanvasLoop() {
  const canvas = dom.spectrumCanvas;
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;

  const render = () => {
    const style = getComputedStyle(document.documentElement);
    const bgControl = style.getPropertyValue('--bg-control').trim() || '#181818';
    const bgPanel = style.getPropertyValue('--bg-panel').trim() || '#252525';
    const gridColor = style.getPropertyValue('--canvas-grid').trim() || '#2f2f2f';
    const accentColor = style.getPropertyValue('--accent').trim() || '#4a9eff';
    const accentHover = style.getPropertyValue('--accent-hover').trim() || '#68b0ff';
    const textMain = style.getPropertyValue('--text-main').trim() || '#f0f0f0';

    ctx.fillStyle = bgControl;
    ctx.fillRect(0, 0, width, height);

    // Сетка: линия 0 dB по центру
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const midY = dbToCanvasY(0, height);
    ctx.moveTo(0, midY);
    ctx.lineTo(width, midY);
    ctx.stroke();

    // 1. Отрисовка спектра FFT (плоские столбики)
    const binCount = latestFftBins.length;
    const barWidth = width / binCount;
    ctx.fillStyle = state.captured ? `${accentColor}44` : `${gridColor}55`;

    for (let i = 0; i < binCount; i++) {
      const val = state.captured ? latestFftBins[i] : 0;
      const barHeight = (val / 255) * (height - 8);
      const x = Math.floor(i * barWidth);
      const y = height - barHeight;
      ctx.fillRect(x, y, Math.max(1, Math.floor(barWidth - 1)), barHeight);
    }

    // 2. Вертикальная пунктирная направляющая при перетаскивании полосы
    if (draggedBandIndex !== null && draggedBandIndex >= 0 && draggedBandIndex < FREQUENCIES.length) {
      const { x: guideX } = getBandCoords(draggedBandIndex, width, height);
      ctx.save();
      ctx.strokeStyle = `${accentColor}66`;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(guideX, 0);
      ctx.lineTo(guideX, height);
      ctx.stroke();
      ctx.restore();
    }

    // 3. Отрисовка кривой 10-полосного эквалайзера
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 2;
    ctx.beginPath();

    const firstCoord = getBandCoords(0, width, height);
    ctx.moveTo(0, firstCoord.y);

    for (let idx = 0; idx < FREQUENCIES.length; idx++) {
      const { x, y } = getBandCoords(idx, width, height);
      ctx.lineTo(x, y);
    }

    const lastCoord = getBandCoords(FREQUENCIES.length - 1, width, height);
    ctx.lineTo(width, lastCoord.y);
    ctx.stroke();

    // 4. Интерактивные узловые точки на кривой
    for (let idx = 0; idx < FREQUENCIES.length; idx++) {
      const { x, y } = getBandCoords(idx, width, height);
      const isDragged = (draggedBandIndex === idx);
      const isHovered = (hoveredBandIndex === idx);

      if (isDragged) {
        // Перетаскиваемая точка
        ctx.fillStyle = accentHover;
        ctx.beginPath();
        ctx.arc(x, y, 6.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
      } else if (isHovered) {
        // Точка под курсором
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(x, y, 5.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = accentColor;
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        // Обычная узловая точка
        ctx.fillStyle = accentColor;
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = bgControl;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    requestAnimationFrame(render);
  };

  requestAnimationFrame(render);
}

/**
 * Загружает и отображает список пользовательских пресетов из chrome.storage.sync.
 */
async function loadAndRenderUserPresets() {
  const { userPresets = [] } = await chrome.storage.sync.get({ userPresets: [] });
  dom.userPresetsList.innerHTML = '';

  if (userPresets.length === 0) {
    const emptyEl = document.createElement('li');
    emptyEl.className = 'empty-presets';
    emptyEl.textContent = 'Сохранённых пресетов пока нет. Настройте звук и нажмите «Сохранить».';
    dom.userPresetsList.appendChild(emptyEl);
    return;
  }

  userPresets.forEach((preset) => {
    const li = document.createElement('li');
    li.className = 'preset-item';

    const topRow = document.createElement('div');
    topRow.className = 'preset-item-top';

    if (editingPresetId === preset.id) {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'rename-input';
      input.value = preset.name;
      input.maxLength = 28;

      const saveRenameBtn = document.createElement('button');
      saveRenameBtn.className = 'flat-btn primary-btn';
      saveRenameBtn.textContent = 'ОК';
      saveRenameBtn.addEventListener('click', async () => {
        const trimmed = input.value.trim();
        if (trimmed) {
          await renameUserPreset(preset.id, trimmed);
        }
        editingPresetId = null;
        await loadAndRenderUserPresets();
      });

      topRow.appendChild(input);
      topRow.appendChild(saveRenameBtn);
    } else {
      const titleBtn = document.createElement('button');
      titleBtn.className = 'preset-title-btn';
      titleBtn.textContent = preset.name;
      titleBtn.title = 'Нажмите, чтобы применить этот пресет';
      titleBtn.addEventListener('click', () => {
        applyUserPreset(preset);
      });

      const actions = document.createElement('div');
      actions.className = 'preset-item-actions';

      const renameBtn = document.createElement('button');
      renameBtn.className = 'flat-btn';
      renameBtn.textContent = 'Имя';
      renameBtn.title = 'Переименовать пресет';
      renameBtn.addEventListener('click', () => {
        editingPresetId = preset.id;
        loadAndRenderUserPresets();
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'flat-btn';
      deleteBtn.textContent = 'Удалить';
      deleteBtn.addEventListener('click', async () => {
        await deleteUserPreset(preset.id);
      });

      actions.appendChild(renameBtn);
      actions.appendChild(deleteBtn);
      topRow.appendChild(titleBtn);
      topRow.appendChild(actions);
    }

    const meta = document.createElement('div');
    meta.className = 'preset-meta';
    const gainPct = Math.round((preset.gain ?? 1) * 100);
    const limText = preset.limiter ? 'Limiter ON' : 'Limiter OFF';
    meta.textContent = `Gain: ${gainPct}% | ${limText} | EQ: [${preset.bands.join(', ')}] dB`;

    li.appendChild(topRow);
    li.appendChild(meta);
    dom.userPresetsList.appendChild(li);
  });
}

/**
 * Сохраняет текущую комбинацию Gain + Limiter + 10 полос EQ в chrome.storage.sync.
 * @param {string} name
 */
async function saveCurrentAsUserPreset(name) {
  const { userPresets = [] } = await chrome.storage.sync.get({ userPresets: [] });
  const newPreset = {
    id: `preset_${Date.now()}`,
    name,
    gain: state.gain,
    limiter: state.limiter,
    bands: [...state.bands]
  };

  userPresets.unshift(newPreset);
  await chrome.storage.sync.set({ userPresets });
  await loadAndRenderUserPresets();
}

/**
 * Переименовывает пользовательский пресет в chrome.storage.sync.
 * @param {string} id
 * @param {string} newName
 */
async function renameUserPreset(id, newName) {
  const { userPresets = [] } = await chrome.storage.sync.get({ userPresets: [] });
  const updated = userPresets.map((p) => (p.id === id ? { ...p, name: newName } : p));
  await chrome.storage.sync.set({ userPresets: updated });
}

/**
 * Удаляет пользовательский пресет из chrome.storage.sync.
 * @param {string} id
 */
async function deleteUserPreset(id) {
  const { userPresets = [] } = await chrome.storage.sync.get({ userPresets: [] });
  const filtered = userPresets.filter((p) => p.id !== id);
  await chrome.storage.sync.set({ userPresets: filtered });
  await loadAndRenderUserPresets();
}

/**
 * Применяет выбранный пользовательский пресет к текущей вкладке.
 * @param {Object} preset
 */
function applyUserPreset(preset) {
  state.gain = Number(preset.gain ?? 1.0);
  state.limiter = Boolean(preset.limiter ?? true);
  state.bands = Array.isArray(preset.bands) && preset.bands.length === 10
    ? [...preset.bands]
    : [...BUILTIN_PRESETS.flat];
  state.presetName = 'custom';

  renderStateToUi();
  syncAudioSettings();
  toggleDrawer(false);
}

/**
 * Открывает или закрывает боковую панель (side drawer) пресетов.
 * @param {boolean} open
 */
function toggleDrawer(open) {
  dom.presetsDrawer.classList.toggle('open', open);
  dom.presetsDrawer.setAttribute('aria-hidden', String(!open));
  dom.drawerBackdrop.hidden = !open;
}

/**
 * Отображает сообщение об ошибке в верхней части Popup.
 * @param {string} msg
 */
function showError(msg) {
  dom.errorBanner.textContent = msg;
  dom.errorBanner.hidden = false;
}

/**
 * Скрывает баннер ошибки.
 */
function hideError() {
  dom.errorBanner.hidden = true;
}

/**
 * Инициализирует тему оформления (Dark по умолчанию, Light опционально).
 */
async function initTheme() {
  const { theme = 'dark' } = await chrome.storage.sync.get({ theme: 'dark' });
  document.documentElement.setAttribute('data-theme', theme);

  dom.themeToggleBtn.addEventListener('click', async () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    await chrome.storage.sync.set({ theme: next });
  });
}

/**
 * Привязывает обработчики событий ко всем элементам управления.
 */
function bindEvents() {
  // Ползунок громкости
  dom.gainSlider.addEventListener('input', (e) => {
    const percent = clamp(Number(e.target.value), 0, 1000);
    state.gain = percent / 100;
    renderStateToUi();
    syncAudioSettings();
  });

  // Числовой ввод громкости
  dom.gainNumberInput.addEventListener('change', (e) => {
    const percent = clamp(Number(e.target.value) || 0, 0, 1000);
    state.gain = percent / 100;
    renderStateToUi();
    syncAudioSettings();
  });

  // Быстрые кнопки громкости (100%, 200%, 300%, 500%, 1000%)
  dom.tickButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const percent = Number(btn.dataset.gain);
      state.gain = percent / 100;
      renderStateToUi();
      syncAudioSettings();
    });
  });

  // Лимитер
  dom.limiterCheckbox.addEventListener('change', (e) => {
    state.limiter = e.target.checked;
    renderStateToUi();
    syncAudioSettings();
  });

  // Выбор встроенного пресета EQ
  dom.builtinPresetSelect.addEventListener('change', (e) => {
    const key = e.target.value;
    if (BUILTIN_PRESETS[key]) {
      state.bands = [...BUILTIN_PRESETS[key]];
      state.presetName = key;
      renderStateToUi();
      syncAudioSettings();
    }
  });

  // Кнопка сброса эквалайзера в 0 dB
  dom.resetEqBtn.addEventListener('click', () => {
    state.bands = [...BUILTIN_PRESETS.flat];
    state.presetName = 'flat';
    renderStateToUi();
    syncAudioSettings();
  });

  // Отключение захвата вкладки (возврат штатного звука браузера)
  dom.releaseBtn.addEventListener('click', async () => {
    if (state.tabId === null) return;
    await chrome.runtime.sendMessage({
      target: 'service-worker',
      type: 'RELEASE_TAB_CAPTURE',
      tabId: state.tabId
    });
    state.captured = false;
    state.gain = 1.0;
    state.bands = [...BUILTIN_PRESETS.flat];
    state.presetName = 'flat';
    latestFftBins.fill(0);
    renderStateToUi();
  });

  // Открытие / закрытие Side Drawer
  dom.openDrawerBtn.addEventListener('click', () => toggleDrawer(true));
  dom.closeDrawerBtn.addEventListener('click', () => toggleDrawer(false));
  dom.drawerBackdrop.addEventListener('click', () => toggleDrawer(false));

  // Сохранение пользовательского пресета
  dom.savePresetForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = dom.newPresetNameInput.value.trim();
    if (!name) return;
    dom.newPresetNameInput.value = '';
    await saveCurrentAsUserPreset(name);
  });
}

function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
}

/**
 * Точка входа при открытии Popup.
 */
async function initPopup() {
  buildEqSliders();
  await initTheme();
  bindEvents();
  setupCanvasInteractions();
  startCanvasLoop();
  await loadAndRenderUserPresets();

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab || typeof activeTab.id !== 'number') {
    showError('Не удалось определить активную вкладку.');
    return;
  }

  state.tabId = activeTab.id;
  state.tabUrl = activeTab.url || '';

  const initRes = await chrome.runtime.sendMessage({
    target: 'service-worker',
    type: 'POPUP_INIT',
    tabId: state.tabId,
    tabUrl: state.tabUrl
  });

  if (!initRes?.ok) {
    showError(initRes?.error || 'Захват звука недоступен на этой странице.');
    return;
  }

  if (initRes.state) {
    state.gain = initRes.state.gain ?? 1.0;
    state.limiter = initRes.state.limiter ?? true;
    state.bands = Array.isArray(initRes.state.bands) ? [...initRes.state.bands] : [...BUILTIN_PRESETS.flat];
    state.presetName = initRes.state.presetName || 'flat';
  }
  state.captured = Boolean(initRes.captured);

  renderStateToUi();
  if (state.captured) {
    ensureVisualizerConnection();
  }
}

document.addEventListener('DOMContentLoaded', initPopup);
