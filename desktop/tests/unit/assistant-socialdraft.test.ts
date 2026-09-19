// F1-ASSIST 单测：QQ/微博草稿（socialDraft）。
// 覆盖：建稿/持久化、预览气泡、敏感检查（长度上限/@全体/链接）、
// 「发送永远先确认」两步流程、确认后恒「通道未就绪」、social.publish 桩默认禁用，
// 以及 D9 的**零外发断言**（整个流程不触碰任何网络 API）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SOCIAL_CHANNEL_NOT_READY,
  SOCIAL_LIMITS,
  SOCIAL_PUBLISH_NOT_AUTHORIZED,
  confirmSend,
  createDraft,
  createSocialDraftService,
  inspectDraft,
  previewContent,
  renderPreview,
  requestSend,
  socialPublish,
} from '../../src/assistant/socialDraft';
import type { StorageLike } from '../../src/assistant/localStore';

const NOW = 1_756_000_000_000;

function memStorage(): StorageLike & { dump(): Record<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    dump: () => Object.fromEntries(map),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('socialDraft 建稿与预览', () => {
  it('createDraft 产出草稿字段，无告警时不阻塞', () => {
    const draft = createDraft('qq', { to: ' 小美 ', text: '晚上一起吃饭吗' }, { now: () => NOW, id: () => 'd1' });
    expect(draft.id).toBe('d1');
    expect(draft.platform).toBe('qq');
    expect(draft.to).toBe('小美');
    expect(draft.text).toBe('晚上一起吃饭吗');
    expect(draft.createdAt).toBe(NOW);
    expect(draft.warnings).toEqual([]);
    expect(draft.blocking).toBe(false);
  });

  it('QQ 预览是「发给某人」的发出气泡，微博是公开发布', () => {
    const qq = createDraft('qq', { to: '小美', text: '在吗' }, { id: () => 'd1' });
    const qqPreview = renderPreview(qq);
    expect(qqPreview.title).toContain('QQ');
    expect(qqPreview.title).toContain('小美');
    expect(qqPreview.bubbles).toHaveLength(1);
    expect(qqPreview.bubbles[0].side).toBe('out');
    expect(qqPreview.bubbles[0].text).toBe('在吗');
    expect(qqPreview.meta).toBe(`2 / ${SOCIAL_LIMITS.qq} 字`);
    expect(qqPreview.canSend).toBe(true);

    const weibo = createDraft('weibo', { text: '今天天气不错' }, { id: () => 'd2' });
    expect(renderPreview(weibo).title).toContain('公开发布');

    const noTo = createDraft('qq', { text: 'hi' }, { id: () => 'd3' });
    expect(renderPreview(noTo).title).toContain('未填收件人');
  });

  it('previewContent 是纯预览（编辑框边写边看），不落盘', () => {
    const preview = previewContent('weibo', { text: 'a'.repeat(10) });
    expect(preview.meta).toBe(`10 / ${SOCIAL_LIMITS.weibo} 字`);
    expect(preview.bubbles[0].text).toBe('a'.repeat(10));
  });

  it('敏感检查：超长阻塞、@全体 警示、链接标注、空内容阻塞', () => {
    const overLong = inspectDraft('qq', 'a'.repeat(SOCIAL_LIMITS.qq + 1));
    expect(overLong.map((warning) => warning.kind)).toContain('length-over-limit');
    expect(overLong.find((warning) => warning.kind === 'length-over-limit')?.level).toBe('block');

    expect(inspectDraft('qq', '各位 @全体成员 注意').find((w) => w.kind === 'at-all')?.level).toBe('warn');
    expect(inspectDraft('qq', 'hi @all').map((w) => w.kind)).toContain('at-all');
    expect(inspectDraft('weibo', '看 https://example.com/x').find((w) => w.kind === 'link')?.level).toBe('info');
    expect(inspectDraft('qq', '   ').find((w) => w.kind === 'empty')?.level).toBe('block');
  });

  it('链接在预览气泡里被标注', () => {
    const draft = createDraft('weibo', { text: '看 https://example.com' }, { id: () => 'd1' });
    const preview = renderPreview(draft);
    expect(preview.bubbles[0].note).toContain('链接');
    expect(preview.warnings.some((warning) => warning.kind === 'link')).toBe(true);
  });

  it('超长草稿 blocking=true 且 canSend=false', () => {
    const draft = createDraft('weibo', { text: 'x'.repeat(SOCIAL_LIMITS.weibo + 1) }, { id: () => 'd1' });
    expect(draft.blocking).toBe(true);
    expect(renderPreview(draft).canSend).toBe(false);
  });
});

describe('socialDraft 发送流程：永远先确认，确认后通道未就绪', () => {
  it('requestSend 恒要求确认，且不外发', () => {
    const draft = createDraft('qq', { to: '小美', text: '在吗' }, { id: () => 'd1' });
    const decision = requestSend(draft);
    expect(decision.ok).toBe(false);
    expect(decision.code).toBe('confirmation-required');
    expect(decision.requiresConfirmation).toBe(true);
    expect(decision.externalSent).toBe(false);
    expect(decision.message).toContain('确认');
  });

  it('未确认时 confirmSend 回到确认步骤，不进入通道', () => {
    const draft = createDraft('qq', { to: '小美', text: '在吗' }, { id: () => 'd1' });
    const decision = confirmSend(draft, { confirmed: false });
    expect(decision.code).toBe('confirmation-required');
    expect(decision.externalSent).toBe(false);
  });

  it('确认后仍报「通道未就绪」，且 ok=false / externalSent=false', () => {
    const draft = createDraft('weibo', { text: '今天天气不错' }, { id: () => 'd1' });
    const decision = confirmSend(draft, { confirmed: true });
    expect(decision.ok).toBe(false);
    expect(decision.code).toBe('channel-not-ready');
    expect(decision.message).toBe(SOCIAL_CHANNEL_NOT_READY);
    expect(decision.externalSent).toBe(false);
  });

  it('阻塞草稿不进入确认，也不进入通道检查', () => {
    const empty = createDraft('qq', { to: '小美', text: '' }, { id: () => 'd1' });
    expect(requestSend(empty).code).toBe('draft-blocked');
    expect(requestSend(empty).requiresConfirmation).toBe(false);
    expect(confirmSend(empty, { confirmed: true }).code).toBe('draft-blocked');
  });

  it('social.publish 接口桩默认禁用，恒 not-authorized', () => {
    const draft = createDraft('qq', { to: '小美', text: '在吗' }, { id: () => 'd1' });
    const decision = socialPublish(draft);
    expect(decision.ok).toBe(false);
    expect(decision.code).toBe('not-authorized');
    expect(decision.enabled).toBe(false);
    expect(decision.message).toBe(SOCIAL_PUBLISH_NOT_AUTHORIZED);
    expect(decision.externalSent).toBe(false);
  });

  it('D9 零外发：完整「建稿→发送→确认→publish」流程不触碰任何网络 API', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const service = createSocialDraftService({ storage: memStorage(), now: () => NOW, id: () => 'd1' });
    const draft = service.createDraft('qq', { to: '小美', text: '在吗' });
    expect(service.requestSend(draft.id)?.code).toBe('confirmation-required');
    expect(service.confirmSend(draft.id, { confirmed: true })?.code).toBe('channel-not-ready');
    expect(service.publish(draft.id)?.code).toBe('not-authorized');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('socialDraft 草稿列表持久化', () => {
  it('建稿落盘、最新在前，可从同一存储重建', () => {
    const storage = memStorage();
    let seq = 0;
    const service = createSocialDraftService({ storage, now: () => NOW, id: () => `d${(seq += 1)}` });
    service.createDraft('qq', { to: '小美', text: '第一条' });
    service.createDraft('weibo', { text: '第二条' });

    expect(service.list().map((draft) => draft.id)).toEqual(['d2', 'd1']);
    const raw = JSON.stringify(storage.dump());
    expect(raw).toContain('vistaverge.assistant.socialDrafts');
    expect(raw).toContain('第一条');

    const reloaded = createSocialDraftService({ storage });
    expect(reloaded.list().map((draft) => draft.text)).toEqual(['第二条', '第一条']);
    expect(reloaded.list()[0].warnings).toEqual([]);
  });

  it('损坏条目被跳过，不猜字段；删除后清空键', () => {
    const storage = memStorage();
    storage.setItem(
      'vistaverge.assistant.socialDrafts',
      JSON.stringify([
        { id: 'ok', platform: 'qq', to: '小美', text: '好', createdAt: NOW },
        { id: 'bad', platform: 'wechat', text: '不支持的平台' },
        'nonsense',
      ]),
    );
    const service = createSocialDraftService({ storage });
    expect(service.list().map((draft) => draft.id)).toEqual(['ok']);

    expect(service.remove('ok')).toBe(true);
    expect(service.remove('ok')).toBe(false);
    expect(service.list()).toEqual([]);
    expect(storage.dump()['vistaverge.assistant.socialDrafts']).toBeUndefined();
  });

  it('服务方法按 id 工作；未知 id 返回 null，不抛错也不编造', () => {
    const service = createSocialDraftService({ storage: memStorage(), id: () => 'd1' });
    expect(service.preview('missing')).toBeNull();
    expect(service.requestSend('missing')).toBeNull();
    expect(service.confirmSend('missing', { confirmed: true })).toBeNull();
    expect(service.publish('missing')).toBeNull();

    const draft = service.createDraft('qq', { to: '小美', text: '在吗' });
    expect(service.preview(draft.id)?.bubbles[0].text).toBe('在吗');
  });
});
