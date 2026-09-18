// 模型 → 角色的输出协议：回答中可夹带轻量标记，由应用解析后驱动形象。
// [emo:happy|sad|thinking|surprised|shy|neutral] 表情
// [act:nod|shake|tilt|wave|happy|angry|surprised|sleepy] 一次性动作
// [face:user|screen|auto] 朝向；[gaze:x,y] 视线（-1..1）
export interface AvatarDirective {
  kind: 'emo' | 'act' | 'face' | 'gaze';
  value: string;
}

const DIRECTIVE_RE = /\[(emo|act|face|gaze):([^\]\s]{1,32})\]/g;
const EMO_VALUES = new Set(['happy', 'sad', 'thinking', 'surprised', 'shy', 'neutral', 'angry']);
const ACT_VALUES = new Set(['nod', 'shake', 'tilt', 'wave', 'happy', 'angry', 'surprised', 'sleepy']);

export function parseDirectives(text: string): AvatarDirective[] {
  const out: AvatarDirective[] = [];
  for (const match of text.matchAll(DIRECTIVE_RE)) {
    const kind = match[1] as AvatarDirective['kind'];
    const value = match[2].toLowerCase();
    if (kind === 'emo' && EMO_VALUES.has(value)) out.push({ kind, value });
    else if (kind === 'act' && ACT_VALUES.has(value)) out.push({ kind, value });
    else if (kind === 'face' && ['user', 'screen', 'auto'].includes(value)) out.push({ kind, value });
    else if (kind === 'gaze') {
      const [x, y] = value.split(',').map(Number);
      if (Number.isFinite(x) && Number.isFinite(y)) out.push({ kind, value });
    }
  }
  return out;
}

/** 展示与持久化用的干净文本：去掉完整标记，压缩多余空白。 */
export function stripDirectives(text: string): string {
  return text
    .replace(DIRECTIVE_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** 回答可夹带未完成标记的残片（流式增量时）也算干净展示。 */
export function stripPartialDirective(text: string): string {
  return stripDirectives(text).replace(/\[(emo|act|face|gaze):[^\]]*$/s, '').trimEnd();
}

export const DIRECTIVE_INSTRUCTION =
  '你可以用标记控制自己的形象：[emo:happy|sad|thinking|surprised|shy|neutral] 表情，' +
  '[act:nod|shake|tilt|wave] 动作，[face:user|screen] 看向用户或屏幕。' +
  '标记放在回答最前面，最多两个，日常对话自然使用，不要在每句话都加。';
