import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { editDistance, filterTranscript } from './filter.ts';

const PROMPT = '以下是普通话的句子。';

describe('编辑距离', () => {
  it('按码点算，增删改各算一次', () => {
    assert.equal(editDistance('', ''), 0);
    assert.equal(editDistance('abc', 'abc'), 0);
    assert.equal(editDistance('这句子是', '以下是'), 3);
    assert.equal(editDistance('收到', ''), 2);
    // 增补字符是一个码点
    assert.equal(editDistance('𠮷a', 'a'), 1);
  });
});

describe('幻觉过滤', () => {
  // brief 里 4 段 1.1 秒以内的空按，每一段都是这样
  it('整句都是括号里的字幕署名：没有人声', () => {
    for (const raw of ['(中文字幕製作:貝爾)', '(字幕製作:貝爾)', '(字幕君:是)', '( 词: 罗宏 曲: 罗宏 )']) {
      const f = filterTranscript(raw, PROMPT);
      assert.equal(f.hasSpeech, false, raw);
    }
  });

  // 只在「包含 字幕」就判无声会把这条真通联藏掉
  it('真话后面跟着署名：署名剔掉，真话留下', () => {
    const f = filterTranscript('收到了，那先祝你回家的路上一路顺风，平安抵达。(字幕製作:貝爾)', PROMPT);
    assert.equal(f.hasSpeech, true);
    // 文字是 NFKC 归一化之后的，全角逗号变成半角
    assert.equal(f.text, '收到了,那先祝你回家的路上一路顺风,平安抵达。');
  });

  it('全角的括号和冒号先归一化，照样认得', () => {
    assert.equal(filterTranscript('（字幕製作：貝爾）', PROMPT).hasSpeech, false);
    assert.equal(filterTranscript('（词：罗宏 曲：罗宏）', PROMPT).hasSpeech, false);
  });

  it('繁体的「詞」「貝爾」和 Amara、请不吝点赞都认', () => {
    for (const raw of ['(詞:某人)', '(Amara.org 社群提供的字幕)', '(请不吝点赞 订阅)', '[贝尔]']) {
      assert.equal(filterTranscript(raw, PROMPT).hasSpeech, false, raw);
    }
  });

  it('没包括号的署名也剔：字幕by索兰娅、中文字幕製作', () => {
    assert.equal(filterTranscript('字幕by索兰娅', PROMPT).hasSpeech, false);
    assert.equal(filterTranscript('中文字幕製作:貝爾', PROMPT).hasSpeech, false);
    const f = filterTranscript('好的收到 字幕by索兰娅', PROMPT);
    assert.equal(f.hasSpeech, true);
    assert.equal(f.text, '好的收到');
  });

  it('括号里没有署名的内容原样留下', () => {
    const f = filterTranscript('BG0CG (本台) 收到', PROMPT);
    assert.equal(f.hasSpeech, true);
    assert.equal(f.text, 'BG0CG (本台) 收到');
  });

  it('只有标点和空白：没有人声', () => {
    assert.equal(filterTranscript('', PROMPT).hasSpeech, false);
    assert.equal(filterTranscript('  。，… \n', PROMPT).hasSpeech, false);
  });

  // brief 实测的三个回声，和提示词都只差 2 到 3 个字
  it('提示词的回声：实测的三个变体都判没有人声，提示词本身也是', () => {
    for (const raw of ['这句子是普通话的句子。', '这句话是普通话的句子。', '这句是普通话的句子。', PROMPT]) {
      assert.equal(filterTranscript(raw, PROMPT).hasSpeech, false, raw);
    }
  });

  it('和提示词差得远的是真话', () => {
    assert.equal(filterTranscript('收到了，那先祝你回家的路上一路顺风。', PROMPT).hasSpeech, true);
    assert.equal(filterTranscript('QQ赛，第一，QQ赛，第二', PROMPT).hasSpeech, true);
  });

  // 没配提示词就没有回声，短短的「好」「收到」是真话
  it('没有提示词：短话不会被当成回声', () => {
    assert.equal(filterTranscript('好', '').hasSpeech, true);
    assert.equal(filterTranscript('收到', '').hasSpeech, true);
  });

  // 提示词只有几个字时容差跟着缩，否则「收到」和提示词「CQ」只差 2 个字
  it('提示词很短时容差跟着缩小', () => {
    assert.equal(filterTranscript('收到', 'CQ').hasSpeech, true);
    assert.equal(filterTranscript('CQ', 'CQ').hasSpeech, false);
  });
});
