/**
 * 转写里的幻觉。
 *
 * whisper 对挂机尾巴（静噪尾音）会凭空编字幕署名，实测每一段 1.1 秒以内的空按
 * 都是，而且都包在括号里。换哪组参数都去不掉，只能在文字上剔。
 */

/** 括号里出现这些就整段去掉。冒号在归一化之后一律是半角。 */
const CREDIT = /字幕|貝爾|贝尔|[词詞]\s*:|曲\s*:|Amara|请不吝点赞/i;
const PAREN = /\([^()]*\)|\[[^[\]]*\]|【[^【】]*】/g;
/** 没包括号的署名：字幕君、字幕by……，连同前面的「中文」。 */
const BARE_CREDIT = /(?:中文)?字幕(?:製作|制作|君|by)\S*/gi;
const NOT_SPEECH = /[\p{P}\p{S}\s]/gu;

/** 编辑距离，按码点算。 */
export function editDistance(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length]!;
}

export interface Filtered {
  /** 剔掉署名之后剩下的，送去提取。 */
  text: string;
  hasSpeech: boolean;
}

/**
 * 没有人声：剩下的去掉标点是空的，或者和提示词只差几个字。
 *
 * 提示词会被回声，实测的三个变体（这句子、这句话、这句是普通话的句子）和
 * 「以下是普通话的句子」都只差 2 到 3 个字。容差取提示词长度的三分之一、
 * 最多 3：提示词只有几个字时放到 3，「收到」这样的真话就被当成回声了。
 * 没配提示词就没有回声可言。
 */
export function filterTranscript(raw: string, prompt: string): Filtered {
  const text = raw
    .normalize('NFKC')
    .replace(PAREN, (run) => (CREDIT.test(run) ? '' : run))
    .replace(BARE_CREDIT, '')
    .trim();
  const bare = text.replace(NOT_SPEECH, '');
  if (bare === '') return { text, hasSpeech: false };

  const echo = prompt.normalize('NFKC').replace(NOT_SPEECH, '');
  if (echo !== '') {
    const tolerance = Math.min(3, Math.floor(Array.from(echo).length / 3));
    if (editDistance(bare, echo) <= tolerance) return { text, hasSpeech: false };
  }
  return { text, hasSpeech: true };
}
