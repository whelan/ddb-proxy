const crypto = require("crypto");
const Cache = require("./cache");
const fetch = require("node-fetch");
const CONFIG = require("./config.js");

var CACHE_AUTH = new Cache("AUTH", 0.08);

function isJSON(str) {
  try {
    return (JSON.parse(str) && !!str);
  } catch (e) {
    return false;
  }
}

function getBearerToken(id, cobalt) {
  return new Promise((resolve) => {
    if (cobalt && cobalt !== "" && !isJSON(`{ "cobalt": "${cobalt}" }`)) {
      console.log(`Invalid token for ${id}`);
      resolve(null);
    } else if (cobalt && cobalt !== "") {
      const cached = CACHE_AUTH.exists(id);
      if (cached && cached.data) {
        resolve(cached.data);
        return;
      }
      fetch(CONFIG.urls.authService, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `CobaltSession=${cobalt}`,
        },
        timeout: 15000,
      })
        .then((response) => response.json())
        .then((data) => {
          if (!data || !data.token || !data.token.length) {
            resolve(null);
            return;
          }
          CACHE_AUTH.add(id, data.token);
          resolve(data.token);
        })
        .catch((error) => {
          // A network error or a non-JSON answer must not leave the request hanging.
          console.log(`Auth service error for ${id}: ${error.message || error}`);
          resolve(null);
        });
    } else {
      console.log("NO COBALT TOKEN");
      resolve(null);
    }
  });
}


function getCacheId(value) {
  const hash = crypto.createHash("sha256");
  hash.update(value);
  const cacheId = hash.digest("hex");
  return cacheId;
}



exports.CACHE_AUTH = CACHE_AUTH;
exports.getBearerToken = getBearerToken;
exports.getCacheId = getCacheId;
