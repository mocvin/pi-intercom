import test from "node:test";
import assert from "node:assert/strict";
import { INFERENCE_WINDOW_MS, PeerTracker, extractThreadRef, recipientInfo, threadReplyHint } from "./trace-data.ts";

test("a plain send answers the one recent message from that peer, and nothing else is guessed", () => {
  const peers = new PeerTracker();
  const now = 1_000_000;
  assert.equal(peers.inferReply("a", now), undefined, "nothing received yet");
  peers.recordInbound("a", "m1", now - 60_000, false);
  assert.deepEqual(peers.inferReply("a", now), { id: "m1", basis: "sole_unanswered_message_from_peer", ageMs: 60_000 });
  assert.equal(peers.inferReply("b", now), undefined, "another peer");
  peers.recordInbound("a", "m2", now - 30_000, false);
  assert.equal(peers.inferReply("a", now), undefined, "two candidates: ambiguous, no guess");
});

test("an answered message is not a candidate again, and old or ask messages are never guessed", () => {
  const peers = new PeerTracker();
  const now = 5_000_000;
  peers.recordInbound("a", "m1", now - 10_000, false);
  peers.recordOutbound("a", now - 5_000);
  assert.equal(peers.inferReply("a", now), undefined, "this session already wrote to the peer after it");
  peers.recordInbound("a", "m2", now - 1_000, false);
  assert.equal(peers.inferReply("a", now)?.id, "m2", "a new message after the answer is a candidate");
  peers.recordInbound("c", "ask1", now - 1_000, true);
  assert.equal(peers.inferReply("c", now), undefined, "asks are threaded by their own mechanism");
  peers.recordInbound("d", "old", now - INFERENCE_WINDOW_MS - 1, false);
  assert.equal(peers.inferReply("d", now), undefined, "too old");
  assert.equal(peers.inferReply("a", now - 100_000), undefined, "a clock that went backwards guesses nothing");
});

test("recipientInfo keeps only what is known", () => {
  assert.deepEqual(recipientInfo({ id: "x" }), { id: "x" });
  assert.deepEqual(recipientInfo({ id: "x", piSessionId: "p", cwd: "/c", name: "n" }), { id: "x", piSessionId: "p", cwd: "/c", name: "n" });
});

test("a [RE:<id>] tag at the start of a message names the message it answers", () => {
  assert.equal(extractThreadRef("[RE:0198a0a0-aaaa-7bbb-8ccc-ddddeeeeffff] Done, see below."), "0198a0a0-aaaa-7bbb-8ccc-ddddeeeeffff");
  assert.equal(extractThreadRef("  [RE:m-123.4] ok"), "m-123.4");
  assert.equal(extractThreadRef("[INFO] [RE:abcd-1234] progress"), "abcd-1234", "after one leading tag");
  assert.equal(extractThreadRef("[RICHIESTA, sola lettura] [RE:abcd-1234] x"), "abcd-1234");
  assert.equal(extractThreadRef("Hello [RE:abcd-1234] in the middle of a sentence"), undefined, "only at the start");
  assert.equal(extractThreadRef("[RE:ab] too short"), undefined);
  assert.equal(extractThreadRef("[RE:bad id with spaces] x"), undefined);
  assert.equal(extractThreadRef("no tag here"), undefined);
  assert.equal(extractThreadRef(`${"x".repeat(400)}[RE:abcd-1234]`), undefined);
  assert.match(threadReplyHint("peer-1", "msg-9"), /\[RE:msg-9\]/);
});

test("receivedFrom tells whether a peer really sent a message with that id", () => {
  const peers = new PeerTracker();
  peers.recordInbound("a", "m1", 1, false);
  assert.equal(peers.receivedFrom("a", "m1"), true);
  assert.equal(peers.receivedFrom("b", "m1"), false, "another peer");
  assert.equal(peers.receivedFrom("a", "unknown"), false);
});
