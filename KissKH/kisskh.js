// KissKH module for Sora (asyncJS + softsub mode)
// Docs: https://soradocs.readthedocs.io/en/latest/

const BASE = "https://kisskh.co";

const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Referer": BASE + "/",
    "Accept": "application/json, text/plain, */*"
};

// ---------------------------------------------------------------------------
// kkey token
// ---------------------------------------------------------------------------
// kisskh now requires a per-episode `kkey` token on the stream and subtitle
// endpoints. The site's own JS builds it (AES based, from the episode id plus
// GUID / version constants found in its JS chunks). Sora's JavaScriptCore
// sandbox has no crypto API, so this module cannot derive it by itself.
//
// Fill this in one of two ways:
//   1. Set KKEY_SERVICE to a URL you host that returns {"key": "..."} for
//      ?id=<episodeId>&type=<"vi"|"sub">
//   2. Implement the algorithm directly inside getKKey() in pure JS.
// Until then the module sends an empty kkey, which only works if the site
// is not enforcing it.
const KKEY_SERVICE = "";

async function getKKey(episodeId, kind) {
    if (!KKEY_SERVICE) return "";
    try {
        const res = await fetchv2(
            `${KKEY_SERVICE}?id=${encodeURIComponent(episodeId)}&type=${kind}`,
            HEADERS
        );
        const data = await res.json();
        return (data && data.key) ? String(data.key) : "";
    } catch (e) {
        console.log("kkey error: " + e);
        return "";
    }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// searchResults(keyword) -> JSON string of [{title, image, href}]
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// extractDetails(url) -> JSON string of [{description, aliases, airdate}]
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// extractEpisodes(url) -> JSON string of [{href, number}]
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// extractStreamUrl(url) -> JSON string {stream, subtitles}   (softsub mode)
// ---------------------------------------------------------------------------
function pickSubtitle(subs) {
    if (!Array.isArray(subs)) return null;

    // Encrypted subtitle files use these extensions; Sora can't decrypt them.
    const isEncrypted = s => /\.(txt1?|srt1|vtt1)(\?|$)/i.test(s.src || "");
    const usable = subs.filter(s => s && s.src && !isEncrypted(s));

    const isEnglish = s => /^en/i.test(s.land || "") || /english/i.test(s.label || "");
    const english = usable.find(isEnglish);
    return (english || usable[0] || {}).src || null;
}

async function extractStreamUrl(url) {
    try {
        const epId = queryParam(url, "ep");
        if (!epId) throw new Error("No episode id in url");

        const [viKey, subKey] = await Promise.all([
            getKKey(epId, "vi"),
            getKKey(epId, "sub")
        ]);

        const streamData = await getJson(
            `${BASE}/api/DramaList/Episode/${epId}.png?err=false&ts=&time=&kkey=${encodeURIComponent(viKey)}`
        );
        const stream = streamData.Video || streamData.video || streamData.ThirdParty || null;

        let subtitles = null;
        try {
            const subData = await getJson(
                `${BASE}/api/Sub/${epId}?kkey=${encodeURIComponent(subKey)}`
            );
            subtitles = pickSubtitle(subData);
        } catch (e) {
            console.log("Subtitle error: " + e);
        }

        return JSON.stringify({ stream: stream, subtitles: subtitles });
    } catch (error) {
        console.log("Stream error: " + error);
        return JSON.stringify({ stream: null, subtitles: null });
    }
}
