// A copy of the publishing service's SVG check (mahfouz-app/app
// src/worker/src/publish/svg.ts), for the diagram plugins' tests: what a
// publishRender returns must pass it, or the page shows the fence as code.
// Keep in sync; types stripped, logic unchanged.
//
// The check every diagram render (a `render:<key>` part, src/publish/
// payload.ts) passes before it's stored and served as a page's image. An
// SVG is a document that can run script and fetch other URLs, so it is read
// by a strict XML tokenizer of its own (Workers have no DOM) and accepted
// only when every construct in it is on an allowlist: the SVG elements and
// attributes that draw (shapes, text, gradients, markers, filters), no
// script, event attribute, <foreignObject>, link, embedded document,
// animation (which can rewrite an attribute), external reference or
// declaration. A render that fails is dropped: its fence stays code.
//
// The bytes are stored as they came: nothing is rewritten, so what's served
// is exactly what was checked. It's served with the pages' CSP sandbox and
// shown through <img>, where an SVG runs no script and loads nothing; the
// check is what keeps it safe opened on its own too.
//
// XML well-formedness is enforced where it matters to the check (matched
// tags, quoted attributes, no `<` in a value, only the five predefined
// entities and character references), so the browser parses the same tree
// this did. Plugins must hand over XMLSerializer output, never innerHTML
// (whose `&nbsp;` and unescaped `<` in attributes aren't XML).

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

/** The elements a render may hold: static drawing only. */
const ELEMENTS = new Set(
  (
    "svg g defs symbol use title desc style switch " +
    "path rect circle ellipse line polyline polygon text tspan textPath " +
    "marker linearGradient radialGradient stop pattern clipPath mask filter " +
    "feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting " +
    "feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR " +
    "feGaussianBlur feMerge feMergeNode feMorphology feOffset fePointLight feSpecularLighting " +
    "feSpotLight feTile feTurbulence"
  ).split(" ")
);

/** The attributes a render may carry (plus `data-*` and `aria-*`); `href`, `xlink:href` and `xmlns*` are checked by value. */
const ATTRIBUTES = new Set(
  (
    "id class style transform x y x1 y1 x2 y2 cx cy r rx ry width height viewBox preserveAspectRatio " +
    "d points pathLength fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap " +
    "stroke-linejoin stroke-dasharray stroke-dashoffset stroke-miterlimit opacity clip-path clip-rule " +
    "mask filter marker-start marker-mid marker-end markerWidth markerHeight markerUnits refX refY orient " +
    "font-family font-size font-size-adjust font-stretch font-weight font-style font-variant text-anchor " +
    "dominant-baseline alignment-baseline baseline-shift letter-spacing word-spacing text-decoration " +
    "dx dy rotate textLength lengthAdjust writing-mode direction unicode-bidi display visibility " +
    "overflow color pointer-events shape-rendering text-rendering image-rendering color-interpolation " +
    "color-interpolation-filters vector-effect paint-order offset stop-color stop-opacity gradientUnits " +
    "gradientTransform spreadMethod fx fy fr patternUnits patternContentUnits patternTransform " +
    "clipPathUnits maskUnits maskContentUnits filterUnits primitiveUnits in in2 result stdDeviation " +
    "flood-color flood-opacity lighting-color mode operator k1 k2 k3 k4 values type tableValues slope " +
    "intercept amplitude exponent scale xChannelSelector yChannelSelector radius order kernelMatrix " +
    "divisor bias targetX targetY edgeMode kernelUnitLength preserveAlpha surfaceScale diffuseConstant " +
    "specularConstant specularExponent azimuth elevation z pointsAtX pointsAtY pointsAtZ " +
    "limitingConeAngle baseFrequency numOctaves seed stitchTiles startOffset method spacing side " +
    "version baseProfile role name content requiredFeatures systemLanguage xml:space xml:lang lang " +
    "href xlink:href xmlns xmlns:xlink"
  ).split(" ")
);

/** How deep elements may nest. */
const MAX_DEPTH = 256;

const NAME = /[A-Za-z_][A-Za-z0-9._:-]*/y;
const SPACE = /[ \t\r\n]*/y;
const XML_DECL = /^<\?xml[ \t\r\n]+version[ \t\r\n]*=[ \t\r\n]*(["'])1\.[01]\1([ \t\r\n]+encoding[ \t\r\n]*=[ \t\r\n]*(["'])[A-Za-z][A-Za-z0-9._-]*\3)?([ \t\r\n]+standalone[ \t\r\n]*=[ \t\r\n]*(["'])(yes|no)\5)?[ \t\r\n]*\?>/;
/** A character XML 1.0 refuses anywhere: controls other than tab, LF and CR, lone surrogates, U+FFFE/U+FFFF. */
const BAD_CHAR = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const REF = /&(?:#([0-9]{1,7})|#x([0-9a-fA-F]{1,6})|(lt|gt|amp|quot|apos));/y;
const NAMED = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

class Refused extends Error {}

function refuse(reason) {
  throw new Refused(reason);
}

/** `raw` with its references decoded; refused for any `&` that isn't one of XML's own, or a reference to a character XML refuses. */
function decode(raw) {
  if (!raw.includes("&")) return raw;
  let out = "";
  let i = 0;
  for (let amp = raw.indexOf("&"); amp !== -1; amp = raw.indexOf("&", i)) {
    out += raw.slice(i, amp);
    REF.lastIndex = amp;
    const m = REF.exec(raw);
    if (!m) refuse("entity");
    let ch;
    if (m[3]) ch = NAMED[m[3]];
    else {
      const cp = m[1] !== undefined ? Number(m[1]) : parseInt(m[2], 16);
      if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) refuse("entity");
      ch = String.fromCodePoint(cp);
      if (BAD_CHAR.test(ch)) refuse("entity");
    }
    out += ch;
    i = REF.lastIndex;
  }
  return out + raw.slice(i);
}

/** Every `url(` in `value` names a fragment of this document (`url(#id)`, quoted or not). */
function onlyLocalUrls(value) {
  const lower = value.toLowerCase();
  for (let at = lower.indexOf("url("); at !== -1; at = lower.indexOf("url(", at + 4)) {
    if (!/^url\([ \t\r\n]*(["']?)#[A-Za-z0-9_.:-]+\1[ \t\r\n]*\)/.test(value.slice(at))) return false;
  }
  return true;
}

/** CSS (a `style` attribute or a <style> element) that fetches nothing and runs nothing. */
function checkCss(css) {
  const lower = css.toLowerCase();
  // An escape could spell anything the checks below look for (`\75rl(`).
  if (css.includes("\\")) refuse("css_escape");
  for (const bad of ["@import", "@font-face", "expression", "javascript:", "image-set", "-moz-binding", "behavior"]) {
    if (lower.includes(bad)) refuse("css");
  }
  if (!onlyLocalUrls(css)) refuse("css_url");
}

function checkAttribute(element, name, raw) {
  if (raw.includes("<")) refuse("attribute_value");
  const lowerName = name.toLowerCase();
  if (lowerName.startsWith("on")) refuse("event_attribute");
  const known = ATTRIBUTES.has(name) || /^data-[a-z0-9_.-]+$/i.test(name) || /^aria-[a-z]+$/.test(name);
  if (!known) refuse(`attribute:${name}`);
  const value = decode(raw);
  if (name === "xmlns") {
    if (value !== SVG_NS) refuse("namespace");
    return;
  }
  if (name === "xmlns:xlink") {
    if (value !== XLINK_NS) refuse("namespace");
    return;
  }
  if (name === "href" || name === "xlink:href") {
    if (!value.trim().startsWith("#")) refuse("external_href");
    return;
  }
  if (name === "style") {
    checkCss(value);
    return;
  }
  // Draw.io keeps the diagram's own XML here, escaped: data the browser never reads.
  if (name === "content" && element === "svg") return;
  if (value.includes("\\")) refuse("attribute_escape");
  if (!onlyLocalUrls(value)) refuse("attribute_url");
  if (/javascript:|data:/i.test(value)) refuse("attribute_url");
}

/**
 * Whether `text` (an SVG document, already decoded as UTF-8) is safe to
 * store and serve as a page's diagram, and if not, why. Never throws.
 */
export function checkSvg(text) {
  try {
    walk(text);
    return { ok: true };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, reason: err.message };
    return { ok: false, reason: "malformed" };
  }
}

function walk(input) {
  if (BAD_CHAR.test(input)) refuse("character");
  let i = input.startsWith("﻿") ? 1 : 0;
  // The XML declaration, only at the very start.
  const decl = XML_DECL.exec(input.slice(i));
  if (decl) i += decl[0].length;
  const stack = [];
  let rootSeen = false;
  let styleText = null;

  const skipSpace = () => {
    SPACE.lastIndex = i;
    SPACE.exec(input);
    i = SPACE.lastIndex;
  };

  while (i < input.length) {
    const lt = input.indexOf("<", i);
    const text = input.slice(i, lt === -1 ? input.length : lt);
    if (text !== "") {
      // Outside the root only whitespace; inside, text with XML's references only.
      if (stack.length === 0) {
        if (text.trim() !== "") refuse("text_outside_root");
      } else {
        const decoded = decode(text);
        if (styleText !== null) styleText += decoded;
      }
    }
    if (lt === -1) break;
    i = lt;
    if (input.startsWith("<!--", i)) {
      const end = input.indexOf("-->", i + 4);
      if (end === -1) refuse("malformed");
      if (input.slice(i + 4, end).includes("--")) refuse("malformed");
      i = end + 3;
      continue;
    }
    if (input.startsWith("<![CDATA[", i)) {
      // Only a stylesheet's text may be CDATA; it's checked as CSS like any other.
      if (styleText === null) refuse("cdata");
      const end = input.indexOf("]]>", i + 9);
      if (end === -1) refuse("malformed");
      styleText += input.slice(i + 9, end);
      i = end + 3;
      continue;
    }
    if (input.startsWith("<!", i)) refuse("declaration");
    if (input.startsWith("<?", i)) refuse("processing_instruction");
    if (input.startsWith("</", i)) {
      NAME.lastIndex = i + 2;
      const m = NAME.exec(input);
      if (!m || m[0] !== stack[stack.length - 1]) refuse("malformed");
      i = NAME.lastIndex;
      skipSpace();
      if (input[i] !== ">") refuse("malformed");
      i++;
      if (m[0] === "style") {
        checkCss(styleText ?? "");
        styleText = null;
      }
      stack.pop();
      continue;
    }
    // A start tag.
    if (stack.length === 0 && rootSeen) refuse("text_outside_root");
    if (styleText !== null) refuse("element_in_style");
    NAME.lastIndex = i + 1;
    const m = NAME.exec(input);
    if (!m) refuse("malformed");
    const name = m[0];
    if (!ELEMENTS.has(name)) refuse(`element:${name}`);
    if (stack.length === 0 && name !== "svg") refuse("root");
    i = NAME.lastIndex;
    const seen = new Set();
    let selfClosing = false;
    for (;;) {
      const before = i;
      skipSpace();
      if (input.startsWith("/>", i)) {
        selfClosing = true;
        i += 2;
        break;
      }
      if (input[i] === ">") {
        i++;
        break;
      }
      // Attributes are separated by whitespace.
      if (i === before) refuse("malformed");
      NAME.lastIndex = i;
      const a = NAME.exec(input);
      if (!a) refuse("malformed");
      i = NAME.lastIndex;
      skipSpace();
      if (input[i] !== "=") refuse("malformed");
      i++;
      skipSpace();
      const quote = input[i];
      if (quote !== '"' && quote !== "'") refuse("malformed");
      const end = input.indexOf(quote, i + 1);
      if (end === -1) refuse("malformed");
      if (seen.has(a[0])) refuse("duplicate_attribute");
      seen.add(a[0]);
      checkAttribute(name, a[0], input.slice(i + 1, end));
      i = end + 1;
    }
    if (stack.length === 0) {
      rootSeen = true;
      if (!seen.has("xmlns")) refuse("namespace");
    }
    if (selfClosing) {
      if (name === "style") checkCss("");
      continue;
    }
    if (stack.length >= MAX_DEPTH) refuse("depth");
    stack.push(name);
    if (name === "style") styleText = "";
  }
  if (stack.length !== 0 || !rootSeen) refuse("malformed");
}
