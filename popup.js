/**
 * @fileoverview Контроллер интерфейса Popup.
 * Управляет 10-полосным эквалайзером, усилением, отрисовкой АЧХ + кривой EQ на Canvas,
 * переключением тем и синхронизацией пользовательских пресетов в chrome.storage.sync.
 */

const FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/** Встроенные пресеты эквалайзера (в дБ для 10 полос) */
const BUILTIN_PRESETS = {
  flat:       [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  bass:       [7, 6, 4.5, 2, 0, 0, 0, 0, 0, 0],
  vocal:      [-3, -2, -1, 1.5, 4, 5, 4, 2, 0, -1],
  rock:       [5, 4, 2, -1, -2, 0, 2.5, 4, 5, 5],
  electronic: [6, 5, 1.5, -2, -1, 1, 0.5, 3, 5, 6],
  podcast:    [-6, -4, -1, 2, 4.5, 5, 3.5, 1, -1, -3]
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
    slider.title = `${freq} Гц (двойной клик — сброс в 0 дБ)`;

    slider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      state.bands[idx] = val;
      state.presetName = 'custom';
      dom.builtinPresetSelect.value = 'custom';
      updateEqDomLabels();
      syncAudioSettings();
    });

    slider.addEventListener('dblclick', () => {
      state.bands[idx] = 0;
      slider.value = '0';
      state.presetName = 'custom';
      dom.builtinPresetSelect.value = 'custom';
      updateEqDomLabels();
      syncAudioSettings();
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
 */
async function syncAudioSettings() {
  if (state.tabId === null) return;

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
    return;
  }

  hideError();
  state.captured = Boolean(response.captured);
  renderStateToUi();
  ensureVisualizerConnection();
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

/**
 * Запускает цикл отрисовки Canvas:
 * 1) Столбики спектра в реальном времени (AnalyserNode FFT)
 * 2) Результирующая кривая эквалайзера (АЧХ фильтров)
 */
function startCanvasLoop() {
  const canvas = dom.spectrumCanvas;
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;

  const render = () => {
    const style = getComputedStyle(document.documentElement);
    const bgControl = style.getPropertyValue('--bg-control').trim() || '#181818';
    const gridColor = style.getPropertyValue('--canvas-grid').trim() || '#2f2f2f';
    const accentColor = style.getPropertyValue('--accent').trim() || '#4a9eff';

    ctx.fillStyle = bgControl;
    ctx.fillRect(0, 0, width, height);

    // Сетка: линия 0 dB по центру и четверти
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const midY = Math.floor(height / 2) + 0.5;
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

    // 2. Отрисовка кривой 10-полосного эквалайзера
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 2;
    ctx.beginPath();

    const stepX = width / (FREQUENCIES.length - 1);
    state.bands.forEach((db, idx) => {
      const x = idx * stepX;
      // Картируем [-12..+12] дБ в координаты Y [height-8 .. 8]
      const normalized = (db + 12) / 24;
      const y = height - 8 - normalized * (height - 16);
      if (idx === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();

    // Узловые точки полос на кривой
    ctx.fillStyle = accentColor;
    state.bands.forEach((db, idx) => {
      const x = idx * stepX;
      const normalized = (db + 12) / 24;
      const y = height - 8 - normalized * (height - 16);
      ctx.fillRect(x - 2.5, y - 2.5, 5, 5);
    });

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