const { z } = require('zod');
const { DAMAGE_KEYWORDS, SALE_TYPE_KEYWORDS } = require('../constants/keywords');
const fs = require("fs").promises;
const axios = require("axios");
const { HttpProxyAgent } = require("http-proxy-agent");
const { HttpsProxyAgent } = require("https-proxy-agent");

async function runWithConcurrency(items, limit, worker) {
    const results = [];
    let i = 0;
    const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
        while (true) {
            const idx = i++;
            if (idx >= items.length) break;
            try {
                const result = await worker(items[idx], idx);
                if (result !== undefined && result !== null) {
                    results.push(result);
                }
            } catch (error) {
                console.error(`Error processing item ${idx}:`, error);
                // Continue processing other items
            }
        }
    });
    await Promise.all(runners);
    return results;
}

const DAMAGE_CANON = DAMAGE_KEYWORDS.map(k => k.toLowerCase());
const SALE_CANON = SALE_TYPE_KEYWORDS.map(k => k.toLowerCase());

function processSourcesToTags(sources) {
    if (!sources || !Array.isArray(sources) || sources.length === 0) {
        return { damage_tags: [], saletype_tags: [] };
    }

    const damage_tags = [];
    const saletype_tags = [];

    for (const source of sources) {
        const sourceLower = source.toLowerCase().trim();

        if (!sourceLower) continue;

        if (SALE_CANON.includes(sourceLower)) {
            if (!saletype_tags.includes(sourceLower)) {
                saletype_tags.push(sourceLower);
            }
        } else {
            for (const damageKeyword of DAMAGE_CANON) {
                if (sourceLower === damageKeyword ||
                    sourceLower.includes(damageKeyword) ||
                    damageKeyword.includes(sourceLower)) {
                    if (!damage_tags.includes(damageKeyword)) {
                        damage_tags.push(damageKeyword);
                    }
                }
            }
        }
    }

    return {
        damage_tags: damage_tags,
        saletype_tags: saletype_tags
    };
}


let getLLM;
{
    let llmSingleton = null;
    getLLM = async () => {
        if (!llmSingleton) {
            const { ChatOpenAI } = await import('@langchain/openai');
            llmSingleton = new ChatOpenAI({
                model: process.env.OPENAI_MODEL || "gpt-4o-mini",
                apiKey: process.env.OPENAI_API_KEY || "",
                temperature: 0
            });
        }
        return llmSingleton;
    };
}

function heuristicTags(description) {
    const t = (description || "").toLowerCase();
    const damage = DAMAGE_CANON.filter(k => t.includes(k));
    const sale = SALE_CANON.filter(k => t.includes(k));
    // handle "tlc" variants (normalize)
    if (/\bneeds\s+tlc\b/i.test(description) && !damage.includes("tlc")) damage.push("tlc");
    if (/\bneeds\s+tlc\b/i.test(description) && !sale.includes("needs tlc")) sale.push("needs tlc");
    return {
        damage_tags: Array.from(new Set(damage)),
        saletype_tags: Array.from(new Set(sale)),
    };
}

const ResultSchema = z.object({
    damage: z.array(z.enum(DAMAGE_CANON)),
    sale_types: z.array(z.enum(SALE_CANON)),
    rationale: z.string(),
});

async function llmTags(description) {
    const prompt = [
        { role: "system", content: "Tag real-estate descriptions with exact allowed lowercase keywords only. Prefer high precision." },
        {
            role: "user",
            content: [
                "ALLOWED DAMAGE:",
                ...DAMAGE_CANON.map(k => `- ${k}`),
                "",
                "ALLOWED SALE TYPES:",
                ...SALE_CANON.map(k => `- ${k}`),
                "",
                "OUTPUT JSON with fields: damage[], sale_types[], rationale",
                "DESCRIPTION:",
                description,
            ].join("\n"),
        },
    ];
    const llm = await getLLM();
    const out = await llm.withStructuredOutput(ResultSchema).invoke(prompt);
    const uniq = a => Array.from(new Set(a));
    return {
        damage_tags: uniq(out.damage),
        saletype_tags: uniq(out.sale_types),
        recommendation: out.rationale,
    };
}

async function tagListing(item) {
    const text = item.description || "";
    if (!text.trim()) return { ...item, damage_tags: [], saletype_tags: [], recommendation: "No description." };

    if (!process.env.OPENAI_API_KEY) {
        // heuristic only
        const h = heuristicTags(text);
        return { ...item, ...h, recommendation: "Heuristic tags (no LLM key provided)." };
    }

    try {
        const res = await llmTags(text);
        // merge in any obvious heuristics that LLM might miss (optional)
        const h = heuristicTags(text);
        return {
            ...item,
            damage_tags: Array.from(new Set([...res.damage_tags, ...h.damage_tags])),
            saletype_tags: Array.from(new Set([...res.saletype_tags, ...h.saletype_tags])),
            recommendation: res.recommendation || "LLM tags",
        };
    } catch (e) {
        console.warn("LLM tagging failed; falling back to heuristic:", (e?.message));
        const h = heuristicTags(text);
        return { ...item, ...h, recommendation: "" };
    }
}

async function autoScroll(page, { step = 1000, pauseMs = 600, maxSteps = 15 } = {}) {
    for (let i = 0; i < maxSteps; i++) {
        await page.evaluate(s => window.scrollBy(0, s), step);
        await page.waitForTimeout(pauseMs);
    }
}

function cleanNum(text) {
    if (!text) return null;
    const m = /[\d.]+/.exec(text.replace(/,/g, ""));
    if (!m) return null;
    const val = Number(m[0]);
    return Number.isFinite(val) ? Math.trunc(val) : null;
}

function joinUrl(base, href) {
    if (!href) return "";
    if (/^https?:\/\//i.test(href)) return href;
    return `${base.replace(/\/$/, "")}/${href.replace(/^\//, "")}`;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseProxy(ipaddress, port, username, password) {
    const u = encodeURIComponent(username);
    const p = encodeURIComponent(password);
    return `http://${u}:${p}@${ipaddress}:${port}`;
}

function getRandomProxyPort() {
    return 10105;
    const min = Number(process.env.PROXY_PORT_MIN);
    const max = Number(process.env.PROXY_PORT_MAX);
    const randomPort = Math.floor(Math.random() * (max - min + 1)) + min;
    console.log(`Using random proxy port: ${randomPort}`);
    return randomPort.toString();
}

function getRandomProxyUrl() {
    const port = getRandomProxyPort();
    return parseProxy(process.env.PROXY_IP_ADDRESS, 10110, process.env.PROXY_USERNAME, process.env.PROXY_PASSWORD);
}

function proxy_client(proxyUrl) {
    if (!proxyUrl) {
        proxyUrl = getRandomProxyUrl();
    }
    const httpAgent = new HttpProxyAgent(proxyUrl);
    const httpsAgent = new HttpsProxyAgent(proxyUrl);
    return axios.create({
        httpAgent,
        httpsAgent,
        proxy: false, // use agents instead of axios' proxy option
        timeout: 30000,
        validateStatus: (s) => s >= 200 && s < 400,
    });
}


module.exports = {
    runWithConcurrency,
    processSourcesToTags,
    heuristicTags,
    llmTags,
    tagListing,
    autoScroll,
    cleanNum,
    joinUrl,
    proxy_client,
    parseProxy,
    delay
}
