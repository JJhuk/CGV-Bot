const assert = require('node:assert/strict');
const test = require('node:test');

const { JSDOM } = require('jsdom');

const { readBookingFingerprint, run } = require('../bookmarklet');

function createSeatPage() {
  const dom = new JSDOM(`<!doctype html>
    <html>
      <head></head>
      <body>
        <main role="region">
        <h2>스파이더맨-브랜드 뉴 데이</h2>
        <p>2026.08.07 (금) 오늘</p>
        <p>강남 5관 (Laser) 2D</p>
        <div role="group">
          <div id="number-choice-label">일반</div>
          <button aria-label="1 선택" aria-pressed="false">1</button>
          <button aria-label="2 선택" aria-pressed="true">2</button>
        </div>
        <button type="button" title="새로고침">새로고침</button>
        <button type="button" aria-pressed="true" aria-label="상영 시간 09:10부터 11:45까지, 141석 남음">09:10</button>
        <div role="dialog">
          <section aria-label="좌석선택 지도">
            <div class="rzpp-mini-map">
              <button data-seatlocno="a3">A3</button>
              <button data-seatlocno="a4" disabled>A4</button>
            </div>
            <div class="react-transform-component">
              <button data-seatlocno="a3" style="left:114px;top:38px;width:38px">A3</button>
              <button data-seatlocno="a4" class="seatMap_seatDisabled__hash" disabled style="left:152px;top:38px;width:38px">A4</button>
            </div>
          </section>
          <button type="button" disabled>선택완료</button>
        </div>
        <button type="button" disabled>0원&nbsp;결제하기</button>
        </main>
      </body>
    </html>`, {
    url: 'https://cgv.co.kr/cnm/selectVisitorCnt',
  });

  const dialog = dom.window.document.querySelector('[role="dialog"]');
  dialog.getClientRects = () => [{ width: 600, height: 800 }];
  return dom;
}

test('booking fingerprint ignores changing inventory but detects another showtime', () => {
  const dom = createSeatPage();
  const document = dom.window.document;
  const schedule = document.querySelector('button[aria-label^="상영 시간 "]');
  const initial = readBookingFingerprint(document);

  schedule.setAttribute('aria-label', '상영 시간 09:10부터 11:45까지, 95석 남음');
  assert.equal(readBookingFingerprint(document), initial);
  const countButtons = document.querySelectorAll('[role="group"] button');
  countButtons[0].setAttribute('aria-pressed', 'true');
  countButtons[1].setAttribute('aria-pressed', 'false');
  assert.equal(readBookingFingerprint(document), initial);
  schedule.setAttribute('aria-label', '상영 시간 12:20부터 14:55까지, 95석 남음');
  assert.notEqual(readBookingFingerprint(document), initial);
  dom.window.close();
});

test('recording mode updates its required preference count when visitors change', async () => {
  const dom = createSeatPage();
  const { window } = dom;
  const document = window.document;
  const a3 = document.querySelector('.react-transform-component button[data-seatlocno="a3"]');
  const controller = run(window);
  a3.click();
  const startButton = [...document.querySelectorAll('#cgv-bot-panel button')]
    .find((button) => button.textContent === '감시 시작');
  assert.equal(startButton.disabled, true);

  const countButtons = document.querySelectorAll('[role="group"] button');
  countButtons[0].setAttribute('aria-pressed', 'true');
  countButtons[1].setAttribute('aria-pressed', 'false');
  await new Promise((resolve) => window.setTimeout(resolve, 20));

  assert.equal(controller.mode, 'recording');
  assert.equal(startButton.disabled, false);
  controller.destroy();
  dom.window.close();
});

test('recording mode captures sold-seat preferences and restores CGV DOM on exit', () => {
  const dom = createSeatPage();
  const { window } = dom;
  const document = window.document;
  const mainSeats = document.querySelectorAll('.react-transform-component button[data-seatlocno]');
  const a3 = mainSeats[0];
  const soldA4 = mainSeats[1];
  let cgvClickCount = 0;
  soldA4.addEventListener('click', () => {
    cgvClickCount += 1;
  });

  const controller = run(window);

  assert.ok(controller);
  assert.equal(controller.mode, 'recording');
  assert.equal(document.querySelectorAll('#cgv-bot-panel').length, 1);
  assert.equal(soldA4.disabled, false, 'sold seats are temporarily clickable only in preference mode');
  assert.equal(
    document.querySelector('.rzpp-mini-map button[data-seatlocno="a4"]').disabled,
    true,
    'mini-map duplicates are not modified',
  );

  soldA4.click();
  a3.click();

  assert.equal(cgvClickCount, 0, 'captured preference clicks do not reach CGV handlers');
  assert.deepEqual(
    controller.preferences.map(({ locNo, label, priority }) => ({ locNo, label, priority })),
    [
      { locNo: 'a4', label: 'A4', priority: 1 },
      { locNo: 'a3', label: 'A3', priority: 2 },
    ],
  );
  assert.equal(soldA4.getAttribute('data-cgv-bot-priority'), '1');
  assert.equal(a3.getAttribute('data-cgv-bot-priority'), '2');

  controller.destroy();

  assert.equal(soldA4.disabled, true);
  assert.equal(a3.disabled, false);
  assert.equal(soldA4.hasAttribute('data-cgv-bot-priority'), false);
  assert.equal(document.querySelector('#cgv-bot-panel'), null);
  assert.equal(document.querySelector('#cgv-bot-style'), null);
  dom.window.close();
});

test('exit restores the latest CGV availability when the same seat node changed', () => {
  const dom = createSeatPage();
  const { window } = dom;
  const document = window.document;
  const seats = document.querySelectorAll('.react-transform-component button[data-seatlocno]');
  const availableA3 = seats[0];
  const soldA4 = seats[1];
  const controller = run(window);

  soldA4.className = 'seatMap_seatNumber__hash seatMap_seatNormal__hash';
  soldA4.disabled = false;
  availableA3.className = 'seatMap_seatNumber__hash seatMap_seatNormal__hash seatMap_seatComplete__hash';
  availableA3.disabled = true;
  controller.destroy();

  assert.equal(soldA4.disabled, false, 'newly available same-node seat stays available');
  assert.equal(availableA3.disabled, true, 'newly completed same-node seat stays unavailable');
  dom.window.close();
});

test('replacing only the seat map inside the same dialog keeps recording active', async () => {
  const dom = createSeatPage();
  const { window } = dom;
  const document = window.document;
  const controller = run(window);
  const dialog = document.querySelector('[role="dialog"]');
  const oldMap = dialog.querySelector('section[aria-label="좌석선택 지도"]');
  const newMap = document.createElement('section');
  newMap.setAttribute('aria-label', '좌석선택 지도');
  newMap.innerHTML = `
    <div class="react-transform-component">
      <button data-seatlocno="a3" style="left:114px;top:38px;width:38px">A3</button>
      <button data-seatlocno="a4" class="seatMap_seatDisabled__hash" disabled style="left:152px;top:38px;width:38px">A4</button>
    </div>`;
  oldMap.replaceWith(newMap);
  await new Promise((resolve) => window.setTimeout(resolve, 20));

  assert.equal(controller.mode, 'recording');
  assert.equal(newMap.querySelector('button[data-seatlocno="a4"]').disabled, false);
  controller.destroy();
  dom.window.close();
});

test('stopping during refresh invalidates the pending async selection run', async () => {
  const dom = createSeatPage();
  const { window } = dom;
  const document = window.document;
  const countButtons = document.querySelectorAll('[role="group"] button');
  countButtons[0].setAttribute('aria-pressed', 'true');
  countButtons[1].setAttribute('aria-pressed', 'false');

  const a3 = document.querySelector('.react-transform-component button[data-seatlocno="a3"]');
  let officialSeatClicks = 0;
  a3.addEventListener('click', () => {
    officialSeatClicks += 1;
  });

  const controller = run(window);
  a3.click();
  const startButton = [...document.querySelectorAll('#cgv-bot-panel button')]
    .find((button) => button.textContent === '감시 시작');
  startButton.click();

  await new Promise((resolve) => window.setTimeout(resolve, 50));
  startButton.click();
  await new Promise((resolve) => window.setTimeout(resolve, 1300));

  assert.equal(controller.mode, 'recording');
  assert.equal(officialSeatClicks, 0);
  controller.destroy();
  dom.window.close();
});

test('destroying during refresh prevents all delayed CGV clicks', async () => {
  const dom = createSeatPage();
  const { window } = dom;
  const document = window.document;
  const countButtons = document.querySelectorAll('[role="group"] button');
  countButtons[0].setAttribute('aria-pressed', 'true');
  countButtons[1].setAttribute('aria-pressed', 'false');

  const a3 = document.querySelector('.react-transform-component button[data-seatlocno="a3"]');
  let officialSeatClicks = 0;
  a3.addEventListener('click', () => {
    officialSeatClicks += 1;
  });

  const controller = run(window);
  a3.click();
  const startButton = [...document.querySelectorAll('#cgv-bot-panel button')]
    .find((button) => button.textContent === '감시 시작');
  startButton.click();

  await new Promise((resolve) => window.setTimeout(resolve, 50));
  controller.destroy();
  await new Promise((resolve) => window.setTimeout(resolve, 1300));

  assert.equal(controller.mode, 'destroyed');
  assert.equal(officialSeatClicks, 0);
  assert.equal(document.querySelector('#cgv-bot-panel'), null);
  dom.window.close();
});

test('replacing the seat dialog on the same route invalidates old preferences', async () => {
  const dom = createSeatPage();
  const { window } = dom;
  const document = window.document;
  const countButtons = document.querySelectorAll('[role="group"] button');
  countButtons[0].setAttribute('aria-pressed', 'true');
  countButtons[1].setAttribute('aria-pressed', 'false');

  const oldA3 = document.querySelector('.react-transform-component button[data-seatlocno="a3"]');
  const controller = run(window);
  oldA3.click();
  const startButton = [...document.querySelectorAll('#cgv-bot-panel button')]
    .find((button) => button.textContent === '감시 시작');
  startButton.click();

  await new Promise((resolve) => window.setTimeout(resolve, 50));
  const oldDialog = document.querySelector('[role="dialog"]');
  const newDialog = document.createElement('div');
  newDialog.setAttribute('role', 'dialog');
  newDialog.innerHTML = `
    <section aria-label="좌석선택 지도">
      <div class="react-transform-component">
        <button data-seatlocno="a3" style="left:114px;top:38px;width:38px">A3</button>
      </div>
    </section>
    <button type="button">선택완료</button>`;
  newDialog.getClientRects = () => [{ width: 600, height: 800 }];
  oldDialog.replaceWith(newDialog);

  let wrongSessionClicks = 0;
  newDialog.querySelector('button[data-seatlocno]').addEventListener('click', () => {
    wrongSessionClicks += 1;
  });
  await new Promise((resolve) => window.setTimeout(resolve, 1300));

  assert.equal(controller.mode, 'destroyed');
  assert.equal(wrongSessionClicks, 0);
  assert.equal(document.querySelector('#cgv-bot-panel'), null);
  dom.window.close();
});

test('the DOM adapter selects, confirms, and advances through CGV click handlers', async () => {
  const dom = createSeatPage();
  const { window } = dom;
  const document = window.document;
  const nativeSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = (callback, delay, ...args) =>
    nativeSetTimeout(callback, Math.min(delay, 10), ...args);

  const countButtons = document.querySelectorAll('[role="group"] button');
  countButtons[0].setAttribute('aria-pressed', 'true');
  countButtons[1].setAttribute('aria-pressed', 'false');
  const a3 = document.querySelector('.react-transform-component button[data-seatlocno="a3"]');
  const complete = [...document.querySelectorAll('button')]
    .find((button) => button.textContent === '선택완료');
  const payment = [...document.querySelectorAll('button')]
    .find((button) => button.textContent.includes('결제하기'));
  let officialSeatClicks = 0;
  let completeClicks = 0;
  let paymentClicks = 0;

  a3.addEventListener('click', () => {
    officialSeatClicks += 1;
    a3.setAttribute('title', '선택됨');
    complete.disabled = false;
  });
  complete.addEventListener('click', () => {
    completeClicks += 1;
    payment.disabled = false;
    document.querySelector('[role="dialog"]').remove();
  });
  payment.addEventListener('click', () => {
    paymentClicks += 1;
  });

  const controller = run(window);
  a3.click();
  const startButton = [...document.querySelectorAll('#cgv-bot-panel button')]
    .find((button) => button.textContent === '감시 시작');
  startButton.click();
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(officialSeatClicks, 1);
  assert.equal(completeClicks, 1);
  assert.equal(paymentClicks, 1);
  assert.equal(controller.mode, 'destroyed');
  assert.equal(document.querySelector('#cgv-bot-panel'), null);
  dom.window.close();
});

test('three unhandled programmatic seat clicks stop instead of retrying forever', async () => {
  const dom = createSeatPage();
  const { window } = dom;
  const document = window.document;
  const nativeSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = (callback, delay, ...args) =>
    nativeSetTimeout(callback, Math.min(delay, 10), ...args);

  const countButtons = document.querySelectorAll('[role="group"] button');
  countButtons[0].setAttribute('aria-pressed', 'true');
  countButtons[1].setAttribute('aria-pressed', 'false');
  const a3 = document.querySelector('.react-transform-component button[data-seatlocno="a3"]');
  let unhandledClicks = 0;
  a3.addEventListener('click', () => {
    unhandledClicks += 1;
  });

  const controller = run(window);
  a3.click();
  const startButton = [...document.querySelectorAll('#cgv-bot-panel button')]
    .find((button) => button.textContent === '감시 시작');
  startButton.click();
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal(controller.mode, 'recording');
  assert.equal(unhandledClicks, 3);
  assert.match(
    document.querySelector('#cgv-bot-panel').textContent,
    /프로그램 좌석 클릭을 반영하지 않아 감시를 멈췄습니다/,
  );
  controller.destroy();
  dom.window.close();
});

test('five refresh failures stop and keep the actionable error visible', async () => {
  const dom = createSeatPage();
  const { window } = dom;
  const document = window.document;
  const nativeSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = (callback, delay, ...args) =>
    nativeSetTimeout(callback, Math.min(delay, 10), ...args);

  const countButtons = document.querySelectorAll('[role="group"] button');
  countButtons[0].setAttribute('aria-pressed', 'true');
  countButtons[1].setAttribute('aria-pressed', 'false');
  const a3 = document.querySelector('.react-transform-component button[data-seatlocno="a3"]');
  const controller = run(window);
  a3.click();
  document.querySelector('button[title="새로고침"]').remove();
  const startButton = [...document.querySelectorAll('#cgv-bot-panel button')]
    .find((button) => button.textContent === '감시 시작');
  startButton.click();
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(controller.mode, 'recording');
  assert.match(
    document.querySelector('#cgv-bot-panel').textContent,
    /좌석 새로고침에 연속으로 실패했습니다: 새로고침 버튼을 찾지 못했습니다/,
  );
  controller.destroy();
  dom.window.close();
});
