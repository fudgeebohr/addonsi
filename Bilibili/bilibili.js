// Bilibili (bilibili.tv / Bstation, international) - Sora module for MiruShin
// Endpoints taken from the public web API used by bilibili.tv itself.
// Videos on bilibili.tv are DASH: the video and the audio are SEPARATE files.
var BL_VERSION = "1.1.0";

var BL_WEB = "https://www.bilibili.tv";
var BL_API = "https://api.bilibili.tv/intl/gateway/web";
var BL_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ---- settings you can change ------------------------------------------------
// Highest quality id to use: 112 = 1080P+, 80 = 1080P, 64 = 720P, 32 = 480P, 16 = 360P.
// (guests normally only get up to 720P; the best one that exists <= this number is used)
var BL_MAX_QUALITY = 112;
// Address of YOUR relay (see worker.js / SETUP). Example: "https://bilibili-relay.yourname.workers.dev"
// Leave it empty ("") to run without the relay (video only, no sound, in MiruShin on Windows).
var BL_RELAY = "https://hsl.fugenkenneth.workers.dev/";
// How the separate audio file is handed to the player:
//   "auto"  = "relay" when BL_RELAY is filled in, otherwise "split"
//   "relay" = HLS playlist from your relay: video + audio together (works in MiruShin on Windows)
//   "dash"  = MiruShin's inline-DASH link (only players that accept single-file DASH)
//   "split" = video url in "stream" + audio url in extra keys (MiruShin ignores the audio)
var BL_AUDIO_MODE = "auto";
// -----------------------------------------------------------------------------

// ------------------------------------------------------------- helpers ------
function blHeaders() {
    return {
        "Referer": BL_WEB + "/",
        "Origin": BL_WEB,
        "User-Agent": BL_UA,
        "Accept": "application/json, text/plain, */*"
    };
}

// headers the video player must send to the CDN
function blMediaHeaders() {
    return { "Referer": BL_WEB + "/", "Origin": BL_WEB, "User-Agent": BL_UA };
}

function blDecode(s) {
    var raw = String(s == null ? "" : s);
    try { raw = decodeURIComponent(raw.replace(/\+/g, " ")); } catch (e) { }
    return raw;
}

function blStrip(s) {
    return String(s == null ? "" : s)
        .replace(/<[^>]*>/g, "")
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"").replace(/&#0?39;/g, "'").replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ").trim();
}

function blHttps(u) {
    u = String(u || "");
    if (u.indexOf("//") === 0) return "https:" + u;
    return u;
}

async function blGet(url, headers) {
    var r = await fetchv2(url, headers || blHeaders());
    return String(await r.text());
}

function blParseJson(text) {
    var t = String(text).replace(/^﻿/, "").trim();
    return JSON.parse(t);
}

async function blJson(path) {
    var url = path.indexOf("http") === 0 ? path : BL_API + path;
    var text = await blGet(url);
    var j;
    try { j = blParseJson(text); }
    catch (e) { throw new Error("not JSON from " + path.slice(0, 60) + ": " + text.slice(0, 80)); }
    if (j && j.code !== undefined && j.code !== 0) {
        throw new Error(blApiError(j));
    }
    return j;
}

function blApiError(j) {
    var c = j && j.code, m = (j && j.message) || "";
    var hint = "";
    if (c === 10004004 || c === 10004005 || c === 10023006) hint = " (needs a Bilibili login / premium)";
    else if (c === 10004001) hint = " (not available in your region)";
    return "API code " + c + (m ? " " + m : "") + hint;
}

// What does the url / text point to?
//   .../en/play/<season>[/<episode>]   -> series (ogv)
//   .../en/video/<aid>                 -> user video (ugc)
//   a bare number: 4-8 digits = episode id, longer = video id
function blParse(url) {
    var u = String(url || "");
    var m = u.match(/\/play\/(\d+)(?:\/(\d+))?/);
    if (m) return { type: "ogv", season: m[1], ep: m[2] || "" };
    m = u.match(/\/video\/(\d+)/);
    if (m) return { type: "ugc", aid: m[1] };
    m = u.match(/^\s*(\d+)\s*$/);
    if (m) {
        if (m[1].length <= 8) return { type: "ogv", season: "", ep: m[1] };
        return { type: "ugc", aid: m[1] };
    }
    return null;
}

function blPage(id) {
    return id.type === "ugc" ? BL_WEB + "/en/video/" + id.aid
        : BL_WEB + "/en/play/" + id.season + (id.ep ? "/" + id.ep : "");
}

// ------------------------------------------------------------- base64 -----
var BL_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function blUtf8Bytes(s) {
    var out = [], i, c;
    for (i = 0; i < s.length; i++) {
        c = s.charCodeAt(i);
        if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
            var d = s.charCodeAt(i + 1);
            if (d >= 0xDC00 && d <= 0xDFFF) { c = 0x10000 + ((c - 0xD800) << 10) + (d - 0xDC00); i++; }
        }
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
}

function blB64(bytes) {
    var out = "", i;
    for (i = 0; i < bytes.length; i += 3) {
        var a = bytes[i], b = i + 1 < bytes.length ? bytes[i + 1] : 0, c = i + 2 < bytes.length ? bytes[i + 2] : 0;
        out += BL_B64.charAt(a >> 2) + BL_B64.charAt(((a & 3) << 4) | (b >> 4)) +
            (i + 1 < bytes.length ? BL_B64.charAt(((b & 15) << 2) | (c >> 6)) : "=") +
            (i + 2 < bytes.length ? BL_B64.charAt(c & 63) : "=");
    }
    return out;
}

function blDataUri(mime, text) {
    return "data:" + mime + ";base64," + blB64(blUtf8Bytes(text));
}

// MiruShin understands "mirushin-dash:<base64url of an MPD manifest>" (its own inline-DASH link).
function blDashLink(manifest) {
    return "mirushin-dash:" + blB64(blUtf8Bytes(manifest)).replace(/\+/g, "-").replace(/\//g, "_");
}

// ------------------------------------------------------------- search -----
async function searchResults(keyword) {
    try {
        var raw = blDecode(keyword);
        var dm = raw.match(/^\s*bl-(debug|raw|play|sub|relay)((?:\s+\S+)*)\s*$/i);
        if (dm) return await blCommand(dm[1].toLowerCase(), (dm[2] || "").trim());

        var q = raw.replace(/\s+/g, " ").trim();
        if (!q) return JSON.stringify([]);

        var j = await blJson("/v2/search_v2?keyword=" + encodeURIComponent(q) +
            "&platform=web&pn=1&ps=30&s_locale=en_US");
        var mods = (j && j.data && j.data.modules) || [];
        var out = [], seen = {}, mi, ii;
        for (mi = 0; mi < mods.length; mi++) {
            var mod = mods[mi] || {};
            var items = mod.items || [];
            for (ii = 0; ii < items.length; ii++) {
                var it = items[ii] || {};
                var season = it.season_id && String(it.season_id) !== "0" ? String(it.season_id) : "";
                var aid = it.aid && String(it.aid) !== "0" ? String(it.aid) : "";
                var type = String(mod.type || "").toLowerCase();
                var href = "";
                if (season && type !== "ugc") href = BL_WEB + "/en/play/" + season;
                else if (aid) href = BL_WEB + "/en/video/" + aid;
                else if (season) href = BL_WEB + "/en/play/" + season;
                if (!href || seen[href]) continue;
                var title = blStrip(it.title);
                if (!title) continue;
                seen[href] = true;
                out.push({ title: title, image: blHttps(it.cover || it.pic || ""), href: href });
            }
        }
        if (!out.length) {
            return JSON.stringify([{
                title: "No results for \"" + q + "\" (bilibili v" + BL_VERSION + ", " + mods.length + " result groups)",
                image: "", href: BL_WEB + "/"
            }]);
        }
        return JSON.stringify(out);
    } catch (e) {
        return JSON.stringify([{
            title: "Search failed (bilibili v" + BL_VERSION + "): " + ((e && e.message) || e),
            image: "", href: BL_WEB + "/"
        }]);
    }
}

// ------------------------------------------------------------- details ----
async function extractDetails(url) {
    try {
        var dg = String(url).match(/[?&]bl-diag=([^&#]*)/);
        if (dg) {
            return JSON.stringify([{ description: decodeURIComponent(dg[1]), aliases: "Diagnostic", airdate: "N/A" }]);
        }
        var id = blParse(url);
        if (!id) return JSON.stringify([{ description: "N/A", aliases: "N/A", airdate: "N/A" }]);

        if (id.type === "ogv") {
            var season = id.season;
            if (!season) season = "";
            var j = await blJson("/v2/ogv/play/season_info?season_id=" + season + "&platform=web&s_locale=en_US");
            var s = (j.data && (j.data.season || j.data)) || {};
            var styles = [], k;
            var st = s.styles || [];
            for (k = 0; k < st.length; k++) {
                var t = typeof st[k] === "string" ? st[k] : (st[k] && st[k].title);
                if (t) styles.push(t);
            }
            return JSON.stringify([{
                description: blStrip(s.description || s.evaluate || "") || "No description available",
                aliases: styles.length ? styles.join(", ") : "N/A",
                airdate: String(s.player_date || s.publish_time || s.release_date || "N/A")
            }]);
        }

        // user video: the page head has the upload date, the body the uploader
        var html = await blGet(BL_WEB + "/en/video/" + id.aid, {
            "User-Agent": BL_UA, "Accept-Language": "en-US,en;q=0.9"
        });
        var up = html.match(/bstar-meta-upinfo__nickName[^>]*>\s*([^<]+?)\s*(?:<|$)/);
        var dt = html.match(/"uploadDate"\s*:\s*"([^"]+)"/);
        var ds = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]*)"/);
        var desc = [];
        if (up) desc.push("Uploader: " + blStrip(up[1]));
        if (ds && blStrip(ds[1])) desc.push(blStrip(ds[1]));
        return JSON.stringify([{
            description: desc.length ? desc.join("\n") : "Bilibili video",
            aliases: "N/A",
            airdate: dt ? dt[1].slice(0, 10) : "N/A"
        }]);
    } catch (e) {
        return JSON.stringify([{ description: "Error: " + ((e && e.message) || e), aliases: "N/A", airdate: "N/A" }]);
    }
}

// ------------------------------------------------------------- episodes ---
async function blEpisodeList(season) {
    var j = await blJson("/v2/ogv/play/episodes?season_id=" + season + "&platform=web&s_locale=en_US");
    var sections = (j.data && j.data.sections) || [];
    var pick = [], i, k;
    for (i = 0; i < sections.length; i++) {
        var sec = sections[i] || {};
        var name = String(sec.ep_list_title || sec.title || "");
        if (/episode/i.test(name) && (sec.episodes || []).length) pick.push(sec);
    }
    if (!pick.length) {
        for (i = 0; i < sections.length; i++) {
            if (((sections[i] || {}).episodes || []).length) { pick.push(sections[i]); break; }
        }
    }
    var list = [], seen = {};
    for (i = 0; i < pick.length; i++) {
        var eps = pick[i].episodes || [];
        for (k = 0; k < eps.length; k++) {
            var e = eps[k] || {};
            var eid = String(e.episode_id || e.id || "");
            if (!eid || seen[eid]) continue;
            seen[eid] = true;
            list.push({
                id: eid,
                short: String(e.short_title_display || e.title_display || ""),
                long: blStrip(e.long_title_display || e.title_display || "")
            });
        }
    }
    return list;
}

async function extractEpisodes(url) {
    try {
        var id = blParse(url);
        if (!id) return JSON.stringify([]);
        if (id.type === "ugc") {
            return JSON.stringify([{ href: BL_WEB + "/en/video/" + id.aid, number: 1, title: "Video" }]);
        }
        var list = await blEpisodeList(id.season);
        var out = [], used = {}, i;
        for (i = 0; i < list.length; i++) {
            var n = parseFloat((list[i].short.match(/\d+(?:\.\d+)?/) || [])[0]);
            if (!isFinite(n) || used[n]) n = i + 1;
            while (used[n]) n += 1;
            used[n] = true;
            out.push({
                href: BL_WEB + "/en/play/" + id.season + "/" + list[i].id,
                number: n,
                title: list[i].long || list[i].short || ("Episode " + n)
            });
        }
        return JSON.stringify(out);
    } catch (e) {
        return JSON.stringify([]);
    }
}

// ------------------------------------------------------------- playback ---
function blPlayPath(id, qn) {
    if (id.type === "ugc") {
        return "/playurl?s_locale=en_US&platform=web&aid=" + id.aid + "&device=wap&qn=" + qn + "&tf=0&type=0";
    }
    return "/playurl?ep_id=" + id.ep + "&s_locale=en_US&device=wap&platform=web&qn=" + qn + "&tf=0&type=0";
}

// Collect every video / audio file the API offers.
function blCollect(j, videos, audios) {
    var d = (j && j.data) || {}, p = d.playurl || d;
    var vs = p.video || [], i;
    for (i = 0; i < vs.length; i++) {
        var v = vs[i] || {}, r = v.video_resource || {}, si = v.stream_info || {};
        var u = r.url || (r.backup_url && r.backup_url[0]) || "";
        if (!u) continue;
        videos.push({
            url: u, q: si.quality || 0, desc: si.desc_words || "",
            codecs: String(r.codecs || ""), w: r.width || 0, h: r.height || 0,
            size: r.size || 0, bw: r.bandwidth || 0
        });
    }
    var as = p.audio_resource || [];
    for (i = 0; i < as.length; i++) {
        var a = as[i] || {};
        if (!a.url) continue;
        audios.push({ url: a.url, bw: a.bandwidth || 0, codecs: String(a.codecs || ""), size: a.size || 0 });
    }
    // alternative layout (same as the page uses): playurl.dash.{video,audio}[].base_url
    var dash = p.dash || d.dash;
    if (dash) {
        var dv = dash.video || [], da = dash.audio || [];
        for (i = 0; i < dv.length; i++) {
            var x = dv[i] || {}, xu = x.base_url || x.baseUrl || "";
            if (xu) videos.push({ url: xu, q: x.id || 0, desc: "", codecs: String(x.codecs || ""), w: x.width || 0, h: x.height || 0, size: 0, bw: x.bandwidth || 0 });
        }
        for (i = 0; i < da.length; i++) {
            var y = da[i] || {}, yu = y.base_url || y.baseUrl || "";
            if (yu) audios.push({ url: yu, bw: y.bandwidth || 0, codecs: String(y.codecs || ""), size: 0 });
        }
    }
}

async function blPlay(id) {
    var videos = [], audios = [], notes = [], err = "";
    var qns = [64, 120];
    for (var i = 0; i < qns.length; i++) {
        try {
            var j = await blJson(blPlayPath(id, qns[i]));
            var before = videos.length;
            blCollect(j, videos, audios);
            notes.push("qn=" + qns[i] + ": " + (videos.length - before) + " video file(s)");
        } catch (e) {
            err = (e && e.message) || String(e);
            notes.push("qn=" + qns[i] + ": " + err);
        }
        if (i === 0 && !videos.length && /login|region|premium/i.test(err)) break;
    }
    if (!videos.length) throw new Error("no video file returned (" + notes.join("; ") + ")");

    // best quality that is <= BL_MAX_QUALITY, h264 preferred (plays everywhere)
    var best = null, k;
    for (k = 0; k < videos.length; k++) {
        var v = videos[k];
        if (v.q > BL_MAX_QUALITY) continue;
        if (!best) { best = v; continue; }
        var vAvc = /^avc/i.test(v.codecs), bAvc = /^avc/i.test(best.codecs);
        if (v.q > best.q || (v.q === best.q && vAvc && !bAvc) || (v.q === best.q && vAvc === bAvc && v.bw > best.bw)) best = v;
    }
    if (!best) {   // everything is above the limit: take the lowest
        best = videos[0];
        for (k = 1; k < videos.length; k++) if (videos[k].q < best.q) best = videos[k];
    }
    var audio = null;
    for (k = 0; k < audios.length; k++) if (!audio || audios[k].bw > audio.bw) audio = audios[k];
    return { video: best, audio: audio, videos: videos, audios: audios, notes: notes };
}

// ------------------------------------------------------------- subtitles --
function blTime(sec) {
    var ms = Math.round(Number(sec) * 1000);
    if (!isFinite(ms) || ms < 0) ms = 0;
    var h = Math.floor(ms / 3600000); ms -= h * 3600000;
    var m = Math.floor(ms / 60000); ms -= m * 60000;
    var s = Math.floor(ms / 1000); ms -= s * 1000;
    function p(n, w) { n = String(n); while (n.length < w) n = "0" + n; return n; }
    return p(h, 2) + ":" + p(m, 2) + ":" + p(s, 2) + "." + p(ms, 3);
}

// MiruShin reads SRT / VTT / ASS subtitle files over HTTP. Bilibili lists several
// files per language; JSON ones (its own format) cannot be used, so pick srt/ass/vtt.
function blSubUrl(s) {
    var c = [s && s.srt && s.srt.url, s && s.ass && s.ass.url, s && s.vtt && s.vtt.url, s && s.url], i;
    for (i = 0; i < c.length; i++) {
        var u = blHttps(c[i] || "");
        if (u && !/\.json(\?|#|$)/i.test(u)) return u;
    }
    return "";
}

async function blSubs(id) {
    var q = id.type === "ugc" ? "aid=" + id.aid : "ep_id=" + id.ep + "&episode_id=" + id.ep;
    var j = await blJson("/v2/subtitle?" + q + "&platform=web&s_locale=en_US");
    var d = j.data || {};
    var list = (d.subtitles || d.video_subtitle || []).slice(0, 20);
    var tracks = [], i;
    for (i = 0; i < list.length; i++) {
        var s = list[i] || {}, url = blSubUrl(s);
        if (!url) continue;
        var label = String(s.lang_doc || s.lang || s.lang_key || "Subtitle");
        var lang = String(s.lang_key || s.lang || label);
        tracks.push({
            label: label, language: lang, lang: lang, name: label,
            url: url, file: url, src: url, "default": false,
            headers: { "Referer": BL_WEB + "/", "Origin": BL_WEB, "User-Agent": BL_UA }
        });
    }
    // English first, and it is the default track
    tracks.sort(function (a, b) {
        var ae = /^en|english/i.test(a.label) ? 0 : 1, be = /^en|english/i.test(b.label) ? 0 : 1;
        return ae - be;
    });
    if (tracks.length) tracks[0]["default"] = true;
    return tracks;
}

// ------------------------------------------------------------- manifest ---
function blXml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

function blMpd(video, audio) {
    var x = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
        "<MPD xmlns=\"urn:mpeg:dash:schema:mpd:2011\" profiles=\"urn:mpeg:dash:profile:isoff-on-demand:2011\" type=\"static\" minBufferTime=\"PT1.5S\" mediaPresentationDuration=\"PT12H\">\n" +
        "  <Period>\n" +
        "    <AdaptationSet mimeType=\"video/mp4\" contentType=\"video\">\n" +
        "      <Representation id=\"video\" bandwidth=\"" + (video.bw || 2000000) + "\" codecs=\"" + blXml(video.codecs || "avc1.640028") + "\" width=\"" + (video.w || 1280) + "\" height=\"" + (video.h || 720) + "\">\n" +
        "        <BaseURL>" + blXml(video.url) + "</BaseURL>\n" +
        "      </Representation>\n" +
        "    </AdaptationSet>\n";
    if (audio) {
        x += "    <AdaptationSet mimeType=\"audio/mp4\" contentType=\"audio\" lang=\"und\">\n" +
            "      <Representation id=\"audio\" bandwidth=\"" + (audio.bw || 128000) + "\" codecs=\"" + blXml(audio.codecs || "mp4a.40.2") + "\">\n" +
            "        <BaseURL>" + blXml(audio.url) + "</BaseURL>\n" +
            "      </Representation>\n" +
            "    </AdaptationSet>\n";
    }
    return x + "  </Period>\n</MPD>";
}

function blMode() {
    if (BL_AUDIO_MODE === "auto") return BL_RELAY ? "relay" : "split";
    return BL_AUDIO_MODE;
}

function blB64Url(str) {
    return blB64(blUtf8Bytes(String(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// master playlist address on the relay: it holds the video AND the audio track
function blRelayMaster(video, audio) {
    var base = String(BL_RELAY).replace(/\/+$/, "");
    var u = base + "/master.m3u8?v=" + blB64Url(video.url);
    if (audio) u += "&a=" + blB64Url(audio.url);
    if (video.codecs) u += "&vc=" + encodeURIComponent(video.codecs);
    if (audio && audio.codecs) u += "&ac=" + encodeURIComponent(audio.codecs);
    if (video.w && video.h) u += "&w=" + video.w + "&h=" + video.h;
    if (video.bw) u += "&vb=" + video.bw;
    if (audio && audio.bw) u += "&ab=" + audio.bw;
    return u;
}

async function blResolve(url) {
    var id = blParse(url);
    if (!id) throw new Error("unknown link: " + String(url).slice(0, 80));
    if (id.type === "ogv" && !id.ep) {   // series link without an episode: use the first one
        var list = await blEpisodeList(id.season);
        if (!list.length) throw new Error("series has no episodes");
        id.ep = list[0].id;
    }
    return id;
}

async function extractStreamUrl(url) {
    try {
        var id = await blResolve(url);
        var p = await blPlay(id);
        var subs = [];
        try { subs = await blSubs(id); } catch (e) { subs = []; }

        var hdr = blMediaHeaders();
        var subHdr = { "Referer": BL_WEB + "/", "Origin": BL_WEB };
        var title = "Bilibili " + (p.video.desc || (p.video.h ? p.video.h + "p" : "")) + (p.audio ? "" : " (no separate audio)");
        var out;

        var mode = blMode();
        if (mode === "relay" && BL_RELAY) {
            var rl = blRelayMaster(p.video, p.audio);
            out = {
                stream: rl, subtitles: subs, headers: hdr, subtitleHeaders: subHdr,
                streams: [{ title: title, streamUrl: rl, headers: hdr, subtitleHeaders: subHdr, subtitles: subs }]
            };
            return JSON.stringify(out);
        }

        if (mode === "dash" && p.audio) {
            var mpd = blDashLink(blMpd(p.video, p.audio));
            out = {
                stream: mpd, subtitles: subs, headers: hdr, subtitleHeaders: subHdr,
                streams: [{ title: title, streamUrl: mpd, headers: hdr, subtitleHeaders: subHdr, subtitles: subs }]
            };
            return JSON.stringify(out);
        }

        var audioTrack = null;
        if (p.audio) {
            audioTrack = { url: p.audio.url, file: p.audio.url, src: p.audio.url, title: "Audio", name: "Audio", label: "Audio",
                language: "und", lang: "und", headers: hdr, default: true };
        }
        out = {
            stream: p.video.url,
            subtitles: subs,
            headers: hdr,
            subtitleHeaders: subHdr
        };
        if (audioTrack) {
            out.audio = p.audio.url;
            out.audioUrl = p.audio.url;
            out.audio_url = p.audio.url;
            out.audioTracks = [audioTrack];
            out.audios = [audioTrack];
            out.externalAudioTracks = [audioTrack];
            out.audioHeaders = hdr;
        }
        var entry = { title: title, streamUrl: p.video.url, headers: hdr, subtitleHeaders: subHdr, subtitles: subs };
        if (audioTrack) {
            entry.audio = p.audio.url;
            entry.audioUrl = p.audio.url;
            entry.audioTracks = [audioTrack];
            entry.externalAudioTracks = [audioTrack];
        }
        out.streams = [entry];
        return JSON.stringify(out);
    } catch (e) {
        return JSON.stringify({
            stream: null, subtitles: [],
            error: "bilibili v" + BL_VERSION + ": " + ((e && e.message) || e)
        });
    }
}

// ------------------------------------------------------------- diagnostics -
function blDiagRow(lines) {
    return JSON.stringify([{
        title: "Bilibili diagnostic - tap to read all " + lines.length + " lines. " + (lines[0] || ""),
        image: "",
        href: BL_WEB + "/?bl-diag=" + encodeURIComponent(lines.join("\n"))
    }]);
}

function blShort(u) {
    u = String(u || "");
    var m = u.match(/^(https?:\/\/[^\/?#]+)(\/[^?#]*)?/);
    if (!m) return u.slice(0, 80);
    var path = m[2] || "";
    return m[1] + (path.length > 60 ? "..." + path.slice(-45) : path) + (u.indexOf("?") >= 0 ? "?..." : "");
}

async function blCommand(cmd, arg) {
    var lines = [];
    try {
        if (cmd === "debug") {
            lines.push("Bilibili module v" + BL_VERSION + " is running (audio mode: " + blMode() + (BL_RELAY ? ", relay set" : ", no relay") + ", max quality " + BL_MAX_QUALITY + ")");
            try {
                var j = await blJson("/v2/search_v2?keyword=naruto&platform=web&pn=1&ps=30&s_locale=en_US");
                var mods = (j.data && j.data.modules) || [], n = 0, i;
                var kinds = [];
                for (i = 0; i < mods.length; i++) { n += (mods[i].items || []).length; kinds.push(mods[i].type + ":" + (mods[i].items || []).length); }
                lines.push("search 'naruto': " + mods.length + " groups, " + n + " items [" + kinds.join(", ") + "]");
                if (mods[0] && mods[0].items && mods[0].items[0]) lines.push("first item keys: " + Object.keys(mods[0].items[0]).join(","));
            } catch (e) { lines.push("search failed: " + ((e && e.message) || e)); }
            try {
                var p = await blPlay({ type: "ugc", aid: "4801666396986368" });
                lines.push("playurl ok: " + p.videos.length + " video file(s), " + p.audios.length + " audio file(s); " + p.notes.join("; "));
            } catch (e2) { lines.push("playurl failed: " + ((e2 && e2.message) || e2)); }
            return blDiagRow(lines);
        }

        if (cmd === "relay") {
            if (!BL_RELAY) { lines.push("BL_RELAY is empty in bilibili.js - fill in your relay address first"); return blDiagRow(lines); }
            var base = String(BL_RELAY).replace(/\/+$/, "");
            var hr = await fetchv2(base + "/", {});
            var ht = String(await hr.text());
            lines.push("relay answered: HTTP " + hr.status + " " + ht.slice(0, 80));
            var tp = await blPlay(arg ? await blResolve(arg) : { type: "ugc", aid: "4801666396986368" });
            lines.push("test video: " + tp.video.desc + " " + tp.video.codecs + (tp.audio ? ", audio " + tp.audio.codecs : ", NO audio file"));
            var master = blRelayMaster(tp.video, tp.audio);
            var mr = await fetchv2(master, {});
            var mt = String(await mr.text());
            lines.push("master playlist: HTTP " + mr.status + ", " + mt.split("\n").length + " lines");
            var tm = mt.match(/https?:\/\/[^\s"]+\/track\.m3u8\?u=[^\s"]+/g) || [];
            for (var t = 0; t < tm.length; t++) {
                var tr2 = await fetchv2(tm[t], {});
                var tt = String(await tr2.text());
                var segs = (tt.match(/#EXTINF/g) || []).length;
                lines.push("track " + (t + 1) + ": HTTP " + tr2.status + (tr2.status === 200 ? ", " + segs + " segments" : " -> " + tt.slice(0, 160)));
            }
            lines.push(mt.length < 20 ? "master empty" : "relay looks " + (tm.length && lines.join(" ").indexOf("HTTP 200, ") > -1 ? "OK" : "broken - read the lines above"));
            return blDiagRow(lines);
        }

        if (cmd === "raw") {
            var path = arg.indexOf("/") === 0 ? arg : "/" + arg;
            var text = await blGet(BL_API + path);
            lines.push("GET " + path.slice(0, 120) + " -> " + text.length + " chars");
            var pos = 0;
            while (pos < text.length && lines.length < 40) { lines.push(text.slice(pos, pos + 180)); pos += 180; }
            return blDiagRow(lines);
        }

        if (cmd === "play" || cmd === "sub") {
            var id = await blResolve(arg);
            lines.push("id: " + JSON.stringify(id));
            if (cmd === "sub") {
                var tr = await blSubs(id);
                lines.push(tr.length + " subtitle track(s)");
                for (var s = 0; s < tr.length; s++) lines.push(tr[s].label + " -> " + (blShort(tr[s].url)));
                return blDiagRow(lines);
            }
            var pl = await blPlay(id);
            lines.push("api: " + pl.notes.join("; "));
            lines.push("picked video: q=" + pl.video.q + " " + pl.video.desc + " " + pl.video.codecs + " " + pl.video.w + "x" + pl.video.h + " " + blShort(pl.video.url));
            lines.push(pl.audio ? "picked audio: bw=" + pl.audio.bw + " " + pl.audio.codecs + " " + blShort(pl.audio.url) : "no separate audio file in the response");
            var k;
            for (k = 0; k < pl.videos.length; k++) lines.push("video[" + k + "] q=" + pl.videos[k].q + " " + pl.videos[k].codecs + " " + pl.videos[k].w + "x" + pl.videos[k].h);
            for (k = 0; k < pl.audios.length; k++) lines.push("audio[" + k + "] bw=" + pl.audios[k].bw + " " + pl.audios[k].codecs);
            return blDiagRow(lines);
        }
    } catch (e3) {
        lines.push("failed: " + ((e3 && e3.message) || e3));
    }
    return blDiagRow(lines.length ? lines : ["nothing to show"]);
}