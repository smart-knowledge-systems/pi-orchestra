import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Minimal conductor extension entrypoint.
 *
 * This is intentionally small so the `piorx` wrapper is immediately usable.
 * Future work will implement the full conductor workflow described in docs/specification/.
 */
export default function (_pi: ExtensionAPI) {
	// no-op for now
}
