/**
 * Mock D&D Beyond (auth service + the character-service endpoints that
 * /proxy/inventory uses), in memory. Point the proxy at it with
 *   DDB_AUTH_URL=http://localhost:<port>/v1/cobalt-token
 *   DDB_CHARACTER_BASE_URL=http://localhost:<port>/character/v5
 *
 * Run standalone:  node test/mock-ddb.js [port]   (default 3998)
 */
const express = require("express");

const ENTITY = { CHARACTER: 1581111423, ITEM: 1439493548, CAMPAIGN: 618115330 };

const DEFINITIONS = [
  { id: 2, entityTypeId: 1439493548, name: "Potion of Healing", isHomebrew: false, isLegacy: false },
  { id: 3, entityTypeId: 2103445194, name: "Rope, Hempen (50 feet)", isHomebrew: false, isLegacy: false },
  { id: 4, entityTypeId: 1782728300, name: "Dagger", isHomebrew: false, isLegacy: false },
];

function createMockDdb({ cobalt = "GOOD-COBALT", characters } = {}) {
  const state = {
    tokens: new Set(),
    nextRowId: 1000,
    characters: new Map(),
    party: new Map(), // campaignId -> { inventory: [], currencies }
    calls: [],
    failNext: [], // queue of HTTP statuses to answer with before doing anything
  };

  const seed = characters || [{ id: 111, name: "Ireena", campaignId: 999 }, { id: 222, name: "Ismark", campaignId: 999 }];
  for (const c of seed) {
    state.characters.set(c.id, {
      id: c.id,
      name: c.name,
      campaign: c.campaignId ? { id: c.campaignId } : null,
      currencies: { cp: 0, sp: 0, ep: 0, gp: 10, pp: 0 },
      inventory: [],
      customItems: [],
    });
  }

  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    state.calls.push({ method: req.method, path: req.path, body: req.body, auth: req.headers.authorization || null });
    const status = state.failNext.shift();
    if (status) return res.status(status).json({ success: false, message: `mock failure ${status}` });
    next();
  });

  app.post("/v1/cobalt-token", (req, res) => {
    const cookie = req.headers.cookie || "";
    if (cookie !== `CobaltSession=${cobalt}`) return res.status(401).json({});
    const token = `tok-${state.tokens.size + 1}`;
    state.tokens.add(token);
    return res.json({ token, ttl: 300 });
  });

  const authed = (req, res, next) => {
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    if (!state.tokens.has(token)) return res.status(401).json({ success: false, message: "Unauthorized" });
    next();
  };

  const character = (req, res) => {
    const id = Number(req.body.characterId || req.params.id);
    const c = state.characters.get(id);
    if (!c) {
      res.status(403).json({ success: false, message: "Forbidden" });
      return null;
    }
    return c;
  };

  const definition = (entityId) => DEFINITIONS.find((d) => d.id === entityId) || null;

  const partyOf = (campaignId) => {
    if (!state.party.has(campaignId)) {
      state.party.set(campaignId, { inventory: [], currencies: { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 } });
    }
    return state.party.get(campaignId);
  };

  /** Find a row on the character or in its campaign's party inventory. */
  const findRow = (c, id) => {
    const own = c.inventory.find((r) => r.id === id);
    if (own) return { list: c.inventory, row: own };
    if (c.campaign) {
      const party = partyOf(c.campaign.id);
      const row = party.inventory.find((r) => r.id === id);
      if (row) return { list: party.inventory, row };
    }
    return null;
  };

  const router = express.Router();
  router.use(authed);

  router.get("/character/:id", (req, res) => {
    const c = character(req, res);
    if (!c) return;
    res.json({ success: true, data: c });
  });

  router.get("/game-data/items", (req, res) => res.json({ success: true, data: DEFINITIONS }));

  router.post("/inventory/item", (req, res) => {
    const c = character(req, res);
    if (!c) return;
    const added = [];
    for (const e of req.body.equipment || []) {
      const def = definition(e.entityId);
      if (!def || def.entityTypeId !== e.entityTypeId) {
        return res.status(400).json({ success: false, message: `Unknown definition ${e.entityId}` });
      }
      const toParty = e.containerEntityTypeId === ENTITY.CAMPAIGN;
      if (toParty && (!c.campaign || c.campaign.id !== e.containerEntityId)) {
        return res.status(400).json({ success: false, message: "Character is not in that campaign" });
      }
      const row = {
        id: state.nextRowId++,
        entityTypeId: def.entityTypeId,
        definitionId: def.id,
        definitionTypeId: def.entityTypeId,
        containerEntityId: toParty ? e.containerEntityId : c.id,
        containerEntityTypeId: toParty ? ENTITY.CAMPAIGN : ENTITY.CHARACTER,
        quantity: e.quantity,
        equipped: false,
        isAttuned: false,
        definition: { id: def.id, name: def.name },
      };
      (toParty ? partyOf(e.containerEntityId).inventory : c.inventory).push(row);
      added.push(row);
    }
    res.json({ success: true, data: { addItems: added } });
  });

  router.delete("/inventory/item", (req, res) => {
    const c = character(req, res);
    if (!c) return;
    const hit = findRow(c, Number(req.body.id));
    if (!hit) return res.status(404).json({ success: false, message: "Item not found" });
    hit.list.splice(hit.list.indexOf(hit.row), 1);
    res.json({ success: true, data: {} });
  });

  const rowUpdate = (field, from) => (req, res) => {
    const c = character(req, res);
    if (!c) return;
    const hit = findRow(c, Number(req.body.id));
    if (!hit) return res.status(404).json({ success: false, message: "Item not found" });
    hit.row[field] = req.body[from];
    res.json({ success: true, data: {} });
  };
  router.put("/inventory/item/quantity", rowUpdate("quantity", "quantity"));
  router.put("/inventory/item/equipped", rowUpdate("equipped", "value"));
  router.put("/inventory/item/attuned", rowUpdate("isAttuned", "value"));
  router.put("/inventory/item/move", (req, res) => {
    const c = character(req, res);
    if (!c) return;
    const hit = findRow(c, Number(req.body.id));
    if (!hit) return res.status(404).json({ success: false, message: "Item not found" });
    hit.row.containerEntityId = req.body.containerEntityId;
    hit.row.containerEntityTypeId = req.body.containerEntityTypeId;
    res.json({ success: true, data: {} });
  });

  router.put("/inventory/currency", (req, res) => {
    const c = character(req, res);
    if (!c) return;
    const { destinationEntityId, destinationEntityTypeId } = req.body;
    let purse;
    if (destinationEntityTypeId === ENTITY.CHARACTER && destinationEntityId === c.id) purse = c.currencies;
    else if (destinationEntityTypeId === ENTITY.CAMPAIGN && c.campaign && c.campaign.id === destinationEntityId) {
      purse = partyOf(destinationEntityId).currencies;
    } else return res.status(400).json({ success: false, message: "Bad currency destination" });
    for (const coin of ["cp", "sp", "ep", "gp", "pp"]) if (req.body[coin] !== undefined) purse[coin] = req.body[coin];
    res.json({ success: true, data: {} });
  });

  const custom = express.Router();
  custom.use(authed);
  custom.post("/custom/item", (req, res) => {
    const c = character(req, res);
    if (!c) return;
    const toParty = req.body.containerEntityTypeId === ENTITY.CAMPAIGN;
    const row = {
      id: state.nextRowId++,
      entityTypeId: 0,
      definitionId: null,
      definitionTypeId: null,
      containerEntityId: toParty ? req.body.containerEntityId : c.id,
      containerEntityTypeId: toParty ? ENTITY.CAMPAIGN : ENTITY.CHARACTER,
      quantity: req.body.quantity,
      equipped: false,
      isAttuned: false,
      definition: { id: null, name: req.body.name },
    };
    (toParty ? partyOf(req.body.containerEntityId).inventory : c.inventory).push(row);
    res.json({ success: true, data: { addItems: [row] } });
  });

  app.use("/character/v5", router);
  app.use("/character/v5.1", custom);

  return { app, state, ENTITY, DEFINITIONS };
}

module.exports = { createMockDdb, ENTITY, DEFINITIONS };

if (require.main === module) {
  const port = Number(process.argv[2]) || 3998;
  const { app } = createMockDdb();
  app.listen(port, () => console.log(`Mock D&D Beyond on :${port} (cobalt: GOOD-COBALT)`));
}
