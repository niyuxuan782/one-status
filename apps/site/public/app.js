const releaseFallback = {
  tag_name: "v0.5.0",
  assets: [],
  html_url: "https://github.com/niyuxuan782/one-status/releases/latest",
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
    const response = await fetch("./release.json", {
      headers: { Accept: "application/json" },
    });
    if (response.ok) release = await response.json();
  } catch {
    // Static fallback keeps every download pointed at the Releases page.
  }

  const label = document.querySelector("#release-label");
  if (label) label.textContent = release.tag_name || releaseFallback.tag_name;
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

function installTabs() {
  const tabs = [...document.querySelectorAll("[data-install-tab]")];
  const panels = [...document.querySelectorAll("[data-install-panel]")];
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      const selected = tab.dataset.installTab;
      for (const candidate of tabs) {
        const active = candidate === tab;
        candidate.classList.toggle("active", active);
        candidate.setAttribute("aria-selected", String(active));
      }
      for (const panel of panels) {
        const active = panel.dataset.installPanel === selected;
        panel.classList.toggle("active", active);
        panel.hidden = !active;
      }
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
