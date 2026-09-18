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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            set_secret,
            get_secret,
            delete_secret,
            db_read_file,
            db_write_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::is_safe_db_file_name;

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
}
