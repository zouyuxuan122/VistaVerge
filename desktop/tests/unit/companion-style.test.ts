// F1-COMP 口癖/风格学习测试（GAP_AUDIT G-COMP-03）：
// n-gram + 停用词 + 词频/占比双阈值检出；滑动窗口增量重算；手动增删跨重算保留；
// 持久化往返；一键关闭后 buildStylePrompt 返回空；提示语明确「不要刻意堆砌」。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/data/db';
import {
  CJK_INTERJECTIONS,
  STYLE_THRESHOLDS,
  addCatchphrase,
  buildStylePrompt,
  clearStyleProfile,
  extractStyleProfile,
  learnStyle,
  loadStyleProfile,
  normalizeIntensity,
  removeCatchphrase,
  setStyleEnabled,
  stylePromptFromStore,
} from '../../src/companion/styleProfile';

const SAMPLE = [
  '今天好累 awsl',
  '这个画风 awsl',
  'awsl 太顶了',
  '捏',
  '捏',
  '捏',
  '这个好捏',
  '嗯嗯',
];

describe('companion/styleProfile：口癖检出与阈值', () => {
  it('高频英文口头禅与单字语气词都能检出', () => {
    const profile = extractStyleProfile(SAMPLE);
    const texts = profile.catchphrases.map((entry) => entry.text);
    expect(texts).toContain('awsl');
    expect(texts).toContain('捏');
    expect(profile.sampleCount).toBe(SAMPLE.length);
    expect(profile.catchphrases.find((entry) => entry.text === 'awsl')?.count).toBe(3);
  });

  it('停用词（这个/嗯嗯 之外的功能词）不会成为口癖', () => {
    const profile = extractStyleProfile(['这个', '这个', '这个', '然后', '然后', '然后']);
    const texts = profile.catchphrases.map((entry) => entry.text);
    expect(texts).not.toContain('这个');
    expect(texts).not.toContain('然后');
  });

  it('词频阈值可配置：抬高阈值后不再产出条目', () => {
    const profile = extractStyleProfile(SAMPLE, { thresholds: { minCatchphraseCount: 5 } });
    expect(profile.catchphrases).toHaveLength(0);
  });

  it('消息数低于 minMessages 时不产出条目', () => {
    const profile = extractStyleProfile(['awsl', 'awsl'], { thresholds: { minMessages: 5 } });
    expect(profile.catchphrases).toHaveLength(0);
  });

  it('消息占比阈值可配置：抬高占比阈值后不再产出条目', () => {
    const profile = extractStyleProfile(SAMPLE, { thresholds: { minCatchphraseRatio: 0.9 } });
    expect(profile.catchphrases).toHaveLength(0);
  });

  it('单字口癖白名单存在且被用于单字检出', () => {
    expect(CJK_INTERJECTIONS).toContain('捏');
    const profile = extractStyleProfile(['捏', '捏', '捏']);
    expect(profile.catchphrases.map((entry) => entry.text)).toContain('捏');
  });

  it('阈值对象可整体导出并被前台覆盖', () => {
    expect(STYLE_THRESHOLDS.windowSize).toBeGreaterThan(0);
    expect(STYLE_THRESHOLDS.promptPhrasesByIntensity[2]).toBeGreaterThan(
      STYLE_THRESHOLDS.promptPhrasesByIntensity[1],
    );
  });
});

describe('companion/styleProfile：句长/标点/emoji/自称/中英混合', () => {
  it('统计平均句长与分档', () => {
    const profile = extractStyleProfile([
      '短。中等长度的一句话。这是很长很长很长很长很长很长很长很长很长很长的一句话。',
    ]);
    expect(profile.avgSentenceLength).toBeGreaterThan(0);
    expect(
      profile.sentenceLengthBuckets.short +
        profile.sentenceLengthBuckets.medium +
        profile.sentenceLengthBuckets.long,
    ).toBe(3);
    expect(profile.sentenceLengthBuckets.short).toBe(2);
    expect(profile.sentenceLengthBuckets.medium).toBe(0);
    expect(profile.sentenceLengthBuckets.long).toBe(1);
  });

  it('统计标点习惯（省略号/感叹号/波浪号）', () => {
    const profile = extractStyleProfile(['等等……', '好耶！！', '这样~', '嗯。']);
    expect(profile.punctuation.ellipsis).toBeGreaterThan(0);
    expect(profile.punctuation.exclaim).toBeGreaterThan(0);
    expect(profile.punctuation.tilde).toBeGreaterThan(0);
    expect(profile.punctuation.period).toBeGreaterThan(0);
  });

  it('统计 emoji 与颜文字频率', () => {
    const profile = extractStyleProfile(['笑死 😂', '(^_^) 好', '普通一句话。']);
    expect(profile.emojiRate).toBeGreaterThan(0);
    expect(profile.kaomojiRate).toBeGreaterThan(0);
  });

  it('提取自称与对她的称呼（含调用方传入的昵称）', () => {
    const profile = extractStyleProfile(['俺觉得可以', '小满你在吗', '小满你说呢'], {
      herNames: ['小满'],
    });
    expect(profile.selfReference).toContain('俺');
    expect(profile.addressTerms).toContain('小满');
  });

  it('统计中英混合度', () => {
    const mixed = extractStyleProfile(['今天 review 了一个 PR，感觉 ok']);
    expect(mixed.codeSwitchRatio).toBeGreaterThan(0);
    const pure = extractStyleProfile(['今天天气很好']);
    expect(pure.codeSwitchRatio).toBe(0);
  });
});

describe('companion/styleProfile：buildStylePrompt', () => {
  const profile = extractStyleProfile(SAMPLE);

  it('intensity 1/2 产出中文指令段，并明示不要刻意堆砌/不要每句都用', () => {
    const prompt = buildStylePrompt(profile, 1);
    expect(prompt).toContain('说话风格参考');
    expect(prompt).toContain('awsl');
    expect(prompt).toContain('不要刻意堆砌');
    expect(prompt).toContain('不要每句都用');
    expect(prompt).toContain('不改变你的安全规则与权限');
    const lively = buildStylePrompt(profile, 2);
    expect(lively.length).toBeGreaterThanOrEqual(prompt.length);
  });

  it('intensity 0 返回空（不注入）', () => {
    expect(buildStylePrompt(profile, 0)).toBe('');
  });

  it('无档案或未学习时返回空', () => {
    expect(buildStylePrompt(null, 1)).toBe('');
    expect(buildStylePrompt(extractStyleProfile([]), 1)).toBe('');
  });

  it('normalizeIntensity 收敛越界入参', () => {
    expect(normalizeIntensity(-1)).toBe(0);
    expect(normalizeIntensity(9)).toBe(2);
    expect(normalizeIntensity(1.4)).toBe(1);
  });
});

describe('companion/styleProfile：持久化与滑动窗口', () => {
  beforeEach(async () => {
    await initDb();
  });
  afterEach(() => {
    closeDb();
  });

  it('持久化往返：learnStyle 后 loadStyleProfile 读回同一档案', () => {
    const { profile, events } = learnStyle(SAMPLE);
    expect(events.map((e) => e.type)).toContain('style.updated');
    const loaded = loadStyleProfile();
    expect(loaded).not.toBeNull();
    expect(loaded).toEqual(
      expect.objectContaining({
        id: profile.id,
        enabled: true,
        sampleCount: profile.sampleCount,
        avgSentenceLength: profile.avgSentenceLength,
        catchphrases: profile.catchphrases,
        selfReference: profile.selfReference,
      }),
    );
  });

  it('滑动窗口：窗口外的旧口癖不再计入', () => {
    const messages = ['awsl', 'awsl', 'awsl', '今天很安静', '什么也没说', '就这样吧'];
    const { profile } = learnStyle(messages, { thresholds: { windowSize: 3 } });
    expect(profile.sampleCount).toBe(3);
    expect(profile.catchphrases.map((entry) => entry.text)).not.toContain('awsl');
  });

  it('增量更新：新消息进来后重算并保留窗口内新口癖', () => {
    learnStyle(SAMPLE);
    const { profile } = learnStyle([...SAMPLE, 'awsl', 'awsl', 'awsl']);
    expect(profile.catchphrases.map((entry) => entry.text)).toContain('awsl');
    expect(loadStyleProfile()?.sampleCount).toBe(SAMPLE.length + 3);
  });

  it('一键关闭：enabled=false 后 loadStyleProfile 读到关闭态，提示返回空', () => {
    learnStyle(SAMPLE);
    const off = setStyleEnabled(false);
    expect(off.enabled).toBe(false);
    expect(loadStyleProfile()?.enabled).toBe(false);
    expect(stylePromptFromStore(1)).toBe('');
    const on = setStyleEnabled(true);
    expect(on.enabled).toBe(true);
    expect(stylePromptFromStore(1)).not.toBe('');
  });

  it('手动增删口癖条目：跨重算保留、删除后消失', () => {
    learnStyle(SAMPLE);
    const added = addCatchphrase('喵呜');
    expect(added.catchphrases.find((entry) => entry.text === '喵呜')?.manual).toBe(true);
    const relearned = learnStyle(SAMPLE);
    expect(relearned.profile.catchphrases.map((entry) => entry.text)).toContain('喵呜');
    const removed = removeCatchphrase('喵呜');
    expect(removed.catchphrases.map((entry) => entry.text)).not.toContain('喵呜');
    expect(loadStyleProfile()?.catchphrases.map((entry) => entry.text)).not.toContain('喵呜');
  });

  it('addCatchphrase 拒绝空内容；未学习时 removeCatchphrase 抛错', () => {
    expect(() => addCatchphrase('   ')).toThrow(/不能为空/);
    expect(() => removeCatchphrase('捏')).toThrow(/尚未学习/);
  });

  it('clearStyleProfile 清空档案（用户删除自己的风格数据）', () => {
    learnStyle(SAMPLE);
    clearStyleProfile();
    expect(loadStyleProfile()).toBeNull();
    expect(stylePromptFromStore(1)).toBe('');
  });
});
