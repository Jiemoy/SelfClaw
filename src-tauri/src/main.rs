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
const COMMAND_TIMEOUT_SECONDS: u64 = 30;
const NPM_GLOBAL_INSTALL_TIMEOUT_SECONDS: u64 = 900;
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
    gateway_token: Option<String>,
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
        .map_err(|error| format!("读取配置文件 {} 失败：{}", path.display(), error))?;
    let parsed: Value = serde_json::from_str(&content).map_err(|error| {
        format!(
            "解析配置文件 {} JSON 格式错误：{}",
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
        .map_err(|error| format!("读取配置文件 {} 失败：{}", path.display(), error))?;
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
        .map_err(|error| format!("读取 UI 配置 {} 失败：{}", path.display(), error))?;
    if content.trim().is_empty() {
        return Ok(SelfClawUiConfig::default());
    }

    serde_json::from_str::<SelfClawUiConfig>(&content)
        .map_err(|error| format!("解析 UI 配置 {} 失败：{}", path.display(), error))
}

fn write_selfclaw_ui_config_sync(config: &SelfClawUiConfig) -> Result<(), String> {
    let path = selfclaw_ui_config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建配置目录 {} 失败：{}", parent.display(), error))?;
    }

    let content = serde_json::to_string_pretty(config)
        .map_err(|error| format!("序列化 UI 配置失败：{}", error))?;
    fs::write(&path, content)
        .map_err(|error| format!("写入 UI 配置 {} 失败：{}", path.display(), error))
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

#[allow(dead_code)]
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
        "{} 写入失败（尝试键：{}）：{}",
        field_label,
        key_candidates.join(", "),
        errors.join(" | ")
    ))
}

fn update_openclaw_config_sync(payload: OpenClawConfigPayload) -> Result<String, String> {
    let workspace_dir = openclaw_workspace_dir();
    fs::create_dir_all(&workspace_dir)
        .map_err(|error| format!("创建配置目录 {} 失败：{}", workspace_dir.display(), error))?;

    // 1) SelfClaw UI 偏好写入 ~/.openclaw/selfclaw-ui.json
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

    // 2) OpenClaw 底层配置直接写入 ~/.openclaw/openclaw.json
    let config_path = workspace_dir.join("openclaw.json");
    let mut config: Value = if config_path.exists() {
        let content = fs::read_to_string(&config_path)
            .map_err(|error| format!("读取配置文件 {} 失败：{}", config_path.display(), error))?;
        serde_json::from_str(&content)
            .unwrap_or_else(|_| Value::Object(serde_json::Map::new()))
    } else {
        Value::Object(serde_json::Map::new())
    };

    let obj = config.as_object_mut().unwrap();

    // --- LLM section: obj["llm"] ---
    {
        let llm = obj
            .entry("llm".to_string())
            .or_insert_with(|| Value::Object(serde_json::Map::new()));
        if let Some(llm_map) = llm.as_object_mut() {
            if let Some(v) = normalize_option_string(payload.provider.clone()) {
                llm_map.insert("provider".to_string(), Value::String(v));
            } else {
                llm_map.remove("provider");
            }
            let model_name = normalize_option_string(
                payload
                    .default_model
                    .clone()
                    .or_else(|| payload.model.clone()),
            );
            if let Some(v) = model_name {
                llm_map.insert("model".to_string(), Value::String(v));
            } else {
                llm_map.remove("model");
            }
            if let Some(v) = normalize_option_string(payload.api_key.clone()) {
                llm_map.insert("api_key".to_string(), Value::String(v));
            } else {
                llm_map.remove("api_key");
            }
            if let Some(v) = normalize_option_string(payload.base_url.clone()) {
                llm_map.insert("base_url".to_string(), Value::String(v));
            } else {
                llm_map.remove("base_url");
            }
            if let Some(v) = normalize_option_string(payload.system_prompt.clone()) {
                llm_map.insert("system_prompt".to_string(), Value::String(v));
            } else {
                llm_map.remove("system_prompt");
            }
            if let Some(v) = payload.temperature {
                let num = serde_json::Number::from_f64(v)
                    .unwrap_or_else(|| serde_json::Number::from(0));
                llm_map.insert("temperature".to_string(), Value::Number(num));
            } else {
                llm_map.remove("temperature");
            }
            if let Some(v) = payload.max_tokens {
                llm_map.insert(
                    "max_tokens".to_string(),
                    Value::Number(serde_json::Number::from(v)),
                );
            } else {
                llm_map.remove("max_tokens");
            }
        }
    }

    // --- Network section: obj["network"] ---
    {
        let network = obj
            .entry("network".to_string())
            .or_insert_with(|| Value::Object(serde_json::Map::new()));
        if let Some(net_map) = network.as_object_mut() {
            if let Some(v) = normalize_option_string(payload.http_proxy.clone()) {
                net_map.insert("http_proxy".to_string(), Value::String(v));
            } else {
                net_map.remove("http_proxy");
            }
            if let Some(v) = normalize_option_string(payload.socks5_proxy.clone()) {
                net_map.insert("socks5_proxy".to_string(), Value::String(v));
            } else {
                net_map.remove("socks5_proxy");
            }
        }
    }

    // --- Gateway section: obj["gateway"] ---
    {
        let gateway = obj
            .entry("gateway".to_string())
            .or_insert_with(|| Value::Object(serde_json::Map::new()));
        if let Some(gw_map) = gateway.as_object_mut() {
            if let Some(v) = payload.gateway_port {
                gw_map.insert(
                    "port".to_string(),
                    Value::Number(serde_json::Number::from(u32::from(v))),
                );
            } else {
                gw_map.remove("port");
            }
            // Write gateway auth token under gateway.auth.token
            if let Some(token) = normalize_option_string(payload.gateway_token.clone()) {
                let auth = gw_map
                    .entry("auth".to_string())
                    .or_insert_with(|| Value::Object(serde_json::Map::new()));
                if let Some(auth_map) = auth.as_object_mut() {
                    auth_map.insert("token".to_string(), Value::String(token));
                }
            } else {
                // Remove token only if it was explicitly cleared
                if let Some(auth) = gw_map.get("auth").and_then(Value::as_object) {
                    let mut new_auth = auth.clone();
                    new_auth.remove("token");
                    gw_map.insert("auth".to_string(), Value::Object(new_auth));
                }
            }
        }
    }

    // --- Log section: obj["log"] ---
    {
        let log = obj
            .entry("log".to_string())
            .or_insert_with(|| Value::Object(serde_json::Map::new()));
        if let Some(log_map) = log.as_object_mut() {
            if let Some(v) = normalize_option_string(payload.log_level.clone()) {
                log_map.insert("level".to_string(), Value::String(v));
            } else {
                log_map.remove("level");
            }
        }
    }

    let content = serde_json::to_string_pretty(&config)
        .map_err(|error| format!("序列化配置失败：{}", error))?;
    fs::write(&config_path, content)
        .map_err(|error| format!("写入配置文件 {} 失败：{}", config_path.display(), error))?;

    Ok(format!(
        "配置已保存至 {} 和 {}",
        config_path.display(),
        selfclaw_ui_config_path().display()
    ))
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

    // 同时读取 SelfClaw UI 配置，前者优先统一来源
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
            Err(error) => Err(format!("查询开机自启状态失败：{}", error)),
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
                std::env::current_exe().map_err(|error| format!("获取当前可执行文件路径失败：{}", error))?;
            let executable = current_executable
                .to_str()
                .ok_or_else(|| "可执行文件路径包含非 UTF-8 字符".to_string())?;
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
                Err(error) => Err(format!("写入注册表失败：{}", error)),
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
        .map_err(|error| format!("启动命令 {} 失败: {}", command, error))?;

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
        .map_err(|error| format!("等待命令 {} 完成失败：{}", command, error))?,
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
        format!("命令 {} 执行失败，退出码：{}", command, status)
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
    _gateway_child: Option<Arc<Mutex<Option<Child>>>>,
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
        // NOTE: do NOT call child.wait() here — it causes deadlock because:
        //   - we hold the stdout reader which the child is writing to
        //   - the child (cmd /c openclaw gateway) only exits when openclaw exits
        //   - openclaw gateway runs forever, so we would wait forever
        // Gateway process lifecycle is managed separately via GatewayProcessState.
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
                    emit_gateway_log_line(&app, format!("[system] 检测到网关进程已退出，状态：{}", status));
                    *guard = None;
                }
                Ok(None) => return Ok("网关已在运行中".to_string()),
                Err(error) => {
                    emit_gateway_log_line(
                        &app,
                        format!("[warn] 检查现有网关进程状态失败，将重新启动：{}", error),
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

    let args = vec!["gateway".to_string(), "--allow-unconfigured".to_string()];
    // Windows: npm 全局安装的是 openclaw.cmd，CreateProcess 无法用 "openclaw" 直接解析；
    // 必须经过 cmd 才能按 PATHEXT 找到 .cmd（与之前 shell 包装行为一致）。
    let mut cmd = build_shell_wrapped_tokio_command("openclaw", &args);
    attach_windows_flags_tokio(&mut cmd);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|error| format!("启动网关进程失败：{}", error))?;

    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    {
        let mut guard = gateway_child.lock().await;
        *guard = Some(child);
    }

    if let Some(stdout_stream) = stdout {
        spawn_gateway_output_reader(app.clone(), stdout_stream, false, None);
    }
    if let Some(stderr_stream) = stderr {
        spawn_gateway_output_reader(app.clone(), stderr_stream, true, None);
    }

    // 独立的 child 退出监控：只负责观察退出并发出 gateway-exited，不从共享状态中夺走 child
    // 的拥有权，以便 stop_openclaw_gateway_process 仍能通过 taskkill 终止进程。
    tokio::spawn({
        let app = app.clone();
        let gateway_child = gateway_child.clone();
        async move {
            loop {
                // 每隔 1 秒检查一次 child 是否已退出，避免永久阻塞导致死锁。
                tokio::time::sleep(Duration::from_secs(1)).await;
                let mut guard = gateway_child.lock().await;
                let Some(child) = guard.as_mut() else {
                    break;
                };
                match child.try_wait() {
                    Ok(Some(status)) => {
                        emit_gateway_log_line(&app, format!("[system] Gateway process exited: {}", status));
                        let _ = app.emit("gateway-exited", ());
                        break;
                    }
                    Ok(None) => {
                        // 仍在运行，继续循环等待。
                    }
                    Err(e) => {
                        emit_gateway_log_line(&app, format!("[error] Failed polling gateway process: {}", e));
                        let _ = app.emit("gateway-exited", ());
                        break;
                    }
                }
            }
        }
    });

    if let Some(pid) = pid {
        Ok(format!("网关已在前台启动（PID: {}）", pid))
    } else {
        Ok("OpenClaw gateway started in foreground".to_string())
    }
}

async fn stop_openclaw_gateway_process(
    gateway_child: Arc<Mutex<Option<Child>>>,
) -> Result<String, String> {
    // Take child OUT of shared state FIRST so snapshot_gateway_process can't
    // return (true, pid) after we start killing — it will see None and check port.
    let child_pid = {
        let mut guard = gateway_child.lock().await;
        if let Some(ref mut child) = *guard {
            child.id()
        } else {
            None
        }
    };

    // Try graceful stop via openclaw CLI first
    let _ = run_openclaw_cli_with_timeout_async(&["gateway", "stop"], 5).await;

    // Force kill the process by PID
    if let Some(pid) = child_pid {
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
            let mut cmd = tokio::process::Command::new("kill");
            cmd.arg("-9").arg(pid.to_string());
            let _ = run_raw_tokio_command_with_timeout(cmd, 10, "kill").await;
        }
    }

    // Now clear the shared child state (safe — we own nothing now)
    {
        let mut guard = gateway_child.lock().await;
        *guard = None;
    }

    // Kill any remaining processes on the gateway port
    kill_gateway_port_occupants().await;

    // Poll port until it is confirmed free (up to 6 seconds)
    for _ in 0..60 {
        if !is_port_open(GATEWAY_PORT) {
            return Ok("Gateway stopped".to_string());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    // Port still occupied after 6s — try one more forceful cleanup
    kill_gateway_port_occupants().await;
    tokio::time::sleep(Duration::from_secs(1)).await;

    if !is_port_open(GATEWAY_PORT) {
        Ok("Gateway stopped".to_string())
    } else {
        Err(format!(
            "Gateway port {} is still occupied after stop. Please manually stop the process using that port.",
            GATEWAY_PORT
        ))
    }
}

async fn restart_openclaw_gateway_process(
    app: AppHandle,
    gateway_child: Arc<Mutex<Option<Child>>>,
) -> Result<String, String> {
    // Stop may return Err if already stopped (port free) — that's fine for restart
    if let Err(error) = stop_openclaw_gateway_process(gateway_child.clone()).await {
        // "网关未运行" means port is free — expected for restart
        if error != "Gateway stopped" && !error.contains("port") {
            return Err(error);
        }
    }

    start_openclaw_gateway_process(app, gateway_child).await?;
    Ok("网关重启完成".to_string())
}

async fn snapshot_gateway_process(gateway_child: Arc<Mutex<Option<Child>>>) -> (bool, Option<u32>) {
    {
        let mut guard = gateway_child.lock().await;
        let Some(child) = guard.as_mut() else {
            let running = is_port_open(GATEWAY_PORT);
            return (running, None);
        };

        match child.try_wait() {
            Ok(Some(_)) => {
                *guard = None;
                let running = is_port_open(GATEWAY_PORT);
                return (running, None);
            }
            Ok(None) => return (true, child.id()),
            Err(_) => {
                *guard = None;
                let running = is_port_open(GATEWAY_PORT);
                return (running, None);
            }
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
        return Err("技能名称不能为空".to_string());
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
            "技能 `{}` 已{}",
            skill_name,
            if enabled {
                "启用"
            } else {
                "禁用"
            }
        ))
    } else {
        Ok(output)
    }
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return Err("找不到主窗口".to_string());
    };

    let _ = window.unminimize();
    window
        .show()
        .map_err(|error| format!("显示窗口失败：{}", error))?;
    window
        .set_focus()
        .map_err(|error| format!("聚焦窗口失败：{}", error))?;
    Ok(())
}

fn toggle_main_window_visibility<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return Err("找不到主窗口".to_string());
    };

    if window
        .is_visible()
        .map_err(|error| format!("获取窗口可见状态失败：{}", error))?
    {
        window
            .hide()
            .map_err(|error| format!("隐藏窗口失败：{}", error))?;
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
        .text(TRAY_MENU_RESTART_GATEWAY, "重启网关")
        .separator()
        .text(TRAY_MENU_QUIT, "退出 SelfClaw")
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
    let handle = tokio::task::spawn_blocking(task);
    match tokio::time::timeout(Duration::from_secs(120), handle).await {
        Ok(Ok(task_result)) => task_result,
        Ok(Err(panic_error)) => Err(format!("后台任务 panic：{}", panic_error)),
        Err(_) => Err("后台任务执行超时（120s）".to_string()),
    }
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
            name: Some("飞书".to_string()),
            ..Default::default()
        },
        ImChannelEntry {
            id: "wecom".to_string(),
            name: Some("企业微信".to_string()),
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
        "feishu" => "飞书".to_string(),
        "wecom" => "企业微信".to_string(),
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
        .map_err(|error| format!("读取渠道配置文件 {} 失败：{}", path.display(), error))?;

    let value: Value = serde_json::from_str(&content)
        .map_err(|error| format!("解析渠道配置文件 JSON 格式错误: {}", error))?;

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
                "创建渠道配置目录 {} 失败：{}",
                parent.display(),
                error
            )
        })?;
    }

    let payload = ImChannelFile {
        channels: entries.to_vec(),
    };

    let data = serde_json::to_string_pretty(&payload)
        .map_err(|error| format!("序列化渠道配置失败：{}", error))?;

    fs::write(&path, data)
        .map_err(|error| format!("写入渠道配置文件 {} 失败：{}", path.display(), error))
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
        return Err("命令不能为空".to_string());
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
        let plugin_name = ensure_cli_name(&name, "插件名称")?;
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
        let plugin_name = ensure_cli_name(&name, "插件名称")?;
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
        let plugin_name = ensure_cli_name(&name, "插件名称")?;
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
        let plugin_name = ensure_cli_name(&name, "插件名称")?;
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
        let channel_name = ensure_cli_name(&name, "渠道名称")?;
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
        let channel_name = ensure_cli_name(&name, "渠道名称")?;
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
        let channel_name = ensure_cli_name(&name, "渠道名称")?;
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
        let channel_name = ensure_cli_name(&name, "渠道名称")?;
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
        let channel_name = ensure_cli_name(&name, "渠道名称")?;
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
            "诊断与自动修复已完成".to_string()
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
            Err(error) => Err(format!("终止网关进程失败：{}", error)),
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
            Err(error) => Err(format!("终止网关进程失败：{}", error)),
        }
    }
}

#[tauri::command]
async fn force_kill_gateway() -> Result<String, String> {
    run_in_background(force_kill_gateway_sync).await
}

fn read_gateway_auth_token_sync() -> Result<String, String> {
    let config_path = openclaw_workspace_dir().join("openclaw.json");
    if !config_path.exists() {
        return Err("OpenClaw 配置文件不存在，请先在设置中保存配置以初始化网关".to_string());
    }

    let content = fs::read_to_string(&config_path)
        .map_err(|error| format!("读取配置文件 {} 失败：{}", config_path.display(), error))?;
    if content.trim().is_empty() {
        return Err("OpenClaw 配置文件为空，请先在设置中保存配置以初始化网关".to_string());
    }
    let parsed: Value = serde_json::from_str(&content)
        .map_err(|error| format!("解析配置文件 JSON 失败：{}", error))?;

    let token = parsed
        .get("gateway")
        .and_then(|gw| gw.get("auth"))
        .and_then(|auth| auth.get("token"))
        .and_then(|t| t.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(ToString::to_string);

    match token {
        Some(t) => Ok(t),
        None => Err("网关认证 token 未配置，请在设置中保存配置或启动网关以生成 token".to_string()),
    }
}

#[tauri::command]
async fn get_gateway_auth_token() -> Result<String, String> {
    run_in_background(read_gateway_auth_token_sync).await
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
            .map_err(|error| format!("创建工作区 {} 失败：{}", workspace.display(), error))?;

        #[cfg(target_os = "windows")]
        {
            let mut cmd = Command::new("explorer");
            cmd.arg(&workspace);
            attach_windows_flags(&mut cmd);
            cmd.spawn().map_err(|error| {
                format!(
                    "通过 Explorer 打开工作区 {} 失败：{}",
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
                        "通过 Finder 打开工作区 {} 失败：{}",
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
                        "通过文件管理器打开工作区 {} 失败：{}",
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
                .map_err(|error| format!("创建工作区 {} 失败：{}", workspace.display(), error))?;
            return Ok("Workspace is already empty".to_string());
        }

        let mut removed = 0usize;
        let entries = fs::read_dir(&workspace)
            .map_err(|error| format!("读取工作区 {} 失败：{}", workspace.display(), error))?;

        for entry in entries {
            let entry = entry.map_err(|error| format!("读取目录项失败：{}", error))?;
            let path = entry.path();
            if path.is_dir() {
                fs::remove_dir_all(&path)
                    .map_err(|error| format!("删除目录 {} 失败：{}", path.display(), error))?;
            } else {
                fs::remove_file(&path)
                    .map_err(|error| format!("删除文件 {} 失败：{}", path.display(), error))?;
            }
            removed += 1;
        }

        Ok(format!(
            "Cleared {} items from {}",
            removed,
            workspace.display()
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
            return Err("渠道 ID 不能为空".to_string());
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
            return Err("渠道 ID 不能为空".to_string());
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
            return Err("渠道 ID 不能为空".to_string());
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
async fn parse_dropped_file(file_name: String, content: String) -> Result<DroppedFileAnalysis, String> {
    let normalized_name = if file_name.trim().is_empty() {
        "untitled".to_string()
    } else {
        file_name.trim().to_string()
    };

    let content_size = content.len();
    let line_count = content.lines().count();
    let preview = if content.chars().count() > 5000 {
        let shortened: String = content.chars().take(5000).collect();
        format!("{}\n\n[后端已截断显示]", shortened)
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

#[tauri::command]
async fn download_file_with_progress(
    app: AppHandle,
    url: String,
    output_path: String,
) -> Result<String, String> {
    use std::sync::mpsc;
    use std::time::Duration;

    #[derive(Debug)]
    enum DownloadMsg {
        Progress { progress: u8, stage: String },
        Error(String),
        Done(String),
    }

    let (tx, rx) = mpsc::channel::<DownloadMsg>();
    let output_path_for_return = output_path.clone();

    std::thread::Builder::new()
        .name("openclaw-downloader".into())
        .spawn(move || {
            let response = match ureq::get(&url).call() {
                Ok(r) => r,
                Err(e) => {
                    let _ = tx.send(DownloadMsg::Error(format!("HTTP 请求失败: {}", e)));
                    return;
                }
            };

            let total_bytes: Option<u64> = response
                .header("content-length")
                .and_then(|v| v.parse::<u64>().ok());

            let reader: Box<dyn std::io::Read + Send> = response.into_reader();

            let mut reader = reader;
            let mut file = match std::fs::File::create(&output_path) {
                Ok(f) => f,
                Err(e) => {
                    let _ = tx.send(DownloadMsg::Error(format!("创建文件 {} 失败: {}", output_path, e)));
                    return;
                }
            };

            let mut bytes_downloaded: u64 = 0;
            let mut chunk_buf = [0u8; 65536];

            loop {
                let n = match std::io::Read::read(&mut reader, &mut chunk_buf) {
                    Ok(n) => n,
                    Err(e) => {
                        let _ = tx.send(DownloadMsg::Error(format!("读取下载流失败: {}", e)));
                        return;
                    }
                };
                if n == 0 {
                    break;
                }

                if let Err(e) = std::io::Write::write_all(&mut file, &chunk_buf[..n]) {
                    let _ = tx.send(DownloadMsg::Error(format!("写入文件失败: {}", e)));
                    return;
                }

                bytes_downloaded += n as u64;

                let progress = if let Some(total) = total_bytes {
                    ((bytes_downloaded as f64 / total as f64) * 80.0) as u8
                } else {
                    50u8
                };

                let size_str = if bytes_downloaded < 1024 * 1024 {
                    format!("{:.1} KB", bytes_downloaded as f64 / 1024.0)
                } else {
                    format!("{:.1} MB", bytes_downloaded as f64 / (1024.0 * 1024.0))
                };

                let _ = tx.send(DownloadMsg::Progress {
                    progress,
                    stage: format!("下载中 ({})", size_str),
                });
            }

            let final_size = std::fs::metadata(&output_path)
                .map(|m| m.len())
                .unwrap_or(0);

            if final_size < 5 * 1024 * 1024 {
                let _ = std::fs::remove_file(&output_path);
                let size_mb = format!("{:.2}", final_size as f64 / (1024.0 * 1024.0));
                let _ = tx.send(DownloadMsg::Error(format!(
                    "下载失败：文件体积异常 ({} MB < 5 MB)，可能链接已失效",
                    size_mb
                )));
                return;
            }

            let _ = tx.send(DownloadMsg::Done(output_path.clone()));
        })
        .map_err(|e| format!("启动下载线程失败: {}", e))?;

    loop {
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(DownloadMsg::Progress { progress, stage }) => {
                let _ = app.emit("download-progress", serde_json::json!({
                    "progress": progress,
                    "stage": stage,
                    "bytesDownloaded": 0,
                    "totalBytes": null
                }));
            }
            Ok(DownloadMsg::Done(_)) => {
                let _ = app.emit("download-progress", serde_json::json!({
                    "progress": 85,
                    "stage": "下载完成，正在准备安装...",
                    "bytesDownloaded": 0,
                    "totalBytes": null
                }));
                return Ok(output_path_for_return);
            }
            Ok(DownloadMsg::Error(msg)) => {
                return Err(msg);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                continue;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("下载线程异常退出".to_string());
            }
        }
    }
}

#[tauri::command]
async fn install_openclaw_cli(app: AppHandle) -> Result<String, String> {
    use std::sync::mpsc;
    use std::time::Duration;

    let (tx, rx) = mpsc::channel::<Result<String, String>>();

    std::thread::Builder::new()
        .name("openclaw-npm-install".into())
        .spawn(move || {
            let args = ["install".to_string(), "-g".to_string(), "openclaw@latest".to_string()];
            let output = run_command_output_with_custom_timeout(
                "npm",
                &args,
                NPM_GLOBAL_INSTALL_TIMEOUT_SECONDS,
            );
            tx.send(output).ok();
        })
        .map_err(|e| format!("启动 npm 安装线程失败: {}", e))?;

    let start = std::time::Instant::now();
    loop {
        match rx.recv_timeout(Duration::from_millis(150)) {
            Ok(Ok(msg)) => {
                let _ = app.emit("npm-install-progress", serde_json::json!({
                    "progress": 100,
                    "stage": "安装完成"
                }));
                return Ok(msg);
            }
            Ok(Err(e)) => {
                let _ = app.emit("npm-install-progress", serde_json::json!({
                    "progress": 0,
                    "stage": "安装失败"
                }));
                return Err(e);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let elapsed = start.elapsed().as_secs();
                let progress = if elapsed < 15 {
                    ((elapsed as f64 / 15.0) * 90.0) as u8
                } else {
                    90u8
                };
                let seconds = elapsed;
                let stage = if seconds < 60 {
                    format!("正在安装 OpenClaw CLI... ({}s)", seconds)
                } else {
                    let mins = seconds / 60;
                    let secs = seconds % 60;
                    format!("正在安装 OpenClaw CLI... ({}m{}s)", mins, secs)
                };
                let _ = app.emit("npm-install-progress", serde_json::json!({
                    "progress": progress,
                    "stage": stage
                }));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("npm 安装线程异常退出".to_string());
            }
        }
    }
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
            get_gateway_auth_token,
            open_openclaw_workspace,
            clear_openclaw_data,
            list_im_channels,
            disable_im_channel,
            delete_im_channel,
            pair_im_channel,
            parse_dropped_file,
            download_file_with_progress,
            install_openclaw_cli
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
