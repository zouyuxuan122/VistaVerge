// F1-COMP 回应门控与主动插话仲裁测试（VOICE §1.4/§1.6、MEMORY_PERCEPTION §8、
// GAP_AUDIT G-COMP-06 / G-VOICE-01）：每条规则都给正反例；纯函数、不发 LLM。
import { describe, expect, it } from 'vitest';
import {
  PROACTIVE_THRESHOLDS,
  REPLY_GATE_THRESHOLDS,
  arbitrateProactive,
  countSpokenInWindow,
  decideReplyGate,
  explainReplyGate,
  isQuietHour,
  type ProactiveEvent,
} from '../../src/companion/proactive';

/** 本地时间构造：避免测试依赖运行机器时区。 */
function at(hour: number, minute = 0): number {
  return new Date(2026, 8, 19, hour, minute, 0, 0).getTime();
}

const NIGHT = at(2);
const NOON = at(12);

describe('companion/proactive：decideReplyGate 该回', () => {
  it('含对她的称呼 → respond', () => {
    expect(decideReplyGate('小满在干嘛', { myNames: ['小满'] })).toBe('respond');
  });

  it('问句（问号结尾 / 吗呢结尾 / 疑问词短句）→ respond', () => {
    expect(decideReplyGate('在吗？')).toBe('respond');
    expect(decideReplyGate('你今天有空吗')).toBe('respond');
    expect(decideReplyGate('这个怎么做呢')).toBe('respond');
    expect(decideReplyGate('现在几点')).toBe('respond');
  });

  it('祈使/请求指令 → respond', () => {
    expect(decideReplyGate('帮我查一下天气')).toBe('respond');
    expect(decideReplyGate('打开音乐')).toBe('respond');
    expect(decideReplyGate('麻烦你记一下')).toBe('respond');
  });

  it('接续上文短答（即使很短）→ respond', () => {
    expect(decideReplyGate('好', { continuationOfPrevious: true })).toBe('respond');
  });

  it('调用方显式标记「在对她说」→ respond（优先级高于启发式）', () => {
    expect(decideReplyGate('你们看这个', { addressedToHer: true })).toBe('respond');
  });
});

describe('companion/proactive：decideReplyGate 只记录', () => {
  it('说话人判定为他人 / 背景旁白 / 自播回声 → record', () => {
    expect(decideReplyGate('把报告发我', { speaker: 'other' })).toBe('record');
    expect(decideReplyGate('在吗？', { speaker: 'background' })).toBe('record');
    expect(decideReplyGate('小满在吗', { speaker: 'self' })).toBe('record');
    expect(decideReplyGate('今天开会', { isBackgroundNarration: true })).toBe('record');
  });

  it('明显在对他人说话（你们/大家/跟他说）→ record', () => {
    expect(decideReplyGate('你们看这个')).toBe('record');
    expect(decideReplyGate('大家先吃饭')).toBe('record');
    expect(decideReplyGate('我跟他说一下')).toBe('record');
  });

  it('自言自语标记 / 语气词填充 → record', () => {
    expect(decideReplyGate('嗯嗯')).toBe('record');
    expect(decideReplyGate('唉')).toBe('record');
    expect(decideReplyGate('我看看')).toBe('record');
    expect(decideReplyGate('那个')).toBe('record');
    expect(decideReplyGate('嗯嗯', { isSelfTalk: true })).toBe('record');
  });

  it('过短无信息（<2 有效字）→ record', () => {
    expect(decideReplyGate('好')).toBe('record');
    expect(decideReplyGate('。')).toBe('record');
    expect(decideReplyGate('')).toBe('record');
  });

  it('阈值可配置：抬高 minEffectiveChars 后普通短句也只记录', () => {
    expect(decideReplyGate('今天天气不错', { thresholds: { minEffectiveChars: 20 } })).toBe('record');
    expect(REPLY_GATE_THRESHOLDS.minEffectiveChars).toBe(2);
  });
});

describe('companion/proactive：decideReplyGate 拿不准', () => {
  it('无明确回应/忽略信号的陈述 → uncertain（不发起 LLM）', () => {
    expect(decideReplyGate('今天天气不错')).toBe('uncertain');
    expect(decideReplyGate('我刚从超市回来')).toBe('uncertain');
  });

  it('explainReplyGate 给可读依据，decideReplyGate 只给结论', () => {
    const explained = explainReplyGate('在吗？');
    expect(explained.gate).toBe('respond');
    expect(explained.reasons.length).toBeGreaterThan(0);
    expect(decideReplyGate('在吗？')).toBe('respond');
  });

  it('拿不准时不产生任何事件/副作用（纯函数：同输入同输出）', () => {
    expect(decideReplyGate('我刚从超市回来')).toBe(decideReplyGate('我刚从超市回来'));
  });
});

describe('companion/proactive：安静时段与额度', () => {
  it('isQuietHour 支持跨午夜、同日区间与关闭', () => {
    expect(isQuietHour(2, { startHour: 23, endHour: 8 })).toBe(true);
    expect(isQuietHour(23, { startHour: 23, endHour: 8 })).toBe(true);
    expect(isQuietHour(12, { startHour: 23, endHour: 8 })).toBe(false);
    expect(isQuietHour(14, { startHour: 13, endHour: 15 })).toBe(true);
    expect(isQuietHour(15, { startHour: 13, endHour: 15 })).toBe(false);
    expect(isQuietHour(2, null)).toBe(false);
    expect(isQuietHour(9, { startHour: 9, endHour: 9 })).toBe(false);
  });

  it('安静时段内不插话但排队（默认不突破）', () => {
    const events: ProactiveEvent[] = [{ kind: 'reminder', at: NIGHT }];
    const decision = arbitrateProactive(events, { now: NIGHT, intensity: 1 });
    expect(decision.shouldSpeak).toBe(false);
    expect(decision.reason).toBe('quiet-hours');
    expect(decision.queued).toBe(true);
    expect(decision.priority).toBe(3);
  });

  it('安静时段可被高优先级事件突破（quietBypassPriority 可配置）', () => {
    const events: ProactiveEvent[] = [{ kind: 'reminder', at: NIGHT, priority: 4 }];
    const decision = arbitrateProactive(events, { now: NIGHT, intensity: 1 });
    expect(decision.shouldSpeak).toBe(true);
    expect(decision.reason).toBe('ok');
  });

  it('每小时额度用尽后不插话（默认 2，可配置）', () => {
    const events: ProactiveEvent[] = [{ kind: 'reminder', at: NOON }];
    expect(arbitrateProactive(events, { now: NOON, spokenThisHour: 2 }).reason).toBe('hourly-quota');
    expect(arbitrateProactive(events, { now: NOON, spokenThisHour: 1 }).shouldSpeak).toBe(true);
    expect(
      arbitrateProactive(events, {
        now: NOON,
        spokenThisHour: 0,
        thresholds: { hourlyQuota: 0 },
      }).reason,
    ).toBe('hourly-quota');
    expect(PROACTIVE_THRESHOLDS.hourlyQuota).toBe(2);
  });

  it('countSpokenInWindow 只统计窗口内的时间戳', () => {
    const now = NOON;
    expect(countSpokenInWindow([now - 1000, now - 7200_000, now + 1000], now, 3600_000)).toBe(1);
  });
});

describe('companion/proactive：强度档与忙碌状态', () => {
  const reminder: ProactiveEvent[] = [{ kind: 'reminder', at: NOON }];
  const idleCare: ProactiveEvent[] = [{ kind: 'idle_care', at: NOON }];

  it('强度 0（关闭）→ 不插话', () => {
    const decision = arbitrateProactive(reminder, { now: NOON, intensity: 0 });
    expect(decision.shouldSpeak).toBe(false);
    expect(decision.reason).toBe('intensity-off');
  });

  it('强度 1（保守）只发高优先级事件，低优先级直接丢弃', () => {
    expect(arbitrateProactive(reminder, { now: NOON, intensity: 1 }).shouldSpeak).toBe(true);
    const low = arbitrateProactive(idleCare, { now: NOON, intensity: 1 });
    expect(low.shouldSpeak).toBe(false);
    expect(low.reason).toBe('low-priority');
    expect(low.queued).toBe(false);
  });

  it('强度 2（活泼）允许低优先级事件', () => {
    expect(arbitrateProactive(idleCare, { now: NOON, intensity: 2 }).shouldSpeak).toBe(true);
    expect(PROACTIVE_THRESHOLDS.intensityMinPriority[2]).toBeLessThan(
      PROACTIVE_THRESHOLDS.intensityMinPriority[1],
    );
  });

  it('正在播放或生成中不插话，但排队', () => {
    expect(arbitrateProactive(reminder, { now: NOON, isPlayingAudio: true }).reason).toBe('busy-playing');
    expect(arbitrateProactive(reminder, { now: NOON, isGenerating: true }).reason).toBe('busy-generating');
    expect(arbitrateProactive(reminder, { now: NOON, isGenerating: true }).queued).toBe(true);
  });

  it('距上次主动发言太近 → 不插话并排队', () => {
    const decision = arbitrateProactive(reminder, { now: NOON, lastSpokenAt: NOON - 1000 });
    expect(decision.shouldSpeak).toBe(false);
    expect(decision.reason).toBe('min-gap');
    expect(decision.queued).toBe(true);
    expect(arbitrateProactive(reminder, { now: NOON, lastSpokenAt: NOON - 200_000 }).shouldSpeak).toBe(
      true,
    );
  });
});

describe('companion/proactive：事件挑选与过期', () => {
  it('无事件 / 未来事件 → 不插话且不排队', () => {
    expect(arbitrateProactive([], { now: NOON })).toEqual({
      shouldSpeak: false,
      reason: 'no-event',
      priority: 0,
      queued: false,
    });
    expect(arbitrateProactive([{ kind: 'reminder', at: NOON + 60_000 }], { now: NOON }).reason).toBe(
      'no-event',
    );
  });

  it('过期事件被丢弃（不补说打断用户）', () => {
    const stale: ProactiveEvent[] = [
      { kind: 'reminder', at: NOON - PROACTIVE_THRESHOLDS.maxQueueAgeMs - 1 },
    ];
    const decision = arbitrateProactive(stale, { now: NOON });
    expect(decision.shouldSpeak).toBe(false);
    expect(decision.reason).toBe('stale-event');
  });

  it('多个事件时挑优先级最高的，同优先级挑最早的', () => {
    const events: ProactiveEvent[] = [
      { kind: 'mc_task_complete', at: NOON - 5000 },
      { kind: 'reminder', at: NOON - 1000 },
      { kind: 'user_home', at: NOON - 3000 },
    ];
    const decision = arbitrateProactive(events, { now: NOON, intensity: 1 });
    expect(decision.shouldSpeak).toBe(true);
    expect(decision.priority).toBe(3);
    expect(decision.event?.kind).toBe('reminder');
  });

  it('事件优先级表可配置', () => {
    expect(PROACTIVE_THRESHOLDS.eventPriority.reminder).toBeGreaterThan(
      PROACTIVE_THRESHOLDS.eventPriority.idle_care,
    );
    const events: ProactiveEvent[] = [{ kind: 'idle_care', at: NOON }];
    const decision = arbitrateProactive(events, {
      now: NOON,
      intensity: 1,
      thresholds: { eventPriority: { ...PROACTIVE_THRESHOLDS.eventPriority, idle_care: 9 } },
    });
    expect(decision.shouldSpeak).toBe(true);
    expect(decision.priority).toBe(9);
  });
});
