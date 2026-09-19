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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            set_secret,
            get_secret,
            delete_secret,
            db_read_file,
            db_write_file,
            import_model_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{is_safe_db_file_name, is_safe_import_rel_path};

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
}
