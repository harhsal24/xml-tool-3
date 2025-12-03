const fs = require('fs');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');

// ---------------------------------------------
// CLI ARG PARSER
// ---------------------------------------------
const [, , inputFile, outputFile, optFlag, optValue] = process.argv;

if (!inputFile || !outputFile) {
    console.log(`Usage:
    node xml-xpaths.js <input.xml> <output.txt> --options <json OR json-file>

Examples:
    node xml-xpaths.js input.xml output.txt
    node xml-xpaths.js input.xml output.txt --options config.json
    node xml-xpaths.js input.xml output.txt --options '{ "namespace":"d" }'`);
    process.exit(1);
}

// Load config
let options = {};
if (optFlag === '--options') {
    if (optValue && optValue.endsWith && optValue.endsWith('.json')) {
        options = JSON.parse(fs.readFileSync(optValue, 'utf8'));
    } else if (optValue) {
        options = JSON.parse(optValue);
    }
}

// defaults applied if missing
options.namespace = options.namespace || 'd';
options.attributesToIncludeInPath = options.attributesToIncludeInPath || [];
options.ignoreLeafNodes = options.ignoreLeafNodes || [];
options.forceIndexOneFor = options.forceIndexOneFor || [];
options.exceptionsToIndexOneForcing = options.exceptionsToIndexOneForcing || [];
options.disableLeafNodeIndexing = options.disableLeafNodeIndexing || false;
// NEW: optional starting tag name (string) - if provided, traversal starts at first matching element
// Example: "startAtTag": "PROPERTY"
options.startAtTag = options.startAtTag || null;

// ---------------------------------------------
// Helper: build starting path for a given element
// ---------------------------------------------
function buildStartPathForElement(node, opts) {
    if (!node) return null;

    // build predicate string based on configured attributes
    let predicateStr = '';
    for (const a of opts.attributesToIncludeInPath) {
        if (node.hasAttribute && node.hasAttribute(a)) {
            predicateStr += `[@${a}="${node.getAttribute(a)}"]`;
        }
    }

    // compute index among siblings with same tag+predicate
    let index = 1;
    const parent = node.parentNode;
    if (parent) {
        const siblings = Array.from(parent.childNodes).filter(n => n.nodeType === 1);
        let count = 0;
        for (const s of siblings) {
            // only count same tag name *and* identical predicate string (based on attributes)
            let sPred = '';
            for (const a of opts.attributesToIncludeInPath) {
                if (s.hasAttribute && s.hasAttribute(a)) {
                    sPred += `[@${a}="${s.getAttribute(a)}"]`;
                }
            }
            if (s.tagName === node.tagName && sPred === predicateStr) {
                count++;
                if (s === node) {
                    index = count;
                    break;
                }
            }
        }
    }

    // decide whether to show [1] for index === 1
    let indexStr = '';
    if (index === 1) {
        let showIndex = false;
        if (opts.forceIndexOneFor.length === 0) {
            showIndex = true; // force for all
        } else if (opts.forceIndexOneFor.includes(node.tagName)) {
            showIndex = true;
        }
        if (opts.exceptionsToIndexOneForcing.includes(node.tagName)) {
            showIndex = false;
        }
        if (showIndex) indexStr = `[1]`;
    } else {
        indexStr = `[${index}]`;
    }

    return `//${opts.namespace}:${node.tagName}${predicateStr}${indexStr}`;
}

// ---------------------------------------------
// XML → XPATH
// ---------------------------------------------
function generateXpathList(xmlString, opts) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlString, 'application/xml');

    // error detection
    const errNode = doc.getElementsByTagName('parsererror');
    if (errNode.length > 0) {
        throw new Error("XML Parsing Error: " + new XMLSerializer().serializeToString(errNode[0]));
    }

    const results = [];

    // determine starting node and starting path
    let startNode = null;
    let startPath = null;

    if (opts.startAtTag) {
        // try both plain tag and namespaced tag
        const attempts = [
            opts.startAtTag,
            `${opts.namespace}:${opts.startAtTag}`
        ];

        for (const t of attempts) {
            const found = Array.from(doc.getElementsByTagName(t));
            if (found.length > 0) {
                startNode = found[0];
                break;
            }
        }

        // if found, build a correct starting path using the chosen node
        if (startNode) {
            startPath = buildStartPathForElement(startNode, opts);
        }
    }

    // fallback to documentElement
    if (!startNode) {
        startNode = doc.documentElement;
        // keep old behavior: double-slash + [1] for root
        startPath = `//${opts.namespace}:${startNode.tagName}[1]`;
    }

    // traverse from the chosen node/path
    traverse(startNode, startPath, results, opts);
    return results.join('\n');
}

function traverse(node, currentPath, results, opts) {
    if (node.nodeType !== 1) return;

    // ignore selected leaf tags entirely
    if (opts.ignoreLeafNodes.includes(node.tagName)) return;

    const children = Array.from(node.childNodes).filter(n => n.nodeType === 1);

    // HANDLE LEAF NODE (contains value text)
    if (children.length === 0 && node.textContent && node.textContent.trim()) {
        const text = node.textContent.trim();

        if (!opts.disableLeafNodeIndexing) {
            // attach a predicate-like element-for-leaf (keeps namespace qualifier)
            const leafXpath = `${currentPath}[${opts.namespace}:${node.tagName}="${text}"]`;
            results.push(text + ' : ' + leafXpath);
        } else {
            results.push(text + ' : ' + currentPath);
        }

        return;
    }

    // prepare sibling counters
    const counters = {};

    for (const child of children) {
        const tag = `${opts.namespace}:${child.tagName}`;
        let predicateStr = '';

        // append attribute selectors
        for (const a of opts.attributesToIncludeInPath) {
            if (child.hasAttribute && child.hasAttribute(a)) {
                predicateStr += `[@${a}="${child.getAttribute(a)}"]`;
            }
        }

        const siblingKey = tag + predicateStr;
        counters[siblingKey] = (counters[siblingKey] || 0) + 1;
        const idx = counters[siblingKey];

        let indexStr = '';

        // FORCE INDEXING RULE
        if (idx === 1) {
            let showIndex = false;

            if (opts.forceIndexOneFor.length === 0) {
                showIndex = true; // force for all
            } else if (opts.forceIndexOneFor.includes(child.tagName)) {
                showIndex = true;
            }

            // exceptions override
            if (opts.exceptionsToIndexOneForcing.includes(child.tagName)) {
                showIndex = false;
            }

            if (showIndex) indexStr = `[1]`;
        } else {
            indexStr = `[${idx}]`;
        }

        const newPath = `${currentPath}/${tag}${predicateStr}${indexStr}`;
        traverse(child, newPath, results, opts);
    }
}

// ----------------------------
// MAIN EXEC
// ----------------------------
try {
    const xml = fs.readFileSync(inputFile, 'utf8');
    const output = generateXpathList(xml, options);
    fs.writeFileSync(outputFile, output, 'utf8');

    console.log(`✔ XPath generated: ${outputFile}`);
} catch (err) {
    console.error("❌ ERROR:", err.message);
    process.exit(1);
}
