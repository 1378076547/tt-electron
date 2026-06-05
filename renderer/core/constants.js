/**
 * 全局常量（阶段 1）
 */
(function initConstants(TD) {
  TD.constants = {
    DEFAULT_HANDLER: "wb_lidelei",
    DEFAULT_INTERVAL_SEC: 30,
    MIN_INTERVAL_SEC: 3,
    MAX_INTERVAL_SEC: 300,
    DEFAULT_BATCH_LIMIT: 100,
    NEXT_TICKET_RELOAD_DELAY_MS: 1200,
    MAX_LOG_ITEMS: 300,
    TITLE_PATROL_LOG_BAD_MAX: 30,
    AUTO_PRIORITY_BOOST_TARGET: "高",
    AUTO_PRIORITY_BOOST_KEYWORDS: ["网络卡顿", "断电", "没网"],
    AUTO_PRIORITY_BOOST_MAX_PER_ROUND: 8,
    AUTO_PRIORITY_BOOST_COOLDOWN_MS: 30 * 60 * 1000,
    DEFAULT_SLA_WARN_HOURS: 40,
    DEFAULT_SLA_OVERDUE_HOURS: 48,
    SLA_ALERT_COOLDOWN_MS: 30 * 60 * 1000,
    STORAGE_KEYS: {
      handler: "tt_handler",
      interval: "tt_interval_sec",
      autoGroup: "tt_auto_group",
      autoSendMessage: "tt_auto_send_message",
      titlePatrolLog: "tt_title_patrol_log",
      titleOnNewAuto: "tt_title_on_new_auto",
      autoPriorityBoost: "tt_auto_priority_boost",
      pmCsvPath: "tt_pm_csv_path",
      elephantMessage: "tt_elephant_message",
      elephantMessageEn: "tt_elephant_message_en",
      elephantRules: "tt_elephant_rules_v2",
      slaReminderEnabled: "tt_sla_reminder_enabled",
      slaNotifyWindows: "tt_sla_notify_windows"
    },
    TICKET_CATEGORY_RULES: [
      { key: "monitor", label: "监控类", keywords: ["监控", "摄像头", "cctv", "黑屏", "花屏", "回放", "录像"] },
      { key: "printer", label: "打印类", keywords: ["打印", "打印机", "标签", "条码", "热敏", "标签机"] },
      { key: "network", label: "网络类", keywords: ["网络", "断网", "离线", "联网", "wifi", "路由", "交换机"] },
      { key: "pda", label: "PDA类", keywords: ["pda", "手持", "扫码枪", "扫码", "枪"] }
    ],
    TARGET_RG_IDS: [13619, 8238, 8200, 4967],
    TARGET_FILTER_IDS: [7599],
    TT_WEBVIEW_PARTITION: "persist:tt-desktop-tt-guest",
    TT_WEBVIEW_DEFAULT_SRC: "https://tt.sankuai.com/ticket/handle?filter=todo"
  };
})(window.TTDesktop = window.TTDesktop || {});
