/**
 * Sentinel AI — local ESLint plugin: fabrication guards.
 *
 * CLAUDE.md, "Hard constraints": *Never fabricate data. If something fails,
 * surface an explicit error. Do not write fallbacks that return
 * plausible-looking placeholder results, invented scores, or synthetic
 * content.*
 *
 * Nine of the fourteen critical findings in the 2026-08-12 audit were one of
 * three syntactic shapes. This file makes each of them a lint error.
 *
 *   A. Clock invention   `date: item.pubDate || new Date().toISOString()`
 *   B. Literal-as-measurement
 *                        `{whois?.Registrar || "GoDaddy"}`
 *                        `status: item.status || "online"`
 *   C. Zero flattening   `deaths: (e.deaths_a || 0) + ...`
 *                        `lat: Number(h.lat ?? 0)`
 *   D. Invented literal returned from a failure path
 *                        `} catch { } return 4290;`
 *
 * The rule works on the AST, not on text, and is deliberately built around an
 * ALLOW-list of honest absence markers: `x || "-"`, `x ?? "not reported"`,
 * `x || "none"` are how this codebase is supposed to render a value it did not
 * measure, and they must never be flagged.
 *
 * No dependencies. Plain ESM, consumed directly by eslint.config.js.
 */

// ─── Shared helpers ─────────────────────────────────────────────────────────

/**
 * A string that ANNOUNCES an absence rather than substituting for one.
 *
 * Deliberately generous: a false negative here is a fabrication that survives
 * one more review, a false positive is a developer who stops trusting the
 * rule. "Unknown botnet" and "No MX record found" are let through by this,
 * which is the price of never flagging "issuer not reported".
 */
const ABSENCE_MARKER =
  /\b(?:not\s+\w+|no\s+\w+|unknown|unavailable|unreported|unspecified|unmeasured|unassessed|uncollected|unresolved|unverified|unrated|unscored|undated|untitled|unnamed|unset|unplaceable|unattributed|unclassified|undetermined|undisclosed|unlisted|unparsed|withheld|redacted|missing|absent|none|nil|empty|pending|tbd|n\/a)\b/i;

/** "", "-", "—", "–", "?", "…", "--", "(none)" style placeholders. */
const PUNCTUATION_ONLY = /^[\s\p{P}\p{S}]*$/u;

function isHonestAbsenceString(value) {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v === "" || PUNCTUATION_ONLY.test(v)) return true;
  return ABSENCE_MARKER.test(v);
}

/** The string value of a Literal or a no-substitution template, else null. */
function staticString(node) {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.map((q) => q.value.cooked ?? "").join("");
  }
  return null;
}

function isNumericLiteral(node, value) {
  return node && node.type === "Literal" && typeof node.value === "number" && node.value === value;
}

/** Strip parentheses / `as T` / `!` so the shape underneath is visible. */
function unwrap(node) {
  let n = node;
  while (
    n &&
    (n.type === "TSAsExpression" ||
      n.type === "TSNonNullExpression" ||
      n.type === "TSSatisfiesExpression" ||
      n.type === "ChainExpression")
  ) {
    n = n.expression;
  }
  return n;
}

const NUMERIC_COERCERS = new Set(["Number", "parseFloat", "parseInt"]);

/** `Number(e.deaths_a)` -> `e.deaths_a`; anything else is returned as-is. */
function stripNumericCoercion(node) {
  let n = unwrap(node);
  while (
    n &&
    n.type === "CallExpression" &&
    n.callee.type === "Identifier" &&
    NUMERIC_COERCERS.has(n.callee.name) &&
    n.arguments.length > 0
  ) {
    n = unwrap(n.arguments[0]);
  }
  return n;
}

/** Static property name of a member expression, else null. */
function memberName(node) {
  const n = unwrap(node);
  if (!n || n.type !== "MemberExpression") return null;
  if (!n.computed && n.property.type === "Identifier") return n.property.name;
  const s = staticString(n.property);
  return s;
}

/** Dotted source text of the left side, for the message. */
function sourceOf(context, node) {
  const text = context.sourceCode.getText(node).replace(/\s+/g, " ");
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/** True when the expression reads configuration rather than collected data. */
function readsConfiguration(context, node, extraCallees) {
  const text = context.sourceCode.getText(node);
  if (/\bprocess\s*\.\s*env\b/.test(text)) return true;
  if (/\bimport\s*\.\s*meta\s*\.\s*env\b/.test(text)) return true;
  if (/\b(?:local|session)Storage\s*\.\s*getItem\b/.test(text)) return true;
  const n = unwrap(node);
  if (n && n.type === "CallExpression") {
    const callee = n.callee.type === "Identifier" ? n.callee.name : memberName(n.callee);
    if (callee && extraCallees.includes(callee)) return true;
  }
  return false;
}

/**
 * True when the left side is a caller-supplied argument used WHOLE —
 * `name || "New Watchlist"`, `target.trim() || "Unnamed subject"`.
 *
 * A property READ off a parameter (`item.status || "online"`) is NOT exempt:
 * that is a collector unpacking an upstream record, which is exactly the case
 * this rule exists for.
 */
function isParameterDefault(context, node) {
  let n = unwrap(node);
  // allow one layer of string massaging: param.trim(), String(param)
  if (n && n.type === "CallExpression") {
    if (n.callee.type === "MemberExpression") n = unwrap(n.callee.object);
    else if (n.callee.type === "Identifier" && n.arguments.length === 1) n = unwrap(n.arguments[0]);
  }
  if (!n || n.type !== "Identifier") return false;
  const scope = context.sourceCode.getScope(node);
  let ref = null;
  for (let s = scope; s && !ref; s = s.upper) {
    ref = s.variables.find((v) => v.name === n.name) ?? null;
  }
  if (!ref || ref.defs.length === 0) return false;
  return ref.defs.every((d) => d.type === "Parameter");
}

/** Nearest enclosing callback that is an argument to `.reduce()` / `.sort()`. */
function insideAggregationCallback(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === "ArrowFunctionExpression" || p.type === "FunctionExpression") {
      const call = p.parent;
      if (call && call.type === "CallExpression") {
        const name = memberName(call.callee);
        if (name && ["reduce", "reduceRight", "sort", "toSorted"].includes(name)) return true;
      }
    }
  }
  return false;
}

/** Anywhere under Math.max / Math.min — the classic harmless `?? 0`. */
function insideMathExtreme(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === "CallExpression" && p.callee.type === "MemberExpression") {
      const obj = p.callee.object;
      const name = memberName(p.callee);
      if (obj.type === "Identifier" && obj.name === "Math" && (name === "max" || name === "min")) {
        return true;
      }
    }
    if (p.type === "Program") break;
  }
  return false;
}

/** Key of the object-literal property this expression is the value of. */
function enclosingPropertyKey(node) {
  for (let p = node.parent, child = node; p; child = p, p = p.parent) {
    if (p.type === "Property" && p.value === child) {
      if (!p.computed && p.key.type === "Identifier") return p.key.name;
      return staticString(p.key);
    }
    // only climb through value-shaped parents
    if (
      ![
        "BinaryExpression",
        "LogicalExpression",
        "UnaryExpression",
        "CallExpression",
        "TSAsExpression",
        "TSNonNullExpression",
        "ChainExpression",
        "ConditionalExpression",
      ].includes(p.type)
    ) {
      return null;
    }
  }
  return null;
}

/**
 * Where a fabricated STRING actually does damage: it becomes a field on a
 * record, or it is rendered. A `||` inside a log line, an error message or a
 * call argument is not a measurement, and flagging those was the single
 * largest source of noise when this rule was first measured (62 hits, most of
 * them UI copy). Climbing stops at anything not on this list.
 */
const TRANSPARENT_PARENTS = new Set([
  "LogicalExpression",
  "ConditionalExpression",
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "ChainExpression",
]);

const COERCION_CALLEES = new Set(["String", "Number", "Boolean"]);

/** JSX attributes that carry presentation, not findings. */
const PRESENTATIONAL_ATTRS =
  /^(class|className|style|placeholder|alt|title|color|fill|stroke|key|id|role|type|variant|size|width|height|href|src|aria-.*|data-.*)$/;

/** Property reads whose value is a caption, not a measurement. */
const PRESENTATIONAL_NAMES = /(label|hint|caption|placeholder|colour|color|icon|tooltip|copy)$/i;

const DEFAULT_OPTIONS_IDENTIFIERS = ["opts", "options", "config", "cfg", "settings", "props"];

/**
 * "record field or rendered" | null.
 *
 * Returns the reason the expression is in scope, or null when it is not.
 */
function fabricationContext(node) {
  let child = node;
  for (let p = node.parent; p; child = p, p = p.parent) {
    if (p.type === "Property" && p.value === child) return "record field";
    if (p.type === "VariableDeclarator" && p.init === child) return "record field";
    if (p.type === "JSXExpressionContainer") {
      const holder = p.parent;
      if (holder && holder.type === "JSXAttribute") {
        const name =
          holder.name.type === "JSXIdentifier"
            ? holder.name.name
            : `${holder.name.namespace?.name}:${holder.name.name?.name}`;
        return PRESENTATIONAL_ATTRS.test(name) ? null : "rendered";
      }
      return "rendered";
    }
    if (
      p.type === "CallExpression" &&
      p.callee.type === "Identifier" &&
      COERCION_CALLEES.has(p.callee.name)
    ) {
      continue;
    }
    if (!TRANSPARENT_PARENTS.has(p.type)) return null;
  }
  return null;
}

const DEFAULT_MEASUREMENT_NAMES =
  "death|casualt|fatalit|killed|injur|wounded|latitude|longitude|(^|_)lat($|_)|(^|_)lon(g)?($|_)|coord|magnitude|confidence|^value$|^reading$|dose|cpm|usv|sievert|radiation|becquerel|temperature|likes|shares|retweets|upvotes|views|followers|subscribers|altitude|velocity|speed|casualties|flights|aircraft|strength|severity_score";

const DEFAULT_CLOCK_SEAMS = ["now", "nowMs", "clock", "currentTime", "timeSource"];

const DEFAULT_CONFIG_CALLEES = ["envValue", "getEnv", "env", "readEnv", "getConfig"];

// ─── Rule 1: no-fabricated-fallback ─────────────────────────────────────────

/** @type {import("eslint").Rule.RuleModule} */
const noFabricatedFallback = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid `||` / `??` fallbacks that substitute a plausible value for one that was never measured.",
    },
    schema: [
      {
        type: "object",
        properties: {
          measurementNames: { type: "string" },
          clockSeamNames: { type: "array", items: { type: "string" } },
          configCallees: { type: "array", items: { type: "string" } },
          optionsIdentifiers: { type: "array", items: { type: "string" } },
          checkCatchReturns: { type: "boolean" },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      fabricatedTimestamp:
        "Fabricated timestamp: `{{left}}` falls back to the current clock, stamping the moment this code ran onto a record the source left undated. Use `null` and render it as undated. If this really is a clock seam, name the left side `now`.",
      fabricatedString:
        'Fabricated value ({{where}}): `{{left}}` falls back to the literal "{{value}}", which reads exactly like a measurement. Use `null`, or an explicit absence marker such as "not reported" / "unknown" / "-".',
      fabricatedZero:
        "Fabricated measurement: `{{left}}` falls back to 0, so an UNREPORTED {{what}} becomes a measured zero — a coordinate at 0,0, a casualty count of none, a reading classified normal. Use `null` and report the absence.",
      fabricatedFailureValue:
        "Invented value on a failure path: returning the literal `{{value}}` from a function that swallows an error hands the UI a number nothing measured. Return `null` (or throw) and let the caller render the failure.",
    },
  },

  create(context) {
    const opts = context.options[0] ?? {};
    const measurementRe = new RegExp(opts.measurementNames ?? DEFAULT_MEASUREMENT_NAMES, "i");
    const clockSeams = opts.clockSeamNames ?? DEFAULT_CLOCK_SEAMS;
    const configCallees = opts.configCallees ?? DEFAULT_CONFIG_CALLEES;
    const optionsIdentifiers = opts.optionsIdentifiers ?? DEFAULT_OPTIONS_IDENTIFIERS;
    const checkCatchReturns = opts.checkCatchReturns !== false;

    /** `new Date()` / `Date.now()` / `new Date().toISOString()` and friends. */
    function isClockCall(node) {
      let n = unwrap(node);
      // peel `.toISOString()`, `.getTime()`, `.valueOf()`
      while (n && n.type === "CallExpression" && n.callee.type === "MemberExpression") {
        n = unwrap(n.callee.object);
      }
      n = unwrap(n);
      if (!n) return false;
      if (
        n.type === "NewExpression" &&
        n.callee.type === "Identifier" &&
        n.callee.name === "Date"
      ) {
        return n.arguments.length === 0;
      }
      if (n.type === "CallExpression" && n.callee.type === "MemberExpression") {
        const obj = n.callee.object;
        return obj.type === "Identifier" && obj.name === "Date" && memberName(n.callee) === "now";
      }
      return false;
    }

    return {
      LogicalExpression(node) {
        if (node.operator !== "||" && node.operator !== "??") return;
        const left = node.left;
        const right = unwrap(node.right);

        // ── A. clock invention ────────────────────────────────────────────
        if (isClockCall(right)) {
          const seam = memberName(left);
          const bare = left.type === "Identifier" ? left.name : null;
          if (
            (seam && clockSeams.includes(seam)) ||
            (bare && clockSeams.includes(bare)) ||
            isParameterDefault(context, left)
          ) {
            return;
          }
          context.report({
            node,
            messageId: "fabricatedTimestamp",
            data: { left: sourceOf(context, left) },
          });
          return;
        }

        // ── B. literal-as-measurement ─────────────────────────────────────
        const literal = staticString(right);
        if (literal !== null) {
          if (isHonestAbsenceString(literal)) return;
          if (readsConfiguration(context, left, configCallees)) return;

          // Only a NAMED property read is treated as collected data.
          // `name || "New Watchlist"` is a caller's default; `map[k] || "low"`
          // is a lookup miss; `item.status || "online"` is an unmeasured field
          // dressed as a measurement, and only the last of those is a lie.
          // `a?.x || b?.y || "Registered"` — the operand that actually ran out
          // is the right-most one in the chain, not the whole chain.
          let probe = unwrap(left);
          while (probe && probe.type === "LogicalExpression") probe = unwrap(probe.right);
          const source = probe;
          if (!source || source.type !== "MemberExpression" || source.computed) return;
          const readName = memberName(source);
          if (!readName || PRESENTATIONAL_NAMES.test(readName)) return;
          let root = unwrap(source.object);
          while (root && root.type === "MemberExpression") root = unwrap(root.object);
          if (root && root.type === "Identifier" && optionsIdentifiers.includes(root.name)) return;

          const where = fabricationContext(node);
          if (!where) return;

          context.report({
            node,
            messageId: "fabricatedString",
            data: { left: sourceOf(context, left), value: literal, where },
          });
          return;
        }

        // ── C. zero flattening ────────────────────────────────────────────
        if (isNumericLiteral(right, 0)) {
          if (insideAggregationCallback(node) || insideMathExtreme(node)) return;
          const source = stripNumericCoercion(left);
          const readName = source
            ? (memberName(source) ?? (source.type === "Identifier" ? source.name : null))
            : null;
          const keyName = enclosingPropertyKey(node);
          const what = [readName, keyName].find((n) => n && measurementRe.test(n));
          if (!what) return;
          context.report({
            node,
            messageId: "fabricatedZero",
            data: { left: sourceOf(context, left), what },
          });
        }
      },

      // ── D. invented literal on a failure path ───────────────────────────
      ReturnStatement(node) {
        if (!checkCatchReturns) return;
        const arg = unwrap(node.argument);
        if (!arg || arg.type !== "Literal") return;
        const value = arg.value;
        const isSuspectNumber = typeof value === "number" && Math.abs(value) > 1;
        const isSuspectString =
          typeof value === "string" && value.trim() !== "" && !isHonestAbsenceString(value);
        if (!isSuspectNumber && !isSuspectString) return;

        // only inside a catch block, or after one in the same function body
        let inCatch = false;
        let fn = null;
        for (let p = node.parent; p; p = p.parent) {
          if (p.type === "CatchClause") inCatch = true;
          if (
            p.type === "FunctionDeclaration" ||
            p.type === "FunctionExpression" ||
            p.type === "ArrowFunctionExpression"
          ) {
            fn = p;
            break;
          }
        }
        if (!inCatch) {
          if (!fn || !fn.body || fn.body.type !== "BlockStatement") return;
          const hasTry = fn.body.body.some((s) => s.type === "TryStatement");
          const isTail = fn.body.body[fn.body.body.length - 1] === node;
          if (!hasTry || !isTail) return;
        }
        context.report({
          node,
          messageId: "fabricatedFailureValue",
          data: { value: typeof value === "string" ? `"${value}"` : String(value) },
        });
      },
    };
  },
};

// ─── Rule 2: require-fabrication-justification ──────────────────────────────

const DISABLE_DIRECTIVE = /^\s*eslint-disable(?:-next-line|-line)?\s+(.*)$/;

/** @type {import("eslint").Rule.RuleModule} */
const requireFabricationJustification = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Every eslint-disable of a fabrication rule must carry a `--` justification naming what the value really is.",
    },
    schema: [
      {
        type: "object",
        properties: {
          ruleNames: { type: "array", items: { type: "string" } },
          minLength: { type: "number" },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      missing:
        "Disabling `{{rule}}` needs a justification: append ` -- <why this value is measured, not invented>` (at least {{min}} characters) to the disable comment.",
    },
  },
  create(context) {
    const opts = context.options[0] ?? {};
    const names = opts.ruleNames ?? ["no-fabricated-fallback"];
    const min = opts.minLength ?? 20;
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const m = DISABLE_DIRECTIVE.exec(comment.value);
          if (!m) continue;
          const [rulePart, ...rest] = m[1].split("--");
          const mentioned = names.find((n) => rulePart.includes(n));
          if (!mentioned) continue;
          if (rest.join("--").trim().length >= min) continue;
          context.report({
            loc: comment.loc,
            messageId: "missing",
            data: { rule: mentioned, min },
          });
        }
      },
    };
  },
};

export default {
  meta: { name: "sentinel", version: "1.0.0" },
  rules: {
    "no-fabricated-fallback": noFabricatedFallback,
    "require-fabrication-justification": requireFabricationJustification,
  },
};
