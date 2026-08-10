const releaseFallback = {
  tag_name: "v0.8.0",
  assets: [],
  html_url: "https://github.com/niyuxuan782/one-status/releases/latest",
  macos_notarized: false,
};

const assetRules = {
  "download-mac-arm": /One-Status-.*-mac-arm64\.dmg$/i,
  "download-mac-intel": /One-Status-.*-mac-x64\.dmg$/i,
  "download-windows": /One-Status-Setup-.*-x64\.exe$/i,
  "download-linux": /One-Status-.*-linux-x64\.AppImage$/i,
};

async function loadRelease() {
  let release = releaseFallback;
  try {
    const response = await fetch("./release.json?v=0.8.0-20260811", {
      headers: { Accept: "application/json" },
    });
    if (response.ok) release = await response.json();
  } catch {
    // Static fallback keeps every download pointed at the Releases page.
  }

  const label = document.querySelector("#release-label");
  if (label) label.textContent = release.tag_name || releaseFallback.tag_name;
  updateMacReleaseStatus(release);
  for (const [id, pattern] of Object.entries(assetRules)) {
    const link = document.querySelector(`#${id}`);
    if (!link) continue;
    const asset = (release.assets || []).find((candidate) =>
      pattern.test(candidate.name || ""),
    );
    link.href = asset?.browser_download_url || release.html_url;
    if (!asset) link.dataset.pending = "true";
  }
}

function updateMacReleaseStatus(release) {
  const notarized = release.macos_notarized === true;
  const tag = release.tag_name || releaseFallback.tag_name;
  const title = document.querySelector("#mac-release-title");
  const note = document.querySelector("#mac-release-note");
  if (title) {
    title.textContent = notarized
      ? "macOS Developer ID 与 Apple 公证"
      : `${tag} macOS 旧版预览`;
  }
  if (note) {
    note.textContent = notarized
      ? "该 Release 已通过 Developer ID、Apple notarization、stapled ticket 与 Gatekeeper 校验。"
      : "该 Release 尚未完成 Apple 公证，macOS 可能显示开发者或安全警告。新的发布流水线会拒绝上传未签名或未公证的包。";
  }
  for (const id of ["download-mac-arm", "download-mac-intel"]) {
    const status = document.querySelector(`#${id} [data-mac-release-status]`);
    if (status) {
      status.textContent = notarized
        ? ".dmg · Developer ID + 公证"
        : ".dmg · 未公证旧版";
    }
  }
}

function installTabs() {
  const tabs = [...document.querySelectorAll("[data-install-tab]")];
  const panels = [...document.querySelectorAll("[data-install-panel]")];

  function activateTab(tab) {
    const selected = tab.dataset.installTab;
    for (const candidate of tabs) {
      const active = candidate === tab;
      candidate.classList.toggle("active", active);
      candidate.setAttribute("aria-selected", String(active));
      candidate.tabIndex = active ? 0 : -1;
    }
    for (const panel of panels) {
      const active = panel.dataset.installPanel === selected;
      panel.classList.toggle("active", active);
      panel.hidden = !active;
    }
  }

  for (const tab of tabs) {
    tab.addEventListener("click", () => activateTab(tab));
    tab.addEventListener("keydown", (event) => {
      const current = tabs.indexOf(tab);
      let next = current;
      if (event.key === "ArrowRight") next = (current + 1) % tabs.length;
      else if (event.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else return;

      event.preventDefault();
      tabs[next].focus();
      activateTab(tabs[next]);
    });
  }
}

function copyButtons() {
  const toast = document.querySelector(".toast");
  let toastTimer;
  for (const button of document.querySelectorAll("[data-copy]")) {
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copy || "");
        button.textContent = "已复制";
        if (toast) {
          toast.hidden = false;
          clearTimeout(toastTimer);
          toastTimer = setTimeout(() => { toast.hidden = true; }, 1600);
        }
        setTimeout(() => { button.textContent = "复制"; }, 1600);
      } catch {
        button.textContent = "请手动复制";
      }
    });
  }
}

loadRelease();
installTabs();
copyButtons();
