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
                "<p><button onclick=\"try{window.top.location.replace('" +
                sjBase() +
                "?r=' + Date.now())}catch(e){location.replace('" +
                sjBase() +
                "?r=' + Date.now())}\">Reload the site</button></p>",
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
  const tls = require("tls");
  const stream = require("stream");
  const express = require("express");
  const { server: wisp, logging } = require("@mercuryworkshop/wisp-js/server");
  let WSImpl = null, nativeWS = false; // Node >= 22 has global WebSocket; else use `ws`
  if (typeof WebSocket !== "undefined") { WSImpl = WebSocket; nativeWS = true; }
  else { try { WSImpl = require("ws"); } catch {} }

  const PORT = parseInt(process.env.PORT || "8080", 10);
  logging.set_level(logging.ERROR);

  const app = express();
  app.disable("x-powered-by");

  /* ==================== WISP RELAY TUNNEL (fetch like scramjet) ========== */
  /* Same relays the frontend uses. Wisp is a raw TCP tunnel, so TLS is done
     in-process (Node's tls over the tunnel) and we speak plain HTTP/1.1. */
  const RELAYS = ["wss://w2.qwq.sh/ws/", "wss://wisp.mercurywork.shop/wisp/", "wss://hydrovolter.com/wisp/"];
  const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
  const BODY_CAP = 5 * 1024 * 1024;

  function openSocket(url, timeout) {
    return new Promise((resolve, reject) => {
      const socket = nativeWS ? new WSImpl(url) : new WSImpl(url, { followRedirects: false });
      const kill = setTimeout(() => { try { socket.close(); } catch {} reject(new Error("ws timeout")); }, timeout);
      socket.binaryType = "arraybuffer";
      socket.onopen = () => { clearTimeout(kill); resolve(socket); };
      socket.onerror = (e) => { clearTimeout(kill); reject(new Error("ws error " + ((e && e.message) || ""))); };
    });
  }

  /* wisp framing: [u8 type][u32 stream LE][payload] — types from wisp-js:
     0x01 CONNECT (u8 proto=1 TCP, u16 port LE, hostname) · 0x02 DATA ·
     0x03 CONTINUE (u32 buffer_remaining LE) · 0x04 CLOSE · 0x05 INFO      */
  class WispTunnel {
    constructor(socket, host, port) {
      this.socket = socket; this.id = 1; this.host = host;
      this.acc = Buffer.alloc(0); this.chunks = []; this.pending = null;
      this.done = false; this.continueRemaining = Infinity; this.continueWaiters = [];
      socket.onmessage = (ev) => this._onData(Buffer.from(ev.data instanceof ArrayBuffer ? ev.data : ev.data.buffer));
      socket.onclose = () => this._finish();
      const c = Buffer.alloc(5 + 3 + Buffer.byteLength(host));
      c.writeUInt8(0x01, 0); c.writeUInt32LE(this.id, 1);
      c.writeUInt8(1, 5); c.writeUInt16LE(port, 6);
      c.write(host, 8, "utf8");
      socket.send(c);
    }
    _finish() { if (!this.done) { this.done = true; this.chunks.push(null); if (this.pending) this.pending(); } }
    _onData(buf) {
      this.acc = Buffer.concat([this.acc, buf]);
      while (this.acc.length >= 5) {
        const type = this.acc.readUInt8(0);
        const id = this.acc.readUInt32LE(1);
        if (type === 0x02) {
          // DATA has no length prefix — the rest of the ws message is payload
          const payload = this.acc.subarray(5); this.acc = Buffer.alloc(0);
          if (id === this.id) { this.chunks.push(Buffer.from(payload)); if (this.pending) this.pending(); }
          return;
        }
        let need = 5, parse = null;
        if (type === 0x03) { need = 5 + 4; parse = (p) => { this.continueRemaining = p.readUInt32LE(0); const w = this.continueWaiters; this.continueWaiters = []; w.forEach((f) => f()); }; }
        else if (type === 0x04) { need = 5 + 1; parse = () => this._finish(); }
        else if (type === 0x05) { need = 5 + 4; parse = () => {}; }
        else { this.acc = Buffer.alloc(0); return; }
        if (this.acc.length < need) return;
        parse(this.acc.subarray(5, need));
        this.acc = this.acc.subarray(need);
      }
    }
    _read() {
      return new Promise((res) => {
        if (this.chunks.length) return res(this.chunks.shift());
        if (this.done) return res(null);
        this.pending = () => { this.pending = null; res(this.chunks.length ? this.chunks.shift() : null); };
      });
    }
    async write(data) {
      if (this.continueRemaining <= 0) await new Promise((r) => this.continueWaiters.push(r));
      const hdr = Buffer.alloc(5); hdr.writeUInt8(0x02, 0); hdr.writeUInt32LE(this.id, 1);
      this.socket.send(Buffer.concat([hdr, data]));
      if (this.continueRemaining !== Infinity) this.continueRemaining = Math.max(0, this.continueRemaining - data.length);
    }
    close() { try { this.socket.close(); } catch {} }

    /* Duplex wrapper so node's `tls` can run inside the tunnel */
    duplex() {
      const t = this;
      return new stream.Duplex({
        read() {
          t._read().then((c) => { if (c === null) this.push(null); else this.push(c); });
        },
        write(chunk, _enc, cb) { t.write(Buffer.from(chunk)).then(() => cb(), cb); },
        final(cb) { t.close(); cb(); },
      });
    }
  }

  /* HTTP/1.1 chunked transfer-encoding -> plain body */
  function dechunk(buf) {
    const out = []; let i = 0;
    while (i < buf.length) {
      let nl = buf.indexOf("\r\n", i);
      if (nl < 0) break;
      const size = parseInt(buf.toString("latin1", i, nl).split(";")[0], 16);
      if (!Number.isFinite(size)) break;
      i = nl + 2;
      if (size === 0) break;
      if (i + size > buf.length) { out.push(buf.subarray(i)); break; } // cut short: keep what we have
      out.push(buf.subarray(i, i + size));
      i += size + 2;
    }
    return Buffer.concat(out);
  }

  /* one hop: wisp CONNECT -> TLS -> HTTP/1.1 request */
  function wispHop(relay, targetUrl, timeoutMs = 25000) {
    return new Promise(async (resolve, reject) => {
      let tunnel, sock;
      const bail = (msg) => { try { tunnel && tunnel.close(); sock && sock.destroy(); } catch {} reject(new Error(msg)); };
      try {
        const u = new URL(targetUrl);
        const isHttps = u.protocol === "https:";
        const host = u.hostname, port = u.port || (isHttps ? 443 : 80);
        const ws = await openSocket(relay, 12000);
        tunnel = new WispTunnel(ws, host, port);
        const deadline = setTimeout(() => bail("tunnel timeout"), timeoutMs);

        let io;
        if (isHttps) {
          io = tls.connect({ socket: tunnel.duplex(), servername: host, ALPNProtocols: ["http/1.1"], rejectUnauthorized: false });
          await new Promise((res, rej) => { io.once("secureConnect", res); io.once("error", rej); });
        } else {
          io = tunnel.duplex();
        }

        const p = u.pathname + u.search;
        const req = [
          "GET " + p + " HTTP/1.1",
          "Host: " + host,
          "User-Agent: " + UA,
          "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language: en-US,en;q=0.9",
          "Accept-Encoding: identity",
          "Connection: close",
          "", "",
        ].join("\r\n");
        io.write(req);

        const buf = []; let got = 0;
        while (true) {
          const c = await new Promise((res) => { io.once("readable", () => res(io.read())); io.once("end", () => res(null)); io.once("error", () => res(null)); });
          if (c === null) break;
          buf.push(c); got += c.length;
          if (got > BODY_CAP) break;
        }
        clearTimeout(deadline);
        const raw = Buffer.concat(buf);
        const sep = raw.indexOf("\r\n\r\n");
        if (sep < 0) return bail("malformed response from " + host);
        const head = raw.subarray(0, sep).toString("latin1").split("\r\n");
        const m = head[0].match(/^HTTP\/1\.[01] (\d{3})/);
        if (!m) return bail("bad status line: " + head[0]);
        const headers = {};
        head.slice(1).forEach((l) => { const i = l.indexOf(":"); if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); });
        let body = raw.subarray(sep + 4);
        if (String(headers["transfer-encoding"] || "").includes("chunked")) body = dechunk(body);
        try { io.destroy(); } catch {} tunnel.close();
        resolve({ status: parseInt(m[1], 10), headers, body, via: relay });
      } catch (e) {
        bail(String((e && e.message) || e));
      }
    });
  }

  async function relayFetch(targetUrl) {
    for (const relay of RELAYS) {
      let r = await wispHop(relay, targetUrl).catch((e) => ({ error: String((e && e.message) || e) }));
      if (r.error) { console.error("[relay]", relay, "->", r.error); continue; }
      // follow redirects across relays (fresh tunnel per hop)
      for (let hops = 0; hops < 4 && r.status >= 300 && r.status < 400 && r.headers.location; hops++) {
        const next = new URL(r.headers.location, targetUrl).href;
        r = await wispHop(relay, next).catch((e) => ({ error: String((e && e.message) || e) }));
        if (r.error) break;
        r.url = next;
      }
      if (!r.error) { r.url = r.url || targetUrl; return r; }
    }
    return null;
  }

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
        fetch_raw: origin + "/api/fetch?url=https://example.com&raw=1",
      },
      note: "/api/fetch tunnels through the wisp relays (same egress as the browser proxy). Add &raw=1 for raw bytes, &direct=1 to skip relays.",
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

  // GET /api/fetch?url=... -> fetches the page THROUGH the wisp relays
  // (same egress the browser proxy uses), returns what it got.
  //   default: JSON { ok, status, url, contentType, body, ... }
  //   &raw=1 : raw bytes + original content-type (pipe it straight into curl)
  //   &direct=1 : skip the relays, plain server fetch
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
    const directOnly = req.query.direct === "1";
    const wantsRaw = req.query.raw === "1";

    let r = null;
    if (!directOnly) r = await relayFetch(u.href);

    if (!r) { // relay tunnel unavailable -> honest direct fetch fallback
      try {
        const f = await fetch(u.href, { redirect: "follow", signal: AbortSignal.timeout(20_000), headers: { "user-agent": UA } });
        r = { status: f.status, url: f.url, headers: Object.fromEntries(f.headers), body: Buffer.from(await f.arrayBuffer()), via: "direct" };
      } catch (err) {
        return res.status(502).json({ error: "fetch failed", detail: String((err && err.message) || err) });
      }
    }

    const ct = r.headers["content-type"] || "application/octet-stream";
    const ok = r.status >= 200 && r.status < 400;
    if (wantsRaw) {
      res.status(r.status).set("Content-Type", ct).send(r.body);
      return;
    }
    const isText = /^(text\/|application\/(json|xml|xhtml|javascript)|image\/svg)/.test(ct) || r.body.toString("utf8", 0, 200).includes("<html");
    res.json({
      ok, status: r.status, url: r.url, contentType: ct,
      via: r.via, bytes: r.body.length, truncated: r.body.length > BODY_CAP,
      body: isText ? r.body.toString("utf8") : r.body.toString("base64"),
      encoding: isText ? "utf8" : "base64",
    });
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
