/* e2e-only diagnostics: runs at extension startup, dumps lifecycle and all console messages. */
/* global ExtensionAPI, ChromeUtils, Services, Cc, Ci, Cu, Components, PathUtils, IOUtils */
this.e2eprobe = class extends ExtensionAPI {
  onStartup() {
    dump("E2EPROBE: extension startup\n");
    Services.console.registerListener({
      observe(m) {
        const text = m.message || String(m);
        if (!/gtk|remote-settings|EnvironmentAddonBuilder/i.test(text)) dump(`E2ECONSOLE: ${text}\n`);
      },
    });
    Services.obs.addObserver((subject) => {
      const m = subject.wrappedJSObject;
      if (/^moz-extension:|ews-bridge|\/ext\//.test(String(m.filename || ""))) {
        dump(`E2ELOG[${m.level}]: ${m.arguments.map(a => (a && a.message ? a.message + " " + (a.stack || "") : String(a))).join(" ")}\n`);
      }
    }, "console-api-log-event");
    const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
    ExtensionParent.browserStartupPromise.then(() => dump("E2EPROBE: browserStartupPromise resolved\n"));
    const ext = this.extension;
    try {
      const url = ext.rootURI.resolve("experiments/bridge/parent.js");
      const sb = Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(), { wantGlobalProperties: ["ChromeUtils"] });
      Object.assign(sb, { ExtensionAPI: class {}, ExtensionCommon: { ExtensionError: Error, EventManager: class {} }, Services, Cc, Ci, Cr: Components.results, Cu, dump });
      Services.scriptloader.loadSubScript(url, sb);
      dump(`E2EPROBE: sandbox load ok, typeof ewsBridge=${typeof sb.ewsBridge}, keys=${Object.keys(sb).join(",")}\n`);
    } catch (e) {
      dump(`E2EPROBE: sandbox load error: ${e} @${e.fileName}:${e.lineNumber}\n`);
    }
    let n = 0;
    this.timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    this.timer.initWithCallback(() => { if (n++ < 20) dump(`E2EPROBE: backgroundState=${ext.backgroundState}\n`); }, 3000, Ci.nsITimer.TYPE_REPEATING_SLACK);
  }
  onShutdown() { this.timer?.cancel(); }
  getAPI() {
    return {
      e2eprobe: {
        async calendarTitles() {
          const { Sqlite } = ChromeUtils.importESModule("resource://gre/modules/Sqlite.sys.mjs");
          const path = PathUtils.join(PathUtils.profileDir, "calendar-data", "cache.sqlite");
          if (!(await IOUtils.exists(path))) return [];
          const conn = await Sqlite.openConnection({ path, readOnly: true });
          try {
            return (await conn.execute("SELECT title FROM cal_events")).map(r => r.getResultByName("title"));
          } finally {
            await conn.close();
          }
        },
        async quit() {
          Services.tm.dispatchToMainThread(() => Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit));
        },
      },
    };
  }
};
