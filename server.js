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
  importScripts(
    "https://cdn.jsdelivr.net/npm/@mercuryworkshop/scramjet@1.1.0/dist/scramjet.all.js"
  );
  const { ScramjetServiceWorker } = $scramjetLoadWorker();
  const scramjet = new ScramjetServiceWorker();

  self.addEventListener("fetch", (event) => {
    event.respondWith(
      (async () => {
        await scramjet.loadConfig();
        if (scramjet.route(event)) return scramjet.fetch(event);
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
