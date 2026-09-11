/* EWS Bridge — locate the EWS endpoint for an e-mail address.
 *
 * Implements Exchange "POX" autodiscover
 * (https://learn.microsoft.com/exchange/client-developer/web-service-reference/pox-autodiscover-xml-reference)
 * plus a list of conventional host names to try when autodiscover fails.
 */

import { parseXml, xmlEscape } from "../xml.mjs";

const REQUEST_NS = "http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006";
const RESPONSE_SCHEMA = "http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a";

export class AutodiscoverError extends Error {}

function requestBody(email) {
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<Autodiscover xmlns="${REQUEST_NS}"><Request>` +
    `<EMailAddress>${xmlEscape(email)}</EMailAddress>` +
    `<AcceptableResponseSchema>${RESPONSE_SCHEMA}</AcceptableResponseSchema>` +
    `</Request></Autodiscover>`
  );
}

/** Parse an autodiscover response document. */
export function parseAutodiscoverResponse(text) {
  const root = parseXml(text);
  const response = root.child("Response");
  if (!response) {
    throw new AutodiscoverError("Not an autodiscover response");
  }
  const err = response.child("Error");
  if (err) {
    throw new AutodiscoverError(`Autodiscover error ${err.childText("ErrorCode", "")}: ${err.childText("Message", "")}`.trim());
  }
  const user = response.child("User");
  const account = response.child("Account");
  if (!account) {
    throw new AutodiscoverError("Autodiscover response has no Account element");
  }
  const action = account.childText("Action", "settings");
  if (action == "redirectAddr") {
    return { redirectAddr: account.childText("RedirectAddr") };
  }
  if (action == "redirectUrl") {
    return { redirectUrl: account.childText("RedirectUrl") };
  }
  const protocols = account.elements("Protocol");
  const pick = type => protocols.find(p => p.childText("Type") == type);
  const ewsUrl =
    pick("EXCH")?.childText("EwsUrl") ||
    pick("EXPR")?.childText("EwsUrl") ||
    protocols.map(p => p.childText("EwsUrl") || p.childText("ExternalEwsUrl")).find(Boolean) ||
    null;
  if (!ewsUrl) {
    throw new AutodiscoverError("Autodiscover response contains no EWS URL");
  }
  return {
    ewsUrl,
    displayName: user?.childText("DisplayName") || null,
    smtpAddress: user?.childText("AutoDiscoverSMTPAddress") || null,
    serverVersion: pick("EXCH")?.childText("ServerVersion") || null,
  };
}

/**
 * Run autodiscover. `transport` as for EwsClient (performs auth).
 * Returns { ewsUrl, displayName, smtpAddress, source } or throws with a
 * list of what was attempted.
 */
export async function autodiscover(email, transport, { log = null } = {}) {
  const attempts = [];
  let address = email;
  for (let redirects = 0; redirects < 10; redirects++) {
    const domain = address.split("@")[1];
    if (!domain) {
      throw new AutodiscoverError("Invalid e-mail address");
    }
    const urls = [
      `https://${domain}/autodiscover/autodiscover.xml`,
      `https://autodiscover.${domain}/autodiscover/autodiscover.xml`,
    ];
    // HTTP redirect method: GET http://autodiscover.domain/... answers with a 302 to an https URL.
    let redirectedUrl = null;
    let result = null;
    for (const url of urls) {
      result = await tryUrl(url);
      if (result) {
        break;
      }
    }
    if (!result) {
      try {
        const res = await transport.request({
          method: "GET",
          url: `http://autodiscover.${domain}/autodiscover/autodiscover.xml`,
          headers: {},
          body: null,
          noRedirect: true,
        });
        const loc = res.headers?.location;
        if (res.status >= 300 && res.status < 400 && loc && loc.startsWith("https://")) {
          redirectedUrl = loc;
        }
      } catch (e) {
        attempts.push(`http://autodiscover.${domain}: ${e.message}`);
      }
      if (redirectedUrl) {
        result = await tryUrl(redirectedUrl);
      }
    }
    if (!result) {
      break;
    }
    if (result.redirectAddr) {
      log?.info(`Autodiscover redirected to address ${result.redirectAddr}`);
      address = result.redirectAddr;
      continue;
    }
    if (result.redirectUrl) {
      const r = await tryUrl(result.redirectUrl);
      if (r && r.ewsUrl) {
        return r;
      }
      break;
    }
    return result;
  }
  throw new AutodiscoverError(`Autodiscover failed. Tried:\n${attempts.join("\n")}`);

  async function tryUrl(url) {
    try {
      const res = await transport.request({
        method: "POST",
        url,
        headers: { "Content-Type": "text/xml; charset=utf-8" },
        body: requestBody(address),
      });
      if (res.status != 200) {
        attempts.push(`${url}: HTTP ${res.status}`);
        return null;
      }
      const r = parseAutodiscoverResponse(res.body);
      r.source = url;
      return r;
    } catch (e) {
      attempts.push(`${url}: ${e.message}`);
      log?.debug(`autodiscover ${url}: ${e.message}`);
      return null;
    }
  }
}

/** Conventional EWS URLs to probe when autodiscover is unavailable. */
export function guessEwsUrls(email) {
  const domain = (email.split("@")[1] || "").toLowerCase();
  if (!domain) {
    return [];
  }
  const hosts = [`outlook.${domain}`, `mail.${domain}`, `exchange.${domain}`, `owa.${domain}`, `webmail.${domain}`, domain];
  return hosts.map(h => `https://${h}/EWS/Exchange.asmx`);
}
