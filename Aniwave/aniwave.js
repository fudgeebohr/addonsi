// Aniwaves (aniwaves.org) module for Sora-compatible apps (MiruShin).
// Mode: asyncJS + softsub.  Pure-JS crypto (JavaScriptCore has no WebCrypto).
//
// Stream chain (reverse-engineered from the site's own players):
//   watch page  -> per-anime token `k`
//   play.aniwaves.org/get/<k>.<ep>.<server>.<sub|dub> -> {"info": <AES-GCM blob>, "mode":"embed"}
//   decrypt info (key = PAGE_KEY from play.aniwaves.org/watch) -> megaplay embed URL
//   embed page -> data-id -> megaplay.buzz/stream/getSources?id=..  -> {enc, tracks}
//   decrypt enc (AES-256-CBC) -> {"file": m3u8}; append ?token= (HMAC-SHA256)
//
// NOTE: the constants below are the site's own and may rotate. PAGE_KEY is
// re-read from the live player page on every run; the others are only
// changed by editing this file if the site ever rotates them.

var AW_VERSION = "1.5.0";
var AW_BASE = "https://aniwaves.org";
var AW_PLAY = "https://play.aniwaves.org";
var AW_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

var AW_PAGE_KEY_DEFAULT = "PU0XS6iGenzI19viQiaR5JqGctWLN_-gZ7c1UM6DYro";
var AW_ENC_KEY = "i?LMTAx0Q6,:}50U";      // AES-256-CBC key (utf8, zero padded to 32)
var AW_ENC_IV = "W0;27ToaUpl_P%'c";        // IV (utf8, zero padded to 16)
var AW_CDN_SECRET = "MpCdnT0k3n!9f2K#xQ7vL5mR8wN1pY4s";
var AW_CDN_TTL = 90;
var AW_SERVERS = [2, 1, 3, 4];
var AW_TYPE = "sub";
// How subtitles are handed to the app:
//   "data" = the module downloads the .vtt itself (with the right Referer) and
//            passes it inline as a data: link, because the app loads subtitle
//            links without any headers and the subtitle host refuses that.
//   "url"  = pass the plain link (use this if "data" ever breaks playback).
var AW_SUB_MODE = "data";
var AW_SUB_MAX = 200000;   // characters; larger files fall back to the plain link

// ---------------------------------------------------------------- crypto ---
var AW_SBOX = [], AW_INV = [];
(function () {
    function rotl8(x, n) { return ((x << n) | (x >> (8 - n))) & 255; }
    var p = 1, q = 1;
    do {
        p = (p ^ ((p << 1) & 255) ^ ((p & 128) ? 0x1b : 0)) & 255;
        q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 255;
        if (q & 128) q ^= 0x09;
        var x = q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4);
        AW_SBOX[p] = (x ^ 0x63) & 255;
    } while (p !== 1);
    AW_SBOX[0] = 0x63;
    for (var i = 0; i < 256; i++) AW_INV[AW_SBOX[i]] = i;
})();

function awMul(a, b) {
    var r = 0;
    while (b) {
        if (b & 1) r ^= a;
        a = ((a << 1) ^ ((a & 128) ? 0x11b : 0)) & 255;
        b >>= 1;
    }
    return r;
}

function awExpandKey(key) {
    var nk = key.length / 4, nr = nk + 6, total = 16 * (nr + 1);
    var w = key.slice(), rcon = 1, i, t, k;
    for (i = nk; i < total / 4; i++) {
        t = w.slice(4 * (i - 1), 4 * i);
        if (i % nk === 0) {
            t = [AW_SBOX[t[1]] ^ rcon, AW_SBOX[t[2]], AW_SBOX[t[3]], AW_SBOX[t[0]]];
            rcon = awMul(rcon, 2);
        } else if (nk > 6 && i % nk === 4) {
            t = [AW_SBOX[t[0]], AW_SBOX[t[1]], AW_SBOX[t[2]], AW_SBOX[t[3]]];
        }
        for (k = 0; k < 4; k++) w[4 * i + k] = w[4 * (i - nk) + k] ^ t[k];
    }
    return { w: w, nr: nr };
}

function awAddRK(s, ks, round) {
    for (var i = 0; i < 16; i++) s[i] ^= ks.w[16 * round + i];
}

function awEncBlock(ks, input) {
    var s = input.slice(), r, i, c, t;
    awAddRK(s, ks, 0);
    for (r = 1; r <= ks.nr; r++) {
        for (i = 0; i < 16; i++) s[i] = AW_SBOX[s[i]];
        t = s.slice();
        for (c = 0; c < 4; c++) for (i = 0; i < 4; i++) s[c * 4 + i] = t[((c + i) % 4) * 4 + i];
        if (r !== ks.nr) {
            for (c = 0; c < 4; c++) {
                var a0 = s[c * 4], a1 = s[c * 4 + 1], a2 = s[c * 4 + 2], a3 = s[c * 4 + 3];
                s[c * 4] = awMul(a0, 2) ^ awMul(a1, 3) ^ a2 ^ a3;
                s[c * 4 + 1] = a0 ^ awMul(a1, 2) ^ awMul(a2, 3) ^ a3;
                s[c * 4 + 2] = a0 ^ a1 ^ awMul(a2, 2) ^ awMul(a3, 3);
                s[c * 4 + 3] = awMul(a0, 3) ^ a1 ^ a2 ^ awMul(a3, 2);
            }
        }
        awAddRK(s, ks, r);
    }
    return s;
}

function awDecBlock(ks, input) {
    var s = input.slice(), r, i, c, t;
    awAddRK(s, ks, ks.nr);
    for (r = ks.nr - 1; r >= 0; r--) {
        t = s.slice();
        for (c = 0; c < 4; c++) for (i = 0; i < 4; i++) s[((c + i) % 4) * 4 + i] = t[c * 4 + i];
        for (i = 0; i < 16; i++) s[i] = AW_INV[s[i]];
        awAddRK(s, ks, r);
        if (r !== 0) {
            for (c = 0; c < 4; c++) {
                var a0 = s[c * 4], a1 = s[c * 4 + 1], a2 = s[c * 4 + 2], a3 = s[c * 4 + 3];
                s[c * 4] = awMul(a0, 14) ^ awMul(a1, 11) ^ awMul(a2, 13) ^ awMul(a3, 9);
                s[c * 4 + 1] = awMul(a0, 9) ^ awMul(a1, 14) ^ awMul(a2, 11) ^ awMul(a3, 13);
                s[c * 4 + 2] = awMul(a0, 13) ^ awMul(a1, 9) ^ awMul(a2, 14) ^ awMul(a3, 11);
                s[c * 4 + 3] = awMul(a0, 11) ^ awMul(a1, 13) ^ awMul(a2, 9) ^ awMul(a3, 14);
            }
        }
    }
    return s;
}

// AES-256-CBC decrypt + PKCS7 unpad
function awCbcDecrypt(key, iv, data) {
    var ks = awExpandKey(key), out = [], prev = iv, i, j, blk, dec;
    for (i = 0; i + 16 <= data.length; i += 16) {
        blk = data.slice(i, i + 16);
        dec = awDecBlock(ks, blk);
        for (j = 0; j < 16; j++) out.push(dec[j] ^ prev[j]);
        prev = blk;
    }
    var pad = out[out.length - 1];
    if (pad >= 1 && pad <= 16) out = out.slice(0, out.length - pad);
    return out;
}

// AES-GCM decrypt (12-byte IV). Counter mode only; the auth tag is not
// checked (we only need the plaintext, a wrong key just yields garbage that
// the caller validates).
function awGcmDecrypt(key, blob) {
    var iv = blob.slice(0, 12), ct = blob.slice(12, blob.length - 16);
    var ks = awExpandKey(key), out = [], ctr = iv.concat([0, 0, 0, 2]), i, j, n;
    for (i = 0; i < ct.length; i += 16) {
        var ksb = awEncBlock(ks, ctr);
        n = Math.min(16, ct.length - i);
        for (j = 0; j < n; j++) out.push(ct[i + j] ^ ksb[j]);
        for (j = 15; j >= 12; j--) { ctr[j] = (ctr[j] + 1) & 255; if (ctr[j] !== 0) break; }
    }
    return out;
}

var AW_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function awSha256(bytes) {
    var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var m = bytes.slice(), len = bytes.length, i, j;
    m.push(0x80);
    while (m.length % 64 !== 56) m.push(0);
    var bits = len * 8;
    for (i = 7; i >= 0; i--) m.push(i >= 4 ? 0 : (bits >>> (i * 8)) & 255);
    function ror(x, n) { return (x >>> n) | (x << (32 - n)); }
    for (i = 0; i < m.length; i += 64) {
        var w = [];
        for (j = 0; j < 16; j++) w[j] = ((m[i + 4 * j] << 24) | (m[i + 4 * j + 1] << 16) | (m[i + 4 * j + 2] << 8) | m[i + 4 * j + 3]) | 0;
        for (j = 16; j < 64; j++) {
            var s0 = ror(w[j - 15], 7) ^ ror(w[j - 15], 18) ^ (w[j - 15] >>> 3);
            var s1 = ror(w[j - 2], 17) ^ ror(w[j - 2], 19) ^ (w[j - 2] >>> 10);
            w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0;
        }
        var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
        for (j = 0; j < 64; j++) {
            var S1 = ror(e, 6) ^ ror(e, 11) ^ ror(e, 25);
            var ch = (e & f) ^ (~e & g);
            var t1 = (hh + S1 + ch + AW_K[j] + w[j]) | 0;
            var S0 = ror(a, 2) ^ ror(a, 13) ^ ror(a, 22);
            var maj = (a & b) ^ (a & c) ^ (b & c);
            var t2 = (S0 + maj) | 0;
            hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
        }
        h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
        h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
    }
    var out = [];
    for (i = 0; i < 8; i++) out.push((h[i] >>> 24) & 255, (h[i] >>> 16) & 255, (h[i] >>> 8) & 255, h[i] & 255);
    return out;
}

function awHmacSha256(key, msg) {
    if (key.length > 64) key = awSha256(key);
    var ip = [], op = [], i;
    for (i = 0; i < 64; i++) { var kb = i < key.length ? key[i] : 0; ip.push(kb ^ 0x36); op.push(kb ^ 0x5c); }
    return awSha256(op.concat(awSha256(ip.concat(msg))));
}

// ----------------------------------------------------------- byte helpers ---
var AW_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function awUtf8Bytes(str) {
    var out = [], i, c;
    str = String(str);
    for (i = 0; i < str.length; i++) {
        c = str.charCodeAt(i);
        if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) {
            c = 0x10000 + ((c - 0xd800) << 10) + (str.charCodeAt(++i) - 0xdc00);
        }
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
}

function awBytesToUtf8(bytes) {
    var s = "", i = 0, c;
    while (i < bytes.length) {
        c = bytes[i++];
        if (c < 0x80) s += String.fromCharCode(c);
        else if (c < 0xe0) s += String.fromCharCode(((c & 31) << 6) | (bytes[i++] & 63));
        else if (c < 0xf0) s += String.fromCharCode(((c & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63));
        else {
            var cp = ((c & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
            cp -= 0x10000;
            s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023));
        }
    }
    return s;
}

function awB64Decode(str) {
    str = String(str).replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+\/]/g, "");
    var out = [], i, a, b, c, d;
    for (i = 0; i < str.length; i += 4) {
        a = AW_B64.indexOf(str.charAt(i));
        b = AW_B64.indexOf(str.charAt(i + 1));
        c = i + 2 < str.length ? AW_B64.indexOf(str.charAt(i + 2)) : -1;
        d = i + 3 < str.length ? AW_B64.indexOf(str.charAt(i + 3)) : -1;
        out.push((a << 2) | (b >> 4));
        if (c >= 0) out.push(((b & 15) << 4) | (c >> 2));
        if (d >= 0) out.push(((c & 3) << 6) | d);
    }
    return out;
}

function awB64UrlEncode(bytes) {
    var s = "", i, a, b, c;
    for (i = 0; i < bytes.length; i += 3) {
        a = bytes[i]; b = i + 1 < bytes.length ? bytes[i + 1] : -1; c = i + 2 < bytes.length ? bytes[i + 2] : -1;
        s += AW_B64.charAt(a >> 2) + AW_B64.charAt(((a & 3) << 4) | ((b < 0 ? 0 : b) >> 4));
        if (b >= 0) s += AW_B64.charAt(((b & 15) << 2) | ((c < 0 ? 0 : c) >> 6));
        if (c >= 0) s += AW_B64.charAt(c & 63);
    }
    return s.replace(/\+/g, "-").replace(/\//g, "_");
}

function awPad(str, n) {
    var b = awUtf8Bytes(str).slice(0, n);
    while (b.length < n) b.push(0);
    return b;
}

// ----------------------------------------------------------- site logic ---
function awDecryptInfo(info, pageKey) {
    var plain = awBytesToUtf8(awGcmDecrypt(awB64Decode(pageKey), awB64Decode(info)));
    if (!/^https?:\/\//.test(plain)) throw new Error("bad key");
    return plain;
}

function awDecryptEnc(enc) {
    var plain = awBytesToUtf8(awCbcDecrypt(awPad(AW_ENC_KEY, 32), awPad(AW_ENC_IV, 16), awB64Decode(enc)));
    return JSON.parse(plain);
}

function awCdnToken(m3u8Url, nowSeconds) {
    var m = String(m3u8Url).match(/\/([a-f0-9]{32})\/([a-f0-9]{32})\//i);
    if (!m) return null;
    var exp = Math.floor((nowSeconds === undefined ? Date.now() / 1000 : nowSeconds)) + AW_CDN_TTL;
    var payload = awUtf8Bytes(String(exp) + "|" + m[1].toLowerCase() + "/" + m[2].toLowerCase());
    var sig = awHmacSha256(awUtf8Bytes(AW_CDN_SECRET), payload);
    return awB64UrlEncode(payload) + "." + awB64UrlEncode(sig);
}

function awAttachToken(url) {
    if (/[?&]token=/.test(url)) return url;
    var t = awCdnToken(url);
    if (!t) return url;
    return url + (url.indexOf("?") >= 0 ? "&" : "?") + "token=" + encodeURIComponent(t);
}

async function awGet(url, headers) {
    var h = { "User-Agent": AW_UA, "Accept": "*/*" };
    for (var k in (headers || {})) h[k] = headers[k];
    var res = await fetchv2(url, h, "GET", null);
    return await res.text();
}

function awStrip(html) {
    return String(html || "")
        .replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, " ")
        .replace(/[ \t]+/g, " ").trim();
}

function awAbs(href) {
    if (/^https?:/.test(href)) return href;
    return AW_BASE + (href.charAt(0) === "/" ? "" : "/") + href;
}

var AW_INDEX = null;
var AW_DIAG = "";
var AW_TRACE = [];
var AW_LINE = 0;

// Parse the index; if it is incomplete, keep every complete entry.
function awParseIndex(txt) {
    txt = String(txt).replace(/^\uFEFF/, "").trim();
    try { return JSON.parse(txt); } catch (e) { }
    var parts = txt.replace(/^\[/, "").replace(/\]\s*$/, "").split('},{"n":'), out = [], i, p;
    for (i = 0; i < parts.length; i++) {
        p = i === 0 ? parts[i] : '{"n":' + parts[i];
        if (!/\}\s*$/.test(p)) p += "}";
        try { out.push(JSON.parse(p)); } catch (e) { }
    }
    return out;
}

// The host app cuts every response off at ~96 KB, and the title list is far
// bigger. So it is downloaded in 80 KB pieces with HTTP Range requests.
var AW_CHUNK = 80000;

async function awChunk(n) {
    var from = n * AW_CHUNK;
    try {
        return String(await awGet(AW_BASE + "/filter-index.json", {
            "Referer": AW_BASE + "/", "Accept": "*/*", "Range": "bytes=" + from + "-" + (from + AW_CHUNK - 1)
        }));
    } catch (e) { return ""; }
}

function awChunkBad(txt, n) {
    return txt.length < 5 || /<html|not satisfiable/i.test(txt.slice(0, 200)) || (n > 0 && /^\[\{"n":/.test(txt));
}

async function awIndex() {
    if (AW_INDEX) return AW_INDEX;
    var parts = [], n = 0, done = false, ignored = false, joined = "";
    while (!done && n < 80) {
        var batch = [], k;
        for (k = 0; k < 5; k++) batch.push(awChunk(n + k));
        var res = await Promise.all(batch);
        for (k = 0; k < res.length; k++) {
            if (n + k > 0 && /^\[\{"n":/.test(res[k])) { ignored = true; done = true; break; }
            if (awChunkBad(res[k], n + k)) { done = true; break; }
            parts.push(res[k]);
        }
        n += 5;
        joined = parts.join("");
        if (/"\}\]\s*$/.test(joined)) done = true;
    }
    if (!parts.length) {
        // no Range support at all: plain single request
        joined = String(await awGet(AW_BASE + "/filter-index.json", { "Referer": AW_BASE + "/" }));
    }
    var list = awParseIndex(joined);
    AW_DIAG = "index " + parts.length + " chunks, " + list.length + " titles" +
        (/"\}\]\s*$/.test(joined) ? ", complete" : ", INCOMPLETE") + (ignored ? ", range ignored" : "");
    if (!list.length) throw new Error(AW_DIAG + ", starts: " + joined.slice(0, 40));
    AW_INDEX = list;
    return AW_INDEX;
}

function awNorm(str) {
    return String(str || "").toLowerCase().replace(/[^a-z0-9\u00c0-\uffff]+/g, " ").trim();
}


// Type  aw-debug  into the app's search box to see what the module sees.
async function awDebug() {
    var rows = [], t0 = Date.now();
    function add(t) { rows.push({ title: String(t), image: "", href: AW_BASE + "/" }); }
    add("Aniwaves module v" + AW_VERSION + " is running");
    try {
        var list = await awIndex();
        add("title list: " + AW_DIAG + " in " + (Date.now() - t0) + "ms");
        var hit = 0;
        for (var i = 0; i < list.length; i++) if (awNorm(list[i].n).indexOf("black clover") >= 0) hit++;
        add("'black clover' matches: " + hit + "; first title: " + (list[0] && list[0].n));
    } catch (e) { add("title list failed: " + ((e && e.message) || e)); }
    return awDiagRow(rows);
}

// Download a whole (possibly >96 KB) page by stitching Range pieces together.
async function awRangePiece(url, headers, n) {
    var h = {}, k;
    for (k in (headers || {})) h[k] = headers[k];
    h["Range"] = "bytes=" + (n * AW_CHUNK) + "-" + ((n + 1) * AW_CHUNK - 1);
    try { return String(await awGet(url, h)); } catch (e) { return ""; }
}

async function awGetAll(url, headers) {
    var parts = [], n = 0, done = false, first = "", k;
    while (!done && n < 40) {
        var batch = [];
        for (k = 0; k < 4; k++) batch.push(awRangePiece(url, headers, n + k));
        var res = await Promise.all(batch);
        for (k = 0; k < res.length; k++) {
            var t = res[k], idx = n + k;
            if (idx === 0) first = t;
            else if (t.length < 5 || /not satisfiable/i.test(t.slice(0, 200)) || t.slice(0, 300) === first.slice(0, 300)) { done = true; break; }
            parts.push(t);
            if (/<\/html>\s*$/i.test(t)) { done = true; break; }
        }
        n += 4;
    }
    return parts.join("");
}


// aw-page [slug]   -> what the raw episode page contains
// aw-stream [slug] -> runs the stream chain for episode 1 and shows each step
async function awPageDebug(slug) {
    var rows = [];
    function add(t) { rows.push({ title: String(t), image: "", href: AW_BASE + "/" }); }
    var url = AW_BASE + "/watch/" + (slug || "black-clover-520") + "/";
    try {
        var html = await awGetAll(url, { "Referer": AW_BASE + "/" });
        var c = function (re) { return (html.match(re) || []).length; };
        add("page " + html.length + " chars, ends with </html>: " + /<\/html>\s*$/i.test(html));
        add("data-num: " + c(/data-num=/g) + ", /watch/ links: " + c(/\/watch\//g) + ", 'Episode 2': " + c(/Episode 2\b/g));
        var i = html.indexOf("data-num=");
        add("first data-num: " + (i >= 0 ? html.slice(Math.max(0, i - 120), i + 120).replace(/\s+/g, " ") : "none"));
        var j = html.indexOf('data-num="2"');
        add("data-num 2: " + (j >= 0 ? html.slice(Math.max(0, j - 80), j + 80).replace(/\s+/g, " ") : "none"));
    } catch (e) { add("page failed: " + ((e && e.message) || e)); }
    return awDiagRow(rows);
}

async function awStreamDebug(slug) {
    var rows = [];
    function add(t) { rows.push({ title: String(t), image: "", href: AW_BASE + "/" }); }
    AW_TRACE = [];
    var r = JSON.parse(await extractStreamUrl(AW_BASE + "/watch/" + (slug || "black-clover-520") + "/?ep=1"));
    for (var i = 0; i < AW_TRACE.length; i++) add(AW_TRACE[i]);
    add("stream: " + (r.stream ? r.stream.length + " chars, " + r.stream.slice(0, 90) + "…" : "none"));
    add("subtitles: " + (r.subtitles ? (r.subtitles.indexOf("data:") === 0 ? "inline data link, " + r.subtitles.length + " chars" : r.subtitles) : "none"));
    r.subtitles = r.subtitleUrl || r.subtitles;
    if (r.subtitles) {
        var variants = [["no referer", {}], ["megaplay referer", { "Referer": "https://megaplay.buzz/", "Origin": "https://megaplay.buzz" }]];
        for (var v = 0; v < variants.length; v++) {
            try {
                var h = { "User-Agent": AW_UA }, k;
                for (k in variants[v][1]) h[k] = variants[v][1][k];
                var res = await fetchv2(r.subtitles, h, "GET", null);
                var txt = String(await res.text());
                add("subtitle file (" + variants[v][0] + "): " + txt.length + " chars, starts: " + txt.slice(0, 40).replace(/\s+/g, " "));
            } catch (e) { add("subtitle file (" + variants[v][0] + ") failed: " + ((e && e.message) || e)); }
        }
    }
    return awDiagRow(rows);
}

// ---- tolerant HTML helpers (the live pages are minified: href=/watch/x/ data-num=1) ----
function awTagEnd(html, i) {
    var q = "", c;
    for (; i < html.length; i++) {
        c = html.charAt(i);
        if (q) { if (c === q) q = ""; }
        else if (c === '"' || c === "'") q = c;
        else if (c === ">") return i;
    }
    return -1;
}

function awAttr(tag, name) {
    var m = tag.match(new RegExp("[\\s\"']" + name + "=(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i"));
    return m ? (m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3])) : null;
}

function awTags(html, name) {
    var re = new RegExp("<" + name + "[\\s]", "gi"), out = [], m, e;
    while ((m = re.exec(html))) {
        e = awTagEnd(html, m.index);
        if (e < 0) break;
        out.push({ tag: html.slice(m.index, e + 1), start: m.index, end: e });
    }
    return out;
}


// aw-fetch -> what the app's fetch function gives back (headers, Range support)
async function awFetchDebug() {
    var rows = [];
    function add(t) { rows.push({ title: String(t), image: "", href: AW_BASE + "/" }); }
    var targets = [
        ["page", AW_BASE + "/watch/black-clover-520/", { "Referer": AW_BASE + "/", "Range": "bytes=-70000" }],
        ["json", AW_BASE + "/filter-index.json", { "Referer": AW_BASE + "/", "Range": "bytes=0-79999" }]
    ];
    for (var t = 0; t < targets.length; t++) {
        try {
            var h = { "User-Agent": AW_UA }, k;
            for (k in targets[t][2]) h[k] = targets[t][2][k];
            var res = await fetchv2(targets[t][1], h, "GET", null);
            var keys = [];
            for (k in res) keys.push(k);
            var txt = String(await res.text());
            var info = [];
            try { info.push("status " + res.status); } catch (e) { }
            try {
                var hd = res.headers || {}, names = ["content-length", "content-range", "accept-ranges", "content-encoding", "cf-cache-status", "server"];
                for (k = 0; k < names.length; k++) {
                    var v = typeof hd.get === "function" ? hd.get(names[k]) : (hd[names[k]] || hd[names[k].toUpperCase()]);
                    if (v) info.push(names[k] + "=" + v);
                }
            } catch (e) { }
            add(targets[t][0] + ": " + txt.length + " chars; " + info.join(", ") + "; members: " + keys.join(","));
        } catch (e) { add(targets[t][0] + " failed: " + ((e && e.message) || e)); }
    }
    return awDiagRow(rows);
}

// The app shows only one row per diagnostic, so everything goes into a single
// row; tapping it opens the details page, which prints the full text.
function awDiagRow(rows) {
    var lines = [];
    for (var i = 0; i < rows.length; i++) lines.push(rows[i].title);
    if (AW_LINE > 0 && lines[AW_LINE - 1] !== undefined) {   // e.g. "aw-stream <slug> 4" shows only line 4
        return JSON.stringify([{
            title: "[" + AW_LINE + "/" + lines.length + "] " + lines[AW_LINE - 1],
            image: "",
            href: AW_BASE + "/?aw-diag=" + encodeURIComponent(lines.join("\n"))
        }]);
    }
    return JSON.stringify([{
        title: "Aniwaves diagnostic - tap to read all " + lines.length + " lines. " + (lines[0] || ""),
        image: "",
        href: AW_BASE + "/?aw-diag=" + encodeURIComponent(lines.join("\n"))
    }]);
}

// --------------------------------------------------------------- search ---
async function searchResults(keyword) {
    try {
        var raw = String(keyword || "");
        try { raw = decodeURIComponent(raw.replace(/\+/g, " ")); } catch (e) { }
        var dm = raw.match(/^\s*aw-(debug|fetch|page|stream)((?:\s+\S+)*)\s*$/i);
        if (dm) {
            var args = dm[2].trim() ? dm[2].trim().split(/\s+/) : [], slug = "", z;
            AW_LINE = 0;
            for (z = 0; z < args.length; z++) {
                if (/^\d{1,2}$/.test(args[z])) AW_LINE = parseInt(args[z], 10);
                else if (!slug) slug = args[z];
            }
            var kind = dm[1].toLowerCase();
            if (kind === "debug") return await awDebug();
            if (kind === "fetch") return await awFetchDebug();
            if (kind === "page") return await awPageDebug(slug);
            return await awStreamDebug(slug);
        }
        var q = awNorm(raw), words = q ? q.split(" ") : [];
        var list = await awIndex();
        var scored = [];
        for (var i = 0; i < list.length; i++) {
            var it = list[i];
            var names = [it.n, it.j].concat(it.an || []);
            var best = 0;
            for (var k = 0; k < names.length; k++) {
                var nm = awNorm(names[k]);
                if (!nm) continue;
                var s = 0;
                if (!q) s = 1;
                else if (nm.indexOf(q) === 0) s = 4;
                else if (nm.indexOf(q) > 0) s = 3;
                else {
                    var all = true;
                    for (var w = 0; w < words.length; w++) if (nm.indexOf(words[w]) < 0) { all = false; break; }
                    if (all) s = 2;
                }
                if (s > best) best = s;
            }
            if (best > 0) scored.push({ s: best, it: it });
        }
        scored.sort(function (a, b) { return b.s - a.s; });
        var out = [];
        if (!scored.length) {
            return JSON.stringify([{ title: "No match for \"" + raw + "\" (v" + AW_VERSION + "; " + AW_DIAG + ")", image: "", href: AW_BASE + "/" }]);
        }
        for (var n = 0; n < scored.length && n < 40; n++) {
            var x = scored[n].it;
            out.push({
                title: x.n || x.j,
                image: "https://img.aniwaves.org/thumb/w_128/h_176/" + x.s + ".webp",
                href: AW_BASE + "/watch/" + x.s + "/"
            });
        }
        return JSON.stringify(out);
    } catch (e) {
        // Show the real reason in the results list instead of failing silently.
        return JSON.stringify([{ title: "Aniwaves error: " + ((e && e.message) || e), image: "", href: AW_BASE + "/" }]);
    }
}

// ------------------------------------------------------------- details ---
async function extractDetails(url) {
    var dg = String(url).match(/[?&]aw-diag=([^&#]*)/);
    if (dg) {
        var text = "";
        try { text = decodeURIComponent(dg[1]); } catch (e0) { text = dg[1]; }
        return JSON.stringify([{ description: text, aliases: "Aniwaves v" + AW_VERSION, airdate: "diagnostic" }]);
    }
    try {
        var html = await awGetAll(awAbs(url), { "Referer": AW_BASE + "/" });
        var desc = "", aliases = "", airdate = "", i, e;
        var cm = html.match(/class=["']?content[\s"'>]/);
        if (cm) {
            e = awTagEnd(html, cm.index);
            var close = html.indexOf("</div>", e);
            if (e > 0 && close > e) desc = awStrip(html.slice(e + 1, close));
        }
        var h1 = awTags(html, "h1")[0];
        if (h1) aliases = awStrip(awAttr(h1.tag, "data-jp") || "");
        var d = html.match(/Date aired:\s*<span[^>]*>([^<]*)<\/span>/i);
        if (d) airdate = awStrip(d[1]);
        else {
            var p = html.match(/Premiered:\s*<span[^>]*>([^<]*)<\/span>/i);
            if (p) airdate = awStrip(p[1]);
        }
        if (!desc || !airdate) {
            // Long episode lists push the info block past the app's 96 KB limit;
            // the site's title list has the basics for every show.
            try {
                var slug = (awAbs(url).match(/\/watch\/([^\/?#]+)/) || [])[1], list = await awIndex(), it = null;
                for (i = 0; i < list.length; i++) if (list[i].s === slug) { it = list[i]; break; }
                if (it) {
                    if (!desc) {
                        var bits = [];
                        if (it.f) bits.push(it.f);
                        if (it.st) bits.push(it.st);
                        if (it.g && it.g.length) bits.push(it.g.join(", "));
                        if (it.tt) bits.push(it.tt + " episodes");
                        if (it.sc) bits.push("Score " + (it.sc / 10).toFixed(1));
                        if (it.r) bits.push(it.r);
                        desc = bits.join(" · ");
                    }
                    if (!aliases) aliases = [it.j].concat(it.an || []).filter(function (x) { return x; }).join(", ");
                    if (!airdate) airdate = it.rd || it.y || "";
                }
            } catch (e4) { }
        }
        return JSON.stringify([{
            description: desc || "No description available",
            aliases: aliases || "N/A",
            airdate: airdate || "N/A"
        }]);
    } catch (e2) {
        return JSON.stringify([{ description: "Error loading details", aliases: "N/A", airdate: "N/A" }]);
    }
}

// ------------------------------------------------------------ episodes ---
async function extractEpisodes(url) {
    try {
        var page = awAbs(url).replace(/[#?].*$/, "");
        var html = await awGetAll(page, { "Referer": AW_BASE + "/" });
        var anchors = awTags(html, "a"), seen = {}, out = [], i, maxn = 0;
        for (i = 0; i < anchors.length; i++) {
            var num = awAttr(anchors[i].tag, "data-num");
            if (num === null || num === "" || seen[num] || isNaN(parseFloat(num))) continue;
            seen[num] = true;
            var href = awAttr(anchors[i].tag, "href");
            var base = href ? awAbs(href) : page;
            out.push({ href: base.replace(/[#?].*$/, "") + "?ep=" + num, number: parseFloat(num) });
            if (parseFloat(num) > maxn) maxn = parseFloat(num);
        }
        // The app only receives the first ~96 KB of a page, so long episode lists
        // arrive cut off. The site's title list knows each show's episode total.
        var truncated = html.length >= 90000 && !/<\/html>\s*$/i.test(html);
        if (truncated || !out.length) {
            try {
                var slug = (page.match(/\/watch\/([^\/]+)\/?$/) || [])[1], list = await awIndex();
                for (i = 0; i < list.length; i++) {
                    if (list[i].s === slug) {
                        var tt = parseInt(list[i].tt, 10) || 0;
                        for (var n = Math.floor(maxn) + 1; n <= tt; n++) {
                            out.push({ href: page + "?ep=" + n, number: n });
                        }
                        break;
                    }
                }
            } catch (e3) { }
        }
        out.sort(function (a, b) { return a.number - b.number; });
        return JSON.stringify(out);
    } catch (e) {
        return JSON.stringify([]);
    }
}

// -------------------------------------------------------------- stream ---
async function awPageKey() {
    try {
        var html = await awGet(AW_PLAY + "/watch", { "Referer": AW_BASE + "/" });
        var m = html.match(/PAGE_KEY\s*=\s*["']([A-Za-z0-9_\-]{40,})["']/);
        if (m) return m[1];
    } catch (e) { }
    return AW_PAGE_KEY_DEFAULT;
}

function awB64Std(bytes) {
    var s = awB64UrlEncode(bytes).replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    return s;
}

// Download the subtitle file ourselves and return it as a data: link.
async function awInlineSubtitle(url) {
    if (AW_SUB_MODE !== "data" || !url) return url;
    try {
        var txt = await awGet(url, { "Referer": "https://megaplay.buzz/", "Origin": "https://megaplay.buzz" });
        txt = String(txt).replace(/^\uFEFF/, "");
        if (!/^\s*WEBVTT/.test(txt) || txt.length > AW_SUB_MAX) { AW_TRACE.push("subtitle kept as link (" + txt.length + " chars)"); return url; }
        AW_TRACE.push("subtitle inlined (" + txt.length + " chars)");
        return "data:text/vtt;charset=utf-8;base64," + awB64Std(awUtf8Bytes(txt));
    } catch (e) {
        AW_TRACE.push("subtitle download failed: " + ((e && e.message) || e));
        return url;
    }
}

function awPickSubtitle(tracks) {
    if (!tracks || !tracks.length) return "";
    var subs = [], i;
    for (i = 0; i < tracks.length; i++) {
        var t = tracks[i];
        if (!t || !t.file) continue;
        if (t.kind && !/captions|subtitles/i.test(t.kind)) continue;
        subs.push(t);
    }
    for (i = 0; i < subs.length; i++) if (/english/i.test(subs[i].label || "")) return subs[i].file;
    for (i = 0; i < subs.length; i++) if (subs[i]["default"]) return subs[i].file;
    return subs.length ? subs[0].file : "";
}

async function awTryServer(token, ep, server, type, pageKey) {
    var hash = token + "." + ep + "." + server + "." + type;
    var raw = await awGet(AW_PLAY + "/get/" + encodeURIComponent(hash), {
        "Referer": AW_PLAY + "/watch", "Accept": "application/json"
    });
    var info = JSON.parse(raw);
    if (!info || info.mode !== "embed" || !info.info) throw new Error("no embed");

    var embedUrl;
    try { embedUrl = awDecryptInfo(info.info, pageKey); }
    catch (e) { embedUrl = awDecryptInfo(info.info, AW_PAGE_KEY_DEFAULT); }

    var embed = await awGet(embedUrl, { "Referer": AW_PLAY + "/" });
    var idm = embed.match(/id=["']megaplay-player["'][^>]*?data-id=["']([^"']+)["']/) ||
        embed.match(/data-id=["']([^"']+)["'][^>]*?id=["']megaplay-player["']/);
    if (!idm) throw new Error("no data-id");
    var bm = embed.match(/base_url["']?\s*[:=]\s*["']([^"']+)["']/);
    var base = bm ? bm[1].replace(/\\\//g, "/") : (embedUrl.match(/^https?:\/\/[^\/]+/)[0] + "/");
    if (!/^https?:\/\//.test(base)) base = embedUrl.match(/^https?:\/\/[^\/]+/)[0] + "/";
    if (base.charAt(base.length - 1) !== "/") base += "/";

    var src = await awGet(base + "stream/getSources?id=" + encodeURIComponent(idm[1]) + "&platform=OTHER", {
        "Referer": embedUrl, "X-Requested-With": "XMLHttpRequest", "Accept": "application/json"
    });
    var data = JSON.parse(src);
    try {
        var tl = [];
        for (var q = 0; q < (data.tracks || []).length; q++) {
            var tk = data.tracks[q];
            tl.push((tk.label || tk.kind || "?") + "/" + (tk.kind || "-") + (tk["default"] ? "*" : "") + " " + String(tk.file || "").slice(-28));
        }
        AW_TRACE.push("tracks(" + tl.length + "): " + (tl.join(" ; ") || "none") + " | keys: " + Object.keys(data).join(","));
    } catch (e) { }
    var file = null;
    if (data.enc) file = awDecryptEnc(data.enc).file;
    else if (data.sources) file = typeof data.sources === "string" ? data.sources : data.sources.file;
    if (!file) throw new Error("no file");

    var subUrl = awPickSubtitle(data.tracks);
    return { stream: awAttachToken(file), subtitles: await awInlineSubtitle(subUrl), subtitleUrl: subUrl };
}

async function extractStreamUrl(url) {
    try {
        var epm = String(url).match(/[?&#]ep=([^&#]+)/);
        var ep = epm ? epm[1] : "1";
        var page = awAbs(url).replace(/[#?].*$/, "");
        var kre1 = /const\s+O\s*=\s*"[^"]*"\s*,\s*k\s*=\s*"([A-Za-z0-9_\-]+)"/, kre2 = /\bk\s*=\s*"([A-Za-z0-9_\-]{30,})"/;
        var km = null, html = "";
        try {   // the token script sits near the end of the page: ask for just the tail first
            html = await awGet(page, { "Referer": AW_BASE + "/", "Range": "bytes=-70000" });
            km = html.match(kre1) || html.match(kre2);
        } catch (e) { }
        if (!km) {
            html = await awGetAll(page, { "Referer": AW_BASE + "/" });
            km = html.match(kre1) || html.match(kre2);
        }
        if (!km) { AW_TRACE.push("no player token in page (" + html.length + " chars)"); return JSON.stringify({ stream: "", subtitles: "" }); }
        var pageKey = await awPageKey();
        for (var i = 0; i < AW_SERVERS.length; i++) {
            try {
                var r = await awTryServer(km[1], ep, AW_SERVERS[i], AW_TYPE, pageKey);
                AW_TRACE.push("server " + AW_SERVERS[i] + " ok");
                // The CDN wants the player site as referrer. The documented keys are
                // stream/subtitles; the extra keys are for apps that accept headers.
                var hdr = { "Referer": "https://megaplay.buzz/", "Origin": "https://megaplay.buzz", "User-Agent": AW_UA };
                return JSON.stringify({
                    stream: r.stream, subtitles: r.subtitles, subtitle: r.subtitles, subtitleUrl: r.subtitleUrl, headers: hdr,
                    streams: [{ title: "Aniwaves", streamUrl: r.stream, headers: hdr }]
                });
            } catch (e) { AW_TRACE.push("server " + AW_SERVERS[i] + ": " + ((e && e.message) || e)); }
        }
        return JSON.stringify({ stream: "", subtitles: "" });
    } catch (e) {
        AW_TRACE.push("stream error: " + ((e && e.message) || e));
        return JSON.stringify({ stream: "", subtitles: "" });
    }
}