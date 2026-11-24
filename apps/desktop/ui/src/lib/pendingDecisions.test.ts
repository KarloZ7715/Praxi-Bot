import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { GlobalEnvelope } from "../api/types.ts";
import {
  applyEvent,
  EMPTY_EVENTS,
  needsYou,
  type EventsState
} from "../state/timeline.ts";
import { pendingForChat } from "./pendingDecisions.ts";

let gseq = 0;
function feed(state: EventsState, event: GlobalEnvelope["event"], parent?: string): EventsState {
  gseq += 1;
  return applyEvent(state, { v: 1, seq: gseq, ts_ms: 1000 + gseq, gseq, parent_run_id: parent, event });
}
const ask = (run: string, call: string) =>
  ({ type: "approval_needed", run_id: run, call_id: call, tool_name: "fs_write", input: {}, summary: "w" }) as const;

function world(): EventsState {
  gseq = 0;
  let s = EMPTY_EVENTS;
  // chat A (bot 1): a top-level run and a subagent of it, each waiting
  s = feed(s, { type: "run_started", run_id: "a", chat_id: "chatA", bot_id: "bot1" });
  s = feed(s, ask("a", "top"));
  s = feed(s, { type: "subagent_started", run_id: "kid", parent_run_id: "a", task: "t", call_id: "spawn" }, "a");
  s = feed(s, ask("kid", "deep"), "a");
  // chat B of the same bot, another bot's chat C
  s = feed(s, { type: "run_started", run_id: "b", chat_id: "chatB", bot_id: "bot1" });
  s = feed(s, ask("b", "other-chat"));
  s = feed(s, { type: "run_started", run_id: "c", chat_id: "chatC", bot_id: "bot2" });
  s = feed(s, ask("c", "other-bot"));
  return s;
}

test("every waiting card of a chat is drawn exactly once: inline, or pinned above the composer", () => {
  const events = world();
  const needs = needsYou(events);
  assert.equal(needs.length, 4);
  const { inline, pinned, own } = pendingForChat(needs, events, { id: "chatA", botId: "bot1" });
  assert.deepEqual(inline.map((e) => e.callId), ["top"]);
  // the subagent's card and the bot's card from its other chat are pinned; another bot's is not here
  assert.deepEqual(pinned.map((e) => e.callId).sort(), ["deep", "other-chat"]);
  assert.deepEqual(own.map((e) => e.callId).sort(), ["deep", "top"]);
  const drawn = [...inline, ...pinned].map((e) => e.callId);
  assert.equal(new Set(drawn).size, drawn.length, "no card twice");
});

test("a card of a run the events never placed is pinned once the run list names its chat", () => {
  gseq = 0;
  const events = feed(EMPTY_EVENTS, ask("ghost", "lost"));
  const placed = needsYou(events, [
    { id: "ghost", chat_id: "chatA", bot_id: "bot1", state: "waiting_approval", created_at_ms: 1 }
  ]);
  const { inline, pinned } = pendingForChat(placed, events, { id: "chatA", botId: "bot1" });
  assert.equal(inline.length + pinned.length, 1);
  assert.equal(pinned[0].callId, "lost");
});

// The components cannot be mounted by the DOM-less runner: these fail if the wiring is undone.
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

test("the live view banner counts the very entries it renders as cards", () => {
  const viewer = read("../views/LiveViewer.tsx");
  assert.match(viewer, /count: questionCount/);
  assert.match(viewer, /<PendingDecisions entries=\{needs\.filter\(\(item\) => item\.kind === "question"\)\} \/>/);
  assert.match(viewer, /const questionCount = needs\.filter\(\(item\) => item\.kind === "question"\)\.length/);
});

test("the chat pins the cards its timeline cannot draw and names what it waits for", () => {
  const chat = read("../views/ChatView.tsx");
  assert.match(chat, /<PendingDecisions\s+entries=\{pending\.pinned\}/);
  assert.match(chat, /pendingForChat\(needs, events/);
  // the status line is fed by the cards, not by the run state alone
  assert.match(chat, /const askedHere = pending\.own\.length > 0/);
  assert.match(chat, /t\("runStatus\.waiting", \{/);
});
