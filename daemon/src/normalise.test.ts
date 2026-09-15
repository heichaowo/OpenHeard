import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkRules } from './brandmeister.ts';
import { normalise } from './normalise.ts';

// searchHouse 返回的形状：Start/Stop 是字符串，没有 Event，LinkKind 而不是 LinkType。
const history = {
  Master: 4501,
  SessionID: 'fca2f1eb-5fd5-47a5-a176-137ff8a43d47',
  Start: '1789381957',
  Stop: '1789381967',
  LinkKind: 1,
  SourceID: 4660397,
  DestinationID: 91,
  RSSI: -47,
  BER: 0,
  SourceCall: 'BX7AEN',
};

// 实时推送的形状：Start/Stop 是数字，有 Event，未知呼号是空串。
const live = {
  Event: 'Session-Stop',
  SessionID: 'a6694acc-156f-4ebf-b739-7a21d1acf02b',
  Start: 1789381954,
  Stop: 1789381975,
  LinkType: 1,
  SourceID: 2629839,
  DestinationID: 460,
  SourceCall: '',
};

describe('normalise', () => {
  it('吃得下历史行', () => {
    const a = normalise(history, 4660397);
    assert.equal(a?.id, 'fca2f1eb-5fd5-47a5-a176-137ff8a43d47');
    assert.equal(a?.startAt, 1789381957);
    assert.equal(a?.durationS, 10);
    assert.equal(a?.callsign, 'BX7AEN');
    assert.equal(a?.dmrId, 4660397);
    assert.equal(a?.talkgroup, 91);
    assert.equal(a?.mine, true);
  });

  it('吃得下实时行，也不假设 Event 存在', () => {
    const a = normalise(live);
    assert.equal(a?.durationS, 21);
    assert.equal(a?.talkgroup, 460);
    assert.equal(a?.mine, false);
  });

  it('未知呼号的 null 和空串都归成 undefined', () => {
    assert.equal(normalise({ ...history, SourceCall: null })?.callsign, undefined);
    assert.equal(normalise({ ...history, SourceCall: '' })?.callsign, undefined);
    assert.equal(normalise({ ...history, SourceCall: '  ' })?.callsign, undefined);
  });

  it('没有 SessionID 就丢掉', () => {
    assert.equal(normalise({ ...history, SessionID: undefined }), undefined);
  });

  it('Session-Start 形状的行丢掉，它没有结束时间', () => {
    assert.equal(normalise({ ...history, Stop: 0 }), undefined);
    assert.equal(normalise({ ...history, Stop: null }), undefined);
  });

  it('结束时间早于开始时间的行丢掉', () => {
    assert.equal(normalise({ ...history, Stop: '1789381900' }), undefined);
  });

  it('RSSI 和 BER 缺了就是 undefined，不是 0', () => {
    const a = normalise({ ...history, RSSI: null, BER: null });
    assert.equal(a?.rssi, undefined);
    assert.equal(a?.ber, undefined);
  });

  it('BER 为 0 是有效值，不当成缺失', () => {
    assert.equal(normalise(history)?.ber, 0);
  });
});

describe('checkRules', () => {
  it('空 rules 拦住，它返回的是全网最新记录', () => {
    assert.throws(() => checkRules([]), /不能为空/);
  });

  it('数值字段传字符串拦住，它静默返回空集', () => {
    assert.throws(
      () => checkRules([{ id: 'DestinationID', operator: 'equal', value: '91' }]),
      /必须是数字/,
    );
    assert.throws(
      () => checkRules([{ id: 'SourceID', operator: 'equal', value: '4600000' }]),
      /必须是数字/,
    );
  });

  it('字符串字段传字符串没问题', () => {
    assert.doesNotThrow(() => checkRules([{ id: 'SourceCall', operator: 'equal', value: 'BG0CG' }]));
  });
});
