/**
 * OpenCode V2 server plugin entrypoint.
 *
 * The TUI is exposed separately through the package's `./tui` export. Keeping
 * this target server-only lets the promise plugin receive the privileged V2
 * integration resolver without putting that resolver on the TUI/client API.
 */
export { default } from "./v2-plugin.js";
