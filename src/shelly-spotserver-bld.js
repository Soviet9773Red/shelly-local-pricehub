/* =====================================================
 * Direct elprisetjustnu.se parser - SERVER side
 * v0.9.0b — memory: logs as arrays, string concat in buildUI
 *
 * Compatible with parser v0.9.0
 *
 * Endpoints:
 *   POST /prices {"t0":"..."}            : ping from parser
 *   POST /prices {"t0":"...","p":[...]}  : price data from parser
 *   GET  /prices ?d=YYYY-MM-DD&avg24     : serve data (backward compat)
 *   GET  /?r=prices&d=YYYY-MM-DD&avg24  : serve data (shelly-elpris-se ≥3.2)
 *   GET  /?r=ui                          : JSON state for dashboard
 *   GET  /?r=reset                       : reset cache (dayCache + ndayCache)
 *   GET  /                               : gzip HTML dashboard
 *
 * shelly-elpris-se: shelly_api = "http://ip/script/id/"
 *   bldU: return shelly_api + "?r=prices&d=" + dStr + "&z=" + reg + "&avg24";
 *
 * Parser POST body formats:
 *   {"z":"SE3"}                          : ping, parser cache empty
 *   {"z":"SE3","t0":"..."}               : ping, parser cache holds date X
 *   {"z":"SE3","t0":"...","p":[...]}     : data delivery
 *   zone "z" is set by parser only — server reads and syncs from payload
 *
 * reqLog entry (array): [ts, tp, pd, n, rc]
 *   tp: 0=data 1=out 2=cmd
 * evLog entry (array): [ts, ev, pd]
 *   ev: 0=pLOST 1=pRecon 2=cmd202 3=cmd205
 *       4=rvInvalid 5=rvNoSrc 6=rvOK 7=storedToday 8=storedNday 9=cacheReset
 *
 * MIT License
 * @license (c) Alexander - Soviet9773Red https://github.com/Soviet9773Red
 * ===================================================== */

const v = "0.9.0b" // version
    ,RLOG = 8  	   // Max log records for requests
    ,ELOG = 8;     // Max log records for events
	
// ========== gzip HTML dashboard (base64) ==========
let GZ = "GZIP";

// ========== zone and random API minute ==========
let ZONE = "NA", AM  = Math.floor(5 + Math.random()*51)  // API request random minute 5-55;

// ========== cache slots ==========
let dayCache  = null  // {date, std, avg, n}
   ,ndayCache = null
   ,lastReq205   = 0
   ,rolloverFlag = false;

// ========== parser tracking ==========
let lastParserDate = "?"  // last price date reported by parser in ping (YYYY-MM-DD or "?")
   ,lastPingTs     = 0    // unix timestamp of last ping received from parser
   ,parserLost     = false; // true if parser has not pinged within watchdog interval (180s)

// ========== logs — stored as flat arrays (less memory than objects) ==========
// reqLog[i] = [ts, tp, pd, n, rc]
//   ts : unix timestamp of the request
//   tp : request type  0=data (parser POST)  1=out (client GET)  2=cmd (ping reply with code)
//   pd : price date the request refers to (YYYY-MM-DD)
//   n  : number of prices received (non-zero for tp=0 only)
//   rc : HTTP response code sent back (200/201/202/205/400/404)
//
// evLog[i] = [ts, ev, pd]
//   ts : unix timestamp of the event
//   ev : event type (see below)
//   pd : price date or detail string related to the event
//
// ev: 0=pLOST      parser watchdog timeout — no ping for 180s
//     1=pRecon     parser reconnected after being lost
//     2=cmd202     server instructed parser to fetch today
//     3=cmd205     server instructed parser to fetch nextday
//     4=rvInvalid  rollover attempted but promoted cache has invalid n
//     5=rvNoSrc    rollover attempted but ndayCache had wrong date or was null
//     6=rvOK       rollover completed successfully (ndayCache -> dayCache)
//     7=storedToday  parser delivered today prices, stored in dayCache
//     8=storedNday   parser delivered nextday prices, stored in ndayCache
//     9=dayChange    calendar day changed, detected in tick()
//     10=cacheReset  dayCache + ndayCache cleared via /?r=reset
let reqLog = []
   ,evLog  = [];

function addLog(tp, pd, n, rc) {
  if (reqLog.length >= RLOG) reqLog.splice(0, 1);
  reqLog.push([nowSec(), tp, pd || "-", n, rc]);
}
function addEv(ev, pd) {
  if (evLog.length >= ELOG) evLog.splice(0, 1);
  evLog.push([nowSec(), ev, pd || ""]);
}

// ========== device info (set in init) ==========
let srvIp = ""
   ,srvId = 0;

// ========== helpers ==========
function pad2(n) { return n < 10 ? "0" + n : "" + n; }
function nowSec() { return Math.floor(Date.now() / 1e3); }

function todayStr() {
  let d = new Date();
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}
function ndayStr() {
  let d = new Date(Date.now() + 864e5);
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}
function dateFromT0(t0) {
  if (!t0 || t0.length < 10) return null;
  return t0.substring(0, 10);
}
function isAfterApiTime() {
  let d = new Date(), h = d.getHours(), m = d.getMinutes();
  return h > 14 || (h === 14 && m >= AM);
}
function isValidCache(c, exp) {
  return c !== null && c.date === exp && c.n >= 92 && c.n <= 100;
}

// ========== decision logic ==========
function decideCode(parserDate) {
  let td = todayStr();
  if (rolloverFlag) {
    rolloverFlag = false;
    if (parserDate && parserDate === td) { print("Recovery: 201"); return 201; }
    print("Recovery: 202");
    return 202;
  }
  if (!isValidCache(dayCache, td)) {
    if (parserDate && parserDate === td) return 201;
    return 202;
  }
  if (isAfterApiTime() && !isValidCache(ndayCache, ndayStr())) {
    let now = nowSec();
    if (now - lastReq205 >= 3600) { lastReq205 = now; return 205; }
  }
  return 200;
}

// ========== format builders ==========
function buildStd(t0, pr) {
  let p = [
    '{"src":"Elprisetjustnu.se","via":"shelly-parser","z":"', ZONE, '","t0":"', t0,
    '","s":900,"u":"SEK","raw":', pr.length.toString(), ',"p":['
  ];
  for (let i = 0; i < pr.length; i++) {
    if (i > 0) p.push(',');
    p.push(pr[i].toString());
  }
  p.push(']}');
  return p.join('');
}

function buildAvg24(t0, pr) {
  let gs = 4, ol = Math.floor(pr.length / gs);
  let p = [
    '{"src":"Elprisetjustnu.se","via":"shelly-parser","z":"', ZONE, '","t0":"', t0,
    '","s":3600,"u":"SEK","raw":', pr.length.toString(), ',"p":['
  ];
  for (let i = 0; i < ol; i++) {
    let sum = 0, base = i * gs;
    for (let j = 0; j < gs; j++) sum += pr[base + j];
    if (i > 0) p.push(',');
    p.push((Math.round((sum / gs) * 100000) / 100000).toString());
  }
  p.push(']}');
  return p.join('');
}

// ========== query parser — no z, no object fields we don't use ==========
function parseQuery(q) {
  let r = null, d = null, avg24 = false;
  if (!q) return { r: r, d: d, avg24: avg24 };
  let pairs = q.split("&");
  for (let i = 0; i < pairs.length; i++) {
    let kv = pairs[i].split("=");
    let k = kv[0];
    if      (k === "r")     r = kv[1] || "";
    else if (k === "d")     d = kv[1] || "";
    else if (k === "avg24") avg24 = true;
  }
  return { r: r, d: d, avg24: avg24 };
}

// ========== reply helpers ==========
function replyJson(res, code, body) {
  res.code = code;
  res.headers = [["Content-Type", "application/json"],
                 ["Cache-Control", "no-store"]];
  res.body = body || ('{"code":' + code + '}');
  res.send();
}

function replyGzip(res, b64) {
  res.code = 200;
  res.headers = [["Content-Type", "text/html; charset=utf-8"],
                 ["Content-Encoding", "gzip"],
                 ["Cache-Control", "max-age=3600"]];
  res.body = atob(b64);
  res.send();
}

// ========== UI JSON builder — string concat (faster/cheaper than array+join) ==========
function buildUI() {
  let td = todayStr(), tm = ndayStr()
     ,tcOK = isValidCache(dayCache, td)
     ,tmOK = isValidCache(ndayCache, tm);

  let s = '{"v":"' + v + '","z":"' + ZONE + '","now":' + nowSec();
  s += ',"api":[' + 14 + ',' + AM + ']';
  s += ',"ping":[' + lastPingTs + ',"' + lastParserDate + '",' +
       (parserLost ? 'true' : 'false') + ']';
  s += ',"td":' + (dayCache
    ? '["' + dayCache.date + '",' + dayCache.n + ',' + (tcOK ? 'true' : 'false') + ']'
    : 'null');
  s += ',"tm":' + (ndayCache
    ? '["' + ndayCache.date + '",' + ndayCache.n + ',' + (tmOK ? 'true' : 'false') + ']'
    : 'null');
  s += ',"req":[';
  for (let i = 0; i < reqLog.length; i++) {
    let e = reqLog[i];
    if (i > 0) s += ',';
    s += '[' + e[0] + ',' + e[1] + ',"' + e[2] + '",' + e[3] + ',' + e[4] + ']';
  }
  s += '],"ev":[';
  for (let i = 0; i < evLog.length; i++) {
    let e = evLog[i];
    if (i > 0) s += ',';
    s += '[' + e[0] + ',' + e[1] + ',"' + e[2] + '"]';
  }
  s += ']}';
  return s;
}

// ========== serve cache helper ==========
function serveCache(res, d, avg24) {
  let cache = null;
  if (dayCache  && dayCache.date  === d) cache = dayCache;
  else if (ndayCache && ndayCache.date === d) cache = ndayCache;
  if (!cache) {
    addLog(1, d, 0, 404);
    replyJson(res, 404, '{"err":"no data for ' + d + '"}');
    return;
  }
  addLog(1, d, 0, 200);
  replyJson(res, 200, avg24 ? cache.avg : cache.std);
}

// ========== /prices endpoint — parser protocol (unchanged) ==========
HTTPServer.registerEndpoint("prices", function (req, res) {

  if (req.method === "POST") {
    if (!req.body || req.body.length === 0) {
      replyJson(res, decideCode(null)); return;
    }
    let raw;
    try { raw = JSON.parse(req.body); }
    catch (e) { replyJson(res, 400, '{"err":"bad json"}'); return; }
    if (!raw) { replyJson(res, 400, '{"err":"null"}'); return; }

    // PING
    if (!raw.p) {
      let pDate = raw.t0 ? dateFromT0(raw.t0) : null;
      let pd = pDate || "empty";
      lastPingTs = nowSec();
	  if (raw.z) ZONE = raw.z;
      if (parserLost) {
        print("[ping] reconnected, cache=" + pd);
        parserLost = false; lastParserDate = "?"; addEv(1, pd);
      }
      if (pd !== lastParserDate) { print("[ping] parser=" + pd); lastParserDate = pd; }
      raw = null;
      let code = decideCode(pDate);
      if (code === 202 || code === 205) {
        addLog(2, pd, 0, code);
        addEv(code === 202 ? 2 : 3, pd);
      }
      replyJson(res, code); return;
    }

    // DATA POST
    if (!raw.t0 || raw.p.length === 0) {
      raw = null; replyJson(res, 400, '{"err":"missing t0 or p"}'); return;
    }
    let dataDate = dateFromT0(raw.t0)
       ,td = todayStr(), tm = ndayStr()
       ,n  = raw.p.length
       ,r  = buildStd(raw.t0, raw.p)
       ,a  = buildAvg24(raw.t0, raw.p);
	if (raw.z) ZONE = raw.z;
    raw = null;

    let slot = "";
    if (dataDate === td) {
      dayCache  = { date: dataDate, std: r, avg: a, n: n }; slot = "today";
    } else if (dataDate === tm) {
      ndayCache = { date: dataDate, std: r, avg: a, n: n }; slot = "nextday";
    } else {
      r = null; a = null;
      replyJson(res, 400, '{"err":"date out of range: ' + dataDate + '"}'); return;
    }
    r = null; a = null;
    print("Stored " + slot + ": " + dataDate + " (" + n + ")");
    addEv(dataDate === td ? 7 : 8, dataDate);
    let code = decideCode(null);
    addLog(0, dataDate, n, code);
    replyJson(res, code, '{"ok":true,"slot":"' + slot + '","n":' + n + '}');
    return;
  }

  // GET — backward compat
  let o = parseQuery(req.query);
  if (!o.d) { replyJson(res, 400, '{"err":"missing d"}'); return; }
  serveCache(res, o.d, o.avg24);
});

// ========== root endpoint ==========
HTTPServer.registerEndpoint("", function (req, res) {
  try {
    let o = parseQuery(req.query);
    if (o.r === "ui")     { replyJson(res, 200, buildUI()); return; }
    if (o.r === "prices") {
      if (!o.d) { replyJson(res, 400, '{"err":"missing d"}'); return; }
      serveCache(res, o.d, o.avg24); return;
    }
	if (o.r === "reset") {
	  dayCache = null; ndayCache = null; lastReq205 = 0;
	  print("Cache reset by user");
	  addEv(10, "manual");
	  replyJson(res, 200, '{"ok":true}');
	  return;
	}
    replyGzip(res, GZ);
  } catch (e) {
    print("root err: " + e);
    res.code = 500; res.body = '{"err":"server error"}'; res.send();
  }
});

// ========== tick ==========
let lastSeenDate = null;

function tick() {
  let td = todayStr(), tm = ndayStr();
  if (lastSeenDate !== null && lastSeenDate !== td) {
    addEv(9, td);  // dayChange
  }
  lastSeenDate = td;
  if (dayCache && dayCache.date !== td) {
    print("Today stale (" + dayCache.date + ")");
    if (ndayCache && ndayCache.date === td) {
      dayCache = ndayCache; ndayCache = null; lastReq205 = 0;
      print("Rollover: nextday -> today (" + td + ")");
      if (!isValidCache(dayCache, td)) {
        print("[WARN] Rollover invalid: n=" + dayCache.n);
        addEv(4, dayCache.date); dayCache = null; rolloverFlag = true;
      } else { print("Rollover OK: n=" + dayCache.n); addEv(6, td); }
    } else { dayCache = null; print("No rollover source"); addEv(5, td); }
  }
  if (ndayCache && ndayCache.date !== tm) {
    print("Nextday stale (" + ndayCache.date + "), dropping"); ndayCache = null;
  }
  if (lastPingTs > 0 && !parserLost && (nowSec() - lastPingTs) > 180) {
    parserLost = true; addEv(0, "");
    print("[WARN] Parser connection lost");
  }
}

// ========== init ==========
function init() {
  if (Shelly.getComponentStatus("sys").unixtime === null) {
    Timer.set(1000, false, init); return;
  }
  let w = Shelly.getComponentStatus("wifi");
  if (w && w.sta_ip) srvIp = w.sta_ip;
  srvId = Script.id;
  print("Shelly spotprice server " + v + " | API time: " + 14 + ":" + pad2(AM));
  print("Parser s =   http://" + srvIp + "/script/" + srvId + "/prices");
  print("Server UI:   http://" + srvIp + "/script/" + srvId + "/");
  print("[ping] waiting...");
  Timer.set(20000, true, tick);
}
init();
