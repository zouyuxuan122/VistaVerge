/**
 * teacher/pptx.ts — .pptx（OOXML zip）解析：页序、文本框、图片、备注。
 *
 * 依据：规划.txt「我给他一张 PPT，他就打开 PPT 讲课」；TEACHER_COMPANION §1.1(1)
 * 页码/锚点引用。产出 `SlideDeck` **纯数据结构**，不含任何 DOM/渲染依赖，
 * 便于 node 环境单测；渲染在 UI 层（ui/teacher/LectureView.vue）按比例缩放。
 *
 * 解析路径（全部经 fflate 解压 + 自写轻量 XML 解析，避免依赖 DOMParser）：
 *   1. `ppt/presentation.xml` 的 `<p:sldIdLst>` 给出页序（r:id 引用）；
 *   2. `ppt/_rels/presentation.xml.rels` 把 r:id 映射到 `slides/slideN.xml`；
 *   3. 逐页解析 `p:sp`（a:t 文本、pPr lvl 层级、a:xfrm 位置尺寸 EMU）；
 *   4. `p:pic` 经 slide rels 找到 `ppt/media/*` 字节 → blob URL；
 *   5. `notesSlide` 备注文本。
 *
 * 注入防护：所有解析文本按不可信数据处理，复用 study.detectInjection 标记；
 * 本模块不持有任何工具权限，绝不执行文本中的指令。
 * .ppt（老二进制）明确拒绝并提示「请另存为 .pptx」。
 */

import { unzipSync } from 'fflate';
import { detectInjection, type StudyEvent } from './study';
import { newId } from '../data/util';

/** EMU → CSS px：1 inch = 914400 EMU，CSS 96 px/inch。 */
export const EMU_PER_PX = 9525;

export function emuToPx(emu: number): number {
  return Math.round((emu / EMU_PER_PX) * 100) / 100;
}

export interface SlideParagraph {
  /** pPr@lvl，0 为顶层。 */
  level: number;
  text: string;
}

export interface SlideTextBox {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  paragraphs: SlideParagraph[];
  text: string;
}

export interface SlideImage {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** slide 内关系 ID（a:blip@r:embed）。 */
  relId: string;
  /** zip 内媒体路径，如 ppt/media/image1.png；关系缺失时为 null。 */
  mediaPath: string | null;
  mimeType: string | null;
  bytes: Uint8Array | null;
  /** 可渲染 URL（blob: 优先，无 createObjectURL 时退化为 data:）。 */
  url: string | null;
  urlIsBlob: boolean;
}

export interface Slide {
  /** 1 起的页序。 */
  index: number;
  /** zip 内路径，如 ppt/slides/slide1.xml。 */
  partPath: string;
  texts: SlideTextBox[];
  images: SlideImage[];
  notes: string;
  /** 该页文本或备注命中指令式内容（仅标记，不执行）。 */
  injectionDetected: boolean;
}

export interface SlideDeck {
  name: string;
  slides: Slide[];
  /** 幻灯片尺寸（px，按 EMU 换算）；缺失时用 960×540 兜底。 */
  widthPx: number;
  heightPx: number;
  events: StudyEvent[];
}

/* ------------------------------------------------------------------ */
/* 轻量 XML 解析（无 DOM 依赖，node/jsdom 通用）                        */
/* ------------------------------------------------------------------ */

interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    return named[entity] ?? whole;
  });
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) attrs[match[1]!] = decodeEntities(match[2]!);
  return attrs;
}

/** 解析 XML 为树；未知/畸形标签被跳过，不抛错（解析文本是数据）。 */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { tag: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const clean = xml
    .replace(/^\uFEFF/, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>]*>/g, '');
  const tagRe = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(clean)) !== null) {
    const between = clean.slice(lastIndex, match.index);
    if (between.trim().length > 0) stack[stack.length - 1]!.text += decodeEntities(between);
    lastIndex = tagRe.lastIndex;
    if (match[1] === '/') {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const node: XmlNode = { tag: match[2]!, attrs: parseAttrs(match[3] ?? ''), children: [], text: '' };
    stack[stack.length - 1]!.children.push(node);
    if (match[4] !== '/') stack.push(node);
  }
  return root;
}

function localName(tag: string): string {
  const idx = tag.indexOf(':');
  return idx >= 0 ? tag.slice(idx + 1) : tag;
}

function findAll(node: XmlNode, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (current: XmlNode): void => {
    for (const child of current.children) {
      if (localName(child.tag) === name) out.push(child);
      walk(child);
    }
  };
  walk(node);
  return out;
}

function findFirst(node: XmlNode, name: string): XmlNode | null {
  for (const child of node.children) {
    if (localName(child.tag) === name) return child;
    const nested = findFirst(child, name);
    if (nested) return nested;
  }
  return null;
}

function attrAny(node: XmlNode, ...names: string[]): string | null {
  for (const name of names) {
    if (node.attrs[name] !== undefined) return node.attrs[name]!;
  }
  // 关系属性可能带命名空间前缀，按 localName 兜底匹配。
  for (const [key, value] of Object.entries(node.attrs)) {
    if (names.includes(localName(key))) return value;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 路径与关系                                                          */
/* ------------------------------------------------------------------ */

const decoder = new TextDecoder('utf-8');

function readPart(files: Record<string, Uint8Array>, path: string): XmlNode | null {
  const bytes = files[path];
  if (!bytes) return null;
  return parseXml(decoder.decode(bytes));
}

/** 解析相对 target（相对 baseDir）为 zip 内规范路径。 */
export function resolvePartPath(baseDir: string, target: string): string {
  const clean = target.replace(/\\/g, '/').replace(/^\//, '');
  const base = clean.startsWith('ppt/') ? [] : baseDir.split('/').filter(Boolean);
  const segments = [...base];
  for (const part of clean.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') segments.pop();
    else segments.push(part);
  }
  return segments.join('/');
}

function relsPathFor(partPath: string): string {
  const idx = partPath.lastIndexOf('/');
  const dir = idx >= 0 ? partPath.slice(0, idx) : '';
  const file = idx >= 0 ? partPath.slice(idx + 1) : partPath;
  return `${dir}/_rels/${file}.rels`;
}

interface Relationship {
  id: string;
  type: string;
  target: string;
}

function readRelationships(files: Record<string, Uint8Array>, partPath: string): Relationship[] {
  const rels = readPart(files, relsPathFor(partPath));
  if (!rels) return [];
  const relationships = findFirst(rels, 'Relationships');
  if (!relationships) return [];
  const out: Relationship[] = [];
  for (const node of relationships.children) {
    if (localName(node.tag) !== 'Relationship') continue;
    const id = attrAny(node, 'Id', 'id');
    const target = attrAny(node, 'Target', 'target');
    if (!id || !target) continue;
    out.push({ id, type: attrAny(node, 'Type', 'type') ?? '', target });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 形状/图片/备注提取                                                   */
/* ------------------------------------------------------------------ */

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function readBox(spPr: XmlNode | null): Box {
  const xfrm = spPr ? findFirst(spPr, 'xfrm') : null;
  if (!xfrm) return { x: 0, y: 0, width: 0, height: 0 };
  const off = findFirst(xfrm, 'off');
  const ext = findFirst(xfrm, 'ext');
  return {
    x: emuToPx(Number(off?.attrs.x ?? 0)),
    y: emuToPx(Number(off?.attrs.y ?? 0)),
    width: emuToPx(Number(ext?.attrs.cx ?? 0)),
    height: emuToPx(Number(ext?.attrs.cy ?? 0)),
  };
}

function readParagraphs(txBody: XmlNode | null): SlideParagraph[] {
  if (!txBody) return [];
  const paragraphs: SlideParagraph[] = [];
  for (const node of findAll(txBody, 'p')) {
    const pPr = findFirst(node, 'pPr');
    const level = Number(pPr?.attrs.lvl ?? 0) || 0;
    const runs = [...findAll(node, 't'), ...findAll(node, 'fld')]
      .map((run) => run.text)
      .join('');
    const text = runs.trim();
    if (text.length > 0) paragraphs.push({ level, text });
  }
  return paragraphs;
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  tiff: 'image/tiff',
  emf: 'image/emf',
  wmf: 'image/wmf',
};

function mimeForPath(path: string): string | null {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return MIME_BY_EXT[ext] ?? null;
}

function toDataUrl(bytes: Uint8Array, mime: string): string | null {
  const g = globalThis as { btoa?: (s: string) => string; Buffer?: { from: (b: Uint8Array) => { toString: (enc: string) => string } } };
  try {
    let binary = '';
    if (typeof g.Buffer !== 'undefined') {
      binary = g.Buffer.from(bytes).toString('base64');
    } else if (typeof g.btoa === 'function') {
      let chunk = '';
      for (let i = 0; i < bytes.length; i += 1) chunk += String.fromCharCode(bytes[i]!);
      binary = g.btoa(chunk);
    } else {
      return null;
    }
    return `data:${mime};base64,${binary}`;
  } catch {
    return null;
  }
}

/** 优先 blob URL（可 revoke）；无 createObjectURL 时退化为 data URL 并如实标记。 */
function toObjectUrl(bytes: Uint8Array, mime: string): { url: string | null; isBlob: boolean } {
  const g = globalThis as { URL?: { createObjectURL?: (b: unknown) => string }; Blob?: new (parts: unknown[], options: { type: string }) => unknown };
  try {
    if (typeof g.URL?.createObjectURL === 'function' && typeof g.Blob === 'function') {
      const blob = new g.Blob([bytes], { type: mime });
      return { url: g.URL.createObjectURL(blob), isBlob: true };
    }
  } catch {
    /* 落到 data URL */
  }
  return { url: toDataUrl(bytes, mime), isBlob: false };
}

function readNotes(files: Record<string, Uint8Array>, slidePath: string): string {
  const rels = readRelationships(files, slidePath);
  const notesRel = rels.find((rel) => rel.type.endsWith('/notesSlide') || /notesSlide\d+\.xml$/.test(rel.target));
  if (!notesRel) return '';
  const target = resolvePartPath(slidePath.slice(0, slidePath.lastIndexOf('/')), notesRel.target);
  const notesXml = readPart(files, target);
  if (!notesXml) return '';
  return findAll(notesXml, 't')
    .map((node) => node.text)
    .join('')
    .trim();
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

export interface ParsePptxInput {
  name: string;
  bytes: Uint8Array;
}

const FALLBACK_WIDTH_PX = 960;
const FALLBACK_HEIGHT_PX = 540;

/** 解析 .pptx。老式 .ppt / 非 zip / 缺 presentation.xml 均明确报错，不臆造内容。 */
export function parsePptx(input: ParsePptxInput): SlideDeck {
  const name = input.name?.trim() || '未命名演示文稿';
  if (/\.ppt$/i.test(name)) {
    throw new Error('不支持旧版 .ppt 二进制格式，请用 PowerPoint/WPS 另存为 .pptx 后再导入');
  }
  const bytes = input.bytes;
  if (!bytes || bytes.byteLength < 2 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error('文件不是有效的 .pptx（zip）包，请确认另存为 .pptx');
  }

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes) as Record<string, Uint8Array>;
  } catch (error) {
    throw new Error(`.pptx 解压失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const presentationPath = 'ppt/presentation.xml';
  const presentation = readPart(files, presentationPath);
  if (!presentation) {
    throw new Error('无效的 .pptx：缺少 ppt/presentation.xml');
  }

  const presentationRels = readRelationships(files, presentationPath);
  const relById = new Map(presentationRels.map((rel) => [rel.id, rel]));

  // 页序：sldIdLst 中的 sldId@r:id 顺序。
  const slidePaths: string[] = [];
  const sldIdLst = findFirst(presentation, 'sldIdLst');
  const sldIds = sldIdLst ? findAll(sldIdLst, 'sldId') : [];
  for (const sldId of sldIds) {
    const relId = attrAny(sldId, 'r:id', 'embed', 'id');
    if (!relId) continue;
    const rel = relById.get(relId);
    if (!rel) continue;
    slidePaths.push(resolvePartPath('ppt', rel.target));
  }
  // 无 sldIdLst（异常包）时退回按文件名顺序扫描，保证不空手而归。
  if (slidePaths.length === 0) {
    const discovered = Object.keys(files)
      .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
      .sort((a, b) => Number(a.match(/slide(\d+)/)![1]) - Number(b.match(/slide(\d+)/)![1]));
    slidePaths.push(...discovered);
  }

  const sldSz = findFirst(presentation, 'sldSz');
  const widthPx = sldSz ? emuToPx(Number(sldSz.attrs.cx ?? 0)) || FALLBACK_WIDTH_PX : FALLBACK_WIDTH_PX;
  const heightPx = sldSz ? emuToPx(Number(sldSz.attrs.cy ?? 0)) || FALLBACK_HEIGHT_PX : FALLBACK_HEIGHT_PX;

  const events: StudyEvent[] = [];
  const slides: Slide[] = [];

  slidePaths.forEach((slidePath, position) => {
    const slideXml = readPart(files, slidePath);
    const rels = readRelationships(files, slidePath);
    const slideDir = slidePath.slice(0, slidePath.lastIndexOf('/'));
    const texts: SlideTextBox[] = [];
    const images: SlideImage[] = [];

    if (slideXml) {
      for (const sp of findAll(slideXml, 'sp')) {
        const cNvPr = findFirst(sp, 'cNvPr');
        const paragraphs = readParagraphs(findFirst(sp, 'txBody'));
        if (paragraphs.length === 0) continue;
        const box = readBox(findFirst(sp, 'spPr'));
        texts.push({
          id: cNvPr?.attrs.id ?? newId(),
          name: cNvPr?.attrs.name ?? '',
          ...box,
          paragraphs,
          text: paragraphs.map((paragraph) => paragraph.text).join('\n'),
        });
      }

      for (const pic of findAll(slideXml, 'pic')) {
        const cNvPr = findFirst(pic, 'cNvPr');
        const blip = findFirst(pic, 'blip');
        const relId = blip ? attrAny(blip, 'embed', 'r:embed', 'link') ?? '' : '';
        const box = readBox(findFirst(pic, 'spPr'));
        let mediaPath: string | null = null;
        let mimeType: string | null = null;
        let mediaBytes: Uint8Array | null = null;
        let url: string | null = null;
        let urlIsBlob = false;
        const rel = rels.find((entry) => entry.id === relId);
        if (rel) {
          mediaPath = resolvePartPath(slideDir, rel.target);
          mediaBytes = files[mediaPath] ?? null;
          if (mediaBytes) {
            mimeType = mimeForPath(mediaPath);
            if (mimeType) {
              const objectUrl = toObjectUrl(mediaBytes, mimeType);
              url = objectUrl.url;
              urlIsBlob = objectUrl.isBlob;
            }
          }
        }
        images.push({
          id: cNvPr?.attrs.id ?? newId(),
          name: cNvPr?.attrs.name ?? '',
          ...box,
          relId,
          mediaPath,
          mimeType,
          bytes: mediaBytes,
          url,
          urlIsBlob,
        });
      }
    }

    const notes = readNotes(files, slidePath);
    const pageText = texts.map((box) => box.text).join('\n');
    const injectionDetected = detectInjection(`${pageText}\n${notes}`).length > 0;
    const index = position + 1;
    slides.push({ index, partPath: slidePath, texts, images, notes, injectionDetected });
    if (injectionDetected) {
      events.push({
        type: 'material.injection.detected',
        at: Date.now(),
        traceId: newId(),
        detail: { name, anchor: `幻灯片 第${index}页`, source: 'pptx' },
      });
    }
  });

  if (slides.length === 0) {
    throw new Error('无效的 .pptx：未找到任何幻灯片');
  }

  return { name, slides, widthPx, heightPx, events };
}

/** 释放解析期创建的 blob URL（不释放 data URL）。 */
export function revokeDeckUrls(deck: SlideDeck): void {
  const g = globalThis as { URL?: { revokeObjectURL?: (url: string) => void } };
  if (typeof g.URL?.revokeObjectURL !== 'function') return;
  for (const slide of deck.slides) {
    for (const image of slide.images) {
      if (image.urlIsBlob && image.url) {
        try {
          g.URL.revokeObjectURL(image.url);
        } catch {
          /* 已释放或环境不支持：忽略 */
        }
      }
    }
  }
}
