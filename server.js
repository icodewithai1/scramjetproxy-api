#!/usr/bin/env node
/* ============================================================================
   THIS FILE HAS TWO JOBS (that's why the repo only needs 2 files):

   1) On GitHub Pages the browser loads this file as the SERVICE WORKER.
      Only the tiny block below runs there — it intercepts requests and lets
      Scramjet rewrite + route them through the wisp relay. Nothing else
      in this file executes on GitHub Pages.

   2) OPTIONAL: run it yourself later with  `node server.js`  and it becomes
      a full backend (its own wisp engine at /wisp/ + a public JSON API at
      /api/health, /api/encode, /api/fetch). You don't need this for the
      GitHub Pages site to work.
   ============================================================================ */
"use strict";

/* ---------------------------------------------------------------------------
   PART 1 — SERVICE-WORKER MODE (runs inside the browser)
   --------------------------------------------------------------------------- */
if (typeof importScripts === "function" && typeof self !== "undefined" && !("window" in self)) {
  /* --- In-memory IndexedDB shim ----------------------------------------
     Scramjet stores its config + cookies in IndexedDB, but IDB inside
     service workers is unreliable on iOS Safari (and absent in private
     browsing). The page re-sends us the config on every load anyway, so
     we swap `indexedDB` for a tiny in-memory implementation that speaks
     enough of the API for the `idb` library Scramjet bundles. Real IDB
     is never touched in the SW -> works everywhere. */
  const sjFakeIDB = (() => {
    const proto = (k, fb) => {
      try { const g = self[k]; if (g && g.prototype) return g.prototype; } catch {}
      return fb || Object.prototype;
    };
    const P_REQ = proto("IDBOpenDBRequest", proto("IDBRequest"));
    const P_DB = proto("IDBDatabase");
    const P_TX = proto("IDBTransaction");
    const P_STORE = proto("IDBObjectStore");
    const dbs = new Map(); // name -> Map(storeName -> Map(key -> value))

    // defineProperty because the real prototypes expose getter-only props
    // (result, error, objectStoreNames, mode) — plain assignment throws.
    const def = (o, k, v) => Object.defineProperty(o, k, { value: v, configurable: true, writable: true });

    const listeners = () => {
      const m = new Map();
      return {
        addEventListener: (t, f) => { (m.get(t) || m.set(t, []).get(t)).push(f); },
        removeEventListener: () => {},
        _fire: (t, ev) => { (m.get(t) || []).forEach((f) => { try { f(ev); } catch {} }); },
      };
    };

    function makeRequest() {
      const r = Object.create(P_REQ);
      def(r, "result", undefined); def(r, "error", null);
      // on* IDL attributes can't be assigned on create(proto) objects in Chrome
      def(r, "onsuccess", null); def(r, "onerror", null);
      def(r, "oncomplete", null); def(r, "onabort", null);
      const L = listeners();
      r.addEventListener = L.addEventListener; r.removeEventListener = L.removeEventListener;
      r._fire = L._fire;
      return r;
    }
    function resolveReq(r, value) {
      def(r, "result", value);
      queueMicrotask(() => {
        try { r.onsuccess && r.onsuccess({ target: r }); } catch {}
        try { r._fire("success", { target: r }); } catch {}
      });
    }
    function makeStore(map) {
      const s = Object.create(P_STORE);
      s.get = (k) => { const r = makeRequest(); resolveReq(r, map.get(k)); return r; };
      s.put = (v, k) => { const r = makeRequest(); map.set(k, v); resolveReq(r, k); return r; };
      s.add = s.put;
      s.delete = (k) => { const r = makeRequest(); map.delete(k); resolveReq(r, undefined); return r; };
      s.clear = () => { const r = makeRequest(); map.clear(); resolveReq(r, undefined); return r; };
      return s;
    }
    function makeDB(stores) {
      const db = Object.create(P_DB);
      def(db, "objectStoreNames", {
        contains: (n) => stores.has(n),
        get length() { return stores.size; },
        item: (i) => [...stores.keys()][i] || null,
      });
      db.createObjectStore = (n) => { if (!stores.has(n)) stores.set(n, new Map()); return makeStore(stores.get(n)); };
      db.transaction = (names) => {
        const list = Array.isArray(names) ? names : [names];
        for (const n of list) if (!stores.has(n)) stores.set(n, new Map());
        const tx = Object.create(P_TX);
        const L = listeners();
        tx.addEventListener = L.addEventListener; tx.removeEventListener = L.removeEventListener;
        def(tx, "objectStoreNames", list.slice()); // idb's tx.store accessor indexes this
        tx.objectStore = (n) => makeStore(stores.get(n));
        def(tx, "abort", () => {}); def(tx, "commit", () => {});
        def(tx, "oncomplete", null); def(tx, "onerror", null); def(tx, "onabort", null);
        def(tx, "error", null); def(tx, "mode", "readwrite");
        setTimeout(() => { try { L._fire("complete", { target: tx }); } catch {} }, 0);
        return tx;
      };
      def(db, "close", () => {});
      def(db, "onabort", null); def(db, "onerror", null);
      def(db, "onclose", null); def(db, "onversionchange", null);
      const L = listeners();
      db.addEventListener = L.addEventListener; db.removeEventListener = L.removeEventListener;
      return db;
    }
    return {
      open(name) {
        const r = makeRequest();
        queueMicrotask(() => {
          if (!dbs.has(name)) dbs.set(name, new Map());
          resolveReq(r, makeDB(dbs.get(name)));
        });
        return r;
      },
      deleteDatabase(name) { const r = makeRequest(); dbs.delete(name); resolveReq(r, undefined); return r; },
      cmp: () => 0,
      databases: async () => [],
      // direct seed (used for the config the page posts to us)
      _set(name, storeName, key, value) {
        if (!dbs.has(name)) dbs.set(name, new Map());
        const stores = dbs.get(name);
        if (!stores.has(storeName)) stores.set(storeName, new Map());
        stores.get(storeName).set(key, value);
      },
    };
  })();

  try { self.indexedDB = sjFakeIDB; } catch {}
  if (self.indexedDB !== sjFakeIDB) {
    try { Object.defineProperty(self, "indexedDB", { value: sjFakeIDB, configurable: true }); } catch {}
  }

  /* Capture the config the page's controller sends us, into the mem DB.
     (Registered before importScripts so nothing can be missed.) */
  self.addEventListener("message", (ev) => {
    const d = ev && ev.data;
    if (d && typeof d === "object" && d.scramjet$type === "loadConfig" && d.config) {
      sjFakeIDB._set("$scramjet", "config", "config", d.config);
    }
  });

  importScripts(
    "https://cdn.jsdelivr.net/npm/@mercuryworkshop/scramjet@1.1.0/dist/scramjet.all.js"
  );

  const { ScramjetServiceWorker } = $scramjetLoadWorker();
  const scramjet = new ScramjetServiceWorker();

  // replace any old SW version + take control of open pages immediately
  self.addEventListener("install", () => { self.skipWaiting(); });
  self.addEventListener("activate", (event) => {
    event.waitUntil(self.clients.claim());
  });

  /* Config flow: the page posts {scramjet$type:"loadConfig", config} which
     the class stores as this.config — but that path skips scramjet's real
     setConfig()/wasm init, crashing later with "Cannot read properties of
     undefined (reading 'prefix')". So once, we clear it and run
     loadConfig() through the (in-memory) DB path, which does the full
     init properly. */
  let sjConfigInited = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function sjEnsureConfig() {
    if (sjConfigInited) return true;
    try {
      scramjet.config = undefined;
      await scramjet.loadConfig();
      if (scramjet.config) { sjConfigInited = true; return true; }
    } catch (e) {
      console.warn("[sj-sw] loadConfig error:", (e && e.stack) || e);
    }
    return false;
  }

  self.addEventListener("fetch", (event) => {
    event.respondWith(
      (async () => {
        try {
          if (!(await sjEnsureConfig())) {
            // page still booting -> wait for its config message (up to ~10s)
            for (let i = 0; i < 40 && !sjConfigInited; i++) {
              await sleep(250);
              if (await sjEnsureConfig()) break;
            }
          }
          if (sjConfigInited && scramjet.route(event)) return scramjet.fetch(event);
        } catch (err) {
          console.error("[sj-sw] fetch error:", err);
        }
        return fetch(event.request); // not a proxied request -> pass through
      })()
    );
  });
} else {
  /* -------------------------------------------------------------------------
     PART 2 — OPTIONAL NODE BACKEND (wisp server + public API)
     ------------------------------------------------------------------------- */
  const http = require("http");
  const path = require("path");
  const express = require("express");
  const { server: wisp, logging } = require("@mercuryworkshop/wisp-js/server");
  const { scramjetPath } = require("@mercuryworkshop/scramjet/path");
  const { baremuxPath } = require("@mercuryworkshop/bare-mux/node");
  const { libcurlPath } = require("@mercuryworkshop/libcurl-transport");

  const PORT = parseInt(process.env.PORT || "8080", 10);
  logging.set_level(logging.ERROR);

  const app = express();
  app.disable("x-powered-by");

  /* ============================== PUBLIC API ============================== */
  const hits = new Map();
  const rateLimited = (ip) => {
    const now = Date.now();
    let h = hits.get(ip);
    if (!h || now - h.t > 60_000) h = { n: 0, t: now };
    h.n += 1;
    hits.set(ip, h);
    if (hits.size > 10_000) hits.clear();
    return h.n > 60;
  };

  app.use("/api", (req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "*");
    next();
  });

  app.get("/api", (req, res) => {
    const origin = req.protocol + "://" + req.get("host");
    res.json({
      name: "scramjet-gateway API",
      endpoints: {
        health: origin + "/api/health",
        encode: origin + "/api/encode?url=https://example.com",
        fetch: origin + "/api/fetch?url=https://example.com",
      },
      wisp: origin.replace(/^http/, "ws") + "/wisp/",
    });
  });

  // GET /api/health -> is the backend alive?
  app.get("/api/health", (req, res) => {
    res.json({ ok: true, service: "scramjet-gateway", wisp: "/wisp/", uptime_s: Math.round(process.uptime()), time: new Date().toISOString() });
  });

  // GET /api/encode?url=... -> the scramjet-encoded path for that url
  app.get("/api/encode", (req, res) => {
    const raw = String(req.query.url || "");
    if (!raw) return res.status(400).json({ error: "missing ?url= parameter" });
    try {
      const u = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw);
      if (!/^https?:$/.test(u.protocol)) throw new Error("bad protocol");
      const encoded = encodeURIComponent(u.href);
      res.json({ url: u.href, encoded, proxied_path: "/scramjet/" + encoded, note: "full proxied url = <frontend origin><scramjet prefix>" + encoded });
    } catch {
      res.status(400).json({ error: "invalid url" });
    }
  });

  // GET /api/fetch?url=... -> server-side fetch, returns the page as JSON
  app.get("/api/fetch", async (req, res) => {
    if (rateLimited(req.ip)) return res.status(429).json({ error: "rate limit exceeded (60 req/min)" });
    const raw = String(req.query.url || "");
    if (!raw) return res.status(400).json({ error: "missing ?url= parameter" });
    let u;
    try {
      u = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw);
      if (!/^https?:$/.test(u.protocol)) throw new Error();
    } catch {
      return res.status(400).json({ error: "invalid url (http/https only)" });
    }
    try {
      const r = await fetch(u.href, {
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
        headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) scramjet-gateway/1.0" },
      });
      const buf = Buffer.from(await r.arrayBuffer());
      const MAX = 512 * 1024;
      res.json({ ok: r.ok, url: r.url, status: r.status, contentType: r.headers.get("content-type"), bytes: buf.length, truncated: buf.length > MAX, body: buf.subarray(0, MAX).toString("utf8") });
    } catch (err) {
      res.status(502).json({ error: "fetch failed", detail: String((err && err.message) || err) });
    }
  });

  /* =================== STATIC: proxy assets + the site =================== */
  app.use("/scram", express.static(scramjetPath));
  app.use("/baremux", express.static(baremuxPath));
  app.use("/libcurl", express.static(libcurlPath));
  app.get("/server.js", (req, res) => res.type("text/javascript").sendFile(__filename));
  app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

  /* ============================ WISP + LISTEN ============================ */
  const server = http.createServer(app);
  server.on("upgrade", (req, socket, head) => {
    if (req.url && req.url.split("?")[0].endsWith("/wisp/")) wisp.routeRequest(req, socket, head);
    else socket.destroy();
  });
  server.listen(PORT, "0.0.0.0", () => {
    console.log("⚡ scramjet-gateway running");
    console.log("   site: http://localhost:" + PORT + "/");
    console.log("   wisp: ws://localhost:" + PORT + "/wisp/");
    console.log("   api:  http://localhost:" + PORT + "/api");
  });
}
