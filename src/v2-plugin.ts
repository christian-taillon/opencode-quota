import { define, type PluginContext } from "@opencode-ai/plugin/v2/promise";

import { registerNativeConnectionResolver } from "./lib/opencode-v2-connections.js";

/**
 * V2 server-side companion. The resolver remains in-process; no credential
 * values are returned through a client, command, log, or serialized state.
 */
export const QuotaV2Plugin = define({
  id: "@slkiser/opencode-quota",
  setup(context: PluginContext) {
    registerNativeConnectionResolver(context);
  },
});

export default QuotaV2Plugin;
