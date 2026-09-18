/**
 * plugins/views/memoryView.ts — 记忆面板（查看/搜索/改/删/导出）。
 *
 * 只经 data/memory 的公开接口使用数据层（不修改其内部实现）；服务经 props 注入，
 * 组件可独立挂载测试。删除覆盖全文索引/向量/缓存由数据层 forgetMemory 保证，
 * 本面板只调用它并把结果显示为“已删除”，不谎报。
 */

import { computed, defineComponent, h, onMounted, ref, type PropType } from 'vue';
import {
  correctMemory as defaultCorrect,
  exportMemory as defaultExport,
  forgetMemory as defaultForget,
  searchMemory as defaultSearch,
  type MemoryHit,
  type MemoryRecord,
} from '../../data/memory';

export interface MemoryRow {
  id: string;
  text: string;
  tags: string[];
  score?: number;
  stale?: boolean;
}

export interface MemoryViewService {
  list(): MemoryRecord[];
  search(query: string): MemoryHit[];
  correct(id: string, text: string): void;
  forget(id: string): void;
  exportJson(): string;
}

function toRow(record: MemoryRecord | MemoryHit): MemoryRow {
  const row: MemoryRow = { id: record.id, text: record.text, tags: record.tags ?? [] };
  if ('score' in record) row.score = record.score;
  if ('stale' in record) row.stale = record.stale;
  return row;
}

export function createMemoryViewService(overrides: Partial<MemoryViewService> = {}): MemoryViewService {
  return {
    list: overrides.list ?? (() => defaultExport()),
    search: overrides.search ?? ((query) => defaultSearch({ query })),
    correct: overrides.correct ?? ((id, text) => defaultCorrect(id, text)),
    forget: overrides.forget ?? ((id) => defaultForget(id)),
    exportJson:
      overrides.exportJson ??
      (() => {
        const records = defaultExport();
        return JSON.stringify(records, null, 2);
      }),
  };
}

export const MemoryView = defineComponent({
  name: 'MemoryView',
  props: {
    service: { type: Object as PropType<MemoryViewService>, default: undefined },
    /** 导出回调（宿主可写文件/剪贴板）；缺省只在面板内显示 JSON。 */
    onExport: { type: Function as PropType<(json: string) => void>, default: undefined },
  },
  setup(props) {
    const service = props.service ?? createMemoryViewService();
    const query = ref('');
    const rows = ref<MemoryRow[]>([]);
    const selectedId = ref<string | null>(null);
    const editText = ref('');
    const exportOutput = ref<string | null>(null);
    const searched = ref(false);

    function loadAll(): void {
      rows.value = service.list().map(toRow);
      selectedId.value = null;
      editText.value = '';
    }

    onMounted(loadAll);

    function doSearch(): void {
      const text = query.value.trim();
      if (text.length === 0) {
        searched.value = false;
        loadAll();
        return;
      }
      searched.value = true;
      rows.value = service.search(text).map(toRow);
      selectedId.value = null;
      editText.value = '';
    }

    function select(row: MemoryRow): void {
      selectedId.value = row.id;
      editText.value = row.text;
    }

    function save(): void {
      if (!selectedId.value) return;
      service.correct(selectedId.value, editText.value);
      const id = selectedId.value;
      rows.value = rows.value.map((row) => (row.id === id ? { ...row, text: editText.value } : row));
    }

    function remove(): void {
      if (!selectedId.value) return;
      service.forget(selectedId.value);
      const id = selectedId.value;
      rows.value = rows.value.filter((row) => row.id !== id);
      selectedId.value = null;
      editText.value = '';
    }

    function exportAll(): void {
      const json = service.exportJson();
      exportOutput.value = json;
      props.onExport?.(json);
    }

    const selectedRow = computed(() => rows.value.find((row) => row.id === selectedId.value) ?? null);

    return () =>
      h('section', { 'data-test': 'memory-view', class: 'memory-view' }, [
        h('div', { class: 'memory-toolbar' }, [
          h('input', {
            'data-test': 'memory-search-input',
            class: 'memory-search-input',
            value: query.value,
            placeholder: '搜索记忆（关键词或标签）',
            onInput: (event: Event) => {
              query.value = (event.target as HTMLInputElement).value;
            },
          }),
          h('button', { 'data-test': 'memory-search', onClick: doSearch }, '搜索'),
          h('button', { 'data-test': 'memory-export', onClick: exportAll }, '导出'),
        ]),
        rows.value.length === 0
          ? h(
              'p',
              { 'data-test': 'memory-empty', class: 'memory-empty' },
              searched.value ? '未找到匹配的记忆。' : '暂无记忆记录。',
            )
          : h(
              'ul',
              { class: 'memory-list' },
              rows.value.map((row) =>
                h(
                  'li',
                  {
                    'data-test': 'memory-item',
                    class: ['memory-item', row.id === selectedId.value ? 'is-selected' : ''],
                    onClick: () => select(row),
                  },
                  [
                    h('span', { 'data-test': 'memory-item-text' }, row.text),
                    row.tags.length > 0
                      ? h('span', { 'data-test': 'memory-item-tags' }, ` [${row.tags.join(', ')}]`)
                      : null,
                  ],
                ),
              ),
            ),
        selectedRow.value
          ? h('div', { 'data-test': 'memory-detail', class: 'memory-detail' }, [
              h('textarea', {
                'data-test': 'memory-edit-input',
                class: 'memory-edit-input',
                value: editText.value,
                rows: 3,
                onInput: (event: Event) => {
                  editText.value = (event.target as HTMLTextAreaElement).value;
                },
              }),
              h('div', { class: 'memory-actions' }, [
                h('button', { 'data-test': 'memory-save', onClick: save }, '保存更正'),
                h('button', { 'data-test': 'memory-delete', onClick: remove }, '删除（含索引）'),
              ]),
            ])
          : null,
        exportOutput.value !== null
          ? h('pre', { 'data-test': 'memory-export-output', class: 'memory-export-output' }, exportOutput.value)
          : null,
      ]);
  },
});

export default MemoryView;
