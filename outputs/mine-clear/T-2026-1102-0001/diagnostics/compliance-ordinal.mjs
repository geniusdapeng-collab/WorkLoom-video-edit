// Diagnostic regression for the explicitly deferred policy finding MC-010.
// Exit 1 is the current known false rejection; this file is not a green CI test.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../../../package.json", import.meta.url));
const { MarketingComplianceGuard } = require("./vendor/supermickey/hyperreality-system/engines/production-engine/agents/marketing-compliance-guard.js");
const guard = new MarketingComplianceGuard();
const ordinal = guard.check("【动作】第一步打开包装，第二步展示商品。");
const claim = guard.check("【台词】我们的产品是最好的。");
console.log(JSON.stringify({ ordinal, claim }));
assert.equal(claim.pass, false, "A real promotional superlative must still be rejected");
assert.equal(ordinal.pass, true, "A sequence instruction must not be treated as a product ranking claim");
