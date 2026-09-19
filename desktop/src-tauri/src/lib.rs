// lib.rs — VistaVerge：Rust 壳负责窗口 + HTTP 代理（tauri-plugin-http）
// + OS 凭据仓（keyring，service="VistaVerge"）+ 数据库文件持久化命令。
// 语音管线（VAD→STT→LLM→TTS）在前端 TypeScript 引擎里（见 src/engine.ts）。
// 数据层（SQLite/记忆/会话）在前端 data/**（见 src/data/db.ts），
// 这里只提供 db 文件的读写原语供 platform/persistence.ts 调用。

use keyring::{Entry, Error as KeyringError};
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::Manager;

/// OS 凭据仓服务名。所有 API key / token 以该 service + 用户提供的 key 存储。
const KEYRING_SERVICE: &str = "VistaVerge";

/// Windows 保留设备名（大小写不敏感）。这些名字即使带目录前缀也会被解析为设备，
/// `db_write_file("NUL", …)` 会静默写到空设备而不是报错。
const WINDOWS_RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// 数据库文件名白名单：仅 ASCII 字母/数字/点/下划线/连字符，不以点开头，
/// 长度受限。防止路径分隔符与 `..` 逃逸 app_data_dir；并拒绝 Windows 保留名
/// 与结尾点/空格（`foo.` 与 `foo` 在 Windows 上是同一个文件）。
fn is_safe_db_file_name(name: &str) -> bool {
    if name.is_empty()
        || name.len() > 128
        || name.starts_with('.')
        || name.contains("..")
        || name.ends_with('.')
        || name.ends_with(' ')
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return false;
    }
    let stem = name.split('.').next().unwrap_or(name);
    !WINDOWS_RESERVED.iter().any(|r| stem.eq_ignore_ascii_case(r))
}

fn resolve_db_path(app: &tauri::AppHandle, name: &str) -> Result<std::path::PathBuf, String> {
    if !is_safe_db_file_name(name) {
        return Err(format!("invalid db file name: {name:?}"));
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    Ok(dir.join(name))
}

/// 写入 OS 凭据仓（无则创建）。
/// async：Tauri 会把它放到异步运行时执行，DPAPI/凭据管理器可能较慢，
/// 同步命令会在主线程阻塞 webview 事件循环。
#[tauri::command]
async fn set_secret(key: String, value: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let entry = Entry::new(KEYRING_SERVICE, &key).map_err(|e| e.to_string())?;
        entry.set_password(&value).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("set_secret join error: {e}"))?
}

/// 读取 OS 凭据仓；不存在返回 None（不算错误）。
#[tauri::command]
async fn get_secret(key: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let entry = Entry::new(KEYRING_SERVICE, &key).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|e| format!("get_secret join error: {e}"))?
}

/// 删除 OS 凭据仓条目；不存在返回 Ok(false)（幂等，不算错误）。
#[tauri::command]
async fn delete_secret(key: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let entry = Entry::new(KEYRING_SERVICE, &key).map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) => Ok(true),
            Err(KeyringError::NoEntry) => Ok(false),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|e| format!("delete_secret join error: {e}"))?
}

/// 读取 app_data_dir 下的数据库文件；不存在返回 Ok(None)。
#[tauri::command]
async fn db_read_file(app: tauri::AppHandle, name: String) -> Result<Option<Vec<u8>>, String> {
    let path = resolve_db_path(&app, &name)?;
    tauri::async_runtime::spawn_blocking(move || {
        if !path.exists() {
            return Ok(None);
        }
        std::fs::read(&path).map(Some).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("db_read_file join error: {e}"))?
}

/// 写 app_data_dir 下的数据库文件（唯一临时文件 + fsync + rename 原子替换）。
///
/// 这里是会话/记忆/用量的唯一持久化路径，必须防掉电截断：
/// 先写临时文件并 `sync_all`，再 rename，最后清理失败残留的临时文件。
#[tauri::command]
async fn db_write_file(app: tauri::AppHandle, name: String, data: Vec<u8>) -> Result<(), String> {
    let path = resolve_db_path(&app, &name)?;
    tauri::async_runtime::spawn_blocking(move || {
        let dir = path
            .parent()
            .ok_or_else(|| "db path has no parent".to_string())?
            .to_path_buf();
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

        // 唯一临时名：避免 `a.db`/`a.txt` 撞同一临时文件，也避免名字本身以 .tmp 结尾时
        // 临时文件就是目标文件（那样 rename 会变成空操作，等于没有原子性）。
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let unique = SEQ.fetch_add(1, Ordering::Relaxed);
        let tmp = dir.join(format!(".{}.{}.{}.tmp", name, std::process::id(), unique));

        let write_result = (|| -> std::io::Result<()> {
            let mut file = std::fs::File::create(&tmp)?;
            file.write_all(&data)?;
            file.sync_all()?;
            drop(file);
            std::fs::rename(&tmp, &path)
        })();

        if let Err(e) = write_result {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("db_write_file join error: {e}"))?
}

/* ------------------------------------------------------------------ */
/* Live2D 模型运行时导入                                               */
/* ------------------------------------------------------------------ */

/// Windows 保留设备名（大小写不敏感）——同样适用于导入的模型文件名。
const IMPORT_RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// 校验前端提交的模型相对路径。
///
/// 允许：`fense/fense.model3.json` 这类嵌套相对路径（含非 ASCII 文件名）。
/// 拒绝：绝对路径、盘符、反斜杠、`..` 段、空段、控制字符、Windows 保留设备名。
/// 这是**唯一的写入边界**：模型文件最终落在 app_data_dir/live2d/imported/ 下，
/// 并通过 asset 协议（scope 限定该目录）暴露给前端，路径必须在此处收死。
fn is_safe_import_rel_path(rel: &str) -> bool {
    if rel.is_empty() || rel.len() > 512 {
        return false;
    }
    if rel.chars().any(|c| c.is_control()) {
        return false;
    }
    if rel.contains('\\') || rel.starts_with('/') || rel.contains(':') {
        return false;
    }
    let reserved = |stem: &str| IMPORT_RESERVED.iter().any(|r| stem.eq_ignore_ascii_case(r));
    rel.split('/').all(|segment| {
        if segment.is_empty() || segment == "." || segment == ".." || segment.ends_with('.') || segment.ends_with(' ')
        {
            return false;
        }
        let stem = segment.split('.').next().unwrap_or(segment);
        !reserved(stem)
    })
}

/// 单文件大小上限（64MB）：模型最大的是整张贴图，64MB 足够且能挡住异常载荷。
const IMPORT_MAX_FILE_BYTES: usize = 64 * 1024 * 1024;

/// 导入一个模型文件（大文件由前端分块多次调用，`append=true` 时续写）。
///
/// 目标固定为 app_data_dir/live2d/imported/<rel_path>：
/// 路径无法逃出该目录（校验见 `is_safe_import_rel_path`），写入后 sync_all 防掉电截断。
#[tauri::command]
async fn import_model_file(
    app: tauri::AppHandle,
    rel_path: String,
    data: Vec<u8>,
    append: bool,
) -> Result<(), String> {
    if !is_safe_import_rel_path(&rel_path) {
        return Err(format!("invalid model relative path: {rel_path:?}"));
    }
    if data.len() > IMPORT_MAX_FILE_BYTES {
        return Err(format!(
            "chunk too large: {} bytes (max {IMPORT_MAX_FILE_BYTES})",
            data.len()
        ));
    }
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join("live2d")
        .join("imported");
    let target = root.join(&rel_path);
    // 双保险：拼接后再确认仍落在 root 内（防未来校验改动引入回归）。
    let canonical_root = root
        .canonicalize()
        .unwrap_or(root.clone());
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let canonical_target = target.canonicalize().unwrap_or(target.clone());
    if !canonical_target.starts_with(&canonical_root) {
        return Err(format!("import path escapes model dir: {rel_path:?}"));
    }

    tauri::async_runtime::spawn_blocking(move || {
        let mut file = if append {
            std::fs::OpenOptions::new()
                .append(true)
                .open(&target)
                .map_err(|e| e.to_string())?
        } else {
            std::fs::File::create(&target).map_err(|e| e.to_string())?
        };
        file.write_all(&data).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| format!("import_model_file join error: {e}"))?
}

/* ------------------------------------------------------------------ */
/* 按路径整目录导入（设置页第二条通道；也是可自动化的验证入口）          */
/* ------------------------------------------------------------------ */

#[derive(serde::Serialize)]
struct ImportedModelSummary {
    /// 模型入口（*.model3.json）相对 imported 根的路径；找不到时为 None。
    model_path: Option<String>,
    /// Cubism Core（live2dcubismcore*.js）相对路径；用户没一起提供时为 None。
    core_path: Option<String>,
    file_count: u64,
    total_bytes: u64,
    /// 因路径不安全被跳过的文件（最多列 3 个），供前端提示。
    skipped: Vec<String>,
}

/// 整目录导入的上限（与前端预检一致；真正拦截在这里）。
const IMPORT_MAX_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
const IMPORT_MAX_FILES: usize = 800;
const IMPORT_MAX_WALK_DEPTH: usize = 8;

/// 递归收集一个模型目录下全部安全文件（相对路径 + 大小），不做任何写入。
///
/// 排序保证结果确定；不安全相对路径不中断导入，记入 skipped 由前端提示。
fn collect_import_files(source: &std::path::Path) -> Result<(Vec<(String, u64)>, Vec<String>), String> {
    let mut files: Vec<(String, u64)> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut stack = vec![(source.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        if depth > IMPORT_MAX_WALK_DEPTH {
            return Err("模型目录嵌套过深（>8 层），拒绝导入".to_string());
        }
        let entries = std::fs::read_dir(&dir).map_err(|e| format!("读取目录失败 {}: {e}", dir.display()))?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            let file_type = entry.file_type().map_err(|e| e.to_string())?;
            if file_type.is_dir() {
                stack.push((path, depth + 1));
                continue;
            }
            if !file_type.is_file() {
                continue; // 符号链接等一律跳过，不追出源目录
            }
            let rel = match path.strip_prefix(source) {
                Ok(p) => p
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().to_string())
                    .collect::<Vec<_>>()
                    .join("/"),
                Err(_) => continue,
            };
            if !is_safe_import_rel_path(&rel) {
                if skipped.len() < 8 {
                    skipped.push(rel);
                }
                continue;
            }
            let size = entry.metadata().map_err(|e| e.to_string())?.len();
            files.push((rel, size));
        }
    }
    files.sort();
    Ok((files, skipped))
}

/// 把用户指定的模型文件夹整目录拷入 app_data_dir/live2d/imported/。
/// 与分块上传（import_model_file）互为两条通道：这条由前端传**路径**，
/// Rust 自己遍历拷贝——没有大 payload 过 IPC，也能被 Rust 单测覆盖。
/// 源目录必须存在；没有 *.model3.json 时报错拒绝（那不是模型文件夹）。
#[tauri::command]
async fn import_model_from_dir(
    app: tauri::AppHandle,
    source: String,
) -> Result<ImportedModelSummary, String> {
    let source_path = std::path::PathBuf::from(&source);
    if !source_path.is_dir() {
        return Err(format!("路径不存在或不是文件夹：{source}"));
    }
    let source_canon = source_path.canonicalize().map_err(|e| format!("解析路径失败：{e}"))?;

    tauri::async_runtime::spawn_blocking(move || {
        let (files, skipped) = collect_import_files(&source_canon)?;
        if files.is_empty() {
            return Err("所选文件夹里没有可导入的文件".to_string());
        }
        let total: u64 = files.iter().map(|(_, s)| s).sum();
        if total > IMPORT_MAX_TOTAL_BYTES {
            return Err(format!("总大小 {total} 字节超过上限 {IMPORT_MAX_TOTAL_BYTES}"));
        }
        if files.len() > IMPORT_MAX_FILES {
            return Err(format!("文件数 {} 超过上限 {IMPORT_MAX_FILES}", files.len()));
        }

        let root = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("app_data_dir: {e}"))?
            .join("live2d")
            .join("imported");
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;

        let mut model_path: Option<String> = None;
        let mut core_path: Option<String> = None;
        let mut copied_total: u64 = 0;
        for (rel, size) in &files {
            let src = source_canon.join(rel.replace('/', "\\"));
            let dest = root.join(rel);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::copy(&src, &dest).map_err(|e| format!("复制 {rel} 失败：{e}"))?;
            // 掉电截断防护：拷完每张贴图都 sync。注意必须用**写句柄**——
            // Windows 上 File::open（只读）调 FlushFileBuffers 会返回拒绝访问 (os error 5)。
            let done = std::fs::OpenOptions::new()
                .write(true)
                .open(&dest)
                .and_then(|f| f.sync_all());
            if let Err(e) = done {
                return Err(format!("落盘确认 {rel} 失败：{e}"));
            }
            copied_total += size;
            let lower = rel.to_ascii_lowercase();
            if model_path.is_none() && lower.ends_with("model3.json") {
                model_path = Some(rel.clone());
            }
            // Cubism Core 按文件名识别：相对路径可能带子目录（如 lib/live2dcubismcore.min.js），
            // 用整条路径 starts_with 会漏掉它（真机验证踩过）。
            let file_name = lower.rsplit('/').next().unwrap_or(&lower).to_string();
            if core_path.is_none() && file_name.starts_with("live2dcubismcore") && file_name.ends_with(".js") {
                core_path = Some(rel.clone());
            }
        }
        if copied_total != total {
            return Err(format!("拷贝字节数不符：{copied_total} / {total}"));
        }
        let model_path = model_path.ok_or_else(|| {
            "所选文件夹里没有 *.model3.json——那才是模型的入口文件（请选择模型文件夹本身，而不是它的上级目录）".to_string()
        })?;

        Ok(ImportedModelSummary {
            model_path: Some(model_path),
            core_path,
            file_count: files.len() as u64,
            total_bytes: copied_total,
            skipped,
        })
    })
    .await
    .map_err(|e| format!("import_model_from_dir join error: {e}"))?
}

/* ------------------------------------------------------------------ */
/* 模型文件服务：vvmodel:// 自定义协议                                  */
/* ------------------------------------------------------------------ */

/// 极简百分号解码（自定义协议里前端会 encodeURI 路径）。
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = |b: u8| -> Option<u8> {
                match b {
                    b'0'..=b'9' => Some(b - b'0'),
                    b'a'..=b'f' => Some(b - b'a' + 10),
                    b'A'..=b'F' => Some(b - b'A' + 10),
                    _ => None,
                }
            };
            if let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(hi * 16 + lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn content_type_for(rel: &str) -> &'static str {
    let lower = rel.to_ascii_lowercase();
    if lower.ends_with(".json") {
        "application/json"
    } else if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".js") {
        "text/javascript"
    } else if lower.ends_with(".txt") || lower.ends_with(".md") {
        "text/plain; charset=utf-8"
    } else {
        "application/octet-stream"
    }
}

/// 从 app_data_dir/live2d/imported/ 读一个模型文件（含路径校验）。
///
/// 为什么不用 asset 协议：`convertFileSrc` 会把整条 Windows 路径编码成**单个** URL 段
/// （分隔符变 %5C/%2F），而 pixi-live2d-display 用 `new URL(相对路径, 模型URL)` 解析贴图，
/// 此时 URL 的「目录」只剩 `http://asset.localhost/`，相对路径会被拼成错误位置 → 403。
/// 自定义协议用真实斜杠，相对解析天然正确（真机验证踩过）。
fn read_model_asset(app: &tauri::AppHandle, raw_path: &str) -> Result<Vec<u8>, (u16, String)> {
    let decoded = percent_decode(raw_path);
    let rel = decoded.trim_start_matches('/');
    if !is_safe_import_rel_path(rel) {
        return Err((403, format!("拒绝不安全的模型路径：{rel}")));
    }
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| (500, format!("app_data_dir: {e}")))?
        .join("live2d")
        .join("imported");
    let target = root.join(rel);
    std::fs::read(&target).map_err(|e| (404, format!("读取失败 {rel}: {e}")))
}

/* ------------------------------------------------------------------ */
/* 应用内更新：重启命令                                                 */
/* ------------------------------------------------------------------ */

/// 安装更新后重启应用（updater JS 插件的 `install()` 只落盘，不重启）。
///
/// 为什么自己写而不是引入 tauri-plugin-process：本任务文件域只允许新增
/// `@tauri-apps/plugin-updater` 一个 JS 依赖，避免再多一个前端包；
/// 原生重启走这里即可（`AppHandle::restart` 会重新拉起当前进程）。
#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        // updater 插件：pubkey / endpoints / windows.installMode 都在 tauri.conf.json 的 plugins.updater。
        .plugin(tauri_plugin_updater::Builder::new().build())
        .register_uri_scheme_protocol("vvmodel", |ctx, request| {
            let path = request.uri().path().to_string();
            match read_model_asset(ctx.app_handle(), &path) {
                Ok(bytes) => tauri::http::Response::builder()
                    .status(200)
                    .header("Content-Type", content_type_for(&path))
                    // 页面源是 tauri.localhost，跨源取模型文件需要放行 CORS
                    .header("Access-Control-Allow-Origin", "*")
                    .body(bytes)
                    .unwrap_or_else(|_| tauri::http::Response::new(Vec::new())),
                Err((status, message)) => tauri::http::Response::builder()
                    .status(status)
                    .header("Access-Control-Allow-Origin", "*")
                    .header("Content-Type", "text/plain; charset=utf-8")
                    .body(message.into_bytes())
                    .unwrap_or_else(|_| tauri::http::Response::new(Vec::new())),
            }
        })
        .invoke_handler(tauri::generate_handler![
            set_secret,
            get_secret,
            delete_secret,
            db_read_file,
            db_write_file,
            import_model_file,
            import_model_from_dir,
            restart_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{collect_import_files, is_safe_db_file_name, is_safe_import_rel_path};

    #[test]
    fn accepts_plain_names() {
        assert!(is_safe_db_file_name("vistaverge.sqlite3"));
        assert!(is_safe_db_file_name("chat-db_01.tar.gz"));
    }

    #[test]
    fn rejects_path_escape_and_specials() {
        assert!(!is_safe_db_file_name("../escape.sqlite3"));
        assert!(!is_safe_db_file_name("a/b.sqlite3"));
        assert!(!is_safe_db_file_name("a\\b.sqlite3"));
        assert!(!is_safe_db_file_name(".."));
        assert!(!is_safe_db_file_name(".hidden"));
        assert!(!is_safe_db_file_name(""));
        assert!(!is_safe_db_file_name("名字.sqlite3"));
        assert!(!is_safe_db_file_name(&"x".repeat(129)));
    }

    #[test]
    fn rejects_windows_reserved_and_trailing_dot() {
        // 保留设备名（大小写不敏感）会被 Windows 解析成设备而非文件
        assert!(!is_safe_db_file_name("NUL"));
        assert!(!is_safe_db_file_name("con"));
        assert!(!is_safe_db_file_name("COM1"));
        assert!(!is_safe_db_file_name("LPT1.db"));
        // 结尾点/空格在 Windows 上被规范化 → 与去掉结尾后的名字冲突
        assert!(!is_safe_db_file_name("foo."));
        assert!(!is_safe_db_file_name("foo "));
        // 正常名字不受影响
        assert!(is_safe_db_file_name("console.db"));
        assert!(is_safe_db_file_name("com10.db"));
    }

    #[test]
    fn accepts_nested_model_paths() {
        assert!(is_safe_import_rel_path("fense/fense.model3.json"));
        assert!(is_safe_import_rel_path("fense/fense.8192/texture_00.png"));
        assert!(is_safe_import_rel_path("live2dcubismcore.min.js"));
        assert!(is_safe_import_rel_path("模型/moc3/file.moc3"));
    }

    #[test]
    fn rejects_escaping_or_unsafe_model_paths() {
        // 逃逸与绝对路径
        assert!(!is_safe_import_rel_path("../escape.moc3"));
        assert!(!is_safe_import_rel_path("a/../../b.moc3"));
        assert!(!is_safe_import_rel_path("/abs/model3.json"));
        assert!(!is_safe_import_rel_path("C:\\model\\x.moc3"));
        assert!(!is_safe_import_rel_path("C:/model/x.moc3"));
        assert!(!is_safe_import_rel_path("\\\\server\\share\\x.moc3"));
        // 反斜杠统一拒绝（前端已归一化为 /）
        assert!(!is_safe_import_rel_path("a\\b.moc3"));
        // 空段 / 点段 / 结尾点与空格 / 控制字符
        assert!(!is_safe_import_rel_path("a//b.moc3"));
        assert!(!is_safe_import_rel_path("./x.moc3"));
        assert!(!is_safe_import_rel_path("a/./b.moc3"));
        assert!(!is_safe_import_rel_path("a/trailing./b"));
        assert!(!is_safe_import_rel_path("a/x\u{0000}y"));
        // Windows 保留设备名（含带扩展名形式）
        assert!(!is_safe_import_rel_path("NUL"));
        assert!(!is_safe_import_rel_path("a/COM1.moc3"));
        // 空串与超长
        assert!(!is_safe_import_rel_path(""));
        assert!(!is_safe_import_rel_path(&"a".repeat(513)));
    }

    #[test]
    fn collect_import_files_walks_recursively_and_is_deterministic() {
        let tmp = std::env::temp_dir().join(format!("vv-import-test-{}", std::process::id()));
        let model_dir = tmp.join("fense");
        std::fs::create_dir_all(&model_dir).unwrap();
        std::fs::write(model_dir.join("fense.model3.json"), b"{}").unwrap();
        std::fs::write(model_dir.join("fense.moc3"), vec![0u8; 100]).unwrap();
        std::fs::create_dir_all(model_dir.join("tex")).unwrap();
        std::fs::write(model_dir.join("tex").join("texture_00.png"), vec![1u8; 2048]).unwrap();
        std::fs::write(tmp.join("live2dcubismcore.min.js"), b"core").unwrap();

        let (files, skipped) = collect_import_files(&tmp).unwrap();
        assert_eq!(skipped, Vec::<String>::new());
        // 排序确定，且嵌套目录进来了
        assert_eq!(
            files,
            vec![
                ("fense/fense.moc3".to_string(), 100),
                ("fense/fense.model3.json".to_string(), 2),
                ("fense/tex/texture_00.png".to_string(), 2048),
                ("live2dcubismcore.min.js".to_string(), 4),
            ]
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn collect_import_files_skips_unsafe_names_without_aborting() {
        let tmp = std::env::temp_dir().join(format!("vv-import-skip-{}", std::process::id()));
        let model_dir = tmp.join("m");
        std::fs::create_dir_all(&model_dir).unwrap();
        std::fs::write(model_dir.join("a.model3.json"), b"{}").unwrap();
        // 保留设备名（CON）用常规 API 创建不了；用 verbatim 路径绕过试试。
        // 创建成功 → 收集时应被跳过且不中断；创建被拒 → 该文件系统不存在此风险，
        // 退而确认安全文件被正常收集（跳过逻辑已由 is_safe_import_rel_path 单测覆盖）。
        let verbatim = format!("\\\\?\\{}", model_dir.join("CON").display());
        if std::fs::write(&verbatim, b"x").is_ok() {
            let (files, skipped) = collect_import_files(&tmp).unwrap();
            assert_eq!(files.len(), 1);
            assert!(skipped.iter().any(|s| s == "m/CON"), "skipped={skipped:?}");
        } else {
            let (files, skipped) = collect_import_files(&tmp).unwrap();
            assert_eq!(files.len(), 1);
            assert!(skipped.is_empty());
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn collect_import_files_reports_missing_model_entry_upstream() {
        // 没有任何 model3.json 的目录：收集不为空，但由 import_model_from_dir 报错拒绝
        let tmp = std::env::temp_dir().join(format!("vv-import-nomodel-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("readme.txt"), b"not a model").unwrap();
        let (files, _) = collect_import_files(&tmp).unwrap();
        assert_eq!(files.len(), 1);
        assert!(files.iter().all(|(rel, _)| !rel.ends_with("model3.json")));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
