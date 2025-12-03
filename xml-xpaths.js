#!/usr/bin/env node
const fs = require("fs");
const { DOMParser, XMLSerializer } = require("@xmldom/xmldom");

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
if (optFlag === "--options") {
  if (optValue && optValue.endsWith && optValue.endsWith(".json")) {
    options = JSON.parse(fs.readFileSync(optValue, "utf8"));
  } else if (optValue) {
    options = JSON.parse(optValue);
  }
}

// defaults applied if missing
options.namespace = options.namespace || "d";
options.attributesToIncludeInPath = options.attributesToIncludeInPath || [];
options.ignoreLeafNodes = options.ignoreLeafNodes || [];
options.forceIndexOneFor = options.forceIndexOneFor || [];
options.exceptionsToIndexOneForcing = options.exceptionsToIndexOneForcing || [];
options.disableLeafNodeIndexing = options.disableLeafNodeIndexing || false;
options.startAtTag = options.startAtTag || null;

// new clearer option: includeLeafValuePredicate (if present, takes precedence)
if (typeof options.includeLeafValuePredicate === "undefined") {
  // not provided — keep backwards compatibility
  options.includeLeafValuePredicate = !options.disableLeafNodeIndexing;
}

// debug flag
options.debug = !!options.debug;

// simple debug logger
function dbg(...args) {
  if (options.debug) console.log(...args);
}

// helper to get local name (works whether or not DOM exposes localName)
function localNameOf(node) {
  if (!node) return null;
  if (node.localName) return node.localName;
  if (node.tagName) return node.tagName.replace(/^.*:/, "");
  return null;
}

// NEW: robust DFS to find first element by local name (case-insensitive)
function findFirstElementByLocalName(root, localName) {
  if (!root || !localName) return null;
  const want = localName.toLowerCase();

  function dfs(node) {
    if (!node) return null;
    if (node.nodeType === 1) {
      const ln = localNameOf(node);
      if (ln && ln.toLowerCase() === want) return node;
    }
    const children = node.childNodes ? Array.from(node.childNodes) : [];
    for (const c of children) {
      const found = dfs(c);
      if (found) return found;
    }
    return null;
  }

  return dfs(root);
}

// ---------------------------------------------
// Helper: build starting path for a given element
// ---------------------------------------------
function buildStartPathForElement(node, opts) {
  if (!node) return null;

  const local = localNameOf(node);

  // build predicate string based on configured attributes
  let predicateStr = "";
  for (const a of opts.attributesToIncludeInPath) {
    if (node.hasAttribute && node.hasAttribute(a)) {
      predicateStr += `[@${a}="${node.getAttribute(a)}"]`;
    }
  }

  // compute index among siblings with same localName + predicate
  let index = 1;
  const parent = node.parentNode;
  if (parent) {
    const siblings = Array.from(parent.childNodes).filter(
      (n) => n.nodeType === 1
    );
    let count = 0;
    for (const s of siblings) {
      const sLocal = localNameOf(s);
      // only count same local name *and* identical predicate string (based on attributes)
      let sPred = "";
      for (const a of opts.attributesToIncludeInPath) {
        if (s.hasAttribute && s.hasAttribute(a)) {
          sPred += `[@${a}="${s.getAttribute(a)}"]`;
        }
      }
      if (sLocal === local && sPred === predicateStr) {
        count++;
        if (s === node) {
          index = count;
          break;
        }
      }
    }
  }

  // decide whether to show [1] for index === 1
  let indexStr = "";
  if (index === 1) {
    let showIndex = false;
    if (opts.forceIndexOneFor.length === 0) {
      showIndex = true; // force for all
    } else if (opts.forceIndexOneFor.includes(local)) {
      showIndex = true;
    }
    if (opts.exceptionsToIndexOneForcing.includes(local)) {
      showIndex = false;
    }
    if (showIndex) indexStr = `[1]`;
  } else {
    indexStr = `[${index}]`;
  }

  return `//${opts.namespace}:${local}${predicateStr}${indexStr}`;
}

// ---------------------------------------------
// XML → XPATH
// ---------------------------------------------
function generateXpathList(xmlString, opts) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, "application/xml");

  // error detection
  const errNode = doc.getElementsByTagName("parsererror");
  if (errNode.length > 0) {
    throw new Error(
      "XML Parsing Error: " + new XMLSerializer().serializeToString(errNode[0])
    );
  }

  const results = [];

  // determine starting node and starting path
  let startNode = null;
  let startPath = null;

  if (opts.startAtTag) {
    dbg("🔍 Searching startAtTag:", opts.startAtTag);

    // 1) try getElementsByTagNameNS if available
    try {
      if (typeof doc.getElementsByTagNameNS === "function") {
        const foundNS = doc.getElementsByTagNameNS("*", opts.startAtTag);
        dbg("⭐ getElementsByTagNameNS returned:", foundNS.length);
        if (foundNS && foundNS.length > 0) {
          startNode = foundNS[0];
        }
      }
    } catch (e) {
      dbg("⚠️ NS search error:", e && e.message ? e.message : e);
    }

    // 2) fallback to getElementsByTagName (legacy)
    if (!startNode) {
      dbg("🔄 Fallback to getElementsByTagName");
      try {
        const attempts = [
          opts.startAtTag,
          `${opts.namespace}:${opts.startAtTag}`,
        ];
        for (const t of attempts) {
          const found = Array.from(doc.getElementsByTagName(t) || []);
          dbg(`🤖 searching tag '${t}' →`, found.length);
          if (found.length > 0) {
            startNode = found[0];
            break;
          }
        }
      } catch (e) {
        dbg("⚠️ tagName search error:", e && e.message ? e.message : e);
      }
    }

    // 3) robust DFS fallback (recommended) - searches by local name case-insensitively
    if (!startNode) {
      dbg("🧠 Fallback DFS by localName");
      startNode = findFirstElementByLocalName(
        doc.documentElement,
        opts.startAtTag
      );
      dbg("DFS found? →", !!startNode);
    }

    if (startNode) {
      dbg("🎯 Start node localName:", localNameOf(startNode));
      startPath = buildStartPathForElement(startNode, opts);
      dbg("📌 Built startPath:", startPath);
    } else {
      dbg("❌ No start node found - fallback to root");
    }
  }

  // fallback to documentElement
  if (!startNode) {
    startNode = doc.documentElement;
    const rootLocal = localNameOf(startNode);
    startPath = `//${opts.namespace}:${rootLocal}[1]`;
    dbg("Using documentElement as startNode:", rootLocal);
    dbg("StartPath:", startPath);
  }

  // traverse from the chosen node/path
  traverse(startNode, startPath, results, opts);
  return results.join("\n");
}

function traverse(node, currentPath, results, opts) {
  if (node.nodeType !== 1) return;

  const nodeLocal = localNameOf(node);
  // ignore selected leaf tags entirely (compare local names)
  if (opts.ignoreLeafNodes.includes(nodeLocal)) return;

  const children = Array.from(node.childNodes).filter((n) => n.nodeType === 1);

  // HANDLE LEAF NODE (contains value text)
  if (children.length === 0 && node.textContent && node.textContent.trim()) {
    const text = node.textContent.trim();

    // use includeLeafValuePredicate (new) for decision; kept backwards-compatible above
    if (opts.includeLeafValuePredicate) {
      // attach a predicate-like element-for-leaf (keeps namespace qualifier)
      const leafXpath = `${currentPath}[${opts.namespace}:${nodeLocal}="${text}"]`;
      results.push(text + " : " + leafXpath);
    } else {
      // do NOT attach value predicate — only keep the element path
      results.push(text + " : " + currentPath);
    }

    return;
  }

  // prepare sibling counters
  const counters = {};

  for (const child of children) {
    const childLocal = localNameOf(child);
    const tag = `${opts.namespace}:${childLocal}`;
    let predicateStr = "";

    // append attribute selectors
    for (const a of opts.attributesToIncludeInPath) {
      if (child.hasAttribute && child.hasAttribute(a)) {
        predicateStr += `[@${a}="${child.getAttribute(a)}"]`;
      }
    }

    const siblingKey = tag + predicateStr;
    counters[siblingKey] = (counters[siblingKey] || 0) + 1;
    const idx = counters[siblingKey];

    let indexStr = "";

    // FORCE INDEXING RULE
    if (idx === 1) {
      let showIndex = false;

      if (opts.forceIndexOneFor.length === 0) {
        showIndex = true; // force for all
      } else if (opts.forceIndexOneFor.includes(childLocal)) {
        showIndex = true;
      }

      // exceptions override
      if (opts.exceptionsToIndexOneForcing.includes(childLocal)) {
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

// trim helper (unchanged) - optional trimming to startAtTag
function trimGeneratedXPaths(outputStr, startAtTag, namespace) {
  dbg("🔧 TRIM active → startAtTag:", startAtTag);

  if (!startAtTag) return outputStr;
  const want = String(startAtTag).toLowerCase();

  const lines = outputStr.split(/\r?\n/);
  const out = lines.map((line) => {
    if (!line.trim()) return line;
    dbg("\n----------------------------------");
    dbg("🧾 Source:", line);

    const sepIndex = line.indexOf(" : ");
    if (sepIndex === -1) {
      dbg("⚠️ skip: not key:value format");
      return line; // unexpected format, leave as-is
    }

    const value = line.slice(0, sepIndex);
    const path = line.slice(sepIndex + 3).trim();

    dbg("🔗 Raw path:", path);

    // split into segments (removes empty pieces from leading //)
    const segments = path.split("/").filter((s) => s.length > 0);
    dbg("📦 Segments:", segments);

    // find index of first segment whose local name matches startAtTag
    let found = -1;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const local = seg.replace(/^.*?:/, "").replace(/\[.*$/, "");
      if (local.toLowerCase() === want) {
        found = i;
        break;
      }
    }

    if (found === -1) {
      dbg("❌ No segment matching startAtTag → leave unchanged");
      return line;
    }

    dbg("🎯 Match found at index:", found);

    // build trimmed segments, ensure namespace prefix exists if missing
    const newSegments = segments.slice(found).map((s) => {
      if (s.includes(":")) return s; // keep existing prefix
      return `${namespace}:${s}`;
    });

    const newPath = "//" + newSegments.join("/");
    dbg("✂️ Trimmed:", newPath);

    return `${value} : ${newPath}`;
  });

  return out.join("\n");
}

// ----------------------------
// MAIN EXEC
// ----------------------------
try {
  const xml = fs.readFileSync(inputFile, "utf8");
  dbg("📥 Read input file:", inputFile);

  let output = generateXpathList(xml, options);
  dbg("📤 Raw generated output (first 20 lines):\n", output.split(/\r?\n/).slice(0, 20).join("\n"));

  if (options.startAtTag) {
    output = trimGeneratedXPaths(output, options.startAtTag, options.namespace || "d");
  }

  fs.writeFileSync(outputFile, output, "utf8");
  dbg("💾 Wrote output file:", outputFile);

  console.log(`✔ XPath generated: ${outputFile}`);
} catch (err) {
  console.error("❌ ERROR:", err && err.message ? err.message : err);
  process.exit(1);
}
