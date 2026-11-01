/**
 * @fileoverview Фоновый звуковой движок (Offscreen Document).
 * Поддерживает независимые цепочки Web Audio API для каждой захваченной вкладки
 * и транслирует данные спектра (AnalyserNode) в Popup по запросу через Port.
 */

export const EQ_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const FILTER_Q = 1.414; // ~1 октава
const SMOOTH_TIME_CONSTANT = 0.015; // 15 мс сглаживание для предотвращения треска (zipper noise)

/**
 * @typedef {Object} TabAudioPipeline
 * @property {AudioContext} audioCtx
 * @property {MediaStream} mediaStream
 * @property {MediaStreamAudioSourceNode} sourceNode
 * @property {GainNode} gainNode
 * @property {BiquadFilterNode[]} filters
 * @property {DynamicsCompressorNode} limiterNode
 * @property {AnalyserNode} analyserNode
 * @property {boolean} limiterActive
 * @property {Object} state
 */

/** @type {Map<number, TabAudioPipeline>} */
const pipelines = new Map();

/**
 * Создаёт и настраивает полный граф Web Audio API для вкладки.
 * @param {number} tabId
 * @param {string} streamId
 * @param {Object} settings
 * @returns {Promise<Object>}
 */
async function createTabPipeline(tabId, streamId, settings) {
  if (pipelines.has(tabId)) {
    await destroyTabPipeline(tabId);
  }

  const mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  const audioCtx = new AudioContext({ latencyHint: 'interactive' });
  const sourceNode = audioCtx.createMediaStreamSource(mediaStream);
  const gainNode = audioCtx.createGain();

  // Создаём 10 полос эквалайзера (peaking)
  const filters = EQ_FREQUENCIES.map((freq, idx) => {
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'peaking';
    filter.frequency.value = freq;
    filter.Q.value = FILTER_Q;
    filter.gain.value = Number(settings.bands?.[idx] ?? 0);
    return filter;
  });

  // Настраиваем DynamicsCompressorNode в режиме защитного Brickwall-лимитера
  const limiterNode = audioCtx.createDynamicsCompressor();
  limiterNode.threshold.value = -1.0; // Срабатывание около -1 dBFS
  limiterNode.knee.value = 0.0;       // Жёсткое колено
  limiterNode.ratio.value = 20.0;     // Высокая степень сжатия пиков
  limiterNode.attack.value = 0.001;   // Мгновенная атака 1 мс
  limiterNode.release.value = 0.06;   // Быстрое восстановление 60 мс

  // Узел анализатора для визуализации АЧХ в реальном времени
  const analyserNode = audioCtx.createAnalyser();
  analyserNode.fftSize = 256;
  analyserNode.smoothingTimeConstant = 0.78;

  gainNode.gain.value = clamp(Number(settings.gain ?? 1.0), 0, 10);

  const state = {
    gain: gainNode.gain.value,
    limiter: Boolean(settings.limiter ?? true),
    bands: filters.map((f) => f.gain.value),
    presetName: settings.presetName || 'custom'
  };

  const pipeline = {
    audioCtx,
    mediaStream,
    sourceNode,
    gainNode,
    filters,
    limiterNode,
    analyserNode,
    limiterActive: state.limiter,
    state
  };

  // Собираем последовательную цепочку: Source -> Gain -> Filter[0..9]
  sourceNode.connect(gainNode);
  let prevNode = gainNode;
  for (const filter of filters) {
    prevNode.connect(filter);
    prevNode = filter;
  }

  // Подключаем выход последнего фильтра через лимитер (или напрямую) к Analyser -> Destination
  wireTailNodes(pipeline, state.limiter);
  analyserNode.connect(audioCtx.destination);

  // Если поток неожиданно завершился (например, вкладка перезагрузилась или закрылась)
  const [audioTrack] = mediaStream.getAudioTracks();
  if (audioTrack) {
    audioTrack.addEventListener('ended', () => {
      destroyTabPipeline(tabId);
    });
  }

  pipelines.set(tabId, pipeline);
  return state;
}

/**
 * Переключает маршрутизацию хвоста аудио-графа (с лимитером или в обход).
 * @param {TabAudioPipeline} pipeline
 * @param {boolean} enableLimiter
 */
function wireTailNodes(pipeline, enableLimiter) {
  const lastFilter = pipeline.filters[pipeline.filters.length - 1];
  try {
    lastFilter.disconnect();
    pipeline.limiterNode.disconnect();
  } catch (_) {
    // Игнорируем ошибку, если узлы ещё не были соединены
  }

  if (enableLimiter) {
    lastFilter.connect(pipeline.limiterNode);
    pipeline.limiterNode.connect(pipeline.analyserNode);
  } else {
    lastFilter.connect(pipeline.analyserNode);
  }
  pipeline.limiterActive = enableLimiter;
}

/**
 * Плавно обновляет параметры существующего аудио-пайплайна без пересоздания потока.
 * @param {number} tabId
 * @param {Object} settings
 * @returns {Object|null}
 */
function updateTabPipeline(tabId, settings) {
  const pipeline = pipelines.get(tabId);
  if (!pipeline) return null;

  const { audioCtx, gainNode, filters, state } = pipeline;
  const now = audioCtx.currentTime;

  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }

  if (typeof settings.gain === 'number') {
    const targetGain = clamp(settings.gain, 0, 10);
    gainNode.gain.setTargetAtTime(targetGain, now, SMOOTH_TIME_CONSTANT);
    state.gain = targetGain;
  }

  if (Array.isArray(settings.bands) && settings.bands.length === EQ_FREQUENCIES.length) {
    settings.bands.forEach((db, idx) => {
      const clampedDb = clamp(Number(db), -12, 12);
      filters[idx].gain.setTargetAtTime(clampedDb, now, SMOOTH_TIME_CONSTANT);
      state.bands[idx] = clampedDb;
    });
  }

  if (typeof settings.limiter === 'boolean' && settings.limiter !== pipeline.limiterActive) {
    wireTailNodes(pipeline, settings.limiter);
    state.limiter = settings.limiter;
  }

  if (typeof settings.presetName === 'string') {
    state.presetName = settings.presetName;
  }

  return state;
}

/**
 * Останавливает захват звука вкладки и освобождает ресурсы AudioContext.
 * @param {number} tabId
 */
async function destroyTabPipeline(tabId) {
  const pipeline = pipelines.get(tabId);
  if (!pipeline) return;

  pipelines.delete(tabId);

  try {
    pipeline.mediaStream.getTracks().forEach((track) => track.stop());
  } catch (_) {}

  try {
    await pipeline.audioCtx.close();
  } catch (_) {}
}

/**
 * Ограничивает число заданным диапазоном.
 * @param {number} val
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
}

// Обработчик команд от Service Worker
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== 'offscreen') {
    return false;
  }

  (async () => {
    try {
      switch (message.type) {
        case 'GET_TAB_STATE': {
          const pipeline = pipelines.get(message.tabId);
          sendResponse({
            ok: true,
            captured: Boolean(pipeline),
            state: pipeline ? pipeline.state : null
          });
          break;
        }

        case 'START_CAPTURE': {
          const state = await createTabPipeline(
            message.tabId,
            message.streamId,
            message.settings
          );
          sendResponse({ ok: true, captured: true, state });
          break;
        }

        case 'UPDATE_TAB_STATE': {
          const state = updateTabPipeline(message.tabId, message.settings);
          sendResponse({ ok: Boolean(state), captured: Boolean(state), state });
          break;
        }

        case 'STOP_CAPTURE': {
          await destroyTabPipeline(message.tabId);
          sendResponse({ ok: true, captured: false });
          break;
        }

        default:
          sendResponse({ ok: false, error: 'Неизвестный тип сообщения в Offscreen' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true;
});

// Порт реального времени для передачи спектра АЧХ в открытый Popup
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'visualizer-port') return;

  let activeTabId = null;
  let timerId = null;
  const freqBuffer = new Uint8Array(128);

  const startStreaming = () => {
    if (timerId) clearInterval(timerId);
    timerId = setInterval(() => {
      if (activeTabId === null) return;
      const pipeline = pipelines.get(activeTabId);
      if (!pipeline) return;

      pipeline.analyserNode.getByteFrequencyData(freqBuffer);
      // Проверяем, есть ли ненулевой сигнал, чтобы не гонять пустые массивы
      try {
        port.postMessage({
          type: 'FFT_DATA',
          bins: Array.from(freqBuffer.subarray(0, 64))
        });
      } catch (_) {
        clearInterval(timerId);
      }
    }, 33); // ~30 FPS достаточно для плавной отрисовки и экономит IPC-канал
  };

  port.onMessage.addListener((msg) => {
    if (msg.type === 'SUBSCRIBE_TAB' && typeof msg.tabId === 'number') {
      activeTabId = msg.tabId;
      startStreaming();
    }
  });

  port.onDisconnect.addListener(() => {
    if (timerId) {
      clearInterval(timerId);
      timerId = null;
    }
  });
});