#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::net::{SocketAddr, TcpStream};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::async_runtime::spawn_blocking;
use tauri::menu::MenuBuilder;
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WindowEvent};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Child;
use tokio::sync::Mutex;

const GATEWAY_PORT: u16 = 18789;
const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_MENU_TOGGLE: &str = "tray_toggle_main";
const TRAY_MENU_RESTART_GATEWAY: &str = "tray_restart_gateway";
const TRAY_MENU_QUIT: &str = "tray_quit_app";
const COMMAND_TIMEOUT_SECONDS: u64 = 10;
const DOCTOR_TIMEOUT_SECONDS: u64 = 45;
const PRE_START_STOP_TIMEOUT_SECONDS: u64 = 8;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Serialize)]
struct GatewayStatus {
    running: bool,
    pid: Option<u32>,
    checked_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct ImChannelEntry {
    id: String,
    name: Option<String>,
    enabled: Option<bool>,
    paired: Option<bool>,
    token: Option<String>,
    webhook: Option<String>,
    port: Option<u16>,
}

impl Default for ImChannelEntry {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: None,
            enabled: None,
            paired: None,
            token: None,
            webhook: None,
            port: None,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(default)]
struct ImChannelFile {
    channels: Vec<ImChannelEntry>,
}

impl Default for ImChannelFile {
    fn default() -> Self {
        Self { channels: vec![] }
    }
}

#[derive(Debug, Serialize)]
struct ImChannelStatus {
    id: String,
    name: String,
    icon: String,
    configured: bool,
    enabled: bool,
    connected: bool,
    online: bool,
}

#[derive(Debug, Serialize)]
struct DroppedFileAnalysis {
    file_name: String,
    size: usize,
    line_count: usize,
    preview: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct DetectedOpenClawConfig {
    found: bool,
    source: Option<String>,
    api_key: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    default_model: Option<String>,
    provider: Option<String>,
    system_prompt: Option<String>,
    temperature: Option<f64>,
    max_tokens: Option<u32>,
    http_proxy: Option<String>,
    socks5_proxy: Option<String>,
    gateway_port: Option<u16>,
    log_level: Option<String>,
    history_message_limit: Option<u32>,
    long_term_memory_enabled: Option<bool>,
    autostart_enabled: Option<bool>,
    custom_name: Option<String>,
    theme: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledSkill {
    name: String,
    description: Option<String>,
    enabled: bool,
}

#[derive(Default)]
struct GatewayProcessState {
    gateway_child: Arc<Mutex<Option<Child>>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenClawConfigPayload {
    provider: Option<String>,
    model: Option<String>,
    default_model: Option<String>,
    api_key: Option<String>,
    base_url: Option<String>,
    system_prompt: Option<String>,
    temperature: Option<f64>,
    max_tokens: Option<u32>,
    http_proxy: Option<String>,
    socks5_proxy: Option<String>,
    gateway_port: Option<u16>,
    log_level: Option<String>,
    history_message_limit: Option<u32>,
    long_term_memory_enabled: Option<bool>,
    autostart_enabled: Option<bool>,
    custom_name: Option<String>,
    theme: Option<String>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SelfClawUiConfig {
    #[serde(alias = "custom_name")]
    custom_name: Option<String>,
    #[serde(alias = "history_message_limit")]
    history_message_limit: Option<u32>,
    #[serde(alias = "long_term_memory_enabled")]
    long_term_memory_enabled: Option<bool>,
    #[serde(alias = "autostart_enabled")]
    autostart_enabled: Option<bool>,
    theme: Option<String>,
}

fn now_unix_ts() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

fn openclaw_workspace_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(profile) = std::env::var("USERPROFILE") {
            return PathBuf::from(profile).join(".openclaw");
        }
    }

    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".openclaw");
    }

    PathBuf::from(".openclaw")
}

fn selfclaw_ui_config_path() -> PathBuf {
    openclaw_workspace_dir().join("selfclaw-ui.json")
}

#[cfg(target_os = "windows")]
const AUTOSTART_REGISTRY_KEY: &str = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
#[cfg(target_os = "windows")]
const AUTOSTART_VALUE_NAME: &str = "SelfClaw";

fn normalize_config_key(raw: &str) -> String {
    let mut key = String::with_capacity(raw.len());
    let mut previous_was_underscore = false;
    let mut previous_was_lower_or_digit = false;

    for ch in raw.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            // Treat camelCase as snake_case, e.g. apiKey -> API_KEY.
            if ch.is_ascii_uppercase() && previous_was_lower_or_digit && !previous_was_underscore {
                key.push('_');
            }
            key.push(ch.to_ascii_uppercase());
            previous_was_underscore = false;
            previous_was_lower_or_digit = ch.is_ascii_lowercase() || ch.is_ascii_digit();
        } else if !previous_was_underscore {
            key.push('_');
            previous_was_underscore = true;
            previous_was_lower_or_digit = false;
        }
    }

    key.trim_matches('_').to_string()
}

fn clean_config_value(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_matches('"').trim_matches('\'').trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn flatten_json_config(prefix: Option<&str>, value: &Value, out: &mut HashMap<String, String>) {
    match value {
        Value::Object(map) => {
            for (key, nested) in map {
                let normalized_key = normalize_config_key(key);
                if normalized_key.is_empty() {
                    continue;
                }

                let next_prefix = match prefix {
                    Some(existing) if !existing.is_empty() => {
                        format!("{}_{}", existing, normalized_key)
                    }
                    _ => normalized_key,
                };
                flatten_json_config(Some(&next_prefix), nested, out);
            }
        }
        Value::String(text) => {
            if let Some(path) = prefix {
                if let Some(cleaned) = clean_config_value(text) {
                    out.insert(path.to_string(), cleaned);
                }
            }
        }
        Value::Number(number) => {
            if let Some(path) = prefix {
                out.insert(path.to_string(), number.to_string());
            }
        }
        Value::Bool(boolean) => {
            if let Some(path) = prefix {
                out.insert(path.to_string(), boolean.to_string());
            }
        }
        _ => {}
    }
}

fn parse_json_config(path: &Path) -> Result<HashMap<String, String>, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("鐠囪褰囬柊宥囩枂閺傚洣锟?{} 婢惰精锟? {}", path.display(), error))?;
    let parsed: Value = serde_json::from_str(&content).map_err(|error| {
        format!(
            "闁板秶鐤嗛弬鍥︽ {} JSON 鐟欙絾鐎芥径杈Е: {}",
            path.display(),
            error
        )
    })?;

    let mut values = HashMap::new();
    flatten_json_config(None, &parsed, &mut values);
    Ok(values)
}

fn parse_text_config(path: &Path) -> Result<HashMap<String, String>, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("鐠囪褰囬柊宥囩枂閺傚洣锟?{} 婢惰精锟? {}", path.display(), error))?;
    let mut values = HashMap::new();

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let normalized_line = trimmed.strip_prefix("export ").unwrap_or(trimmed);
        let (raw_key, raw_value) = if let Some((key, value)) = normalized_line.split_once('=') {
            (key, value)
        } else if let Some((key, value)) = normalized_line.split_once(':') {
            (key, value)
        } else {
            continue;
        };

        let key = normalize_config_key(raw_key);
        if key.is_empty() {
            continue;
        }

        if let Some(value) = clean_config_value(raw_value) {
            values.insert(key, value);
        }
    }

    Ok(values)
}

fn read_openclaw_config_map(path: &Path) -> Result<HashMap<String, String>, String> {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("json") => parse_json_config(path),
        _ => parse_text_config(path),
    }
}

fn read_selfclaw_ui_config_sync() -> Result<SelfClawUiConfig, String> {
    let path = selfclaw_ui_config_path();
    if !path.exists() {
        return Ok(SelfClawUiConfig::default());
    }

    let content = fs::read_to_string(&path)
        .map_err(|error| format!("璇诲彇 UI 閰嶇疆 {} 澶辫触: {}", path.display(), error))?;
    if content.trim().is_empty() {
        return Ok(SelfClawUiConfig::default());
    }

    serde_json::from_str::<SelfClawUiConfig>(&content)
        .map_err(|error| format!("瑙ｆ瀽 UI 閰嶇疆 {} 澶辫触: {}", path.display(), error))
}

fn write_selfclaw_ui_config_sync(config: &SelfClawUiConfig) -> Result<(), String> {
    let path = selfclaw_ui_config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("鍒涘缓閰嶇疆鐩綍 {} 澶辫触: {}", parent.display(), error))?;
    }

    let content = serde_json::to_string_pretty(config)
        .map_err(|error| format!("搴忓垪锟?UI 閰嶇疆澶辫触: {}", error))?;
    fs::write(&path, content)
        .map_err(|error| format!("鍐欏叆 UI 閰嶇疆 {} 澶辫触: {}", path.display(), error))
}

fn normalize_option_string(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn run_openclaw_config_set_with_fallback(
    field_label: &str,
    key_candidates: &[&str],
    value: &str,
) -> Result<(), String> {
    let mut errors = Vec::new();

    for key in key_candidates {
        let args = vec![
            "config".to_string(),
            "set".to_string(),
            key.to_string(),
            value.to_string(),
        ];
        match run_openclaw_cli_owned(args) {
            Ok(_) => return Ok(()),
            Err(error) => errors.push(format!("{}: {}", key, error)),
        }
    }

    Err(format!(
        "{} 鍐欏叆澶辫触锛堝皾璇曢敭: {}锟? {}",
        field_label,
        key_candidates.join(", "),
        errors.join(" | ")
    ))
}

fn update_openclaw_config_sync(payload: OpenClawConfigPayload) -> Result<String, String> {
    let workspace_dir = openclaw_workspace_dir();
    fs::create_dir_all(&workspace_dir)
        .map_err(|error| format!("鍒涘缓閰嶇疆鐩綍 {} 澶辫触: {}", workspace_dir.display(), error))?;

    // 1) SelfClaw 澹冲瓙閰嶇疆鐗╃悊闅旂鍐欏叆 ~/.openclaw/selfclaw-ui.json
    let mut ui_config = read_selfclaw_ui_config_sync()?;
    if payload.custom_name.is_some() {
        ui_config.custom_name = normalize_option_string(payload.custom_name.clone());
    }
    if payload.history_message_limit.is_some() {
        ui_config.history_message_limit = payload.history_message_limit;
    }
    if payload.long_term_memory_enabled.is_some() {
        ui_config.long_term_memory_enabled = payload.long_term_memory_enabled;
    }
    if payload.autostart_enabled.is_some() {
        ui_config.autostart_enabled = payload.autostart_enabled;
    }
    if payload.theme.is_some() {
        ui_config.theme = normalize_option_string(payload.theme.clone());
    }
    write_selfclaw_ui_config_sync(&ui_config)?;

    // 2) 搴曞眰 OpenClaw 閰嶇疆缁熶竴锟?CLI锛岄伩鍏嶇洿鎺ュ啓锟?openclaw.json Schema
    let mut errors: Vec<String> = Vec::new();
    let mut apply_setting = |field_label: &str, candidates: &[&str], value: Option<String>| {
        if let Some(raw) = value {
            if let Err(error) = run_openclaw_config_set_with_fallback(field_label, candidates, &raw)
            {
                errors.push(error);
            }
        }
    };

    apply_setting(
        "Provider",
        &["llm.provider", "provider"],
        normalize_option_string(payload.provider),
    );
    apply_setting(
        "Model",
        &["llm.model", "model"],
        normalize_option_string(payload.model),
    );
    apply_setting(
        "Default Model",
        &["llm.default_model", "default_model"],
        normalize_option_string(payload.default_model),
    );
    apply_setting(
        "API Key",
        &["llm.api_key", "api_key"],
        normalize_option_string(payload.api_key),
    );
    apply_setting(
        "Base URL",
        &["llm.base_url", "base_url"],
        normalize_option_string(payload.base_url),
    );
    apply_setting(
        "System Prompt",
        &["llm.system_prompt", "system_prompt"],
        normalize_option_string(payload.system_prompt),
    );
    apply_setting(
        "Temperature",
        &["llm.temperature", "temperature"],
        payload.temperature.map(|value| value.to_string()),
    );
    apply_setting(
        "Max Tokens",
        &["llm.max_tokens", "max_tokens"],
        payload.max_tokens.map(|value| value.to_string()),
    );
    apply_setting(
        "HTTP Proxy",
        &["network.http_proxy", "http_proxy"],
        normalize_option_string(payload.http_proxy),
    );
    apply_setting(
        "SOCKS5 Proxy",
        &["network.socks5_proxy", "socks5_proxy"],
        normalize_option_string(payload.socks5_proxy),
    );
    apply_setting(
        "Gateway Port",
        &["gateway.port", "gateway_port"],
        payload.gateway_port.map(|value| value.to_string()),
    );
    apply_setting(
        "Log Level",
        &["log.level", "log_level"],
        normalize_option_string(payload.log_level),
    );

    if errors.is_empty() {
        Ok(format!(
            "锟斤拷锟斤拷锟斤拷同锟斤拷锟斤拷锟阶诧拷锟斤拷锟斤拷通锟斤拷 OpenClaw CLI 锟斤拷锟铰ｏ拷SelfClaw UI 锟斤拷锟斤拷锟斤拷写锟斤拷 {}",
            selfclaw_ui_config_path().display()
        ))
    } else {
        Err(format!(
            "锟斤拷锟矫憋拷锟芥部锟斤拷失锟杰ｏ拷{}锟斤拷SelfClaw UI 锟斤拷锟斤拷锟斤拷写锟斤拷 {}",
            errors.join("锟斤拷"),
            selfclaw_ui_config_path().display()
        ))
    }
}

fn pick_first_key(values: &HashMap<String, String>, aliases: &[&str]) -> Option<String> {
    let mut normalized_aliases = Vec::with_capacity(aliases.len());
    for alias in aliases {
        let normalized = normalize_config_key(alias);
        normalized_aliases.push(normalized.clone());
        if let Some(value) = values.get(&normalized) {
            if !value.trim().is_empty() {
                return Some(value.clone());
            }
        }
    }

    // Fallback for nested JSON keys such as LLM_API_KEY or OPENCLAW_LLM_API_KEY.
    for (key, value) in values {
        if value.trim().is_empty() {
            continue;
        }

        if normalized_aliases
            .iter()
            .any(|alias| key == alias || key.ends_with(&format!("_{}", alias)))
        {
            return Some(value.clone());
        }
    }

    None
}

fn pick_first_u32(values: &HashMap<String, String>, aliases: &[&str]) -> Option<u32> {
    pick_first_key(values, aliases).and_then(|value| value.trim().parse::<u32>().ok())
}

fn pick_first_f64(values: &HashMap<String, String>, aliases: &[&str]) -> Option<f64> {
    pick_first_key(values, aliases).and_then(|value| value.trim().parse::<f64>().ok())
}

fn score_detected_config(config: &DetectedOpenClawConfig) -> usize {
    let mut score = 0usize;
    if config
        .api_key
        .as_ref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        score += 1;
    }
    if config
        .base_url
        .as_ref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        score += 1;
    }
    if config
        .default_model
        .as_ref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        score += 1;
    }
    if config
        .model
        .as_ref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        score += 1;
    }
    if config
        .provider
        .as_ref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        score += 1;
    }
    score
}

fn detect_openclaw_config_sync() -> Result<DetectedOpenClawConfig, String> {
    const API_KEY_ALIASES: [&str; 12] = [
        "API_KEY",
        "APIKEY",
        "OPENAI_API_KEY",
        "OPENCLAW_API_KEY",
        "LLM_API_KEY",
        "LLM_APIKEY",
        "MODEL_API_KEY",
        "MODEL_APIKEY",
        "LLM_OPENAI_API_KEY",
        "AUTH_TOKEN",
        "TOKEN",
        "KEY",
    ];
    const BASE_URL_ALIASES: [&str; 12] = [
        "BASE_URL",
        "BASEURL",
        "OPENAI_BASE_URL",
        "OPENAI_BASEURL",
        "API_BASE_URL",
        "API_BASEURL",
        "LLM_BASE_URL",
        "LLM_BASEURL",
        "MODEL_BASE_URL",
        "MODEL_BASEURL",
        "GATEWAY_BASE_URL",
        "ENDPOINT",
    ];
    const DEFAULT_MODEL_ALIASES: [&str; 5] = [
        "DEFAULT_MODEL",
        "LLM_DEFAULT_MODEL",
        "CHAT_DEFAULT_MODEL",
        "MODEL_DEFAULT",
        "OPENCLAW_DEFAULT_MODEL",
    ];
    const MODEL_ALIASES: [&str; 6] = [
        "MODEL",
        "MODEL_NAME",
        "LLM_MODEL",
        "OPENAI_MODEL",
        "CHAT_MODEL",
        "ACTIVE_MODEL",
    ];
    const PROVIDER_ALIASES: [&str; 6] = [
        "PROVIDER",
        "MODEL_PROVIDER",
        "DEFAULT_PROVIDER",
        "AI_PROVIDER",
        "LLM_PROVIDER",
        "MODEL_VENDOR",
    ];
    const SYSTEM_PROMPT_ALIASES: [&str; 4] = [
        "SYSTEM_PROMPT",
        "LLM_SYSTEM_PROMPT",
        "PROMPT_SYSTEM",
        "GLOBAL_SYSTEM_PROMPT",
    ];
    const TEMPERATURE_ALIASES: [&str; 3] = ["TEMPERATURE", "LLM_TEMPERATURE", "MODEL_TEMPERATURE"];
    const MAX_TOKENS_ALIASES: [&str; 4] = [
        "MAX_TOKENS",
        "LLM_MAX_TOKENS",
        "MODEL_MAX_TOKENS",
        "MAX_TOKEN",
    ];
    const HTTP_PROXY_ALIASES: [&str; 4] = [
        "HTTP_PROXY",
        "PROXY_HTTP",
        "NETWORK_HTTP_PROXY",
        "GLOBAL_HTTP_PROXY",
    ];
    const SOCKS5_PROXY_ALIASES: [&str; 4] = [
        "SOCKS5_PROXY",
        "PROXY_SOCKS5",
        "NETWORK_SOCKS5_PROXY",
        "GLOBAL_SOCKS5_PROXY",
    ];
    const GATEWAY_PORT_ALIASES: [&str; 5] = [
        "GATEWAY_PORT",
        "PORT",
        "HTTP_PORT",
        "SERVER_PORT",
        "LISTEN_PORT",
    ];
    const LOG_LEVEL_ALIASES: [&str; 3] = ["LOG_LEVEL", "LOGLEVEL", "LOGGER_LEVEL"];

    let workspace = openclaw_workspace_dir();
    if !workspace.exists() {
        return Ok(read_selfclaw_ui_config_sync()
            .map(|ui| DetectedOpenClawConfig {
                custom_name: ui.custom_name,
                history_message_limit: ui.history_message_limit,
                long_term_memory_enabled: ui.long_term_memory_enabled,
                autostart_enabled: ui.autostart_enabled,
                theme: ui.theme,
                ..DetectedOpenClawConfig::default()
            })
            .unwrap_or_default());
    }

    let candidates = [
        "openclaw.json",
        "config.yaml",
        "config.yml",
        "config.json",
        ".env",
    ];
    let mut best = DetectedOpenClawConfig::default();
    let mut best_score = 0usize;

    for file in candidates {
        let path = workspace.join(file);
        if !path.exists() || !path.is_file() {
            continue;
        }

        let values = match read_openclaw_config_map(&path) {
            Ok(values) => values,
            Err(_) => continue,
        };

        let candidate = DetectedOpenClawConfig {
            found: false,
            source: Some(path.to_string_lossy().to_string()),
            api_key: pick_first_key(&values, &API_KEY_ALIASES),
            base_url: pick_first_key(&values, &BASE_URL_ALIASES),
            model: pick_first_key(&values, &MODEL_ALIASES),
            default_model: pick_first_key(&values, &DEFAULT_MODEL_ALIASES)
                .or_else(|| pick_first_key(&values, &MODEL_ALIASES)),
            provider: pick_first_key(&values, &PROVIDER_ALIASES),
            system_prompt: pick_first_key(&values, &SYSTEM_PROMPT_ALIASES),
            temperature: pick_first_f64(&values, &TEMPERATURE_ALIASES),
            max_tokens: pick_first_u32(&values, &MAX_TOKENS_ALIASES),
            http_proxy: pick_first_key(&values, &HTTP_PROXY_ALIASES),
            socks5_proxy: pick_first_key(&values, &SOCKS5_PROXY_ALIASES),
            gateway_port: pick_first_u32(&values, &GATEWAY_PORT_ALIASES)
                .and_then(|value| u16::try_from(value).ok()),
            log_level: pick_first_key(&values, &LOG_LEVEL_ALIASES),
            history_message_limit: None,
            long_term_memory_enabled: None,
            autostart_enabled: None,
            custom_name: None,
            theme: None,
        };

        let score = score_detected_config(&candidate);
        if score > best_score {
            best_score = score;
            best = candidate;
        }
    }

    let mut merged = if best_score == 0 {
        DetectedOpenClawConfig::default()
    } else {
        best
    };

    // 锟较诧拷 SelfClaw UI 锟斤拷锟矫ｏ拷锟斤拷前锟斤拷统一锟斤拷锟窖★拷
    if let Ok(ui_config) = read_selfclaw_ui_config_sync() {
        merged.custom_name = ui_config.custom_name;
        merged.history_message_limit = ui_config.history_message_limit;
        merged.long_term_memory_enabled = ui_config.long_term_memory_enabled;
        merged.autostart_enabled = ui_config.autostart_enabled;
        merged.theme = ui_config.theme;
    }

    let has_valid_official_config = merged
        .api_key
        .as_ref()
        .is_some_and(|value| !value.trim().is_empty())
        || merged
            .base_url
            .as_ref()
            .is_some_and(|value| !value.trim().is_empty())
        || merged
            .default_model
            .as_ref()
            .is_some_and(|value| !value.trim().is_empty())
        || merged
            .model
            .as_ref()
            .is_some_and(|value| !value.trim().is_empty())
        || merged
            .provider
            .as_ref()
            .is_some_and(|value| !value.trim().is_empty());
    merged.found = has_valid_official_config;

    Ok(merged)
}

fn query_autostart_enabled_sync() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("reg");
        cmd.arg("query")
            .arg(AUTOSTART_REGISTRY_KEY)
            .arg("/v")
            .arg(AUTOSTART_VALUE_NAME)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        attach_windows_flags(&mut cmd);

        match cmd.output() {
            Ok(output) => Ok(output.status.success()),
            Err(error) => Err(format!("锟斤拷询锟斤拷锟斤拷锟阶刺э拷锟? {}", error)),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(false)
    }
}

fn set_autostart_enabled_sync(enabled: bool) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        if enabled {
            let current_executable =
                std::env::current_exe().map_err(|error| format!("锟斤拷取锟斤拷执锟斤拷路锟斤拷失锟斤拷: {}", error))?;
            let executable = current_executable
                .to_str()
                .ok_or_else(|| "锟斤拷执锟斤拷路锟斤拷锟斤拷锟斤拷锟角凤拷 UTF-8 锟街凤拷".to_string())?;
            let quoted_path = format!("\"{}\"", executable);

            let mut cmd = Command::new("reg");
            cmd.arg("add")
                .arg(AUTOSTART_REGISTRY_KEY)
                .arg("/v")
                .arg(AUTOSTART_VALUE_NAME)
                .arg("/t")
                .arg("REG_SZ")
                .arg("/d")
                .arg(quoted_path)
                .arg("/f")
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            attach_windows_flags(&mut cmd);

            match cmd.output() {
                Ok(output) if output.status.success() => query_autostart_enabled_sync(),
                Ok(output) => {
                    let stderr = decode_output_lossy(&output.stderr).trim().to_string();
                    let stdout = decode_output_lossy(&output.stdout).trim().to_string();
                    let message = if !stderr.is_empty() {
                        stderr
                    } else if !stdout.is_empty() {
                        stdout
                    } else {
                        "Failed to update autostart registry".to_string()
                    };
                    Err(message)
                }
                Err(error) => Err(format!("锟斤拷锟斤拷锟斤拷锟斤拷锟绞э拷锟? {}", error)),
            }
        } else {
            let mut cmd = Command::new("reg");
            cmd.arg("delete")
                .arg(AUTOSTART_REGISTRY_KEY)
                .arg("/v")
                .arg(AUTOSTART_VALUE_NAME)
                .arg("/f")
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            attach_windows_flags(&mut cmd);

            let _ = cmd.output();
            query_autostart_enabled_sync()
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = enabled;
        Ok(false)
    }
}

fn channels_config_path() -> PathBuf {
    openclaw_workspace_dir().join("channels.json")
}

fn attach_windows_flags(cmd: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

fn attach_windows_flags_tokio(cmd: &mut tokio::process::Command) {
    #[cfg(target_os = "windows")]
    {
        cmd.as_std_mut().creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = cmd;
    }
}

#[cfg(not(target_os = "windows"))]
fn shell_escape_unix(value: &str) -> String {
    if value.is_empty() {
        "''".to_string()
    } else {
        format!("'{}'", value.replace('\'', "'\"'\"'"))
    }
}

fn build_shell_wrapped_tokio_command(command: &str, args: &[String]) -> tokio::process::Command {
    #[cfg(target_os = "windows")]
    {
        let mut process = tokio::process::Command::new("cmd");
        process.as_std_mut().creation_flags(CREATE_NO_WINDOW);
        process
            .arg("/c")
            .arg("chcp 65001 >nul &&")
            .arg(command)
            .args(args);
        process
    }

    #[cfg(not(target_os = "windows"))]
    {
        let mut process = tokio::process::Command::new("sh");
        let mut parts = Vec::with_capacity(1 + args.len());
        parts.push(shell_escape_unix(command));
        for arg in args {
            parts.push(shell_escape_unix(arg));
        }
        process.arg("-c").arg(parts.join(" "));
        process
    }
}

fn emit_gateway_log_line(app: &AppHandle, line: String) {
    let _ = app.emit("gateway-log-line", line);
}

fn decode_output_lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

async fn run_raw_tokio_command_with_timeout(
    mut cmd: tokio::process::Command,
    timeout_seconds: u64,
    label: &str,
) -> Result<String, String> {
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let output = match tokio::time::timeout(Duration::from_secs(timeout_seconds), cmd.output()).await
    {
        Ok(result) => result.map_err(|error| format!("Failed to run {}: {}", label, error))?,
        Err(_) => return Err(format!("Command {} timed out ({}s)", label, timeout_seconds)),
    };

    let stdout = decode_output_lossy(&output.stdout).trim().to_string();
    let stderr = decode_output_lossy(&output.stderr).trim().to_string();

    if output.status.success() {
        if !stdout.is_empty() {
            Ok(stdout)
        } else {
            Ok(stderr)
        }
    } else if !stderr.is_empty() {
        Err(stderr)
    } else if !stdout.is_empty() {
        Err(stdout)
    } else {
        Err(format!("{} exited with status {}", label, output.status))
    }
}

#[cfg(target_os = "windows")]
async fn kill_gateway_port_occupants() {
    let script = format!(
        "$pids = Get-NetTCPConnection -LocalPort {} -ErrorAction Ignore | Select-Object -ExpandProperty OwningProcess -Unique; if ($pids) {{ Stop-Process -Id $pids -Force -ErrorAction Ignore }}",
        GATEWAY_PORT
    );
    let mut kill_port_cmd = tokio::process::Command::new("powershell");
    attach_windows_flags_tokio(&mut kill_port_cmd);
    kill_port_cmd
        .args(["-NoProfile", "-Command"])
        .arg(script);

    if let Ok(Ok(output)) =
        tokio::time::timeout(Duration::from_secs(10), kill_port_cmd.output()).await
    {
        let _ = decode_output_lossy(&output.stdout);
        let _ = decode_output_lossy(&output.stderr);
    }

    tokio::time::sleep(Duration::from_secs(1)).await;
}

#[cfg(not(target_os = "windows"))]
async fn kill_gateway_port_occupants() {
    let script = format!("lsof -t -i:{} | xargs kill -9", GATEWAY_PORT);
    let mut cmd = tokio::process::Command::new("sh");
    cmd.arg("-c").arg(script);
    let _ = run_raw_tokio_command_with_timeout(cmd, 10, "gateway-port-snipe").await;
}

async fn run_command_output_with_timeout(
    command: &str,
    args: &[String],
    timeout_seconds: u64,
) -> Result<String, String> {
    let mut cmd = build_shell_wrapped_tokio_command(command, args);
    attach_windows_flags_tokio(&mut cmd);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|error| format!("鍚姩鍛戒护 `{}` 澶辫触: {}", command, error))?;

    let stdout_task = child.stdout.take().map(|mut stdout| {
        tauri::async_runtime::spawn(async move {
            let mut buffer = Vec::new();
            let _ = tokio::io::AsyncReadExt::read_to_end(&mut stdout, &mut buffer).await;
            buffer
        })
    });

    let stderr_task = child.stderr.take().map(|mut stderr| {
        tauri::async_runtime::spawn(async move {
            let mut buffer = Vec::new();
            let _ = tokio::io::AsyncReadExt::read_to_end(&mut stderr, &mut buffer).await;
            buffer
        })
    });

    let status =
        match tokio::time::timeout(Duration::from_secs(timeout_seconds), child.wait()).await {
            Ok(wait_result) => wait_result
                .map_err(|error| format!("绛夊緟鍛戒护 `{}` 瀹屾垚澶辫触: {}", command, error))?,
            Err(_) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(format!(
                    "Command `{}` timed out ({}s), process terminated.",
                    command,
                    timeout_seconds
                ));
            }
        };

    let stdout_bytes = if let Some(task) = stdout_task {
        task.await.unwrap_or_default()
    } else {
        Vec::new()
    };
    let stderr_bytes = if let Some(task) = stderr_task {
        task.await.unwrap_or_default()
    } else {
        Vec::new()
    };

    let stdout = decode_output_lossy(&stdout_bytes).trim().to_string();
    let stderr = decode_output_lossy(&stderr_bytes).trim().to_string();

    if status.success() {
        if !stdout.is_empty() {
            Ok(stdout)
        } else {
            Ok(stderr)
        }
    } else {
        let message = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("鍛戒护 `{}` 鎵ц澶辫触锛岄€€鍑虹爜: {}", command, status)
        };
        Err(message)
    }
}

fn run_command_output(command: &str, args: &[String]) -> Result<String, String> {
    tauri::async_runtime::block_on(run_command_output_with_timeout(
        command,
        args,
        COMMAND_TIMEOUT_SECONDS,
    ))
}

fn run_command_output_with_custom_timeout(
    command: &str,
    args: &[String],
    timeout_seconds: u64,
) -> Result<String, String> {
    tauri::async_runtime::block_on(run_command_output_with_timeout(
        command,
        args,
        timeout_seconds,
    ))
}

fn run_openclaw_cli(args: &[&str]) -> Result<String, String> {
    let cmd_args: Vec<String> = args.iter().map(|value| value.to_string()).collect();
    run_command_output("openclaw", &cmd_args)
}

fn run_openclaw_cli_with_timeout(args: &[&str], timeout_seconds: u64) -> Result<String, String> {
    let cmd_args: Vec<String> = args.iter().map(|value| value.to_string()).collect();
    run_command_output_with_custom_timeout("openclaw", &cmd_args, timeout_seconds)
}

async fn run_openclaw_cli_with_timeout_async(
    args: &[&str],
    timeout_seconds: u64,
) -> Result<String, String> {
    let cmd_args: Vec<String> = args.iter().map(|value| value.to_string()).collect();
    run_command_output_with_timeout("openclaw", &cmd_args, timeout_seconds).await
}

fn run_openclaw_cli_owned(args: Vec<String>) -> Result<String, String> {
    run_command_output("openclaw", &args)
}

fn ensure_cli_name(name: &str, field_name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        Err(format!("{}涓嶈兘涓虹┖", field_name))
    } else {
        Ok(trimmed.to_string())
    }
}

fn spawn_gateway_output_reader<R>(
    app: AppHandle,
    stream: R,
    stderr: bool,
    gateway_child: Option<Arc<Mutex<Option<Child>>>>,
)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(stream).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    let text = line.trim_end();
                    if text.is_empty() {
                        continue;
                    }

                    if stderr {
                        emit_gateway_log_line(&app, format!("[stderr] {}", text));
                    } else {
                        emit_gateway_log_line(&app, text.to_string());
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    emit_gateway_log_line(&app, format!("[error] Gateway log read failed: {}", error));
                    break;
                }
            }
        }

        if stderr {
            return;
        }

        let Some(gateway_child) = gateway_child else {
            return;
        };

        let Some(mut child) = ({
            let mut guard = gateway_child.lock().await;
            guard.take()
        }) else {
            return;
        };

        let wait_result = child.wait().await;

        match wait_result {
            Ok(status) => {
                emit_gateway_log_line(&app, format!("[system] Gateway process exited: {}", status));
                let _ = app.emit("gateway-exited", ());
            }
            Err(error) => {
                emit_gateway_log_line(
                    &app,
                    format!("[error] Failed waiting for gateway process exit: {}", error),
                );
                let _ = app.emit("gateway-exited", ());
            }
        }
    });
}
async fn start_openclaw_gateway_process(
    app: AppHandle,
    gateway_child: Arc<Mutex<Option<Child>>>,
) -> Result<String, String> {
    {
        let mut guard = gateway_child.lock().await;

        if let Some(existing_child) = guard.as_mut() {
            match existing_child.try_wait() {
                Ok(Some(status)) => {
                    emit_gateway_log_line(&app, format!("[system] 锟斤拷獾斤拷锟斤拷锟斤拷亟锟斤拷锟斤拷锟斤拷顺锟? {}", status));
                    *guard = None;
                }
                Ok(None) => return Ok("锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷".to_string()),
                Err(error) => {
                    emit_gateway_log_line(
                        &app,
                        format!("[warn] 锟斤拷锟斤拷锟截斤拷锟斤拷状态锟斤拷锟绞э拷埽锟斤拷锟斤拷锟斤拷镁锟斤拷: {}", error),
                    );
                    *guard = None;
                }
            }
        }
    }

    // Best-effort cleanup for stale background daemon/task before we spawn the foreground gateway.
    let _ =
        run_openclaw_cli_with_timeout_async(&["gateway", "stop"], PRE_START_STOP_TIMEOUT_SECONDS)
            .await;
    kill_gateway_port_occupants().await;

    for _ in 0..10 {
        if !is_port_open(GATEWAY_PORT) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    if is_port_open(GATEWAY_PORT) {
        return Err(format!(
            "Gateway port {} is still occupied. Stop the process using this port and retry.",
            GATEWAY_PORT
        ));
    }

    let args = vec!["gateway".to_string()];
    let mut cmd = build_shell_wrapped_tokio_command("openclaw", &args);
    attach_windows_flags_tokio(&mut cmd);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|error| format!("锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟绞э拷锟? {}", error))?;

    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    {
        let mut guard = gateway_child.lock().await;
        *guard = Some(child);
    }

    if let Some(stdout_stream) = stdout {
        spawn_gateway_output_reader(app.clone(), stdout_stream, false, Some(gateway_child.clone()));
    }
    if let Some(stderr_stream) = stderr {
        spawn_gateway_output_reader(app.clone(), stderr_stream, true, None);
    }

    if let Some(pid) = pid {
        Ok(format!("锟斤拷锟斤拷前台锟斤拷锟斤拷锟斤拷锟斤拷锟?(PID: {})", pid))
    } else {
        Ok("OpenClaw gateway started in foreground".to_string())
    }
}

async fn stop_openclaw_gateway_process(
    gateway_child: Arc<Mutex<Option<Child>>>,
) -> Result<String, String> {
    let maybe_child = { gateway_child.lock().await.take() };
    if let Some(mut child) = maybe_child {
        if let Some(pid) = child.id() {
            #[cfg(target_os = "windows")]
            {
                let mut taskkill = tokio::process::Command::new("taskkill");
                attach_windows_flags_tokio(&mut taskkill);
                taskkill
                    .arg("/F")
                    .arg("/T")
                    .arg("/PID")
                    .arg(pid.to_string());
                let _ = run_raw_tokio_command_with_timeout(taskkill, 10, "taskkill").await;
            }

            #[cfg(not(target_os = "windows"))]
            {
                let _ = child.kill().await;
            }
        } else {
            let _ = child.kill().await;
        }

        let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
    }

    kill_gateway_port_occupants().await;

    for _ in 0..10 {
        if !is_port_open(GATEWAY_PORT) {
            return Ok("Gateway stopped".to_string());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    Err(format!(
        "Gateway port {} is still occupied after stop",
        GATEWAY_PORT
    ))
}

async fn restart_openclaw_gateway_process(
    app: AppHandle,
    gateway_child: Arc<Mutex<Option<Child>>>,
) -> Result<String, String> {
    if let Err(error) = stop_openclaw_gateway_process(gateway_child.clone()).await {
        if error != "锟斤拷锟斤拷未锟斤拷锟斤拷" {
            return Err(error);
        }
    }

    start_openclaw_gateway_process(app, gateway_child).await?;
    Ok("锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷".to_string())
}

async fn snapshot_gateway_process(gateway_child: Arc<Mutex<Option<Child>>>) -> (bool, Option<u32>) {
    let mut guard = gateway_child.lock().await;
    let Some(child) = guard.as_mut() else {
        return (false, None);
    };

    match child.try_wait() {
        Ok(Some(_)) => {
            *guard = None;
            (false, None)
        }
        Ok(None) => (true, child.id()),
        Err(_) => {
            *guard = None;
            (false, None)
        }
    }
}

fn parse_skill_enabled(raw: &Value) -> Option<bool> {
    if let Some(enabled) = raw.get("enabled").and_then(Value::as_bool) {
        return Some(enabled);
    }
    if let Some(active) = raw.get("active").and_then(Value::as_bool) {
        return Some(active);
    }
    if let Some(status) = raw
        .get("status")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
    {
        if status.contains("disable") || status.contains("off") || status.contains("inactive") {
            return Some(false);
        }
        if status.contains("enable") || status.contains("on") || status.contains("active") {
            return Some(true);
        }
    }
    None
}

fn parse_installed_skills_from_json(raw: &str) -> Option<Vec<InstalledSkill>> {
    let parsed: Value = serde_json::from_str(raw).ok()?;
    let list = if let Some(array) = parsed.as_array() {
        array.clone()
    } else if let Some(array) = parsed
        .as_object()
        .and_then(|object| object.get("skills"))
        .and_then(Value::as_array)
    {
        array.clone()
    } else if let Some(array) = parsed
        .as_object()
        .and_then(|object| object.get("data"))
        .and_then(Value::as_array)
    {
        array.clone()
    } else {
        return None;
    };

    let mut skills = Vec::new();
    for item in list {
        let Some(object) = item.as_object() else {
            continue;
        };
        let name = object
            .get("name")
            .and_then(Value::as_str)
            .or_else(|| object.get("id").and_then(Value::as_str))
            .or_else(|| object.get("skill").and_then(Value::as_str))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string);
        let Some(name) = name else {
            continue;
        };

        let description = object
            .get("description")
            .and_then(Value::as_str)
            .or_else(|| object.get("desc").and_then(Value::as_str))
            .or_else(|| object.get("summary").and_then(Value::as_str))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string);
        let enabled = parse_skill_enabled(&item).unwrap_or(true);

        skills.push(InstalledSkill {
            name,
            description,
            enabled,
        });
    }

    if skills.is_empty() {
        None
    } else {
        Some(skills)
    }
}

fn parse_installed_skills_from_text(raw: &str) -> Vec<InstalledSkill> {
    let mut skills = Vec::new();

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let lowered = trimmed.to_ascii_lowercase();
        if (lowered.contains("name") && lowered.contains("status"))
            || lowered.starts_with("installed skills")
            || lowered.starts_with("total")
        {
            continue;
        }

        let mut parts = trimmed.split_whitespace();
        let Some(name) = parts.next() else {
            continue;
        };
        if name.starts_with('-') || name.starts_with('=') {
            continue;
        }

        let enabled = if lowered.contains("disable")
            || lowered.contains("off")
            || lowered.contains("inactive")
        {
            false
        } else if lowered.contains("enable") || lowered.contains("active") || lowered.contains("on")
        {
            true
        } else {
            true
        };

        let description = if let Some(index) = trimmed.find(" - ") {
            let desc = trimmed[index + 3..].trim();
            if desc.is_empty() {
                None
            } else {
                Some(desc.to_string())
            }
        } else {
            None
        };

        skills.push(InstalledSkill {
            name: name.to_string(),
            description,
            enabled,
        });
    }

    skills
}

fn get_installed_skills_sync() -> Result<Vec<InstalledSkill>, String> {
    let json_output = run_openclaw_cli(&["skills", "ls", "--json"]).ok();

    if let Some(output) = json_output.as_ref() {
        if let Some(mut parsed) = parse_installed_skills_from_json(output) {
            parsed.sort_by(|a, b| a.name.cmp(&b.name));
            return Ok(parsed);
        }
    }

    let text_output = if let Some(output) = json_output {
        if output.trim().is_empty() {
            run_openclaw_cli(&["skills", "ls"])?
        } else {
            output
        }
    } else {
        run_openclaw_cli(&["skills", "ls"])?
    };

    let mut parsed = parse_installed_skills_from_text(&text_output);
    if parsed.is_empty() {
        return Ok(Vec::new());
    }

    parsed.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(parsed)
}

fn toggle_skill_status_sync(name: &str, enabled: bool) -> Result<String, String> {
    let skill_name = name.trim();
    if skill_name.is_empty() {
        return Err("锟斤拷锟斤拷锟斤拷锟狡诧拷锟斤拷为锟斤拷".to_string());
    }

    let action = if enabled { "enable" } else { "disable" };
    let args = vec![
        "skills".to_string(),
        action.to_string(),
        skill_name.to_string(),
    ];
    let output = run_command_output("openclaw", &args)?;

    if output.trim().is_empty() {
        Ok(format!(
            "锟斤拷锟斤拷 `{}` 锟斤拷{}",
            skill_name,
            if enabled {
                "锟斤拷锟斤拷"
            } else {
                "锟斤拷锟斤拷"
            }
        ))
    } else {
        Ok(output)
    }
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return Err("锟斤拷锟斤拷锟节诧拷锟斤拷锟斤拷".to_string());
    };

    let _ = window.unminimize();
    window
        .show()
        .map_err(|error| format!("锟斤拷示锟斤拷锟斤拷锟斤拷失锟斤拷: {}", error))?;
    window
        .set_focus()
        .map_err(|error| format!("锟桔斤拷锟斤拷锟斤拷锟斤拷失锟斤拷: {}", error))?;
    Ok(())
}

fn toggle_main_window_visibility<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return Err("锟斤拷锟斤拷锟节诧拷锟斤拷锟斤拷".to_string());
    };

    if window
        .is_visible()
        .map_err(|error| format!("锟斤拷取锟斤拷锟节可硷拷状态失锟斤拷: {}", error))?
    {
        window
            .hide()
            .map_err(|error| format!("锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷失锟斤拷: {}", error))?;
    } else {
        show_main_window(app)?;
    }
    Ok(())
}

fn graceful_shutdown_gateway_sync() {
    if run_openclaw_cli(&["gateway", "stop"]).is_err() && is_port_open(GATEWAY_PORT) {
        let _ = force_kill_gateway_sync();
    }
}

fn setup_system_tray(app: &AppHandle) -> tauri::Result<()> {
    let tray_menu = MenuBuilder::new(app)
        .text(TRAY_MENU_TOGGLE, "Show/Hide Window")
        .text(TRAY_MENU_RESTART_GATEWAY, "锟斤拷锟斤拷锟斤拷锟斤拷")
        .separator()
        .text(TRAY_MENU_QUIT, "锟剿筹拷 SelfClaw")
        .build()?;

    let mut tray_builder = TrayIconBuilder::with_id("selfclaw-tray")
        .menu(&tray_menu)
        .tooltip("SelfClaw")
        .on_menu_event(|app, event| match event.id.as_ref() {
            TRAY_MENU_TOGGLE => {
                if let Err(error) = toggle_main_window_visibility(app) {
                    eprintln!("tray toggle failed: {}", error);
                }
            }
            TRAY_MENU_RESTART_GATEWAY => {
                let app_handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let Some(gateway_state) = app_handle.try_state::<GatewayProcessState>() else {
                        eprintln!("tray restart gateway failed: gateway state unavailable");
                        return;
                    };

                    if let Err(error) = restart_openclaw_gateway_process(
                        app_handle.clone(),
                        gateway_state.gateway_child.clone(),
                    )
                    .await
                    {
                        eprintln!("tray restart gateway failed: {}", error);
                    }
                });
            }
            TRAY_MENU_QUIT => {
                if let Some(gateway_state) = app.try_state::<GatewayProcessState>() {
                    let _ = tauri::async_runtime::block_on(stop_openclaw_gateway_process(
                        gateway_state.gateway_child.clone(),
                    ));
                }
                graceful_shutdown_gateway_sync();
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick { .. } = event {
                if let Err(error) = show_main_window(tray.app_handle()) {
                    eprintln!("tray double click restore failed: {}", error);
                }
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        tray_builder = tray_builder.icon(icon);
    }

    let _ = tray_builder.build(app)?;
    Ok(())
}

async fn run_in_background<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    spawn_blocking(task)
        .await
        .map_err(|error| format!("閸氬骸褰存禒璇插閹笛嗩攽婢惰精锟? {}", error))?
}

fn is_port_open(port: u16) -> bool {
    let address: SocketAddr = format!("127.0.0.1:{}", port)
        .parse()
        .unwrap_or_else(|_| SocketAddr::from(([127, 0, 0, 1], port)));
    TcpStream::connect_timeout(&address, Duration::from_millis(300)).is_ok()
}

fn channel_templates() -> Vec<ImChannelEntry> {
    vec![
        ImChannelEntry {
            id: "feishu".to_string(),
            name: Some("锟斤拷锟斤拷".to_string()),
            ..Default::default()
        },
        ImChannelEntry {
            id: "wecom".to_string(),
            name: Some("锟斤拷业微锟斤拷".to_string()),
            ..Default::default()
        },
        ImChannelEntry {
            id: "qq".to_string(),
            name: Some("QQ".to_string()),
            ..Default::default()
        },
    ]
}

fn channel_name_by_id(channel_id: &str) -> String {
    match channel_id {
        "feishu" => "锟斤拷锟斤拷".to_string(),
        "wecom" => "锟斤拷业微锟斤拷".to_string(),
        "qq" => "QQ".to_string(),
        _ => channel_id.to_string(),
    }
}

fn channel_icon_by_id(channel_id: &str) -> String {
    match channel_id {
        "feishu" => "message-square".to_string(),
        "wecom" => "briefcase".to_string(),
        "qq" => "message-circle".to_string(),
        _ => "radio".to_string(),
    }
}

fn parse_channel_entry(id_hint: Option<&str>, value: &Value) -> Option<ImChannelEntry> {
    let object = value.as_object()?;

    let id = object
        .get("id")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| id_hint.map(ToString::to_string))?;

    let name = object
        .get("name")
        .and_then(Value::as_str)
        .map(ToString::to_string);

    let enabled = object.get("enabled").and_then(Value::as_bool);
    let paired = object.get("paired").and_then(Value::as_bool);

    let token = object
        .get("token")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| {
            object
                .get("api_key")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        });

    let webhook = object
        .get("webhook")
        .and_then(Value::as_str)
        .map(ToString::to_string);

    let port = object
        .get("port")
        .and_then(Value::as_u64)
        .map(|value| value as u16);

    Some(ImChannelEntry {
        id,
        name,
        enabled,
        paired,
        token,
        webhook,
        port,
    })
}

fn read_channels_from_disk() -> Result<Vec<ImChannelEntry>, String> {
    let path = channels_config_path();
    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(&path)
        .map_err(|error| format!("鐠囪褰囧〒鐘讳壕闁板秶锟?{} 婢惰精锟? {}", path.display(), error))?;

    let value: Value = serde_json::from_str(&content)
        .map_err(|error| format!("濞撶娀浜鹃柊宥囩枂 JSON 閺嶇厧绱￠弮鐘虫櫏: {}", error))?;

    if let Some(array) = value.get("channels").and_then(Value::as_array) {
        let mut entries = Vec::new();
        for item in array {
            if let Some(entry) = parse_channel_entry(None, item) {
                entries.push(entry);
            }
        }
        return Ok(entries);
    }

    if let Some(array) = value.as_array() {
        let mut entries = Vec::new();
        for item in array {
            if let Some(entry) = parse_channel_entry(None, item) {
                entries.push(entry);
            }
        }
        return Ok(entries);
    }

    if let Some(object) = value.as_object() {
        let mut entries = Vec::new();
        for (id, item) in object {
            if let Some(entry) = parse_channel_entry(Some(id.as_str()), item) {
                entries.push(entry);
            }
        }
        return Ok(entries);
    }

    Ok(Vec::new())
}

fn merge_channel_entries() -> Result<Vec<ImChannelEntry>, String> {
    let mut merged = channel_templates();
    let disk_entries = read_channels_from_disk()?;

    for entry in disk_entries {
        if let Some(existing) = merged.iter_mut().find(|item| item.id == entry.id) {
            *existing = ImChannelEntry {
                id: existing.id.clone(),
                name: entry.name.or_else(|| existing.name.clone()),
                enabled: entry.enabled,
                paired: entry.paired,
                token: entry.token,
                webhook: entry.webhook,
                port: entry.port,
            };
        } else {
            merged.push(entry);
        }
    }

    Ok(merged)
}

fn save_channels_to_disk(entries: &[ImChannelEntry]) -> Result<(), String> {
    let path = channels_config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "閸戝棗顦〒鐘讳壕闁板秶鐤嗛惄顔肩秿 {} 婢惰精锟? {}",
                parent.display(),
                error
            )
        })?;
    }

    let payload = ImChannelFile {
        channels: entries.to_vec(),
    };

    let data = serde_json::to_string_pretty(&payload)
        .map_err(|error| format!("鎼村繐鍨崠鏍ㄧ闁捇鍘ょ純顔笺亼锟? {}", error))?;

    fs::write(&path, data)
        .map_err(|error| format!("閸愭瑥鍙嗗〒鐘讳壕闁板秶锟?{} 婢惰精锟? {}", path.display(), error))
}

fn channel_is_configured(entry: &ImChannelEntry) -> bool {
    entry.paired.unwrap_or(false)
        || entry
            .token
            .as_ref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
        || entry
            .webhook
            .as_ref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
}

fn to_channel_status(entry: &ImChannelEntry, gateway_running: bool) -> ImChannelStatus {
    let configured = channel_is_configured(entry);
    let enabled = entry.enabled.unwrap_or(configured);
    let connected = configured && enabled;
    let online = if !connected {
        false
    } else if let Some(port) = entry.port {
        is_port_open(port)
    } else {
        gateway_running
    };

    ImChannelStatus {
        id: entry.id.clone(),
        name: entry
            .name
            .clone()
            .unwrap_or_else(|| channel_name_by_id(&entry.id)),
        icon: channel_icon_by_id(&entry.id),
        configured,
        enabled,
        connected,
        online,
    }
}

fn upsert_channel(entries: &mut Vec<ImChannelEntry>, channel_id: &str) -> usize {
    if let Some(index) = entries.iter().position(|entry| entry.id == channel_id) {
        index
    } else {
        entries.push(ImChannelEntry {
            id: channel_id.to_string(),
            name: Some(channel_name_by_id(channel_id)),
            ..Default::default()
        });
        entries.len() - 1
    }
}

#[tauri::command]
async fn run_sys_command(command: String, args: Vec<String>) -> Result<String, String> {
    let normalized = command.trim().to_string();
    if normalized.is_empty() {
        return Err("鍛戒护涓嶈兘涓虹┖".to_string());
    }

    run_in_background(move || run_command_output(&normalized, &args)).await
}

#[tauri::command]
async fn auto_detect_openclaw_config() -> Result<DetectedOpenClawConfig, String> {
    run_in_background(detect_openclaw_config_sync).await
}

#[tauri::command]
async fn update_openclaw_config(payload: OpenClawConfigPayload) -> Result<String, String> {
    run_in_background(move || update_openclaw_config_sync(payload)).await
}

#[tauri::command]
async fn get_installed_skills() -> Result<Vec<InstalledSkill>, String> {
    run_in_background(get_installed_skills_sync).await
}

#[tauri::command]
async fn toggle_skill_status(name: String, enabled: bool) -> Result<String, String> {
    run_in_background(move || toggle_skill_status_sync(&name, enabled)).await
}

#[tauri::command]
async fn skills_list() -> Result<String, String> {
    run_in_background(|| run_openclaw_cli(&["skills", "list"])).await
}

#[tauri::command]
async fn skills_info(name: String) -> Result<String, String> {
    run_in_background(move || {
        let skill_name = ensure_cli_name(&name, "skill name")?;
        let args = vec![
            "skills".to_string(),
            "info".to_string(),
            skill_name.to_string(),
        ];
        run_openclaw_cli_owned(args)
    })
    .await
}

#[tauri::command]
async fn skills_check() -> Result<String, String> {
    run_in_background(|| run_openclaw_cli(&["skills", "check"])).await
}

#[tauri::command]
async fn plugins_list() -> Result<String, String> {
    run_in_background(|| run_openclaw_cli(&["plugins", "list"])).await
}

#[tauri::command]
async fn plugins_info(name: String) -> Result<String, String> {
    run_in_background(move || {
        let plugin_name = ensure_cli_name(&name, "鎻掍欢鍚嶇О")?;
        let args = vec![
            "plugins".to_string(),
            "info".to_string(),
            plugin_name.to_string(),
        ];
        run_openclaw_cli_owned(args)
    })
    .await
}

#[tauri::command]
async fn plugins_install(name: String) -> Result<String, String> {
    run_in_background(move || {
        let plugin_name = ensure_cli_name(&name, "鎻掍欢鍚嶇О")?;
        let args = vec![
            "plugins".to_string(),
            "install".to_string(),
            plugin_name.to_string(),
        ];
        run_openclaw_cli_owned(args)
    })
    .await
}

#[tauri::command]
async fn plugins_enable(name: String) -> Result<String, String> {
    run_in_background(move || {
        let plugin_name = ensure_cli_name(&name, "鎻掍欢鍚嶇О")?;
        let args = vec![
            "plugins".to_string(),
            "enable".to_string(),
            plugin_name.to_string(),
        ];
        run_openclaw_cli_owned(args)
    })
    .await
}

#[tauri::command]
async fn plugins_disable(name: String) -> Result<String, String> {
    run_in_background(move || {
        let plugin_name = ensure_cli_name(&name, "鎻掍欢鍚嶇О")?;
        let args = vec![
            "plugins".to_string(),
            "disable".to_string(),
            plugin_name.to_string(),
        ];
        run_openclaw_cli_owned(args)
    })
    .await
}

#[tauri::command]
async fn plugins_doctor() -> Result<String, String> {
    run_in_background(|| run_openclaw_cli(&["plugins", "doctor"])).await
}

#[tauri::command]
async fn channels_list() -> Result<String, String> {
    run_in_background(|| run_openclaw_cli(&["channels", "list"])).await
}

#[tauri::command]
async fn channels_status() -> Result<String, String> {
    run_in_background(|| run_openclaw_cli(&["channels", "status"])).await
}

#[tauri::command]
async fn channels_logs(name: String) -> Result<String, String> {
    run_in_background(move || {
        let channel_name = ensure_cli_name(&name, "娓犻亾鍚嶇О")?;
        let args = vec![
            "channels".to_string(),
            "logs".to_string(),
            channel_name.to_string(),
        ];
        run_openclaw_cli_owned(args)
    })
    .await
}

#[tauri::command]
async fn channels_add(name: String, args: Option<Vec<String>>) -> Result<String, String> {
    run_in_background(move || {
        let channel_name = ensure_cli_name(&name, "娓犻亾鍚嶇О")?;
        let mut cmd_args = vec![
            "channels".to_string(),
            "add".to_string(),
            channel_name.to_string(),
        ];
        if let Some(extra) = args {
            for argument in extra {
                let trimmed = argument.trim();
                if !trimmed.is_empty() {
                    cmd_args.push(trimmed.to_string());
                }
            }
        }
        run_openclaw_cli_owned(cmd_args)
    })
    .await
}

#[tauri::command]
async fn channels_remove(name: String) -> Result<String, String> {
    run_in_background(move || {
        let channel_name = ensure_cli_name(&name, "娓犻亾鍚嶇О")?;
        let args = vec![
            "channels".to_string(),
            "remove".to_string(),
            channel_name.to_string(),
        ];
        run_openclaw_cli_owned(args)
    })
    .await
}

#[tauri::command]
async fn channels_login(name: String) -> Result<String, String> {
    run_in_background(move || {
        let channel_name = ensure_cli_name(&name, "娓犻亾鍚嶇О")?;
        let args = vec![
            "channels".to_string(),
            "login".to_string(),
            channel_name.to_string(),
        ];
        run_openclaw_cli_owned(args)
    })
    .await
}

#[tauri::command]
async fn channels_logout(name: String) -> Result<String, String> {
    run_in_background(move || {
        let channel_name = ensure_cli_name(&name, "娓犻亾鍚嶇О")?;
        let args = vec![
            "channels".to_string(),
            "logout".to_string(),
            channel_name.to_string(),
        ];
        run_openclaw_cli_owned(args)
    })
    .await
}

#[tauri::command]
async fn nodes_list() -> Result<String, String> {
    run_in_background(|| run_openclaw_cli(&["nodes"])).await
}

#[tauri::command]
async fn devices_list() -> Result<String, String> {
    run_in_background(|| run_openclaw_cli(&["devices"])).await
}

#[tauri::command]
async fn get_autostart_enabled() -> Result<bool, String> {
    run_in_background(query_autostart_enabled_sync).await
}

#[tauri::command]
async fn set_autostart_enabled(enabled: bool) -> Result<bool, String> {
    run_in_background(move || set_autostart_enabled_sync(enabled)).await
}

#[tauri::command]
async fn get_gateway_status(
    state: State<'_, GatewayProcessState>,
) -> Result<GatewayStatus, String> {
    let (running, pid) = snapshot_gateway_process(state.gateway_child.clone()).await;
    Ok(GatewayStatus {
        running,
        pid,
        checked_at: now_unix_ts(),
    })
}

#[tauri::command]
async fn probe_openclaw_gateway(
    state: State<'_, GatewayProcessState>,
) -> Result<GatewayStatus, String> {
    let (running, pid) = snapshot_gateway_process(state.gateway_child.clone()).await;
    Ok(GatewayStatus {
        running,
        pid: if running { pid } else { None },
        checked_at: now_unix_ts(),
    })
}

#[tauri::command]
async fn start_openclaw_gateway(
    app: AppHandle,
    state: State<'_, GatewayProcessState>,
) -> Result<String, String> {
    start_openclaw_gateway_process(app, state.gateway_child.clone()).await
}

#[tauri::command]
async fn stop_openclaw_gateway(state: State<'_, GatewayProcessState>) -> Result<String, String> {
    stop_openclaw_gateway_process(state.gateway_child.clone()).await
}

#[tauri::command]
async fn doctor_openclaw_gateway() -> Result<String, String> {
    run_in_background(|| {
        run_openclaw_cli_with_timeout(&["doctor", "--fix"], DOCTOR_TIMEOUT_SECONDS)
    })
    .await
    .map(|output| {
        if output.trim().is_empty() {
            "璇婃柇涓庤嚜鍔ㄤ慨澶嶅凡瀹屾垚".to_string()
        } else {
            output
        }
    })
}

#[tauri::command]
async fn restart_openclaw_gateway(
    app: AppHandle,
    state: State<'_, GatewayProcessState>,
) -> Result<String, String> {
    restart_openclaw_gateway_process(app, state.gateway_child.clone()).await
}

fn force_kill_gateway_sync() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let script = format!(
            "Stop-Process -Id (Get-NetTCPConnection -LocalPort {} -ErrorAction SilentlyContinue).OwningProcess -Force -ErrorAction SilentlyContinue",
            GATEWAY_PORT
        );
        let mut command = Command::new("powershell");
        command
            .arg("-NoProfile")
            .arg("-Command")
            .arg(script)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        attach_windows_flags(&mut command);

        match command.output() {
            Ok(_) => Ok("Gateway force-kill command executed.".to_string()),
            Err(error) => Err(format!("缁堟缃戝叧杩涚▼澶辫触: {}", error)),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        match Command::new("pkill")
            .arg("-f")
            .arg("openclaw gateway")
            .output()
        {
            Ok(_) => Ok("Gateway kill command executed.".to_string()),
            Err(error) => Err(format!("缁堟缃戝叧杩涚▼澶辫触: {}", error)),
        }
    }
}

#[tauri::command]
async fn force_kill_gateway() -> Result<String, String> {
    run_in_background(force_kill_gateway_sync).await
}

#[tauri::command]
async fn self_heal_gateway() -> Result<String, String> {
    doctor_openclaw_gateway().await
}

#[tauri::command]
async fn open_openclaw_workspace() -> Result<String, String> {
    run_in_background(|| {
        let workspace = openclaw_workspace_dir();
        fs::create_dir_all(&workspace)
            .map_err(|error| format!("鍒涘缓宸ヤ綔鍖?{} 澶辫触: {}", workspace.display(), error))?;

        #[cfg(target_os = "windows")]
        {
            let mut cmd = Command::new("explorer");
            cmd.arg(&workspace);
            attach_windows_flags(&mut cmd);
            cmd.spawn().map_err(|error| {
                format!(
                    "閫氳繃 Explorer 鎵撳紑宸ヤ綔鍖?{} 澶辫触: {}",
                    workspace.display(),
                    error
                )
            })?;
        }

        #[cfg(target_os = "macos")]
        {
            Command::new("open")
                .arg(&workspace)
                .spawn()
                .map_err(|error| {
                    format!(
                        "閫氳繃 Finder 鎵撳紑宸ヤ綔鍖?{} 澶辫触: {}",
                        workspace.display(),
                        error
                    )
                })?;
        }

        #[cfg(all(unix, not(target_os = "macos")))]
        {
            Command::new("xdg-open")
                .arg(&workspace)
                .spawn()
                .map_err(|error| {
                    format!(
                        "閫氳繃鏂囦欢绠＄悊鍣ㄦ墦寮€宸ヤ綔鍖?{} 澶辫触: {}",
                        workspace.display(),
                        error
                    )
                })?;
        }

        Ok(workspace.to_string_lossy().to_string())
    })
    .await
}

#[tauri::command]
async fn clear_openclaw_data() -> Result<String, String> {
    run_in_background(|| {
        let workspace = openclaw_workspace_dir();
        if !workspace.exists() {
            fs::create_dir_all(&workspace)
                .map_err(|error| format!("鍒涘缓宸ヤ綔鍖?{} 澶辫触: {}", workspace.display(), error))?;
            return Ok("Workspace is already empty".to_string());
        }

        let mut removed = 0usize;
        let entries = fs::read_dir(&workspace)
            .map_err(|error| format!("璇诲彇宸ヤ綔鍖?{} 澶辫触: {}", workspace.display(), error))?;

        for entry in entries {
            let entry = entry.map_err(|error| format!("璇诲彇鐩綍椤瑰け璐? {}", error))?;
            let path = entry.path();
            if path.is_dir() {
                fs::remove_dir_all(&path)
                    .map_err(|error| format!("鍒犻櫎鐩綍 {} 澶辫触: {}", path.display(), error))?;
            } else {
                fs::remove_file(&path)
                    .map_err(|error| format!("鍒犻櫎鏂囦欢 {} 澶辫触: {}", path.display(), error))?;
            }
            removed += 1;
        }

        Ok(format!(
            "Cleared {} items from {}",
            workspace.display(),
            removed
        ))
    })
    .await
}

#[tauri::command]
async fn list_im_channels() -> Result<Vec<ImChannelStatus>, String> {
    run_in_background(|| {
        let gateway_running = is_port_open(GATEWAY_PORT);
        let entries = merge_channel_entries()?;
        Ok(entries
            .iter()
            .map(|entry| to_channel_status(entry, gateway_running))
            .collect())
    })
    .await
}

#[tauri::command]
async fn disable_im_channel(channel_id: String) -> Result<String, String> {
    run_in_background(move || {
        let channel_id = channel_id.trim().to_string();
        if channel_id.is_empty() {
            return Err("娓犻亾 ID 涓嶈兘涓虹┖".to_string());
        }

        let mut entries = merge_channel_entries()?;
        let index = upsert_channel(&mut entries, &channel_id);
        entries[index].enabled = Some(false);

        save_channels_to_disk(&entries)?;

        if is_port_open(GATEWAY_PORT) {
            let _ = force_kill_gateway_sync();
        }

        Ok(format!("Channel `{}` disabled", channel_id))
    })
    .await
}

#[tauri::command]
async fn delete_im_channel(channel_id: String) -> Result<String, String> {
    run_in_background(move || {
        let channel_id = channel_id.trim().to_string();
        if channel_id.is_empty() {
            return Err("娓犻亾 ID 涓嶈兘涓虹┖".to_string());
        }

        let mut entries = merge_channel_entries()?;
        entries.retain(|entry| entry.id != channel_id);

        save_channels_to_disk(&entries)?;

        if is_port_open(GATEWAY_PORT) {
            let _ = force_kill_gateway_sync();
        }

        Ok(format!("Channel `{}` deleted", channel_id))
    })
    .await
}

#[tauri::command]
async fn pair_im_channel(channel_id: String) -> Result<String, String> {
    run_in_background(move || {
        let channel_id = channel_id.trim().to_string();
        if channel_id.is_empty() {
            return Err("娓犻亾 ID 涓嶈兘涓虹┖".to_string());
        }

        let mut entries = merge_channel_entries()?;
        let index = upsert_channel(&mut entries, &channel_id);

        entries[index].enabled = Some(true);
        entries[index].paired = Some(true);

        if entries[index].name.is_none() {
            entries[index].name = Some(channel_name_by_id(&channel_id));
        }

        save_channels_to_disk(&entries)?;

        Ok(format!("娓犻亾 `{}` 閰嶅鐘舵€佸凡鏇存柊", channel_id))
    })
    .await
}

#[tauri::command]
fn parse_dropped_file(file_name: String, content: String) -> Result<DroppedFileAnalysis, String> {
    let normalized_name = if file_name.trim().is_empty() {
        "untitled".to_string()
    } else {
        file_name.trim().to_string()
    };

    let content_size = content.len();
    let line_count = content.lines().count();
    let preview = if content.chars().count() > 5000 {
        let shortened: String = content.chars().take(5000).collect();
        format!("{}\n\n[鍚庣宸叉埅鏂樉绀篯", shortened)
    } else {
        content
    };

    Ok(DroppedFileAnalysis {
        file_name: normalized_name,
        size: content_size,
        line_count,
        preview,
    })
}

fn main() {
    tauri::Builder::default()
        .manage(GatewayProcessState::default())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            setup_system_tray(&app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != MAIN_WINDOW_LABEL {
                return;
            }

            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            run_sys_command,
            auto_detect_openclaw_config,
            update_openclaw_config,
            get_installed_skills,
            toggle_skill_status,
            skills_list,
            skills_info,
            skills_check,
            plugins_list,
            plugins_info,
            plugins_install,
            plugins_enable,
            plugins_disable,
            plugins_doctor,
            channels_list,
            channels_status,
            channels_logs,
            channels_add,
            channels_remove,
            channels_login,
            channels_logout,
            nodes_list,
            devices_list,
            get_autostart_enabled,
            set_autostart_enabled,
            get_gateway_status,
            probe_openclaw_gateway,
            start_openclaw_gateway,
            stop_openclaw_gateway,
            doctor_openclaw_gateway,
            force_kill_gateway,
            restart_openclaw_gateway,
            self_heal_gateway,
            open_openclaw_workspace,
            clear_openclaw_data,
            list_im_channels,
            disable_im_channel,
            delete_im_channel,
            pair_im_channel,
            parse_dropped_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
