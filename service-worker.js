/**
 * @fileoverview Координационный Service Worker (Manifest V3).
 * Отвечает за создание Offscreen-документа, получение streamId через tabCapture,
 * маршрутизацию команд между Popup и Offscreen и очистку ресурсов закрытых вкладок.
 */

const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
let creatingOffscreenPromise = null;

/**
 * Гарантирует существование единственного экземпляра Offscreen-документа.
 * @returns {Promise<void>}
 */
async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl]
  });

  if (existingContexts.length > 0) {
    return;
  }

  if (creatingOffscreenPromise) {
    await creatingOffscreenPromise;
    return;
  }

  creatingOffscreenPromise = chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ['USER_MEDIA'],
    justification: 'Захват и обработка аудиопотока вкладки через Web Audio API (Gain + 10-band EQ)'
  });

  try {
    await creatingOffscreenPromise;
  } finally {
    creatingOffscreenPromise = null;
  }
}

/**
 * Проверяет, допускает ли URL вкладки захват звука через tabCapture.
 * @param {string} [url]
 * @returns {boolean}
 */
function isCapturableUrl(url) {
  if (!url) return false;
  const forbiddenPrefixes = [
    'chrome://',
    'chrome-extension://',
    'edge://',
    'about:',
    'view-source:',
    'https://chrome.google.com/webstore',
    'https://chromewebstore.google.com'
  ];
  return !forbiddenPrefixes.some((prefix) => url.startsWith(prefix));
}

/**
 * Инициализирует или обновляет состояние аудио-пайплайна для указанной вкладки.
 * @param {number} tabId
 * @param {string} [tabUrl]
 * @param {Object} [initialSettings]
 * @returns {Promise<Object>}
 */
async function initOrGetTabAudio(tabId, tabUrl, initialSettings = null) {
  if (!isCapturableUrl(tabUrl)) {
    return {
      ok: false,
      error: 'Системные страницы браузера и магазин расширений защищены от перехвата звука (ограничение безопасности Chrome).'
    };
  }

  await ensureOffscreenDocument();

  // Проверяем, не захвачена ли уже эта вкладка в offscreen
  const statusResponse = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'GET_TAB_STATE',
    tabId
  });

  if (statusResponse && statusResponse.captured) {
    if (initialSettings) {
      return await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'UPDATE_TAB_STATE',
        tabId,
        settings: initialSettings
      });
    }
    return { ok: true, state: statusResponse.state, captured: true };
  }

  // Если настройки не переданы, возвращаем дефолтное неактивное состояние без принудительного захвата,
  // либо захватываем сразу при запросе активации
  if (!initialSettings) {
    return {
      ok: true,
      captured: false,
      state: {
        gain: 1.0,
        limiter: true,
        bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        presetName: 'flat'
      }
    };
  }

  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tabId
    });

    const startResponse = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'START_CAPTURE',
      tabId,
      streamId,
      settings: initialSettings
    });

    if (startResponse?.ok) {
      await updateActionBadge(tabId, initialSettings.gain);
    }

    return startResponse;
  } catch (err) {
    return {
      ok: false,
      error: `Не удалось перехватить аудиопоток вкладки: ${err.message || 'Неизвестная ошибка tabCapture'}`
    };
  }
}

/**
 * Обновляет текстовый бейдж на иконке расширения с текущим процентом громкости.
 * @param {number} tabId
 * @param {number} gainValue
 */
async function updateActionBadge(tabId, gainValue) {
  try {
    const percent = Math.round(gainValue * 100);
    const text = percent === 100 ? 'EQ' : `${percent}%`;
    const color = percent > 300 ? '#e05252' : '#4a9eff';
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
  } catch (_) {
    // Вкладка могла быть закрыта в момент обновления бейджа
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== 'service-worker') {
    return false;
  }

  (async () => {
    try {
      switch (message.type) {
        case 'POPUP_INIT': {
          const result = await initOrGetTabAudio(message.tabId, message.tabUrl, null);
          sendResponse(result);
          break;
        }

        case 'APPLY_AUDIO_SETTINGS': {
          const result = await initOrGetTabAudio(
            message.tabId,
            message.tabUrl,
            message.settings
          );
          if (result?.ok) {
            await updateActionBadge(message.tabId, message.settings.gain);
          }
          sendResponse(result);
          break;
        }

        case 'RELEASE_TAB_CAPTURE': {
          await ensureOffscreenDocument();
          const res = await chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'STOP_CAPTURE',
            tabId: message.tabId
          });
          await chrome.action.setBadgeText({ tabId: message.tabId, text: '' });
          sendResponse(res);
          break;
        }

        default:
          sendResponse({ ok: false, error: 'Неизвестная команда Service Worker' });
      }
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
  })();

  return true;
});

// Автоматическая очистка аудио-контекста при закрытии вкладки
chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl]
    });
    if (existingContexts.length > 0) {
      await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'STOP_CAPTURE',
        tabId
      });
    }
  } catch (_) {
    // Игнорируем, если offscreen ещё не создан
  }
});