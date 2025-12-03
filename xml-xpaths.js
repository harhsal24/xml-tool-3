const fs = require("fs");
const xpath = require("xpath");
const { DOMParser } = require("@xmldom/xmldom");

let DEBUG = false;
function log(...args) {
    if (DEBUG) console.log("[DEBUG]", ...args);
}

// read files
function loadXML(p) {
    return new DOMParser().parseFromString(
        fs.readFileSync(p, "utf8"),
        "text/xml"
    );
}
function loadConfig(p) {
    return JSON.parse(fs.readFileSync(p, "utf8"));
}

/* ───────────────────────────────────────────────
   1. Count index of same-tag siblings
─────────────────────────────────────────────────*/
function getSiblingIndex(node) {
    let i = 1;
    let s = node.previousSibling;
    while (s) {
        if (s.nodeType === 1 && s.nodeName === node.nodeName) i++;
        s = s.previousSibling;
    }
    return i;
}

/* ───────────────────────────────────────────────
   2. Trim whole XPath until startAtTag
─────────────────────────────────────────────────*/
function trimStart(tag, xp) {
    const needle = `/d:${tag}`;
    const i = xp.indexOf(needle);
    if (i === -1) return xp;
    return xp.slice(i);
}

/* ───────────────────────────────────────────────
   3. Build xpath for any element
─────────────────────────────────────────────────*/
function buildPathForElement(node, cfg) {
    if (!node || node.nodeType !== 1) return "";

    const name = node.nodeName;
    let segment = `/d:${name}`;

    // --- optional element-based filters ---
    const filters = [];

    // loop attributes
    if (node.attributes) {
        for (let a of node.attributes) {
            const key = a.name;
            if (cfg.attributesToIncludeInPath.includes(key)) {
                filters.push(`d:${key}="${a.value}"`);
            }
        }
    }

    // add index always
    const index = getSiblingIndex(node);
    if (filters.length > 0) {
        segment += `[${filters.join(" and ")}][${index}]`;
    } else {
        segment += `[${index}]`;
    }

    // reach root
    if (!node.parentNode || node.parentNode.nodeName === "#document")
        return segment;

    return buildPathForElement(node.parentNode, cfg) + segment;
}

/* ───────────────────────────────────────────────
   4. Collect leaf values
─────────────────────────────────────────────────*/
function collectLeaves(doc, cfg) {
    const textNodes = xpath.select("//*[text()]", doc);
    const list = [];

    for (const t of textNodes) {
        const parent = t.parentNode;
        if (!parent) continue;

        const tag = parent.nodeName;
        if (cfg.ignoreLeafNodes.includes(tag)) {
            log("Ignoring leaf:", tag);
            continue;
        }

        let xp = buildPathForElement(parent, cfg);

        if (cfg.startAtTag) xp = trimStart(cfg.startAtTag, xp);

        list.push({
            text: t.nodeValue.trim(),
            xpath: xp,
        });
    }

    return list;
}

/* ───────────────────────────────────────────────
   5. Main
─────────────────────────────────────────────────*/
function main(xmlFile, cfgFile, debugMode) {
    const cfg = loadConfig(cfgFile);
    const doc = loadXML(xmlFile);
    DEBUG = debugMode;

    log("CONFIG:", cfg);

    const rows = collectLeaves(doc, cfg);

    for (const r of rows) {
        console.log(`${r.text} : ${r.xpath}`);
    }
}

/* CLI */
const xmlFile = process.argv[2];
const cfgFile = process.argv[3];
const debugMode = process.argv.includes("--debug");

main(xmlFile, cfgFile, debugMode);
