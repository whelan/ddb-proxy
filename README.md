# ddb-proxy

This proxy allows for communication with DDB for use integrating content into Foundry VTT.

It provides the following backend functionality for [ddb-importer](https://github.com/MrPrimate/ddb-importer)

* Characters
* Spells
* Items
* Monsters


## Setup

This proxy is updated to work with the latest version of DDB Importer as quickly as possible.

Run this as a [nodeJS](https://nodejs.org/en/) app the standard way.

Install:

```
yarn install
```

Run:

```
node index.js
```

You can also run this as a docker image, for details see [Docker instructions](docker/README.md)

It _must_ be proxied behind a service providing an SSL/TLS encryption if you are not running on your local machine. I would recommend [Caddy](https://caddyserver.com/).

If using DDB Importer v3.1.26 or higher you can enable the custom proxy and change the endpoint address in the settings menu.
> Note: the endpoint address should not have a forward slash at the end. For example: http://example.com:3000 rather than http://exampole.com:3000/

If using an earlier version, in Foundry's developer console or the web browser's developer console (depending on how you're hosting Foundry) run the following commands:

```javascript
game.settings.set("ddb-importer", "custom-proxy", true);
game.settings.set("ddb-importer", "api-endpoint", "YOUR_URL_HERE");
```

e.g. running locally

```javascript
game.settings.set("ddb-importer", "custom-proxy", true);
game.settings.set("ddb-importer", "api-endpoint", "http://localhost:3000");
```

To revert to MrPrimate's proxy:
```javascript
game.settings.set("ddb-importer", "api-endpoint", "https://proxy.ddb.mrprimate.co.uk");
game.settings.set("ddb-importer", "custom-proxy", false);
```

## How can I see if the server is running?

Visit `YOUR_URL_HERE/ping` e.g. `https://myddbproxy.example.com/ping`

## Why is x feature missing

This is a cut down, MVP implementation of the proxy, it is meant for individual use and does not implement caching. It should not be run as a service for others.

It does not include and features in development.


## Support

No support is provided for this software.

## Inventory sync (`/proxy/inventory`)

Used by the `ddb-inventory-sync` Foundry module to write loot and merchant trades back to
D&D Beyond. D&D Beyond's API only answers CORS for `www.dndbeyond.com`, so a Foundry module
cannot call it directly; this route is the bridge.

`POST /proxy/inventory` with `{ cobalt, characterId, op, payload }`:

| op | D&D Beyond call | payload |
|---|---|---|
| `read` | `GET character/{id}` (trimmed to inventory, currencies, campaignId) | — |
| `add` | `POST inventory/item` | `{ equipment: [{ entityId, entityTypeId, quantity, containerEntityId?, containerEntityTypeId? }] }` |
| `remove` | `DELETE inventory/item` | `{ id, removeContainerContents? }` |
| `quantity` | `PUT inventory/item/quantity` | `{ id, quantity }` |
| `move` | `PUT inventory/item/move` | `{ id, containerEntityId, containerEntityTypeId }` |
| `equipped` / `attuned` | `PUT inventory/item/equipped` / `attuned` | `{ id, value }` |
| `currency` | `PUT inventory/currency` | `{ cp, sp, ep, gp, pp, destinationEntityId, destinationEntityTypeId }` |
| `customItem` | `POST v5.1/custom/item` | `{ name, quantity, description?, notes?, cost?, weight?, containerEntityId?, containerEntityTypeId?, partyId? }` |

Container entity type ids: character `1581111423`, item (a bag) `1439493548`, campaign party
inventory `618115330` (with the campaign id as `containerEntityId`). Only these operations and
fields are forwarded; anything else is rejected with 400. Writes that create rows answer with the new rows in `data.addItems`. The endpoints are the ones D&D
Beyond's own character sheet uses; they are unofficial and can change without notice.
