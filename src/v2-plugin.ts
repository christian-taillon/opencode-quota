import { define } from "@opencode-ai/plugin/v2/promise";

/**
 * OpenCode V2 server plugin entrypoint.
 *
 * The TUI is exposed separately through the package's `./tui` export.
 *
 * The server plugin is intentionally a no-op: native credential access is
 * handled entirely by the TUI reading OpenCode's SQLite credential database
 * directly. There is no server→TUI bridge or shared module state.
 */
export const QuotaV2Plugin = define({
  id: "@slkiser/opencode-quota",
  setup() {
    // No server-side operations needed.
  },
});

export default QuotaV2Plugin;
