/* EWS Bridge — settings page. */
"use strict";

const $ = sel => document.querySelector(sel);
const send = async msg => {
  const r = await browser.runtime.sendMessage(msg);
  if (r && r.error) {
    throw new Error(r.error);
  }
  return r;
};

let lastTest = null;
let lastParams = null;

async function refresh() {
  const s = await send({ type: "getState" });
  const err = $("#startup-error");
  err.hidden = !s.error;
  err.textContent = s.error ? `The gateway failed to start: ${s.error}` : "";
  const list = $("#accounts");
  list.textContent = "";
  if (!s.accounts.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "No Exchange account configured yet.";
    list.append(p);
  }
  for (const a of s.accounts) {
    const node = $("#account-tpl").content.cloneNode(true);
    node.querySelector(".acc-email").textContent = a.email;
    node.querySelector(".acc-url").textContent = `${a.ewsUrl} · ${a.username}`;
    const status = node.querySelector(".acc-status");
    node.querySelector(".check-btn").addEventListener("click", async () => {
      status.className = "acc-status muted";
      status.textContent = "Checking…";
      try {
        const r = await send({ type: "checkAccount", key: a.key });
        status.className = "acc-status ok";
        status.textContent = `Connected — ${r.inbox}: ${r.unread} unread · Exchange ${r.serverVersion || ""}`;
      } catch (e) {
        status.className = "acc-status fail";
        status.textContent = e.message;
      }
    });
    node.querySelector(".pw-btn").addEventListener("click", async () => {
      const pw = prompt(`New Exchange password for ${a.email}:`);
      if (!pw) {
        return;
      }
      try {
        await send({ type: "updatePassword", params: { key: a.key, password: pw } });
        status.className = "acc-status ok";
        status.textContent = "Password updated and verified.";
      } catch (e) {
        status.className = "acc-status fail";
        status.textContent = e.message;
      }
    });
    node.querySelector(".remove-btn").addEventListener("click", async () => {
      if (!confirm(`Remove ${a.email} from Thunderbird? Local copies of its mail, the calendar and the address book are removed. Nothing is deleted on the Exchange server.`)) {
        return;
      }
      await send({ type: "removeAccount", params: { key: a.key } });
      refresh();
    });
    list.append(node);
  }
  const st = s.status;
  $("#ports").textContent = st
    ? `Local gateway: IMAP 127.0.0.1:${st.ports.imap} · SMTP 127.0.0.1:${st.ports.smtp} · CalDAV/CardDAV http://127.0.0.1:${st.ports.dav} · ${st.sessions} open connection(s)`
    : "Gateway not running.";
  $("#log-level").value = s.logLevel;
  $("#log").textContent = s.log.join("\n");
}

function renderAttempts(attempts) {
  const ul = $("#attempts");
  ul.textContent = "";
  for (const a of attempts) {
    const li = document.createElement("li");
    li.textContent = a;
    li.className = a.startsWith("✓") ? "ok" : a.startsWith("✗") ? "fail" : "";
    ul.append(li);
  }
}

$("#add-form").addEventListener("submit", async ev => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  lastParams = Object.fromEntries(f.entries());
  $("#test-btn").disabled = true;
  $("#test-status").textContent = "Connecting… this can take a moment";
  $("#test-result").hidden = true;
  try {
    const r = await send({ type: "testConnection", params: lastParams });
    lastTest = r;
    $("#test-result").hidden = false;
    renderAttempts(r.attempts);
    $("#found").hidden = !r.ok;
    $("#hint").hidden = r.ok;
    if (r.ok) {
      $("#f-name").textContent = r.displayName;
      $("#f-url").textContent = r.ewsUrl;
      $("#f-user").textContent = r.username;
      $("#f-server").textContent = `Exchange ${r.serverVersion || "?"} (schema ${r.schema}${r.authScheme ? `, ${r.authScheme}` : ""})`;
      $("#test-status").textContent = "";
    } else {
      $("#hint").textContent = r.hint;
      $("#test-status").textContent = "";
      if (!$("#advanced").open) {
        $("#advanced").open = true;
      }
    }
  } catch (e) {
    $("#test-status").textContent = e.message;
  } finally {
    $("#test-btn").disabled = false;
  }
});

$("#add-btn").addEventListener("click", async () => {
  if (!lastTest?.ok) {
    return;
  }
  $("#add-btn").disabled = true;
  $("#add-status").textContent = "Setting up mail, calendar and contacts…";
  try {
    await send({
      type: "addAccount",
      params: {
        email: lastParams.email,
        password: lastParams.password,
        username: lastTest.username,
        ewsUrl: lastTest.ewsUrl,
        authMethod: lastParams.authMethod,
        displayName: lastTest.displayName,
        calendars: $("#opt-cal").checked,
        contacts: $("#opt-contacts").checked,
      },
    });
    $("#add-status").textContent = "Done. The account appears in the folder pane; the first synchronisation runs in the background.";
    $("#add-form").reset();
    $("#found").hidden = true;
    refresh();
  } catch (e) {
    $("#add-status").textContent = `Failed: ${e.message}`;
  } finally {
    $("#add-btn").disabled = false;
  }
});

$("#log-level").addEventListener("change", ev => send({ type: "setLogLevel", level: ev.target.value }));
$("#refresh-log").addEventListener("click", refresh);
$("#copy-log").addEventListener("click", () => navigator.clipboard.writeText($("#log").textContent));

refresh().catch(e => {
  $("#startup-error").hidden = false;
  $("#startup-error").textContent = e.message;
});
