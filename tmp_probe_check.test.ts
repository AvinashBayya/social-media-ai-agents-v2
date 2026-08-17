import { test, expect } from "bun:test";
import { resolveCredential } from "./src/utils/credential-vault";

test("env: password set, identifier UNSET", async () => {
  delete process.env.BLUESKY_IDENTIFIER;
  process.env.BLUESKY_APP_PASSWORD = "abcd-efgh-ijkl-mnop";
  const r = await resolveCredential("bluesky");
  console.log("RESOLVED =", JSON.stringify(r));
  console.log("probe branch =>", r ? `not-probeable: "An app password is configured (source: ${r.source})"` : "no-credential");
  console.log("collector branch (!cred?.identifier) =>", !r?.identifier ? "THROWS SocialUnavailableError 403 (missing credential)" : "proceeds to createSession");
});
