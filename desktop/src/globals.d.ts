// 构建期注入的全局常量（见 vite.config.ts 的 define）。
// __VV_LIVE2D_BUNDLED__: 本次产物是否内嵌了 Live2D 模型与 Cubism Core。
// 声明为 `boolean | undefined`：vitest（node 环境，无 Vite define）里它是 undefined，
// 按「已内置」处理，保证单测环境与应用的本地构建行为一致。
declare const __VV_LIVE2D_BUNDLED__: boolean | undefined;
