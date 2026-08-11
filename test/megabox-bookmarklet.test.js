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
} = require('../megabox-bookmarklet');

test('Megabox CommonJS exports do not auto-run when window already exists', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'megabox-bookmarklet.js'), 'utf8');
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
    top: options.top ?? 40,
    width: options.width ?? 20,
    groupNo: options.groupNo ?? '2',
    groupName: options.groupName ?? 'A2',
    groupSeq: options.groupSeq ?? parsed.number,
    seatToCnt: options.seatToCnt ?? 1,
    type: options.type ?? 'NORMAL:NORMAL',
    disabled: options.disabled ?? false,
  };
}

test('Megabox seat labels normalize row and number', () => {
  assert.equal(normalizeSeatLabel(' 좌석 A 12 '), 'A12');
  assert.deepEqual(parseSeatLabel('AA10'), {
    label: 'AA10',
    row: 'AA',
    number: 10,
  });
  assert.equal(Number.isNaN(parseSeatLabel('통로').number), true);
});

test('adjacency follows row, choice group, sequence, and seat type', () => {
  const a1 = seat('a1', 'A1', 20, { groupSeq: 1 });

  assert.equal(areAdjacent(a1, seat('a2', 'A2', 40, { groupSeq: 2 })), true);
  assert.equal(areAdjacent(a1, seat('b2', 'B2', 40, { groupSeq: 2 })), false);
  assert.equal(
    areAdjacent(a1, seat('a2-other-number', 'A2', 40, { groupNo: '3', groupSeq: 2 })),
    true,
    'group name is the official boundary even when opaque group numbers differ',
  );
  assert.equal(
    areAdjacent(a1, seat('a2-other-name', 'A2', 40, { groupName: 'A3', groupSeq: 2 })),
    false,
  );
  assert.equal(areAdjacent(a1, seat('a3', 'A3', 40, { groupSeq: 3 })), false);
  assert.equal(
    areAdjacent(a1, seat('a2-special', 'A2', 40, { groupSeq: 2, type: 'SOFA:NORMAL' })),
    false,
  );
  assert.equal(
    areAdjacent(
      seat('f1', 'A1', 20, { groupNo: '2', groupName: '', groupSeq: 1 }),
      seat('f2', 'A2', 40, { groupNo: '3', groupName: '', groupSeq: 2 }),
    ),
    false,
    'group number is used only when the official group name is missing',
  );
});

test('geometry rejects an aisle gap when group metadata is unavailable', () => {
  const a1 = seat('a1', 'A1', 20, { groupNo: '', groupName: '', groupSeq: NaN });
  const a2 = seat('a2', 'A2', 80, { groupNo: '', groupName: '', groupSeq: NaN });
  assert.equal(areAdjacent(a1, a2), false);
});

test('highest-priority available contiguous Megabox group wins', () => {
  const seats = [
    seat('a1', 'A1', 20, { groupSeq: 1 }),
    seat('a2', 'A2', 40, { groupSeq: 2 }),
    seat('a3', 'A3', 60, { groupSeq: 3 }),
    seat('a4', 'A4', 80, { groupSeq: 4 }),
  ];
  const preferences = [
    { locNo: 'a3', priority: 1 },
    { locNo: 'a4', priority: 2 },
    { locNo: 'a1', priority: 3 },
    { locNo: 'a2', priority: 4 },
  ];

  assert.deepEqual(
    chooseBestGroup(preferences, seats, 2).map((item) => item.locNo),
    ['a3', 'a4'],
  );
});

test('sold and impossible seats never form an available candidate group', () => {
  const seats = [
    seat('a1', 'A1', 20, { groupSeq: 1 }),
    seat('a2', 'A2', 40, { groupSeq: 2, disabled: true }),
    seat('a3', 'A3', 60, { groupSeq: 3 }),
    seat('a4', 'A4', 80, { groupSeq: 4 }),
  ];

  assert.deepEqual(
    chooseBestGroup(['a1', 'a2', 'a3', 'a4'], seats, 2).map((item) => item.locNo),
    ['a3', 'a4'],
  );
  assert.deepEqual(chooseBestGroup(['a1', 'a2', 'a3', 'a4'], seats, 3), []);
});

test('seatToCnt is treated as ticket capacity rather than button count', () => {
  const sofa = seat('s1', 'S1', 20, { seatToCnt: 2, type: 'SOFA:PREMIUM' });
  const normal1 = seat('a1', 'A1', 60, { groupSeq: 1 });
  const normal2 = seat('a2', 'A2', 80, { groupSeq: 2 });

  assert.deepEqual(chooseBestGroup(['s1'], [sofa], 2).map((item) => item.locNo), ['s1']);
  assert.deepEqual(
    chooseBestGroup(['a1', 'a2'], [normal1, normal2], 2).map((item) => item.locNo),
    ['a1', 'a2'],
  );
  assert.deepEqual(chooseBestGroup(['s1'], [sofa], 1), []);
});

test('seat set comparison ignores official auto-selection order', () => {
  assert.equal(
    sameSeatSet([{ locNo: 'a1' }, { locNo: 'a2' }], [{ locNo: 'a2' }, { locNo: 'a1' }]),
    true,
  );
  assert.equal(sameSeatSet([{ locNo: 'a1' }], [{ locNo: 'a1' }, { locNo: 'a2' }]), false);
  assert.equal(
    sameSeatSet([{ locNo: 'a1' }, { locNo: 'a1' }], [{ locNo: 'a1' }, { locNo: 'a1' }]),
    false,
    'duplicate DOM identities cannot masquerade as an exact official selection',
  );
});

test('current Megabox button attributes map to normalized inventory', () => {
  const attributes = {
    seatuniqno: '00100101',
    rownm: 'A',
    seatno: '1',
    seatchoigrpno: '2',
    seatchoigrpnm: 'A2',
    seatchoigrpseq: '1',
    seatchoirowcnt: '4',
    seattocnt: '1',
    seatclasscd: 'NORMAL',
    seatzonecd: 'STANDARD',
    selected: 'selected',
  };
  const button = {
    className: 'seat-condition choice',
    classList: { contains: (name) => button.className.split(/\s+/).includes(name) },
    disabled: false,
    offsetLeft: 20,
    offsetTop: 40,
    offsetWidth: 20,
    style: { left: '20px', top: '40px', width: '20px' },
    textContent: 'A1',
    getAttribute: (name) => attributes[name] ?? null,
    hasAttribute: (name) => Object.hasOwn(attributes, name),
  };

  assert.deepEqual(
    { ...seatFromButton(button), element: undefined },
    {
      locNo: '00100101',
      label: 'A1',
      row: 'A',
      number: 1,
      left: 20,
      top: 40,
      width: 20,
      groupNo: '2',
      groupName: 'A2',
      groupSeq: 1,
      groupRowCount: 4,
      seatToCnt: 1,
      classCode: 'NORMAL',
      zoneCode: 'STANDARD',
      type: 'NORMAL:STANDARD',
      disabled: false,
      selected: true,
      element: undefined,
    },
  );
});

test('finish and impossible classes are unavailable, while boolean selected is recognized', () => {
  function fakeButton(className, attributes = {}) {
    return {
      className,
      classList: { contains: (name) => className.split(/\s+/).includes(name) },
      disabled: false,
      offsetLeft: 0,
      offsetTop: 0,
      offsetWidth: 20,
      style: {},
      textContent: 'A1',
      getAttribute: (name) => attributes[name] ?? null,
      hasAttribute: (name) => Object.hasOwn(attributes, name),
    };
  }

  assert.equal(seatFromButton(fakeButton('seat-condition finish')).disabled, true);
  assert.equal(seatFromButton(fakeButton('seat-condition impossible')).disabled, true);
  assert.equal(
    seatFromButton(fakeButton('seat-condition', { selected: 'selected' })).selected,
    true,
  );
});

test('ticket target sums categories and de-duplicates responsive copies', () => {
  function cell(category, value) {
    return {
      querySelector(selector) {
        if (selector === '.txt') return { textContent: category };
        if (selector === 'button.now') {
          return { value: String(value), getAttribute: () => String(value), textContent: String(value) };
        }
        return null;
      },
    };
  }
  const document = {
    querySelectorAll(selector) {
      if (selector === '.seat-count .cell') {
        return [cell('성인', 2), cell('청소년', 1), cell('성인', 2), cell('우대', 0)];
      }
      return [];
    },
  };

  assert.equal(readTargetCount(document), 3);
});
