/* EWS Bridge — EWS SOAP envelope handling and errors. */

import { parseXml, xmlEscape } from "../xml.mjs";

export const NS_SOAP = "http://schemas.xmlsoap.org/soap/envelope/";
export const NS_TYPES = "http://schemas.microsoft.com/exchange/services/2006/types";
export const NS_MESSAGES = "http://schemas.microsoft.com/exchange/services/2006/messages";

export class EwsError extends Error {
  constructor(code, message, extra = {}) {
    super(message ? `${code}: ${message}` : code);
    this.name = "EwsError";
    this.code = code;
    Object.assign(this, extra);
  }
}

/** Credentials rejected (HTTP 401 after the transport tried everything). */
export class EwsAuthError extends EwsError {
  constructor(message, extra) {
    super("AuthenticationFailed", message, extra);
    this.name = "EwsAuthError";
  }
}

/** Could not reach the server at all (DNS, TLS, connection refused, timeout). */
export class EwsNetworkError extends EwsError {
  constructor(message, extra) {
    super("NetworkError", message, extra);
    this.name = "EwsNetworkError";
  }
}

/** HTTP-level failure that isn't a SOAP fault. */
export class EwsHttpError extends EwsError {
  constructor(status, message, extra) {
    super(`HTTP${status}`, message, { status, ...extra });
    this.name = "EwsHttpError";
  }
}

export function envelope(body, { version = "Exchange2013_SP1", timeZone = null, impersonate = null } = {}) {
  let header = `<t:RequestServerVersion Version="${xmlEscape(version)}"/>`;
  if (impersonate) {
    header += `<t:ExchangeImpersonation><t:ConnectingSID><t:PrimarySmtpAddress>${xmlEscape(
      impersonate
    )}</t:PrimarySmtpAddress></t:ConnectingSID></t:ExchangeImpersonation>`;
  }
  if (timeZone) {
    header += `<t:TimeZoneContext><t:TimeZoneDefinition Id="${xmlEscape(timeZone)}"/></t:TimeZoneContext>`;
  }
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="${NS_SOAP}" xmlns:t="${NS_TYPES}" xmlns:m="${NS_MESSAGES}">` +
    `<soap:Header>${header}</soap:Header>` +
    `<soap:Body>${body}</soap:Body></soap:Envelope>`
  );
}

/**
 * Parse an EWS HTTP response. Returns { body: XmlElement (the *Response
 * element), serverVersion }. Throws EwsError for SOAP faults.
 */
export function parseEnvelope(status, text) {
  let root;
  try {
    root = parseXml(text);
  } catch (e) {
    if (status >= 400) {
      throw new EwsHttpError(status, snippet(text));
    }
    throw new EwsError("InvalidResponse", `Unparseable response from server: ${e.message}`);
  }
  if (root.name != "Envelope") {
    throw new EwsError("InvalidResponse", `Unexpected document <${root.name}>`);
  }
  const body = root.child("Body");
  if (!body) {
    throw new EwsError("InvalidResponse", "SOAP envelope has no body");
  }
  const fault = body.child("Fault");
  if (fault) {
    const detail = fault.child("detail");
    const code = detail?.find("ResponseCode")?.text || fault.childText("faultcode") || "SoapFault";
    const msg = fault.childText("faultstring") || detail?.find("Message")?.text || "";
    const backOff = parseInt(detail?.find("Value")?.text ?? detail?.find("BackOffMilliseconds")?.text, 10);
    throw new EwsError(code, msg, { status, backOffMs: Number.isFinite(backOff) ? backOff : null });
  }
  const response = body.elements()[0];
  if (!response) {
    throw new EwsError("InvalidResponse", "Empty SOAP body");
  }
  const svi = root.child("Header")?.child("ServerVersionInfo");
  const serverVersion = svi
    ? {
        major: parseInt(svi.attr("MajorVersion"), 10),
        minor: parseInt(svi.attr("MinorVersion"), 10),
        build: `${svi.attr("MajorVersion")}.${svi.attr("MinorVersion")}.${svi.attr("MajorBuildNumber")}.${svi.attr("MinorBuildNumber")}`,
        version: svi.attr("Version"),
      }
    : null;
  return { body: response, serverVersion };
}

/**
 * The per-item response messages of an EWS response:
 * <m:FooResponse><m:ResponseMessages><m:FooResponseMessage ResponseClass=..>
 */
export function responseMessages(response) {
  const rm = response.child("ResponseMessages");
  return rm ? rm.elements() : [];
}

/** Throw if a response message is an error; returns it otherwise. */
export function checkMessage(msg, { allowWarnings = true, allowCodes = [] } = {}) {
  const cls = msg.attr("ResponseClass");
  const code = msg.childText("ResponseCode") || "NoError";
  if (cls == "Success" || code == "NoError" || allowCodes.includes(code)) {
    return msg;
  }
  if (cls == "Warning" && allowWarnings) {
    return msg;
  }
  const backOff = parseInt(msg.find("Value")?.text, 10);
  throw new EwsError(code, msg.childText("MessageText") || "", {
    responseClass: cls,
    backOffMs: code == "ErrorServerBusy" && Number.isFinite(backOff) ? backOff : null,
  });
}

export function messageError(msg) {
  try {
    checkMessage(msg);
    return null;
  } catch (e) {
    return e;
  }
}

function snippet(text) {
  const t = String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > 200 ? t.slice(0, 200) + "…" : t;
}
