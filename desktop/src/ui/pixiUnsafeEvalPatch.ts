/**
 * ui/pixiUnsafeEvalPatch.ts — 让 pixi 在禁止 eval 的 CSP 下工作（打包版必需）。
 *
 * 为什么需要：打包版 CSP 是 `script-src 'self' 'wasm-unsafe-eval'`（不含 'unsafe-eval'），
 * pixi v7 的 `ShaderSystem.systemCheck()` 会直接抛
 * 「Current environment does not allow unsafe-eval」，Live2D 在**安装版里永远起不来**
 * （`vite` dev 不注入 CSP，所以这个缺陷只在真实桌面窗口暴露）。
 *
 * 为什么内联而不是装 `@pixi/unsafe-eval`：本仓库的依赖树是 pixi v6/v7 混血
 * ——`pixi-live2d-display@0.4.0` 拉着 `@pixi/*@6.5.10`（顶层），而应用用 `pixi.js@7.2.4`
 * （其 @pixi/* 7.x 嵌套在 pixi.js 内部）。`@pixi/unsafe-eval@7.2.4` 的 peer 要求
 * `@pixi/core@7.2.4`，与 v6 那一套冲突，装它会重排整棵树并破坏类型与解析
 * （实测：顶层 @pixi/* 被搬走，Live2DModel 类型直接崩）。
 *
 * 源码来源：`@pixi/unsafe-eval@7.2.4`（MIT），逐行照搬 `lib/install.mjs` +
 * `lib/syncUniforms.mjs`，只做两处调整：
 *   1. 从 `pixi.js` 取 `ShaderSystem`（与 `new PIXI.Application()` 用的是同一个类对象，
 *      从 `@pixi/core` 取会拿到顶层那份 6.5.10，补丁打不到点上）；
 *   2. 去掉 7.1.0 起已废弃的 `install()` 包装与 deprecation 提示。
 * 这是渲染热路径代码，不做「顺手优化」，保持与原实现逐行一致。
 */

import { ShaderSystem } from 'pixi.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFn = (...args: any[]) => void;

const GLSL_TO_SINGLE_SETTERS: Record<string, AnyFn> = {
  float(gl, location, cv, v) {
    if (cv !== v) {
      cv.v = v;
      gl.uniform1f(location, v);
    }
  },
  vec2(gl, location, cv, v) {
    if (cv[0] !== v[0] || cv[1] !== v[1]) {
      cv[0] = v[0];
      cv[1] = v[1];
      gl.uniform2f(location, v[0], v[1]);
    }
  },
  vec3(gl, location, cv, v) {
    if (cv[0] !== v[0] || cv[1] !== v[1] || cv[2] !== v[2]) {
      cv[0] = v[0];
      cv[1] = v[1];
      cv[2] = v[2];
      gl.uniform3f(location, v[0], v[1], v[2]);
    }
  },
  int(gl, location, _cv, value) {
    gl.uniform1i(location, value);
  },
  ivec2(gl, location, _cv, value) {
    gl.uniform2i(location, value[0], value[1]);
  },
  ivec3(gl, location, _cv, value) {
    gl.uniform3i(location, value[0], value[1], value[2]);
  },
  ivec4(gl, location, _cv, value) {
    gl.uniform4i(location, value[0], value[1], value[2], value[3]);
  },
  uint(gl, location, _cv, value) {
    gl.uniform1ui(location, value);
  },
  uvec2(gl, location, _cv, value) {
    gl.uniform2ui(location, value[0], value[1]);
  },
  uvec3(gl, location, _cv, value) {
    gl.uniform3ui(location, value[0], value[1], value[2]);
  },
  uvec4(gl, location, _cv, value) {
    gl.uniform4ui(location, value[0], value[1], value[2], value[3]);
  },
  bool(gl, location, cv, v) {
    if (cv !== v) {
      cv.v = v;
      gl.uniform1i(location, Number(v));
    }
  },
  bvec2(gl, location, _cv, value) {
    gl.uniform2i(location, value[0], value[1]);
  },
  bvec3(gl, location, _cv, value) {
    gl.uniform3i(location, value[0], value[1], value[2]);
  },
  bvec4(gl, location, _cv, value) {
    gl.uniform4i(location, value[0], value[1], value[2], value[3]);
  },
  mat2(gl, location, _cv, value) {
    gl.uniformMatrix2fv(location, false, value);
  },
  mat3(gl, location, _cv, value) {
    gl.uniformMatrix3fv(location, false, value);
  },
  mat4(gl, location, _cv, value) {
    gl.uniformMatrix4fv(location, false, value);
  },
  sampler2D(gl, location, _cv, value) {
    gl.uniform1i(location, value);
  },
  samplerCube(gl, location, _cv, value) {
    gl.uniform1i(location, value);
  },
  sampler2DArray(gl, location, _cv, value) {
    gl.uniform1i(location, value);
  },
};

const GLSL_TO_ARRAY_SETTERS: Record<string, AnyFn> = {
  float(gl, location, _cv, value) {
    gl.uniform1fv(location, value);
  },
  vec2(gl, location, _cv, value) {
    gl.uniform2fv(location, value);
  },
  vec3(gl, location, _cv, value) {
    gl.uniform3fv(location, value);
  },
  vec4(gl, location, _cv, value) {
    gl.uniform4fv(location, value);
  },
  int(gl, location, _cv, value) {
    gl.uniform1iv(location, value);
  },
  ivec2(gl, location, _cv, value) {
    gl.uniform2iv(location, value);
  },
  ivec3(gl, location, _cv, value) {
    gl.uniform3iv(location, value);
  },
  ivec4(gl, location, _cv, value) {
    gl.uniform4iv(location, value);
  },
  uint(gl, location, _cv, value) {
    gl.uniform1uiv(location, value);
  },
  uvec2(gl, location, _cv, value) {
    gl.uniform2uiv(location, value);
  },
  uvec3(gl, location, _cv, value) {
    gl.uniform3uiv(location, value);
  },
  uvec4(gl, location, _cv, value) {
    gl.uniform4uiv(location, value);
  },
  bool(gl, location, _cv, value) {
    gl.uniform1iv(location, value);
  },
  bvec2(gl, location, _cv, value) {
    gl.uniform2iv(location, value);
  },
  bvec3(gl, location, _cv, value) {
    gl.uniform3iv(location, value);
  },
  bvec4(gl, location, _cv, value) {
    gl.uniform4iv(location, value);
  },
  sampler2D(gl, location, _cv, value) {
    gl.uniform1iv(location, value);
  },
  samplerCube(gl, location, _cv, value) {
    gl.uniform1iv(location, value);
  },
  sampler2DArray(gl, location, _cv, value) {
    gl.uniform1iv(location, value);
  },
};

/** 解释执行版 uniform 同步：完全绕开 eval 生成的 setter。 */
function syncUniforms(group: any, uniformData: any, ud: any, uv: any, renderer: any): void {
  let textureCount = 0;
  let v: any = null;
  let cv: any = null;
  const gl = renderer.gl;
  for (const i in group.uniforms) {
    const data = uniformData[i];
    const uvi = uv[i];
    const udi = ud[i];
    const gu = group.uniforms[i];
    if (!data) {
      if (gu.group) {
        renderer.shader.syncUniformGroup(uvi);
      }
      continue;
    }
    if (data.type === 'float' && data.size === 1) {
      if (uvi !== udi.value) {
        udi.value = uvi;
        gl.uniform1f(udi.location, uvi);
      }
    } else if (
      (data.type === 'sampler2D' || data.type === 'samplerCube' || data.type === 'sampler2DArray') &&
      data.size === 1 &&
      !data.isArray
    ) {
      renderer.texture.bind(uvi, textureCount);
      if (udi.value !== textureCount) {
        udi.value = textureCount;
        gl.uniform1i(udi.location, textureCount);
      }
      textureCount++;
    } else if (data.type === 'mat3' && data.size === 1) {
      if (gu.a !== undefined) {
        gl.uniformMatrix3fv(udi.location, false, uvi.toArray(true));
      } else {
        gl.uniformMatrix3fv(udi.location, false, uvi);
      }
    } else if (data.type === 'vec2' && data.size === 1) {
      if (gu.x !== undefined) {
        cv = udi.value;
        v = uvi;
        if (cv[0] !== v.x || cv[1] !== v.y) {
          cv[0] = v.x;
          cv[1] = v.y;
          gl.uniform2f(udi.location, v.x, v.y);
        }
      } else {
        cv = udi.value;
        v = uvi;
        if (cv[0] !== v[0] || cv[1] !== v[1]) {
          cv[0] = v[0];
          cv[1] = v[1];
          gl.uniform2f(udi.location, v[0], v[1]);
        }
      }
    } else if (data.type === 'vec4' && data.size === 1) {
      if (gu.width !== undefined) {
        cv = udi.value;
        v = uvi;
        if (cv[0] !== v.x || cv[1] !== v.y || cv[2] !== v.width || cv[3] !== v.height) {
          cv[0] = v.x;
          cv[1] = v.y;
          cv[2] = v.width;
          cv[3] = v.height;
          gl.uniform4f(udi.location, v.x, v.y, v.width, v.height);
        }
      } else {
        cv = udi.value;
        v = uvi;
        if (cv[0] !== v[0] || cv[1] !== v[1] || cv[2] !== v[2] || cv[3] !== v[3]) {
          cv[0] = v[0];
          cv[1] = v[1];
          cv[2] = v[2];
          cv[3] = v[3];
          gl.uniform4f(udi.location, v[0], v[1], v[2], v[3]);
        }
      }
    } else {
      const funcArray = data.size === 1 ? GLSL_TO_SINGLE_SETTERS : GLSL_TO_ARRAY_SETTERS;
      funcArray[data.type].call(null, gl, udi.location, udi.value, uvi);
    }
  }
}

let installed = false;

/**
 * 给 ShaderSystem 打补丁：systemCheck 置空 + 用解释执行版 syncUniforms。
 * 幂等；必须在创建 PIXI.Application 之前调用。
 */
export function installPixiUnsafeEvalPatch(): void {
  if (installed) return;
  Object.assign(ShaderSystem.prototype as unknown as Record<string, unknown>, {
    systemCheck() {
      /* CSP 下没有 eval：不做检查，改用下面的解释执行版同步 */
    },
    syncUniforms(this: any, group: any, glProgram: any) {
      const { shader, renderer } = this;
      syncUniforms(group, shader.program.uniformData, glProgram.uniformData, group.uniforms, renderer);
    },
  });
  installed = true;
}
