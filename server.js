#!/usr/bin/env node
/* ============================================================================
   THIS FILE HAS TWO JOBS (that's why the repo only needs 2 files):

   1) On GitHub Pages the browser loads this file as the SERVICE WORKER.
      It relays Scramjet's proxied requests to the page (v2 architecture)
      and serves the converted scramjet runtime at  <base>/sj-runtime.js.
      Nothing else in this file executes on GitHub Pages.

   2) OPTIONAL: run it yourself later with  `node server.js`  and it becomes
      a full backend (its own wisp engine at /wisp/ + a public JSON API at
      /api/health, /api/encode, /api/fetch). You don't need this for the
      GitHub Pages site to work.
   ============================================================================ */
"use strict";

/* ---------------------------------------------------------------------------
   PART 1 — SERVICE-WORKER MODE (runs inside the browser)
   Scramjet v2 architecture:
     - the SW is a thin RPC relay (controller.sw.js): every proxied request
       is forwarded to the page's Controller over a MessagePort
     - the transport (wisp) runs IN THE PAGE — no worker features needed,
       which makes this work on iOS Safari & private browsing out of the box
     - the rewriter runtime is an ESM build on the CDN; the page (and every
       proxied page) needs it as a CLASSIC script, so we convert it
       on the fly and serve it at  <base>/sj-runtime.js
   No IndexedDB anywhere in the SW.
   --------------------------------------------------------------------------- */
if (typeof importScripts === "function" && typeof self !== "undefined" && !("window" in self)) {
  const SJ_VERSION = "2.0.67-alpha.2";
  const SJ_CDN = "https://cdn.jsdelivr.net/npm/@mercuryworkshop/scramjet@" + SJ_VERSION + "/dist";
  const CONTROLLER_CDN =
    "https://cdn.jsdelivr.net/npm/@mercuryworkshop/scramjet-controller@0.0.14/dist";

  // the SW-side controller (RPC relay): defines $scramjetController
  importScripts(CONTROLLER_CDN + "/controller.sw.js");

  /* ---- ESM -> classic IIFE conversion of the scramjet runtime ----------
     The npm build is an ES module (`export{a as X,...}` at the end, zero
     import statements). Proxied pages inject it via a plain <script src>,
     so we rewrite the export tail into `globalThis.$scramjet = {...}` and
     wrap it in an IIFE. Cached in memory after the first conversion. */
  let sjRuntimePromise = null;
  function sjRuntimeSrc() {
    if (!sjRuntimePromise) {
      sjRuntimePromise = (async () => {
        const res = await fetch(SJ_CDN + "/scramjet.mjs");
        if (!res.ok) throw new Error("failed to fetch scramjet runtime: " + res.status);
        let src = await res.text();
        /* Compat patch: the bundle uses two regexes with the new "(?i:...)"
           inline-modifier syntax that older Safari/Chrome choke on. Rewrite
           them to the equivalent global-i-flag form (the only letters in
           those patterns are "url"/"@import", so /i is equivalent). */
        src = src
          .replace("/(?i:url)", "/url")
          .replace("((?i:url)", "(url")
          .replace("))\\)/gm,(t,n,o,a)=>", "))\\)/gmi,(t,n,o,a)=>")
          .replace("($|\\s|;)/gm,(t,n)=>", "($|\\s|;)/gmi,(t,n)=>");
        const m = src.match(/export\{([\s\S]*?)\}\s*;?\s*(?:\/\/[^\n]*)?\s*$/);
        if (!m) throw new Error("scramjet runtime: export tail not found");
        const body = src.slice(0, m.index);
        const seen = {};
        const pairs = [];
        for (const part of m[1].split(",")) {
          const kv = part.trim().split(/\s+as\s+/);
          if (!kv[0]) continue;
          const local = kv[0], exported = kv.length > 1 ? kv[1] : kv[0];
          if (seen[exported]) continue;
          seen[exported] = true;
          pairs.push('"' + exported + '":' + local);
        }
        return (
          '"use strict";(function(){' +
          body +
          ";globalThis.$scramjet={" + pairs.join(",") + "};})();"
        );
      })().catch((e) => {
        sjRuntimePromise = null; // allow retry on next request
        throw e;
      });
    }
    return sjRuntimePromise;
  }

  const sjBase = () => new URL(self.registration.scope).pathname;

  self.addEventListener("fetch", (event) => {
    try {
      const url = new URL(event.request.url);
      // our virtual file: the converted scramjet runtime (classic script)
      if (url.origin === self.location.origin && url.pathname === sjBase() + "sj-runtime.js") {
        event.respondWith(
          sjRuntimeSrc()
            .then(
              (code) =>
                new Response(code, {
                  headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" },
                })
            )
            .catch((e) => new Response("/* " + e + " */", { status: 502 }))
        );
        return;
      }
      // anything matching a controller prefix -> RPC to the page's Controller
      if ($scramjetController.shouldRoute(event)) {
        event.respondWith($scramjetController.route(event));
        return;
      }
      // a proxied-looking request that no controller claimed (e.g. the page
      // is an old cached copy from a previous version) -> explain instead of
      // falling through to the host's own 404 page
      if (
        event.request.mode === "navigate" &&
        url.origin === self.location.origin &&
        url.pathname.startsWith(sjBase() + "scramjet/")
      ) {
        event.respondWith(
          Promise.resolve(
            new Response(
              "<!doctype html><meta charset=utf-8><title>Update needed</title>" +
                "<body style='font:15px system-ui;padding:40px;max-width:560px'>" +
                "<h2>Scramjet Gateway was updated</h2>" +
                "<p>The page you have open is an old cached version and can't talk to the new service worker.</p>" +
                "<p><b>Hard-refresh this tab</b> (or close it and open the site again)." +
                " On a phone: close ALL tabs of this site, then reopen it.</p>" +
                "<p><button onclick=\"window.top.location.replace('" +
                sjBase() +
                "?r=' + Date.now())\">Reload the site</button></p>",
              { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
            )
          )
        );
        return;
      }
      // everything else falls through to the network
    } catch (err) {
      console.error("[sj-sw] fetch handler error:", err);
    }
  });
  /* NOTE: controller.sw.js itself registers install(skipWaiting),
     activate(clients.claim) and the SW<->page message plumbing. */
} else {
  /* -------------------------------------------------------------------------
     PART 2 — OPTIONAL NODE BACKEND (wisp server + public API)
     ------------------------------------------------------------------------- */
  const http = require("http");
  const path = require("path");
  const express = require("express");
  const { server: wisp, logging } = require("@mercuryworkshop/wisp-js/server");

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

  /* =================== STATIC: the site (everything else comes from CDN /
     the service worker's virtual sj-runtime.js route) ==================== */
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
