// xml-xpaths.js
const fs = require("fs");
const path = require("path");
const xpath = require("xpath");
const { DOMParser } = require("@xmldom/xmldom");

let DEBUG = false;
function log(...args) {
    if (DEBUG) console.log("[DEBUG]", ...args);
}

function fileExists(p) {
    try {
        return fs.statSync(p).isFile();
    } catch (e) {
        return false;
    }
}

function loadXML(p) {
    const xml = fs.readFileSync(p, "utf8");
    return new DOMParser().parseFromString(xml, "text/xml");
}
function loadConfig(p) {
    return JSON.parse(fs.readFileSync(p, "utf8"));
}

/* 1. Count index of same-tag siblings */
function getSiblingIndex(node) {
    let i = 1;
    let s = node.previousSibling;
    while (s) {
        if (s.nodeType === 1 && s.nodeName === node.nodeName) i++;
        s = s.previousSibling;
    }
    return i;
}

/* 2. Trim whole XPath until startAtTag */
function trimStart(tag, xp) {
    if (!tag) return xp;
    const needle = `/d:${tag}`;
    const i = xp.indexOf(needle);
    if (i === -1) return xp;
    return xp.slice(i);
}

/* Escape for XPath predicate (double " for XPath literals) */
function esc(v) {
    if (v == null) return "";
    return String(v).replace(/"/g, '""');
}

/* Helper: get first child element by name (case-sensitive) */
function getFirstChildElementByName(node, name) {
    for (let c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 1 && c.nodeName === name) return c;
    }
    return null;
}

/* 3. Build xpath for any element
   - attr predicates come from cfg.attributesToIncludeInPath (used to build the xpath, not output)
   - child predicates come from cfg.childFilters (if provided)
*/
function buildPathForElement(node, cfg) {
    if (!node || node.nodeType !== 1) return "";

    const name = node.nodeName;
    let segment = `/d:${name}`;

    const attrFilters = [];
    const childFilters = [];

    // attribute predicates (separate bracket)
    if (node.attributes && node.attributes.length && cfg.attributesToIncludeInPath) {
        for (let i = 0; i < node.attributes.length; i++) {
            const a = node.attributes.item(i);
            if (cfg.attributesToIncludeInPath.includes(a.name)) {
                attrFilters.push(`@${a.name}="${esc(a.value)}"`);
            }
        }
    }

    // child-value predicates (from cfg.childFilters array)
    if (cfg.childFilters && Array.isArray(cfg.childFilters) && cfg.childFilters.length) {
        for (const childName of cfg.childFilters) {
            const childEl = getFirstChildElementByName(node, childName);
            if (childEl) {
                const txtRaw = (childEl.textContent || "").trim();
                if (txtRaw && !(cfg.ignoreLeafNodes || []).includes(childEl.nodeName)) {
                    childFilters.push(`d:${childEl.nodeName}="${esc(txtRaw)}"`);
                    continue;
                }
            }
            // fallback to attribute with same name
            if (node.attributes && node.attributes.length) {
                for (let i = 0; i < node.attributes.length; i++) {
                    const a = node.attributes.item(i);
                    if (a.name === childName) {
                        childFilters.push(`@${a.name}="${esc(a.value)}"`);
                        break;
                    }
                }
            }
        }
    } else if (cfg.includeLeafValuePredicate) {
        // legacy: include all child element text predicates
        for (let c = node.firstChild; c; c = c.nextSibling) {
            if (c.nodeType === 1) {
                const txt = (c.textContent || "").trim();
                if (txt && !(cfg.ignoreLeafNodes || []).includes(c.nodeName)) {
                    childFilters.push(`d:${c.nodeName}="${esc(txt)}"`);
                }
            }
        }
    }

    if (attrFilters.length) segment += `[${attrFilters.join(" and ")}]`;
    if (childFilters.length) segment += `[${childFilters.join(" and ")}]`;

    // always include sibling index
    const index = getSiblingIndex(node);
    segment += `[${index}]`;

    // reach root?
    if (!node.parentNode || node.parentNode.nodeName === "#document") {
        return segment;
    }

    return buildPathForElement(node.parentNode, cfg) + segment;
}

/* 4. Collect only element text leaf rows (no attribute rows) */
function collectLeafRows(doc, cfg) {
    const rows = [];

    const allElements = xpath.select("//*", doc); // document order

    for (const el of allElements) {
        if (!el || el.nodeType !== 1) continue;

        // Only consider leaf elements: elements with NO child element nodes
        let hasChildElement = false;
        for (let c = el.firstChild; c; c = c.nextSibling) {
            if (c.nodeType === 1) {
                hasChildElement = true;
                break;
            }
        }
        if (hasChildElement) continue;

        const txt = (el.textContent || "").trim();
        if (!txt) continue;

        const tag = el.nodeName;
        if (cfg.ignoreLeafNodes && cfg.ignoreLeafNodes.includes(tag)) continue;

        // Build full xpath
        let xp = buildPathForElement(el, cfg);
        if (cfg.startAtTag) xp = trimStart(cfg.startAtTag, xp);

        rows.push({
            type: "leaf",
            text: txt,
            xpath: xp,
        });
    }

    return rows;
}


/* CSV helper */
function toCsvRow(fields) {
    return fields
        .map((f) => {
            if (f == null) return '""';
            const s = String(f).replace(/"/g, '""');
            return `"${s}"`;
        })
        .join(",");
}

/* 5. Main */
function main(xmlFile, cfgFile, outFile, debugMode) {
    DEBUG = !!debugMode;

    if (!xmlFile || !cfgFile) {
        console.error("Usage: node xml-xpaths.js <input.xml> <config.json> [outFile]");
        process.exit(1);
    }
    if (!fileExists(xmlFile)) {
        console.error(`ERROR: XML file not found: ${xmlFile}`);
        process.exit(2);
    }
    if (!fileExists(cfgFile)) {
        console.error(`ERROR: Config file not found: ${cfgFile}`);
        process.exit(3);
    }

    let cfg, doc;
    try {
        cfg = loadConfig(cfgFile);
    } catch (e) {
        console.error("Failed to load/parse config:", e.message);
        process.exit(4);
    }
    try {
        doc = loadXML(xmlFile);
    } catch (e) {
        console.error("Failed to load/parse XML:", e.message);
        process.exit(5);
    }

    log("CONFIG:", cfg);

    const rows = collectLeafRows(doc, cfg);

    if (!outFile) {
        for (const r of rows) {
            console.log(`${r.text} : ${r.xpath}`);
        }
        return;
    }

    const outDir = path.dirname(outFile);
    if (outDir && outDir !== "." && !fs.existsSync(outDir)) {
        try {
            fs.mkdirSync(outDir, { recursive: true });
        } catch (e) {
            console.error("Failed to create output directory:", e.message);
            process.exit(6);
        }
    }

    if (outFile.toLowerCase().endsWith(".csv")) {
        const header = toCsvRow(["type", "text", "xpath"]);
        const lines = [header];
        for (const r of rows) {
            lines.push(toCsvRow([r.type, r.text, r.xpath]));
        }
        fs.writeFileSync(outFile, lines.join("\n"), "utf8");
        console.log(`CSV output written to ${outFile} (${rows.length} rows)`);
    } else {
        const lines = rows.map((r) => `${r.text} : ${r.xpath}`);
        fs.writeFileSync(outFile, lines.join("\n") + "\n", "utf8");
        console.log(`Output written to ${outFile} (${rows.length} rows)`);
    }
}

/* CLI */
const args = process.argv.slice(2);
const xmlFile = args[0];
const cfgFile = args[1];
const outFile = args[2]; // optional
const debugMode = args.includes("--debug") || args.includes("-d");

main(xmlFile, cfgFile, outFile, debugMode);
