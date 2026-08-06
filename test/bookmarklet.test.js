const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const {
  areAdjacent,
  chooseBestGroup,
  normalizeSeatLabel,
  parseSeatLabel,
  readTargetCount,
  sameSeatSet,
  seatFromButton,
} = require('../bookmarklet');

test('CommonJS exports work even when a test environment installed window first', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'bookmarklet.js'), 'utf8');
  const context = {
    globalThis: { window: {} },
    module: { exports: {} },
    window: {},
  };

  vm.runInNewContext(source, context);

  assert.equal(typeof context.module.exports.run, 'function');
  assert.equal(typeof context.module.exports.chooseBestGroup, 'function');
});

function seat(locNo, label, left, options = {}) {
  const parsed = parseSeatLabel(label);
  return {
    locNo,
    label: parsed.label,
    row: parsed.row,
    number: parsed.number,
    left,
    top: options.top ?? 38,
    width: options.width ?? 38,
    type: options.type ?? 'normal',
    disabled: options.disabled ?? false,
  };
}

test('seat labels ignore the linked-seat screen-reader prefix', () => {
  assert.equal(normalizeSeatLabel(' 연접좌석\nL12 '), 'L12');
  assert.deepEqual(parseSeatLabel('AA10'), {
    label: 'AA10',
    row: 'AA',
    number: 10,
  });
  assert.equal(Number.isNaN(parseSeatLabel('통로').number), true);
});

test('adjacency requires the same row, type, sequence, and physical position', () => {
  const a3 = seat('a3', 'A3', 114);

  assert.equal(areAdjacent(a3, seat('a4', 'A4', 152)), true);
  assert.equal(areAdjacent(a3, seat('b4', 'B4', 152)), false);
  assert.equal(areAdjacent(a3, seat('a5', 'A5', 152)), false);
  assert.equal(areAdjacent(a3, seat('a4-gap', 'A4', 190)), false);
  assert.equal(
    areAdjacent(a3, seat('a4-sweetbox', 'A4', 152, { type: 'sweetbox' })),
    false,
  );
});

test('different CGV special-seat classes never form one contiguous group', () => {
  const beanbag = seat('a3', 'A3', 114, { type: 'beanbag' });
  const nextBeanbag = seat('a4', 'A4', 152, { type: 'beanbag' });
  const recliner = seat('a4-recliner', 'A4', 152, { type: 'recliner' });

  assert.equal(areAdjacent(beanbag, nextBeanbag), true);
  assert.equal(areAdjacent(beanbag, recliner), false);
});

test('the highest-priority available contiguous group is selected', () => {
  const seats = [
    seat('a3', 'A3', 114),
    seat('a4', 'A4', 152),
    seat('a5', 'A5', 190),
    seat('a6', 'A6', 228),
  ];
  const preferences = [
    { locNo: 'a5', priority: 1 },
    { locNo: 'a6', priority: 2 },
    { locNo: 'a3', priority: 3 },
    { locNo: 'a4', priority: 4 },
  ];

  assert.deepEqual(
    chooseBestGroup(preferences, seats, 2).map((item) => item.locNo),
    ['a5', 'a6'],
  );
});

test('sold seats and aisle gaps cannot form a candidate group', () => {
  const preferences = ['a3', 'a4', 'a5', 'a6'];
  const seats = [
    seat('a3', 'A3', 114),
    seat('a4', 'A4', 152, { disabled: true }),
    seat('a5', 'A5', 228),
    seat('a6', 'A6', 266),
  ];

  assert.deepEqual(
    chooseBestGroup(preferences, seats, 2).map((item) => item.locNo),
    ['a5', 'a6'],
  );
  assert.deepEqual(chooseBestGroup(preferences, seats, 3), []);
});

test('single-seat selection follows preference priority, not map order', () => {
  const seats = [seat('a1', 'A1', 38), seat('a2', 'A2', 76)];

  assert.deepEqual(
    chooseBestGroup(['a2', 'a1'], seats, 1).map((item) => item.locNo),
    ['a2'],
  );
});

test('seat set comparison ignores order but rejects missing seats', () => {
  assert.equal(
    sameSeatSet([{ locNo: 'a3' }, { locNo: 'a4' }], [{ locNo: 'a4' }, { locNo: 'a3' }]),
    true,
  );
  assert.equal(sameSeatSet([{ locNo: 'a3' }], [{ locNo: 'a3' }, { locNo: 'a4' }]), false);
});

test('current CGV seat button attributes become normalized inventory', () => {
  const button = {
    className: 'seatMap_seatNumber__hash seatMap_seatNormal__hash seatMap_seatDisabled__hash',
    disabled: true,
    offsetHeight: 38,
    offsetLeft: 114,
    offsetTop: 38,
    offsetWidth: 38,
    style: { left: '114px', top: '38px', width: '38px' },
    textContent: '연접좌석L3',
    getAttribute(name) {
      return {
        'data-seatlocno': '00100100050023',
        title: '',
      }[name] ?? null;
    },
  };

  assert.deepEqual(
    { ...seatFromButton(button), element: undefined },
    {
      locNo: '00100100050023',
      label: 'L3',
      row: 'L',
      number: 3,
      left: 114,
      top: 38,
      width: 38,
      type: 'normal',
      disabled: true,
      selected: false,
      element: undefined,
    },
  );
});

test('current CGV CSS modules expose any special-seat type without a hard-coded list', () => {
  function fakeButton(className) {
    return {
      className,
      disabled: false,
      offsetLeft: 114,
      offsetTop: 38,
      offsetWidth: 38,
      style: { left: '114px', top: '38px', width: '38px' },
      textContent: 'A3',
      getAttribute(name) {
        return name === 'data-seatlocno' ? 'a3' : '';
      },
    };
  }

  assert.equal(
    seatFromButton(fakeButton('seatMap_seatNumber__a seatMap_seatNormal__b seatMap_seatBeanbag__c')).type,
    'beanbag',
  );
  assert.equal(
    seatFromButton(fakeButton('seatMap_seatNumber__a seatMap_seatLight__b seatMap_seatDisabled__c')).type,
    'light',
  );
});

test('visitor count sums categories and de-duplicates responsive copies', () => {
  function group(label, value) {
    return {
      querySelector(selector) {
        if (selector.startsWith('button')) {
          return value ? { textContent: String(value) } : null;
        }
        if (selector === '[id="number-choice-label"]') {
          return { textContent: label };
        }
        return null;
      },
    };
  }

  const document = {
    querySelectorAll(selector) {
      if (selector === '[role="group"]') {
        return [group('일반', 2), group('청소년', 1), group('일반', 2), group('우대', 0)];
      }
      if (selector === 'button') {
        return [];
      }
      return [];
    },
  };

  assert.equal(readTargetCount(document), 3);
});
