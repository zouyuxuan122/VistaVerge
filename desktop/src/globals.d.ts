// 构建期注入的全局常量（见 vite.config.ts 的 define）。
// true = 本次产物内嵌了 Live2D 模型；false = 发行包（模型由用户自备）。
declare const __VV_LIVE2D_BUNDLED__: boolean;
