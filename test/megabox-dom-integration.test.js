const assert = require('node:assert/strict');
const test = require('node:test');

const { JSDOM } = require('jsdom');

const { readBookingFingerprint, run } = require('../megabox-bookmarklet');

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function seatSpec(number, options = {}) {
  return {
    locNo: options.locNo ?? `001001${String(number).padStart(2, '0')}`,
    row: options.row ?? 'A',
    number,
    groupNo: options.groupNo ?? '2',
    groupName: options.groupName ?? 'A2',
    groupSeq: options.groupSeq ?? number,
    seatToCnt: options.seatToCnt ?? 1,
    className: options.className ?? '',
    disabled: options.disabled ?? false,
    classCode: options.classCode ?? 'NORMAL',
    zoneCode: options.zoneCode ?? 'STANDARD',
  };
}

function createBookingPage(options = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><iframe id="frameBokdMSeat"></iframe></body></html>', {
    url: options.url ?? 'https://www.megabox.co.kr/booking',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const topDocument = window.document;
  const frame = topDocument.querySelector('#frameBokdMSeat');
  frame.getClientRects = () => [{ width: 1000, height: 700 }];

  const seatDocument = frame.contentDocument;
  seatDocument.open();
  seatDocument.write(`<!doctype html><html><head></head><body>
    <input id="playSchdlNo" value="20260811-1010">
    <input id="brchNo" value="1372">
    <input id="movieNo" value="23000100">
    <input id="playDe" value="20260811">
    <input id="playStartTime" value="1010">
    <div id="counts"></div>
    <button id="seatMemberCntInit" type="button">초기화</button>
    <div id="seat-map"></div>
    <a id="pageNext" href="#next">다음</a>
  </body></html>`);
  seatDocument.close();

  const state = {
    adult: options.adult ?? 2,
    youth: options.youth ?? 0,
    refreshClicks: 0,
    upClicks: { 성인: 0, 청소년: 0 },
    nextClicks: 0,
    officialSeatClicks: 0,
    renderCount: 0,
    specs: (options.seats ?? [seatSpec(1), seatSpec(2), seatSpec(3), seatSpec(4)])
      .map((spec) => ({ ...spec })),
  };

  function setSelected(button, selected) {
    button.classList.toggle('choice', selected);
    if (selected) {
      button.setAttribute('selected', 'selected');
    } else {
      button.removeAttribute('selected');
    }
  }

  function clearSelection() {
    seatDocument.querySelectorAll('button.seat-condition').forEach((button) => {
      setSelected(button, false);
      button.removeAttribute('seatnextuniqno');
    });
    seatDocument.querySelector('#pageNext').classList.remove('active');
  }

  function renderCounts(adult, youth) {
    state.adult = adult;
    state.youth = youth;
    const counts = seatDocument.createElement('div');
    counts.id = 'counts';
    counts.className = 'seat-count';
    counts.innerHTML = [
      ['성인', adult],
      ['청소년', youth],
    ].map(([category, count]) => `
      <div class="cell" data-category="${category}">
        <span class="txt">${category}</span>
        <button type="button" class="now" value="${count}">${count}</button>
        <button type="button" class="up">증가</button>
      </div>`).join('');
    seatDocument.querySelector('#counts').replaceWith(counts);

    counts.querySelectorAll('.cell').forEach((cell) => {
      const category = cell.querySelector('.txt').textContent;
      cell.querySelector('.up').addEventListener('click', () => {
        state.upClicks[category] += 1;
        const now = cell.querySelector('.now');
        const nextValue = Number(now.value) + 1;
        now.value = String(nextValue);
        now.textContent = String(nextValue);
        if (category === '성인') state.adult = nextValue;
        if (category === '청소년') state.youth = nextValue;
      });
    });
  }

  function renderSeats(specs = state.specs) {
    state.renderCount += 1;
    state.specs = specs.map((spec) => ({ ...spec }));
    const map = seatDocument.createElement('div');
    map.id = 'seat-map';
    map.innerHTML = state.specs.map((spec) => `
      <button type="button"
        class="seat-condition ${spec.className}"
        seatuniqno="${spec.locNo}"
        rownm="${spec.row}"
        seatno="${spec.number}"
        seatchoigrpno="${spec.groupNo}"
        seatchoigrpnm="${spec.groupName}"
        seatchoigrpseq="${spec.groupSeq}"
        seatchoirowcnt="${state.specs.length}"
        seattocnt="${spec.seatToCnt}"
        seatclasscd="${spec.classCode}"
        seatzonecd="${spec.zoneCode}"
        style="left:${spec.number * 20}px;top:40px;width:${20 * spec.seatToCnt}px"
        ${spec.disabled ? 'disabled' : ''}>${spec.row}${spec.number}</button>`).join('');
    seatDocument.querySelector('#seat-map').replaceWith(map);
    map.querySelectorAll('button.seat-condition').forEach((button) => {
      button.addEventListener('click', () => {
        state.officialSeatClicks += 1;
        if (options.onSeatClick) {
          options.onSeatClick({ button, seatDocument, state, setSelected, clearSelection });
        }
      });
    });
    return map;
  }

  renderCounts(state.adult, state.youth);
  renderSeats();

  const nativeWindowSetTimeout = window.setTimeout.bind(window);
  if (options.accelerate !== false) {
    window.setTimeout = (callback, delayMs, ...args) => nativeWindowSetTimeout(
      callback,
      delayMs >= 6000 ? (options.pollDelayCap ?? 1000) : Math.min(delayMs, 5),
      ...args,
    );
  }

  const refresh = seatDocument.querySelector('#seatMemberCntInit');
  refresh.addEventListener('click', () => {
    state.refreshClicks += 1;
    refresh.disabled = true;
    const performReset = () => {
      clearSelection();
      const nextSpecs = options.afterRefreshSeats
        ? options.afterRefreshSeats(state.specs.map((spec) => ({ ...spec })), state)
        : state.specs;
      if (!options.keepSeatNodesOnRefresh) {
        renderSeats(nextSpecs);
      }
      const finishCountReset = () => {
        renderCounts(0, 0);
        if (options.onRefresh) options.onRefresh({ seatDocument, state });
      };
      if (options.seatsBeforeCountsDelayMs != null) {
        setTimeout(finishCountReset, options.seatsBeforeCountsDelayMs);
      } else {
        finishCountReset();
      }
    };

    if (options.resetDelayMs != null) {
      setTimeout(performReset, options.resetDelayMs);
    } else {
      performReset();
    }
    setTimeout(() => {
      refresh.disabled = false;
    }, options.refreshEnableDelayMs ?? 30);
  });

  seatDocument.querySelector('#pageNext').addEventListener('click', (event) => {
    event.preventDefault();
    state.nextClicks += 1;
  });

  return {
    dom,
    window,
    topDocument,
    frame,
    seatDocument,
    state,
    renderSeats,
    renderCounts,
    setSelected,
    clearSelection,
  };
}

function panelButton(topDocument, text) {
  return [...topDocument.querySelectorAll('#megabox-bot-panel button')]
    .find((button) => button.textContent === text);
}

test('host and seat-step guards show a Megabox-specific setup panel', () => {
  const wrongHost = new JSDOM('<!doctype html><body></body>', {
    url: 'https://example.com/booking',
  });
  assert.equal(run(wrongHost.window), null);
  assert.match(wrongHost.window.document.querySelector('#megabox-bot-panel').textContent, /메가박스 예매 페이지/);
  assert.equal(wrongHost.window.document.querySelector('#cgv-bot-panel'), null);
  wrongHost.window.close();

  const noSeatStep = new JSDOM('<!doctype html><body></body>', {
    url: 'https://www.megabox.co.kr/booking',
  });
  assert.equal(run(noSeatStep.window), null);
  assert.match(noSeatStep.window.document.querySelector('#megabox-bot-panel').textContent, /좌석 선택 단계/);
  noSeatStep.window.close();
});

test('booking fingerprint ignores inventory/count rerenders but detects another schedule', () => {
  const page = createBookingPage();
  const initial = readBookingFingerprint(page.seatDocument);

  page.renderCounts(1, 0);
  page.renderSeats([seatSpec(1, { className: 'finish', disabled: true })]);
  assert.equal(readBookingFingerprint(page.seatDocument), initial);
  page.seatDocument.querySelector('#playSchdlNo').value = '20260811-1310';
  assert.notEqual(readBookingFingerprint(page.seatDocument), initial);
  page.dom.window.close();
});

test('recording captures sold preferences inside the iframe and restores both documents', () => {
  const page = createBookingPage({
    seats: [
      seatSpec(1),
      seatSpec(2, { className: 'finish', disabled: true }),
    ],
  });
  const { topDocument, seatDocument } = page;
  const controller = run(page.window);
  const a1 = seatDocument.querySelector('[seatuniqno="00100101"]');
  const soldA2 = seatDocument.querySelector('[seatuniqno="00100102"]');

  assert.ok(controller);
  assert.equal(controller.mode, 'recording');
  assert.ok(topDocument.querySelector('#megabox-bot-panel'));
  assert.ok(topDocument.querySelector('#megabox-bot-top-style'));
  assert.ok(seatDocument.querySelector('#megabox-bot-seat-style'));
  assert.equal(soldA2.disabled, false);

  soldA2.click();
  a1.click();

  assert.equal(page.state.officialSeatClicks, 0, 'capture phase blocks Megabox handlers');
  assert.deepEqual(
    controller.preferences.map(({ locNo, label, priority }) => ({ locNo, label, priority })),
    [
      { locNo: '00100102', label: 'A2', priority: 1 },
      { locNo: '00100101', label: 'A1', priority: 2 },
    ],
  );
  assert.equal(soldA2.getAttribute('data-megabox-bot-priority'), '1');
  assert.equal(a1.getAttribute('data-megabox-bot-priority'), '2');
  assert.equal(topDocument.querySelector('[data-megabox-bot-priority]'), null);

  controller.destroy();
  assert.equal(soldA2.disabled, true);
  assert.equal(soldA2.hasAttribute('data-megabox-bot-priority'), false);
  assert.equal(topDocument.querySelector('#megabox-bot-panel'), null);
  assert.equal(topDocument.querySelector('#megabox-bot-top-style'), null);
  assert.equal(seatDocument.querySelector('#megabox-bot-seat-style'), null);
  page.dom.window.close();
});

test('start stays disabled when preferred weighted seats cannot exactly fit the audience', () => {
  const page = createBookingPage({
    adult: 3,
    seats: [
      seatSpec(1, { seatToCnt: 2, classCode: 'SOFA' }),
      seatSpec(2, { seatToCnt: 2, classCode: 'SOFA' }),
    ],
  });
  const controller = run(page.window);
  page.seatDocument.querySelector('[seatuniqno="00100101"]').click();
  page.seatDocument.querySelector('[seatuniqno="00100102"]').click();

  assert.equal(panelButton(page.topDocument, '감시 시작').disabled, true);
  assert.match(page.topDocument.querySelector('#megabox-bot-panel').textContent, /정확히 맞는/);
  controller.destroy();
  page.dom.window.close();
});

test('refresh preserves category counts and reapplies markers to regenerated seats', async () => {
  const page = createBookingPage({
    afterRefreshSeats: (specs) => specs.map((spec) => ({
      ...spec,
      className: 'finish',
      disabled: true,
    })),
  });
  const controller = run(page.window);
  const oldA1 = page.seatDocument.querySelector('[seatuniqno="00100101"]');
  const oldA2 = page.seatDocument.querySelector('[seatuniqno="00100102"]');
  oldA1.click();
  oldA2.click();
  panelButton(page.topDocument, '감시 시작').click();

  await delay(80);

  const newA1 = page.seatDocument.querySelector('[seatuniqno="00100101"]');
  assert.equal(page.state.refreshClicks, 1);
  assert.equal(oldA1.isConnected, false);
  assert.notEqual(newA1, oldA1);
  assert.equal(page.state.adult, 2);
  assert.equal(page.state.upClicks.성인, 2);
  assert.equal(newA1.getAttribute('data-megabox-bot-priority'), '1');
  assert.equal(page.seatDocument.querySelector('[seatuniqno="00100102"]')
    .getAttribute('data-megabox-bot-priority'), '2');
  assert.equal(controller.mode, 'polling');

  panelButton(page.topDocument, '감시 중지').click();
  controller.destroy();
  page.dom.window.close();
});

test('refresh waits for the regenerated ticket UI to reach zero before restoring counts', async () => {
  const page = createBookingPage({
    seatsBeforeCountsDelayMs: 35,
    afterRefreshSeats: (specs) => specs.map((spec) => ({
      ...spec,
      className: 'finish',
      disabled: true,
    })),
  });
  const controller = run(page.window);
  const oldA1 = page.seatDocument.querySelector('[seatuniqno="00100101"]');
  oldA1.click();
  page.seatDocument.querySelector('[seatuniqno="00100102"]').click();
  panelButton(page.topDocument, '감시 시작').click();

  await delay(15);
  assert.equal(oldA1.isConnected, false, 'seat nodes can arrive before the reset count UI');
  assert.equal(page.state.adult, 2);
  assert.equal(page.state.upClicks.성인, 0, 'restoration has not raced the delayed reset');

  await delay(80);
  assert.equal(page.state.adult, 2);
  assert.equal(page.state.upClicks.성인, 2);
  assert.equal(controller.mode, 'polling');
  panelButton(page.topDocument, '감시 중지').click();
  controller.destroy();
  page.dom.window.close();
});

test('refresh lifecycle also supports an in-place seat map once ticket counts reset to zero', async () => {
  const page = createBookingPage({
    keepSeatNodesOnRefresh: true,
    afterRefreshSeats: undefined,
  });
  const controller = run(page.window);
  const originalA1 = page.seatDocument.querySelector('[seatuniqno="00100101"]');
  originalA1.click();
  page.seatDocument.querySelector('[seatuniqno="00100102"]').click();
  panelButton(page.topDocument, '감시 시작').click();

  await delay(80);

  assert.equal(originalA1.isConnected, true);
  assert.equal(page.seatDocument.querySelector('[seatuniqno="00100101"]'), originalA1);
  assert.equal(page.state.adult, 2);
  assert.equal(page.state.upClicks.성인, 2);
  assert.equal(page.state.officialSeatClicks > 0, true, 'selection can continue after in-place refresh');
  controller.destroy();
  await delay(20);
  page.dom.window.close();
});

test('official multi-person selection is verified exactly before advancing', async () => {
  const page = createBookingPage({
    onSeatClick({ button, seatDocument, setSelected, clearSelection }) {
      if (button.hasAttribute('selected')) {
        clearSelection();
        return;
      }
      if (button.getAttribute('seatuniqno') === '00100101') {
        const a1 = seatDocument.querySelector('[seatuniqno="00100101"]');
        const a2 = seatDocument.querySelector('[seatuniqno="00100102"]');
        setSelected(a1, true);
        setSelected(a2, true);
        a1.setAttribute('seatnextuniqno', '00100102');
        a2.setAttribute('seatnextuniqno', '00100101');
        seatDocument.querySelector('#pageNext').classList.add('active');
      }
    },
  });
  const controller = run(page.window);
  page.seatDocument.querySelector('[seatuniqno="00100101"]').click();
  page.seatDocument.querySelector('[seatuniqno="00100102"]').click();
  panelButton(page.topDocument, '감시 시작').click();

  await delay(100);

  assert.equal(controller.mode, 'success');
  assert.equal(page.state.officialSeatClicks, 1);
  assert.equal(page.state.nextClicks, 1);
  assert.deepEqual(
    [...page.seatDocument.querySelectorAll('button.choice')]
      .map((button) => button.getAttribute('seatuniqno')),
    ['00100101', '00100102'],
  );
  controller.destroy();
  page.dom.window.close();
});

test('safe anchor orders reject an outside auto-seat and avoid toggling a planned choice', async () => {
  const clickLog = [];
  const page = createBookingPage({
    onSeatClick({ button, seatDocument, setSelected, clearSelection }) {
      const locNo = button.getAttribute('seatuniqno');
      clickLog.push({ locNo, wasSelected: button.hasAttribute('selected') });
      if (button.hasAttribute('selected')) {
        clearSelection();
        return;
      }
      if (locNo === '00100102') {
        setSelected(seatDocument.querySelector('[seatuniqno="00100101"]'), true);
        setSelected(seatDocument.querySelector('[seatuniqno="00100102"]'), true);
      } else if (locNo === '00100103') {
        setSelected(seatDocument.querySelector('[seatuniqno="00100102"]'), true);
        setSelected(seatDocument.querySelector('[seatuniqno="00100103"]'), true);
        seatDocument.querySelector('#pageNext').classList.add('active');
      } else {
        clearSelection();
      }
    },
  });
  const controller = run(page.window);
  page.seatDocument.querySelector('[seatuniqno="00100102"]').click();
  page.seatDocument.querySelector('[seatuniqno="00100103"]').click();
  panelButton(page.topDocument, '감시 시작').click();

  await delay(140);

  assert.equal(controller.mode, 'success');
  assert.equal(page.state.nextClicks, 1);
  assert.equal(
    clickLog.some(({ locNo, wasSelected }) => locNo === '00100102' && wasSelected),
    false,
    'the auto-selected desired partner is never toggled back off',
  );
  assert.deepEqual(
    [...page.seatDocument.querySelectorAll('button.choice')]
      .map((button) => button.getAttribute('seatuniqno')),
    ['00100102', '00100103'],
  );
  controller.destroy();
  page.dom.window.close();
});

test('three-person selection accumulates safe official clicks instead of toggling the auto-pair', async () => {
  const clickLog = [];
  const page = createBookingPage({
    adult: 3,
    onSeatClick({ button, seatDocument, setSelected, clearSelection }) {
      const locNo = button.getAttribute('seatuniqno');
      clickLog.push({ locNo, wasSelected: button.hasAttribute('selected') });
      if (button.hasAttribute('selected')) {
        clearSelection();
        return;
      }
      if (locNo === '00100101') {
        setSelected(seatDocument.querySelector('[seatuniqno="00100101"]'), true);
        setSelected(seatDocument.querySelector('[seatuniqno="00100102"]'), true);
      } else if (locNo === '00100103') {
        setSelected(button, true);
      }
      if (seatDocument.querySelectorAll('button.choice').length === 3) {
        seatDocument.querySelector('#pageNext').classList.add('active');
      }
    },
  });
  const controller = run(page.window);
  for (const number of [1, 2, 3]) {
    page.seatDocument.querySelector(`[seatuniqno="0010010${number}"]`).click();
  }
  panelButton(page.topDocument, '감시 시작').click();

  await delay(140);

  assert.equal(controller.mode, 'success');
  assert.equal(page.state.nextClicks, 1);
  assert.equal(clickLog.some(({ locNo }) => locNo === '00100102'), false);
  assert.deepEqual(clickLog.map(({ locNo }) => locNo), ['00100101', '00100103']);
  controller.destroy();
  page.dom.window.close();
});

test('stopping during selection clears the partial official choice before recording resumes', async () => {
  let resolvePartialSelection;
  const partialSelection = new Promise((resolve) => {
    resolvePartialSelection = resolve;
  });
  const page = createBookingPage({
    onSeatClick({ button, setSelected, clearSelection }) {
      if (button.hasAttribute('selected')) {
        clearSelection();
        return;
      }
      setSelected(button, true);
      resolvePartialSelection();
    },
  });
  const controller = run(page.window);
  page.seatDocument.querySelector('[seatuniqno="00100101"]').click();
  page.seatDocument.querySelector('[seatuniqno="00100102"]').click();
  panelButton(page.topDocument, '감시 시작').click();

  await partialSelection;
  panelButton(page.topDocument, '선택 중지').click();
  await delay(40);

  assert.equal(controller.mode, 'recording');
  assert.equal(page.seatDocument.querySelectorAll('button.choice').length, 0);
  assert.equal(page.state.nextClicks, 0);
  assert.equal(panelButton(page.topDocument, '종료').disabled, false);
  controller.destroy();
  page.dom.window.close();
});

test('auto-advance can be disabled and never clicks the next link', async () => {
  const page = createBookingPage({
    adult: 1,
    onSeatClick({ button, seatDocument, setSelected }) {
      setSelected(button, true);
      seatDocument.querySelector('#pageNext').classList.add('active');
    },
  });
  const controller = run(page.window);
  page.seatDocument.querySelector('[seatuniqno="00100101"]').click();
  const checkbox = page.topDocument.querySelector('#megabox-bot-panel input[type="checkbox"]');
  assert.equal(checkbox.checked, true);
  checkbox.checked = false;
  panelButton(page.topDocument, '감시 시작').click();

  await delay(100);

  assert.equal(controller.mode, 'success');
  assert.equal(page.state.nextClicks, 0);
  assert.match(page.topDocument.querySelector('#megabox-bot-panel').textContent, /직접 눌러/);
  controller.destroy();
  page.dom.window.close();
});

test('stopping during reset first restores the audience count, then invalidates selection work', async () => {
  const page = createBookingPage({
    adult: 1,
    resetDelayMs: 35,
    onSeatClick({ button, setSelected }) {
      setSelected(button, true);
    },
  });
  const controller = run(page.window);
  page.seatDocument.querySelector('[seatuniqno="00100101"]').click();
  const start = panelButton(page.topDocument, '감시 시작');
  start.click();
  await delay(10);
  panelButton(page.topDocument, '감시 중지').click();
  await delay(70);

  assert.equal(controller.mode, 'recording');
  assert.equal(page.state.upClicks.성인, 1);
  assert.equal(page.state.officialSeatClicks, 0);
  assert.equal(page.state.adult, 1);
  assert.match(page.topDocument.querySelector('#megabox-bot-panel').textContent, /관람 인원을 복원하고 감시를 멈췄습니다/);
  controller.destroy();
  page.dom.window.close();
});

test('panel exit during reset defers cleanup until the audience count is restored', async () => {
  const page = createBookingPage({
    adult: 1,
    resetDelayMs: 35,
  });
  const controller = run(page.window);
  page.seatDocument.querySelector('[seatuniqno="00100101"]').click();
  panelButton(page.topDocument, '감시 시작').click();
  await delay(10);
  panelButton(page.topDocument, '종료').click();

  assert.equal(controller.mode, 'polling');
  assert.ok(page.topDocument.querySelector('#megabox-bot-panel'));
  await delay(70);

  assert.equal(page.state.adult, 1);
  assert.equal(page.state.upClicks.성인, 1);
  assert.equal(page.state.officialSeatClicks, 0);
  assert.equal(controller.mode, 'destroyed');
  assert.equal(page.topDocument.querySelector('#megabox-bot-panel'), null);
  page.dom.window.close();
});

test('public destroy and a repeated run defer replacement during an in-flight refresh', async () => {
  const page = createBookingPage({
    adult: 1,
    resetDelayMs: 35,
  });
  const controller = run(page.window);
  page.seatDocument.querySelector('[seatuniqno="00100101"]').click();
  panelButton(page.topDocument, '감시 시작').click();
  await delay(10);

  assert.equal(controller.destroy(), false);
  assert.equal(run(page.window), controller, 'a second instance is not created during deferred cleanup');
  assert.equal(page.topDocument.querySelectorAll('#megabox-bot-panel').length, 1);
  await delay(70);

  assert.equal(page.state.adult, 1);
  assert.equal(page.state.upClicks.성인, 1);
  assert.equal(controller.mode, 'destroyed');
  assert.equal(page.topDocument.querySelector('#megabox-bot-panel'), null);
  page.dom.window.close();
});

test('repeated refresh restoration failure destroys the adapter with actionable setup guidance', async () => {
  const page = createBookingPage({
    adult: 1,
    pollDelayCap: 5,
    onRefresh({ seatDocument }) {
      seatDocument.querySelectorAll('.seat-count button.up').forEach((button) => button.remove());
    },
  });
  const controller = run(page.window);
  page.seatDocument.querySelector('[seatuniqno="00100101"]').click();
  panelButton(page.topDocument, '감시 시작').click();
  await delay(160);

  assert.equal(controller.mode, 'destroyed');
  assert.match(
    page.topDocument.querySelector('#megabox-bot-panel').textContent,
    /관람 인원 복원|인원을 다시 선택/,
  );
  assert.equal(page.state.officialSeatClicks, 0);
  page.dom.window.close();
});

test('replacing or hiding the original seat iframe invalidates the controller', async () => {
  const replaced = createBookingPage();
  const replacedController = run(replaced.window);
  const newFrame = replaced.topDocument.createElement('iframe');
  newFrame.id = 'frameBokdMSeat';
  replaced.frame.replaceWith(newFrame);
  await delay(20);
  assert.equal(replacedController.mode, 'destroyed');
  assert.equal(replaced.topDocument.querySelector('#megabox-bot-panel'), null);
  replaced.dom.window.close();

  const hidden = createBookingPage();
  const hiddenController = run(hidden.window);
  hidden.frame.style.display = 'none';
  await delay(20);
  assert.equal(hiddenController.mode, 'destroyed');
  assert.equal(hidden.topDocument.querySelector('#megabox-bot-panel'), null);
  hidden.dom.window.close();
});
