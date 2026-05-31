/**
 * Bundled channel registration entry point.
 *
 * Importing this module triggers each bundled adapter's `defineChannel`
 * side effect. External channel plugins are discovered in a later step.
 */
import "@/channels/slack/adapter";
