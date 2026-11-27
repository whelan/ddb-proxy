const fetch = require("node-fetch");
const CONFIG = require("./config.js");

/**
 * Inventory write operations against the D&D Beyond character service.
 *
 * The paths, verbs and body fields mirror what D&D Beyond's own character
 * sheet sends (read from its public character-app bundle, ApiRequests
 * postCharacterInventoryItem, deleteCharacterInventoryItem,
 * putCharacterInventoryItemQuantity/Move/Equipped/Attuned,
 * putCharacterInventoryCurrency, postCharacterCustomItem).
 *
 * Only whitelisted operations and whitelisted body fields are forwarded, so
 * the route can never be used as an open pass-through to D&D Beyond.
 */

// Container entity type ids used by D&D Beyond's inventory.
const ENTITY_TYPES = {
  CHARACTER: 1581111423,
  ITEM: 1439493548,
  CAMPAIGN: 618115330, // the campaign's party inventory
};

const int = (v) => {
  const n = Number(v);
  return Number.isInteger(n) ? n : undefined;
};
const intOrNull = (v) => (v === null ? null : int(v));
const bool = (v) => (typeof v === "boolean" ? v : undefined);
const str = (max) => (v) => (typeof v === "string" ? v.slice(0, max) : undefined);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function pick(source, spec, required = []) {
  const out = {};
  for (const [key, cast] of Object.entries(spec)) {
    if (source[key] === undefined) continue;
    const value = cast(source[key]);
    if (value === undefined) throw new Error(`Invalid value for "${key}"`);
    out[key] = value;
  }
  for (const key of required) {
    if (out[key] === undefined) throw new Error(`Missing "${key}"`);
  }
  return out;
}

const equipmentEntry = (e) =>
  pick(
    e || {},
    {
      entityId: int,
      entityTypeId: int,
      quantity: int,
      containerEntityId: intOrNull,
      containerEntityTypeId: intOrNull,
    },
    ["entityId", "entityTypeId", "quantity"]
  );

const OPERATIONS = {
  add: {
    method: "POST",
    path: "inventory/item",
    body: (p) => {
      if (!Array.isArray(p.equipment) || p.equipment.length === 0 || p.equipment.length > 50) {
        throw new Error('"equipment" must be an array of 1-50 entries');
      }
      return { equipment: p.equipment.map(equipmentEntry) };
    },
  },
  remove: {
    method: "DELETE",
    path: "inventory/item",
    body: (p) => pick(p, { id: int, removeContainerContents: bool }, ["id"]),
  },
  quantity: {
    method: "PUT",
    path: "inventory/item/quantity",
    body: (p) => pick(p, { id: int, quantity: int }, ["id", "quantity"]),
  },
  move: {
    method: "PUT",
    path: "inventory/item/move",
    body: (p) =>
      pick(p, { id: int, containerEntityId: int, containerEntityTypeId: int }, [
        "id",
        "containerEntityId",
        "containerEntityTypeId",
      ]),
  },
  equipped: {
    method: "PUT",
    path: "inventory/item/equipped",
    body: (p) => pick(p, { id: int, value: bool }, ["id", "value"]),
  },
  attuned: {
    method: "PUT",
    path: "inventory/item/attuned",
    body: (p) => pick(p, { id: int, value: bool }, ["id", "value"]),
  },
  currency: {
    method: "PUT",
    path: "inventory/currency",
    body: (p) =>
      pick(
        p,
        {
          cp: int,
          sp: int,
          ep: int,
          gp: int,
          pp: int,
          destinationEntityId: int,
          destinationEntityTypeId: int,
        },
        ["destinationEntityId", "destinationEntityTypeId"]
      ),
  },
  customItem: {
    // D&D Beyond's sheet creates custom items on v5.1; the new row comes back in data.addItems
    method: "POST",
    path: "custom/item",
    version: "v5.1",
    body: (p) =>
      pick(
        p,
        {
          name: str(256),
          description: str(4000),
          notes: str(1000),
          quantity: int,
          cost: (v) => (v === null ? null : num(v)),
          weight: (v) => (v === null ? null : num(v)),
          containerEntityId: intOrNull,
          containerEntityTypeId: intOrNull,
          partyId: intOrNull,
        },
        ["name", "quantity"]
      ),
  },
};

/**
 * Run one whitelisted inventory operation.
 * @returns {Promise<{status:number, json:object}>}
 */
async function runInventoryOperation(token, characterId, op, payload) {
  const operation = OPERATIONS[op];
  if (!operation) throw new Error(`Unknown inventory operation "${op}"`);
  const body = { characterId, ...operation.body(payload || {}) };

  const base = operation.version
    ? CONFIG.urls.baseUrl.replace(/\/v5$/, `/${operation.version}`)
    : CONFIG.urls.baseUrl;
  const response = await fetch(`${base}/${operation.path}`, {
    method: operation.method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    timeout: 15000,
  });

  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (e) {
    json = { message: text.slice(0, 500) };
  }
  return { status: response.status, json };
}

/**
 * Read the slice of the raw character that inventory sync needs: inventory
 * rows (with their D&D Beyond ids and definition ids), currency and campaign.
 */
async function readInventory(token, characterId) {
  const response = await fetch(CONFIG.urls.characterUrl(characterId), {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 15000,
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.success || !json.data) {
    return { status: response.status, json: { success: false, message: json.message || "Character read failed" } };
  }
  const data = json.data;
  const inventory = (data.inventory || []).map((row) => ({
    id: row.id,
    entityTypeId: row.entityTypeId,
    definitionId: row.definitionId,
    definitionTypeId: row.definitionTypeId,
    containerEntityId: row.containerEntityId,
    containerEntityTypeId: row.containerEntityTypeId,
    quantity: row.quantity,
    equipped: row.equipped,
    isAttuned: row.isAttuned,
    name: row.definition ? row.definition.name : null,
  }));
  const customItems = (data.customItems || []).map((row) => ({
    id: row.id,
    name: row.name,
    quantity: row.quantity,
  }));
  return {
    status: 200,
    json: {
      success: true,
      data: {
        id: data.id,
        name: data.name,
        currencies: data.currencies || null,
        campaignId: data.campaign ? data.campaign.id : null,
        inventory,
        customItems,
      },
    },
  };
}

exports.readInventory = readInventory;
exports.ENTITY_TYPES = ENTITY_TYPES;
exports.OPERATIONS = OPERATIONS;
exports.runInventoryOperation = runInventoryOperation;
