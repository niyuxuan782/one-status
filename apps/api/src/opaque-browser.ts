import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

declare const __ONE_STATUS_OPAQUE_BROWSER_BUNDLE__: string | undefined;

const opaqueRequire = createRequire(
  new URL("../../../packages/pake/package.json", import.meta.url),
);
let cachedOpaqueBundle: string | undefined;

export function opaqueBrowserBundle(): string {
  if (cachedOpaqueBundle) return cachedOpaqueBundle;
  if (
    typeof __ONE_STATUS_OPAQUE_BROWSER_BUNDLE__ === "string" &&
    __ONE_STATUS_OPAQUE_BROWSER_BUNDLE__.length > 0
  ) {
    cachedOpaqueBundle = __ONE_STATUS_OPAQUE_BROWSER_BUNDLE__;
    return cachedOpaqueBundle;
  }
  const path = opaqueRequire.resolve("@serenity-kit/opaque/esm/index.js");
  cachedOpaqueBundle = readFileSync(path, "utf8");
  return cachedOpaqueBundle;
}

export function opaqueAuthorizationBrowserScript(): string {
  return `import * as opaque from "/v1/auth/opaque-client.js";
await opaque.ready;
const form = document.querySelector("form[data-opaque-authorization]");
const email = document.querySelector("#one-status-email");
const password = document.querySelector("#one-status-password");
const proof = document.querySelector("input[name=accountProof]");
const decision = document.querySelector("input[name=decision]");
const error = document.querySelector("[data-opaque-error]");
const buttons = [...form.querySelectorAll("button[data-decision]")];
const message = (value) => {
  error.textContent = value;
  error.hidden = !value;
};
const json = async (response) => {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message || "Authentication failed.");
  return body;
};
const setBusy = (busy) => {
  for (const button of buttons) button.disabled = busy;
  email.disabled = busy;
  password.disabled = busy;
};
for (const button of buttons) {
  button.addEventListener("click", async () => {
    decision.value = button.dataset.decision;
    if (decision.value === "deny") {
      password.value = "";
      form.submit();
      return;
    }
    message("");
    setBusy(true);
    try {
      const started = opaque.client.startLogin({ password: password.value });
      const challenge = await json(await fetch("/v1/auth/opaque/proof/start", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: email.value,
          purpose: "oauth-authorize",
          startLoginRequest: started.startLoginRequest,
        }),
      }));
      const finished = opaque.client.finishLogin({
        clientLoginState: started.clientLoginState,
        keyStretching: challenge.profile.keyStretching,
        loginResponse: challenge.loginResponse,
        password: password.value,
      });
      if (!finished || finished.serverStaticPublicKey !== challenge.serverPublicKey) {
        throw new Error("Invalid email or password.");
      }
      const verified = await json(await fetch("/v1/auth/opaque/proof/finish", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          finishLoginRequest: finished.finishLoginRequest,
          flowId: challenge.flowId,
        }),
      }));
      proof.value = verified.proofToken;
      password.value = "";
      form.submit();
    } catch {
      password.value = "";
      message("Invalid email or password.");
      setBusy(false);
      password.focus();
    }
  });
}
`;
}
