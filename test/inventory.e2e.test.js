/**
 * End to end: real proxy process -> mock D&D Beyond, over HTTP.
 * Run: npm test
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { createMockDdb, ENTITY } = require("./mock-ddb.js");

const COBALT = "GOOD-COBALT";
let mock;
let mockServer;
let proxy;
let proxyUrl;

const listen = (app) =>
  new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });

async function waitFor(url, ms = 10000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} never came up`);
}

before(async () => {
  mock = createMockDdb({ cobalt: COBALT });
  mockServer = await listen(mock.app);
  const mockUrl = `http://127.0.0.1:${mockServer.address().port}`;
  const port = 30000 + Math.floor(Math.random() * 20000);
  proxyUrl = `http://127.0.0.1:${port}`;
  proxy = spawn(process.execPath, [path.join(__dirname, "..", "index.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      DDB_AUTH_URL: `${mockUrl}/v1/cobalt-token`,
      DDB_CHARACTER_BASE_URL: `${mockUrl}/character/v5`,
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  await waitFor(`${proxyUrl}/ping`);
});

after(() => {
  proxy?.kill();
  mockServer?.close();
});

async function inv(op, payload, { characterId = 111, cobalt = COBALT } = {}) {
  const r = await fetch(`${proxyUrl}/proxy/inventory`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cobalt, characterId, op, payload }),
  });
  return { status: r.status, json: await r.json() };
}

const char = (id = 111) => mock.state.characters.get(id);

test("read returns the trimmed inventory, coins and campaign", async () => {
  const { status, json } = await inv("read");
  assert.equal(status, 200);
  assert.equal(json.data.name, "Ireena");
  assert.equal(json.data.campaignId, 999);
  assert.deepEqual(json.data.currencies, { cp: 0, sp: 0, ep: 0, gp: 10, pp: 0 });
  assert.deepEqual(json.data.inventory, []);
});

test("add -> quantity -> equipped -> remove on a character", async () => {
  const add = await inv("add", { equipment: [{ entityId: 2, entityTypeId: ENTITY.ITEM, quantity: 1 }] });
  assert.equal(add.status, 200);
  const row = add.json.data.addItems[0];
  assert.equal(char().inventory[0].definition.name, "Potion of Healing");

  assert.equal((await inv("quantity", { id: row.id, quantity: 3 })).status, 200);
  assert.equal(char().inventory[0].quantity, 3);
  assert.equal((await inv("equipped", { id: row.id, value: true })).status, 200);
  assert.equal(char().inventory[0].equipped, true);

  const read = await inv("read");
  assert.equal(read.json.data.inventory[0].quantity, 3);
  assert.equal(read.json.data.inventory[0].name, "Potion of Healing");

  assert.equal((await inv("remove", { id: row.id, removeContainerContents: false })).status, 200);
  assert.equal(char().inventory.length, 0);
});

test("currency sets the purse absolutely on the character and the party", async () => {
  await inv("currency", { gp: 25, sp: 3, cp: 0, ep: 0, pp: 0, destinationEntityId: 111, destinationEntityTypeId: ENTITY.CHARACTER });
  assert.deepEqual(char().currencies, { cp: 0, sp: 3, ep: 0, gp: 25, pp: 0 });
  await inv("currency", { gp: 7, destinationEntityId: 999, destinationEntityTypeId: ENTITY.CAMPAIGN });
  assert.equal(mock.state.party.get(999).currencies.gp, 7);
});

test("add to the party inventory and a custom item through v5.1", async () => {
  const party = await inv("add", {
    equipment: [{ entityId: 4, entityTypeId: 1782728300, quantity: 2, containerEntityId: 999, containerEntityTypeId: ENTITY.CAMPAIGN }],
  });
  assert.equal(party.status, 200);
  assert.equal(mock.state.party.get(999).inventory[0].quantity, 2);

  const custom = await inv("customItem", { name: "Bonegrinder Bell", quantity: 1, cost: 10, weight: 1, description: "Cold iron" });
  assert.equal(custom.status, 200);
  assert.equal(custom.json.data.addItems[0].definition.name, "Bonegrinder Bell");
  assert.ok(mock.state.calls.some((c) => c.path === "/character/v5.1/custom/item"));
});

test("only whitelisted fields reach D&D Beyond", async () => {
  mock.state.calls.length = 0;
  await inv("quantity", { id: 1, quantity: 2, characterId: 222, evil: "x" });
  const call = mock.state.calls.find((c) => c.path.endsWith("/inventory/item/quantity"));
  assert.deepEqual(call.body, { characterId: 111, id: 1, quantity: 2 }, "payload cannot override characterId or add fields");
});

test("rejections: bad op, bad fields, bad character id, missing cobalt", async () => {
  assert.equal((await inv("nuke", {})).status, 400);
  assert.equal((await inv("quantity", { id: "x", quantity: 1 })).status, 400);
  assert.equal((await inv("add", { equipment: [] })).status, 400);
  assert.equal((await inv("read", {}, { characterId: "abc" })).status, 400);
  const noCobalt = await inv("read", {}, { cobalt: "" });
  assert.equal(noCobalt.json.success, false);
});

test("D&D Beyond errors come back as 502 with ddbStatus", async () => {
  const missing = await inv("remove", { id: 123456 });
  assert.equal(missing.status, 502);
  assert.equal(missing.json.ddbStatus, 404);
  const forbidden = await inv("read", {}, { characterId: 333 });
  assert.equal(forbidden.status, 502);
  assert.equal(forbidden.json.ddbStatus, 403);
  mock.state.failNext.push(503);
  const flaky = await inv("read");
  assert.equal(flaky.json.ddbStatus, 503);
});

test("a wrong cobalt is refused with 401", async () => {
  const r = await inv("read", {}, { cobalt: "WRONG" });
  assert.equal(r.status, 401);
  assert.equal(r.json.success, false);
});

test("an expired bearer token is refreshed once", async () => {
  mock.state.tokens.clear(); // every cached token is now refused by the mock
  const r = await inv("read");
  assert.equal(r.status, 200);
  assert.equal(mock.state.tokens.size, 1);
});

test("the auth service being down answers instead of hanging", async () => {
  mock.state.tokens.clear();
  mock.state.failNext.push(500, 500); // the read's 401 retry hits a broken auth service
  const started = Date.now();
  const r = await inv("read", {}, { cobalt: "OTHER-COBALT" });
  assert.equal(r.json.success, false);
  assert.ok(Date.now() - started < 5000);
});
