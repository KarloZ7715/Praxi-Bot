import type { ComputerApprovalDetails, EgressApprovalDetails } from "./approvalDetails.ts";
import { describeTool, hostOf, isSendTool, resolveToolCall } from "./toolLabels.ts";

type AppName = (server: string) => string | null;

/** `t` as i18next gives it; a plain function keeps this module free of React. */
export type T = (key: string, values?: Record<string, unknown>) => string;

const KINDS = ["file", "window", "page", "mailbox", "mcp", "tool"] as const;

/** One source label the daemon recorded ("window msedge.exe") as a short phrase in the UI language. */
export function sourceText(label: string, t: T): string {
  const fixed: Record<string, string> = {
    "command output": "command",
    "workflow replay": "workflow",
    memory: "memory",
    "untrusted skill": "skill"
  };
  const key = fixed[label];
  if (key) return t(`chat.approval.plain.source.${key}`);
  const m = /^(\S+) (.+)$/s.exec(label);
  if (m && (KINDS as readonly string[]).includes(m[1])) {
    return t(`chat.approval.plain.source.${m[1]}`, { name: m[2] });
  }
  return label;
}

/** The daemon's English target ids ("the shell") and the key of their words in the UI language. */
const HOSTS: Record<string, string> = {
  "the shell": "shell",
  "a script": "script",
  "the browser": "browser",
  "the desktop": "desktop",
  "the mailbox": "mailbox",
  "this bot's scheduler": "scheduler",
  "this bot's memory": "memory",
  "the user's bots": "bots"
};

/** Where the data goes, as words: a known internal target id is translated, a site or domain stays. */
export function hostText(host: string, t: T): string {
  const key = HOSTS[host];
  if (key) return t(`chat.approval.plain.host.${key}`);
  const m = /^mailbox (.+)$/s.exec(host);
  if (m) return t("chat.approval.plain.host.mailboxNamed", { name: m[1] });
  return host;
}

/** Why it asks, in one sentence, from the daemon's reason code. `null` for an older daemon (use its text). */
export function reasonLine(egress: EgressApprovalDetails, t: T): string | null {
  const list = egress.read.length
    ? egress.read.map((s) => sourceText(s, t)).join(", ")
    : t("chat.approval.plain.reason.unknownSources");
  // An action in the browser the owner connected asks only because the run also read private data.
  if (egress.reasonCode === "egress_browser") return t("chat.approval.plain.reason.egressBrowser", { list });
  if (egress.reasonCode !== "egress" && egress.reasonCode !== "egress_executes") return null;
  const key = egress.reasonCode === "egress_executes" || egress.executes ? "egressExecutes" : "egress";
  return t(`chat.approval.plain.reason.${key}`, { list, host: hostText(egress.host, t) });
}

export interface WhereInput {
  /** The computer the daemon bound to a desktop/browser call, when it did. */
  computer: ComputerApprovalDetails | null;
  /** The bots' home server name (empty when unnamed), or `null` when the home is this computer. */
  serverName: string | null;
}

/** Which computer the call acts on, as words. */
export function whereText(tool: string, w: WhereInput, t: T): string {
  const onComputer = tool.startsWith("desktop_") || tool.startsWith("browser_");
  if (onComputer && w.computer?.kind === "pc" && w.serverName !== null) {
    return t("chat.approval.plain.where.user", { name: w.computer.name });
  }
  if (w.serverName === null) return t("chat.approval.plain.where.thisComputer");
  return w.serverName
    ? t("chat.approval.plain.where.server", { name: w.serverName })
    : t("chat.approval.plain.where.serverUnnamed");
}

/** A short value on one line; anything cut (a longer text, more lines) ends in "…". */
function clip(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : "";
  const lines = text.split(/\r?\n/);
  const line = lines[0] ?? "";
  const chars = [...line];
  if (chars.length > max) return `${chars.slice(0, max).join("")}…`;
  return lines.length > 1 ? `${line} …` : line;
}

/**
 * A command shown whole: every line, joined with " ⏎ " so a second command on another line is
 * never hidden; only a very long one is cut, and then it ends in "…".
 */
function whole(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : "";
  const joined = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join(" ⏎ ");
  const chars = [...joined];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : joined;
}

/** A desktop key list (`["ctrl","s"]` or `"ctrl+s"`) as text. */
function keysText(value: unknown): string {
  if (Array.isArray(value)) return clip(value.filter((k) => typeof k === "string").join("+"), 40);
  return clip(value, 40);
}

/** The `pc_browser_*` / `pc_desktop_*` call as a specific sentence. */
function pcComputerText(tool: string, rec: Record<string, unknown>, t: T): string | null {
  const ref = clip(rec.ref, 16);
  switch (tool) {
    case "pc_browser_open":
      return t("chat.approval.plain.action.pcBrowserOpen", { url: clip(rec.url, 200) });
    case "pc_browser_click":
      return t("chat.approval.plain.action.pcBrowserClick", { ref });
    case "pc_browser_fill":
      return t("chat.approval.plain.action.pcBrowserFill", { ref, text: whole(rec.text, 200) });
    case "pc_browser_select":
      return t("chat.approval.plain.action.pcBrowserSelect", { ref, value: clip(rec.value, 80) });
    case "pc_browser_press":
      return t("chat.approval.plain.action.pcBrowserPress", { key: clip(rec.key, 40) });
    case "pc_browser_back":
      return t("chat.approval.plain.action.pcBrowserBack");
    case "pc_browser_tabs":
      return typeof rec.switch_to === "number"
        ? t("chat.approval.plain.action.pcBrowserTab", { n: rec.switch_to })
        : t("chat.approval.plain.action.pcBrowserLook");
    case "pc_browser_snapshot":
    case "pc_browser_screenshot":
    case "pc_browser_wait":
    case "pc_browser_scroll":
      return t("chat.approval.plain.action.pcBrowserLook");
    case "pc_desktop_launch":
      return t("chat.approval.plain.action.pcLaunch", { name: whole([rec.executable, ...(Array.isArray(rec.args) ? rec.args : [])].filter((a) => typeof a === "string").join(" "), 200) });
    case "pc_desktop_type":
      return t("chat.approval.plain.action.pcScreenType", { text: whole(rec.text, 200) });
    case "pc_desktop_set_value":
      return t("chat.approval.plain.action.pcScreenType", { text: whole(rec.value, 200) });
    case "pc_desktop_key":
      return t("chat.approval.plain.action.pcScreenKeys", { keys: keysText(rec.keys) });
    case "pc_desktop_click":
    case "pc_desktop_drag":
      return t("chat.approval.plain.action.pcScreenClick");
    case "pc_desktop_get_state":
    case "pc_desktop_screenshot":
    case "pc_desktop_list_apps":
      return t("chat.approval.plain.action.pcScreenLook");
    default:
      if (tool.startsWith("pc_browser_")) return t("chat.approval.plain.action.pcBrowser");
      if (tool.startsWith("pc_desktop_")) return t("chat.approval.plain.action.pcScreen");
      return null;
  }
}

/** What the bot wants to do in plain words, or `null` for a tool without a plain sentence. */
export function actionText(tool: string, input: unknown, w: WhereInput, t: T): string | null {
  const rec = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const where = whereText(tool, w, t);
  // The `pc_*` family always acts on the USER'S computer, whatever the bot runs on.
  if (tool.startsWith("pc_")) {
    if (tool === "pc_shell_run") return t("chat.approval.plain.action.pcShell");
    if (tool === "pc_fs_write") return t("chat.approval.plain.action.pcWrite", { path: clip(rec.path, 200) });
    if (tool === "pc_fs_read" || tool === "pc_fs_list") {
      return t("chat.approval.plain.action.pcRead", { path: clip(rec.path, 200) });
    }
    return pcComputerText(tool, rec, t);
  }
  if (tool === "shell_run") {
    return t("chat.approval.plain.action.shell", { where });
  }
  if (tool === "desktop_launch") {
    return t("chat.approval.plain.action.launch", { where, name: clip(rec.executable, 80) });
  }
  if (tool === "browser_open") {
    return t("chat.approval.plain.action.browser", { where, url: clip(rec.url, 120) });
  }
  if (tool.startsWith("desktop_")) return t("chat.approval.plain.action.screen", { where });
  return null;
}

/**
 * One plain sentence for a call to the browser the owner connected (a browser-kind MCP server),
 * or `null`. Only when the daemon marked the call (`browser_action`, or an always-asking
 * `mcp_call` card): a tool name alone never makes a call a browser action.
 */
export function browserMcpText(tool: string, input: unknown, details: unknown, t: T): string | null {
  // `mcp:<server>/<tool>`, or `<server>.<tool>` as a wrapped call is shown.
  const m = /^mcp:[^/]+\/(.+)$/s.exec(tool) ?? /^[^/:]+\.([^./:]+)$/s.exec(tool);
  if (!m || !details || typeof details !== "object") return null;
  const d = details as { browser_action?: unknown; kind?: unknown; reason_code?: unknown };
  const remote = m[1];
  if (d.kind === "mcp_call") {
    if (d.reason_code === "browser_code") return t("chat.approval.plain.action.browserMcpCode");
    if (d.reason_code === "browser_file") return t("chat.approval.plain.action.browserMcpFile");
    return null;
  }
  if (d.browser_action !== true) return null;
  const rec = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  if ((remote === "browser_navigate" || remote === "browser_tabs" || remote === "browser_tab_new") && typeof rec.url === "string") {
    return t("chat.approval.plain.action.browserMcpOpen", { url: escapeInvisible(clip(rec.url, 160)) });
  }
  return t("chat.approval.plain.action.browserMcpAction", { tool: remote });
}

/** Characters of a shell command shown before the card says it was cut. */
export const COMMAND_LIMIT = 2000;
/** Characters of the full tool input shown before the card says it was cut. */
export const INPUT_LIMIT = 4000;

/**
 * Control, bidi-override and zero-width characters written as `<U+XXXX>`, so a command or an
 * argument cannot hide text or reorder what the owner reads. Tabs and line breaks stay as they are.
 */
export function escapeInvisible(text: string): string {
  let out = "";
  for (const ch of text.replace(/\r\n/g, "\n")) {
    const c = ch.codePointAt(0) ?? 0;
    const hidden =
      (c < 0x20 && c !== 0x09 && c !== 0x0a) ||
      (c >= 0x7f && c <= 0x9f) ||
      c === 0xad || c === 0x61c || c === 0x180e ||
      (c >= 0x200b && c <= 0x200f) ||
      (c >= 0x2028 && c <= 0x202e) ||
      (c >= 0x2060 && c <= 0x206f) ||
      c === 0xfeff ||
      (c >= 0xfff9 && c <= 0xfffb);
    out += hidden ? "<U+" + c.toString(16).toUpperCase().padStart(4, "0") + ">" : ch;
  }
  return out;
}

/** `text` cut to `max` characters (ending in "…") and escaped; `shortened` says whether it was cut. */
function cutAndEscape(text: string, max: number): { text: string; shortened: boolean } {
  const chars = [...text];
  if (chars.length > max) return { text: `${escapeInvisible(chars.slice(0, max).join(""))}…`, shortened: true };
  return { text: escapeInvisible(text), shortened: false };
}

/**
 * The command of a shell call, whole and on its own lines, for the code box under the sentence;
 * `null` for any other call. Only a very long one is cut (`shortened`, text ends in "…").
 */
export function actionCommand(tool: string, input: unknown): { text: string; shortened: boolean } | null {
  if (tool !== "shell_run" && tool !== "pc_shell_run" && tool !== "shell.run") return null;
  const rec = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const text = typeof rec.command === "string" ? rec.command.trim() : "";
  if (!text) return null;
  return cutAndEscape(text, COMMAND_LIMIT);
}

/**
 * The whole input of a call as readable text (pretty JSON), so the owner sees every argument
 * (path, recipient, body, url, typed text) before approving. `null` when there is no input.
 */
export function actionArguments(input: unknown): { text: string; shortened: boolean } | null {
  if (input === null || input === undefined || input === "") return null;
  if (typeof input === "object" && Object.keys(input as object).length === 0) return null;
  let text: string;
  if (typeof input === "string") {
    text = input;
  } else {
    try {
      text = JSON.stringify(input, null, 2) ?? "";
    } catch {
      text = String(input);
    }
  }
  if (!text) return null;
  return cutAndEscape(text, INPUT_LIMIT);
}

/**
 * The steps of a `browser_act` batch (`details.kind = "browser_steps"`) as numbered, readable
 * lines, every step in order. Invisible and bidi characters are shown as `<U+XXXX>`. `null` when
 * the card carries no steps (the full input box stays the fallback).
 */
export function browserStepLines(details: unknown, t: T): string[] | null {
  if (!details || typeof details !== "object") return null;
  const d = details as { kind?: unknown; steps?: unknown };
  if (d.kind !== "browser_steps" || !Array.isArray(d.steps) || d.steps.length === 0) return null;
  const str = (v: unknown, max: number): string =>
    typeof v === "string" ? escapeInvisible([...v].slice(0, max).join("")) : "";
  const known = ["click", "fill", "select", "press", "scroll", "wait"];
  const lines: string[] = [];
  for (const [i, raw] of d.steps.entries()) {
    if (!raw || typeof raw !== "object") return null;
    const row = raw as Record<string, unknown>;
    const action = str(row.action, 16);
    if (!known.includes(action)) return null;
    const ref = str(row.ref, 40);
    const rawTarget = str(row.target, 120);
    const target =
      !rawTarget || rawTarget === "unknown element" ? t("chat.approval.steps.unknown", { ref }) : rawTarget;
    const values = {
      n: i + 1,
      target,
      text: str(row.text, 300),
      value: str(row.value, 120),
      key: str(row.key, 40),
      what: str(row.wait_for, 120)
    };
    const key = action === "scroll" && !ref ? "scrollPage" : action;
    lines.push(t(`chat.approval.steps.${key}`, values));
  }
  return lines;
}

function asObj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Public hostname targeted by a browser/web/site approval, for rendering a crisp site favicon. */
export function approvalTargetDomain(tool: string, input: unknown, details?: unknown): string | null {
  const rec = asObj(input) ?? {};
  for (const key of ["url", "href", "origin", "domain", "site"]) {
    const raw = rec[key];
    if (typeof raw === "string" && raw.trim()) {
      const host = hostOf(raw.trim());
      if (host && host.includes(".")) return host;
      if (!raw.includes("/") && !raw.includes(":") && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(raw.trim())) {
        return raw.trim().replace(/^www\./i, "").toLowerCase();
      }
    }
  }
  const det = asObj(details);
  if (det) {
    const egress = asObj(det.egress);
    const candidate =
      (typeof egress?.host === "string" && egress.host) ||
      (typeof det.host === "string" && det.host) ||
      null;
    if (candidate) {
      const host = hostOf(candidate) ?? candidate.replace(/^www\./i, "").toLowerCase();
      if (host.includes(".") && !host.includes(" ")) return host;
    }
    const mem = asObj(det.memory);
    if (mem?.kind === "origin" && typeof mem.pattern === "string") {
      const host = hostOf(mem.pattern);
      if (host && host.includes(".")) return host;
    }
  }
  void tool;
  return null;
}

export type RiskKind = "send" | "delete" | "run";

/**
 * Classifies high-consequence actions whose critical target data (recipient/subject,
 * command line, or path) must stay visible on the compact card before expanding Details.
 */
export function approvalRiskKind(tool: string, input: unknown, details?: unknown): RiskKind | null {
  const call = resolveToolCall(tool, input);
  const low = call.name.toLowerCase();
  if (isSendTool(tool) || isSendTool(call.name)) return "send";
  if (low === "shell_run" || low === "pc_shell_run" || low === "shell.run" || low === "shell") {
    return "run";
  }
  if (
    low === "fs_delete" ||
    low === "pc_fs_delete" ||
    low.includes("delete") ||
    low.includes("remove") ||
    low.includes("wipe") ||
    low.includes("purge")
  ) {
    return "delete";
  }
  const det = asObj(details);
  if (det?.kind === "schedule" && det.action === "delete") return "delete";
  return null;
}

/** Read-only tools a standing "Always allow" may cover; mirrors the daemon's allow-list. */
const ALWAYS_READ_ONLY_TOOLS = new Set(["fs_read", "fs_list", "fs_stat", "fs_search"]);

/**
 * Whether standing "Always allow" is refused for this call. The daemon is authoritative (it
 * refuses the choice and sends `always_offered`); this mirrors its ALLOW-list so the button never
 * shows for anything else: only `browser_open` scoped to one origin and the listed read-only
 * tools qualify. Sends, writes, shell, MCP / Composio tools of any name, desktop input and
 * every destructive, paid or credential action are refused.
 */
export function isAlwaysBlockedAction(tool: string, input: unknown, details?: unknown): boolean {
  const call = resolveToolCall(tool, input);
  const det = asObj(details);
  if (det?.always_offered === false) return true;
  if (det?.kind === "bot" || det?.kind === "control_grant" || det?.kind === "app_action") return true;
  if (det?.kind === "schedule") return true;
  if (call.name === "browser_open") return asObj(det?.memory)?.kind !== "origin";
  return !ALWAYS_READ_ONLY_TOOLS.has(call.name);
}

type HostFlag = "mixed" | "idn" | null;

/** Scripts present in a host's letters (Latin / Cyrillic / Greek / other). */
function scriptsOf(host: string): Set<string> {
  const out = new Set<string>();
  for (const ch of host) {
    if (/[A-Za-z]/.test(ch)) out.add("latin");
    else if (/\p{Script=Cyrillic}/u.test(ch)) out.add("cyrillic");
    else if (/\p{Script=Greek}/u.test(ch)) out.add("greek");
    else if (/\p{L}/u.test(ch)) out.add("other");
  }
  return out;
}

/**
 * The address as the owner must read it: the ASCII (punycode) form of the host, and whether it
 * can imitate another site: `mixed` when letters of several alphabets share the name (a Cyrillic
 * "о" inside `webioo.com.tr`), `idn` for any other international name (non-ASCII or `xn--`).
 */
export function lookalikeHost(rawTarget: string, host: string): { host: string; flag: HostFlag } {
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(rawTarget.trim())?.[1] ?? rawTarget.trim();
  const rawHost = authority.slice(authority.lastIndexOf("@") + 1).replace(/:\d*$/, "");
  const scripts = scriptsOf(rawHost);
  let ascii = host;
  if (/[\u0080-\u{10ffff}]/u.test(host)) {
    try {
      ascii = new URL(`https://${host}`).hostname;
    } catch {
      ascii = host;
    }
  }
  if (scripts.size > 1) return { host: ascii, flag: "mixed" };
  if (/[\u0080-\u{10ffff}]/u.test(rawHost) || /(^|\.)xn--/i.test(ascii)) return { host: ascii, flag: "idn" };
  return { host: ascii, flag: null };
}

/** One short exact-data line for risky send/delete/run cards; null for non-risky calls or when already shown verbatim in headline. */
export function approvalCompactPreview(
  tool: string,
  input: unknown,
  details?: unknown
): { text: string; kind: RiskKind } | null {
  const kind = approvalRiskKind(tool, input, details);
  if (!kind) return null;
  const call = resolveToolCall(tool, input);
  const rec = asObj(call.input) ?? {};
  if (kind === "run") {
    const raw = typeof rec.command === "string" ? rec.command.trim() : "";
    if (!raw || [...raw].length <= 44 && !raw.includes("\n")) return null;
    const cmd = whole(raw, 110);
    return cmd ? { kind, text: escapeInvisible(cmd) } : null;
  }
  if (kind === "send") {
    const to = typeof rec.to === "string" ? rec.to : Array.isArray(rec.to) ? rec.to.join(", ") : "";
    const subject = typeof rec.subject === "string" ? rec.subject : "";
    const joined = [to, subject].filter(Boolean).join(" — ");
    return joined ? { kind, text: escapeInvisible(clip(joined, 110)) } : null;
  }
  const target =
    (typeof rec.path === "string" && rec.path) ||
    (typeof rec.target === "string" && rec.target) ||
    (typeof rec.id === "string" && rec.id) ||
    "";
  return target ? { kind, text: escapeInvisible(clip(target, 110)) } : null;
}

/**
 * One short plain sentence describing the approval request ("Open webioo.com.tr",
 * "Run shell command", "Send email to team@praxi.dev").
 */
export function approvalHeadline(
  tool: string,
  input: unknown,
  details: unknown,
  w: WhereInput,
  t: T,
  brandName?: AppName
): string {
  const det = asObj(details);
  if (det?.kind === "bot" && typeof det.action === "string") {
    return t(`chat.approval.bot.title.${det.action}`);
  }
  if (det?.kind === "control_grant") {
    return t("chat.approval.compact.controlGrant");
  }
  if (det?.kind === "schedule") {
    const action = typeof det.action === "string" ? det.action : "create";
    const name = typeof det.name === "string" ? det.name : "";
    if (name) return t(`chat.approval.compact.schedule.${action}`, { name: clip(name, 48) });
  }
  if (det?.kind === "app_action" && typeof det.app === "string" && typeof det.action === "string") {
    return `${det.app} · ${det.action}`;
  }
  const call = resolveToolCall(tool, input);
  const domain = approvalTargetDomain(call.name, call.input, details);
  if (
    domain &&
    (call.name === "browser_open" ||
      call.name === "pc_browser_open" ||
      call.name.endsWith("browser_navigate") ||
      call.name.endsWith("browser_tab_new"))
  ) {
    // The host is shown whole (never clipped) and, for an international name, in its ASCII
    // form with a warning, so a look-alike cannot read as the site it imitates.
    const rawTarget = typeof asObj(call.input)?.url === "string" ? (asObj(call.input)!.url as string) : domain;
    const { host, flag } = lookalikeHost(rawTarget, domain);
    if (flag) return t(`chat.approval.compact.openSite_${flag}`, { site: host });
    return t("chat.approval.compact.openSite", { site: host });
  }
  const rec = asObj(call.input) ?? {};
  if ((call.name === "email_send" || call.name.endsWith("send_message")) && typeof rec.to === "string" && rec.to.trim()) {
    return t("chat.approval.compact.sendMail", { to: escapeInvisible(clip(rec.to.trim(), 48)) });
  }
  if (call.name === "shell_run" || call.name === "pc_shell_run" || call.name === "shell.run") {
    const cmd = typeof rec.command === "string" ? clip(rec.command.trim(), 44) : "";
    if (cmd) return t("chat.approval.compact.runCommand", { command: escapeInvisible(cmd) });
  }
  if (call.name === "fs_delete" || call.name === "pc_fs_delete") {
    const p = typeof rec.path === "string" ? clip(rec.path.trim(), 48) : "";
    if (p) return t("chat.approval.compact.deletePath", { path: escapeInvisible(p) });
  }
  const plain =
    browserMcpText(call.name, call.input, details, t) ??
    actionText(call.name, call.input, w, t);
  if (plain) return plain;
  const mcp = /^mcp:([^/]+)\/(.+)$/.exec(call.name);
  const canonical = mcp ? `${mcp[1]}.${mcp[2]}` : call.name;
  const stepLabel = describeTool(canonical, call.input, brandName);
  return t(`${stepLabel.key}.running`, stepLabel.values);
}
