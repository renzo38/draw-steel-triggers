/**
 * Structural checks on the Handlebars templates.
 *
 * ApplicationV2 refuses to render a part that produces more than one root
 * element — "Template part must render a single HTML element". Nothing in the
 * JS test suite could catch that: the templates are data for a renderer that
 * only exists inside Foundry. This file closes that gap with a small parser.
 *
 * Run with `node test/templates.test.mjs`, or via `node test/engine.test.mjs`
 * which imports it.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const templateDir = join(here, "../templates");

/** HTML elements that never carry a closing tag. */
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/* -------------------------------------------------- */

/**
 * Count how many elements sit at the top level of a template.
 *
 * Handlebars expressions are stripped first: a `{{#if}}` block can wrap a root
 * element without being one, and its braces would otherwise confuse the tag
 * scanner.
 *
 * @param {string} source
 * @returns {number}
 */
export function countRootElements(source) {
  const markup = source
    .replace(/\{\{![\s\S]*?\}\}/g, "") // handlebars comments
    .replace(/<!--[\s\S]*?-->/g, "") // html comments
    .replace(/\{\{[\s\S]*?\}\}/g, ""); // every other expression

  let depth = 0;
  let roots = 0;

  const tagPattern = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let match;
  while ((match = tagPattern.exec(markup)) !== null) {
    const [, closing, rawName, , selfClosing] = match;
    const name = rawName.toLowerCase();
    if (VOID_ELEMENTS.has(name) || selfClosing === "/") {
      if (depth === 0) roots++;
      continue;
    }
    if (closing) {
      depth = Math.max(0, depth - 1);
      if (depth === 0) roots++;
    } else {
      depth++;
    }
  }

  return roots;
}

/* -------------------------------------------------- */

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error.message}`);
    process.exitCode = 1;
  }
};

/* -------------------------------------------------- */

export function runTemplateTests() {
  console.log("\nGabarits — racine unique exigée par ApplicationV2");

  test("le compteur reconnaît une racine unique", () => {
    assert.equal(countRootElements("<div><p>a</p><p>b</p></div>"), 1);
  });

  test("le compteur détecte deux racines", () => {
    assert.equal(countRootElements("<div>a</div><p>b</p>"), 2);
  });

  test("les blocs Handlebars ne comptent pas comme des éléments", () => {
    assert.equal(countRootElements('{{#if x}}<div>a</div>{{else}}<div>b</div>{{/if}}'), 2);
    assert.equal(countRootElements('<div>{{#if x}}<p>a</p>{{/if}}</div>'), 1);
  });

  test("les éléments sans fermeture ne faussent pas le compte", () => {
    assert.equal(countRootElements("<div><br><img src='x'></div>"), 1);
  });

  for (const file of readdirSync(templateDir).filter((f) => f.endsWith(".hbs"))) {
    test(`${file} ne rend qu'un seul élément racine`, () => {
      const roots = countRootElements(readFileSync(join(templateDir, file), "utf8"));
      assert.equal(
        roots, 1,
        `${roots} racines — ApplicationV2 refusera de rendre cette part`,
      );
    });
  }

  return passed;
}

/* -------------------------------------------------- */

// Exécution directe.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const count = runTemplateTests();
  console.log(`\n${count} tests passed${process.exitCode ? " (with failures above)" : ""}.\n`);
}
