import assert from "node:assert/strict";
import { test } from "node:test";
import { mayFetchFavicon } from "./faviconPolicy.ts";

test("a favicon is requested only for a site that is already allowed, never for a pending card", () => {
  // A pending approval card names a model-chosen host: no lookup, whatever the host looks like.
  assert.equal(mayFetchFavicon(undefined, "secret-abc123.attacker.com"), false);
  assert.equal(mayFetchFavicon(false, "secret-abc123.attacker.com"), false);
  // Allowed sites (Allowed-sites list, activity chips after Allow) may fetch.
  assert.equal(mayFetchFavicon(true, "webioo.com.tr"), true);
  assert.equal(mayFetchFavicon(true, "not a host"), false);
});
