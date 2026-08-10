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
  PackageOpen,
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
  capabilities: renderIcon(PackageOpen),
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
  <link rel="icon" href="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2064%2064'%3E%3Crect%20width='64'%20height='64'%20rx='12'%20fill='%238edab9'/%3E%3Cpath%20d='M18%2024c0-5%204-9%2010-9h8c6%200%2010%204%2010%209v16c0%205-4%209-10%209h-8c-6%200-10-4-10-9V24Zm9-2c-2%200-3%201-3%203v14c0%202%201%203%203%203h10c2%200%203-1%203-3V25c0-2-1-3-3-3H27Z'%20fill='%2315271f'/%3E%3C/svg%3E">
  <link rel="stylesheet" href="/assets/dashboard.css">
</head>
<body>
  <div class="app-shell">
    <aside class="sidebar" id="sidebar">
      <div class="brand"><span class="brand-mark"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="12" fill="#8edab9"/><path d="M18 24c0-5 4-9 10-9h8c6 0 10 4 10 9v16c0 5-4 9-10 9h-8c-6 0-10-4-10-9V24Zm9-2c-2 0-3 1-3 3v14c0 2 1 3 3 3h10c2 0 3-1 3-3V25c0-2-1-3-3-3H27Z" fill="#15271f"/></svg></span><span>One Status</span></div>
      <nav class="nav" aria-label="主导航">
        ${navLink("/", "overview", "概览")}
        ${navLink("/models", "key", "密钥钱包")}
        ${navLink("/projects", "projects", "项目")}
        ${navLink("/memory", "brain", "记忆")}
        ${navLink("/integrations", "integrations", "连接")}
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
  color-scheme: light;
  color: #1f2622;
  background: #edf2ef;
  font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-synthesis: none;
  --paper: #edf2ef;
  --surface: #fcfdfc;
  --surface-2: #f4f7f5;
  --surface-subtle: #e7eeea;
  --ink: #1f2622;
  --muted: #66716b;
  --faint: #87938c;
  --line: #ccd6d0;
  --line-strong: #b7c4bc;
  --accent: #b6533e;
  --accent-bright: #934331;
  --accent-soft: #f7e1db;
  --ok: #4a7c59;
  --blue: #58719e;
  --amber: #a9761f;
  --red: #b3402e;
  --serif: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif;
  --shadow-card: 2px 3px 0 rgba(31, 38, 34, .05);
  --shadow-lift: 4px 6px 0 rgba(31, 38, 34, .09);
  --wobble: 255px 15px 225px 15px / 15px 225px 15px 255px;
  --wobble-sm: 12px 5px 14px 6px / 6px 13px 5px 14px;
  --wave: url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='120'%20height='8'%20viewBox='0%200%20120%208'%3E%3Cpath%20d='M2%205c15-4%2026%204%2040-1s29%203%2043-2%2024%203%2033%201'%20fill='none'%20stroke='%23c15f3c'%20stroke-width='2'%20stroke-linecap='round'%20opacity='.65'/%3E%3C/svg%3E");
  --grain: url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='140'%20height='140'%3E%3Cfilter%20id='n'%3E%3CfeTurbulence%20type='fractalNoise'%20baseFrequency='0.9'%20numOctaves='2'%20stitchTiles='stitch'/%3E%3C/filter%3E%3Crect%20width='140'%20height='140'%20filter='url(%23n)'%20opacity='0.55'/%3E%3C/svg%3E");
}
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; min-height: 100vh; background: var(--paper); }
body::before { content: ""; position: fixed; inset: 0; z-index: 999; pointer-events: none; opacity: .05; background: var(--grain) repeat; }
button, input, textarea, select { font: inherit; letter-spacing: 0; }
button { cursor: pointer; }
a { color: inherit; }
.app-shell { display: grid; grid-template-columns: 224px minmax(0, 1fr); min-height: 100vh; }
.sidebar { position: fixed; inset: 0 auto 0 0; width: 224px; display: flex; flex-direction: column; padding: 18px 14px; background: #e4ebe7; border-right: 1px solid var(--line-strong); color: var(--ink); z-index: 30; }
.brand { display: flex; align-items: center; gap: 10px; padding: 0 8px 18px; font-family: var(--serif); font-size: 17px; font-weight: 700; }
.brand-mark { display: grid; place-items: center; width: 30px; height: 30px; }
.brand-mark svg { width: 100%; height: 100%; border-radius: 7px 4px 8px 5px / 5px 8px 4px 7px; box-shadow: 2px 2px 0 rgba(38,34,27,.12); transition: transform .2s ease; }
.brand:hover .brand-mark svg { transform: rotate(-6deg); }
.nav { display: grid; gap: 3px; min-height: 0; overflow-y: auto; }
.nav-link { position: relative; display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 0 10px; border-radius: 9px; color: #56625b; text-decoration: none; font-size: 14px; font-weight: 550; transition: color .15s ease, background-color .15s ease; }
.nav-link::after { content: ""; position: absolute; left: 0; top: 24%; bottom: 24%; width: 3px; border-radius: 3px 1px 3px 1px; background: var(--accent); transform: scaleY(0); transition: transform .18s ease; }
.nav-link svg { width: 17px; height: 17px; transition: transform .18s ease; }
.nav-link:hover { color: var(--ink); background: rgba(193,95,60,.08); }
.nav-link:hover svg { transform: rotate(-8deg); }
.nav-link.active { color: var(--accent-bright); background: var(--accent-soft); }
.nav-link.active::after { transform: scaleY(1); }
.sidebar-footer { margin-top: auto; display: flex; align-items: center; gap: 9px; padding: 12px 9px; border-top: 1px solid var(--line); color: #48534d; }
.sidebar-footer div { display: grid; gap: 2px; }
.sidebar-footer strong { font-size: 12px; }
.sidebar-footer span:not(.health-dot) { color: var(--faint); font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.health-dot { width: 8px; height: 8px; border-radius: 50% 42% 55% 45%; background: var(--ok); animation: ping 2.4s cubic-bezier(0, 0, .2, 1) infinite; }
.workspace { grid-column: 2; min-width: 0; }
.topbar { position: sticky; top: 0; z-index: 20; display: flex; align-items: center; justify-content: space-between; min-height: 76px; padding: 12px clamp(20px, 4vw, 48px); background: rgba(237,242,239,.9); border-bottom: 1px solid var(--line); backdrop-filter: blur(10px); }
.topbar h1 { margin: 1px 0 0; font-family: var(--serif); font-size: 25px; line-height: 1.15; font-weight: 700; font-style: italic; }
.eyebrow { margin: 0; color: var(--accent); font-size: 10px; font-weight: 750; letter-spacing: .18em; }
.eyebrow::before { content: "✳ "; }
.topbar-actions { display: flex; align-items: center; gap: 10px; }
.sync-state { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); font-size: 12px; }
.sync-state span { width: 8px; height: 8px; border-radius: 50% 42% 55% 45%; background: var(--ok); animation: ping 2.4s cubic-bezier(0, 0, .2, 1) infinite; }
.sync-state.syncing span { background: var(--amber); animation-duration: 1s; }
.sync-state.error span { background: var(--red); animation: none; }
.icon-button { display: inline-grid; place-items: center; width: 34px; height: 34px; padding: 0; border: 1px solid var(--line-strong); border-radius: 9px; color: #48534d; background: var(--surface); transition: transform .15s ease, border-color .15s ease, color .15s ease, box-shadow .15s ease; }
.icon-button:hover { color: var(--accent-bright); border-color: var(--accent); transform: rotate(-4deg); box-shadow: 2px 3px 0 rgba(38,34,27,.1); }
.icon-button svg { width: 16px; height: 16px; transition: transform .35s ease; }
#refresh:hover svg { transform: rotate(120deg); }
.mobile-menu { display: none; }
.main { width: min(1180px, 100%); margin: 0 auto; padding: 30px clamp(20px, 4vw, 48px) 60px; }
.loading { display: grid; justify-items: center; gap: 12px; padding: 96px 0; color: var(--muted); }
.loading span { width: 26px; height: 26px; border: 2.5px dashed var(--accent); border-radius: 50% 45% 52% 48%; animation: spin 1.4s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.section-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
.section-header h2 { margin: 0; padding-bottom: 9px; background: var(--wave) left bottom / auto 8px repeat-x; font-family: var(--serif); font-size: 21px; font-weight: 700; }
.section-header p { margin: 5px 0 0; color: var(--muted); font-size: 13px; }
.button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 37px; padding: 0 15px; border: 1.5px solid var(--accent-bright); border-radius: var(--wobble); color: #fff; background: var(--accent); font-size: 13px; font-weight: 650; text-decoration: none; box-shadow: 2px 3px 0 rgba(31,38,34,.16); transition: transform .15s ease, box-shadow .15s ease, background-color .15s ease; }
.button:hover { background: var(--accent-bright); transform: translate(-1px, -2px) rotate(-.4deg); box-shadow: 4px 5px 0 rgba(38,34,27,.16); }
.button:active { transform: translate(1px, 1px); box-shadow: 1px 1px 0 rgba(38,34,27,.16); }
.button.secondary { color: var(--ink); background: var(--surface); border-color: var(--line-strong); box-shadow: 2px 3px 0 rgba(38,34,27,.08); }
.button.secondary:hover { background: var(--surface-2); border-color: var(--muted); }
.button.danger { color: var(--red); background: transparent; border-color: var(--red); box-shadow: none; }
.button.danger:hover { background: rgba(179,64,46,.08); }
.button:disabled { cursor: not-allowed; opacity: .45; transform: none; }
.button svg { width: 15px; height: 15px; }
.metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin-bottom: 26px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); box-shadow: var(--shadow-card); overflow: hidden; animation: rise .45s cubic-bezier(.2, .7, .3, 1) backwards; }
.metric { position: relative; min-height: 104px; padding: 16px 18px; border-left: 1px solid var(--line); background: transparent; transition: background-color .15s ease; }
.metric:first-child { border-left: 0; }
.metric:hover { background: var(--surface-2); }
.metric-top { display: flex; align-items: center; justify-content: space-between; color: var(--muted); font-size: 10px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
.metric-icon { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 9px; background: var(--accent-soft); color: var(--accent-bright); }
.metric-icon svg { width: 15px; height: 15px; }
.metric strong { display: block; margin-top: 13px; font-family: var(--serif); font-size: 32px; line-height: 1; font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; }
.metric small { display: block; margin-top: 7px; color: var(--faint); font-size: 11px; }
.layout-2 { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(280px, .8fr); gap: 20px; align-items: start; }
.header-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.data-section { min-width: 0; }
.device-matrix { display: grid; gap: 16px; }
.device-block { overflow: hidden; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); box-shadow: var(--shadow-card); animation: rise .4s cubic-bezier(.2, .7, .3, 1) backwards; }
.device-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; padding: 17px 18px; border-bottom: 1px solid var(--line); background: var(--surface-2); }
.device-head h3 { margin: 0; font-family: var(--serif); font-size: 18px; }
.device-title { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; }
.device-head p { margin: 5px 0 0; color: var(--muted); font-size: 11px; }
.device-head-side { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px 14px; color: var(--muted); font-size: 10px; }
.presence { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 10px; font-weight: 700; }
.presence i { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); }
.presence.online { color: var(--ok); }
.presence.online i { background: var(--ok); box-shadow: 0 0 0 3px rgba(74,124,89,.12); }
.presence.offline i { background: var(--faint); }
.tool-matrix-head, .tool-matrix-row { display: grid; grid-template-columns: minmax(170px, 1.25fr) minmax(150px, 1fr) minmax(155px, 1fr) minmax(110px, .7fr) 78px; gap: 14px; align-items: center; }
.tool-matrix-head { min-height: 35px; padding: 0 18px; color: var(--muted); background: var(--surface-subtle); font-size: 9px; font-weight: 700; text-transform: uppercase; }
.tool-matrix-row { min-height: 68px; padding: 11px 18px; border-top: 1px solid var(--line); }
.tool-matrix-row:first-of-type { border-top: 0; }
.tool-matrix-row > div { min-width: 0; }
.tool-matrix-row strong, .tool-matrix-row small { display: block; overflow-wrap: anywhere; }
.tool-matrix-row strong { font-size: 12px; }
.tool-matrix-row small { margin-top: 3px; color: var(--muted); font-size: 10px; }
.tool-name { display: flex; align-items: center; gap: 10px; }
.tool-glyph { display: grid; place-items: center; width: 32px; height: 32px; flex: 0 0 auto; border-radius: 6px; color: #315f50; background: #dce9e2; }
.tool-glyph svg { width: 16px; height: 16px; }
.device-empty { display: flex; min-height: 104px; align-items: center; justify-content: center; gap: 10px; padding: 18px; color: var(--muted); }
.device-empty > span { display: grid; }
.device-empty svg { width: 18px; height: 18px; }
.device-empty p { margin: 0; font-size: 11px; }
.health-state, .intent-status { display: inline-flex; min-height: 22px; align-items: center; padding: 0 7px; border-radius: 5px; font-size: 9px; font-weight: 750; white-space: nowrap; }
.health-available, .health-not-required, .intent-healthy, .intent-applied { color: #3f6a4c; background: #e4efe6; }
.health-missing, .intent-error, .intent-failed, .intent-rollback { color: #8f3527; background: #f7e3de; }
.health-unverified, .intent-unknown, .intent-unconfigured { color: #6d6553; background: #eee8d9; }
.intent-pending, .intent-applying { color: #46618f; background: #e5ebf4; }
.model-table td small { color: var(--muted); }
.model-table code { overflow-wrap: anywhere; white-space: normal; }
.wallet-secret { display: grid; gap: 6px; justify-items: start; }
.wallet-secret code { min-width: 96px; color: var(--ink); font-size: 12px; letter-spacing: 0; }
.wallet-revealed { user-select: none; color: var(--ink); border-color: var(--line-strong); background: var(--surface-subtle); }
.result-cell { max-width: 320px; overflow-wrap: anywhere; white-space: normal; }
.configuration-targets { display: grid; gap: 10px; }
.configuration-device { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 0; padding: 12px; border: 1px solid var(--line); border-radius: 8px; }
.configuration-device legend { grid-column: 1 / -1; padding: 0 6px; font-size: 11px; font-weight: 700; }
.configuration-target { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 8px; padding: 9px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-2); }
.configuration-target.disabled { opacity: .45; }
.configuration-target strong, .configuration-target small { display: block; }
.configuration-target strong { font-size: 11px; }
.configuration-target small { margin-top: 3px; color: var(--muted); font-size: 9px; }
.configuration-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.configuration-summary > div { min-width: 0; padding: 11px; border-left: 1px solid var(--line); }
.configuration-summary > div:first-child { border-left: 0; }
.configuration-summary span, .configuration-summary strong, .configuration-summary small { display: block; overflow-wrap: anywhere; }
.configuration-summary span { color: var(--muted); font-size: 9px; font-weight: 700; text-transform: uppercase; }
.configuration-summary strong { margin-top: 5px; font-size: 12px; }
.configuration-summary small { margin-top: 3px; color: var(--muted); font-size: 9px; }
.persona-toolbar { align-items: center; margin-bottom: 16px; }
.persona-table .persona-content { min-width: 260px; max-width: 520px; white-space: normal; line-height: 1.55; }
.persona-events { display: grid; gap: 10px; }
.persona-event { padding: 15px 16px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface); box-shadow: var(--shadow-card); }
.persona-event-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--muted); font-size: 10px; }
.persona-event > p { margin: 12px 0; color: var(--ink); font-size: 13px; line-height: 1.6; white-space: pre-wrap; }
.persona-event footer { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; padding-top: 10px; border-top: 1px solid var(--line); }
.persona-event footer strong, .persona-event footer small { display: block; }
.persona-event footer strong { font-size: 10px; }
.persona-event footer small { margin-top: 3px; color: var(--muted); font-size: 9px; }
.persona-policy { display: grid; border-top: 1px solid var(--line); }
.policy-section { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 17px 0; border-bottom: 1px solid var(--line); }
.policy-section h3 { margin: 0; font-size: 13px; }
.policy-section p { margin: 4px 0 0; color: var(--muted); font-size: 10px; }
.policy-stack { display: grid; justify-content: stretch; }
.policy-options { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; width: 100%; }
.policy-category-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; width: 100%; }
.policy-category { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 8px; padding: 9px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-2); }
.policy-category strong, .policy-category small { display: block; }
.policy-category strong { font-size: 11px; }
.policy-category small { margin-top: 2px; color: var(--muted); font-size: 9px; overflow-wrap: anywhere; }
.toggle { display: inline-flex; align-items: center; gap: 8px; }
.toggle input { position: absolute; opacity: 0; pointer-events: none; }
.toggle span { position: relative; width: 38px; height: 22px; border-radius: 12px; background: var(--line-strong); transition: background .15s ease; }
.toggle span::after { content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(31,38,34,.2); transition: transform .15s ease; }
.toggle input:checked + span { background: var(--ok); }
.toggle input:checked + span::after { transform: translateX(16px); }
.toggle strong { font-size: 11px; }
.notebook { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); padding: 0; margin-bottom: 24px; }
.notebook-page { padding: 20px 22px; min-width: 0; }
.notebook-page + .notebook-page { border-left: 1px solid var(--line); }
.context-quote { margin: 0; font-family: var(--serif); font-size: 17px; font-style: italic; line-height: 1.8; color: #354039; }
.context-quote::before { content: "“ "; color: var(--accent); }
.context-quote::after { content: " ”"; color: var(--accent); }
.spotlight-name { margin: 0; font-family: var(--serif); font-size: 26px; font-weight: 700; }
.panel { position: relative; padding: 20px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); box-shadow: var(--shadow-card); animation: rise .45s cubic-bezier(.2, .7, .3, 1) backwards; }
.panel.notebook { padding: 0; }
.panel + .panel { margin-top: 16px; }
.panel-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.panel-title h3 { margin: 0; font-family: var(--serif); font-size: 16px; font-weight: 700; }
.panel-title span { color: var(--faint); font-size: 11px; letter-spacing: .06em; }
.context-text { margin: 0; color: #48534d; font-size: 14px; line-height: 1.7; white-space: pre-wrap; }
.project-spotlight { display: grid; gap: 14px; }
.project-spotlight::before { content: ""; position: absolute; top: -9px; left: 50%; width: 74px; height: 16px; transform: translateX(-50%) rotate(-2deg); background: rgba(142,218,185,.32); border: 1px solid rgba(31,38,34,.07); box-shadow: 0 1px 2px rgba(31,38,34,.08); }
.project-spotlight h3 { margin: 0; font-family: var(--serif); font-size: 22px; font-weight: 700; }
.project-spotlight p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.6; }
.tag-list { display: flex; flex-wrap: wrap; gap: 6px; }
.tag { display: inline-flex; align-items: center; min-height: 25px; padding: 0 9px; border: 1px dashed var(--line-strong); border-radius: 8px 4px 9px 5px / 5px 9px 4px 8px; background: transparent; color: var(--muted); font-size: 11px; }
.link-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 0; border-top: 1px solid var(--line); font-size: 13px; }
.link-row:first-child { border-top: 0; padding-top: 0; }
.link-row:last-child { padding-bottom: 0; }
.link-row > div { min-width: 0; }
.link-row strong { display: block; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.link-row small { color: var(--muted); }
.link-row svg { width: 15px; height: 15px; color: var(--faint); transition: transform .15s ease, color .15s ease; }
.link-row:hover svg { transform: translateX(3px) rotate(-6deg); color: var(--accent); }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.field { display: grid; gap: 6px; }
.form-grid > .full { grid-column: 1 / -1; }
.field label { color: #48534d; font-size: 12px; font-weight: 650; }
.field input, .field textarea, .field select { width: 100%; border: 1px solid var(--line-strong); border-radius: 8px; color: var(--ink); background: #fff; outline: none; transition: border-color .12s ease, box-shadow .12s ease; }
.field input, .field select { height: 38px; padding: 0 10px; }
.field textarea { min-height: 112px; padding: 10px; line-height: 1.5; resize: vertical; }
.field input:focus, .field textarea:focus, .field select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(193,95,60,.15); }
.field small { color: var(--muted); font-size: 11px; }
.form-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.preference-list, .memory-list { border-top: 1px solid var(--line); }
.preference-row, .memory-row { display: grid; grid-template-columns: 200px minmax(0, 1fr) auto; align-items: center; gap: 18px; padding: 12px 0; border-bottom: 1px solid var(--line); }
.preference-row strong, .memory-row strong { font-size: 12px; }
.preference-row > div:last-child { display: flex; gap: 6px; }
.preference-row code { overflow-wrap: anywhere; color: #48534d; background: var(--surface-subtle); border: 1px solid var(--line); border-radius: 6px; padding: 3px 9px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.memory-row { grid-template-columns: 100px minmax(0, 1fr) auto; }
.memory-row p { margin: 0 0 7px; font-size: 13px; line-height: 1.5; white-space: pre-wrap; }
.memory-row small { display: block; margin-top: 8px; color: var(--muted); font-size: 10px; }
.scope { display: inline-flex; align-items: center; width: fit-content; min-height: 24px; padding: 0 8px; border: 1px solid rgba(193,95,60,.35); border-radius: 8px; background: var(--accent-soft); color: var(--accent-bright); font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
.segmented { display: inline-flex; max-width: 100%; padding: 3px; overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--surface-subtle); }
.segmented button { flex: 0 0 auto; min-height: 29px; padding: 0 11px; border: 0; border-radius: 8px; color: var(--muted); background: transparent; font-size: 12px; transition: color .12s ease, background-color .12s ease, box-shadow .12s ease; }
.segmented button.active { color: var(--accent-bright); background: var(--surface); box-shadow: 2px 2px 0 rgba(38,34,27,.1); }
.card-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.item-card { position: relative; min-width: 0; padding: 18px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); box-shadow: var(--shadow-card); animation: rise .45s cubic-bezier(.2, .7, .3, 1) backwards; transition: transform .16s ease, box-shadow .16s ease, border-color .16s ease; }
.item-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-lift); }
.item-card.active { border-color: var(--accent); background: #f8fbf9; }
.item-card.spotlight { grid-column: 1 / -1; }
.item-card.spotlight .card-head h3 { font-size: 22px; }
.item-card.spotlight .card-body { min-height: 0; font-size: 14px; }
.card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.card-head h3 { margin: 0; font-family: var(--serif); font-size: 16px; font-weight: 700; }
.card-head p { margin: 4px 0 0; color: var(--faint); font-size: 11px; }
.card-body { min-height: 66px; margin: 14px 0; color: #48534d; font-size: 13px; line-height: 1.6; }
.card-actions { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding-top: 13px; border-top: 1px solid var(--line); }
.provider-buttons { display: flex; align-items: center; gap: 8px; }
.provider-card { position: relative; overflow: hidden; }
.provider-card.provider-google { --provider-accent: #4285f4; }
.provider-card.provider-github { --provider-accent: #24292f; }
.provider-card.provider-slack { --provider-accent: #36c5f0; }
.provider-card.provider-microsoft { --provider-accent: #00a4ef; }
.provider-card.provider-notion { --provider-accent: #191919; }
.provider-card.provider-dropbox { --provider-accent: #0061ff; }
.provider-card.provider-zoom { --provider-accent: #2d8cff; }
.provider-card.provider-canva { --provider-accent: #00a4aa; }
.provider-card.provider-asana { --provider-accent: #d84f5f; }
.provider-card.provider-trello { --provider-accent: #0c66e4; }
.provider-card.provider-airtable { --provider-accent: #087ea4; }
.provider-card.provider-linear { --provider-accent: #5e6ad2; }
.provider-card.provider-figma { --provider-accent: #8f4ed8; }
.provider-card.provider-box { --provider-accent: #0061d5; }
.provider-line { position: absolute; inset: 0 auto 0 0; width: 3px; background: var(--provider-accent); }
.provider-heading { display: flex; gap: 11px; align-items: center; }
.provider-scopes { margin-top: 10px; }
.provider-icon { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 6px; color: #fff; background: var(--provider-accent); }
.provider-icon svg { width: 19px; height: 19px; }
.capability-card { display: flex; min-height: 250px; flex-direction: column; }
.capability-card .card-body { flex: 1; }
.capability-heading { display: flex; align-items: center; gap: 11px; min-width: 0; }
.capability-heading .provider-icon { background: #315f50; }
.capability-meta { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 12px; }
.capability-targets { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 12px; }
.capability-target { display: flex; min-height: 44px; align-items: center; gap: 9px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-subtle); }
.capability-target input { width: 16px; height: 16px; flex: none; }
.capability-target span { min-width: 0; }
.capability-target strong, .capability-target small { display: block; }
.capability-target small { margin-top: 2px; color: var(--muted); }
.approval-section + .approval-section { margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--line); }
.provider-capabilities { display: grid; gap: 9px; margin-top: 14px; padding-top: 13px; border-top: 1px solid var(--line); }
.provider-capability { display: grid; gap: 9px; padding: 2px 0; }
.provider-capability + .provider-capability { padding-top: 12px; border-top: 1px solid var(--line); }
.provider-capability-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.provider-capability-head strong, .provider-capability-head small { display: block; }
.provider-capability-head small { margin-top: 3px; color: var(--muted); font-size: 9px; }
.provider-capability-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
.approval-section > p { overflow-wrap: anywhere; }
.connection { margin-top: 14px; padding-top: 13px; border-top: 1px solid var(--line); }
.connection-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.connection-head > div { min-width: 0; }
.connection-head strong { font-size: 12px; }
.connection-head small { display: block; margin-top: 3px; color: var(--muted); font-size: 10px; }
.connection-status { flex: 0 0 auto; font-size: 10px; font-weight: 700; }
.connection-status.connected { color: var(--ok); }
.connection-status.expired { color: var(--amber); }
.connection-status.error { color: var(--red); }
.grant-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 9px; padding-top: 9px; border-top: 1px solid var(--line); font-size: 11px; }
.grant-row span { color: var(--muted); }
.connection-scopes { display: grid; gap: 7px; margin-top: 10px; }
.connection-scopes > small { color: var(--muted); font-size: 10px; font-weight: 650; }
.handoff-policy { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 20px; padding: 14px 16px; border: 1px solid #dcb096; border-left: 3px solid var(--accent); border-radius: 10px; background: #f7ead9; }
.handoff-policy > svg { flex: 0 0 auto; width: 18px; height: 18px; margin-top: 1px; color: var(--accent); }
.handoff-policy strong { display: block; margin-bottom: 3px; font-size: 12px; }
.handoff-policy p { margin: 0; color: #7c4a33; font-size: 11px; line-height: 1.55; }
.handoff-project .card-body { min-height: 84px; }
.handoff-path { display: block; margin-top: 10px; padding: 8px 9px; overflow-wrap: anywhere; border: 1px solid var(--line); border-radius: 8px; color: #6d6553; background: var(--surface-subtle); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; line-height: 1.45; }
.handoff-card-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 7px; }
.handoff-preview { display: grid; gap: 16px; }
.preview-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.preview-metric { min-width: 0; padding: 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-2); }
.preview-metric span { display: block; color: var(--muted); font-size: 9px; font-weight: 700; text-transform: uppercase; }
.preview-metric strong { display: block; margin-top: 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
.scan-result { padding: 12px; border: 1px solid var(--line-strong); border-radius: 10px; }
.scan-result-head { display: flex; align-items: center; gap: 8px; }
.scan-result-head svg { width: 16px; height: 16px; }
.scan-result-head strong { font-size: 12px; }
.scan-result p { margin: 5px 0 0 24px; color: var(--muted); font-size: 11px; }
.scan-result.passed { color: #3f6a4c; border-color: #9db89a; background: #edf2e7; }
.scan-result.blocked, .scan-result.error { color: #8f3527; border-color: #d8a79b; background: #f7e9e5; }
.scan-findings { margin-top: 11px; overflow-x: auto; }
.scan-findings table { background: var(--surface); }
.handoff-markdown { max-height: 280px; margin: 0; padding: 13px; overflow: auto; border: 1px solid var(--line); border-radius: 8px; color: #57503f; background: var(--surface-2); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.handoff-warning { padding: 11px 12px; border: 1px solid #d9c68d; border-radius: 10px; color: #7a5a17; background: #f7efdb; font-size: 11px; line-height: 1.5; }
.empty { padding: 48px 20px; border: 1.5px dashed var(--line-strong); border-radius: 10px 6px 12px 7px / 7px 12px 6px 10px; text-align: center; background: transparent; }
.empty svg { width: 26px; height: 26px; color: var(--faint); rotate: -6deg; }
.empty h3 { margin: 12px 0 5px; font-family: var(--serif); font-size: 15px; }
.empty p { margin: 0; color: var(--muted); font-size: 12px; }
.table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); box-shadow: var(--shadow-card); }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { padding: 13px 14px; border-bottom: 1px solid var(--line); text-align: left; white-space: nowrap; }
th { color: var(--muted); background: var(--surface-subtle); font-size: 10px; text-transform: uppercase; letter-spacing: .08em; border-bottom: 1px solid var(--line-strong); }
tbody tr { transition: background-color .12s ease; }
tbody tr:hover { background: rgba(193,95,60,.045); }
tr:last-child td { border-bottom: 0; }
.current-device { color: var(--ok); font-size: 10px; font-weight: 700; }
.row-actions { display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
.task-status { display: inline-flex; min-height: 23px; align-items: center; padding: 0 8px; border-radius: 8px 4px 9px 5px / 5px 9px 4px 8px; font-size: 10px; font-weight: 700; white-space: nowrap; }
.task-todo { color: #6d6553; background: #eee8d9; }
.task-in_progress { color: #46618f; background: #e5ebf4; }
.task-blocked { color: #8f3527; background: #f7e3de; }
.task-done { color: #3f6a4c; background: #e4efe6; }
.modal-backdrop { position: fixed; inset: 0; z-index: 80; display: grid; place-items: center; padding: 20px; background: rgba(31,38,34,.42); backdrop-filter: blur(3px); }
.modal-backdrop[hidden] { display: none; }
.modal { width: min(560px, 100%); max-height: calc(100vh - 40px); overflow: auto; border: 1px solid var(--line-strong); border-radius: 14px; background: var(--surface); box-shadow: 6px 8px 0 rgba(38,34,27,.08); animation: rise .25s cubic-bezier(.2, .7, .3, 1); }
.modal.wide { width: min(860px, 100%); }
.modal > header { position: sticky; top: 0; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 15px 18px; border-bottom: 1px solid var(--line); background: var(--surface); z-index: 2; }
.modal h2 { margin: 0; font-family: var(--serif); font-size: 17px; font-weight: 700; }
#modal-content { padding: 18px; }
.check-list { display: grid; gap: 8px; }
.check-row { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 9px; align-items: start; padding: 10px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface-2); }
.check-row input { margin: 2px 0 0; }
.check-row strong { display: block; font-size: 12px; }
.check-row small { color: var(--muted); font-size: 11px; }
.action-meta { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
.action-meta .tag { font-size: 9px; }
.action-meta .write-risk { border-color: color-mix(in srgb, var(--red) 45%, var(--line)); color: var(--red); }
.action-meta .scope-missing { border-color: color-mix(in srgb, var(--amber) 55%, var(--line)); color: var(--amber); }
.permission-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
.permission-toolbar > span { color: var(--muted); font-size: 11px; }
.permission-toolbar > div { display: flex; gap: 6px; }
.permission-toolbar .button { min-height: 30px; }
.callback { display: flex; gap: 7px; align-items: flex-start; padding: 9px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-subtle); }
.callback code { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 10px; line-height: 1.5; }
.callback .icon-button { flex: 0 0 auto; width: 30px; height: 30px; }
.oauth-help { grid-column: 1 / -1; margin: 0; padding: 10px 11px; border-left: 3px solid var(--accent); border-radius: 4px; color: #7c4a33; background: #f7ead9; font-size: 11px; line-height: 1.55; }
.app-shell.onboarding { grid-template-columns: 1fr; }
.app-shell.onboarding .sidebar { display: none; }
.app-shell.onboarding .workspace { grid-column: 1; }
.onboarding-layout { width: min(820px, 100%); margin: 18px auto 0; }
.onboarding-head { display: grid; gap: 8px; margin-bottom: 22px; }
.onboarding-head h2 { margin: 0; font-size: 22px; }
.onboarding-head p { max-width: 620px; margin: 0; color: var(--muted); font-size: 13px; line-height: 1.6; }
.onboarding-form { padding: 20px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); background: var(--surface); box-shadow: var(--shadow-card); }
.onboarding-form .segmented { margin-bottom: 18px; }
.onboarding-security { display: flex; gap: 10px; margin-top: 16px; color: var(--muted); font-size: 11px; line-height: 1.55; }
.onboarding-security svg { flex: 0 0 auto; width: 17px; height: 17px; color: var(--ok); }
.recovery-key { display: block; margin: 12px 0; padding: 12px; overflow-wrap: anywhere; border: 1.5px dashed #9db89a; border-radius: 8px 5px 9px 6px / 6px 9px 5px 8px; color: #3f6a4c; background: #edf2e7; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.6; }
.toast { position: fixed; right: 20px; bottom: 20px; z-index: 100; max-width: 360px; padding: 12px 15px; border: 1.5px solid var(--ink); border-radius: var(--wobble-sm); color: var(--paper); background: var(--ink); box-shadow: 3px 4px 0 rgba(38,34,27,.25); font-size: 12px; animation: rise .25s cubic-bezier(.2, .7, .3, 1); }
.toast.error { background: var(--red); border-color: #7c2d20; }
.mt-20 { margin-top: 20px; }
.mt-12 { margin-top: 12px; }
.mt-6 { margin-top: 6px; }
.loading-compact { padding: 48px 0; }
@keyframes rise { from { opacity: 0; transform: translateY(8px) rotate(-.5deg); } to { opacity: 1; transform: translateY(0) rotate(0deg); } }
@keyframes ping { 0% { box-shadow: 0 0 0 0 currentColor; } 75%, 100% { box-shadow: 0 0 0 7px transparent; } }
::selection { background: rgba(193, 95, 60, .28); }
* { scrollbar-width: thin; scrollbar-color: var(--line-strong) transparent; }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { border: 3px solid transparent; border-radius: 8px; background: var(--line-strong); background-clip: content-box; }
a:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; }
}
@media (max-width: 920px) {
  .metrics { grid-template-columns: 1fr 1fr; }
  .metric { border-top: 1px solid var(--line); }
  .metric:nth-child(-n+2) { border-top: 0; }
  .metric:nth-child(odd) { border-left: 0; }
  .notebook { grid-template-columns: 1fr; }
  .notebook-page + .notebook-page { border-left: 0; border-top: 1px solid var(--line); }
  .layout-2 { grid-template-columns: 1fr; }
  .card-grid { grid-template-columns: 1fr; }
  .tool-matrix-head { display: none; }
  .tool-matrix-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .tool-matrix-row > .row-actions { grid-column: 1 / -1; justify-content: flex-start; }
  .policy-category-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
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
  .preference-row { grid-template-columns: 1fr auto; gap: 8px; }
  .preference-row > :first-child { grid-column: 1; }
  .memory-row { grid-template-columns: 1fr; align-items: start; gap: 8px; }
  .memory-row > * { grid-column: 1; min-width: 0; }
  .memory-row .row-actions { justify-content: flex-start; flex-wrap: wrap; }
  .preview-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .provider-card .card-actions { flex-wrap: wrap; }
  .device-head { flex-direction: column; }
  .device-head-side { justify-content: flex-start; }
  .configuration-summary { grid-template-columns: 1fr; }
  .configuration-summary > div { border-top: 1px solid var(--line); border-left: 0; }
  .configuration-summary > div:first-child { border-top: 0; }
  .persona-event footer { align-items: flex-start; flex-direction: column; }
  .model-table, .model-table tbody { display: block; width: 100%; }
  .model-table thead { display: none; }
  .model-table tr { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 11px 12px; border-bottom: 1px solid var(--line); }
  .model-table tr:last-child { border-bottom: 0; }
  .model-table td { display: block; min-width: 0; padding: 6px; border: 0; white-space: normal; overflow-wrap: anywhere; }
  .model-table td::before { display: block; margin-bottom: 3px; color: var(--muted); font-size: 8px; font-weight: 700; text-transform: uppercase; }
  .model-table td:first-child, .model-table td:last-child { grid-column: 1 / -1; }
  .model-table td:first-child::before { content: "记录"; }
  .model-table td:last-child .row-actions { justify-content: flex-start; }
  .source-table td:nth-child(2)::before { content: "类型"; }
  .source-table td:nth-child(3)::before { content: "协议 / Endpoint"; }
  .source-table td:nth-child(4)::before { content: "AI 工具"; }
  .source-table td:nth-child(5)::before { content: "API Key"; }
  .source-table td:nth-child(6)::before { content: "验证"; }
  .models-table td:nth-child(2)::before { content: "来源"; }
  .models-table td:nth-child(3)::before { content: "模型 ID"; }
  .models-table td:nth-child(4)::before { content: "AI 工具"; }
  .models-table td:nth-child(5)::before { content: "已配置"; }
  .overview-model-table td:nth-child(2)::before { content: "密钥来源"; }
  .overview-model-table td:nth-child(3)::before { content: "兼容工具"; }
  .overview-model-table td:nth-child(4)::before { content: "已配置"; }
  .overview-model-table td:nth-child(5)::before { content: "消耗量"; }
  .overview-model-table td:nth-child(6)::before { content: "最近统计"; }
}
@media (max-width: 430px) {
  .metrics { grid-template-columns: 1fr; }
  .metric { border-left: 0; }
  .metric:nth-child(-n+2) { border-top: 1px solid var(--line); }
  .metric:first-child { border-top: 0; }
  .sync-state { display: none; }
  .section-header { align-items: flex-start; flex-direction: column; }
  .section-header .button { width: 100%; }
  .modal-backdrop { align-items: end; padding: 16px 0 0; }
  .modal { width: 100%; max-height: calc(100dvh - 16px); border-radius: 7px 7px 0 0; }
  .modal > header, #modal-content { padding-left: 16px; padding-right: 16px; }
  .provider-card .card-actions, .grant-row { align-items: stretch; flex-direction: column; }
  .provider-buttons { width: 100%; flex-direction: column; }
  .provider-card .card-actions .button, .grant-row .button { width: 100%; }
  .capability-targets { grid-template-columns: 1fr; }
  .connection-head { align-items: flex-start; }
  .permission-toolbar { align-items: flex-start; flex-direction: column; }
  .form-actions { display: grid; grid-template-columns: 1fr 1fr; }
  .header-actions, .header-actions .button { width: 100%; }
  .header-actions { display: grid; grid-template-columns: 1fr 1fr; }
  .tool-matrix-row { grid-template-columns: 1fr; gap: 9px; }
  .tool-matrix-row > .row-actions { grid-column: 1; }
  .tool-matrix-row .button { width: 100%; }
  .configuration-device, .policy-options, .policy-category-grid { grid-template-columns: 1fr; }
  .persona-toolbar { align-items: stretch; }
  .persona-toolbar .segmented { width: 100%; overflow-x: auto; }
  .persona-toolbar .segmented button { flex: 1 0 auto; }
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
  let pendingCapabilityInstall: any;
  let pendingModelConfiguration: any;
  let memoryView: "records" | "profile" | "events" | "policy" = "records";
  let toastTimer: number | undefined;

  gatewayAddress.textContent = location.host;

  const routes: Record<string, { label: string; render: () => string }> = {
    "/": { label: "概览", render: renderOverview },
    "/models": { label: "密钥钱包", render: renderModels },
    "/projects": { label: "项目", render: renderProjects },
    "/memory": { label: "记忆", render: renderMemory },
    "/integrations": { label: "连接", render: renderIntegrations },
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
      if (action === "sync-device-control") {
        const button = target as HTMLButtonElement;
        const restore = setButtonBusy(button, "正在扫描");
        try {
          await api("/v1/dashboard/device-control/sync", {
            method: "POST",
            body: {},
          });
          await load(false);
          toast("当前设备工具与模型状态已更新");
        } finally {
          restore();
        }
        return;
      }
      if (action === "add-model-source") return openModelSourceModal();
      if (action === "edit-model-source") {
        return openModelSourceModal(target.dataset.id);
      }
      if (action === "delete-model-source") {
        if (confirm("删除这份密钥配置？关联模型和待执行配置也会删除。")) {
          await api(
            `/v1/dashboard/model-sources/${encodeURIComponent(target.dataset.id || "")}`,
            { method: "DELETE" },
          );
          await load(false);
          toast("密钥配置已删除");
        }
        return;
      }
      if (action === "add-model") return openModelModal();
      if (action === "edit-model") return openModelModal(target.dataset.id);
      if (action === "delete-model") {
        if (confirm("删除这个模型？相关待执行配置也会删除。")) {
          await api(
            `/v1/dashboard/models/${encodeURIComponent(target.dataset.id || "")}`,
            { method: "DELETE" },
          );
          await load(false);
          toast("模型已删除");
        }
        return;
      }
      if (action === "configure-model") {
        return openModelConfigurationModal(target.dataset.model, {
          deviceId: target.dataset.device,
          toolId: target.dataset.tool,
        });
      }
      if (action === "reveal-model-credential") {
        return openWalletPasswordModal(
          target.dataset.id!,
          target.dataset.mode === "copy" ? "copy" : "view",
        );
      }
      if (action === "change-wallet-password") {
        return openWalletPasswordChangeModal();
      }
      if (action === "set-memory-view") {
        memoryView = (target.dataset.view || "records") as typeof memoryView;
        renderRoute();
        return;
      }
      if (action === "edit-persona-event") {
        return openPersonaEventModal(target.dataset.id!);
      }
      if (action === "delete-persona-event") {
        if (confirm("删除这条观察记录？用户细节会根据剩余记录重新生成。")) {
          await api(
            `/v1/dashboard/persona/events/${encodeURIComponent(target.dataset.id || "")}`,
            { method: "DELETE" },
          );
          await load(false);
          toast("观察记录已删除");
        }
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
      if (action === "configure-capability") {
        return openCapabilityModal(target.dataset.pack!);
      }
      if (action === "remove-capability") {
        if (confirm("停用这项连接能力？已生成的本机文件会保留，便于恢复或手动删除。")) {
          await api(`/v1/dashboard/capabilities/${encodeURIComponent(target.dataset.pack || "")}`, {
            method: "DELETE",
          });
          await load(false);
          toast("连接能力已停用");
        }
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
          input.checked = checked && !input.disabled;
        });
        updateGrantSummary(form);
        return;
      }
      if (action === "connect-provider") {
        const provider = snapshot.integrations.providers.find(
          (entry: any) => entry.id === target.dataset.provider,
        );
        if (provider?.authMode === "token") {
          return openTokenConnectionModal(provider.id);
        }
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
      if (action === "approve-tool" || action === "deny-tool") {
        await api(
          `/v1/dashboard/tool-approvals/${encodeURIComponent(target.dataset.id || "")}`,
          {
            method: "POST",
            body: { decision: action === "approve-tool" ? "approve" : "deny" },
          },
        );
        await load(false);
        toast(action === "approve-tool" ? "本次工具调用已批准" : "工具调用已拒绝");
        return;
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
    const input = event.target as HTMLInputElement | HTMLSelectElement;
    if (input.name === "actions") {
      const form = input.closest<HTMLFormElement>('form[data-form="grant"]');
      if (form) updateGrantSummary(form);
      return;
    }
    if (input.name === "modelId") {
      const form = input.closest<HTMLFormElement>(
        'form[data-form="model-configuration"]',
      );
      if (form) updateModelTargetAvailability(form, input.value);
      return;
    }
    if (input.name === "sourceId") {
      const form = input.closest<HTMLFormElement>('form[data-form="model"]');
      const source = snapshot.status.deviceControl.sources[input.value];
      if (form && source) {
        form
          .querySelectorAll<HTMLInputElement>('input[name="supportedTools"]')
          .forEach((checkbox) => {
            checkbox.disabled = !source.supportedTools.includes(checkbox.value);
            if (checkbox.disabled) checkbox.checked = false;
          });
      }
      return;
    }
    if (input.name === "protocol") {
      const form = input.closest<HTMLFormElement>(
        'form[data-form="model-source"]',
      );
      if (form) updateSourceToolAvailability(form, input.value);
    }
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
      if (form.dataset.form === "model-source") {
        const id = stringValue(data, "id");
        await api(`/v1/dashboard/model-sources/${encodeURIComponent(id)}`, {
          method: "PUT",
          body: {
            label: stringValue(data, "label"),
            kind: stringValue(data, "kind"),
            protocol: stringValue(data, "protocol"),
            endpoint: stringValue(data, "endpoint") || undefined,
            supportedTools: data.getAll("supportedTools").map(String),
            apiKey: stringValue(data, "apiKey") || undefined,
            clearCredential: data.get("clearCredential") === "on",
          },
        });
        closeModal();
        toast("密钥配置已保存");
      }
      if (form.dataset.form === "model") {
        const id = stringValue(data, "id");
        await api(`/v1/dashboard/models/${encodeURIComponent(id)}`, {
          method: "PUT",
          body: {
            sourceId: stringValue(data, "sourceId"),
            name: stringValue(data, "name"),
            modelId: stringValue(data, "modelId"),
            supportedTools: data.getAll("supportedTools").map(String),
          },
        });
        closeModal();
        toast("模型已保存");
      }
      if (form.dataset.form === "model-configuration") {
        const targets = data.getAll("targets").map(String).map((value) => {
          const separator = value.indexOf("|");
          return {
            deviceId: value.slice(0, separator),
            toolId: value.slice(separator + 1),
          };
        });
        if (targets.length === 0) throw new Error("至少选择一个设备和 AI 工具。");
        pendingModelConfiguration = await api(
          "/v1/dashboard/model-configurations/preview",
          {
            method: "POST",
            body: {
              modelId: stringValue(data, "modelId"),
              targets,
            },
          },
        );
        openModelConfigurationApprovalModal();
        return;
      }
      if (form.dataset.form === "model-configuration-apply") {
        if (!pendingModelConfiguration) {
          throw new Error("模型配置预览已失效。");
        }
        if (data.get("confirmConfiguration") !== "on") {
          throw new Error("请确认应用预览中的模型配置。");
        }
        await api("/v1/dashboard/model-configurations/apply", {
          method: "POST",
          body: {
            approvalId: pendingModelConfiguration.approvalId,
            digest: pendingModelConfiguration.digest,
            confirm: true,
          },
        });
        pendingModelConfiguration = undefined;
        closeModal();
        toast("模型配置已提交；离线设备会在上线后应用");
      }
      if (form.dataset.form === "wallet-reveal") {
        const sourceId = stringValue(data, "sourceId");
        const mode = stringValue(data, "mode") === "copy" ? "copy" : "view";
        const result = await api(
          `/v1/dashboard/model-wallet/${encodeURIComponent(sourceId)}/reveal`,
          {
            method: "POST",
            body: { password: stringValue(data, "password") },
          },
        );
        const secret = revealedModelCredential(result);
        if (mode === "copy") {
          await copyToClipboard(secret);
          closeModal();
          toast("密钥已复制，本次授权不会保留");
          return;
        }
        openModal(
          "查看 API Key",
          `<p class="oauth-help">页面关闭后会立即清除本次明文展示。明文区域禁止选择；复制操作需要重新输入钱包密码。</p><code class="recovery-key wallet-revealed">${escapeHtml(secret)}</code><div class="form-actions"><button class="button" data-close-modal type="button">${icon("check")}关闭</button></div>`,
        );
        return;
      }
      if (form.dataset.form === "wallet-password-change") {
        const newPassword = stringValue(data, "newPassword");
        if (newPassword !== stringValue(data, "confirmPassword")) {
          throw new Error("两次输入的新钱包密码不一致。");
        }
        await api("/v1/dashboard/model-wallet/password", {
          method: "POST",
          body: {
            currentPassword: stringValue(data, "currentPassword"),
            newPassword,
          },
        });
        closeModal();
        toast("钱包密码已更新并加密同步");
        return;
      }
      if (form.dataset.form === "persona-event") {
        const id = stringValue(data, "id");
        await api(
          `/v1/dashboard/persona/events/${encodeURIComponent(id)}`,
          {
            method: "PUT",
            body: {
              category: stringValue(data, "category"),
              content: stringValue(data, "content"),
              confidence: stringValue(data, "confidence"),
            },
          },
        );
        closeModal();
        toast("观察记录已更新");
      }
      if (form.dataset.form === "persona-policy") {
        const customBlocked = csv(stringValue(data, "customBlockedCategories"));
        const allowedConfidences = data.getAll("allowedConfidences").map(String);
        if (allowedConfidences.length === 0) {
          throw new Error("至少保留一种可记录的可信度。");
        }
        await api("/v1/dashboard/persona/policy", {
          method: "PUT",
          body: {
            enabled: data.get("enabled") === "on",
            blockedCategories: [
              ...new Set([
                ...data.getAll("blockedCategories").map(String),
                ...customBlocked,
              ]),
            ],
            allowedConfidences,
          },
        });
        toast("记忆记录策略已保存");
      }
      if (form.dataset.form === "capability") {
        const packId = stringValue(data, "packId");
        const targets = data.getAll("targets").map(String);
        const enabled = data.get("enabled") === "on";
        if (targets.length === 0) {
          throw new Error("至少选择一个目标 Agent。");
        }
        const localTargets = enabled
          ? targets.filter((target) => ["codex", "claude-code", "markdown"].includes(target))
          : [];
        if (localTargets.length > 0) {
          const plans = await Promise.all(
            localTargets.map((target) =>
              api(`/v1/dashboard/capabilities/${encodeURIComponent(packId)}/preview`, {
                method: "POST",
                body: { target },
              }),
            ),
          );
          pendingCapabilityInstall = { packId, targets, enabled, plans };
          openCapabilityApprovalModal();
          return;
        }
        await saveCapabilityIntent(packId, targets, enabled);
        closeModal();
        toast("Agent 安装目标已保存并同步");
      }
      if (form.dataset.form === "capability-apply") {
        if (!pendingCapabilityInstall) throw new Error("安装预览已失效。");
        if (data.get("confirmInstall") !== "on") {
          throw new Error("请先确认安装文件和平台注册命令。");
        }
        for (const plan of pendingCapabilityInstall.plans) {
          await api(`/v1/dashboard/capabilities/${encodeURIComponent(pendingCapabilityInstall.packId)}/install`, {
            method: "POST",
            body: {
              target: plan.target,
              approvalId: plan.approvalId,
              confirmed: true,
            },
          });
        }
        await saveCapabilityIntent(
          pendingCapabilityInstall.packId,
          pendingCapabilityInstall.targets,
          pendingCapabilityInstall.enabled,
        );
        pendingCapabilityInstall = undefined;
        closeModal();
        toast("连接能力已安装并同步");
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
      if (form.dataset.form === "provider-token") {
        const provider = stringValue(data, "provider");
        await api(`/v1/dashboard/oauth/providers/${provider}/import-token`, {
          method: "POST",
          body: { accessToken: stringValue(data, "accessToken") },
        });
        closeModal();
        toast("服务账号已连接");
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
    const devices = snapshot.account.devices;
    const control = snapshot.status.deviceControl;
    const models = Object.values(control.models) as any[];
    const installedToolCount = Object.values(control.reports).reduce(
      (total: number, report: any) =>
        total + report.tools.filter((tool: any) => tool.installed).length,
      0,
    );
    return `
      ${pageLead(
        `${devices.length} 台设备 · ${devices.filter((device: any) => device.online).length} 台在线 · ${installedToolCount} 个已安装工具`,
        `<button class="button secondary" data-action="sync-device-control" type="button">${icon("refresh")}扫描当前设备</button>`,
      )}
      <div class="device-matrix">${devices.map((device: any) => renderDeviceBlock(device)).join("")}</div>
      <section class="data-section mt-20">
        ${sectionHeader("可配置模型", `${models.length} 个模型 · ${snapshot.modelUsage?.scannedAt ? `用量统计于 ${formatDate(snapshot.modelUsage.scannedAt)}` : "等待本机会话用量扫描"}`)}
        ${models.length ? `<div class="table-wrap"><table class="model-table overview-model-table"><thead><tr><th>模型</th><th>密钥来源</th><th>兼容工具</th><th>已配置</th><th>消耗量</th><th>最近统计</th><th></th></tr></thead><tbody>${models.map((model: any) => {
          const source = control.sources[model.sourceId];
          const configured = Object.values(control.reports).flatMap((report: any) => report.tools).filter((tool: any) => tool.currentModelRef === model.id).length;
          const usage = modelUsageSummary(model);
          return `<tr><td><strong>${escapeHtml(model.name)}</strong><br><small>${escapeHtml(model.modelId)}</small></td><td><strong>${escapeHtml(source?.label || model.sourceId)}</strong><br><small>${escapeHtml(endpointHost(source?.endpoint) || modelSourceKindLabel(source?.kind))}</small></td><td>${renderToolTags(model.supportedTools)}</td><td>${configured} 个工具</td><td><strong>${escapeHtml(usage.primary)}</strong><br><small>${escapeHtml(usage.detail)}</small></td><td>${usage.updatedAt ? formatDate(usage.updatedAt) : "等待扫描"}</td><td><button class="button secondary" data-action="configure-model" data-model="${escapeHtml(model.id)}" type="button">切换</button></td></tr>`;
        }).join("")}</tbody></table></div>` : emptyState("database", "暂无可配置模型", "密钥钱包完成自动扫描后会在这里显示模型")}
      </section>`;
  }

  function renderModels(): string {
    const control = snapshot.status.deviceControl;
    const sources = Object.values(control.sources) as any[];
    const models = Object.values(control.models) as any[];
    const intents = (Object.values(control.intents) as any[]).sort(
      (left, right) => right.updatedAt.localeCompare(left.updatedAt),
    );
    const actions = `<div class="header-actions"><button class="button secondary" data-action="add-model-source" type="button">${icon("plus")}添加密钥</button><button class="button" data-action="add-model" type="button" ${sources.length ? "" : "disabled"}>${icon("plus")}添加模型</button></div>`;
    return `
      ${pageLead(`${sources.length} 份加密配置 · ${models.length} 个模型`, actions)}
      <section class="data-section">
        <div class="panel-title"><h3>API、Endpoint 与模型来源</h3><span>E2EE 同步</span></div>
        ${sources.length ? `<div class="table-wrap"><table class="model-table source-table wallet-table"><thead><tr><th>名称</th><th>类型</th><th>协议 / Endpoint</th><th>AI 工具</th><th>API Key</th><th>验证</th><th></th></tr></thead><tbody>${sources.map((source: any) => {
          const credential = (snapshot.modelCredentialSources || []).find((entry: any) => entry.sourceId === source.id);
          const hasCredential = Boolean(credential) && source.credentialStatus !== "missing";
          return `<tr><td><strong>${escapeHtml(source.label)}</strong><br><small>${escapeHtml(source.id)}</small></td><td>${escapeHtml(modelSourceKindLabel(source.kind))}</td><td><strong>${escapeHtml(modelProtocolLabel(source.protocol))}</strong><br><small>${escapeHtml(endpointHost(source.endpoint) || "默认 Endpoint")}</small></td><td>${renderToolTags(source.supportedTools)}</td><td><div class="wallet-secret"><code>${hasCredential ? "••••••••••••" : "未保存"}</code><span class="health-state health-${escapeHtml(source.credentialStatus)}">${escapeHtml(credentialStatusLabel(source.credentialStatus))}</span></div></td><td>${formatDate(source.lastVerifiedAt || credential?.updatedAt)}</td><td><div class="row-actions">${hasCredential ? `<button class="button secondary" data-action="reveal-model-credential" data-mode="view" data-id="${escapeHtml(source.id)}" type="button">${icon("key")}查看</button><button class="icon-button" data-action="reveal-model-credential" data-mode="copy" data-id="${escapeHtml(source.id)}" type="button" title="验证密码并复制密钥" aria-label="验证密码并复制密钥">${icon("copy")}</button>` : ""}<button class="button secondary" data-action="edit-model-source" data-id="${escapeHtml(source.id)}" type="button">编辑</button><button class="icon-button" data-action="delete-model-source" data-id="${escapeHtml(source.id)}" type="button" title="删除密钥配置">${icon("trash")}</button></div></td></tr>`;
        }).join("")}</tbody></table></div>` : emptyState("key", "密钥钱包为空", "当前设备扫描到的 AI 配置会自动加密进入钱包")}
      </section>
      <section class="data-section mt-20">
        <div class="panel-title"><h3>模型</h3><span>${models.length}</span></div>
        ${models.length ? `<div class="table-wrap"><table class="model-table models-table"><thead><tr><th>模型</th><th>来源</th><th>模型 ID</th><th>AI 工具</th><th>已配置</th><th></th></tr></thead><tbody>${models.map((model: any) => {
          const source = control.sources[model.sourceId];
          const configured = Object.values(control.reports).flatMap((report: any) => report.tools).filter((tool: any) => tool.currentModelRef === model.id).length;
          return `<tr><td><strong>${escapeHtml(model.name)}</strong><br><small>${escapeHtml(model.id)}</small></td><td>${escapeHtml(source?.label || model.sourceId)}</td><td><code>${escapeHtml(model.modelId)}</code></td><td>${renderToolTags(model.supportedTools)}</td><td>${configured} 个工具</td><td><div class="row-actions"><button class="button" data-action="configure-model" data-model="${escapeHtml(model.id)}" type="button">配置</button><button class="button secondary" data-action="edit-model" data-id="${escapeHtml(model.id)}" type="button">编辑</button><button class="icon-button" data-action="delete-model" data-id="${escapeHtml(model.id)}" type="button" title="删除模型">${icon("trash")}</button></div></td></tr>`;
        }).join("")}</tbody></table></div>` : emptyState("database", "暂无模型", "")}
      </section>
      <section class="data-section mt-20">
        <div class="panel-title"><h3>配置状态</h3><span>${intents.length}</span></div>
        ${intents.length ? `<div class="table-wrap"><table><thead><tr><th>设备</th><th>AI 工具</th><th>模型</th><th>状态</th><th>更新时间</th><th>结果</th></tr></thead><tbody>${intents.slice(0, 30).map((intent: any) => {
          const device = snapshot.account.devices.find((entry: any) => entry.id === intent.deviceId);
          const model = control.models[intent.modelId];
          return `<tr><td>${escapeHtml(device?.name || intent.deviceId)}</td><td>${escapeHtml(agentLabel(intent.toolId))}</td><td>${escapeHtml(model?.name || intent.modelId)}</td><td><span class="intent-status intent-${escapeHtml(intent.status)}">${escapeHtml(intentStatusLabel(intent.status))}</span></td><td>${formatDate(intent.updatedAt)}</td><td class="result-cell">${escapeHtml(intent.error || (intent.status === "applied" ? "已应用" : intent.status === "rollback" ? "已恢复原配置" : "—"))}</td></tr>`;
        }).join("")}</tbody></table></div>` : emptyState("activity", "暂无配置任务", "")}
      </section>`;
  }

  function renderStatus(): string {
    const identity = snapshot.status.identity;
    return `
      ${sectionHeader("身份与偏好", `Version ${snapshot.version} · 加密同步`)}
      <section class="panel notebook">
        <div class="notebook-page">
        <div class="panel-title"><h3>身份</h3><span>加密同步</span></div>
        <form data-form="identity"><div class="form-grid">
          ${field("显示名称", "displayName", identity.displayName || "")}
          ${field("语言", "locale", identity.locale || navigator.language)}
          ${field("时区", "timezone", identity.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone, "text", "full")}
        </div><div class="form-actions"><button class="button" type="submit">${icon("save")}保存身份</button></div></form>
        </div>
        <div class="notebook-page">
        <div class="panel-title"><h3>当前上下文</h3><span>Agent handoff</span></div>
        <form data-form="context"><div class="form-grid">
          <div class="field full"><label for="currentContext">上下文</label><textarea id="currentContext" name="currentContext">${escapeHtml(snapshot.status.workspace.currentContext || "")}</textarea></div>
          <div class="field full"><label for="activeProjectId">活动项目</label><select id="activeProjectId" name="activeProjectId"><option value="">未选择</option>${Object.values(snapshot.status.projects).map((project: any) => `<option value="${escapeHtml(project.id)}" ${project.id === snapshot.status.workspace.activeProjectId ? "selected" : ""}>${escapeHtml(project.name)}</option>`).join("")}</select></div>
        </div><div class="form-actions"><button class="button" type="submit">${icon("save")}保存上下文</button></div></form>
        </div>
      </section>
      <section class="panel mt-20">
        <div class="panel-title"><h3>偏好</h3><button class="button secondary" data-action="add-preference" type="button">${icon("plus")}添加</button></div>
        <div class="preference-list">${Object.entries(snapshot.status.preferences).map(([key, value]) => `<div class="preference-row"><strong>${escapeHtml(key)}</strong><code>${escapeHtml(formatValue(value))}</code><div><button class="button secondary" data-action="edit-preference" data-key="${escapeHtml(key)}" type="button">编辑</button> <button class="icon-button" data-action="delete-preference" data-key="${escapeHtml(key)}" type="button" title="删除">${icon("trash")}</button></div></div>`).join("") || '<div class="empty"><p>暂无偏好</p></div>'}</div>
      </section>`;
  }

  function renderProjects(): string {
    const projects = Object.values(snapshot.status.projects) as any[];
    const tasks = Object.values(snapshot.status.tasks) as any[];
    return `
      ${pageLead(`${projects.length} 个项目 · ${snapshot.status.workspace.activeProjectId ? "已设置活动项目" : "无活动项目"}`, `<button class="button" data-action="add-project" type="button">${icon("plus")}新建项目</button>`)}
      ${projects.length ? `<div class="card-grid">${projects.map((project) => `
        <article class="item-card ${project.id === snapshot.status.workspace.activeProjectId ? "active spotlight" : ""}">
          <div class="card-head"><div><h3>${escapeHtml(project.name)}</h3><p>${escapeHtml(project.id)}</p></div>${project.id === snapshot.status.workspace.activeProjectId ? '<span class="scope">活动</span>' : ""}</div>
          <div class="card-body">${escapeHtml(project.currentGoal || project.summary || "暂无目标")}</div>
          <div class="tag-list">${project.techStack.map((tag: string) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>
          <div class="card-actions"><small>${formatDate(project.updatedAt)}</small><div><button class="button secondary" data-action="edit-project" data-id="${escapeHtml(project.id)}" type="button">编辑</button> <button class="icon-button" data-action="delete-project" data-id="${escapeHtml(project.id)}" type="button" title="删除">${icon("trash")}</button></div></div>
        </article>`).join("")}</div>` : emptyState("projects", "暂无项目", "当前项目列表为空")}
      <section class="panel mt-20">
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
      <section class="panel mt-20">
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
        ${inventory.rules.length ? `<div class="tag-list mt-12">${inventory.rules.map((rule: any) => `<span class="tag">${escapeHtml(rule.type)} · ${escapeHtml(rule.agent)}</span>`).join("")}</div>` : ""}
      </section>
      ${inventory.warnings.length ? `<section class="panel"><div class="panel-title"><h3>扫描提示</h3><span>${inventory.warnings.length}</span></div>${inventory.warnings.map((warning: string) => `<p>${escapeHtml(warning)}</p>`).join("")}</section>` : ""}`;
  }

  function renderProviderCapabilities(providerId: string): string {
    const catalog = (snapshot.capabilityPacks || []).filter(
      (entry: any) => entry.manifest.authorization?.provider === providerId,
    );
    if (catalog.length === 0) return "";
    const installations = snapshot.status.capabilities?.installations || {};
    return `<div class="provider-capabilities">${catalog.map((entry: any) => {
        const pack = entry.manifest;
        const installation = installations[pack.name];
        const writeCount = pack.tools.filter((tool: any) => tool.readOnly === false).length;
        return `<section class="provider-capability">
          <div class="provider-capability-head"><div><strong>${escapeHtml(capabilityDisplayName(pack))}</strong><small>${pack.tools.length} 项操作 · ${writeCount} 项写入确认</small></div><span class="connection-status ${installation?.enabled ? "connected" : "expired"}">${installation?.enabled ? "已启用" : "待安装"}</span></div>
          <p>${escapeHtml(capabilityDescription(pack))}</p>
          <div class="tag-list">${pack.tools.slice(0, 4).map((tool: any) => `<span class="tag">${escapeHtml(tool.id)}</span>`).join("")}${pack.tools.length > 4 ? `<span class="tag">+${pack.tools.length - 4}</span>` : ""}</div>
          <div class="provider-capability-actions"><div class="tag-list">${installation?.targets?.length ? installation.targets.map((target: string) => `<span class="scope">${escapeHtml(capabilityTargetLabel(target))}</span>`).join("") : '<span class="tag">尚未选择 Agent</span>'}</div><div class="provider-buttons">${installation ? `<button class="button secondary" data-action="remove-capability" data-pack="${escapeHtml(pack.name)}" type="button">停用</button>` : ""}<button class="button secondary" data-action="configure-capability" data-pack="${escapeHtml(pack.name)}" type="button">${icon("settings")}${installation ? "配置 Agent" : "安装到 Agent"}</button></div></div>
        </section>`;
      }).join("")}</div>`;
  }

  function renderMemory(): string {
    const persona = snapshot.status.persona;
    const candidates = snapshot.status.memory.filter((entry: any) => entry.state === "candidate");
    const memories = snapshot.status.memory.filter((entry: any) =>
      memoryFilter === "all"
        ? true
        : memoryFilter === "candidate"
          ? entry.state === "candidate"
          : entry.scope === memoryFilter,
    );
    const views = [
      { id: "records", label: `记忆 ${snapshot.status.memory.length}` },
      { id: "profile", label: `用户细节 ${Object.keys(persona.profile).length}` },
      { id: "events", label: `观察记录 ${persona.events.length}` },
      { id: "policy", label: "记录策略" },
    ];
    const recordList = `
      <div class="section-header"><div class="segmented">${["all", "candidate", "user", "project", "session"].map((scope) => `<button class="${memoryFilter === scope ? "active" : ""}" data-action="filter-memory" data-scope="${scope}" type="button">${scope === "all" ? "全部" : scope === "candidate" ? `待确认 ${candidates.length}` : scopeLabel(scope)}</button>`).join("")}</div><p>${memories.length} 条</p></div>
      ${memories.length ? `<div class="memory-list">${memories.map((entry: any) => `<div class="memory-row"><div><span class="scope">${scopeLabel(entry.scope)}</span>${entry.state === "candidate" ? '<span class="task-status task-in_progress mt-6">待确认</span>' : ""}</div><div><p>${escapeHtml(entry.content)}</p><div class="tag-list">${entry.tags.map((tag: string) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div><small>${escapeHtml(memoryOriginLabel(entry))} · ${formatDate(entry.updatedAt)}</small></div><div class="row-actions">${entry.state === "candidate" ? `<button class="button" data-action="confirm-memory" data-id="${escapeHtml(entry.id)}" type="button">${icon("check")}确认</button>` : ""}<button class="button secondary" data-action="edit-memory" data-id="${escapeHtml(entry.id)}" type="button">编辑</button><button class="icon-button" data-action="delete-memory" data-id="${escapeHtml(entry.id)}" type="button" title="删除">${icon("trash")}</button></div></div>`).join("")}</div>` : emptyState("brain", "当前筛选下没有记忆", "当前记忆列表为空")}`;
    return `
      ${pageLead(`${snapshot.status.memory.length} 条加密记录 · ${persona.events.length} 条用户观察`, memoryView === "records" ? `<button class="button" data-action="add-memory" type="button">${icon("plus")}添加记忆</button>` : "")}
      <div class="section-header persona-toolbar"><div class="segmented" role="tablist" aria-label="记忆视图">${views.map((view) => `<button class="${memoryView === view.id ? "active" : ""}" data-action="set-memory-view" data-view="${view.id}" type="button">${view.label}</button>`).join("")}</div><p>${persona.policy.enabled ? "记忆观察已启用" : "记忆观察已暂停"}</p></div>
      ${memoryView === "records" ? recordList : memoryView === "events" ? renderPersonaEvents(persona.events) : memoryView === "policy" ? renderPersonaPolicy(persona) : renderPersonaProfile(persona)}`;
  }

  function renderIntegrations(): string {
    const integrations = snapshot.integrations;
    const approvals = integrations.approvals || [];
    const approvalPanel = approvals.length
      ? `<section class="panel"><div class="panel-title"><h3>待审批调用</h3><span>${approvals.length} 项 · 10 分钟内有效</span></div><div class="memory-list">${approvals.map((approval: any) => {
          const connection = integrations.connections.find(
            (entry: any) => entry.id === approval.connectionId,
          );
          return `<div class="memory-row"><div><span class="scope">${escapeHtml(agentLabel(approval.agentId))}</span></div><div><p><strong>${escapeHtml(approval.action)}</strong> · ${escapeHtml(connection?.label || approval.connectionId)}</p><pre class="handoff-markdown">${escapeHtml(JSON.stringify(approval.arguments, null, 2))}</pre><small>过期于 ${formatDate(approval.expiresAt)} · 参数变化后需要重新审批</small></div><div class="row-actions"><button class="button" data-action="approve-tool" data-id="${escapeHtml(approval.id)}" type="button">${icon("check")}批准一次</button><button class="button secondary" data-action="deny-tool" data-id="${escapeHtml(approval.id)}" type="button">拒绝</button></div></div>`;
        }).join("")}</div></section>`
      : "";
    return `
      ${pageLead(`${integrations.connections.length} 个服务账号 · ${integrations.grants.length} 条 Agent 授权`)}
      ${approvalPanel}
      <section class="data-section mt-20"><div class="panel-title"><h3>服务账号与权限</h3><span>${integrations.providers.length} 个服务</span></div>
      <div class="card-grid">${integrations.providers.map((provider: any) => {
        const connections = integrations.connections.filter((connection: any) => connection.provider === provider.id);
        const tokenMode = provider.authMode === "token";
        const cliImport = provider.id === "github"
          ? `<button class="button secondary" data-action="import-github-cli" type="button">${icon("terminal")}从 gh 导入</button>`
          : "";
        return `<article class="item-card provider-card provider-${provider.id}"><span class="provider-line"></span>
          <div class="card-head"><div class="provider-heading"><span class="provider-icon">${providerIcon(provider.id)}</span><div><h3>${escapeHtml(provider.label)}</h3><p>${connections.length ? `${connections.length} 个账号已连接` : provider.configured ? tokenMode ? "API Key 已配置" : "OAuth App 已配置" : provider.id === "github" ? "可配置 OAuth App 或导入 gh" : tokenMode ? "需要配置 API Key" : "需要配置 OAuth App"}</p></div></div><button class="icon-button" data-action="configure-provider" data-provider="${provider.id}" type="button" title="配置">${icon("settings")}</button></div>
          <div class="card-body">${escapeHtml(provider.description)}<div class="tag-list provider-scopes">${provider.scopes.map((scope: string) => `<span class="tag">${escapeHtml(shortScope(scope))}</span>`).join("")}</div>${renderProviderCapabilities(provider.id)}</div>
          ${connections.map((connection: any) => renderConnection(connection, provider)).join("")}
          <div class="card-actions"><small>${connections.length ? connections.length + " 个账号" : provider.configured ? tokenMode ? "可以导入用户 Token" : "可以开始账号授权" : provider.id === "github" ? "gh 登录可直接导入" : tokenMode ? "先保存 API Key" : "先完成 App 配置"}</small><div class="provider-buttons">${cliImport}<button class="button ${provider.configured ? "" : "secondary"}" data-action="connect-provider" data-provider="${provider.id}" type="button" ${provider.configured ? "" : "disabled"}>${icon("key")}${tokenMode ? "导入 Token" : connections.length ? "连接其他账号" : "连接账号"}</button></div></div>
        </article>`;
      }).join("")}</div></section>`;
  }

  function renderConnection(connection: any, provider: any): string {
    const agents = ["codex", "claude-code"];
    const status = connectionDisplayStatus(connection);
    const source = connection.source === "imported" ? " · 本机凭据导入" : "";
    return `<div class="connection"><div class="connection-head"><div><strong>${escapeHtml(connection.label)}</strong><small>更新于 ${formatDate(connection.updatedAt)}${source}</small></div><span class="connection-status ${status.key}">${status.label}</span></div><div class="connection-scopes"><small>账号授权范围</small><div class="tag-list">${connection.scopes.map((scope: string) => `<span class="tag">${escapeHtml(shortScope(scope))}</span>`).join("") || '<span class="tag">未返回 scope</span>'}</div></div>${agents.map((agent) => {
      const grant = snapshot.integrations.grants.find((entry: any) => entry.connectionId === connection.id && entry.agentId === agent);
      const count = grant?.actions.length || 0;
      return `<div class="grant-row"><span>${agentLabel(agent)} · ${count ? `允许 ${count}/${provider.actions.length} 项操作` : "尚未授权操作"}</span><button class="button secondary" data-action="edit-grant" data-id="${connection.id}" data-agent="${agent}" type="button">${icon("shield")}权限</button></div>`;
    }).join("")}<div class="grant-row"><span>断开后，该账号的所有 Agent 授权会一并删除</span><button class="button danger" data-action="disconnect-connection" data-id="${connection.id}" type="button">断开</button></div></div>`;
  }

  function renderDeviceBlock(device: any, management = false): string {
    const control = snapshot.status.deviceControl;
    const report = control.reports[device.id];
    const installedTools = report?.tools.filter((tool: any) => tool.installed) || [];
    const current = device.id === snapshot.profile.deviceId;
    const online = current || device.online;
    const managementAction = management && !current
      ? `<button class="button danger" data-action="revoke-device" data-id="${escapeHtml(device.id)}" type="button">撤销设备</button>`
      : "";
    return `<article class="device-block">
      <header class="device-head"><div><div class="device-title"><h3>${escapeHtml(device.name)}</h3>${current ? '<span class="scope">当前设备</span>' : ""}<span class="presence ${online ? "online" : "offline"}"><i></i>${online ? "在线" : "离线"}</span></div><p>${report ? `${escapeHtml(operatingSystemLabel(report.operatingSystem))} ${escapeHtml(report.osVersion)} · ${escapeHtml(report.architecture)}` : "等待设备后台上报"}</p></div><div class="device-head-side"><span>后台 ${escapeHtml(report?.backgroundVersion || "—")}</span><span>最后在线 ${formatDate(device.lastSeenAt)}</span>${managementAction}</div></header>
      ${installedTools.length ? `<div class="tool-matrix"><div class="tool-matrix-head"><span>AI 工具</span><span>当前模型</span><span>模型来源</span><span>配置状态</span><span></span></div>${installedTools.map((tool: any) => {
        const source = tool.sourceId ? control.sources[tool.sourceId] : undefined;
        const model = tool.currentModelRef ? control.models[tool.currentModelRef] : undefined;
        const intent = latestConfigurationIntent(device.id, tool.toolId);
        const health = intent && ["pending", "applying", "failed", "rollback"].includes(intent.status)
          ? intent.status
          : tool.health;
        const compatible = (Object.values(control.models) as any[]).filter((entry: any) => entry.supportedTools.includes(tool.toolId));
        return `<div class="tool-matrix-row"><div class="tool-name"><span class="tool-glyph">${icon(tool.toolId === "cursor" ? "projects" : "terminal")}</span><div><strong>${escapeHtml(tool.name || agentLabel(tool.toolId))}</strong><small>${escapeHtml(tool.version || "版本未知")}</small></div></div><div><strong>${escapeHtml(model?.name || tool.currentModelId || "未配置")}</strong><small>${escapeHtml(tool.currentModelId || "")}</small></div><div><strong>${escapeHtml(source?.label || tool.sourceLabel || "—")}</strong><small>${escapeHtml(modelSourceKindLabel(source?.kind || tool.sourceKind))}${tool.endpointHost ? ` · ${escapeHtml(tool.endpointHost)}` : ""}</small></div><div><span class="intent-status intent-${escapeHtml(health)}">${escapeHtml(toolHealthLabel(health))}</span>${intent ? `<small>${formatDate(intent.updatedAt)}</small>` : ""}</div><div class="row-actions"><button class="button secondary" data-action="configure-model" data-device="${escapeHtml(device.id)}" data-tool="${escapeHtml(tool.toolId)}" data-model="${escapeHtml(tool.currentModelRef || "")}" type="button" ${compatible.length ? "" : "disabled"}>${tool.currentModelId ? "切换" : "配置"}</button></div></div>`;
      }).join("")}</div>` : `<div class="device-empty"><span>${icon("terminal")}</span><p>${report ? "未检测到已安装的 AI 工具" : online ? "等待首次环境扫描" : "设备上线后获取工具清单"}</p>${current ? `<button class="button secondary" data-action="sync-device-control" type="button">${icon("refresh")}扫描</button>` : ""}</div>`}
    </article>`;
  }

  function renderPersonaProfile(persona: any): string {
    const entries = Object.values(persona.profile) as any[];
    return entries.length
      ? `<div class="table-wrap"><table class="persona-table"><thead><tr><th>类别</th><th>当前用户细节</th><th>可信度</th><th>观察</th><th>最近观察</th><th></th></tr></thead><tbody>${entries.sort((left, right) => left.category.localeCompare(right.category)).map((entry: any) => `<tr><td><span class="scope">${escapeHtml(personaCategoryLabel(entry.category))}</span><br><small>${escapeHtml(entry.category)}</small></td><td class="persona-content">${escapeHtml(entry.content)}</td><td>${escapeHtml(confidenceLabel(entry.confidence))}</td><td>${entry.observationCount} 次</td><td>${formatDate(entry.lastObservedAt)}</td><td><button class="button secondary" data-action="edit-persona-event" data-id="${escapeHtml(entry.sourceEventIds[0])}" type="button">编辑记录</button></td></tr>`).join("")}</tbody></table></div>`
      : emptyState("brain", "暂无用户细节", "有效观察会在本机归并为用户习惯、偏好、目标与规划");
  }

  function renderPersonaEvents(eventsValue: any[]): string {
    const events = [...eventsValue].sort(
      (left, right) => right.lastObservedAt.localeCompare(left.lastObservedAt),
    );
    return events.length
      ? `<div class="persona-events">${events.map((entry: any) => {
          const agents = [...new Set(entry.observations.map((observation: any) => agentLabel(observation.sourceAgent)))];
          const projects = [...new Set(entry.observations.map((observation: any) => observation.sourceProject).filter(Boolean))];
          return `<article class="persona-event"><div class="persona-event-meta"><span class="scope">${escapeHtml(personaCategoryLabel(entry.category))}</span><span>${escapeHtml(confidenceLabel(entry.confidence))}</span><span>${entry.observationCount} 次</span></div><p>${escapeHtml(entry.content)}</p><footer><div><strong>${escapeHtml(agents.join("、"))}</strong><small>${projects.length ? `项目 ${escapeHtml(projects.join("、"))} · ` : ""}${formatDate(entry.observedAt)} → ${formatDate(entry.lastObservedAt)}</small></div><div class="row-actions"><button class="button secondary" data-action="edit-persona-event" data-id="${escapeHtml(entry.id)}" type="button">编辑</button><button class="icon-button" data-action="delete-persona-event" data-id="${escapeHtml(entry.id)}" type="button" title="删除观察记录">${icon("trash")}</button></div></footer></article>`;
        }).join("")}</div>`
      : emptyState("brain", "暂无观察记录", "Agent 识别到用户细节后会在本机生成带来源的结构化记录");
  }

  function renderPersonaPolicy(persona: any): string {
    const categories = personaPolicyCategories(persona);
    const blocked = new Set(persona.policy.blockedCategories || []);
    const allowed = new Set(persona.policy.allowedConfidences || []);
    const standard = new Set(defaultPersonaCategories());
    const customBlocked = [...blocked].filter((category) => !standard.has(String(category)));
    return `<form class="persona-policy" data-form="persona-policy">
      <section class="policy-section"><div><h3>自动记录</h3><p>${persona.policy.updatedAt ? `更新于 ${formatDate(persona.policy.updatedAt)}` : "使用默认策略"}</p></div><label class="toggle"><input type="checkbox" name="enabled" ${persona.policy.enabled ? "checked" : ""}><span></span><strong>${persona.policy.enabled ? "启用" : "暂停"}</strong></label></section>
      <section class="policy-section policy-stack"><div><h3>允许的可信度</h3></div><div class="policy-options">${["explicit", "observed", "inferred"].map((confidence) => `<label class="check-row"><input type="checkbox" name="allowedConfidences" value="${confidence}" ${allowed.has(confidence) ? "checked" : ""}><span><strong>${escapeHtml(confidenceLabel(confidence))}</strong></span></label>`).join("")}</div></section>
      <section class="policy-section policy-stack"><div><h3>类别策略</h3><p>${blocked.size} 个类别已停止记录</p></div><div class="policy-category-grid">${categories.map((category) => `<label class="policy-category"><input type="checkbox" name="blockedCategories" value="${escapeHtml(category)}" ${blocked.has(category) ? "checked" : ""}><span><strong>${escapeHtml(personaCategoryLabel(category))}</strong><small>${escapeHtml(category)}</small></span></label>`).join("")}</div><div class="field full"><label for="customBlockedCategories">其他禁用类别</label><input id="customBlockedCategories" name="customBlockedCategories" type="text" value="${escapeHtml(customBlocked.join(", "))}"></div></section>
      <div class="form-actions"><button class="button" type="submit">${icon("save")}保存记录策略</button></div>
    </form>`;
  }

  function renderDevices(): string {
    return `
      ${sectionHeader("设备", `${snapshot.account.devices.length} 台已注册设备`, `<button class="button secondary" data-action="sync-device-control" type="button">${icon("refresh")}同步当前设备</button>`)}
      <div class="device-matrix">${snapshot.account.devices.map((device: any) => renderDeviceBlock(device, true)).join("")}</div>`;
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
      ${pageLead("密钥、设备、连接和 Agent 权限的当前状态")}
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
          <div class="link-row"><div><strong>密钥钱包密码</strong><small>查看或复制 API Key 时验证；模型切换不需要</small></div><button class="button secondary" data-action="change-wallet-password" type="button">修改密码</button></div>
          <div class="link-row"><div><strong>设备会话</strong><small>到期时间 ${formatDate(snapshot.profile.tokenExpiresAt)}</small></div><span class="current-device">当前设备</span></div>
        </section>
        <section class="panel">
          <div class="panel-title"><h3>安全边界</h3><span>${configuredProviders.length}/${snapshot.integrations.providers.length} PROVIDERS</span></div>
          <div class="link-row"><div><strong>恢复密钥</strong><small>不会进入 Dashboard response 或云端明文</small></div>${icon("key")}</div>
          <div class="link-row"><div><strong>OAuth Token</strong><small>Agent 只能调用已授权动作</small></div>${icon("shield")}</div>
          <div class="link-row"><div><strong>本机绝对路径</strong><small>保存在设备本地 workspace 数据库</small></div>${icon("database")}</div>
          <div class="link-row"><div><strong>原始会话记录</strong><small>默认留在 Agent 本机目录</small></div>${icon("terminal")}</div>
        </section>
      </div>
      <section class="panel mt-20">
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
    openModal("生成 Handoff 预览", '<div class="loading loading-compact"><span></span><p>正在采集 Git 状态并扫描 Secret</p></div>', true);
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

  function openWalletPasswordModal(
    sourceId: string,
    mode: "view" | "copy",
  ): void {
    const source = snapshot.status.deviceControl.sources[sourceId];
    if (!source) throw new Error("密钥配置已变化，请刷新后重试。");
    openModal(
      mode === "copy" ? "验证并复制密钥" : "验证并查看密钥",
      `<form data-form="wallet-reveal"><input type="hidden" name="sourceId" value="${escapeHtml(sourceId)}"><input type="hidden" name="mode" value="${mode}"><div class="form-grid"><div class="field full"><label for="walletPassword">钱包密码</label><input id="walletPassword" name="password" type="password" required autocomplete="current-password" inputmode="numeric"><small>${escapeHtml(source.label)} · 初始密码为 123456</small></div><p class="oauth-help full">密码只用于本次明文访问。切换密钥与模型无需输入钱包密码。</p></div>${modalActions(mode === "copy" ? "验证并复制" : "验证并查看")}</form>`,
    );
  }

  function openWalletPasswordChangeModal(): void {
    openModal(
      "修改密钥钱包密码",
      `<form data-form="wallet-password-change"><div class="form-grid"><div class="field full"><label for="currentWalletPassword">当前密码</label><input id="currentWalletPassword" name="currentPassword" type="password" required autocomplete="current-password"><small>首次修改时使用初始密码 123456。</small></div><div class="field"><label for="newWalletPassword">新密码</label><input id="newWalletPassword" name="newPassword" type="password" minlength="6" required autocomplete="new-password"></div><div class="field"><label for="confirmWalletPassword">确认新密码</label><input id="confirmWalletPassword" name="confirmPassword" type="password" minlength="6" required autocomplete="new-password"></div><p class="oauth-help full">新密码的 scrypt verifier 会随加密 Permission Vault 同步到账号设备。</p></div>${modalActions("更新密码")}</form>`,
    );
  }

  function openModelSourceModal(id?: string): void {
    const source = id ? snapshot.status.deviceControl.sources[id] : undefined;
    if (id && !source) throw new Error("密钥配置已变化，请刷新后重试。");
    const protocol = source?.protocol || "openai";
    const availableTools = supportedToolsForProtocol(protocol);
    const selectedTools = new Set<string>(
      source?.supportedTools || ["codex"],
    );
    const credentialStored = (snapshot.modelCredentialSources || []).some(
      (entry: any) => entry.sourceId === id,
    );
    openModal(
      source ? "编辑密钥配置" : "添加密钥配置",
      `<form data-form="model-source"><div class="form-grid">
        ${field("来源 ID", "id", source?.id || "", "text", "full", source ? "readonly" : 'required pattern="[A-Za-z0-9][A-Za-z0-9._:-]*"')}
        ${field("显示名称", "label", source?.label || "", "text", "full", "required")}
        <div class="field"><label for="kind">来源类型</label><select id="kind" name="kind">${["official-account", "official-api", "compatible-api", "local-service", "custom-endpoint"].map((kind) => `<option value="${kind}" ${kind === (source?.kind || "official-api") ? "selected" : ""}>${modelSourceKindLabel(kind)}</option>`).join("")}</select></div>
        <div class="field"><label for="protocol">API 协议</label><select id="protocol" name="protocol">${["openai", "anthropic", "ollama", "azure-openai", "custom"].map((protocol) => `<option value="${protocol}" ${protocol === (source?.protocol || "openai") ? "selected" : ""}>${modelProtocolLabel(protocol)}</option>`).join("")}</select></div>
        ${field("Endpoint", "endpoint", source?.endpoint || "", "url", "full", 'placeholder="https://api.example.com/v1"')}
        <div class="field full"><label>支持的 AI 工具</label><div class="capability-targets">${agentToolChoices(selectedTools, "supportedTools", availableTools)}</div></div>
        <div class="field full"><label for="apiKey">API Key</label><input id="apiKey" name="apiKey" type="password" autocomplete="new-password" placeholder="${credentialStored ? "已加密保存；留空继续使用" : "按来源类型填写"}"><small>API Key 进入端到端加密的账号钱包，不进入普通状态和 Agent 上下文。</small></div>
        ${credentialStored ? '<label class="check-row full"><input type="checkbox" name="clearCredential"><span><strong>清除钱包中的 API Key</strong></span></label>' : ""}
      </div>${modalActions()}</form>`,
    );
  }

  function openModelModal(id?: string): void {
    const model = id ? snapshot.status.deviceControl.models[id] : undefined;
    if (id && !model) throw new Error("模型已变化，请刷新后重试。");
    const sources = Object.values(snapshot.status.deviceControl.sources) as any[];
    if (sources.length === 0) throw new Error("请先添加模型来源。");
    const source = snapshot.status.deviceControl.sources[model?.sourceId] || sources[0];
    const selectedTools = new Set<string>(
      model?.supportedTools || source.supportedTools,
    );
    openModal(
      model ? "编辑模型" : "添加模型",
      `<form data-form="model"><div class="form-grid">
        ${field("模型记录 ID", "id", model?.id || "", "text", "full", model ? "readonly" : 'required pattern="[A-Za-z0-9][A-Za-z0-9._:-]*"')}
        <div class="field full"><label for="sourceId">模型来源</label><select id="sourceId" name="sourceId">${sources.map((entry: any) => `<option value="${escapeHtml(entry.id)}" ${entry.id === source.id ? "selected" : ""}>${escapeHtml(entry.label)} · ${escapeHtml(modelProtocolLabel(entry.protocol))}</option>`).join("")}</select></div>
        ${field("模型名称", "name", model?.name || "", "text", "full", "required")}
        ${field("模型 ID", "modelId", model?.modelId || "", "text", "full", "required")}
        <div class="field full"><label>支持的 AI 工具</label><div class="capability-targets">${agentToolChoices(selectedTools, "supportedTools", new Set(source.supportedTools))}</div></div>
      </div>${modalActions()}</form>`,
    );
  }

  function openModelConfigurationModal(
    requestedModelId?: string,
    initialTarget: { deviceId?: string; toolId?: string } = {},
  ): void {
    const control = snapshot.status.deviceControl;
    const allModels = Object.values(control.models) as any[];
    const compatibleModels = initialTarget.toolId
      ? allModels.filter((model: any) => model.supportedTools.includes(initialTarget.toolId))
      : allModels;
    if (compatibleModels.length === 0) throw new Error("没有可用于该 AI 工具的模型。");
    const selectedModel = compatibleModels.find((model: any) => model.id === requestedModelId) || compatibleModels[0];
    const targetGroups = snapshot.account.devices.map((device: any) => {
      const report = control.reports[device.id];
      const tools = report?.tools.filter((tool: any) => tool.installed) || [];
      const rows = tools.map((tool: any) => {
        const supportedModels = compatibleModels.filter((model: any) => model.supportedTools.includes(tool.toolId));
        if (supportedModels.length === 0) return "";
        const checked = device.id === initialTarget.deviceId && tool.toolId === initialTarget.toolId;
        const available = supportedModels.some((model: any) => model.id === selectedModel.id);
        return `<label class="configuration-target" data-model-target data-models="${escapeHtml(supportedModels.map((model: any) => model.id).join(","))}"><input type="checkbox" name="targets" value="${escapeHtml(device.id)}|${escapeHtml(tool.toolId)}" ${checked && available ? "checked" : ""} ${available ? "" : "disabled"}><span><strong>${escapeHtml(agentLabel(tool.toolId))}</strong><small>${escapeHtml(tool.currentModelId || "未配置")} · ${escapeHtml(toolHealthLabel(tool.health))}</small></span></label>`;
      }).join("");
      return rows ? `<fieldset class="configuration-device"><legend>${escapeHtml(device.name)} <span class="presence ${device.online || device.id === snapshot.profile.deviceId ? "online" : "offline"}"><i></i>${device.online || device.id === snapshot.profile.deviceId ? "在线" : "离线"}</span></legend>${rows}</fieldset>` : "";
    }).join("");
    openModal(
      "配置模型到设备",
      `<form data-form="model-configuration"><div class="form-grid"><div class="field full"><label for="configuration-model">模型</label><select id="configuration-model" name="modelId">${compatibleModels.map((model: any) => {
        const source = control.sources[model.sourceId];
        return `<option value="${escapeHtml(model.id)}" ${model.id === selectedModel.id ? "selected" : ""}>${escapeHtml(model.name)} · ${escapeHtml(source?.label || model.sourceId)}</option>`;
      }).join("")}</select></div><div class="field full"><label>目标设备与工具</label><div class="configuration-targets">${targetGroups || '<div class="empty"><p>没有可配置的已安装工具</p></div>'}</div></div></div>${modalActions("预览变更")}</form>`,
      true,
    );
  }

  function openModelConfigurationApprovalModal(): void {
    if (!pendingModelConfiguration) throw new Error("模型配置预览已失效。");
    const preview = pendingModelConfiguration;
    const changes = preview.changes.map((change: any) => `<tr><td><strong>${escapeHtml(change.deviceName)}</strong></td><td>${escapeHtml(agentLabel(change.toolId))}</td><td><code>${escapeHtml(change.previousModelId || "未配置")}</code></td><td><code>${escapeHtml(change.nextModelId)}</code></td><td><span class="intent-status intent-${change.execution === "immediate" ? "applying" : "pending"}">${change.execution === "immediate" ? "立即应用" : "设备上线后应用"}</span></td></tr>`).join("");
    const localPlans = preview.changes.filter((change: any) => change.localPlan).map((change: any) => {
      const plan = change.localPlan;
      const targets = plan.targets.map((target: any) => `<tr><td><code>${escapeHtml(target.path)}</code></td><td>${escapeHtml(target.purpose)}</td><td>${target.existed ? "更新" : "新建"}</td><td><code>${escapeHtml(fileModeLabel(target.beforeMode))} → ${escapeHtml(fileModeLabel(target.afterMode))}</code></td></tr>`).join("");
      const fieldChanges = plan.changes.map((entry: any) => `<tr><td><code>${escapeHtml(entry.path)}</code></td><td>${escapeHtml(configurationOperationLabel(entry.operation))}</td><td><code>${escapeHtml(entry.before === undefined ? "—" : formatValue(entry.before))}</code></td><td><code>${escapeHtml(entry.after === undefined ? "—" : formatValue(entry.after))}</code></td></tr>`).join("");
      return `<section class="approval-section mt-12"><div class="panel-title"><h3>${escapeHtml(change.deviceName)} · ${escapeHtml(agentLabel(change.toolId))}</h3><span>Plan ${escapeHtml(plan.planId.slice(5, 17))}</span></div><div class="table-wrap"><table><thead><tr><th>本机文件</th><th>用途</th><th>动作</th><th>权限</th></tr></thead><tbody>${targets}</tbody></table></div>${fieldChanges ? `<div class="table-wrap mt-12"><table><thead><tr><th>配置字段</th><th>动作</th><th>当前</th><th>变更后</th></tr></thead><tbody>${fieldChanges}</tbody></table></div>` : ""}${plan.warnings.length ? `<div class="scan-result blocked mt-12">${plan.warnings.map((warning: string) => `<p>${escapeHtml(warning)}</p>`).join("")}</div>` : ""}${plan.requiresRestart ? '<p class="oauth-help">应用后需要重启对应 AI 工具。</p>' : ""}</section>`;
    }).join("");
    const pendingFilePlans = preview.changes.some(
      (change: any) => change.execution === "pending" && !change.localPlan,
    )
      ? '<p class="oauth-help mt-12">离线设备会在上线后根据当时的本机配置生成原子写入计划；文件发生冲突时任务会失败并保留原配置。</p>'
      : "";
    openModal(
      "确认模型配置",
      `<form data-form="model-configuration-apply"><div class="configuration-summary"><div><span>模型</span><strong>${escapeHtml(preview.model.name)}</strong><small>${escapeHtml(preview.model.modelId)}</small></div><div><span>来源</span><strong>${escapeHtml(preview.source.label)}</strong><small>${escapeHtml(modelSourceKindLabel(preview.source.kind))}</small></div><div><span>预览有效期</span><strong>${formatDate(preview.expiresAt)}</strong></div></div><div class="table-wrap mt-12"><table><thead><tr><th>设备</th><th>AI 工具</th><th>当前</th><th>变更后</th><th>执行</th></tr></thead><tbody>${changes}</tbody></table></div>${localPlans}${pendingFilePlans}<label class="check-row mt-12"><input type="checkbox" name="confirmConfiguration"><span><strong>确认应用以上配置</strong><small>写入失败时设备后台会恢复原配置并报告结果。</small></span></label>${modalActions("确认应用")}</form>`,
      true,
    );
  }

  function openPersonaEventModal(id: string): void {
    const entry = snapshot.status.persona.events.find((event: any) => event.id === id);
    if (!entry) throw new Error("观察记录已变化，请刷新后重试。");
    const sources = entry.observations.map((observation: any) => `${agentLabel(observation.sourceAgent)}${observation.sourceProject ? ` · ${observation.sourceProject}` : ""} · ${formatDate(observation.observedAt)} · ${confidenceLabel(observation.confidence)}`).join("\n");
    openModal(
      "编辑观察记录",
      `<form data-form="persona-event"><input type="hidden" name="id" value="${escapeHtml(entry.id)}"><div class="form-grid">${field("类别", "category", entry.category, "text", "full", 'required pattern="[a-z][a-z0-9_]*"')}${textareaField("内容", "content", entry.content)}<div class="field full"><label for="confidence">可信度</label><select id="confidence" name="confidence">${["explicit", "observed", "inferred"].map((confidence) => `<option value="${confidence}" ${confidence === entry.confidence ? "selected" : ""}>${confidenceLabel(confidence)}</option>`).join("")}</select></div><div class="field full"><label>观察来源</label><pre class="handoff-markdown">${escapeHtml(sources)}</pre><small>${entry.observationCount} 次观察 · 首次 ${formatDate(entry.observedAt)} · 最近 ${formatDate(entry.lastObservedAt)}</small></div></div>${modalActions()}</form>`,
      true,
    );
  }

  function openCapabilityModal(packId: string): void {
    const entry = (snapshot.capabilityPacks || []).find(
      (candidate: any) => candidate.manifest.name === packId,
    );
    if (!entry) throw new Error("连接能力不存在。");
    const pack = entry.manifest;
    const installation = snapshot.status.capabilities?.installations?.[packId];
    const selected = new Set(installation?.targets || []);
    const targets = [
      { id: "chatgpt", adapter: "chatgpt-plugin", label: "ChatGPT", detail: "安装意图 · 平台输出开发中" },
      { id: "codex", adapter: "codex-plugin", label: "Codex", detail: "Plugin + Skill + MCP" },
      { id: "claude-code", adapter: "claude-skill", label: "Claude Code", detail: "Skill + MCP" },
      { id: "cursor", adapter: "cursor-rules", label: "Cursor", detail: "Rules + MCP manifest" },
      { id: "markdown", adapter: "markdown", label: "Markdown", detail: "Context 文件" },
      { id: "sdk", adapter: "one-status-sdk", label: "One Status SDK", detail: "安装意图 · SDK 接入目标" },
    ].filter((target) => pack.adapters.includes(target.adapter));
    const targetRows = targets.map((target) => `<label class="capability-target"><input type="checkbox" name="targets" value="${target.id}" ${selected.has(target.id) ? "checked" : ""}><span><strong>${target.label}</strong><small>${target.detail}</small></span></label>`).join("");
    const writeActions = pack.tools.filter((tool: any) => tool.readOnly === false);
    openModal(
      capabilityDisplayName(pack),
      `<form data-form="capability"><input type="hidden" name="packId" value="${escapeHtml(packId)}"><div class="form-grid"><div class="field full"><label>目标 Agent</label><div class="capability-targets">${targetRows}</div></div><label class="check-row full"><input type="checkbox" name="enabled" ${installation?.enabled === false ? "" : "checked"}><span><strong>启用这项连接能力</strong><small>同步全部 Agent 的安装意图；Codex、Claude Code 与 Markdown 会先展示本机写入预览</small></span></label><div class="field full"><label>Gateway Actions</label><div class="tag-list">${pack.tools.map((tool: any) => `<span class="tag">${escapeHtml(tool.id)}${tool.readOnly === false ? " · 确认" : ""}</span>`).join("")}</div><small>${writeActions.length} 个写操作需要明确确认；Provider Token 留在 Permission Vault。</small></div></div>${modalActions("保存目标")}</form>`,
    );
  }

  function openCapabilityApprovalModal(): void {
    if (!pendingCapabilityInstall) throw new Error("安装预览已失效。");
    const sections = pendingCapabilityInstall.plans.map((plan: any) => {
      const changed = plan.preview.files.filter(
        (file: any) => file.disposition !== "unchanged",
      );
      const rows = changed.map((file: any) => `<tr><td><code>${escapeHtml(file.relativePath)}</code></td><td>${file.disposition === "create" ? "新建" : file.disposition === "update" ? "更新" : "阻止"}</td></tr>`).concat((plan.removals || []).map((file: any) => `<tr><td><code>${escapeHtml(file.relativePath)}</code></td><td>清理旧文件</td></tr>`)).join("");
      const commands = plan.commands.map((command: any) => `<code>${escapeHtml([command.command, ...command.args].join(" "))}</code>`).join("<br>");
      return `<section class="approval-section"><div class="panel-title"><h3>${escapeHtml(capabilityTargetLabel(plan.target))}</h3><span>${plan.preview.creates} 新建 · ${plan.preview.updates} 更新 · ${(plan.removals || []).length} 清理</span></div><p><code>${escapeHtml(plan.root)}</code></p>${rows ? `<div class="table-wrap"><table><thead><tr><th>文件</th><th>变化</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="oauth-help">本机文件已经与当前编译结果一致。</p>'}${commands ? `<div class="field full mt-12"><label>平台注册命令</label>${commands}</div>` : ""}</section>`;
    }).join("");
    openModal(
      "确认安装连接能力",
      `<form data-form="capability-apply">${sections}<label class="check-row mt-12"><input type="checkbox" name="confirmInstall"><span><strong>确认写入以上文件并执行列出的注册命令</strong><small>安装器会重新验证摘要和路径，变化后会中止。</small></span></label>${modalActions("确认安装")}</form>`,
    );
  }

  async function saveCapabilityIntent(
    packId: string,
    targets: string[],
    enabled: boolean,
  ): Promise<void> {
    await api(`/v1/dashboard/capabilities/${encodeURIComponent(packId)}`, {
      method: "PUT",
      body: { targets, enabled },
    });
  }

  function openProviderModal(providerId: string): void {
    const provider = snapshot.integrations.providers.find((entry: any) => entry.id === providerId);
    const secretAttributes = provider.configured
      ? 'autocomplete="new-password" placeholder="已保存；留空继续使用"'
      : 'required autocomplete="new-password" placeholder="首次配置必须填写"';
    const secretField = provider.requiresSecret
      ? `<div class="field full"><label for="clientSecret">Client Secret</label><input id="clientSecret" name="clientSecret" type="password" ${secretAttributes}><small>${provider.configured ? "Secret 已加密保存。留空提交时继续使用现有值。" : "Secret 只写入本机 Permission Vault，页面不会再次显示。"}</small></div>`
      : `<p class="oauth-help full">${provider.authMode === "token" ? "该服务使用 API key 与用户 Token；API key 在这里保存，用户 Token 在连接时单独导入。" : "该服务使用 PKCE public client，只需填写 Client ID，无需 Client Secret。"}</p>`;
    const pkceHint = provider.authMode === "token"
      ? "Token 连接会先调用 Provider API 验证账号，再加密写入 Permission Vault。"
      : provider.requiresPkce
      ? "授权时启用 PKCE，授权码只能由发起流程的本机兑换。"
      : "授权码由本机 Permission Vault 中的 Client Secret 兑换。";
    const callbackField = provider.authMode === "token" ? "" : `<div class="field full"><label>OAuth Callback URL</label><div class="callback"><code>${escapeHtml(provider.callbackUrl)}</code><button class="icon-button" data-action="copy-callback" data-value="${escapeHtml(provider.callbackUrl)}" type="button" title="复制 Callback URL" aria-label="复制 Callback URL">${icon("copy")}</button></div><small>${escapeHtml(providerCallbackInstruction(provider.id))}</small></div>`;
    const clientIdLabel = provider.authMode === "token" ? "API Key" : "Client ID";
    openModal(`配置 ${provider.label}`, `<form data-form="provider"><input type="hidden" name="provider" value="${escapeHtml(provider.id)}"><div class="form-grid">${field(clientIdLabel, "clientId", provider.clientId || "", "text", "full", 'required autocomplete="off"')}${secretField}${callbackField}<p class="oauth-help full">${escapeHtml(pkceHint)} 保存配置后，每个 Agent 的可调用操作仍需单独勾选。</p></div>${modalActions()}</form>`);
  }

  function openTokenConnectionModal(providerId: string): void {
    const provider = snapshot.integrations.providers.find((entry: any) => entry.id === providerId);
    openModal(`连接 ${provider.label}`, `<form data-form="provider-token"><input type="hidden" name="provider" value="${escapeHtml(provider.id)}"><div class="form-grid"><div class="field full"><label for="accessToken">${escapeHtml(provider.id === "trello" ? "Trello user Token" : "Access Token")}</label><input id="accessToken" name="accessToken" type="password" required autocomplete="new-password"><small>Token 只进入本机加密 Permission Vault，验证完成后不会返回页面。</small></div><p class="oauth-help full">One Status 会读取当前服务账号确认 Token 有效；导入后由 Agent Permission Firewall 控制每项 action。</p></div>${modalActions("验证并连接")}</form>`);
  }

  function openGrantModal(connectionId: string, agentId: string): void {
    const connection = snapshot.integrations.connections.find((entry: any) => entry.id === connectionId);
    const provider = snapshot.integrations.providers.find((entry: any) => entry.id === connection.provider);
    const grant = snapshot.integrations.grants.find((entry: any) => entry.connectionId === connectionId && entry.agentId === agentId);
    const selected = new Set(grant?.actions || []);
    const grantedScopes = new Set(connection.scopes || []);
    const availableActions = provider.actions.filter((action: any) =>
      action.requiredScopes.every((scope: string) => grantedScopes.has(scope)),
    );
    const availableSelected = availableActions.filter((action: any) =>
      selected.has(action.id),
    ).length;
    const actionRows = provider.actions.map((action: any) => {
      const hasScopes = action.requiredScopes.every((scope: string) => grantedScopes.has(scope));
      const risk = action.requiresConfirmation
        ? '<span class="tag write-risk">写入 · 每次确认</span>'
        : '<span class="tag">只读</span>';
      const scope = hasScopes
        ? ""
        : '<span class="tag scope-missing">缺少 scope · 重新授权</span>';
      return `<label class="check-row"><input type="checkbox" name="actions" value="${escapeHtml(action.id)}" ${selected.has(action.id) && hasScopes ? "checked" : ""} ${hasScopes ? "" : "disabled"}><span><strong>${escapeHtml(action.title)}</strong><small>${escapeHtml(action.description)}</small><span class="action-meta">${risk}${scope}</span></span></label>`;
    }).join("");
    openModal(`${agentLabel(agentId)} 权限`, `<form data-form="grant"><input type="hidden" name="connectionId" value="${escapeHtml(connectionId)}"><input type="hidden" name="agentId" value="${escapeHtml(agentId)}"><div class="permission-toolbar"><span data-grant-summary aria-live="polite">已允许 ${availableSelected}/${availableActions.length} 项可用操作</span><div><button class="button secondary" data-action="set-grant-selection" data-value="all" type="button">全选</button><button class="button secondary" data-action="set-grant-selection" data-value="none" type="button">清空</button></div></div><div class="check-list">${actionRows}</div>${modalActions("保存权限")}</form>`);
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
    const selected = form.querySelectorAll<HTMLInputElement>('input[name="actions"]:checked:not(:disabled)').length;
    const total = form.querySelectorAll<HTMLInputElement>('input[name="actions"]:not(:disabled)').length;
    const summary = form.querySelector<HTMLElement>("[data-grant-summary]");
    if (summary) summary.textContent = `已允许 ${selected}/${total} 项可用操作`;
  }

  function metric(iconName: string, label: string, value: unknown, detail: string): string {
    return `<article class="metric"><div class="metric-top"><span>${label}</span><span class="metric-icon">${icon(iconName)}</span></div><strong>${escapeHtml(String(value))}</strong><small>${escapeHtml(detail)}</small></article>`;
  }
  function sectionHeader(heading: string, description: string, action = ""): string {
    return `<div class="section-header"><div><h2>${heading}</h2><p>${description}</p></div>${action}</div>`;
  }
  function pageLead(description: string, action = ""): string {
    return `<div class="section-header page-lead"><p>${description}</p>${action}</div>`;
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
    return icon(provider === "google" ? "calendar" : provider === "github" ? "github" : provider === "slack" ? "slack" : "integrations");
  }
  function providerLabel(provider: string): string {
    return snapshot.integrations.providers.find((entry: any) => entry.id === provider)?.label || (provider ? provider : "无需授权");
  }
  function providerCallbackInstruction(provider: string): string {
    if (provider === "google") return "填入 Google Cloud Console 的 Authorized redirect URIs。";
    if (provider === "github") return "填入 GitHub OAuth App 的 Authorization callback URL。";
    if (provider === "slack") return "填入 Slack App → OAuth & Permissions → Redirect URLs。";
    return "填入该 Provider Developer Console 的 OAuth redirect URL。";
  }
  function agentLabel(agentId: string): string {
    return agentId === "claude-code" ? "Claude Code" : agentId === "codex" ? "Codex" : agentId;
  }
  function agentToolChoices(
    selected: Set<string>,
    name: string,
    available = new Set(["codex", "claude-code", "cursor"]),
  ): string {
    return ["codex", "claude-code", "cursor"].map((tool) =>
      `<label class="capability-target"><input type="checkbox" name="${name}" value="${tool}" ${selected.has(tool) ? "checked" : ""} ${available.has(tool) ? "" : "disabled"}><span><strong>${agentLabel(tool)}</strong></span></label>`,
    ).join("");
  }
  function renderToolTags(tools: string[]): string {
    return `<div class="tag-list">${tools.map((tool) => `<span class="tag">${escapeHtml(agentLabel(tool))}</span>`).join("")}</div>`;
  }
  function latestConfigurationIntent(deviceId: string, toolId: string): any {
    return (Object.values(snapshot.status.deviceControl.intents) as any[])
      .filter((intent: any) => intent.deviceId === deviceId && intent.toolId === toolId)
      .sort((left: any, right: any) => right.updatedAt.localeCompare(left.updatedAt))[0];
  }
  function updateModelTargetAvailability(form: HTMLFormElement, modelId: string): void {
    form.querySelectorAll<HTMLElement>("[data-model-target]").forEach((row) => {
      const supported = (row.dataset.models || "").split(",").includes(modelId);
      const checkbox = row.querySelector<HTMLInputElement>('input[name="targets"]');
      row.classList.toggle("disabled", !supported);
      if (!checkbox) return;
      checkbox.disabled = !supported;
      if (!supported) checkbox.checked = false;
    });
  }
  function supportedToolsForProtocol(protocol: string): Set<string> {
    if (protocol === "anthropic") return new Set(["claude-code", "cursor"]);
    if (protocol === "custom") {
      return new Set(["codex", "claude-code", "cursor"]);
    }
    return new Set(["codex", "cursor"]);
  }
  function updateSourceToolAvailability(
    form: HTMLFormElement,
    protocol: string,
  ): void {
    const available = supportedToolsForProtocol(protocol);
    form
      .querySelectorAll<HTMLInputElement>('input[name="supportedTools"]')
      .forEach((checkbox) => {
        checkbox.disabled = !available.has(checkbox.value);
        if (checkbox.disabled) checkbox.checked = false;
      });
  }
  function endpointHost(value?: string): string {
    if (!value) return "";
    try {
      return new URL(value).host;
    } catch {
      return value;
    }
  }
  function modelUsageSummary(model: any): {
    detail: string;
    primary: string;
    updatedAt?: string;
  } {
    const control = snapshot.status.deviceControl;
    const usageCollection = snapshot.modelUsage || control.usage || {};
    const collectedEntries = Array.isArray(usageCollection)
      ? usageCollection
      : Array.isArray(usageCollection.entries)
        ? usageCollection.entries
        : [];
    const directEntries = collectedEntries.filter((entry: any) =>
      [model.id, model.modelId].includes(entry.modelId) ||
      entry.modelRef === model.id ||
      entry.id === model.id,
    );
    const syncedEntries = Object.entries(control.reports).flatMap(
      ([deviceId, report]: [string, any]) =>
        (report.modelUsage?.entries || []).map((entry: any) => ({
          ...entry,
          deviceId,
        })),
    ).filter((entry: any) =>
      [model.id, model.modelId].includes(entry.modelId) ||
      entry.modelRef === model.id ||
      entry.id === model.id,
    );
    const syncedFallback = directEntries.length
      ? syncedEntries.filter(
          (entry: any) => entry.deviceId !== snapshot.profile.deviceId,
        )
      : syncedEntries;
    const direct = Array.isArray(usageCollection)
      ? undefined
      : usageCollection[model.id] || usageCollection[model.modelId];
    const reported = (Object.values(control.reports) as any[])
      .flatMap((report: any) => report.tools || [])
      .filter((tool: any) =>
        tool.currentModelRef === model.id || tool.currentModelId === model.modelId,
      )
      .map((tool: any) => tool.usage || tool.modelUsage)
      .filter(Boolean);
    const entries = directEntries.length || syncedFallback.length
      ? [...directEntries, ...syncedFallback]
      : direct
        ? [direct]
        : model.usage
          ? [model.usage]
          : reported;
    if (entries.length === 0) {
      return { primary: "尚无用量", detail: "等待本机会话扫描" };
    }
    const input = sumUsage(entries, ["inputTokens", "input_tokens", "input"]);
    const output = sumUsage(entries, ["outputTokens", "output_tokens", "output"]);
    const cached = sumUsage(entries, ["cachedInputTokens", "cacheReadTokens", "cached_tokens"]);
    const cacheCreated = sumUsage(entries, ["cacheCreationInputTokens"]);
    const explicitTotal = sumUsage(entries, ["totalTokens", "total_tokens", "tokens"]);
    const total = explicitTotal || input + output;
    const requests = sumUsage(entries, ["requests", "requestCount", "sessions"]);
    const costUsd = sumUsage(entries, ["costUsd", "cost_usd", "estimatedCostUsd"]);
    const details = [
      input ? `输入 ${formatCompactNumber(input)}` : "",
      output ? `输出 ${formatCompactNumber(output)}` : "",
      cached ? `缓存 ${formatCompactNumber(cached)}` : "",
      cacheCreated ? `缓存写入 ${formatCompactNumber(cacheCreated)}` : "",
      requests ? `${formatCompactNumber(requests)} 次调用` : "",
      costUsd ? `$${costUsd.toFixed(costUsd < 1 ? 4 : 2)}` : "",
    ].filter(Boolean);
    const updatedAt = entries
      .map((entry: any) => entry.latestAt || entry.updatedAt || entry.scannedAt || entry.observedAt)
      .filter(Boolean)
      .sort()
      .at(-1);
    return {
      primary: total ? `${formatCompactNumber(total)} tokens` : "0 tokens",
      detail: details.join(" · ") || "已完成本地统计",
      ...(updatedAt ? { updatedAt } : {}),
    };
  }
  function sumUsage(entries: any[], keys: string[]): number {
    return entries.reduce((total, entry) => {
      const value = keys.map((key) => entry?.[key]).find(Number.isFinite);
      return total + (typeof value === "number" ? value : 0);
    }, 0);
  }
  function formatCompactNumber(value: number): string {
    return new Intl.NumberFormat("zh-CN", {
      maximumFractionDigits: value >= 1_000 ? 1 : 0,
      notation: value >= 1_000 ? "compact" : "standard",
    }).format(value);
  }
  function revealedModelCredential(result: any): string {
    const value =
      result?.apiKey ??
      result?.secret ??
      result?.credential?.apiKey ??
      result?.credential;
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("钱包未返回可查看的 API Key。");
    }
    return value;
  }
  function operatingSystemLabel(value: string): string {
    if (value === "macos") return "macOS";
    if (value === "windows") return "Windows";
    if (value === "linux") return "Linux";
    return "Other OS";
  }
  function modelSourceKindLabel(value?: string): string {
    if (value === "official-account") return "官方账号";
    if (value === "official-api") return "官方 API";
    if (value === "compatible-api") return "第三方兼容 API";
    if (value === "local-service") return "本地模型服务";
    if (value === "custom-endpoint") return "自定义 Endpoint";
    return value || "来源未知";
  }
  function modelProtocolLabel(value: string): string {
    if (value === "openai") return "OpenAI";
    if (value === "anthropic") return "Anthropic";
    if (value === "ollama") return "Ollama";
    if (value === "azure-openai") return "Azure OpenAI";
    return value === "custom" ? "Custom" : value;
  }
  function fileModeLabel(value?: number): string {
    return value === undefined ? "—" : `0${value.toString(8).padStart(3, "0")}`;
  }
  function configurationOperationLabel(value: string): string {
    if (value === "add") return "新增";
    if (value === "remove") return "移除";
    return "更新";
  }
  function credentialStatusLabel(value: string): string {
    if (value === "available") return "可用";
    if (value === "missing") return "缺失";
    if (value === "not-required") return "无需 Credential";
    return "未验证";
  }
  function toolHealthLabel(value: string): string {
    if (value === "healthy") return "正常";
    if (value === "unconfigured") return "未配置";
    if (value === "pending") return "待应用";
    if (value === "applying") return "应用中";
    if (value === "applied") return "已应用";
    if (value === "failed") return "失败";
    if (value === "rollback") return "已回滚";
    if (value === "error") return "配置异常";
    return "状态未知";
  }
  function intentStatusLabel(value: string): string {
    return toolHealthLabel(value);
  }
  function confidenceLabel(value: string): string {
    if (value === "explicit") return "明确陈述";
    if (value === "observed") return "重复观察";
    return "谨慎推断";
  }
  function defaultPersonaCategories(): string[] {
    return [
      "personality",
      "behavior_preference",
      "language_style",
      "output_style",
      "project_work_habit",
      "technical_habit",
      "long_term_goal",
      "future_plan",
      "personal_info",
    ];
  }
  function personaPolicyCategories(persona: any): string[] {
    return [...new Set([
      ...defaultPersonaCategories(),
      ...persona.events.map((event: any) => event.category),
      ...persona.policy.blockedCategories,
    ])].sort((left, right) => String(left).localeCompare(String(right))) as string[];
  }
  function personaCategoryLabel(value: string): string {
    const labels: Record<string, string> = {
      personality: "性格",
      behavior_preference: "行为偏好",
      language_style: "语言风格",
      output_style: "输出风格",
      project_work_habit: "项目习惯",
      technical_habit: "技术习惯",
      long_term_goal: "长期目标",
      future_plan: "未来规划",
      personal_info: "个人信息",
    };
    return labels[value] || value;
  }
  function capabilityTargetLabel(target: string): string {
    if (target === "chatgpt") return "ChatGPT";
    if (target === "claude-code") return "Claude Code";
    if (target === "cursor") return "Cursor";
    if (target === "markdown") return "Markdown";
    if (target === "sdk") return "SDK";
    return target === "codex" ? "Codex" : target;
  }
  function capabilityDisplayName(pack: any): string {
    return pack.name === "persona" ? "记忆生成" : pack.displayName;
  }
  function capabilityDescription(pack: any): string {
    return pack.name === "persona"
      ? "持续识别用户习惯、表达风格、工作方式、目标与规划，并生成可追溯的结构化记忆。"
      : pack.description;
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
