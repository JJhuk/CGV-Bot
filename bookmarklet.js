/**
 * CGV 자동 예매 북마클릿
 *
 * 원작자: 김병용 (MIT License)
 * 2026년 CGV 웹 앱 대응 구현도 같은 MIT License를 따른다.
 *
 * 현재 CGV 웹 앱의 공개 DOM 상태만 사용한다. React 내부 객체나 비공개 API를
 * 직접 호출하지 않으므로 번들 해시가 바뀌어도 semantic attribute가 유지되면
 * 동작한다.
 */
(function initializeCgvBot(root, factory) {
  var api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }

  api.run(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function createCgvBotApi() {
  'use strict';

  var BOT_KEY = '__CGV_BOT_V2__';
  var MAP_SELECTOR = 'section[aria-label="좌석선택 지도"]';
  var SEAT_SELECTOR = 'button[data-seatlocno]';
  var REFRESH_SELECTOR = 'button[title="새로고침"]';
  var PANEL_ID = 'cgv-bot-panel';
  var STYLE_ID = 'cgv-bot-style';
  var POLL_INTERVAL_MS = 5000;
  var REFRESH_SETTLE_MS = 1200;

  function normalizeSeatLabel(value) {
    return String(value || '')
      .replace(/\s+/g, '')
      .replace(/^연접좌석/, '');
  }

  function parseSeatLabel(value) {
    var label = normalizeSeatLabel(value);
    var match = /^(.*?)(\d+)$/.exec(label);

    if (!match || !match[1]) {
      return { label: label, row: '', number: NaN };
    }

    return {
      label: label,
      row: match[1],
      number: Number(match[2])
    };
  }

  function seatTypeFromClassName(className) {
    var value = String(className || '');
    var types = value.split(/\s+/).map(function extractSeatType(token) {
      var match = /(?:^|_)seat([A-Z][A-Za-z0-9]*)__/.exec(token);
      return match ? match[1].toLowerCase() : '';
    }).filter(function excludeStateClass(type) {
      return type && !['number', 'disabled', 'complete'].includes(type);
    });

    return types.find(function preferSpecificType(type) {
      return type !== 'normal';
    }) || types[0] || 'unknown';
  }

  function seatClassIsUnavailable(button) {
    return /seat(?:Disabled|Complete)/i.test(String(button.className || ''));
  }

  function isSeatUnavailable(button) {
    return Boolean(button.disabled || seatClassIsUnavailable(button));
  }

  function isSeatSelected(button) {
    return (
      button.getAttribute('title') === '선택됨' ||
      /seatMap_active/i.test(String(button.className || ''))
    );
  }

  function finiteNumber(value, fallback) {
    var number = Number.parseFloat(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function seatFromButton(button) {
    var parsed = parseSeatLabel(button.textContent);

    return {
      locNo: String(button.getAttribute('data-seatlocno') || ''),
      label: parsed.label,
      row: parsed.row,
      number: parsed.number,
      left: finiteNumber(button.style.left, finiteNumber(button.offsetLeft, NaN)),
      top: finiteNumber(button.style.top, finiteNumber(button.offsetTop, NaN)),
      width: finiteNumber(button.style.width, finiteNumber(button.offsetWidth, NaN)),
      type: seatTypeFromClassName(button.className),
      disabled: isSeatUnavailable(button),
      selected: isSeatSelected(button),
      element: button
    };
  }

  function areAdjacent(leftSeat, rightSeat) {
    if (!leftSeat || !rightSeat) {
      return false;
    }
    if (!leftSeat.row || leftSeat.row !== rightSeat.row) {
      return false;
    }
    if (!Number.isFinite(leftSeat.number) || rightSeat.number !== leftSeat.number + 1) {
      return false;
    }
    if (leftSeat.type !== rightSeat.type) {
      return false;
    }

    if (Number.isFinite(leftSeat.top) && Number.isFinite(rightSeat.top)) {
      if (Math.abs(leftSeat.top - rightSeat.top) > 2) {
        return false;
      }
    }

    if (
      Number.isFinite(leftSeat.left) &&
      Number.isFinite(rightSeat.left) &&
      Number.isFinite(leftSeat.width)
    ) {
      var tolerance = Math.max(3, leftSeat.width * 0.25);
      if (Math.abs(rightSeat.left - (leftSeat.left + leftSeat.width)) > tolerance) {
        return false;
      }
    }

    return true;
  }

  function compareSeatPosition(leftSeat, rightSeat) {
    if (Number.isFinite(leftSeat.top) && Number.isFinite(rightSeat.top)) {
      if (leftSeat.top !== rightSeat.top) {
        return leftSeat.top - rightSeat.top;
      }
    }
    if (leftSeat.row !== rightSeat.row) {
      return leftSeat.row < rightSeat.row ? -1 : 1;
    }
    if (Number.isFinite(leftSeat.left) && Number.isFinite(rightSeat.left)) {
      return leftSeat.left - rightSeat.left;
    }
    return leftSeat.number - rightSeat.number;
  }

  function preferenceLocNo(preference) {
    return typeof preference === 'string' ? preference : preference.locNo;
  }

  function preferencePriority(preference, index) {
    var priority = typeof preference === 'string' ? NaN : Number(preference.priority);
    return Number.isFinite(priority) ? priority : index + 1;
  }

  function chooseBestGroup(preferences, seats, targetCount) {
    var count = Number(targetCount);
    if (!Number.isInteger(count) || count < 1) {
      return [];
    }

    var priorityByLocNo = new Map();
    preferences.forEach(function addPreference(preference, index) {
      var locNo = String(preferenceLocNo(preference) || '');
      if (locNo && !priorityByLocNo.has(locNo)) {
        priorityByLocNo.set(locNo, preferencePriority(preference, index));
      }
    });

    var candidates = seats
      .filter(function isAvailablePreference(seat) {
        return !seat.disabled && priorityByLocNo.has(String(seat.locNo));
      })
      .slice()
      .sort(compareSeatPosition);

    var groups = [];
    for (var start = 0; start + count <= candidates.length; start += 1) {
      var group = candidates.slice(start, start + count);
      var contiguous = true;

      for (var index = 1; index < group.length; index += 1) {
        if (!areAdjacent(group[index - 1], group[index])) {
          contiguous = false;
          break;
        }
      }

      if (!contiguous) {
        continue;
      }

      var priorities = group.map(function getPriority(seat) {
        return priorityByLocNo.get(String(seat.locNo));
      });

      groups.push({
        seats: group,
        score: priorities.reduce(function sum(total, priority) {
          return total + priority;
        }, 0),
        maxPriority: Math.max.apply(Math, priorities),
        priorities: priorities.slice().sort(function sortNumbers(a, b) {
          return a - b;
        })
      });
    }

    groups.sort(function compareGroups(leftGroup, rightGroup) {
      if (leftGroup.score !== rightGroup.score) {
        return leftGroup.score - rightGroup.score;
      }
      if (leftGroup.maxPriority !== rightGroup.maxPriority) {
        return leftGroup.maxPriority - rightGroup.maxPriority;
      }
      for (var index = 0; index < leftGroup.priorities.length; index += 1) {
        if (leftGroup.priorities[index] !== rightGroup.priorities[index]) {
          return leftGroup.priorities[index] - rightGroup.priorities[index];
        }
      }
      return compareSeatPosition(leftGroup.seats[0], rightGroup.seats[0]);
    });

    return groups.length ? groups[0].seats : [];
  }

  function sameSeatSet(leftSeats, rightSeats) {
    if (leftSeats.length !== rightSeats.length) {
      return false;
    }

    var rightLocNos = new Set(rightSeats.map(function toLocNo(seat) {
      return String(seat.locNo);
    }));

    return leftSeats.every(function containsSeat(seat) {
      return rightLocNos.has(String(seat.locNo));
    });
  }

  function isVisible(root, element) {
    if (!element || !element.isConnected) {
      return false;
    }

    var style = root.getComputedStyle ? root.getComputedStyle(element) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden')) {
      return false;
    }
    return !element.getClientRects || element.getClientRects().length > 0;
  }

  function findSeatMap(document) {
    var maps = Array.from(document.querySelectorAll(MAP_SELECTOR));
    return maps.find(function mapInsideVisibleDialog(map) {
      var dialog = map.closest('[role="dialog"]');
      return dialog && (!dialog.getClientRects || dialog.getClientRects().length > 0);
    }) || maps[0] || null;
  }

  function findMainSeatButtons(document) {
    var map = findSeatMap(document);
    if (!map) {
      return [];
    }

    return Array.from(map.querySelectorAll(SEAT_SELECTOR)).filter(function excludeMiniMap(button) {
      return !button.closest('.rzpp-mini-map');
    });
  }

  function listSeats(document) {
    return findMainSeatButtons(document).map(seatFromButton);
  }

  function normalizedText(element) {
    return String(element && element.textContent || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function readBookingFingerprint(document) {
    var refreshButton = document.querySelector(REFRESH_SELECTOR);
    var region = refreshButton && refreshButton.closest('[role="region"]');
    var context = region || document;
    var heading = Array.from(context.querySelectorAll('h2')).find(function movieHeading(element) {
      var text = normalizedText(element);
      return text && text !== '관람인원' && text !== '범례보기' && text !== '꼭 확인해 주세요';
    });
    var paragraphs = Array.from(context.querySelectorAll('p'))
      .slice(0, 2)
      .map(normalizedText);
    var selectedSchedule = document.querySelector(
      'button[aria-pressed="true"][aria-label^="상영 시간 "]'
    );
    var schedule = String(selectedSchedule && selectedSchedule.getAttribute('aria-label') || '')
      .replace(/,\s*[\d,]+석\s*남음.*$/, '')
      .trim();

    return JSON.stringify([
      normalizedText(heading),
      paragraphs[0] || '',
      paragraphs[1] || '',
      schedule
    ]);
  }

  function findButtonByText(root, document, text, options) {
    var exact = !options || options.exact !== false;
    var buttons = Array.from(document.querySelectorAll('button'));
    var matching = buttons.filter(function matches(button) {
      var value = normalizedText(button);
      return exact ? value === text : value.indexOf(text) !== -1;
    });

    return matching.find(function visibleButton(button) {
      return isVisible(root, button);
    }) || matching[0] || null;
  }

  function readTargetCount(document) {
    var totalsByCategory = new Map();

    Array.from(document.querySelectorAll('[role="group"]')).forEach(function readGroup(group, index) {
      var pressed = group.querySelector('button[aria-pressed="true"][aria-label$=" 선택"]');
      if (!pressed) {
        return;
      }

      var value = Number(normalizedText(pressed));
      if (!Number.isFinite(value) || value < 1) {
        return;
      }

      var labelNode = group.querySelector('[id="number-choice-label"]');
      var category = normalizedText(labelNode)
        .replace(/내용 확인하기/g, '')
        .trim() || 'group-' + index;
      var previous = totalsByCategory.get(category) || 0;
      totalsByCategory.set(category, Math.max(previous, value));
    });

    var total = Array.from(totalsByCategory.values()).reduce(function sum(result, value) {
      return result + value;
    }, 0);

    if (total > 0) {
      return total;
    }

    var countButton = Array.from(document.querySelectorAll('button')).find(function findCount(button) {
      return /인원선택\s*\(\d+\)/.test(normalizedText(button));
    });
    var match = countButton && /인원선택\s*\((\d+)\)/.exec(normalizedText(countButton));
    return match ? Number(match[1]) : 0;
  }

  function createElement(document, tagName, className, text) {
    var element = document.createElement(tagName);
    if (className) {
      element.className = className;
    }
    if (typeof text === 'string') {
      element.textContent = text;
    }
    return element;
  }

  function injectStyle(document) {
    var oldStyle = document.getElementById(STYLE_ID);
    if (oldStyle) {
      oldStyle.remove();
    }

    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '#' + PANEL_ID + '{position:fixed;top:12px;left:50%;z-index:2147483647;width:min(520px,calc(100vw - 24px));transform:translateX(-50%);box-sizing:border-box;padding:14px 16px;border-radius:12px;background:rgba(20,20,24,.96);color:#fff;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35)}',
      '#' + PANEL_ID + ' strong{font-size:16px}',
      '#' + PANEL_ID + ' .cgv-bot-status{margin-top:6px;color:#fff}',
      '#' + PANEL_ID + ' .cgv-bot-list{margin-top:4px;color:#bfc7ff;word-break:break-all}',
      '#' + PANEL_ID + ' .cgv-bot-options{display:flex;align-items:center;gap:8px;margin-top:8px;color:#ddd}',
      '#' + PANEL_ID + ' .cgv-bot-actions{display:flex;gap:8px;margin-top:10px}',
      '#' + PANEL_ID + ' button{min-height:36px;padding:0 12px;border:0;border-radius:8px;cursor:pointer;font-weight:700}',
      '#' + PANEL_ID + ' button:disabled{cursor:not-allowed;opacity:.45}',
      '#' + PANEL_ID + ' .cgv-bot-primary{background:#ff4d5a;color:#fff}',
      '#' + PANEL_ID + ' .cgv-bot-secondary{background:#444;color:#fff}',
      'button[data-cgv-bot-priority]{outline:3px solid #5965ff!important;outline-offset:-3px;z-index:10!important}',
      'button[data-cgv-bot-priority]::after{content:attr(data-cgv-bot-priority);position:absolute;right:-5px;top:-7px;display:grid;place-items:center;min-width:18px;height:18px;padding:0 3px;border-radius:999px;background:#3640dc;color:#fff;font:700 11px/1 sans-serif;box-sizing:border-box}',
      'button[data-cgv-bot-was-disabled="true"]{filter:saturate(.45)}'
    ].join('');
    document.head.appendChild(style);
    return style;
  }

  function createController(root, document, targetCount, initialDialog, initialFingerprint) {
    var preferences = [];
    var mode = 'recording';
    var timer = null;
    var observer = null;
    var observerQueued = false;
    var panel = null;
    var statusElement = null;
    var listElement = null;
    var startButton = null;
    var clearButton = null;
    var cancelButton = null;
    var autoAdvanceInput = null;
    var styleElement = null;
    var audioContext = null;
    var initialPath = root.location && root.location.pathname;
    var originalDisabled = new WeakMap();
    var touchedSeats = new Set();
    var destroyed = false;
    var consecutiveErrors = 0;
    var generation = 0;
    var failedGroupKey = '';
    var failedGroupCount = 0;

    function runIsActive(token, expectedMode) {
      if (destroyed || token !== generation) {
        return false;
      }
      if (Array.isArray(expectedMode)) {
        return expectedMode.includes(mode);
      }
      return !expectedMode || mode === expectedMode;
    }

    function seatSessionIsActive(token, expectedMode) {
      if (!runIsActive(token, expectedMode)) {
        return false;
      }
      if (!routeIsStillValid()) {
        destroy();
        return false;
      }
      return true;
    }

    function setStatus(message) {
      if (statusElement) {
        statusElement.textContent = message;
      }
    }

    function preferenceIndex(locNo) {
      return preferences.findIndex(function matches(preference) {
        return preference.locNo === locNo;
      });
    }

    function syncSeatMarkers() {
      findMainSeatButtons(document).forEach(function markSeat(button) {
        var locNo = String(button.getAttribute('data-seatlocno') || '');
        var index = preferenceIndex(locNo);

        if (index === -1) {
          button.removeAttribute('data-cgv-bot-priority');
          return;
        }
        button.setAttribute('data-cgv-bot-priority', String(index + 1));
      });
    }

    function prepareRecordingSeats() {
      if (mode !== 'recording') {
        syncSeatMarkers();
        return;
      }

      findMainSeatButtons(document).forEach(function enablePreferenceClick(button) {
        if (!originalDisabled.has(button)) {
          originalDisabled.set(button, button.disabled);
          touchedSeats.add(button);
        }
        if (originalDisabled.get(button)) {
          button.setAttribute('data-cgv-bot-was-disabled', 'true');
        }
        button.disabled = false;
      });
      syncSeatMarkers();
    }

    function restoreSeatDisabledState() {
      touchedSeats.forEach(function restore(button) {
        if (button.isConnected) {
          button.disabled = seatClassIsUnavailable(button);
        }
        button.removeAttribute('data-cgv-bot-was-disabled');
      });
      touchedSeats.clear();
      originalDisabled = new WeakMap();
    }

    function updatePanel() {
      if (!panel) {
        return;
      }

      if (mode === 'recording') {
        setStatus('원하는 좌석을 선호 순서대로 클릭하세요. 매진 좌석도 선택할 수 있습니다.');
      }
      listElement.textContent = preferences.length
        ? '선호: ' + preferences.map(function seatLabel(preference) {
          return preference.label;
        }).join(' → ')
        : '선호 좌석이 아직 없습니다.';
      startButton.disabled = mode === 'recording' && preferences.length < targetCount;
    }

    function togglePreference(button) {
      var locNo = String(button.getAttribute('data-seatlocno') || '');
      if (!locNo) {
        return;
      }

      var index = preferenceIndex(locNo);
      if (index === -1) {
        preferences.push({
          locNo: locNo,
          label: normalizeSeatLabel(button.textContent),
          priority: preferences.length + 1
        });
      } else {
        preferences.splice(index, 1);
        preferences.forEach(function resetPriority(preference, preferenceOffset) {
          preference.priority = preferenceOffset + 1;
        });
      }

      syncSeatMarkers();
      updatePanel();
    }

    function captureSeatClick(event) {
      if (mode !== 'recording') {
        return;
      }

      var target = event.target && event.target.closest
        ? event.target.closest(SEAT_SELECTOR)
        : null;
      if (!target || target.closest('.rzpp-mini-map')) {
        return;
      }
      if (!findSeatMap(document) || !findSeatMap(document).contains(target)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) {
        event.stopImmediatePropagation();
      }
      togglePreference(target);
    }

    function observeSeatChanges() {
      if (!initialDialog || !root.MutationObserver) {
        return;
      }

      observer = new root.MutationObserver(function onSeatMutation() {
        if (observerQueued) {
          return;
        }
        observerQueued = true;
        root.queueMicrotask(function refreshSeatHooks() {
          observerQueued = false;
          var latestTargetCount = readTargetCount(document);
          if (latestTargetCount > 0 && latestTargetCount !== targetCount) {
            if (mode === 'recording') {
              targetCount = latestTargetCount;
              updatePanel();
            } else if (!destroyed) {
              destroy();
              return;
            }
          }
          if (!destroyed && routeIsStillValid()) {
            prepareRecordingSeats();
          } else if (!destroyed) {
            destroy();
          }
        });
      });
      var observerRoot = initialDialog.parentElement || document.body;
      observer.observe(observerRoot, {
        childList: true,
        subtree: true,
        attributes: observerRoot === document.body,
        attributeFilter: observerRoot === document.body ? ['aria-pressed'] : undefined
      });
      if (observerRoot !== document.body) {
        observer.observe(document.body, {
          attributes: true,
          subtree: true,
          attributeFilter: ['aria-pressed']
        });
      }
    }

    function createPanel() {
      var oldPanel = document.getElementById(PANEL_ID);
      if (oldPanel) {
        oldPanel.remove();
      }

      panel = createElement(document, 'aside');
      panel.id = PANEL_ID;
      panel.setAttribute('role', 'status');
      panel.appendChild(createElement(document, 'strong', '', 'CGV Bot'));

      statusElement = createElement(document, 'div', 'cgv-bot-status');
      listElement = createElement(document, 'div', 'cgv-bot-list');
      panel.appendChild(statusElement);
      panel.appendChild(listElement);

      var options = createElement(document, 'label', 'cgv-bot-options');
      autoAdvanceInput = createElement(document, 'input');
      autoAdvanceInput.type = 'checkbox';
      autoAdvanceInput.checked = true;
      options.appendChild(autoAdvanceInput);
      options.appendChild(document.createTextNode('좌석 확보 시 결제 화면까지 자동 이동'));
      panel.appendChild(options);

      var actions = createElement(document, 'div', 'cgv-bot-actions');
      startButton = createElement(document, 'button', 'cgv-bot-primary', '감시 시작');
      startButton.type = 'button';
      clearButton = createElement(document, 'button', 'cgv-bot-secondary', '선호 초기화');
      clearButton.type = 'button';
      cancelButton = createElement(document, 'button', 'cgv-bot-secondary', '종료');
      cancelButton.type = 'button';
      actions.appendChild(startButton);
      actions.appendChild(clearButton);
      actions.appendChild(cancelButton);
      panel.appendChild(actions);

      startButton.addEventListener('click', function handleStartStop() {
        if (mode === 'recording') {
          startMonitoring();
        } else if (mode === 'polling' || mode === 'selecting') {
          returnToRecording();
        }
      });
      clearButton.addEventListener('click', function clearPreferences() {
        preferences = [];
        syncSeatMarkers();
        updatePanel();
      });
      cancelButton.addEventListener('click', function cancelBot() {
        destroy();
      });

      document.body.appendChild(panel);
      updatePanel();
    }

    function setupAudio() {
      if (audioContext) {
        return;
      }
      var AudioContext = root.AudioContext || root.webkitAudioContext;
      if (!AudioContext) {
        return;
      }
      try {
        audioContext = new AudioContext();
        if (audioContext.resume) {
          audioContext.resume().catch(function ignoreResumeFailure() {});
        }
      } catch (error) {
        audioContext = null;
      }
    }

    function beep() {
      if (root.navigator && root.navigator.vibrate) {
        root.navigator.vibrate([160, 80, 160]);
      }
      if (!audioContext) {
        return;
      }

      try {
        if (audioContext.resume) {
          audioContext.resume().catch(function ignoreResumeFailure() {});
        }
        var oscillator = audioContext.createOscillator();
        var gain = audioContext.createGain();
        oscillator.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.22, audioContext.currentTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.7);
        oscillator.connect(gain);
        gain.connect(audioContext.destination);
        oscillator.start();
        oscillator.stop(audioContext.currentTime + 0.72);
      } catch (error) {
        // 시각 알림은 계속 표시하므로 오디오 실패는 무시한다.
      }
    }

    function clearTimer() {
      if (timer !== null) {
        root.clearTimeout(timer);
        timer = null;
      }
    }

    function scheduleNextPoll(delay) {
      clearTimer();
      if (mode !== 'polling') {
        return;
      }
      timer = root.setTimeout(poll, delay);
    }

    function wait(delay) {
      return new Promise(function resolveAfter(resolve) {
        root.setTimeout(resolve, delay);
      });
    }

    function routeIsStillValid() {
      var map = findSeatMap(document);
      var dialog = map && map.closest('[role="dialog"]');
      return (
        root.location.pathname === initialPath &&
        Boolean(map) &&
        dialog === initialDialog &&
        initialDialog.isConnected &&
        readBookingFingerprint(document) === initialFingerprint &&
        isVisible(root, dialog)
      );
    }

    function currentSelectedSeats() {
      return listSeats(document).filter(function selected(seat) {
        return seat.selected;
      });
    }

    async function clearOfficialSelection(token) {
      for (var attempt = 0; attempt < targetCount + 2; attempt += 1) {
        if (!seatSessionIsActive(token, 'selecting')) {
          return false;
        }
        var selected = currentSelectedSeats();
        if (!selected.length) {
          return true;
        }
        selected[0].element.click();
        await wait(120);
        if (!seatSessionIsActive(token, 'selecting')) {
          return false;
        }
      }
      return !currentSelectedSeats().length;
    }

    async function trySelectingGroup(group, token) {
      if (!seatSessionIsActive(token, 'polling')) {
        return false;
      }
      mode = 'selecting';
      startButton.textContent = '선택 중지';
      setStatus('선호 좌석 ' + group.map(function label(seat) {
        return seat.label;
      }).join(', ') + ' 선택을 시도합니다.');

      await clearOfficialSelection(token);
      if (!seatSessionIsActive(token, 'selecting')) {
        return false;
      }
      var wanted = group.map(function wantedSeat(seat) {
        return { locNo: seat.locNo };
      });

      for (var index = 0; index < group.length; index += 1) {
        var currentSeats = listSeats(document);
        var anchor = currentSeats.find(function sameLocNo(seat) {
          return String(seat.locNo) === String(group[index].locNo);
        });
        if (!anchor || anchor.disabled) {
          break;
        }

        anchor.element.click();
        await wait(250);
        if (!seatSessionIsActive(token, 'selecting')) {
          return false;
        }
        var selected = currentSelectedSeats();
        if (sameSeatSet(selected, wanted)) {
          failedGroupKey = '';
          failedGroupCount = 0;
          await completeSelection(group, token);
          return true;
        }
        await clearOfficialSelection(token);
        if (!seatSessionIsActive(token, 'selecting')) {
          return false;
        }
      }

      if (seatSessionIsActive(token, 'selecting')) {
        var groupKey = group.map(function failedSeat(seat) {
          return seat.locNo;
        }).join('|');
        if (groupKey === failedGroupKey) {
          failedGroupCount += 1;
        } else {
          failedGroupKey = groupKey;
          failedGroupCount = 1;
        }

        if (failedGroupCount >= 3) {
          returnToRecording();
          setStatus('CGV가 프로그램 좌석 클릭을 반영하지 않아 감시를 멈췄습니다. 페이지 변경 여부를 확인해 주세요.');
          return false;
        }

        mode = 'polling';
        startButton.textContent = '감시 중지';
        setStatus('CGV의 연속 좌석 선택 결과가 달라 다시 확인합니다.');
        scheduleNextPoll(POLL_INTERVAL_MS);
      }
      return false;
    }

    async function waitForEnabledPaymentButton(timeoutMs, token) {
      var startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        if (!runIsActive(token, 'success')) {
          return null;
        }
        var button = findButtonByText(root, document, '결제하기', { exact: false });
        if (button && !button.disabled) {
          return button;
        }
        await wait(100);
      }
      return null;
    }

    async function completeSelection(group, token) {
      if (!seatSessionIsActive(token, 'selecting')) {
        return;
      }
      mode = 'success';
      clearTimer();
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      beep();
      startButton.textContent = '완료';
      startButton.disabled = true;
      setStatus('좌석 확보: ' + group.map(function label(seat) {
        return seat.label;
      }).join(', '));

      var completeButton = findButtonByText(root, document, '선택완료');
      if (!completeButton || completeButton.disabled) {
        setStatus('좌석은 선택했지만 선택완료 버튼을 찾지 못했습니다. 직접 확인해 주세요.');
        return;
      }

      completeButton.click();
      if (autoAdvanceInput.checked) {
        setStatus('좌석을 확보했습니다. 결제 화면을 여는 중입니다.');
        var paymentButton = await waitForEnabledPaymentButton(3000, token);
        if (!runIsActive(token, 'success')) {
          return;
        }
        if (paymentButton) {
          paymentButton.click();
          root.setTimeout(function destroyCompletedRun() {
            if (runIsActive(token, 'success')) {
              destroy();
            }
          }, 3000);
        } else {
          setStatus('좌석을 확보했습니다. 결제하기 버튼을 직접 눌러 주세요.');
        }
      } else {
        setStatus('좌석을 확보했습니다. 결제하기 버튼을 눌러 주세요.');
      }
    }

    async function poll() {
      if (destroyed || mode !== 'polling') {
        return;
      }
      var token = generation;
      if (!routeIsStillValid()) {
        destroy();
        return;
      }

      try {
        var refreshButton = document.querySelector(REFRESH_SELECTOR);
        if (!refreshButton) {
          throw new Error('새로고침 버튼을 찾지 못했습니다.');
        }

        setStatus('좌석 현황을 새로고침하는 중입니다.');
        refreshButton.click();
        await wait(REFRESH_SETTLE_MS);
        if (!seatSessionIsActive(token, 'polling')) {
          return;
        }

        syncSeatMarkers();
        var group = chooseBestGroup(preferences, listSeats(document), targetCount);
        consecutiveErrors = 0;
        if (group.length === targetCount) {
          await trySelectingGroup(group, token);
          return;
        }

        failedGroupKey = '';
        failedGroupCount = 0;
        setStatus('아직 가능한 선호 연속 좌석이 없습니다. 5초 후 다시 확인합니다.');
        scheduleNextPoll(POLL_INTERVAL_MS);
      } catch (error) {
        if (!runIsActive(token, 'polling')) {
          return;
        }
        consecutiveErrors += 1;
        if (consecutiveErrors >= 5) {
          mode = 'recording';
          root.addEventListener('click', captureSeatClick, true);
          prepareRecordingSeats();
          startButton.textContent = '감시 시작';
          clearButton.disabled = false;
          autoAdvanceInput.disabled = false;
          updatePanel();
          setStatus('좌석 새로고침에 연속으로 실패했습니다: ' + error.message);
          return;
        }
        setStatus('좌석 확인에 실패해 5초 후 다시 시도합니다. (' + consecutiveErrors + '/5)');
        scheduleNextPoll(POLL_INTERVAL_MS);
      }
    }

    function startMonitoring() {
      var latestTargetCount = readTargetCount(document);
      if (latestTargetCount > 0) {
        targetCount = latestTargetCount;
      }
      if (preferences.length < targetCount) {
        updatePanel();
        return;
      }

      setupAudio();
      generation += 1;
      failedGroupKey = '';
      failedGroupCount = 0;
      mode = 'polling';
      consecutiveErrors = 0;
      root.removeEventListener('click', captureSeatClick, true);
      restoreSeatDisabledState();
      startButton.textContent = '감시 중지';
      startButton.disabled = false;
      clearButton.disabled = true;
      autoAdvanceInput.disabled = true;
      setStatus('좌석 감시를 시작합니다.');
      scheduleNextPoll(0);
    }

    function returnToRecording() {
      clearTimer();
      generation += 1;
      mode = 'recording';
      root.addEventListener('click', captureSeatClick, true);
      prepareRecordingSeats();
      startButton.textContent = '감시 시작';
      clearButton.disabled = false;
      autoAdvanceInput.disabled = false;
      updatePanel();
    }

    function destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      generation += 1;
      mode = 'destroyed';
      clearTimer();
      root.removeEventListener('click', captureSeatClick, true);
      if (observer) {
        observer.disconnect();
      }
      restoreSeatDisabledState();
      findMainSeatButtons(document).forEach(function removeMarker(button) {
        button.removeAttribute('data-cgv-bot-priority');
        button.removeAttribute('data-cgv-bot-was-disabled');
      });
      if (styleElement) {
        styleElement.remove();
      }
      if (panel) {
        panel.remove();
      }
      if (audioContext && audioContext.close) {
        audioContext.close().catch(function ignoreCloseFailure() {});
      }
      if (root[BOT_KEY] === controller) {
        delete root[BOT_KEY];
      }
    }

    function start() {
      styleElement = injectStyle(document);
      createPanel();
      root.addEventListener('click', captureSeatClick, true);
      prepareRecordingSeats();
      observeSeatChanges();
    }

    var controller = {
      destroy: destroy,
      get mode() {
        return mode;
      },
      get preferences() {
        return preferences.slice();
      }
    };

    return {
      controller: controller,
      start: start
    };
  }

  function showSetupMessage(document, message) {
    var oldPanel = document.getElementById(PANEL_ID);
    if (oldPanel) {
      oldPanel.remove();
    }

    injectStyle(document);
    var panel = createElement(document, 'aside');
    panel.id = PANEL_ID;
    panel.appendChild(createElement(document, 'strong', '', 'CGV Bot'));
    panel.appendChild(createElement(document, 'div', 'cgv-bot-status', message));
    var closeButton = createElement(document, 'button', 'cgv-bot-secondary', '닫기');
    closeButton.type = 'button';
    closeButton.addEventListener('click', function closeMessage() {
      panel.remove();
      var style = document.getElementById(STYLE_ID);
      if (style) {
        style.remove();
      }
    });
    panel.appendChild(closeButton);
    document.body.appendChild(panel);
  }

  function run(root) {
    var document = root && root.document;
    if (!document || !document.body) {
      return null;
    }

    if (root[BOT_KEY] && root[BOT_KEY].destroy) {
      root[BOT_KEY].destroy();
    }

    if (!/(^|\.)cgv\.co\.kr$/i.test(String(root.location && root.location.hostname || ''))) {
      showSetupMessage(document, 'CGV 예매 페이지에서 실행해 주세요.');
      return null;
    }

    var map = findSeatMap(document);
    var dialog = map && map.closest('[role="dialog"]');
    var targetCount = readTargetCount(document);
    if (
      !dialog ||
      !isVisible(root, dialog) ||
      !map ||
      !findMainSeatButtons(document).length ||
      !targetCount
    ) {
      showSetupMessage(
        document,
        '관람 인원을 선택하고 좌석 영역의 “선택” 버튼을 눌러 좌석 창을 연 뒤 다시 실행해 주세요.'
      );
      return null;
    }

    var instance = createController(
      root,
      document,
      targetCount,
      dialog,
      readBookingFingerprint(document)
    );
    root[BOT_KEY] = instance.controller;
    instance.start();
    return instance.controller;
  }

  return {
    areAdjacent: areAdjacent,
    chooseBestGroup: chooseBestGroup,
    normalizeSeatLabel: normalizeSeatLabel,
    parseSeatLabel: parseSeatLabel,
    readBookingFingerprint: readBookingFingerprint,
    readTargetCount: readTargetCount,
    run: run,
    sameSeatSet: sameSeatSet,
    seatFromButton: seatFromButton
  };
});
