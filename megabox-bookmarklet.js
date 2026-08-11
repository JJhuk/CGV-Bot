/**
 * Megabox automatic seat watcher bookmarklet.
 *
 * The adapter intentionally uses only the public DOM exposed by the booking
 * page. It never calls fn_search (or another private Megabox function)
 * directly, and it never clicks a purchase control.
 */
(function initializeMegaboxBot(root, factory) {
  var api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }

  api.run(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function createMegaboxBotApi() {
  'use strict';

  var BOT_KEY = '__MEGABOX_BOT_V1__';
  var FRAME_SELECTOR = '#frameBokdMSeat';
  var SEAT_SELECTOR = 'button.seat-condition[seatuniqno]';
  var REFRESH_SELECTOR = '#seatMemberCntInit';
  var NEXT_SELECTOR = 'a#pageNext.active:not(.disabled)';
  var PANEL_ID = 'megabox-bot-panel';
  var TOP_STYLE_ID = 'megabox-bot-top-style';
  var SEAT_STYLE_ID = 'megabox-bot-seat-style';
  var PRIORITY_ATTRIBUTE = 'data-megabox-bot-priority';
  var WAS_DISABLED_ATTRIBUTE = 'data-megabox-bot-was-disabled';
  var POLL_INTERVAL_MS = 6000;
  var REFRESH_WAIT_ATTEMPTS = 24;
  var REFRESH_WAIT_STEP_MS = 250;
  var MAX_REFRESH_ERRORS = 5;
  var MAX_GROUP_FAILURES = 3;

  function normalizedText(element) {
    return String(element && element.textContent || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeSeatLabel(value) {
    return String(value || '')
      .replace(/\s+/g, '')
      .replace(/^좌석/, '');
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

  function finiteNumber(value, fallback) {
    var number = Number.parseFloat(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function positiveInteger(value, fallback) {
    var number = Number.parseInt(value, 10);
    return Number.isInteger(number) && number > 0 ? number : fallback;
  }

  function hasClass(element, className) {
    if (element && element.classList && element.classList.contains) {
      return element.classList.contains(className);
    }
    return new RegExp('(?:^|\\s)' + className + '(?:\\s|$)', 'i')
      .test(String(element && element.className || ''));
  }

  function seatClassIsUnavailable(button) {
    return hasClass(button, 'finish') || hasClass(button, 'impossible');
  }

  function isSeatUnavailable(button) {
    return Boolean(button.disabled || seatClassIsUnavailable(button));
  }

  function isSeatSelected(button) {
    if (hasClass(button, 'choice')) {
      return true;
    }
    if (!button.hasAttribute || !button.hasAttribute('selected')) {
      return false;
    }

    var value = String(button.getAttribute('selected') || '').toLowerCase();
    return value !== 'n' && value !== 'false' && value !== '0';
  }

  function seatFromButton(button) {
    var rowAttribute = normalizeSeatLabel(button.getAttribute('rownm'));
    var seatNumberAttribute = normalizeSeatLabel(button.getAttribute('seatno'));
    var parsed = parseSeatLabel(
      rowAttribute && seatNumberAttribute
        ? rowAttribute + seatNumberAttribute
        : normalizedText(button)
    );
    var classCode = String(button.getAttribute('seatclasscd') || '');
    var zoneCode = String(button.getAttribute('seatzonecd') || '');
    var groupSeq = finiteNumber(button.getAttribute('seatchoigrpseq'), NaN);

    return {
      locNo: String(button.getAttribute('seatuniqno') || ''),
      label: parsed.label,
      row: rowAttribute || parsed.row,
      number: finiteNumber(seatNumberAttribute, parsed.number),
      left: finiteNumber(button.style && button.style.left, finiteNumber(button.offsetLeft, NaN)),
      top: finiteNumber(button.style && button.style.top, finiteNumber(button.offsetTop, NaN)),
      width: finiteNumber(button.style && button.style.width, finiteNumber(button.offsetWidth, NaN)),
      groupNo: String(button.getAttribute('seatchoigrpno') || ''),
      groupName: String(button.getAttribute('seatchoigrpnm') || ''),
      groupSeq: groupSeq,
      groupRowCount: positiveInteger(button.getAttribute('seatchoirowcnt'), 0),
      seatToCnt: positiveInteger(button.getAttribute('seattocnt'), 1),
      classCode: classCode,
      zoneCode: zoneCode,
      type: (classCode || 'normal') + ':' + (zoneCode || 'normal'),
      disabled: isSeatUnavailable(button),
      selected: isSeatSelected(button),
      element: button
    };
  }

  function seatWeight(seat) {
    return positiveInteger(seat && seat.seatToCnt, 1);
  }

  function areAdjacent(leftSeat, rightSeat) {
    if (!leftSeat || !rightSeat) {
      return false;
    }
    if (!leftSeat.row || leftSeat.row !== rightSeat.row) {
      return false;
    }
    if (String(leftSeat.type || '') !== String(rightSeat.type || '')) {
      return false;
    }

    var leftGroup = String(leftSeat.groupNo || '');
    var rightGroup = String(rightSeat.groupNo || '');
    var leftGroupName = String(leftSeat.groupName || '');
    var rightGroupName = String(rightSeat.groupName || '');
    if (leftGroupName || rightGroupName) {
      if (leftGroupName !== rightGroupName) {
        return false;
      }
    } else if ((leftGroup || rightGroup) && leftGroup !== rightGroup) {
      return false;
    }

    var sequentialBySeatNumber = Number.isFinite(leftSeat.number) &&
      rightSeat.number === leftSeat.number + 1;
    if (Number.isFinite(leftSeat.groupSeq) && Number.isFinite(rightSeat.groupSeq)) {
      if (rightSeat.groupSeq !== leftSeat.groupSeq + 1 && !sequentialBySeatNumber) {
        return false;
      }
    } else if (!sequentialBySeatNumber) {
      return false;
    }

    if (Number.isFinite(leftSeat.top) && Number.isFinite(rightSeat.top)) {
      if (Math.abs(leftSeat.top - rightSeat.top) > 3) {
        return false;
      }
    }

    // The official client groups seats by row + group name. Group number and
    // geometry remain fallbacks for older/incomplete seat markup.
    if (
      !leftGroupName &&
      !leftGroup &&
      Number.isFinite(leftSeat.left) &&
      Number.isFinite(rightSeat.left) &&
      Number.isFinite(leftSeat.width)
    ) {
      var tolerance = Math.max(4, leftSeat.width * 0.4);
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
    if (
      Number.isFinite(leftSeat.groupSeq) &&
      Number.isFinite(rightSeat.groupSeq) &&
      leftSeat.groupSeq !== rightSeat.groupSeq
    ) {
      return leftSeat.groupSeq - rightSeat.groupSeq;
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

    for (var start = 0; start < candidates.length; start += 1) {
      var capacity = 0;
      for (var end = start; end < candidates.length; end += 1) {
        if (end > start && !areAdjacent(candidates[end - 1], candidates[end])) {
          break;
        }
        capacity += seatWeight(candidates[end]);
        if (capacity > count) {
          break;
        }
        if (capacity !== count) {
          continue;
        }

        var group = candidates.slice(start, end + 1);
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
        break;
      }
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

    var leftLocNos = new Set(leftSeats.map(function toLocNo(seat) {
      return String(seat.locNo);
    }));
    var rightLocNos = new Set(rightSeats.map(function toLocNo(seat) {
      return String(seat.locNo);
    }));
    if (leftLocNos.size !== leftSeats.length || rightLocNos.size !== rightSeats.length) {
      return false;
    }
    return leftLocNos.size === rightLocNos.size && Array.from(leftLocNos).every(function containsLocNo(locNo) {
      return rightLocNos.has(locNo);
    });
  }

  function findSeatButtons(seatDocument) {
    return Array.from(seatDocument.querySelectorAll(SEAT_SELECTOR));
  }

  function listSeats(seatDocument) {
    return findSeatButtons(seatDocument).map(seatFromButton);
  }

  function countFromNowButton(button) {
    if (!button) {
      return 0;
    }
    var candidates = [button.value, button.getAttribute && button.getAttribute('value'), normalizedText(button)];
    for (var index = 0; index < candidates.length; index += 1) {
      var match = /-?\d+/.exec(String(candidates[index] || ''));
      if (match) {
        return Math.max(0, Number(match[0]));
      }
    }
    return 0;
  }

  function readTicketCounts(seatDocument) {
    var countByCategory = new Map();
    Array.from(seatDocument.querySelectorAll('.seat-count .cell')).forEach(function readCell(cell, index) {
      var category = normalizedText(cell.querySelector('.txt')) || 'category-' + index;
      var count = countFromNowButton(cell.querySelector('button.now'));
      var previous = countByCategory.get(category);
      if (!previous || count > previous.count) {
        countByCategory.set(category, { category: category, count: count });
      }
    });
    return Array.from(countByCategory.values());
  }

  function readTargetCount(seatDocument) {
    return readTicketCounts(seatDocument).reduce(function sum(total, entry) {
      return total + entry.count;
    }, 0);
  }

  function inputValue(document, id) {
    var element = document.getElementById(id);
    if (!element) {
      return '';
    }
    return String(typeof element.value !== 'undefined' ? element.value : element.getAttribute('value') || '');
  }

  function readBookingFingerprint(seatDocument) {
    var locationValue = '';
    try {
      locationValue = String(seatDocument.location && (
        seatDocument.location.pathname + seatDocument.location.search
      ) || '');
    } catch (error) {
      locationValue = '';
    }

    return JSON.stringify([
      locationValue,
      inputValue(seatDocument, 'movieNo'),
      inputValue(seatDocument, 'movieNm'),
      inputValue(seatDocument, 'playDe'),
      inputValue(seatDocument, 'playStartTime'),
      inputValue(seatDocument, 'playEndTime'),
      inputValue(seatDocument, 'theabNo'),
      inputValue(seatDocument, 'playSchdlNo'),
      inputValue(seatDocument, 'brchNo')
    ]);
  }

  function isVisible(root, element) {
    if (!element || !element.isConnected || element.hidden) {
      return false;
    }
    var style = root.getComputedStyle ? root.getComputedStyle(element) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden')) {
      return false;
    }
    return !element.getClientRects || element.getClientRects().length > 0;
  }

  function seatDocumentFromFrame(frame) {
    if (!frame) {
      return null;
    }
    try {
      return frame.contentDocument || frame.contentWindow && frame.contentWindow.document || null;
    } catch (error) {
      return null;
    }
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

  function injectTopStyle(document) {
    var oldStyle = document.getElementById(TOP_STYLE_ID);
    if (oldStyle) {
      oldStyle.remove();
    }
    var style = document.createElement('style');
    style.id = TOP_STYLE_ID;
    style.textContent = [
      '#' + PANEL_ID + '{position:fixed;top:12px;left:50%;z-index:2147483647;width:min(540px,calc(100vw - 24px));transform:translateX(-50%);box-sizing:border-box;padding:14px 16px;border-radius:12px;background:rgba(20,20,24,.96);color:#fff;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35)}',
      '#' + PANEL_ID + ' strong{font-size:16px}',
      '#' + PANEL_ID + ' .megabox-bot-status{margin-top:6px;color:#fff}',
      '#' + PANEL_ID + ' .megabox-bot-list{margin-top:4px;color:#c9b8ff;word-break:break-all}',
      '#' + PANEL_ID + ' .megabox-bot-options{display:flex;align-items:center;gap:8px;margin-top:8px;color:#ddd}',
      '#' + PANEL_ID + ' .megabox-bot-actions{display:flex;gap:8px;margin-top:10px}',
      '#' + PANEL_ID + ' button{min-height:36px;padding:0 12px;border:0;border-radius:8px;cursor:pointer;font-weight:700}',
      '#' + PANEL_ID + ' button:disabled{cursor:not-allowed;opacity:.45}',
      '#' + PANEL_ID + ' .megabox-bot-primary{background:#6f2dbd;color:#fff}',
      '#' + PANEL_ID + ' .megabox-bot-secondary{background:#444;color:#fff}'
    ].join('');
    document.head.appendChild(style);
    return style;
  }

  function injectSeatStyle(seatDocument) {
    var oldStyle = seatDocument.getElementById(SEAT_STYLE_ID);
    if (oldStyle) {
      oldStyle.remove();
    }
    var style = seatDocument.createElement('style');
    style.id = SEAT_STYLE_ID;
    style.textContent = [
      'button[' + PRIORITY_ATTRIBUTE + ']{outline:3px solid #7f39db!important;outline-offset:1px;z-index:999!important}',
      'button[' + PRIORITY_ATTRIBUTE + ']::after{content:attr(' + PRIORITY_ATTRIBUTE + ');position:absolute;right:-6px;top:-8px;display:grid;place-items:center;min-width:18px;height:18px;padding:0 3px;border-radius:999px;background:#5b16ad;color:#fff;font:700 11px/1 sans-serif;box-sizing:border-box}',
      'button[' + WAS_DISABLED_ATTRIBUTE + '="true"]{filter:saturate(.45)}'
    ].join('');
    seatDocument.head.appendChild(style);
    return style;
  }

  function createController(
    root,
    topDocument,
    seatFrame,
    seatDocument,
    targetCount,
    initialPlaySchdlNo,
    initialBrchNo,
    initialFingerprint
  ) {
    var preferences = [];
    var mode = 'recording';
    var pollTimer = null;
    var validationTimer = null;
    var topObserver = null;
    var seatObserver = null;
    var observerQueued = false;
    var panel = null;
    var statusElement = null;
    var listElement = null;
    var startButton = null;
    var clearButton = null;
    var cancelButton = null;
    var autoAdvanceInput = null;
    var topStyleElement = null;
    var seatStyleElement = null;
    var audioContext = null;
    var initialRoute = String(root.location.pathname || '') +
      String(root.location.search || '') + String(root.location.hash || '');
    var touchedSeats = new Set();
    var destroyed = false;
    var consecutiveErrors = 0;
    var generation = 0;
    var failedGroupKey = '';
    var failedGroupCount = 0;
    var lastPollStartedAt = 0;
    var ticketSnapshot = [];
    var refreshInFlight = false;
    var pendingUserAction = '';
    var selectionStopAction = '';

    function runIsActive(token, expectedMode) {
      if (destroyed || token !== generation) {
        return false;
      }
      if (Array.isArray(expectedMode)) {
        return expectedMode.includes(mode);
      }
      return !expectedMode || mode === expectedMode;
    }

    function currentRoute() {
      return String(root.location.pathname || '') +
        String(root.location.search || '') + String(root.location.hash || '');
    }

    function routeIsStillValid() {
      var currentFrame = topDocument.querySelector(FRAME_SELECTOR);
      return (
        currentRoute() === initialRoute &&
        currentFrame === seatFrame &&
        seatFrame.isConnected &&
        isVisible(root, seatFrame) &&
        seatDocumentFromFrame(seatFrame) === seatDocument &&
        inputValue(seatDocument, 'playSchdlNo') === initialPlaySchdlNo &&
        inputValue(seatDocument, 'brchNo') === initialBrchNo &&
        readBookingFingerprint(seatDocument) === initialFingerprint
      );
    }

    function seatSessionIsActive(token, expectedMode) {
      if (!runIsActive(token, expectedMode)) {
        return false;
      }
      if (!routeIsStillValid()) {
        forceDestroy();
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

    function preferredCapacity() {
      return preferences.reduce(function sum(total, preference) {
        return total + seatWeight(preference);
      }, 0);
    }

    function preferredStructuralGroup() {
      var preferredLocNos = new Set(preferences.map(function preferenceLoc(preference) {
        return String(preference.locNo);
      }));
      var structurallyAvailableSeats = listSeats(seatDocument)
        .filter(function isPreferred(seat) {
          return preferredLocNos.has(String(seat.locNo));
        })
        .map(function ignoreCurrentAvailability(seat) {
          return Object.assign({}, seat, { disabled: false });
        });
      return chooseBestGroup(preferences, structurallyAvailableSeats, targetCount);
    }

    function hasPreferredStructuralGroup() {
      var group = preferredStructuralGroup();
      return group.length > 0 && group.reduce(function sumCapacity(total, seat) {
        return total + seatWeight(seat);
      }, 0) === targetCount;
    }

    function syncSeatMarkers() {
      findSeatButtons(seatDocument).forEach(function markSeat(button) {
        var locNo = String(button.getAttribute('seatuniqno') || '');
        var index = preferenceIndex(locNo);
        if (index === -1) {
          if (button.hasAttribute(PRIORITY_ATTRIBUTE)) {
            button.removeAttribute(PRIORITY_ATTRIBUTE);
          }
          return;
        }
        var seat = seatFromButton(button);
        preferences[index].label = seat.label;
        preferences[index].seatToCnt = seat.seatToCnt;
        var priority = String(index + 1);
        if (button.getAttribute(PRIORITY_ATTRIBUTE) !== priority) {
          button.setAttribute(PRIORITY_ATTRIBUTE, priority);
        }
      });
    }

    function prepareRecordingSeats() {
      if (mode !== 'recording') {
        syncSeatMarkers();
        return;
      }
      findSeatButtons(seatDocument).forEach(function enableBookedPreference(button) {
        if (hasClass(button, 'finish') && button.disabled) {
          touchedSeats.add(button);
          button.setAttribute(WAS_DISABLED_ATTRIBUTE, 'true');
          button.disabled = false;
        }
      });
      syncSeatMarkers();
    }

    function restoreSeatDisabledState() {
      touchedSeats.forEach(function restore(button) {
        if (button.isConnected) {
          button.disabled = seatClassIsUnavailable(button);
        }
        button.removeAttribute(WAS_DISABLED_ATTRIBUTE);
      });
      touchedSeats.clear();
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
      var enoughCapacity = preferredCapacity() >= targetCount;
      var hasExactGroup = enoughCapacity && hasPreferredStructuralGroup();
      startButton.disabled = mode === 'recording' && !hasExactGroup;
      if (mode === 'recording' && enoughCapacity && !hasExactGroup) {
        setStatus('현재 선호 좌석에는 관람 인원에 정확히 맞는 같은 종류의 연속 좌석 조합이 없습니다.');
      }
    }

    function togglePreference(button) {
      var seat = seatFromButton(button);
      if (!seat.locNo || hasClass(button, 'impossible')) {
        return;
      }
      var index = preferenceIndex(seat.locNo);
      if (index === -1) {
        preferences.push({
          locNo: seat.locNo,
          label: seat.label,
          priority: preferences.length + 1,
          seatToCnt: seat.seatToCnt
        });
      } else {
        preferences.splice(index, 1);
        preferences.forEach(function resetPriority(preference, offset) {
          preference.priority = offset + 1;
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
      if (!target || target.ownerDocument !== seatDocument) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) {
        event.stopImmediatePropagation();
      }
      togglePreference(target);
    }

    function queueObserverWork() {
      if (observerQueued || destroyed) {
        return;
      }
      observerQueued = true;
      root.queueMicrotask(function refreshHooks() {
        observerQueued = false;
        if (destroyed) {
          return;
        }
        if (!routeIsStillValid()) {
          forceDestroy();
          return;
        }
        if (mode === 'recording') {
          var latestTargetCount = readTargetCount(seatDocument);
          if (latestTargetCount > 0 && latestTargetCount !== targetCount) {
            targetCount = latestTargetCount;
          }
          prepareRecordingSeats();
          updatePanel();
        } else {
          syncSeatMarkers();
        }
      });
    }

    function observeSession() {
      if (root.MutationObserver) {
        topObserver = new root.MutationObserver(queueObserverWork);
        topObserver.observe(seatFrame.parentElement || topDocument.body, {
          childList: true,
          subtree: false
        });
        topObserver.observe(seatFrame, {
          attributes: true,
          attributeFilter: ['class', 'style', 'hidden', 'src']
        });

        var SeatMutationObserver = seatFrame.contentWindow &&
          seatFrame.contentWindow.MutationObserver || root.MutationObserver;
        seatObserver = new SeatMutationObserver(queueObserverWork);
        seatObserver.observe(seatDocument.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'disabled', 'selected', 'value'],
          characterData: true
        });
      }
      seatFrame.addEventListener('load', queueObserverWork);
      root.addEventListener('popstate', queueObserverWork);
      root.addEventListener('hashchange', queueObserverWork);
      scheduleValidation();
    }

    function scheduleValidation() {
      if (destroyed) {
        return;
      }
      validationTimer = root.setTimeout(function validateSession() {
        validationTimer = null;
        if (!routeIsStillValid()) {
          forceDestroy();
          return;
        }
        scheduleValidation();
      }, 500);
    }

    function createPanel() {
      var oldPanel = topDocument.getElementById(PANEL_ID);
      if (oldPanel) {
        oldPanel.remove();
      }
      panel = createElement(topDocument, 'aside');
      panel.id = PANEL_ID;
      panel.setAttribute('role', 'status');
      panel.appendChild(createElement(topDocument, 'strong', '', 'Megabox Bot'));

      statusElement = createElement(topDocument, 'div', 'megabox-bot-status');
      listElement = createElement(topDocument, 'div', 'megabox-bot-list');
      panel.appendChild(statusElement);
      panel.appendChild(listElement);

      var options = createElement(topDocument, 'label', 'megabox-bot-options');
      autoAdvanceInput = createElement(topDocument, 'input');
      autoAdvanceInput.type = 'checkbox';
      autoAdvanceInput.checked = true;
      options.appendChild(autoAdvanceInput);
      options.appendChild(topDocument.createTextNode('좌석 확보 시 다음 단계로 자동 이동'));
      panel.appendChild(options);

      var actions = createElement(topDocument, 'div', 'megabox-bot-actions');
      startButton = createElement(topDocument, 'button', 'megabox-bot-primary', '감시 시작');
      startButton.type = 'button';
      clearButton = createElement(topDocument, 'button', 'megabox-bot-secondary', '선호 초기화');
      clearButton.type = 'button';
      cancelButton = createElement(topDocument, 'button', 'megabox-bot-secondary', '종료');
      cancelButton.type = 'button';
      actions.appendChild(startButton);
      actions.appendChild(clearButton);
      actions.appendChild(cancelButton);
      panel.appendChild(actions);

      startButton.addEventListener('click', function handleStartStop() {
        if (mode === 'recording') {
          startMonitoring();
        } else if (mode === 'polling' || mode === 'selecting') {
          requestReturnToRecording();
        }
      });
      clearButton.addEventListener('click', function clearPreferences() {
        preferences = [];
        syncSeatMarkers();
        updatePanel();
      });
      cancelButton.addEventListener('click', requestDestroy);
      topDocument.body.appendChild(panel);
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
        // The visual success state remains available when audio is blocked.
      }
    }

    function clearPollTimer() {
      if (pollTimer !== null) {
        root.clearTimeout(pollTimer);
        pollTimer = null;
      }
    }

    function scheduleNextPoll(delay) {
      clearPollTimer();
      if (mode !== 'polling') {
        return;
      }
      var requestedDelay = Math.max(0, delay);
      if (lastPollStartedAt) {
        requestedDelay = Math.max(
          requestedDelay,
          POLL_INTERVAL_MS - Math.max(0, Date.now() - lastPollStartedAt)
        );
      }
      pollTimer = root.setTimeout(poll, requestedDelay);
    }

    function wait(delay) {
      return new Promise(function resolveAfter(resolve) {
        root.setTimeout(resolve, delay);
      });
    }

    function currentSelectedSeats() {
      return listSeats(seatDocument).filter(function selected(seat) {
        return seat.selected;
      });
    }

    async function waitForFreshSeats(oldFirstSeat, refreshButton, token) {
      for (var attempt = 0; attempt < REFRESH_WAIT_ATTEMPTS; attempt += 1) {
        if (!seatSessionIsActive(token, 'polling')) {
          return false;
        }
        var newSeats = findSeatButtons(seatDocument);
        var refreshLifecycleStarted = Boolean(
          refreshButton.disabled ||
          hasClass(refreshButton, 'disabled') ||
          String(refreshButton.getAttribute('aria-disabled') || '') === 'true'
        );
        var oldSeatWasReplaced = Boolean(
          oldFirstSeat && !oldFirstSeat.isConnected && newSeats[0] !== oldFirstSeat
        );
        if (
          newSeats.length &&
          readTargetCount(seatDocument) === 0 &&
          (oldSeatWasReplaced || refreshLifecycleStarted)
        ) {
          return true;
        }
        await wait(REFRESH_WAIT_STEP_MS);
      }
      throw new Error('새 좌석 현황이 표시되지 않았습니다.');
    }

    function ticketCellForCategory(category) {
      return Array.from(seatDocument.querySelectorAll('.seat-count .cell')).find(function matches(cell) {
        return normalizedText(cell.querySelector('.txt')) === category;
      }) || null;
    }

    function ticketCountsMatch(snapshot) {
      var currentByCategory = new Map(readTicketCounts(seatDocument).map(function entryPair(entry) {
        return [entry.category, entry.count];
      }));
      return snapshot.every(function matchesSnapshot(entry) {
        return currentByCategory.get(entry.category) === entry.count;
      });
    }

    async function restoreTicketCounts(snapshot, token) {
      for (var categoryIndex = 0; categoryIndex < snapshot.length; categoryIndex += 1) {
        var desired = snapshot[categoryIndex];
        if (desired.count < 1) {
          continue;
        }
        var initialCell = ticketCellForCategory(desired.category);
        if (!initialCell) {
          throw new Error(desired.category + ' 인원 선택 영역을 다시 찾지 못했습니다.');
        }
        var current = countFromNowButton(initialCell.querySelector('button.now'));
        if (current > desired.count) {
          throw new Error(desired.category + ' 인원 수가 예상과 다릅니다.');
        }

        var clicksNeeded = desired.count - current;
        for (var clickIndex = 0; clickIndex < clicksNeeded; clickIndex += 1) {
          if (!seatSessionIsActive(token, 'polling')) {
            return false;
          }
          var latestCell = ticketCellForCategory(desired.category);
          var upButton = latestCell && latestCell.querySelector('button.up');
          if (!upButton || upButton.disabled) {
            throw new Error(desired.category + ' 인원 수를 복원할 수 없습니다.');
          }
          upButton.click();
          await wait(40);
        }
      }

      if (!seatSessionIsActive(token, 'polling')) {
        return false;
      }
      await wait(80);
      if (!seatSessionIsActive(token, 'polling')) {
        return false;
      }

      if (!ticketCountsMatch(snapshot)) {
        throw new Error('관람 인원 복원 결과를 확인하지 못했습니다.');
      }
      return true;
    }

    async function clearOfficialSelection(token, expectedMode) {
      var requiredMode = expectedMode || 'selecting';
      for (var attempt = 0; attempt < Math.max(8, targetCount + 3); attempt += 1) {
        if (!seatSessionIsActive(token, requiredMode)) {
          return false;
        }
        var selected = currentSelectedSeats();
        if (!selected.length) {
          return true;
        }
        // A selected Megabox anchor clears the whole automatic adjacency set.
        selected[0].element.click();
        await wait(160);
      }
      return !currentSelectedSeats().length;
    }

    function safeAnchorLocNos(group) {
      var order = [];
      var left = 0;
      var right = group.length - 1;
      while (left <= right) {
        order.push(String(group[left].locNo));
        if (right !== left) {
          order.push(String(group[right].locNo));
        }
        left += 1;
        right -= 1;
      }
      return Array.from(new Set(order));
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

      if (!await clearOfficialSelection(token)) {
        if (seatSessionIsActive(token, 'selecting')) {
          returnToRecording();
          setStatus('기존 좌석 선택을 안전하게 해제하지 못했습니다. 직접 좌석 상태를 확인해 주세요.');
        }
        return false;
      }
      if (!seatSessionIsActive(token, 'selecting')) {
        return false;
      }

      var wanted = group.map(function wantedSeat(seat) {
        return { locNo: seat.locNo };
      });
      var wantedLocNos = new Set(wanted.map(function wantedLocNo(seat) {
        return String(seat.locNo);
      }));
      var anchors = safeAnchorLocNos(group);
      for (var index = 0; index < anchors.length; index += 1) {
        if (!seatSessionIsActive(token, 'selecting')) {
          return false;
        }
        var clickOrder = [anchors[index]].concat(anchors.filter(function otherAnchor(locNo) {
          return locNo !== anchors[index];
        }));

        for (var clickIndex = 0; clickIndex < clickOrder.length; clickIndex += 1) {
          var selectedBeforeClick = currentSelectedSeats();
          if (sameSeatSet(selectedBeforeClick, wanted)) {
            failedGroupKey = '';
            failedGroupCount = 0;
            completeSelection(group, token);
            return true;
          }
          if (selectedBeforeClick.some(function selectedOutsideGroup(seat) {
            return !wantedLocNos.has(String(seat.locNo));
          })) {
            break;
          }

          var currentSeats = listSeats(seatDocument);
          var anchor = currentSeats.find(function sameLocNo(seat) {
            return String(seat.locNo) === clickOrder[clickIndex];
          });
          // The official handler may already have selected this planned seat
          // as its adjacent partner. Clicking it again would clear the pair.
          if (!anchor || anchor.disabled || anchor.selected) {
            continue;
          }

          anchor.element.click();
          await wait(220);
          if (!seatSessionIsActive(token, 'selecting')) {
            return false;
          }
          var selectedAfterClick = currentSelectedSeats();
          if (sameSeatSet(selectedAfterClick, wanted)) {
            failedGroupKey = '';
            failedGroupCount = 0;
            completeSelection(group, token);
            return true;
          }
          if (selectedAfterClick.some(function selectedOutsideGroup(seat) {
            return !wantedLocNos.has(String(seat.locNo));
          })) {
            break;
          }
        }
        if (!await clearOfficialSelection(token)) {
          break;
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
        if (failedGroupCount >= MAX_GROUP_FAILURES) {
          returnToRecording();
          setStatus('메가박스가 프로그램 좌석 클릭을 정확히 반영하지 않아 감시를 멈췄습니다. 인원과 좌석 상태를 확인해 주세요.');
          return false;
        }
        mode = 'polling';
        startButton.textContent = '감시 중지';
        setStatus('메가박스의 자동 연속 좌석 결과가 달라 6초 후 다시 확인합니다.');
        scheduleNextPoll(POLL_INTERVAL_MS);
      }
      return false;
    }

    function completeSelection(group, token) {
      if (!seatSessionIsActive(token, 'selecting')) {
        return;
      }
      if (!sameSeatSet(currentSelectedSeats(), group)) {
        returnToRecording();
        setStatus('선택된 좌석이 선호 좌석과 달라 자동 진행하지 않았습니다. 직접 확인해 주세요.');
        return;
      }

      mode = 'success';
      clearPollTimer();
      beep();
      startButton.textContent = '완료';
      startButton.disabled = true;
      clearButton.disabled = true;
      autoAdvanceInput.disabled = true;
      setStatus('좌석 확보: ' + group.map(function label(seat) {
        return seat.label;
      }).join(', '));

      if (!autoAdvanceInput.checked) {
        setStatus('좌석을 확보했습니다. 다음 단계 버튼을 직접 눌러 주세요.');
        return;
      }
      var nextButton = seatDocument.querySelector(NEXT_SELECTOR);
      if (!nextButton) {
        setStatus('좌석은 확보했지만 활성화된 다음 단계 버튼을 찾지 못했습니다. 직접 확인해 주세요.');
        return;
      }
      if (!runIsActive(token, 'success')) {
        return;
      }
      nextButton.click();
      setStatus('좌석을 확보해 다음 단계 진행을 요청했습니다. 화면의 안내와 결제 내용은 직접 확인해 주세요.');
    }

    async function poll() {
      if (destroyed || mode !== 'polling') {
        return;
      }
      var token = generation;
      if (!routeIsStillValid()) {
        forceDestroy();
        return;
      }
      lastPollStartedAt = Date.now();

      try {
        var snapshot = ticketSnapshot.map(function copyTicketCount(entry) {
          return { category: entry.category, count: entry.count };
        });
        var snapshotTarget = snapshot.reduce(function sum(total, entry) {
          return total + entry.count;
        }, 0);
        if (!snapshotTarget) {
          throw new Error('선택한 관람 인원을 읽지 못했습니다.');
        }
        targetCount = snapshotTarget;
        var oldFirstSeat = findSeatButtons(seatDocument)[0];
        var refreshButton = seatDocument.querySelector(REFRESH_SELECTOR);
        if (!refreshButton || refreshButton.disabled) {
          throw new Error('좌석 새로고침 버튼을 사용할 수 없습니다.');
        }

        setStatus('좌석 현황을 새로고침하고 관람 인원을 보존하는 중입니다.');
        refreshInFlight = true;
        refreshButton.click();
        if (!await waitForFreshSeats(oldFirstSeat, refreshButton, token)) {
          return;
        }
        if (!await restoreTicketCounts(snapshot, token)) {
          return;
        }
        if (!seatSessionIsActive(token, 'polling')) {
          return;
        }
        refreshInFlight = false;
        if (finishPendingUserAction(true)) {
          return;
        }

        syncSeatMarkers();
        var group = chooseBestGroup(preferences, listSeats(seatDocument), targetCount);
        consecutiveErrors = 0;
        var groupCapacity = group.reduce(function sumCapacity(total, seat) {
          return total + seatWeight(seat);
        }, 0);
        if (group.length && groupCapacity === targetCount) {
          await trySelectingGroup(group, token);
          return;
        }

        failedGroupKey = '';
        failedGroupCount = 0;
        setStatus('아직 가능한 선호 연속 좌석이 없습니다. 6초 후 다시 확인합니다.');
        scheduleNextPoll(POLL_INTERVAL_MS);
      } catch (error) {
        var countsRecovered = ticketCountsMatch(snapshot);
        if (refreshInFlight && !countsRecovered && runIsActive(token, 'polling')) {
          try {
            countsRecovered = await restoreTicketCounts(snapshot, token);
          } catch (restoreError) {
            countsRecovered = false;
          }
        }
        refreshInFlight = false;
        if (pendingUserAction) {
          if (countsRecovered) {
            finishPendingUserAction(true);
          } else {
            pendingUserAction = '';
            forceDestroy();
            showSetupMessage(
              topDocument,
              '새로고침 뒤 관람 인원을 복원하지 못했습니다. 인원과 좌석 상태를 직접 확인한 뒤 다시 실행해 주세요.'
            );
          }
          return;
        }
        if (!runIsActive(token, 'polling')) {
          return;
        }
        consecutiveErrors += 1;
        if (consecutiveErrors >= MAX_REFRESH_ERRORS) {
          if (!countsRecovered) {
            forceDestroy();
            showSetupMessage(
              topDocument,
              '좌석 새로고침과 관람 인원 복원에 실패했습니다. 인원을 다시 선택한 뒤 실행해 주세요.'
            );
            return;
          }
          returnToRecording();
          setStatus('좌석 새로고침에 연속으로 실패했습니다: ' + error.message);
          return;
        }
        setStatus('좌석 확인에 실패해 6초 후 다시 시도합니다. (' + consecutiveErrors + '/' + MAX_REFRESH_ERRORS + ')');
        scheduleNextPoll(POLL_INTERVAL_MS);
      }
    }

    function startMonitoring() {
      var latestSnapshot = readTicketCounts(seatDocument);
      var latestTargetCount = latestSnapshot.reduce(function sum(total, entry) {
        return total + entry.count;
      }, 0);
      if (!latestTargetCount) {
        updatePanel();
        setStatus('관람 인원을 다시 선택한 뒤 감시를 시작해 주세요.');
        return;
      }
      ticketSnapshot = latestSnapshot.map(function copyTicketCount(entry) {
        return { category: entry.category, count: entry.count };
      });
      targetCount = latestTargetCount;
      if (preferredCapacity() < targetCount || !hasPreferredStructuralGroup()) {
        updatePanel();
        return;
      }

      setupAudio();
      generation += 1;
      failedGroupKey = '';
      failedGroupCount = 0;
      mode = 'polling';
      consecutiveErrors = 0;
      lastPollStartedAt = 0;
      seatDocument.removeEventListener('click', captureSeatClick, true);
      restoreSeatDisabledState();
      startButton.textContent = '감시 중지';
      startButton.disabled = false;
      clearButton.disabled = true;
      autoAdvanceInput.disabled = true;
      setStatus('좌석 감시를 시작합니다.');
      scheduleNextPoll(0);
    }

    function returnToRecording() {
      clearPollTimer();
      generation += 1;
      mode = 'recording';
      lastPollStartedAt = 0;
      seatDocument.addEventListener('click', captureSeatClick, true);
      prepareRecordingSeats();
      startButton.textContent = '감시 시작';
      clearButton.disabled = false;
      cancelButton.disabled = false;
      autoAdvanceInput.disabled = false;
      updatePanel();
    }

    function requestReturnToRecording() {
      if (!refreshInFlight) {
        if (mode === 'selecting') {
          stopSelectingSafely('recording');
          return;
        }
        returnToRecording();
        return;
      }
      if (pendingUserAction !== 'destroy') {
        pendingUserAction = 'recording';
      }
      startButton.disabled = true;
      clearButton.disabled = true;
      autoAdvanceInput.disabled = true;
      setStatus('관람 인원을 원래대로 복원한 뒤 감시를 멈춥니다.');
    }

    function requestDestroy() {
      if (!refreshInFlight) {
        if (mode === 'selecting' || mode === 'stopping') {
          stopSelectingSafely('destroy');
          return;
        }
        forceDestroy();
        return;
      }
      pendingUserAction = 'destroy';
      startButton.disabled = true;
      clearButton.disabled = true;
      cancelButton.disabled = true;
      autoAdvanceInput.disabled = true;
      setStatus('관람 인원을 원래대로 복원한 뒤 종료합니다.');
    }

    async function stopSelectingSafely(action) {
      if (mode === 'stopping') {
        if (action === 'destroy') {
          selectionStopAction = 'destroy';
        }
        return;
      }
      selectionStopAction = action;
      generation += 1;
      var token = generation;
      mode = 'stopping';
      startButton.disabled = true;
      clearButton.disabled = true;
      cancelButton.disabled = true;
      autoAdvanceInput.disabled = true;
      setStatus('부분 선택된 좌석을 안전하게 해제하는 중입니다.');

      var cleared = await clearOfficialSelection(token, 'stopping');
      if (!runIsActive(token, 'stopping')) {
        return;
      }
      if (!cleared) {
        selectionStopAction = '';
        forceDestroy();
        showSetupMessage(
          topDocument,
          '부분 선택 좌석을 자동으로 해제하지 못했습니다. 좌석 상태를 직접 확인한 뒤 다시 실행해 주세요.'
        );
        return;
      }
      var finalAction = selectionStopAction;
      selectionStopAction = '';
      if (finalAction === 'destroy') {
        forceDestroy();
        return;
      }
      returnToRecording();
      setStatus('부분 선택 좌석을 해제하고 감시를 멈췄습니다.');
    }

    function finishPendingUserAction(restored) {
      var action = pendingUserAction;
      pendingUserAction = '';
      if (action === 'destroy') {
        forceDestroy();
        return true;
      }
      if (action === 'recording') {
        returnToRecording();
        if (restored) {
          setStatus('관람 인원을 복원하고 감시를 멈췄습니다.');
        }
        return true;
      }
      return false;
    }

    function requestPublicDestroy() {
      if (destroyed) {
        return true;
      }
      if (refreshInFlight || mode === 'selecting' || mode === 'stopping') {
        requestDestroy();
        return false;
      }
      forceDestroy();
      return true;
    }

    function forceDestroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      generation += 1;
      mode = 'destroyed';
      refreshInFlight = false;
      pendingUserAction = '';
      selectionStopAction = '';
      clearPollTimer();
      if (validationTimer !== null) {
        root.clearTimeout(validationTimer);
        validationTimer = null;
      }
      seatDocument.removeEventListener('click', captureSeatClick, true);
      seatFrame.removeEventListener('load', queueObserverWork);
      root.removeEventListener('popstate', queueObserverWork);
      root.removeEventListener('hashchange', queueObserverWork);
      if (topObserver) {
        topObserver.disconnect();
      }
      if (seatObserver) {
        seatObserver.disconnect();
      }
      restoreSeatDisabledState();
      findSeatButtons(seatDocument).forEach(function removeCurrentMarker(button) {
        button.removeAttribute(PRIORITY_ATTRIBUTE);
        button.removeAttribute(WAS_DISABLED_ATTRIBUTE);
      });
      if (seatStyleElement) {
        seatStyleElement.remove();
      }
      if (topStyleElement) {
        topStyleElement.remove();
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
      topStyleElement = injectTopStyle(topDocument);
      seatStyleElement = injectSeatStyle(seatDocument);
      createPanel();
      seatDocument.addEventListener('click', captureSeatClick, true);
      prepareRecordingSeats();
      observeSession();
    }

    var controller = {
      destroy: requestPublicDestroy,
      get mode() {
        return mode;
      },
      get preferences() {
        return preferences.slice();
      }
    };

    return { controller: controller, start: start };
  }

  function showSetupMessage(document, message) {
    var oldPanel = document.getElementById(PANEL_ID);
    if (oldPanel) {
      oldPanel.remove();
    }
    injectTopStyle(document);
    var panel = createElement(document, 'aside');
    panel.id = PANEL_ID;
    panel.appendChild(createElement(document, 'strong', '', 'Megabox Bot'));
    panel.appendChild(createElement(document, 'div', 'megabox-bot-status', message));
    var closeButton = createElement(document, 'button', 'megabox-bot-secondary', '닫기');
    closeButton.type = 'button';
    closeButton.addEventListener('click', function closeMessage() {
      panel.remove();
      var style = document.getElementById(TOP_STYLE_ID);
      if (style) {
        style.remove();
      }
    });
    panel.appendChild(closeButton);
    document.body.appendChild(panel);
  }

  function run(root) {
    var topDocument = root && root.document;
    if (!topDocument || !topDocument.body) {
      return null;
    }

    if (root[BOT_KEY] && root[BOT_KEY].destroy) {
      var previousController = root[BOT_KEY];
      if (previousController.destroy() === false) {
        return previousController;
      }
    }

    var hostname = String(root.location && root.location.hostname || '');
    if (!/(^|\.)megabox\.co\.kr$/i.test(hostname)) {
      showSetupMessage(topDocument, '메가박스 예매 페이지에서 실행해 주세요.');
      return null;
    }
    if (!/^\/booking(?:\/|$)/.test(String(root.location && root.location.pathname || ''))) {
      showSetupMessage(topDocument, '메가박스의 예매 페이지를 연 뒤 실행해 주세요.');
      return null;
    }

    var seatFrame = topDocument.querySelector(FRAME_SELECTOR);
    var seatDocument = seatDocumentFromFrame(seatFrame);
    var targetCount = seatDocument ? readTargetCount(seatDocument) : 0;
    var playSchdlNo = seatDocument ? inputValue(seatDocument, 'playSchdlNo') : '';
    var brchNo = seatDocument ? inputValue(seatDocument, 'brchNo') : '';
    if (
      !seatFrame ||
      !isVisible(root, seatFrame) ||
      !seatDocument ||
      !seatDocument.body ||
      !findSeatButtons(seatDocument).length ||
      !targetCount ||
      !playSchdlNo ||
      !brchNo
    ) {
      showSetupMessage(
        topDocument,
        '영화와 상영 시간을 고르고 관람 인원을 선택해 좌석 선택 단계를 연 뒤 다시 실행해 주세요.'
      );
      return null;
    }

    var instance = createController(
      root,
      topDocument,
      seatFrame,
      seatDocument,
      targetCount,
      playSchdlNo,
      brchNo,
      readBookingFingerprint(seatDocument)
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
    readTicketCounts: readTicketCounts,
    run: run,
    sameSeatSet: sameSeatSet,
    seatFromButton: seatFromButton
  };
});
