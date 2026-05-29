// @license (c) Alexander - Soviet9773Red https://github.com/Soviet9773Red
/* =====================================================
 * Direct elprisetjustnu.se parser - PARSER side
 * v0.9.0 - single-cache + 4-code service protocol
 *
 * Architecture:
 *   - Single price cache (like v0.7a).
 *   - Parser pings server periodically.
 *   - Server replies with HTTP service code that
 *     instructs parser what to do next.
 *
 * POST body formats:
 *   {"z":"SE3"}                          : ping, cache is empty
 *   {"z":"SE3","t0":"..."}               : ping, cache holds data for date X
 *   {"z":"SE3","t0":"...","p":[...]}     : data delivery (full)
 *
 * Note: Shelly HTTP.POST rejects empty body (RPC error -103),
 * so empty cache is signalled with {"z":"SEn"} not "".
 * Zone is always included so server can identify the source region.
 *
 * Service codes from server:
 *   200 OK              - all good, keep pinging
 *   201 Created         - resend cached as-is (full POST)
 *   202 Accepted        - fetch today from upstream and POST
 *   205 Reset Content   - fetch nextday from upstream and POST
 *   any other           - log and retry ping
 *
 * Memory optimizations vs v0.83:
 *   - pad2() inlined into dp()
 *   - Exponent handling removed from rN() (SEK prices never use e-notation)
 *   - ft()/fn() wrappers replaced by Timer.set userdata: Timer.set(t, false, df, 0/1)
 *   Result: mem_used 4060, mem_peak 24192
 *
 * MIT License
 * @license (c) Alexander - Soviet9773Red https://github.com/Soviet9773Red
 * ===================================================== */
let z = "SE3", s = "http://192.168.8.162/script/4/prices"; // "http://ip/script/id/prices"

// 60000 -60 sec PING
// 90000 -90 sec RETRY on errors
// 2000 -2 sec before commanded action ADELAY

print("shelly-parser 0.9.0");
// publish = pub, cached = ch
let busy = false, pub = false, ch = null; // {t0, pr} or null

// ========== date helpers ==========
// dp - dayPath
function dp(o) {
  let d = new Date(Date.now() + o * 86400000),
      m = d.getMonth() + 1,
      dd = d.getDate();
  return d.getFullYear() + "/" +
         (m < 10 ? "0" + m : m) + "-" +
         (dd < 10 ? "0" + dd : dd);
}

// ========== char-by-char number parser ==========
// Output goes to globals to avoid allocating [val, idx] on every call.
let _nV = 0, _nIdx = 0;

// rN - readNumber
function rN(body, st) {
  let i = st, len = body.length, cc, neg = false;
  cc = body.charCodeAt(i);
  if (cc === 45) { neg = true; i++; }     // -
  else if (cc === 43) { i++; }            // +

// iP- intPart
  let iP = 0;
  while (i < len) {
    cc = body.charCodeAt(i);
    if (cc < 48 || cc > 57) break;
    iP = iP * 10 + (cc - 48);
    i++;
  }

// fP- fracPart fD- fracDiv
  let fP = 0, fD = 1;
  if (i < len && body.charCodeAt(i) === 46) {  // .
    i++;
    while (i < len) {
      cc = body.charCodeAt(i);
      if (cc < 48 || cc > 57) break;
      fP = fP * 10 + (cc - 48);
      fD *= 10;
      i++;
    }
  }

  let val = iP + fP / fD;

  if (neg) val = -val;
  _nV = val;
  _nIdx = i;
}

function et0(body) {
  let key = '"time_start":"', idx = body.indexOf(key);
  if (idx === -1) return null;
  idx += key.length;
  let end = body.indexOf('"', idx);
  if (end === -1) return null;
  return body.substring(idx, end);
}
//parse.pr
function pp(body) {
  let key = '"SEK_per_kWh":', keyL = key.length, pr = [], pos = 0, len = body.length;

  while (pos < len) {
    let idx = body.indexOf(key, pos);
    if (idx === -1) break;
    idx += keyL;
    rN(body, idx);
    pr.push(_nV);
    pos = _nIdx;
  }
  return pr;
}

// ========== pay.load builders ==========
//buildDataPayload
function bd() {
  let d = ['{"z":"', z, '","t0":"', ch.t0, '","p":['];
  for (let i = 0; i < ch.pr.length; i++) {
    if (i > 0) d.push(',');
    d.push(ch.pr[i].toString());
  }
  d.push(']}');
  return d.join('');
}

//buildPing.Payload
function bp() {
  if (ch) return '{"z":"' + z + '","t0":"' + ch.t0 + '"}';
  return '{"z":"' + z + '"}'; // Shelly HTTP.POST rejects empty body (-103),
                              // server treats zone {z:"SEn"} as ping with no cache
}

// ========== response handler (single switch) ==========
//handle.Response
function hr(res, errc, errm) {
  pub = false;

  if (errc !== 0) {
    print("Server unreachable:", errc, errm,
          "- retry in", 90, "s");
    Timer.set(90000, false, sp); // Retry to reach server
    return;
  }

  let code = res ? res.code : 0;
  res = null;

  if (code === 200) {
    Timer.set(60000, false, sp); // PING 60 sek
  }
  else if (code === 201) {
    print("Server: 201 - resend cached");
    if (ch) Timer.set(2000, false, sd); // 2 sec delay
    else Timer.set(2000, false, sp);
  }
  else if (code === 202) {
    print("Server: 202 - fetch today");
	Timer.set(2000, false, df, 0);
  }
  else if (code === 205) {
    print("Server: 205 - fetch nextday");
	Timer.set(2000, false, df, 1);
  }
  else {
    print("Unexpected code:", code,
          "- retry ping in", 90, "s");
    Timer.set(90000, false, sp);
  }
}

// ========== ping ==========
function sp() {
  if (pub) {
    print("Busy, skip ping");
    return;
  }
  pub = true;

  let pl = bp();
  Shelly.call("HTTP.POST", {
    url: s,
    body: pl,
    content_type: "application/json",
    timeout: 8
  }, function (res, errc, errm) {
    pl = null;
    hr(res, errc, errm);
  });
}

// ========== send full cached data ==========
// sendData
function sd() {
  if (pub) {
    print("Busy, skip sd");
    return;
  }
  if (!ch) {
    print("No cache - falling back to ping");
    Timer.set(2000, false, sp);
    return;
  }
  pub = true;

  let pl = bd();
  print("POST " + ch.t0.substring(0, 10) +
        ", " + pl.length + "B");

  Shelly.call("HTTP.POST", {
    url: s,
    body: pl,
    content_type: "application/json",
    timeout: 8
  }, function (res, errc, errm) {
    pl = null;
    hr(res, errc, errm);
  });
}

// ========== fetch from upstream ==========
function df(doff) {
  if (busy) {
    print("Fetch busy, skip");
    Timer.set(2000, false, sp);
    return;
  }
  busy = true;

  // Free old cache BEFORE network op + parse to minimize peak memory.
  // Single-cache design: we'll overwrite it anyway. If fetch fails,
  // cache stays empty and self-heals via next ping -> 205 cycle.
  ch = null;

  let p = dp(doff), api = "https://www.elprisetjustnu.se/api/v1/prices/"
            + p + "_" + z + ".json";
  print("Fetch:", api, "\n wait ~20 sek ..." );

  Shelly.call("HTTP.GET", { url: api, timeout: 20 },
    function (res, errc, errm) {
      if (errc !== 0) {
        print("Fetch err:", errc, errm);
        busy = false;
        Timer.set(90000, false, sp);
        return;
      }
      if (!res || res.code !== 200) {
        print("Fetch HTTP:", res ? res.code : "?");
        if (res) delete res.body;
        res = null;
        busy = false;
        Timer.set(90000, false, sp);
        return;
      }

      delete res.headers;

      let t0 = et0(res.body);
      if (!t0) {
        print("No t0 in response");
        delete res.body;
        res = null;
        busy = false;
        Timer.set(90000, false, sp);
        return;
      }

      let pr = pp(res.body);
      delete res.body;
      res = null;

      ch = { t0: t0, pr: pr };
      pr = null;
      t0 = null;

      busy = false;
      print("Cached t0=" + ch.t0,
            "(" + ch.pr.length, "prices)");

      // POST data to server
      Timer.set(100, false, sd);
    }
  );
}

// ========== init ==========
function init() {
  if (Shelly.getComponentStatus("sys").unixtime === null) {
    Timer.set(1000, false, init);
    return;
  }

  print(z, "| Server:", s, "| Ping:", 60, "s");
  // Start with ping (cache empty -> server will respond 202/205)
  Timer.set(2000, false, sp);
}

init();
