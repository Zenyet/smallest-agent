// ============================================================================
// msg_times.rs —— 每条消息的发送 / 回复时间
// ----------------------------------------------------------------------------
// 和 session_titles.rs / projects.json 同一个模式：旁挂一个文件，存
// 「core 不管但 UI 需要」的元数据。
//
// ## 为什么不直接给 core 的 Message 加一个时间字段
//
// 试过那条路，它会打破一个有测试守着的约定：`writes_json_ts_can_read`
// 断言 Rust 写出的会话 JSON 和 TS 版**完全相等**（字段名、缺省、嵌套全对上）。
// Message 上多一个 `at` 字段就会多一个键，那条测试立刻红 ——
// 而它守的是真东西：两个版本读写同一批 .sessions/*.json 文件。
//
// 所以时间戳存在旁边，按 `会话id → [时间戳]` 的形状，下标和该会话
// 消息数组的下标一一对应。
//
// ## 下标对应会不会错位
//
// 会，如果消息数组被中间插入或删除。实际上不会发生：会话历史只在末尾追加
// （SaveSessionHook 整体覆写，但内容是「原历史 + 这一轮新增」），
// 唯一的删除是「编辑重发」那种截断到某一点再续写 —— 那时候时间戳数组
// 也一起截断（见 truncate）。
//
// 错位的后果是显示的时间不对，不影响对话本身。所以这里选了「便宜且够用」
// 而不是给每条消息发一个稳定 id ——后者要改 core 的线格式，代价回到上面那条。
// ============================================================================

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{Context as _, Result};

/// 会话 id → 每条消息的时间戳（unix 毫秒）。下标对应消息下标。
pub type MsgTimes = BTreeMap<String, Vec<u64>>;

fn times_path() -> Result<PathBuf> {
    crate::settings::settings_path()
        .map(|p| p.with_file_name("message_times.json"))
        .context("算 message_times.json 路径失败")
}

/// 读。文件不存在或坏了都返回空表 —— 时间戳丢了只是不显示时间，
/// 不该让应用起不来（同 session_titles）。
pub fn load() -> MsgTimes {
    let Ok(path) = times_path() else {
        return MsgTimes::new();
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return MsgTimes::new();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

pub fn save(times: &MsgTimes) -> Result<()> {
    let path = times_path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .with_context(|| format!("建配置目录失败：{}", dir.display()))?;
    }
    let json = serde_json::to_vec_pretty(times).context("序列化消息时间失败")?;
    std::fs::write(&path, json).with_context(|| format!("写 {} 失败", path.display()))
}

/// 现在的 unix 毫秒。
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 把时间戳格式化成「时:分」。
///
/// 只显示时分，不显示日期：气泡上那一行空间很小，而绝大多数回看
/// 发生在当天。跨天的情况下用户靠会话列表的日期定位，不靠这里。
///
/// 手写而不是引 chrono：只为把一个毫秒数变成 `14:32` 引一个日期库
/// （以及它的时区数据库）不值得。代价是**用本地时区偏移的近似**：
/// 这里直接用系统的 UTC 偏移，不处理夏令时切换那一小时的边界。
/// 显示时间差一小时不影响任何决定，而正确处理它要一整个 tz 数据库。
pub fn format_hm(at: u64, utc_offset_secs: i64) -> String {
    if at == 0 {
        // 0 = 不知道（历史消息没有记录）。显示空串而不是 1970-01-01，
        // 后者看着像 bug
        return String::new();
    }
    let secs = (at / 1000) as i64 + utc_offset_secs;
    let secs_of_day = secs.rem_euclid(86_400);
    let h = secs_of_day / 3600;
    let m = (secs_of_day % 3600) / 60;
    format!("{h:02}:{m:02}")
}

/// 系统的 UTC 偏移（秒）。
///
/// std 没有拿本地时区的 API，所以问一次 `date +%z`。
/// 只在启动时调一次，结果缓存 —— 每帧起子进程是不可接受的。
///
/// 拿不到就返回 0（当成 UTC）。那会让时间显示偏一个时区，
/// 但不会崩，也不会阻塞启动。
pub fn utc_offset_secs() -> i64 {
    use std::sync::OnceLock;
    static OFFSET: OnceLock<i64> = OnceLock::new();
    *OFFSET.get_or_init(|| {
        let out = std::process::Command::new("date").arg("+%z").output().ok();
        let Some(out) = out else { return 0 };
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        // 形如 +0800 / -0500
        if s.len() < 5 {
            return 0;
        }
        let sign = if s.starts_with('-') { -1 } else { 1 };
        let h: i64 = s[1..3].parse().unwrap_or(0);
        let m: i64 = s[3..5].parse().unwrap_or(0);
        sign * (h * 3600 + m * 60)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_renders_empty_not_epoch() {
        // 历史消息没有时间记录时显示空串 —— 显示 1970 那种看着像 bug
        assert_eq!(format_hm(0, 0), "");
    }

    #[test]
    fn formats_as_two_digit_hour_and_minute() {
        // 1970-01-01 14:32:00 UTC
        let at = (14 * 3600 + 32 * 60) * 1000;
        assert_eq!(format_hm(at, 0), "14:32");
    }

    #[test]
    fn applies_the_utc_offset() {
        // 同一时刻在 +08:00 是 22:32
        let at = (14 * 3600 + 32 * 60) * 1000;
        assert_eq!(format_hm(at, 8 * 3600), "22:32");
    }

    #[test]
    fn wraps_across_midnight_instead_of_going_negative() {
        // 00:30 UTC 在 -05:00 是前一天的 19:30。
        // 用 rem_euclid 而不是 %：后者对负数返回负值，会算出 "-5:30"
        // 00:30 UTC
        let at = 30 * 60 * 1000;
        assert_eq!(format_hm(at, -5 * 3600), "19:30");
    }

    #[test]
    fn pads_single_digit_hours() {
        let at = (9 * 3600 + 5 * 60) * 1000;
        assert_eq!(format_hm(at, 0), "09:05");
    }
}
