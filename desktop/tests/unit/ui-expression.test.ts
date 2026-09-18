// 模型 → 角色指令协议测试（EXP-007）
import { describe, it, expect } from 'vitest';
import {
  parseDirectives,
  stripDirectives,
  stripPartialDirective,
} from '../../src/app/expressionProtocol';

describe('指令协议解析', () => {
  it('解析表情/动作/朝向/视线标记', () => {
    const ds = parseDirectives('[emo:happy]你好呀[act:wave] [face:screen] [gaze:0.2,-0.1]');
    expect(ds).toEqual([
      { kind: 'emo', value: 'happy' },
      { kind: 'act', value: 'wave' },
      { kind: 'face', value: 'screen' },
      { kind: 'gaze', value: '0.2,-0.1' },
    ]);
  });

  it('非法值被拒绝（未知表情/动作/朝向/非数值视线）', () => {
    expect(parseDirectives('[emo:furious][act:fly][face:moon][gaze:a,b]')).toEqual([]);
  });

  it('剥离标记后的展示文本干净且压空白', () => {
    expect(stripDirectives('[emo:happy] 你好 [act:nod] 世界')).toBe('你好 世界');
  });

  it('流式残片标记也不漏到展示层', () => {
    expect(stripPartialDirective('你好[emo:hap')).toBe('你好');
    expect(stripPartialDirective('[emo:happy]你好')).toBe('你好');
  });
});
