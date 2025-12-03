#!/usr/bin/env node
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

    const root = doc.documentElement;
    if (root) {
        // <-- changed here: use double slash at start
        const rootPath = `//${opts.namespace}:${root.tagName}[1]`;
        traverse(root, rootPath, results, opts);
    }

    return results.join('\n');
}

function traverse(node, currentPath, results, opts) {
    if (node.nodeType !== 1) return;

    // ignore selected leaf tags entirely
    if (opts.ignoreLeafNodes.includes(node.tagName)) return;

    const children = Array.from(node.childNodes).filter(n => n.nodeType === 1);

    // HANDLE LEAF NODE (contains value text)
    if (children.length === 0 && node.textContent.trim()) {
        const text = node.textContent.trim();

        if (!opts.disableLeafNodeIndexing) {
            // attach a predicate-like element-for-leaf (keeps namespace qualifier)
            // Note: this appends a predicate referencing the leaf node name+value
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
            if (child.hasAttribute(a)) {
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
