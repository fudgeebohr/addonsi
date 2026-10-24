// KissKH module for Sora / MiruShin (asyncJS + softsub mode)
// Docs: https://soradocs.readthedocs.io/en/latest/

const BASE = "https://kisskh.co";

const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Referer": BASE + "/",
    "Accept": "application/json, text/plain, */*"
};

// ===========================================================================
// kkey token generator
// ===========================================================================
// kisskh requires a per-episode `kkey` on the stream and subtitle endpoints.
// This is a plain-JS port of the site's own generator (AES-128-CBC with a
// fixed key and IV over a "|"-joined string). It needs no crypto API, so it
// runs inside Sora's JavaScriptCore.
//
// The constants below are copied from the site's player code. If kisskh bumps
// them the module re-reads them from the live site (see discoverConfig), and
// falls back to these values otherwise.
const KK_DEFAULTS = {
    appVer: "2.8.10",
    platformVer: 4830201,
    appName: "kisskh",
    viGuid: "62f176f3bb1b5b8e70e39932ad34a0c7",
    subGuid: "VgV52sWhwvBSf8BsM3BRY9weWiiCbtGp"
};

const KK_MARKER = "mg3c3b04ba";
const KK_IV = [0x1504af3, 0x56e619cf, 0x2e42bba6, -0x73c08f07];
const KK_ROUND_KEYS = [0x4f6bdaa3,-0x61d07350,0x7f5e722d,-0x61210cec,0x536620a8,-0x32b653e8,-0x4de821cb,0x2cc92d21,-0x73412227,0x41f771c1,-0xc1f500c,-0x20d67d2b,0x2dadde47,0x6c5aaf86,-0x6045ff8e,0x409382a7,-0x6417db2,-0x6a1bd238,0xa5e2dba,0x4acdaf1d,0x54c72698,-0x3edcf4b0,-0x3482d916,-0x7e4f7609,-0x6c9fb16c,0x524345c4,-0x66c19cd2,0x188eead9,-0x351884c7,-0x675bc103,0x19a5dd3,0x1914b70a,-0x4fb1e313,0x28ea2210,0x29707fc3,0x3064c8c9,-0x17593e17,-0x3fb31c07,-0x16c363c6,-0x26a7ab0d,-0x4b793324,0x74ca2f25,-0x62094ce1,0x44aee7ec];

const KK_TABLES = (function () {
    const t0 = [], t1 = [], t2 = [], t3 = [], sbox = [], dbl = [];
    for (let i = 0; i < 256; i++) dbl[i] = i < 128 ? i << 1 : (i << 1) ^ 0x11b;
    let x = 0, xi = 0;
    for (let i = 0; i < 256; i++) {
        let s = xi ^ (xi << 1) ^ (xi << 2) ^ (xi << 3) ^ (xi << 4);
        s = (s >>> 8) ^ (s & 0xff) ^ 0x63;
        sbox[x] = s;
        const x2 = dbl[x];
        const x8 = dbl[dbl[x2]];
        const t = 0x101 * dbl[s] ^ 0x1010100 * s;
        t0[x] = (t << 24) | (t >>> 8);
        t1[x] = (t << 16) | (t >>> 16);
        t2[x] = (t << 8) | (t >>> 24);
        t3[x] = t;
        if (x) {
            x = x2 ^ dbl[dbl[dbl[x8 ^ x2]]];
            xi ^= dbl[dbl[xi]];
        } else {
            x = xi = 1;
        }
    }
    return { t0: t0, t1: t1, t2: t2, t3: t3, sbox: sbox };
})();

function kkTrunc(s) {
    return String(s == null ? "" : s).substring(0, 48);
}

function kkHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h << 5) - h + str.charCodeAt(i);
    return h;
}

function kkPad(str) {
    const n = 16 - (str.length % 16);
    for (let i = 0; i < n; i++) str += String.fromCharCode(n);
    return str;
}

function kkToWords(str) {
    const w = [];
    for (let i = 0; i < str.length; i++) {
        w[i >>> 2] |= (str.charCodeAt(i) & 0xff) << (24 - (i % 4) * 8);
    }
    return w;
}

function kkEncryptBlock(w, off) {
    const t0 = KK_TABLES.t0, t1 = KK_TABLES.t1, t2 = KK_TABLES.t2, t3 = KK_TABLES.t3;
    const sb = KK_TABLES.sbox, rk = KK_ROUND_KEYS;

    const prev = off === 0 ? KK_IV : w.slice(off - 4, off);
    for (let i = 0; i < 4; i++) w[off + i] ^= prev[i];

    let s0 = w[off] ^ rk[0], s1 = w[off + 1] ^ rk[1], s2 = w[off + 2] ^ rk[2], s3 = w[off + 3] ^ rk[3];
    let k = 4;
    for (let r = 1; r < 10; r++) {
        const n0 = t0[s0 >>> 24] ^ t1[(s1 >>> 16) & 255] ^ t2[(s2 >>> 8) & 255] ^ t3[s3 & 255] ^ rk[k++];
        const n1 = t0[s1 >>> 24] ^ t1[(s2 >>> 16) & 255] ^ t2[(s3 >>> 8) & 255] ^ t3[s0 & 255] ^ rk[k++];
        const n2 = t0[s2 >>> 24] ^ t1[(s3 >>> 16) & 255] ^ t2[(s0 >>> 8) & 255] ^ t3[s1 & 255] ^ rk[k++];
        const n3 = t0[s3 >>> 24] ^ t1[(s0 >>> 16) & 255] ^ t2[(s1 >>> 8) & 255] ^ t3[s2 & 255] ^ rk[k++];
        s0 = n0; s1 = n1; s2 = n2; s3 = n3;
    }
    w[off]     = ((sb[s0 >>> 24] << 24) | (sb[(s1 >>> 16) & 255] << 16) | (sb[(s2 >>> 8) & 255] << 8) | sb[s3 & 255]) ^ rk[k++];
    w[off + 1] = ((sb[s1 >>> 24] << 24) | (sb[(s2 >>> 16) & 255] << 16) | (sb[(s3 >>> 8) & 255] << 8) | sb[s0 & 255]) ^ rk[k++];
    w[off + 2] = ((sb[s2 >>> 24] << 24) | (sb[(s3 >>> 16) & 255] << 16) | (sb[(s0 >>> 8) & 255] << 8) | sb[s1 & 255]) ^ rk[k++];
    w[off + 3] = ((sb[s3 >>> 24] << 24) | (sb[(s0 >>> 16) & 255] << 16) | (sb[(s1 >>> 8) & 255] << 8) | sb[s2 & 255]) ^ rk[k++];
}

function kkEncryptToHex(plain) {
    const padded = kkPad(plain);
    const words = kkToWords(padded);
    for (let off = 0; off < words.length; off += 4) kkEncryptBlock(words, off);
    let hex = "";
    for (let i = 0; i < padded.length; i++) {
        const b = (words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
        hex += ("0" + b.toString(16)).slice(-2);
    }
    return hex.toUpperCase();
}

// Same inputs the site passes to cryptoService.key(): the episode id plus the
// video GUID (stream) or subtitle GUID (subs).
function makeKKey(episodeId, guid, cfg) {
    const name = cfg.appName;
    const fields = [
        "", episodeId, null, KK_MARKER, cfg.appVer, guid, cfg.platformVer,
        kkTrunc(name), kkTrunc(String(name).toLowerCase()), kkTrunc(name),
        name, name, name, "00", ""
    ];
    fields.splice(1, 0, kkHash(fields.join("|")));
    return kkEncryptToHex(fields.join("|"));
}

// Re-read the constants from the live site, in case kisskh changed them.
// Returns null if anything can't be found.
async function discoverConfig() {
    try {
        const html = await (await fetchv2(BASE + "/", HEADERS)).text();
        const rt = html.match(/runtime\.[0-9a-f]+\.js/);
        if (!rt) return null;

        const runtime = await (await fetchv2(`${BASE}/${rt[0]}`, HEADERS)).text();
        const re = /(\d+):"([0-9a-f]{8,})"/g;
        const chunks = [];
        let m;
        while ((m = re.exec(runtime)) !== null) chunks.push(m[1] + "." + m[2] + ".js");

        for (let i = 0; i < chunks.length && i < 20; i++) {
            const text = await (await fetchv2(`${BASE}/${chunks[i]}`, HEADERS)).text();
            const vi = text.match(/this\.viGuid="([^"]+)"/);
            const sub = text.match(/this\.subGuid="([^"]+)"/);
            const ver = text.match(/this\.appVer="([^"]+)"/);
            const plat = text.match(/this\.platformVer=(\d+)/);
            if (vi && sub && ver && plat) {
                const name = text.match(/this\.appName="([^"]+)"/);
                return {
                    viGuid: vi[1],
                    subGuid: sub[1],
                    appVer: ver[1],
                    platformVer: parseInt(plat[1], 10),
                    appName: name ? name[1] : KK_DEFAULTS.appName
                };
            }
        }
    } catch (e) {
        console.log("discoverConfig error: " + e);
    }
    return null;
}

// ===========================================================================
// helpers
// ===========================================================================
async function getJson(url) {
    const res = await fetchv2(url, HEADERS);
    return await res.json();
}

function slugify(title) {
    return String(title || "")
        .replace(/[^A-Za-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "Drama";
}

function queryParam(url, name) {
    const m = String(url).match(new RegExp("[?&]" + name + "=([^&#]+)"));
    return m ? decodeURIComponent(m[1]) : null;
}

function dramaUrl(id, title) {
    return `${BASE}/Drama/${slugify(title)}?id=${id}`;
}

function episodeUrl(dramaId, title, number, epId) {
    return `${BASE}/Drama/${slugify(title)}/Episode-${number}?id=${dramaId}&ep=${epId}`;
}

// ===========================================================================
// searchResults(keyword) -> JSON string of [{title, image, href}]
// ===========================================================================
async function searchResults(keyword) {
    try {
        const data = await getJson(
            `${BASE}/api/DramaList/Search?q=${encodeURIComponent(keyword)}&type=0`
        );
        const list = Array.isArray(data) ? data : (data && data.data) || [];

        const results = list
            .filter(item => item && item.id)
            .map(item => ({
                title: item.title || "Untitled",
                image: item.thumbnail || "",
                href: dramaUrl(item.id, item.title)
            }));

        return JSON.stringify(results);
    } catch (error) {
        console.log("Search error: " + error);
        return JSON.stringify([{ title: "Error", image: "", href: "" }]);
    }
}

// ===========================================================================
// extractDetails(url) -> JSON string of [{description, aliases, airdate}]
// ===========================================================================
async function extractDetails(url) {
    try {
        const id = queryParam(url, "id");
        const data = await getJson(`${BASE}/api/DramaList/Drama/${id}?isq=false`);

        const aliasParts = [];
        if (data.country) aliasParts.push(data.country);
        if (data.type) aliasParts.push(data.type);
        if (data.status) aliasParts.push(data.status);

        const year = data.releaseDate ? String(data.releaseDate).split("-")[0] : "Unknown";

        return JSON.stringify([{
            description: (data.description || "No description available")
                .replace(/<[^>]*>/g, "").trim(),
            aliases: aliasParts.length ? aliasParts.join(" | ") : "N/A",
            airdate: `Aired: ${year}`
        }]);
    } catch (error) {
        console.log("Details error: " + error);
        return JSON.stringify([{
            description: "Error loading description",
            aliases: "N/A",
            airdate: "Aired: Unknown"
        }]);
    }
}

// ===========================================================================
// extractEpisodes(url) -> JSON string of [{href, number}]
// ===========================================================================
async function extractEpisodes(url) {
    try {
        const id = queryParam(url, "id");
        const data = await getJson(`${BASE}/api/DramaList/Drama/${id}?isq=false`);

        const episodes = (data.episodes || [])
            .filter(ep => ep && ep.id)
            .map(ep => ({
                href: episodeUrl(id, data.title, ep.number, ep.id),
                number: ep.number
            }))
            .sort((a, b) => Number(a.number) - Number(b.number));

        return JSON.stringify(episodes);
    } catch (error) {
        console.log("Episodes error: " + error);
        return JSON.stringify([]);
    }
}

// ===========================================================================
// extractStreamUrl(url) -> JSON string {stream, subtitles}   (softsub mode)
// ===========================================================================
function pickSubtitle(subs) {
    if (!Array.isArray(subs)) return null;

    // Files with these extensions are encrypted by the site; Sora can't read them.
    const isEncrypted = s => /\.(txt1?|srt1|vtt1)(\?|$)/i.test(s.src || "");
    const usable = subs.filter(s => s && s.src && !isEncrypted(s));

    const isEnglish = s => /^en/i.test(s.land || "") || /english/i.test(s.label || "");
    const english = usable.find(isEnglish);
    return (english || usable[0] || {}).src || null;
}

async function requestStream(epId, cfg) {
    const viKey = makeKKey(epId, cfg.viGuid, cfg);
    try {
        const data = await getJson(
            `${BASE}/api/DramaList/Episode/${epId}.png?err=false&ts=null&time=null&kkey=${viKey}`
        );
        return data.Video || data.video || data.ThirdParty || null;
    } catch (e) {
        console.log("Stream request error: " + e);
        return null;
    }
}

async function requestSubtitle(epId, cfg) {
    const subKey = makeKKey(epId, cfg.subGuid, cfg);
    try {
        return pickSubtitle(await getJson(`${BASE}/api/Sub/${epId}?kkey=${subKey}`));
    } catch (e) {
        console.log("Subtitle request error: " + e);
        return null;
    }
}

async function extractStreamUrl(url) {
    try {
        const epId = queryParam(url, "ep");
        if (!epId) throw new Error("No episode id in url");

        let cfg = KK_DEFAULTS;
        let stream = await requestStream(epId, cfg);

        // No stream: kisskh may have changed its constants. Re-read them once.
        if (!stream) {
            const fresh = await discoverConfig();
            if (fresh && JSON.stringify(fresh) !== JSON.stringify(KK_DEFAULTS)) {
                cfg = fresh;
                stream = await requestStream(epId, cfg);
            }
        }

        const subtitles = stream ? await requestSubtitle(epId, cfg) : null;
        return JSON.stringify({ stream: stream, subtitles: subtitles });
    } catch (error) {
        console.log("Stream error: " + error);
        return JSON.stringify({ stream: null, subtitles: null });
    }
}