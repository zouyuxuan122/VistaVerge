/**
 * plugins/views/marketView.ts — 市场面板（可挂载组件实现）。
 *
 * 需求（EXP-006 步骤 3）：源 URL 配置、列表、详情、权限差异、安装/停用；
 * 仅数据包，明示“可执行插件未开放”。
 *
 * 组件不假定 App 结构：依赖经 props 注入（默认自建），可独立挂载测试。
 * 说明：本仓库 vitest 配置未包含 Vue SFC 插件，因此可挂载实现放在 .ts 中，
 * `src/ui/MarketView.vue` 是同名 SFC 薄包装。
 */

import { computed, defineComponent, h, onMounted, ref, type PropType } from 'vue';
import { createMarketStore, type MarketStore } from './marketStore';

export const MarketView = defineComponent({
  name: 'MarketView',
  props: {
    store: { type: Object as PropType<MarketStore>, default: undefined },
  },
  setup(props) {
    const store = props.store ?? createMarketStore();
    const sourceInput = ref(store.sourceUrl ?? '');
    const entries = ref(store.list());
    const selected = ref(store.selected());
    const error = ref(store.lastError());
    const busy = ref(false);

    function sync(): void {
      entries.value = store.list();
      selected.value = store.selected();
      error.value = store.lastError();
    }

    onMounted(sync);

    async function refresh(): Promise<void> {
      store.setSource(sourceInput.value);
      busy.value = true;
      try {
        await store.refresh();
      } finally {
        busy.value = false;
        sync();
      }
    }

    function select(id: string): void {
      store.select(id);
      sync();
    }

    async function run(action: () => Promise<unknown>): Promise<void> {
      busy.value = true;
      try {
        await action();
      } finally {
        busy.value = false;
        sync();
      }
    }

    const notice = computed(
      () => '仅支持数据包（theme / character）；可执行插件未开放，安装包不携带可执行脚本。',
    );

    function renderDetail(): ReturnType<typeof h> | null {
      const view = selected.value;
      if (!view) return null;
      const { entry, installed, permissionDiff } = view;
      const children: (ReturnType<typeof h> | null)[] = [
        h('h3', { 'data-test': 'market-detail-title' }, `${entry.name ?? entry.id} @${entry.version}`),
        h('p', { 'data-test': 'market-detail-id' }, `ID：${entry.id}　种类：${entry.kind}　发行者：${entry.publisher ?? '未声明'}`),
        h('p', { 'data-test': 'market-detail-license' }, `许可证：${entry.license}`),
        h(
          'p',
          { 'data-test': 'market-detail-permissions' },
          `声明权限：${entry.permissions.length > 0 ? entry.permissions.join(', ') : '无'}`,
        ),
        h('p', {}, `sha256：${entry.sha256.slice(0, 16)}…　体积：${entry.size} 字节`),
        h('p', { 'data-test': 'market-detail-signature' }, entry.signature ? '已附签名引用（信任需发行者签名核验）' : '未附签名引用：哈希仅验证一致性，不建立信任'),
      ];
      if (entry.description) children.push(h('p', {}, entry.description));
      if (permissionDiff.added.length > 0) {
        children.push(
          h(
            'p',
            { 'data-test': 'market-perm-added' },
            `新增权限：${permissionDiff.added.join(', ')}（需重新同意后生效，不自动激活）`,
          ),
        );
      }
      if (permissionDiff.removed.length > 0) {
        children.push(
          h('p', { 'data-test': 'market-perm-removed' }, `移除权限：${permissionDiff.removed.join(', ')}`),
        );
      }

      const buttons: ReturnType<typeof h>[] = [];
      if (!installed) {
        buttons.push(
          h('button', { 'data-test': 'market-install', onClick: () => run(() => store.install(entry.id)) }, '安装'),
        );
      } else if (installed.enabled) {
        buttons.push(
          h('button', { 'data-test': 'market-disable', onClick: () => run(() => store.disable(entry.id)) }, '停用（撤销权限）'),
        );
        buttons.push(
          h('button', { 'data-test': 'market-uninstall', onClick: () => run(() => store.uninstall(entry.id)) }, '卸载'),
        );
      } else {
        buttons.push(
          h('button', { 'data-test': 'market-enable', onClick: () => run(() => store.enable(entry.id)) }, '启用'),
        );
        buttons.push(
          h('button', { 'data-test': 'market-uninstall', onClick: () => run(() => store.uninstall(entry.id)) }, '卸载'),
        );
      }
      children.push(h('div', { class: 'market-actions' }, buttons));
      return h('div', { 'data-test': 'market-detail', class: 'market-detail' }, children);
    }

    return () =>
      h('section', { 'data-test': 'market-view', class: 'market-view' }, [
        h('p', { 'data-test': 'market-notice', class: 'market-notice' }, notice.value),
        h('div', { class: 'market-source' }, [
          h('input', {
            'data-test': 'market-source-input',
            class: 'market-source-input',
            value: sourceInput.value,
            placeholder: 'https://…/index.json',
            onInput: (event: Event) => {
              sourceInput.value = (event.target as HTMLInputElement).value;
            },
          }),
          h('button', { 'data-test': 'market-refresh', disabled: busy.value, onClick: refresh }, '刷新索引'),
        ]),
        error.value ? h('p', { 'data-test': 'market-error', class: 'market-error' }, error.value) : null,
        h(
          'ul',
          { class: 'market-list' },
          entries.value.map((view) =>
            h(
              'li',
              {
                'data-test': 'market-item',
                class: ['market-item', view.entry.id === selected.value?.entry.id ? 'is-selected' : ''],
                onClick: () => select(view.entry.id),
              },
              [
                h('span', { 'data-test': 'market-item-id' }, `${view.entry.id} @${view.entry.version}`),
                h('span', { 'data-test': 'market-item-kind' }, ` [${view.entry.kind}]`),
                h(
                  'span',
                  { 'data-test': 'market-item-state' },
                  view.installed ? (view.installed.enabled ? ' 已启用' : ' 已停用') : ' 未安装',
                ),
              ],
            ),
          ),
        ),
        renderDetail(),
      ]);
  },
});

export default MarketView;
