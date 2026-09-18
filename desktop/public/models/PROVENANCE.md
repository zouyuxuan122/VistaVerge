# desktop/public/models/ 素材来源登记（PROVENANCE）

## macbook-source.glb（639,284 bytes）

- **SHA-256**：`6f4b01027858cbc5fd7a8320bbf48b66d553c67b39feabe19007eb91eafe96a1`
- **模型**："MacBook Pro M3 16-inch 2024"，作者 **jackbaeten**（Sketchfab）
  https://sketchfab.com/3d-models/macbook-pro-m3-16-inch-2024-8e34fc2b303144f78490007d91ff57c4
- **许可**：**CC-BY 4.0**（https://creativecommons.org/licenses/by/4.0/）——需署名；署名信息已内嵌 GLB `asset.extras`，应用内署名见 DeskLaptop 道具的右下角标注。
- **修改者**：William Laverty（https://github.com/william-laverty/rigged-macbook-3d）——Space Black 配色、铰链拆分。
- **下载源**：https://raw.githubusercontent.com/william-laverty/rigged-macbook-3d/main/assets/macbook-source.glb （2026-09-19，校验 `glTF` 魔数与字节数一致）
- **署名文本**：见同目录 `CREDITS.md`（上游原样拷贝）。
- **商标**：与 Apple Inc. 无关；"MacBook" 为 Apple 商标，此处仅作描述性指称。
- **技术依赖**：`KHR_draco_mesh_compression` + `EXT_texture_webp` → 运行时用 three 自带 DRACOLoader，解码器文件在 `public/draco/`（three npm 包 MIT 许可，随包分发路径 `three/examples/jsm/libs/draco/gltf/`）。
