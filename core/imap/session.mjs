/* EWS Bridge — IMAP4rev1 server session backed by a MailAccount.
 * Implements the command set Thunderbird uses, plus UIDPLUS, MOVE, IDLE,
 * LITERAL+, NAMESPACE, ID, ENABLE, UNSELECT, CHILDREN and SPECIAL-USE.
 */

import { CommandReader, ParseError, tokenize, astr, quote, parseSequenceSet, inRanges, formatSet, patternToRegExp } from "./protocol.mjs";
import { encodeMUTF7, decodeMUTF7 } from "./mutf7.mjs";
import { F_SEEN, F_FLAGGED, F_ANSWERED, F_DELETED, F_DRAFT, FLAG_NAMES, DELIMITER, MailboxError } from "./mailbox.mjs";
import { buildHeaderBlock } from "./headers.mjs";
import { parseMime, resolvePart, messageNodeFor, bodyStructure, envelope, Headers, formatImapDate, parseImapSearchDate, parseImapDateTime, findHeaderEnd } from "../mime.mjs";
import { EwsAuthError, EwsNetworkError } from "../ews/soap.mjs";
import { base64Decode, redact } from "../util.mjs";
import { xmlEscape } from "../xml.mjs";

const CAPS_PREAUTH = "IMAP4rev1 LITERAL+ SASL-IR ID ENABLE AUTH=PLAIN";
const CAPS = "IMAP4rev1 LITERAL+ SASL-IR ID ENABLE IDLE NAMESPACE UIDPLUS MOVE UNSELECT CHILDREN SPECIAL-USE";

const FLAG_BITS = Object.fromEntries(FLAG_NAMES.map(([bit, name]) => [name.toLowerCase(), bit]));

function flagList(msg) {
  const out = [];
  for (const [bit, name] of FLAG_NAMES) {
    if (msg.flags & bit) {
      out.push(name);
    }
  }
  out.push(...msg.keywords, ...msg.localKeywords);
  return `(${out.join(" ")})`;
}

function parseFlags(tok) {
  const list = Array.isArray(tok) ? tok : [tok];
  let bits = 0;
  const keywords = [];
  for (const t of list) {
    const f = astr(t);
    const bit = FLAG_BITS[f.toLowerCase()];
    if (bit) {
      bits |= bit;
    } else if (f.startsWith("\\")) {
      // \Recent and unknown system flags are ignored
    } else {
      keywords.push(f);
    }
  }
  return { bits, keywords };
}

class ImapError extends Error {
  constructor(message, { bad = false, code = null } = {}) {
    super(message);
    this.bad = bad;
    this.code = code;
  }
}

export class ImapSession {
  /**
   * @param {object} o
   * @param {object} o.conn   { write(bin), close() }
   * @param {Function} o.authenticate  async (user, pass) -> MailAccount | null
   * @param {object} [o.log]
   * @param {object} [o.timers]
   * @param {number} [o.idlePollMs]
   */
  constructor({ conn, authenticate, log = null, timers = globalThis, idlePollMs = 60000 }) {
    this.conn = conn;
    this.authenticate = authenticate;
    this.log = log;
    this.timers = timers;
    this.idlePollMs = idlePollMs;
    this.account = null;
    this.selected = null;
    this.queue = Promise.resolve();
    this.lineWaiter = null;
    this.closed = false;
    this.reader = new CommandReader({
      onCommand: parts => this.#enqueue(parts),
      onContinuationNeeded: () => this.#send("+ Ready for literal data"),
      onLine: line => {
        if (this.lineWaiter) {
          const w = this.lineWaiter;
          this.lineWaiter = null;
          w(line);
          return true;
        }
        return false;
      },
    });
    this.listener = changes => this.#onFolderChange(changes);
    this.#send(`* OK [CAPABILITY ${CAPS_PREAUTH}] EWS Bridge IMAP gateway ready`);
  }

  data(bin) {
    try {
      this.reader.feed(bin);
    } catch (e) {
      this.#send(`* BYE ${e.message}`);
      this.close();
    }
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.#deselect();
    if (this.idleTimer) {
      this.timers.clearInterval(this.idleTimer);
    }
    try {
      this.conn.close();
    } catch {}
  }

  #send(line) {
    if (!this.closed) {
      this.conn.write(line + "\r\n");
    }
  }

  #write(bin) {
    if (!this.closed) {
      this.conn.write(bin);
    }
  }

  #enqueue(parts) {
    this.queue = this.queue.then(() => this.#run(parts)).catch(e => this.log?.error(`IMAP session: ${e.message}`));
  }

  async #run(parts) {
    if (this.closed) {
      return;
    }
    let tag = "*";
    let tokens;
    try {
      tokens = tokenize(parts);
      tag = typeof tokens[0] == "string" ? tokens[0] : "*";
      if (tokens.length < 2 || typeof tokens[1] != "string") {
        this.#send(`${tag} BAD Missing command`);
        return;
      }
    } catch (e) {
      this.#send(`${tag} BAD ${e.message}`);
      return;
    }
    let command = tokens[1].toUpperCase();
    let args = tokens.slice(2);
    let uid = false;
    if (command == "UID") {
      uid = true;
      command = astr(args[0]).toUpperCase();
      args = args.slice(1);
    }
    this.log?.debug(`C: ${redact(`${tag} ${uid ? "UID " : ""}${command} ${command == "LOGIN" ? astr(args[0]) + " ***" : ""}`)}`);
    try {
      const handler = this[`cmd_${command}`];
      if (!handler) {
        throw new ImapError(`Unknown command ${command}`, { bad: true });
      }
      const needsAuth = !["CAPABILITY", "NOOP", "LOGOUT", "LOGIN", "AUTHENTICATE", "ID", "STARTTLS"].includes(command);
      if (needsAuth && !this.account) {
        throw new ImapError("Not authenticated", { bad: true });
      }
      const needsSelect = ["FETCH", "STORE", "COPY", "MOVE", "SEARCH", "EXPUNGE", "CLOSE", "UNSELECT", "CHECK"].includes(command);
      if (needsSelect && !this.selected) {
        throw new ImapError("No mailbox selected", { bad: true });
      }
      const result = await handler.call(this, tag, args, uid);
      if (result !== false) {
        this.#send(`${tag} OK ${result || `${uid ? "UID " : ""}${command} completed`}`);
      }
    } catch (e) {
      this.#reportError(tag, e);
    }
  }

  #reportError(tag, e) {
    if (e instanceof ImapError) {
      this.#send(`${tag} ${e.bad ? "BAD" : "NO"} ${e.code ? `[${e.code}] ` : ""}${e.message}`);
    } else if (e instanceof ParseError) {
      this.#send(`${tag} BAD ${e.message}`);
    } else if (e instanceof MailboxError) {
      this.#send(`${tag} NO ${e.imapCode && e.imapCode != "NO" ? `[${e.imapCode}] ` : ""}${e.message}`);
    } else if (e instanceof EwsAuthError) {
      this.#send(`${tag} NO [UNAVAILABLE] Exchange rejected the stored credentials: ${oneLine(e.message)}`);
    } else if (e instanceof EwsNetworkError) {
      this.#send(`${tag} NO [UNAVAILABLE] Exchange server not reachable: ${oneLine(e.message)}`);
    } else {
      this.log?.error(`command failed: ${e.stack || e.message}`);
      this.#send(`${tag} NO [SERVERBUG] Exchange error: ${oneLine(e.message)}`);
    }
  }

  // ---------------------------------------------------------------- any state

  cmd_CAPABILITY() {
    this.#send(`* CAPABILITY ${this.account ? CAPS : CAPS_PREAUTH}`);
  }

  async cmd_NOOP() {
    if (this.selected) {
      await this.#syncSelected(false);
      this.#flush(true);
    }
  }

  async cmd_CHECK() {
    return this.cmd_NOOP();
  }

  cmd_LOGOUT(tag) {
    this.#send("* BYE EWS Bridge logging out");
    this.#send(`${tag} OK LOGOUT completed`);
    this.close();
    return false;
  }

  cmd_ID(tag, args) {
    this.#send(`* ID ("name" "EWS Bridge" "vendor" "ews-bridge")`);
  }

  cmd_ENABLE() {
    this.#send("* ENABLED");
  }

  cmd_STARTTLS() {
    throw new ImapError("STARTTLS not available on the local gateway", { bad: true });
  }

  async cmd_LOGIN(tag, args) {
    if (this.account) {
      throw new ImapError("Already authenticated", { bad: true });
    }
    await this.#login(astr(args[0]), astr(args[1]));
    return `[CAPABILITY ${CAPS}] LOGIN completed`;
  }

  async cmd_AUTHENTICATE(tag, args) {
    if (this.account) {
      throw new ImapError("Already authenticated", { bad: true });
    }
    const mech = astr(args[0]).toUpperCase();
    if (mech != "PLAIN") {
      throw new ImapError("Unsupported authentication mechanism", { code: "CANNOT" });
    }
    let response = args[1] !== undefined ? astr(args[1]) : null;
    if (response === null) {
      this.#send("+ ");
      response = await new Promise(resolve => (this.lineWaiter = resolve));
    }
    if (response == "*") {
      throw new ImapError("Authentication cancelled", { bad: true });
    }
    const [, user, pass] = base64Decode(response).split("\0");
    await this.#login(user || "", pass || "");
    return `[CAPABILITY ${CAPS}] AUTHENTICATE completed`;
  }

  async #login(user, pass) {
    let account = null;
    try {
      account = await this.authenticate(user, pass);
    } catch (e) {
      this.log?.warn(`login: ${e.message}`);
      throw new ImapError(`Login failed: ${oneLine(e.message)}`, { code: "UNAVAILABLE" });
    }
    if (!account) {
      throw new ImapError("Invalid credentials for the local gateway", { code: "AUTHENTICATIONFAILED" });
    }
    this.account = account;
  }

  // ---------------------------------------------------------------- mailboxes

  #mailboxArg(tok) {
    const raw = astr(tok);
    const name = decodeMUTF7(raw);
    return name.toUpperCase() == "INBOX" ? "INBOX" : name;
  }

  #fmtName(name) {
    return quote(encodeMUTF7(name));
  }

  cmd_NAMESPACE() {
    this.#send(`* NAMESPACE (("" "${DELIMITER}")) NIL NIL`);
  }

  async cmd_LIST(tag, args, _uid, lsub = false) {
    let selection = [];
    if (Array.isArray(args[0])) {
      selection = args.shift().map(t => astr(t).toUpperCase());
    }
    const reference = this.#mailboxArg(args[0]);
    const patterns = Array.isArray(args[1]) ? args[1].map(t => this.#mailboxArg(t)) : [this.#mailboxArg(args[1])];
    let returnOpts = [];
    if (args[2] && astr(args[2]).toUpperCase() == "RETURN" && Array.isArray(args[3])) {
      returnOpts = args[3].map(t => (typeof t == "string" ? t.toUpperCase() : ""));
    }
    if (patterns.length == 1 && patterns[0] == "") {
      this.#send(`* ${lsub ? "LSUB" : "LIST"} (\\Noselect) "${DELIMITER}" ""`);
      return;
    }
    await this.account.refreshFolders();
    const regexes = patterns.map(p => {
      const full = reference + p;
      const re = patternToRegExp(full, DELIMITER);
      return name => re.test(name) || (full.toUpperCase().startsWith("INBOX") && patternToRegExp("INBOX" + full.slice(5), DELIMITER).test(name));
    });
    const specialOnly = selection.includes("SPECIAL-USE");
    const subscribedOnly = lsub || selection.includes("SUBSCRIBED");
    const folders = this.account.folders().sort((a, b) => (a.name == "INBOX" ? -1 : b.name == "INBOX" ? 1 : a.name.localeCompare(b.name)));
    for (const f of folders) {
      if (!regexes.some(r => r(f.name))) {
        continue;
      }
      if (specialOnly && !f.specialUse) {
        continue;
      }
      const subscribed = this.account.isSubscribed(f);
      if (subscribedOnly && !subscribed) {
        continue;
      }
      const attrs = [f.hasChildren ? "\\HasChildren" : "\\HasNoChildren"];
      if (f.specialUse) {
        attrs.push(f.specialUse);
      }
      if (!lsub && (selection.includes("SUBSCRIBED") || returnOpts.includes("SUBSCRIBED")) && subscribed) {
        attrs.push("\\Subscribed");
      }
      this.#send(`* ${lsub ? "LSUB" : "LIST"} (${attrs.join(" ")}) "${DELIMITER}" ${this.#fmtName(f.name)}`);
    }
  }

  async cmd_LSUB(tag, args) {
    return this.cmd_LIST(tag, args, false, true);
  }

  async cmd_SUBSCRIBE(tag, args) {
    await this.account.refreshFolders();
    const f = this.account.getFolder(this.#mailboxArg(args[0]));
    if (f) {
      await this.account.setSubscribed(f, true);
    }
  }

  async cmd_UNSUBSCRIBE(tag, args) {
    await this.account.refreshFolders();
    const f = this.account.getFolder(this.#mailboxArg(args[0]));
    if (f) {
      await this.account.setSubscribed(f, false);
    }
  }

  async cmd_CREATE(tag, args) {
    const name = this.#mailboxArg(args[0]);
    if (name.toUpperCase() == "INBOX") {
      throw new ImapError("INBOX already exists", { code: "ALREADYEXISTS" });
    }
    await this.account.createFolder(name);
  }

  async cmd_DELETE(tag, args) {
    const name = this.#mailboxArg(args[0]);
    if (this.selected?.folder.name == name) {
      this.#deselect();
    }
    await this.account.deleteFolder(name);
  }

  async cmd_RENAME(tag, args) {
    const from = this.#mailboxArg(args[0]);
    const to = this.#mailboxArg(args[1]);
    if (from == "INBOX") {
      throw new ImapError("Renaming INBOX is not supported", { code: "CANNOT" });
    }
    await this.account.renameFolder(from, to);
  }

  async cmd_STATUS(tag, args) {
    const name = this.#mailboxArg(args[0]);
    const items = (args[1] || []).map(t => astr(t).toUpperCase());
    await this.account.refreshFolders();
    const f = this.account.getFolder(name);
    if (!f) {
      throw new ImapError("No such mailbox", { code: "NONEXISTENT" });
    }
    await this.account.openFolder(f);
    await this.account.syncFolder(f);
    const out = [];
    for (const it of items) {
      if (it == "MESSAGES") {
        out.push(`MESSAGES ${f.exists}`);
      } else if (it == "RECENT") {
        out.push("RECENT 0");
      } else if (it == "UIDNEXT") {
        out.push(`UIDNEXT ${f.uidNext}`);
      } else if (it == "UIDVALIDITY") {
        out.push(`UIDVALIDITY ${f.uidValidity}`);
      } else if (it == "UNSEEN") {
        out.push(`UNSEEN ${f.unseen}`);
      }
    }
    this.#send(`* STATUS ${this.#fmtName(f.name)} (${out.join(" ")})`);
  }

  async cmd_SELECT(tag, args, _uid, readOnly = false) {
    this.#deselect();
    const name = this.#mailboxArg(args[0]);
    await this.account.refreshFolders();
    const folder = this.account.getFolder(name);
    if (!folder) {
      throw new ImapError("No such mailbox", { code: "NONEXISTENT" });
    }
    await this.account.openFolder(folder);
    await this.account.syncFolder(folder, { force: true });
    this.selected = {
      folder,
      readOnly,
      view: folder.msgs.map(m => m.uid),
      pending: { removed: new Set(), added: new Set(), changed: new Set() },
    };
    folder.listeners.add(this.listener);
    const kw = new Set(["$Forwarded", "$MDNSent", "Junk", "NonJunk", "$label1", "$label2", "$label3", "$label4", "$label5"]);
    for (const m of folder.msgs) {
      m.keywords.forEach(k => kw.add(k));
      m.localKeywords.forEach(k => kw.add(k));
    }
    this.#send(`* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft ${[...kw].join(" ")})`);
    this.#send(`* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft ${[...kw].join(" ")} \\*)] Flags permitted`);
    this.#send(`* ${this.selected.view.length} EXISTS`);
    this.#send("* 0 RECENT");
    const firstUnseen = folder.msgs.findIndex(m => !(m.flags & F_SEEN));
    if (firstUnseen >= 0) {
      this.#send(`* OK [UNSEEN ${firstUnseen + 1}] First unseen`);
    }
    this.#send(`* OK [UIDVALIDITY ${folder.uidValidity}] UIDs valid`);
    this.#send(`* OK [UIDNEXT ${folder.uidNext}] Predicted next UID`);
    return `[${readOnly ? "READ-ONLY" : "READ-WRITE"}] ${readOnly ? "EXAMINE" : "SELECT"} completed`;
  }

  async cmd_EXAMINE(tag, args) {
    return this.cmd_SELECT(tag, args, false, true);
  }

  #deselect() {
    if (this.selected) {
      this.selected.folder.listeners.delete(this.listener);
      this.selected = null;
    }
  }

  async cmd_CLOSE() {
    const sel = this.selected;
    if (!sel.readOnly) {
      const doomed = sel.view.map(u => sel.folder.byUid.get(u)).filter(m => m && m.flags & F_DELETED);
      if (doomed.length) {
        this.#deselect(); // CLOSE sends no EXPUNGE responses
        await this.account.expunge(sel.folder, doomed);
        return;
      }
    }
    this.#deselect();
  }

  cmd_UNSELECT() {
    this.#deselect();
  }

  // ---------------------------------------------------------------- selected state updates

  #onFolderChange({ added, removed, changed }) {
    const sel = this.selected;
    if (!sel) {
      return;
    }
    for (const m of removed) {
      sel.pending.removed.add(m.uid);
      sel.pending.added.delete(m.uid);
      sel.pending.changed.delete(m.uid);
    }
    for (const m of added) {
      sel.pending.added.add(m.uid);
    }
    for (const m of changed) {
      sel.pending.changed.add(m.uid);
    }
    if (this.idling) {
      this.#flush(true);
    }
  }

  /** Send pending EXPUNGE / EXISTS / FETCH updates to the client. */
  #flush(allowExpunge) {
    const sel = this.selected;
    if (!sel) {
      return;
    }
    const p = sel.pending;
    if (allowExpunge && p.removed.size) {
      for (let i = sel.view.length - 1; i >= 0; i--) {
        if (p.removed.has(sel.view[i])) {
          this.#send(`* ${i + 1} EXPUNGE`);
          sel.view.splice(i, 1);
        }
      }
      p.removed.clear();
    }
    if (p.added.size) {
      const inView = new Set(sel.view);
      const fresh = [...p.added].filter(u => !inView.has(u) && sel.folder.byUid.has(u)).sort((a, b) => a - b);
      if (fresh.length) {
        sel.view.push(...fresh);
        sel.view.sort((a, b) => a - b);
        this.#send(`* ${sel.view.length} EXISTS`);
      }
      p.added.clear();
    }
    if (p.changed.size) {
      sel.view.forEach((u, i) => {
        if (p.changed.has(u)) {
          const m = sel.folder.byUid.get(u);
          if (m) {
            this.#send(`* ${i + 1} FETCH (UID ${u} FLAGS ${flagList(m)})`);
          }
        }
      });
      p.changed.clear();
    }
  }

  async #syncSelected(force) {
    try {
      await this.account.syncFolder(this.selected.folder, { force });
    } catch (e) {
      if (e instanceof MailboxError && e.imapCode == "NONEXISTENT") {
        this.#send("* BYE Selected folder was deleted on the server");
        this.close();
        return;
      }
      throw e;
    }
  }

  /** Resolve a sequence/UID set to [{seq, msg}] in view order. */
  #resolveSet(setStr, uid) {
    const sel = this.selected;
    const view = sel.view;
    const out = [];
    if (uid) {
      const max = view.length ? view[view.length - 1] : 0;
      const ranges = parseSequenceSet(setStr, max);
      // "n:*" with n > max still matches the highest UID
      view.forEach((u, i) => {
        if (inRanges(ranges, u)) {
          out.push({ seq: i + 1, uid: u, msg: sel.folder.byUid.get(u) });
        }
      });
    } else {
      const ranges = parseSequenceSet(setStr, view.length);
      view.forEach((u, i) => {
        if (inRanges(ranges, i + 1)) {
          out.push({ seq: i + 1, uid: u, msg: sel.folder.byUid.get(u) });
        }
      });
    }
    return out;
  }

  // ---------------------------------------------------------------- FETCH

  async cmd_FETCH(tag, args, uid) {
    const targets = this.#resolveSet(astr(args[0]), uid);
    let attTok = args[1];
    let atts = Array.isArray(attTok) ? attTok.map(astr) : [astr(attTok)];
    const expanded = [];
    for (const a of atts) {
      const A = a.toUpperCase();
      if (A == "ALL") {
        expanded.push("FLAGS", "INTERNALDATE", "RFC822.SIZE", "ENVELOPE");
      } else if (A == "FAST") {
        expanded.push("FLAGS", "INTERNALDATE", "RFC822.SIZE");
      } else if (A == "FULL") {
        expanded.push("FLAGS", "INTERNALDATE", "RFC822.SIZE", "ENVELOPE", "BODY");
      } else {
        expanded.push(a);
      }
    }
    if (uid && !expanded.some(a => a.toUpperCase() == "UID")) {
      expanded.unshift("UID");
    }
    const specs = expanded.map(parseFetchAtt);
    const needMime = specs.some(s => s.needsMime);
    const needHeaders = !needMime && specs.some(s => s.headerOnly || s.type == "ENVELOPE");
    const setsSeen = !this.selected.readOnly && specs.some(s => s.setsSeen);
    const folder = this.selected.folder;
    const live = targets.filter(t => t.msg);

    const BATCH = 100;
    for (let i = 0; i < live.length; i += BATCH) {
      const batch = live.slice(i, i + BATCH);
      let headerItems = null;
      if (needHeaders) {
        const withoutMime = batch.filter(t => this.account.peekMime(t.msg) === undefined).map(t => t.msg);
        headerItems = withoutMime.length ? await this.account.getHeaderItems(withoutMime) : new Map();
      }
      for (const t of batch) {
        let mime = this.account.peekMime(t.msg);
        if (needMime && mime === undefined) {
          mime = await this.account.getMime(t.msg);
          if (mime === null) {
            continue; // deleted on the server in the meantime
          }
        }
        let seenNow = false;
        if (setsSeen && !(t.msg.flags & F_SEEN)) {
          await this.account.storeFlags(folder, [t.msg], "+", F_SEEN);
          this.selected?.pending.changed.delete(t.uid);
          seenNow = !specs.some(s => s.type == "FLAGS");
        }
        const parts = [];
        let tree = null;
        const getTree = () => (tree ||= parseMime(mime));
        let headerBlock = null;
        const synthHeader = () => {
          if (headerBlock === null) {
            const item = headerItems?.get(t.msg.id);
            headerBlock = item ? buildHeaderBlock(item) : "\r\n";
          }
          return headerBlock;
        };
        for (const s of specs) {
          switch (s.type) {
            case "UID":
              parts.push(`UID ${t.uid}`);
              break;
            case "FLAGS":
              parts.push(`FLAGS ${flagList(t.msg)}`);
              break;
            case "INTERNALDATE":
              parts.push(`INTERNALDATE "${formatImapDate(t.msg.received)}"`);
              break;
            case "RFC822.SIZE":
              parts.push(`RFC822.SIZE ${mime !== undefined && mime !== null ? mime.length : t.msg.exactSize || t.msg.size || 0}`);
              break;
            case "ENVELOPE": {
              const h = mime ? getTree().headers : Headers.parse(synthHeader());
              parts.push(`ENVELOPE ${envelope(h, quote)}`);
              break;
            }
            case "BODYSTRUCTURE":
              parts.push(`BODYSTRUCTURE ${bodyStructure(mime, getTree(), quote, true)}`);
              break;
            case "BODY":
              parts.push(`BODY ${bodyStructure(mime, getTree(), quote, false)}`);
              break;
            case "SECTION": {
              let data;
              if (s.headerOnly && (mime === undefined || mime === null)) {
                data = sectionFromHeader(synthHeader(), s);
              } else {
                data = sectionData(mime, getTree(), s);
              }
              if (data === null) {
                data = "";
              }
              if (s.partial) {
                data = data.slice(s.partial[0], s.partial[0] + s.partial[1]);
              }
              parts.push(`${s.responseName} {${data.length}}\r\n${data}`);
              break;
            }
          }
        }
        if (seenNow) {
          parts.push(`FLAGS ${flagList(t.msg)}`);
        }
        this.#write(`* ${t.seq} FETCH (${parts.join(" ")})\r\n`);
      }
    }
    this.#flush(uid);
  }

  // ---------------------------------------------------------------- STORE

  async cmd_STORE(tag, args, uid) {
    if (this.selected.readOnly) {
      throw new ImapError("Mailbox is read-only", { code: "READ-ONLY" });
    }
    const targets = this.#resolveSet(astr(args[0]), uid);
    const item = astr(args[1]).toUpperCase();
    const m = /^([+-]?)FLAGS(\.SILENT)?$/.exec(item);
    if (!m) {
      throw new ImapError(`Bad STORE item ${item}`, { bad: true });
    }
    const mode = m[1] || "=";
    const silent = !!m[2];
    const { bits, keywords } = parseFlags(args.length > 3 ? args.slice(2) : args[2]);
    const msgs = targets.filter(t => t.msg).map(t => t.msg);
    await this.account.storeFlags(this.selected.folder, msgs, mode, bits, keywords);
    for (const t of targets) {
      this.selected.pending.changed.delete(t.uid);
    }
    if (!silent) {
      for (const t of targets) {
        if (t.msg) {
          this.#send(`* ${t.seq} FETCH (${uid ? `UID ${t.uid} ` : ""}FLAGS ${flagList(t.msg)})`);
        }
      }
    }
    this.#flush(uid);
  }

  // ---------------------------------------------------------------- COPY / MOVE

  async #transfer(tag, args, uid, move) {
    const targets = this.#resolveSet(astr(args[0]), uid).filter(t => t.msg);
    const destName = this.#mailboxArg(args[1]);
    await this.account.refreshFolders();
    const dest = this.account.getFolder(destName);
    if (!dest) {
      throw new ImapError("Destination mailbox does not exist", { code: "TRYCREATE" });
    }
    if (move && this.selected.readOnly) {
      throw new ImapError("Mailbox is read-only", { code: "READ-ONLY" });
    }
    if (!targets.length) {
      return move ? "MOVE completed" : "COPY completed";
    }
    const pairs = await this.account.transfer(this.selected.folder, targets.map(t => t.msg), dest, { move });
    const copyuid = pairs.length ? `[COPYUID ${dest.uidValidity} ${formatSet(pairs.map(p => p[0]))} ${formatSet(pairs.map(p => p[1]))}] ` : "";
    if (move) {
      if (copyuid) {
        this.#send(`* OK ${copyuid.trim()} Moved`);
      }
      this.#flush(true);
      return `${uid ? "UID " : ""}MOVE completed`;
    }
    this.#flush(uid);
    return `${copyuid}${uid ? "UID " : ""}COPY completed`;
  }

  async cmd_COPY(tag, args, uid) {
    return this.#transfer(tag, args, uid, false);
  }

  async cmd_MOVE(tag, args, uid) {
    return this.#transfer(tag, args, uid, true);
  }

  // ---------------------------------------------------------------- EXPUNGE

  async cmd_EXPUNGE(tag, args, uid) {
    if (this.selected.readOnly) {
      throw new ImapError("Mailbox is read-only", { code: "READ-ONLY" });
    }
    const sel = this.selected;
    let candidates = sel.view.map(u => sel.folder.byUid.get(u)).filter(m => m && m.flags & F_DELETED);
    if (uid) {
      const allowed = new Set(this.#resolveSet(astr(args[0]), true).map(t => t.uid));
      candidates = candidates.filter(m => allowed.has(m.uid));
    }
    if (candidates.length) {
      await this.account.expunge(sel.folder, candidates);
    }
    this.#flush(true);
  }

  // ---------------------------------------------------------------- APPEND

  async cmd_APPEND(tag, args) {
    const name = this.#mailboxArg(args[0]);
    let i = 1;
    let flags = { bits: 0, keywords: [] };
    if (Array.isArray(args[i])) {
      flags = parseFlags(args[i]);
      i++;
    }
    let date = null;
    if (args[i] && typeof args[i] == "object" && !Array.isArray(args[i]) && args[i + 1] !== undefined) {
      date = parseImapDateTime(args[i].s);
      i++;
    }
    const msg = args[i];
    if (!msg || typeof msg != "object" || Array.isArray(msg)) {
      throw new ImapError("APPEND requires a message literal", { bad: true });
    }
    await this.account.refreshFolders();
    const folder = this.account.getFolder(name);
    if (!folder) {
      throw new ImapError("Mailbox does not exist", { code: "TRYCREATE" });
    }
    const newUid = await this.account.append(folder, msg.s, flags.bits, flags.keywords, date);
    if (this.selected) {
      this.#flush(false);
    }
    return `[APPENDUID ${folder.uidValidity} ${newUid}] APPEND completed`;
  }

  // ---------------------------------------------------------------- SEARCH

  async cmd_SEARCH(tag, args, uid) {
    let i = 0;
    if (typeof args[0] == "string" && args[0].toUpperCase() == "CHARSET") {
      i = 2;
    }
    const sel = this.selected;
    const tree = parseSearch(args.slice(i));
    // Resolve text criteria with EWS first.
    const textSets = new Map();
    const collect = node => {
      if (node.text) {
        textSets.set(node, null);
      }
      (node.children || []).forEach(collect);
    };
    collect(tree);
    for (const node of textSets.keys()) {
      textSets.set(node, await this.account.searchText(sel.folder, [node.text]));
    }
    const results = [];
    sel.view.forEach((u, idx) => {
      const m = sel.folder.byUid.get(u);
      if (m && evalSearch(tree, m, idx + 1, sel.view, textSets)) {
        results.push(uid ? u : idx + 1);
      }
    });
    this.#send(`* SEARCH${results.length ? " " + results.join(" ") : ""}`);
    this.#flush(uid);
  }

  // ---------------------------------------------------------------- IDLE

  async cmd_IDLE(tag) {
    this.#send("+ idling");
    this.idling = true;
    this.#flush(true);
    const poll = async () => {
      if (!this.selected || this.closed) {
        return;
      }
      try {
        await this.account.syncFolder(this.selected.folder, { force: true });
      } catch (e) {
        this.log?.warn(`IDLE poll: ${e.message}`);
      }
    };
    this.idleTimer = this.selected ? this.timers.setInterval(poll, this.idlePollMs) : null;
    const line = await new Promise(resolve => (this.lineWaiter = resolve));
    this.idling = false;
    if (this.idleTimer) {
      this.timers.clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    if (line.trim().toUpperCase() != "DONE") {
      throw new ImapError("Expected DONE", { bad: true });
    }
    return "IDLE terminated";
  }
}

function oneLine(s) {
  return String(s).replace(/[\r\n]+/g, " ").slice(0, 300);
}

// -------------------------------------------------------------------- fetch attributes

/**
 * Parse a fetch attribute like BODY.PEEK[1.2.HEADER.FIELDS (From To)]<0.100>
 */
export function parseFetchAtt(att) {
  const A = att.toUpperCase();
  if (["UID", "FLAGS", "INTERNALDATE", "RFC822.SIZE", "ENVELOPE"].includes(A)) {
    return { type: A };
  }
  if (A == "BODYSTRUCTURE" || A == "BODY") {
    return { type: A, needsMime: true };
  }
  if (A == "RFC822") {
    return { type: "SECTION", path: [], spec: "", responseName: "RFC822", needsMime: true, setsSeen: true };
  }
  if (A == "RFC822.HEADER") {
    return { type: "SECTION", path: [], spec: "HEADER", responseName: "RFC822.HEADER", headerOnly: true };
  }
  if (A == "RFC822.TEXT") {
    return { type: "SECTION", path: [], spec: "TEXT", responseName: "RFC822.TEXT", needsMime: true, setsSeen: true };
  }
  const m = /^(BODY|BINARY)(\.PEEK)?\[([^\]]*)\](?:<(\d+)(?:\.(\d+))?>)?$/i.exec(att);
  if (!m) {
    throw new ParseError(`Unknown fetch attribute ${att}`);
  }
  const section = m[3];
  const peek = !!m[2];
  const sm = /^((?:\d+\.)*\d+)?\.?(HEADER\.FIELDS\.NOT|HEADER\.FIELDS|HEADER|TEXT|MIME)?\s*(?:\((.*)\))?$/i.exec(section.trim());
  if (!sm) {
    throw new ParseError(`Bad section ${section}`);
  }
  const path = sm[1] ? sm[1].split(".").map(n => parseInt(n, 10)) : [];
  const spec = (sm[2] || "").toUpperCase();
  const fields = sm[3] ? sm[3].trim().split(/\s+/).map(f => f.replace(/^"|"$/g, "").toLowerCase()) : null;
  const headerOnly = !path.length && spec.startsWith("HEADER");
  const partial = m[4] !== undefined ? [parseInt(m[4], 10), m[5] !== undefined ? parseInt(m[5], 10) : Infinity] : null;
  let responseName = `BODY[${section.toUpperCase().replace(/\s+/g, " ")}]`;
  if (partial) {
    responseName += `<${partial[0]}>`;
  }
  return { type: "SECTION", path, spec, fields, partial, responseName, headerOnly, needsMime: !headerOnly, setsSeen: !peek };
}

function filterHeaderLines(block, fields, not) {
  const lines = block.split(/\r?\n/);
  const out = [];
  let include = false;
  for (const line of lines) {
    if (line == "") {
      continue;
    }
    if (line[0] == " " || line[0] == "\t") {
      if (include) {
        out.push(line);
      }
      continue;
    }
    const name = line.slice(0, line.indexOf(":")).trim().toLowerCase();
    include = fields.includes(name) != not;
    if (include) {
      out.push(line);
    }
  }
  return out.join("\r\n") + (out.length ? "\r\n" : "") + "\r\n";
}

function sectionFromHeader(block, s) {
  if (s.spec == "HEADER") {
    return block;
  }
  return filterHeaderLines(block, s.fields || [], s.spec == "HEADER.FIELDS.NOT");
}

function sectionData(bin, root, s) {
  if (!s.path.length && !s.spec) {
    return bin;
  }
  if (s.spec == "MIME") {
    const node = resolvePart(root, s.path);
    return node ? bin.slice(node.start, node.bodyStart) : null;
  }
  if (s.spec.startsWith("HEADER") || s.spec == "TEXT") {
    const msgNode = messageNodeFor(root, s.path);
    if (!msgNode) {
      return null;
    }
    if (s.spec == "TEXT") {
      return bin.slice(msgNode.bodyStart, msgNode.end);
    }
    const block = bin.slice(msgNode.start, msgNode.bodyStart);
    return s.spec == "HEADER" ? block : filterHeaderLines(block, s.fields || [], s.spec == "HEADER.FIELDS.NOT");
  }
  const node = resolvePart(root, s.path);
  if (!node) {
    return null;
  }
  return bin.slice(node.bodyStart, node.end);
}

// -------------------------------------------------------------------- SEARCH

const TEXT_FIELDS = {
  SUBJECT: ["item:Subject"],
  BODY: ["item:Body"],
  TO: ["item:DisplayTo"],
  CC: ["item:DisplayCc"],
  BCC: ["item:DisplayTo"],
  FROM: ["0x0042", "0x0065", "0x5D02", "0x0C1A"],
  TEXT: ["item:Subject", "item:Body", "item:DisplayTo", "0x0042", "0x5D02"],
};

function containsXml(field, value) {
  const uri = field.startsWith("0x")
    ? `<t:ExtendedFieldURI PropertyTag="${field}" PropertyType="String"/>`
    : `<t:FieldURI FieldURI="${field}"/>`;
  return `<t:Contains ContainmentMode="Substring" ContainmentComparison="IgnoreCase">${uri}<t:Constant Value="${xmlEscape(value)}"/></t:Contains>`;
}

function textRestriction(key, value) {
  const fields = TEXT_FIELDS[key];
  const parts = fields.map(f => containsXml(f, value));
  return parts.length == 1 ? parts[0] : `<t:Or>${parts.join("")}</t:Or>`;
}

export function parseSearch(tokens) {
  let i = 0;
  const next = () => tokens[i++];
  const parseOne = () => {
    const tok = next();
    if (tok === undefined) {
      throw new ParseError("Incomplete search criteria");
    }
    if (Array.isArray(tok)) {
      return { op: "AND", children: parseSearch(tok).children };
    }
    const K = astr(tok).toUpperCase();
    switch (K) {
      case "ALL": return { op: "ALL" };
      case "ANSWERED": return { op: "FLAG", bit: F_ANSWERED, set: true };
      case "UNANSWERED": return { op: "FLAG", bit: F_ANSWERED, set: false };
      case "DELETED": return { op: "FLAG", bit: F_DELETED, set: true };
      case "UNDELETED": return { op: "FLAG", bit: F_DELETED, set: false };
      case "FLAGGED": return { op: "FLAG", bit: F_FLAGGED, set: true };
      case "UNFLAGGED": return { op: "FLAG", bit: F_FLAGGED, set: false };
      case "SEEN": return { op: "FLAG", bit: F_SEEN, set: true };
      case "UNSEEN": return { op: "FLAG", bit: F_SEEN, set: false };
      case "NEW": return { op: "FLAG", bit: F_SEEN, set: false };
      case "OLD": return { op: "ALL" };
      case "RECENT": return { op: "NONE" };
      case "DRAFT": return { op: "FLAG", bit: F_DRAFT, set: true };
      case "UNDRAFT": return { op: "FLAG", bit: F_DRAFT, set: false };
      case "KEYWORD": return { op: "KEYWORD", kw: astr(next()), set: true };
      case "UNKEYWORD": return { op: "KEYWORD", kw: astr(next()), set: false };
      case "BEFORE": case "SENTBEFORE": return { op: "DATE", cmp: "<", date: parseImapSearchDate(astr(next())) };
      case "ON": case "SENTON": return { op: "DATE", cmp: "=", date: parseImapSearchDate(astr(next())) };
      case "SINCE": case "SENTSINCE": return { op: "DATE", cmp: ">=", date: parseImapSearchDate(astr(next())) };
      case "LARGER": return { op: "SIZE", cmp: ">", n: parseInt(astr(next()), 10) };
      case "SMALLER": return { op: "SIZE", cmp: "<", n: parseInt(astr(next()), 10) };
      case "UID": return { op: "UID", set: astr(next()) };
      case "NOT": return { op: "NOT", children: [parseOne()] };
      case "OR": return { op: "OR", children: [parseOne(), parseOne()] };
      case "HEADER": {
        const name = astr(next()).toUpperCase();
        const value = astr(next());
        if (name == "MESSAGE-ID") {
          return { op: "TEXT", text: `<t:IsEqualTo><t:FieldURI FieldURI="message:InternetMessageId"/><t:FieldURIOrConstant><t:Constant Value="${xmlEscape(value)}"/></t:FieldURIOrConstant></t:IsEqualTo>` };
        }
        if (TEXT_FIELDS[name]) {
          return { op: "TEXT", text: textRestriction(name, value) };
        }
        return value == "" ? { op: "ALL" } : { op: "TEXT", text: textRestriction("TEXT", value) };
      }
      default:
        if (TEXT_FIELDS[K]) {
          return { op: "TEXT", text: textRestriction(K, astr(next())) };
        }
        if (/^[\d*:,]+$/.test(K)) {
          return { op: "SEQ", set: K };
        }
        throw new ParseError(`Unsupported search key ${K}`);
    }
  };
  const children = [];
  while (i < tokens.length) {
    children.push(parseOne());
  }
  return { op: "AND", children };
}

function evalSearch(node, m, seq, view, textSets) {
  switch (node.op) {
    case "ALL": return true;
    case "NONE": return false;
    case "AND": return node.children.every(c => evalSearch(c, m, seq, view, textSets));
    case "OR": return node.children.some(c => evalSearch(c, m, seq, view, textSets));
    case "NOT": return !evalSearch(node.children[0], m, seq, view, textSets);
    case "FLAG": return !!(m.flags & node.bit) == node.set;
    case "KEYWORD": {
      const has = [...m.keywords, ...m.localKeywords].some(k => k.toLowerCase() == node.kw.toLowerCase());
      return has == node.set;
    }
    case "DATE": {
      if (!node.date) return false;
      const day = Date.UTC(new Date(m.received).getUTCFullYear(), new Date(m.received).getUTCMonth(), new Date(m.received).getUTCDate());
      const d = node.date.getTime();
      return node.cmp == "<" ? day < d : node.cmp == "=" ? day == d : day >= d;
    }
    case "SIZE": {
      const size = m.exactSize || m.size;
      return node.cmp == ">" ? size > node.n : size < node.n;
    }
    case "UID": return inRanges(parseSequenceSet(node.set, view.length ? view[view.length - 1] : 0), m.uid);
    case "SEQ": return inRanges(parseSequenceSet(node.set, view.length), seq);
    case "TEXT": return textSets.get(node)?.has(m.id) ?? false;
  }
  return false;
}
