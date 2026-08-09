import {
  Activity,
  Brain,
  BriefcaseBusiness,
  CalendarDays,
  Check,
  ChevronRight,
  CircleUserRound,
  Cloud,
  Code2,
  Copy,
  Database,
  KeyRound,
  LayoutDashboard,
  Link2,
  Menu,
  MonitorSmartphone,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  ShieldCheck,
  MessageSquare,
  Terminal,
  Trash2,
  X,
  type IconNode,
} from "lucide";

const iconMap = {
  activity: renderIcon(Activity),
  brain: renderIcon(Brain),
  calendar: renderIcon(CalendarDays),
  check: renderIcon(Check),
  chevron: renderIcon(ChevronRight),
  cloud: renderIcon(Cloud),
  copy: renderIcon(Copy),
  database: renderIcon(Database),
  devices: renderIcon(MonitorSmartphone),
  github: renderIcon(Code2),
  integrations: renderIcon(Link2),
  key: renderIcon(KeyRound),
  menu: renderIcon(Menu),
  overview: renderIcon(LayoutDashboard),
  plus: renderIcon(Plus),
  projects: renderIcon(BriefcaseBusiness),
  refresh: renderIcon(RefreshCw),
  save: renderIcon(Save),
  settings: renderIcon(Settings2),
  shield: renderIcon(ShieldCheck),
  slack: renderIcon(MessageSquare),
  status: renderIcon(CircleUserRound),
  terminal: renderIcon(Terminal),
  trash: renderIcon(Trash2),
  x: renderIcon(X),
};

export function renderDashboardPage(csrfToken: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="one-status-csrf" content="${escapeHtml(csrfToken)}">
  <title>One Status</title>
  <link rel="stylesheet" href="/assets/dashboard.css">
</head>
<body>
  <div class="app-shell">
    <aside class="sidebar" id="sidebar">
      <div class="brand"><span class="brand-mark">OS</span><span>One Status</span></div>
      <nav class="nav" aria-label="主导航">
        ${navLink("/", "overview", "概览")}
        ${navLink("/status", "status", "状态")}
        ${navLink("/projects", "projects", "项目")}
        ${navLink("/handoffs", "cloud", "Handoff")}
        ${navLink("/environment", "settings", "Agents 与工具")}
        ${navLink("/memory", "brain", "记忆")}
        ${navLink("/integrations", "integrations", "连接与权限")}
        ${navLink("/devices", "devices", "设备")}
        ${navLink("/activity", "activity", "活动")}
        ${navLink("/security", "shield", "安全")}
      </nav>
      <div class="sidebar-footer">
        <span class="health-dot"></span>
        <div><strong>Local Gateway</strong><span id="gateway-address">本机服务</span></div>
      </div>
    </aside>
    <div class="workspace">
      <header class="topbar">
        <button class="icon-button mobile-menu" id="mobile-menu" type="button" title="打开导航">${iconMap.menu}</button>
        <div><p class="eyebrow">ONE STATUS</p><h1 id="page-title">概览</h1></div>
        <div class="topbar-actions">
          <span class="sync-state" id="sync-state"><span></span>已同步</span>
          <button class="icon-button" id="refresh" type="button" title="刷新">${iconMap.refresh}</button>
        </div>
      </header>
      <main id="main" class="main"><div class="loading"><span></span><p>正在读取加密状态</p></div></main>
    </div>
  </div>
  <div class="modal-backdrop" id="modal-backdrop" hidden>
    <section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <header><h2 id="modal-title"></h2><button class="icon-button" data-close-modal type="button" title="关闭">${iconMap.x}</button></header>
      <div id="modal-content"></div>
    </section>
  </div>
  <div class="toast" id="toast" role="status" hidden></div>
  <script src="/assets/dashboard.js" defer></script>
</body>
</html>`;
}

export const dashboardCss = String.raw`
:root {
  color: #17191c;
  background: #f5f6f7;
  font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-synthesis: none;
  --border: #dfe2e5;
  --muted: #687078;
  --surface: #ffffff;
  --surface-subtle: #f8f9fa;
  --green: #16825d;
  --blue: #2463eb;
  --amber: #a65f00;
  --red: #c33b3b;
}
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; min-height: 100vh; }
button, input, textarea, select { font: inherit; letter-spacing: 0; }
button { cursor: pointer; }
a { color: inherit; }
.app-shell { display: grid; grid-template-columns: 224px minmax(0, 1fr); min-height: 100vh; }
.sidebar { position: fixed; inset: 0 auto 0 0; width: 224px; display: flex; flex-direction: column; padding: 18px 14px; background: #17191c; color: #f7f8f9; z-index: 30; }
.brand { display: flex; align-items: center; gap: 10px; padding: 0 8px 18px; font-size: 15px; font-weight: 700; }
.brand-mark { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 6px; color: #17221e; background: #8ce0ba; font-size: 11px; font-weight: 800; }
.nav { display: grid; gap: 3px; }
.nav-link { display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 0 10px; border-radius: 6px; color: #aeb5bc; text-decoration: none; font-size: 14px; font-weight: 550; }
.nav-link:hover { color: #fff; background: #24272b; }
.nav-link.active { color: #fff; background: #2b2f33; }
.nav-link svg { width: 17px; height: 17px; }
.sidebar-footer { margin-top: auto; display: flex; align-items: center; gap: 9px; padding: 12px 9px; border-top: 1px solid #303338; color: #cbd0d5; }
.sidebar-footer div { display: grid; gap: 2px; }
.sidebar-footer strong { font-size: 12px; }
.sidebar-footer span:not(.health-dot) { color: #7e8790; font-size: 11px; }
.health-dot { width: 8px; height: 8px; border-radius: 50%; background: #45c78c; box-shadow: 0 0 0 3px rgba(69,199,140,.12); }
.workspace { grid-column: 2; min-width: 0; }
.topbar { position: sticky; top: 0; z-index: 20; display: flex; align-items: center; justify-content: space-between; min-height: 72px; padding: 12px clamp(20px, 4vw, 48px); background: rgba(255,255,255,.94); border-bottom: 1px solid var(--border); backdrop-filter: blur(10px); }
.topbar h1 { margin: 1px 0 0; font-size: 20px; line-height: 1.2; letter-spacing: 0; }
.eyebrow { margin: 0; color: var(--muted); font-size: 10px; font-weight: 750; }
.topbar-actions { display: flex; align-items: center; gap: 10px; }
.sync-state { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); font-size: 12px; }
.sync-state span { width: 7px; height: 7px; border-radius: 50%; background: var(--green); }
.sync-state.syncing span { background: var(--amber); }
.sync-state.error span { background: var(--red); }
.icon-button { display: inline-grid; place-items: center; width: 34px; height: 34px; padding: 0; border: 1px solid var(--border); border-radius: 6px; color: #34393e; background: #fff; }
.icon-button:hover { background: #f3f5f6; }
.icon-button svg { width: 16px; height: 16px; }
.mobile-menu { display: none; }
.main { width: min(1180px, 100%); margin: 0 auto; padding: 30px clamp(20px, 4vw, 48px) 60px; }
.loading { display: grid; justify-items: center; gap: 12px; padding: 96px 0; color: var(--muted); }
.loading span { width: 22px; height: 22px; border: 2px solid #d9dddf; border-top-color: #252a2e; border-radius: 50%; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.section-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
.section-header h2 { margin: 0; font-size: 17px; letter-spacing: 0; }
.section-header p { margin: 5px 0 0; color: var(--muted); font-size: 13px; }
.button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 36px; padding: 0 13px; border: 1px solid #22272b; border-radius: 6px; color: #fff; background: #22272b; font-size: 13px; font-weight: 650; text-decoration: none; }
.button:hover { background: #111315; }
.button.secondary { color: #33383c; background: #fff; border-color: var(--border); }
.button.secondary:hover { background: #f5f6f7; }
.button.danger { color: var(--red); background: #fff; border-color: #e9c9c9; }
.button:disabled { cursor: not-allowed; opacity: .5; }
.button svg { width: 15px; height: 15px; }
.metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 28px; }
.metric { min-height: 112px; padding: 16px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); }
.metric-top { display: flex; align-items: center; justify-content: space-between; color: var(--muted); font-size: 12px; }
.metric-icon { display: grid; place-items: center; width: 29px; height: 29px; border-radius: 6px; background: #eef1f3; color: #495158; }
.metric-icon svg { width: 15px; height: 15px; }
.metric strong { display: block; margin-top: 12px; font-size: 24px; line-height: 1; }
.metric small { display: block; margin-top: 7px; color: var(--muted); font-size: 11px; }
.layout-2 { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(280px, .8fr); gap: 20px; }
.panel { padding: 18px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); }
.panel + .panel { margin-top: 16px; }
.panel-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.panel-title h3 { margin: 0; font-size: 14px; }
.panel-title span { color: var(--muted); font-size: 11px; }
.context-text { margin: 0; color: #33393e; font-size: 14px; line-height: 1.65; white-space: pre-wrap; }
.project-spotlight { display: grid; gap: 14px; }
.project-spotlight h3 { margin: 0; font-size: 20px; }
.project-spotlight p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.55; }
.tag-list { display: flex; flex-wrap: wrap; gap: 6px; }
.tag { display: inline-flex; align-items: center; min-height: 25px; padding: 0 8px; border-radius: 5px; background: #eef1f3; color: #4e565d; font-size: 11px; }
.link-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 0; border-top: 1px solid #eceeef; font-size: 13px; }
.link-row:first-child { border-top: 0; padding-top: 0; }
.link-row:last-child { padding-bottom: 0; }
.link-row > div { min-width: 0; }
.link-row strong { display: block; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.link-row small { color: var(--muted); }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.field { display: grid; gap: 6px; }
.field.full { grid-column: 1 / -1; }
.field label { color: #4f565d; font-size: 12px; font-weight: 650; }
.field input, .field textarea, .field select { width: 100%; border: 1px solid #ccd1d5; border-radius: 6px; color: #24282c; background: #fff; outline: none; }
.field input, .field select { height: 38px; padding: 0 10px; }
.field textarea { min-height: 112px; padding: 10px; line-height: 1.5; resize: vertical; }
.field input:focus, .field textarea:focus, .field select:focus { border-color: #5d7592; box-shadow: 0 0 0 3px rgba(57,91,128,.1); }
.field small { color: var(--muted); font-size: 11px; }
.form-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.preference-list, .memory-list { border-top: 1px solid var(--border); }
.preference-row, .memory-row { display: grid; grid-template-columns: 180px minmax(0, 1fr) auto; align-items: start; gap: 18px; padding: 13px 0; border-bottom: 1px solid var(--border); }
.preference-row strong, .memory-row strong { font-size: 12px; }
.preference-row > div:last-child { display: flex; gap: 6px; }
.preference-row code { overflow-wrap: anywhere; color: #3f464c; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.memory-row { grid-template-columns: 100px minmax(0, 1fr) auto; }
.memory-row p { margin: 0 0 7px; font-size: 13px; line-height: 1.5; white-space: pre-wrap; }
.memory-row small { display: block; margin-top: 8px; color: var(--muted); font-size: 10px; }
.scope { display: inline-flex; align-items: center; width: fit-content; min-height: 24px; padding: 0 7px; border-radius: 5px; background: #eaf0ff; color: #315aaf; font-size: 10px; font-weight: 700; text-transform: uppercase; }
.segmented { display: inline-flex; max-width: 100%; padding: 3px; overflow-x: auto; border: 1px solid var(--border); border-radius: 6px; background: #eef0f2; }
.segmented button { flex: 0 0 auto; min-height: 29px; padding: 0 10px; border: 0; border-radius: 4px; color: var(--muted); background: transparent; font-size: 12px; }
.segmented button.active { color: #22272b; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.07); }
.card-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.item-card { min-width: 0; padding: 17px; border: 1px solid var(--border); border-radius: 6px; background: #fff; }
.item-card.active { border-color: #8ab6a2; box-shadow: inset 3px 0 0 var(--green); }
.card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.card-head h3 { margin: 0; font-size: 15px; }
.card-head p { margin: 4px 0 0; color: var(--muted); font-size: 11px; }
.card-body { min-height: 66px; margin: 14px 0; color: #444b51; font-size: 13px; line-height: 1.55; }
.card-actions { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding-top: 13px; border-top: 1px solid #eceeef; }
.provider-buttons { display: flex; align-items: center; gap: 8px; }
.provider-card { position: relative; overflow: hidden; }
.provider-card.provider-google { --provider-accent: #4285f4; }
.provider-card.provider-github { --provider-accent: #24292f; }
.provider-card.provider-slack { --provider-accent: #36c5f0; }
.provider-line { position: absolute; inset: 0 auto 0 0; width: 3px; background: var(--provider-accent); }
.provider-heading { display: flex; gap: 11px; align-items: center; }
.provider-scopes { margin-top: 10px; }
.provider-icon { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 6px; color: #fff; background: var(--provider-accent); }
.provider-icon svg { width: 19px; height: 19px; }
.connection { margin-top: 14px; padding-top: 13px; border-top: 1px solid #e0e3e5; }
.connection-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.connection-head > div { min-width: 0; }
.connection-head strong { font-size: 12px; }
.connection-head small { display: block; margin-top: 3px; color: var(--muted); font-size: 10px; }
.connection-status { flex: 0 0 auto; font-size: 10px; font-weight: 700; }
.connection-status.connected { color: var(--green); }
.connection-status.expired { color: var(--amber); }
.connection-status.error { color: var(--red); }
.grant-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 9px; padding-top: 9px; border-top: 1px solid #e0e3e5; font-size: 11px; }
.grant-row span { color: var(--muted); }
.connection-scopes { display: grid; gap: 7px; margin-top: 10px; }
.connection-scopes > small { color: var(--muted); font-size: 10px; font-weight: 650; }
.handoff-policy { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 20px; padding: 14px 16px; border: 1px solid #cfd9e5; border-left: 3px solid #41658a; border-radius: 6px; background: #f4f7fa; }
.handoff-policy > svg { flex: 0 0 auto; width: 18px; height: 18px; margin-top: 1px; color: #315779; }
.handoff-policy strong { display: block; margin-bottom: 3px; font-size: 12px; }
.handoff-policy p { margin: 0; color: #58636d; font-size: 11px; line-height: 1.5; }
.handoff-project .card-body { min-height: 84px; }
.handoff-path { display: block; margin-top: 10px; padding: 8px 9px; overflow-wrap: anywhere; border-radius: 5px; color: #41484e; background: #f1f3f5; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; line-height: 1.45; }
.handoff-card-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 7px; }
.handoff-preview { display: grid; gap: 16px; }
.preview-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.preview-metric { min-width: 0; padding: 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-subtle); }
.preview-metric span { display: block; color: var(--muted); font-size: 9px; font-weight: 700; text-transform: uppercase; }
.preview-metric strong { display: block; margin-top: 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
.scan-result { padding: 12px; border: 1px solid var(--border); border-radius: 6px; }
.scan-result-head { display: flex; align-items: center; gap: 8px; }
.scan-result-head svg { width: 16px; height: 16px; }
.scan-result-head strong { font-size: 12px; }
.scan-result p { margin: 5px 0 0 24px; color: var(--muted); font-size: 11px; }
.scan-result.passed { color: #176b50; border-color: #b8d9ca; background: #f2faf6; }
.scan-result.blocked, .scan-result.error { color: #9b3030; border-color: #e3bcbc; background: #fff6f6; }
.scan-findings { margin-top: 11px; overflow-x: auto; }
.scan-findings table { background: #fff; }
.handoff-markdown { max-height: 280px; margin: 0; padding: 13px; overflow: auto; border: 1px solid var(--border); border-radius: 6px; color: #3e454b; background: #f7f8f9; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.handoff-warning { padding: 11px 12px; border: 1px solid #e6cfaa; border-radius: 6px; color: #795016; background: #fff9ef; font-size: 11px; line-height: 1.5; }
.empty { padding: 48px 20px; border: 1px dashed #ccd1d4; border-radius: 6px; text-align: center; background: rgba(255,255,255,.45); }
.empty svg { width: 24px; height: 24px; color: #7c858d; }
.empty h3 { margin: 12px 0 5px; font-size: 14px; }
.empty p { margin: 0; color: var(--muted); font-size: 12px; }
.table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 6px; background: #fff; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { padding: 13px 14px; border-bottom: 1px solid #e8eaec; text-align: left; white-space: nowrap; }
th { color: var(--muted); background: #f7f8f9; font-size: 10px; text-transform: uppercase; }
tr:last-child td { border-bottom: 0; }
.current-device { color: var(--green); font-size: 10px; font-weight: 700; }
.row-actions { display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
.task-status { display: inline-flex; min-height: 23px; align-items: center; padding: 0 7px; border-radius: 5px; font-size: 10px; font-weight: 700; white-space: nowrap; }
.task-todo { color: #4f5961; background: #edf0f2; }
.task-in_progress { color: #215fb1; background: #e8f1ff; }
.task-blocked { color: var(--red); background: #fff0f0; }
.task-done { color: var(--green); background: #e9f7f1; }
.modal-backdrop { position: fixed; inset: 0; z-index: 80; display: grid; place-items: center; padding: 20px; background: rgba(17,20,23,.48); }
.modal-backdrop[hidden] { display: none; }
.modal { width: min(560px, 100%); max-height: calc(100vh - 40px); overflow: auto; border-radius: 7px; background: #fff; box-shadow: 0 22px 70px rgba(0,0,0,.2); }
.modal.wide { width: min(860px, 100%); }
.modal > header { position: sticky; top: 0; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 15px 18px; border-bottom: 1px solid var(--border); background: #fff; z-index: 2; }
.modal h2 { margin: 0; font-size: 15px; }
#modal-content { padding: 18px; }
.check-list { display: grid; gap: 8px; }
.check-row { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 9px; align-items: start; padding: 10px; border: 1px solid var(--border); border-radius: 6px; }
.check-row input { margin: 2px 0 0; }
.check-row strong { display: block; font-size: 12px; }
.check-row small { color: var(--muted); font-size: 11px; }
.permission-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
.permission-toolbar > span { color: var(--muted); font-size: 11px; }
.permission-toolbar > div { display: flex; gap: 6px; }
.permission-toolbar .button { min-height: 30px; }
.callback { display: flex; gap: 7px; align-items: flex-start; padding: 9px 10px; border-radius: 5px; background: #f0f2f4; }
.callback code { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 10px; line-height: 1.5; }
.callback .icon-button { flex: 0 0 auto; width: 30px; height: 30px; }
.oauth-help { grid-column: 1 / -1; margin: 0; padding: 10px 11px; border-left: 3px solid #6f7f8d; color: #535c64; background: #f6f7f8; font-size: 11px; line-height: 1.55; }
.app-shell.onboarding { grid-template-columns: 1fr; }
.app-shell.onboarding .sidebar { display: none; }
.app-shell.onboarding .workspace { grid-column: 1; }
.onboarding-layout { width: min(820px, 100%); margin: 18px auto 0; }
.onboarding-head { display: grid; gap: 8px; margin-bottom: 22px; }
.onboarding-head h2 { margin: 0; font-size: 22px; }
.onboarding-head p { max-width: 620px; margin: 0; color: var(--muted); font-size: 13px; line-height: 1.6; }
.onboarding-form { padding: 20px; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); background: var(--surface); }
.onboarding-form .segmented { margin-bottom: 18px; }
.onboarding-security { display: flex; gap: 10px; margin-top: 16px; color: var(--muted); font-size: 11px; line-height: 1.55; }
.onboarding-security svg { flex: 0 0 auto; width: 17px; height: 17px; color: var(--green); }
.recovery-key { display: block; margin: 12px 0; padding: 12px; overflow-wrap: anywhere; border: 1px solid var(--border); border-radius: 6px; color: #28322e; background: #f0f7f4; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.6; }
.toast { position: fixed; right: 20px; bottom: 20px; z-index: 100; max-width: 360px; padding: 12px 14px; border: 1px solid #ced3d6; border-radius: 6px; color: #fff; background: #252a2e; box-shadow: 0 10px 30px rgba(0,0,0,.16); font-size: 12px; }
.toast.error { background: #9f3030; border-color: #9f3030; }
@media (max-width: 920px) {
  .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .layout-2 { grid-template-columns: 1fr; }
  .card-grid { grid-template-columns: 1fr; }
}
@media (max-width: 720px) {
  .app-shell { grid-template-columns: 1fr; }
  .sidebar { transform: translateX(-100%); transition: transform .18s ease; }
  .sidebar.open { transform: translateX(0); box-shadow: 12px 0 30px rgba(0,0,0,.2); }
  .workspace { grid-column: 1; }
  .mobile-menu { display: inline-grid; }
  .topbar { justify-content: flex-start; gap: 12px; padding: 10px 16px; }
  .topbar-actions { margin-left: auto; }
  .main { padding: 22px 16px 42px; }
  .form-grid { grid-template-columns: 1fr; }
  .metrics { grid-template-columns: 1fr 1fr; }
  .preference-row, .memory-row { grid-template-columns: 1fr auto; gap: 8px; }
  .preference-row > :first-child, .memory-row > :first-child { grid-column: 1; }
  .preview-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .provider-card .card-actions { flex-wrap: wrap; }
}
@media (max-width: 430px) {
  .metrics { grid-template-columns: 1fr; }
  .sync-state { display: none; }
  .section-header { align-items: flex-start; flex-direction: column; }
  .section-header .button { width: 100%; }
  .modal-backdrop { align-items: end; padding: 16px 0 0; }
  .modal { width: 100%; max-height: calc(100dvh - 16px); border-radius: 7px 7px 0 0; }
  .modal > header, #modal-content { padding-left: 16px; padding-right: 16px; }
  .provider-card .card-actions, .grant-row { align-items: stretch; flex-direction: column; }
  .provider-buttons { width: 100%; flex-direction: column; }
  .provider-card .card-actions .button, .grant-row .button { width: 100%; }
  .connection-head { align-items: flex-start; }
  .permission-toolbar { align-items: flex-start; flex-direction: column; }
  .form-actions { display: grid; grid-template-columns: 1fr 1fr; }
  .toast { right: 12px; bottom: 12px; left: 12px; max-width: none; }
}
`;

export const dashboardJs = `const __name=(target,value)=>Object.defineProperty(target,"name",{value,configurable:true});window.__ONE_STATUS_ICONS__=${JSON.stringify(iconMap)};(${dashboardClient.toString()})();`;

function dashboardClient(): void {
  type Snapshot = any;
  const icons = (window as unknown as { __ONE_STATUS_ICONS__: Record<string, string> })
    .__ONE_STATUS_ICONS__;
  const csrf = document
    .querySelector<HTMLMetaElement>('meta[name="one-status-csrf"]')!
    .content;
  const appShell = document.querySelector<HTMLElement>(".app-shell")!;
  const main = document.querySelector<HTMLElement>("#main")!;
  const title = document.querySelector<HTMLElement>("#page-title")!;
  const syncState = document.querySelector<HTMLElement>("#sync-state")!;
  const sidebar = document.querySelector<HTMLElement>("#sidebar")!;
  const gatewayAddress = document.querySelector<HTMLElement>("#gateway-address")!;
  const modalBackdrop = document.querySelector<HTMLElement>("#modal-backdrop")!;
  const modalTitle = document.querySelector<HTMLElement>("#modal-title")!;
  const modalContent = document.querySelector<HTMLElement>("#modal-content")!;
  const toastElement = document.querySelector<HTMLElement>("#toast")!;
  let snapshot: Snapshot;
  let inventory: any;
  let handoffs: any;
  let handoffPreview: any;
  let memoryFilter = "all";
  let onboarding: any;
  let onboardingMode: "login" | "register" = "register";
  let toastTimer: number | undefined;

  gatewayAddress.textContent = location.host;

  const routes: Record<string, { label: string; render: () => string }> = {
    "/": { label: "概览", render: renderOverview },
    "/status": { label: "状态", render: renderStatus },
    "/projects": { label: "项目", render: renderProjects },
    "/handoffs": { label: "Handoff", render: renderHandoffs },
    "/environment": { label: "Agents 与工具", render: renderEnvironment },
    "/memory": { label: "记忆", render: renderMemory },
    "/integrations": { label: "连接与权限", render: renderIntegrations },
    "/devices": { label: "设备", render: renderDevices },
    "/activity": { label: "活动", render: renderActivity },
    "/security": { label: "安全", render: renderSecurity },
  };

  document.querySelector("#refresh")?.addEventListener("click", () => load());
  document.querySelector("#mobile-menu")?.addEventListener("click", () =>
    sidebar.classList.toggle("open"),
  );
  document.querySelectorAll("[data-close-modal]").forEach((element) =>
    element.addEventListener("click", closeModal),
  );
  modalBackdrop.addEventListener("click", (event) => {
    if (event.target === modalBackdrop) closeModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!modalBackdrop.hidden) closeModal();
      sidebar.classList.remove("open");
    }
  });

  document.addEventListener("click", async (event) => {
    const closeTarget = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-close-modal]",
    );
    if (closeTarget) {
      closeModal();
      return;
    }
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    try {
      if (action === "set-onboarding-mode") {
        onboardingMode = target.dataset.mode === "login" ? "login" : "register";
        renderOnboarding();
        return;
      }
      if (action === "copy-value") {
        await copyToClipboard(target.dataset.value || "");
        toast("已复制");
        return;
      }
      if (action === "add-preference") return openPreferenceModal();
      if (action === "edit-preference") return openPreferenceModal(target.dataset.key);
      if (action === "delete-preference") {
        if (confirm("删除这项偏好？")) {
          await api(`/v1/dashboard/preferences/${encodeURIComponent(target.dataset.key || "")}`, { method: "DELETE" });
          await load(false);
          toast("偏好已删除");
        }
      }
      if (action === "add-project") return openProjectModal();
      if (action === "edit-project") return openProjectModal(target.dataset.id);
      if (action === "delete-project") {
        if (confirm("删除项目及其项目记忆和任务？")) {
          await api(`/v1/dashboard/projects/${encodeURIComponent(target.dataset.id || "")}`, { method: "DELETE" });
          await load(false);
          toast("项目已删除");
        }
      }
      if (action === "add-task") return openTaskModal();
      if (action === "edit-task") return openTaskModal(target.dataset.id);
      if (action === "delete-task") {
        if (confirm("删除这项任务？")) {
          await api(`/v1/dashboard/tasks/${encodeURIComponent(target.dataset.id || "")}`, { method: "DELETE" });
          await load(false);
          toast("任务已删除");
        }
      }
      if (action === "add-memory") return openMemoryModal();
      if (action === "edit-memory") return openMemoryModal(target.dataset.id);
      if (action === "confirm-memory") {
        await api(`/v1/dashboard/memories/${encodeURIComponent(target.dataset.id || "")}/confirm`, {
          method: "PUT",
          body: {},
        });
        await load(false);
        toast("候选记忆已确认");
      }
      if (action === "delete-memory") {
        if (confirm("删除这条记忆？")) {
          await api(`/v1/dashboard/memories/${target.dataset.id}`, { method: "DELETE" });
          await load(false);
          toast("记忆已删除");
        }
      }
      if (action === "filter-memory") {
        memoryFilter = target.dataset.scope || "all";
        renderRoute();
      }
      if (action === "refresh-inventory") {
        inventory = await api("/v1/dashboard/local-inventory/refresh", {
          method: "POST",
          body: {},
        });
        renderRoute();
        toast("本机环境清单已刷新");
      }
      if (action === "import-inventory-project") {
        return openInventoryProjectModal(Number(target.dataset.index));
      }
      if (action === "map-handoff-project") {
        return openHandoffMappingModal(target.dataset.id!);
      }
      if (action === "unmap-handoff-project") {
        if (confirm("移除这个项目的本机路径映射？本地文件不会被删除。")) {
          await api(`/v1/dashboard/local-project-mappings/${encodeURIComponent(target.dataset.id || "")}`, {
            method: "DELETE",
            body: {},
          });
          await load(false);
          toast("本机路径映射已移除");
        }
      }
      if (action === "preview-handoff") {
        await openHandoffPreview(target.dataset.id!);
        return;
      }
      if (action === "open-handoff") {
        openContinueModal(target.dataset.id!, target.dataset.agent as "codex" | "claude-code");
        return;
      }
      if (action === "configure-provider") return openProviderModal(target.dataset.provider!);
      if (action === "copy-callback") {
        await copyToClipboard(target.dataset.value || "");
        toast("Callback URL 已复制");
        return;
      }
      if (action === "set-grant-selection") {
        const form = target.closest<HTMLFormElement>('form[data-form="grant"]');
        if (!form) return;
        const checked = target.dataset.value === "all";
        form.querySelectorAll<HTMLInputElement>('input[name="actions"]').forEach((input) => {
          input.checked = checked;
        });
        updateGrantSummary(form);
        return;
      }
      if (action === "connect-provider") {
        return connectProvider(target.dataset.provider!, target as HTMLButtonElement);
      }
      if (action === "import-github-cli") {
        if (confirm("从本机 GitHub CLI 导入当前 OAuth 会话？凭据会加密保存到 Permission Vault，并随加密状态同步。")) {
          const button = target as HTMLButtonElement;
          const restore = setButtonBusy(button, "正在验证 gh");
          try {
            await api("/v1/dashboard/oauth/providers/github/import-cli", {
              method: "POST",
              body: {},
            });
            await load(false);
            toast("GitHub CLI 账号已导入");
          } finally {
            restore();
          }
        }
        return;
      }
      if (action === "disconnect-connection") {
        if (confirm("断开这个 OAuth 连接？")) {
          const button = target as HTMLButtonElement;
          const restore = setButtonBusy(button, "断开中");
          try {
            await api(`/v1/dashboard/oauth/connections/${target.dataset.id}`, { method: "DELETE" });
            await load(false);
            toast("连接已断开，Agent 权限已撤销");
          } finally {
            restore();
          }
        }
      }
      if (action === "edit-grant") {
        return openGrantModal(target.dataset.id!, target.dataset.agent!);
      }
      if (action === "revoke-device") {
        if (confirm("撤销该设备及其所有会话？")) {
          await api(`/v1/dashboard/devices/${target.dataset.id}`, { method: "DELETE" });
          await load(false);
          toast("设备已撤销");
        }
      }
    } catch (error) {
      toast(readError(error), true);
    }
  });

  document.addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement;
    if (input.name !== "actions") return;
    const form = input.closest<HTMLFormElement>('form[data-form="grant"]');
    if (form) updateGrantSummary(form);
  });

  document.addEventListener("submit", async (event) => {
    const form = event.target as HTMLFormElement;
    if (!form.matches("[data-form]")) return;
    event.preventDefault();
    const data = new FormData(form);
    setBusy(form, true);
    try {
      if (form.dataset.form === "onboarding-register") {
        const response = await api("/v1/dashboard/onboarding/register", {
          method: "POST",
          body: {
            deviceName: stringValue(data, "deviceName"),
            email: stringValue(data, "email"),
            password: stringValue(data, "password"),
            serverUrl: stringValue(data, "serverUrl"),
          },
        });
        await load(false);
        openModal("保存恢复密钥", `<p class="oauth-help">恢复密钥用于在新设备解密状态。服务器无法替你找回。</p><code class="recovery-key">${escapeHtml(response.statusKey)}</code><div class="form-actions"><button class="button secondary" data-action="copy-value" data-value="${escapeHtml(response.statusKey)}" type="button">${icon("copy")}复制</button><button class="button" data-close-modal type="button">${icon("check")}我已保存</button></div>`);
        return;
      }
      if (form.dataset.form === "onboarding-login") {
        await api("/v1/dashboard/onboarding/login", {
          method: "POST",
          body: {
            deviceName: stringValue(data, "deviceName"),
            email: stringValue(data, "email"),
            password: stringValue(data, "password"),
            serverUrl: stringValue(data, "serverUrl"),
            statusKey: stringValue(data, "statusKey"),
          },
        });
        await load(false);
        toast("设备已连接，加密状态已恢复");
        return;
      }
      if (form.dataset.form === "context") {
        await api("/v1/dashboard/context", {
          method: "PUT",
          body: {
            currentContext: stringValue(data, "currentContext"),
            activeProjectId: stringValue(data, "activeProjectId") || undefined,
          },
        });
        toast("当前上下文已保存");
      }
      if (form.dataset.form === "identity") {
        await api("/v1/dashboard/identity", {
          method: "PUT",
          body: {
            displayName: stringValue(data, "displayName") || undefined,
            locale: stringValue(data, "locale") || undefined,
            timezone: stringValue(data, "timezone") || undefined,
          },
        });
        toast("身份资料已保存");
      }
      if (form.dataset.form === "preference") {
        const key = stringValue(data, "key");
        await api(`/v1/dashboard/preferences/${encodeURIComponent(key)}`, {
          method: "PUT",
          body: { value: parsePreference(stringValue(data, "value")) },
        });
        closeModal();
        toast("偏好已保存");
      }
      if (form.dataset.form === "project") {
        const id = stringValue(data, "id");
        await api(`/v1/dashboard/projects/${encodeURIComponent(id)}`, {
          method: "PUT",
          body: {
            name: stringValue(data, "name"),
            summary: stringValue(data, "summary"),
            currentGoal: stringValue(data, "currentGoal"),
            techStack: csv(stringValue(data, "techStack")),
            decisions: lines(stringValue(data, "decisions")),
            makeActive: data.get("makeActive") === "on",
          },
        });
        closeModal();
        toast("项目已保存");
      }
      if (form.dataset.form === "task") {
        const id = stringValue(data, "id");
        await api(`/v1/dashboard/tasks/${encodeURIComponent(id)}`, {
          method: "PUT",
          body: {
            title: stringValue(data, "title"),
            projectId: stringValue(data, "projectId") || undefined,
            status: stringValue(data, "status"),
            completed: lines(stringValue(data, "completed")),
            next: lines(stringValue(data, "next")),
          },
        });
        closeModal();
        toast("任务已保存");
      }
      if (form.dataset.form === "memory") {
        const memoryId = stringValue(data, "id");
        await api(memoryId ? `/v1/dashboard/memories/${memoryId}` : "/v1/dashboard/memories", {
          method: memoryId ? "PUT" : "POST",
          body: {
            scope: stringValue(data, "scope"),
            projectId: stringValue(data, "projectId") || undefined,
            content: stringValue(data, "content"),
            tags: csv(stringValue(data, "tags")),
          },
        });
        closeModal();
        toast("记忆已保存");
      }
      if (form.dataset.form === "inventory-project") {
        const id = stringValue(data, "id");
        await api(`/v1/dashboard/projects/${encodeURIComponent(id)}`, {
          method: "PUT",
          body: {
            name: stringValue(data, "name"),
            summary: stringValue(data, "summary"),
            currentGoal: "",
            techStack: [],
            decisions: [],
            makeActive: data.get("makeActive") === "on",
          },
        });
        const gitProject = data.get("git") === "true";
        if (gitProject) {
          await api(`/v1/dashboard/local-project-mappings/${encodeURIComponent(id)}`, {
            method: "PUT",
            body: { path: stringValue(data, "path") },
          });
        } else {
          await api(`/v1/dashboard/local-project-paths/${encodeURIComponent(id)}`, {
            method: "PUT",
            body: { path: stringValue(data, "path") },
          });
        }
        closeModal();
        toast(gitProject ? "本机项目已注册并建立路径映射" : "本机项目已注册");
      }
      if (form.dataset.form === "handoff-mapping") {
        const projectId = stringValue(data, "projectId");
        await api(`/v1/dashboard/local-project-mappings/${encodeURIComponent(projectId)}`, {
          method: "PUT",
          body: { path: stringValue(data, "path") },
        });
        closeModal();
        toast("本机 Git 仓库已映射");
      }
      if (form.dataset.form === "handoff-publish") {
        if (data.get("confirmWrite") !== "on") {
          throw new Error("请先确认写入 Handoff 文件。");
        }
        if (data.get("confirmCommit") !== "on") {
          throw new Error("请先确认提交当前 Git 变更。");
        }
        if (data.get("confirmPush") !== "on") {
          throw new Error("请先确认推送 GitHub。");
        }
        const projectId = stringValue(data, "projectId");
        const result = await api(`/v1/dashboard/handoffs/${encodeURIComponent(projectId)}/publish`, {
          method: "POST",
          body: {
            expectedCommit: stringValue(data, "expectedCommit"),
            expectedStatusVersion: Number(stringValue(data, "expectedStatusVersion")),
            overwrite: data.get("overwrite") === "on",
            confirmCommit: true,
            confirmPush: true,
          },
        });
        handoffPreview = undefined;
        closeModal();
        toast(`Handoff ${result.repository.commit.slice(0, 12)} 已推送 GitHub`);
      }
      if (form.dataset.form === "handoff-open") {
        if (data.get("confirmCheckout") !== "on") {
          throw new Error("请先确认检出已发布的 Git commit。");
        }
        const projectId = stringValue(data, "projectId");
        const agentId = stringValue(data, "agentId");
        const result = await api(`/v1/dashboard/handoffs/${encodeURIComponent(projectId)}/open`, {
          method: "POST",
          body: {
            agentId,
            confirmCheckout: true,
            destinationPath: stringValue(data, "destinationPath") || undefined,
          },
        });
        closeModal();
        toast(`${agentLabel(agentId)} 已打开 commit ${result.commit.slice(0, 12)}`);
      }
      if (form.dataset.form === "provider") {
        const provider = stringValue(data, "provider");
        await api(`/v1/dashboard/oauth/providers/${provider}/config`, {
          method: "PUT",
          body: {
            clientId: stringValue(data, "clientId"),
            clientSecret: stringValue(data, "clientSecret") || undefined,
          },
        });
        closeModal();
        toast("OAuth App 配置已保存");
      }
      if (form.dataset.form === "grant") {
        const connectionId = stringValue(data, "connectionId");
        const agentId = stringValue(data, "agentId");
        await api(`/v1/dashboard/oauth/connections/${connectionId}/grants/${encodeURIComponent(agentId)}`, {
          method: "PUT",
          body: { actions: data.getAll("actions").map(String) },
        });
        closeModal();
        toast("Agent 权限已保存");
      }
      await load(false);
    } catch (error) {
      toast(readError(error), true);
    } finally {
      setBusy(form, false);
    }
  });

  async function load(showLoading = true): Promise<void> {
    if (showLoading) main.innerHTML = '<div class="loading"><span></span><p>正在读取加密状态</p></div>';
    syncState.className = "sync-state syncing";
    syncState.innerHTML = "<span></span>同步中";
    try {
      onboarding = await api("/v1/dashboard/onboarding");
      if (!onboarding.authenticated) {
        appShell.classList.add("onboarding");
        syncState.className = "sync-state";
        syncState.innerHTML = "<span></span>本机服务就绪";
        renderOnboarding();
        return;
      }
      appShell.classList.remove("onboarding");
      snapshot = await api("/v1/dashboard/snapshot");
      if (location.pathname === "/environment") {
        inventory = await api("/v1/dashboard/local-inventory");
      }
      if (location.pathname === "/handoffs") {
        [handoffs, inventory] = await Promise.all([
          api("/v1/dashboard/handoffs"),
          api("/v1/dashboard/local-inventory"),
        ]);
      }
      if (location.pathname === "/activity") {
        handoffs = await api("/v1/dashboard/handoffs");
      }
      syncState.className = "sync-state";
      syncState.innerHTML = "<span></span>版本 " + snapshot.version;
      renderRoute();
    } catch (error) {
      syncState.className = "sync-state error";
      syncState.innerHTML = "<span></span>读取失败";
      main.innerHTML = `<div class="empty">${icon("shield")}<h3>无法打开本地状态</h3><p>${escapeHtml(readError(error))}</p></div>`;
    }
  }

  function renderOnboarding(): void {
    title.textContent = onboardingMode === "register" ? "创建账号" : "连接设备";
    const serverUrl = onboarding.defaultServerUrl || "https://os.furesta.top";
    const deviceName = onboarding.deviceName || "Mac";
    const register = onboardingMode === "register";
    main.innerHTML = `<div class="onboarding-layout">
      <div class="onboarding-head"><h2>${register ? "创建 One Status 账号" : "恢复已有状态"}</h2><p>${register ? "注册首台设备，并生成只显示一次的恢复密钥。" : "使用账号密码和恢复密钥连接这台设备。"}</p></div>
      <section class="onboarding-form">
        <div class="segmented" role="group" aria-label="账号操作"><button class="${register ? "active" : ""}" data-action="set-onboarding-mode" data-mode="register" type="button">注册</button><button class="${register ? "" : "active"}" data-action="set-onboarding-mode" data-mode="login" type="button">登录已有账号</button></div>
        <form data-form="onboarding-${register ? "register" : "login"}"><div class="form-grid">
          ${field("同步服务器", "serverUrl", serverUrl, "url", "full", 'required autocomplete="url"')}
          ${field("邮箱", "email", "", "email", "", 'required autocomplete="email"')}
          ${field("设备名称", "deviceName", deviceName, "text", "", 'required autocomplete="off"')}
          ${field("账号密码", "password", "", "password", "full", `required minlength="10" autocomplete="${register ? "new-password" : "current-password"}"`)}
          ${register ? "" : field("恢复密钥", "statusKey", "", "password", "full", 'required autocomplete="off" placeholder="os1_…"')}
        </div><div class="form-actions"><button class="button" type="submit">${icon(register ? "key" : "cloud")}${register ? "创建账号" : "连接并解密"}</button></div></form>
      </section>
      <div class="onboarding-security">${icon("shield")}<span>密码仅用于登录；恢复密钥留在设备上。云端保存加密状态，OAuth 凭据在同步前会再次加密。</span></div>
    </div>`;
  }

  function renderRoute(): void {
    const route = routes[location.pathname] ?? routes["/"]!;
    title.textContent = route.label;
    document.querySelectorAll(".nav-link").forEach((link) =>
      link.classList.toggle("active", link.getAttribute("href") === location.pathname),
    );
    main.innerHTML = route.render();
    sidebar.classList.remove("open");
  }

  function renderOverview(): string {
    const activeId = snapshot.status.workspace.activeProjectId;
    const project = activeId ? snapshot.status.projects[activeId] : null;
    const connections = snapshot.integrations.connections;
    return `
      <div class="metrics">
        ${metric("projects", "项目", Object.keys(snapshot.status.projects).length, project ? "当前：" + project.name : "尚未选择")}
        ${metric("brain", "记忆", snapshot.status.memory.length, "跨 Agent 同步")}
        ${metric("integrations", "OAuth 连接", connections.length, connections.length ? "凭据已加密" : "等待连接")}
        ${metric("devices", "设备", snapshot.account.devices.length, snapshot.profile.deviceName)}
      </div>
      <div class="layout-2">
        <div>
          <section class="panel">
            <div class="panel-title"><h3>当前上下文</h3><span>Version ${snapshot.version}</span></div>
            <p class="context-text">${escapeHtml(snapshot.status.workspace.currentContext || "暂无上下文")}</p>
          </section>
          <section class="panel">
            <div class="panel-title"><h3>最近记忆</h3><span>${snapshot.status.memory.length} 条</span></div>
            ${snapshot.status.memory.slice(0, 4).map((entry: any) => `
              <div class="link-row"><div><strong>${escapeHtml(entry.content)}</strong><small>${scopeLabel(entry.scope)} · ${formatDate(entry.updatedAt)}</small></div>${icon("chevron")}</div>
            `).join("") || '<div class="empty"><p>暂无记忆</p></div>'}
          </section>
        </div>
        <div>
          <section class="panel project-spotlight">
            <div class="panel-title"><h3>活动项目</h3><span>${activeId ? "ACTIVE" : "EMPTY"}</span></div>
            ${project ? `<h3>${escapeHtml(project.name)}</h3><p>${escapeHtml(project.currentGoal || project.summary || "暂无目标")}</p><div class="tag-list">${project.techStack.map((tag: string) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>` : '<div class="empty"><p>尚未设置活动项目</p></div>'}
          </section>
          <section class="panel">
            <div class="panel-title"><h3>连接状态</h3><span>${connections.length} CONNECTED</span></div>
            ${connections.map((connection: any) => `<div class="link-row"><div><strong>${escapeHtml(connection.label)}</strong><small>${providerLabel(connection.provider)}</small></div><span class="scope">已连接</span></div>`).join("") || '<div class="empty"><p>尚未连接第三方服务</p></div>'}
          </section>
        </div>
      </div>`;
  }

  function renderStatus(): string {
    const identity = snapshot.status.identity;
    return `
      ${sectionHeader("身份与偏好", `Version ${snapshot.version} · 加密同步`)}
      <section class="panel">
        <div class="panel-title"><h3>身份</h3><span>加密同步</span></div>
        <form data-form="identity"><div class="form-grid">
          ${field("显示名称", "displayName", identity.displayName || "")}
          ${field("语言", "locale", identity.locale || navigator.language)}
          ${field("时区", "timezone", identity.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone, "text", "full")}
        </div><div class="form-actions"><button class="button" type="submit">${icon("save")}保存身份</button></div></form>
      </section>
      <section class="panel">
        <div class="panel-title"><h3>当前上下文</h3><span>Agent handoff</span></div>
        <form data-form="context"><div class="form-grid">
          <div class="field full"><label for="currentContext">上下文</label><textarea id="currentContext" name="currentContext">${escapeHtml(snapshot.status.workspace.currentContext || "")}</textarea></div>
          <div class="field full"><label for="activeProjectId">活动项目</label><select id="activeProjectId" name="activeProjectId"><option value="">未选择</option>${Object.values(snapshot.status.projects).map((project: any) => `<option value="${escapeHtml(project.id)}" ${project.id === snapshot.status.workspace.activeProjectId ? "selected" : ""}>${escapeHtml(project.name)}</option>`).join("")}</select></div>
        </div><div class="form-actions"><button class="button" type="submit">${icon("save")}保存上下文</button></div></form>
      </section>
      <section class="panel">
        <div class="panel-title"><h3>偏好</h3><button class="button secondary" data-action="add-preference" type="button">${icon("plus")}添加</button></div>
        <div class="preference-list">${Object.entries(snapshot.status.preferences).map(([key, value]) => `<div class="preference-row"><strong>${escapeHtml(key)}</strong><code>${escapeHtml(formatValue(value))}</code><div><button class="button secondary" data-action="edit-preference" data-key="${escapeHtml(key)}" type="button">编辑</button> <button class="icon-button" data-action="delete-preference" data-key="${escapeHtml(key)}" type="button" title="删除">${icon("trash")}</button></div></div>`).join("") || '<div class="empty"><p>暂无偏好</p></div>'}</div>
      </section>`;
  }

  function renderProjects(): string {
    const projects = Object.values(snapshot.status.projects) as any[];
    const tasks = Object.values(snapshot.status.tasks) as any[];
    return `
      ${sectionHeader("项目", `${projects.length} 个项目 · ${snapshot.status.workspace.activeProjectId ? "已设置活动项目" : "无活动项目"}`, `<button class="button" data-action="add-project" type="button">${icon("plus")}新建项目</button>`)}
      ${projects.length ? `<div class="card-grid">${projects.map((project) => `
        <article class="item-card ${project.id === snapshot.status.workspace.activeProjectId ? "active" : ""}">
          <div class="card-head"><div><h3>${escapeHtml(project.name)}</h3><p>${escapeHtml(project.id)}</p></div>${project.id === snapshot.status.workspace.activeProjectId ? '<span class="scope">活动</span>' : ""}</div>
          <div class="card-body">${escapeHtml(project.currentGoal || project.summary || "暂无目标")}</div>
          <div class="tag-list">${project.techStack.map((tag: string) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>
          <div class="card-actions"><small>${formatDate(project.updatedAt)}</small><div><button class="button secondary" data-action="edit-project" data-id="${escapeHtml(project.id)}" type="button">编辑</button> <button class="icon-button" data-action="delete-project" data-id="${escapeHtml(project.id)}" type="button" title="删除">${icon("trash")}</button></div></div>
        </article>`).join("")}</div>` : emptyState("projects", "暂无项目", "当前项目列表为空")}
      <section class="panel" style="margin-top:20px">
        <div class="panel-title"><h3>任务状态</h3><button class="button secondary" data-action="add-task" type="button">${icon("plus")}添加任务</button></div>
        ${tasks.length ? `<div class="table-wrap"><table><thead><tr><th>任务</th><th>项目</th><th>状态</th><th>下一步</th><th>更新时间</th><th></th></tr></thead><tbody>${tasks.map((task) => {
          const project = task.projectId ? snapshot.status.projects[task.projectId] : null;
          return `<tr><td><strong>${escapeHtml(task.title)}</strong><br><small>${escapeHtml(task.id)}</small></td><td>${escapeHtml(project?.name || "—")}</td><td><span class="task-status task-${escapeHtml(task.status)}">${taskStatusLabel(task.status)}</span></td><td>${escapeHtml(task.next?.[0] || "—")}</td><td>${formatDate(task.updatedAt)}</td><td><div class="row-actions"><button class="button secondary" data-action="edit-task" data-id="${escapeHtml(task.id)}" type="button">编辑</button><button class="icon-button" data-action="delete-task" data-id="${escapeHtml(task.id)}" type="button" title="删除">${icon("trash")}</button></div></td></tr>`;
        }).join("")}</tbody></table></div>` : '<div class="empty"><p>暂无任务状态</p></div>'}
      </section>`;
  }

  function renderHandoffs(): string {
    if (!handoffs) return emptyState("cloud", "正在读取 Handoff 状态", "");
    const projects = handoffs.projects || [];
    const mappings = handoffs.mappings || [];
    const activity = handoffs.activity || [];
    const mappingByProject = new Map(mappings.map((mapping: any) => [mapping.projectId, mapping]));
    const installedAgents = new Set((inventory?.agents || []).filter((agent: any) => agent.installed).map((agent: any) => agent.id));
    const publishedCount = projects.filter((project: any) => project.handoff).length;
    const openedCount = activity.filter((entry: any) => entry.type === "handoff_opened").length;
    return `
      ${sectionHeader("跨设备 Handoff", `${mappings.length}/${projects.length} 个项目已映射本机 Git 仓库`)}
      <div class="handoff-policy">${icon("shield")}<div><strong>发布操作由用户确认</strong><p>程序采集 Git 状态并扫描 Secret；只有勾选提交与推送确认后，才会发布精确 commit。</p></div></div>
      <div class="metrics">
        ${metric("projects", "Portable 项目", projects.length, "来自加密 Status")}
        ${metric("database", "本机映射", mappings.length, "每台设备独立保存")}
        ${metric("cloud", "Handoff ready", publishedCount, "精确 Git commit")}
        ${metric("activity", "Open and Continue", openedCount, "Codex / Claude Code")}
      </div>
      ${projects.length ? `<div class="card-grid">${projects.map((project: any) => {
        const mapping = mappingByProject.get(project.id) as any;
        const handoff = project.handoff;
        const codexDisabled = installedAgents.has("codex") ? "" : "disabled";
        const claudeDisabled = installedAgents.has("claude-code") ? "" : "disabled";
        return `<article class="item-card handoff-project ${mapping ? "active" : ""}">
          <div class="card-head"><div><h3>${escapeHtml(project.name)}</h3><p>${escapeHtml(project.id)}</p></div><span class="scope">${handoff ? "Handoff ready" : mapping ? "已映射" : "待映射"}</span></div>
          <div class="card-body">${escapeHtml(project.goal || "暂无当前目标")}${mapping ? `<code class="handoff-path">${escapeHtml(mapping.repoRoot)}</code>` : '<code class="handoff-path">尚未选择本机 Git 仓库</code>'}${handoff ? `<code class="handoff-path">${escapeHtml(handoff.branch)} @ ${escapeHtml(handoff.commit.slice(0, 12))}</code>` : ""}</div>
          <div class="card-actions"><small>${handoff ? `发布于 ${formatDate(handoff.publishedAt)}` : mapping ? `更新于 ${formatDate(mapping.updatedAt)}` : "路径不会同步到云端"}</small><div class="handoff-card-actions"><button class="button secondary" data-action="map-handoff-project" data-id="${escapeHtml(project.id)}" type="button">${mapping ? "更改映射" : "选择仓库"}</button>${mapping ? `<button class="button" data-action="preview-handoff" data-id="${escapeHtml(project.id)}" type="button">${icon("cloud")}发布 Handoff</button><button class="icon-button" data-action="unmap-handoff-project" data-id="${escapeHtml(project.id)}" type="button" title="移除映射">${icon("trash")}</button>` : ""}${handoff ? `<button class="button secondary" data-action="open-handoff" data-agent="codex" data-id="${escapeHtml(project.id)}" type="button" ${codexDisabled}>${icon("chevron")}Codex</button><button class="button secondary" data-action="open-handoff" data-agent="claude-code" data-id="${escapeHtml(project.id)}" type="button" ${claudeDisabled}>Claude Code</button>` : ""}</div></div>
        </article>`;
      }).join("")}</div>` : emptyState("projects", "暂无 Portable 项目", "先在项目页面创建项目，再建立本机路径映射")}
      <section class="panel" style="margin-top:20px">
        <div class="panel-title"><h3>最近活动</h3><span>${activity.length} 条本机记录</span></div>
        ${activity.length ? `<div class="table-wrap"><table><thead><tr><th>操作</th><th>项目</th><th>时间</th></tr></thead><tbody>${activity.slice(0, 20).map((entry: any) => {
          const project = projects.find((candidate: any) => candidate.id === entry.projectId);
          return `<tr><td><strong>${handoffActivityLabel(entry.type)}</strong></td><td>${escapeHtml(project?.name || entry.projectId || "—")}</td><td>${formatDate(entry.createdAt)}</td></tr>`;
        }).join("")}</tbody></table></div>` : '<div class="empty"><p>还没有 Handoff 活动</p></div>'}
      </section>`;
  }

  function renderEnvironment(): string {
    if (!inventory) return emptyState("settings", "正在读取本机环境", "");
    const installedAgents = inventory.agents.filter((agent: any) => agent.installed);
    return `
      ${sectionHeader("Agents 与工具", `扫描于 ${formatDate(inventory.scannedAt)}`, `<button class="button secondary" data-action="refresh-inventory" type="button">${icon("refresh")}重新扫描</button>`)}
      <div class="metrics">
        ${metric("settings", "Agent", installedAgents.length, `${inventory.agents.length} 个已识别`) }
        ${metric("integrations", "MCP", inventory.mcpServers.length, "仅显示脱敏元数据")}
        ${metric("brain", "Skills", inventory.skills.length, `${inventory.plugins.length} 个 Plugin`) }
        ${metric("projects", "本机项目", inventory.projects.length, `${inventory.rules.length} 个 Rules`) }
      </div>
      <section class="panel">
        <div class="panel-title"><h3>Agent</h3><span>${installedAgents.length} 个可用</span></div>
        <div class="table-wrap"><table><thead><tr><th>名称</th><th>状态</th><th>版本</th><th>可执行文件</th></tr></thead><tbody>${inventory.agents.map((agent: any) => `<tr><td><strong>${escapeHtml(agent.name)}</strong></td><td>${agent.installed ? '<span class="current-device">已安装</span>' : "未检测到"}</td><td>${escapeHtml(agent.version || "—")}</td><td><code>${escapeHtml(agent.path || "—")}</code></td></tr>`).join("")}</tbody></table></div>
      </section>
      <section class="panel">
        <div class="panel-title"><h3>MCP</h3><span>${inventory.mcpServers.length} 个配置</span></div>
        ${inventory.mcpServers.length ? `<div class="table-wrap"><table><thead><tr><th>名称</th><th>Agent</th><th>传输</th><th>状态</th><th>环境变量</th></tr></thead><tbody>${inventory.mcpServers.map((server: any) => `<tr><td><strong>${escapeHtml(server.name)}</strong><br><small>${escapeHtml(server.endpoint || server.command || "")}</small></td><td>${escapeHtml(server.agent)}</td><td>${escapeHtml(server.transport)}</td><td>${server.enabled ? "启用" : "停用"}</td><td><div class="tag-list">${server.envNames.map((name: string) => `<span class="tag">${escapeHtml(name)}</span>`).join("") || "—"}</div></td></tr>`).join("")}</tbody></table></div>` : emptyState("integrations", "未检测到 MCP", "")}
      </section>
      <section class="panel">
        <div class="panel-title"><h3>Skills 与 Plugins</h3><span>${inventory.skills.length + inventory.plugins.length} 项</span></div>
        <div class="table-wrap"><table><thead><tr><th>名称</th><th>类型</th><th>Agent</th><th>状态</th></tr></thead><tbody>${[...inventory.skills.map((skill: any) => ({...skill, kind: "Skill", state: skill.description || "已发现"})), ...inventory.plugins.map((plugin: any) => ({...plugin, kind: "Plugin", state: plugin.enabled ? plugin.version || "启用" : "停用"}))].map((asset: any) => `<tr><td><strong>${escapeHtml(asset.name)}</strong></td><td>${asset.kind}</td><td>${escapeHtml(asset.agent)}</td><td>${escapeHtml(asset.state)}</td></tr>`).join("") || '<tr><td colspan="4">暂无资产</td></tr>'}</tbody></table></div>
      </section>
      <section class="panel">
        <div class="panel-title"><h3>本机项目与 Rules</h3><span>${inventory.projects.length} 个项目</span></div>
        <div class="table-wrap"><table><thead><tr><th>项目</th><th>Git</th><th>Agent</th><th>标记</th><th></th></tr></thead><tbody>${inventory.projects.map((project: any, index: number) => {
          const registered = Boolean(snapshot.status.projects[project.id]);
          return `<tr><td><strong>${escapeHtml(project.name)}</strong><br><small>${escapeHtml(project.path)}</small></td><td>${project.git ? escapeHtml(project.branch || "Git") : "Local only"}</td><td>${escapeHtml(project.agents.join(", ") || "—")}</td><td><div class="tag-list">${project.markers.map((marker: string) => `<span class="tag">${escapeHtml(marker)}</span>`).join("") || "—"}</div></td><td>${registered ? '<span class="current-device">已注册</span>' : `<button class="button secondary" data-action="import-inventory-project" data-index="${index}" type="button">导入</button>`}</td></tr>`;
        }).join("") || '<tr><td colspan="5">暂无项目</td></tr>'}</tbody></table></div>
        ${inventory.rules.length ? `<div class="tag-list" style="margin-top:12px">${inventory.rules.map((rule: any) => `<span class="tag">${escapeHtml(rule.type)} · ${escapeHtml(rule.agent)}</span>`).join("")}</div>` : ""}
      </section>
      ${inventory.warnings.length ? `<section class="panel"><div class="panel-title"><h3>扫描提示</h3><span>${inventory.warnings.length}</span></div>${inventory.warnings.map((warning: string) => `<p>${escapeHtml(warning)}</p>`).join("")}</section>` : ""}`;
  }

  function renderMemory(): string {
    const candidates = snapshot.status.memory.filter((entry: any) => entry.state === "candidate");
    const memories = snapshot.status.memory.filter((entry: any) =>
      memoryFilter === "all"
        ? true
        : memoryFilter === "candidate"
          ? entry.state === "candidate"
          : entry.scope === memoryFilter,
    );
    return `
      ${sectionHeader("记忆", `${snapshot.status.memory.length} 条加密记录 · ${candidates.length} 条待确认`, `<button class="button" data-action="add-memory" type="button">${icon("plus")}添加记忆</button>`)}
      <div class="section-header"><div class="segmented">${["all", "candidate", "user", "project", "session"].map((scope) => `<button class="${memoryFilter === scope ? "active" : ""}" data-action="filter-memory" data-scope="${scope}" type="button">${scope === "all" ? "全部" : scope === "candidate" ? `待确认 ${candidates.length}` : scopeLabel(scope)}</button>`).join("")}</div><p>${memories.length} 条</p></div>
      ${memories.length ? `<div class="memory-list">${memories.map((entry: any) => `<div class="memory-row"><div><span class="scope">${scopeLabel(entry.scope)}</span>${entry.state === "candidate" ? '<span class="task-status task-in_progress" style="margin-top:6px">待确认</span>' : ""}</div><div><p>${escapeHtml(entry.content)}</p><div class="tag-list">${entry.tags.map((tag: string) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div><small>${escapeHtml(memoryOriginLabel(entry))} · ${formatDate(entry.updatedAt)}</small></div><div class="row-actions">${entry.state === "candidate" ? `<button class="button" data-action="confirm-memory" data-id="${escapeHtml(entry.id)}" type="button">${icon("check")}确认</button>` : ""}<button class="button secondary" data-action="edit-memory" data-id="${escapeHtml(entry.id)}" type="button">编辑</button><button class="icon-button" data-action="delete-memory" data-id="${escapeHtml(entry.id)}" type="button" title="删除">${icon("trash")}</button></div></div>`).join("")}</div>` : emptyState("brain", "当前筛选下没有记忆", "当前记忆列表为空")}`;
  }

  function renderIntegrations(): string {
    const integrations = snapshot.integrations;
    return `
      ${sectionHeader("连接与权限", `${integrations.connections.length} 个连接 · ${integrations.grants.length} 条 Agent 授权`)}
      <div class="card-grid">${integrations.providers.map((provider: any) => {
        const connections = integrations.connections.filter((connection: any) => connection.provider === provider.id);
        const cliImport = provider.id === "github"
          ? `<button class="button secondary" data-action="import-github-cli" type="button">${icon("terminal")}从 gh 导入</button>`
          : "";
        return `<article class="item-card provider-card provider-${provider.id}"><span class="provider-line"></span>
          <div class="card-head"><div class="provider-heading"><span class="provider-icon">${providerIcon(provider.id)}</span><div><h3>${escapeHtml(provider.label)}</h3><p>${connections.length ? `${connections.length} 个账号已连接` : provider.configured ? "OAuth App 已配置" : provider.id === "github" ? "可配置 OAuth App 或导入 gh" : "需要配置 OAuth App"}</p></div></div><button class="icon-button" data-action="configure-provider" data-provider="${provider.id}" type="button" title="配置">${icon("settings")}</button></div>
          <div class="card-body">${escapeHtml(provider.description)}<div class="tag-list provider-scopes">${provider.scopes.map((scope: string) => `<span class="tag">${escapeHtml(shortScope(scope))}</span>`).join("")}</div></div>
          ${connections.map((connection: any) => renderConnection(connection, provider)).join("")}
          <div class="card-actions"><small>${connections.length ? connections.length + " 个账号" : provider.configured ? "可以开始账号授权" : provider.id === "github" ? "gh 登录可直接导入" : "先完成 App 配置"}</small><div class="provider-buttons">${cliImport}<button class="button ${provider.configured ? "" : "secondary"}" data-action="connect-provider" data-provider="${provider.id}" type="button" ${provider.configured ? "" : "disabled"}>${icon("key")}${connections.length ? "连接其他账号" : "连接账号"}</button></div></div>
        </article>`;
      }).join("")}</div>`;
  }

  function renderConnection(connection: any, provider: any): string {
    const agents = ["codex", "claude-code"];
    const status = connectionDisplayStatus(connection);
    const source = connection.source === "imported" ? " · GitHub CLI 导入" : "";
    return `<div class="connection"><div class="connection-head"><div><strong>${escapeHtml(connection.label)}</strong><small>更新于 ${formatDate(connection.updatedAt)}${source}</small></div><span class="connection-status ${status.key}">${status.label}</span></div><div class="connection-scopes"><small>账号授权范围</small><div class="tag-list">${connection.scopes.map((scope: string) => `<span class="tag">${escapeHtml(shortScope(scope))}</span>`).join("") || '<span class="tag">未返回 scope</span>'}</div></div>${agents.map((agent) => {
      const grant = snapshot.integrations.grants.find((entry: any) => entry.connectionId === connection.id && entry.agentId === agent);
      const count = grant?.actions.length || 0;
      return `<div class="grant-row"><span>${agentLabel(agent)} · ${count ? `允许 ${count}/${provider.actions.length} 项操作` : "尚未授权操作"}</span><button class="button secondary" data-action="edit-grant" data-id="${connection.id}" data-agent="${agent}" type="button">${icon("shield")}权限</button></div>`;
    }).join("")}<div class="grant-row"><span>断开后，该账号的所有 Agent 授权会一并删除</span><button class="button danger" data-action="disconnect-connection" data-id="${connection.id}" type="button">断开</button></div></div>`;
  }

  function renderDevices(): string {
    return `
      ${sectionHeader("设备", `${snapshot.account.devices.length} 台已注册设备`)}
      <div class="table-wrap"><table><thead><tr><th>设备</th><th>创建时间</th><th>最近活动</th><th>状态</th><th></th></tr></thead><tbody>${snapshot.account.devices.map((device: any) => `<tr><td><strong>${escapeHtml(device.name)}</strong></td><td>${formatDate(device.createdAt)}</td><td>${formatDate(device.lastSeenAt)}</td><td>${device.id === snapshot.profile.deviceId ? '<span class="current-device">当前设备</span>' : device.online ? '<span class="current-device">在线</span>' : "离线"}</td><td>${device.id === snapshot.profile.deviceId ? "" : `<button class="button danger" data-action="revoke-device" data-id="${device.id}" type="button">撤销</button>`}</td></tr>`).join("")}</tbody></table></div>`;
  }

  function renderActivity(): string {
    const auditEvents = snapshot.integrations.auditEvents || [];
    const localEvents = handoffs?.activity || [];
    const connections = new Map(
      snapshot.integrations.connections.map((connection: any) => [connection.id, connection]),
    );
    const events = [
      ...auditEvents.map((entry: any) => ({ ...entry, kind: "tool" })),
      ...localEvents.map((entry: any) => ({ ...entry, kind: "handoff" })),
    ].sort((left: any, right: any) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
    const successful = auditEvents.filter((entry: any) => entry.outcome === "success").length;
    const blocked = auditEvents.filter((entry: any) => entry.outcome === "blocked").length;
    return `
      ${sectionHeader("活动", `${events.length} 条本机脱敏记录`)}
      <div class="metrics">
        ${metric("activity", "工具调用", auditEvents.length, "不记录 OAuth Token")}
        ${metric("check", "调用成功", successful, "Provider 已响应")}
        ${metric("shield", "权限拦截", blocked, "Agent Permission Firewall")}
        ${metric("cloud", "Handoff", localEvents.length, "当前设备记录")}
      </div>
      ${events.length ? `<div class="table-wrap"><table><thead><tr><th>时间</th><th>来源</th><th>操作</th><th>目标</th><th>结果</th><th>耗时</th></tr></thead><tbody>${events.map((entry: any) => {
        if (entry.kind === "handoff") {
          return `<tr><td>${formatDate(entry.createdAt)}</td><td>本机 Handoff</td><td><strong>${handoffActivityLabel(entry.type)}</strong></td><td>${escapeHtml(entry.projectId || "—")}</td><td><span class="task-status task-done">完成</span></td><td>—</td></tr>`;
        }
        const connection = connections.get(entry.connectionId) as any;
        return `<tr><td>${formatDate(entry.createdAt)}</td><td>${escapeHtml(agentLabel(entry.agentId))}</td><td><strong>${escapeHtml(entry.action)}</strong></td><td>${escapeHtml(connection?.label || providerLabel(connection?.provider || ""))}</td><td><span class="task-status ${auditOutcomeClass(entry.outcome)}">${auditOutcomeLabel(entry.outcome)}</span></td><td>${entry.durationMs === undefined ? "—" : `${escapeHtml(String(entry.durationMs))} ms`}</td></tr>`;
      }).join("")}</tbody></table></div>` : emptyState("activity", "暂无活动", "Agent 工具调用与 Handoff 记录会显示在这里")}`;
  }

  function renderSecurity(): string {
    const vault = snapshot.status.permissions.vault;
    const configuredProviders = snapshot.integrations.providers.filter((provider: any) => provider.configured);
    const onlineDevices = snapshot.account.devices.filter((device: any) => device.online).length;
    const grants = snapshot.integrations.grants;
    const connectionById = new Map(
      snapshot.integrations.connections.map((connection: any) => [connection.id, connection]),
    );
    return `
      ${sectionHeader("安全", "密钥、设备、连接和 Agent 权限的当前状态")}
      <div class="metrics">
        ${metric("shield", "Status 加密", "AES-256-GCM", `Version ${snapshot.version}`)}
        ${metric("key", "Permission Vault", vault ? "已封装" : "仅本机", vault?.algorithm || "等待首次连接")}
        ${metric("devices", "在线设备", onlineDevices, `${snapshot.account.devices.length} 台已注册`)}
        ${metric("integrations", "Agent 授权", grants.length, `${snapshot.integrations.connections.length} 个连接`)}
      </div>
      <div class="layout-2">
        <section class="panel">
          <div class="panel-title"><h3>加密与同步</h3><span>PRIVATE BY DESIGN</span></div>
          <div class="link-row"><div><strong>同步服务器</strong><small>${escapeHtml(snapshot.profile.baseUrl)}</small></div><span class="current-device">HTTPS</span></div>
          <div class="link-row"><div><strong>Status Envelope</strong><small>明文只在当前设备解密</small></div><span class="scope">AES-256-GCM</span></div>
          <div class="link-row"><div><strong>Permission Vault Bundle</strong><small>${vault ? `更新于 ${formatDate(vault.updatedAt)}` : "连接 OAuth 后生成"}</small></div><span class="scope">${vault ? "二次加密" : "LOCAL"}</span></div>
          <div class="link-row"><div><strong>设备会话</strong><small>到期时间 ${formatDate(snapshot.profile.tokenExpiresAt)}</small></div><span class="current-device">当前设备</span></div>
        </section>
        <section class="panel">
          <div class="panel-title"><h3>安全边界</h3><span>${configuredProviders.length}/3 PROVIDERS</span></div>
          <div class="link-row"><div><strong>恢复密钥</strong><small>不会进入 Dashboard response 或云端明文</small></div>${icon("key")}</div>
          <div class="link-row"><div><strong>OAuth Token</strong><small>Agent 只能调用已授权动作</small></div>${icon("shield")}</div>
          <div class="link-row"><div><strong>本机绝对路径</strong><small>保存在设备本地 workspace 数据库</small></div>${icon("database")}</div>
          <div class="link-row"><div><strong>原始会话记录</strong><small>默认留在 Agent 本机目录</small></div>${icon("terminal")}</div>
        </section>
      </div>
      <section class="panel" style="margin-top:20px">
        <div class="panel-title"><h3>Agent Permission Firewall</h3><span>${grants.length} 条授权</span></div>
        ${grants.length ? `<div class="table-wrap"><table><thead><tr><th>Agent</th><th>服务账号</th><th>Provider</th><th>允许动作</th><th>更新时间</th></tr></thead><tbody>${grants.map((grant: any) => {
          const connection = connectionById.get(grant.connectionId) as any;
          return `<tr><td><strong>${escapeHtml(agentLabel(grant.agentId))}</strong></td><td>${escapeHtml(connection?.label || "已断开")}</td><td>${escapeHtml(providerLabel(connection?.provider || ""))}</td><td><div class="tag-list">${grant.actions.map((action: string) => `<span class="tag">${escapeHtml(action)}</span>`).join("")}</div></td><td>${formatDate(grant.updatedAt)}</td></tr>`;
        }).join("")}</tbody></table></div>` : '<div class="empty"><p>尚未向 Agent 开放第三方动作</p></div>'}
      </section>`;
  }

  function openPreferenceModal(key?: string): void {
    const value = key ? snapshot.status.preferences[key] : "";
    openModal(key ? "编辑偏好" : "添加偏好", `<form data-form="preference"><div class="form-grid">${field("键", "key", key || "", "text", "full", key ? "readonly" : "")}${field("值", "value", formatValue(value), "text", "full")}</div>${modalActions()}</form>`);
  }

  function openProjectModal(id?: string): void {
    const project = id ? snapshot.status.projects[id] : null;
    openModal(project ? "编辑项目" : "新建项目", `<form data-form="project"><div class="form-grid">${field("项目 ID", "id", project?.id || "", "text", "full", project ? "readonly" : "")}${field("名称", "name", project?.name || "")}${field("技术栈", "techStack", project?.techStack?.join(", ") || "")}${textareaField("摘要", "summary", project?.summary || "")}${textareaField("当前目标", "currentGoal", project?.currentGoal || "")}${textareaField("架构决策（每行一项）", "decisions", project?.decisions?.join("\n") || "")}<label class="check-row full"><input type="checkbox" name="makeActive" ${project?.id === snapshot.status.workspace.activeProjectId ? "checked" : ""}><span><strong>设为活动项目</strong><small>新会话恢复时优先加载</small></span></label></div>${modalActions()}</form>`);
  }

  function openTaskModal(id?: string): void {
    const task = id ? snapshot.status.tasks[id] : null;
    openModal(task ? "编辑任务" : "添加任务", `<form data-form="task"><div class="form-grid">
      ${field("任务 ID", "id", task?.id || "", "text", "full", `${task ? "readonly" : ""} required`)}
      ${field("标题", "title", task?.title || "", "text", "full", "required")}
      <div class="field"><label for="projectId">项目</label><select id="projectId" name="projectId"><option value="">无</option>${Object.values(snapshot.status.projects).map((project: any) => `<option value="${escapeHtml(project.id)}" ${project.id === task?.projectId ? "selected" : ""}>${escapeHtml(project.name)}</option>`).join("")}</select></div>
      <div class="field"><label for="status">状态</label><select id="status" name="status">${["todo", "in_progress", "blocked", "done"].map((status) => `<option value="${status}" ${status === (task?.status || "todo") ? "selected" : ""}>${taskStatusLabel(status)}</option>`).join("")}</select></div>
      ${textareaField("已完成（每行一项）", "completed", task?.completed?.join("\n") || "")}
      ${textareaField("下一步（每行一项）", "next", task?.next?.join("\n") || "")}
    </div>${modalActions()}</form>`);
  }

  function openInventoryProjectModal(index: number): void {
    const project = inventory?.projects?.[index];
    if (!project) throw new Error("本机项目已变化，请重新扫描。");
    const summary = project.git
      ? "从本机 Git 仓库确认导入。"
      : "从本机 Workspace 确认导入。";
    openModal("导入本机项目", `<form data-form="inventory-project"><input type="hidden" name="path" value="${escapeHtml(project.path)}"><input type="hidden" name="git" value="${project.git ? "true" : "false"}"><div class="form-grid">
      ${field("项目 ID", "id", project.id, "text", "full", 'required pattern="[a-zA-Z0-9._-]+"')}
      ${field("名称", "name", project.name, "text", "full", "required")}
      ${textareaField("摘要", "summary", summary)}
      <div class="field full"><label>本机路径</label><code class="handoff-path">${escapeHtml(project.path)}</code><small>该绝对路径只写入当前设备的 workspace 数据库。</small></div>
      <div class="field full"><label>发现信息</label><div class="tag-list"><span class="tag">${project.git ? `Git · ${escapeHtml(project.branch || "detached")}` : "Local only"}</span>${project.agents.map((agent: string) => `<span class="tag">${escapeHtml(agent)}</span>`).join("")}${project.markers.map((marker: string) => `<span class="tag">${escapeHtml(marker)}</span>`).join("")}</div></div>
      <label class="check-row full"><input type="checkbox" name="makeActive" checked><span><strong>设为活动项目</strong><small>${project.git ? "导入会写入项目元数据并建立本机 Git 路径映射。" : "导入会注册本地项目；初始化 Git 后可在 Handoff 页面建立仓库映射。"}不会自动推送 GitHub。</small></span></label>
    </div>${modalActions("确认导入")}</form>`, true);
  }

  function openHandoffMappingModal(projectId: string): void {
    const project = handoffs.projects.find((entry: any) => entry.id === projectId);
    const mapping = handoffs.mappings.find((entry: any) => entry.projectId === projectId);
    openModal(`映射 ${project?.name || projectId}`, `<form data-form="handoff-mapping"><input type="hidden" name="projectId" value="${escapeHtml(projectId)}"><div class="form-grid"><div class="field full"><label for="handoff-path">Git 仓库根目录</label><input id="handoff-path" name="path" type="text" required autocomplete="off" placeholder="/Users/name/Projects/project" value="${escapeHtml(mapping?.repoRoot || "")}"><small>请输入这台设备上的绝对路径。程序会验证目录、Git HEAD 和仓库根目录。</small></div><label class="check-row full"><input type="checkbox" disabled><span><strong>同步本机绝对路径</strong><small>保持关闭；路径映射只保存在当前设备。</small></span></label></div>${modalActions("保存映射")}</form>`);
  }

  async function openHandoffPreview(projectId: string): Promise<void> {
    openModal("生成 Handoff 预览", '<div class="loading" style="padding:48px 0"><span></span><p>正在采集 Git 状态并扫描 Secret</p></div>', true);
    try {
      handoffPreview = await api(`/v1/dashboard/handoffs/${encodeURIComponent(projectId)}/preview`, {
        method: "POST",
        body: {},
      });
      const project = handoffs.projects.find((entry: any) => entry.id === projectId);
      modalTitle.textContent = `${project?.name || projectId} Handoff 预览`;
      modalContent.innerHTML = renderHandoffPreview(handoffPreview);
    } catch (error) {
      closeModal();
      throw error;
    }
  }

  function renderHandoffPreview(preview: any): string {
    const manifest = preview.manifest;
    const repository = manifest.repository;
    const findings = preview.findings || [];
    const existingFiles = preview.existingFiles || [];
    const scanState = manifest.validation.secretScan;
    const scanResult = scanState === "passed"
      ? `<div class="scan-result passed"><div class="scan-result-head">${icon("check")}<strong>Secret 扫描通过</strong></div><p>Git 变更文件与待生成内容中没有发现已知 Secret 模式。</p></div>`
      : `<div class="scan-result ${scanState === "error" ? "error" : "blocked"}"><div class="scan-result-head">${icon("shield")}<strong>${scanState === "error" ? "Secret 扫描未完成" : `发现 ${findings.length} 个 Secret 风险`}</strong></div><p>${scanState === "error" ? escapeHtml(preview.secretScanError || "扫描失败，写入已关闭。") : "写入已关闭。请处理对应文件后重新生成预览。"}</p>${findings.length ? `<div class="scan-findings"><table><thead><tr><th>文件</th><th>行</th><th>规则</th></tr></thead><tbody>${findings.map((finding: any) => `<tr><td><code>${escapeHtml(finding.file)}</code></td><td>${escapeHtml(String(finding.line))}</td><td><code>${escapeHtml(finding.ruleId)}</code></td></tr>`).join("")}</tbody></table></div>` : ""}</div>`;
    return `<div class="handoff-preview">
      <div class="preview-metrics">
        <div class="preview-metric"><span>Branch</span><strong title="${escapeHtml(repository.branch || "detached")}">${escapeHtml(repository.branch || "detached")}</strong></div>
        <div class="preview-metric"><span>Commit</span><strong title="${escapeHtml(repository.commit)}">${escapeHtml(repository.commit.slice(0, 12))}</strong></div>
        <div class="preview-metric"><span>Working tree</span><strong>${repository.dirty ? "有未提交修改" : "Clean"}</strong></div>
        <div class="preview-metric"><span>Changed files</span><strong>${escapeHtml(String(repository.changedFiles.length))}</strong></div>
      </div>
      ${scanResult}
      ${existingFiles.length ? `<div class="handoff-warning"><strong>目标文件已存在：</strong> ${existingFiles.map((file: string) => escapeHtml(file)).join("、")}。继续写入需要单独确认覆盖。</div>` : ""}
      <div><div class="panel-title"><h3>HANDOFF.md 预览</h3><span>Status Version ${escapeHtml(String(manifest.statusVersion))}</span></div><pre class="handoff-markdown">${escapeHtml(preview.markdown)}</pre></div>
      <form data-form="handoff-publish">
        <input type="hidden" name="projectId" value="${escapeHtml(manifest.projectId)}">
        <input type="hidden" name="expectedCommit" value="${escapeHtml(repository.commit)}">
        <input type="hidden" name="expectedStatusVersion" value="${escapeHtml(String(manifest.statusVersion))}">
        <div class="check-list">
          <label class="check-row"><input type="checkbox" name="confirmWrite" required ${preview.canWrite ? "" : "disabled"}><span><strong>确认写入两个 Handoff 文件</strong><small>将生成 HANDOFF.md 与 .one-status/handoff.json。</small></span></label>
          ${existingFiles.length ? '<label class="check-row"><input type="checkbox" name="overwrite" required><span><strong>确认覆盖已有 Handoff 文件</strong><small>已有文件内容会被新的预览替换。</small></span></label>' : ""}
          <label class="check-row"><input type="checkbox" name="confirmCommit" required ${preview.canWrite ? "" : "disabled"}><span><strong>确认提交当前 Git 变更</strong><small>Secret 扫描通过的 tracked、staged 与 untracked 变更会和 Handoff 一起提交。</small></span></label>
          <label class="check-row"><input type="checkbox" name="confirmPush" required ${preview.canWrite && repository.branch && repository.remote ? "" : "disabled"}><span><strong>确认推送 origin/${escapeHtml(repository.branch || "")}</strong><small>推送成功并验证远端 commit 后，精确引用才会同步到 One Status。</small></span></label>
        </div>
        <div class="form-actions"><button class="button secondary" data-close-modal type="button">取消</button><button class="button" type="submit" ${preview.canWrite && repository.branch && repository.remote ? "" : "disabled"}>${icon("cloud")}发布 Handoff</button></div>
      </form>
    </div>`;
  }

  function openContinueModal(projectId: string, agentId: "codex" | "claude-code"): void {
    const project = handoffs.projects.find((entry: any) => entry.id === projectId);
    const mapping = handoffs.mappings.find((entry: any) => entry.projectId === projectId);
    const handoff = project?.handoff;
    if (!project || !handoff) throw new Error("该项目还没有可用的 Handoff。");
    const destination = mapping
      ? `<div class="field full"><label>本机目录</label><code class="handoff-path">${escapeHtml(mapping.repoRoot)}</code><small>目录必须保持 clean；程序会 fetch 并检出精确 commit。</small></div>`
      : `<div class="field full"><label for="destinationPath">新建本机目录</label><input id="destinationPath" name="destinationPath" type="text" required autocomplete="off" placeholder="/Users/name/Projects/${escapeHtml(project.id)}"><small>目录必须尚未存在，程序会从 GitHub 克隆。</small></div>`;
    openModal(`Continue with ${agentLabel(agentId)}`, `<form data-form="handoff-open"><input type="hidden" name="projectId" value="${escapeHtml(projectId)}"><input type="hidden" name="agentId" value="${escapeHtml(agentId)}"><div class="form-grid"><div class="field full"><label>已发布版本</label><code class="handoff-path">${escapeHtml(handoff.repositoryUrl)}</code><code class="handoff-path">${escapeHtml(handoff.branch)} @ ${escapeHtml(handoff.commit)}</code></div>${destination}<label class="check-row full"><input type="checkbox" name="confirmCheckout" required><span><strong>确认检出精确 commit</strong><small>已有映射仅在工作区 clean 时更新；Agent 将在 macOS Terminal 中打开。</small></span></label></div>${modalActions(`打开 ${agentLabel(agentId)}`)}</form>`, true);
  }

  function openMemoryModal(id?: string): void {
    const memory = id ? snapshot.status.memory.find((entry: any) => entry.id === id) : null;
    if (id && !memory) throw new Error("记忆已变化，请刷新后重试。");
    openModal(memory ? "编辑记忆" : "添加记忆", `<form data-form="memory"><input type="hidden" name="id" value="${escapeHtml(memory?.id || "")}"><div class="form-grid"><div class="field"><label>范围</label><select name="scope">${["user", "project", "session"].map((scope) => `<option value="${scope}" ${scope === (memory?.scope || "user") ? "selected" : ""}>${scopeLabel(scope)}</option>`).join("")}</select></div><div class="field"><label>项目</label><select name="projectId"><option value="">无</option>${Object.values(snapshot.status.projects).map((project: any) => `<option value="${escapeHtml(project.id)}" ${project.id === memory?.projectId ? "selected" : ""}>${escapeHtml(project.name)}</option>`).join("")}</select></div>${textareaField("内容", "content", memory?.content || "")}${field("标签", "tags", memory?.tags?.join(", ") || "", "text", "full")}${memory ? `<div class="field full"><label>来源</label><code class="handoff-path">${escapeHtml(memoryOriginLabel(memory))}</code><small>编辑会保留原始来源和创建时间。</small></div>` : ""}</div>${modalActions()}</form>`);
  }

  function openProviderModal(providerId: string): void {
    const provider = snapshot.integrations.providers.find((entry: any) => entry.id === providerId);
    const secretAttributes = provider.configured
      ? 'autocomplete="new-password" placeholder="已保存；留空继续使用"'
      : 'required autocomplete="new-password" placeholder="首次配置必须填写"';
    const secretField = provider.requiresSecret
      ? `<div class="field full"><label for="clientSecret">Client Secret</label><input id="clientSecret" name="clientSecret" type="password" ${secretAttributes}><small>${provider.configured ? "Secret 已加密保存。留空提交时继续使用现有值。" : "Secret 只写入本机 Permission Vault，页面不会再次显示。"}</small></div>`
      : '<p class="oauth-help full">该服务使用 PKCE public client，只需填写 Client ID，无需 Client Secret。</p>';
    const pkceHint = provider.requiresPkce
      ? "授权时启用 PKCE，授权码只能由发起流程的本机兑换。"
      : "授权码由本机 Permission Vault 中的 Client Secret 兑换。";
    openModal(`配置 ${provider.label}`, `<form data-form="provider"><input type="hidden" name="provider" value="${escapeHtml(provider.id)}"><div class="form-grid">${field("Client ID", "clientId", provider.clientId || "", "text", "full", 'required autocomplete="off"')}${secretField}<div class="field full"><label>OAuth Callback URL</label><div class="callback"><code>${escapeHtml(provider.callbackUrl)}</code><button class="icon-button" data-action="copy-callback" data-value="${escapeHtml(provider.callbackUrl)}" type="button" title="复制 Callback URL" aria-label="复制 Callback URL">${icon("copy")}</button></div><small>${escapeHtml(providerCallbackInstruction(provider.id))}</small></div><p class="oauth-help full">${escapeHtml(pkceHint)} 保存 App 配置后，再从连接页发起账号授权；每个 Agent 的可调用操作需要单独勾选。</p></div>${modalActions()}</form>`);
  }

  function openGrantModal(connectionId: string, agentId: string): void {
    const connection = snapshot.integrations.connections.find((entry: any) => entry.id === connectionId);
    const provider = snapshot.integrations.providers.find((entry: any) => entry.id === connection.provider);
    const grant = snapshot.integrations.grants.find((entry: any) => entry.connectionId === connectionId && entry.agentId === agentId);
    const selected = new Set(grant?.actions || []);
    openModal(`${agentLabel(agentId)} 权限`, `<form data-form="grant"><input type="hidden" name="connectionId" value="${escapeHtml(connectionId)}"><input type="hidden" name="agentId" value="${escapeHtml(agentId)}"><div class="permission-toolbar"><span data-grant-summary aria-live="polite">已允许 ${selected.size}/${provider.actions.length} 项操作</span><div><button class="button secondary" data-action="set-grant-selection" data-value="all" type="button">全选</button><button class="button secondary" data-action="set-grant-selection" data-value="none" type="button">清空</button></div></div><div class="check-list">${provider.actions.map((action: any) => `<label class="check-row"><input type="checkbox" name="actions" value="${escapeHtml(action.id)}" ${selected.has(action.id) ? "checked" : ""}><span><strong>${escapeHtml(action.title)}</strong><small>${escapeHtml(action.description)}</small></span></label>`).join("")}</div>${modalActions("保存权限")}</form>`);
  }

  async function connectProvider(provider: string, button: HTMLButtonElement): Promise<void> {
    const restore = setButtonBusy(button, "正在打开授权页");
    try {
      const response = await api(`/v1/dashboard/oauth/providers/${provider}/start`, { method: "POST", body: {} });
      location.href = response.authorizationUrl;
    } catch (error) {
      restore();
      throw error;
    }
  }

  function openModal(titleValue: string, html: string, wide = false): void {
    modalTitle.textContent = titleValue;
    modalContent.innerHTML = html;
    modalBackdrop.querySelector(".modal")?.classList.toggle("wide", wide);
    modalBackdrop.hidden = false;
    modalContent.querySelector<HTMLInputElement>("input:not([type=hidden]),textarea,select")?.focus();
  }

  function closeModal(): void {
    modalBackdrop.hidden = true;
    modalBackdrop.querySelector(".modal")?.classList.remove("wide");
    modalContent.innerHTML = "";
  }

  async function api(path: string, options: { body?: unknown; method?: string } = {}): Promise<any> {
    const headers = new Headers({ accept: "application/json" });
    const method = (options.method || "GET").toUpperCase();
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
    }
    if (method !== "GET" && method !== "HEAD") {
      headers.set("x-one-status-csrf", csrf);
    }
    const response = await fetch(path, {
      method,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: "same-origin",
      headers,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error?.message || body.error || `HTTP ${response.status}`);
    return body;
  }

  function toast(message: string, error = false): void {
    window.clearTimeout(toastTimer);
    toastElement.textContent = message;
    toastElement.className = "toast" + (error ? " error" : "");
    toastElement.hidden = false;
    toastTimer = window.setTimeout(() => { toastElement.hidden = true; }, 3600);
  }

  function setBusy(form: HTMLFormElement, busy: boolean): void {
    form.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
      button.disabled = busy;
    });
  }

  function setButtonBusy(button: HTMLButtonElement, label: string): () => void {
    const html = button.innerHTML;
    const disabled = button.disabled;
    button.disabled = true;
    button.textContent = label;
    return () => {
      if (!button.isConnected) return;
      button.innerHTML = html;
      button.disabled = disabled;
    };
  }

  async function copyToClipboard(value: string): Promise<void> {
    if (!value) throw new Error("没有可复制的 Callback URL");
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("复制失败，请手动选择 Callback URL");
  }

  function updateGrantSummary(form: HTMLFormElement): void {
    const selected = form.querySelectorAll<HTMLInputElement>('input[name="actions"]:checked').length;
    const total = form.querySelectorAll<HTMLInputElement>('input[name="actions"]').length;
    const summary = form.querySelector<HTMLElement>("[data-grant-summary]");
    if (summary) summary.textContent = `已允许 ${selected}/${total} 项操作`;
  }

  function metric(iconName: string, label: string, value: unknown, detail: string): string {
    return `<article class="metric"><div class="metric-top"><span>${label}</span><span class="metric-icon">${icon(iconName)}</span></div><strong>${escapeHtml(String(value))}</strong><small>${escapeHtml(detail)}</small></article>`;
  }
  function sectionHeader(heading: string, description: string, action = ""): string {
    return `<div class="section-header"><div><h2>${heading}</h2><p>${description}</p></div>${action}</div>`;
  }
  function field(label: string, name: string, value: string, type = "text", className = "", attributes = ""): string {
    return `<div class="field ${className}"><label for="${name}">${label}</label><input id="${name}" name="${name}" type="${type}" value="${escapeHtml(value)}" ${attributes}></div>`;
  }
  function textareaField(label: string, name: string, value: string): string {
    return `<div class="field full"><label for="${name}">${label}</label><textarea id="${name}" name="${name}">${escapeHtml(value)}</textarea></div>`;
  }
  function modalActions(label = "保存"): string {
    return `<div class="form-actions"><button class="button secondary" data-close-modal type="button">取消</button><button class="button" type="submit">${icon("save")}${label}</button></div>`;
  }
  function emptyState(iconName: string, heading: string, description: string): string {
    return `<div class="empty">${icon(iconName)}<h3>${heading}</h3><p>${description}</p></div>`;
  }
  function icon(name: string): string { return icons[name] || ""; }
  function providerIcon(provider: string): string {
    return icon(provider === "google" ? "calendar" : provider === "github" ? "github" : "slack");
  }
  function providerLabel(provider: string): string {
    if (provider === "google") return "Google Calendar";
    if (provider === "github") return "GitHub";
    if (provider === "slack") return "Slack";
    return "OAuth";
  }
  function providerCallbackInstruction(provider: string): string {
    if (provider === "google") return "填入 Google Cloud Console 的 Authorized redirect URIs。";
    if (provider === "github") return "填入 GitHub OAuth App 的 Authorization callback URL。";
    return "填入 Slack App → OAuth & Permissions → Redirect URLs。";
  }
  function agentLabel(agentId: string): string {
    return agentId === "claude-code" ? "Claude Code" : agentId === "codex" ? "Codex" : agentId;
  }
  function connectionDisplayStatus(connection: any): { key: string; label: string } {
    const status = connection.status;
    if (status === "connected") return { key: "connected", label: "已连接" };
    if (status === "expired") return { key: "expired", label: "需要重新授权" };
    return { key: "error", label: "连接异常" };
  }
  function oauthErrorMessage(reason: string | null): string {
    if (reason === "access_denied") return "你取消了账号授权，未保存任何连接。";
    if (reason === "temporarily_unavailable") return "授权服务暂时不可用，请稍后重试。";
    if (reason === "invalid_oauth_state") return "授权会话已失效，请从连接页重新开始。";
    if (reason === "missing_code") return "授权服务没有返回授权码，请重新连接。";
    if (reason === "oauth_exchange_failed") return "授权码验证失败，请检查 App 配置和 Callback URL。";
    return "账号授权未完成，请重新尝试。";
  }
  function handoffActivityLabel(type: string): string {
    if (type === "handoff_published") return "已发布 Handoff";
    if (type === "handoff_opened") return "已打开并继续";
    if (type === "handoff_written") return "已写入 Handoff";
    if (type === "project_mapped") return "已映射本机仓库";
    if (type === "project_registered") return "已注册本机项目";
    if (type === "project_unmapped") return "已移除本机映射";
    return type;
  }
  function taskStatusLabel(status: string): string {
    if (status === "in_progress") return "进行中";
    if (status === "blocked") return "受阻";
    if (status === "done") return "已完成";
    return "待处理";
  }
  function memoryOriginLabel(memory: any): string {
    if (memory.origin?.label) {
      return memory.createdByAgentId
        ? `来源：${memory.origin.label} · Agent：${agentLabel(memory.createdByAgentId)}`
        : `来源：${memory.origin.label}`;
    }
    return memory.createdByAgentId
      ? `Agent：${agentLabel(memory.createdByAgentId)}`
      : "来源：旧版记录";
  }
  function auditOutcomeLabel(outcome: string): string {
    if (outcome === "success") return "成功";
    if (outcome === "blocked") return "已拦截";
    return "失败";
  }
  function auditOutcomeClass(outcome: string): string {
    if (outcome === "success") return "task-done";
    if (outcome === "blocked") return "task-blocked";
    return "task-blocked";
  }
  function scopeLabel(scope: string): string {
    return scope === "user" ? "用户" : scope === "project" ? "项目" : "会话";
  }
  function shortScope(scope: string): string { return scope.split("/").pop() || scope; }
  function formatDate(value: string): string {
    return value ? new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "—";
  }
  function formatValue(value: unknown): string {
    return Array.isArray(value) ? value.join(", ") : String(value ?? "");
  }
  function parsePreference(value: string): string | number | boolean | string[] {
    if (value === "true") return true;
    if (value === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
    return value.includes(",") ? csv(value) : value;
  }
  function stringValue(data: FormData, key: string): string { return String(data.get(key) || "").trim(); }
  function csv(value: string): string[] { return value.split(",").map((entry) => entry.trim()).filter(Boolean); }
  function lines(value: string): string[] { return value.split("\n").map((entry) => entry.trim()).filter(Boolean); }
  function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
  }
  function readError(error: unknown): string { return error instanceof Error ? error.message : "操作失败"; }

  const params = new URLSearchParams(location.search);
  if (params.get("oauth") === "connected") {
    window.setTimeout(() => toast(`${providerLabel(params.get("provider") || "")} 已连接`), 200);
    history.replaceState({}, "", location.pathname);
  } else if (params.get("oauth") === "error") {
    window.setTimeout(() => toast(oauthErrorMessage(params.get("reason")), true), 200);
    history.replaceState({}, "", location.pathname);
  }
  void load();
}

function navLink(path: string, iconName: keyof typeof iconMap, label: string) {
  return `<a class="nav-link" href="${path}">${iconMap[iconName]}<span>${label}</span></a>`;
}

function renderIcon(node: IconNode): string {
  const children = node
    .map(([tag, attributes]) => {
      const serialized = Object.entries(attributes)
        .filter(([key, value]) => key !== "key" && value !== undefined)
        .map(([key, value]) => `${key}="${escapeHtml(String(value))}"`)
        .join(" ");
      return `<${tag} ${serialized}></${tag}>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${children}</svg>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const replacements: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return replacements[character]!;
  });
}
